import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Button, ErrorBox, TextInput } from '../components/ui';
import { AuthShell } from './AuthShell';

export function ResetPasswordPage() {
  // O token vem no fragmento (#token=…), que nunca é enviado ao servidor nem fica nos registos.
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== confirm) return setError(new ApiError(422, 'CONFIRMACAO', 'As palavras-passe não coincidem.'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, newPassword: pw });
      setDone(true);
      history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Definir nova palavra-passe">
      {done ? (
        <div className="text-center">
          <p className="text-sm text-slate-700">Palavra-passe alterada com sucesso.</p>
          <Link to="/entrar" className="mt-3 inline-block font-medium text-marinho-700 underline">
            Iniciar sessão
          </Link>
        </div>
      ) : !token ? (
        <p className="text-sm text-red-700">Ligação inválida. Peça uma nova ligação ao administrador.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <TextInput label="Nova palavra-passe" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required hint="Mínimo de 10 caracteres, combinando letras com números ou símbolos." />
          <TextInput label="Confirmar" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          <ErrorBox error={error} />
          <Button type="submit" className="w-full" loading={busy}>
            Guardar
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
