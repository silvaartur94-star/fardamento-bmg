import { Hono } from 'hono';
import { z } from 'zod';
import { ROLE_PERMISSIONS, SETUP_STEPS } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, nowIso, parseBody, runBatch, uuid, type Ctx } from '../lib/core';
import { DUMMY_HASH, hashPassword, sha256Hex, timingSafeEqualStr, validatePasswordStrength, verifyPassword } from '../auth/crypto';
import { clearSessionCookie, createSession, requireAuth, requirePerm } from '../auth/session';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAIL_PER_EMAIL = 5;
const MAX_FAIL_PER_IP = 30;

async function failuresSince(db: D1Database, key: string, sinceIso: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
        WHERE key = ?1 AND success = 0 AND attempted_at > ?2
          AND attempted_at > COALESCE((SELECT MAX(attempted_at) FROM login_attempts WHERE key = ?1 AND success = 1), '')`,
    )
    .bind(key, sinceIso)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

function clientIp(c: Ctx) {
  return c.req.header('CF-Connecting-IP') ?? 'local';
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
  const body = await parseBody(
    c,
    z.object({ email: z.string().trim().min(1, 'Obrigatório').max(200), password: z.string().min(1, 'Obrigatório').max(200) }),
  );
  const db = c.env.DB;
  const emailKey = `email:${await sha256Hex(body.email.toLowerCase())}`;
  const ipKey = `ip:${await sha256Hex(clientIp(c))}`;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const [fe, fi] = await Promise.all([failuresSince(db, emailKey, since), failuresSince(db, ipKey, since)]);
  if (fe >= MAX_FAIL_PER_EMAIL || fi >= MAX_FAIL_PER_IP) {
    throw new ApiError(429, 'DEMASIADAS_TENTATIVAS', 'Demasiadas tentativas falhadas. Aguarde 15 minutos antes de tentar novamente.');
  }

  const user = await first<{ id: string; password_hash: string; active: number; name: string }>(
    db,
    'SELECT id, password_hash, active, name FROM users WHERE email = ? COLLATE NOCASE',
    body.email,
  );
  const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
  const now = nowIso();
  if (!user || !ok || user.active !== 1) {
    await runBatch(db, [
      db.prepare('INSERT INTO login_attempts (key, success, attempted_at) VALUES (?, 0, ?)').bind(emailKey, now),
      db.prepare('INSERT INTO login_attempts (key, success, attempted_at) VALUES (?, 0, ?)').bind(ipKey, now),
      auditStmt(c, 'auth.login_falhado', 'user', user?.id ?? null, { motivo: user && user.active !== 1 ? 'inativo' : 'credenciais' }, user?.id ?? null),
    ]);
    throw new ApiError(401, 'CREDENCIAIS_INVALIDAS', 'Email ou palavra-passe incorretos.');
  }
  const session = await createSession(c, user.id);
  await runBatch(db, [
    session.stmt,
    db.prepare('INSERT INTO login_attempts (key, success, attempted_at) VALUES (?, 1, ?)').bind(emailKey, now),
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, user.id),
    db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(new Date(Date.now() - 86400000).toISOString()),
    db.prepare('DELETE FROM sessions WHERE absolute_expires_at < ?').bind(new Date(Date.now() - 30 * 86400000).toISOString()),
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').bind(new Date(Date.now() - 7 * 86400000).toISOString()),
    auditStmt(c, 'auth.login', 'user', user.id, {}, user.id),
  ]);
  return c.json({ ok: true });
});

authRoutes.post('/logout', async (c) => {
  const sid = c.get('sessionId');
  if (sid) {
    await runBatch(c.env.DB, [
      c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(nowIso(), sid),
      auditStmt(c, 'auth.logout', 'user', c.get('user').id),
    ]);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ user: null });
  return c.json({ user, permissions: ROLE_PERMISSIONS[user.role] });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const body = await parseBody(c, z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }));
  const user = c.get('user');
  const row = await first<{ password_hash: string }>(c.env.DB, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
    throw new ApiError(422, 'PALAVRA_PASSE_ATUAL', 'A palavra-passe atual está incorreta.');
  }
  const weak = validatePasswordStrength(body.newPassword);
  if (weak) throw new ApiError(422, 'PALAVRA_PASSE_FRACA', weak);
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?').bind(
      await hashPassword(body.newPassword),
      now,
      now,
      user.id,
    ),
    // Termina as restantes sessões do utilizador.
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(now, user.id, c.get('sessionId')),
    auditStmt(c, 'auth.alterar_palavra_passe', 'user', user.id),
  ]);
  return c.json({ ok: true });
});

authRoutes.get('/sessions', requireAuth, async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT substr(id, 1, 12) AS id, created_at, last_seen_at, expires_at, user_agent
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
    c.get('user').id,
    nowIso(),
  );
  const current = c.get('sessionId').slice(0, 12);
  return c.json({ items: rows.map((r) => ({ ...r, current: r.id === current })) });
});

authRoutes.post('/sessions/revoke-others', requireAuth, async (c) => {
  const user = c.get('user');
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(nowIso(), user.id, c.get('sessionId')),
    auditStmt(c, 'auth.revogar_sessoes', 'user', user.id),
  ]);
  return c.json({ ok: true });
});

authRoutes.post('/sessions/:prefix/revoke', requireAuth, async (c) => {
  const user = c.get('user');
  const prefix = c.req.param('prefix');
  if (!/^[0-9a-f]{12}$/.test(prefix)) throw new ApiError(400, 'SESSAO_INVALIDA', 'Sessão inválida.');
  await runBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(id, 1, 12) = ? AND revoked_at IS NULL").bind(nowIso(), user.id, prefix),
    auditStmt(c, 'auth.revogar_sessao', 'user', user.id),
  ]);
  return c.json({ ok: true });
});

/** Redefinição de palavra-passe com um token de utilização única gerado por um administrador. */
authRoutes.post('/reset-password', async (c) => {
  const body = await parseBody(c, z.object({ token: z.string().min(20).max(200), newPassword: z.string().max(200) }));
  const id = await sha256Hex(body.token);
  const row = await first<{ user_id: string; expires_at: string; used_at: string | null }>(
    c.env.DB,
    'SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE id = ?',
    id,
  );
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    throw new ApiError(422, 'TOKEN_INVALIDO', 'A ligação de redefinição é inválida ou expirou. Peça uma nova ao administrador.');
  }
  const weak = validatePasswordStrength(body.newPassword);
  if (weak) throw new ApiError(422, 'PALAVRA_PASSE_FRACA', weak);
  const now = nowIso();
  await runBatch(c.env.DB, [
    // A condição used_at IS NULL torna o token de utilização única mesmo com pedidos concorrentes.
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, id),
    c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ?
        WHERE id = ? AND (SELECT used_at FROM password_reset_tokens WHERE id = ?) = ?`,
    ).bind(await hashPassword(body.newPassword), now, now, row.user_id, id, now),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, row.user_id),
    auditStmt(c, 'auth.redefinir_palavra_passe', 'user', row.user_id, {}, row.user_id),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Inicialização: criação do primeiro administrador
