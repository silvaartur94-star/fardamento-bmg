import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, ORIGINS, ORIGIN_LABELS, STATUSES, STATUS_LABELS, VERIFICATION_LABELS, type Status } from '../../shared/domain';
import { DataTable, Pagination } from '../components/DataTable';
import { Badge, Button, Card, ErrorBox, LinkButton, Modal, PageHeader, SelectInput, Tabs, TextInput } from '../components/ui';
import { ConditionBadge, StatusBadge } from '../components/domain';
import { AdjustModal, MoveModal } from '../components/inventoryModals';
import { fmtDate, fmtNum } from '../lib/format';
import { useItemTypes, useListParams, useLocations } from '../lib/hooks';
import { useAuth } from '../lib/auth';

export default function Inventory() {
  const { can } = useAuth();
  const nav = useNavigate();
  const types = useItemTypes();
  const locations = useLocations();
  const { params, set, page, toggleSort } = useListParams({ tab: 'pecas' });
  const tab = params.tab;
  const type = types.byId[params.itemTypeId ?? ''];
  const filters = { itemTypeId: params.itemTypeId, sizeId: params.sizeId, status: params.status, condition: params.condition, locationId: params.locationId };
  const garments = useQuery({ queryKey: ['garments', params], queryFn: () => api.get<Page<any>>('/inventory/garments', { ...filters, q: params.q, origin: params.origin, sort: params.sort, dir: params.dir, page, pageSize: 50 }), enabled: tab === 'pecas', placeholderData: (p) => p });
  const balances = useQuery({ queryKey: ['balances', filters], queryFn: () => api.get<{ items: any[] }>('/inventory/balances', filters), enabled: tab === 'quantidades' });
  const summary = useQuery({ queryKey: ['summary', params.itemTypeId, params.locationId], queryFn: () => api.get<{ items: any[] }>('/inventory/summary', { itemTypeId: params.itemTypeId, locationId: params.locationId }), enabled: tab === 'resumo' });
  const [move, setMove] = useState<any>(null);
  const [adjust, setAdjust] = useState(false);
  const [labels, setLabels] = useState(false);
  const [labelStart, setLabelStart] = useState('1');
  const [codeSearch, setCodeSearch] = useState('');
  const [consistency, setConsistency] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);

  const exportParams = { ...filters, q: params.q };
  async function goCode() {
    setErr(null);
    try {
      const g = await api.get<{ id: string }>(`/inventory/garments/by-code/${encodeURIComponent(codeSearch.trim())}`);
      nav(`/inventario/pecas/${g.id}`);
    } catch (e) {
      setErr(e);
    }
  }
  async function check() {
    setErr(null);
    try {
      setConsistency(await api.get('/inventory/consistency'));
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <div>
      <PageHeader
        title="Inventário"
        subtitle="Peças individuais com código e artigos geridos por quantidade. O stock disponível exclui peças atribuídas, emprestadas, reservadas, em inspeção, quarentena, reparação ou abatidas."
        actions={
          <>
            {can('inventory.write') && <LinkButton to="/inventario/entrada">Entrada de stock</LinkButton>}
            <LinkButton variant="secondary" to="/inventario/contagens">Contagens físicas</LinkButton>
            {can('inventory.adjust') && <Button variant="secondary" onClick={() => setAdjust(true)}>Ajuste manual</Button>}
            {can('inventory.adjust') && <Button variant="ghost" onClick={check}>Verificar consistência</Button>}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <TextInput label="Ir para peça (código)" placeholder="Ex.: CAS-00012" value={codeSearch} onChange={(e) => setCodeSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && goCode()} />
        <Button variant="secondary" onClick={goCode} disabled={!codeSearch.trim()}>
          Abrir
        </Button>
      </div>
      <ErrorBox error={err} />
      {consistency && (
        <div className={`mb-4 rounded p-3 text-sm ${consistency.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'}`}>
          {consistency.ok ? 'Verificação concluída: saldos, estados das peças e empréstimos coincidem com o histórico de movimentos.' : `Foram encontradas inconsistências: ${consistency.balances.length} saldo(s), ${consistency.garments.length} peça(s), ${consistency.loans.length} linha(s) de empréstimo. Contacte o administrador técnico.`}
        </div>
      )}
      <Tabs
        active={tab}
        onChange={(k) => set({ tab: k })}
        tabs={[
          { key: 'pecas', label: 'Peças individuais' },
          { key: 'quantidades', label: 'Artigos por quantidade' },
          { key: 'resumo', label: 'Resumo por tipo e tamanho' },
        ]}
      />
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tab === 'pecas' && <TextInput label="Pesquisar" type="search" placeholder="Código, inscrição, notas" value={params.q ?? ''} onChange={(e) => set({ q: e.target.value })} />}
        <SelectInput label="Tipo" value={params.itemTypeId ?? ''} onChange={(e) => set({ itemTypeId: e.target.value, sizeId: undefined })} options={types.items.filter((t) => t.stock_enabled && (tab === 'resumo' || t.tracking_mode === (tab === 'pecas' ? 'individual' : 'quantidade'))).map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />
        {tab !== 'resumo' && type?.has_size ? <SelectInput label="Tamanho" value={params.sizeId ?? ''} onChange={(e) => set({ sizeId: e.target.value })} options={type.sizes.map((s) => ({ value: s.id, label: s.label }))} placeholder="Todos" /> : null}
        {tab !== 'resumo' && (
          <SelectInput label="Estado" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} options={[{ value: 'disponivel', label: 'Disponível' }, { value: 'disponivel,reservado,pendente_inspecao,quarentena,reparacao', label: 'Em armazém (todos)' }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i).concat(params.status && !STATUSES.includes(params.status as Status) && !params.status.startsWith('disponivel,') ? [{ value: params.status, label: params.status.split(',').map((s) => STATUS_LABELS[s as Status]).join(' + ') }] : [])} placeholder="Todos" />
        )}
        {tab !== 'resumo' && <SelectInput label="Conservação" value={params.condition ?? ''} onChange={(e) => set({ condition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} placeholder="Todas" />}
        <SelectInput label="Localização" value={params.locationId ?? ''} onChange={(e) => set({ locationId: e.target.value })} options={locations.items.map((l) => ({ value: l.id, label: l.name }))} placeholder="Todas" />
        {tab === 'pecas' && <SelectInput label="Origem" value={params.origin ?? ''} onChange={(e) => set({ origin: e.target.value })} options={ORIGINS.map((o) => ({ value: o, label: ORIGIN_LABELS[o] }))} placeholder="Todas" />}
      </div>
      {can('export') && (
        <div className="no-print mb-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => download('/reports/datasets/inventario/csv', exportParams)}>CSV (filtrado)</Button>
          <Button size="sm" variant="secondary" onClick={() => download('/reports/datasets/inventario/xlsx', exportParams)}>Excel (filtrado)</Button>
          <Button size="sm" variant="secondary" onClick={() => download('/reports/datasets/inventario/pdf', exportParams)}>PDF (filtrado)</Button>
          {tab === 'pecas' && <Button size="sm" variant="secondary" onClick={() => setLabels(true)}>Etiquetas QR</Button>}
        </div>
      )}

      {tab === 'pecas' && (
        <>
          <DataTable
            rows={garments.data?.items}
            loading={garments.isFetching}
            error={garments.error}
            onRetry={() => garments.refetch()}
            rowKey={(r) => r.id}
            sort={params.sort}
            dir={params.dir as 'asc'}
            onSort={toggleSort}
            onRowClick={(r) => nav(`/inventario/pecas/${r.id}`)}
            emptyTitle="Sem peças individuais"
            emptyHint={can('inventory.write') ? 'Registe o stock existente em «Entrada de stock».' : undefined}
            columns={[
              { key: 'code', header: 'Código', sortKey: 'code', render: (r) => <Link className="font-mono font-medium text-marinho-700 underline" to={`/inventario/pecas/${r.id}`}>{r.code}</Link> },
              { key: 'type', header: 'Artigo', sortKey: 'type', render: (r) => r.item_type_name },
              { key: 'size', header: 'Tamanho', sortKey: 'size', render: (r) => r.size_label ?? '—' },
              { key: 'insc', header: 'Inscrição', render: (r) => r.inscription ?? '—' },
              { key: 'cond', header: 'Conservação', sortKey: 'condition', render: (r) => <ConditionBadge condition={r.condition} /> },
              { key: 'status', header: 'Estado', sortKey: 'status', render: (r) => <span className="flex flex-col gap-0.5"><StatusBadge status={r.status} />{r.holder_name && <span className="text-xs text-slate-500">{r.holder_name}</span>}</span> },
              { key: 'loc', header: 'Localização', sortKey: 'location', render: (r) => r.location_name ?? '—' },
              { key: 'ver', header: 'Verificação', render: (r) => (r.verification === 'contado' ? '' : <Badge tone="amber">{VERIFICATION_LABELS[r.verification as 'estimado']}</Badge>) },
              { key: 'entry', header: 'Entrada', sortKey: 'entry', render: (r) => fmtDate(r.entry_date) },
            ]}
          />
          {garments.data && <Pagination page={page} pageSize={50} total={garments.data.total} onPage={(p) => set({ page: String(p) }, false)} />}
        </>
      )}

      {tab === 'quantidades' && (
        <DataTable
          rows={balances.data?.items}
          loading={balances.isFetching}
          error={balances.error}
          rowKey={(r) => r.bucket_key}
          emptyTitle="Sem stock por quantidade"
          columns={[
            { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
            { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? '—' },
            { key: 'c', header: 'Conservação', render: (r) => <ConditionBadge condition={r.condition} /> },
            { key: 'st', header: 'Estado', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'l', header: 'Localização', render: (r) => r.location_name ?? '—' },
            { key: 'q', header: 'Quantidade', align: 'right', render: (r) => <strong>{fmtNum(r.quantity)}</strong> },
            { key: 'v', header: 'Verificação', render: (r) => (r.verification === 'contado' ? (r.last_counted_at ? `Contado ${fmtDate(r.last_counted_at)}` : 'Contado') : <Badge tone="amber">{VERIFICATION_LABELS[r.verification as 'estimado']}</Badge>) },
            {
              key: 'a',
              header: '',
              render: (r) =>
                can('inventory.write') && !['atribuido', 'emprestado', 'abatido', 'extraviado', 'rejeitado'].includes(r.status) && (
                  <Button size="sm" variant="ghost" onClick={() => setMove({ kind: 'balance', bucketKey: r.bucket_key, label: `${r.item_type_name} ${r.size_label ?? ''}`, status: r.status, condition: r.condition, locationId: r.location_id, quantity: r.quantity })}>
                    Movimentar
                  </Button>
                ),
            },
          ]}
        />
      )}

      {tab === 'resumo' && (
        <Card>
          <DataTable
            rows={summary.data?.items}
            loading={summary.isFetching}
            error={summary.error}
            rowKey={(r) => `${r.item_type_id}-${r.size_id}`}
            emptyTitle="Inventário vazio"
            columns={[
              { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
              { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? '—' },
              ...(['disponivel', 'reservado', 'atribuido', 'emprestado', 'pendente_inspecao', 'quarentena', 'reparacao', 'abatido', 'extraviado'] as Status[]).map((s) => ({
                key: s,
                header: STATUS_LABELS[s],
                align: 'right' as const,
                render: (r: any) => (r[s] ? <Link className={s === 'disponivel' ? 'font-bold text-emerald-700 underline' : 'underline'} to={`/inventario?tab=${r.tracking_mode === 'individual' ? 'pecas' : 'quantidades'}&itemTypeId=${r.item_type_id}${r.size_id ? `&sizeId=${r.size_id}` : ''}&status=${s}`}>{fmtNum(r[s])}</Link> : <span className="text-slate-300">0</span>),
              })),
            ]}
          />
          <p className="mt-2 text-xs text-slate-500">Cada coluna mostra um estado distinto; o stock disponível é apenas a primeira coluna.</p>
        </Card>
      )}

      {move && <MoveModal open target={move} onClose={() => setMove(null)} />}
      {adjust && <AdjustModal open onClose={() => setAdjust(false)} />}
      <Modal
        open={labels}
        onClose={() => setLabels(false)}
        title="Etiquetas com código QR"
        footer={
          <Button
            onClick={() => {
              download('/reports/labels.pdf', { ...filters, q: params.q, start: labelStart });
              setLabels(false);
            }}
          >
            Gerar PDF
          </Button>
        }
      >
        <p className="text-sm text-slate-600">Gera uma folha A4 com 24 etiquetas (3 × 8, 70 × 37 mm) para as peças da lista atual (máx. 500). Ao ler o QR com o telemóvel abre a ficha da peça (requer sessão iniciada).</p>
        <TextInput className="mt-3" label="Começar na etiqueta n.º" type="number" min={1} max={24} value={labelStart} onChange={(e) => setLabelStart(e.target.value)} hint="Útil para aproveitar folhas parcialmente usadas." />
      </Modal>
    </div>
  );
}
