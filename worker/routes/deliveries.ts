import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, likeTerm, notFound, nowIso, pageQuery, paging, parseBody, parseQuery, runBatch, runMutation, uuid, zDate, zOptId, zOptKey, zQty, zText, type Ctx } from '../lib/core';
import { requirePerm } from '../auth/session';
import { assertSize, garmentInsertStmt, getBalance, getGarment, getItemType, movementStmt, reverseOperationStmts } from '../services/stock';
import { CONDITIONS } from '../../shared/domain';

export const deliveryRoutes = new Hono<AppEnv>();

export const deliveryFilters = pageQuery.extend({
  musicianId: z.string().optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  itemTypeId: z.string().optional(),
});

export function deliveryWhere(f: z.infer<typeof deliveryFilters>) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.musicianId) (where.push('d.musician_id = ?'), params.push(f.musicianId));
  if (f.from) (where.push('d.delivered_at >= ?'), params.push(f.from));
  if (f.to) (where.push('d.delivered_at <= ?'), params.push(`${f.to}T23:59:59.999Z`));
  if (f.itemTypeId) (where.push('EXISTS (SELECT 1 FROM musician_delivery_lines x WHERE x.delivery_id = d.id AND x.item_type_id = ?)'), params.push(f.itemTypeId));
  if (f.q) (where.push("m.full_name LIKE ? ESCAPE '\\'"), params.push(likeTerm(f.q)));
  return { sql: where.join(' AND '), params };
}

deliveryRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, deliveryFilters);
  const w = deliveryWhere(f);
  const { limit, offset } = paging(f);
  const items = await all(
    c.env.DB,
    `SELECT d.*, m.full_name AS musician_name, u.name AS delivered_by_name,
            (SELECT SUM(quantity) FROM musician_delivery_lines x WHERE x.delivery_id = d.id AND x.status = 'entregue') AS total_quantity,
            (SELECT COUNT(*) FROM musician_delivery_lines x WHERE x.delivery_id = d.id) AS line_count
       FROM musician_deliveries d JOIN musicians m ON m.id = d.musician_id JOIN users u ON u.id = d.delivered_by
      WHERE ${w.sql} ORDER BY d.delivered_at DESC, d.created_at DESC LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM musician_deliveries d JOIN musicians m ON m.id = d.musician_id WHERE ${w.sql}`, ...w.params);
  return c.json({ items, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize });
});

export async function deliveryDetail(db: D1Database, id: string) {
  const d = await first(
    db,
    `SELECT d.*, m.full_name AS musician_name, m.internal_code AS musician_code, u.name AS delivered_by_name
       FROM musician_deliveries d JOIN musicians m ON m.id = d.musician_id JOIN users u ON u.id = d.delivered_by WHERE d.id = ?`,
    id,
  );
  if (!d) notFound('Entrega');
  const lines = await all(
    db,
    `SELECT dl.*, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, g.inscription, l.name AS from_location_name
       FROM musician_delivery_lines dl JOIN item_types t ON t.id = dl.item_type_id LEFT JOIN item_sizes s ON s.id = dl.size_id
       LEFT JOIN garments g ON g.id = dl.garment_id LEFT JOIN locations l ON l.id = dl.from_location_id
      WHERE dl.delivery_id = ? ORDER BY t.sort_order, s.sort_order`,
    id,
  );
  return { delivery: d as Record<string, unknown> & { musician_id: string }, lines };
}

deliveryRoutes.get('/:id', requirePerm('read'), async (c) => {
  return c.json(await deliveryDetail(c.env.DB, c.req.param('id')));
});

const lineSchema = z
  .object({
    itemTypeId: z.string().min(1),
    garmentId: zOptId,
    bucketKey: zOptKey,
    quantity: zQty.default(1),
    requestId: zOptId,
  })
  .refine((l) => Boolean(l.garmentId) !== Boolean(l.bucketKey), 'Indique a peça (código) ou o lote de stock');

