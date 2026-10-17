import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, download } from '../api/client';
import { EVENT_STATUS_LABELS, LOAN_STATE_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Checkbox, ConfirmDialog, DefList, ErrorBox, LinkButton, Loading, PageHeader, Tabs, TextArea } from '../components/ui';
import { ConditionBadge, Photos, StatusBadge } from '../components/domain';
import { EventModal, ReconciliationView, type Reconciliation } from '../components/eventForms';
import { RemindersModal, type ReminderTarget } from '../components/RemindersModal';
import { fmtDate, fmtDateTime, todayIso } from '../lib/format';
import { useAuth } from '../lib/auth';
import { DangerAction } from '../components/DangerAction';

export default function EventDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['event', id], queryFn: () => api.get<{ event: any; loans: any[]; returns: any[]; reconciliation: Reconciliation & { lines: any[] } }>(`/events/${id}`) });
  const [tab, setTab] = useState('emprestimos');
  const [edit, setEdit] = useState(false);
  const [remind, setRemind] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { event: e, loans, returns, reconciliation } = q.data;
  const pending = reconciliation.totals.pending;

  async function close() {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/events/${id}/close`, { confirmPending, notes: notes || null });
      setClosing(false);
      qc.invalidateQueries();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    try {
      await api.post(`/events/${id}/reopen`);
      qc.invalidateQueries();
    } catch (x) {
      setErr(x);
    }
  }

  return (
    <div>
      <PageHeader
        back={{ to: '/festas', label: 'Festas' }}
        title={e.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {fmtDate(e.start_date)}
            {e.end_date && e.end_date !== e.start_date && ` – ${fmtDate(e.end_date)}`}
            {e.place && ` · ${e.place}`}
            <Badge tone={e.status === 'encerrada' ? 'grey' : 'navy'}>{EVENT_STATUS_LABELS[e.status as 'ativa']}</Badge>
            {e.closed_with_pending === 1 && <Badge tone="amber">encerrada com pendências</Badge>}
          </span>
        }
        actions={
          <>
            {can('loans.write') && pending > 0 && <Button variant="gold" onClick={() => setRemind(true)}>Lembrar devolução da farda</Button>}
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/event/${id}`)}>Relatório da festa (PDF)</Button>}
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/datasets/emprestimos/xlsx', { eventId: id })}>Excel</Button>}
            {can('events.write') && <Button variant="secondary" onClick={() => setEdit(true)}>Editar</Button>}
            {can('events.write') && e.status !== 'encerrada' && <Button variant="secondary" onClick={() => { setConfirmPending(false); setNotes(''); setClosing(true); }}>Encerrar festa</Button>}
            {can('events.write') && e.status === 'encerrada' && <Button variant="ghost" onClick={reopen}>Reabrir</Button>}
            {can('loans.write') && !['encerrada', 'cancelada'].includes(e.status) && <LinkButton to={`/emprestimos/novo?festa=${id}`}>Novo empréstimo</LinkButton>}
            {can('events.write') && loans.length === 0 && (
              <DangerAction variant="ghost" label="Eliminar festa" title="Eliminar festa" message={<>Eliminar a festa «{e.name}»? Só é possível enquanto não tiver empréstimos.</>} onConfirm={() => api.del(`/events/${id}`)} onDone={() => nav('/festas', { replace: true })} />
            )}
          </>
        }
      />
      <ErrorBox error={err} />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'emprestimos', label: `Músicos convidados (${loans.length})` },
          { key: 'artigos', label: `Artigos emprestados (${reconciliation.totals.lent})` },
          { key: 'devolucoes', label: `Devoluções (${returns.length})` },
          { key: 'reconciliacao', label: 'Reconciliação' },
          { key: 'info', label: 'Informação' },
        ]}
      />
      {tab === 'emprestimos' && (
        <DataTable
          rows={loans}
          rowKey={(r) => r.id}
          emptyTitle="Sem empréstimos nesta festa"
          emptyHint={can('loans.write') ? 'Use «Novo empréstimo» para registar o material entregue a cada músico convidado.' : undefined}
          columns={[
            { key: 'm', header: 'Músico', render: (r) => <Link className="font-medium text-marinho-700 underline" to={`/emprestimos/${r.id}`}>{r.musician_name}</Link> },
            { key: 'i', header: 'Instrumento', render: (r) => r.musician_instrument ?? '—' },
            { key: 'b', header: 'Banda de origem', render: (r) => r.origin_band ?? '—' },
            { key: 't', header: 'Telemóvel', render: (r) => r.musician_phone ?? <span className="text-amber-700">—</span> },
            { key: 'd', header: 'Entregue', render: (r) => `${fmtDateTime(r.delivered_at)} · ${r.delivered_by_name}` },
            { key: 'p', header: 'Prazo', render: (r) => (r.due_date ? <span className={r.pending && r.due_date < todayIso() ? 'font-semibold text-red-700' : ''}>{fmtDate(r.due_date)}</span> : '—') },
            { key: 'q', header: 'Emprestado', align: 'right', render: (r) => r.quantity },
            { key: 'r', header: 'Devolvido', align: 'right', render: (r) => r.returned },
            { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
            { key: 's', header: 'Situação', render: (r) => <Badge tone={r.pending ? 'amber' : 'green'}>{r.pending ? (r.returned ? LOAN_STATE_LABELS.parcial : LOAN_STATE_LABELS.aberto) : r.lost ? LOAN_STATE_LABELS.com_perdas : LOAN_STATE_LABELS.devolvido}</Badge> },
          ]}
        />
      )}
      {tab === 'artigos' && (
        <DataTable
          rows={reconciliation.lines}
          rowKey={(r) => r.id}
          emptyTitle="Sem artigos emprestados"
          columns={[
            { key: 'm', header: 'Músico', render: (r) => <Link className="underline" to={`/emprestimos/${r.loan_id}`}>{r.musician_name}</Link> },
            { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
            { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? '—' },
            { key: 'c', header: 'Código', render: (r) => (r.garment_code ? <span className="font-mono text-xs">{r.garment_code}</span> : '—') },
            { key: 'o', header: 'Estado à saída', render: (r) => <ConditionBadge condition={r.out_condition} /> },
            { key: 'q', header: 'Qtd.', align: 'right', render: (r) => r.quantity },
            { key: 'r', header: 'Devolvido', align: 'right', render: (r) => r.returned_quantity },
            { key: 'd', header: 'Danificado', align: 'right', render: (r) => r.damaged_quantity || 0 },
            { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending_quantity ? <strong className="text-amber-700">{r.pending_quantity}</strong> : 0) },
            { key: 'g', header: 'Estado atual', render: (r) => (r.garment_status ? <StatusBadge status={r.garment_status} /> : '') },
          ]}
        />
      )}
      {tab === 'devolucoes' && (
        <DataTable
          rows={returns}
          rowKey={(r) => r.id}
          emptyTitle="Ainda sem devoluções"
          columns={[
            { key: 'd', header: 'Data', render: (r) => fmtDateTime(r.received_at) },
            { key: 'm', header: 'Músico', render: (r) => r.musician_name },
            { key: 'k', header: 'Tipo', render: (r) => (r.kind === 'perda' ? <Badge tone="red">Perda</Badge> : 'Devolução') },
            { key: 't', header: 'Artigo', render: (r) => `${r.item_type_name} ${r.size_label ?? ''} ${r.garment_code ?? ''}` },
            { key: 'q', header: 'Qtd.', align: 'right', render: (r) => r.quantity },
            { key: 'c', header: 'Estado', render: (r) => (r.condition ? <ConditionBadge condition={r.condition} /> : '—') },
            { key: 'dm', header: 'Danos', render: (r) => (r.damaged ? <Badge tone="red">Sim</Badge> : '') },
            { key: 'ds', header: 'Destino', render: (r) => <StatusBadge status={r.destination_status} /> },
            { key: 'u', header: 'Recebido por', render: (r) => r.received_by_name },
          ]}
        />
      )}
      {tab === 'reconciliacao' && (
        <Card>
          <ReconciliationView rec={reconciliation} />
        </Card>
      )}
      {tab === 'info' && (
        <Card>
          <DefList
            items={[
              ['Local', e.place],
              ['Observações', e.notes],
              ['Encerrada', e.closed_at ? `${fmtDateTime(e.closed_at)} por ${e.closed_by_name}` : null],
              ['Notas de encerramento', e.closing_notes],
            ]}
          />
          <div className="mt-4">
            <Photos entityType="event" entityId={id} />
          </div>
        </Card>
      )}
      {edit && <EventModal open existing={e} onClose={() => setEdit(false)} />}
      {remind && (
        <RemindersModal
          open
          onClose={() => setRemind(false)}
          eventName={e.name}
          targets={loans
            .filter((l) => l.pending > 0)
            .map(
              (l): ReminderTarget => ({
                loanId: l.id,
                musicianId: l.musician_id,
                name: l.musician_name,
                phone: l.musician_phone,
                dueDate: l.due_date,
                lastReminderAt: l.last_reminder_at,
                reminderCount: l.reminder_count ?? 0,
                items: reconciliation.lines
                  .filter((x) => x.loan_id === l.id && x.pending_quantity > 0)
                  .map((x) => `${x.pending_quantity} × ${x.item_type_name}${x.size_label ? ` (${x.size_label})` : ''}${x.garment_code ? ` ${x.garment_code}` : ''}`),
              }),
            )}
        />
      )}
      <ConfirmDialog
        open={closing}
        title="Encerrar festa"
        message={pending ? <p className="text-amber-900">Existem <strong>{pending}</strong> peça(s) ainda por devolver. As pendências ficam registadas e continuam visíveis nos alertas.</p> : 'Todo o material foi devolvido. Confirma o encerramento?'}
        loading={busy}
        error={err instanceof ApiError && err.code === 'PENDENCIAS' ? null : err}
        onClose={() => setClosing(false)}
        onConfirm={close}
      >
        {pending > 0 && (
          <>
            <Checkbox label="Confirmo o encerramento com material por devolver" checked={confirmPending} onChange={setConfirmPending} />
            <TextArea label="Descrição das pendências e diligências (obrigatório)" value={notes} onChange={(ev) => setNotes(ev.target.value)} />
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
