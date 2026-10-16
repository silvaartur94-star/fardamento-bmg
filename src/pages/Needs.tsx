import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { REQUEST_PROGRESS_LABELS, REQUEST_STATUS_LABELS } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, ConfirmDialog, LinkButton, PageHeader, SelectInput, Tabs, TextInput, type Tone } from '../components/ui';
import { fmtDate } from '../lib/format';
import { useItemTypes, useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

interface SummaryRow {
  item_type_id: string;
  item_type_name: string;
  size_id: string | null;
  size_label: string | null;
  requested: number;
  ordered: number;
  received: number;
  delivered: number;
  missing: number;
  to_order: number;
  musicians: number;
  request_ids: string;
}
const PROGRESS = { ...REQUEST_PROGRESS_LABELS, ...(REQUEST_STATUS_LABELS as Record<string, string>) };
const TONE: Record<string, Tone> = { pendente: 'amber', encomendada: 'blue', recebida: 'purple', parcial: 'orange', entregue: 'green', cancelada: 'grey', por_avaliar: 'amber', confirmada: 'blue', resolvida: 'green' };

export default function Needs() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const types = useItemTypes();
  const { params, set, page } = useListParams({ tab: 'resumo' });
  const tab = params.tab;
  const summary = useQuery({ queryKey: ['requests', 'summary'], queryFn: () => api.get<{ items: SummaryRow[]; shoes: { item_type_name: string; size_label: string | null; status: string; requests: number; quantity: number }[] }>('/requests/summary'), enabled: tab === 'resumo' || tab === 'sapatos' });
  const list = useQuery({
    queryKey: ['requests', 'list', params],
    queryFn: () => api.get<Page<any>>('/requests', { q: params.q, itemTypeId: params.itemTypeId, pendingOnly: params.pendingOnly, shoes: tab === 'sapatos' ? '1' : params.shoes, page, pageSize: 50 }),
    enabled: tab === 'lista' || tab === 'sapatos',
    placeholderData: (p) => p,
  });
  const deliveries = useQuery({ queryKey: ['deliveries', params], queryFn: () => api.get<Page<any>>('/deliveries', { q: params.q, page, pageSize: 25 }), enabled: tab === 'entregas', placeholderData: (p) => p });
  const [bulk, setBulk] = useState<{ row: SummaryRow; action: 'encomendar' | 'receber' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function runBulk() {
    if (!bulk) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post('/requests/bulk', { ids: bulk.row.request_ids.split(','), action: bulk.action });
      qc.invalidateQueries({ queryKey: ['requests'] });
      setBulk(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const totals = (summary.data?.items ?? []).reduce((a, r) => ({ requested: a.requested + r.requested, ordered: a.ordered + r.ordered, received: a.received + r.received, delivered: a.delivered + r.delivered, missing: a.missing + r.missing }), { requested: 0, ordered: 0, received: 0, delivered: 0, missing: 0 });

  return (
    <div>
      <PageHeader
        title="Necessidades e entregas"
        subtitle="Levantamento das necessidades dos músicos, encomendas e distribuição do fardamento novo."
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/necessidades/xlsx', { itemTypeId: params.itemTypeId, pendingOnly: params.pendingOnly })}>Exportar Excel</Button>}
            {can('deliveries.write') && <LinkButton to="/entregas/nova">Nova entrega</LinkButton>}
          </>
        }
      />
      <Tabs
        active={tab}
        onChange={(k) => set({ tab: k })}
        tabs={[
          { key: 'resumo', label: 'Resumo por artigo e tamanho' },
          { key: 'lista', label: 'Necessidades por músico' },
          { key: 'sapatos', label: 'Sapatos (sem aquisição)' },
          { key: 'entregas', label: 'Entregas registadas' },
        ]}
      />
      {tab === 'resumo' && (
        <>
          <DataTable
            rows={summary.data?.items}
            loading={summary.isFetching}
            error={summary.error}
            rowKey={(r) => `${r.item_type_id}-${r.size_id}-${r.size_label}`}
            emptyTitle="Sem necessidades ativas"
            emptyHint="Registe as necessidades na ficha de cada músico."
            columns={[
              { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
              { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? <span className="text-slate-400">sem tamanho</span> },
              { key: 'm', header: 'Músicos', align: 'right', render: (r) => r.musicians },
              { key: 'r', header: 'Necessário', align: 'right', render: (r) => <strong>{r.requested}</strong> },
              { key: 'o', header: 'Encomendado', align: 'right', render: (r) => r.ordered },
              { key: 'rc', header: 'Recebido', align: 'right', render: (r) => r.received },
              { key: 'd', header: 'Distribuído', align: 'right', render: (r) => r.delivered },
              { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.missing ? <strong className="text-amber-700">{r.missing}</strong> : <span className="text-emerald-700">0</span>) },
              {
                key: 'a',
                header: '',
                render: (r) =>
                  can('requests.write') && (
                    <span className="flex gap-1">
                      {r.to_order > 0 && <Button size="sm" variant="ghost" onClick={() => setBulk({ row: r, action: 'encomendar' })}>Marcar encomendado</Button>}
                      {r.received < r.requested && <Button size="sm" variant="ghost" onClick={() => setBulk({ row: r, action: 'receber' })}>Marcar recebido</Button>}
                    </span>
                  ),
              },
            ]}
          />
          {!!summary.data?.items.length && (
            <p className="mt-2 text-sm text-slate-600">
              Totais: necessário <strong>{totals.requested}</strong> · encomendado {totals.ordered} · recebido {totals.received} · distribuído {totals.delivered} · em falta <strong>{totals.missing}</strong>. As quantidades distribuídas são calculadas a partir das entregas registadas.
            </p>
          )}
        </>
      )}
      {(tab === 'lista' || tab === 'sapatos') && (
        <>
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextInput label="Pesquisar músico" type="search" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
            {tab === 'lista' && <SelectInput label="Artigo" value={params.itemTypeId ?? ''} onChange={(e) => set({ itemTypeId: e.target.value })} options={types.items.map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />}
            <SelectInput label="Situação" value={params.pendingOnly ?? ''} onChange={(e) => set({ pendingOnly: e.target.value })} options={[{ value: '1', label: 'Apenas pendentes' }]} placeholder="Todas" />
          </div>
          <DataTable
            rows={list.data?.items}
            loading={list.isFetching}
            error={list.error}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/musicos/${r.musician_id}`)}
            emptyTitle="Sem necessidades"
            columns={[
              { key: 'm', header: 'Músico', render: (r) => <Link className="font-medium text-marinho-700 underline" to={`/musicos/${r.musician_id}`}>{r.musician_name}</Link> },
              { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
              { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? r.size_text ?? '—' },
              { key: 'q', header: 'Qtd.', align: 'right', render: (r) => r.quantity_requested },
              ...(tab === 'lista' ? [{ key: 'd', header: 'Entregue', align: 'right' as const, render: (r: any) => r.quantity_delivered }] : []),
              { key: 'p', header: 'Situação', render: (r) => <Badge tone={TONE[r.progress] ?? 'grey'}>{PROGRESS[r.progress]}</Badge> },
              { key: 'dt', header: 'Levantamento', render: (r) => fmtDate(r.requested_at) },
            ]}
          />
          {list.data && <Pagination page={page} pageSize={50} total={list.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
          {tab === 'sapatos' && summary.data && (
            <p className="mt-3 text-sm text-slate-600">
              Os sapatos são registados apenas para identificar quem precisa deles; não fazem parte da aquisição planeada nem geram movimentos de stock.
            </p>
          )}
        </>
      )}
      {tab === 'entregas' && (
        <>
          <div className="mb-3 max-w-sm">
            <TextInput label="Pesquisar músico" type="search" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
          </div>
          <DataTable
            rows={deliveries.data?.items}
            loading={deliveries.isFetching}
            error={deliveries.error}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/entregas/${r.id}`)}
            emptyTitle="Ainda não há entregas registadas"
            columns={[
              { key: 'd', header: 'Data', render: (r) => fmtDate(r.delivered_at) },
              { key: 'm', header: 'Músico', render: (r) => r.musician_name },
              { key: 'q', header: 'Peças', align: 'right', render: (r) => r.total_quantity ?? 0 },
              { key: 'u', header: 'Responsável', render: (r) => r.delivered_by_name },
              { key: 'r', header: 'Recebido por', render: (r) => r.received_by_name ?? '—' },
            ]}
          />
          {deliveries.data && <Pagination page={page} pageSize={25} total={deliveries.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
        </>
      )}
      <ConfirmDialog
        open={!!bulk}
        title={bulk?.action === 'encomendar' ? 'Marcar como encomendado' : 'Marcar como recebido'}
        message={bulk && <>Atualizar as {bulk.row.request_ids.split(',').length} necessidade(s) de <strong>{bulk.row.item_type_name} {bulk.row.size_label ?? ''}</strong> com a quantidade total pretendida ({bulk.row.requested})?</>}
        loading={busy}
        error={err}
        onConfirm={runBulk}
        onClose={() => setBulk(null)}
      />
    </div>
  );
}
