import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, LinkButton, PageHeader, SelectInput, TextInput } from '../components/ui';
import { fmtDate } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

const STATUS = { pendente: 'Por inspecionar', em_curso: 'Inspeção em curso', concluida: 'Concluída' } as Record<string, string>;

export default function Returns() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { params, set, page } = useListParams();
  const q = useQuery({ queryKey: ['returns', params], queryFn: () => api.get<Page<any>>('/returns', { ...params, page, pageSize: 25 }), placeholderData: (p) => p });
  return (
    <div>
      <PageHeader
        title="Recolhas e inspeções"
        subtitle="Fardamento antigo recolhido aos músicos. Uma peça recebida só volta ao stock depois de inspecionada e aprovada."
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/recolhas/xlsx', { from: params.from, to: params.to })}>Exportar Excel</Button>}
            {can('returns.write') && <LinkButton to="/recolhas/nova">Nova recolha</LinkButton>}
          </>
        }
      />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <TextInput label="Pesquisar músico" type="search" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <SelectInput label="Estado" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} options={[{ value: 'por_decidir', label: 'Por decidir (pendente ou em curso)' }, ...Object.entries(STATUS).map(([value, label]) => ({ value, label }))]} placeholder="Todos" />
        <TextInput label="Desde" type="date" value={params.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        <TextInput label="Até" type="date" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
      </div>
      <DataTable
        rows={q.data?.items}
        loading={q.isFetching}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/recolhas/${r.id}`)}
        emptyTitle="Sem recolhas registadas"
        columns={[
          { key: 'd', header: 'Receção', render: (r) => fmtDate(r.received_at) },
          { key: 'm', header: 'Músico', render: (r) => r.musician_name },
          { key: 'q', header: 'Peças', align: 'right', render: (r) => r.total_quantity },
          { key: 'u', header: 'Linhas por decidir', align: 'right', render: (r) => r.undecided },
          { key: 's', header: 'Estado', render: (r) => <Badge tone={r.inspection_status === 'concluida' ? 'green' : 'amber'}>{STATUS[r.inspection_status]}</Badge> },
          { key: 'r', header: 'Recebido por', render: (r) => r.received_by_name },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={25} total={q.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
    </div>
  );
}
