import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Empty, ErrorBox, Loading, PageHeader, SelectInput } from '../components/ui';
import { fmtDate } from '../lib/format';
import { useListParams } from '../lib/hooks';

interface Alert {
  kind: string;
  severity: 'alta' | 'media' | 'baixa';
  title: string;
  detail: string;
  link: string;
  date?: string | null;
}

const KIND_LABELS: Record<string, string> = {
  emprestimo_atrasado: 'Empréstimos fora do prazo',
  emprestimo_pendente: 'Material emprestado por devolver',
  recolha_por_inspecionar: 'Recolhas por inspecionar',
  pendente_inspecao: 'Peças pendentes de inspeção',
  quarentena: 'Em quarentena',
  reparacao: 'Em reparação',
  entrega_incompleta: 'Entregas incompletas',
  devolucao_antiga_em_falta: 'Fardamento antigo por devolver',
  contagem_em_curso: 'Diferenças de inventário / contagens',
  stock_minimo: 'Stock abaixo do mínimo',
  ocorrencia: 'Ocorrências por resolver',
};

export default function Alerts() {
  const { params, set } = useListParams();
  const q = useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ items: Alert[] }>('/dashboard/alerts') });
  const items = (q.data?.items ?? []).filter((a) => !params.kind || a.kind === params.kind);
  return (
    <div>
      <PageHeader title="Alertas e pendências" subtitle="Calculados em tempo real a partir dos registos. Clique para abrir o registo associado." />
      <div className="mb-4 max-w-sm">
        <SelectInput label="Tipo de alerta" value={params.kind ?? ''} onChange={(e) => set({ kind: e.target.value })} options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} placeholder="Todos" />
      </div>
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <Loading /> : !items.length ? <Empty title="Sem alertas">Não há pendências a assinalar.</Empty> : (
        <ul className="space-y-2">
          {items.map((a, i) => (
            <li key={i}>
              <Link to={a.link} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:border-marinho-300">
                <Badge tone={a.severity === 'alta' ? 'red' : a.severity === 'media' ? 'amber' : 'grey'}>{a.severity === 'alta' ? 'Urgente' : a.severity === 'media' ? 'Atenção' : 'Info'}</Badge>
                <div className="flex-1">
                  <p className="font-medium text-marinho-800">{a.title}</p>
                  <p className="text-sm text-slate-600">{a.detail}</p>
                </div>
                {a.date && <span className="text-xs text-slate-500">{fmtDate(a.date)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
