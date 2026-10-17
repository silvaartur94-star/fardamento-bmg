import { Hono } from 'hono';
import { z } from 'zod';
import {
  CONDITIONS,
  COUNTABLE_STATUSES,
  INVENTORY_TRANSITIONS,
  ORIGINS,
  STATUSES,
  VERIFICATIONS,
  transitionMovementType,
  type Status,
} from '../../shared/domain';
import type { AppEnv } from '../env';
import {
  ApiError,
  all,
  auditStmt,
  first,
  likeTerm,
  notFound,
  nowIso,
  orderBy,
  pageQuery,
  paging,
  parseBody,
  parseQuery,
  purgeAttachments,
  runBatch,
  runMutation,
  todayIso,
  uuid,
  zDate,
  zOptId,
  zQty,
  zText,
} from '../lib/core';
import { assertPerm, requirePerm } from '../auth/session';
import { assertSize, bucketKey, consistencyReport, garmentInsertStmt, getBalance, getGarment, getItemType, movementStmt } from '../services/stock';

export const inventoryRoutes = new Hono<AppEnv>();

const zStatus = z.enum(STATUSES);
const zCondition = z.enum(CONDITIONS);
const WRITEOFF: Status[] = ['abatido', 'extraviado', 'rejeitado'];

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export const GARMENT_SELECT = `
  SELECT g.id, g.code, g.legacy_code, g.item_type_id, t.name AS item_type_name, g.size_id, s.label AS size_label,
         g.inscription, g.condition, g.status, g.origin, g.verification, g.entry_date, g.cost_cents,
         g.location_id, l.name AS location_name, g.holder_musician_id, m.full_name AS holder_name, g.notes,
         g.last_counted_at, g.created_at, g.updated_at
    FROM garments g
    JOIN item_types t ON t.id = g.item_type_id
    LEFT JOIN item_sizes s ON s.id = g.size_id
    LEFT JOIN locations l ON l.id = g.location_id
    LEFT JOIN musicians m ON m.id = g.holder_musician_id`;

export const garmentFilters = pageQuery.extend({
  itemTypeId: z.string().optional(),
  sizeId: z.string().optional(),
  status: z.string().optional(),
  condition: z.string().optional(),
  locationId: z.string().optional(),
  origin: z.string().optional(),
  holderId: z.string().optional(),
});

export function garmentWhere(f: z.infer<typeof garmentFilters>) {
  const where: string[] = ['g.status IS NOT NULL'];
  const params: unknown[] = [];
  if (f.q) {
    where.push("(g.code LIKE ? ESCAPE '\\' OR g.legacy_code LIKE ? ESCAPE '\\' OR g.inscription LIKE ? ESCAPE '\\' OR g.notes LIKE ? ESCAPE '\\')");
    const t = likeTerm(f.q);
    params.push(t, t, t, t);
  }
  if (f.itemTypeId) (where.push('g.item_type_id = ?'), params.push(f.itemTypeId));
  if (f.sizeId) (where.push('g.size_id = ?'), params.push(f.sizeId));
  if (f.status) {
    const list = f.status.split(',').filter((s) => (STATUSES as readonly string[]).includes(s));
    if (list.length) (where.push(`g.status IN (${list.map(() => '?').join(',')})`), params.push(...list));
  }
  if (f.condition) (where.push('g.condition = ?'), params.push(f.condition));
  if (f.locationId) (where.push('g.location_id = ?'), params.push(f.locationId));
  if (f.origin) (where.push('g.origin = ?'), params.push(f.origin));
  if (f.holderId) (where.push('g.holder_musician_id = ?'), params.push(f.holderId));
  return { sql: where.join(' AND '), params };
}

