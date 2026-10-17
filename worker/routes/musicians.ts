import { Hono } from 'hono';
import { z } from 'zod';
import { MUSICIAN_KINDS, MUSICIAN_STATUSES, normalizeName } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, orderBy, pageQuery, paging, parseBody, parseQuery, purgeAttachments, runBatch, runDelete, todayIso, uuid, zDate, zText, type Ctx } from '../lib/core';
import { assertSize, getItemType } from '../services/stock';
import { requirePerm } from '../auth/session';
import { withProgress } from './requests';

export const musicianRoutes = new Hono<AppEnv>();

const MUSICIAN_SUMMARY = `
  SELECT m.id, m.internal_code, m.full_name, m.instrument, m.kind, m.status, m.contact, m.origin_band, m.created_at, m.updated_at,
    COALESCE((SELECT SUM(MAX(v.quantity_requested - v.quantity_delivered, 0)) FROM v_request_progress v
               JOIN item_types t ON t.id = v.item_type_id
              WHERE v.musician_id = m.id AND v.status = 'ativa' AND t.procurement_enabled = 1), 0) AS needs_open,
    COALESCE((SELECT SUM(v.quantity_requested) FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id
              WHERE v.musician_id = m.id AND v.status = 'ativa' AND t.procurement_enabled = 1), 0) AS needs_total,
    (SELECT COUNT(*) FROM musician_item_requests r JOIN item_types t ON t.id = r.item_type_id
      WHERE r.musician_id = m.id AND t.procurement_enabled = 0 AND r.status IN ('por_avaliar', 'confirmada')) AS shoes_open,
    COALESCE((SELECT SUM(dl.quantity) FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id
              WHERE d.musician_id = m.id AND dl.status = 'entregue'), 0) AS delivered_qty,
    COALESCE((SELECT SUM(r.return_expected) FROM musician_item_requests r WHERE r.musician_id = m.id AND r.status != 'cancelada'), 0) AS return_expected,
    COALESCE((SELECT SUM(x.returned_quantity) FROM v_musician_returns x WHERE x.musician_id = m.id), 0) AS returned_qty,
    (SELECT COUNT(*) FROM garment_returns gr WHERE gr.musician_id = m.id AND gr.inspection_status != 'concluida') AS returns_uninspected,
    (SELECT COUNT(*) FROM garments g WHERE g.holder_musician_id = m.id) AS garments_held,
    COALESCE((SELECT SUM(v.pending_quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.musician_id = m.id), 0) AS loan_pending
  FROM musicians m`;

export const musicianFilters = pageQuery.extend({
  kind: z.enum(MUSICIAN_KINDS).optional(),
  instrument: z.string().trim().max(60).optional(),
  status: z.enum(MUSICIAN_STATUSES).optional(),
  pending: z.enum(['entregas', 'devolucoes', 'emprestimos']).optional(),
});

export function musicianWhere(f: z.infer<typeof musicianFilters>) {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (f.q) {
    where.push("(m.name_key LIKE ? ESCAPE '\\' OR m.internal_code LIKE ? ESCAPE '\\' OR m.full_name LIKE ? ESCAPE '\\')");
    params.push(likeTerm(normalizeName(f.q)), likeTerm(f.q), likeTerm(f.q));
  }
  if (f.kind) (where.push('m.kind = ?'), params.push(f.kind));
  if (f.status) (where.push('m.status = ?'), params.push(f.status));
  if (f.instrument) (where.push('m.instrument = ? COLLATE NOCASE'), params.push(f.instrument));
  return { sql: where.join(' AND '), params };
}

