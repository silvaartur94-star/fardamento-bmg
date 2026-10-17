import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, notFound, nowIso, parseBody, runBatch, runDelete, uuid, zText } from '../lib/core';
import { requirePerm } from '../auth/session';

// ---------------------------------------------------------------------------
// Tipos de artigo e tamanhos
// ---------------------------------------------------------------------------
export const itemTypeRoutes = new Hono<AppEnv>();

itemTypeRoutes.get('/', requirePerm('read'), async (c) => {
  const types = await all<Record<string, unknown> & { id: string }>(
    c.env.DB,
    `SELECT t.*,
            (SELECT COUNT(*) FROM garments g WHERE g.item_type_id = t.id) AS garment_count,
            (SELECT COUNT(*) FROM stock_movements m WHERE m.item_type_id = t.id) AS movement_count
       FROM item_types t ORDER BY t.sort_order, t.name COLLATE NOCASE`,
  );
  const sizes = await all<{ item_type_id: string }>(c.env.DB, 'SELECT * FROM item_sizes ORDER BY sort_order, label');
  return c.json({
    items: types.map((t) => ({ ...t, locked: Number(t.garment_count) > 0 || Number(t.movement_count) > 0, sizes: sizes.filter((s) => s.item_type_id === t.id) })),
  });
});

const typeSchema = z.object({
  name: z.string().trim().min(1, 'Obrigatório').max(80),
  category: z.string().trim().min(1, 'Obrigatório').max(80),
  description: zText(500),
  codePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,6}$/, 'Prefixo com 2 a 6 letras'),
  hasSize: z.boolean(),
  sizeKind: z.enum(['alfanumerico', 'numerico', 'livre']),
  allowsInscription: z.boolean(),
  trackingMode: z.enum(['individual', 'quantidade']),
  procurementEnabled: z.boolean(),
  stockEnabled: z.boolean(),
  minAvailable: z.number().int().min(0).nullish(),
  sortOrder: z.number().int().min(0).max(10000).default(100),
  active: z.boolean().default(true),
});

itemTypeRoutes.post('/', requirePerm('settings.manage'), async (c) => {
  const b = await parseBody(c, typeSchema);
  const id = uuid();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      `INSERT INTO item_types (id, name, category, description, code_prefix, has_size, size_kind, allows_inscription, tracking_mode,
         procurement_enabled, stock_enabled, min_available, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      b.name,
      b.category,
      b.description,
      b.codePrefix,
      b.hasSize ? 1 : 0,
      b.sizeKind,
      b.allowsInscription ? 1 : 0,
      b.trackingMode,
      b.procurementEnabled ? 1 : 0,
      b.stockEnabled ? 1 : 0,
      b.minAvailable ?? null,
      b.sortOrder,
      b.active ? 1 : 0,
    ),
    auditStmt(c, 'tipo_artigo.criar', 'item_type', id, b),
  ]);
  return c.json({ id }, 201);
});

itemTypeRoutes.patch('/:id', requirePerm('settings.manage'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, typeSchema.partial());
  const cur = await first<Record<string, unknown>>(c.env.DB, 'SELECT * FROM item_types WHERE id = ?', id);
  if (!cur) notFound('Tipo de artigo');
  const map: Record<string, [string, (v: unknown) => unknown]> = {
    name: ['name', (v) => v],
    category: ['category', (v) => v],
    description: ['description', (v) => v],
    codePrefix: ['code_prefix', (v) => v],
    hasSize: ['has_size', (v) => (v ? 1 : 0)],
    sizeKind: ['size_kind', (v) => v],
    allowsInscription: ['allows_inscription', (v) => (v ? 1 : 0)],
    trackingMode: ['tracking_mode', (v) => v],
    procurementEnabled: ['procurement_enabled', (v) => (v ? 1 : 0)],
    stockEnabled: ['stock_enabled', (v) => (v ? 1 : 0)],
    minAvailable: ['min_available', (v) => v ?? null],
    sortOrder: ['sort_order', (v) => v],
    active: ['active', (v) => (v ? 1 : 0)],
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || !map[k]) continue;
    sets.push(`${map[k][0]} = ?`);
    vals.push(map[k][1](v));
  }
  if (b.codePrefix && b.codePrefix !== cur.code_prefix) {
    const used = await first(c.env.DB, 'SELECT 1 FROM garments WHERE item_type_id = ? LIMIT 1', id);
    if (used) throw new ApiError(409, 'PREFIXO_EM_USO', 'Não é possível alterar o prefixo de um tipo que já tem peças codificadas.');
  }
  if (!sets.length) return c.json({ ok: true });
  sets.push('updated_at = ?');
  vals.push(nowIso());
  await runBatch(c.env.DB, [
    c.env.DB.prepare(`UPDATE item_types SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id),
    auditStmt(c, 'tipo_artigo.editar', 'item_type', id, b),
  ]);
  return c.json({ ok: true });
});

