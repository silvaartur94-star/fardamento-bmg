// Formulários reutilizados: músico e necessidade de fardamento.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { MUSICIAN_KIND_LABELS, MUSICIAN_STATUS_LABELS, REQUEST_STATUS_LABELS, SHOE_REQUEST_STATUSES } from '../../shared/domain';
import { useItemTypes } from '../lib/hooks';
import { todayIso } from '../lib/format';
import { Button, Checkbox, ErrorBox, Modal, SelectInput, TextArea, TextInput } from './ui';
import { TypeSizePicker } from './domain';

export interface MusicianFormValue {
  fullName: string;
  internalCode: string;
  kind: 'banda' | 'convidado';
  status: 'ativo' | 'inativo' | 'arquivado';
  contact: string;
  originBand: string;
  notes: string;
}

export function MusicianModal({
  open,
  onClose,
  initial,
  id,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<MusicianFormValue>;
  id?: string;
  onSaved?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<MusicianFormValue>({ fullName: '', internalCode: '', kind: 'banda', status: 'ativo', contact: '', originBand: '', notes: '', ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDup, setConfirmDup] = useState(false);
  const fe = error instanceof ApiError ? error.fieldErrors : {};

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, confirmDuplicate: confirmDup || undefined };
      const r = id ? (await api.patch<{ ok: true }>(`/musicians/${id}`, body), { id }) : await api.post<{ id: string }>('/musicians', body);
      qc.invalidateQueries({ queryKey: ['musicians'] });
      qc.invalidateQueries({ queryKey: ['musician'] });
      onSaved?.(r.id);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const isDup = error instanceof ApiError && error.code === 'POSSIVEL_DUPLICADO';
  const upd = (k: keyof MusicianFormValue) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={id ? 'Editar músico' : 'Novo músico'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => submit()} loading={busy} disabled={isDup && !confirmDup}>
            Guardar
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextInput className="sm:col-span-2" label="Nome completo" value={f.fullName} onChange={upd('fullName')} required error={fe.fullName} autoFocus />
        <TextInput label="Número / código interno" value={f.internalCode} onChange={upd('internalCode')} hint="Opcional; único quando preenchido." error={fe.internalCode} />
        <SelectInput label="Tipo" value={f.kind} onChange={upd('kind')} options={Object.entries(MUSICIAN_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
        <SelectInput label="Estado" value={f.status} onChange={upd('status')} options={Object.entries(MUSICIAN_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextInput label="Contacto" value={f.contact} onChange={upd('contact')} hint="Opcional." />
        {f.kind === 'convidado' && <TextInput className="sm:col-span-2" label="Banda de origem" value={f.originBand} onChange={upd('originBand')} />}
        <TextArea className="sm:col-span-2" label="Observações" value={f.notes} onChange={upd('notes')} />
        <div className="sm:col-span-2 space-y-2">
          <ErrorBox error={error} />
          {isDup && <Checkbox label="Confirmo que se trata de uma pessoa diferente" checked={confirmDup} onChange={setConfirmDup} />}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export interface RequestRowLite {
  id: string;
  item_type_id: string;
  size_id: string | null;
  size_text: string | null;
  quantity_requested: number;
  quantity_ordered: number;
  quantity_received: number;
  quantity_delivered: number;
  return_expected: number;
  status: string;
  notes: string | null;
  procurement_enabled: number;
}

export function RequestModal({ open, onClose, musicianId, existing }: { open: boolean; onClose: () => void; musicianId: string; existing?: RequestRowLite }) {
  const qc = useQueryClient();
  const types = useItemTypes();
  const [f, setF] = useState({
    itemTypeId: existing?.item_type_id ?? '',
    sizeId: existing?.size_id ?? '',
    sizeText: existing?.size_text ?? '',
    quantity: String(existing?.quantity_requested ?? 1),
    quantityOrdered: String(existing?.quantity_ordered ?? 0),
    quantityReceived: String(existing?.quantity_received ?? 0),
    returnExpected: String(existing?.return_expected ?? 0),
    status: existing?.status ?? '',
    notes: existing?.notes ?? '',
    requestedAt: todayIso(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const type = types.byId[f.itemTypeId];
  const procurement = type ? Boolean(type.procurement_enabled) : true;
  const fe = error instanceof ApiError ? error.fieldErrors : {};

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api.patch(`/requests/${existing.id}`, {
          sizeId: f.sizeId || null,
          sizeText: f.sizeText || null,
          quantity: Number(f.quantity),
          returnExpected: Number(f.returnExpected),
          notes: f.notes || null,
          ...(procurement ? { quantityOrdered: Number(f.quantityOrdered), quantityReceived: Number(f.quantityReceived) } : {}),
          ...(f.status ? { status: f.status } : {}),
        });
      } else {
        await api.post('/requests', {
          musicianId,
          itemTypeId: f.itemTypeId,
          sizeId: f.sizeId || null,
          sizeText: f.sizeText || null,
          quantity: Number(f.quantity),
          returnExpected: Number(f.returnExpected),
          requestedAt: f.requestedAt,
          notes: f.notes || null,
          ...(f.status ? { status: f.status } : {}),
        });
      }
      qc.invalidateQueries({ queryKey: ['musician', musicianId] });
      qc.invalidateQueries({ queryKey: ['requests'] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const statusOptions = procurement ? [{ value: 'ativa', label: 'Ativa' }, { value: 'cancelada', label: 'Cancelada' }] : SHOE_REQUEST_STATUSES.map((s) => ({ value: s, label: REQUEST_STATUS_LABELS[s] }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Editar necessidade' : 'Nova necessidade de fardamento'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={busy} disabled={!f.itemTypeId}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {existing ? (
          <p className="sm:col-span-2 text-sm">
            Artigo: <strong>{type?.name}</strong>
          </p>
        ) : null}
        {existing ? (
          type?.has_size ? (
            <SelectInput label="Tamanho" value={f.sizeId} onChange={(e) => setF({ ...f, sizeId: e.target.value })} options={(type?.sizes ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.label }))} placeholder="Desconhecido" />
          ) : <div />
        ) : (
          <TypeSizePicker types={types.active} typeId={f.itemTypeId} sizeId={f.sizeId} onChange={(t, s) => setF({ ...f, itemTypeId: t, sizeId: s })} />
        )}
        {type?.has_size ? <TextInput label="Tamanho indicado (texto original)" value={f.sizeText} onChange={(e) => setF({ ...f, sizeText: e.target.value })} hint="Ex.: 42,5 — preserva o valor exatamente como foi indicado." /> : null}
        <TextInput label="Quantidade pretendida" type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} error={fe.quantity} required />
        {procurement && <TextInput label="Peças antigas a devolver" type="number" min={0} value={f.returnExpected} onChange={(e) => setF({ ...f, returnExpected: e.target.value })} hint="Peças antigas deste artigo que o músico deve entregar." />}
        {existing && procurement && (
          <>
            <TextInput label="Quantidade encomendada" type="number" min={0} value={f.quantityOrdered} onChange={(e) => setF({ ...f, quantityOrdered: e.target.value })} />
            <TextInput label="Quantidade recebida para distribuição" type="number" min={0} value={f.quantityReceived} onChange={(e) => setF({ ...f, quantityReceived: e.target.value })} />
          </>
        )}
        {(existing || !procurement) && <SelectInput label="Estado" value={f.status || (procurement ? 'ativa' : 'por_avaliar')} onChange={(e) => setF({ ...f, status: e.target.value })} options={statusOptions} />}
        {!existing && <TextInput label="Data do levantamento" type="date" value={f.requestedAt} onChange={(e) => setF({ ...f, requestedAt: e.target.value })} />}
        <TextArea className="sm:col-span-2" label="Observações" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        {!procurement && type && <p className="sm:col-span-2 rounded bg-sky-50 p-2 text-xs text-sky-900">{type.name}: apenas registo de necessidade — não gera encomenda, aquisição nem movimento de stock.</p>}
        <div className="sm:col-span-2">
          <ErrorBox error={error} />
        </div>
      </div>
    </Modal>
  );
}
