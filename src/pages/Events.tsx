import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../api/client';
import { EVENT_STATUSES, EVENT_STATUS_LABELS } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, PageHeader, SelectInput, TextInput } from '../components/ui';
import { EventModal } from '../components/eventForms';
import { fmtDate } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

export default function Events() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { params, set, page } = useListParams();
  const events = useQuery({ queryKey: ['events', params], queryFn: () => api.get<Page<any>>('/events', { ...params, page, pageSize: 25 }), placeholderData: (p) => p });
  const [newEvent, setNewEvent] = useState(false);
  return (
    <div>
      <PageHeader
        title="Festas"
        subtitle="Festas e atuações da banda. Em cada festa registam-se os empréstimos de fardamento aos músicos convidados e as respetivas devoluções."
        actions={can('events.write') && <Button onClick={() => setNewEvent(true)}>Nova festa</Button>}
      />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextInput label="Pesquisar" type="search" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <SelectInput label="Estado" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} options={EVENT_STATUSES.map((s) => ({ value: s, label: EVENT_STATUS_LABELS[s] }))} placeholder="Todos" />
        <SelectInput label="Devoluções" value={params.withPending ?? ''} onChange={(e) => set({ withPending: e.target.value })} options={[{ value: '1', label: 'Com material por devolver' }]} placeholder="Todas" />
      </div>
      <DataTable
        rows={events.data?.items}
        loading={events.isFetching}
        error={events.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/festas/${r.id}`)}
        emptyTitle="Sem festas registadas"
        columns={[
          { key: 'n', header: 'Festa', render: (r) => <Link to={`/festas/${r.id}`} className="font-medium text-marinho-700 underline">{r.name}</Link> },
          { key: 'd', header: 'Data', render: (r) => `${fmtDate(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ` – ${fmtDate(r.end_date)}` : ''}` },
          { key: 'p', header: 'Local', render: (r) => r.place ?? '—' },
          { key: 'l', header: 'Empréstimos', align: 'right', render: (r) => r.loan_count },
          { key: 'q', header: 'Peças emprestadas', align: 'right', render: (r) => r.lent },
          { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
          { key: 's', header: 'Estado', render: (r) => <Badge tone={r.status === 'encerrada' ? 'grey' : r.status === 'ativa' ? 'navy' : 'blue'}>{EVENT_STATUS_LABELS[r.status as 'ativa']}</Badge> },
        ]}
      />
      {events.data && <Pagination page={page} pageSize={25} total={events.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
      {newEvent && <EventModal open onClose={() => setNewEvent(false)} onSaved={(id) => nav(`/festas/${id}`)} />}
    </div>
  );
}
