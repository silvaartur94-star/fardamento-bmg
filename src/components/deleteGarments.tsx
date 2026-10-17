// Eliminação definitiva de peças do inventário, com aviso das que estão com músicos ou têm histórico.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { DangerAction } from './DangerAction';

interface CheckRow {
  id: string;
  code: string;
  warning: string | null;
}

function Warnings({ ids, open }: { ids: string[]; open: boolean }) {
  const q = useQuery({
    queryKey: ['garments-delete-check', ids],
    queryFn: () => api.post<{ items: CheckRow[] }>('/inventory/garments/delete-check', { ids }),
    enabled: open && ids.length > 0,
  });
  const warned = (q.data?.items ?? []).filter((r) => r.warning);
  if (!warned.length) return null;
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">Atenção: {warned.length === 1 ? 'esta peça' : `${warned.length} peças`}:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {warned.slice(0, 12).map((r) => (
          <li key={r.id}>
            <span className="font-mono">{r.code}</span> — {r.warning}
          </li>
        ))}
        {warned.length > 12 && <li>… e mais {warned.length - 12}</li>}
      </ul>
      <p className="mt-2 text-xs">
        Ao eliminar, a peça deixa de constar na posse do músico e desaparece das entregas e empréstimos onde aparecia. Se a peça existe mas foi estragada ou perdida, prefira «Movimentar → Abatido / Extraviado», que mantém o histórico.
      </p>
    </div>
  );
}

export function DeleteGarmentsAction({ ids, label, title, size, variant, onDone }: { ids: string[]; label: string; title: string; size?: 'sm' | 'md'; variant?: 'danger' | 'ghost'; onDone?: () => void }) {
  return (
    <DangerAction
      size={size}
      variant={variant}
      label={label}
      title={title}
      reason
      message={
        <p>
          {ids.length === 1 ? 'A peça é apagada' : `As ${ids.length} peças são apagadas`} <strong>definitivamente</strong> do inventário, com o seu histórico de movimentos. Fica apenas o registo na auditoria (com o motivo).
        </p>
      }
      onConfirm={(reason, key) => api.post('/inventory/garments/delete', { ids, reason }, { idempotencyKey: key })}
      onDone={onDone}
    >
      {(open: boolean) => <Warnings ids={ids} open={open} />}
    </DangerAction>
  );
}
