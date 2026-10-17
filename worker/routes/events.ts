import { Hono } from 'hono';
import { z } from 'zod';
import { CAMPAIGN_STATUSES, EVENT_STATUSES } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, purgeAttachments, runBatch, runDelete, uuid, zDate, zOptDate, zOptId, zText } from '../lib/core';
import { requirePerm } from '../auth/session';

// ---------------------------------------------------------------------------
// Reconciliação (empréstimos de uma festa ou campanha)
// ---------------------------------------------------------------------------
export async function reconciliation(db: D1Database, scope: { eventId?: string; campaignId?: string }) {
  const where = scope.eventId ? 'lo.event_id = ?' : 'e.campaign_id = ?';
  const param = scope.eventId ?? scope.campaignId;
  const lines = await all<{
    loan_id: string;
    musician_id: string;
    musician_name: string;
    event_name: string;
    event_id: string;
    item_type_name: string;
    size_label: string | null;
    garment_code: string | null;
    quantity: number;
    returned_quantity: number;
    lost_quantity: number;
    pending_quantity: number;
    damaged_quantity: number;
    needs_attention: number;
    out_condition: string;
    due_date: string | null;
  }>(
    db,
    `SELECT v.*, lo.musician_id, mu.full_name AS musician_name, e.name AS event_name, e.id AS event_id, lo.due_date,
            t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, g.inscription, g.status AS garment_status,
            COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = v.id AND r.kind = 'devolucao' AND r.damaged = 1), 0) AS damaged_quantity,
            COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = v.id AND r.kind = 'devolucao'
                       AND r.destination_status IN ('pendente_inspecao', 'quarentena', 'reparacao')), 0) AS needs_attention
       FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id JOIN events e ON e.id = lo.event_id
       JOIN musicians mu ON mu.id = lo.musician_id JOIN item_types t ON t.id = v.item_type_id
       LEFT JOIN item_sizes s ON s.id = v.size_id LEFT JOIN garments g ON g.id = v.garment_id
      WHERE ${where} ORDER BY e.start_date, mu.full_name COLLATE NOCASE, t.sort_order`,
    param,
  );
  const sum = (k: keyof (typeof lines)[number]) => lines.reduce((a, l) => a + Number(l[k] ?? 0), 0);
  const byMusician = new Map<string, { musician_id: string; musician_name: string; lent: number; returned: number; lost: number; pending: number; damaged: number }>();
  for (const l of lines) {
    const m = byMusician.get(l.musician_id) ?? { musician_id: l.musician_id, musician_name: l.musician_name, lent: 0, returned: 0, lost: 0, pending: 0, damaged: 0 };
    m.lent += l.quantity;
    m.returned += l.returned_quantity;
    m.lost += l.lost_quantity;
    m.pending += l.pending_quantity;
    m.damaged += l.damaged_quantity;
    byMusician.set(l.musician_id, m);
  }
  return {
    totals: {
      lent: sum('quantity'),
      returned: sum('returned_quantity'),
      lost: sum('lost_quantity'),
      pending: sum('pending_quantity'),
      damaged: sum('damaged_quantity'),
      needsAttention: sum('needs_attention'),
    },
    byMusician: [...byMusician.values()],
    pendingLines: lines.filter((l) => l.pending_quantity > 0),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Campanhas
// ---------------------------------------------------------------------------
export const campaignRoutes = new Hono<AppEnv>();

campaignRoutes.get('/', requirePerm('read'), async (c) => {
  const items = await all(
    c.env.DB,
    `SELECT fc.*, (SELECT COUNT(*) FROM events e WHERE e.campaign_id = fc.id) AS event_count,
            COALESCE((SELECT SUM(v.pending_quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id JOIN events e ON e.id = lo.event_id WHERE e.campaign_id = fc.id), 0) AS pending
       FROM festival_campaigns fc ORDER BY COALESCE(fc.start_date, fc.created_at) DESC`,
  );
  return c.json({ items });
});

const campaignSchema = z.object({
  name: z.string().trim().min(1, 'Obrigatório').max(160),
  startDate: zOptDate,
  endDate: zOptDate,
  status: z.enum(CAMPAIGN_STATUSES).default('planeada'),
  notes: zText(2000),
});

campaignRoutes.post('/', requirePerm('events.write'), async (c) => {
  const b = await parseBody(c, campaignSchema);
  if (b.startDate && b.endDate && b.endDate < b.startDate) throw new ApiError(422, 'DATAS', 'A data de fim não pode ser anterior à de início.');
  const id = uuid();
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('INSERT INTO festival_campaigns (id, name, start_date, end_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      b.name,
      b.startDate,
      b.endDate,
      b.status,
      b.notes,
      now,
      now,
    ),
    auditStmt(c, 'campanha.criar', 'campaign', id, b),
  ]);
  return c.json({ id }, 201);
});

