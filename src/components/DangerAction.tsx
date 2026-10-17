import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey } from '../api/client';
import { Button, ConfirmDialog, TextArea } from './ui';

/**
 * Botão para eliminar/anular com janela de confirmação.
 * Quando `reason` é verdadeiro, exige um motivo (registado na auditoria).
 */
export function DangerAction({
  label,
  title,
  message,
  confirmLabel,
  reason,
  size = 'md',
  variant = 'danger',
  onConfirm,
  onDone,
  children,
}: {
  label: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  reason?: boolean;
  size?: 'sm' | 'md';
  variant?: 'danger' | 'ghost' | 'secondary';
  onConfirm: (reason: string, idempotencyKey: string) => Promise<unknown>;
  onDone?: () => void;
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(text.trim(), key);
      setOpen(false);
      setKey(newIdempotencyKey());
      qc.invalidateQueries();
      onDone?.();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={variant === 'ghost' ? 'text-red-700 hover:bg-red-50' : undefined}
        onClick={() => {
          setText('');
          setErr(null);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        danger
        title={title}
        message={message}
        confirmLabel={confirmLabel ?? 'Eliminar'}
        loading={busy}
        error={err}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          if (reason && text.trim().length < 3) {
            setErr(new Error('Indique o motivo (mínimo 3 caracteres).'));
            return;
          }
          run();
        }}
      >
        {reason && <TextArea label="Motivo (obrigatório)" value={text} onChange={(e) => setText(e.target.value)} />}
        {children}
      </ConfirmDialog>
    </>
  );
}