const sizeSchema = z.object({
  label: z.string().trim().min(1, 'Obrigatório').max(20),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
});

itemTypeRoutes.post('/:id/sizes', requirePerm('settings.manage'), async (c) => {
  const typeId = c.req.param('id');
  const b = await parseBody(c, sizeSchema);
  const t = await first(c.env.DB, 'SELECT id FROM item_types WHERE id = ?', typeId);
  if (!t) notFound('Tipo de artigo');
  const max = await first<{ m: number }>(c.env.DB, 'SELECT COALESCE(MAX(sort_order), 0) AS m FROM item_sizes WHERE item_type_id = ?', typeId);
  const id = uuid();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('INSERT INTO item_sizes (id, item_type_id, label, sort_order, active) VALUES (?, ?, ?, ?, 1)').bind(
      id,
      typeId,
      b.label,
      b.sortOrder ?? (max?.m ?? 0) + 10,
    ),
    auditStmt(c, 'tamanho.criar', 'item_type', typeId, { tamanho: b.label }),
  ]);
  return c.json({ id }, 201);
});

itemTypeRoutes.patch('/:id/sizes/:sizeId', requirePerm('settings.manage'), async (c) => {
  const { id, sizeId } = c.req.param();
  const b = await parseBody(c, sizeSchema.partial());
  const s = await first<{ label: string }>(c.env.DB, 'SELECT label FROM item_sizes WHERE id = ? AND item_type_id = ?', sizeId, id);
  if (!s) notFound('Tamanho');
  if (b.label && b.label !== s.label) {
    const used = await first(
      c.env.DB,
      `SELECT 1 FROM garments WHERE size_id = ?1 UNION ALL SELECT 1 FROM stock_movements WHERE size_id = ?1
        UNION ALL SELECT 1 FROM musician_item_requests WHERE size_id = ?1 LIMIT 1`,
      sizeId,
    );
    if (used) throw new ApiError(409, 'TAMANHO_EM_USO', 'Este tamanho já está em uso; desative-o e crie um novo em vez de o renomear.');
  }
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE item_sizes SET label = COALESCE(?, label), sort_order = COALESCE(?, sort_order), active = COALESCE(?, active) WHERE id = ?').bind(
      b.label ?? null,
      b.sortOrder ?? null,
      b.active === undefined ? null : b.active ? 1 : 0,
      sizeId,
    ),
    auditStmt(c, 'tamanho.editar', 'item_type', id, { tamanho: sizeId, ...b }),
  ]);
  return c.json({ ok: true });
});

itemTypeRoutes.delete('/:id', requirePerm('settings.manage'), async (c) => {
  const id = c.req.param('id');
  const t = await first<{ name: string }>(c.env.DB, 'SELECT name FROM item_types WHERE id = ?', id);
  if (!t) notFound('Tipo de artigo');
  await runDelete(
    c.env.DB,
    [
      c.env.DB.prepare('DELETE FROM item_sizes WHERE item_type_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM item_types WHERE id = ?').bind(id),
      auditStmt(c, 'tipo_artigo.eliminar', 'item_type', id, { nome: t.name }),
    ],
    `«${t.name}» já tem necessidades, stock ou movimentos registados e não pode ser eliminado. Pode desativá-lo.`,
  );
  return c.json({ ok: true });
});

