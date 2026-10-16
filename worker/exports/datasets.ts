// Conjuntos de dados exportáveis (CSV/XLSX/PDF), sempre calculados a partir da base de dados.
import { z } from 'zod';
import {
  CONDITION_LABELS,
  MOVEMENT_LABELS,
  MUSICIAN_KIND_LABELS,
  MUSICIAN_STATUS_LABELS,
  ORIGIN_LABELS,
  REQUEST_PROGRESS_LABELS,
  REQUEST_STATUS_LABELS,
  STATUS_LABELS,
  STATUSES,
  VERIFICATION_LABELS,
  DESTINATION_LABELS,
} from '../../shared/domain';
import { all, todayIso } from '../lib/core';
import { listMusicians, musicianFilters } from '../routes/musicians';
import { REQUEST_SELECT, requestFilters, requestWhere, withProgress } from '../routes/requests';
import { movementFilters, movementWhere, MOVEMENT_SELECT } from '../routes/movements';
import { summaryRows } from '../routes/inventory';
import type { Column, Dataset } from './format';

const S = STATUS_LABELS as Record<string, string>;
const C = CONDITION_LABELS as Record<string, string>;

export const DATASET_KEYS = [
  'inventario',
  'stock-disponivel',
  'stock-tipo-tamanho',
  'musicos',
  'necessidades',
  'entregas',
  'recolhas',
  'movimentos',
  'emprestimos',
  'pendencias',
] as const;
export type DatasetKey = (typeof DATASET_KEYS)[number];

export const DATASET_TITLES: Record<DatasetKey, string> = {
  inventario: 'Inventário geral',
  'stock-disponivel': 'Stock disponível',
  'stock-tipo-tamanho': 'Stock por tipo e tamanho',
  musicos: 'Fichas de músicos',
  necessidades: 'Necessidades de fardamento',
  entregas: 'Entregas de fardamento',
  recolhas: 'Recolhas e inspeções',
  movimentos: 'Movimentos de stock',
  emprestimos: 'Empréstimos por festa',
  pendencias: 'Pendências de devolução',
};

const exportFilters = z.object({
  itemTypeId: z.string().optional(),
  sizeId: z.string().optional(),
  status: z.string().optional(),
  condition: z.string().optional(),
  locationId: z.string().optional(),
  musicianId: z.string().optional(),
  eventId: z.string().optional(),
  campaignId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().max(100).optional(),
  kind: z.string().optional(),
  type: z.string().optional(),
  pendingOnly: z.string().optional(),
});
export type ExportFilters = z.infer<typeof exportFilters>;
export function parseExportFilters(q: Record<string, string>): ExportFilters {
  const r = exportFilters.safeParse(q);
  return r.success ? r.data : {};
}

/** Descrição legível dos filtros aplicados (com nomes resolvidos). */
export async function describeFilters(db: D1Database, f: ExportFilters): Promise<string[]> {
  const out: string[] = [];
  const name = async (table: string, col: string, id?: string) =>
    id ? ((await db.prepare(`SELECT ${col} AS n FROM ${table} WHERE id = ?`).bind(id).first<{ n: string }>())?.n ?? id) : null;
  if (f.itemTypeId) out.push(`Tipo: ${await name('item_types', 'name', f.itemTypeId)}`);
  if (f.sizeId) out.push(`Tamanho: ${await name('item_sizes', 'label', f.sizeId)}`);
  if (f.status) out.push(`Estado: ${f.status.split(',').map((s) => S[s] ?? s).join(', ')}`);
  if (f.condition) out.push(`Conservação: ${C[f.condition] ?? f.condition}`);
  if (f.locationId) out.push(`Localização: ${await name('locations', 'name', f.locationId)}`);
  if (f.musicianId) out.push(`Músico: ${await name('musicians', 'full_name', f.musicianId)}`);
  if (f.eventId) out.push(`Festa: ${await name('events', 'name', f.eventId)}`);
  if (f.campaignId) out.push(`Campanha: ${await name('festival_campaigns', 'name', f.campaignId)}`);
  if (f.from) out.push(`Desde: ${f.from}`);
  if (f.to) out.push(`Até: ${f.to}`);
  if (f.q) out.push(`Pesquisa: "${f.q}"`);
  if (f.type) out.push(`Movimento: ${f.type.split(',').map((t) => (MOVEMENT_LABELS as Record<string, string>)[t] ?? t).join(', ')}`);
  if (f.pendingOnly === '1') out.push('Apenas pendentes');
  return out;
}

const statusIn = (s: string | undefined) => (s ?? '').split(',').filter((x) => (STATUSES as readonly string[]).includes(x));

