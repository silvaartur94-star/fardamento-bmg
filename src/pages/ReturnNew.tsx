import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, type Condition } from '../../shared/domain';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { TypeSizePicker } from '../components/domain';
import { MusicianPicker, type MusicianLite } from '../components/pickers';
import { conditionLabel, todayIso } from '../lib/format';
import { useItemTypes, useLocations, useSafeMutation } from '../lib/hooks';

interface Line {
  key: string;
  itemTypeId: string;
  label: string;
  garmentId?: string;
  deliveryLineId?: string;
  sizeId?: string | null;
  sizeText?: string | null;
  inscription?: string | null;
  legacyCode?: string | null;
  quantity: number;
  maxQuantity?: number;
  observedCondition: Condition;
}

const condOptions = CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }));

export default function ReturnNew() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const types = useItemTypes();
  const locations = useLocations();
  const [musician, setMusician] = useState<MusicianLite | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [meta, setMeta] = useState({ receivedAt: todayIso(), initialObservations: '', notes: '', locationId: '' });
  const [nf, setNf] = useState({ itemTypeId: '', sizeId: '', sizeText: '', inscription: '', legacyCode: '', quantity: '1', observedCondition: 'bom' as Condition });

  const pre = sp.get('musico');
  const preQ = useQuery({ queryKey: ['musician-lite', pre], queryFn: () => api.get<{ musician: MusicianLite }>(`/musicians/${pre}`), enabled: !!pre && !musician });
  useEffect(() => {
    if (preQ.data && !musician) setMusician(preQ.data.musician);
  }, [preQ.data, musician]);
  const expected = useQuery({
    queryKey: ['musician', musician?.id],
    queryFn: () => api.get<{ typeSummary: { item_type_id: string; item_type_name: string; return_expected: number; returned: number; sizes: string | null }[] }>(`/musicians/${musician!.id}`),
    enabled: !!musician,
  });
  const returnables = useQuery({
    queryKey: ['returnables', musician?.id],
    queryFn: () => api.get<{ garments: any[]; deliveryLines: any[] }>(`/musicians/${musician!.id}/returnables`),
    enabled: !!musician,
  });

  const m = useSafeMutation(
    (_: void, key: string) =>
      api.post<{ id: string }>(
        '/returns',
        {
          musicianId: musician!.id,
          receivedAt: meta.receivedAt,
          initialObservations: meta.initialObservations || null,
          notes: meta.notes || null,
          lines: lines.map((l) => ({
            itemTypeId: l.itemTypeId,
            garmentId: l.garmentId ?? null,
            deliveryLineId: l.deliveryLineId ?? null,
            sizeId: l.sizeId ?? null,
            sizeText: l.sizeText ?? null,
            inscription: l.inscription ?? null,
            legacyCode: l.legacyCode ?? null,
            quantity: l.quantity,
            observedCondition: l.observedCondition,
            locationId: meta.locationId || null,
          })),
        },
        { idempotencyKey: key },
      ),
    { onSuccess: (r) => nav(`/recolhas/${r.id}`), invalidate: [['returns'], ['musician'], ['musicians'], ['alerts'], ['dashboard']] },
  );

  const addNew = () => {
    const t = types.byId[nf.itemTypeId];
    if (!t) return;
    const size = t.sizes.find((s) => s.id === nf.sizeId)?.label;
    setLines([
      ...lines,
      {
        key: crypto.randomUUID(),
        itemTypeId: t.id,
        label: `${t.name} ${size ?? nf.sizeText ?? ''} ${nf.inscription ? `«${nf.inscription}»` : ''} (sem registo anterior)`,
        sizeId: nf.sizeId || null,
        sizeText: nf.sizeText || null,
        inscription: nf.inscription || null,
        legacyCode: nf.legacyCode || null,
        quantity: Math.max(1, Number(nf.quantity) || 1),
        observedCondition: nf.observedCondition,
      },
    ]);
    setNf({ ...nf, inscription: '', legacyCode: '', quantity: '1' });
  };
  const nfType = types.byId[nf.itemTypeId];
  const usedGarments = new Set(lines.map((l) => l.garmentId));
  const usedDL = new Set(lines.map((l) => l.deliveryLineId));

  return (
    <div>
      <PageHeader back={{ to: '/recolhas', label: 'Recolhas' }} title="Recolha de fardamento antigo" subtitle="Registe as peças recebidas; o destino de cada uma é decidido na inspeção." />
      <div className="space-y-4">
        <Card title="1. Músico que devolve">{preQ.isLoading ? <Loading /> : <MusicianPicker value={musician} onChange={(v) => { setMusician(v); setLines([]); }} />}</Card>
        {musician && (
          <>
            <Card title="2. Peças atribuídas através da aplicação">
              {returnables.isLoading ? <Loading /> : (
                <>
                  {!returnables.data?.garments.length && !returnables.data?.deliveryLines.length && <p className="text-sm text-slate-500">Este músico não tem peças atribuídas registadas na aplicação. Use a secção seguinte para peças antigas sem registo.</p>}
                  <ul className="divide-y text-sm">
                    {returnables.data?.garments.filter((g) => !usedGarments.has(g.id)).map((g) => (
                      <li key={g.id} className="flex items-center justify-between py-1.5">
                        <span>
                          <span className="font-mono">{g.code}</span> {g.item_type_name} {g.size_label} {g.inscription && `«${g.inscription}»`}
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => setLines([...lines, { key: g.id, itemTypeId: g.item_type_id, garmentId: g.id, label: `${g.code} — ${g.item_type_name} ${g.size_label ?? ''}`, quantity: 1, observedCondition: g.condition }])}>
                          Adicionar
                        </Button>
                      </li>
                    ))}
                    {returnables.data?.deliveryLines.filter((d) => !usedDL.has(d.id)).map((d) => (
                      <li key={d.id} className="flex items-center justify-between py-1.5">
                        <span>
                          {d.outstanding} × {d.item_type_name} {d.size_label} <span className="text-xs text-slate-500">(entregue em {d.delivered_at.slice(0, 10)})</span>
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => setLines([...lines, { key: d.id, itemTypeId: d.item_type_id, deliveryLineId: d.id, sizeId: d.size_id, label: `${d.item_type_name} ${d.size_label ?? ''} (entrega anterior)`, quantity: d.outstanding, maxQuantity: d.outstanding, observedCondition: d.condition }])}>
                          Adicionar
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
            {(() => {
              const pending = (expected.data?.typeSummary ?? [])
                .map((t) => ({ ...t, missing: t.return_expected - t.returned - lines.filter((l) => l.itemTypeId === t.item_type_id && !l.garmentId && !l.deliveryLineId).reduce((a, l) => a + l.quantity, 0) }))
                .filter((t) => t.missing > 0);
              if (!pending.length) return null;
              return (
                <Card title="Fardamento antigo que o músico tem de devolver (segundo o pedido)">
                  <ul className="divide-y text-sm">
                    {pending.map((t) => (
                      <li key={t.item_type_id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span>
                          <strong>{t.missing}</strong> × {t.item_type_name} <span className="text-slate-500">(já devolvidas {t.returned} de {t.return_expected})</span>
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const type = types.byId[t.item_type_id];
                            setLines([
                              ...lines,
                              ...(type?.tracking_mode === 'individual'
                                ? Array.from({ length: t.missing }, (_, k) => ({ key: `${t.item_type_id}-${Date.now()}-${k}`, itemTypeId: t.item_type_id, label: `${t.item_type_name} antigo (sem registo anterior)`, quantity: 1, observedCondition: 'bom' as Condition }))
                                : [{ key: `${t.item_type_id}-${Date.now()}`, itemTypeId: t.item_type_id, label: `${t.item_type_name} antigo (sem registo anterior)`, quantity: t.missing, maxQuantity: t.missing, observedCondition: 'bom' as Condition }]),
                            ]);
                          }}
                        >
                          Adicionar à recolha
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-slate-500">Depois de adicionar, ajuste o estado observado de cada peça e, se souber, o tamanho e a inscrição na secção seguinte.</p>
                </Card>
              );
            })()}
            <Card title="3. Peças antigas sem registo (ex.: fardamento anterior à aplicação)">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TypeSizePicker types={types.active.filter((t) => t.stock_enabled)} typeId={nf.itemTypeId} sizeId={nf.sizeId} onChange={(t, s) => setNf({ ...nf, itemTypeId: t, sizeId: s })} />
                {nfType?.has_size ? <TextInput label="Tamanho indicado (se não constar da lista)" value={nf.sizeText} onChange={(e) => setNf({ ...nf, sizeText: e.target.value })} /> : null}
                {nfType?.allows_inscription ? <TextInput label="Inscrição existente (nome)" value={nf.inscription} onChange={(e) => setNf({ ...nf, inscription: e.target.value })} /> : null}
                {nfType?.tracking_mode === 'individual' && <TextInput label="Etiqueta/código antigo" value={nf.legacyCode} onChange={(e) => setNf({ ...nf, legacyCode: e.target.value })} hint="Opcional." />}
                <TextInput label="Quantidade" type="number" min={1} value={nf.quantity} onChange={(e) => setNf({ ...nf, quantity: e.target.value })} />
                <SelectInput label="Estado observado" value={nf.observedCondition} onChange={(e) => setNf({ ...nf, observedCondition: e.target.value as Condition })} options={condOptions} />
              </div>
              <Button className="mt-3" variant="secondary" disabled={!nf.itemTypeId} onClick={addNew}>
                Adicionar à recolha
              </Button>
              {nfType?.tracking_mode === 'individual' && <p className="mt-2 text-xs text-slate-500">Cada {nfType.name.toLowerCase()} recebe um código novo e único no inventário.</p>}
            </Card>
            <Card title={`Peças recebidas (${lines.reduce((a, l) => a + l.quantity, 0)})`}>
              {lines.length ? (
                <ul className="divide-y text-sm">
                  {lines.map((l, i) => (
                    <li key={l.key} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="flex-1">{l.label}</span>
                      {l.maxQuantity !== undefined && (
                        <input className="input w-20" type="number" min={1} max={l.maxQuantity} value={l.quantity} aria-label="Quantidade" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Math.min(l.maxQuantity!, Number(e.target.value) || 1)) } : x)))} />
                      )}
                      {l.maxQuantity === undefined && <Badge tone="grey">× {l.quantity}</Badge>}
                      <select className="input w-40" aria-label="Estado observado" value={l.observedCondition} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, observedCondition: e.target.value as Condition } : x)))}>
                        {condOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <button className="text-red-700 underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                        Remover
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Nenhuma peça adicionada.</p>
              )}
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextInput label="Data da receção" type="date" value={meta.receivedAt} max={todayIso()} onChange={(e) => setMeta({ ...meta, receivedAt: e.target.value })} />
                <SelectInput label="Onde ficam guardadas até à inspeção" value={meta.locationId} onChange={(e) => setMeta({ ...meta, locationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Sem localização" />
                <TextArea className="sm:col-span-2" label="Estado inicial observado / observações" value={meta.initialObservations} onChange={(e) => setMeta({ ...meta, initialObservations: e.target.value })} />
              </div>
              <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">
                As peças ficam «Pendentes de inspeção» e não contam como stock disponível. Poderá anexar fotografias e decidir o destino na página seguinte. Estado observado resumido: {lines.map((l) => conditionLabel(l.observedCondition)).join(', ') || '—'}.
              </p>
              <ErrorBox error={m.error} />
              <div className="mt-3 flex justify-end">
                <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!lines.length}>
                  Guardar receção
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
