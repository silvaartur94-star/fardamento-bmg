import { Hono } from 'hono';
import { z } from 'zod';
import { INCIDENT_KINDS, MOVEMENT_TYPES, REVERSIBLE_MOVEMENTS, type Condition, type MovementType, type Status } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, purgeAttachments, runBatch, runMutation, uuid, zDate, zOptId, zText } from '../lib/core';
import { requirePerm } from '../auth/session';
import { movementStmt } from '../services/stock';

export const movementRoutes = new Hono<AppEnv>();

export const MOVEMENT_SELECT = `
  SELECT m.seq, m.id, m.operation_id, m.movement_type, m.item_type_id, t.name AS item_type_name, m.garment_id, g.code AS garment_code,
         m.size_id, s.label AS size_label, m.quantity, m.from_status, m.from_condition, m.from_location_id, fl.name AS from_location_name,
         m.to_status, m.to_condition, m.to_location_id, tl.name AS to_location_name, m.musician_id, mu.full_name AS musician_name,
         m.ref_type, m.ref_id, m.reason, m.notes, m.verification, m.reverses_movement_id, m.created_at, m.created_by, u.name AS user_name,
         (SELECT r.id FROM stock_movements r WHERE r.reverses_movement_id = m.id) AS reversed_by
    FROM stock_movements m
    JOIN item_types t ON t.id = m.item_type_id
    JOIN users u ON u.id = m.created_by
    LEFT JOIN garments g ON g.id = m.garment_id
    LEFT JOIN item_sizes s ON s.id = m.size_id
    LEFT JOIN locations fl ON fl.id = m.from_location_id
    LEFT JOIN locations tl ON tl.id = m.to_location_id
    LEFT JOIN musicians mu ON mu.id = m.musician_id`;

export const movementFilters = pageQuery.extend({
  type: z.string().optional(),
  itemTypeId: z.string().optional(),
  sizeId: z.string().optional(),
  garmentId: z.string().optional(),
  musicianId: z.string().optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
  operationId: z.string().optional(),
  userId: z.string().optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export function movementWhere(f: z.infer<typeof movementFilters>) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.type) {
    const list = f.type.split(',').filter((t) => (MOVEMENT_TYPES as readonly string[]).includes(t));
    if (list.length) (where.push(`m.movement_type IN (${list.map(() => '?').join(',')})`), params.push(...list));
  }
  if (f.itemTypeId) (where.push('m.item_type_id = ?'), params.push(f.itemTypeId));
  if (f.sizeId) (where.push('m.size_id = ?'), params.push(f.sizeId));
  if (f.garmentId) (where.push('m.garment_id = ?'), params.push(f.garmentId));
  if (f.musicianId) (where.push('m.musician_id = ?'), params.push(f.musicianId));
  if (f.refType) (where.push('m.ref_type = ?'), params.push(f.refType));
  if (f.refId) (where.push('m.ref_id = ?'), params.push(f.refId));
  if (f.operationId) (where.push('m.operation_id = ?'), params.push(f.operationId));
  if (f.userId) (where.push('m.created_by = ?'), params.push(f.userId));
  if (f.from) (where.push('m.created_at >= ?'), params.push(f.from));
  if (f.to) (where.push('m.created_at <= ?'), params.push(`${f.to}T23:59:59.999Z`));
  if (f.q) (where.push("(g.code LIKE ? ESCAPE '\\' OR m.reason LIKE ? ESCAPE '\\' OR mu.full_name LIKE ? ESCAPE '\\')"), params.push(likeTerm(f.q), likeTerm(f.q), likeTerm(f.q)));
  return { sql: where.join(' AND '), params };
}

movementRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, movementFilters);
  const w = movementWhere(f);
  const { limit, offset } = paging(f);
  const items = await all(c.env.DB, `${MOVEMENT_SELECT} WHERE ${w.sql} ORDER BY m.seq DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset);
  const total = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM stock_movements m LEFT JOIN garments g ON g.id = m.garment_id LEFT JOIN musicians mu ON mu.id = m.musician_id WHERE ${w.sql}`,
    ...w.params,
  );
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

/** Estorno: cria um movimento inverso, preservando o registo original. */
movementRoutes.post('/:id/reverse', requirePerm('inventory.reverse'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3, 'Indique o motivo do estorno').max(500) }));
  const m = await first<{
    id: string;
    movement_type: MovementType;
    item_type_id: string;
    garment_id: string | null;
    size_id: string | null;
    quantity: number;
    from_status: Status | null;
    from_condition: Condition | null;
    from_location_id: string | null;
    to_status: Status | null;
    to_condition: Condition | null;
    to_location_id: string | null;
    musician_id: string | null;
  }>(c.env.DB, 'SELECT * FROM stock_movements WHERE id = ?', id);
  if (!m) notFound('Movimento');
  if (!REVERSIBLE_MOVEMENTS.includes(m.movement_type)) {
    throw new ApiError(409, 'NAO_ESTORNAVEL', 'Este movimento está associado a uma operação (entrega, recolha, empréstimo). Corrija-o através dessa operação.');
  }
  const already = await first(c.env.DB, 'SELECT id FROM stock_movements WHERE reverses_movement_id = ?', id);
  if (already) throw new ApiError(409, 'JA_ESTORNADO', 'Este movimento já foi estornado.');
  const from = m.to_status ? { status: m.to_status, condition: m.to_condition as Condition, locationId: m.to_location_id } : null;
  let to = m.from_status ? { status: m.from_status, condition: m.from_condition as Condition, locationId: m.from_location_id } : null;
  if (m.garment_id && !to) {
    // Peça introduzida por engano: fica registada como rejeitada (o código nunca é reutilizado).
    to = { status: 'rejeitado', condition: (m.to_condition ?? 'bom') as Condition, locationId: null };
  }
  const mv = movementStmt(c, {
    operationId: uuid(),
    type: 'estorno',
    itemTypeId: m.item_type_id,
    garmentId: m.garment_id,
    sizeId: m.size_id,
    quantity: m.quantity,
    from,
    to,
    musicianId: m.musician_id,
    refType: 'movement',
    refId: m.id,
    reason: b.reason,
    reversesMovementId: m.id,
  });
  const res = await runMutation(c, [mv.stmt, auditStmt(c, 'movimento.estornar', 'stock_movement', m.id, { motivo: b.reason, estorno: mv.id })], {
    scope: 'movements.reverse',
    response: { movementId: mv.id },
  });
  return c.json(res.response);
});