inventoryRoutes.get('/garments', requirePerm('read'), async (c) => {
  const f = parseQuery(c, garmentFilters);
  const w = garmentWhere(f);
  const order = orderBy(
    f.sort,
    f.dir,
    { code: 'g.serial', type: 't.name', size: 's.sort_order', status: 'g.status', condition: 'g.condition', location: 'l.name', entry: 'g.entry_date' },
    'g.serial DESC',
  );
  const { limit, offset } = paging(f);
  const items = await all(c.env.DB, `${GARMENT_SELECT} WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...w.params, limit, offset);
  const total = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM garments g JOIN item_types t ON t.id = g.item_type_id LEFT JOIN item_sizes s ON s.id = g.size_id LEFT JOIN locations l ON l.id = g.location_id WHERE ${w.sql}`,
    ...w.params,
  );
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

inventoryRoutes.get('/garments/by-code/:code', requirePerm('read'), async (c) => {
  const code = c.req.param('code').trim();
  const g = await first(c.env.DB, `${GARMENT_SELECT} WHERE g.code = ? COLLATE NOCASE OR g.legacy_code = ? COLLATE NOCASE LIMIT 1`, code, code);
  if (!g) notFound('Peça');
  return c.json(g);
});

inventoryRoutes.get('/garments/:id', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const g = await first(db, `${GARMENT_SELECT} WHERE g.id = ?`, id);
  if (!g) notFound('Peça');
  const [movements, deliveries, loans, returns, incidents, attachments] = await Promise.all([
    all(
      db,
      `SELECT m.*, u.name AS user_name, mu.full_name AS musician_name, fl.name AS from_location_name, tl.name AS to_location_name
         FROM stock_movements m JOIN users u ON u.id = m.created_by
         LEFT JOIN musicians mu ON mu.id = m.musician_id
         LEFT JOIN locations fl ON fl.id = m.from_location_id LEFT JOIN locations tl ON tl.id = m.to_location_id
        WHERE m.garment_id = ? ORDER BY m.seq DESC`,
      id,
    ),
    all(
      db,
      `SELECT dl.id, dl.status, d.id AS delivery_id, d.delivered_at, mu.full_name AS musician_name, mu.id AS musician_id
         FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id JOIN musicians mu ON mu.id = d.musician_id
        WHERE dl.garment_id = ? ORDER BY d.delivered_at DESC`,
      id,
    ),
    all(
      db,
      `SELECT ll.id, ll.returned_quantity, ll.lost_quantity, lo.id AS loan_id, lo.delivered_at, e.name AS event_name, mu.full_name AS musician_name
         FROM loan_lines ll JOIN loans lo ON lo.id = ll.loan_id JOIN events e ON e.id = lo.event_id JOIN musicians mu ON mu.id = lo.musician_id
        WHERE ll.garment_id = ? ORDER BY lo.delivered_at DESC`,
      id,
    ),
    all(
      db,
      `SELECT rl.id, rl.observed_condition, rl.approved_destination, r.id AS return_id, r.received_at, mu.full_name AS musician_name
         FROM garment_return_lines rl JOIN garment_returns r ON r.id = rl.return_id JOIN musicians mu ON mu.id = r.musician_id
        WHERE rl.garment_id = ? ORDER BY r.received_at DESC`,
      id,
    ),
    all(db, 'SELECT i.*, u.name AS user_name FROM incidents i JOIN users u ON u.id = i.created_by WHERE i.garment_id = ? ORDER BY i.occurred_at DESC', id),
    all(db, "SELECT id, caption, content_type, uploaded_at, thumb_r2_key IS NOT NULL AS has_thumb FROM attachments WHERE entity_type = 'garment' AND entity_id = ? AND deleted_at IS NULL", id),
  ]);
  return c.json({ garment: g, movements, deliveries, loans, returns, incidents, attachments });
});

inventoryRoutes.patch('/garments/:id', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({
      inscription: zText(120).optional(),
      legacyCode: zText(60).optional(),
      notes: zText(2000).optional(),
      costCents: z.number().int().min(0).nullish(),
      sizeId: zOptId.optional(),
      entryDate: zDate.optional(),
    }),
  );
  const g = await getGarment(c.env.DB, id);
  const type = await getItemType(c.env.DB, g.item_type_id);
  if (b.inscription && !type.allows_inscription) throw new ApiError(422, 'SEM_INSCRICAO', 'Este tipo de artigo não admite inscrição.');
  if (b.sizeId !== undefined) await assertSize(c.env.DB, type, b.sizeId);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const cols: Record<string, string> = { inscription: 'inscription', legacyCode: 'legacy_code', notes: 'notes', costCents: 'cost_cents', sizeId: 'size_id', entryDate: 'entry_date' };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    vals.push(v ?? null);
  }
  if (!sets.length) return c.json({ ok: true });
  await runBatch(c.env.DB, [
    c.env.DB.prepare(`UPDATE garments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, nowIso(), id),
    auditStmt(c, 'peca.editar', 'garment', id, { codigo: g.code, antes: { inscricao: g.inscription, tamanho: g.size_id }, alteracoes: b }),
  ]);
  return c.json({ ok: true });
});

export const BALANCE_SELECT = `
  SELECT b.bucket_key, b.item_type_id, t.name AS item_type_name, b.size_id, s.label AS size_label, b.condition, b.location_id,
         l.name AS location_name, b.status, b.quantity, b.verification, b.last_counted_at, b.updated_at
    FROM stock_balances b
    JOIN item_types t ON t.id = b.item_type_id
    LEFT JOIN item_sizes s ON s.id = b.size_id
    LEFT JOIN locations l ON l.id = b.location_id`;

export const balanceFilters = z.object({
  itemTypeId: z.string().optional(),
  sizeId: z.string().optional(),
  status: z.string().optional(),
  condition: z.string().optional(),
  locationId: z.string().optional(),
  includeZero: z.string().optional(),
});

export function balanceWhere(f: z.infer<typeof balanceFilters>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.includeZero !== '1') where.push('b.quantity > 0');
  if (f.itemTypeId) (where.push('b.item_type_id = ?'), params.push(f.itemTypeId));
  if (f.sizeId) (where.push('b.size_id = ?'), params.push(f.sizeId));
  if (f.status) {
    const list = f.status.split(',').filter((s) => (STATUSES as readonly string[]).includes(s));
    if (list.length) (where.push(`b.status IN (${list.map(() => '?').join(',')})`), params.push(...list));
  }
  if (f.condition) (where.push('b.condition = ?'), params.push(f.condition));
  if (f.locationId) (where.push('b.location_id = ?'), params.push(f.locationId));
  return { sql: where.length ? where.join(' AND ') : '1=1', params };
}

inventoryRoutes.get('/balances', requirePerm('read'), async (c) => {
  const f = parseQuery(c, balanceFilters);
  const w = balanceWhere(f);
  const items = await all(c.env.DB, `${BALANCE_SELECT} WHERE ${w.sql} ORDER BY t.sort_order, s.sort_order, b.status, b.condition LIMIT 2000`, ...w.params);
  return c.json({ items });
});

/** Resumo por tipo e tamanho, com as quantidades separadas por estado (peças + quantidades). */
inventoryRoutes.get('/summary', requirePerm('read'), async (c) => {
  const f = parseQuery(c, z.object({ itemTypeId: z.string().optional(), locationId: z.string().optional() }));
  const items = await summaryRows(c.env.DB, f);
  return c.json({ items });
});

export async function summaryRows(db: D1Database, f: { itemTypeId?: string; locationId?: string }) {
  const params: unknown[] = [];
  let gw = 'g.status IS NOT NULL';
  let bw = 'b.quantity > 0';
  if (f.itemTypeId) {
    gw += ' AND g.item_type_id = ?';
    bw += ' AND b.item_type_id = ?';
  }
  if (f.locationId) {
    gw += ' AND g.location_id = ?';
    bw += ' AND b.location_id = ?';
  }
  const gp = [f.itemTypeId, f.locationId].filter(Boolean);
  params.push(...gp, ...gp);
  const statusCols = STATUSES.map((s) => `SUM(CASE WHEN x.status = '${s}' THEN x.q ELSE 0 END) AS ${s}`).join(', ');
  return all(
    db,
    `WITH x AS (
       SELECT g.item_type_id, g.size_id, g.status, 1 AS q FROM garments g WHERE ${gw}
       UNION ALL
       SELECT b.item_type_id, b.size_id, b.status, b.quantity FROM stock_balances b WHERE ${bw}
     )
     SELECT x.item_type_id, t.name AS item_type_name, t.tracking_mode, x.size_id, s.label AS size_label, ${statusCols},
            t.min_available
       FROM x JOIN item_types t ON t.id = x.item_type_id LEFT JOIN item_sizes s ON s.id = x.size_id
      GROUP BY x.item_type_id, x.size_id
      ORDER BY t.sort_order, s.sort_order`,
    ...params,
  );
}

/** Artigos disponíveis para entrega/empréstimo. */
inventoryRoutes.get('/available', requirePerm('read'), async (c) => {
  const f = parseQuery(c, z.object({ itemTypeId: z.string(), sizeId: z.string().optional(), q: z.string().max(60).optional() }));
  const params: unknown[] = [f.itemTypeId];
  let gw = "g.status = 'disponivel' AND g.item_type_id = ?";
  if (f.sizeId) (gw += ' AND g.size_id = ?', params.push(f.sizeId));
  if (f.q) (gw += " AND (g.code LIKE ? ESCAPE '\\' OR g.inscription LIKE ? ESCAPE '\\' OR g.legacy_code LIKE ? ESCAPE '\\')", params.push(likeTerm(f.q), likeTerm(f.q), likeTerm(f.q)));
  const garments = await all(c.env.DB, `${GARMENT_SELECT} WHERE ${gw} ORDER BY s.sort_order, g.serial LIMIT 300`, ...params);
  const bp: unknown[] = [f.itemTypeId];
  let bw = "b.status = 'disponivel' AND b.quantity > 0 AND b.item_type_id = ?";
  if (f.sizeId) (bw += ' AND b.size_id = ?', bp.push(f.sizeId));
  const buckets = await all(c.env.DB, `${BALANCE_SELECT} WHERE ${bw} ORDER BY s.sort_order, b.condition`, ...bp);
  return c.json({ garments, buckets });
});

// ---------------------------------------------------------------------------
// Entradas: stock inicial e receção de artigos novos
// ---------------------------------------------------------------------------
const entrySchema = z.object({
  kind: z.enum(['stock_inicial', 'rececao_nova']),
  entryDate: zDate.optional(),
  origin: z.enum(ORIGINS).optional(),
  originNotes: zText(300),
  notes: zText(1000),
  items: z
    .array(
      z.object({
        itemTypeId: z.string().min(1),
        sizeId: zOptId,
        condition: zCondition,
        status: z.enum(['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao']).default('disponivel'),
        locationId: zOptId,
        quantity: zQty,
        verification: z.enum(VERIFICATIONS).default('contado'),
        inscriptions: z.array(z.string().trim().max(120)).max(500).optional(),
        legacyCodes: z.array(z.string().trim().max(60)).max(500).optional(),
        costCents: z.number().int().min(0).nullish(),
        notes: zText(500),
      }),
    )
    .min(1, 'Indique pelo menos um artigo')
    .max(100),
});

inventoryRoutes.post('/entries', requirePerm('inventory.write'), async (c) => {
  const b = await parseBody(c, entrySchema);
  const db = c.env.DB;
  const opId = uuid();
  const now = nowIso();
  const entryDate = b.entryDate ?? todayIso();
  const origin = b.origin ?? (b.kind === 'stock_inicial' ? 'stock_inicial' : 'aquisicao_nova');
  const stmts: D1PreparedStatement[] = [];
  const garmentIds: string[] = [];
  let pieces = 0;
  for (const it of b.items) {
    const type = await getItemType(db, it.itemTypeId);
    if (!type.stock_enabled) throw new ApiError(422, 'TIPO_SEM_STOCK', `"${type.name}" não é gerido em stock.`);
    const sizeId = await assertSize(db, type, it.sizeId);
    if (it.locationId) {
      const loc = await first(db, 'SELECT id FROM locations WHERE id = ?', it.locationId);
      if (!loc) throw new ApiError(422, 'LOCALIZACAO_INVALIDA', 'Localização inexistente.');
    }
    const to = { status: it.status, condition: it.condition, locationId: it.locationId };
    if (type.tracking_mode === 'individual') {
      if (it.quantity > 300) throw new ApiError(422, 'QUANTIDADE_EXCESSIVA', 'Máximo de 300 peças individuais por linha.');
      if ((it.inscriptions?.length ?? 0) > it.quantity) throw new ApiError(422, 'INSCRICOES', 'Há mais inscrições do que peças.');
      if (it.inscriptions?.some(Boolean) && !type.allows_inscription) throw new ApiError(422, 'SEM_INSCRICAO', `"${type.name}" não admite inscrição.`);
      pieces += it.quantity;
      for (let i = 0; i < it.quantity; i++) {
        const g = garmentInsertStmt(
          c,
          {
            itemTypeId: type.id,
            sizeId,
            inscription: it.inscriptions?.[i] || null,
            legacyCode: it.legacyCodes?.[i] || null,
            condition: it.condition,
            origin,
            originNotes: b.originNotes,
            verification: it.verification,
            entryDate,
            costCents: it.costCents ?? null,
            locationId: it.locationId,
            notes: it.notes,
          },
          now,
        );
        garmentIds.push(g.id);
        stmts.push(g.stmt);
        stmts.push(
          movementStmt(
            c,
            { operationId: opId, type: b.kind, itemTypeId: type.id, garmentId: g.id, sizeId, to, verification: it.verification, reason: b.notes, notes: it.notes },
            now,
          ).stmt,
        );
      }
    } else {
      stmts.push(
        movementStmt(
          c,
          { operationId: opId, type: b.kind, itemTypeId: type.id, sizeId, quantity: it.quantity, to, verification: it.verification, reason: b.notes, notes: it.notes },
          now,
        ).stmt,
      );
    }
  }
  if (pieces > 600) throw new ApiError(422, 'OPERACAO_GRANDE', 'Máximo de 600 peças individuais por operação. Divida a entrada em várias operações.');
  stmts.push(
    auditStmt(c, b.kind === 'stock_inicial' ? 'inventario.stock_inicial' : 'inventario.rececao_nova', 'operation', opId, {
      linhas: b.items.map((i) => ({ tipo: i.itemTypeId, tamanho: i.sizeId, quantidade: i.quantity, condicao: i.condition, verificacao: i.verification })),
    }),
  );
  const res = await runMutation(c, stmts, { scope: 'inventory.entries', response: { operationId: opId, garmentIds } });
  const codes = res.response.garmentIds.length
    ? await all<{ id: string; code: string }>(
        db,
        `SELECT g.id, g.code FROM garments g JOIN stock_movements m ON m.garment_id = g.id WHERE m.operation_id = ? ORDER BY g.serial`,
        res.response.operationId,
      )
    : [];
  return c.json({ ...res.response, garments: codes, replayed: res.replayed }, res.replayed ? 200 : 201);
});

// ---------------------------------------------------------------------------
// Mudanças de estado e transferências
// ---------------------------------------------------------------------------
const transitionSchema = z.object({
  toStatus: zStatus,
  toLocationId: zOptId.optional(),
  toCondition: zCondition.optional(),
  reason: zText(500),
  notes: zText(1000),
});

function checkTransition(c: Parameters<typeof assertPerm>[0], from: Status, to: Status, reason: string | null) {
  if (from === to) return;
  const allowed = INVENTORY_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw new ApiError(409, 'TRANSICAO_INVALIDA', `Não é possível passar de "${from}" para "${to}" através do inventário.`);
  if (WRITEOFF.includes(to)) {
    assertPerm(c, 'inventory.writeoff');
    if (!reason) throw new ApiError(422, 'MOTIVO_OBRIGATORIO', 'Indique o motivo do abate, extravio ou rejeição.');
  }
}

inventoryRoutes.post('/garments/:id/transition', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, transitionSchema);
  const g = await getGarment(c.env.DB, id);
  const toLocation = b.toLocationId === undefined ? g.location_id : b.toLocationId;
  if (g.status === b.toStatus && toLocation === g.location_id && (!b.toCondition || b.toCondition === g.condition)) {
    throw new ApiError(422, 'SEM_ALTERACAO', 'Não foi indicada nenhuma alteração.');
  }
  if (g.status === 'atribuido' || g.status === 'emprestado') {
    throw new ApiError(409, 'PECA_FORA', 'A peça está atribuída ou emprestada. Registe primeiro a devolução.');
  }
  checkTransition(c, g.status, b.toStatus, b.reason);
  const type =
    g.status === b.toStatus
      ? toLocation !== g.location_id
        ? 'transferencia'
        : 'ajuste'
      : transitionMovementType(g.status, b.toStatus);
  if (type === 'ajuste' && !b.reason) throw new ApiError(422, 'MOTIVO_OBRIGATORIO', 'Indique o motivo da alteração.');
  const opId = uuid();
  const m = movementStmt(c, {
    operationId: opId,
    type,
    itemTypeId: g.item_type_id,
    garmentId: g.id,
    sizeId: g.size_id,
    from: { status: g.status, condition: g.condition, locationId: g.location_id },
    to: { status: b.toStatus, condition: b.toCondition ?? g.condition, locationId: toLocation },
    reason: b.reason,
    notes: b.notes,
  });
  const res = await runMutation(c, [m.stmt, auditStmt(c, `inventario.${type}`, 'garment', g.id, { codigo: g.code, de: g.status, para: b.toStatus, motivo: b.reason })], {
    scope: 'inventory.transition',
    response: { movementId: m.id },
  });
  return c.json(res.response);
});

const balanceMoveSchema = z.object({
  bucketKey: z.string().min(3).max(300),
  quantity: zQty,
  toStatus: zStatus,
  toLocationId: zOptId.optional(),
  toCondition: zCondition.optional(),
  reason: zText(500),
  notes: zText(1000),
});

inventoryRoutes.post('/balances/move', requirePerm('inventory.write'), async (c) => {
  const b = await parseBody(c, balanceMoveSchema);
  const bal = await getBalance(c.env.DB, b.bucketKey);
  if (!bal) notFound('Saldo');
  if (bal.status === 'atribuido' || bal.status === 'emprestado' || WRITEOFF.includes(bal.status)) {
    throw new ApiError(409, 'TRANSICAO_INVALIDA', 'Este saldo não pode ser movimentado diretamente no inventário.');
  }
  const toLocation = b.toLocationId === undefined ? bal.location_id : b.toLocationId;
  const toCondition = b.toCondition ?? bal.condition;
  if (bal.status === b.toStatus && toLocation === bal.location_id && toCondition === bal.condition) {
    throw new ApiError(422, 'SEM_ALTERACAO', 'Não foi indicada nenhuma alteração.');
  }
  checkTransition(c, bal.status, b.toStatus, b.reason);
  const type =
    bal.status === b.toStatus ? (toLocation !== bal.location_id && toCondition === bal.condition ? 'transferencia' : 'ajuste') : transitionMovementType(bal.status, b.toStatus);
  if (type === 'ajuste' && !b.reason) throw new ApiError(422, 'MOTIVO_OBRIGATORIO', 'Indique o motivo da alteração.');
  const opId = uuid();
  const m = movementStmt(c, {
    operationId: opId,
    type,
    itemTypeId: bal.item_type_id,
    sizeId: bal.size_id,
    quantity: b.quantity,
    from: { status: bal.status, condition: bal.condition, locationId: bal.location_id },
    to: { status: b.toStatus, condition: toCondition, locationId: toLocation },
    reason: b.reason,
    notes: b.notes,
  });
  const res = await runMutation(
    c,
    [m.stmt, auditStmt(c, `inventario.${type}`, 'stock_balance', b.bucketKey, { quantidade: b.quantity, de: bal.status, para: b.toStatus, motivo: b.reason })],
    { scope: 'inventory.balance_move', response: { movementId: m.id } },
  );
  return c.json(res.response);
});

/** Ajuste manual de quantidade (apenas administradores, motivo obrigatório). */
inventoryRoutes.post('/adjust', requirePerm('inventory.adjust'), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      itemTypeId: z.string().min(1),
      sizeId: zOptId,
      condition: zCondition,
      locationId: zOptId,
      status: z.enum(['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao']),
      delta: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 100000, 'O ajuste tem de ser diferente de zero'),
      reason: z.string().trim().min(3, 'Indique o motivo do ajuste').max(500),
    }),
  );
  const type = await getItemType(c.env.DB, b.itemTypeId);
  if (type.tracking_mode !== 'quantidade') throw new ApiError(422, 'TIPO_NAO_QUANTIDADE', 'Os ajustes de quantidade aplicam-se apenas a artigos geridos por quantidade.');
  const sizeId = await assertSize(c.env.DB, type, b.sizeId);
  const bucket = { status: b.status, condition: b.condition, locationId: b.locationId };
  const opId = uuid();
  const m = movementStmt(c, {
    operationId: opId,
    type: 'ajuste',
    itemTypeId: type.id,
    sizeId,
    quantity: Math.abs(b.delta),
    from: b.delta < 0 ? bucket : null,
    to: b.delta > 0 ? bucket : null,
    reason: b.reason,
  });
  const res = await runMutation(c, [m.stmt, auditStmt(c, 'inventario.ajuste', 'stock_balance', bucketKey(type.id, sizeId, bucket), { delta: b.delta, motivo: b.reason })], {
    scope: 'inventory.adjust',
    response: { movementId: m.id },
  });
  return c.json(res.response);
});

inventoryRoutes.get('/consistency', requirePerm('inventory.adjust'), async (c) => {
  return c.json(await consistencyReport(c.env.DB));
});

// ---------------------------------------------------------------------------
// Contagens físicas
// ---------------------------------------------------------------------------
inventoryRoutes.get('/counts', requirePerm('read'), async (c) => {
  const items = await all(
    c.env.DB,
    `SELECT ic.*, l.name AS location_name, t.name AS item_type_name, u.name AS created_by_name, cu.name AS confirmed_by_name,
            (SELECT COUNT(*) FROM inventory_count_lines x WHERE x.count_id = ic.id) AS line_count,
            (SELECT COUNT(*) FROM inventory_count_lines x WHERE x.count_id = ic.id AND x.counted_quantity IS NOT NULL) AS counted_lines
       FROM inventory_counts ic LEFT JOIN locations l ON l.id = ic.location_id LEFT JOIN item_types t ON t.id = ic.item_type_id
       JOIN users u ON u.id = ic.created_by LEFT JOIN users cu ON cu.id = ic.confirmed_by
      ORDER BY ic.created_at DESC LIMIT 200`,
  );
  return c.json({ items });
});

inventoryRoutes.post('/counts', requirePerm('inventory.write'), async (c) => {
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1, 'Obrigatório').max(120), locationId: zOptId, itemTypeId: zOptId, notes: zText(1000) }));
  const db = c.env.DB;
  const id = uuid();
  const now = nowIso();
  const statuses = COUNTABLE_STATUSES.map((s) => `'${s}'`).join(',');
  const params: unknown[] = [];
  let extra = '';
  if (b.locationId) (extra += ' AND location_id = ?', params.push(b.locationId));
  if (b.itemTypeId) (extra += ' AND item_type_id = ?', params.push(b.itemTypeId));
  const stmts = [
    db.prepare('INSERT INTO inventory_counts (id, name, location_id, item_type_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      b.name,
      b.locationId,
      b.itemTypeId,
      'em_curso',
      b.notes,
      c.get('user').id,
      now,
    ),
    // Instantâneo das quantidades esperadas no momento de abertura da contagem.
    db
      .prepare(
        `INSERT INTO inventory_count_lines (id, count_id, kind, item_type_id, size_id, condition, location_id, status, expected_quantity, updated_at)
         SELECT lower(hex(randomblob(16))), ?, 'quantidade', item_type_id, size_id, condition, location_id, status, quantity, ?
           FROM stock_balances WHERE quantity > 0 AND status IN (${statuses}) ${extra}`,
      )
      .bind(id, now, ...params),
    db
      .prepare(
        `INSERT INTO inventory_count_lines (id, count_id, kind, item_type_id, size_id, condition, location_id, status, garment_id, expected_quantity, updated_at)
         SELECT lower(hex(randomblob(16))), ?, 'peca', item_type_id, size_id, condition, location_id, status, id, 1, ?
           FROM garments WHERE status IN (${statuses}) ${extra}`,
      )
      .bind(id, now, ...params),
    auditStmt(c, 'contagem.criar', 'inventory_count', id, b),
  ];
  await runBatch(db, stmts);
  return c.json({ id }, 201);
});

async function getCount(db: D1Database, id: string) {
  const ic = await first<{ id: string; status: string; name: string }>(db, 'SELECT * FROM inventory_counts WHERE id = ?', id);
  if (!ic) notFound('Contagem');
  return ic;
}

inventoryRoutes.get('/counts/:id', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const ic = await first(
    c.env.DB,
    `SELECT ic.*, l.name AS location_name, t.name AS item_type_name, u.name AS created_by_name, cu.name AS confirmed_by_name
       FROM inventory_counts ic LEFT JOIN locations l ON l.id = ic.location_id LEFT JOIN item_types t ON t.id = ic.item_type_id
       JOIN users u ON u.id = ic.created_by LEFT JOIN users cu ON cu.id = ic.confirmed_by WHERE ic.id = ?`,
    id,
  );
  if (!ic) notFound('Contagem');
  const lines = await countLinesWithCurrent(c.env.DB, id);
  return c.json({ count: ic, lines });
});

async function countLinesWithCurrent(db: D1Database, id: string) {
  return all<{
    id: string;
    kind: 'quantidade' | 'peca';
    item_type_id: string;
    size_id: string | null;
    condition: string;
    location_id: string | null;
    status: Status;
    garment_id: string | null;
    expected_quantity: number;
    counted_quantity: number | null;
    current_quantity: number;
    current_status: Status | null;
  }>(
    db,
    `SELECT x.*, t.name AS item_type_name, s.label AS size_label, l.name AS location_name, g.code AS garment_code, g.inscription,
            g.status AS current_status,
            CASE WHEN x.kind = 'peca' THEN CASE WHEN g.status = x.status THEN 1 ELSE 0 END
                 ELSE COALESCE((SELECT quantity FROM stock_balances b WHERE b.bucket_key =
                      x.item_type_id || '|' || COALESCE(x.size_id, '') || '|' || x.condition || '|' || COALESCE(x.location_id, '') || '|' || x.status), 0)
            END AS current_quantity
       FROM inventory_count_lines x JOIN item_types t ON t.id = x.item_type_id
       LEFT JOIN item_sizes s ON s.id = x.size_id LEFT JOIN locations l ON l.id = x.location_id LEFT JOIN garments g ON g.id = x.garment_id
      WHERE x.count_id = ? ORDER BY t.sort_order, s.sort_order, x.kind, g.serial`,
    id,
  );
}

inventoryRoutes.put('/counts/:id/lines', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({ lines: z.array(z.object({ id: z.string(), countedQuantity: z.number().int().min(0).max(100000).nullable(), notes: zText(300) })).max(2000) }),
  );
  const ic = await getCount(c.env.DB, id);
  if (ic.status !== 'em_curso') throw new ApiError(409, 'CONTAGEM_FECHADA', 'Esta contagem já não está em curso.');
  const now = nowIso();
  const stmts = b.lines.map((l) =>
    c.env.DB.prepare(
      `UPDATE inventory_count_lines SET counted_quantity = ?, notes = ?, updated_at = ?
        WHERE id = ? AND count_id = ? AND (kind = 'quantidade' OR ? IS NULL OR ? IN (0, 1))`,
    ).bind(l.countedQuantity, l.notes, now, l.id, id, l.countedQuantity, l.countedQuantity),
  );
  await runBatch(c.env.DB, stmts);
  return c.json({ ok: true });
});

inventoryRoutes.post('/counts/:id/lines', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({
      itemTypeId: z.string().min(1),
      sizeId: zOptId,
      condition: zCondition,
      locationId: zOptId,
      status: z.enum(['disponivel', 'reservado', 'pendente_inspecao', 'quarentena']),
      countedQuantity: z.number().int().min(0).max(100000),
    }),
  );
  const ic = await getCount(c.env.DB, id);
  if (ic.status !== 'em_curso') throw new ApiError(409, 'CONTAGEM_FECHADA', 'Esta contagem já não está em curso.');
  const type = await getItemType(c.env.DB, b.itemTypeId);
  if (type.tracking_mode !== 'quantidade') {
    throw new ApiError(422, 'TIPO_NAO_QUANTIDADE', 'Peças individuais não registadas devem ser introduzidas como entrada de stock (ficam com código próprio).');
  }
  const sizeId = await assertSize(c.env.DB, type, b.sizeId);
  const lineId = uuid();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      `INSERT INTO inventory_count_lines (id, count_id, kind, item_type_id, size_id, condition, location_id, status, expected_quantity, counted_quantity, updated_at)
       VALUES (?, ?, 'quantidade', ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(lineId, id, type.id, sizeId, b.condition, b.locationId, b.status, b.countedQuantity, nowIso()),
  ]);
  return c.json({ id: lineId }, 201);
});

