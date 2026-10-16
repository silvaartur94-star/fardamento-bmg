import { Hono } from 'hono';
import { z } from 'zod';
import { ATTACHMENT_ENTITY_TYPES, type AttachmentEntityType } from '../../shared/domain';
import type { AppEnv } from '../env';
import { ApiError, all, auditStmt, first, notFound, nowIso, parseQuery, runBatch, uuid } from '../lib/core';
import { ImageError, processImage } from '../lib/images';
import { requirePerm } from '../auth/session';
import { getSetting } from './reference';

export const attachmentRoutes = new Hono<AppEnv>();

const ENTITY_TABLE: Record<AttachmentEntityType, string> = {
  garment: 'garments',
  musician: 'musicians',
  return: 'garment_returns',
  return_line: 'garment_return_lines',
  loan: 'loans',
  loan_line: 'loan_lines',
  event: 'events',
  incident: 'incidents',
  delivery: 'musician_deliveries',
};
const MAX_DIMENSION = 12000;
const MAX_THUMB_BYTES = 400_000;

attachmentRoutes.get('/', requirePerm('read'), async (c) => {
  const f = parseQuery(c, z.object({ entityType: z.enum(ATTACHMENT_ENTITY_TYPES), entityId: z.string().min(1).max(64) }));
  const items = await all(
    c.env.DB,
    `SELECT a.id, a.entity_type, a.entity_id, a.content_type, a.original_name, a.size_bytes, a.width, a.height, a.caption,
            a.uploaded_at, a.thumb_r2_key IS NOT NULL AS has_thumb, u.name AS uploaded_by_name
       FROM attachments a JOIN users u ON u.id = a.uploaded_by
      WHERE a.entity_type = ? AND a.entity_id = ? AND a.deleted_at IS NULL ORDER BY a.uploaded_at DESC`,
    f.entityType,
    f.entityId,
  );
  return c.json({ items });
});

attachmentRoutes.post('/', requirePerm('attachments.write'), async (c) => {
  const maxBytes = await getSetting(c.env.DB, 'uploads.max_bytes', 8 * 1024 * 1024);
  const len = Number(c.req.header('Content-Length') ?? 0);
  if (len > maxBytes + MAX_THUMB_BYTES + 100_000) throw new ApiError(413, 'FICHEIRO_GRANDE', `O ficheiro excede o tamanho máximo (${Math.round(maxBytes / 1048576)} MB).`);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new ApiError(400, 'FORMULARIO_INVALIDO', 'Envio de ficheiro inválido.');
  }
  const meta = z
    .object({
      entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
      entityId: z.string().min(1).max(64),
      caption: z.string().trim().max(300).optional(),
    })
    .safeParse({ entityType: form.get('entityType'), entityId: form.get('entityId'), caption: form.get('caption') ?? undefined });
  if (!meta.success) throw new ApiError(422, 'VALIDACAO', 'Dados do anexo inválidos.');
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new ApiError(422, 'SEM_FICHEIRO', 'Selecione uma fotografia.');
  if (file.size === 0) throw new ApiError(422, 'FICHEIRO_VAZIO', 'O ficheiro está vazio.');
  if (file.size > maxBytes) throw new ApiError(413, 'FICHEIRO_GRANDE', `O ficheiro excede o tamanho máximo (${Math.round(maxBytes / 1048576)} MB).`);

  const table = ENTITY_TABLE[meta.data.entityType];
  const exists = await first(c.env.DB, `SELECT id FROM ${table} WHERE id = ?`, meta.data.entityId);
  if (!exists) notFound('Registo associado');

  let img;
  let thumb;
  try {
    img = processImage(new Uint8Array(await file.arrayBuffer()));
    const t = form.get('thumb');
    if (t && typeof t !== 'string' && t.size > 0 && t.size <= MAX_THUMB_BYTES) thumb = processImage(new Uint8Array(await t.arrayBuffer()));
  } catch (e) {
    if (e instanceof ImageError) throw new ApiError(415, 'IMAGEM_INVALIDA', e.message);
    throw e;
  }
  if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) throw new ApiError(422, 'DIMENSOES', `A imagem excede ${MAX_DIMENSION} píxeis de lado.`);
  if (thumb && (thumb.width > 800 || thumb.height > 800)) thumb = undefined;

  const id = uuid();
  const key = `anexos/${meta.data.entityType}/${id}`;
  const thumbKey = thumb ? `${key}-miniatura` : null;
  const ext = img.type === 'image/jpeg' ? 'jpg' : img.type === 'image/png' ? 'png' : 'webp';
  const originalName = (file.name || `fotografia.${ext}`).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120);
  await c.env.FILES.put(key, img.bytes, { httpMetadata: { contentType: img.type }, customMetadata: { attachmentId: id } });
  if (thumb && thumbKey) await c.env.FILES.put(thumbKey, thumb.bytes, { httpMetadata: { contentType: thumb.type } });
  try {
    await runBatch(c.env.DB, [
      c.env.DB.prepare(
        `INSERT INTO attachments (id, entity_type, entity_id, r2_key, thumb_r2_key, content_type, original_name, size_bytes, width, height, caption, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, meta.data.entityType, meta.data.entityId, key, thumbKey, img.type, originalName, img.bytes.length, img.width, img.height, meta.data.caption ?? null, c.get('user').id, nowIso()),
      auditStmt(c, 'anexo.carregar', meta.data.entityType, meta.data.entityId, { anexo: id, nome: originalName }),
    ]);
  } catch (e) {
    await c.env.FILES.delete([key, ...(thumbKey ? [thumbKey] : [])]);
    throw e;
  }
  return c.json({ id }, 201);
});

attachmentRoutes.get('/:id/file', requirePerm('read'), async (c) => {
  const id = c.req.param('id');
  const a = await first<{ r2_key: string; thumb_r2_key: string | null; content_type: string; original_name: string | null }>(
    c.env.DB,
    'SELECT r2_key, thumb_r2_key, content_type, original_name FROM attachments WHERE id = ? AND deleted_at IS NULL',
    id,
  );
  if (!a) notFound('Anexo');
  const wantThumb = c.req.query('variant') === 'thumb' && a.thumb_r2_key;
  const obj = await c.env.FILES.get(wantThumb ? a.thumb_r2_key! : a.r2_key);
  if (!obj) notFound('Ficheiro');
  const name = (a.original_name ?? 'fotografia').replace(/["\\\r\n]/g, '_');
  return new Response(obj.body, {
    headers: {
      'Content-Type': ['image/jpeg', 'image/png', 'image/webp'].includes(a.content_type) ? a.content_type : 'application/octet-stream',
      'Content-Disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=300',
    },
  });
});

attachmentRoutes.delete('/:id', requirePerm('attachments.write'), async (c) => {
  const id = c.req.param('id');
  const a = await first<{ r2_key: string; thumb_r2_key: string | null; entity_type: string; entity_id: string }>(
    c.env.DB,
    'SELECT r2_key, thumb_r2_key, entity_type, entity_id FROM attachments WHERE id = ? AND deleted_at IS NULL',
    id,
  );
  if (!a) notFound('Anexo');
  await runBatch(c.env.DB, [
    c.env.DB.prepare('UPDATE attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(nowIso(), c.get('user').id, id),
    auditStmt(c, 'anexo.remover', a.entity_type, a.entity_id, { anexo: id }),
  ]);
  await c.env.FILES.delete([a.r2_key, ...(a.thumb_r2_key ? [a.thumb_r2_key] : [])]);
  return c.json({ ok: true });
});
