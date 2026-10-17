import { Hono } from 'hono';
import { z } from 'zod';
import {
  CONDITION_LABELS,
  DESTINATION_LABELS,
  LOAN_STATE_LABELS,
  MUSICIAN_KIND_LABELS,
  MUSICIAN_STATUS_LABELS,
  REQUEST_PROGRESS_LABELS,
  REQUEST_STATUS_LABELS,
  STATUS_LABELS,
} from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, notFound, parseQuery, runBatch, type Ctx } from '../lib/core';
import { requirePerm } from '../auth/session';
import { toCsv } from '../exports/csv';
import { toXlsx } from '../exports/xlsx';
import { PdfBuilder, datasetsToPdf, labelsPdf, type TableColumn } from '../exports/pdf';
import { DATASET_KEYS, buildDataset, parseExportFilters, type DatasetKey } from '../exports/datasets';
import { fileStamp, fmtDate, fmtDateTime } from '../exports/format';
import { deliveryDetail } from './deliveries';
import { returnDetail } from './returns';
import { loanDetail } from './loans';
import { reconciliation } from './events';
import { musicianTypeSummary } from './musicians';
import { withProgress } from './requests';
import { garmentFilters, garmentWhere, GARMENT_SELECT } from './inventory';

export const reportRoutes = new Hono<AppEnv>();
reportRoutes.use('*', requirePerm('export'));

const C = CONDITION_LABELS as Record<string, string>;
const S = STATUS_LABELS as Record<string, string>;

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

