// Registo do fardamento que o músico já tem em sua posse (anterior à aplicação).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, download, newIdempotencyKey } from '../api/client';
import { CONDITIONS, CONDITION_LABELS } from '../../shared/domain';
import { useItemTypes } from '../lib/hooks';
import { todayIso } from '../lib/format';
import { Button, ErrorBox, Modal, TextInput } from './ui';

interface Req {
  id: string;
  item_type_id: string;
  size_id: string | null;
  status: string;
  quantity_requested: number;
  quantity_delivered: number;
}

interface Row {
  itemTypeId: string;
  quantity: string;
  sizeId: string;
  condition: string;
  inscription: string;
  countsForRequest: boolean;
}

export function ExistingUniformModal({ open, onClose, musicianId, musicianName, requests }: { open: boolean; onClose: () => void; musicianId: string; musicianName: string; requests: Req[] }) {
  const qc = useQueryClient();
  const types = useItemTypes();
  const stockTypes = types.active.filter((t) => t.stock_enabled);
  const initial = useMemo<Row[]>(
    () => stockTypes.map((t) => ({ itemTypeId: t.id, quantity: '0', sizeId: '', condition: 'bom', inscription: '', countsForRequest: false })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockTypes.length],
  );
  const [rows, setRows] = useState<Row[] | null>(null);
  const data = rows ?? initial;
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key] = useState(newIdempotencyKey);
  const [result, setResult] = useState<{ id: string; garments: { id: string; code: string }[] } | null>(null);
  const upd = (i: number, patch: Partial<Row>) => setRows(data.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const openRequest = (itemTypeId: string, sizeId: string) => {
    const list = requests.filter((r) => r.item_type_id === itemTypeId && r.status === 'ativa' && r.quantity_delivered < r.quantity_requested);
    return list.find((r) => (r.size_id ?? '') === sizeId) ?? list.find((r) => !r.size_id) ?? list[0] ?? null;
  };

  async function save() {
    const items = data
      .filter((r) => Number(r.quantity) > 0)
      .map((r) => {
        const req = r.countsForRequest ? openRequest(r.itemTypeId, r.sizeId) : null;
        return {
          itemTypeId: r.itemTypeId,
          sizeId: r.sizeId || null,
          condition: r.condition,
          quantity: Number(r.quantity),
          inscriptions: r.inscription ? Array.from({ length: Number(r.quantity) }, () => r.inscription) : undefined,
          requestId: req?.id ?? null,
        };
      });
    if (!items.length) {
      setErr(new Error('Indique a quantidade de pelo menos um artigo.'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ id: string; garments: { id: string; code: string }[] }>('/deliveries/existing', { musicianId, date, items }, { idempotencyKey: key });
      qc.invalidateQueries();
      setResult(r);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setRows(null);
    setResult(null);
    onClose();
  };

  if (result)
    return (
      <Modal open={open} onClose={close} title="Fardamento registado">
        <p className="text-sm text-emerald-800">O fardamento de {musicianName} ficou registado como atribuído ao músico.</p>
        {result.garments.length > 0 && (
          <>
            <p className="mt-3 text-sm">Códigos atribuídos:</p>
            <p className="mt-1 flex flex-wrap gap-1">
              {result.garments.map((g) => (
                <Link key={g.id} to={`/inventario/pecas/${g.id}`} className="rounded bg-marinho-50 px-2 py-0.5 font-mono text-sm underline" onClick={close}>
                  {g.code}
                </Link>
              ))}
            </p>
            <Button className="mt-3" onClick={() => download('/reports/labels.pdf', { ids: result.garments.map((g) => g.id).join(',') })}>
              Imprimir etiquetas QR
            </Button>
          </>
        )}
      </Modal>
    );

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={`Fardamento que ${musicianName} já tem`}
      footer={
        <Button onClick={save} loading={busy}>
          Registar fardamento
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Registe as peças que o músico <strong>já tem em sua posse</strong>. Cada peça recebe um código (e etiqueta QR) e fica atribuída ao músico, sem sair do stock da banda. Só a quantidade é obrigatória.
      </p>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Artigo</th>
              <th>
                Quantidade <span className="text-red-600">*</span>
              </th>
              <th>
                Tamanho <span className="font-normal normal-case text-slate-500">(opcional)</span>
              </th>
              <th>Estado</th>
              <th>Nome inscrito</th>
              <th>Pedido</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => {
              const t = types.byId[r.itemTypeId];
              if (!t) return null;
              const qty = Number(r.quantity) || 0;
              const req = openRequest(t.id, r.sizeId);
              const missing = req ? req.quantity_requested - req.quantity_delivered : 0;
              return (
                <tr key={t.id} className={qty > 0 ? 'bg-marinho-50/50' : ''}>
                  <td className="whitespace-nowrap font-medium">{t.name}</td>
                  <td>
                    <input className="input !w-20" type="number" min={0} max={50} aria-label={`Quantidade de ${t.name}`} value={r.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} />
                  </td>
                  <td className="min-w-40">
                    {t.has_size ? (
                      <select className="input" aria-label={`Tamanho de ${t.name}`} value={r.sizeId} onChange={(e) => upd(i, { sizeId: e.target.value })}>
                        <option value="">— não sei —</option>
                        {t.sizes.filter((s) => s.active).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-slate-500">sem tamanho</span>
                    )}
                  </td>
                  <td>
                    <select className="input min-w-32" aria-label={`Estado de ${t.name}`} value={r.condition} onChange={(e) => upd(i, { condition: e.target.value })}>
                      {CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {CONDITION_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {t.allows_inscription ? (
                      <input className="input min-w-36" aria-label={`Nome inscrito em ${t.name}`} value={r.inscription} onChange={(e) => upd(i, { inscription: e.target.value })} placeholder="Opcional" />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {req ? (
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={r.countsForRequest && qty <= missing} disabled={qty > missing || qty === 0} onChange={(e) => upd(i, { countsForRequest: e.target.checked })} />
                        conta para o pedido (faltam {missing})
                      </label>
                    ) : (
                      <span className="text-slate-400">sem pedido</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 max-w-xs">
        <TextInput label="Data do registo" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        «Conta para o pedido»: marque se esta peça já satisfaz o que o músico pediu (deixa de aparecer em «falta entregar»). Se forem peças antigas que o músico vai devolver, deixe por marcar.
      </p>
      <div className="mt-2">
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
