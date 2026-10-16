import {
  CONDITION_LABELS,
  MOVEMENT_LABELS,
  ORIGIN_LABELS,
  STATUS_LABELS,
  type Condition,
  type MovementType,
  type Status,
} from '../../shared/domain';

const TZ = 'Europe/Lisbon';

export function fmtDate(v?: string | null): string {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function fmtDateTime(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function fmtNum(n?: number | null): string {
  return (n ?? 0).toLocaleString('pt-PT');
}

export function fmtMoney(cents?: number | null): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const statusLabel = (s?: string | null) => (s ? (STATUS_LABELS[s as Status] ?? s) : '—');
export const conditionLabel = (s?: string | null) => (s ? (CONDITION_LABELS[s as Condition] ?? s) : '—');
export const movementLabel = (s?: string | null) => (s ? (MOVEMENT_LABELS[s as MovementType] ?? s) : '—');
export const originLabel = (s?: string | null) => (s ? ((ORIGIN_LABELS as Record<string, string>)[s] ?? s) : '—');

export function plural(n: number, one: string, many: string) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}