const deliverySchema = z.object({
  musicianId: z.string().min(1),
  deliveredAt: zDate.optional(),
  receivedByName: zText(160),
  notes: zText(2000),
  lines: z.array(lineSchema).min(1, 'Indique pelo menos um artigo').max(100),
});

deliveryRoutes.post('/', requirePerm('deliveries.write'), async (c) => {
  const b = await parseBody(c, deliverySchema);
  const db = c.env.DB;
  const musician = await first<{ id: string; full_name: string; status: string }>(db, 'SELECT id, full_name, status FROM musicians WHERE id = ?', b.musicianId);
  if (!musician) notFound('Músico');
  if (musician.status === 'arquivado') throw new ApiError(409, 'MUSICO_ARQUIVADO', 'Não é possível entregar fardamento a um músico arquivado.');
  const deliveryId = uuid();
  const opId = uuid();
  const now = nowIso();
  const deliveredAt = b.deliveredAt ? `${b.deliveredAt}T12:00:00.000Z` : now;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO musician_deliveries (id, musician_id, delivered_at, delivered_by, status, received_by_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(deliveryId, b.musicianId, deliveredAt, c.get('user').id, 'concluida', b.receivedByName, b.notes, now),
  ];
  const seenGarments = new Set<string>();
  for (const l of b.lines) {
    const type = await getItemType(db, l.itemTypeId);
    const lineId = uuid();
    if (l.garmentId) {
      if (seenGarments.has(l.garmentId)) throw new ApiError(422, 'PECA_REPETIDA', 'A mesma peça foi indicada mais do que uma vez.');
      seenGarments.add(l.garmentId);
      const g = await getGarment(db, l.garmentId);
      if (g.item_type_id !== type.id) throw new ApiError(422, 'TIPO_INCOERENTE', 'O tipo de artigo não corresponde à peça indicada.');
      if (g.status !== 'disponivel') throw new ApiError(409, 'PECA_INDISPONIVEL', `A peça ${g.code} não está disponível.`);
      stmts.push(
        db
          .prepare(
            'INSERT INTO musician_delivery_lines (id, delivery_id, item_type_id, garment_id, size_id, condition, from_location_id, quantity, request_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
          )
          .bind(lineId, deliveryId, type.id, g.id, g.size_id, g.condition, g.location_id, l.requestId, 'entregue', now),
        movementStmt(
          c,
          {
            operationId: opId,
            type: 'entrega_musico',
            itemTypeId: type.id,
            garmentId: g.id,
            sizeId: g.size_id,
            from: { status: 'disponivel', condition: g.condition, locationId: g.location_id },
            to: { status: 'atribuido', condition: g.condition, locationId: null },
            musicianId: b.musicianId,
            refType: 'delivery',
            refId: deliveryId,
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
            'INSERT INTO musician_delivery_lines (id, delivery_id, item_type_id, garment_id, size_id, condition, from_location_id, quantity, request_id, status, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(lineId, deliveryId, type.id, bal.size_id, bal.condition, bal.location_id, l.quantity, l.requestId, 'entregue', now),
        movementStmt(
          c,
          {
            operationId: opId,
            type: 'entrega_musico',
            itemTypeId: type.id,
            sizeId: bal.size_id,
            quantity: l.quantity,
            from: { status: 'disponivel', condition: bal.condition, locationId: bal.location_id },
            to: { status: 'atribuido', condition: bal.condition, locationId: null },
            musicianId: b.musicianId,
            refType: 'delivery',
            refId: deliveryId,
          },
          now,
        ).stmt,
      );
    }
  }
  stmts.push(auditStmt(c, 'entrega.registar', 'delivery', deliveryId, { musico: musician.full_name, linhas: b.lines.length }));
  stmts.push(auditStmt(c, 'entrega.registar', 'musician', b.musicianId, { entrega: deliveryId }));
  const res = await runMutation(c, stmts, { scope: 'deliveries.create', response: { id: deliveryId } });
  return c.json({ ...res.response, replayed: res.replayed }, res.replayed ? 200 : 201);
});

interface DeliveryLineRow {
  id: string;
  delivery_id: string;
  item_type_id: string;
  garment_id: string | null;
  size_id: string | null;
  condition: string;
  from_location_id: string | null;
  quantity: number;
  status: string;
  returned_quantity: number;
  musician_id: string;
}

/** Instruções que anulam uma linha de entrega: a peça regressa ao stock disponível. */
async function cancelLineStmts(c: Ctx, line: DeliveryLineRow, reason: string, opId: string, now: string) {
  if (line.status !== 'entregue' || line.returned_quantity > 0) throw new ApiError(409, 'LINHA_NAO_ANULAVEL', 'Esta linha já foi anulada ou tem devoluções registadas.');
  let condition = line.condition;
  if (line.garment_id) {
    const g = await getGarment(c.env.DB, line.garment_id);
    if (g.status !== 'atribuido' || g.holder_musician_id !== line.musician_id) throw new ApiError(409, 'PECA_ALTERADA', `A peça ${g.code} já não está atribuída a este músico.`);
    condition = g.condition;
  }
  return [
    c.env.DB.prepare("UPDATE musician_delivery_lines SET status = 'anulada', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status = 'entregue'").bind(now, c.get('user').id, line.id),
    movementStmt(
      c,
      {
        operationId: opId,
        type: 'anulacao_entrega',
        itemTypeId: line.item_type_id,
        garmentId: line.garment_id,
        sizeId: line.size_id,
        quantity: line.quantity,
        from: { status: 'atribuido', condition: condition as never, locationId: null },
        to: { status: 'disponivel', condition: condition as never, locationId: line.from_location_id },
        musicianId: line.musician_id,
        refType: 'delivery',
        refId: line.delivery_id,
        reason,
      },
      now,
    ).stmt,
  ];
}

const LINE_SELECT = 'SELECT dl.*, d.musician_id, d.kind FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id';

/** Anula uma linha de entrega registada por engano. */
deliveryRoutes.post('/lines/:lineId/cancel', requirePerm('deliveries.write'), async (c) => {
  const lineId = c.req.param('lineId');
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3, 'Indique o motivo').max(500) }));
  const line = await first<DeliveryLineRow & { kind: string }>(c.env.DB, `${LINE_SELECT} WHERE dl.id = ?`, lineId);
  if (!line) notFound('Linha de entrega');
  if (line.kind === 'existente') throw new ApiError(409, 'REGISTO_EXISTENTE', 'Este registo é de fardamento que o músico já tinha. Para o corrigir, anule o registo completo.');
  const now = nowIso();
  const stmts = [...(await cancelLineStmts(c, line, b.reason, uuid(), now)), auditStmt(c, 'entrega.anular_linha', 'delivery', line.delivery_id, { linha: lineId, motivo: b.reason })];
  const res = await runMutation(c, stmts, { scope: 'deliveries.cancel_line', response: { ok: true } });
  return c.json(res.response);
});

