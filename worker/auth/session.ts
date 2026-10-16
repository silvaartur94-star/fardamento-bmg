import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { can, type Permission, type Role } from '../../shared/domain';
import type { AppEnv, Env } from '../env';
import { ApiError, type Ctx } from '../lib/core';
import { randomToken, sha256Hex } from './crypto';

const IDLE_MS = 12 * 60 * 60 * 1000; // 12 horas de inatividade
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias no máximo
const REFRESH_MS = 5 * 60 * 1000;

export function isProd(env: Env) {
  return env.ENVIRONMENT === 'production';
}

export function cookieName(env: Env) {
  // O prefixo __Host- obriga a Secure, Path=/ e ausência de Domain.
  return isProd(env) ? '__Host-bmg_sessao' : 'bmg_sessao';
}

export async function createSession(c: Ctx, userId: string): Promise<{ id: string; stmt: D1PreparedStatement }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  const stmt = c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, absolute_expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    userId,
    new Date(now).toISOString(),
    new Date(now + IDLE_MS).toISOString(),
    new Date(now + ABSOLUTE_MS).toISOString(),
    new Date(now).toISOString(),
    (c.req.header('User-Agent') ?? '').slice(0, 200) || null,
  );
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: isProd(c.env),
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(ABSOLUTE_MS / 1000),
  });
  return { id, stmt };
}

export function clearSessionCookie(c: Ctx) {
  deleteCookie(c, cookieName(c.env), { path: '/', secure: isProd(c.env) });
}

interface SessionRow {
  sid: string;
  expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
  id: string;
  name: string;
  email: string;
  role: Role;
  active: number;
  must_change_password: number;
}

/** Carrega a sessão (se existir) e coloca o utilizador no contexto. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, cookieName(c.env));
  if (token && token.length < 200) {
    const sid = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.id AS sid, s.expires_at, s.absolute_expires_at, s.last_seen_at,
              u.id, u.name, u.email, u.role, u.active, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.revoked_at IS NULL`,
    )
      .bind(sid)
      .first<SessionRow>();
    const now = Date.now();
    if (row && row.active === 1 && Date.parse(row.expires_at) > now && Date.parse(row.absolute_expires_at) > now) {
      c.set('user', {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        mustChangePassword: row.must_change_password === 1,
      });
      c.set('sessionId', row.sid);
      if (now - Date.parse(row.last_seen_at) > REFRESH_MS) {
        const exp = Math.min(now + IDLE_MS, Date.parse(row.absolute_expires_at));
        await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
          .bind(new Date(now).toISOString(), new Date(exp).toISOString(), row.sid)
          .run();
      }
    }
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new ApiError(401, 'NAO_AUTENTICADO', 'É necessário iniciar sessão.');
  await next();
};

export function requirePerm(...perms: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new ApiError(401, 'NAO_AUTENTICADO', 'É necessário iniciar sessão.');
    for (const p of perms) {
      if (!can(user.role, p)) throw new ApiError(403, 'SEM_PERMISSAO', 'Não tem permissão para efetuar esta operação.');
    }
    await next();
  };
}

export function assertPerm(c: Ctx, perm: Permission) {
  const user = c.get('user');
  if (!user || !can(user.role, perm)) throw new ApiError(403, 'SEM_PERMISSAO', 'Não tem permissão para efetuar esta operação.');
}

/**
 * Proteção CSRF para pedidos que alteram dados:
 *  - o cookie de sessão é SameSite=Strict;
 *  - exige-se o cabeçalho personalizado X-BMG-CSRF (impossível de enviar
 *    entre origens sem um preflight CORS, que a API não autoriza);
 *  - quando presente, o cabeçalho Origin tem de pertencer às origens autorizadas.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    if (c.req.header('X-BMG-CSRF') !== '1') {
      throw new ApiError(403, 'CSRF', 'Pedido recusado por motivos de segurança (CSRF).');
    }
    const origin = c.req.header('Origin');
    if (origin) {
      const self = new URL(c.req.url).origin;
      const allowed = new Set([self, ...(c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)]);
      if (!allowed.has(origin)) throw new ApiError(403, 'ORIGEM', 'Origem do pedido não autorizada.');
    }
  }
  await next();
};