async function inventoryRows(db: D1Database, f: ExportFilters, forceStatus?: string[]) {
  const statuses = forceStatus ?? statusIn(f.status);
  const gw: string[] = ['g.status IS NOT NULL'];
  const bw: string[] = ['b.quantity > 0'];
  const gp: unknown[] = [];
  const bp: unknown[] = [];
  const both = (col: string, v: unknown) => {
    gw.push(`g.${col} = ?`);
    bw.push(`b.${col} = ?`);
    gp.push(v);
    bp.push(v);
  };
  if (f.itemTypeId) both('item_type_id', f.itemTypeId);
  if (f.sizeId) both('size_id', f.sizeId);
  if (f.condition) both('condition', f.condition);
  if (f.locationId) both('location_id', f.locationId);
  if (statuses.length) {
    gw.push(`g.status IN (${statuses.map(() => '?').join(',')})`);
    bw.push(`b.status IN (${statuses.map(() => '?').join(',')})`);
    gp.push(...statuses);
    bp.push(...statuses);
  }
  return all(
    db,
    `SELECT * FROM (
       SELECT 'Peça individual' AS gestao, g.code, t.name AS item_type_name, s.label AS size_label, g.inscription, g.condition, g.status,
              l.name AS location_name, 1 AS quantity, g.origin, g.verification, g.entry_date, mu.full_name AS holder_name, g.cost_cents,
              t.sort_order AS t_sort, s.sort_order AS s_sort, g.serial AS ord
         FROM garments g JOIN item_types t ON t.id = g.item_type_id LEFT JOIN item_sizes s ON s.id = g.size_id
         LEFT JOIN locations l ON l.id = g.location_id LEFT JOIN musicians mu ON mu.id = g.holder_musician_id
        WHERE ${gw.join(' AND ')}
       UNION ALL
       SELECT 'Quantidade', NULL, t.name, s.label, NULL, b.condition, b.status, l.name, b.quantity, NULL, b.verification, NULL, NULL, NULL,
              t.sort_order, s.sort_order, 0
         FROM stock_balances b JOIN item_types t ON t.id = b.item_type_id LEFT JOIN item_sizes s ON s.id = b.size_id
         LEFT JOIN locations l ON l.id = b.location_id
        WHERE ${bw.join(' AND ')}
     ) ORDER BY t_sort, s_sort, status, ord`,
    ...gp,
    ...bp,
  );
}

const INVENTORY_COLUMNS: Column[] = [
  { key: 'gestao', label: 'Gestão' },
  { key: 'code', label: 'Código' },
  { key: 'item_type_name', label: 'Artigo' },
  { key: 'size_label', label: 'Tamanho' },
  { key: 'inscription', label: 'Inscrição' },
  { key: 'condition', label: 'Conservação', map: C },
  { key: 'status', label: 'Estado', map: S },
  { key: 'quantity', label: 'Quantidade', type: 'int' },
  { key: 'location_name', label: 'Localização' },
  { key: 'holder_name', label: 'Na posse de' },
  { key: 'origin', label: 'Origem', map: ORIGIN_LABELS as Record<string, string> },
  { key: 'verification', label: 'Verificação', map: VERIFICATION_LABELS as Record<string, string> },
  { key: 'entry_date', label: 'Data de entrada', type: 'date' },
  { key: 'cost_cents', label: 'Custo (€)', type: 'money' },
];

