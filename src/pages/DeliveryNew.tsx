import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download } from '../api/client';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { AvailablePicker, MusicianPicker, type MusicianLite, type PickedLine } from '../components/pickers';
import { todayIso } from '../lib/format';
import { useItemTypes, useSafeMutation, type ItemType } from '../lib/hooks';

interface Req {
  id: string;
  item_type_id: string;
  item_type_name: string;
  size_id: string | null;
  size_label: string | null;
  size_text: string | null;
  quantity_requested: number;
  quantity_delivered: number;
  quantity_missing: number;
  procurement_enabled: number;
  status: string;
}

export default function DeliveryNew() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const types = useItemTypes();
  const [musician, setMusician] = useState<MusicianLite | null>(null);
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [picker, setPicker] = useState<{ type: ItemType; sizeId?: string | null; requestId?: string | null; max?: number } | null>(null);
  const [extraType, setExtraType] = useState('');
  const [meta, setMeta] = useState({ deliveredAt: todayIso(), receivedByName: '', notes: '' });
  const [step, setStep] = useState(1);
  const [done, setDone] = useState<string | null>(null);

  const pre = sp.get('musico');
  const preQ = useQuery({ queryKey: ['musician-lite', pre], queryFn: () => api.get<{ musician: MusicianLite }>(`/musicians/${pre}`), enabled: !!pre && !musician });
  useEffect(() => {
    if (preQ.data && !musician) {
      setMusician(preQ.data.musician);
      setStep(2);
    }
  }, [preQ.data, musician]);

  const reqs = useQuery({
    queryKey: ['musician-requests', musician?.id],
    queryFn: () => api.get<{ requests: Req[] }>(`/musicians/${musician!.id}`),
    enabled: !!musician,
  });
  const pending = (reqs.data?.requests ?? []).filter((r) => r.status === 'ativa' && r.procurement_enabled && r.quantity_missing > 0);
  const chosenFor = (id: string) => lines.filter((l) => l.requestId === id).reduce((a, l) => a + l.quantity, 0);

  const m = useSafeMutation(
    (_: void, key: string) =>
      api.post<{ id: string }>(
        '/deliveries',
        {
          musicianId: musician!.id,
          deliveredAt: meta.deliveredAt,
          receivedByName: meta.receivedByName || null,
          notes: meta.notes || null,
          lines: lines.map((l) => ({ itemTypeId: l.itemTypeId, garmentId: l.garmentId ?? null, bucketKey: l.bucketKey ?? null, quantity: l.quantity, requestId: l.requestId ?? null })),
        },
        { idempotencyKey: key },
      ),
    { onSuccess: (r) => setDone(r.id), invalidate: [['musician'], ['musicians'], ['requests'], ['dashboard'], ['available'], ['alerts']] },
  );

  if (done) return <DeliveryDone id={done} musicianId={musician!.id} onAnother={() => nav(0)} />;

  return (
    <div>
      <PageHeader back={{ to: '/necessidades?tab=entregas', label: 'Entregas' }} title="Entrega de fardamento novo" subtitle={`Passo ${step} de 3`} />
      <ol className="mb-5 flex flex-wrap gap-2 text-sm">
        {['Músico', 'Artigos a entregar', 'Confirmação'].map((s, i) => (
          <li key={s} className={`rounded-full px-3 py-1 ${step === i + 1 ? 'bg-marinho-700 text-white' : step > i + 1 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card title="1. Selecionar o músico">
          {preQ.isLoading ? <Loading /> : <MusicianPicker value={musician} onChange={(v) => { setMusician(v); setLines([]); }} />}
          <div className="mt-4 flex justify-end">
            <Button disabled={!musician} onClick={() => setStep(2)}>
              Seguinte
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && musician && (
        <div className="space-y-4">
          <Card title={`2. Necessidades pendentes de ${musician.full_name}`}>
            {reqs.isLoading ? <Loading /> : reqs.error ? <ErrorBox error={reqs.error} /> : pending.length ? (
              <ul className="divide-y">
                {pending.map((r) => {
                  const chosen = chosenFor(r.id);
                  const type = types.byId[r.item_type_id];
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <span className="flex-1">
                        <strong>{r.item_type_name}</strong> {r.size_label ?? r.size_text ? `— tamanho ${r.size_label ?? r.size_text}` : ''}
                        <span className="block text-xs text-slate-500">
                          Pretendido {r.quantity_requested}, já entregue {r.quantity_delivered}, falta {r.quantity_missing}
                        </span>
                      </span>
                      {chosen > 0 && <Badge tone="green">{chosen} selecionado(s)</Badge>}
                      {type?.stock_enabled ? (
                        <Button size="sm" variant="secondary" disabled={chosen >= r.quantity_missing} onClick={() => setPicker({ type, sizeId: r.size_id, requestId: r.id, max: r.quantity_missing - chosen })}>
                          Escolher do stock
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">
                Este músico não tem necessidades pendentes. Pode ainda entregar artigos avulsos abaixo, ou <Link className="underline" to={`/musicos/${musician.id}`}>registar necessidades na ficha</Link>.
              </p>
            )}
          </Card>
          <Card title="Artigo sem necessidade registada">
            <div className="flex flex-wrap items-end gap-2">
              <SelectInput className="min-w-56" label="Tipo de artigo" value={extraType} onChange={(e) => setExtraType(e.target.value)} options={types.active.filter((t) => t.stock_enabled).map((t) => ({ value: t.id, label: t.name }))} placeholder="Selecione…" />
              <Button variant="secondary" disabled={!extraType} onClick={() => setPicker({ type: types.byId[extraType] })}>
                Escolher do stock
              </Button>
            </div>
          </Card>
          <Card title={`Artigos selecionados (${lines.reduce((a, l) => a + l.quantity, 0)})`}>
            {lines.length ? (
              <ul className="divide-y text-sm">
                {lines.map((l, i) => (
                  <li key={i} className="flex items-center justify-between py-1.5">
                    <span>
                      {l.quantity} × {l.itemTypeName} — {l.label} {!l.requestId && <Badge tone="grey">avulso</Badge>}
                    </span>
                    <button className="text-red-700 underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      Remover
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Ainda não selecionou artigos.</p>
            )}
          </Card>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Anterior
            </Button>
            <Button disabled={!lines.length} onClick={() => setStep(3)}>
              Seguinte
            </Button>
          </div>
        </div>
      )}

      {step === 3 && musician && (
        <Card title="3. Confirmar a entrega">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextInput label="Data da entrega" type="date" value={meta.deliveredAt} max={todayIso()} onChange={(e) => setMeta({ ...meta, deliveredAt: e.target.value })} />
            <TextInput label="Recebido por (nome)" value={meta.receivedByName} onChange={(e) => setMeta({ ...meta, receivedByName: e.target.value })} hint="Opcional, se não for o próprio músico." />
            <TextArea className="sm:col-span-2" label="Observações" value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} />
          </div>
          <div className="mt-4 rounded border bg-slate-50 p-3 text-sm">
            <p className="font-medium">
              Entregar a {musician.full_name}: {lines.reduce((a, l) => a + l.quantity, 0)} peça(s)
            </p>
            <ul className="mt-1 list-inside list-disc">
              {lines.map((l, i) => (
                <li key={i}>
                  {l.quantity} × {l.itemTypeName} — {l.label}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-600">As peças passam ao estado «Atribuído a músico» e deixam de contar como stock disponível.</p>
          </div>
          <ErrorBox error={m.error} />
          <div className="mt-4 flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)} disabled={m.isPending}>
              Anterior
            </Button>
            <Button onClick={() => m.mutate()} loading={m.isPending}>
              Confirmar entrega
            </Button>
          </div>
        </Card>
      )}

      {picker && (
        <AvailablePicker
          open
          type={picker.type}
          sizeId={picker.sizeId}
          maxQuantity={picker.max}
          exclude={lines}
          onClose={() => setPicker(null)}
          onPick={(ls) => setLines([...lines, ...ls.map((l) => ({ ...l, requestId: picker.requestId ?? null }))])}
        />
      )}
    </div>
  );
}

function DeliveryDone({ id, musicianId, onAnother }: { id: string; musicianId: string; onAnother: () => void }) {
  const q = useQuery({ queryKey: ['musician', musicianId], queryFn: () => api.get<{ typeSummary: { item_type_id: string; item_type_name: string; missing: number; sizes: string | null }[] }>(`/musicians/${musicianId}`) });
  const missing = q.data?.typeSummary.filter((t) => t.missing > 0) ?? [];
  return (
    <div>
      <PageHeader title="Entrega registada" />
      <Card>
        <p className="text-emerald-800">A entrega foi registada e o stock atualizado.</p>
        <h3 className="mt-4 font-semibold">Ainda falta entregar</h3>
        {q.isLoading ? <Loading /> : missing.length ? (
          <ul className="list-inside list-disc text-sm">
            {missing.map((t) => (
              <li key={t.item_type_id}>
                {t.missing} × {t.item_type_name} {t.sizes && `(tam. ${t.sizes})`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">Nada — todas as necessidades deste músico estão satisfeitas.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => download(`/reports/pdf/delivery/${id}`)}>Imprimir folha de entrega</Button>
          <Link to={`/entregas/${id}`} className="rounded-md border px-3.5 py-2 text-sm">Ver entrega</Link>
          <Link to={`/musicos/${musicianId}`} className="rounded-md border px-3.5 py-2 text-sm">Ficha do músico</Link>
          <Button variant="ghost" onClick={onAnother}>Nova entrega</Button>
        </div>
      </Card>
    </div>
  );
}
