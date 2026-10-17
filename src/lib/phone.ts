// Ligações para enviar mensagens a partir do dispositivo do utilizador (sem serviços pagos).

/** Número em formato internacional só com dígitos (assume Portugal +351 para números de 9 dígitos). */
export function intlDigits(phone: string): string {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 9) d = `351${d}`;
  return d.replace(/\D/g, '');
}

export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${intlDigits(phone)}?text=${encodeURIComponent(text)}`;
}

export function smsLink(phone: string, text: string): string {
  return `sms:+${intlDigits(phone)}?&body=${encodeURIComponent(text)}`;
}

/** Substitui {chaves} num modelo de mensagem. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
