import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Card, ErrorBox, Loading, PageHeader, SelectInput, Stat, TextInput, LinkButton, Badge } from '../components/ui';
import { MovementsTable, type MovementRow } from '../components/domain';
import { fmtDate, fmtNum } from '../lib/format';
import { useItemTypes, useListParams } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { EVENT_STATUS_LABELS } from '../../shared/domain';

interface DashboardData {
  byStatus: Record<string, number>;
  availableByCategory: { category: string; item_type_name: string; item_type_id: string; available: number; min_available: number | null }[];
  counts: Record<string, number>;
  recent: MovementRow[];
  activeEvents: { id: string; name: string; start_date: string; end_date: string | null; status: string; campaign_name: string | null; pending: number }[];
}

export default function Dashboard() {
  const { can } = useAuth();
  const types = useItemTypes();
  const { params, set } = useListParams();
  const q = useQuery({ queryKey: ['dashboard', params], queryFn: () => api.get<DashboardData>('/dashboard', { itemTypeId: params.itemTypeId, from: params.from, to: params.to }) });
  const s = q.data?.byStatus ?? {};
  const c = q.data?.counts ?? {};
  const max = Math.max(1, ...(q.data?.availableByCategory.map((x) => x.available) ?? [1]));
  return (
    <div>
      <PageHeader
        title="Painel de controlo"
        subtitle="Situação atual do fardamento, calculada a partir dos registos."
        actions={
          <>
            {can('deliveries.write') && <LinkButton to="/entregas/nova">Nova entrega</LinkButton>}
            {can('loans.write') && <LinkButton to="/emprestimos/novo" variant="secondary">Novo empréstimo</LinkButton>}
            {can('returns.write') && <LinkButton to="/recolhas/nova" variant="secondary">Nova recolha</LinkButton>}
          </>
        }
      />
      <div className="no-print mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:max-w-3xl">
        <SelectInput label="Tipo de artigo" value={params.itemTypeId ?? ''} onChange={(e) => set({ itemTypeId: e.target.value })} options={types.items.map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />
        <TextInput label="Movimentos desde" type="date" value={params.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        <TextInput label="até" type="date" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Peças individuais" value={fmtNum(c.garments_total)} hint="Excluindo abatidas/extraviadas" to="/inventario" />
            <Stat label="Disponível" tone="green" value={fmtNum(s.disponivel)} to="/inventario?status=disponivel" />
            <Stat label="Reservado" value={fmtNum(s.reservado)} to="/inventario?status=reservado" />
            <Stat label="Atribuído a músicos" value={fmtNum(s.atribuido)} to="/inventario?status=atribuido" />
            <Stat label="Emprestado" value={fmtNum(s.emprestado)} hint="Ainda não devolvido" to="/emprestimos?state=pendentes" />
            <Stat label="Reparação / quarentena" tone="amber" value={`${fmtNum(s.reparacao)} / ${fmtNum(s.quarentena)}`} to="/inventario?status=reparacao,quarentena" />
            <Stat label="Pendente de inspeção" tone="amber" value={fmtNum(s.pendente_inspecao)} to="/inventario?status=pendente_inspecao" />
            <Stat label="Necessidades por satisfazer" value={fmtNum(c.needs_open)} hint={`${fmtNum(c.musicians_pending)} músico(s)`} to="/necessidades" />
            <Stat label="Entregas incompletas" tone="amber" value={fmtNum(c.musicians_incomplete)} hint="Músicos com entrega parcial" to="/musicos?pending=entregas" />
            <Stat label="Recolhas por inspecionar" tone={c.returns_uninspected ? 'amber' : 'green'} value={fmtNum(c.returns_uninspected)} to="/recolhas?status=por_decidir" />
            <Stat label="Empréstimos atrasados" tone={c.loans_overdue ? 'red' : 'green'} value={fmtNum(c.loans_overdue)} to="/emprestimos?state=atrasados" />
            <Stat label="Festas ativas" value={fmtNum(c.events_active)} to="/festas" />
          </div>
          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Card title="Stock disponível por artigo">
              <ul className="space-y-2">
                {q.data!.availableByCategory.map((r) => (
                  <li key={r.item_type_id}>
                    <Link to={`/inventario?itemTypeId=${r.item_type_id}&status=disponivel`} className="flex items-center gap-3 text-sm hover:underline">
                      <span className="w-28 shrink-0">{r.item_type_name}</span>
                      <span className="h-3 flex-1 rounded bg-slate-100" aria-hidden>
                        <span className="block h-3 rounded bg-marinho-500" style={{ width: `${(r.available / max) * 100}%` }} />
                      </span>
                      <span className="w-12 text-right font-semibold tabular-nums">{fmtNum(r.available)}</span>
                      {r.min_available !== null && r.available < r.min_available && <Badge tone="red">abaixo do mínimo</Badge>}
                    </Link>
                  </li>
                ))}
                {!q.data!.availableByCategory.length && <li className="text-sm text-slate-500">Sem tipos de artigo ativos.</li>}
              </ul>
              {c.shoes_open > 0 && <p className="mt-3 text-xs text-slate-500">Necessidades de sapatos por resolver: {c.shoes_open} (não incluídas na aquisição).</p>}
            </Card>
            <Card title="Festas ativas" actions={<LinkButton size="sm" variant="ghost" to="/festas">Ver todas</LinkButton>}>
              {q.data!.activeEvents.length ? (
                <ul className="divide-y">
                  {q.data!.activeEvents.map((e) => (
                    <li key={e.id} className="flex items-center justify-between py-2 text-sm">
                      <Link to={`/festas/${e.id}`} className="font-medium text-marinho-700 hover:underline">
                        {e.name}
                        <span className="block text-xs font-normal text-slate-500">
                          {fmtDate(e.start_date)}
                        </span>
                      </Link>
                      <span className="flex gap-2">
                        <Badge tone="navy">{EVENT_STATUS_LABELS[e.status as 'ativa']}</Badge>
                        {e.pending > 0 && <Badge tone="amber">{e.pending} por devolver</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Nenhuma festa planeada ou a decorrer.</p>
              )}
            </Card>
          </div>
          <Card className="mt-5" title="Movimentos recentes" actions={<LinkButton size="sm" variant="ghost" to="/movimentos">Histórico completo</LinkButton>}>
            <MovementsTable rows={q.data!.recent} />
          </Card>
        </>
      )}
    </div>
  );
}
