import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ROLES, ROLE_LABELS } from '../../shared/domain';
import { DataTable } from '../components/DataTable';
import { Badge, Button, ConfirmDialog, ErrorBox, Modal, PageHeader, SelectInput, TextInput } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';

export default function Users() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ items: any[] }>('/users') });
  const [modal, setModal] = useState<any>(null);
  const [f, setF] = useState({ name: '', email: '', role: 'gestor', password: '' });
  const [link, setLink] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (modal === 'new') await api.post('/users', f);
      else await api.patch(`/users/${modal.id}`, { name: f.name, role: f.role });
      refresh();
      setModal(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    setErr(null);
    try {
      await confirm.run();
      refresh();
      setConfirm(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="Utilizadores" subtitle="Contas com acesso à aplicação. Não existe registo público: só um administrador pode criar contas." actions={<Button onClick={() => { setErr(null); setF({ name: '', email: '', role: 'gestor', password: '' }); setModal('new'); }}>Novo utilizador</Button>} />
      <ErrorBox error={!modal && !confirm ? err : null} />
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        rowKey={(u) => u.id}
        columns={[
          { key: 'n', header: 'Nome', render: (u) => u.name },
          { key: 'e', header: 'Email', render: (u) => u.email },
          { key: 'r', header: 'Perfil', render: (u) => <Badge tone={u.role === 'admin' ? 'navy' : u.role === 'gestor' ? 'blue' : 'grey'}>{ROLE_LABELS[u.role as 'admin']}</Badge> },
          { key: 's', header: 'Estado', render: (u) => <Badge tone={u.active ? 'green' : 'grey'}>{u.active ? 'Ativo' : 'Inativo'}</Badge> },
          { key: 'l', header: 'Último acesso', render: (u) => fmtDateTime(u.last_login_at) },
          { key: 'ss', header: 'Sessões', align: 'right', render: (u) => u.active_sessions },
          {
            key: 'a',
            header: '',
            render: (u) => (
              <span className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setErr(null); setF({ name: u.name, email: u.email, role: u.role, password: '' }); setModal(u); }}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={async () => { setErr(null); try { const r = await api.post<{ url: string }>(`/users/${u.id}/reset-link`); setLink(r.url); } catch (e) { setErr(e); } }}>Ligação de redefinição</Button>
                {u.id !== me?.id && (
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ title: u.active ? 'Desativar utilizador' : 'Reativar utilizador', message: u.active ? `${u.name} deixa de poder entrar e as sessões ativas são terminadas. O histórico mantém-se.` : `${u.name} volta a poder entrar.`, run: () => api.patch(`/users/${u.id}`, { active: !u.active }) })}>
                    {u.active ? 'Desativar' : 'Reativar'}
                  </Button>
                )}
                {u.active_sessions > 0 && <Button size="sm" variant="ghost" onClick={() => setConfirm({ title: 'Terminar sessões', message: `Terminar todas as sessões de ${u.name}?`, run: () => api.post(`/users/${u.id}/revoke-sessions`) })}>Terminar sessões</Button>}
              </span>
            ),
          },
        ]}
      />
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'new' ? 'Novo utilizador' : 'Editar utilizador'} footer={<Button onClick={save} loading={busy}>Guardar</Button>}>
        <div className="space-y-3">
          <TextInput label="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          {modal === 'new' && <TextInput label="Email (identificador de acesso)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}
          <SelectInput label="Perfil" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          {modal === 'new' && <TextInput label="Palavra-passe provisória" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="O utilizador será convidado a alterá-la. Mínimo 10 caracteres." required />}
          <ul className="text-xs text-slate-600">
            <li><strong>Administrador:</strong> acesso integral, contas, configurações, ajustes, estornos e auditoria.</li>
            <li><strong>Responsável pelo fardamento:</strong> músicos, necessidades, entregas, recolhas, inspeções, inventário, festas e empréstimos.</li>
            <li><strong>Consulta:</strong> apenas leitura e exportações.</li>
          </ul>
          <ErrorBox error={err} />
        </div>
      </Modal>
      <Modal open={!!link} onClose={() => setLink(null)} title="Ligação de redefinição de palavra-passe">
        <p className="text-sm">Envie esta ligação ao utilizador por um canal de confiança. É válida durante 24 horas e só pode ser usada uma vez. Não voltará a ser mostrada.</p>
        <textarea className="input mt-3 font-mono text-xs" rows={3} readOnly value={link ?? ''} onFocus={(e) => e.target.select()} aria-label="Ligação" />
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(link ?? '')}>Copiar</Button>
      </Modal>
      <ConfirmDialog open={!!confirm} title={confirm?.title ?? ''} message={confirm?.message} loading={busy} error={err} onClose={() => setConfirm(null)} onConfirm={runConfirm} />
    </div>
  );
}