function slug(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function send(c: Ctx, bytes: Uint8Array, format: keyof typeof MIME, name: string, audit: Record<string, unknown>) {
  await runBatch(c.env.DB, [auditStmt(c, 'exportacao', 'report', name, audit)]);
  return new Response(bytes, {
    headers: {
      'Content-Type': MIME[format],
      'Content-Disposition': `attachment; filename="${slug(name)}-${fileStamp()}.${format}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

reportRoutes.get('/datasets/:key/:format', async (c) => {
  const key = c.req.param('key') as DatasetKey;
  const format = c.req.param('format') as keyof typeof MIME;
  if (!DATASET_KEYS.includes(key)) throw new ApiError(404, 'RELATORIO_DESCONHECIDO', 'Relatório desconhecido.');
  if (!(format in MIME)) throw new ApiError(400, 'FORMATO', 'Formato inválido (csv, xlsx ou pdf).');
  const f = parseExportFilters(c.req.query());
  const ds = await buildDataset(c.env.DB, key, f);
  let bytes: Uint8Array;
  if (format === 'csv') bytes = toCsv(ds);
  else if (format === 'xlsx') bytes = toXlsx([ds]);
  else bytes = await datasetsToPdf(ds.title, [ds], { landscape: ds.columns.length > 7 });
  return send(c, bytes, format, ds.title, { relatorio: key, formato: format, filtros: f, linhas: ds.rows.length });
});

/** Livro Excel completo com uma folha por área. */
reportRoutes.get('/workbook.xlsx', async (c) => {
  const f = parseExportFilters(c.req.query());
  const keys: DatasetKey[] = ['inventario', 'stock-tipo-tamanho', 'musicos', 'necessidades', 'entregas', 'recolhas', 'movimentos', 'emprestimos', 'pendencias'];
  const sets = [];
  for (const k of keys) sets.push(await buildDataset(c.env.DB, k, f));
  return send(c, toXlsx(sets), 'xlsx', 'Fardamento - livro completo', { relatorio: 'livro_completo', filtros: f });
});

// ---------------------------------------------------------------------------
// Documentos PDF individuais
// ---------------------------------------------------------------------------
const reqCols: TableColumn[] = [
  { key: 'item_type_name', label: 'Artigo', weight: 1.4 },
  { key: 'size', label: 'Tamanho' },
  { key: 'quantity_requested', label: 'Pretendida', type: 'int', align: 'right' },
  { key: 'quantity_delivered', label: 'Entregue', type: 'int', align: 'right' },
  { key: 'quantity_missing', label: 'Em falta', type: 'int', align: 'right' },
  { key: 'return_expected', label: 'Antigas a devolver', type: 'int', align: 'right' },
  { key: 'progress', label: 'Situação', weight: 1.3, map: { ...REQUEST_PROGRESS_LABELS, ...(REQUEST_STATUS_LABELS as Record<string, string>) } },
];

reportRoutes.get('/pdf/musician/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const m = await first<Record<string, string>>(db, 'SELECT * FROM musicians WHERE id = ?', id);
  if (!m) notFound('Músico');
  const requests = withProgress(
    await all(
      db,
      `SELECT v.*, t.name AS item_type_name, t.procurement_enabled, COALESCE(s.label, v.size_text) AS size
         FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id
        WHERE v.musician_id = ? AND v.status != 'cancelada' ORDER BY t.sort_order`,
      id,
    ),
  );
  const deliveries = await all(
    db,
    `SELECT d.delivered_at, t.name AS item_type_name, s.label AS size_label, g.code AS garment_code, g.inscription, dl.quantity, dl.status
       FROM musician_delivery_lines dl JOIN musician_deliveries d ON d.id = dl.delivery_id JOIN item_types t ON t.id = dl.item_type_id
       LEFT JOIN item_sizes s ON s.id = dl.size_id LEFT JOIN garments g ON g.id = dl.garment_id WHERE d.musician_id = ? ORDER BY d.delivered_at`,
    id,
  );
  const returns = await all(
    db,
    `SELECT r.received_at, t.name AS item_type_name, COALESCE(s.label, rl.size_text) AS size, g.code AS garment_code, rl.inscription, rl.quantity,
            rl.observed_condition, rl.approved_destination
       FROM garment_return_lines rl JOIN garment_returns r ON r.id = rl.return_id JOIN item_types t ON t.id = rl.item_type_id
       LEFT JOIN item_sizes s ON s.id = rl.size_id LEFT JOIN garments g ON g.id = rl.garment_id WHERE r.musician_id = ? ORDER BY r.received_at`,
    id,
  );
  const summary = await musicianTypeSummary(db, id);
  const pdf = await PdfBuilder.create('Ficha individual de músico');
  pdf.fields([
    ['Nome', m.full_name],
    ['Código interno', m.internal_code],
    ['Tipo', MUSICIAN_KIND_LABELS[m.kind as 'banda']],
    ['Estado', MUSICIAN_STATUS_LABELS[m.status as 'ativo']],
    ['Contacto', m.contact],
    ['Banda de origem', m.origin_band],
  ]);
  if (m.notes) pdf.paragraph(`Observações: ${m.notes}`);
  const mm = await first<Record<string, number | string | null>>(db, 'SELECT * FROM musician_measurements WHERE musician_id = ?', id);
  if (mm) {
    pdf.heading('Medidas');
    const cm = (v: unknown) => (v == null ? '—' : `${String(v).replace('.', ',')} cm`);
    pdf.fields([
      ['Altura', cm(mm.height_cm)],
      ['Peito', cm(mm.chest_cm)],
      ['Cintura', cm(mm.waist_cm)],
      ['Anca', cm(mm.hips_cm)],
      ['Ombros', cm(mm.shoulder_cm)],
      ['Manga', cm(mm.sleeve_cm)],
      ['Entrepernas', cm(mm.inseam_cm)],
      ['Pescoço', cm(mm.neck_cm)],
      ['Cabeça', cm(mm.head_cm)],
      ['Sapato', mm.shoe_size],
    ]);
    if (mm.notes) pdf.paragraph(`Notas das medidas (${fmtDate(mm.measured_at)}): ${mm.notes}`, 8);
  }
  pdf.heading('Resumo por artigo');
  pdf.table(
    [
      { key: 'item_type_name', label: 'Artigo', weight: 1.4 },
      { key: 'sizes', label: 'Tamanho(s)' },
      { key: 'requested', label: 'Pretendido', type: 'int', align: 'right' },
      { key: 'delivered', label: 'Entregue', type: 'int', align: 'right' },
      { key: 'missing', label: 'Falta entregar', type: 'int', align: 'right' },
      { key: 'return_expected', label: 'A devolver', type: 'int', align: 'right' },
      { key: 'returned', label: 'Devolvido', type: 'int', align: 'right' },
    ],
    summary,
  );
  pdf.heading('Pedido de fardamento (tamanhos e quantidades)');
  pdf.table(reqCols, requests, { emptyText: 'Sem necessidades registadas.' });
  pdf.heading('Fardamento novo entregue');
  pdf.table(
    [
      { key: 'delivered_at', label: 'Data', type: 'date' },
      { key: 'item_type_name', label: 'Artigo', weight: 1.3 },
      { key: 'size_label', label: 'Tamanho' },
      { key: 'garment_code', label: 'Código' },
      { key: 'inscription', label: 'Inscrição', weight: 1.3 },
      { key: 'quantity', label: 'Qtd.', type: 'int', align: 'right', weight: 0.6 },
      { key: 'status', label: 'Estado', map: { entregue: 'Entregue', anulada: 'Anulada' } },
    ],
    deliveries,
    { emptyText: 'Sem entregas registadas.' },
  );
  pdf.heading('Fardamento antigo devolvido');
  pdf.table(
    [
      { key: 'received_at', label: 'Data', type: 'date' },
      { key: 'item_type_name', label: 'Artigo', weight: 1.3 },
      { key: 'size', label: 'Tamanho' },
      { key: 'garment_code', label: 'Código' },
      { key: 'quantity', label: 'Qtd.', type: 'int', align: 'right', weight: 0.6 },
      { key: 'observed_condition', label: 'Estado', map: C },
      { key: 'approved_destination', label: 'Destino', weight: 1.5, map: DESTINATION_LABELS as Record<string, string> },
    ],
    returns,
    { emptyText: 'Sem devoluções registadas.' },
  );
  pdf.signatures(['O músico', 'Responsável pelo fardamento']);
  return send(c, await pdf.finish(), 'pdf', `Ficha ${m.full_name}`, { documento: 'ficha_musico', musico: id });
});

reportRoutes.get('/pdf/delivery/:id', async (c) => {
  const { delivery: d, lines } = await deliveryDetail(c.env.DB, c.req.param('id'));
  const pendingRequests = withProgress(
    await all(
      c.env.DB,
      `SELECT v.*, t.name AS item_type_name, t.procurement_enabled, COALESCE(s.label, v.size_text) AS size
         FROM v_request_progress v JOIN item_types t ON t.id = v.item_type_id LEFT JOIN item_sizes s ON s.id = v.size_id
        WHERE v.musician_id = ? AND v.status = 'ativa' AND t.procurement_enabled = 1 AND v.quantity_delivered < v.quantity_requested`,
      d.musician_id,
    ),
  );
  const pdf = await PdfBuilder.create('Folha de entrega de fardamento');
  pdf.fields([
    ['Músico', d.musician_name],
    ['Código', d.musician_code],
    ['Data da entrega', fmtDate(d.delivered_at)],
    ['Responsável', d.delivered_by_name],
    ['Recebido por', d.received_by_name],
    ['Referência', String(d.id).slice(0, 8)],
  ]);
  if (d.notes) pdf.paragraph(`Observações: ${d.notes}`);
  pdf.heading('Artigos entregues');
  pdf.table(
    [
      { key: 'item_type_name', label: 'Artigo', weight: 1.4 },
      { key: 'size_label', label: 'Tamanho' },
      { key: 'garment_code', label: 'Código' },
      { key: 'inscription', label: 'Inscrição', weight: 1.4 },
      { key: 'condition', label: 'Conservação', map: C },
      { key: 'quantity', label: 'Qtd.', type: 'int', align: 'right', weight: 0.6 },
      { key: 'status', label: 'Estado', map: { entregue: 'Entregue', anulada: 'Anulada' } },
    ],
    lines,
  );
  pdf.heading('Ainda por entregar');
  pdf.table(reqCols.filter((x) => x.key !== 'return_expected'), pendingRequests, { emptyText: 'Nada por entregar.' });
  pdf.paragraph('Declaro que recebi os artigos acima indicados em bom estado, comprometendo-me a zelar pela sua conservação e a devolvê-los quando solicitado.', 8);
  pdf.signatures(['Quem entrega', 'Quem recebe (músico)']);
  return send(c, await pdf.finish(), 'pdf', `Entrega ${d.musician_name}`, { documento: 'folha_entrega', entrega: d.id });
});

reportRoutes.get('/pdf/return/:id', async (c) => {
  const { return: r, lines } = await returnDetail(c.env.DB, c.req.param('id'));
  const pdf = await PdfBuilder.create('Folha de recolha e inspeção', { landscape: true });
  pdf.fields([
    ['Músico', r.musician_name],
    ['Código', r.musician_code],
    ['Data de receção', fmtDate(r.received_at)],
    ['Recebido por', r.received_by_name],
    ['Estado da inspeção', ({ pendente: 'Pendente', em_curso: 'Em curso', concluida: 'Concluída' } as Record<string, string>)[String(r.inspection_status)]],
    ['Decidido por', r.decided_by_name],
  ]);
  if (r.initial_observations) pdf.paragraph(`Estado inicial observado: ${r.initial_observations}`);
  pdf.table(
    [
      { key: 'item_type_name', label: 'Artigo', weight: 1.2 },
      { key: 'size', label: 'Tamanho', weight: 0.7 },
      { key: 'garment_code', label: 'Código', weight: 0.9 },
      { key: 'inscription', label: 'Inscrição', weight: 1.2 },
      { key: 'quantity', label: 'Qtd.', type: 'int', align: 'right', weight: 0.5 },
      { key: 'observed_condition', label: 'Estado observado', map: C },
      { key: 'inspected_condition', label: 'Estado inspecionado', map: C },
      { key: 'inspection_result', label: 'Resultado da inspeção', weight: 1.8 },
      { key: 'approved_destination', label: 'Destino aprovado', weight: 1.5, map: DESTINATION_LABELS as Record<string, string> },
    ],
    lines.map((l) => ({ ...l, size: (l as Record<string, unknown>).size_label ?? (l as Record<string, unknown>).size_text })),
  );
  pdf.signatures(['Quem entrega (músico)', 'Quem recebe', 'Quem inspeciona']);
  return send(c, await pdf.finish(), 'pdf', `Recolha ${r.musician_name}`, { documento: 'folha_recolha', recolha: r.id });
});

reportRoutes.get('/pdf/loan/:id', async (c) => {
  const { loan, lines, returns } = await loanDetail(c.env.DB, c.req.param('id'));
  const pdf = await PdfBuilder.create('Ficha de empréstimo');
  pdf.fields([
    ['Músico', loan.musician_name],
    ['Banda de origem', loan.origin_band],
    ['Contacto', loan.musician_contact],
    ['Festa', loan.event_name],
    ['Data de entrega', fmtDateTime(loan.delivered_at)],
    ['Devolução prevista', fmtDate(loan.due_date)],
    ['Entregue por', loan.delivered_by_name],
    ['Situação', LOAN_STATE_LABELS[String(loan.state)]],
  ]);
  pdf.heading('Artigos emprestados');
  pdf.table(
    [
      { key: 'item_type_name', label: 'Artigo', weight: 1.3 },
      { key: 'size_label', label: 'Tamanho' },
      { key: 'garment_code', label: 'Código' },
      { key: 'out_condition', label: 'Estado à saída', map: C },
      { key: 'quantity', label: 'Emprestado', type: 'int', align: 'right' },
      { key: 'returned_quantity', label: 'Devolvido', type: 'int', align: 'right' },
      { key: 'lost_quantity', label: 'Perdido', type: 'int', align: 'right' },
      { key: 'pending_quantity', label: 'Em falta', type: 'int', align: 'right' },
    ],
    lines,
  );
  if (returns.length) {
    pdf.heading('Devoluções registadas');
    pdf.table(
      [
        { key: 'received_at', label: 'Data', type: 'datetime' },
        { key: 'kind', label: 'Tipo', map: { devolucao: 'Devolução', perda: 'Perda' } },
        { key: 'quantity', label: 'Qtd.', type: 'int', align: 'right' },
        { key: 'condition', label: 'Estado', map: C },
        { key: 'destination_status', label: 'Destino', map: S },
        { key: 'received_by_name', label: 'Recebido por' },
        { key: 'notes', label: 'Observações', weight: 1.6 },
      ],
      returns,
    );
  }
  pdf.paragraph('O músico compromete-se a devolver todos os artigos em bom estado até à data prevista. Danos ou perdas serão registados como ocorrência.', 8);
  pdf.signatures(['Quem entrega', 'Quem recebe (músico)', 'Quem recebe a devolução']);
  return send(c, await pdf.finish(), 'pdf', `Emprestimo ${loan.musician_name}`, { documento: 'ficha_emprestimo', emprestimo: loan.id });
});

async function reconciliationPdf(c: Ctx, title: string, info: [string, unknown][], rec: Awaited<ReturnType<typeof reconciliation>>, name: string, audit: Record<string, unknown>) {
  const pdf = await PdfBuilder.create(title, { landscape: true });
  pdf.fields(info);
  pdf.heading('Reconciliação');
  pdf.fields([
    ['Total de peças emprestadas', rec.totals.lent],
    ['Total de peças devolvidas', rec.totals.returned],
    ['Peças ainda em falta', rec.totals.pending],
    ['Peças perdidas', rec.totals.lost],
    ['Devolvidas danificadas', rec.totals.damaged],
    ['A exigir inspeção/reparação', rec.totals.needsAttention],
  ]);
  pdf.heading('Pendências por músico');
  pdf.table(
    [
      { key: 'musician_name', label: 'Músico', weight: 2 },
      { key: 'lent', label: 'Emprestado', type: 'int', align: 'right' },
      { key: 'returned', label: 'Devolvido', type: 'int', align: 'right' },
      { key: 'damaged', label: 'Danificado', type: 'int', align: 'right' },
      { key: 'lost', label: 'Perdido', type: 'int', align: 'right' },
      { key: 'pending', label: 'Em falta', type: 'int', align: 'right' },
    ],
    rec.byMusician,
  );
  pdf.heading('Detalhe dos artigos');
  pdf.table(
    [
      { key: 'event_name', label: 'Festa', weight: 1.3 },
      { key: 'musician_name', label: 'Músico', weight: 1.5 },
      { key: 'item_type_name', label: 'Artigo' },
      { key: 'size_label', label: 'Tamanho', weight: 0.7 },
      { key: 'garment_code', label: 'Código', weight: 0.9 },
      { key: 'out_condition', label: 'Estado à saída', map: C },
      { key: 'quantity', label: 'Emp.', type: 'int', align: 'right', weight: 0.5 },
      { key: 'returned_quantity', label: 'Dev.', type: 'int', align: 'right', weight: 0.5 },
      { key: 'damaged_quantity', label: 'Danif.', type: 'int', align: 'right', weight: 0.5 },
      { key: 'pending_quantity', label: 'Falta', type: 'int', align: 'right', weight: 0.5 },
    ],
    rec.lines,
  );
  pdf.signatures(['Responsável pelo fardamento', 'Direção']);
  return send(c, await pdf.finish(), 'pdf', name, audit);
}

reportRoutes.get('/pdf/event/:id', async (c) => {
  const id = c.req.param('id');
  const ev = await first<Record<string, string>>(c.env.DB, 'SELECT e.*, fc.name AS campaign_name FROM events e LEFT JOIN festival_campaigns fc ON fc.id = e.campaign_id WHERE e.id = ?', id);
  if (!ev) notFound('Festa');
  const rec = await reconciliation(c.env.DB, { eventId: id });
  return reconciliationPdf(
    c,
    'Relatório de empréstimos da festa',
    [
      ['Festa', ev.name],
      ['Campanha', ev.campaign_name],
      ['Local', ev.place],
      ['Datas', `${fmtDate(ev.start_date)}${ev.end_date ? ` a ${fmtDate(ev.end_date)}` : ''}`],
      ['Estado', ev.status],
      ['Notas de encerramento', ev.closing_notes],
    ],
    rec,
    `Festa ${ev.name}`,
    { documento: 'relatorio_festa', festa: id },
  );
});

reportRoutes.get('/pdf/campaign/:id', async (c) => {
  const id = c.req.param('id');
  const fc = await first<Record<string, string>>(c.env.DB, 'SELECT * FROM festival_campaigns WHERE id = ?', id);
  if (!fc) notFound('Campanha');
  const rec = await reconciliation(c.env.DB, { campaignId: id });
  return reconciliationPdf(
    c,
    'Relatório de empréstimos da campanha',
    [
      ['Campanha', fc.name],
      ['Datas', `${fmtDate(fc.start_date)}${fc.end_date ? ` a ${fmtDate(fc.end_date)}` : ''}`],
    ],
    rec,
    `Campanha ${fc.name}`,
    { documento: 'relatorio_campanha', campanha: id },
  );
});

/** Etiquetas com QR para peças individuais (por IDs ou pelos filtros do inventário). */
reportRoutes.get('/labels.pdf', async (c) => {
  const f = parseQuery(c, garmentFilters.extend({ ids: z.string().max(20000).optional(), start: z.coerce.number().int().min(1).max(24).default(1) }));
  let rows: { code: string; item_type_name: string; size_label: string | null; inscription: string | null }[];
  if (f.ids) {
    const ids = f.ids.split(',').slice(0, 500);
    rows = await all(c.env.DB, `${GARMENT_SELECT} WHERE g.id IN (${ids.map(() => '?').join(',')}) ORDER BY g.serial`, ...ids);
  } else {
    const w = garmentWhere(f);
    rows = await all(c.env.DB, `${GARMENT_SELECT} WHERE ${w.sql} ORDER BY g.serial LIMIT 500`, ...w.params);
  }
  const origin = new URL(c.req.url).origin;
  const bytes = await labelsPdf(
    rows.map((r) => ({
      code: r.code,
      line1: `${r.item_type_name}${r.size_label ? ` — tam. ${r.size_label}` : ''}`,
      line2: r.inscription ? `Nome: ${r.inscription}` : undefined,
      url: `${origin}/p/${encodeURIComponent(r.code)}`,
    })),
    f.start,
  );
  return send(c, bytes, 'pdf', 'Etiquetas', { documento: 'etiquetas', pecas: rows.length });
});

