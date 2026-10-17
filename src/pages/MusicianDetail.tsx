import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, download } from '../api/client';
import { DESTINATION_LABELS, LOAN_STATE_LABELS, MUSICIAN_KIND_LABELS, MUSICIAN_STATUS_LABELS, REQUEST_PROGRESS_LABELS, REQUEST_STATUS_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, DefList, ErrorBox, LinkButton, Loading, PageHeader, Tabs, type Tone } from '../components/ui';
import { ConditionBadge, MovementsTable, Photos, StatusBadge, type MovementRow } from '../components/domain';
import { MusicianModal, RequestModal, type RequestRowLite } from '../components/forms';
import { fmtDate, fmtDateTime } from '../lib/format';
import { DangerAction } from '../components/DangerAction';
import { MEASUREMENT_FIELDS, MeasurementsModal, OrderModal, type Measurements } from '../components/order';
import { MessageModal, type MessageTemplate } from '../components/messages';
import { ExistingUniformModal } from '../components/existing';
import { firstName } from '../lib/phone';

function musicianTemplates(
  fullName: string,
  missing: { item_type_name: string; missing: number; sizes: string | null }[],
  toReturn: { item_type_name: string; return_expected: number; returned: number }[],
): MessageTemplate[] {
  const nome = firstName(fullName);
  const items = missing.map((t) => `- ${t.missing} × ${t.item_type_name}${t.sizes ? ` (tam. ${t.sizes})` : ''}`).join('\n');
  const back = toReturn.map((t) => `- ${t.return_expected - t.returned} × ${t.item_type_name}`).join('\n');
  const list: MessageTemplate[] = [
    { key: 'livre', label: 'Mensagem livre', text: `Olá ${nome},\n\n\n\nCumprimentos,\nBanda Marcial de Gueifães` },
    {
      key: 'levantar',
      label: 'Fardamento pronto para levantar',
      text: `Olá ${nome}, o teu fardamento novo já está disponível para levantar${items ? `:\n${items}` : '.'}\n\nCombina connosco o dia para o levantamento.\nBanda Marcial de Gueifães`,
    },
    {
      key: 'devolver',
      label: 'Devolver fardamento antigo',
      text: `Olá ${nome}, lembramos que é necessário entregar o fardamento antigo${back ? `:\n${back}` : '.'}\n\nObrigado!\nBanda Marcial de Gueifães`,
    },
    {
      key: 'medidas',
      label: 'Pedir tamanhos / medidas',
      text: `Olá ${nome}, para prepararmos o teu fardamento precisamos de confirmar os teus tamanhos (casaco, calças, camisa, boné). Podes enviar-nos?\n\nObrigado!\nBanda Marcial de Gueifães`,
    },
  ];
  return list;
}
import { useAuth } from '../lib/auth';

interface Detail {
  musician: Record<string, any>;
  measurements: Measurements | null;
  requests: (RequestRowLite & { item_type_name: string; size_label: string | null; progress: string; quantity_missing: number })[];
  deliveries: { id: string; delivered_at: string; delivered_by_name: string; status: string; kind: string; received_by_name: string | null }[];
  deliveryLines: { id: string; delivery_id: string; item_type_name: string; size_label: string | null; garment_code: string | null; garment_id: string | null; inscription: string | null; quantity: number; status: string; condition: string; returned_quantity: number }[];
  returns: { id: string; received_at: string; inspection_status: string; received_by_name: string }[];
  returnLines: { id: string; return_id: string; item_type_name: string; size_label: string | null; size_text: string | null; garment_code: string | null; garment_id: string | null; quantity: number; observed_condition: string; approved_destination: string | null }[];
  loans: { id: string; delivered_at: string; due_date: string | null; event_id: string; event_name: string; quantity: number; returned: number; lost: number; pending: number }[];
  holdings: { id: string; code: string; inscription: string | null; status: string; item_type_name: string; size_label: string | null }[];
  typeSummary: { item_type_id: string; item_type_name: string; procurement_enabled: number; requested: number; delivered: number; missing: number; return_expected: number; returned: number; sizes: string | null }[];
  movements: MovementRow[];
  audit: { action: string; created_at: string; user_name: string; summary: string | null }[];
}

