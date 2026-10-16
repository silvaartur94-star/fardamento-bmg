import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download } from '../api/client';
import { CAMPAIGN_STATUS_LABELS, EVENT_STATUS_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { CampaignModal, EventModal, ReconciliationView, type Reconciliation } from '../components/eventForms';
import { fmtDate } from '../lib/format';
import { useAuth } from '../lib/auth';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => api.get<{ campaign: any; events: any[]; reconciliation: Reconciliation }>(`/campaigns/${id}`) });
  const [edit, setEdit] = useState(false);
  const [newEvent, setNewEvent] = useState(false);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { campaign: c, events, reconciliation } = q.data;
  return (
    <div>
      <PageHeader
        back={{ to: '/festas', label: 'Festas e campanhas' }}
        title={c.name}
        subtitle={
          <span>
            {c.start_date ? `${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}` : 'Sem datas'} · <Badge tone="navy">{CAMPAIGN_STATUS_LABELS[c.status as 'ativa']}</Badge>
          </span>
        }
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/campaign/${id}`)}>Relatório de reconciliação (PDF)</Button>}
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/emprestimos/xlsx', { campaignId: id })}>Excel</Button>}
            {can('events.write') && <Button variant="secondary" onClick={() => setEdit(true)}>Editar</Button>}
            {can('events.write') && <Button onClick={() => setNewEvent(true)}>Adicionar festa</Button>}
          </>
        }
      />
      {c.notes && <p className="mb-4 text-sm text-slate-700">{c.notes}</p>}
      <Card title="Festas da campanha" className="mb-4">
        <DataTable
          rows={events}
          rowKey={(r) => r.id}
          emptyTitle="Ainda sem festas"
          columns={[
            { key: 'n', header: 'Festa', render: (r) => <Link className="font-medium text-marinho-700 underline" to={`/festas/${r.id}`}>{r.name}</Link> },
            { key: 'd', header: 'Data', render: (r) => fmtDate(r.start_date) },
            { key: 'l', header: 'Empréstimos', align: 'right', render: (r) => r.loan_count },
            { key: 'q', header: 'Peças', align: 'right', render: (r) => r.lent },
            { key: 'p', header: 'Em falta', align: 'right', render: (r) => r.pending },
            { key: 's', header: 'Estado', render: (r) => <Badge>{EVENT_STATUS_LABELS[r.status as 'ativa']}</Badge> },
          ]}
        />
      </Card>
      <Card title="Reconciliação da campanha">
        <ReconciliationView rec={reconciliation} />
      </Card>
      {edit && <CampaignModal open existing={c} onClose={() => setEdit(false)} />}
      {newEvent && <EventModal open campaignId={id} onClose={() => setNewEvent(false)} />}
    </div>
  );
}
