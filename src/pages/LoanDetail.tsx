import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, newIdempotencyKey } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, LOAN_STATE_LABELS, STATUS_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, ConfirmDialog, DefList, ErrorBox, Loading, Modal, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { ConditionBadge, Photos, StatusBadge } from '../components/domain';
import { AvailablePicker, type PickedLine } from '../components/pickers';
import { fmtDate, fmtDateTime, todayIso } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useItemTypes, useLocations, type ItemType } from '../lib/hooks';
import { LOAN_TONE } from './Loans';

interface RetForm {
  quantity: string;
  condition: string;
  damaged: boolean;
  destination: string;
  locationId: string;
  notes: string;
}

export default function LoanDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const types = useItemTypes();
  const locations = useLocations();
  const q = useQuery({ queryKey: ['loan', id], queryFn: () => api.get<{ loan: any; lines: any[]; returns: any[] }>(`/loans/${id}`) });
  const [ret, setRet] = useState<Record<string, RetForm> | null>(null);
  const [lost, setLost] = useState<any>(null);
  const [lostF, setLostF] = useState({ quantity: '1', reason: '' });
  const [addType, setAddType] = useState('');
  const [picker, setPicker] = useState<ItemType | null>(null);
  const [toAdd, setToAdd] = useState<PickedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { loan, lines, returns } = q.data;
  const pendingLines = lines.filter((l) => l.pending_quantity > 0);

  function openReturn() {
    setErr(null);
    setRet(Object.fromEntries(pendingLines.map((l) => [l.id, { quantity: String(l.pending_quantity), condition: l.out_condition, damaged: false, destination: '', locationId: l.out_location_id ?? '', notes: '' }])));
  }
  async function run(fn: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      qc.invalidateQueries();
      after();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  const submitReturn = () =>
    run(
      () =>
        api.post(
          `/loans/${id}/returns`,
          {
            returns: Object.entries(ret!)
              .filter(([, f]) => Number(f.quantity) > 0)
              .map(([lineId, f]) => ({ lineId, quantity: Number(f.quantity), condition: f.condition, damaged: f.damaged, destination: f.destination || undefined, locationId: f.locationId || null, notes: f.notes || null })),
          },
          { idempotencyKey: newIdempotencyKey() },
        ),
      () => setRet(null),
    );

  return (
    <div>
      <PageHeader
        back={{ to: `/festas/${loan.event_id}`, label: loan.event_name }}
        title={`Empréstimo a ${loan.musician_name}`}
        subtitle={<Badge tone={LOAN_TONE[loan.state]}>{LOAN_STATE_LABELS[loan.state]}</Badge>}
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/loan/${id}`)}>Ficha de empréstimo (PDF)</Button>}
            {can('loans.write') && <Button variant="secondary" onClick={() => setAddType(addType ? '' : ' ')}>Adicionar peças</Button>}
            {can('loans.write') && pendingLines.length > 0 && <Button onClick={openReturn}>Registar devolução</Button>}
          </>
        }
      />
      <Card>
        <DefList
          items={[
            ['Músico', <Link className="underline" to={`/musicos/${loan.musician_id}`}>{loan.musician_name}</Link>],
            ['Banda de origem', loan.origin_band],
            ['Contacto', loan.musician_contact],
            ['Festa', <Link className="underline" to={`/festas/${loan.event_id}`}>{loan.event_name}</Link>],
            ['Entregue', `${fmtDateTime(loan.delivered_at)} por ${loan.delivered_by_name}`],
            ['Devolução prevista', loan.due_date ? <span className={loan.pending && loan.due_date < todayIso() ? 'font-semibold text-red-700' : ''}>{fmtDate(loan.due_date)}</span> : null],
            ['Totais', `${loan.quantity} emprestada(s) · ${loan.returned} devolvida(s) · ${loan.lost} perdida(s) · ${loan.pending} em falta`],
            ['Observações', loan.notes],
          ]}
        />
      </Card>
      {addType && (
        <Card className="mt-4" title="Adicionar peças a este empréstimo">
          <div className="flex flex-wrap items-end gap-2">
            <SelectInput className="min-w-56" label="Tipo de artigo" value={addType.trim()} onChange={(e) => setAddType(e.target.value || ' ')} options={types.active.filter((t) => t.stock_enabled).map((t) => ({ value: t.id, label: t.name }))} placeholder="Selecione…" />
            <Button variant="secondary" disabled={!addType.trim()} onClick={() => setPicker(types.byId[addType.trim()])}>Escolher do stock</Button>
            <Button disabled={!toAdd.length} loading={busy} onClick={() => run(() => api.post(`/loans/${id}/lines`, { lines: toAdd.map((l) => ({ itemTypeId: l.itemTypeId, garmentId: l.garmentId ?? null, bucketKey: l.bucketKey ?? null, quantity: l.quantity })) }, { idempotencyKey: newIdempotencyKey() }), () => { setToAdd([]); setAddType(''); })}>
              Registar ({toAdd.reduce((a, l) => a + l.quantity, 0)})
            </Button>
          </div>
          <ul className="mt-2 text-sm">{toAdd.map((l, i) => <li key={i}>{l.quantity} × {l.itemTypeName} — {l.label}</li>)}</ul>
          <ErrorBox error={err} />
        </Card>
      )}
      <Card className="mt-4" title="Peças emprestadas">
        <DataTable
          rows={lines}
          rowKey={(l) => l.id}
          columns={[
            { key: 't', header: 'Artigo', render: (l) => l.item_type_name },
            { key: 's', header: 'Tamanho', render: (l) => l.size_label ?? '—' },
            { key: 'c', header: 'Código', render: (l) => (l.garment_id ? <Link className="font-mono text-xs underline" to={`/inventario/pecas/${l.garment_id}`}>{l.garment_code}</Link> : '—') },
            { key: 'o', header: 'Estado à saída', render: (l) => <ConditionBadge condition={l.out_condition} /> },
            { key: 'q', header: 'Emprestado', align: 'right', render: (l) => l.quantity },
            { key: 'r', header: 'Devolvido', align: 'right', render: (l) => l.returned_quantity },
            { key: 'x', header: 'Perdido', align: 'right', render: (l) => l.lost_quantity },
            { key: 'p', header: 'Em falta', align: 'right', render: (l) => (l.pending_quantity ? <strong className="text-amber-700">{l.pending_quantity}</strong> : 0) },
            { key: 'g', header: 'Estado atual', render: (l) => (l.garment_status ? <StatusBadge status={l.garment_status} /> : '') },
            ...(can('loans.write') && can('inventory.writeoff')
              ? [{ key: 'a', header: '', render: (l: any) => l.pending_quantity > 0 && <Button size="sm" variant="ghost" onClick={() => { setLostF({ quantity: '1', reason: '' }); setLost(l); }}>Registar perda</Button> }]
              : []),
          ]}
        />
      </Card>
      <Card className="mt-4" title="Devoluções registadas">
        <DataTable
          rows={returns}
          rowKey={(r) => r.id}
          emptyTitle="Ainda sem devoluções"
          columns={[
            { key: 'd', header: 'Data', render: (r) => fmtDateTime(r.received_at) },
            { key: 'l', header: 'Peça', render: (r) => { const l = lines.find((x) => x.id === r.loan_line_id); return `${l?.item_type_name ?? ''} ${l?.size_label ?? ''} ${l?.garment_code ?? ''}`; } },
            { key: 'k', header: 'Tipo', render: (r) => (r.kind === 'perda' ? <Badge tone="red">Perda</Badge> : 'Devolução') },
            { key: 'q', header: 'Qtd.', align: 'right', render: (r) => r.quantity },
            { key: 'c', header: 'Estado', render: (r) => (r.condition ? <ConditionBadge condition={r.condition} /> : '—') },
            { key: 'dm', header: 'Danos', render: (r) => (r.damaged ? <Badge tone="red">Sim</Badge> : '') },
            { key: 'ds', header: 'Destino', render: (r) => <StatusBadge status={r.destination_status} /> },
            { key: 'u', header: 'Recebido por', render: (r) => r.received_by_name },
            { key: 'n', header: 'Observações', render: (r) => r.notes },
          ]}
        />
      </Card>
      <Card className="mt-4">
        <Photos entityType="loan" entityId={id} />
      </Card>

      <Modal open={!!ret} onClose={() => setRet(null)} wide title="Registar devolução" footer={<Button onClick={submitReturn} loading={busy}>Registar devolução</Button>}>
        <p className="mb-3 text-sm text-slate-600">Indique a quantidade devolvida de cada peça (0 = não devolvida agora). Pode registar devoluções parciais em momentos diferentes. Peças danificadas nunca ficam diretamente disponíveis.</p>
        <div className="space-y-3">
          {ret &&
            pendingLines.map((l) => {
              const f = ret[l.id];
              const bad = f.damaged || f.condition === 'mau' || f.condition === 'inutilizavel';
              const up = (patch: Partial<RetForm>) => setRet({ ...ret, [l.id]: { ...f, ...patch } });
              return (
                <div key={l.id} className="rounded border p-3">
                  <p className="mb-2 text-sm font-medium">
                    {l.item_type_name} {l.size_label ?? ''} {l.garment_code ?? ''} — em falta {l.pending_quantity}
                  </p>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                    <TextInput label="Quantidade" type="number" min={0} max={l.pending_quantity} value={f.quantity} onChange={(e) => up({ quantity: e.target.value })} />
                    <SelectInput label="Estado" value={f.condition} onChange={(e) => up({ condition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
                    <SelectInput
                      label="Destino"
                      value={f.destination}
                      onChange={(e) => up({ destination: e.target.value })}
                      options={(['disponivel', 'pendente_inspecao', 'quarentena', 'reparacao'] as const).filter((s) => !(bad && s === 'disponivel')).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
                      placeholder={bad ? 'Automático (inspeção)' : 'Automático (disponível)'}
                    />
                    <SelectInput label="Localização" value={f.locationId} onChange={(e) => up({ locationId: e.target.value })} options={locations.active.map((x) => ({ value: x.id, label: x.name }))} placeholder="Sem localização" />
                    <label className="flex items-center gap-2 self-end pb-2 text-sm">
                      <input type="checkbox" checked={f.damaged} onChange={(e) => up({ damaged: e.target.checked, destination: e.target.checked && f.destination === 'disponivel' ? '' : f.destination })} /> Danificada
                    </label>
                    {(f.damaged || f.notes) && <TextInput className="col-span-2 md:col-span-5" label="Descrição dos danos / observações" value={f.notes} onChange={(e) => up({ notes: e.target.value })} />}
                  </div>
                </div>
              );
            })}
          <ErrorBox error={err} />
        </div>
      </Modal>
      <ConfirmDialog
        open={!!lost}
        danger
        title="Registar peça perdida"
        message="A peça passa ao estado «Extraviado» e é registada uma ocorrência de perda. Use apenas quando se confirmar que não será devolvida."
        confirmLabel="Registar perda"
        loading={busy}
        error={err}
        onClose={() => setLost(null)}
        onConfirm={() => run(() => api.post(`/loans/${id}/lines/${lost.id}/lost`, { quantity: Number(lostF.quantity), reason: lostF.reason }, { idempotencyKey: newIdempotencyKey() }), () => setLost(null))}
      >
        {lost?.quantity > 1 && <TextInput label="Quantidade" type="number" min={1} max={lost.pending_quantity} value={lostF.quantity} onChange={(e) => setLostF({ ...lostF, quantity: e.target.value })} />}
        <TextArea label="Motivo" value={lostF.reason} onChange={(e) => setLostF({ ...lostF, reason: e.target.value })} />
      </ConfirmDialog>
      {picker && <AvailablePicker open type={picker} exclude={toAdd} onClose={() => setPicker(null)} onPick={(ls) => setToAdd([...toAdd, ...ls])} />}
    </div>
  );
}
