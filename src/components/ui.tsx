import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'gold';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-marinho-700 text-white hover:bg-marinho-800 disabled:bg-marinho-200',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-200',
  ghost: 'text-marinho-700 hover:bg-marinho-50 disabled:text-slate-400',
  gold: 'bg-ouro-400 text-marinho-900 hover:bg-ouro-500 disabled:opacity-50',
};

export function Button({ variant = 'primary', loading, className, children, size = 'md', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function LinkButton({ to, children, variant = 'primary', size = 'md', className }: { to: string; children: ReactNode; variant?: Variant; size?: 'sm' | 'md'; className?: string }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center gap-2 rounded-md font-medium', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm', VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'h-3.5 w-3.5' : 'h-6 w-6')} role="status" aria-label="A carregar" />;
}

export function Loading({ text = 'A carregar…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-3 p-6 text-slate-500">
      <Spinner /> {text}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>{msg}</p>
      {error instanceof ApiError && error.code === 'POSSIVEL_DUPLICADO' && Array.isArray((error.details as { candidates?: unknown[] })?.candidates) && (
        <ul className="mt-2 list-inside list-disc">
          {((error.details as { candidates: { id: string; full_name: string; internal_code?: string }[] }).candidates).map((c) => (
            <li key={c.id}>
              <Link className="underline" to={`/musicos/${c.id}`}>
                {c.full_name}
              </Link>
              {c.internal_code ? ` (${c.internal_code})` : ''}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button className="mt-2 text-sm font-medium underline" onClick={onRetry}>
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-base font-semibold text-marinho-800">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="mb-5">
      {back && (
        <Link to={back.to} className="mb-1 inline-block text-sm text-marinho-600 hover:underline">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-marinho-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

const TONES = {
  green: 'bg-emerald-100 text-emerald-800',
  blue: 'bg-sky-100 text-sky-800',
  navy: 'bg-marinho-100 text-marinho-800',
  amber: 'bg-amber-100 text-amber-900',
  orange: 'bg-orange-100 text-orange-900',
  red: 'bg-red-100 text-red-800',
  grey: 'bg-slate-200 text-slate-700',
  purple: 'bg-violet-100 text-violet-800',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone])}>{children}</span>;
}

export const STATUS_TONE: Record<string, Tone> = {
  disponivel: 'green',
  reservado: 'purple',
  atribuido: 'navy',
  emprestado: 'blue',
  pendente_inspecao: 'amber',
  quarentena: 'orange',
  reparacao: 'orange',
  abatido: 'grey',
  extraviado: 'red',
  rejeitado: 'grey',
};

// --- Formulários -------------------------------------------------------------

export function Field({ label, error, hint, children, required, className }: { label: string; error?: string; hint?: string; children: (id: string) => ReactNode; required?: boolean; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({ label, error, hint, required, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(id) => <input id={id} className="input" aria-invalid={error ? true : undefined} required={required} {...p} />}
    </Field>
  );
}

export function TextArea({ label, error, hint, required, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(id) => <textarea id={id} rows={3} className="input" aria-invalid={error ? true : undefined} required={required} {...p} />}
    </Field>
  );
}

export function SelectInput({
  label,
  error,
  hint,
  required,
  className,
  options,
  placeholder,
  ...p
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string; options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(id) => (
        <select id={id} className="input" aria-invalid={error ? true : undefined} required={required} {...p}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-marinho-700" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-slate-700">
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </label>
    </div>
  );
}

// --- Janelas modais ------------------------------------------------------------

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-lg p-0 shadow-xl backdrop:bg-slate-900/50', wide ? 'max-w-4xl' : 'max-w-lg')}
      aria-labelledby="modal-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b px-5 py-3">
            <h2 id="modal-title" className="text-lg font-semibold text-marinho-800">
              {title}
            </h2>
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">
              ✕
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t bg-slate-50 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  danger,
  loading,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <div>{message}</div>
        {children}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: ReactNode }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            active === t.key ? 'border-marinho-700 text-marinho-800' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone = 'navy', to, hint }: { label: string; value: ReactNode; tone?: Tone; to?: string; hint?: string }) {
  const body = (
    <div className="h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-marinho-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-bold', tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-emerald-700' : 'text-marinho-800')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function DefList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col border-b border-slate-100 pb-1 sm:flex-row sm:gap-2">
          <dt className="text-sm font-medium text-slate-500 sm:w-44 sm:shrink-0">{k}</dt>
          <dd className="text-sm text-slate-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
