import type { ReactNode } from 'react';
import { Button, Empty, ErrorBox, Loading, cx } from './ui';

export interface Col<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortKey?: string;
  className?: string;
  align?: 'right';
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  error,
  onRetry,
  rowKey,
  emptyTitle = 'Sem registos',
  emptyHint,
  sort,
  dir,
  onSort,
  onRowClick,
}: {
  columns: Col<T>[];
  rows?: T[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  rowKey: (r: T) => string;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  sort?: string;
  dir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  onRowClick?: (r: T) => void;
}) {
  if (error) return <ErrorBox error={error} onRetry={onRetry} />;
  if (loading && !rows) return <Loading />;
  if (!rows?.length) return <Empty title={emptyTitle}>{emptyHint}</Empty>;
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-slate-200 bg-white', loading && 'opacity-60')}>
      <table className="table-base">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.align === 'right' && 'text-right', c.className)} aria-sort={c.sortKey && sort === c.sortKey ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}>
                {c.sortKey && onSort ? (
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => onSort(c.sortKey!)}>
                    {c.header}
                    <span aria-hidden>{sort === c.sortKey ? (dir === 'desc' ? '▼' : '▲') : '↕'}</span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? 'cursor-pointer' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx(c.align === 'right' && 'text-right tabular-nums', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="mt-2 text-xs text-slate-500">{total} registo(s)</p>;
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" aria-label="Paginação">
      <span className="text-slate-500">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} de {total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ← Anterior
        </Button>
        <span>
          Página {page} de {pages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Seguinte →
        </Button>
      </div>
    </nav>
  );
}
