// Componentes ligados ao domínio: estados, tabelas de movimentos, seleção de artigos e fotografias.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { conditionLabel, fmtDateTime, movementLabel, statusLabel } from '../lib/format';
import { useAuth } from '../lib/auth';
import type { ItemType } from '../lib/hooks';
import { Badge, Button, ErrorBox, STATUS_TONE, SelectInput, Spinner, type Tone } from './ui';
import { DataTable } from './DataTable';

export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge tone={STATUS_TONE[status ?? ''] ?? 'grey'}>{statusLabel(status)}</Badge>;
}

const COND_TONE: Record<string, Tone> = { novo: 'green', bom: 'green', razoavel: 'amber', mau: 'orange', inutilizavel: 'red' };
export function ConditionBadge({ condition }: { condition?: string | null }) {
  return <Badge tone={COND_TONE[condition ?? ''] ?? 'grey'}>{conditionLabel(condition)}</Badge>;
}

export interface MovementRow {
  id: string;
  seq: number;
  movement_type: string;
  item_type_name?: string;
  size_label?: string | null;
  garment_id?: string | null;
  garment_code?: string | null;
  quantity: number;
  from_status: string | null;
  to_status: string | null;
  from_location_name?: string | null;
  to_location_name?: string | null;
  musician_id?: string | null;
  musician_name?: string | null;
  reason?: string | null;
  notes?: string | null;
  user_name: string;
  created_at: string;
  reversed_by?: string | null;
  reverses_movement_id?: string | null;
}

export function MovementsTable({ rows, compact, actions }: { rows: MovementRow[]; compact?: boolean; actions?: (m: MovementRow) => React.ReactNode }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(m) => m.id}
      emptyTitle="Sem movimentos registados"
      columns={[
        { key: 'date', header: 'Data', render: (m) => <span className="whitespace-nowrap">{fmtDateTime(m.created_at)}</span> },
        {
          key: 'type',
          header: 'Movimento',
          render: (m) => (
            <span>
              {movementLabel(m.movement_type)}
              {m.reversed_by && (
                <Badge tone="grey">estornado</Badge>
              )}
            </span>
          ),
        },
        ...(compact
          ? []
          : [
              {
                key: 'item',
                header: 'Artigo',
                render: (m: MovementRow) => (
                  <span>
                    {m.item_type_name} {m.size_label && <span className="text-slate-500">({m.size_label})</span>}
                    {m.garment_code && (
                      <Link to={`/inventario/pecas/${m.garment_id}`} className="ml-1 font-mono text-xs text-marinho-700 underline">
                        {m.garment_code}
                      </Link>
                    )}
                  </span>
                ),
              },
            ]),
        { key: 'q', header: 'Qtd.', align: 'right', render: (m) => m.quantity },
        {
          key: 'flow',
          header: 'De → Para',
          render: (m) => (
            <span className="flex flex-wrap items-center gap-1">
              {m.from_status ? <StatusBadge status={m.from_status} /> : <span className="text-xs text-slate-400">entrada</span>}→
              {m.to_status ? <StatusBadge status={m.to_status} /> : <span className="text-xs text-slate-400">saída</span>}
              {(m.from_location_name || m.to_location_name) && m.from_location_name !== m.to_location_name && (
                <span className="text-xs text-slate-500">
                  ({m.from_location_name ?? '—'} → {m.to_location_name ?? '—'})
                </span>
              )}
            </span>
          ),
        },
        { key: 'mus', header: 'Músico', render: (m) => (m.musician_id ? <Link className="underline" to={`/musicos/${m.musician_id}`}>{m.musician_name}</Link> : '—') },
        { key: 'reason', header: 'Motivo', render: (m) => <span className="text-slate-600">{m.reason ?? m.notes ?? ''}</span> },
        { key: 'user', header: 'Responsável', render: (m) => m.user_name },
        ...(actions ? [{ key: 'actions', header: '', render: actions }] : []),
      ]}
    />
  );
}

