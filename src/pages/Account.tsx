import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { ROLE_LABELS } from '../../shared/domain';
import { Badge, Button, Card, DefList, ErrorBox, PageHeader, TextInput } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

export default function Account() {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ items: any[] }>('/auth/sessions') });
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  async function change() {
    setErr(null);
    setMsg(null);
    if (f.newPassword !== f.confirm) return setErr(new ApiError(422, 'CONFIRMACAO', 'As palavras-passe não coincidem.'));
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      setF({ currentPassword: '', newPassword: '', confirm: '' });
      setMsg('Palavra-passe alterada. As outras sessões foram terminadas.');
      refresh();
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="A minha conta" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Dados">
          <DefList items={[['Nome', user?.name], ['Email', user?.email], ['Perfil', user ? ROLE_LABELS[user.role] : '']]} />
        </Card>
        <Card title="Alterar palavra-passe">
          <div className="space-y-3">
            <TextInput label="Palavra-passe atual" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
            <TextInput label="Nova palavra-passe" type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} hint="Mínimo de 10 caracteres, combinando letras com números ou símbolos." />
            <TextInput label="Confirmar nova palavra-passe" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
            <ErrorBox error={err} />
            {msg && <p className="text-sm text-emerald-700">{msg}</p>}
            <Button onClick={change} loading={busy} disabled={!f.currentPassword || !f.newPassword}>Alterar</Button>
          </div>
        </Card>
        <Card title="Sessões ativas" className="lg:col-span-2" actions={<Button size="sm" variant="secondary" onClick={async () => { await api.post('/auth/sessions/revoke-others'); qc.invalidateQueries({ queryKey: ['sessions'] }); }}>Terminar as outras sessões</Button>}>
          <ul className="divide-y text-sm">
            {sessions.data?.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.user_agent ?? 'Navegador desconhecido'} {s.current && <Badge tone="green">esta sessão</Badge>}
                  <span className="block text-xs text-slate-500">Início {fmtDateTime(s.created_at)} · última atividade {fmtDateTime(s.last_seen_at)}</span>
                </span>
                {!s.current && <Button size="sm" variant="ghost" onClick={async () => { await api.post(`/auth/sessions/${s.id}/revoke`); qc.invalidateQueries({ queryKey: ['sessions'] }); }}>Terminar</Button>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
