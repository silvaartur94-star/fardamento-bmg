// Construtor de documentos PDF para impressão (pdf-lib, compatível com Workers).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { cellText, nowLabel, type Column, type Dataset } from './format';
import { LOGO_PNG_BASE64 } from './logo-data';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const NAVY = rgb(0.12, 0.23, 0.37);
const GREY = rgb(0.4, 0.4, 0.4);
const LINE = rgb(0.82, 0.85, 0.89);
const ZEBRA = rgb(0.96, 0.97, 0.98);

// Caracteres representáveis na codificação WinAnsi das fontes padrão.
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function winAnsi(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (ch === '\n') out += ' ';
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.includes(ch)) out += ch;
    else if (code === 0x09) out += ' ';
    else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]$/.test(base) ? base : '?';
    }
  }
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface TableColumn extends Column {
  /** Largura relativa da coluna. */
  weight?: number;
  align?: 'left' | 'right';
}

export class PdfBuilder {
  doc!: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  logo!: PDFImage;
  page!: PDFPage;
  y = 0;
  size: [number, number] = A4;
  title = '';
  subtitle: string[] = [];

  static async create(title: string, opts: { subtitle?: string[]; landscape?: boolean } = {}) {
    const b = new PdfBuilder();
    b.doc = await PDFDocument.create();
    b.doc.setTitle(winAnsi(title));
    b.doc.setAuthor('Banda Marcial de Gueifães');
    b.doc.setCreator('Gestão de Fardamento — BMG');
    b.doc.setLanguage('pt-PT');
    b.font = await b.doc.embedFont(StandardFonts.Helvetica);
    b.bold = await b.doc.embedFont(StandardFonts.HelveticaBold);
    b.logo = await b.doc.embedPng(b64ToBytes(LOGO_PNG_BASE64));
    b.title = title;
    b.subtitle = opts.subtitle ?? [];
    if (opts.landscape) b.size = [A4[1], A4[0]];
    b.newPage();
    return b;
  }

  get width() {
    return this.size[0] - MARGIN * 2;
  }