export async function listMusicians(db: D1Database, f: z.infer<typeof musicianFilters>, unpaged = false) {
  const w = musicianWhere(f);
  const order = orderBy(f.sort, f.dir, { name: 'full_name COLLATE NOCASE', code: 'internal_code', status: 'status', kind: 'kind', needs: 'needs_open' }, 'full_name COLLATE NOCASE');
  let having = '';
  if (f.pending === 'entregas') having = 'WHERE needs_open > 0';
  if (f.pending === 'devolucoes') having = 'WHERE return_expected > returned_qty OR returns_uninspected > 0';
  if (f.pending === 'emprestimos') having = 'WHERE loan_pending > 0';
  const base = `SELECT * FROM (${MUSICIAN_SUMMARY} WHERE ${w.sql}) ${having}`;
  const { limit, offset } = paging(f);
  const items = await all(db, `${base} ORDER BY ${order} ${unpaged ? '' : 'LIMIT ? OFFSET ?'}`, ...w.params, ...(unpaged ? [] : [limit, offset]));
  const total = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM (${base})`, ...w.params);
  return { items, total: total?.n ?? 0 };
}

musicianRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, musicianFilters);
  const r = await listMusicians(c.env.DB, f);
  return c.json({ ...r, page: f.page, pageSize: f.pageSize });
});

async function findDuplicates(db: D1Database, fullName: string, code: string | null, excludeId?: string) {
  const key = normalizeName(fullName);
  const parts = key.split(' ');
  const firstLast = parts.length > 1 ? `${parts[0]}%${parts[parts.length - 1]}` : key;
  return all(
    db,
    `SELECT id, full_name, internal_code, kind, status FROM musicians
      WHERE id != ? AND (name_key = ? OR name_key LIKE ? OR (? IS NOT NULL AND internal_code = ? COLLATE NOCASE)) LIMIT 10`,
    excludeId ?? '',
    key,
    firstLast,
    code,
    code,
  );
}

musicianRoutes.get('/instruments', requirePerm('read'), async (c) => {
  const rows = await all<{ instrument: string; n: number }>(
    c.env.DB,
    "SELECT instrument, COUNT(*) AS n FROM musicians WHERE instrument IS NOT NULL AND instrument != '' GROUP BY instrument COLLATE NOCASE ORDER BY instrument COLLATE NOCASE",
  );
  return c.json({ items: rows });
});

musicianRoutes.get('/duplicates', requirePerm('read'), async (c) => {
  const f = parseQuery(c, z.object({ name: z.string().trim().min(2).max(160), code: z.string().max(40).optional(), excludeId: z.string().optional() }));
  return c.json({ items: await findDuplicates(c.env.DB, f.name, f.code || null, f.excludeId) });
});

export const musicianSchema = z.object({
  fullName: z.string().trim().min(2, 'Indique o nome completo').max(160),
  internalCode: zText(40),
  kind: z.enum(MUSICIAN_KINDS).default('banda'),
  status: z.enum(MUSICIAN_STATUSES).default('ativo'),
  contact: zText(160),
  originBand: zText(160),
  instrument: zText(60),
  notes: zText(2000),
  confirmDuplicate: z.boolean().optional(),
});

/** Constrói a instrução de criação de músico, validando duplicados. */
export async function createMusicianStmts(c: Ctx, b: z.infer<typeof musicianSchema>) {
  const dups = await findDuplicates(c.env.DB, b.fullName, b.internalCode);
  if (b.internalCode && dups.some((d) => String(d.internal_code ?? '').toLowerCase() === b.internalCode!.toLowerCase())) {
    throw new ApiError(409, 'CODIGO_DUPLICADO', 'Já existe um músico com este código interno.');
  }
  if (dups.length && !b.confirmDuplicate) {
    throw new ApiError(409, 'POSSIVEL_DUPLICADO', 'Existem músicos com nome semelhante. Confirme se se trata de uma pessoa diferente.', { candidates: dups });
  }
  const id = uuid();
  const now = nowIso();
  return {
    id,
    stmts: [
      c.env.DB.prepare(
        `INSERT INTO musicians (id, internal_code, full_name, name_key, kind, status, contact, origin_band, instrument, notes, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, b.internalCode, b.fullName, normalizeName(b.fullName), b.kind, b.status, b.contact, b.originBand, b.instrument ?? null, b.notes, now, now, c.get('user').id),
      auditStmt(c, 'musico.criar', 'musician', id, { nome: b.fullName, tipo: b.kind, codigo: b.internalCode, instrumento: b.instrument }),
    ],
  };
}

musicianRoutes.post('/', requirePerm('musicians.write'), async (c) => {
  const b = await parseBody(c, musicianSchema);
  const { id, stmts } = await createMusicianStmts(c, b);
  await runBatch(c.env.DB, stmts);
  return c.json({ id }, 201);
});

