import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, INVENTORY_TRANSITIONS, STATUS_LABELS, type Status } from '../../shared/domain';
import { useAuth } from '../lib/auth';
import { useItemTypes, useLocations } from '../lib/hooks';
import { Button, ErrorBox, Modal, SelectInput, TextArea, TextInput } from './ui';
import { TypeSizePicker } from './domain';

const WRITEOFF = ['abatido', 'extraviado', 'rejeitado'];

/** Mudança de estado / transferência de uma peça individual ou de um lote por quantidade. */
export function MoveModal({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: { kind: 'garment'; id: string; code: string; status: Status; condition: string; locationId: string | null } | { kind: 'balance'; bucketKey: string; label: string; status: Status; condition: string; locationId: string | null; quantity: number };
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const locations = useLocations();
  const options = [target.status, ...(INVENTORY_TRANSITIONS[target.status] ?? [])].filter((s) => !WRITEOFF.includes(s) || can('inventory.writeoff'));
  const [f, setF] = useState({ toStatus: target.status as string, toLocationId: target.locationId ?? '', toCondition: target.condition, quantity: target.kind === 'balance' ? String(target.quantity) : '1', reason: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key] = useState(newIdempotencyKey);
  const needsReason = WRITEOFF.includes(f.toStatus) || (f.toStatus === target.status && f.toCondition !== target.condition);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const common = { toStatus: f.toStatus, toLocationId: f.toLocationId || null, toCondition: f.toCondition, reason: f.reason || null, notes: f.notes || null };
      if (target.kind === 'garment') await api.post(`/inventory/garments/${target.id}/transition`, common, { idempotencyKey: key });
      else await api.post('/inventory/balances/move', { ...common, bucketKey: target.bucketKey, quantity: Number(f.quantity) }, { idempotencyKey: key });
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={target.kind === 'garment' ? `Movimentar peça ${target.code}` : `Movimentar ${target.label}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={WRITEOFF.includes(f.toStatus) ? 'danger' : 'primary'} onClick={submit} loading={busy} disabled={needsReason && !f.reason}>
            Registar movimento
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <p className="sm:col-span-2 text-sm text-slate-600">
          Estado atual: <strong>{STATUS_LABELS[target.status]}</strong>
          {target.kind === 'balance' && ` · ${target.quantity} unidade(s)`}
        </p>
        <SelectInput label="Novo estado" value={f.toStatus} onChange={(e) => setF({ ...f, toStatus: e.target.value })} options={options.map((s) => ({ value: s, label: s === target.status ? `${STATUS_LABELS[s]} (manter)` : STATUS_LABELS[s] }))} />
        <SelectInput label="Localização" value={f.toLocationId} onChange={(e) => setF({ ...f, toLocationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Sem localização" />
        <SelectInput label="Estado de conservação" value={f.toCondition} onChange={(e) => setF({ ...f, toCondition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
        {target.kind === 'balance' && <TextInput label="Quantidade" type="number" min={1} max={target.quantity} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />}
        <TextArea className="sm:col-span-2" label={needsReason ? 'Motivo (obrigatório)' : 'Motivo'} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        {WRITEOFF.includes(f.toStatus) && <p className="sm:col-span-2 rounded bg-red-50 p-2 text-xs text-red-800">O abate/extravio é definitivo: o artigo deixa o inventário ativo. O registo e o histórico são preservados.</p>}
        <div className="sm:col-span-2">
          <ErrorBox error={err} />
        </div>
      </div>
    </Modal>
  );
}

/** Ajuste manual de quantidades (administrador). */
export function AdjustModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const types = useItemTypes();
  const locations = useLocations();
  const [f, setF] = useState({ itemTypeId: '', sizeId: '', condition: 'bom', locationId: '', status: 'disponivel', delta: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key] = useState(newIdempotencyKey);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/inventory/adjust', { ...f, sizeId: f.sizeId || null, locationId: f.locationId || null, delta: Number(f.delta) }, { idempotencyKey: key });
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajuste de inventário (quantidades)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={busy} disabled={!f.itemTypeId || !f.delta || f.reason.length < 3}>
            Registar ajuste
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TypeSizePicker types={types.active.filter((t) => t.tracking_mode === 'quantidade' && t.stock_enabled)} typeId={f.itemTypeId} sizeId={f.sizeId} onChange={(t, s) => setF({ ...f, itemTypeId: t, sizeId: s })} />
        <SelectInput label="Conservação" value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
        <SelectInput label="Estado" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao'].map((s) => ({ value: s, label: STATUS_LABELS[s as Status] }))} />
        <SelectInput label="Localização" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Sem localização" />
        <TextInput label="Diferença (+ entrada / − saída)" type="number" value={f.delta} onChange={(e) => setF({ ...f, delta: e.target.value })} hint="Ex.: -2 retira duas unidades." />
        <TextArea className="sm:col-span-2" label="Motivo (obrigatório)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <p className="sm:col-span-2 text-xs text-slate-500">Para peças com código use o movimento individual da peça. Os ajustes ficam no histórico e na auditoria e não podem ser apagados (apenas estornados).</p>
        <div className="sm:col-span-2">
          <ErrorBox error={err} />
        </div>
      </div>
    </Modal>
  );
}
