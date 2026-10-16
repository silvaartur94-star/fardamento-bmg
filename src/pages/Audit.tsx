import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../api/client';
import { DataTable, Pagination } from '../components/DataTable';
import { PageHeader, SelectInput, TextInput } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useListParams } from '../lib/hooks';

const ENTITY = { user: 'Utilizador', musician: 'Músico', garment: 'Peça', delivery: 'Entrega', return: 'Recolha', loan: 'Empréstimo', event: 'Festa', campaign: 'Campanha', operation: 'Operação de stock', stock_balance: 'Saldo', stock_movement: 'Movimento', inventory_count: 'Contagem', item_type: 'Tipo de artigo', location: 'Localização', settings: 'Configuração', report: 'Exportação', incident: 'Ocorrência', request: 'Necessidade' } as Record<string, string>;

export default function Audit() {
  const { params, set, page } = useListParams();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ items: any[] }>('/users') });
  const q = useQuery({ queryKey: ['audit', params], queryFn: () => api.get<Page<any>>('/audit', { ...params, page, pageSize: 50 }), placeholderData: (p) => p });
  return (
    <div>
      <PageHeader title="Auditoria" subtitle="Registo imutável de quem criou, alterou, entregou, recebeu, inspecionou, ajustou, abateu ou exportou. Não contém palavras-passe nem tokens." />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <TextInput label="Ação contém" value={params.action ?? ''} onChange={(e) => set({ action: e.target.value })} placeholder="ex.: entrega" />
        <SelectInput label="Entidade" value={params.entityType ?? ''} onChange={(e) => set({ entityType: e.target.value })} options={Object.entries(ENTITY).map(([value, label]) => ({ value, label }))} placeholder="Todas" />
        <SelectInput label="Utilizador" value={params.userId ?? ''} onChange={(e) => set({ userId: e.target.value })} options={(users.data?.items ?? []).map((u) => ({ value: u.id, label: u.name }))} placeholder="Todos" />
        <TextInput label="Desde" type="date" value={params.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        <TextInput label="Até" type="date" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
      </div>
      <DataTable
        rows={q.data?.items}
        loading={q.isFetching}
        error={q.error}
        rowKey={(r) => r.id}
        columns={[
          { key: 'd', header: 'Data e hora', render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.created_at)}</span> },
          { key: 'u', header: 'Utilizador', render: (r) => r.user_name ?? '—' },
          { key: 'a', header: 'Ação', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
          { key: 'e', header: 'Entidade', render: (r) => `${ENTITY[r.entity_type] ?? r.entity_type}${r.entity_id ? ` · ${String(r.entity_id).slice(0, 8)}` : ''}` },
          { key: 's', header: 'Resumo', render: (r) => <code className="block max-w-xl whitespace-pre-wrap break-all text-xs text-slate-600">{r.summary}</code> },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={50} total={q.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
    </div>
  );
}