campaignRoutes.patch('/:id', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, campaignSchema.partial());
  const cur = await first<{ start_date: string | null; end_date: string | null }>(c.env.DB, 'SELECT start_date, end_date FROM festival_campaigns WHERE id = ?', id);
  if (!cur) notFound('Campanha');
  const start = b.startDate !== undefined ? b.startDate : cur.start_date;
  const end = b.endDate !== undefined ? b.endDate : cur.end_date;
  if (start && end && end < start) throw new ApiError(422, 'DATAS', 'A data de fim não pode ser anterior à de início.');
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'UPDATE festival_campaigns SET name = COALESCE(?, name), start_date = ?, end_date = ?, status = COALESCE(?, status), notes = CASE WHEN ? THEN ? ELSE notes END, updated_at = ? WHERE id = ?',
    ).bind(b.name ?? null, start, end, b.status ?? null, b.notes !== undefined ? 1 : 0, b.notes ?? null, nowIso(), id),
    auditStmt(c, 'campanha.editar', 'campaign', id, b),
  ]);
  return c.json({ ok: true });
});

campaignRoutes.get('/:id', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const campaign = await first(c.env.DB, 'SELECT * FROM festival_campaigns WHERE id = ?', id);
  if (!campaign) notFound('Campanha');
  const events = await all(
    c.env.DB,
    `SELECT e.*, (SELECT COUNT(*) FROM loans lo WHERE lo.event_id = e.id) AS loan_count,
            COALESCE((SELECT SUM(v.quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.event_id = e.id), 0) AS lent,
            COALESCE((SELECT SUM(v.pending_quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.event_id = e.id), 0) AS pending
       FROM events e WHERE e.campaign_id = ? ORDER BY e.start_date`,
    id,
  );
  return c.json({ campaign, events, reconciliation: await reconciliation(c.env.DB, { campaignId: id }) });
});

/** Elimina a campanha; as festas associadas passam a independentes (não são apagadas). */
campaignRoutes.delete('/:id', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const fc = await first<{ name: string }>(c.env.DB, 'SELECT name FROM festival_campaigns WHERE id = ?', id);
  if (!fc) notFound('Campanha');
  await runDelete(
    c.env.DB,
    [
      c.env.DB.prepare('UPDATE events SET campaign_id = NULL, updated_at = ? WHERE campaign_id = ?').bind(nowIso(), id),
      c.env.DB.prepare('DELETE FROM festival_campaigns WHERE id = ?').bind(id),
      auditStmt(c, 'campanha.eliminar', 'campaign', id, { nome: fc.name }),
    ],
    'Não foi possível eliminar a campanha.',
  );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Festas / atuações
// ---------------------------------------------------------------------------
export const eventRoutes = new Hono<AppEnv>();

export const eventFilters = pageQuery.extend({
  campaignId: z.string().optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  withPending: z.string().optional(),
});

eventRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, eventFilters);
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.campaignId) (where.push(f.campaignId === 'none' ? 'e.campaign_id IS NULL' : 'e.campaign_id = ?'), f.campaignId !== 'none' && params.push(f.campaignId));
  if (f.status) (where.push('e.status = ?'), params.push(f.status));
  if (f.from) (where.push('COALESCE(e.end_date, e.start_date) >= ?'), params.push(f.from));
  if (f.to) (where.push('e.start_date <= ?'), params.push(f.to));
  if (f.q) (where.push("(e.name LIKE ? ESCAPE '\\' OR e.place LIKE ? ESCAPE '\\')"), params.push(likeTerm(f.q), likeTerm(f.q)));
  const base = `SELECT e.*, fc.name AS campaign_name,
          (SELECT COUNT(*) FROM loans lo WHERE lo.event_id = e.id) AS loan_count,
          COALESCE((SELECT SUM(v.quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.event_id = e.id), 0) AS lent,
          COALESCE((SELECT SUM(v.pending_quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.event_id = e.id), 0) AS pending
     FROM events e LEFT JOIN festival_campaigns fc ON fc.id = e.campaign_id WHERE ${where.join(' AND ')}`;
  const outer = f.withPending === '1' ? 'WHERE pending > 0' : '';
  const { limit, offset } = paging(f);
  const items = await all(c.env.DB, `SELECT * FROM (${base}) ${outer} ORDER BY start_date DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM (${base}) ${outer}`, ...params);
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

