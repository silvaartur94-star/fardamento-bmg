import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download } from '../api/client';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, ConfirmDialog, DefList, ErrorBox, Loading, PageHeader, TextArea, TextInput } from '../components/ui';
import { ConditionBadge, Photos } from '../components/domain';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { DangerAction } from '../components/DangerAction';

export default function DeliveryDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['delivery', id], queryFn: () => api.get<{ delivery: any; lines: any[] }>(`/deliveries/${id}`) });
  const [cancel, setCancel] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState(false);
  const [recName, setRecName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { delivery: d, lines } = q.data;

  async function run(fn: () => Promise<unknown>, close: () => void) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      qc.invalidateQueries();
      close();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        back={{ to: `/musicos/${d.musician_id}`, label: d.musician_name }}
        title={`Entrega de ${fmtDate(d.delivered_at)}${d.status === 'anulada' ? ' (anulada)' : ''}`}
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/delivery/${id}`)}>Folha de entrega (PDF)</Button>}
            {can('deliveries.write') && d.status !== 'anulada' && <Button onClick={() => { setRecName(d.received_by_name ?? ''); setReceipt(true); }}>Confirmar receção</Button>}
            {can('deliveries.write') && d.status !== 'anulada' && lines.every((l) => !l.returned_quantity) && (
              <DangerAction
                variant="ghost"
                label="Anular entrega"
                title="Anular entrega completa"
                confirmLabel="Anular"
                reason
                message="Use apenas se a entrega foi registada por engano. Todas as peças regressam ao stock disponível e as necessidades voltam a ficar pendentes."
                onConfirm={(reason, key) => api.post(`/deliveries/${id}/cancel`, { reason }, { idempotencyKey: key })}
              />
            )}
          </>
        }
      />
      <Card>
        <DefList
          items={[
            ['Músico', <Link className="underline" to={`/musicos/${d.musician_id}`}>{d.musician_name}</Link>],
            ['Responsável', d.delivered_by_name],
            ['Registada em', fmtDateTime(d.created_at)],
            ['Recebido por', d.received_by_name],
            ['Observações', d.notes],
          ]}
        />
      </Card>
      <Card className="mt-4" title="Artigos">
        <DataTable
          rows={lines}
          rowKey={(l) => l.id}
          columns={[
            { key: 't', header: 'Artigo', render: (l) => l.item_type_name },
            { key: 's', header: 'Tamanho', render: (l) => l.size_label ?? '—' },
            { key: 'c', header: 'Código', render: (l) => (l.garment_id ? <Link className="font-mono text-xs underline" to={`/inventario/pecas/${l.garment_id}`}>{l.garment_code}</Link> : '—') },
            { key: 'i', header: 'Inscrição', render: (l) => l.inscription ?? '—' },
            { key: 'q', header: 'Qtd.', align: 'right', render: (l) => l.quantity },
            { key: 'cd', header: 'Conservação', render: (l) => <ConditionBadge condition={l.condition} /> },
            { key: 'st', header: 'Estado', render: (l) => (l.status === 'anulada' ? <Badge tone="grey">Anulada</Badge> : l.receipt_confirmed ? <Badge tone="green">Receção confirmada</Badge> : <Badge tone="navy">Entregue</Badge>) },
            ...(can('deliveries.write')
              ? [{ key: 'a', header: '', render: (l: any) => l.status === 'entregue' && !l.returned_quantity && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setCancel(l); }}>Anular</Button> }]
              : []),
          ]}
        />
      </Card>
      <Card className="mt-4">
        <Photos entityType="delivery" entityId={id} title="Fotografias da entrega" />
      </Card>
      <ConfirmDialog
        open={!!cancel}
        danger
        title="Anular linha de entrega"
        message="A peça regressa ao stock disponível e a necessidade volta a ficar pendente. Use apenas para corrigir um registo feito por engano."
        confirmLabel="Anular"
        loading={busy}
        error={err}
        onClose={() => setCancel(null)}
        onConfirm={() => run(() => api.post(`/deliveries/lines/${cancel.id}/cancel`, { reason }), () => setCancel(null))}
      >
        <TextArea label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </ConfirmDialog>
      <ConfirmDialog
        open={receipt}
        title="Confirmar receção pelo músico"
        message="Regista que o músico confirmou ter recebido os artigos desta entrega."
        loading={busy}
        error={err}
        onClose={() => setReceipt(false)}
        onConfirm={() => run(() => api.post(`/deliveries/${id}/confirm-receipt`, { receivedByName: recName || null }), () => setReceipt(false))}
      >
        <TextInput label="Recebido por" value={recName} onChange={(e) => setRecName(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}
