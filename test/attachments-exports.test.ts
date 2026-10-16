import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { adminCookie, api, createMusician, createUser, entry } from './helpers';
import { JPEG_WITH_EXIF_B64, PNG_B64, b64 } from './fixtures';

let admin: string;
let consulta: string;
let garmentId: string;
beforeAll(async () => {
  admin = await adminCookie();
  consulta = await createUser(admin, 'consulta', 'consulta-anexos@bmg.test');
  const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-50', condition: 'bom', quantity: 2, inscriptions: ['=HYPERLINK("http://x")', 'Inês Simões'] }]);
  garmentId = e.garments[0].id;
  await entry(admin, [{ itemTypeId: 'tipo-gravata', condition: 'novo', quantity: 4 }]);
  await createMusician(admin, 'Exportação Músico');
});

function form(bytes: Uint8Array, name: string, type: string, entityId = garmentId) {
  const fd = new FormData();
  fd.set('entityType', 'garment');
  fd.set('entityId', entityId);
  fd.set('caption', 'Frente do casaco');
  fd.set('file', new File([bytes], name, { type }));
  return fd;
}

describe('Fotografias e anexos', () => {
  it('carrega uma fotografia, remove o EXIF e guarda-a no R2 privado', async () => {
    const r = await api('POST', '/api/attachments', { cookie: admin, body: form(b64(JPEG_WITH_EXIF_B64), 'foto.jpg', 'image/jpeg') });
    expect(r.status).toBe(201);
    const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(r.body.id).first<any>();
    expect(row.r2_key).toMatch(/^anexos\/garment\//);
    expect(row.width).toBe(40);
    const obj = await env.FILES.get(row.r2_key);
    const bytes = new Uint8Array(await obj!.arrayBuffer());
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('CameraSecreta');
    const dl = await api('GET', `/api/attachments/${r.body.id}/file`, { cookie: consulta, raw: true });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('image/jpeg');
    expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(dl.headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  it('rejeita ficheiros que não são imagens, mesmo com extensão de imagem', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    const r = await api('POST', '/api/attachments', { cookie: admin, body: form(html, 'foto.png', 'image/png') });
    expect(r.status).toBe(415);
    const empty = await api('POST', '/api/attachments', { cookie: admin, body: form(new Uint8Array(), 'x.png', 'image/png') });
    expect(empty.status).toBe(422);
  });

  it('não permite descarregar anexos sem sessão nem carregar com perfil de consulta', async () => {
    const r = await api('POST', '/api/attachments', { cookie: admin, body: form(b64(PNG_B64), 'p.png', 'image/png') });
    expect(r.status).toBe(201);
    expect((await api('GET', `/api/attachments/${r.body.id}/file`, { raw: true })).status).toBe(401);
    expect((await api('POST', '/api/attachments', { cookie: consulta, body: form(b64(PNG_B64), 'p.png', 'image/png') })).status).toBe(403);
    expect((await api('DELETE', `/api/attachments/${r.body.id}`, { cookie: consulta })).status).toBe(403);
    expect((await api('DELETE', `/api/attachments/${r.body.id}`, { cookie: admin })).status).toBe(200);
    expect((await api('GET', `/api/attachments/${r.body.id}/file`, { cookie: admin, raw: true })).status).toBe(404);
  });
});

describe('Exportações', () => {
  it('CSV: UTF-8 com BOM, separador ;, acentos e proteção contra fórmulas', async () => {
    const r = await api('GET', '/api/reports/datasets/inventario/csv?itemTypeId=tipo-casaco', { cookie: consulta, raw: true });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Disposition')).toMatch(/attachment; filename="inventario-geral-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await r.raw.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.trim().split('\r\n');
    expect(lines[0].split(';')[0]).toBe('"Gestão"');
    expect(text).toContain('Inês Simões');
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(text).not.toContain('Gravata'); // filtro respeitado
    expect(lines.every((l) => l.split('";"').length === lines[0].split('";"').length)).toBe(true);
  });

  it('XLSX: ficheiro Excel válido com folhas, cabeçalhos e filtros', async () => {
    const r = await api('GET', '/api/reports/workbook.xlsx', { cookie: admin, raw: true });
    expect(r.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await r.raw.arrayBuffer()));
    expect(Object.keys(zip)).toContain('[Content_Types].xml');
    const wb = strFromU8(zip['xl/workbook.xml']);
    expect(wb).toContain('Inventário geral');
    expect(wb).toContain('Pendências de devolução');
    const sheet1 = strFromU8(zip['xl/worksheets/sheet1.xml']);
    expect(sheet1).toContain('<autoFilter');
    expect(sheet1).toContain('Inês Simões');
    expect(sheet1).not.toContain('<f>');
  });

  it('PDF: documentos legíveis (relatórios, ficha de músico e etiquetas QR)', async () => {
    const musicians = await api('GET', '/api/musicians?q=Exportação', { cookie: admin });
    const urls = [
      '/api/reports/datasets/stock-tipo-tamanho/pdf',
      '/api/reports/datasets/pendencias/pdf',
      `/api/reports/pdf/musician/${musicians.body.items[0].id}`,
      `/api/reports/labels.pdf?ids=${garmentId}`,
    ];
    for (const u of urls) {
      const r = await api('GET', u, { cookie: admin, raw: true });
      expect(r.status, u).toBe(200);
      const bytes = new Uint8Array(await r.raw.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBeGreaterThan(0);
    }
  });

  it('exportações exigem sessão e ficam auditadas', async () => {
    expect((await api('GET', '/api/reports/datasets/musicos/csv', { raw: true })).status).toBe(401);
    expect((await api('GET', '/api/reports/datasets/desconhecido/csv', { cookie: admin })).status).toBe(404);
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'exportacao'").first<{ n: number }>();
    expect(a!.n).toBeGreaterThan(0);
  });

  it('painel e alertas resultam de dados reais', async () => {
    const d = await api('GET', '/api/dashboard', { cookie: consulta });
    expect(d.status).toBe(200);
    expect(d.body.byStatus.disponivel).toBeGreaterThan(0);
    const a = await api('GET', '/api/dashboard/alerts', { cookie: consulta });
    expect(Array.isArray(a.body.items)).toBe(true);
  });
});
