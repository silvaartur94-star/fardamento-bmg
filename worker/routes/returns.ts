import { Hono } from 'hono';
import { z } from 'zod';
import { CONDITIONS, DESTINATION_MOVEMENT, INSPECTION_DESTINATIONS, type Condition, type Status } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, runBatch, runMutation, todayIso, uuid, zDate, zOptId, zQty, zText } from '../lib/core';
import { requirePerm } from '../auth/session';
import { assertSize, garmentInsertStmt, getGarment, getItemType, movementStmt } from '../services/stock';

export const returnRoutes = new Hono<AppEnv>();

export const returnFilters = pageQuery.extend({
  musicianId: z.string().optional(),
  status: z.enum(['pendente', 'em_curso', 'concluida', 'por_decidir']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export function returnWhere(f: z.infer<typeof returnFilters>) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.musicianId) (where.push('r.musician_id = ?'), params.push(f.musicianId));
  if (f.status === 'por_decidir') where.push("r.inspection_status != 'concluida'");
  else if (f.status) (where.push('r.inspection_status = ?'), params.push(f.status));
  if (f.from) (where.push('r.received_at >= ?'), params.push(f.from));
  if (f.to) (where.push('r.received_at <= ?'), params.push(`${f.to}T23:59:59.999Z`));
  if (f.q) (where.push("m.full_name LIKE ? ESCAPE '\\'"), params.push(likeTerm(f.q)));
  return { sql: where.join(' AND '), params };
}

returnRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, returnFilters);
  const w = returnWhere(f);
  const { limit, offset } = paging(f);
  const items = await all(
    c.env.DB,
    `SELECT r.*, m.full_name AS musician_name, u.name AS received_by_name,
            (SELECT SUM(quantity) FROM garment_return_lines x WHERE x.return_id = r.id) AS total_quantity,
            (SELECT COUNT(*) FROM garment_return_lines x WHERE x.return_id = r.id AND x.approved_destination IS NULL) AS undecided
       FROM garment_returns r JOIN musicians m ON m.id = r.musician_id JOIN users u ON u.id = r.received_by
      WHERE ${w.sql} ORDER BY r.received_at DESC LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM garment_returns r JOIN musicians m ON m.id = r.musician_id WHERE ${w.sql}`, ...w.params);
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

export async function returnDetail(db: D1Database, id: string) {
  const r = await first(
    db,
    `SELECT r.*, m.full_name AS musician_name, m.internal_code AS musician_code, u.name AS received_by_name, du.name AS decided_by_name
       FROM garment_returns r JOIN musicians m ON m.id = r.musician_id JOIN users u ON u.id = r.received_by LEFT JOIN users du ON du.id = r.decided_by
      WHERE r.id = ?`,
    id,
  );
  if (!r) notFound('Recolha');
  const lines = await all(
    db,
    `SELECT rl.*, t.name AS item_type_name, t.tracking_mode, s.label AS size_label, g.code AS garment_code, g.status AS garment_status,
            l.name AS location_name, dl2.name AS destination_location_name, pu.name AS proposed_by_name, du.name AS decided_by_name
       FROM garment_return_lines rl JOIN item_types t ON t.id = rl.item_type_id LEFT JOIN item_sizes s ON s.id = rl.size_id
       LEFT JOIN garments g ON g.id = rl.garment_id LEFT JOIN locations l ON l.id = rl.location_id
       LEFT JOIN locations dl2 ON dl2.id = rl.destination_location_id
       LEFT JOIN users pu ON pu.id = rl.proposed_by LEFT JOIN users du ON du.id = rl.decided_by
      WHERE rl.return_id = ? ORDER BY t.sort_order, rl.created_at`,
    id,
  );
  const attachments = await all(
    db,
    `SELECT id, entity_type, entity_id, caption, content_type, uploaded_at FROM attachments
      WHERE deleted_at IS NULL AND ((entity_type = 'return' AND entity_id = ?1) OR (entity_type = 'return_line' AND entity_id IN (SELECT id FROM garment_return_lines WHERE return_id = ?1)))`,
    id,
  );
  return { return: r as Record<string, unknown> & { musician_id: string }, lines, attachments };
}

returnRoutes.get('/:id', requirePerm('read'), async (c) => c.json(await returnDetail(c.env.DB, c.req.param('id'))));

