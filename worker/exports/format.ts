// Formatação comum às exportações (português de Portugal).

export type ColType = 'text' | 'int' | 'date' | 'datetime' | 'money';

export interface Column {
  key: string;
  label: string;
  type?: ColType;
  width?: number;
  map?: Record<string, string>;
}

export interface Dataset {
  title: string;
  sheetName: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  filters?: string[];
}

const TZ = 'Europe/Lisbon';

export function fmtDate(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  return new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(dt);
}

export function fmtDateTime(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  return new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(dt);
}

export function fmtMoney(cents: unknown): string {
  if (cents === null || cents === undefined || cents === '') return '';
  return (Number(cents) / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function cellText(col: Column, row: Record<string, unknown>): string {
  const v = row[col.key];
  if (v === null || v === undefined) return '';
  if (col.map) return col.map[String(v)] ?? String(v);
  switch (col.type) {
    case 'date':
      return fmtDate(v);
    case 'datetime':
      return fmtDateTime(v);
    case 'money':
      return fmtMoney(v);
    case 'int':
      return String(Number(v));
    default:
      return String(v);
  }
}

export function nowLabel(): string {
  return fmtDateTime(new Date().toISOString());
}

export function fileStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
