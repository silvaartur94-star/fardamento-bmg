import type { Role } from '../shared/domain';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS?: Fetcher;
  /** 'development' | 'production' | 'test' */
  ENVIRONMENT: string;
  /** Lista de origens autorizadas separadas por vírgulas (ex.: https://fardamento.exemplo.pt). */
  ALLOWED_ORIGINS?: string;
  /** Segredo de inicialização para criar o primeiro administrador (wrangler secret put SETUP_TOKEN). */
  SETUP_TOKEN?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    sessionId: string;
    requestId: string;
  };
};
