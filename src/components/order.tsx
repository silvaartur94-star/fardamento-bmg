// Pedido de fardamento do músico (todos os artigos num só ecrã) e medidas.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useItemTypes } from '../lib/hooks';
import { todayIso } from '../lib/format';
import { Button, ErrorBox, Modal, TextArea, TextInput } from './ui';

export interface OrderRequest {
  id: string;
  item_type_id: string;
  size_id: string | null;
  size_text: string | null;
  quantity_requested: number;
  quantity_delivered: number;
  return_expected: number;
  status: string;
  notes: string | null;
}

interface Row {
  key: string;
  requestId?: string;
  itemTypeId: string;
  sizeId: string;
  sizeText: string;
  quantity: string;
  returnExpected: string;
  notes: string;
  delivered: number;
}

export function OrderModal({ open, onClose, musicianId, musicianName, requests }: { open: boolean; onClose: () => void; musicianId: string; musicianName: string; requests: OrderRequest[] }) {
  const qc = useQueryClient();
  const types = useItemTypes();
  const initial = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    for (const t of types.active) {
      const existing = requests.filter((r) => r.item_type_id === t.id && r.status !== 'cancelada' && r.status !== 'resolvida');
      if (existing.length) {
        for (const r of existing) {
          rows.push({
            key: r.id,
            requestId: r.id,
            itemTypeId: t.id,
            sizeId: r.size_id ?? '',
            sizeText: r.size_text ?? '',
            quantity: String(r.quantity_requested),
            returnExpected: String(r.return_expected),
            notes: r.notes ?? '',
            delivered: r.quantity_delivered,
          });
        }
      } else {
        rows.push({ key: `novo-${t.id}`, itemTypeId: t.id, sizeId: '', sizeText: '', quantity: '0', returnExpected: '0', notes: '', delivered: 0 });
      }
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.active.length, requests]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const data = rows ?? initial;
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const upd = (key: string, patch: Partial<Row>) => setRows(data.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addSize = (itemTypeId: string) => {
    const idx = data.map((r) => r.itemTypeId).lastIndexOf(itemTypeId);
    const copy = [...data];
    copy.splice(idx + 1, 0, { key: `novo-${itemTypeId}-${Date.now()}`, itemTypeId, sizeId: '', sizeText: '', quantity: '1', returnExpected: '0', notes: '', delivered: 0 });
    setRows(copy);
  };

  async function save() {
    const missingQty = data.find((r) => !r.requestId && (Number(r.quantity) || 0) === 0 && (r.sizeId || r.sizeText || Number(r.returnExpected) > 0 || r.notes));
    if (missingQty) {
      setErr(new Error(`Indique a quantidade de ${types.byId[missingQty.itemTypeId]?.name ?? 'artigo'} (o tamanho é opcional).`));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const items = data
        .filter((r) => r.requestId || Number(r.quantity) > 0)
        .map((r) => ({
          requestId: r.requestId ?? null,
          itemTypeId: r.itemTypeId,
          sizeId: r.sizeId || null,
          sizeText: r.sizeText || null,
          quantity: Math.max(0, Number(r.quantity) || 0),
          returnExpected: Math.max(0, Number(r.returnExpected) || 0),
          notes: r.notes || null,
        }));
      await api.put(`/musicians/${musicianId}/order`, { items, requestedAt: date });
      qc.invalidateQueries({ queryKey: ['musician', musicianId] });
      qc.invalidateQueries({ queryKey: ['musicians'] });
      qc.invalidateQueries({ queryKey: ['requests'] });
      setRows(null);
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
      onClose={() => {
        setRows(null);
        onClose();
      }}
      wide
      title={`Pedido de fardamento — ${musicianName}`}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">Só a quantidade é obrigatória. Quantidade 0 = não precisa (num pedido já registado, remove-o).</span>
          <Button onClick={save} loading={busy}>
            Guardar pedido
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Indique, para cada artigo, a <strong>quantidade</strong> que o músico precisa (obrigatória) e, se já souber, o <strong>tamanho</strong> (opcional — pode ser definido mais tarde). Indique também quantas peças <strong>antigas</strong> desse artigo tem de devolver.
      </p>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Artigo</th>
              <th>Tamanho <span className="font-normal normal-case text-slate-500">(opcional)</span></th>
              <th>Quantidade <span className="text-red-600">*</span></th>
              <th>Antigas a devolver</th>
              <th>Observações</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => {
              const t = types.byId[r.itemTypeId];
              if (!t) return null;
              const firstOfType = data.findIndex((x) => x.itemTypeId === r.itemTypeId) === i;
              const qty = Number(r.quantity) || 0;
              return (
                <tr key={r.key} className={qty > 0 ? 'bg-marinho-50/50' : ''}>
                  <td className="whitespace-nowrap font-medium">
                    {firstOfType ? t.name : <span className="pl-3 text-slate-500">↳ outro tamanho</span>}
                    {!t.procurement_enabled && <span className="block text-xs font-normal text-violet-700">só necessidade (sem aquisição)</span>}
                  </td>
                  <td className="min-w-44">
                    {t.has_size ? (
                      <div className="flex flex-col gap-1">
                        <select className="input" aria-label={`Tamanho de ${t.name}`} value={r.sizeId} disabled={r.delivered > 0} onChange={(e) => upd(r.key, { sizeId: e.target.value })}>
                          <option value="">— a definir —</option>
                          {t.sizes.filter((s) => s.active || s.id === r.sizeId).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                        {(!t.procurement_enabled || r.sizeText) && (
                          <input className="input" placeholder="ou escreva (ex.: 42,5)" aria-label={`Tamanho indicado de ${t.name}`} value={r.sizeText} onChange={(e) => upd(r.key, { sizeText: e.target.value })} />
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">sem tamanho</span>
                    )}
                  </td>
                  <td>
                    <input className="input w-20" type="number" min={r.delivered} max={100} aria-label={`Quantidade de ${t.name}`} value={r.quantity} onChange={(e) => upd(r.key, { quantity: e.target.value })} />
                    {r.delivered > 0 && <span className="block text-xs text-slate-500">já entregue {r.delivered}</span>}
                  </td>
                  <td>
                    {t.procurement_enabled ? (
                      <input className="input w-20" type="number" min={0} max={100} aria-label={`Peças antigas de ${t.name} a devolver`} value={r.returnExpected} onChange={(e) => upd(r.key, { returnExpected: e.target.value })} />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    <input className="input min-w-40" aria-label={`Observações de ${t.name}`} value={r.notes} onChange={(e) => upd(r.key, { notes: e.target.value })} />
                  </td>
                  <td>
                    {firstOfType && t.has_size ? (
                      <button className="whitespace-nowrap text-xs text-marinho-700 underline" onClick={() => addSize(t.id)}>
                        + tamanho
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 max-w-xs">
        <TextInput label="Data do pedido / levantamento" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="mt-2">
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export interface Measurements {
  height_cm: number | null;
  chest_cm: number | null;
  waist_cm: number | null;
  hips_cm: number | null;
  shoulder_cm: number | null;
  sleeve_cm: number | null;
  inseam_cm: number | null;
  neck_cm: number | null;
  head_cm: number | null;
  shoe_size: string | null;
  notes: string | null;
  measured_at: string | null;
  updated_by_name?: string | null;
}

export const MEASUREMENT_FIELDS: [keyof Measurements, string, string][] = [
  ['height_cm', 'heightCm', 'Altura'],
  ['chest_cm', 'chestCm', 'Peito'],
  ['waist_cm', 'waistCm', 'Cintura'],
  ['hips_cm', 'hipsCm', 'Anca'],
  ['shoulder_cm', 'shoulderCm', 'Ombros'],
  ['sleeve_cm', 'sleeveCm', 'Comprimento de manga'],
  ['inseam_cm', 'inseamCm', 'Entrepernas (perna)'],
  ['neck_cm', 'neckCm', 'Pescoço (colarinho)'],
  ['head_cm', 'headCm', 'Cabeça (boné)'],
];

export function MeasurementsModal({ open, onClose, musicianId, current }: { open: boolean; onClose: () => void; musicianId: string; current: Measurements | null }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [col, , ] of MEASUREMENT_FIELDS) o[col] = current?.[col] != null ? String(current[col]).replace('.', ',') : '';
    o.shoe_size = current?.shoe_size ?? '';
    o.notes = current?.notes ?? '';
    o.measured_at = current?.measured_at ?? todayIso();
    return o;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { shoeSize: f.shoe_size || null, notes: f.notes || null, measuredAt: f.measured_at || null };
      for (const [col, key] of MEASUREMENT_FIELDS) body[key] = f[col] ? Number(f[col].replace(',', '.')) : null;
      await api.put(`/musicians/${musicianId}/measurements`, body);
      qc.invalidateQueries({ queryKey: ['musician', musicianId] });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Medidas do músico" footer={<Button onClick={save} loading={busy}>Guardar medidas</Button>}>
      <p className="mb-3 text-sm text-slate-600">Medidas em centímetros (opcionais). Servem de apoio à escolha dos tamanhos e à confeção.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {MEASUREMENT_FIELDS.map(([col, , label]) => (
          <TextInput key={col} label={`${label} (cm)`} inputMode="decimal" value={f[col]} onChange={(e) => setF({ ...f, [col]: e.target.value })} />
        ))}
        <TextInput label="N.º de sapato" value={f.shoe_size} onChange={(e) => setF({ ...f, shoe_size: e.target.value })} />
        <TextInput label="Data das medidas" type="date" value={f.measured_at} onChange={(e) => setF({ ...f, measured_at: e.target.value })} />
        <TextArea className="col-span-2 sm:col-span-3" label="Observações" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
      <div className="mt-2">
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
