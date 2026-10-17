import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { LOAN_STATE_LABELS } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, LinkButton, PageHeader, SelectInput, TextInput, type Tone } from '../components/ui';
import { fmtDate, todayIso } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

export const LOAN_TONE: Record<string, Tone> = { aberto: 'amber', parcial: 'orange', devolvido: 'green', com_perdas: 'red', encerrado: 'grey' };

export default function Loans() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { params, set, page } = useListParams();
  const events = useQuery({ queryKey: ['events', 'all'], queryFn: () => api.get<Page<any>>('/events', { pageSize: 200 }) });
  const q = useQuery({ queryKey: ['loans', params], queryFn: () => api.get<Page<any>>('/loans', { ...params, page, pageSize: 25 }), placeholderData: (p) => p });
  return (
    <div>
      <PageHeader
        title="Empréstimos"
        subtitle="Fardamento emprestado a músicos convidados nas festas e atuações."
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/pendencias/xlsx', { eventId: params.eventId })}>Pendências (Excel)</Button>}
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/pendencias/pdf', { eventId: params.eventId })}>Pendências (PDF)</Button>}
            {can('loans.write') && <LinkButton to="/emprestimos/novo">Novo empréstimo</LinkButton>}
          </>
        }
      />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextInput label="Pesquisar" type="search" placeholder="Músico ou festa" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <SelectInput label="Festa" value={params.eventId ?? ''} onChange={(e) => set({ eventId: e.target.value })} options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: `${e.name} (${fmtDate(e.start_date)})` }))} placeholder="Todas" />
        <SelectInput label="Situação" value={params.state ?? ''} onChange={(e) => set({ state: e.target.value })} options={[{ value: 'pendentes', label: 'Por devolver' }, { value: 'atrasados', label: 'Fora do prazo' }, { value: 'devolvidos', label: 'Devolvidos' }]} placeholder="Todas" />
      </div>
      <DataTable
        rows={q.data?.items}
        loading={q.isFetching}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/emprestimos/${r.id}`)}
        emptyTitle="Sem empréstimos"
        columns={[
          { key: 'm', header: 'Músico', render: (r) => <span className="font-medium text-marinho-700">{r.musician_name}</span> },
          { key: 'i', header: 'Instrumento', render: (r) => r.musician_instrument ?? '—' },
          { key: 'e', header: 'Festa', render: (r) => r.event_name },
          { key: 'd', header: 'Entregue', render: (r) => fmtDate(r.delivered_at) },
          { key: 'p', header: 'Prazo', render: (r) => (r.due_date ? <span className={r.pending && r.due_date < todayIso() ? 'font-semibold text-red-700' : ''}>{fmtDate(r.due_date)}</span> : '—') },
          { key: 'q', header: 'Emprestado', align: 'right', render: (r) => r.quantity },
          { key: 'r', header: 'Devolvido', align: 'right', render: (r) => r.returned },
          { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
          { key: 's', header: 'Situação', render: (r) => <Badge tone={LOAN_TONE[r.state]}>{LOAN_STATE_LABELS[r.state]}</Badge> },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={25} total={q.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
    </div>
  );
}
