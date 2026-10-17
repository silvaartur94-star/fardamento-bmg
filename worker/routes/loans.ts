import { Hono } from 'hono';
import { z } from 'zod';
import { CONDITIONS, type Condition, type Status } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, purgeAttachments, runBatch, runMutation, todayIso, uuid, zDate, zOptDate, zOptId, zOptKey, zQty, zText, type Ctx } from '../lib/core';
import { requirePerm } from '../auth/session';
import { getBalance, getGarment, getItemType, movementStmt, reverseOperationStmts } from '../services/stock';
import { createMusicianStmts, musicianSchema } from './musicians';

export const loanRoutes = new Hono<AppEnv>();

export const LOAN_SELECT = `
  SELECT lo.*, mu.full_name AS musician_name, mu.kind AS musician_kind, mu.origin_band, mu.instrument AS musician_instrument, mu.phone AS musician_phone, mu.contact AS musician_contact,
         e.name AS event_name, e.start_date AS event_date, e.campaign_id, u.name AS delivered_by_name,
         COALESCE(SUM(v.quantity), 0) AS quantity, COALESCE(SUM(v.returned_quantity), 0) AS returned,
         COALESCE(SUM(v.lost_quantity), 0) AS lost, COALESCE(SUM(v.pending_quantity), 0) AS pending,
         CASE WHEN COALESCE(SUM(v.pending_quantity), 0) = 0 AND COALESCE(SUM(v.lost_quantity), 0) > 0 THEN 'com_perdas'
              WHEN COALESCE(SUM(v.pending_quantity), 0) = 0 THEN 'devolvido'
              WHEN lo.closed_at IS NOT NULL THEN 'encerrado'
              WHEN COALESCE(SUM(v.returned_quantity), 0) > 0 THEN 'parcial'
              ELSE 'aberto' END AS state
    FROM loans lo
    JOIN musicians mu ON mu.id = lo.musician_id
    JOIN events e ON e.id = lo.event_id
    JOIN users u ON u.id = lo.delivered_by
    LEFT JOIN v_loan_lines v ON v.loan_id = lo.id`;