// ---------------------------------------------------------------------------
// Ocorrências
// ---------------------------------------------------------------------------
export const incidentRoutes = new Hono<AppEnv>();

incidentRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(
    c,
    pageQuery.extend({ garmentId: z.string().optional(), loanId: z.string().optional(), eventId: z.string().optional(), musicianId: z.string().optional(), open: z.string().optional() }),
  );
  const where = ['1=1'];
  const params: unknown[] = [];
  for (const [k, col] of [
    ['garmentId', 'i.garment_id'],
    ['loanId', 'i.loan_id'],
    ['eventId', 'i.event_id'],
    ['musicianId', 'i.musician_id'],
  ] as const) {
    if (f[k]) (where.push(`${col} = ?`), params.push(f[k]));
  }
  if (f.open === '1') where.push('i.resolved_at IS NULL');
  const { limit, offset } = paging(f);
  const items = await all(
    c.env.DB,
    `SELECT i.*, u.name AS user_name, g.code AS garment_code, mu.full_name AS musician_name, e.name AS event_name
       FROM incidents i JOIN users u ON u.id = i.created_by LEFT JOIN garments g ON g.id = i.garment_id
       LEFT JOIN musicians mu ON mu.id = i.musician_id LEFT JOIN events e ON e.id = i.event_id
      WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return c.json({ items });
});

incidentRoutes.post('/', requirePerm('inventory.write'), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      kind: z.enum(INCIDENT_KINDS),
      description: z.string().trim().min(3, 'Descreva a ocorrência').max(2000),
      garmentId: zOptId,
      musicianId: zOptId,
      loanId: zOptId,
      eventId: zOptId,
      returnId: zOptId,
      occurredAt: zDate.optional(),
    }),
  );
  const id = uuid();
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'INSERT INTO incidents (id, kind, description, garment_id, musician_id, loan_id, event_id, return_id, occurred_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, b.kind, b.description, b.garmentId, b.musicianId, b.loanId, b.eventId, b.returnId, b.occurredAt ? `${b.occurredAt}T12:00:00.000Z` : now, c.get('user').id, now),
    auditStmt(c, 'ocorrencia.registar', 'incident', id, b),
  ]);
  return c.json({ id }, 201);
});

incidentRoutes.post('/:id/resolve', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ resolution: zText(2000) }));
  const res = await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE incidents SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL').bind(nowIso(), b.resolution, id),
    auditStmt(c, 'ocorrencia.resolver', 'incident', id, b),
  ]);
  if (!res[0].meta.changes) notFound('Ocorrência por resolver');
  return c.json({ ok: true });
});

incidentRoutes.delete('/:id', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const i = await first<{ kind: string; description: string }>(c.env.DB, 'SELECT kind, description FROM incidents WHERE id = ?', id);
  if (!i) notFound('Ocorrência');
  await runBatch(c.env.DB, [
    ...(await purgeAttachments(c.env, 'incident', [id])),
    c.env.DB.prepare('DELETE FROM incidents WHERE id = ?').bind(id),
    auditStmt(c, 'ocorrencia.eliminar', 'incident', id, i),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get('/', requirePerm('audit.read'), async (c) => {
  const f = parseQuery(
    c,
    pageQuery.extend({ entityType: z.string().optional(), entityId: z.string().optional(), userId: z.string().optional(), action: z.string().optional(), from: zDate.optional(), to: zDate.optional() }),
  );
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.entityType) (where.push('a.entity_type = ?'), params.push(f.entityType));
  if (f.entityId) (where.push('a.entity_id = ?'), params.push(f.entityId));
  if (f.userId) (where.push('a.user_id = ?'), params.push(f.userId));
  if (f.action) (where.push("a.action LIKE ? ESCAPE '\\'"), params.push(likeTerm(f.action)));
  if (f.from) (where.push('a.created_at >= ?'), params.push(f.from));
  if (f.to) (where.push('a.created_at <= ?'), params.push(`${f.to}T23:59:59.999Z`));
  if (f.q) (where.push("a.summary LIKE ? ESCAPE '\\'"), params.push(likeTerm(f.q)));
  const { limit, offset } = paging(f);
  const items = await all(
    c.env.DB,
    `SELECT a.seq, a.id, a.action, a.entity_type, a.entity_id, a.summary, a.request_id, a.created_at, a.user_id, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.seq DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM audit_logs a WHERE ${where.join(' AND ')}`, ...params);
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

