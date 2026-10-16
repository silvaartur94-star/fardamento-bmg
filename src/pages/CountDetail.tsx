import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, STATUS_LABELS, type Status } from '../../shared/domain';
import { Badge, Button, Card, ConfirmDialog, ErrorBox, Loading, Modal, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { StatusBadge, TypeSizePicker } from '../components/domain';
import { conditionLabel, fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useItemTypes, useLocations } from '../lib/hooks';

export default function CountDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const types = useItemTypes();
  const locations = useLocations();
  const q = useQuery({ queryKey: ['count', id], queryFn: () => api.get<{ count: any; lines: any[] }>(`/inventory/counts/${id}`) });
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [proposals, setProposals] = useState<any[] | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [extra, setExtra] = useState(false);
  const [nl, setNl] = useState({ itemTypeId: '', sizeId: '', condition: 'bom', locationId: '', status: 'disponivel', countedQuantity: '0' });
  useEffect(() => {
    if (q.data) setValues(Object.fromEntries(q.data.lines.map((l) => [l.id, l.counted_quantity === null ? '' : String(l.counted_quantity)])));
  }, [q.data]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { count: c, lines } = q.data;
  const open = c.status === 'em_curso' && can('inventory.write');

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.put(`/inventory/counts/${id}/lines`, { lines: lines.map((l) => ({ id: l.id, countedQuantity: values[l.id] === '' || values[l.id] === undefined ? null : Number(values[l.id]), notes: null })) });
      await qc.invalidateQueries({ queryKey: ['count', id] });
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function loadProposals() {
    if (open && !(await save())) return;
    try {
      const r = await api.get<{ proposals: any[] }>(`/inventory/counts/${id}/proposals`);
      setProposals(r.proposals);
    } catch (e) {
      setErr(e);
    }
  }
  async function confirm() {
    setConfirming(true);
    setErr(null);
    try {
      await api.post(`/inventory/counts/${id}/confirm`, { confirm: true, reason }, { idempotencyKey: newIdempotencyKey() });
      setProposals(null);
      qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    } finally {
      setConfirming(false);
    }
  }
  async function addLine() {
    setErr(null);
    try {
      await api.post(`/inventory/counts/${id}/lines`, { ...nl, sizeId: nl.sizeId || null, locationId: nl.locationId || null, countedQuantity: Number(nl.countedQuantity) });
      setExtra(false);
      qc.invalidateQueries({ queryKey: ['count', id] });
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <div>
      <PageHeader
        back={{ to: '/inventario/contagens', label: 'Contagens' }}
        title={c.name}
        subtitle={`${[c.location_name, c.item_type_name].filter(Boolean).join(' · ') || 'Todo o armazém'} · criada por ${c.created_by_name} em ${fmtDateTime(c.created_at)}`}
        actions={
          open && (
            <>
              <Button variant="secondary" onClick={() => setExtra(true)}>Artigo encontrado não registado</Button>
              <Button variant="secondary" onClick={save} loading={saving}>Guardar contagem</Button>
              <Button onClick={loadProposals}>Ver diferenças</Button>
              <Button variant="ghost" onClick={() => setCancel(true)}>Cancelar contagem</Button>
            </>
          )
        }
      />
      {c.status !== 'em_curso' && <p className="mb-3 rounded bg-slate-100 p-3 text-sm">Contagem {c.status === 'confirmada' ? `confirmada por ${c.confirmed_by_name} em ${fmtDateTime(c.confirmed_at)}. Motivo: ${c.reason}` : 'cancelada'}.</p>}
      <ErrorBox error={err} />
      <Card>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Artigo</th>
                <th>Tamanho</th>
                <th>Conservação</th>
                <th>Estado</th>
                <th>Localização</th>
                <th className="text-right">Registado</th>
                <th className="text-right">Contado</th>
                {c.status === 'confirmada' && <th className="text-right">Ajuste</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.item_type_name} {l.garment_code && <span className="font-mono text-xs">{l.garment_code}</span>} {l.inscription && <span className="text-xs">«{l.inscription}»</span>}
                  </td>
                  <td>{l.size_label ?? '—'}</td>
                  <td>{conditionLabel(l.condition)}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td>{l.location_name ?? '—'}</td>
                  <td className="text-right tabular-nums">{l.kind === 'peca' ? (l.current_status === l.status ? 'presente' : <Badge tone="grey">mudou de estado</Badge>) : l.current_quantity}</td>
                  <td className="text-right">
                    {open ? (
                      l.kind === 'peca' ? (
                        <select className="input w-32" aria-label="Peça encontrada?" value={values[l.id] ?? ''} onChange={(e) => setValues({ ...values, [l.id]: e.target.value })}>
                          <option value="">Por contar</option>
                          <option value="1">Encontrada</option>
                          <option value="0">Não encontrada</option>
                        </select>
                      ) : (
                        <input className="input w-24 text-right" type="number" min={0} aria-label="Quantidade contada" value={values[l.id] ?? ''} onChange={(e) => setValues({ ...values, [l.id]: e.target.value })} />
                      )
                    ) : l.counted_quantity === null ? '—' : l.kind === 'peca' ? (l.counted_quantity ? 'Encontrada' : 'Não encontrada') : l.counted_quantity}
                  </td>
                  {c.status === 'confirmada' && <td className="text-right">{l.applied_delta ? <Badge tone={l.applied_delta > 0 ? 'green' : 'red'}>{l.applied_delta > 0 ? `+${l.applied_delta}` : l.applied_delta}</Badge> : ''}</td>}
                </tr>
              ))}
              {!lines.length && (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-slate-500">Sem artigos no âmbito desta contagem.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <Modal open={!!proposals} onClose={() => setProposals(null)} title="Propostas de ajuste" wide footer={proposals?.length && can('inventory.adjust') ? <Button onClick={confirm} loading={confirming} disabled={reason.trim().length < 3}>Confirmar ajustes</Button> : undefined}>
        {proposals && !proposals.length ? (
          <p className="text-sm text-emerald-800">Não há diferenças entre o contado e o registado. Pode confirmar para marcar os artigos como verificados.</p>
        ) : (
          <ul className="divide-y text-sm">
            {proposals?.map((p) => (
              <li key={p.id} className="py-1.5">
                {p.item_type_name} {p.size_label ?? ''} {p.garment_code ?? ''} · {conditionLabel(p.condition)} · {STATUS_LABELS[p.status as Status]}: registado {p.current_quantity}, contado {p.counted_quantity} →{' '}
                <strong className={p.delta > 0 ? 'text-emerald-700' : 'text-red-700'}>{p.kind === 'peca' ? 'marcar como extraviada' : p.delta > 0 ? `+${p.delta}` : p.delta}</strong>
              </li>
            ))}
          </ul>
        )}
        {can('inventory.adjust') ? (
          <>
            <TextArea className="mt-3" label="Motivo dos ajustes (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} />
            {!proposals?.length && <Button className="mt-3" onClick={confirm} loading={confirming} disabled={reason.trim().length < 3}>Confirmar contagem</Button>}
          </>
        ) : (
          <p className="mt-3 text-sm text-amber-800">A confirmação dos ajustes está reservada a administradores.</p>
        )}
        <ErrorBox error={err} />
      </Modal>
      <Modal open={extra} onClose={() => setExtra(false)} title="Artigo encontrado não registado" footer={<Button onClick={addLine} disabled={!nl.itemTypeId}>Adicionar</Button>}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TypeSizePicker types={types.active.filter((t) => t.stock_enabled && t.tracking_mode === 'quantidade')} typeId={nl.itemTypeId} sizeId={nl.sizeId} onChange={(t, s) => setNl({ ...nl, itemTypeId: t, sizeId: s })} />
          <SelectInput label="Conservação" value={nl.condition} onChange={(e) => setNl({ ...nl, condition: e.target.value })} options={CONDITIONS.map((x) => ({ value: x, label: CONDITION_LABELS[x] }))} />
          <SelectInput label="Estado" value={nl.status} onChange={(e) => setNl({ ...nl, status: e.target.value })} options={['disponivel', 'reservado', 'pendente_inspecao', 'quarentena'].map((s) => ({ value: s, label: STATUS_LABELS[s as Status] }))} />
          <SelectInput label="Localização" value={nl.locationId} onChange={(e) => setNl({ ...nl, locationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Sem localização" />
          <TextInput label="Quantidade contada" type="number" min={0} value={nl.countedQuantity} onChange={(e) => setNl({ ...nl, countedQuantity: e.target.value })} />
          <p className="sm:col-span-2 text-xs text-slate-500">Peças individuais não registadas devem ser introduzidas em «Entrada de stock», para receberem código próprio.</p>
        </div>
      </Modal>
      <ConfirmDialog
        open={cancel}
        danger
        title="Cancelar contagem"
        message="A contagem é cancelada sem qualquer ajuste ao stock."
        onClose={() => setCancel(false)}
        onConfirm={async () => {
          try {
            await api.post(`/inventory/counts/${id}/cancel`);
            setCancel(false);
            qc.invalidateQueries();
          } catch (e) {
            setErr(e);
          }
        }}
      />
    </div>
  );
}