/** Propostas de ajuste: diferença entre o contado e o saldo ATUAL (recalculado no momento). */
inventoryRoutes.get('/counts/:id/proposals', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  await getCount(c.env.DB, id);
  const lines = await countLinesWithCurrent(c.env.DB, id);
  return c.json({ proposals: proposalsFrom(lines), uncounted: lines.filter((l) => l.counted_quantity === null).length });
});

function proposalsFrom(lines: Awaited<ReturnType<typeof countLinesWithCurrent>>) {
  return lines
    .filter((l) => l.counted_quantity !== null && l.counted_quantity !== l.current_quantity)
    .filter((l) => !(l.kind === 'peca' && l.current_status !== l.status)) // a peça mudou de estado após a abertura: ignorar
    .map((l) => ({ ...l, delta: (l.counted_quantity as number) - l.current_quantity }));
}

inventoryRoutes.post('/counts/:id/confirm', requirePerm('inventory.adjust'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3, 'Indique o motivo dos ajustes').max(500), confirm: z.literal(true) }));
  const ic = await getCount(c.env.DB, id);
  if (ic.status !== 'em_curso') throw new ApiError(409, 'CONTAGEM_FECHADA', 'Esta contagem já não está em curso.');
  const lines = await countLinesWithCurrent(c.env.DB, id);
  const proposals = proposalsFrom(lines);
  const opId = uuid();
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const p of proposals) {
    const bucket = { status: p.status, condition: p.condition as never, locationId: p.location_id };
    if (p.kind === 'peca') {
      if (p.delta < 0) {
        stmts.push(
          movementStmt(
            c,
            { operationId: opId, type: 'extravio', itemTypeId: p.item_type_id, garmentId: p.garment_id, sizeId: p.size_id, from: bucket, to: { ...bucket, status: 'extraviado' }, reason: `Contagem "${ic.name}": ${b.reason}`, refType: 'inventory_count', refId: id },
            now,
          ).stmt,
        );
      }
    } else {
      stmts.push(
        movementStmt(
          c,
          {
            operationId: opId,
            type: 'ajuste',
            itemTypeId: p.item_type_id,
            sizeId: p.size_id,
            quantity: Math.abs(p.delta),
            from: p.delta < 0 ? bucket : null,
            to: p.delta > 0 ? bucket : null,
            verification: 'contado',
            reason: `Contagem "${ic.name}": ${b.reason}`,
            refType: 'inventory_count',
            refId: id,
          },
          now,
        ).stmt,
      );
    }
    stmts.push(c.env.DB.prepare('UPDATE inventory_count_lines SET applied_delta = ? WHERE id = ?').bind(p.delta, p.id));
  }
  // Marca saldos e peças contados como verificados.
  stmts.push(
    c.env.DB.prepare(
      `UPDATE stock_balances SET verification = 'contado', last_counted_at = ?
        WHERE bucket_key IN (SELECT item_type_id || '|' || COALESCE(size_id, '') || '|' || condition || '|' || COALESCE(location_id, '') || '|' || status
                               FROM inventory_count_lines WHERE count_id = ? AND kind = 'quantidade' AND counted_quantity IS NOT NULL)`,
    ).bind(now, id),
    c.env.DB.prepare(
      `UPDATE garments SET verification = 'contado', last_counted_at = ?
        WHERE id IN (SELECT garment_id FROM inventory_count_lines WHERE count_id = ? AND kind = 'peca' AND counted_quantity = 1)`,
    ).bind(now, id),
    c.env.DB.prepare("UPDATE inventory_counts SET status = 'confirmada', reason = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'em_curso'").bind(
      b.reason,
      c.get('user').id,
      now,
      id,
    ),
    auditStmt(c, 'contagem.confirmar', 'inventory_count', id, { ajustes: proposals.length, motivo: b.reason }),
  );
  const res = await runMutation(c, stmts, { scope: 'inventory.count_confirm', response: { operationId: opId, adjustments: proposals.length } });
  return c.json(res.response);
});

