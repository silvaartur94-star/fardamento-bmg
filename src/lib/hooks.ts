import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, newIdempotencyKey } from '../api/client';

export interface ItemSize {
  id: string;
  item_type_id: string;
  label: string;
  sort_order: number;
  active: number;
}
export interface ItemType {
  id: string;
  name: string;
  category: string;
  description: string | null;
  code_prefix: string;
  has_size: number;
  size_kind: 'alfanumerico' | 'numerico' | 'livre';
  allows_inscription: number;
  tracking_mode: 'individual' | 'quantidade';
  procurement_enabled: number;
  stock_enabled: number;
  min_available: number | null;
  sort_order: number;
  active: number;
  locked: boolean;
  sizes: ItemSize[];
}
export interface Location {
  id: string;
  name: string;
  description: string | null;
  active: number;
}

export function useItemTypes() {
  const q = useQuery({ queryKey: ['item-types'], queryFn: () => api.get<{ items: ItemType[] }>('/item-types'), staleTime: 5 * 60_000 });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const byId = useMemo(() => Object.fromEntries(items.map((t) => [t.id, t])), [items]);
  return { ...q, items, byId, active: items.filter((t) => t.active) };
}

export function useLocations() {
  const q = useQuery({ queryKey: ['locations'], queryFn: () => api.get<{ items: Location[] }>('/locations'), staleTime: 5 * 60_000 });
  const items = q.data?.items ?? [];
  return { ...q, items, active: items.filter((l) => l.active) };
}

/** Parâmetros de listagem guardados no URL (pesquisa, filtros, página, ordenação). */
export function useListParams(defaults: Record<string, string> = {}) {
  const [sp, setSp] = useSearchParams();
  const params = useMemo(() => {
    const o: Record<string, string> = { ...defaults };
    sp.forEach((v, k) => (o[k] = v));
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const set = useCallback(
    (patch: Record<string, string | undefined>, resetPage = true) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      if (resetPage && !('page' in patch)) next.delete('page');
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  const page = Number(params.page ?? 1);
  const toggleSort = (key: string) => set({ sort: key, dir: params.sort === key && params.dir !== 'desc' ? 'desc' : 'asc' }, false);
  return { params, set, page, toggleSort };
}

/**
 * Mutação protegida contra submissões duplicadas: a mesma chave de idempotência é
 * reutilizada até a operação ter sucesso, e o botão fica desativado enquanto decorre.
 */
export function useSafeMutation<TBody, TRes>(fn: (body: TBody, key: string) => Promise<TRes>, opts: { invalidate?: string[][]; onSuccess?: (r: TRes) => void } = {}) {
  const qc = useQueryClient();
  const keyRef = useRef<string>(newIdempotencyKey());
  const m = useMutation({
    mutationFn: (body: TBody) => fn(body, keyRef.current),
    onSuccess: (r) => {
      keyRef.current = newIdempotencyKey();
      for (const k of opts.invalidate ?? [[]]) qc.invalidateQueries({ queryKey: k.length ? k : undefined });
      opts.onSuccess?.(r);
    },
  });
  return m;
}

export function useToggle(initial = false) {
  const [v, setV] = useState(initial);
  return [v, () => setV((x) => !x), setV] as const;
}