  newPage() {
    this.page = this.doc.addPage(this.size);
    const [w, h] = this.size;
    const logoH = 46;
    this.page.drawImage(this.logo, { x: MARGIN, y: h - MARGIN - logoH, width: logoH, height: logoH });
    this.page.drawText('Banda Marcial de Gueifães', { x: MARGIN + 56, y: h - MARGIN - 12, size: 9, font: this.bold, color: GREY });
    this.page.drawText(winAnsi(this.title), { x: MARGIN + 56, y: h - MARGIN - 30, size: 15, font: this.bold, color: NAVY });
    this.page.drawText(winAnsi(`Emitido em ${nowLabel()}`), { x: MARGIN + 56, y: h - MARGIN - 43, size: 8, font: this.font, color: GREY });
    this.y = h - MARGIN - logoH - 12;
    for (const s of this.subtitle) {
      for (const line of this.wrap(s, this.font, 8, this.width)) {
        this.page.drawText(line, { x: MARGIN, y: this.y, size: 8, font: this.font, color: GREY });
        this.y -= 11;
      }
    }
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: w - MARGIN, y: this.y }, thickness: 1, color: NAVY });
    this.y -= 14;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }

  wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const words = winAnsi(text).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(cand, size) <= maxW) cur = cand;
      else {
        if (cur) lines.push(cur);
        let word = w;
        while (font.widthOfTextAtSize(word, size) > maxW && word.length > 1) {
          let i = word.length;
          while (i > 1 && font.widthOfTextAtSize(word.slice(0, i), size) > maxW) i--;
          lines.push(word.slice(0, i));
          word = word.slice(i);
        }
        cur = word;
      }
    }
    if (cur || !lines.length) lines.push(cur);
    return lines;
  }

  heading(text: string) {
    this.ensure(30);
    this.y -= 4;
    this.page.drawText(winAnsi(text), { x: MARGIN, y: this.y, size: 11, font: this.bold, color: NAVY });
    this.y -= 16;
  }

  paragraph(text: string, size = 9, color = rgb(0, 0, 0)) {
    for (const line of this.wrap(text, this.font, size, this.width)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font: this.font, color });
      this.y -= size + 3;
    }
    this.y -= 3;
  }

  /** Pares etiqueta/valor em duas colunas. */
  fields(pairs: [string, unknown][]) {
    const colW = this.width / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      this.ensure(14);
      for (let j = 0; j < 2 && i + j < pairs.length; j++) {
        const [k, v] = pairs[i + j];
        const x = MARGIN + j * colW;
        this.page.drawText(winAnsi(`${k}:`), { x, y: this.y, size: 8.5, font: this.bold, color: GREY });
        const lw = this.bold.widthOfTextAtSize(winAnsi(`${k}: `), 8.5);
        const val = this.wrap(String(v ?? '—') || '—', this.font, 9, colW - lw - 8)[0];
        this.page.drawText(val, { x: x + lw, y: this.y, size: 9, font: this.font });
      }
      this.y -= 14;
    }
    this.y -= 4;
  }

  table(columns: TableColumn[], rows: Record<string, unknown>[], opts: { emptyText?: string } = {}) {
    const total = columns.reduce((a, c) => a + (c.weight ?? 1), 0);
    const widths = columns.map((c) => ((c.weight ?? 1) / total) * this.width);
    const size = 8;
    const pad = 3;
    const drawHeader = () => {
      const hLines = columns.map((c, i) => this.wrap(c.label, this.bold, size, widths[i] - pad * 2));
      const h = Math.max(...hLines.map((l) => l.length)) * (size + 2) + pad * 2;
      this.ensure(h + 16);
      this.page.drawRectangle({ x: MARGIN, y: this.y - h + size, width: this.width, height: h, color: NAVY });
      let x = MARGIN;
      columns.forEach((c, i) => {
        hLines[i].forEach((ln, li) => this.page.drawText(ln, { x: x + pad, y: this.y - pad - li * (size + 2), size, font: this.bold, color: rgb(1, 1, 1) }));
        x += widths[i];
      });
      this.y -= h;
    };
    drawHeader();
    if (!rows.length) {
      this.page.drawText(winAnsi(opts.emptyText ?? 'Sem registos.'), { x: MARGIN + pad, y: this.y - 2, size, font: this.font, color: GREY });
      this.y -= 16;
      return;
    }
    rows.forEach((row, ri) => {
      const cellLines = columns.map((c, i) => this.wrap(cellText(c, row), this.font, size, widths[i] - pad * 2));
      const h = Math.max(...cellLines.map((l) => l.length)) * (size + 2) + pad * 2;
      if (this.y - h < MARGIN + 20) {
        this.newPage();
        drawHeader();
      }
      if (ri % 2 === 1) this.page.drawRectangle({ x: MARGIN, y: this.y - h + size, width: this.width, height: h, color: ZEBRA });
      let x = MARGIN;
      columns.forEach((c, i) => {
        cellLines[i].forEach((ln, li) => {
          const tw = this.font.widthOfTextAtSize(ln, size);
          const tx = c.align === 'right' ? x + widths[i] - pad - tw : x + pad;
          this.page.drawText(ln, { x: tx, y: this.y - pad - li * (size + 2), size, font: this.font });
        });
        x += widths[i];
      });
      this.page.drawLine({ start: { x: MARGIN, y: this.y - h + size }, end: { x: MARGIN + this.width, y: this.y - h + size }, thickness: 0.5, color: LINE });
      this.y -= h;
    });
    this.y -= 10;
  }

  /** Campos de assinatura (quem entrega, quem recebe, quem inspeciona…). */
  signatures(labels: string[]) {
    this.ensure(70);
    this.y -= 30;
    const w = (this.width - (labels.length - 1) * 20) / labels.length;
    labels.forEach((l, i) => {
      const x = MARGIN + i * (w + 20);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + w, y: this.y }, thickness: 0.7, color: rgb(0, 0, 0) });
      this.page.drawText(winAnsi(l), { x, y: this.y - 11, size: 8, font: this.font, color: GREY });
      this.page.drawText('Data: ____/____/________', { x, y: this.y - 23, size: 8, font: this.font, color: GREY });
    });
    this.y -= 34;
  }

  async finish(): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const { width: w } = p.getSize();
      const txt = winAnsi(`Página ${i + 1} de ${pages.length}`);
      p.drawText(txt, { x: w - MARGIN - this.font.widthOfTextAtSize(txt, 7), y: MARGIN - 18, size: 7, font: this.font, color: GREY });
      p.drawText(winAnsi('Banda Marcial de Gueifães — Gestão de Fardamento e Inventário'), { x: MARGIN, y: MARGIN - 18, size: 7, font: this.font, color: GREY });
    });
    return this.doc.save();
  }
}

