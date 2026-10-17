import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, SIZE_KIND_LABELS, STATUSES, STATUS_LABELS, TRACKING_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Modal, PageHeader, SelectInput, Tabs, TextArea, TextInput } from '../components/ui';
import { StatusBadge, ConditionBadge } from '../components/domain';
import { DangerAction } from '../components/DangerAction';
import { useItemTypes, useListParams, useLocations, type ItemType, type Location } from '../lib/hooks';

export const STATUS_HELP: Record<string, string> = {
  disponivel: 'Pode ser entregue ou emprestado.',
  reservado: 'Separado para um fim específico; não está disponível.',
  atribuido: 'Entregue a um músico da banda.',
  emprestado: 'Emprestado a um músico convidado; aguarda devolução.',
  pendente_inspecao: 'Recebido (recolha ou devolução) e a aguardar inspeção.',
  quarentena: 'Isolado para avaliação posterior (ex.: limpeza, odores, dúvidas).',
  reparacao: 'Enviado para arranjo/costureira.',
  abatido: 'Retirado definitivamente do inventário ativo.',
  extraviado: 'Perdido ou não encontrado.',
  rejeitado: 'Recolhido mas recusado para entrar em stock.',
};

export function StatusReference() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Estados operacionais">
        <ul className="space-y-2 text-sm">
          {STATUSES.map((s) => (
            <li key={s} className="flex gap-2">
              <span className="w-44 shrink-0"><StatusBadge status={s} /></span>
              <span className="text-slate-600">{STATUS_HELP[s]}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Estados de conservação">
        <ul className="space-y-2 text-sm">
          {CONDITIONS.map((c) => (
            <li key={c} className="flex gap-2">
              <ConditionBadge condition={c} /> {c === 'mau' || c === 'inutilizavel' ? <span className="text-slate-600">Não pode ser reintegrado diretamente no stock disponível.</span> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function ItemTypesPanel() {
  const types = useItemTypes();
  const [edit, setEdit] = useState<ItemType | 'new' | null>(null);
  return (
    <Card title="Tipos de artigo e tamanhos" actions={<Button size="sm" onClick={() => setEdit('new')}>Novo tipo de artigo</Button>}>
      <DataTable
        rows={types.items}
        loading={types.isLoading}
        error={types.error}
        rowKey={(t) => t.id}
        columns={[
          { key: 'n', header: 'Artigo', render: (t) => <span className="font-medium">{t.name}</span> },
          { key: 'c', header: 'Categoria', render: (t) => t.category },
          { key: 'm', header: 'Gestão', render: (t) => (t.stock_enabled ? TRACKING_LABELS[t.tracking_mode] : <Badge tone="purple">Só necessidade</Badge>) },
          { key: 'p', header: 'Prefixo', render: (t) => <span className="font-mono">{t.code_prefix}</span> },
          { key: 's', header: 'Tamanhos', render: (t) => (t.has_size ? t.sizes.filter((s) => s.active).map((s) => s.label).join(', ') || '—' : 'Sem tamanho') },
          { key: 'i', header: 'Inscrição', render: (t) => (t.allows_inscription ? 'Sim' : 'Não') },
          { key: 'a', header: 'Aquisição', render: (t) => (t.procurement_enabled ? 'Sim' : 'Não') },
          { key: 'st', header: 'Estado', render: (t) => <Badge tone={t.active ? 'green' : 'grey'}>{t.active ? 'Ativo' : 'Inativo'}</Badge> },
          {
            key: 'e',
            header: '',
            render: (t) => (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Editar</Button>
                {!t.locked && (
                  <DangerAction size="sm" variant="ghost" label="Eliminar" title="Eliminar tipo de artigo" message={<>Eliminar «{t.name}» e a sua escala de tamanhos? Só é possível se não houver necessidades, stock ou movimentos deste artigo; caso contrário, desative-o.</>} onConfirm={() => api.del(`/item-types/${t.id}`)} />
                )}
              </span>
            ),
          },
        ]}
      />
      {edit && <ItemTypeModal existing={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ItemTypeModal({ existing, onClose }: { existing?: ItemType; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: existing?.name ?? '',
    category: existing?.category ?? 'Fardamento principal',
    description: existing?.description ?? '',
    codePrefix: existing?.code_prefix ?? '',
    hasSize: existing ? !!existing.has_size : true,
    sizeKind: existing?.size_kind ?? 'alfanumerico',
    allowsInscription: !!existing?.allows_inscription,
    trackingMode: existing?.tracking_mode ?? 'quantidade',
    procurementEnabled: existing ? !!existing.procurement_enabled : true,
    stockEnabled: existing ? !!existing.stock_enabled : true,
    minAvailable: existing?.min_available != null ? String(existing.min_available) : '',
    sortOrder: String(existing?.sort_order ?? 100),
    active: existing ? !!existing.active : true,
  });
  const [newSize, setNewSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['item-types'] });

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = { ...f, description: f.description || null, minAvailable: f.minAvailable === '' ? null : Number(f.minAvailable), sortOrder: Number(f.sortOrder) };
      if (existing) await api.patch(`/item-types/${existing.id}`, body);
      else await api.post('/item-types', body);
      refresh();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  async function addSize() {
    if (!existing || !newSize.trim()) return;
    setErr(null);
    try {
      await api.post(`/item-types/${existing.id}/sizes`, { label: newSize.trim() });
      setNewSize('');
      refresh();
    } catch (e) {
      setErr(e);
    }
  }
  async function toggleSize(sizeId: string, active: boolean) {
    try {
      await api.patch(`/item-types/${existing!.id}/sizes/${sizeId}`, { active });
      refresh();
    } catch (e) {
      setErr(e);
    }
  }
  async function deleteSize(sizeId: string, label: string) {
    if (!confirm(`Eliminar o tamanho «${label}»? Se já estiver em uso, só pode ser desativado.`)) return;
    setErr(null);
    try {
      await api.del(`/item-types/${existing!.id}/sizes/${sizeId}`);
      refresh();
    } catch (e) {
      setErr(e);
    }
  }
  const current = useItemTypes().byId[existing?.id ?? ''];
  return (
    <Modal open onClose={onClose} wide title={existing ? `Editar ${existing.name}` : 'Novo tipo de artigo'} footer={<Button onClick={save} loading={busy} disabled={!f.name || !f.codePrefix}>Guardar</Button>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextInput label="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <TextInput label="Categoria" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} required />
        <TextInput label="Prefixo dos códigos" value={f.codePrefix} onChange={(e) => setF({ ...f, codePrefix: e.target.value.toUpperCase() })} hint="2 a 6 letras (ex.: CAS)." disabled={existing?.locked && existing.tracking_mode === 'individual'} />
        <TextArea className="sm:col-span-3" label="Descrição" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <SelectInput label="Modo de gestão" value={f.trackingMode} disabled={existing?.locked} onChange={(e) => setF({ ...f, trackingMode: e.target.value as 'individual' })} options={Object.entries(TRACKING_LABELS).map(([value, label]) => ({ value, label }))} hint={existing?.locked ? 'Bloqueado: já existe stock ou movimentos deste tipo.' : undefined} />
        <SelectInput label="Tipo de tamanho" value={f.sizeKind} onChange={(e) => setF({ ...f, sizeKind: e.target.value as 'numerico' })} options={Object.entries(SIZE_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
        <TextInput label="Stock mínimo disponível (alerta)" type="number" min={0} value={f.minAvailable} onChange={(e) => setF({ ...f, minAvailable: e.target.value })} hint="Opcional." />
        <TextInput label="Ordem de apresentação" type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
        <div className="space-y-2 sm:col-span-2">
          <Checkbox label="Tem tamanho" checked={f.hasSize} onChange={(v) => setF({ ...f, hasSize: v })} />
          <Checkbox label="Pode ter inscrição personalizada (nome)" checked={f.allowsInscription} onChange={(v) => setF({ ...f, allowsInscription: v })} />
          <Checkbox label="Entra na aquisição/encomenda" hint="Desmarque para artigos apenas registados como necessidade (ex.: sapatos)." checked={f.procurementEnabled} onChange={(v) => setF({ ...f, procurementEnabled: v })} />
          {!existing?.locked && <Checkbox label="Gerido em stock/inventário" checked={f.stockEnabled} onChange={(v) => setF({ ...f, stockEnabled: v })} />}
          <Checkbox label="Ativo" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
        </div>
      </div>
      {existing && f.hasSize && (
        <div className="mt-5 border-t pt-4">
          <h3 className="mb-2 text-sm font-semibold">Escala de tamanhos de {existing.name}</h3>
          <div className="flex flex-wrap gap-2">
            {(current?.sizes ?? []).map((s) => (
              <span key={s.id} className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-sm ${s.active ? '' : 'text-slate-400 line-through'}`}>
                {s.label}
                <button className="text-xs text-marinho-700 underline" onClick={() => toggleSize(s.id, !s.active)}>{s.active ? 'desativar' : 'ativar'}</button>
                <button className="text-xs text-red-700" aria-label={`Eliminar tamanho ${s.label}`} title="Eliminar tamanho" onClick={() => deleteSize(s.id, s.label)}>✕</button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <TextInput label="Novo tamanho" value={newSize} onChange={(e) => setNewSize(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSize()} />
            <Button variant="secondary" onClick={addSize} disabled={!newSize.trim()}>Adicionar</Button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Tamanhos em uso não podem ser renomeados; desative-os e crie um novo. Cada tipo tem a sua própria escala.</p>
        </div>
      )}
      <div className="mt-3"><ErrorBox error={err} /></div>
    </Modal>
  );
}

export function LocationsPanel() {
  const qc = useQueryClient();
  const locations = useLocations();
  const [edit, setEdit] = useState<Location | 'new' | null>(null);
  const [f, setF] = useState({ name: '', description: '', active: true });
  const [err, setErr] = useState<unknown>(null);
  const open = (l: Location | 'new') => {
    setErr(null);
    setF(l === 'new' ? { name: '', description: '', active: true } : { name: l.name, description: l.description ?? '', active: !!l.active });
    setEdit(l);
  };
  async function save() {
    try {
      const body = { ...f, description: f.description || null };
      if (edit === 'new') await api.post('/locations', body);
      else await api.patch(`/locations/${(edit as Location).id}`, body);
      qc.invalidateQueries({ queryKey: ['locations'] });
      setEdit(null);
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <Card title="Localizações físicas" actions={<Button size="sm" onClick={() => open('new')}>Nova localização</Button>}>
      <DataTable
        rows={locations.items}
        rowKey={(l) => l.id}
        emptyTitle="Sem localizações"
        emptyHint="Ex.: Arrecadação da sede, Armário 1, Costureira."
        columns={[
          { key: 'n', header: 'Nome', render: (l) => l.name },
          { key: 'd', header: 'Descrição', render: (l) => l.description ?? '—' },
          { key: 's', header: 'Estado', render: (l) => <Badge tone={l.active ? 'green' : 'grey'}>{l.active ? 'Ativa' : 'Inativa'}</Badge> },
          {
            key: 'e',
            header: '',
            render: (l) => (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => open(l)}>Editar</Button>
                <DangerAction size="sm" variant="ghost" label="Eliminar" title="Eliminar localização" message={<>Eliminar «{l.name}»? Se já tiver sido usada em peças ou movimentos, só pode ser desativada.</>} onConfirm={() => api.del(`/locations/${l.id}`)} />
              </span>
            ),
          },
        ]}
      />
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Nova localização' : 'Editar localização'} footer={<Button onClick={save} disabled={!f.name.trim()}>Guardar</Button>}>
        <div className="space-y-3">
          <TextInput label="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <TextArea label="Descrição" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <Checkbox label="Ativa" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
          <ErrorBox error={err} />
        </div>
      </Modal>
    </Card>
  );
}

function GeneralPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: Record<string, number> }>('/settings') });
  const [mb, setMb] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const s = q.data?.settings ?? {};
  async function save() {
    setErr(null);
    setMsg(null);
    try {
      if (mb !== null) await api.put('/settings/uploads.max_bytes', { value: Math.round(Number(mb) * 1048576) });
      if (days !== null) await api.put('/settings/loans.default_due_days', { value: Number(days) });
      qc.invalidateQueries({ queryKey: ['settings'] });
      setMsg('Configurações guardadas.');
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <Card title="Configurações gerais">
      <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
        <TextInput label="Tamanho máximo das fotografias (MB)" type="number" min={0.1} step={0.5} value={mb ?? String((s['uploads.max_bytes'] ?? 8388608) / 1048576)} onChange={(e) => setMb(e.target.value)} />
        <TextInput label="Prazo de devolução por defeito (dias após a festa)" type="number" min={0} value={days ?? String(s['loans.default_due_days'] ?? 3)} onChange={(e) => setDays(e.target.value)} />
      </div>
      <Button className="mt-3" onClick={save}>Guardar</Button>
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      <ErrorBox error={err} />
    </Card>
  );
}

export default function Settings() {
  const { params, set } = useListParams({ tab: 'artigos' });
  return (
    <div>
      <PageHeader title="Configurações" subtitle="Listas de referência utilizadas em toda a aplicação." />
      <Tabs active={params.tab} onChange={(k) => set({ tab: k })} tabs={[{ key: 'artigos', label: 'Tipos de artigo' }, { key: 'locais', label: 'Localizações' }, { key: 'estados', label: 'Estados' }, { key: 'geral', label: 'Geral' }]} />
      {params.tab === 'artigos' && <ItemTypesPanel />}
      {params.tab === 'locais' && <LocationsPanel />}
      {params.tab === 'estados' && <StatusReference />}
      {params.tab === 'geral' && <GeneralPanel />}
      <p className="mt-4 text-xs text-slate-500">Os estados são fixos para garantir a integridade do inventário: {STATUSES.map((x) => STATUS_LABELS[x]).join(', ')}. Conservação: {CONDITIONS.map((c) => CONDITION_LABELS[c]).join(', ')}.</p>
    </div>
  );
}
