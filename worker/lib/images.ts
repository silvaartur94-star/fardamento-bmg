// Validação de imagens e remoção de metadados (EXIF/XMP/texto) sem dependências externas.

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(b: Uint8Array, off: number, len: number) {
  return String.fromCharCode(...b.subarray(off, off + len));
}
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
const u24le = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16);

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ProcessedImage {
  bytes: Uint8Array;
  type: ImageType;
  width: number;
  height: number;
}

export class ImageError extends Error {}

/** Valida a imagem, obtém as dimensões e remove metadados. Lança ImageError se inválida. */
export function processImage(input: Uint8Array): ProcessedImage {
  const type = sniffImage(input);
  if (!type) throw new ImageError('Formato não suportado. Utilize JPEG, PNG ou WebP.');
  if (type === 'image/jpeg') return { type, ...stripJpeg(input) };
  if (type === 'image/png') return { type, ...stripPng(input) };
  return { type, ...stripWebp(input) };
}

function stripJpeg(b: Uint8Array) {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let o = 2;
  let width = 0;
  let height = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) throw new ImageError('Ficheiro JPEG corrompido.');
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      parts.push(b.subarray(o, o + 2));
      o += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda) {
      // Início dos dados da imagem: o resto é copiado tal como está.
      parts.push(b.subarray(o));
      o = b.length;
      break;
    }
    const len = u16be(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) throw new ImageError('Ficheiro JPEG corrompido.');
    const seg = b.subarray(o, o + 2 + len);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = u16be(b, o + 5);
      width = u16be(b, o + 7);
    }
    // Remove APP1..APP15 (EXIF, XMP, IPTC…) e comentários; mantém APP0 (JFIF) e APP2 (perfil ICC).
    const isAppToDrop = marker >= 0xe1 && marker <= 0xef && !(marker === 0xe2 && ascii(b, o + 4, 11) === 'ICC_PROFILE');
    if (!isAppToDrop && marker !== 0xfe) parts.push(seg);
    o += 2 + len;
  }
  if (!width || !height) throw new ImageError('Não foi possível ler as dimensões da imagem.');
  return { bytes: concat(parts), width, height };
}

function stripPng(b: Uint8Array) {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  let width = 0;
  let height = 0;
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (end > b.length) throw new ImageError('Ficheiro PNG corrompido.');
    if (type === 'IHDR') {
      width = u32be(b, o + 8);
      height = u32be(b, o + 12);
    }
    if (!drop.has(type)) parts.push(b.subarray(o, end));
    o = end;
    if (type === 'IEND') break;
  }
  if (!width || !height) throw new ImageError('Não foi possível ler as dimensões da imagem.');
  return { bytes: concat(parts), width, height };
}

function stripWebp(b: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let o = 12;
  let width = 0;
  let height = 0;
  let vp8xIndex = -1;
  while (o + 8 <= b.length) {
    const fourcc = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    const end = o + 8 + size + (size & 1);
    if (o + 8 + size > b.length) throw new ImageError('Ficheiro WebP corrompido.');
    const chunk = b.slice(o, Math.min(end, b.length));
    if (fourcc === 'VP8X') {
      width = u24le(b, o + 12) + 1;
      height = u24le(b, o + 15) + 1;
      vp8xIndex = chunks.length;
    } else if (fourcc === 'VP8 ' && !width) {
      width = (b[o + 14] | (b[o + 15] << 8)) & 0x3fff;
      height = (b[o + 16] | (b[o + 17] << 8)) & 0x3fff;
    } else if (fourcc === 'VP8L' && !width) {
      const bits = u32le(b, o + 9);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') chunks.push(chunk);
    o = end;
  }
  if (vp8xIndex >= 0) {
    // Limpa as flags EXIF (bit 3) e XMP (bit 2) do cabeçalho VP8X.
    chunks[vp8xIndex][8] &= ~(0x08 | 0x04);
  }
  if (!width || !height) throw new ImageError('Não foi possível ler as dimensões da imagem.');
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46]);
  const riffSize = body.length + 4;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >> 8) & 0xff;
  header[6] = (riffSize >> 16) & 0xff;
  header[7] = (riffSize >> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concat([header, body]), width, height };
}
