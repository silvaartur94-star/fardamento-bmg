import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../api/client';
import { conditionLabel } from '../lib/format';
import type { ItemType } from '../lib/hooks';
import { Button, ErrorBox, Field, Loading, Modal } from './ui';

export interface MusicianLite {
  id: string;
  full_name: string;
  internal_code: string | null;
  kind: 'banda' | 'convidado';
  status: string;
}

/** Pesquisa e seleção de um músico. */
export function MusicianPicker({ value, onChange, kind, label = 'Músico' }: { value: MusicianLite | null; onChange: (m: MusicianLite | null) => void; kind?: 'banda' | 'convidado'; label?: string }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const r = useQuery({
    queryKey: ['musicians', 'picker', debounced, kind],
    queryFn: () => api.get<Page<MusicianLite>>('/musicians', { q: debounced, kind, pageSize: 10 }),
    enabled: !value,
  });
  if (value)
    return (
      <Field label={label}>
        {() => (
          <div className="flex items-center justify-between rounded-md border border-marinho-200 bg-marinho-50 px-3 py-2 text-sm">
            <span>
              <strong>{value.full_name}</strong> {value.internal_code && <span className="text-slate-500">({value.internal_code})</span>}
            </span>
            <button className="text-marinho-700 underline" onClick={() => onChange(null)}>
              Alterar
            </button>
          </div>
        )}
      </Field>
    );
  return (
    <Field label={label}>
      {(id) => (
        <div>
          <input id={id} className="input" type="search" placeholder="Escreva o nome ou o código…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          <ul className="mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white" role="listbox">
            {r.isLoading && <li className="p-2 text-sm text-slate-500">A procurar…</li>}
            {r.data?.items.map((m) => (
              <li key={m.id}>
                <button className="w-full px-3 py-2 text-left text-sm hover:bg-marinho-50" onClick={() => onChange(m)} role="option" aria-selected={false}>
                  {m.full_name} {m.internal_code && <span className="text-slate-500">({m.internal_code})</span>}
                  {m.kind === 'convidado' && <span className="ml-1 text-xs text-sky-700">convidado</span>}
                  {m.status !== 'ativo' && <span className="ml-1 text-xs text-slate-500">{m.status}</span>}
                </button>
              </li>
            ))}
            {r.data && !r.data.items.length && <li className="p-2 text-sm text-slate-500">Nenhum músico encontrado.</li>}
          </ul>
        </div>
      )}
    </Field>
  );
}

export interface PickedLine {
  itemTypeId: string;
  itemTypeName: string;
  garmentId?: string;
  bucketKey?: string;
  quantity: number;
  label: string;
  requestId?: string | null;
}

interface AvailableGarment {
  id: string;
  code: string;
  size_label: string | null;
  inscription: string | null;
  condition: string;
  location_name: string | null;
}
interface AvailableBucket {
  bucket_key: string;
  size_label: string | null;
  condition: string;
  location_name: string | null;
  quantity: number;
}