musicianRoutes.patch('/:id', requirePerm('musicians.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, musicianSchema.partial());
  const cur = await first<{ full_name: string; internal_code: string | null; status: string; kind: string }>(
    c.env.DB,
    'SELECT full_name, internal_code, status, kind FROM musicians WHERE id = ?',
    id,
  );
  if (!cur) notFound('Músico');
  if (b.internalCode) {
    const dup = await first(c.env.DB, 'SELECT id FROM musicians WHERE internal_code = ? COLLATE NOCASE AND id != ?', b.internalCode, id);
    if (dup) throw new ApiError(409, 'CODIGO_DUPLICADO', 'Já existe um músico com este código interno.');
  }
  if (b.fullName && normalizeName(b.fullName) !== normalizeName(cur.full_name) && !b.confirmDuplicate) {
    const dups = await findDuplicates(c.env.DB, b.fullName, null, id);
    if (dups.length) throw new ApiError(409, 'POSSIVEL_DUPLICADO', 'Existem músicos com nome semelhante. Confirme se se trata de uma pessoa diferente.', { candidates: dups });
  }
  const cols: Record<string, string> = {
    fullName: 'full_name',
    internalCode: 'internal_code',
    kind: 'kind',
    status: 'status',
    contact: 'contact',
    originBand: 'origin_band',
    instrument: 'instrument',
    notes: 'notes',
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || !cols[k]) continue;
    sets.push(`${cols[k]} = ?`);
    vals.push(v ?? null);
  }
  if (b.fullName) (sets.push('name_key = ?'), vals.push(normalizeName(b.fullName)));
  if (!sets.length) return c.json({ ok: true });
  await runBatch(c.env.DB, [
    c.env.DB.prepare(`UPDATE musicians SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, nowIso(), id),
    auditStmt(c, 'musico.editar', 'musician', id, { antes: cur, alteracoes: { ...b, confirmDuplicate: undefined } }),
  ]);
  return c.json({ ok: true });
});

musicianRoutes.get('/:id', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const m = await first(db, `${MUSICIAN_SUMMARY} WHERE m.id = ?`, id);
  if (!m) notFound('Músico');
  const notes = await first<{ notes: string | null }>(db, 'SELECT notes FROM musicians WHERE id = ?', id);
  const measurements = await first(db, 'SELECT mm.*, u.name AS updated_by_name FROM musician_measurements mm LEFT JOIN users u ON u.id = mm.updated_by WHERE mm.musician_id = ?', id);
  const [requests, deliveries, deliveryLines, returns, returnLines, loans, holdings, typeSummary, movements, audit, attachments] = await Promise.all([
    all(
      db,
      `SELECT v.*, t.name AS item_type_name, t.procurement_enabled, t.tracking_mode, s.label AS size_label
         FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id
        WHERE v.musician_id = ? ORDER BY t.sort_order, v.created_at`,
      id,
    ).then(withProgress),
    all(db, 'SELECT d.*, u.name AS delivered_by_name FROM musician_deliveries d JOIN users u ON u.id = d.delivered_by WHERE d.musician_id = ? ORDER BY d.delivered_at DESC', id),
    all(
      db,
      `SELECT dl.*, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, g.inscription
         FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id JOIN item_types t ON t.id = dl.item_type_id
         LEFT JOIN item_sizes s ON s.id = dl.size_id LEFT JOIN garments g ON g.id = dl.garment_id
        WHERE d.musician_id = ? ORDER BY d.delivered_at DESC`,
      id,
    ),
    all(db, 'SELECT r.*, u.name AS received_by_name FROM garment_returns r JOIN users u ON u.id = r.received_by WHERE r.musician_id = ? ORDER BY r.received_at DESC', id),
    all(
      db,
      `SELECT rl.*, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code
         FROM garment_return_lines rl JOIN garment_returns r ON r.id = rl.return_id JOIN item_types t ON t.id = rl.item_type_id
         LEFT JOIN item_sizes s ON s.id = rl.size_id LEFT JOIN garments g ON g.id = rl.garment_id
        WHERE r.musician_id = ?`,
      id,
    ),
    all(
      db,
      `SELECT lo.id, lo.delivered_at, lo.due_date, lo.closed_at, e.id AS event_id, e.name AS event_name,
              SUM(v.quantity) AS quantity, SUM(v.returned_quantity) AS returned, SUM(v.lost_quantity) AS lost, SUM(v.pending_quantity) AS pending
         FROM loans lo JOIN events e ON e.id = lo.event_id LEFT JOIN v_loan_lines v ON v.loan_id = lo.id
        WHERE lo.musician_id = ? GROUP BY lo.id ORDER BY lo.delivered_at DESC`,
      id,
    ),
    all(
      db,
      `SELECT g.id, g.code, g.inscription, g.status, g.condition, t.name AS item_type_name, s.label AS size_label
         FROM garments g JOIN item_types t ON t.id = g.item_type_id LEFT JOIN item_sizes s ON s.id = g.size_id
        WHERE g.holder_musician_id = ? ORDER BY t.sort_order`,
      id,
    ),
    musicianTypeSummary(db, id),
    all(
      db,
      `SELECT m.*, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, u.name AS user_name
         FROM stock_movements m JOIN item_types t ON t.id = m.item_type_id LEFT JOIN item_sizes s ON s.id = m.size_id
         LEFT JOIN garments g ON g.id = m.garment_id JOIN users u ON u.id = m.created_by
        WHERE m.musician_id = ? ORDER BY m.seq DESC LIMIT 200`,
      id,
    ),
    all(db, "SELECT a.action, a.created_at, a.summary, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity_type = 'musician' AND a.entity_id = ? ORDER BY a.seq DESC LIMIT 100", id),
    all(db, "SELECT id, caption, content_type, uploaded_at FROM attachments WHERE entity_type = 'musician' AND entity_id = ? AND deleted_at IS NULL", id),
  ]);
  return c.json({ musician: { ...m, notes: notes?.notes ?? null }, measurements, requests, deliveries, deliveryLines, returns, returnLines, loans, holdings, typeSummary, movements, audit, attachments });
});

/** Resumo por tipo de artigo: pretendido, entregue, em falta, a devolver, devolvido. */
export async function musicianTypeSummary(db: D1Database, musicianId: string) {
  return all(
    db,
    `SELECT t.id AS item_type_id, t.name AS item_type_name, t.procurement_enabled,
            COALESCE((SELECT SUM(v.quantity_requested) FROM v_request_progress v WHERE v.musician_id = ?1 AND v.item_type_id = t.id AND v.status NOT IN ('cancelada', 'resolvida')), 0) AS requested,
            COALESCE((SELECT SUM(dl.quantity) FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id
                       WHERE d.musician_id = ?1 AND dl.item_type_id = t.id AND dl.status = 'entregue'), 0) AS delivered,
            COALESCE((SELECT SUM(MAX(v.quantity_requested - v.quantity_delivered, 0)) FROM v_request_progress v
                       WHERE v.musician_id = ?1 AND v.item_type_id = t.id AND v.status = 'ativa'), 0) AS missing,
            COALESCE((SELECT SUM(r.return_expected) FROM musician_item_requests r WHERE r.musician_id = ?1 AND r.item_type_id = t.id AND r.status != 'cancelada'), 0) AS return_expected,
            COALESCE((SELECT x.returned_quantity FROM v_musician_returns x WHERE x.musician_id = ?1 AND x.item_type_id = t.id), 0) AS returned,
            (SELECT GROUP_CONCAT(COALESCE(r.size_text, s.label), ', ') FROM musician_item_requests r LEFT JOIN item_sizes s ON s.id = r.size_id
              WHERE r.musician_id = ?1 AND r.item_type_id = t.id AND r.status != 'cancelada') AS sizes
       FROM item_types t
      WHERE EXISTS (SELECT 1 FROM musician_item_requests r WHERE r.musician_id = ?1 AND r.item_type_id = t.id)
         OR EXISTS (SELECT 1 FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id WHERE d.musician_id = ?1 AND dl.item_type_id = t.id)
         OR EXISTS (SELECT 1 FROM v_musician_returns x WHERE x.musician_id = ?1 AND x.item_type_id = t.id)
      ORDER BY t.sort_order`,
    musicianId,
  );
}

/** Artigos que o músico tem na sua posse e pode devolver (para associar na recolha). */
musicianRoutes.get('/:id/returnables', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const garments = await all(
    c.env.DB,
    `SELECT g.id, g.code, g.inscription, g.condition, g.item_type_id, t.name AS item_type_name, g.size_id, s.label AS size_label
       FROM garments g JOIN item_types t ON t.id = g.item_type_id LEFT JOIN item_sizes s ON s.id = g.size_id
      WHERE g.holder_musician_id = ? AND g.status = 'atribuido'`,
    id,
  );
  const lines = await all(
    c.env.DB,
    `SELECT dl.id, dl.item_type_id, t.name AS item_type_name, dl.size_id, s.label AS size_label, dl.condition,
            dl.quantity - dl.returned_quantity AS outstanding, d.delivered_at
       FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id JOIN item_types t ON t.id = dl.item_type_id
       LEFT JOIN item_sizes s ON s.id = dl.size_id
      WHERE d.musician_id = ? AND dl.garment_id IS NULL AND dl.status = 'entregue' AND dl.quantity > dl.returned_quantity`,
    id,
  );
  return c.json({ garments, deliveryLines: lines });
});

/** Elimina um músico sem histórico de fardamento (entregas, recolhas, empréstimos, movimentos). */
musicianRoutes.delete('/:id', requirePerm('musicians.write'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const m = await first<{ full_name: string }>(db, 'SELECT full_name FROM musicians WHERE id = ?', id);
  if (!m) notFound('Músico');
  const history = await first<{ n: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM musician_deliveries WHERE musician_id = ?1) + (SELECT COUNT(*) FROM garment_returns WHERE musician_id = ?1)
          + (SELECT COUNT(*) FROM loans WHERE musician_id = ?1) + (SELECT COUNT(*) FROM stock_movements WHERE musician_id = ?1)
          + (SELECT COUNT(*) FROM garments WHERE holder_musician_id = ?1) + (SELECT COUNT(*) FROM incidents WHERE musician_id = ?1) AS n`,
    id,
  );
  if ((history?.n ?? 0) > 0) {
    throw new ApiError(409, 'COM_HISTORICO', 'Este músico já tem entregas, recolhas, empréstimos ou movimentos registados e não pode ser eliminado sem perder o histórico do fardamento. Altere o estado para «Inativo» ou «Arquivado».');
  }
  const stmts = [
    ...(await purgeAttachments(c.env, 'musician', [id])),
    db.prepare('DELETE FROM musician_measurements WHERE musician_id = ?').bind(id),
    db.prepare('DELETE FROM musician_item_requests WHERE musician_id = ?').bind(id),
    db.prepare('DELETE FROM musicians WHERE id = ?').bind(id),
    auditStmt(c, 'musico.eliminar', 'musician', id, { nome: m.full_name }),
  ];
  await runDelete(db, stmts, 'Este músico tem registos associados e não pode ser eliminado. Altere o estado para «Arquivado».');
  return c.json({ ok: true });
});

const zCm = z.number().min(0).max(300).nullish().transform((v) => (v ? v : null));

musicianRoutes.put('/:id/measurements', requirePerm('musicians.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({
      heightCm: zCm,
      chestCm: zCm,
      waistCm: zCm,
      hipsCm: zCm,
      shoulderCm: zCm,
      sleeveCm: zCm,
      inseamCm: zCm,
      neckCm: zCm,
      headCm: zCm,
      shoeSize: zText(10),
      notes: zText(1000),
      measuredAt: zDate.nullish(),
    }),
  );
  const m = await first(c.env.DB, 'SELECT id FROM musicians WHERE id = ?', id);
  if (!m) notFound('Músico');
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      `INSERT INTO musician_measurements (musician_id, height_cm, chest_cm, waist_cm, hips_cm, shoulder_cm, sleeve_cm, inseam_cm, neck_cm, head_cm, shoe_size, notes, measured_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (musician_id) DO UPDATE SET height_cm = excluded.height_cm, chest_cm = excluded.chest_cm, waist_cm = excluded.waist_cm,
         hips_cm = excluded.hips_cm, shoulder_cm = excluded.shoulder_cm, sleeve_cm = excluded.sleeve_cm, inseam_cm = excluded.inseam_cm,
         neck_cm = excluded.neck_cm, head_cm = excluded.head_cm, shoe_size = excluded.shoe_size, notes = excluded.notes,
         measured_at = excluded.measured_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(id, b.heightCm, b.chestCm, b.waistCm, b.hipsCm, b.shoulderCm, b.sleeveCm, b.inseamCm, b.neckCm, b.headCm, b.shoeSize, b.notes, b.measuredAt ?? todayIso(), now, c.get('user').id),
    auditStmt(c, 'musico.medidas', 'musician', id, b),
  ]);
  return c.json({ ok: true });
});

/**
 * Pedido de fardamento do músico num único passo: cria, atualiza ou remove as necessidades
 * (artigo, tamanho, quantidade e peças antigas a devolver). Tudo numa transação.
 */
musicianRoutes.put('/:id/order', requirePerm('requests.write'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const b = await parseBody(
    c,
    z.object({
      items: z
        .array(
          z.object({
            requestId: z.string().nullish(),
            itemTypeId: z.string().min(1),
            sizeId: z.string().nullish(),
            sizeText: zText(20),
            quantity: z.number().int().min(0).max(100),
            returnExpected: z.number().int().min(0).max(100).default(0),
            notes: zText(1000),
          }),
        )
        .max(100),
      requestedAt: zDate.optional(),
    }),
  );
  const m = await first<{ full_name: string }>(db, 'SELECT full_name FROM musicians WHERE id = ?', id);
  if (!m) notFound('Músico');
  const now = nowIso();
  const userId = c.get('user').id;
  const stmts: D1PreparedStatement[] = [];
  const summary: Record<string, unknown>[] = [];
  for (const it of b.items) {
    const type = await getItemType(db, it.itemTypeId);
    const sizeId = await assertSize(db, type, it.sizeId ?? null);
    if (it.requestId) {
      const r = await first<{ id: string; musician_id: string; item_type_id: string; size_id: string | null; status: string; quantity_delivered: number }>(
        db,
        'SELECT id, musician_id, item_type_id, size_id, status, quantity_delivered FROM v_request_progress WHERE id = ?',
        it.requestId,
      );
      if (!r || r.musician_id !== id) notFound('Necessidade');
      const refs = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM musician_delivery_lines WHERE request_id = ?', r.id);
      if (it.quantity === 0) {
        if ((refs?.n ?? 0) > 0) throw new ApiError(409, 'COM_ENTREGAS', `Não é possível remover o pedido de ${type.name}: já tem entregas registadas.`);
        stmts.push(db.prepare('DELETE FROM musician_item_requests WHERE id = ?').bind(r.id));
        summary.push({ acao: 'remover', artigo: type.name });
        continue;
      }
      if (it.quantity < r.quantity_delivered) throw new ApiError(409, 'QUANTIDADE_INFERIOR', `${type.name}: a quantidade não pode ser inferior à já entregue (${r.quantity_delivered}).`);
      if (r.quantity_delivered > 0 && (sizeId ?? null) !== (r.size_id ?? null)) throw new ApiError(409, 'COM_ENTREGAS', `${type.name}: não é possível mudar o tamanho depois de haver entregas.`);
      const status = type.procurement_enabled ? 'ativa' : r.status === 'cancelada' ? 'por_avaliar' : r.status;
      stmts.push(
        db
          .prepare('UPDATE musician_item_requests SET size_id = ?, size_text = ?, quantity_requested = ?, return_expected = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(sizeId, it.sizeText, it.quantity, type.procurement_enabled ? it.returnExpected : 0, it.notes, status, now, r.id),
      );
      summary.push({ acao: 'atualizar', artigo: type.name, tamanho: sizeId ?? it.sizeText, quantidade: it.quantity, devolver: it.returnExpected });
    } else if (it.quantity > 0) {
      if (!type.active) throw new ApiError(422, 'TIPO_INATIVO', `${type.name} está inativo.`);
      stmts.push(
        db
          .prepare(
            `INSERT INTO musician_item_requests (id, musician_id, item_type_id, size_id, size_text, quantity_requested, return_expected, status, notes, requested_at, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(uuid(), id, type.id, sizeId, it.sizeText, it.quantity, type.procurement_enabled ? it.returnExpected : 0, type.procurement_enabled ? 'ativa' : 'por_avaliar', it.notes, b.requestedAt ?? todayIso(), now, now, userId),
      );
      summary.push({ acao: 'criar', artigo: type.name, tamanho: sizeId ?? it.sizeText, quantidade: it.quantity, devolver: it.returnExpected });
    }
  }
  if (!stmts.length) return c.json({ ok: true, changes: 0 });
  stmts.push(auditStmt(c, 'musico.pedido_fardamento', 'musician', id, { linhas: summary }));
  await runBatch(db, stmts);
  return c.json({ ok: true, changes: summary.length });
});