const lineSchema = z.object({
  itemTypeId: z.string().min(1),
  garmentId: zOptId,
  deliveryLineId: zOptId,
  sizeId: zOptId,
  sizeText: zText(20),
  inscription: zText(120),
  legacyCode: zText(60),
  quantity: zQty.default(1),
  observedCondition: z.enum(CONDITIONS),
  locationId: zOptId,
});

returnRoutes.post('/', requirePerm('returns.write'), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      musicianId: z.string().min(1),
      receivedAt: zDate.optional(),
      initialObservations: zText(2000),
      notes: zText(2000),
      lines: z.array(lineSchema).min(1, 'Indique pelo menos um artigo').max(100),
    }),
  );
  const db = c.env.DB;
  const musician = await first<{ id: string; full_name: string }>(db, 'SELECT id, full_name FROM musicians WHERE id = ?', b.musicianId);
  if (!musician) notFound('Músico');
  const returnId = uuid();
  const opId = uuid();
  const now = nowIso();
  const receivedAt = b.receivedAt ? `${b.receivedAt}T12:00:00.000Z` : now;
  const entryDate = b.receivedAt ?? todayIso();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        'INSERT INTO garment_returns (id, musician_id, received_at, received_by, initial_observations, inspection_status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(returnId, b.musicianId, receivedAt, c.get('user').id, b.initialObservations, 'pendente', b.notes, now, now),
  ];
  const insertLine = (l: z.infer<typeof lineSchema>, garmentId: string | null, sizeId: string | null, qty: number) =>
    db
      .prepare(
        `INSERT INTO garment_return_lines (id, return_id, item_type_id, garment_id, size_id, size_text, inscription, quantity, observed_condition, location_id, delivery_line_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(uuid(), returnId, l.itemTypeId, garmentId, sizeId, l.sizeText, l.inscription, qty, l.observedCondition, l.locationId, l.deliveryLineId, now);

  const seen = new Set<string>();
  for (const l of b.lines) {
    const type = await getItemType(db, l.itemTypeId);
    if (!type.stock_enabled) throw new ApiError(422, 'TIPO_SEM_STOCK', `"${type.name}" não é gerido em stock.`);
    const to = { status: 'pendente_inspecao' as Status, condition: l.observedCondition, locationId: l.locationId };
    if (type.tracking_mode === 'individual') {
      if (l.garmentId) {
        if (seen.has(l.garmentId)) throw new ApiError(422, 'PECA_REPETIDA', 'A mesma peça foi indicada mais do que uma vez.');
        seen.add(l.garmentId);
        const g = await getGarment(db, l.garmentId);
        if (g.status !== 'atribuido' || g.holder_musician_id !== b.musicianId) {
          throw new ApiError(409, 'PECA_NAO_ATRIBUIDA', `A peça ${g.code} não está atribuída a este músico.`);
        }
        stmts.push(
          insertLine({ ...l, inscription: l.inscription ?? g.inscription }, g.id, g.size_id, 1),
          movementStmt(
            c,
            {
              operationId: opId,
              type: 'recolha_musico',
              itemTypeId: type.id,
              garmentId: g.id,
              sizeId: g.size_id,
              from: { status: 'atribuido', condition: g.condition, locationId: null },
              to,
              musicianId: b.musicianId,
              refType: 'return',
              refId: returnId,
            },
            now,
          ).stmt,
          db
            .prepare(
              `UPDATE musician_delivery_lines SET returned_quantity = 1
                WHERE garment_id = ? AND status = 'entregue' AND returned_quantity = 0
                  AND delivery_id IN (SELECT id FROM musician_deliveries WHERE musician_id = ?)`,
            )
            .bind(g.id, b.musicianId),
        );
        if (l.inscription && l.inscription !== g.inscription) {
          stmts.push(db.prepare('UPDATE garments SET inscription = ? WHERE id = ?').bind(l.inscription, g.id));
        }
      } else {
        // Peça antiga sem registo: cria-se um registo novo com código próprio.
        if (l.inscription && !type.allows_inscription) throw new ApiError(422, 'SEM_INSCRICAO', `"${type.name}" não admite inscrição.`);
        const sizeId = await assertSize(db, type, l.sizeId);
        if (l.quantity > 50) throw new ApiError(422, 'QUANTIDADE_EXCESSIVA', 'Máximo de 50 peças por linha.');
        for (let i = 0; i < l.quantity; i++) {
          const g = garmentInsertStmt(
            c,
            {
              itemTypeId: type.id,
              sizeId,
              inscription: l.inscription,
              legacyCode: l.legacyCode,
              condition: l.observedCondition,
              origin: 'devolucao_musico',
              originNotes: `Recolhida a ${musician.full_name}`,
              entryDate,
              locationId: l.locationId,
              notes: l.sizeText && !sizeId ? `Tamanho indicado: ${l.sizeText}` : null,
            },
            now,
          );
          stmts.push(
            g.stmt,
            insertLine(l, g.id, sizeId, 1),
            movementStmt(
              c,
              { operationId: opId, type: 'recolha_musico', itemTypeId: type.id, garmentId: g.id, sizeId, to, musicianId: b.musicianId, refType: 'return', refId: returnId },
              now,
            ).stmt,
          );
        }
      }
    } else {
      let sizeId = await assertSize(db, type, l.sizeId);
      let from = null as null | { status: Status; condition: Condition; locationId: null };
      if (l.deliveryLineId) {
        const dl = await first<{ id: string; item_type_id: string; size_id: string | null; condition: Condition; quantity: number; returned_quantity: number; musician_id: string; status: string }>(
          db,
          'SELECT dl.*, d.musician_id FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id WHERE dl.id = ?',
          l.deliveryLineId,
        );
        if (!dl || dl.musician_id !== b.musicianId || dl.item_type_id !== type.id || dl.status !== 'entregue') {
          throw new ApiError(422, 'ENTREGA_INVALIDA', 'A entrega indicada não corresponde a este músico e artigo.');
        }
        sizeId = dl.size_id;
        from = { status: 'atribuido', condition: dl.condition, locationId: null };
        stmts.push(db.prepare('UPDATE musician_delivery_lines SET returned_quantity = returned_quantity + ? WHERE id = ?').bind(l.quantity, dl.id));
      }
      stmts.push(
        insertLine(l, null, sizeId, l.quantity),
        movementStmt(
          c,
          { operationId: opId, type: 'recolha_musico', itemTypeId: type.id, sizeId, quantity: l.quantity, from, to, musicianId: b.musicianId, refType: 'return', refId: returnId },
          now,
        ).stmt,
      );
    }
  }
  stmts.push(auditStmt(c, 'recolha.registar', 'return', returnId, { musico: musician.full_name, linhas: b.lines.length }));
  stmts.push(auditStmt(c, 'recolha.registar', 'musician', b.musicianId, { recolha: returnId }));
  const res = await runMutation(c, stmts, { scope: 'returns.create', response: { id: returnId } });
  return c.json({ ...res.response, replayed: res.replayed }, res.replayed ? 200 : 201);
});

/** Regista o resultado da inspeção e o destino proposto (sem movimentar stock). */
returnRoutes.post('/:id/lines/:lineId/inspect', requirePerm('returns.inspect'), async (c) => {
  const { id, lineId } = c.req.param();
  const b = await parseBody(
    c,
    z.object({ inspectedCondition: z.enum(CONDITIONS), inspectionResult: zText(2000), proposedDestination: z.enum(INSPECTION_DESTINATIONS) }),
  );
  const line = await first<{ approved_destination: string | null }>(c.env.DB, 'SELECT approved_destination FROM garment_return_lines WHERE id = ? AND return_id = ?', lineId, id);
  if (!line) notFound('Linha de recolha');
  if (line.approved_destination) throw new ApiError(409, 'DECISAO_JA_TOMADA', 'O destino desta peça já foi decidido.');
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare(
      'UPDATE garment_return_lines SET inspected_condition = ?, inspection_result = ?, proposed_destination = ?, proposed_by = ?, proposed_at = ? WHERE id = ?',
    ).bind(b.inspectedCondition, b.inspectionResult, b.proposedDestination, c.get('user').id, now, lineId),
    c.env.DB.prepare("UPDATE garment_returns SET inspection_status = 'em_curso', updated_at = ? WHERE id = ? AND inspection_status = 'pendente'").bind(now, id),
    auditStmt(c, 'recolha.inspecionar', 'return', id, { linha: lineId, ...b }),
  ]);
  return c.json({ ok: true });
});

/** Aprova o destino final de uma ou mais linhas e gera os movimentos correspondentes. */
returnRoutes.post('/:id/decisions', requirePerm('returns.inspect'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(
    c,
    z.object({
      decisions: z
        .array(
          z.object({
            lineId: z.string().min(1),
            destination: z.enum(INSPECTION_DESTINATIONS),
            inspectedCondition: z.enum(CONDITIONS).optional(),
            inspectionResult: zText(2000),
            destinationLocationId: zOptId.optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  );
  const db = c.env.DB;
  const ret = await first<{ id: string; musician_id: string }>(db, 'SELECT id, musician_id FROM garment_returns WHERE id = ?', id);
  if (!ret) notFound('Recolha');
  const opId = uuid();
  const now = nowIso();
  const userId = c.get('user').id;
  const stmts: D1PreparedStatement[] = [];
  for (const d of b.decisions) {
    const line = await first<{
      id: string;
      item_type_id: string;
      garment_id: string | null;
      size_id: string | null;
      quantity: number;
      observed_condition: Condition;
      inspected_condition: Condition | null;
      inspection_result: string | null;
      location_id: string | null;
      approved_destination: string | null;
    }>(db, 'SELECT * FROM garment_return_lines WHERE id = ? AND return_id = ?', d.lineId, id);
    if (!line) notFound('Linha de recolha');
    if (line.approved_destination) throw new ApiError(409, 'DECISAO_JA_TOMADA', 'O destino desta peça já foi decidido.');
    const condition = d.inspectedCondition ?? line.inspected_condition ?? line.observed_condition;
    const result = d.inspectionResult ?? line.inspection_result;
    if ((d.destination === 'abatido' || d.destination === 'rejeitado') && !result) {
      throw new ApiError(422, 'MOTIVO_OBRIGATORIO', 'Indique o resultado da inspeção que justifica o abate ou a rejeição.');
    }
    if (d.destination === 'disponivel' && (condition === 'mau' || condition === 'inutilizavel')) {
      throw new ApiError(422, 'CONDICAO_INADEQUADA', 'Uma peça em mau estado ou inutilizável não pode ser reintegrada no stock disponível.');
    }
    const destLoc = d.destinationLocationId === undefined ? line.location_id : d.destinationLocationId;
    let from = { status: 'pendente_inspecao' as Status, condition: line.observed_condition, locationId: line.location_id };
    if (line.garment_id) {
      const g = await getGarment(db, line.garment_id);
      from = { status: g.status, condition: g.condition, locationId: g.location_id };
    }
    stmts.push(
      movementStmt(
        c,
        {
          operationId: opId,
          type: DESTINATION_MOVEMENT[d.destination],
          itemTypeId: line.item_type_id,
          garmentId: line.garment_id,
          sizeId: line.size_id,
          quantity: line.quantity,
          from,
          to: { status: d.destination, condition, locationId: destLoc },
          musicianId: ret.musician_id,
          refType: 'return',
          refId: id,
          reason: result,
        },
        now,
      ).stmt,
      db
        .prepare(
          `UPDATE garment_return_lines SET approved_destination = ?, inspected_condition = ?, inspection_result = ?, destination_location_id = ?,
             decided_by = ?, decided_at = ?, proposed_destination = COALESCE(proposed_destination, ?), proposed_by = COALESCE(proposed_by, ?), proposed_at = COALESCE(proposed_at, ?)
           WHERE id = ? AND approved_destination IS NULL`,
        )
        .bind(d.destination, condition, result, destLoc, userId, now, d.destination, userId, now, line.id),
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE garment_returns SET
           inspection_status = CASE WHEN EXISTS (SELECT 1 FROM garment_return_lines WHERE return_id = ?1 AND approved_destination IS NULL) THEN 'em_curso' ELSE 'concluida' END,
           decided_by = CASE WHEN EXISTS (SELECT 1 FROM garment_return_lines WHERE return_id = ?1 AND approved_destination IS NULL) THEN decided_by ELSE ?2 END,
           decided_at = CASE WHEN EXISTS (SELECT 1 FROM garment_return_lines WHERE return_id = ?1 AND approved_destination IS NULL) THEN decided_at ELSE ?3 END,
           updated_at = ?3
         WHERE id = ?1`,
      )
      .bind(id, userId, now),
    auditStmt(c, 'recolha.decidir_destino', 'return', id, { decisoes: b.decisions.map((d) => ({ linha: d.lineId, destino: d.destination })) }),
  );
  const res = await runMutation(c, stmts, { scope: 'returns.decide', response: { operationId: opId } });
  return c.json(res.response);
});
