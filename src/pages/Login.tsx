import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, ErrorBox, TextInput } from '../components/ui';
import { useAuth } from '../lib/auth';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  const { user, refresh } = useAuth();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsAdmin: boolean }>('/setup/status') });
  useEffect(() => {
    if (setup.data?.needsAdmin) nav('/configuracao-inicial', { replace: true });
  }, [setup.data, nav]);
  const back = sp.get('voltar');
  if (user) return <Navigate to={back && back.startsWith('/') && !back.startsWith('//') ? back : '/'} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Gestão de Fardamento e Inventário">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <TextInput label="Palavra-passe" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>
          Entrar
        </Button>
        <p className="text-center text-xs text-slate-500">
          Esqueceu-se da palavra-passe? Peça a um administrador uma ligação de redefinição.
          <br />
          <Link to="/recuperar-acesso" className="underline">
            Sou administrador e perdi o acesso
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