/** Anula a entrega completa (registada por engano): todas as peças regressam ao stock disponível. */
deliveryRoutes.post('/:id/cancel', requirePerm('deliveries.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3, 'Indique o motivo').max(500) }));
  const d = await first<{ status: string; musician_id: string; kind: string }>(c.env.DB, 'SELECT status, musician_id, kind FROM musician_deliveries WHERE id = ?', id);
  if (!d) notFound('Entrega');
  if (d.status === 'anulada') throw new ApiError(409, 'JA_ANULADA', 'Esta entrega já foi anulada.');
  const lines = await all<DeliveryLineRow>(c.env.DB, `${LINE_SELECT} WHERE dl.delivery_id = ?`, id);
  if (lines.some((l) => l.status === 'entregue' && l.returned_quantity > 0)) {
    throw new ApiError(409, 'COM_DEVOLUCOES', 'Há peças desta entrega que já foram devolvidas. Anule apenas as linhas sem devolução.');
  }
  const opId = uuid();
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (d.kind === 'existente') {
    // Registo de fardamento já na posse do músico: as peças registadas deixam o inventário (ficam «Rejeitadas»).
    stmts.push(
      ...(await reverseOperationStmts(c, 'delivery', id, ['stock_inicial'], `Registo anulado: ${b.reason}`, now)),
      c.env.DB.prepare("UPDATE musician_delivery_lines SET status = 'anulada', cancelled_at = ?, cancelled_by = ? WHERE delivery_id = ? AND status = 'entregue'").bind(now, c.get('user').id, id),
    );
  } else {
    for (const l of lines.filter((x) => x.status === 'entregue')) stmts.push(...(await cancelLineStmts(c, l, b.reason, opId, now)));
  }
  stmts.push(
    c.env.DB.prepare("UPDATE musician_deliveries SET status = 'anulada', notes = COALESCE(notes || char(10), '') || ? WHERE id = ?").bind(`Anulada: ${b.reason}`, id),
    auditStmt(c, 'entrega.anular', 'delivery', id, { motivo: b.reason, linhas: lines.length }),
    auditStmt(c, 'entrega.anular', 'musician', d.musician_id, { entrega: id, motivo: b.reason }),
  );
  const res = await runMutation(c, stmts, { scope: 'deliveries.cancel', response: { ok: true } });
  return c.json(res.response);
});

