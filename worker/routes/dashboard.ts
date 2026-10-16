import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { all, first, parseQuery, todayIso, zDate } from '../lib/core';
import { requirePerm } from '../auth/session';
import { MOVEMENT_SELECT } from './movements';

export const dashboardRoutes = new Hono<AppEnv>();

/** Painel de controlo: todos os indicadores são calculados a partir da base de dados. */
dashboardRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, z.object({ itemTypeId: z.string().optional(), from: zDate.optional(), to: zDate.optional() }));
  const db = c.env.DB;
  const tf = f.itemTypeId ? ' AND item_type_id = ?' : '';
  const tp = f.itemTypeId ? [f.itemTypeId] : [];
  const byStatus = await all<{ status: string; q: number }>(
    db,
    `SELECT status, SUM(q) AS q FROM (
       SELECT status, 1 AS q FROM garments WHERE status IS NOT NULL${tf}
       UNION ALL SELECT status, quantity FROM stock_balances WHERE quantity > 0${tf}
     ) GROUP BY status`,
    ...tp,
    ...tp,
  );
  const availableByCategory = await all(
    db,
    `SELECT t.category, t.name AS item_type_name, t.id AS item_type_id, t.min_available,
            (SELECT COUNT(*) FROM garments g WHERE g.item_type_id = t.id AND g.status = 'disponivel')
          + COALESCE((SELECT SUM(b.quantity) FROM stock_balances b WHERE b.item_type_id = t.id AND b.status = 'disponivel'), 0) AS available
       FROM item_types t WHERE t.stock_enabled = 1 AND t.active = 1 ${f.itemTypeId ? 'AND t.id = ?' : ''} ORDER BY t.sort_order`,
    ...tp,
  );
  const today = todayIso();
  const mvWhere: string[] = ['1=1'];
  const mvParams: unknown[] = [];
  if (f.itemTypeId) (mvWhere.push('m.item_type_id = ?'), mvParams.push(f.itemTypeId));
  if (f.from) (mvWhere.push('m.created_at >= ?'), mvParams.push(f.from));
  if (f.to) (mvWhere.push('m.created_at <= ?'), mvParams.push(`${f.to}T23:59:59.999Z`));
  const counts = await first<Record<string, number>>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM garments WHERE status IS NOT NULL AND status NOT IN ('abatido', 'extraviado', 'rejeitado')${tf}) AS garments_total,
       (SELECT COALESCE(SUM(MAX(v.quantity_requested - v.quantity_delivered, 0)), 0) FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id
         WHERE v.status = 'ativa' AND t.procurement_enabled = 1${f.itemTypeId ? ' AND v.item_type_id = ?' : ''}) AS needs_open,
       (SELECT COUNT(DISTINCT v.musician_id) FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id
         WHERE v.status = 'ativa' AND t.procurement_enabled = 1 AND v.quantity_delivered > 0 AND v.quantity_delivered < v.quantity_requested) AS musicians_incomplete,
       (SELECT COUNT(DISTINCT v.musician_id) FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id
         WHERE v.status = 'ativa' AND t.procurement_enabled = 1 AND v.quantity_delivered < v.quantity_requested) AS musicians_pending,
       (SELECT COUNT(*) FROM musician_item_requests r JOIN item_types t ON t.id = r.item_type_id WHERE t.procurement_enabled = 0 AND r.status IN ('por_avaliar', 'confirmada')) AS shoes_open,
       (SELECT COUNT(*) FROM garment_returns WHERE inspection_status != 'concluida') AS returns_uninspected,
       (SELECT COUNT(*) FROM loans lo WHERE lo.due_date < ? AND EXISTS (SELECT 1 FROM v_loan_lines v WHERE v.loan_id = lo.id AND v.pending_quantity > 0)) AS loans_overdue,
       (SELECT COALESCE(SUM(pending_quantity), 0) FROM v_loan_lines) AS loan_pending_qty,
       (SELECT COUNT(*) FROM festival_campaigns WHERE status IN ('planeada', 'ativa')) AS campaigns_active,
       (SELECT COUNT(*) FROM events WHERE status IN ('planeada', 'ativa')) AS events_active`,
    ...tp,
    ...(f.itemTypeId ? [f.itemTypeId] : []),
    today,
  );
  const recent = await all(db, `${MOVEMENT_SELECT} WHERE ${mvWhere.join(' AND ')} ORDER BY m.seq DESC LIMIT 15`, ...mvParams);
  const activeEvents = await all(
    db,
    `SELECT e.id, e.name, e.start_date, e.end_date, e.status, fc.name AS campaign_name,
            COALESCE((SELECT SUM(v.pending_quantity) FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id WHERE lo.event_id = e.id), 0) AS pending
       FROM events e LEFT JOIN festival_campaigns fc ON fc.id = e.campaign_id WHERE e.status IN ('planeada', 'ativa') ORDER BY e.start_date LIMIT 10`,
  );
  return c.json({ byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.q])), availableByCategory, counts, recent, activeEvents });
});

// ---------------------------------------------------------------------------
// Alertas e pendências
// ---------------------------------------------------------------------------
export interface Alert {
  kind: string;
  severity: 'alta' | 'media' | 'baixa';
  title: string;
  detail: string;
  link: string;
  date?: string | null;
}

export async function computeAlerts(db: D1Database): Promise<Alert[]> {
  const today = todayIso();
  const alerts: Alert[] = [];
  const overdue = await all<{ id: string; musician_name: string; event_name: string; due_date: string; pending: number }>(
    db,
    `SELECT lo.id, mu.full_name AS musician_name, e.name AS event_name, lo.due_date, SUM(v.pending_quantity) AS pending
       FROM loans lo JOIN musicians mu ON mu.id = lo.musician_id JOIN events e ON e.id = lo.event_id JOIN v_loan_lines v ON v.loan_id = lo.id
      WHERE lo.due_date IS NOT NULL AND lo.due_date < ? GROUP BY lo.id HAVING SUM(v.pending_quantity) > 0 ORDER BY lo.due_date`,
    today,
  );
  for (const l of overdue) {
    alerts.push({ kind: 'emprestimo_atrasado', severity: 'alta', title: `Empréstimo fora do prazo — ${l.musician_name}`, detail: `${l.pending} peça(s) por devolver da festa "${l.event_name}". Prazo: ${l.due_date}.`, link: `/emprestimos/${l.id}`, date: l.due_date });
  }
  const open = await all<{ id: string; musician_name: string; event_name: string; due_date: string | null; pending: number }>(
    db,
    `SELECT lo.id, mu.full_name AS musician_name, e.name AS event_name, lo.due_date, SUM(v.pending_quantity) AS pending
       FROM loans lo JOIN musicians mu ON mu.id = lo.musician_id JOIN events e ON e.id = lo.event_id JOIN v_loan_lines v ON v.loan_id = lo.id
      WHERE lo.due_date IS NULL OR lo.due_date >= ? GROUP BY lo.id HAVING SUM(v.pending_quantity) > 0 ORDER BY lo.delivered_at`,
    today,
  );
  for (const l of open) {
    alerts.push({ kind: 'emprestimo_pendente', severity: 'baixa', title: `Material emprestado — ${l.musician_name}`, detail: `${l.pending} peça(s) ainda não devolvida(s) (${l.event_name}).`, link: `/emprestimos/${l.id}`, date: l.due_date });
  }
  const returns = await all<{ id: string; musician_name: string; received_at: string; n: number }>(
    db,
    `SELECT r.id, mu.full_name AS musician_name, r.received_at, (SELECT COUNT(*) FROM garment_return_lines x WHERE x.return_id = r.id AND x.approved_destination IS NULL) AS n
       FROM garment_returns r JOIN musicians mu ON mu.id = r.musician_id WHERE r.inspection_status != 'concluida' ORDER BY r.received_at`,
  );
  for (const r of returns) {
    const days = Math.floor((Date.now() - Date.parse(r.received_at)) / 86400000);
    alerts.push({ kind: 'recolha_por_inspecionar', severity: days > 14 ? 'alta' : 'media', title: `Recolha por inspecionar — ${r.musician_name}`, detail: `${r.n} linha(s) sem destino decidido (recebida há ${days} dia(s)).`, link: `/recolhas/${r.id}`, date: r.received_at.slice(0, 10) });
  }
  const pendingInspection = await all<{ item_type_name: string; q: number }>(
    db,
    `SELECT t.name AS item_type_name, SUM(q) AS q FROM (
        SELECT item_type_id, 1 AS q FROM garments g WHERE g.status = 'pendente_inspecao'
          AND NOT EXISTS (SELECT 1 FROM garment_return_lines rl WHERE rl.garment_id = g.id AND rl.approved_destination IS NULL)
        UNION ALL SELECT item_type_id, quantity FROM stock_balances WHERE status = 'pendente_inspecao' AND quantity > 0
     ) x JOIN item_types t ON t.id = x.item_type_id GROUP BY t.id`,
  );
  for (const p of pendingInspection) {
    alerts.push({ kind: 'pendente_inspecao', severity: 'media', title: `Peças pendentes de inspeção — ${p.item_type_name}`, detail: `${p.q} unidade(s) em inventário a aguardar inspeção (incluindo devoluções de empréstimos).`, link: '/inventario?status=pendente_inspecao' });
  }
  for (const [status, label, sev] of [
    ['quarentena', 'em quarentena', 'media'],
    ['reparacao', 'em reparação', 'baixa'],
  ] as const) {
    const rows = await all<{ item_type_name: string; q: number }>(
      db,
      `SELECT t.name AS item_type_name, SUM(q) AS q FROM (
          SELECT item_type_id, 1 AS q FROM garments WHERE status = ?1
          UNION ALL SELECT item_type_id, quantity FROM stock_balances WHERE status = ?1 AND quantity > 0
       ) x JOIN item_types t ON t.id = x.item_type_id GROUP BY t.id`,
      status,
    );
    for (const r of rows) alerts.push({ kind: status, severity: sev, title: `Artigos ${label} — ${r.item_type_name}`, detail: `${r.q} unidade(s) ${label}.`, link: `/inventario?status=${status}` });
  }
  const incomplete = await all<{ id: string; full_name: string; missing: number; delivered: number }>(
    db,
    `SELECT m.id, m.full_name, SUM(MAX(v.quantity_requested - v.quantity_delivered, 0)) AS missing, SUM(v.quantity_delivered) AS delivered
       FROM v_request_progress v JOIN musicians m ON m.id = v.musician_id JOIN item_types t ON t.id = v.item_type_id
      WHERE v.status = 'ativa' AND t.procurement_enabled = 1 GROUP BY m.id HAVING delivered > 0 AND missing > 0 ORDER BY m.full_name`,
  );
  for (const m of incomplete) {
    alerts.push({ kind: 'entrega_incompleta', severity: 'media', title: `Entrega incompleta — ${m.full_name}`, detail: `Faltam entregar ${m.missing} peça(s).`, link: `/musicos/${m.id}` });
  }
  const toReturn = await all<{ id: string; full_name: string; expected: number; returned: number }>(
    db,
    `SELECT m.id, m.full_name,
            (SELECT SUM(r.return_expected) FROM musician_item_requests r WHERE r.musician_id = m.id AND r.status != 'cancelada') AS expected,
            COALESCE((SELECT SUM(x.returned_quantity) FROM v_musician_returns x WHERE x.musician_id = m.id), 0) AS returned
       FROM musicians m WHERE EXISTS (SELECT 1 FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id WHERE d.musician_id = m.id AND dl.status = 'entregue')`,
  );
  for (const m of toReturn.filter((x) => (x.expected ?? 0) > x.returned)) {
    alerts.push({ kind: 'devolucao_antiga_em_falta', severity: 'media', title: `Fardamento antigo por devolver — ${m.full_name}`, detail: `Recebeu fardamento novo; faltam devolver ${m.expected - m.returned} peça(s) antiga(s).`, link: `/musicos/${m.id}` });
  }
  const counts = await all<{ id: string; name: string; created_at: string }>(db, "SELECT id, name, created_at FROM inventory_counts WHERE status = 'em_curso'");
  for (const ic of counts) {
    alerts.push({ kind: 'contagem_em_curso', severity: 'baixa', title: `Contagem de inventário em curso — ${ic.name}`, detail: 'Existem diferenças por confirmar ou contagem por concluir.', link: `/inventario/contagens/${ic.id}`, date: ic.created_at.slice(0, 10) });
  }
  const low = await all<{ id: string; name: string; min_available: number; available: number }>(
    db,
    `SELECT t.id, t.name, t.min_available,
            (SELECT COUNT(*) FROM garments g WHERE g.item_type_id = t.id AND g.status = 'disponivel')
          + COALESCE((SELECT SUM(b.quantity) FROM stock_balances b WHERE b.item_type_id = t.id AND b.status = 'disponivel'), 0) AS available
       FROM item_types t WHERE t.min_available IS NOT NULL AND t.active = 1 AND t.stock_enabled = 1`,
  );
  for (const t of low.filter((x) => x.available < x.min_available)) {
    alerts.push({ kind: 'stock_minimo', severity: 'media', title: `Stock abaixo do mínimo — ${t.name}`, detail: `Disponível: ${t.available} (mínimo configurado: ${t.min_available}).`, link: `/inventario?itemTypeId=${t.id}` });
  }
  const incidents = await all<{ id: string; kind: string; description: string; occurred_at: string; garment_id: string | null; loan_id: string | null }>(
    db,
    'SELECT id, kind, description, occurred_at, garment_id, loan_id FROM incidents WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT 50',
  );
  for (const i of incidents) {
    alerts.push({ kind: 'ocorrencia', severity: 'baixa', title: `Ocorrência por resolver (${i.kind})`, detail: i.description, link: i.loan_id ? `/emprestimos/${i.loan_id}` : i.garment_id ? `/inventario/pecas/${i.garment_id}` : '/inventario', date: i.occurred_at.slice(0, 10) });
  }
  const order = { alta: 0, media: 1, baixa: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

dashboardRoutes.get('/alerts', requirePerm('read'), async (c) => {
  const items = await computeAlerts(c.env.DB);
  return c.json({ items });
});