const PROGRESS_TONE: Record<string, Tone> = { pendente: 'amber', encomendada: 'blue', recebida: 'purple', parcial: 'orange', entregue: 'green', cancelada: 'grey', por_avaliar: 'amber', confirmada: 'blue', resolvida: 'green' };
const PROGRESS = { ...REQUEST_PROGRESS_LABELS, ...(REQUEST_STATUS_LABELS as Record<string, string>) };

export default function MusicianDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [orderOpen, setOrderOpen] = useState(false);
  const [measOpen, setMeasOpen] = useState(false);
  const [archiveErr, setArchiveErr] = useState<unknown>(null);
  const [msgOpen, setMsgOpen] = useState(false);
  const [existingOpen, setExistingOpen] = useState(false);
  useEffect(() => {
    if (sp.get('pedido') === '1') {
      setOrderOpen(true);
      setSp({}, { replace: true });
    }
  }, [sp, setSp]);
  const [tab, setTab] = useState('resumo');
  const [editing, setEditing] = useState(false);
  const [reqModal, setReqModal] = useState<{ existing?: RequestRowLite } | null>(null);
  const q = useQuery({ queryKey: ['musician', id], queryFn: () => api.get<Detail>(`/musicians/${id}`) });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const m = d.musician;
  const missing = d.typeSummary.filter((t) => t.missing > 0);
  const toReturn = d.typeSummary.filter((t) => t.return_expected > t.returned);
  const shoes = d.requests.filter((r) => !r.procurement_enabled && ['por_avaliar', 'confirmada'].includes(r.status));

  return (
    <div>
      <PageHeader
        back={{ to: '/musicos', label: 'Músicos' }}
        title={m.full_name}
        subtitle={
          <span className="flex flex-wrap gap-2">
            {m.instrument ? <Badge tone="purple">♪ {m.instrument}</Badge> : <Badge tone="amber">Instrumento por indicar</Badge>}
            {m.internal_code && <Badge tone="navy">N.º {m.internal_code}</Badge>}
            <Badge tone={m.kind === 'banda' ? 'navy' : 'blue'}>{MUSICIAN_KIND_LABELS[m.kind as 'banda']}</Badge>
            <Badge tone={m.status === 'ativo' ? 'green' : 'grey'}>{MUSICIAN_STATUS_LABELS[m.status as 'ativo']}</Badge>
          </span>
        }
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/musician/${id}`)}>Ficha em PDF</Button>}
            {can('requests.write') && <Button onClick={() => setOrderOpen(true)}>Pedido de fardamento</Button>}
            {can('musicians.write') && <Button variant="secondary" onClick={() => setMsgOpen(true)}>Enviar mensagem</Button>}
            {can('musicians.write') && <Button variant="secondary" onClick={() => setEditing(true)}>Editar</Button>}
            {can('returns.write') && <LinkButton variant="secondary" to={`/recolhas/nova?musico=${id}`}>Registar recolha</LinkButton>}
            {can('deliveries.write') && <Button variant="secondary" onClick={() => setExistingOpen(true)}>Fardamento que já tem</Button>}
            {can('deliveries.write') && <LinkButton to={`/entregas/nova?musico=${id}`}>Entregar fardamento</LinkButton>}
            {can('musicians.write') && (
              <DangerAction
                variant="ghost"
                label="Eliminar"
                title="Eliminar músico"
                message={
                  <>
                    <p>Eliminar definitivamente <strong>{m.full_name}</strong>, incluindo o pedido de fardamento e as medidas?</p>
                    <p className="mt-2 text-xs text-slate-500">Só é possível se ainda não houver entregas, recolhas, empréstimos ou movimentos. Caso contrário, altere o estado para «Arquivado».</p>
                  </>
                }
                onConfirm={async () => {
                  try {
                    await api.del(`/musicians/${id}`);
                  } catch (e) {
                    setArchiveErr(e);
                    throw e;
                  }
                }}
                onDone={() => nav('/musicos', { replace: true })}
              />
            )}
          </>
        }
      />
      {archiveErr instanceof ApiError && archiveErr.code === 'COM_HISTORICO' && m.status !== 'arquivado' && can('musicians.write') && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Este músico tem histórico de fardamento e não pode ser eliminado.
          <Button size="sm" variant="secondary" onClick={async () => { await api.patch(`/musicians/${id}`, { status: 'arquivado' }); setArchiveErr(null); q.refetch(); }}>
            Arquivar músico
          </Button>
        </div>
      )}
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'resumo', label: 'Resumo' },
          { key: 'necessidades', label: `Pedido de fardamento (${d.requests.length})` },
          { key: 'entregas', label: `Entregas (${d.deliveries.length})` },
          { key: 'antigo', label: `Fardamento antigo (${d.returns.length})` },
          { key: 'emprestimos', label: `Empréstimos (${d.loans.length})` },
          { key: 'fotos', label: 'Observações e fotografias' },
          { key: 'historico', label: 'Histórico' },
        ]}
      />

      {tab === 'resumo' && (
        <div className="grid gap-4 lg:grid-cols-2">
          {!d.requests.length && can('requests.write') && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-marinho-200 bg-marinho-50 p-4 lg:col-span-2">
              <p className="text-sm text-marinho-900">Ainda não foi registado o pedido de fardamento deste músico (tamanhos, quantidades e peças antigas a devolver).</p>
              <Button onClick={() => setOrderOpen(true)}>Registar pedido de fardamento</Button>
            </div>
          )}
          <Card title="Falta entregar">
            {missing.length || shoes.length ? (
              <ul className="space-y-1 text-sm">
                {missing.map((t) => (
                  <li key={t.item_type_id}>
                    <strong>{t.missing}</strong> × {t.item_type_name} {t.sizes && <span className="text-slate-500">(tam. {t.sizes})</span>}
                  </li>
                ))}
                {shoes.map((s) => (
                  <li key={s.id}>
                    {s.item_type_name} {s.size_label ?? s.size_text ? `(tam. ${s.size_label ?? s.size_text})` : ''} — <Badge tone="purple">{PROGRESS[s.status]}</Badge> <span className="text-xs text-slate-500">(sem aquisição)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700">Nada por entregar.</p>
            )}
          </Card>
          <Card title="Falta devolver (fardamento antigo)">
            {toReturn.length ? (
              <ul className="space-y-1 text-sm">
                {toReturn.map((t) => (
                  <li key={t.item_type_id}>
                    <strong>{t.return_expected - t.returned}</strong> × {t.item_type_name} <span className="text-slate-500">({t.returned} de {t.return_expected} devolvidas)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700">Nada por devolver.</p>
            )}
            {d.returns.some((r) => r.inspection_status !== 'concluida') && <p className="mt-2 text-sm text-amber-800">Há recolhas deste músico a aguardar inspeção.</p>}
            {toReturn.length > 0 && can('returns.write') && (
              <LinkButton className="mt-3" size="sm" to={`/recolhas/nova?musico=${id}`}>
                Registar devolução do fardamento antigo
              </LinkButton>
            )}
          </Card>
          <Card title="Medidas" actions={can('musicians.write') && <Button size="sm" variant="secondary" onClick={() => setMeasOpen(true)}>{d.measurements ? 'Editar medidas' : 'Registar medidas'}</Button>} className="lg:col-span-2">
            {d.measurements ? (
              <>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  {MEASUREMENT_FIELDS.filter(([col]) => d.measurements![col] != null).map(([col, , label]) => (
                    <div key={col} className="flex justify-between border-b border-slate-100 py-1">
                      <dt className="text-slate-500">{label}</dt>
                      <dd className="font-medium">{String(d.measurements![col]).replace('.', ',')} cm</dd>
                    </div>
                  ))}
                  {d.measurements.shoe_size && (
                    <div className="flex justify-between border-b border-slate-100 py-1">
                      <dt className="text-slate-500">Sapato</dt>
                      <dd className="font-medium">{d.measurements.shoe_size}</dd>
                    </div>
                  )}
                </dl>
                {d.measurements.notes && <p className="mt-2 text-sm text-slate-600">{d.measurements.notes}</p>}
                <p className="mt-2 text-xs text-slate-500">Medidas de {fmtDate(d.measurements.measured_at)}{d.measurements.updated_by_name ? ` · registadas por ${d.measurements.updated_by_name}` : ''}</p>
              </>
            ) : (
              <p className="text-sm text-slate-500">Sem medidas registadas.</p>
            )}
          </Card>
          <Card title="Resumo por artigo" className="lg:col-span-2">
            <DataTable
              rows={d.typeSummary}
              rowKey={(r) => r.item_type_id}
              emptyTitle="Sem necessidades nem entregas registadas"
              columns={[
                { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
                { key: 's', header: 'Tamanho(s)', render: (r) => r.sizes ?? '—' },
                { key: 'r', header: 'Pretendido', align: 'right', render: (r) => r.requested },
                { key: 'd', header: 'Entregue', align: 'right', render: (r) => r.delivered },
                { key: 'm', header: 'Falta', align: 'right', render: (r) => (r.missing ? <strong className="text-amber-700">{r.missing}</strong> : 0) },
                { key: 'e', header: 'A devolver', align: 'right', render: (r) => r.return_expected },
                { key: 'x', header: 'Devolvido', align: 'right', render: (r) => r.returned },
              ]}
            />
          </Card>
          <Card title="Peças atribuídas (com código)" className="lg:col-span-2" actions={can('deliveries.write') && <Button size="sm" variant="secondary" onClick={() => setExistingOpen(true)}>Registar fardamento que já tem</Button>}>
            {d.holdings.length ? (
              <ul className="flex flex-wrap gap-2 text-sm">
                {d.holdings.map((g) => (
                  <li key={g.id}>
                    <Link to={`/inventario/pecas/${g.id}`} className="rounded border px-2 py-1 hover:bg-marinho-50">
                      <span className="font-mono">{g.code}</span> {g.item_type_name} {g.size_label} {g.inscription && `«${g.inscription}»`} <StatusBadge status={g.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Nenhuma peça individual na posse do músico.</p>
            )}
          </Card>
          <Card title="Dados do músico" className="lg:col-span-2">
            <DefList items={[['Instrumento', m.instrument], ['Telemóvel', m.phone], ['Outro contacto', m.contact], ['Banda de origem', m.origin_band], ['Registado em', fmtDateTime(m.created_at)], ['Atualizado em', fmtDateTime(m.updated_at)]]} />
          </Card>
        </div>
      )}

      {tab === 'necessidades' && (
        <Card
          title="Pedido de fardamento (artigos, tamanhos e quantidades)"
          actions={
            can('requests.write') && (
              <>
                <Button size="sm" onClick={() => setOrderOpen(true)}>Editar pedido completo</Button>
                <Button size="sm" variant="secondary" onClick={() => setReqModal({})}>Adicionar um artigo</Button>
              </>
            )
          }
        >
          <DataTable
            rows={d.requests}
            rowKey={(r) => r.id}
            emptyTitle="Sem necessidades registadas"
            columns={[
              { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
              { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? r.size_text ?? '—' },
              { key: 'q', header: 'Pretendida', align: 'right', render: (r) => r.quantity_requested },
              { key: 'o', header: 'Encomendada', align: 'right', render: (r) => (r.procurement_enabled ? r.quantity_ordered : '—') },
              { key: 'rc', header: 'Recebida', align: 'right', render: (r) => (r.procurement_enabled ? r.quantity_received : '—') },
              { key: 'd', header: 'Entregue', align: 'right', render: (r) => (r.procurement_enabled ? r.quantity_delivered : '—') },
              { key: 'rt', header: 'Antigas a devolver', align: 'right', render: (r) => r.return_expected },
              { key: 'p', header: 'Situação', render: (r) => <Badge tone={PROGRESS_TONE[r.progress] ?? 'grey'}>{PROGRESS[r.progress] ?? r.progress}</Badge> },
              { key: 'n', header: 'Observações', render: (r) => <span className="text-slate-600">{r.notes}</span> },
              ...(can('requests.write')
                ? [
                    {
                      key: 'a',
                      header: '',
                      render: (r: RequestRowLite) => (
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setReqModal({ existing: r })}>Editar</Button>
                          {r.quantity_delivered === 0 && (
                            <DangerAction
                              size="sm"
                              variant="ghost"
                              label="Eliminar"
                              title="Eliminar pedido"
                              message="Eliminar este artigo do pedido do músico?"
                              onConfirm={() => api.del(`/requests/${r.id}`)}
                            />
                          )}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}

      {tab === 'entregas' && (
        <Card title="Entregas de fardamento novo" actions={can('deliveries.write') && <LinkButton size="sm" to={`/entregas/nova?musico=${id}`}>Nova entrega</LinkButton>}>
          {d.deliveries.length ? (
            <div className="space-y-4">
              {d.deliveries.map((dv) => (
                <div key={dv.id} className="rounded border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <Link to={`/entregas/${dv.id}`} className="font-medium text-marinho-700 hover:underline">
                      {dv.kind === 'existente' ? 'Fardamento que já tinha (registado' : 'Entrega de'} {fmtDate(dv.delivered_at)}{dv.kind === 'existente' ? ')' : ''} — {dv.delivered_by_name}
                      {dv.status === 'anulada' && ' · anulado'}
                    </Link>
                    {can('export') && <Button size="sm" variant="ghost" onClick={() => download(`/reports/pdf/delivery/${dv.id}`)}>Folha de entrega (PDF)</Button>}
                  </div>
                  <ul className="text-sm">
                    {d.deliveryLines.filter((l) => l.delivery_id === dv.id).map((l) => (
                      <li key={l.id} className={l.status === 'anulada' ? 'text-slate-400 line-through' : ''}>
                        {l.quantity} × {l.item_type_name} {l.size_label && `(${l.size_label})`} {l.garment_code && <Link to={`/inventario/pecas/${l.garment_id}`} className="font-mono text-xs underline">{l.garment_code}</Link>} {l.inscription && `«${l.inscription}»`}
                        {l.returned_quantity > 0 && <span className="ml-1"><Badge tone="grey">{l.returned_quantity} devolvida(s)</Badge></span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Ainda não foi entregue fardamento a este músico.</p>
          )}
        </Card>
      )}

      {tab === 'antigo' && (
        <Card title="Fardamento antigo devolvido" actions={can('returns.write') && <LinkButton size="sm" to={`/recolhas/nova?musico=${id}`}>Registar recolha</LinkButton>}>
          <DataTable
            rows={d.returnLines}
            rowKey={(r) => r.id}
            emptyTitle="Sem devoluções registadas"
            columns={[
              { key: 'r', header: 'Recolha', render: (r) => { const ret = d.returns.find((x) => x.id === r.return_id); return <Link className="underline" to={`/recolhas/${r.return_id}`}>{fmtDate(ret?.received_at)}</Link>; } },
              { key: 't', header: 'Artigo', render: (r) => r.item_type_name },
              { key: 's', header: 'Tamanho', render: (r) => r.size_label ?? r.size_text ?? '—' },
              { key: 'c', header: 'Código', render: (r) => (r.garment_code ? <Link className="font-mono text-xs underline" to={`/inventario/pecas/${r.garment_id}`}>{r.garment_code}</Link> : '—') },
              { key: 'q', header: 'Qtd.', align: 'right', render: (r) => r.quantity },
              { key: 'o', header: 'Estado observado', render: (r) => <ConditionBadge condition={r.observed_condition} /> },
              { key: 'd', header: 'Destino', render: (r) => (r.approved_destination ? DESTINATION_LABELS[r.approved_destination as 'disponivel'] : <Badge tone="amber">Por inspecionar</Badge>) },
            ]}
          />
        </Card>
      )}

      {tab === 'emprestimos' && (
        <Card title="Histórico de empréstimos">
          <DataTable
            rows={d.loans}
            rowKey={(r) => r.id}
            emptyTitle="Sem empréstimos"
            columns={[
              { key: 'e', header: 'Festa', render: (r) => <Link className="underline" to={`/festas/${r.event_id}`}>{r.event_name}</Link> },
              { key: 'd', header: 'Entregue em', render: (r) => <Link className="underline" to={`/emprestimos/${r.id}`}>{fmtDate(r.delivered_at)}</Link> },
              { key: 'p', header: 'Prazo', render: (r) => fmtDate(r.due_date) },
              { key: 'q', header: 'Emprestado', align: 'right', render: (r) => r.quantity },
              { key: 'r', header: 'Devolvido', align: 'right', render: (r) => r.returned },
              { key: 'f', header: 'Em falta', align: 'right', render: (r) => (r.pending ? <strong className="text-amber-700">{r.pending}</strong> : 0) },
              { key: 's', header: 'Situação', render: (r) => <Badge tone={r.pending ? 'amber' : 'green'}>{r.pending ? LOAN_STATE_LABELS.aberto : r.lost ? LOAN_STATE_LABELS.com_perdas : LOAN_STATE_LABELS.devolvido}</Badge> },
            ]}
          />
        </Card>
      )}

      {tab === 'fotos' && (
        <Card title="Observações e fotografias">
          <p className="mb-4 whitespace-pre-wrap text-sm text-slate-700">{m.notes || 'Sem observações.'}</p>
          <Photos entityType="musician" entityId={id} />
        </Card>
      )}

      {tab === 'historico' && (
        <div className="space-y-4">
          <Card title="Movimentos de stock relacionados">
            <MovementsTable rows={d.movements} />
          </Card>
          <Card title="Operações registadas">
            <ul className="divide-y text-sm">
              {d.audit.map((a, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>{a.action.replace(/[._]/g, ' ')}</span>
                  <span className="text-slate-500">{a.user_name} · {fmtDateTime(a.created_at)}</span>
                </li>
              ))}
              {!d.audit.length && <li className="text-slate-500">Sem operações registadas.</li>}
            </ul>
          </Card>
        </div>
      )}

      {editing && (
        <MusicianModal
          open
          id={id}
          onClose={() => setEditing(false)}
          initial={{ fullName: m.full_name, instrument: m.instrument ?? '', phone: m.phone ?? '', internalCode: m.internal_code ?? '', kind: m.kind, status: m.status, contact: m.contact ?? '', originBand: m.origin_band ?? '', notes: m.notes ?? '' }}
        />
      )}
      {existingOpen && <ExistingUniformModal open musicianId={id} musicianName={m.full_name} requests={d.requests} onClose={() => setExistingOpen(false)} />}
      {msgOpen && (
        <MessageModal
          open
          onClose={() => setMsgOpen(false)}
          name={m.full_name}
          phone={m.phone}
          editLink={`/musicos/${id}`}
          templates={musicianTemplates(m.full_name, missing, toReturn)}
          onSent={(channel, purpose) => api.post(`/musicians/${id}/contacted`, { channel, purpose }).catch(() => undefined)}
        />
      )}
      {orderOpen && <OrderModal open musicianId={id} musicianName={m.full_name} requests={d.requests} onClose={() => setOrderOpen(false)} />}
      {measOpen && <MeasurementsModal open musicianId={id} current={d.measurements} onClose={() => setMeasOpen(false)} />}
      {reqModal && <RequestModal open musicianId={id} existing={reqModal.existing} onClose={() => setReqModal(null)} />}
    </div>
  );
}