deliveryRoutes.post('/:id/confirm-receipt', requirePerm('deliveries.write'), async (c) => {
  const id = c.req.param('id');
  const b = await parseBody(c, z.object({ receivedByName: zText(160) }));
  const d = await first(c.env.DB, 'SELECT id FROM musician_deliveries WHERE id = ?', id);
  if (!d) notFound('Entrega');
  const now = nowIso();
  await runBatch(c.env.DB, [
    c.env.DB.prepare("UPDATE musician_delivery_lines SET receipt_confirmed = 1, receipt_confirmed_at = ? WHERE delivery_id = ? AND status = 'entregue' AND receipt_confirmed = 0").bind(now, id),
    c.env.DB.prepare('UPDATE musician_deliveries SET received_by_name = COALESCE(?, received_by_name) WHERE id = ?').bind(b.receivedByName, id),
    auditStmt(c, 'entrega.confirmar_rececao', 'delivery', id, { recebido_por: b.receivedByName }),
  ]);
  return c.json({ ok: true });
});


/**
 * Regista fardamento que o músico JÁ TEM em sua posse (anterior à aplicação).
 * As peças entram no inventário diretamente como «Atribuídas» a esse músico, com código próprio;
 * não saem do stock disponível. Opcionalmente contam para o pedido de fardamento.
 */