// ---------------------------------------------------------------------------
export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get('/status', async (c) => {
  const r = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM users');
  return c.json({ needsAdmin: (r?.n ?? 0) === 0, setupTokenConfigured: Boolean(c.env.SETUP_TOKEN) });
});

setupRoutes.post('/admin', async (c) => {
  const body = await parseBody(
    c,
    z.object({
      setupToken: z.string().min(1, 'Obrigatório').max(500),
      name: z.string().trim().min(1, 'Obrigatório').max(120),
      email: z.email('Email inválido').max(200),
      password: z.string().max(200),
    }),
  );
  if (!c.env.SETUP_TOKEN || c.env.SETUP_TOKEN.length < 16) {
    throw new ApiError(403, 'SETUP_INDISPONIVEL', 'O segredo SETUP_TOKEN não está configurado (mínimo 16 caracteres). Consulte o README.');
  }
  if (!timingSafeEqualStr(body.setupToken, c.env.SETUP_TOKEN)) {
    throw new ApiError(403, 'SETUP_TOKEN_INVALIDO', 'Código de inicialização inválido.');
  }
  const weak = validatePasswordStrength(body.password);
  if (weak) throw new ApiError(422, 'PALAVRA_PASSE_FRACA', weak);
  const id = uuid();
  const now = nowIso();
  const res = await runBatch(c.env.DB, [
    // Só cria se ainda não existir nenhum utilizador (garantido na mesma instrução).
    c.env.DB.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, active, created_at, updated_at, password_changed_at)
       SELECT ?, ?, ?, ?, 'admin', 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    ).bind(id, body.name, body.email, await hashPassword(body.password), now, now, now),
  ]);
  if (!res[0].meta.changes) throw new ApiError(409, 'SETUP_CONCLUIDO', 'O administrador inicial já foi criado.');
  c.set('user', { id, name: body.name, email: body.email, role: 'admin', mustChangePassword: false });
  const progress = Object.fromEntries(SETUP_STEPS.map((s) => [s.key, s.key === 'admin']));
  await runBatch(c.env.DB, [
    auditStmt(c, 'setup.admin_criado', 'user', id, { email: body.email }),
    c.env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'setup.progress'").bind(JSON.stringify(progress), now),
  ]);
  return c.json({ ok: true }, 201);
});

setupRoutes.get('/progress', requireAuth, async (c) => {
  const row = await first<{ value: string }>(c.env.DB, "SELECT value FROM settings WHERE key = 'setup.progress'");
  const counts = await first<Record<string, number>>(
    c.env.DB,
    `SELECT (SELECT COUNT(*) FROM locations WHERE active = 1) AS locations,
            (SELECT COUNT(*) FROM stock_movements WHERE movement_type = 'stock_inicial') AS initial_movements,
            (SELECT COUNT(*) FROM musicians) AS musicians,
            (SELECT COUNT(*) FROM musician_item_requests) AS requests,
            (SELECT COUNT(*) FROM item_types WHERE active = 1) AS item_types`,
  );
  return c.json({ steps: SETUP_STEPS, progress: JSON.parse(row?.value ?? '{}') as Record<string, boolean>, counts });
});

setupRoutes.post('/progress', requirePerm('settings.manage'), async (c) => {
  const body = await parseBody(c, z.object({ step: z.enum(SETUP_STEPS.map((s) => s.key) as [string, ...string[]]), done: z.boolean() }));
  const row = await first<{ value: string }>(c.env.DB, "SELECT value FROM settings WHERE key = 'setup.progress'");
  const progress = JSON.parse(row?.value ?? '{}') as Record<string, boolean>;
  progress[body.step] = body.done;
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('setup.progress', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    ).bind(JSON.stringify(progress), nowIso(), c.get('user').id),
    auditStmt(c, 'setup.progresso', 'settings', 'setup.progress', { passo: body.step, concluido: body.done }),
  ]);
  return c.json({ progress });
});