/** Seleção de tipo de artigo + tamanho. */
export function TypeSizePicker({
  types,
  typeId,
  sizeId,
  onChange,
  requireSize,
  typeLabel = 'Artigo',
  sizeLabel = 'Tamanho',
}: {
  types: ItemType[];
  typeId: string;
  sizeId: string;
  onChange: (typeId: string, sizeId: string) => void;
  requireSize?: boolean;
  typeLabel?: string;
  sizeLabel?: string;
}) {
  const t = types.find((x) => x.id === typeId);
  return (
    <>
      <SelectInput label={typeLabel} value={typeId} onChange={(e) => onChange(e.target.value, '')} options={types.map((x) => ({ value: x.id, label: x.name }))} placeholder="Selecione…" required />
      {t?.has_size ? (
        <SelectInput
          label={sizeLabel}
          value={sizeId}
          onChange={(e) => onChange(typeId, e.target.value)}
          options={t.sizes.filter((s) => s.active).map((s) => ({ value: s.id, label: s.label }))}
          placeholder={requireSize ? 'Selecione…' : 'Sem tamanho / desconhecido'}
          required={requireSize}
        />
      ) : (
        <div />
      )}
    </>
  );
}

// --- Fotografias ---------------------------------------------------------------

interface AttachmentRow {
  id: string;
  caption: string | null;
  content_type: string;
  uploaded_at: string;
  has_thumb: number;
  uploaded_by_name?: string;
}

/** Reduz a imagem no navegador (remove também os metadados EXIF) e gera uma miniatura. */
async function prepareImage(file: File): Promise<{ main: Blob; thumb: Blob }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => null);
  if (!bitmap) return { main: file, thumb: file };
  const draw = (max: number, quality: number) =>
    new Promise<Blob>((resolve, reject) => {
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao processar a imagem'))), 'image/jpeg', quality);
    });
  return { main: await draw(2400, 0.85), thumb: await draw(320, 0.7) };
}

export function Photos({ entityType, entityId, title = 'Fotografias' }: { entityType: string; entityId: string; title?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const key = ['attachments', entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ items: AttachmentRow[] }>('/attachments', { entityType, entityId }) });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [caption, setCaption] = useState('');
  const [preview, setPreview] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(f.type) && !/\.(jpe?g|png|webp|heic)$/i.test(f.name)) {
          throw new ApiError(415, 'FORMATO', `"${f.name}" não é uma fotografia suportada (JPEG, PNG ou WebP).`);
        }
        const { main, thumb } = await prepareImage(f);
        const fd = new FormData();
        fd.set('entityType', entityType);
        fd.set('entityId', entityId);
        if (caption) fd.set('caption', caption);
        fd.set('file', new File([main], f.name.replace(/\.\w+$/, '.jpg'), { type: main.type || f.type }));
        fd.set('thumb', new File([thumb], 'miniatura.jpg', { type: 'image/jpeg' }));
        await api.post('/attachments', fd);
      }
      setCaption('');
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover esta fotografia? Esta operação fica registada na auditoria.')) return;
    try {
      await api.del(`/attachments/${id}`);
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{title}</h3>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="flex flex-wrap gap-3">
          {q.data?.items.map((a) => (
            <figure key={a.id} className="w-32">
              <button onClick={() => setPreview(a.id)} className="block h-32 w-32 overflow-hidden rounded border bg-slate-100">
                <img src={`/api/attachments/${a.id}/file?variant=thumb`} alt={a.caption ?? 'Fotografia'} className="h-full w-full object-cover" loading="lazy" />
              </button>
              <figcaption className="mt-1 truncate text-xs text-slate-600" title={a.caption ?? ''}>
                {a.caption ?? fmtDateTime(a.uploaded_at)}
              </figcaption>
              {can('attachments.write') && (
                <button className="text-xs text-red-700 underline" onClick={() => remove(a.id)}>
                  Remover
                </button>
              )}
            </figure>
          ))}
          {!q.data?.items.length && <p className="text-sm text-slate-500">Sem fotografias.</p>}
        </div>
      )}
      {can('attachments.write') && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input className="input max-w-xs" placeholder="Legenda (opcional)" value={caption} onChange={(e) => setCaption(e.target.value)} aria-label="Legenda da fotografia" />
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          <Button variant="secondary" onClick={() => input.current?.click()} loading={busy}>
            📷 Adicionar fotografia
          </Button>
        </div>
      )}
      <div className="mt-2">
        <ErrorBox error={error} />
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(null)} role="dialog" aria-label="Pré-visualização">
          <img src={`/api/attachments/${preview}/file`} alt="Fotografia" className="max-h-full max-w-full rounded" />
        </div>
      )}
    </div>
  );
}
