// Serviço de movimentos de stock.
// Todas as alterações de estado/quantidade passam por movementStmt(), cuja
// instrução INSERT ativa os triggers que validam e materializam o novo estado.

import type { Condition, MovementType, Origin, Status, Verification } from '../../shared/domain';
import { ApiError, all, first, nowIso, uuid, type Ctx } from '../lib/core';

export interface Bucket {
  status: Status;
  condition: Condition;
  locationId: string | null;
}

export interface MovementInput {
  operationId: string;
  type: MovementType;
  itemTypeId: string;
  garmentId?: string | null;
  sizeId?: string | null;
  quantity?: number;
  from?: Bucket | null;
  to?: Bucket | null;
  musicianId?: string | null;
  refType?: string | null;
  refId?: string | null;
  reason?: string | null;
  notes?: string | null;
  verification?: Verification | null;
  reversesMovementId?: string | null;
}

export function bucketKey(itemTypeId: string, sizeId: string | null, b: Bucket): string {
  return `${itemTypeId}|${sizeId ?? ''}|${b.condition}|${b.locationId ?? ''}|${b.status}`;
}

export function movementStmt(c: Ctx, m: MovementInput, createdAt = nowIso()): { id: string; stmt: D1PreparedStatement } {
  const id = uuid();
  const stmt = c.env.DB.prepare(
    `INSERT INTO stock_movements (id, operation_id, movement_type, item_type_id, garment_id, size_id, quantity,
       from_status, from_condition, from_location_id, to_status, to_condition, to_location_id,
       musician_id, ref_type, ref_id, reason, notes, verification, reverses_movement_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    m.operationId,
    m.type,
    m.itemTypeId,
    m.garmentId ?? null,
    m.sizeId ?? null,
    m.quantity ?? 1,
    m.from?.status ?? null,
    m.from?.condition ?? null,
    m.from?.locationId ?? null,
    m.to?.status ?? null,
    m.to?.condition ?? null,
    m.to?.locationId ?? null,
    m.musicianId ?? null,
    m.refType ?? null,
    m.refId ?? null,
    m.reason ?? null,
    m.notes ?? null,
    m.verification ?? null,
    m.reversesMovementId ?? null,
    createdAt,
    c.get('user').id,
  );
  return { id, stmt };
}

export interface NewGarment {
  itemTypeId: string;
  sizeId: string | null;
  inscription?: string | null;
  legacyCode?: string | null;
  condition: Condition;
  origin: Origin;
  originNotes?: string | null;
  verification?: Verification;
  entryDate: string;
  costCents?: number | null;
  locationId: string | null;
  notes?: string | null;
}

/** Insere uma peça (sem estado). O estado é atribuído pelo primeiro movimento no mesmo batch. */
export function garmentInsertStmt(c: Ctx, g: NewGarment, createdAt = nowIso()): { id: string; stmt: D1PreparedStatement } {
  const id = uuid();
  const stmt = c.env.DB.prepare(
    `INSERT INTO garments (id, legacy_code, item_type_id, size_id, inscription, condition, origin, origin_notes, verification,
       entry_date, cost_cents, location_id, notes, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    g.legacyCode ?? null,
    g.itemTypeId,
    g.sizeId,
    g.inscription ?? null,
    g.condition,
    g.origin,
    g.originNotes ?? null,
    g.verification ?? 'contado',
    g.entryDate,
    g.costCents ?? null,
    g.locationId,
    g.notes ?? null,
    createdAt,
    createdAt,
    c.get('user').id,
  );
  return { id, stmt };
}

export interface ItemTypeRow {
  id: string;
  name: string;
  tracking_mode: 'individual' | 'quantidade';
  has_size: number;
  allows_inscription: number;
  procurement_enabled: number;
  stock_enabled: number;
  active: number;
}

export async function getItemType(db: D1Database, id: string): Promise<ItemTypeRow> {
  const t = await first<ItemTypeRow>(db, 'SELECT * FROM item_types WHERE id = ?', id);
  if (!t) throw new ApiError(422, 'TIPO_INEXISTENTE', 'Tipo de artigo inexistente.');
  return t;
}

export async function assertSize(db: D1Database, type: ItemTypeRow, sizeId: string | null | undefined): Promise<string | null> {
  if (!sizeId) {
    if (type.has_size && type.stock_enabled) {
      // O tamanho pode ser desconhecido no stock antigo; é permitido, mas fica explícito como "sem tamanho".
    }
    return null;
  }
  const s = await first(db, 'SELECT id FROM item_sizes WHERE id = ? AND item_type_id = ?', sizeId, type.id);
  if (!s) throw new ApiError(422, 'TAMANHO_INVALIDO', `O tamanho indicado não pertence a "${type.name}".`);
  return sizeId;
}

export interface GarmentRow {
  id: string;
  code: string;
  item_type_id: string;
  size_id: string | null;
  status: Status;
  condition: Condition;
  location_id: string | null;
  holder_musician_id: string | null;
  inscription: string | null;
}

export async function getGarment(db: D1Database, id: string): Promise<GarmentRow> {
  const g = await first<GarmentRow>(db, 'SELECT * FROM garments WHERE id = ?', id);
  if (!g) throw new ApiError(404, 'PECA_INEXISTENTE', 'A peça indicada não existe.');
  return g;
}

export async function getBalance(db: D1Database, key: string) {
  return first<{ bucket_key: string; item_type_id: string; size_id: string | null; condition: Condition; location_id: string | null; status: Status; quantity: number }>(
    db,
    'SELECT * FROM stock_balances WHERE bucket_key = ?',
    key,
  );
}

/** Verificação de consistência: recalcula saldos e estados a partir dos movimentos. */
export async function consistencyReport(db: D1Database) {
  const balanceDiffs = await db
    .prepare(
      `WITH flows AS (
         SELECT item_type_id || '|' || COALESCE(size_id, '') || '|' || to_condition || '|' || COALESCE(to_location_id, '') || '|' || to_status AS k, quantity AS q
           FROM stock_movements WHERE garment_id IS NULL AND to_status IS NOT NULL
         UNION ALL
         SELECT item_type_id || '|' || COALESCE(size_id, '') || '|' || from_condition || '|' || COALESCE(from_location_id, '') || '|' || from_status, -quantity
           FROM stock_movements WHERE garment_id IS NULL AND from_status IS NOT NULL
       ), expected AS (SELECT k, SUM(q) AS q FROM flows GROUP BY k)
       SELECT COALESCE(e.k, b.bucket_key) AS bucket_key, COALESCE(e.q, 0) AS expected, COALESCE(b.quantity, 0) AS actual
         FROM expected e LEFT JOIN stock_balances b ON b.bucket_key = e.k
        WHERE COALESCE(e.q, 0) != COALESCE(b.quantity, 0)
       UNION ALL
       SELECT b.bucket_key, 0, b.quantity FROM stock_balances b
        WHERE b.quantity != 0 AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.k = b.bucket_key)`,
    )
    .all();
  const garmentDiffs = await db
    .prepare(
      `SELECT g.id, g.code, g.status,
              (SELECT m.to_status FROM stock_movements m WHERE m.garment_id = g.id ORDER BY m.seq DESC LIMIT 1) AS last_status
         FROM garments g
        WHERE g.status IS NOT (SELECT m.to_status FROM stock_movements m WHERE m.garment_id = g.id ORDER BY m.seq DESC LIMIT 1)`,
    )
    .all();
  const loanDiffs = await db
    .prepare(
      `SELECT l.id, l.quantity, l.returned_quantity, l.lost_quantity,
              COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = l.id AND r.kind = 'devolucao'), 0) AS ret,
              COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = l.id AND r.kind = 'perda'), 0) AS lost
         FROM loan_lines l
        WHERE l.returned_quantity != COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = l.id AND r.kind = 'devolucao'), 0)
           OR l.lost_quantity != COALESCE((SELECT SUM(r.quantity) FROM loan_returns r WHERE r.loan_line_id = l.id AND r.kind = 'perda'), 0)`,
    )
    .all();
  const balances = balanceDiffs.results ?? [];
  const garments = garmentDiffs.results ?? [];
  const loans = loanDiffs.results ?? [];
  return { ok: balances.length === 0 && garments.length === 0 && loans.length === 0, balances, garments, loans, checkedAt: nowIso() };
}

/**
 * Estorna todos os movimentos (ainda não estornados) de uma operação de negócio.
 * Peças criadas pela própria operação ficam «Rejeitadas» (o código nunca é reutilizado).
 */
export async function reverseOperationStmts(c: Ctx, refType: string, refId: string, types: MovementType[], reason: string, now = nowIso()) {
  const rows = await all<{
    id: string;
    item_type_id: string;
    garment_id: string | null;
    size_id: string | null;
    quantity: number;
    from_status: Status | null;
    from_condition: Condition | null;
    from_location_id: string | null;
    to_status: Status | null;
    to_condition: Condition | null;
    to_location_id: string | null;
    musician_id: string | null;
  }>(
    c.env.DB,
    `SELECT * FROM stock_movements m WHERE m.ref_type = ? AND m.ref_id = ? AND m.movement_type IN (${types.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id) ORDER BY m.seq DESC`,
    refType,
    refId,
    ...types,
  );
  const opId = uuid();
  return rows.map(
    (m) =>
      movementStmt(
        c,
        {
          operationId: opId,
          type: 'estorno',
          itemTypeId: m.item_type_id,
          garmentId: m.garment_id,
          sizeId: m.size_id,
          quantity: m.quantity,
          from: m.to_status ? { status: m.to_status, condition: m.to_condition as Condition, locationId: m.to_location_id } : null,
          to: m.from_status
            ? { status: m.from_status, condition: m.from_condition as Condition, locationId: m.from_location_id }
            : m.garment_id
              ? { status: 'rejeitado', condition: (m.to_condition ?? 'bom') as Condition, locationId: m.to_location_id }
              : null,
          musicianId: m.musician_id,
          refType,
          refId,
          reason,
          reversesMovementId: m.id,
        },
        now,
      ).stmt,
  );
}
