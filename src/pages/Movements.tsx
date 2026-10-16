import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, newIdempotencyKey, type Page } from '../api/client';
import { MOVEMENT_LABELS, MOVEMENT_TYPES, REVERSIBLE_MOVEMENTS, type MovementType } from '../../shared/domain';
import { Pagination } from '../components/DataTable';
import { Button, ConfirmDialog, ErrorBox, Loading, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { MovementsTable, type MovementRow } from '../components/domain';
import { useItemTypes, useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { movementLabel } from '../lib/format';

export default function Movements() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const types = useItemTypes();
  const { params, set, page } = useListParams();
  const q = useQuery({ queryKey: ['movements', params], queryFn: () => api.get<Page<MovementRow>>('/stock-movements', { ...params, page, pageSize: 50 }), placeholderData: (p) => p });
  const [rev, setRev] = useState<MovementRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const filters = { type: params.type, itemTypeId: params.itemTypeId, from: params.from, to: params.to, q: params.q };
  return (
    <div>
      <PageHeader
        title="Movimentos e histórico"
        subtitle="Registo imutável de todas as entradas, saídas e mudanças de estado. As correções fazem-se por estorno, preservando o movimento original."
        actions={
          can('export') && (
            <>
              <Button variant="secondary" onClick={() => download('/reports/datasets/movimentos/csv', filters)}>CSV</Button>
              <Button variant="secondary" onClick={() => download('/reports/datasets/movimentos/xlsx', filters)}>Excel</Button>
            </>
          )
        }
      />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <TextInput label="Pesquisar" type="search" placeholder="Código, músico, motivo" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        <SelectInput label="Tipo de movimento" value={params.type ?? ''} onChange={(e) => set({ type: e.target.value })} options={MOVEMENT_TYPES.map((t) => ({ value: t, label: MOVEMENT_LABELS[t] }))} placeholder="Todos" />
        <SelectInput label="Artigo" value={params.itemTypeId ?? ''} onChange={(e) => set({ itemTypeId: e.target.value })} options={types.items.map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />
        <TextInput label="Desde" type="date" value={params.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        <TextInput label="Até" type="date" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {q.error ? <ErrorBox error={q.error} /> : !q.data ? <Loading /> : (
        <>
          <MovementsTable
            rows={q.data.items}
            actions={
              can('inventory.reverse')
                ? (m) =>
                    REVERSIBLE_MOVEMENTS.includes(m.movement_type as MovementType) && !m.reversed_by && (
                      <Button size="sm" variant="ghost" onClick={() => { setReason(''); setErr(null); setRev(m); }}>
                        Estornar
                      </Button>
                    )
                : undefined
            }
          />
          <Pagination page={page} pageSize={50} total={q.data.total} onPage={(p) => set({ page: String(p) }, false)} />
        </>
      )}
      <ConfirmDialog
        open={!!rev}
        title="Estornar movimento"
        message={rev && <>Será criado um movimento inverso de «{movementLabel(rev.movement_type)}» ({rev.quantity} × {rev.item_type_name} {rev.garment_code ?? ''}). O movimento original mantém-se no histórico.</>}
        confirmLabel="Estornar"
        loading={busy}
        error={err}
        onClose={() => setRev(null)}
        onConfirm={async () => {
          setBusy(true);
          setErr(null);
          try {
            await api.post(`/stock-movements/${rev!.id}/reverse`, { reason }, { idempotencyKey: newIdempotencyKey() });
            setRev(null);
            qc.invalidateQueries();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextArea label="Motivo (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}
