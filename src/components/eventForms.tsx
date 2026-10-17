import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { EVENT_STATUSES, EVENT_STATUS_LABELS } from '../../shared/domain';
import { Button, ErrorBox, Modal, SelectInput, TextArea, TextInput } from './ui';
import { DataTable } from './DataTable';

export function EventModal({ open, onClose, existing, onSaved }: { open: boolean; onClose: () => void; existing?: any; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: existing?.name ?? '',
    place: existing?.place ?? '',
    startDate: existing?.start_date ?? '',
    endDate: existing?.end_date ?? '',
    status: existing?.status ?? 'planeada',
    notes: existing?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = { ...f, place: f.place || null, endDate: f.endDate || null, notes: f.notes || null };
      let id = existing?.id;
      if (existing) await api.patch(`/events/${existing.id}`, body);
      else id = (await api.post<{ id: string }>('/events', body)).id;
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['event'] });
      onSaved?.(id);
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  const statuses = EVENT_STATUSES.filter((s) => s !== 'encerrada' || existing?.status === 'encerrada');
  return (
    <Modal open={open} onClose={onClose} title={existing ? 'Editar festa' : 'Nova festa ou atuação'} footer={<Button onClick={submit} loading={busy} disabled={!f.name || !f.startDate}>Guardar</Button>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextInput className="sm:col-span-2" label="Nome da festa ou atuação" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <TextInput className="sm:col-span-2" label="Local" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} />
        <TextInput label="Data de início" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
        <TextInput label="Data de fim" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        <SelectInput label="Estado" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={statuses.map((s) => ({ value: s, label: EVENT_STATUS_LABELS[s] }))} />
        <TextArea className="sm:col-span-2" label="Observações" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="sm:col-span-2"><ErrorBox error={err} /></div>
      </div>
    </Modal>
  );
}

export interface Reconciliation {
  totals: { lent: number; returned: number; lost: number; pending: number; damaged: number; needsAttention: number };
  byMusician: { musician_id: string; musician_name: string; lent: number; returned: number; lost: number; pending: number; damaged: number }[];
  pendingLines: any[];
}

export function ReconciliationView({ rec }: { rec: Reconciliation }) {
  const t = rec.totals;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Emprestadas', t.lent],
          ['Devolvidas', t.returned],
          ['Em falta', t.pending],
          ['Perdidas', t.lost],
          ['Devolvidas danificadas', t.damaged],
          ['Exigem inspeção/reparação', t.needsAttention],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded border bg-slate-50 p-3">
            <p className="text-xs text-slate-500">{l}</p>
            <p className={`text-xl font-bold ${l === 'Em falta' && Number(v) > 0 ? 'text-amber-700' : 'text-marinho-800'}`}>{v}</p>
          </div>
        ))}
      </div>
      <h3 className="mb-2 mt-4 text-sm font-semibold">Pendências por músico</h3>
      <DataTable
        rows={rec.byMusician}
        rowKey={(r) => r.musician_id}
        emptyTitle="Sem empréstimos"
        columns={[
          { key: 'm', header: 'Músico', render: (r) => r.musician_name },
          { key: 'l', header: 'Emprestado', align: 'right', render: (r) => r.lent },
          { key: 'r', header: 'Devolvido', align: 'right', render: (r) => r.returned },
          { key: 'd', header: 'Danificado', align: 'right', render: (r) => r.damaged },
          { key: 'x', header: 'Perdido', align: 'right', render: (r) => r.lost },
          { key: 'p', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
        ]}
      />
    </div>
  );
}
