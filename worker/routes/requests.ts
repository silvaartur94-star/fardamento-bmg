import { Hono } from 'hono';
import { z } from 'zod';
import { REQUEST_STATUSES, SHOE_REQUEST_STATUSES } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, runBatch, todayIso, uuid, zDate, zOptId, zQty, zText } from '../lib/core';
import { requirePerm } from '../auth/session';
import { assertSize, getItemType } from '../services/stock';

export const requestRoutes = new Hono<AppEnv>();

type ReqRow = {
  status: string;
  procurement_enabled: number;
  quantity_requested: number;
  quantity_delivered: number;
  quantity_ordered: number;
  quantity_received: number;
};

export function progressOf(r: ReqRow): string {
  if (r.status === 'cancelada') return 'cancelada';
  if (!r.procurement_enabled) return r.status;
  if (r.quantity_delivered >= r.quantity_requested) return 'entregue';
  if (r.quantity_delivered > 0) return 'parcial';
  if (r.quantity_received > 0) return 'recebida';
  if (r.quantity_ordered > 0) return 'encomendada';
  return 'pendente';
}

export function withProgress<T>(rows: T[]): (T & { progress: string; quantity_missing: number })[] {
  return rows.map((r) => {
    const x = r as unknown as ReqRow;
    return {
      ...r,
      progress: progressOf(x),
      quantity_missing: x.status === 'ativa' && x.procurement_enabled ? Math.max(x.quantity_requested - x.quantity_delivered, 0) : 0,
    };
  });
}

export const REQUEST_SELECT = `
  SELECT v.*, t.name AS item_type_name, t.procurement_enabled, t.tracking_mode, s.label AS size_label,
         m.full_name AS musician_name, m.internal_code AS musician_code, m.kind AS musician_kind
    FROM v_request_progress v
    JOIN item_types t ON t.id = v.item_type_id
    JOIN musicians m ON m.id = v.musician_id
    LEFT JOIN item_sizes s ON s.id = v.size_id`;

export const requestFilters = pageQuery.extend({
  musicianId: z.string().optional(),
  itemTypeId: z.string().optional(),
  sizeId: z.string().optional(),
  status: z.string().optional(),
  pendingOnly: z.string().optional(),
  shoes: z.enum(['0', '1']).optional(),
});

export function requestWhere(f: z.infer<typeof requestFilters>) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.musicianId) (where.push('v.musician_id = ?'), params.push(f.musicianId));
  if (f.itemTypeId) (where.push('v.item_type_id = ?'), params.push(f.itemTypeId));
  if (f.sizeId) (where.push('v.size_id = ?'), params.push(f.sizeId));
  if (f.status) (where.push('v.status = ?'), params.push(f.status));
  if (f.shoes === '1') where.push('t.procurement_enabled = 0');
  if (f.shoes === '0') where.push('t.procurement_enabled = 1');
  if (f.pendingOnly === '1') {
    where.push("((t.procurement_enabled = 1 AND v.status = 'ativa' AND v.quantity_delivered < v.quantity_requested) OR (t.procurement_enabled = 0 AND v.status IN ('por_avaliar', 'confirmada')))");
  }
  if (f.q) (where.push("(m.full_name LIKE ? ESCAPE '\\' OR m.internal_code LIKE ? ESCAPE '\\')"), params.push(likeTerm(f.q), likeTerm(f.q)));
  return { sql: where.join(' AND '), params };
}

requestRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, requestFilters);
  const w = requestWhere(f);
  const { limit, offset } = paging(f);
  const items = await all(c.env.DB, `${REQUEST_SELECT} WHERE ${w.sql} ORDER BY m.full_name COLLATE NOCASE, t.sort_order LIMIT ? OFFSET ?`, ...w.params, limit, offset);
  const total = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id JOIN musicians m ON m.id = v.musician_id WHERE ${w.sql}`,
    ...w.params,
  );
  return c.json({ items: withProgress(items), total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

/** Vista agregada por tipo e tamanho (apenas artigos de aquisição). */
requestRoutes.get('/summary', requirePerm('read'), async (c) => {
  return c.json(await requestSummary(c.env.DB));
});

export async function requestSummary(db: D1Database) {
  const items = await all(
    db,
    `SELECT v.item_type_id, t.name AS item_type_name, v.size_id, COALESCE(s.label, v.size_text) AS size_label,
            SUM(v.quantity_requested) AS requested, SUM(v.quantity_ordered) AS ordered, SUM(v.quantity_received) AS received,
            SUM(v.quantity_delivered) AS delivered,
            SUM(MAX(v.quantity_requested - v.quantity_delivered, 0)) AS missing,
            SUM(MAX(v.quantity_requested - v.quantity_ordered, 0)) AS to_order,
            COUNT(DISTINCT v.musician_id) AS musicians,
            GROUP_CONCAT(v.id) AS request_ids
       FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id
      WHERE v.status = 'ativa' AND t.procurement_enabled = 1
      GROUP BY v.item_type_id, v.size_id, CASE WHEN v.size_id IS NULL THEN v.size_text END
      ORDER BY t.sort_order, s.sort_order, size_label`,
  );
  const shoes = await all(
    db,
    `SELECT t.name AS item_type_name, COALESCE(s.label, r.size_text) AS size_label, r.status, COUNT(*) AS requests, SUM(r.quantity_requested) AS quantity
       FROM musician_item_requests r JOIN item_types t ON t.id = r.item_type_id LEFT JOIN item_sizes s ON s.id = r.size_id
      WHERE t.procurement_enabled = 0 AND r.status != 'cancelada'
      GROUP BY r.item_type_id, size_label, r.status ORDER BY t.sort_order, size_label`,
  );
  return { items, shoes };
}

const createSchema = z.object({
  musicianId: z.string().min(1),
  itemTypeId: z.string().min(1),
  sizeId: zOptId,
  sizeText: zText(20),
  quantity: zQty,
  returnExpected: z.number().int().min(0).max(100).default(0),
  status: z.enum(REQUEST_STATUSES).optional(),
  requestedAt: zDate.optional(),
  notes: zText(1000),
  allowDuplicate: z.boolean().optional(),
});

requestRoutes.post('/', requirePerm('requests.write'), async (c) => {
  const b = await parseBody(c, createSchema);
  const db = c.env.DB;
  const m = await first<{ id: string; status: string }>(db, 'SELECT id, status FROM musicians WHERE id = ?', b.musicianId);
  if (!m) notFound('Músico');
  const type = await getItemType(db, b.itemTypeId);
  if (!type.active) throw new ApiError(422, 'TIPO_INATIVO', 'Este tipo de artigo está inativo.');
  const sizeId = await assertSize(db, type, b.sizeId);
  let status = b.status;
  if (type.procurement_enabled) {
    status = status ?? 'ativa';
    if (status !== 'ativa' && status !== 'cancelada') throw new ApiError(422, 'ESTADO_INVALIDO', 'Estado inválido para este artigo.');
  } else {
    // Ex.: sapatos — apenas registo da necessidade, sem aquisição nem stock.
    status = status ?? 'por_avaliar';
    if (!SHOE_REQUEST_STATUSES.includes(status)) throw new ApiError(422, 'ESTADO_INVALIDO', 'Estado inválido para este artigo.');
  }
  // Evita duplicados: uma necessidade ativa por músico, tipo e tamanho.
  if (!b.allowDuplicate) {
    const dup = await first(
      db,
      "SELECT id FROM musician_item_requests WHERE musician_id = ? AND item_type_id = ? AND COALESCE(size_id, '') = ? AND status NOT IN ('cancelada', 'resolvida')",
      b.musicianId,
      type.id,
      sizeId ?? '',
    );
    if (dup) throw new ApiError(409, 'NECESSIDADE_DUPLICADA', 'Já existe uma necessidade ativa deste artigo e tamanho para este músico. Edite a quantidade da existente.', { id: dup.id });
  }
  const id = uuid();
  const now = nowIso();
  await runBatch(db, [
    db
      .prepare(
        `INSERT INTO musician_item_requests (id, musician_id, item_type_id, size_id, size_text, quantity_requested, return_expected, status, notes, requested_at, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, b.musicianId, type.id, sizeId, b.sizeText, b.quantity, b.returnExpected, status, b.notes, b.requestedAt ?? todayIso(), now, now, c.get('user').id),
    auditStmt(c, 'necessidade.criar', 'musician', b.musicianId, { necessidade: id, tipo: type.name, tamanho: sizeId ?? b.sizeText, quantidade: b.quantity }),
  ]);
  return c.json({ id }, 201);
});

const patchSchema = z.object({
  sizeId: zOptId.optional(),
  sizeText: zText(20).optional(),
  quantity: zQty.optional(),
  quantityOrdered: z.number().int().min(0).max(100000).optional(),
  quantityReceived: z.number().int().min(0).max(100000).optional(),
  returnExpected: z.number().int().min(0).max(100).optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
  notes: zText(1000).optional(),
});