export async function buildDataset(db: D1Database, key: DatasetKey, f: ExportFilters): Promise<Dataset> {
  const filters = await describeFilters(db, f);
  const base = { title: DATASET_TITLES[key], sheetName: DATASET_TITLES[key], filters };
  switch (key) {
    case 'inventario':
      return { ...base, columns: INVENTORY_COLUMNS, rows: await inventoryRows(db, f) };
    case 'stock-disponivel':
      return { ...base, columns: INVENTORY_COLUMNS.filter((c) => !['status', 'holder_name'].includes(c.key)), rows: await inventoryRows(db, f, ['disponivel']) };
    case 'stock-tipo-tamanho': {
      const rows = (await summaryRows(db, { itemTypeId: f.itemTypeId, locationId: f.locationId })).map((r) => {
        const x = r as Record<string, number>;
        return { ...r, fisico: STATUSES.filter((s) => !['abatido', 'extraviado', 'rejeitado'].includes(s)).reduce((a, s) => a + Number(x[s] ?? 0), 0) };
      });
      return {
        ...base,
        columns: [
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size_label', label: 'Tamanho' },
          { key: 'disponivel', label: 'Disponível', type: 'int' },
          { key: 'reservado', label: 'Reservado', type: 'int' },
          { key: 'atribuido', label: 'Atribuído a músicos', type: 'int' },
          { key: 'emprestado', label: 'Emprestado', type: 'int' },
          { key: 'pendente_inspecao', label: 'Pend. inspeção', type: 'int' },
          { key: 'quarentena', label: 'Quarentena', type: 'int' },
          { key: 'reparacao', label: 'Reparação', type: 'int' },
          { key: 'fisico', label: 'Total físico', type: 'int' },
          { key: 'abatido', label: 'Abatido', type: 'int' },
          { key: 'extraviado', label: 'Extraviado', type: 'int' },
        ],
        rows,
      };
    }
    case 'musicos': {
      const mf = musicianFilters.parse({ q: f.q, kind: f.kind || undefined, page: 1, pageSize: 500 });
      const { items } = await listMusicians(db, mf, true);
      return {
        ...base,
        columns: [
          { key: 'internal_code', label: 'Código' },
          { key: 'full_name', label: 'Nome' },
          { key: 'kind', label: 'Tipo', map: MUSICIAN_KIND_LABELS },
          { key: 'status', label: 'Estado', map: MUSICIAN_STATUS_LABELS },
          { key: 'contact', label: 'Contacto' },
          { key: 'needs_total', label: 'Peças pretendidas', type: 'int' },
          { key: 'delivered_qty', label: 'Peças entregues', type: 'int' },
          { key: 'needs_open', label: 'Por entregar', type: 'int' },
          { key: 'shoes_open', label: 'Necessidades de sapatos', type: 'int' },
          { key: 'return_expected', label: 'Antigas a devolver', type: 'int' },
          { key: 'returned_qty', label: 'Antigas devolvidas', type: 'int' },
          { key: 'loan_pending', label: 'Empréstimos por devolver', type: 'int' },
        ],
        rows: items,
      };
    }
    case 'necessidades': {
      const rf = requestFilters.parse({ musicianId: f.musicianId, itemTypeId: f.itemTypeId, sizeId: f.sizeId, pendingOnly: f.pendingOnly, q: f.q, page: 1, pageSize: 500 });
      const w = requestWhere(rf);
      const rows = withProgress(await all(db, `${REQUEST_SELECT} WHERE ${w.sql} ORDER BY m.full_name COLLATE NOCASE, t.sort_order`, ...w.params)).map((r) => ({
        ...r,
        size: (r as Record<string, unknown>).size_label ?? (r as Record<string, unknown>).size_text,
      }));
      return {
        ...base,
        columns: [
          { key: 'musician_name', label: 'Músico' },
          { key: 'musician_code', label: 'Código' },
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size', label: 'Tamanho' },
          { key: 'quantity_requested', label: 'Pretendida', type: 'int' },
          { key: 'quantity_ordered', label: 'Encomendada', type: 'int' },
          { key: 'quantity_received', label: 'Recebida', type: 'int' },
          { key: 'quantity_delivered', label: 'Entregue', type: 'int' },
          { key: 'quantity_missing', label: 'Em falta', type: 'int' },
          { key: 'return_expected', label: 'Antigas a devolver', type: 'int' },
          { key: 'progress', label: 'Situação', map: { ...REQUEST_PROGRESS_LABELS, ...(REQUEST_STATUS_LABELS as Record<string, string>) } },
          { key: 'notes', label: 'Observações' },
        ],
        rows,
      };
    }
    case 'entregas': {
      const where = ['1=1'];
      const p: unknown[] = [];
      if (f.musicianId) (where.push('d.musician_id = ?'), p.push(f.musicianId));
      if (f.itemTypeId) (where.push('dl.item_type_id = ?'), p.push(f.itemTypeId));
      if (f.from) (where.push('d.delivered_at >= ?'), p.push(f.from));
      if (f.to) (where.push('d.delivered_at <= ?'), p.push(`${f.to}T23:59:59.999Z`));
      return {
        ...base,
        columns: [
          { key: 'delivered_at', label: 'Data', type: 'date' },
          { key: 'musician_name', label: 'Músico' },
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size_label', label: 'Tamanho' },
          { key: 'garment_code', label: 'Código' },
          { key: 'inscription', label: 'Inscrição' },
          { key: 'quantity', label: 'Quantidade', type: 'int' },
          { key: 'condition', label: 'Conservação', map: C },
          { key: 'status', label: 'Estado da linha', map: { entregue: 'Entregue', anulada: 'Anulada' } },
          { key: 'receipt', label: 'Receção confirmada' },
          { key: 'delivered_by_name', label: 'Responsável' },
        ],
        rows: await all(
          db,
          `SELECT d.delivered_at, m.full_name AS musician_name, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, g.inscription,
                  dl.quantity, dl.condition, dl.status, CASE WHEN dl.receipt_confirmed = 1 THEN 'Sim' ELSE 'Não' END AS receipt, u.name AS delivered_by_name
             FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id JOIN musicians m ON m.id = d.musician_id
             JOIN item_types t ON t.id = dl.item_type_id LEFT JOIN item_sizes s ON s.id = dl.size_id LEFT JOIN garments g ON g.id = dl.garment_id
             JOIN users u ON u.id = d.delivered_by WHERE ${where.join(' AND ')} ORDER BY d.delivered_at DESC, m.full_name`,
          ...p,
        ),
      };
    }
    case 'recolhas': {
      const where = ['1=1'];
      const p: unknown[] = [];
      if (f.musicianId) (where.push('r.musician_id = ?'), p.push(f.musicianId));
      if (f.itemTypeId) (where.push('rl.item_type_id = ?'), p.push(f.itemTypeId));
      if (f.from) (where.push('r.received_at >= ?'), p.push(f.from));
      if (f.to) (where.push('r.received_at <= ?'), p.push(`${f.to}T23:59:59.999Z`));
      if (f.pendingOnly === '1') where.push('rl.approved_destination IS NULL');
      return {
        ...base,
        columns: [
          { key: 'received_at', label: 'Receção', type: 'date' },
          { key: 'musician_name', label: 'Músico' },
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size', label: 'Tamanho' },
          { key: 'garment_code', label: 'Código' },
          { key: 'inscription', label: 'Inscrição' },
          { key: 'quantity', label: 'Qtd.', type: 'int' },
          { key: 'observed_condition', label: 'Estado observado', map: C },
          { key: 'inspected_condition', label: 'Estado inspecionado', map: C },
          { key: 'inspection_result', label: 'Resultado da inspeção' },
          { key: 'proposed_destination', label: 'Destino proposto', map: DESTINATION_LABELS as Record<string, string> },
          { key: 'approved_destination', label: 'Destino aprovado', map: DESTINATION_LABELS as Record<string, string> },
          { key: 'received_by_name', label: 'Recebido por' },
          { key: 'decided_by_name', label: 'Decidido por' },
          { key: 'decided_at', label: 'Data da decisão', type: 'date' },
        ],
        rows: await all(
          db,
          `SELECT r.received_at, m.full_name AS musician_name, t.name AS item_type_name, COALESCE(s.label, rl.size_text) AS size, g.code AS garment_code,
                  rl.inscription, rl.quantity, rl.observed_condition, rl.inspected_condition, rl.inspection_result, rl.proposed_destination,
                  rl.approved_destination, u.name AS received_by_name, du.name AS decided_by_name, rl.decided_at
             FROM garment_return_lines rl JOIN garment_returns r ON r.id = rl.return_id JOIN musicians m ON m.id = r.musician_id
             JOIN item_types t ON t.id = rl.item_type_id LEFT JOIN item_sizes s ON s.id = rl.size_id LEFT JOIN garments g ON g.id = rl.garment_id
             JOIN users u ON u.id = r.received_by LEFT JOIN users du ON du.id = rl.decided_by
            WHERE ${where.join(' AND ')} ORDER BY r.received_at DESC, m.full_name`,
          ...p,
        ),
      };
    }
    case 'movimentos': {
      const mf = movementFilters.parse({ ...f, page: 1, pageSize: 25 });
      const w = movementWhere(mf);
      return {
        ...base,
        columns: [
          { key: 'seq', label: 'N.º', type: 'int' },
          { key: 'created_at', label: 'Data e hora', type: 'datetime' },
          { key: 'movement_type', label: 'Movimento', map: MOVEMENT_LABELS as Record<string, string> },
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size_label', label: 'Tamanho' },
          { key: 'garment_code', label: 'Código' },
          { key: 'quantity', label: 'Qtd.', type: 'int' },
          { key: 'from_status', label: 'De', map: S },
          { key: 'to_status', label: 'Para', map: S },
          { key: 'from_location_name', label: 'Local de origem' },
          { key: 'to_location_name', label: 'Local de destino' },
          { key: 'musician_name', label: 'Músico' },
          { key: 'reason', label: 'Motivo' },
          { key: 'user_name', label: 'Utilizador' },
        ],
        rows: await all(db, `${MOVEMENT_SELECT} WHERE ${w.sql} ORDER BY m.seq DESC LIMIT 20000`, ...w.params),
      };
    }
    case 'emprestimos':
    case 'pendencias': {
      const where = ['1=1'];
      const p: unknown[] = [];
      if (f.eventId) (where.push('lo.event_id = ?'), p.push(f.eventId));
      if (f.campaignId) (where.push('e.campaign_id = ?'), p.push(f.campaignId));
      if (f.musicianId) (where.push('lo.musician_id = ?'), p.push(f.musicianId));
      if (f.itemTypeId) (where.push('v.item_type_id = ?'), p.push(f.itemTypeId));
      if (key === 'pendencias' || f.pendingOnly === '1') where.push('v.pending_quantity > 0');
      const loanRows = await all(
        db,
        `SELECT e.name AS event_name, e.start_date AS event_date, fc.name AS campaign_name, mu.full_name AS musician_name, mu.contact AS musician_contact,
                t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, v.quantity, v.returned_quantity, v.lost_quantity, v.pending_quantity,
                v.out_condition, v.last_return_condition, v.delivered_at, lo.due_date, u.name AS delivered_by_name,
                CASE WHEN v.pending_quantity > 0 AND lo.due_date < '${todayIso()}' THEN 'Sim' ELSE '' END AS overdue
           FROM v_loan_lines v JOIN loans lo ON lo.id = v.loan_id JOIN events e ON e.id = lo.event_id
           LEFT JOIN festival_campaigns fc ON fc.id = e.campaign_id JOIN musicians mu ON mu.id = lo.musician_id
           JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id LEFT JOIN garments g ON g.id = v.garment_id
           JOIN users u ON u.id = v.delivered_by
          WHERE ${where.join(' AND ')} ORDER BY e.start_date, mu.full_name COLLATE NOCASE, t.sort_order`,
        ...p,
      );
      if (key === 'emprestimos') {
        return {
          ...base,
          columns: [
            { key: 'campaign_name', label: 'Campanha' },
            { key: 'event_name', label: 'Festa' },
            { key: 'event_date', label: 'Data da festa', type: 'date' },
            { key: 'musician_name', label: 'Músico convidado' },
            { key: 'item_type_name', label: 'Artigo' },
            { key: 'size_label', label: 'Tamanho' },
            { key: 'garment_code', label: 'Código' },
            { key: 'quantity', label: 'Emprestado', type: 'int' },
            { key: 'returned_quantity', label: 'Devolvido', type: 'int' },
            { key: 'lost_quantity', label: 'Perdido', type: 'int' },
            { key: 'pending_quantity', label: 'Em falta', type: 'int' },
            { key: 'out_condition', label: 'Estado à saída', map: C },
            { key: 'last_return_condition', label: 'Estado à devolução', map: C },
            { key: 'due_date', label: 'Prazo', type: 'date' },
            { key: 'delivered_by_name', label: 'Entregue por' },
          ],
          rows: loanRows,
        };
      }
      const oldReturns = f.eventId || f.campaignId
        ? []
        : await all(
            db,
            `SELECT 'Fardamento antigo' AS kind, NULL AS event_name, m.full_name AS musician_name, m.contact AS musician_contact, t.name AS item_type_name,
                    NULL AS size_label, NULL AS garment_code, SUM(r.return_expected) - COALESCE(x.returned_quantity, 0) AS pending_quantity, NULL AS due_date, '' AS overdue
               FROM musician_item_requests r JOIN musicians m ON m.id = r.musician_id JOIN item_types t ON t.id = r.item_type_id
               LEFT JOIN v_musician_returns x ON x.musician_id = r.musician_id AND x.item_type_id = r.item_type_id
              WHERE r.status != 'cancelada' ${f.musicianId ? 'AND r.musician_id = ?' : ''} ${f.itemTypeId ? 'AND r.item_type_id = ?' : ''}
              GROUP BY r.musician_id, r.item_type_id HAVING pending_quantity > 0 ORDER BY m.full_name`,
            ...[f.musicianId, f.itemTypeId].filter(Boolean),
          );
      return {
        ...base,
        columns: [
          { key: 'kind', label: 'Tipo de pendência' },
          { key: 'musician_name', label: 'Músico' },
          { key: 'musician_contact', label: 'Contacto' },
          { key: 'event_name', label: 'Festa' },
          { key: 'item_type_name', label: 'Artigo' },
          { key: 'size_label', label: 'Tamanho' },
          { key: 'garment_code', label: 'Código' },
          { key: 'pending_quantity', label: 'Em falta', type: 'int' },
          { key: 'due_date', label: 'Prazo', type: 'date' },
          { key: 'overdue', label: 'Atrasado' },
        ],
        rows: [...loanRows.map((r) => ({ ...r, kind: 'Empréstimo' })), ...oldReturns],
      };
    }
  }
}

