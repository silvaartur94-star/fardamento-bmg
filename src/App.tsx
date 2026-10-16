import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '../shared/domain';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { useAuth } from './lib/auth';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { ResetPasswordPage } from './pages/ResetPassword';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Musicians = lazy(() => import('./pages/Musicians'));
const MusicianDetail = lazy(() => import('./pages/MusicianDetail'));
const Needs = lazy(() => import('./pages/Needs'));
const DeliveryNew = lazy(() => import('./pages/DeliveryNew'));
const DeliveryDetail = lazy(() => import('./pages/DeliveryDetail'));
const Returns = lazy(() => import('./pages/Returns'));
const ReturnNew = lazy(() => import('./pages/ReturnNew'));
const ReturnDetail = lazy(() => import('./pages/ReturnDetail'));
const Inventory = lazy(() => import('./pages/Inventory'));
const GarmentDetail = lazy(() => import('./pages/GarmentDetail'));
const GarmentByCode = lazy(() => import('./pages/GarmentByCode'));
const InventoryEntry = lazy(() => import('./pages/InventoryEntry'));
const Counts = lazy(() => import('./pages/Counts'));
const CountDetail = lazy(() => import('./pages/CountDetail'));
const Events = lazy(() => import('./pages/Events'));
const CampaignDetail = lazy(() => import('./pages/CampaignDetail'));
const EventDetail = lazy(() => import('./pages/EventDetail'));
const Loans = lazy(() => import('./pages/Loans'));
const LoanNew = lazy(() => import('./pages/LoanNew'));
const LoanDetail = lazy(() => import('./pages/LoanDetail'));
const Movements = lazy(() => import('./pages/Movements'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Users = lazy(() => import('./pages/Users'));
const Audit = lazy(() => import('./pages/Audit'));
const Wizard = lazy(() => import('./pages/Wizard'));
const Account = lazy(() => import('./pages/Account'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading text="A verificar a sessão…" />;
  if (!user) return <Navigate to={`/entrar?voltar=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function Perm({ p, children }: { p: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(p)) return <p className="rounded-md bg-amber-50 p-4 text-amber-900">Não tem permissão para aceder a esta página.</p>;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/entrar" element={<LoginPage />} />
        <Route path="/configuracao-inicial" element={<SetupPage />} />
        <Route path="/redefinir-palavra-passe" element={<ResetPasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="alertas" element={<Alerts />} />
          <Route path="musicos" element={<Musicians />} />
          <Route path="musicos/:id" element={<MusicianDetail />} />
          <Route path="necessidades" element={<Needs />} />
          <Route path="entregas/nova" element={<Perm p="deliveries.write"><DeliveryNew /></Perm>} />
          <Route path="entregas/:id" element={<DeliveryDetail />} />
          <Route path="recolhas" element={<Returns />} />
          <Route path="recolhas/nova" element={<Perm p="returns.write"><ReturnNew /></Perm>} />
          <Route path="recolhas/:id" element={<ReturnDetail />} />
          <Route path="inventario" element={<Inventory />} />
          <Route path="inventario/entrada" element={<Perm p="inventory.write"><InventoryEntry /></Perm>} />
          <Route path="inventario/pecas/:id" element={<GarmentDetail />} />
          <Route path="inventario/contagens" element={<Counts />} />
          <Route path="inventario/contagens/:id" element={<CountDetail />} />
          <Route path="p/:code" element={<GarmentByCode />} />
          <Route path="festas" element={<Events />} />
          <Route path="festas/campanhas/:id" element={<CampaignDetail />} />
          <Route path="festas/:id" element={<EventDetail />} />
          <Route path="emprestimos" element={<Loans />} />
          <Route path="emprestimos/novo" element={<Perm p="loans.write"><LoanNew /></Perm>} />
          <Route path="emprestimos/:id" element={<LoanDetail />} />
          <Route path="movimentos" element={<Movements />} />
          <Route path="relatorios" element={<Perm p="export"><Reports /></Perm>} />
          <Route path="configuracoes" element={<Perm p="settings.manage"><Settings /></Perm>} />
          <Route path="utilizadores" element={<Perm p="users.manage"><Users /></Perm>} />
          <Route path="auditoria" element={<Perm p="audit.read"><Audit /></Perm>} />
          <Route path="assistente" element={<Perm p="settings.manage"><Wizard /></Perm>} />
          <Route path="conta" element={<Account />} />
          <Route path="*" element={<p className="p-6">Página não encontrada.</p>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
