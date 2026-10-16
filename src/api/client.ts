// Cliente HTTP da API: cookies de sessão (HttpOnly), cabeçalho anti-CSRF e erros em português.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path: string; message: string }[]) if (d.path && !out[d.path]) out[d.path] = d.message;
    }
    return out;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(params: Query = {}): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-BMG-CSRF': '1', Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'REDE', 'Sem ligação ao servidor. Verifique a ligação à Internet e tente novamente.');
  }
  const ct = res.headers.get('Content-Type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') onUnauthorized?.();
    const e = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERRO', e?.message ?? `Erro inesperado (${res.status}).`, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', `${path}${qs(query)}`),
  post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) => request<T>('POST', path, body ?? {}, opts),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Descarrega um ficheiro gerado pelo servidor (respeita a sessão e as permissões). */
export async function download(path: string, query?: Query) {
  const res = await fetch(`/api${path}${qs(query)}`, { credentials: 'same-origin', headers: { 'X-BMG-CSRF': '1' } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'ERRO', data?.error?.message ?? 'Não foi possível gerar o ficheiro.');
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'exportacao';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