/** Seleção de artigos disponíveis (peças concretas ou lotes por quantidade). */
export function AvailablePicker({
  open,
  onClose,
  type,
  sizeId,
  maxQuantity,
  exclude,
  onPick,
  title,
}: {
  open: boolean;
  onClose: () => void;
  type: ItemType;
  sizeId?: string | null;
  maxQuantity?: number;
  exclude: PickedLine[];
  onPick: (lines: PickedLine[]) => void;
  title?: string;
}) {
  const [anySize, setAnySize] = useState(!sizeId);
  const [search, setSearch] = useState('');
  const r = useQuery({
    queryKey: ['available', type.id, anySize ? '' : sizeId, search],
    queryFn: () => api.get<{ garments: AvailableGarment[]; buckets: AvailableBucket[] }>('/inventory/available', { itemTypeId: type.id, sizeId: anySize ? undefined : sizeId, q: search }),
    enabled: open,
  });
  const [selected, setSelected] = useState<Record<string, number>>({});
  const excludedGarments = new Set(exclude.map((l) => l.garmentId).filter(Boolean));
  const usedFromBucket = (k: string) => exclude.filter((l) => l.bucketKey === k).reduce((a, l) => a + l.quantity, 0);
  const total = Object.values(selected).reduce((a, b) => a + b, 0);
  const over = maxQuantity !== undefined && total > maxQuantity;

  function confirm() {
    const lines: PickedLine[] = [];
    for (const [k, q] of Object.entries(selected)) {
      if (!q) continue;
      if (type.tracking_mode === 'individual') {
        const g = r.data?.garments.find((x) => x.id === k);
        if (g) lines.push({ itemTypeId: type.id, itemTypeName: type.name, garmentId: g.id, quantity: 1, label: `${g.code}${g.size_label ? ` · ${g.size_label}` : ''}${g.inscription ? ` · «${g.inscription}»` : ''}` });
      } else {
        const b = r.data?.buckets.find((x) => x.bucket_key === k);
        if (b) lines.push({ itemTypeId: type.id, itemTypeName: type.name, bucketKey: b.bucket_key, quantity: q, label: `${b.size_label ?? 'sem tamanho'} · ${conditionLabel(b.condition)}${b.location_name ? ` · ${b.location_name}` : ''}` });
      }
    }
    onPick(lines);
    setSelected({});
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={title ?? `Selecionar ${type.name.toLowerCase()} disponível`}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-slate-600">
            Selecionado: {total}
            {maxQuantity !== undefined && ` (máximo ${maxQuantity})`}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={!total || over}>
            Adicionar
          </Button>
        </>
      }
    >
      {sizeId && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anySize} onChange={(e) => setAnySize(e.target.checked)} /> Mostrar outros tamanhos
        </label>
      )}
      {r.error && <ErrorBox error={r.error} />}
      {r.isLoading && <Loading />}
      {type.tracking_mode === 'individual' ? (
        <>
          <input className="input mb-2" type="search" placeholder="Procurar por código ou inscrição" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Procurar peça" />
          <ul className="max-h-96 divide-y overflow-y-auto rounded border">
            {r.data?.garments.filter((g) => !excludedGarments.has(g.id)).map((g) => (
              <li key={g.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-marinho-50">
                  <input type="checkbox" checked={!!selected[g.id]} onChange={(e) => setSelected({ ...selected, [g.id]: e.target.checked ? 1 : 0 })} />
                  <span className="font-mono">{g.code}</span>
                  <span>{g.size_label ?? 'sem tamanho'}</span>
                  <span className="text-slate-600">{conditionLabel(g.condition)}</span>
                  {g.inscription && <span>«{g.inscription}»</span>}
                  <span className="ml-auto text-xs text-slate-500">{g.location_name}</span>
                </label>
              </li>
            ))}
            {r.data && !r.data.garments.length && <li className="p-3 text-sm text-slate-500">Não há peças disponíveis {anySize ? '' : 'neste tamanho'}.</li>}
          </ul>
        </>
      ) : (
        <ul className="divide-y rounded border">
          {r.data?.buckets.map((b) => {
            const avail = b.quantity - usedFromBucket(b.bucket_key);
            return (
              <li key={b.bucket_key} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium">{b.size_label ?? 'sem tamanho'}</span>
                <span>{conditionLabel(b.condition)}</span>
                <span className="text-slate-500">{b.location_name ?? 'sem localização'}</span>
                <span className="ml-auto text-slate-600">Disponível: {avail}</span>
                <input
                  type="number"
                  min={0}
                  max={avail}
                  className="input w-24"
                  aria-label="Quantidade"
                  value={selected[b.bucket_key] ?? 0}
                  onChange={(e) => setSelected({ ...selected, [b.bucket_key]: Math.max(0, Math.min(avail, Number(e.target.value) || 0)) })}
                />
              </li>
            );
          })}
          {r.data && !r.data.buckets.length && <li className="p-3 text-sm text-slate-500">Não há stock disponível {anySize ? '' : 'neste tamanho'}.</li>}
        </ul>
      )}
      {over && <p className="mt-2 text-sm text-red-700">A quantidade selecionada excede a necessidade ({maxQuantity}).</p>}
    </Modal>
  );
}
