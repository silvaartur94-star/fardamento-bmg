import { cellText, type Dataset } from './format';

/**
 * CSV compatível com o Excel em português:
 *  - codificação UTF-8 com BOM;
 *  - separador ponto e vírgula (;) — a vírgula é o separador decimal em Portugal;
 *  - todos os campos entre aspas, aspas internas duplicadas, linhas terminadas em CRLF;
 *  - proteção contra CSV injection: texto que comece por = + - @ TAB ou CR é prefixado com apóstrofo.
 */
export function toCsv(ds: Dataset): Uint8Array {
  const lines = [ds.columns.map((c) => quote(c.label)).join(';')];
  for (const row of ds.rows) {
    lines.push(ds.columns.map((c) => quote(protect(cellText(c, row), c.type))).join(';'));
  }
  const body = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

export function protect(s: string, type?: string): string {
  if (type === 'int' || type === 'money') return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
