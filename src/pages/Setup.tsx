import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { Button, ErrorBox, Loading, TextInput } from '../components/ui';
import { useAuth } from '../lib/auth';
import { AuthShell } from './AuthShell';

export function SetupPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsAdmin: boolean; setupTokenConfigured: boolean }>('/setup/status') });
  const [f, setF] = useState({ setupToken: '', name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status.isLoading) return <Loading />;
  if (status.data && !status.data.needsAdmin)
    return (
      <AuthShell title="Configuração inicial concluída">
        <p className="text-center text-sm text-slate-600">O administrador inicial já foi criado.</p>
        <Link to="/entrar" className="mt-4 block text-center font-medium text-marinho-700 underline">
          Ir para o início de sessão
        </Link>
      </AuthShell>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) return setError(new ApiError(422, 'CONFIRMACAO', 'As palavras-passe não coincidem.'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/setup/admin', { setupToken: f.setupToken, name: f.name, email: f.email, password: f.password });
      await api.post('/auth/login', { email: f.email, password: f.password });
      await refresh();
      nav('/assistente', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <AuthShell title="Criar o primeiro administrador">
      {!status.data?.setupTokenConfigured && (
        <p className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">
          O segredo <code>SETUP_TOKEN</code> ainda não está configurado no servidor. Consulte o README (secção «Criação do primeiro administrador»).
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <TextInput label="Código de inicialização (SETUP_TOKEN)" type="password" value={f.setupToken} onChange={upd('setupToken')} required autoComplete="off" hint="Definido de forma secreta por quem instalou a aplicação." />
        <TextInput label="Nome" value={f.name} onChange={upd('name')} required />
        <TextInput label="Email" type="email" value={f.email} onChange={upd('email')} required autoComplete="username" />
        <TextInput label="Palavra-passe" type="password" value={f.password} onChange={upd('password')} required autoComplete="new-password" hint="Mínimo de 10 caracteres, combinando letras com números ou símbolos." />
        <TextInput label="Confirmar palavra-passe" type="password" value={f.confirm} onChange={upd('confirm')} required autoComplete="new-password" />
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" loading={busy}>
          Criar administrador
        </Button>
      </form>
    </AuthShell>
  );
}
