import { useState } from 'react';
import { Link } from 'react-router-dom';
import { smsLink, whatsappLink } from '../lib/phone';
import { Modal, SelectInput, TextArea } from './ui';

/** Botões que abrem o WhatsApp ou a app de SMS com a mensagem já escrita. */
export function SendButtons({ phone, text, onSent, size = 'md' }: { phone: string; text: string; onSent?: (channel: 'whatsapp' | 'sms') => void; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm';
  return (
    <span className="inline-flex flex-wrap gap-2">
      <a
        href={whatsappLink(phone, text)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => onSent?.('whatsapp')}
        className={`inline-flex items-center gap-1 rounded-md bg-emerald-600 font-medium text-white hover:bg-emerald-700 ${cls}`}
      >
        WhatsApp
      </a>
      <a href={smsLink(phone, text)} onClick={() => onSent?.('sms')} className={`inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white font-medium text-slate-800 hover:bg-slate-50 ${cls}`}>
        SMS
      </a>
    </span>
  );
}

export interface MessageTemplate {
  key: string;
  label: string;
  text: string;
}

/** Janela para escrever (ou escolher um modelo de) mensagem e enviá-la a um contacto. */
export function MessageModal({
  open,
  onClose,
  name,
  phone,
  templates,
  editLink,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  phone: string | null;
  templates: MessageTemplate[];
  editLink?: string;
  onSent?: (channel: 'whatsapp' | 'sms', purpose: string) => void;
}) {
  const [tpl, setTpl] = useState(templates[0]?.key ?? '');
  const [text, setText] = useState(templates[0]?.text ?? '');
  const current = templates.find((t) => t.key === tpl);
  return (
    <Modal open={open} onClose={onClose} title={`Mensagem para ${name}`}>
      {!phone ? (
        <p className="text-sm text-amber-900">
          Este músico não tem telemóvel registado.{' '}
          {editLink && (
            <Link to={editLink} className="underline" onClick={onClose}>
              Edite a ficha
            </Link>
          )}{' '}
          para o acrescentar.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Telemóvel: <strong>{phone}</strong></p>
          {templates.length > 1 && (
            <SelectInput
              label="Modelo"
              value={tpl}
              onChange={(e) => {
                setTpl(e.target.value);
                setText(templates.find((t) => t.key === e.target.value)?.text ?? '');
              }}
              options={templates.map((t) => ({ value: t.key, label: t.label }))}
            />
          )}
          <TextArea label="Mensagem (pode editar)" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
          <SendButtons phone={phone} text={text} onSent={(ch) => onSent?.(ch, current?.label ?? 'Mensagem')} />
          <p className="text-xs text-slate-500">Abre o WhatsApp ou a aplicação de SMS com a mensagem já escrita; confirme o envio lá. O envio fica registado no histórico.</p>
        </div>
      )}
    </Modal>
  );
}

export const RETURN_TEMPLATE =
  'Olá {nome}, obrigado por ter tocado connosco na {festa}!\n\nPedimos que entregue os elementos da farda que lhe foram emprestados:\n{artigos}\n\nPrazo de entrega: {prazo}.\n\nObrigado,\nBanda Marcial de Gueifães';
