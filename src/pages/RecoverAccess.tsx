import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Button, ErrorBox, TextInput } from '../components/ui';
import { AuthShell } from './AuthShell';

/** Recuperação de acesso de administrador através do código de inicialização (SETUP_TOKEN). */
export function RecoverAccessPage() {
  const [f, setF] = useState({ setupToken: '', email: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return setError(new ApiError(422, 'CONFIRMACAO', 'As palavras-passe não coincidem.'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/setup/recover', { setupToken: f.setupToken, email: f.email, newPassword: f.newPassword });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Recuperar acesso de administrador">
      {done ? (
        <div className="text-center">
          <p className="text-sm text-slate-700">Palavra-passe redefinida. Pode iniciar sessão.</p>
          <Link to="/entrar" className="mt-3 inline-block font-medium text-marinho-700 underline">
            Iniciar sessão
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600">
            Para administradores que perderam a palavra-passe. É necessário o <strong>código de inicialização</strong> (segredo <code>SETUP_TOKEN</code>), definido na conta Cloudflare em
            Workers &amp; Pages → fardamento-bmg → Settings → Variables and Secrets. Os restantes utilizadores devem pedir uma ligação de redefinição ao administrador.
          </p>
          <TextInput label="Código de inicialização (SETUP_TOKEN)" type="password" autoComplete="off" value={f.setupToken} onChange={upd('setupToken')} required />
          <TextInput label="Email do administrador" type="email" autoComplete="username" value={f.email} onChange={upd('email')} required />
          <TextInput label="Nova palavra-passe" type="password" autoComplete="new-password" value={f.newPassword} onChange={upd('newPassword')} required hint="Mínimo de 10 caracteres, combinando letras com números ou símbolos." />
          <TextInput label="Confirmar nova palavra-passe" type="password" autoComplete="new-password" value={f.confirm} onChange={upd('confirm')} required />
          <ErrorBox error={error} />
          <Button type="submit" className="w-full" loading={busy}>
            Redefinir palavra-passe
          </Button>
          <p className="text-center text-xs">
            <Link to="/entrar" className="underline">
              Voltar ao início de sessão
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
