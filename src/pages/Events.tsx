import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../api/client';
import { CAMPAIGN_STATUS_LABELS, EVENT_STATUSES, EVENT_STATUS_LABELS } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, Card, PageHeader, SelectInput, TextInput } from '../components/ui';
import { CampaignModal, EventModal } from '../components/eventForms';
import { fmtDate } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';

export default function Events() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { params, set, page } = useListParams();
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api.get<{ items: any[] }>('/campaigns') });
  const events = useQuery({ queryKey: ['events', params], queryFn: () => api.get<Page<any>>('/events', { ...params, page, pageSize: 25 }), placeholderData: (p) => p });
  const [newCampaign, setNewCampaign] = useState(false);
  const [newEvent, setNewEvent] = useState(false);
  return (
    <div>
      <PageHeader
        title="Festas e campanhas"
        subtitle="Uma campanha agrupa várias festas seguidas; cada festa mantém os seus empréstimos e a sua reconciliação."
        actions={
          can('events.write') && (
            <>
              <Button variant="secondary" onClick={() => setNewCampaign(true)}>Nova campanha</Button>
              <Button onClick={() => setNewEvent(true)}>Nova festa</Button>
            </>
          )
        }
      />
      <Card title="Campanhas" className="mb-5">
        {campaigns.data?.items.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {campaigns.data.items.map((c) => (
              <li key={c.id}>
                <Link to={`/festas/campanhas/${c.id}`} className="block rounded border p-3 hover:border-marinho-300 hover:bg-marinho-50">
                  <p className="font-medium text-marinho-800">{c.name}</p>
                  <p className="text-xs text-slate-500">{c.start_date ? `${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}` : 'Sem datas'} · {c.event_count} festa(s)</p>
                  <p className="mt-1 flex gap-1">
                    <Badge tone={c.status === 'ativa' ? 'navy' : c.status === 'concluida' ? 'green' : 'grey'}>{CAMPAIGN_STATUS_LABELS[c.status as 'ativa']}</Badge>
                    {c.pending > 0 && <Badge tone="amber">{c.pending} por devolver</Badge>}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">Sem campanhas registadas.</p>
        )}
      </Card>
      <h2 className="mb-2 text-lg font-semibold text-marinho-800">Festas e atuações</h2>
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <TextInput label="Pesquisar" type="search" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <SelectInput label="Campanha" value={params.campaignId ?? ''} onChange={(e) => set({ campaignId: e.target.value })} options={[{ value: 'none', label: 'Sem campanha' }, ...(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]} placeholder="Todas" />
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
          { key: 'c', header: 'Campanha', render: (r) => r.campaign_name ?? '—' },
          { key: 'p', header: 'Local', render: (r) => r.place ?? '—' },
          { key: 'l', header: 'Empréstimos', align: 'right', render: (r) => r.loan_count },
          { key: 'q', header: 'Peças emprestadas', align: 'right', render: (r) => r.lent },
          { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
          { key: 's', header: 'Estado', render: (r) => <Badge tone={r.status === 'encerrada' ? 'grey' : r.status === 'ativa' ? 'navy' : 'blue'}>{EVENT_STATUS_LABELS[r.status as 'ativa']}</Badge> },
        ]}
      />
      {events.data && <Pagination page={page} pageSize={25} total={events.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
      {newCampaign && <CampaignModal open onClose={() => setNewCampaign(false)} />}
      {newEvent && <EventModal open onClose={() => setNewEvent(false)} onSaved={(id) => nav(`/festas/${id}`)} />}
    </div>
  );
}
