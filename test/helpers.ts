import { SELF } from 'cloudflare:test';

export const BASE = 'https://fardamento.test';
export const SETUP_TOKEN = 'token-de-teste-com-mais-de-16-caracteres';
export const ADMIN = { email: 'admin@bmg.test', password: 'Admin-Segura-2026', name: 'Administrador' };

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  raw: Response;
}

let keySeq = 0;
export function idemKey() {
  keySeq++;
  return `test-${Date.now()}-${keySeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean; raw?: boolean } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.csrf !== false) headers['X-BMG-CSRF'] = '1';
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers, body });
  if (opts.raw) return { status: res.status, body: undefined as T, headers: res.headers, raw: res };
  const ct = res.headers.get('Content-Type') ?? '';
  const parsed = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: parsed as T, headers: res.headers, raw: res };
}

export async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.body)}`);
  const set = r.headers.get('Set-Cookie') ?? '';
  return set.split(';')[0];
}

/** Garante o administrador inicial e devolve o cookie de sessão. */
export async function adminCookie(): Promise<string> {
  const st = await api('GET', '/api/setup/status');
  if (st.body.needsAdmin) {
    const r = await api('POST', '/api/setup/admin', { body: { setupToken: SETUP_TOKEN, ...ADMIN } });
    if (r.status !== 201) throw new Error(`setup falhou ${JSON.stringify(r.body)}`);
  }
  return login(ADMIN.email, ADMIN.password);
}

export async function createUser(admin: string, role: 'admin' | 'gestor' | 'consulta', email: string) {
  const password = 'Utilizador-Seguro-1';
  const r = await api('POST', '/api/users', { cookie: admin, body: { name: `Utilizador ${role}`, email, role, password } });
  if (r.status !== 201 && r.status !== 409) throw new Error(JSON.stringify(r.body));
  return login(email, password);
}

export async function createMusician(cookie: string, fullName: string, extra: Record<string, unknown> = {}) {
  const r = await api('POST', '/api/musicians', { cookie, body: { fullName, confirmDuplicate: true, ...extra } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id as string;
}

export async function entry(cookie: string, items: unknown[], kind = 'stock_inicial') {
  const r = await api('POST', '/api/inventory/entries', { cookie, body: { kind, items }, headers: { 'Idempotency-Key': idemKey() } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body as { operationId: string; garmentIds: string[]; garments: { id: string; code: string }[] };
}

export async function availableBucket(cookie: string, itemTypeId: string, sizeId?: string) {
  const r = await api('GET', `/api/inventory/available?itemTypeId=${itemTypeId}${sizeId ? `&sizeId=${sizeId}` : ''}`, { cookie });
  return r.body as { garments: any[]; buckets: any[] };
}
