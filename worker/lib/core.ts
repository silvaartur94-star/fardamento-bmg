import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

export type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const nowIso = () => new Date().toISOString();
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const uuid = () => crypto.randomUUID();

/** Erros de domínio levantados pelos triggers SQL (RAISE(ABORT, 'CODIGO')). */
export const DOMAIN_ERRORS: Record<string, [ApiError['status'], string]> = {
  STOCK_INSUFICIENTE: [409, 'Stock insuficiente: a quantidade pedida não está disponível.'],
  ESTADO_PECA_ALTERADO: [409, 'A peça já não se encontra no estado esperado (pode ter sido movimentada entretanto). Atualize a página e tente novamente.'],
  ESTADO_SEM_MOVIMENTO: [409, 'O estado de uma peça só pode ser alterado através de um movimento registado.'],
  PECA_INEXISTENTE: [404, 'A peça indicada não existe.'],
  TIPO_INCOERENTE: [422, 'O tipo de artigo não corresponde à peça indicada.'],
  TIPO_NAO_INDIVIDUAL: [422, 'Este tipo de artigo é gerido por quantidade e não por peça individual.'],
  TIPO_NAO_QUANTIDADE: [422, 'Este tipo de artigo é gerido por peça individual e não por quantidade.'],
  TIPO_SEM_STOCK: [422, 'Este tipo de artigo não é gerido em stock (apenas registo de necessidades).'],
  TIPO_COM_STOCK: [409, 'Não é possível alterar o modo de gestão de um tipo que já tem stock ou movimentos.'],
  TAMANHO_INVALIDO: [422, 'O tamanho indicado não pertence a este tipo de artigo.'],
  CONDICAO_OBRIGATORIA: [422, 'O estado de conservação é obrigatório.'],
  MOVIMENTO_IMUTAVEL: [409, 'Os movimentos de stock não podem ser alterados nem apagados. Utilize um estorno ou ajuste.'],
  AUDITORIA_IMUTAVEL: [409, 'O registo de auditoria não pode ser alterado.'],
  CODIGO_IMUTAVEL: [409, 'O código de uma peça não pode ser alterado.'],
  PECA_COM_HISTORICO: [409, 'Não é possível apagar peças com histórico. Utilize o abate.'],
  REGISTO_COM_HISTORICO: [409, 'Não é possível apagar registos com histórico. Utilize a desativação ou o arquivo.'],
  NECESSIDADE_INVALIDA: [422, 'A necessidade indicada não pertence a este músico, não corresponde ao artigo ou não está ativa.'],
  ENTREGA_EXCEDE_NECESSIDADE: [409, 'A quantidade entregue excede a quantidade pretendida na necessidade.'],
  DECISAO_JA_TOMADA: [409, 'O destino desta peça já foi decidido.'],
};

const CHECK_ERRORS: [RegExp, ApiError['status'], string, string][] = [
  [/returned_quantity \+ lost_quantity <= quantity|returned_quantity <= quantity/i, 409, 'DEVOLUCAO_EXCEDE', 'A quantidade devolvida excede a quantidade ainda em falta.'],
  [/quantity >= 0/i, 409, 'STOCK_INSUFICIENTE', 'Stock insuficiente: a operação deixaria stock negativo.'],
];

