import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { MUSICIAN_KIND_LABELS, MUSICIAN_STATUS_LABELS } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, PageHeader, SelectInput, TextInput } from '../components/ui';
import { MusicianModal } from '../components/forms';
import { useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

export interface MusicianRow {
  id: string;
  internal_code: string | null;
  full_name: string;
  kind: 'banda' | 'convidado';
  status: 'ativo' | 'inativo' | 'arquivado';
  needs_open: number;
  needs_total: number;
  shoes_open: number;
  delivered_qty: number;
  return_expected: number;
  returned_qty: number;
  returns_uninspected: number;
  garments_held: number;
  loan_pending: number;
}

export default function Musicians() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { params, set, page, toggleSort } = useListParams({ status: 'ativo' });
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['musicians', params], queryFn: () => api.get<Page<MusicianRow>>('/musicians', { ...params, page, pageSize: 25 }), placeholderData: (p) => p });
  return (
    <div>
      <PageHeader
        title="Músicos"
        subtitle="Fichas individuais dos músicos da banda e dos músicos convidados."
        actions={
          <>
            {can('export') && (
              <Button variant="secondary" onClick={() => download('/reports/datasets/musicos/xlsx', { q: params.q, kind: params.kind })}>
                Exportar Excel
              </Button>
            )}
            {can('musicians.write') && <Button onClick={() => setCreating(true)}>Novo músico</Button>}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput label="Pesquisar" placeholder="Nome ou código" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} type="search" />
        <SelectInput label="Tipo" value={params.kind ?? ''} onChange={(e) => set({ kind: e.target.value })} options={Object.entries(MUSICIAN_KIND_LABELS).map(([value, label]) => ({ value, label }))} placeholder="Todos" />
        <SelectInput label="Estado" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} options={Object.entries(MUSICIAN_STATUS_LABELS).map(([value, label]) => ({ value, label }))} placeholder="Todos" />
        <SelectInput
          label="Pendências"
          value={params.pending ?? ''}
          onChange={(e) => set({ pending: e.target.value })}
          options={[
            { value: 'entregas', label: 'Falta entregar' },
            { value: 'devolucoes', label: 'Falta devolver / inspecionar' },
            { value: 'emprestimos', label: 'Empréstimos por devolver' },
          ]}
          placeholder="Todas"
        />
      </div>
      <DataTable
        rows={q.data?.items}
        loading={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.id}
        sort={params.sort}
        dir={params.dir as 'asc'}
        onSort={toggleSort}
        onRowClick={(r) => nav(`/musicos/${r.id}`)}
        emptyTitle="Nenhum músico encontrado"
        emptyHint={can('musicians.write') ? 'Utilize «Novo músico» para criar a primeira ficha.' : undefined}
        columns={[
          { key: 'name', header: 'Nome', sortKey: 'name', render: (r) => <Link to={`/musicos/${r.id}`} className="font-medium text-marinho-700 hover:underline">{r.full_name}</Link> },
          { key: 'code', header: 'Código', sortKey: 'code', render: (r) => r.internal_code ?? '—' },
          { key: 'kind', header: 'Tipo', render: (r) => <Badge tone={r.kind === 'banda' ? 'navy' : 'blue'}>{r.kind === 'banda' ? 'Banda' : 'Convidado'}</Badge> },
          { key: 'status', header: 'Estado', sortKey: 'status', render: (r) => <Badge tone={r.status === 'ativo' ? 'green' : 'grey'}>{MUSICIAN_STATUS_LABELS[r.status]}</Badge> },
          {
            key: 'needs',
            header: 'Necessidades',
            sortKey: 'needs',
            render: (r) => (
              <span className="text-xs">
                {r.needs_total ? (r.needs_open ? <Badge tone="amber">faltam {r.needs_open} de {r.needs_total}</Badge> : <Badge tone="green">completas ({r.needs_total})</Badge>) : '—'}
                {r.shoes_open > 0 && <span className="ml-1"><Badge tone="purple">sapatos</Badge></span>}
              </span>
            ),
          },
          { key: 'del', header: 'Entregue', align: 'right', render: (r) => r.delivered_qty },
          {
            key: 'ret',
            header: 'Fardamento antigo',
            render: (r) =>
              r.return_expected ? (
                r.returned_qty >= r.return_expected ? <Badge tone="green">devolvido ({r.returned_qty})</Badge> : <Badge tone="amber">{r.returned_qty}/{r.return_expected} devolvido</Badge>
              ) : r.returned_qty ? (
                <Badge tone="grey">{r.returned_qty} recebido</Badge>
              ) : (
                '—'
              ),
          },
          { key: 'loan', header: 'Empréstimos', render: (r) => (r.loan_pending ? <Badge tone="blue">{r.loan_pending} por devolver</Badge> : '—') },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={25} total={q.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
      {creating && <MusicianModal open onClose={() => setCreating(false)} onSaved={(id) => nav(`/musicos/${id}?pedido=1`)} />}
    </div>
  );
}