inventoryRoutes.post('/counts/:id/cancel', requirePerm('inventory.write'), async (c) => {
  const id = c.req.param('id');
  const ic = await getCount(c.env.DB, id);
  if (ic.status !== 'em_curso') throw new ApiError(409, 'CONTAGEM_FECHADA', 'Esta contagem já não está em curso.');
  await runBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE inventory_counts SET status = 'cancelada' WHERE id = ?").bind(id),
    auditStmt(c, 'contagem.cancelar', 'inventory_count', id),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Eliminação de peças do inventário (administrador)
// ---------------------------------------------------------------------------

/** Verifica se cada peça pode ser eliminada e devolve o motivo quando não pode. */
/** Divide uma lista para respeitar o limite de parâmetros por consulta do D1. */
function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

type DeletableRow = { id: string; code: string; status: string; holder_name: string | null; deliveries: number; loans: number; returns: number; warning: string | null };

/** Peças a eliminar, com aviso quando estão com um músico ou têm histórico. */
export async function deletableGarments(db: D1Database, ids: string[]): Promise<DeletableRow[]> {
  const out: DeletableRow[] = [];
  for (const part of chunks(ids)) {
    const marks = part.map(() => '?').join(',');
    out.push(
      ...(await all<DeletableRow>(
        db,
        `SELECT g.id, g.code, g.status, m.full_name AS holder_name,
                (SELECT COUNT(*) FROM musician_delivery_lines x WHERE x.garment_id = g.id) AS deliveries,
                (SELECT COUNT(*) FROM loan_lines x WHERE x.garment_id = g.id) AS loans,
                (SELECT COUNT(*) FROM garment_return_lines x WHERE x.garment_id = g.id) AS returns,
                CASE WHEN g.status = 'atribuido' THEN 'está atribuída a ' || COALESCE(m.full_name, 'um músico')
                     WHEN g.status = 'emprestado' THEN 'está emprestada a ' || COALESCE(m.full_name, 'um músico')
                     WHEN EXISTS (SELECT 1 FROM musician_delivery_lines x WHERE x.garment_id = g.id)
                       OR EXISTS (SELECT 1 FROM loan_lines x WHERE x.garment_id = g.id)
                       OR EXISTS (SELECT 1 FROM garment_return_lines x WHERE x.garment_id = g.id) THEN 'tem histórico de entregas, empréstimos ou recolhas'
                     ELSE NULL END AS warning
           FROM garments g LEFT JOIN musicians m ON m.id = g.holder_musician_id
          WHERE g.id IN (${marks})`,
        ...part,
      )),
    );
  }
  return out;
}

inventoryRoutes.post('/garments/delete-check', requirePerm('read'), async (c) => {
  const b = await parseBody(c, z.object({ ids: z.array(z.string()).min(1).max(500) }));
  return c.json({ items: await deletableGarments(c.env.DB, [...new Set(b.ids)]) });
});

/**
 * Elimina definitivamente peças do inventário (introduzidas por engano, que já não existem
 * ou que não devem constar do inventário), com todo o seu histórico: movimentos, linhas de
 * entrega (as entregas que ficarem vazias são apagadas), linhas e devoluções de empréstimo.
 * Nas recolhas mantém-se o registo do artigo devolvido, sem ligação à peça.
 * Uma peça atribuída ou emprestada deixa de constar na posse do músico.
 * O registo da eliminação fica na auditoria.
 */
inventoryRoutes.post('/garments/delete', requirePerm('inventory.delete'), async (c) => {
  const b = await parseBody(c, z.object({ ids: z.array(z.string()).min(1).max(500), reason: z.string().trim().min(3, 'Indique o motivo').max(500) }));
  const db = c.env.DB;
  const ids = [...new Set(b.ids)];
  const rows = await deletableGarments(db, ids);
  if (rows.length !== ids.length) notFound('Peça');
  const idSet = new Set(ids);
  const deliveryLines: { id: string; delivery_id: string }[] = [];
  const loanLineIds: string[] = [];
  for (const part of chunks(ids)) {
    const marks = part.map(() => '?').join(',');
    deliveryLines.push(...(await all<{ id: string; delivery_id: string }>(db, `SELECT id, delivery_id FROM musician_delivery_lines WHERE garment_id IN (${marks})`, ...part)));
    loanLineIds.push(...(await all<{ id: string }>(db, `SELECT id FROM loan_lines WHERE garment_id IN (${marks})`, ...part)).map((r) => r.id));
  }
  // Entregas que ficam sem linhas depois de retirar estas peças.
  const deliveryIds = [...new Set(deliveryLines.map((l) => l.delivery_id))];
  const emptyDeliveries: string[] = [];
  for (const part of chunks(deliveryIds)) {
    const marks = part.map(() => '?').join(',');
    const lines = await all<{ delivery_id: string; garment_id: string | null }>(db, `SELECT delivery_id, garment_id FROM musician_delivery_lines WHERE delivery_id IN (${marks})`, ...part);
    for (const d of part) if (lines.every((l) => l.delivery_id !== d || (l.garment_id && idSet.has(l.garment_id)))) emptyDeliveries.push(d);
  }
  const attachmentPurges: D1PreparedStatement[] = [];
  for (const part of chunks(ids)) attachmentPurges.push(...(await purgeAttachments(c.env, 'garment', part)));
  for (const part of chunks(loanLineIds)) attachmentPurges.push(...(await purgeAttachments(c.env, 'loan_line', part)));
  for (const part of chunks(emptyDeliveries)) attachmentPurges.push(...(await purgeAttachments(c.env, 'delivery', part)));

  // Todas as instruções seguintes identificam as peças pela tabela de autorização (sem limite de parâmetros).
  const sel = 'SELECT garment_id FROM purge_authorizations';
  const stmts: D1PreparedStatement[] = [
    ...ids.map((id) => db.prepare('INSERT INTO purge_authorizations (garment_id) VALUES (?)').bind(id)),
    ...attachmentPurges,
    db.prepare(`UPDATE incidents SET garment_id = NULL WHERE garment_id IN (${sel})`),
    db.prepare(`DELETE FROM inventory_count_lines WHERE garment_id IN (${sel})`),
    db.prepare(`DELETE FROM loan_returns WHERE loan_line_id IN (SELECT id FROM loan_lines WHERE garment_id IN (${sel}))`),
    db.prepare(`DELETE FROM loan_lines WHERE garment_id IN (${sel})`),
    db.prepare(`UPDATE garment_return_lines SET delivery_line_id = NULL WHERE delivery_line_id IN (SELECT id FROM musician_delivery_lines WHERE garment_id IN (${sel}))`),
    db.prepare(`UPDATE garment_return_lines SET garment_id = NULL WHERE garment_id IN (${sel})`),
    db.prepare(`DELETE FROM musician_delivery_lines WHERE garment_id IN (${sel})`),
    ...chunks(emptyDeliveries).map((part) =>
      db.prepare(`DELETE FROM musician_deliveries WHERE id IN (${part.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM musician_delivery_lines l WHERE l.delivery_id = musician_deliveries.id)`).bind(...part),
    ),
    db.prepare(`DELETE FROM stock_movements WHERE garment_id IN (${sel})`),
    db.prepare(`DELETE FROM garments WHERE id IN (${sel})`),
    db.prepare('DELETE FROM purge_authorizations'),
    auditStmt(c, 'inventario.eliminar_pecas', 'garment', ids.length === 1 ? ids[0] : null, {
      codigos: rows.map((r) => r.code),
      motivo: b.reason,
      comHistorico: rows.filter((r) => r.warning).map((r) => `${r.code}: ${r.warning}`),
    }),
  ];
  const res = await runMutation(c, stmts, { scope: 'inventory.delete_garments', response: { deleted: ids.length } });
  return c.json(res.response);
});

/** Retira do inventário a quantidade total de um lote (artigos geridos por quantidade), com registo de ajuste. */
inventoryRoutes.post('/balances/remove', requirePerm('inventory.adjust'), async (c) => {
  const b = await parseBody(c, z.object({ bucketKey: z.string().min(3).max(300), reason: z.string().trim().min(3, 'Indique o motivo').max(500) }));
  const bal = await getBalance(c.env.DB, b.bucketKey);
  if (!bal || bal.quantity <= 0) notFound('Lote');
  if (!['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao'].includes(bal.status)) {
    throw new ApiError(409, 'LOTE_FORA', 'Este lote está atribuído ou emprestado e não pode ser retirado do inventário.');
  }
  const m = movementStmt(c, {
    operationId: uuid(),
    type: 'ajuste',
    itemTypeId: bal.item_type_id,
    sizeId: bal.size_id,
    quantity: bal.quantity,
    from: { status: bal.status, condition: bal.condition, locationId: bal.location_id },
    to: null,
    reason: `Removido do inventário: ${b.reason}`,
  });
  const res = await runMutation(c, [m.stmt, auditStmt(c, 'inventario.remover_lote', 'stock_balance', b.bucketKey, { quantidade: bal.quantity, motivo: b.reason })], {
    scope: 'inventory.remove_balance',
    response: { removed: bal.quantity },
  });
  return c.json(res.response);
});