itemTypeRoutes.delete('/:id/sizes/:sizeId', requirePerm('settings.manage'), async (c) => {
  const { id, sizeId } = c.req.param();
  const s = await first<{ label: string }>(c.env.DB, 'SELECT label FROM item_sizes WHERE id = ? AND item_type_id = ?', sizeId, id);
  if (!s) notFound('Tamanho');
  await runDelete(
    c.env.DB,
    [c.env.DB.prepare('DELETE FROM item_sizes WHERE id = ?').bind(sizeId), auditStmt(c, 'tamanho.eliminar', 'item_type', id, { tamanho: s.label })],
    `O tamanho «${s.label}» já está em uso e não pode ser eliminado. Pode desativá-lo.`,
  );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Localizações físicas
// ---------------------------------------------------------------------------
export const locationRoutes = new Hono<AppEnv>();

locationRoutes.get('/', requirePerm('read'), async (c) => {
  const items = await all(c.env.DB, 'SELECT * FROM locations ORDER BY active DESC, name COLLATE NOCASE');
  return c.json({ items });
});

const locSchema = z.object({ name: z.string().trim().min(1, 'Obrigatório').max(80), description: zText(300), active: z.boolean().optional() });

locationRoutes.post('/', requirePerm('settings.manage'), async (c) => {
  const b = await parseBody(c, locSchema);
  const id = uuid();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('INSERT INTO locations (id, name, description, active) VALUES (?, ?, ?, 1)').bind(id, b.name, b.description),
    auditStmt(c, 'localizacao.criar', 'location', id, b),
  ]);
  return c.json({ id }, 201);
});

locationRoutes.patch('/:id', requirePerm('settings.manage'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, locSchema.partial());
  const cur = await first(c.env.DB, 'SELECT id FROM locations WHERE id = ?', id);
  if (!cur) notFound('Localização');
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'UPDATE locations SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END, active = COALESCE(?, active), updated_at = ? WHERE id = ?',
    ).bind(b.name ?? null, b.description !== undefined ? 1 : 0, b.description ?? null, b.active === undefined ? null : b.active ? 1 : 0, nowIso(), id),
    auditStmt(c, 'localizacao.editar', 'location', id, b),
  ]);
  return c.json({ ok: true });
});

locationRoutes.delete('/:id', requirePerm('settings.manage'), async (c) => {
  const id = c.req.param('id');
  const l = await first<{ name: string }>(c.env.DB, 'SELECT name FROM locations WHERE id = ?', id);
  if (!l) notFound('Localização');
  await runDelete(
    c.env.DB,
    [c.env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(id), auditStmt(c, 'localizacao.eliminar', 'location', id, { nome: l.name })],
    `A localização «${l.name}» já foi usada em peças, stock ou movimentos e não pode ser eliminada. Pode desativá-la.`,
  );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Configurações gerais (lista branca de chaves)
// ---------------------------------------------------------------------------
const SETTINGS_SCHEMAS: Record<string, z.ZodType> = {
  'uploads.max_bytes': z.number().int().min(100_000).max(20_000_000),
  'loans.default_due_days': z.number().int().min(0).max(365),
};

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get('/', requirePerm('read'), async (c) => {
  const rows = await all<{ key: string; value: string }>(c.env.DB, "SELECT key, value FROM settings WHERE key != 'setup.progress'");
  return c.json({ settings: Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) });
});

settingsRoutes.put('/:key', requirePerm('settings.manage'), async (c) => {
  const key = c.req.param('key');
  const schema = SETTINGS_SCHEMAS[key];
  if (!schema) throw new ApiError(404, 'CONFIG_DESCONHECIDA', 'Configuração desconhecida.');
  const b = await parseBody(c, z.object({ value: schema }));
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    ).bind(key, JSON.stringify(b.value), nowIso(), c.get('user').id),
    auditStmt(c, 'configuracao.editar', 'settings', key, { valor: b.value }),
  ]);
  return c.json({ ok: true });
});

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const r = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}
