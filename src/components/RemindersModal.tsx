import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { fmtDate, fmtDateTime } from '../lib/format';
import { fillTemplate, firstName } from '../lib/phone';
import { RETURN_TEMPLATE, SendButtons } from './messages';
import { Badge, Modal, TextArea } from './ui';

export interface ReminderTarget {
  loanId: string;
  musicianId: string;
  name: string;
  phone: string | null;
  items: string[];
  dueDate: string | null;
  lastReminderAt: string | null;
  reminderCount: number;
}

/** Lembretes de devolução da farda aos músicos convidados com material em falta. */
export function RemindersModal({ open, onClose, eventName, targets }: { open: boolean; onClose: () => void; eventName: string; targets: ReminderTarget[] }) {
  const qc = useQueryClient();
  const [template, setTemplate] = useState(RETURN_TEMPLATE);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const textFor = (t: ReminderTarget) =>
    fillTemplate(template, {
      nome: firstName(t.name),
      festa: eventName,
      artigos: t.items.map((i) => `- ${i}`).join('\n'),
      prazo: t.dueDate ? fmtDate(t.dueDate) : 'o mais breve possível',
    });
  async function mark(t: ReminderTarget, channel: 'whatsapp' | 'sms') {
    setSent((s) => ({ ...s, [t.loanId]: true }));
    await api.post(`/loans/${t.loanId}/reminded`, { channel }).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['event'] });
    qc.invalidateQueries({ queryKey: ['loan'] });
  }
  return (
    <Modal open={open} onClose={onClose} wide title="Lembrar a devolução da farda">
      {!targets.length ? (
        <p className="text-sm text-emerald-800">Não há material emprestado por devolver.</p>
      ) : (
        <div className="space-y-4">
          <TextArea
            label="Mensagem (pode editar)"
            rows={7}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            hint="{nome}, {festa}, {artigos} e {prazo} são preenchidos automaticamente para cada músico."
          />
          <ul className="divide-y rounded border">
            {targets.map((t) => (
              <li key={t.loanId} className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {t.name} {t.phone && <span className="font-normal text-slate-500">· {t.phone}</span>}
                  </p>
                  <p className="text-slate-600">{t.items.join(', ')}</p>
                  {t.reminderCount > 0 && (
                    <p className="text-xs text-slate-500">
                      Já lembrado {t.reminderCount} vez(es); último em {fmtDateTime(t.lastReminderAt)}
                    </p>
                  )}
                </div>
                {t.phone ? (
                  <span className="flex items-center gap-2">
                    {sent[t.loanId] && <Badge tone="green">enviado</Badge>}
                    <SendButtons size="sm" phone={t.phone} text={textFor(t)} onSent={(ch) => mark(t, ch)} />
                  </span>
                ) : (
                  <Link to={`/musicos/${t.musicianId}`} className="text-xs text-amber-800 underline" onClick={onClose}>
                    Sem telemóvel — adicionar na ficha
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Cada botão abre o WhatsApp ou a aplicação de SMS com a mensagem pronta para esse músico; confirme o envio lá. Os lembretes ficam registados.</p>
        </div>
      )}
    </Modal>
  );
}
