import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, api, availableBucket, createMusician } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminCookie();
});

describe('Fardamento que o músico já tem', () => {
  it('regista peças já na posse do músico, com código, sem mexer no stock disponível', async () => {
    const mid = await createMusician(admin, 'Já Fardado', { instrument: 'Trompa' });
    await api('PUT', `/api/musicians/${mid}/order`, { cookie: admin, body: { items: [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-50', quantity: 1 }] } });
    const req = (await api('GET', `/api/musicians/${mid}`, { cookie: admin })).body.requests[0];
    const before = await availableBucket(admin, 'tipo-casaco');
    const r = await api('POST', '/api/deliveries/existing', {
      cookie: admin,
      body: {
        musicianId: mid,
        items: [
          { itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-50', condition: 'bom', quantity: 1, inscriptions: ['J. Fardado'], requestId: req.id },
          { itemTypeId: 'tipo-gravata', condition: 'razoavel', quantity: 2 },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.garments).toHaveLength(1);
    expect(r.body.garments[0].code).toMatch(/^CAS-/);
    const after = await availableBucket(admin, 'tipo-casaco');
    expect(after.garments.length).toBe(before.garments.length);
    const d = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    expect(d.body.holdings).toHaveLength(1);
    expect(d.body.holdings[0].inscription).toBe('J. Fardado');
    expect(d.body.requests[0].quantity_delivered).toBe(1);
    expect(d.body.deliveries[0].kind).toBe('existente');
    const rt = await api('GET', `/api/musicians/${mid}/returnables`, { cookie: admin });
    expect(rt.body.garments).toHaveLength(1);
    expect(rt.body.deliveryLines[0].outstanding).toBe(2);
    expect((await api('GET', '/api/inventory/consistency', { cookie: admin })).body.ok).toBe(true);

    // Anular o registo: as peças deixam de estar atribuídas e a necessidade volta a ficar pendente.
    expect((await api('POST', `/api/deliveries/lines/${(await api('GET', `/api/deliveries/${r.body.id}`, { cookie: admin })).body.lines[0].id}/cancel`, { cookie: admin, body: { reason: 'teste' } })).status).toBe(409);
    const c = await api('POST', `/api/deliveries/${r.body.id}/cancel`, { cookie: admin, body: { reason: 'Registado no músico errado' } });
    expect(c.status).toBe(200);
    const d2 = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    expect(d2.body.holdings).toHaveLength(0);
    expect(d2.body.requests[0].quantity_delivered).toBe(0);
    const g = await api('GET', `/api/inventory/garments/${r.body.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('rejeitado');
    expect((await api('GET', '/api/inventory/consistency', { cookie: admin })).body.ok).toBe(true);
  });
});