const eventSchema = z.object({
  campaignId: zOptId,
  name: z.string().trim().min(1, 'Obrigatório').max(160),
  place: zText(160),
  startDate: zDate,
  endDate: zOptDate,
  status: z.enum(EVENT_STATUSES).default('planeada'),
  notes: zText(2000),
});

eventRoutes.post('/', requirePerm('events.write'), async (c) => {
  const b = await parseBody(c, eventSchema);
  if (b.endDate && b.endDate < b.startDate) throw new ApiError(422, 'DATAS', 'A data de fim não pode ser anterior à de início.');
  if (b.status === 'encerrada') throw new ApiError(422, 'ESTADO_INVALIDO', 'Utilize a função "Encerrar festa".');
  if (b.campaignId) {
    const fc = await first(c.env.DB, 'SELECT id FROM festival_campaigns WHERE id = ?', b.campaignId);
    if (!fc) notFound('Campanha');
  }
  const id = uuid();
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('INSERT INTO events (id, campaign_id, name, place, start_date, end_date, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      b.campaignId,
      b.name,
      b.place,
      b.startDate,
      b.endDate,
      b.status,
      b.notes,
      now,
      now,
    ),
    auditStmt(c, 'festa.criar', 'event', id, b),
  ]);
  return c.json({ id }, 201);
});

eventRoutes.patch('/:id', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, eventSchema.partial());
  const cur = await first<{ start_date: string; end_date: string | null; status: string }>(c.env.DB, 'SELECT start_date, end_date, status FROM events WHERE id = ?', id);
  if (!cur) notFound('Festa');
  if (b.status === 'encerrada' && cur.status !== 'encerrada') throw new ApiError(422, 'ESTADO_INVALIDO', 'Utilize a função "Encerrar festa".');
  const start = b.startDate ?? cur.start_date;
  const end = b.endDate !== undefined ? b.endDate : cur.end_date;
  if (end && end < start) throw new ApiError(422, 'DATAS', 'A data de fim não pode ser anterior à de início.');
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      `UPDATE events SET campaign_id = CASE WHEN ? THEN ? ELSE campaign_id END, name = COALESCE(?, name), place = CASE WHEN ? THEN ? ELSE place END,
         start_date = ?, end_date = ?, status = COALESCE(?, status), notes = CASE WHEN ? THEN ? ELSE notes END, updated_at = ? WHERE id = ?`,
    ).bind(
      b.campaignId !== undefined ? 1 : 0,
      b.campaignId ?? null,
      b.name ?? null,
      b.place !== undefined ? 1 : 0,
      b.place ?? null,
      start,
      end,
      b.status ?? null,
      b.notes !== undefined ? 1 : 0,
      b.notes ?? null,
      nowIso(),
      id,
    ),
    auditStmt(c, 'festa.editar', 'event', id, b),
  ]);
  return c.json({ ok: true });
});

eventRoutes.get('/:id', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const event = await first(
    db,
    `SELECT e.*, fc.name AS campaign_name, cu.name AS closed_by_name FROM events e LEFT JOIN festival_campaigns fc ON fc.id = e.campaign_id
       LEFT JOIN users cu ON cu.id = e.closed_by WHERE e.id = ?`,
    id,
  );
  if (!event) notFound('Festa');
  const loans = await all(
    db,
    `SELECT lo.*, mu.full_name AS musician_name, mu.kind AS musician_kind, mu.origin_band, u.name AS delivered_by_name,
            COALESCE(SUM(v.quantity), 0) AS quantity, COALESCE(SUM(v.returned_quantity), 0) AS returned,
            COALESCE(SUM(v.lost_quantity), 0) AS lost, COALESCE(SUM(v.pending_quantity), 0) AS pending
       FROM loans lo JOIN musicians mu ON mu.id = lo.musician_id JOIN users u ON u.id = lo.delivered_by
       LEFT JOIN v_loan_lines v ON v.loan_id = lo.id
      WHERE lo.event_id = ? GROUP BY lo.id ORDER BY mu.full_name COLLATE NOCASE`,
    id,
  );
  const returns = await all(
    db,
    `SELECT r.*, ll.loan_id, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, u.name AS received_by_name, mu.full_name AS musician_name
       FROM loan_returns r JOIN loan_lines ll ON ll.id = r.loan_line_id JOIN loans lo ON lo.id = ll.loan_id JOIN musicians mu ON mu.id = lo.musician_id
       JOIN item_types t ON t.id = ll.item_type_id LEFT JOIN item_sizes s ON s.id = ll.size_id LEFT JOIN garments g ON g.id = ll.garment_id
       JOIN users u ON u.id = r.received_by
      WHERE lo.event_id = ? ORDER BY r.received_at DESC`,
    id,
  );
  return c.json({ event, loans, returns, reconciliation: await reconciliation(db, { eventId: id }) });
});

