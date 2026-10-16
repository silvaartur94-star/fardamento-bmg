import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler } from '../api/client';
import { can, type Permission, type Role } from '../../shared/domain';

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

interface AuthCtx {
  user: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ user: Me | null }>('/auth/me'), staleTime: 60_000, retry: 1 });
  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], { user: null });
    });
  }, [qc]);
  const user = q.data?.user ?? null;
  const value: AuthCtx = {
    user,
    loading: q.isLoading,
    can: (p) => can(user?.role, p),
    refresh: () => q.refetch(),
    logout: async () => {
      await api.post('/auth/logout').catch(() => undefined);
      qc.clear();
      qc.setQueryData(['me'], { user: null });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider em falta');
  return c;
}