/** Documento PDF com uma ou mais tabelas a partir de datasets. */
export async function datasetsToPdf(title: string, datasets: Dataset[], opts: { landscape?: boolean; subtitle?: string[]; signatures?: string[] } = {}) {
  const filters = datasets[0]?.filters ?? [];
  const pdf = await PdfBuilder.create(title, { landscape: opts.landscape, subtitle: [...(opts.subtitle ?? []), ...(filters.length ? [`Filtros aplicados: ${filters.join('; ')}`] : ['Filtros aplicados: nenhum (conjunto completo)'])] });
  for (const ds of datasets) {
    if (datasets.length > 1) pdf.heading(`${ds.title} (${ds.rows.length})`);
    pdf.table(ds.columns as TableColumn[], ds.rows);
  }
  if (opts.signatures) pdf.signatures(opts.signatures);
  return pdf.finish();
}

// ---------------------------------------------------------------------------
// Etiquetas com código QR (A4, 3 × 8 etiquetas de 70 × 37 mm)
// ---------------------------------------------------------------------------
export interface LabelItem {
  code: string;
  line1: string;
  line2?: string;
  url: string;
}

const MM = 72 / 25.4;

export async function labelsPdf(items: LabelItem[], startPosition = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Etiquetas de fardamento');
  doc.setAuthor('Banda Marcial de Gueifães');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const cols = 3;
  const rows = 8;
  const lw = 70 * MM;
  const lh = 37 * MM;
  const top = (A4[1] - rows * lh) / 2;
  let page: PDFPage | null = null;
  let pos = Math.max(0, Math.min(startPosition - 1, cols * rows - 1));
  for (const it of items) {
    if (!page || pos >= cols * rows) {
      page = doc.addPage(A4);
      if (pos >= cols * rows) pos = 0;
    }
    const col = pos % cols;
    const row = Math.floor(pos / cols);
    const x = col * lw;
    const yTop = A4[1] - top - row * lh;
    const qr = qrcode(0, 'M');
    qr.addData(it.url);
    qr.make();
    const n = qr.getModuleCount();
    const qrSize = lh - 8 * MM;
    const cell = qrSize / n;
    const qx = x + 4 * MM;
    const qy = yTop - 4 * MM - qrSize;
    for (let r = 0; r < n; r++) {
      for (let cc = 0; cc < n; cc++) {
        if (qr.isDark(r, cc)) page.drawRectangle({ x: qx + cc * cell, y: qy + (n - 1 - r) * cell, width: cell + 0.05, height: cell + 0.05, color: rgb(0, 0, 0) });
      }
    }
    const tx = qx + qrSize + 3 * MM;
    const tw = x + lw - 3 * MM - tx;
    const fit = (s: string, f: PDFFont, size: number) => {
      let t = winAnsi(s);
      while (t.length > 1 && f.widthOfTextAtSize(t, size) > tw) t = t.slice(0, -1);
      return t;
    };
    page.drawText(fit(it.code, bold, 13), { x: tx, y: yTop - 10 * MM, size: 13, font: bold });
    page.drawText(fit(it.line1, font, 8.5), { x: tx, y: yTop - 16 * MM, size: 8.5, font });
    if (it.line2) page.drawText(fit(it.line2, font, 8), { x: tx, y: yTop - 21 * MM, size: 8, font });
    page.drawText(fit('Banda Marcial de Gueifães', font, 6), { x: tx, y: yTop - 31 * MM, size: 6, font, color: GREY });
    pos++;
  }
  if (!items.length) doc.addPage(A4);
  return doc.save();
}
