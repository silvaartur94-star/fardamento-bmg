import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, type Permission } from '../../shared/domain';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { cx } from './ui';

const NAV: { to: string; label: string; icon: string; perm?: Permission; end?: boolean }[] = [
  { to: '/', label: 'Painel de controlo', icon: '▦', end: true },
  { to: '/alertas', label: 'Alertas e pendências', icon: '⚠' },
  { to: '/musicos', label: 'Músicos', icon: '♪' },
  { to: '/necessidades', label: 'Necessidades e entregas', icon: '✓' },
  { to: '/recolhas', label: 'Recolhas e inspeções', icon: '↩' },
  { to: '/inventario', label: 'Inventário', icon: '▤' },
  { to: '/festas', label: 'Festas e campanhas', icon: '★' },
  { to: '/emprestimos', label: 'Empréstimos', icon: '⇄' },
  { to: '/movimentos', label: 'Movimentos e histórico', icon: '≡' },
  { to: '/relatorios', label: 'Relatórios e exportações', icon: '⤓', perm: 'export' },
];
const ADMIN_NAV: { to: string; label: string; icon: string; perm: Permission }[] = [
  { to: '/assistente', label: 'Assistente inicial', icon: '➜', perm: 'settings.manage' },
  { to: '/configuracoes', label: 'Configurações', icon: '⚙', perm: 'settings.manage' },
  { to: '/utilizadores', label: 'Utilizadores', icon: '👤', perm: 'users.manage' },
  { to: '/auditoria', label: 'Auditoria', icon: '🔍', perm: 'audit.read' },
];

export function Layout() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ items: { severity: string }[] }>('/dashboard/alerts'), staleTime: 60_000 });
  const high = alerts.data?.items.filter((a) => a.severity === 'alta').length ?? 0;

  const link = (n: { to: string; label: string; icon: string; end?: boolean }) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.end}
      className={({ isActive }) =>
        cx('flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium', isActive ? 'bg-marinho-600 text-white' : 'text-marinho-100 hover:bg-marinho-800 hover:text-white')
      }
    >
      <span aria-hidden className="w-5 text-center">
        {n.icon}
      </span>
      <span className="flex-1">{n.label}</span>
      {n.to === '/alertas' && high > 0 && <span className="rounded-full bg-red-500 px-1.5 text-xs text-white">{high}</span>}
    </NavLink>
  );

  return (
    <div className="min-h-screen lg:flex">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Saltar para o conteúdo
      </a>
      <header className="no-print flex items-center justify-between bg-marinho-900 px-4 py-2 text-white lg:hidden">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo-192.png" alt="" className="h-9 w-9 rounded bg-white p-0.5" />
          <span className="font-semibold">Fardamento BMG</span>
        </Link>
        <button onClick={() => setOpen((v) => !v)} className="rounded border border-marinho-500 px-3 py-1 text-sm" aria-expanded={open} aria-controls="menu-lateral">
          {open ? 'Fechar' : 'Menu'}
        </button>
      </header>
      <aside
        id="menu-lateral"
        className={cx('no-print bg-marinho-900 text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-72 lg:flex-col', open ? 'block' : 'hidden lg:flex')}
        aria-label="Navegação principal"
      >
        <Link to="/" className="hidden items-center gap-3 border-b border-marinho-800 px-4 py-4 lg:flex">
          <img src="/logo-192.png" alt="Logótipo da Banda Marcial de Gueifães" className="h-12 w-12 rounded bg-white p-0.5" />
          <div className="leading-tight">
            <p className="text-sm font-bold">Banda Marcial de Gueifães</p>
            <p className="text-xs text-ouro-400">Gestão de Fardamento</p>
          </div>
        </Link>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.filter((n) => !n.perm || can(n.perm)).map(link)}
          {ADMIN_NAV.some((n) => can(n.perm)) && <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-marinho-200">Administração</p>}
          {ADMIN_NAV.filter((n) => can(n.perm)).map(link)}
        </nav>
        <div className="border-t border-marinho-800 p-3 text-sm">
          <Link to="/conta" className="block rounded px-2 py-1 hover:bg-marinho-800">
            <span className="font-medium">{user?.name}</span>
            <span className="block text-xs text-marinho-200">{user ? ROLE_LABELS[user.role] : ''}</span>
          </Link>
          <button onClick={() => logout()} className="mt-1 w-full rounded px-2 py-1 text-left text-marinho-100 hover:bg-marinho-800">
            Terminar sessão
          </button>
        </div>
      </aside>
      <main id="conteudo" className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8">
        {user?.mustChangePassword && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            A sua conta foi criada por um administrador. <Link to="/conta" className="font-medium underline">Defina uma nova palavra-passe</Link>.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