export function mapDbError(err: unknown): ApiError | null {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: Error }).cause?.message ?? ''}` : String(err);
  for (const code of Object.keys(DOMAIN_ERRORS)) {
    if (msg.includes(code)) {
      const [status, message] = DOMAIN_ERRORS[code];
      return new ApiError(status, code, message);
    }
  }
  for (const [re, status, code, message] of CHECK_ERRORS) {
    if (re.test(msg)) return new ApiError(status, code, message);
  }
  if (/UNIQUE constraint failed: (\w+)\.(\w+)/i.test(msg)) {
    const m = msg.match(/UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/i);
    return new ApiError(409, 'DUPLICADO', 'Já existe um registo com estes dados.', { constraint: m?.[1] });
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new ApiError(422, 'REFERENCIA_INVALIDA', 'Um dos registos referidos não existe.');
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new ApiError(422, 'DADOS_INVALIDOS', 'Os dados não respeitam as regras de integridade.');
  }
  return null;
}

/** Executa várias instruções numa única transação D1 (batch atómico). */
export async function runBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length === 0) return [];
  try {
    return await db.batch(stmts);
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/** Eliminação: se o registo estiver referenciado (chave estrangeira), devolve 409 com a mensagem indicada. */
export async function runDelete(db: D1Database, stmts: D1PreparedStatement[], inUseMessage: string): Promise<D1Result[]> {
  try {
    return await runBatch(db, stmts);
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'REFERENCIA_INVALIDA' || e.code === 'REGISTO_COM_HISTORICO')) {
      throw new ApiError(409, 'EM_USO', inUseMessage);
    }
    throw e;
  }
}

/** Apaga do R2 os ficheiros dos anexos de uma entidade e devolve a instrução que remove os registos. */
export async function purgeAttachments(env: { DB: D1Database; FILES: R2Bucket }, entityType: string, entityIds: string[]): Promise<D1PreparedStatement[]> {
  if (!entityIds.length) return [];
  const marks = entityIds.map(() => '?').join(',');
  const rows = await all<{ r2_key: string; thumb_r2_key: string | null }>(
    env.DB,
    `SELECT r2_key, thumb_r2_key FROM attachments WHERE entity_type = ? AND entity_id IN (${marks})`,
    entityType,
    ...entityIds,
  );
  const keys = rows.flatMap((r) => [r.r2_key, ...(r.thumb_r2_key ? [r.thumb_r2_key] : [])]);
  if (keys.length) await env.FILES.delete(keys);
  return [env.DB.prepare(`DELETE FROM attachments WHERE entity_type = ? AND entity_id IN (${marks})`).bind(entityType, ...entityIds)];
}

export interface MutationOptions<T> {
  /** Chave de idempotência enviada pelo cliente (cabeçalho Idempotency-Key). */
  scope: string;
  response: T;
}

/**
 * Executa uma operação crítica de forma atómica e idempotente.
 * A chave de idempotência é inserida na MESMA transação: um pedido repetido
 * falha na restrição de unicidade e devolve a resposta original, sem repetir
 * os movimentos.
 */
export async function runMutation<T>(
  c: Ctx,
  stmts: D1PreparedStatement[],
  opts: MutationOptions<T>,
): Promise<{ replayed: boolean; response: T }> {
  const db = c.env.DB;
  const key = c.req.header('Idempotency-Key');
  const user = c.get('user');
  const all = [...stmts];
  if (key) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new ApiError(400, 'IDEMPOTENCIA_INVALIDA', 'Chave de idempotência inválida.');
    all.unshift(
      db
        .prepare('INSERT INTO idempotency_keys (user_id, key, scope, response, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(user.id, key, opts.scope, JSON.stringify(opts.response), nowIso()),
    );
  }
  try {
    await db.batch(all);
    return { replayed: false, response: opts.response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (key && /UNIQUE constraint failed: idempotency_keys/i.test(msg)) {
      const row = await db
        .prepare('SELECT scope, response FROM idempotency_keys WHERE user_id = ? AND key = ?')
        .bind(user.id, key)
        .first<{ scope: string; response: string }>();
      if (row && row.scope === opts.scope) return { replayed: true, response: JSON.parse(row.response) as T };
      throw new ApiError(409, 'IDEMPOTENCIA_CONFLITO', 'Esta chave de idempotência já foi utilizada noutra operação.');
    }
    const mapped = mapDbError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/** Instrução de auditoria a incluir no mesmo batch da operação. */
export function auditStmt(
  c: Ctx,
  action: string,
  entityType: string,
  entityId: string | null,
  summary?: Record<string, unknown>,
  userIdOverride?: string | null,
): D1PreparedStatement {
  const user = c.var.user as { id: string } | undefined;
  return c.env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, summary, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    uuid(),
    userIdOverride !== undefined ? userIdOverride : (user?.id ?? null),
    action,
    entityType,
    entityId,
    summary ? JSON.stringify(redact(summary)) : null,
    c.var.requestId ?? null,
    nowIso(),
  );
}

const SENSITIVE = /pass|token|secret|hash|cookie/i;
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? redact(v as Record<string, unknown>) : v;
  }
  return out;
}

// --- Validação --------------------------------------------------------------

export function formatZodError(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'JSON_INVALIDO', 'O corpo do pedido não é JSON válido.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(422, 'VALIDACAO', 'Existem dados inválidos no formulário.', formatZodError(r.error));
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Ctx, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new ApiError(400, 'PARAMETROS_INVALIDOS', 'Parâmetros de pesquisa inválidos.', formatZodError(r.error));
  return r.data;
}

// --- Esquemas comuns ---------------------------------------------------------

export const zId = z.string().trim().min(1, 'Obrigatório').max(64);
export const zOptId = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v) => (v ? v : null));
/** Chave de lote de stock (tipo|tamanho|condição|localização|estado). */
export const zOptKey = z
  .string()
  .trim()
  .max(300)
  .nullish()
  .transform((v) => (v ? v : null));
export const zText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Máximo de ${max} caracteres`)
    .nullish()
    .transform((v) => (v ? v : null));
export const zReqText = (max = 200) => z.string().trim().min(1, 'Obrigatório').max(max, `Máximo de ${max} caracteres`);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD)');
export const zOptDate = zDate.nullish().transform((v) => v ?? null);
export const zQty = z.coerce.number().int('Tem de ser um número inteiro').min(1, 'Mínimo 1').max(100000);

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export function paging(p: { page: number; pageSize: number }) {
  return { limit: p.pageSize, offset: (p.page - 1) * p.pageSize };
}

export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Ordenação segura a partir de uma lista branca de colunas. */
export function orderBy(sort: string | undefined, dir: string | undefined, allowed: Record<string, string>, fallback: string) {
  const col = sort && allowed[sort];
  if (!col) return fallback;
  return `${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return r.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

export function notFound(what = 'Registo'): never {
  throw new ApiError(404, 'NAO_ENCONTRADO', `${what} inexistente.`);
}