export const loanFilters = pageQuery.extend({
  eventId: z.string().optional(),
  campaignId: z.string().optional(),
  musicianId: z.string().optional(),
  state: z.enum(['pendentes', 'atrasados', 'devolvidos']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export async function listLoans(db: D1Database, f: z.infer<typeof loanFilters>, unpaged = false) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.eventId) (where.push('lo.event_id = ?'), params.push(f.eventId));
  if (f.campaignId) (where.push('e.campaign_id = ?'), params.push(f.campaignId));
  if (f.musicianId) (where.push('lo.musician_id = ?'), params.push(f.musicianId));
  if (f.from) (where.push('lo.delivered_at >= ?'), params.push(f.from));
  if (f.to) (where.push('lo.delivered_at <= ?'), params.push(`${f.to}T23:59:59.999Z`));
  if (f.q) (where.push("(mu.full_name LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\')"), params.push(likeTerm(f.q), likeTerm(f.q)));
  let having = '';
  if (f.state === 'pendentes') having = 'HAVING COALESCE(SUM(v.pending_quantity), 0) > 0';
  if (f.state === 'devolvidos') having = 'HAVING COALESCE(SUM(v.pending_quantity), 0) = 0';
  if (f.state === 'atrasados') {
    having = 'HAVING COALESCE(SUM(v.pending_quantity), 0) > 0 AND lo.due_date IS NOT NULL AND lo.due_date < ?';
  }
  const hp = f.state === 'atrasados' ? [todayIso()] : [];
  const base = `${LOAN_SELECT} WHERE ${where.join(' AND ')} GROUP BY lo.id ${having}`;
  const { limit, offset } = paging(f);
  const items = await all(db, `${base} ORDER BY lo.delivered_at DESC ${unpaged ? '' : 'LIMIT ? OFFSET ?'}`, ...params, ...hp, ...(unpaged ? [] : [limit, offset]));
  const total = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM (${base})`, ...params, ...hp);
  return { items, total: total?.n ?? 0 };
}

loanRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, loanFilters);
  return c.json({ ...(await listLoans(c.env.DB, f)), page: f.page, pageSize: f.pageSize });
});

export async function loanDetail(db: D1Database, id: string) {
  const loan = await first<Record<string, unknown> & { event_id: string; musician_id: string }>(db, `${LOAN_SELECT} WHERE lo.id = ? GROUP BY lo.id`, id);
  if (!loan) notFound('Empréstimo');
  const lines = await all(
    db,
    `SELECT v.*, t.name AS item_type_name, t.tracking_mode, s.label AS size_label, g.code AS garment_code, g.inscription, g.status AS garment_status,
            l.name AS out_location_name, u.name AS delivered_by_name
       FROM v_loan_lines v JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id
       LEFT JOIN garments g ON g.id = v.garment_id LEFT JOIN locations l ON l.id = v.out_location_id JOIN users u ON u.id = v.delivered_by
      WHERE v.loan_id = ? ORDER BY t.sort_order, s.sort_order`,
    id,
  );
  const returns = await all(
    db,
    `SELECT r.*, u.name AS received_by_name, l.name AS location_name FROM loan_returns r JOIN users u ON u.id = r.received_by
       LEFT JOIN locations l ON l.id = r.location_id WHERE r.loan_line_id IN (SELECT id FROM loan_lines WHERE loan_id = ?) ORDER BY r.received_at`,
    id,
  );
  const attachments = await all(
    db,
    "SELECT id, caption, content_type, uploaded_at FROM attachments WHERE deleted_at IS NULL AND entity_type IN ('loan', 'loan_line') AND (entity_id = ?1 OR entity_id IN (SELECT id FROM loan_lines WHERE loan_id = ?1))",
    id,
  );
  return { loan, lines, returns, attachments };
}

loanRoutes.get('/:id', requirePerm('read'), async (c) => c.json(await loanDetail(c.env.DB, c.req.param('id'))));

const lineSchema = z
  .object({ itemTypeId: z.string().min(1), garmentId: zOptId, bucketKey: zOptKey, quantity: zQty.default(1), notes: zText(500) })
  .refine((l) => Boolean(l.garmentId) !== Boolean(l.bucketKey), 'Indique a peça (código) ou o lote de stock');

async function buildLineStmts(c: Ctx, loanId: string, musicianId: string, lines: z.infer<typeof lineSchema>[], opId: string, now: string) {
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const userId = c.get('user').id;
  for (const l of lines) {
    const type = await getItemType(db, l.itemTypeId);
    const lineId = uuid();
    if (l.garmentId) {
      if (seen.has(l.garmentId)) throw new ApiError(422, 'PECA_REPETIDA', 'A mesma peça foi indicada mais do que uma vez.');
      seen.add(l.garmentId);
      const g = await getGarment(db, l.garmentId);
      if (g.item_type_id !== type.id) throw new ApiError(422, 'TIPO_INCOERENTE', 'O tipo de artigo não corresponde à peça indicada.');
      if (g.status !== 'disponivel') throw new ApiError(409, 'PECA_INDISPONIVEL', `A peça ${g.code} não está disponível para empréstimo.`);
      stmts.push(
        db
          .prepare(
            `INSERT INTO loan_lines (id, loan_id, item_type_id, garment_id, size_id, quantity, out_condition, out_location_id, delivered_at, delivered_by, notes, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(lineId, loanId, type.id, g.id, g.size_id, g.condition, g.location_id, now, userId, l.notes, now),
        movementStmt(
          c,
          {
            operationId: opId,
            type: 'emprestimo',
            itemTypeId: type.id,
            garmentId: g.id,
            sizeId: g.size_id,
            from: { status: 'disponivel', condition: g.condition, locationId: g.location_id },
            to: { status: 'emprestado', condition: g.condition, locationId: null },
            musicianId,
            refType: 'loan',
            refId: loanId,
          },
          now,
        ).stmt,
      );
    } else {
      const bal = await getBalance(db, l.bucketKey!);
      if (!bal || bal.item_type_id !== type.id) throw new ApiError(422, 'LOTE_INVALIDO', 'Lote de stock inválido.');
      if (bal.status !== 'disponivel') throw new ApiError(409, 'LOTE_INDISPONIVEL', 'O lote indicado não está disponível.');
      if (bal.quantity < l.quantity) throw new ApiError(409, 'STOCK_INSUFICIENTE', `Stock insuficiente de ${type.name}: disponível ${bal.quantity}.`);
      stmts.push(
        db
          .prepare(
            `INSERT INTO loan_lines (id, loan_id, item_type_id, garment_id, size_id, quantity, out_condition, out_location_id, delivered_at, delivered_by, notes, created_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(lineId, loanId, type.id, bal.size_id, l.quantity, bal.condition, bal.location_id, now, userId, l.notes, now),
        movementStmt(
          c,
          {
            operationId: opId,
            type: 'emprestimo',
            itemTypeId: type.id,
            sizeId: bal.size_id,
            quantity: l.quantity,
            from: { status: 'disponivel', condition: bal.condition, locationId: bal.location_id },
            to: { status: 'emprestado', condition: bal.condition, locationId: null },
            musicianId,
            refType: 'loan',
            refId: loanId,
          },
          now,
        ).stmt,
      );
    }
  }
  return stmts;
}

async function assertEventOpen(db: D1Database, eventId: string) {
  const ev = await first<{ status: string }>(db, 'SELECT status FROM events WHERE id = ?', eventId);
  if (!ev) notFound('Festa');
  if (ev.status === 'encerrada' || ev.status === 'cancelada') throw new ApiError(409, 'FESTA_FECHADA', 'A festa está encerrada ou cancelada.');
}

loanRoutes.post('/', requirePerm('loans.write'), async (c) => {
  const b = await parseBody(
    c,
    z
      .object({
        eventId: z.string().min(1),
        musicianId: zOptId,
        newMusician: musicianSchema.optional(),
        dueDate: zOptDate,
        notes: zText(2000),
        lines: z.array(lineSchema).min(1, 'Indique pelo menos um artigo').max(100),
      })
      .refine((x) => Boolean(x.musicianId) !== Boolean(x.newMusician), 'Indique o músico convidado'),
  );
  const db = c.env.DB;
  await assertEventOpen(db, b.eventId);
  const stmts: D1PreparedStatement[] = [];
  let musicianId = b.musicianId;
  if (b.newMusician) {
    const created = await createMusicianStmts(c, { ...b.newMusician, kind: b.newMusician.kind ?? 'convidado' });
    musicianId = created.id;
    stmts.push(...created.stmts);
  } else {
    const m = await first<{ status: string }>(db, 'SELECT status FROM musicians WHERE id = ?', musicianId);
    if (!m) notFound('Músico');
    if (m.status === 'arquivado') throw new ApiError(409, 'MUSICO_ARQUIVADO', 'O músico está arquivado.');
  }
  const loanId = uuid();
  const opId = uuid();
  const now = nowIso();
  stmts.push(
    db
      .prepare('INSERT INTO loans (id, event_id, musician_id, delivered_at, delivered_by, due_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(loanId, b.eventId, musicianId, now, c.get('user').id, b.dueDate, b.notes, now, now),
    ...(await buildLineStmts(c, loanId, musicianId!, b.lines, opId, now)),
    db.prepare("UPDATE events SET status = 'ativa', updated_at = ? WHERE id = ? AND status = 'planeada'").bind(now, b.eventId),
    auditStmt(c, 'emprestimo.criar', 'loan', loanId, { festa: b.eventId, musico: musicianId, linhas: b.lines.length }),
  );
  const res = await runMutation(c, stmts, { scope: 'loans.create', response: { id: loanId, musicianId } });
  return c.json({ ...res.response, replayed: res.replayed }, res.replayed ? 200 : 201);
});

loanRoutes.post('/:id/lines', requirePerm('loans.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ lines: z.array(lineSchema).min(1).max(100) }));
  const loan = await first<{ event_id: string; musician_id: string; closed_at: string | null }>(c.env.DB, 'SELECT event_id, musician_id, closed_at FROM loans WHERE id = ?', id);
  if (!loan) notFound('Empréstimo');
  if (loan.closed_at) throw new ApiError(409, 'EMPRESTIMO_FECHADO', 'O empréstimo está encerrado.');
  await assertEventOpen(c.env.DB, loan.event_id);
  const now = nowIso();
  const stmts = [
    ...(await buildLineStmts(c, id, loan.musician_id, b.lines, uuid(), now)),
    c.env.DB.prepare('UPDATE loans SET updated_at = ? WHERE id = ?').bind(now, id),
    auditStmt(c, 'emprestimo.adicionar_linhas', 'loan', id, { linhas: b.lines.length }),
  ];
  const res = await runMutation(c, stmts, { scope: 'loans.add_lines', response: { ok: true } });
  return c.json(res.response);
});

const RETURN_DESTINATIONS = ['disponivel', 'pendente_inspecao', 'quarentena', 'reparacao'] as const;

loanRoutes.post('/:id/returns', requirePerm('loans.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({
      returns: z
        .array(
          z.object({
            lineId: z.string().min(1),
            quantity: zQty,
            condition: z.enum(CONDITIONS),
            damaged: z.boolean().default(false),
            destination: z.enum(RETURN_DESTINATIONS).optional(),
            locationId: zOptId,
            notes: zText(1000),
          }),
        )
        .min(1)
        .max(200),
    }),
  );
  const db = c.env.DB;
  const loan = await first<{ musician_id: string; event_id: string }>(db, 'SELECT musician_id, event_id FROM loans WHERE id = ?', id);
  if (!loan) notFound('Empréstimo');
  const opId = uuid();
  const now = nowIso();
  const userId = c.get('user').id;
  const stmts: D1PreparedStatement[] = [];
  const perLine = new Map<string, number>();
  for (const r of b.returns) {
    const line = await first<{ id: string; item_type_id: string; garment_id: string | null; size_id: string | null; out_condition: Condition; pending_quantity: number }>(
      db,
      'SELECT * FROM v_loan_lines WHERE id = ? AND loan_id = ?',
      r.lineId,
      id,
    );
    if (!line) notFound('Linha de empréstimo');
    const total = (perLine.get(line.id) ?? 0) + r.quantity;
    perLine.set(line.id, total);
    if (total > line.pending_quantity) {
      throw new ApiError(409, 'DEVOLUCAO_EXCEDE', `A quantidade devolvida (${total}) excede a quantidade em falta (${line.pending_quantity}).`);
    }
    const badCondition = r.damaged || r.condition === 'mau' || r.condition === 'inutilizavel';
    // Uma peça danificada nunca fica automaticamente disponível.
    const destination: Status = r.destination ?? (badCondition ? 'pendente_inspecao' : 'disponivel');
    if (destination === 'disponivel' && badCondition) {
      throw new ApiError(422, 'DANIFICADA', 'Uma peça devolvida danificada não pode ficar diretamente disponível. Escolha inspeção, quarentena ou reparação.');
    }
    let fromCondition = line.out_condition;
    if (line.garment_id) {
      const g = await getGarment(db, line.garment_id);
      fromCondition = g.condition;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO loan_returns (id, loan_line_id, kind, quantity, condition, damaged, destination_status, location_id, received_at, received_by, notes, created_at)
           VALUES (?, ?, 'devolucao', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uuid(), line.id, r.quantity, r.condition, r.damaged ? 1 : 0, destination, r.locationId, now, userId, r.notes, now),
      // A restrição CHECK (returned + lost <= quantity) impede devoluções excessivas, mesmo em pedidos concorrentes.
      db.prepare('UPDATE loan_lines SET returned_quantity = returned_quantity + ?, last_return_condition = ? WHERE id = ?').bind(r.quantity, r.condition, line.id),
      movementStmt(
        c,
        {
          operationId: opId,
          type: 'devolucao_emprestimo',
          itemTypeId: line.item_type_id,
          garmentId: line.garment_id,
          sizeId: line.size_id,
          quantity: r.quantity,
          from: { status: 'emprestado', condition: fromCondition, locationId: null },
          to: { status: destination, condition: r.condition, locationId: r.locationId },
          musicianId: loan.musician_id,
          refType: 'loan',
          refId: id,
          notes: r.notes,
          reason: r.damaged ? 'Devolvida com danos' : null,
        },
        now,
      ).stmt,
    );
    if (r.damaged) {
      stmts.push(
        db
          .prepare('INSERT INTO incidents (id, kind, description, garment_id, musician_id, loan_id, event_id, occurred_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(uuid(), 'dano', r.notes ?? 'Peça devolvida com danos', line.garment_id, loan.musician_id, id, loan.event_id, now, userId, now),
      );
    }
  }
  stmts.push(db.prepare('UPDATE loans SET updated_at = ? WHERE id = ?').bind(now, id), auditStmt(c, 'emprestimo.devolucao', 'loan', id, { devolucoes: b.returns }));
  const res = await runMutation(c, stmts, { scope: 'loans.return', response: { operationId: opId } });
  return c.json(res.response);
});

/** Regista uma peça emprestada como perdida/não devolvida (sai do inventário ativo como extraviada). */
loanRoutes.post('/:id/lines/:lineId/lost', requirePerm('loans.write', 'inventory.writeoff'), async (c) => {
  const { id, lineId } = c.req.param();
  const b = await parseBody(c, z.object({ quantity: zQty, reason: z.string().trim().min(3, 'Indique o motivo').max(1000) }));
  const db = c.env.DB;
  const loan = await first<{ musician_id: string; event_id: string }>(db, 'SELECT musician_id, event_id FROM loans WHERE id = ?', id);
  if (!loan) notFound('Empréstimo');
  const line = await first<{ id: string; item_type_id: string; garment_id: string | null; size_id: string | null; out_condition: Condition; pending_quantity: number }>(
    db,
    'SELECT * FROM v_loan_lines WHERE id = ? AND loan_id = ?',
    lineId,
    id,
  );
  if (!line) notFound('Linha de empréstimo');
  if (b.quantity > line.pending_quantity) throw new ApiError(409, 'DEVOLUCAO_EXCEDE', 'A quantidade indicada excede a quantidade em falta.');
  const now = nowIso();
  const userId = c.get('user').id;
  let cond = line.out_condition;
  if (line.garment_id) cond = (await getGarment(db, line.garment_id)).condition;
  const stmts = [
    db
      .prepare(
        `INSERT INTO loan_returns (id, loan_line_id, kind, quantity, condition, damaged, destination_status, received_at, received_by, notes, created_at)
         VALUES (?, ?, 'perda', ?, NULL, 0, 'extraviado', ?, ?, ?, ?)`,
      )
      .bind(uuid(), line.id, b.quantity, now, userId, b.reason, now),
    db.prepare('UPDATE loan_lines SET lost_quantity = lost_quantity + ? WHERE id = ?').bind(b.quantity, line.id),
    movementStmt(
      c,
      {
        operationId: uuid(),
        type: 'extravio',
        itemTypeId: line.item_type_id,
        garmentId: line.garment_id,
        sizeId: line.size_id,
        quantity: b.quantity,
        from: { status: 'emprestado', condition: cond, locationId: null },
        to: { status: 'extraviado', condition: cond, locationId: null },
        musicianId: loan.musician_id,
        refType: 'loan',
        refId: id,
        reason: b.reason,
      },
      now,
    ).stmt,
    db
      .prepare('INSERT INTO incidents (id, kind, description, garment_id, musician_id, loan_id, event_id, occurred_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uuid(), 'perda', b.reason, line.garment_id, loan.musician_id, id, loan.event_id, now, userId, now),
    auditStmt(c, 'emprestimo.perda', 'loan', id, { linha: line.id, quantidade: b.quantity, motivo: b.reason }),
  ];
  const res = await runMutation(c, stmts, { scope: 'loans.lost', response: { ok: true } });
  return c.json(res.response);
});

/** Anula um empréstimo registado por engano (sem devoluções): o material regressa ao stock disponível. */
loanRoutes.post('/:id/cancel', requirePerm('loans.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3, 'Indique o motivo').max(500) }));
  const db = c.env.DB;
  const loan = await first<{ musician_id: string; event_id: string }>(db, 'SELECT musician_id, event_id FROM loans WHERE id = ?', id);
  if (!loan) notFound('Empréstimo');
  const ret = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM loan_returns WHERE loan_line_id IN (SELECT id FROM loan_lines WHERE loan_id = ?)', id);
  if ((ret?.n ?? 0) > 0) throw new ApiError(409, 'COM_DEVOLUCOES', 'Este empréstimo já tem devoluções ou perdas registadas e não pode ser anulado. Registe a devolução do restante material.');
  const lineIds = (await all<{ id: string }>(db, 'SELECT id FROM loan_lines WHERE loan_id = ?', id)).map((l) => l.id);
  const stmts = [
    ...(await reverseOperationStmts(c, 'loan', id, ['emprestimo'], `Empréstimo anulado: ${b.reason}`)),
    ...(await purgeAttachments(c.env, 'loan_line', lineIds)),
    ...(await purgeAttachments(c.env, 'loan', [id])),
    db.prepare('UPDATE incidents SET loan_id = NULL WHERE loan_id = ?').bind(id),
    db.prepare('DELETE FROM loan_lines WHERE loan_id = ?').bind(id),
    db.prepare('DELETE FROM loans WHERE id = ?').bind(id),
    auditStmt(c, 'emprestimo.anular', 'loan', id, { festa: loan.event_id, musico: loan.musician_id, motivo: b.reason }),
    auditStmt(c, 'emprestimo.anular', 'event', loan.event_id, { emprestimo: id, motivo: b.reason }),
  ];
  const res = await runMutation(c, stmts, { scope: 'loans.cancel', response: { ok: true, eventId: loan.event_id } });
  return c.json(res.response);
});

/** Regista o envio de um lembrete de devolução ao músico convidado. */
loanRoutes.post('/:id/reminded', requirePerm('loans.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ channel: z.enum(['whatsapp', 'sms']) }));
  const loan = await first<{ musician_id: string; event_id: string }>(c.env.DB, 'SELECT musician_id, event_id FROM loans WHERE id = ?', id);
  if (!loan) notFound('Empréstimo');
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE loans SET last_reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?').bind(now, id),
    auditStmt(c, 'emprestimo.lembrete', 'loan', id, { canal: b.channel, festa: loan.event_id }),
  ]);
  return c.json({ ok: true, at: now });
});
