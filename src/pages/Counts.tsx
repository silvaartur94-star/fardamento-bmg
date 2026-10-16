import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { DataTable } from '../components/DataTable';
import { Badge, Button, ErrorBox, Modal, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useItemTypes, useLocations } from '../lib/hooks';
import { useAuth } from '../lib/auth';

const STATUS = { em_curso: 'Em curso', confirmada: 'Confirmada', cancelada: 'Cancelada' } as Record<string, string>;

export default function Counts() {
  const { can } = useAuth();
  const nav = useNavigate();
  const types = useItemTypes();
  const locations = useLocations();
  const q = useQuery({ queryKey: ['counts'], queryFn: () => api.get<{ items: any[] }>('/inventory/counts') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: `Contagem ${new Date().toLocaleDateString('pt-PT')}`, locationId: '', itemTypeId: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ id: string }>('/inventory/counts', { ...f, locationId: f.locationId || null, itemTypeId: f.itemTypeId || null, notes: f.notes || null });
      nav(`/inventario/contagens/${r.id}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader
        back={{ to: '/inventario', label: 'Inventário' }}
        title="Contagens físicas"
        subtitle="Compare as quantidades reais com as registadas. As diferenças geram propostas de ajuste que exigem motivo e confirmação explícita."
        actions={can('inventory.write') && <Button onClick={() => setOpen(true)}>Nova contagem</Button>}
      />
      <DataTable
        rows={q.data?.items}
        loading={q.isFetching}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/inventario/contagens/${r.id}`)}
        emptyTitle="Ainda não foram feitas contagens"
        columns={[
          { key: 'n', header: 'Contagem', render: (r) => r.name },
          { key: 'f', header: 'Âmbito', render: (r) => [r.location_name, r.item_type_name].filter(Boolean).join(' · ') || 'Todo o armazém' },
          { key: 'p', header: 'Linhas contadas', render: (r) => `${r.counted_lines} / ${r.line_count}` },
          { key: 's', header: 'Estado', render: (r) => <Badge tone={r.status === 'em_curso' ? 'amber' : r.status === 'confirmada' ? 'green' : 'grey'}>{STATUS[r.status]}</Badge> },
          { key: 'c', header: 'Criada', render: (r) => `${fmtDateTime(r.created_at)} · ${r.created_by_name}` },
          { key: 'cf', header: 'Confirmada', render: (r) => (r.confirmed_at ? `${fmtDateTime(r.confirmed_at)} · ${r.confirmed_by_name}` : '—') },
        ]}
      />
      <Modal open={open} onClose={() => setOpen(false)} title="Nova contagem física" footer={<Button onClick={create} loading={busy}>Iniciar contagem</Button>}>
        <div className="space-y-3">
          <TextInput label="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <SelectInput label="Localização" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} options={locations.active.map((l) => ({ value: l.id, label: l.name }))} placeholder="Todas" />
          <SelectInput label="Tipo de artigo" value={f.itemTypeId} onChange={(e) => setF({ ...f, itemTypeId: e.target.value })} options={types.active.filter((t) => t.stock_enabled).map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />
          <TextArea label="Notas" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <p className="text-xs text-slate-500">São incluídos os artigos em armazém (disponível, reservado, pendente de inspeção e quarentena). Peças atribuídas, emprestadas ou em reparação não são contadas.</p>
          <ErrorBox error={err} />
        </div>
      </Modal>
    </div>
  );
}
