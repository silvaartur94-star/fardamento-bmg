import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download } from '../api/client';
import { INCIDENT_KINDS, INCIDENT_KIND_LABELS, VERIFICATION_LABELS } from '../../shared/domain';
import { Badge, Button, Card, DefList, ErrorBox, Loading, Modal, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { ConditionBadge, MovementsTable, Photos, StatusBadge } from '../components/domain';
import { MoveModal } from '../components/inventoryModals';
import { fmtDate, fmtDateTime, fmtMoney, originLabel, todayIso } from '../lib/format';
import { useAuth } from '../lib/auth';
import { DangerAction } from '../components/DangerAction';
import { useItemTypes } from '../lib/hooks';

export default function GarmentDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const types = useItemTypes();
  const q = useQuery({ queryKey: ['garment', id], queryFn: () => api.get<any>(`/inventory/garments/${id}`) });
  const [move, setMove] = useState(false);
  const [edit, setEdit] = useState(false);
  const [incident, setIncident] = useState(false);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { garment: g, movements, deliveries, loans, returns, incidents } = q.data;
  const type = types.byId[g.item_type_id];
  const movable = !['atribuido', 'emprestado', 'abatido', 'extraviado', 'rejeitado'].includes(g.status);

  async function save(fn: () => Promise<unknown>, close: () => void) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ['garment', id] });
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
        back={{ to: '/inventario', label: 'Inventário' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{g.code}</span> <StatusBadge status={g.status} />
          </span>
        }
        subtitle={`${g.item_type_name}${g.size_label ? ` · tamanho ${g.size_label}` : ''}${g.inscription ? ` · «${g.inscription}»` : ''}`}
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download('/reports/labels.pdf', { ids: id })}>Etiqueta QR</Button>}
            {can('inventory.write') && <Button variant="secondary" onClick={() => { setForm({ inscription: g.inscription ?? '', legacyCode: g.legacy_code ?? '', notes: g.notes ?? '', sizeId: g.size_id ?? '', cost: g.cost_cents != null ? String(g.cost_cents / 100) : '' }); setEdit(true); }}>Editar dados</Button>}
            {can('inventory.write') && <Button variant="secondary" onClick={() => setIncident(true)}>Registar ocorrência</Button>}
            {can('inventory.write') && movable && <Button onClick={() => setMove(true)}>Movimentar</Button>}
            {can('inventory.reverse') && movements.length === 1 && ['stock_inicial', 'rececao_nova'].includes(movements[0].movement_type) && (
              <DangerAction
                variant="ghost"
                label="Anular entrada"
                title="Anular entrada desta peça"
                confirmLabel="Anular"
                reason
                message="Use se a peça foi introduzida por engano (por exemplo, duplicada). A peça deixa o inventário ativo e fica como «Rejeitada»; o código não é reutilizado e o histórico é preservado."
                onConfirm={(reason, key) => api.post(`/stock-movements/${movements[0].id}/reverse`, { reason }, { idempotencyKey: key })}
              />
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Dados da peça" className="lg:col-span-2">
          <DefList
            items={[
              ['Código', <span className="font-mono">{g.code}</span>],
              ['Código/etiqueta antiga', g.legacy_code],
              ['Artigo', g.item_type_name],
              ['Tamanho', g.size_label],
              ['Inscrição (nome)', g.inscription],
              ['Conservação', <ConditionBadge condition={g.condition} />],
              ['Estado', <StatusBadge status={g.status} />],
              ['Na posse de', g.holder_musician_id ? <Link className="underline" to={`/musicos/${g.holder_musician_id}`}>{g.holder_name}</Link> : null],
              ['Localização', g.location_name],
              ['Origem', originLabel(g.origin)],
              ['Data de entrada', fmtDate(g.entry_date)],
              ['Verificação', `${VERIFICATION_LABELS[g.verification as 'contado']}${g.last_counted_at ? ` (contagem de ${fmtDate(g.last_counted_at)})` : ''}`],
              ['Custo', g.cost_cents != null ? fmtMoney(g.cost_cents) : null],
              ['Observações', g.notes],
            ]}
          />
        </Card>
        <Card title="Utilização">
          <ul className="space-y-1 text-sm">
            {deliveries.map((d: any) => (
              <li key={d.id}>
                Entregue a <Link className="underline" to={`/musicos/${d.musician_id}`}>{d.musician_name}</Link> em {fmtDate(d.delivered_at)} {d.status === 'anulada' && <Badge>anulada</Badge>}
              </li>
            ))}
            {returns.map((r: any) => (
              <li key={r.id}>
                Recolhida a {r.musician_name} em <Link className="underline" to={`/recolhas/${r.return_id}`}>{fmtDate(r.received_at)}</Link>
              </li>
            ))}
            {loans.map((l: any) => (
              <li key={l.id}>
                Emprestada a {l.musician_name} ({l.event_name}) em <Link className="underline" to={`/emprestimos/${l.loan_id}`}>{fmtDate(l.delivered_at)}</Link>
              </li>
            ))}
            {!deliveries.length && !returns.length && !loans.length && <li className="text-slate-500">Sem entregas, recolhas ou empréstimos.</li>}
          </ul>
          {incidents.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Ocorrências</h3>
              <ul className="space-y-1 text-sm">
                {incidents.map((i: any) => (
                  <li key={i.id}>
                    <Badge tone={i.resolved_at ? 'grey' : 'amber'}>{INCIDENT_KIND_LABELS[i.kind as 'dano']}</Badge> {i.description} <span className="text-xs text-slate-500">({fmtDate(i.occurred_at)}, {i.user_name})</span>
                    {can('inventory.write') && <DangerAction size="sm" variant="ghost" label="Eliminar" title="Eliminar ocorrência" message="Eliminar esta ocorrência? Não altera o stock." onConfirm={() => api.del(`/incidents/${i.id}`)} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
      <Card className="mt-4" title="Histórico de movimentos">
        <MovementsTable rows={movements} compact />
      </Card>
      <Card className="mt-4">
        <Photos entityType="garment" entityId={id} />
      </Card>
      {move && <MoveModal open onClose={() => setMove(false)} target={{ kind: 'garment', id, code: g.code, status: g.status, condition: g.condition, locationId: g.location_id }} />}
      <Modal
        open={edit}
        onClose={() => setEdit(false)}
        title="Editar dados da peça"
        footer={
          <Button
            loading={busy}
            onClick={() =>
              save(
                () =>
                  api.patch(`/inventory/garments/${id}`, {
                    inscription: form.inscription || null,
                    legacyCode: form.legacyCode || null,
                    notes: form.notes || null,
                    sizeId: form.sizeId || null,
                    costCents: form.cost ? Math.round(Number(String(form.cost).replace(',', '.')) * 100) : null,
                  }),
                () => setEdit(false),
              )
            }
          >
            Guardar
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {type?.has_size ? <SelectInput label="Tamanho" value={form.sizeId} onChange={(e) => setForm({ ...form, sizeId: e.target.value })} options={type.sizes.map((s) => ({ value: s.id, label: s.label }))} placeholder="Sem tamanho" /> : null}
          {type?.allows_inscription ? <TextInput label="Inscrição (nome)" value={form.inscription} onChange={(e) => setForm({ ...form, inscription: e.target.value })} /> : null}
          <TextInput label="Código/etiqueta antiga" value={form.legacyCode} onChange={(e) => setForm({ ...form, legacyCode: e.target.value })} />
          <TextInput label="Custo (€)" inputMode="decimal" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <TextArea className="sm:col-span-2" label="Observações" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <p className="sm:col-span-2 text-xs text-slate-500">O estado e a localização só mudam através de movimentos («Movimentar»). O código é permanente.</p>
          <div className="sm:col-span-2"><ErrorBox error={err} /></div>
        </div>
      </Modal>
      <IncidentModal open={incident} onClose={() => setIncident(false)} garmentId={id} onSaved={() => qc.invalidateQueries({ queryKey: ['garment', id] })} />
    </div>
  );
}

export function IncidentModal({ open, onClose, onSaved, ...ref }: { open: boolean; onClose: () => void; onSaved: () => void; garmentId?: string; loanId?: string; eventId?: string; musicianId?: string }) {
  const [f, setF] = useState({ kind: 'dano', description: '', occurredAt: todayIso() });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/incidents', { ...f, ...ref });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Registar ocorrência" footer={<Button onClick={submit} loading={busy} disabled={f.description.length < 3}>Registar</Button>}>
      <div className="space-y-3">
        <SelectInput label="Tipo" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={INCIDENT_KINDS.map((k) => ({ value: k, label: INCIDENT_KIND_LABELS[k] }))} />
        <TextInput label="Data" type="date" value={f.occurredAt} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} />
        <TextArea label="Descrição" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <p className="text-xs text-slate-500">A ocorrência não altera o stock. Para retirar a peça de circulação use «Movimentar» (quarentena, reparação ou abate). Registado em {fmtDateTime(new Date().toISOString())}.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