deliveryRoutes.post('/existing', requirePerm('deliveries.write'), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      musicianId: z.string().min(1),
      date: zDate.optional(),
      notes: zText(2000),
      items: z
        .array(
          z.object({
            itemTypeId: z.string().min(1),
            sizeId: zOptId,
            condition: z.enum(CONDITIONS),
            quantity: zQty,
            inscriptions: z.array(z.string().trim().max(120)).max(50).optional(),
            requestId: zOptId,
            notes: zText(500),
          }),
        )
        .min(1, 'Indique pelo menos um artigo')
        .max(50),
    }),
  );
  const db = c.env.DB;
  const musician = await first<{ id: string; full_name: string; status: string }>(db, 'SELECT id, full_name, status FROM musicians WHERE id = ?', b.musicianId);
  if (!musician) notFound('Músico');
  const deliveryId = uuid();
  const opId = uuid();
  const now = nowIso();
  const date = b.date ?? now.slice(0, 10);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO musician_deliveries (id, musician_id, delivered_at, delivered_by, status, kind, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(deliveryId, b.musicianId, `${date}T12:00:00.000Z`, c.get('user').id, 'concluida', 'existente', b.notes ?? 'Fardamento que o músico já tinha em sua posse', now),
  ];
  const garmentIds: string[] = [];
  for (const it of b.items) {
    const type = await getItemType(db, it.itemTypeId);
    if (!type.stock_enabled) throw new ApiError(422, 'TIPO_SEM_STOCK', `"${type.name}" não é gerido em inventário.`);
    const sizeId = await assertSize(db, type, it.sizeId);
    if (it.inscriptions?.some(Boolean) && !type.allows_inscription) throw new ApiError(422, 'SEM_INSCRICAO', `"${type.name}" não admite inscrição.`);
    const to = { status: 'atribuido' as const, condition: it.condition, locationId: null };
    if (type.tracking_mode === 'individual') {
      if (it.quantity > 50) throw new ApiError(422, 'QUANTIDADE_EXCESSIVA', 'Máximo de 50 peças por artigo.');
      for (let i = 0; i < it.quantity; i++) {
        const g = garmentInsertStmt(
          c,
          {
            itemTypeId: type.id,
            sizeId,
            inscription: it.inscriptions?.[i] || null,
            condition: it.condition,
            origin: 'outra',
            originNotes: `Já na posse de ${musician.full_name} (registo inicial)`,
            entryDate: date,
            locationId: null,
            notes: it.notes,
          },
          now,
        );
        garmentIds.push(g.id);
        stmts.push(
          g.stmt,
          movementStmt(
            c,
            { operationId: opId, type: 'stock_inicial', itemTypeId: type.id, garmentId: g.id, sizeId, to, musicianId: b.musicianId, refType: 'delivery', refId: deliveryId, reason: 'Fardamento já na posse do músico' },
            now,
          ).stmt,
          db
            .prepare(
              'INSERT INTO musician_delivery_lines (id, delivery_id, item_type_id, garment_id, size_id, condition, from_location_id, quantity, request_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)',
            )
            .bind(uuid(), deliveryId, type.id, g.id, sizeId, it.condition, it.requestId, 'entregue', now),
        );
      }
    } else {
      stmts.push(
        movementStmt(
          c,
          { operationId: opId, type: 'stock_inicial', itemTypeId: type.id, sizeId, quantity: it.quantity, to, musicianId: b.musicianId, refType: 'delivery', refId: deliveryId, reason: 'Fardamento já na posse do músico' },
          now,
        ).stmt,
        db
          .prepare(
            'INSERT INTO musician_delivery_lines (id, delivery_id, item_type_id, garment_id, size_id, condition, from_location_id, quantity, request_id, status, created_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)',
          )
          .bind(uuid(), deliveryId, type.id, sizeId, it.condition, it.quantity, it.requestId, 'entregue', now),
      );
    }
  }
  stmts.push(
    auditStmt(c, 'musico.fardamento_existente', 'musician', b.musicianId, { registo: deliveryId, artigos: b.items.map((i) => ({ tipo: i.itemTypeId, tamanho: i.sizeId, quantidade: i.quantity })) }),
    auditStmt(c, 'entrega.registo_existente', 'delivery', deliveryId, { musico: musician.full_name }),
  );
  const res = await runMutation(c, stmts, { scope: 'deliveries.existing', response: { id: deliveryId, garmentIds } });
  const codes = res.response.garmentIds.length
    ? await all<{ id: string; code: string }>(db, `SELECT id, code FROM garments WHERE id IN (${res.response.garmentIds.map(() => '?').join(',')}) ORDER BY serial`, ...res.response.garmentIds)
    : [];
  return c.json({ ...res.response, garments: codes, replayed: res.replayed }, res.replayed ? 200 : 201);
});
