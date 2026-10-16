import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge, Button, Card, LinkButton, Loading, PageHeader } from '../components/ui';
import { ItemTypesPanel, LocationsPanel, StatusReference } from './Settings';
import { useListParams } from '../lib/hooks';

interface Progress {
  steps: { key: string; label: string }[];
  progress: Record<string, boolean>;
  counts: Record<string, number>;
}

/** Assistente de configuração inicial — pode ser retomado em qualquer momento sem duplicar registos. */
export default function Wizard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup-progress'], queryFn: () => api.get<Progress>('/setup/progress') });
  const { params, set } = useListParams();
  if (!q.data) return <Loading />;
  const { steps, progress, counts } = q.data;
  const current = params.passo ?? steps.find((s) => !progress[s.key])?.key ?? 'item_types';
  const mark = async (step: string, done: boolean) => {
    await api.post('/setup/progress', { step, done });
    qc.invalidateQueries({ queryKey: ['setup-progress'] });
    if (done) {
      const next = steps.find((s) => s.key !== step && !progress[s.key]);
      if (next) set({ passo: next.key });
    }
  };
  const doneCount = steps.filter((s) => progress[s.key]).length;
  return (
    <div>
      <PageHeader title="Assistente inicial" subtitle={`Configuração da aplicação: ${doneCount} de ${steps.length} passos concluídos. Pode sair e retomar mais tarde.`} />
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Passos do assistente">
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={s.key}>
                <button onClick={() => set({ passo: s.key })} className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${current === s.key ? 'bg-marinho-700 text-white' : 'hover:bg-slate-100'}`}>
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${progress[s.key] ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-700'}`}>{progress[s.key] ? '✓' : i + 1}</span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="space-y-4">
          {current === 'admin' && (
            <Card title="1. Primeiro administrador">
              <p className="text-sm">O administrador inicial já foi criado (a sua conta). Pode criar outras contas em «Utilizadores».</p>
              <LinkButton className="mt-3" variant="secondary" to="/utilizadores">Gerir utilizadores</LinkButton>
            </Card>
          )}
          {current === 'item_types' && (
            <>
              <Card title="2. Tipos de artigo e tamanhos">
                <p className="text-sm text-slate-700">
                  Foram pré-configurados: Casaco (peça individual com código e inscrição, tamanhos 44–62), Calças, Camisa, Cinto, Boné e Gravata (por quantidade) e Sapatos (apenas registo de necessidade). Reveja as escalas de tamanhos e ajuste-as ao fardamento da banda antes de introduzir stock — depois de existir stock, o modo de gestão de um tipo fica bloqueado.
                </p>
              </Card>
              <ItemTypesPanel />
            </>
          )}
          {current === 'statuses' && (
            <>
              <Card title="3. Estados de conservação e operacionais">
                <p className="text-sm text-slate-700">Confirme que compreende os estados utilizados. Apenas o estado «Disponível» conta como stock utilizável.</p>
              </Card>
              <StatusReference />
            </>
          )}
          {current === 'locations' && (
            <>
              <Card title="4. Localizações físicas">
                <p className="text-sm text-slate-700">Registe onde o fardamento é guardado (opcional, mas recomendado). Localizações ativas: {counts.locations}.</p>
              </Card>
              <LocationsPanel />
            </>
          )}
          {current === 'initial_stock' && (
            <Card title="5. Stock inicial">
              <p className="text-sm text-slate-700">
                Introduza o fardamento que já existe. Os casacos recebem código individual (e etiqueta QR); os restantes artigos são registados por quantidade. Indique se as quantidades foram efetivamente contadas ou estimadas. Movimentos de stock inicial já registados: <strong>{counts.initial_movements}</strong>.
              </p>
              <div className="mt-3 flex gap-2">
                <LinkButton to="/inventario/entrada">Introduzir stock inicial</LinkButton>
                <LinkButton variant="secondary" to="/inventario">Ver inventário</LinkButton>
              </div>
            </Card>
          )}
          {current === 'musicians' && (
            <Card title="6. Músicos e necessidades">
              <p className="text-sm text-slate-700">
                Crie a ficha de cada músico e registe as necessidades do levantamento (tamanhos, quantidade de camisas, peças antigas a devolver, sapatos). Músicos registados: <strong>{counts.musicians}</strong>; necessidades: <strong>{counts.requests}</strong>.
              </p>
              <div className="mt-3 flex gap-2">
                <LinkButton to="/musicos">Ir para Músicos</LinkButton>
                <LinkButton variant="secondary" to="/necessidades">Resumo das necessidades</LinkButton>
              </div>
            </Card>
          )}
          <div className="flex items-center gap-3">
            {progress[current] ? (
              <>
                <Badge tone="green">Passo concluído</Badge>
                <Button size="sm" variant="ghost" onClick={() => mark(current, false)}>Marcar como por concluir</Button>
              </>
            ) : (
              <Button onClick={() => mark(current, true)}>Marcar passo como concluído</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