requestRoutes.patch('/:id', requirePerm('requests.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, patchSchema);
  const db = c.env.DB;
  const r = await first<ReqRow & { id: string; item_type_id: string; musician_id: string; size_id: string | null }>(
    db,
    'SELECT v.*, t.procurement_enabled FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id WHERE v.id = ?',
    id,
  );
  if (!r) notFound('Necessidade');
  const type = await getItemType(db, r.item_type_id);
  if (b.sizeId !== undefined) {
    await assertSize(db, type, b.sizeId);
    if (r.quantity_delivered > 0 && b.sizeId !== r.size_id) throw new ApiError(409, 'COM_ENTREGAS', 'Não é possível alterar o tamanho de uma necessidade com entregas registadas.');
  }
  if (b.quantity !== undefined && b.quantity < r.quantity_delivered) {
    throw new ApiError(409, 'QUANTIDADE_INFERIOR', `A quantidade não pode ser inferior à já entregue (${r.quantity_delivered}).`);
  }
  if (b.status) {
    const allowed = type.procurement_enabled ? ['ativa', 'cancelada'] : SHOE_REQUEST_STATUSES;
    if (!allowed.includes(b.status)) throw new ApiError(422, 'ESTADO_INVALIDO', 'Estado inválido para este artigo.');
    if (b.status === 'cancelada' && r.quantity_delivered > 0) throw new ApiError(409, 'COM_ENTREGAS', 'Não é possível cancelar uma necessidade com entregas. Ajuste a quantidade.');
  }
  if (!type.procurement_enabled && (b.quantityOrdered || b.quantityReceived)) {
    throw new ApiError(422, 'SEM_AQUISICAO', 'Este artigo não faz parte da aquisição (apenas registo de necessidade).');
  }
  const cols: Record<string, string> = {
    sizeId: 'size_id',
    sizeText: 'size_text',
    quantity: 'quantity_requested',
    quantityOrdered: 'quantity_ordered',
    quantityReceived: 'quantity_received',
    returnExpected: 'return_expected',
    status: 'status',
    notes: 'notes',
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    vals.push(v ?? null);
  }
  const now = nowIso();
  if (b.quantityOrdered !== undefined) sets.push(`ordered_at = COALESCE(ordered_at, '${now.slice(0, 10)}')`);
  if (b.quantityReceived !== undefined) sets.push(`received_at = COALESCE(received_at, '${now.slice(0, 10)}')`);
  if (b.status && ['cancelada', 'resolvida'].includes(b.status)) sets.push(`closed_at = '${now}'`);
  if (!sets.length) return c.json({ ok: true });
  await runBatch(db, [
    db.prepare(`UPDATE musician_item_requests SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now, id),
    auditStmt(c, 'necessidade.editar', 'musician', r.musician_id, { necessidade: id, alteracoes: b }),
  ]);
  return c.json({ ok: true });
});

/** Marca em bloco as necessidades como encomendadas ou recebidas (quantidade total pretendida). */
requestRoutes.post('/bulk', requirePerm('requests.write'), async (c) => {
  const b = await parseBody(c, z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(['encomendar', 'receber']) }));
  const db = c.env.DB;
  const now = nowIso();
  const day = now.slice(0, 10);
  const placeholders = b.ids.map(() => '?').join(',');
  const sql =
    b.action === 'encomendar'
      ? `UPDATE musician_item_requests SET quantity_ordered = quantity_requested, ordered_at = COALESCE(ordered_at, ?), updated_at = ?
          WHERE id IN (${placeholders}) AND status = 'ativa' AND item_type_id IN (SELECT id FROM item_types WHERE procurement_enabled = 1)`
      : `UPDATE musician_item_requests SET quantity_ordered = MAX(quantity_ordered, quantity_requested), quantity_received = quantity_requested,
            ordered_at = COALESCE(ordered_at, ?), received_at = COALESCE(received_at, ?), updated_at = ?
          WHERE id IN (${placeholders}) AND status = 'ativa' AND item_type_id IN (SELECT id FROM item_types WHERE procurement_enabled = 1)`;
  const params = b.action === 'encomendar' ? [day, now, ...b.ids] : [day, day, now, ...b.ids];
  const res = await runBatch(db, [db.prepare(sql).bind(...params), auditStmt(c, `necessidade.${b.action}_bloco`, 'request', null, { quantidade: b.ids.length })]);
  return c.json({ updated: res[0].meta.changes });
});
