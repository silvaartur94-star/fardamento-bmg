import { Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, notFound, nowIso, parseBody, runBatch, uuid } from '../lib/core';
import { hashPassword, randomToken, sha256Hex, validatePasswordStrength } from '../auth/crypto';
import { requirePerm } from '../auth/session';

export const userRoutes = new Hono<AppEnv>();
userRoutes.use('*', requirePerm('users.manage'));

userRoutes.get('/', async (c) => {
  const items = await all(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.role, u.active, u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
       FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE`,
    nowIso(),
  );
  return c.json({ items });
});

userRoutes.post('/', async (c) => {
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1, 'Obrigatório').max(120),
      email: z.email('Email inválido').max(200),
      role: z.enum(ROLES),
      password: z.string().max(200),
    }),
  );
  const weak = validatePasswordStrength(body.password);
  if (weak) throw new ApiError(422, 'PALAVRA_PASSE_FRACA', weak);
  const exists = await first(c.env.DB, 'SELECT id FROM users WHERE email = ? COLLATE NOCASE', body.email);
  if (exists) throw new ApiError(409, 'EMAIL_EM_USO', 'Já existe um utilizador com este email.');
  const id = uuid();
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'INSERT INTO users (id, name, email, password_hash, role, active, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)',
    ).bind(id, body.name, body.email, await hashPassword(body.password), body.role, now, now),
    auditStmt(c, 'utilizador.criar', 'user', id, { nome: body.name, email: body.email, perfil: body.role }),
  ]);
  return c.json({ id }, 201);
});

userRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
      active: z.boolean().optional(),
    }),
  );
  const user = await first<{ id: string; role: string; active: number; name: string }>(c.env.DB, 'SELECT id, role, active, name FROM users WHERE id = ?', id);
  if (!user) notFound('Utilizador');
  const me = c.get('user');
  if (id === me.id && (body.active === false || (body.role && body.role !== 'admin'))) {
    throw new ApiError(409, 'AUTO_BLOQUEIO', 'Não pode desativar a sua própria conta nem retirar-se o perfil de administrador.');
  }
  // Garante que fica sempre pelo menos um administrador ativo.
  if (user.role === 'admin' && (body.active === false || (body.role && body.role !== 'admin'))) {
    const admins = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
    if ((admins?.n ?? 0) <= 1) throw new ApiError(409, 'ULTIMO_ADMIN', 'Tem de existir pelo menos um administrador ativo.');
  }
  const now = nowIso();
  const stmts = [
    c.env.DB.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active), updated_at = ? WHERE id = ?').bind(
      body.name ?? null,
      body.role ?? null,
      body.active === undefined ? null : body.active ? 1 : 0,
      now,
      id,
    ),
    auditStmt(c, 'utilizador.editar', 'user', id, { antes: { perfil: user.role, ativo: user.active, nome: user.name }, depois: body }),
  ];
  if (body.active === false || (body.role && body.role !== user.role)) {
    stmts.push(c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, id));
  }
  await runBatch(c.env.DB, stmts);
  return c.json({ ok: true });
});

/** Gera uma ligação de redefinição de palavra-passe de utilização única (válida 24 horas). */
userRoutes.post('/:id/reset-link', async (c) => {
  const id = c.req.param('id');
  const user = await first(c.env.DB, 'SELECT id FROM users WHERE id = ?', id);
  if (!user) notFound('Utilizador');
  const token = randomToken(32);
  const now = Date.now();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(nowIso(), id),
    c.env.DB.prepare('INSERT INTO password_reset_tokens (id, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
      await sha256Hex(token),
      id,
      c.get('user').id,
      new Date(now).toISOString(),
      new Date(now + 24 * 3600 * 1000).toISOString(),
    ),
    auditStmt(c, 'utilizador.gerar_redefinicao', 'user', id),
  ]);
  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/redefinir-palavra-passe#token=${token}`, expiresInHours: 24 });
});

userRoutes.post('/:id/revoke-sessions', async (c) => {
  const id = c.req.param('id');
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(nowIso(), id),
    auditStmt(c, 'utilizador.revogar_sessoes', 'user', id),
  ]);
  return c.json({ ok: true });
});