/** Encerra a festa. Com material por devolver exige confirmação explícita e regista as pendências. */
eventRoutes.post('/:id/close', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ confirmPending: z.boolean().default(false), notes: zText(2000) }));
  const ev = await first<{ status: string; name: string }>(c.env.DB, 'SELECT status, name FROM events WHERE id = ?', id);
  if (!ev) notFound('Festa');
  if (ev.status === 'encerrada') throw new ApiError(409, 'JA_ENCERRADA', 'Esta festa já está encerrada.');
  const rec = await reconciliation(c.env.DB, { eventId: id });
  if (rec.totals.pending > 0 && !b.confirmPending) {
    throw new ApiError(409, 'PENDENCIAS', `Existem ${rec.totals.pending} peça(s) por devolver. Confirme explicitamente o encerramento com pendências.`, {
      pending: rec.byMusician.filter((m) => m.pending > 0),
    });
  }
  if (rec.totals.pending > 0 && !b.notes) throw new ApiError(422, 'NOTAS_OBRIGATORIAS', 'Descreva as pendências e as diligências previstas.');
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE events SET status = 'encerrada', closed_at = ?, closed_by = ?, closed_with_pending = ?, closing_notes = ?, updated_at = ? WHERE id = ?").bind(
      now,
      c.get('user').id,
      rec.totals.pending > 0 ? 1 : 0,
      b.notes,
      now,
      id,
    ),
    auditStmt(c, 'festa.encerrar', 'event', id, {
      totais: rec.totals,
      pendencias: rec.pendingLines.map((l) => ({ musico: l.musician_name, artigo: l.item_type_name, tamanho: l.size_label, codigo: l.garment_code, em_falta: l.pending_quantity })),
    }),
  ]);
  return c.json({ ok: true, pending: rec.totals.pending });
});

eventRoutes.post('/:id/reopen', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const ev = await first<{ status: string }>(c.env.DB, 'SELECT status FROM events WHERE id = ?', id);
  if (!ev) notFound('Festa');
  if (ev.status !== 'encerrada') throw new ApiError(409, 'NAO_ENCERRADA', 'A festa não está encerrada.');
  await runBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE events SET status = 'ativa', updated_at = ? WHERE id = ?").bind(nowIso(), id),
    auditStmt(c, 'festa.reabrir', 'event', id),
  ]);
  return c.json({ ok: true });
});

/** Elimina uma festa sem empréstimos (ex.: criada por engano ou cancelada antes de haver material entregue). */
eventRoutes.delete('/:id', requirePerm('events.write'), async (c) => {
  const id = c.req.param('id');
  const ev = await first<{ name: string }>(c.env.DB, 'SELECT name FROM events WHERE id = ?', id);
  if (!ev) notFound('Festa');
  const loans = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM loans WHERE event_id = ?', id);
  if ((loans?.n ?? 0) > 0) {
    throw new ApiError(409, 'COM_EMPRESTIMOS', 'Esta festa tem empréstimos registados. Anule primeiro cada empréstimo (se foi registado por engano) ou altere o estado da festa para «Cancelada».');
  }
  await runDelete(
    c.env.DB,
    [
      ...(await purgeAttachments(c.env, 'event', [id])),
      c.env.DB.prepare('UPDATE incidents SET event_id = NULL WHERE event_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id),
      auditStmt(c, 'festa.eliminar', 'event', id, { nome: ev.name }),
    ],
    'Não foi possível eliminar a festa porque tem registos associados.',
  );
  return c.json({ ok: true });
});
