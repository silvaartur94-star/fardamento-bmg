import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, STATUS_LABELS, VERIFICATIONS, VERIFICATION_LABELS, type Status } from '../../shared/domain';
import { Badge, Button, Card, ErrorBox, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { TypeSizePicker } from '../components/domain';
import { todayIso } from '../lib/format';
import { useItemTypes, useLocations, useSafeMutation } from '../lib/hooks';

interface Line {
  itemTypeId: string;
  sizeId: string;
  condition: string;
  status: string;
  locationId: string;
  quantity: string;
  verification: string;
  inscriptions: string;
  cost: string;
  notes: string;
}
const emptyLine = (prev?: Line): Line => ({ itemTypeId: prev?.itemTypeId ?? '', sizeId: '', condition: prev?.condition ?? 'bom', status: 'disponivel', locationId: prev?.locationId ?? '', quantity: '1', verification: prev?.verification ?? 'contado', inscriptions: '', cost: '', notes: '' });
const ENTRY_STATUSES: Status[] = ['disponivel', 'reservado', 'pendente_inspecao', 'quarentena', 'reparacao'];

export default function InventoryEntry() {
  const [sp] = useSearchParams();
  const types = useItemTypes();
  const locations = useLocations();
  const [kind, setKind] = useState<'stock_inicial' | 'rececao_nova'>((sp.get('tipo') as 'rececao_nova') ?? 'stock_inicial');
  const [entryDate, setEntryDate] = useState(todayIso());
  const [originNotes, setOriginNotes] = useState('');
  const [current, setCurrent] = useState<Line>(emptyLine());
  const [lines, setLines] = useState<Line[]>([]);
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<{ garments: { id: string; code: string }[]; operationId: string } | null>(null);
  const t = types.byId[current.itemTypeId];
  const stockTypes = types.active.filter((x) => x.stock_enabled);

  const m = useSafeMutation(
    (_: void, key: string) =>
      api.post<{ garments: { id: string; code: string }[]; operationId: string }>(
        '/inventory/entries',
        {
          kind,
          entryDate,
          originNotes: originNotes || null,
          items: lines.map((l) => ({
            itemTypeId: l.itemTypeId,
            sizeId: l.sizeId || null,
            condition: l.condition,
            status: l.status,
            locationId: l.locationId || null,
            quantity: Number(l.quantity),
            verification: l.verification,
            inscriptions: l.inscriptions ? l.inscriptions.split('\n').map((s) => s.trim()) : undefined,
            costCents: l.cost ? Math.round(Number(l.cost.replace(',', '.')) * 100) : null,
            notes: l.notes || null,
          })),
        },
        { idempotencyKey: key },
      ),
    { onSuccess: (r) => setResult(r), invalidate: [['garments'], ['balances'], ['summary'], ['dashboard'], ['available']] },
  );

  const addLine = () => {
    if (!current.itemTypeId || Number(current.quantity) < 1) return;
    setLines([...lines, current]);
    setCurrent(emptyLine(current));
  };
  const desc = (l: Line) => {
    const tt = types.byId[l.itemTypeId];
    const size = tt?.sizes.find((s) => s.id === l.sizeId)?.label;
    return `${l.quantity} × ${tt?.name ?? '?'}${size ? ` (${size})` : ''} · ${CONDITION_LABELS[l.condition as 'bom']} · ${STATUS_LABELS[l.status as Status]}${l.locationId ? ` · ${locations.items.find((x) => x.id === l.locationId)?.name}` : ''}`;
  };

  if (result)
    return (
      <div>
        <PageHeader title="Entrada registada" back={{ to: '/inventario', label: 'Inventário' }} />
        <Card>
          <p className="text-emerald-800">A entrada foi registada com sucesso (operação {result.operationId.slice(0, 8)}).</p>
          {result.garments.length > 0 && (
            <>
              <p className="mt-3 text-sm">Códigos atribuídos às peças individuais:</p>
              <p className="mt-1 flex flex-wrap gap-1">
                {result.garments.map((g) => (
                  <Link key={g.id} to={`/inventario/pecas/${g.id}`} className="rounded bg-marinho-50 px-2 py-0.5 font-mono text-sm underline">
                    {g.code}
                  </Link>
                ))}
              </p>
              <Button className="mt-3" onClick={() => download('/reports/labels.pdf', { ids: result.garments.map((g) => g.id).join(',') })}>
                Imprimir etiquetas QR
              </Button>
            </>
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => { setResult(null); setLines([]); setReview(false); }}>
              Nova entrada
            </Button>
            <Link to="/inventario" className="rounded-md border px-3.5 py-2 text-sm">
              Ver inventário
            </Link>
          </div>
        </Card>
      </div>
    );

  return (
    <div>
      <PageHeader back={{ to: '/inventario', label: 'Inventário' }} title="Entrada de stock" subtitle="Introduza o stock existente ou registe artigos novos recebidos. Reveja tudo antes de confirmar." />
      {!review ? (
        <div className="space-y-4">
          <Card title="Tipo de entrada">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SelectInput label="Operação" value={kind} onChange={(e) => setKind(e.target.value as 'stock_inicial')} options={[{ value: 'stock_inicial', label: 'Stock inicial (já existente)' }, { value: 'rececao_nova', label: 'Receção de artigos novos (aquisição/fabrico)' }]} />
              <TextInput label="Data de entrada" type="date" value={entryDate} max={todayIso()} onChange={(e) => setEntryDate(e.target.value)} />
              <TextInput label={kind === 'rececao_nova' ? 'Fornecedor / encomenda' : 'Notas da origem'} value={originNotes} onChange={(e) => setOriginNotes(e.target.value)} />
            </div>
          </Card>
          <Card title="Adicionar artigos">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <TypeSizePicker types={stockTypes} typeId={current.itemTypeId} sizeId={current.sizeId} onChange={(it, s) => setCurrent({ ...current, itemTypeId: it, sizeId: s })} />
              <TextInput label="Quantidade" type="number" min={1} value={current.quantity} onChange={(e) => setCurrent({ ...current, quantity: e.target.value })} />
              <SelectInput label="Estado de conservação" value={current.condition} onChange={(e) => setCurrent({ ...current, condition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
              <SelectInput label="Estado operacional" value={current.status} onChange={(e) => setCurrent({ ...current, status: e.target.value })} options={ENTRY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
              <SelectInput label="Localização física" value={current.locationId} onChange={(e) => setCurrent({ ...current, locationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Sem localização" />
              {kind === 'stock_inicial' && <SelectInput label="Verificação da quantidade" value={current.verification} onChange={(e) => setCurrent({ ...current, verification: e.target.value })} options={VERIFICATIONS.map((v) => ({ value: v, label: v === 'contado' ? 'Contada efetivamente' : VERIFICATION_LABELS[v] }))} hint="Distingue valores contados de estimativas." />}
              <TextInput label="Custo unitário (€)" inputMode="decimal" value={current.cost} onChange={(e) => setCurrent({ ...current, cost: e.target.value })} hint="Opcional." />
              {t?.tracking_mode === 'individual' && t.allows_inscription ? (
                <TextArea className="sm:col-span-2" label="Inscrições (um nome por linha, pela ordem das peças)" value={current.inscriptions} onChange={(e) => setCurrent({ ...current, inscriptions: e.target.value })} hint="Deixe linhas vazias para peças sem nome." />
              ) : null}
              <TextInput className="sm:col-span-2" label="Observações" value={current.notes} onChange={(e) => setCurrent({ ...current, notes: e.target.value })} />
            </div>
            {t && <p className="mt-2 text-xs text-slate-500">{t.tracking_mode === 'individual' ? `Serão criadas ${current.quantity || 0} peça(s) individuais, cada uma com código próprio (${t.code_prefix}-00000).` : 'Será registada uma quantidade agregada (sem códigos individuais).'}</p>}
            <Button className="mt-3" variant="secondary" onClick={addLine} disabled={!current.itemTypeId || Number(current.quantity) < 1}>
              Adicionar à lista
            </Button>
          </Card>
          <Card title={`Lista (${lines.length})`}>
            {lines.length ? (
              <ul className="divide-y text-sm">
                {lines.map((l, i) => (
                  <li key={i} className="flex items-center justify-between py-1.5">
                    <span>
                      {desc(l)} {l.verification !== 'contado' && <Badge tone="amber">{VERIFICATION_LABELS[l.verification as 'estimado']}</Badge>}
                    </span>
                    <button className="text-red-700 underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      Remover
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Adicione os artigos acima.</p>
            )}
            <div className="mt-4 flex justify-end">
              <Button disabled={!lines.length} onClick={() => setReview(true)}>
                Rever antes de confirmar
              </Button>
            </div>
          </Card>
        </div>
      ) : (
        <Card title="Rever e confirmar">
          <p className="text-sm">
            <strong>{kind === 'stock_inicial' ? 'Stock inicial' : 'Receção de artigos novos'}</strong> com data de {entryDate}
            {originNotes && ` — ${originNotes}`}
          </p>
          <ul className="mt-2 list-inside list-disc text-sm">
            {lines.map((l, i) => (
              <li key={i}>{desc(l)}</li>
            ))}
          </ul>
          <p className="mt-2 text-sm">Total: {lines.reduce((a, l) => a + Number(l.quantity), 0)} unidade(s). A operação fica registada em seu nome e não pode ser apagada (apenas estornada por um administrador).</p>
          <ErrorBox error={m.error} />
          <div className="mt-4 flex justify-between">
            <Button variant="secondary" onClick={() => setReview(false)} disabled={m.isPending}>
              Voltar e corrigir
            </Button>
            <Button onClick={() => m.mutate()} loading={m.isPending}>
              Confirmar entrada
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
