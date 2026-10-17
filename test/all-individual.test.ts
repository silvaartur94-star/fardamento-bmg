import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { adminCookie, api, entry } from './helpers';

describe('Artigos com código individual (QR para todas as peças)', () => {
  it('um novo tipo individual gera um código e etiqueta por peça', async () => {
    const admin = await adminCookie();
    const t = await api('POST', '/api/item-types', {
      cookie: admin,
      body: { name: 'Faixa de gala', category: 'Acessórios', codePrefix: 'FXG', hasSize: false, sizeKind: 'livre', allowsInscription: false, trackingMode: 'individual', procurementEnabled: true, stockEnabled: true },
    });
    expect(t.status).toBe(201);
    const e = await entry(admin, [{ itemTypeId: t.body.id, condition: 'novo', quantity: 5 }]);
    expect(e.garments).toHaveLength(5);
    e.garments.forEach((g) => expect(g.code).toMatch(/^FXG-\d{5}$/));
    const r = await api('GET', `/api/reports/labels.pdf?itemTypeId=${t.body.id}`, { cookie: admin, raw: true });
    expect(r.status).toBe(200);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_balances WHERE item_type_id = ?').bind(t.body.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
