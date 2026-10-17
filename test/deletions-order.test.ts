import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { adminCookie, api, availableBucket, createMusician, createUser, entry } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminCookie();
});

describe('Pedido de fardamento e medidas', () => {
  it('regista o pedido completo num só passo e atualiza-o depois', async () => {
    const mid = await createMusician(admin, 'Pedido Completo');
    const r = await api('PUT', `/api/musicians/${mid}/order`, {
      cookie: admin,
      body: {
        items: [
          { itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-52', quantity: 1, returnExpected: 1 },
          { itemTypeId: 'tipo-calcas', sizeId: 'tam-calcas-44', quantity: 2, returnExpected: 1 },
          { itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-l', quantity: 3, returnExpected: 2 },
          { itemTypeId: 'tipo-sapatos', sizeText: '43', quantity: 1 },
          { itemTypeId: 'tipo-gravata', quantity: 0 },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.changes).toBe(4);
    const d = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    expect(d.body.requests).toHaveLength(4);
    const shirt = d.body.requests.find((x: any) => x.item_type_id === 'tipo-camisa');
    const shoes = d.body.requests.find((x: any) => x.item_type_id === 'tipo-sapatos');
    expect(shoes.status).toBe('por_avaliar');
    expect(shoes.return_expected).toBe(0);
    const coat = d.body.requests.find((x: any) => x.item_type_id === 'tipo-casaco');
    const u = await api('PUT', `/api/musicians/${mid}/order`, {
      cookie: admin,
      body: { items: [{ requestId: shirt.id, itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-xl', quantity: 4, returnExpected: 2 }, { requestId: coat.id, itemTypeId: 'tipo-casaco', quantity: 0 }] },
    });
    expect(u.status).toBe(200);
    const d2 = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    expect(d2.body.requests).toHaveLength(3);
    expect(d2.body.requests.find((x: any) => x.id === shirt.id).quantity_requested).toBe(4);
  });

  it('não remove um pedido com entregas registadas', async () => {
    const mid = await createMusician(admin, 'Pedido Entregue');
    await api('PUT', `/api/musicians/${mid}/order`, { cookie: admin, body: { items: [{ itemTypeId: 'tipo-cinto', quantity: 1 }] } });
    const req = (await api('GET', `/api/musicians/${mid}`, { cookie: admin })).body.requests[0];
    await entry(admin, [{ itemTypeId: 'tipo-cinto', condition: 'novo', quantity: 1 }]);
    const b = (await availableBucket(admin, 'tipo-cinto')).buckets[0];
    await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-cinto', bucketKey: b.bucket_key, quantity: 1, requestId: req.id }] } });
    const r = await api('PUT', `/api/musicians/${mid}/order`, { cookie: admin, body: { items: [{ requestId: req.id, itemTypeId: 'tipo-cinto', quantity: 0 }] } });
    expect(r.status).toBe(409);
    expect((await api('DELETE', `/api/requests/${req.id}`, { cookie: admin })).status).toBe(409);
  });

  it('guarda as medidas do músico', async () => {
    const mid = await createMusician(admin, 'Medidas Músico');
    const r = await api('PUT', `/api/musicians/${mid}/measurements`, { cookie: admin, body: { heightCm: 178, chestCm: 102, waistCm: 88, inseamCm: 81, shoeSize: '43', notes: 'Prefere calça mais larga' } });
    expect(r.status).toBe(200);
    const d = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    expect(d.body.measurements.chest_cm).toBe(102);
    expect(d.body.measurements.shoe_size).toBe('43');
  });
});

describe('Eliminações e anulações', () => {
  it('elimina um músico sem histórico, mas não um com entregas', async () => {
    const mid = await createMusician(admin, 'Para Eliminar');
    await api('PUT', `/api/musicians/${mid}/order`, { cookie: admin, body: { items: [{ itemTypeId: 'tipo-gravata', quantity: 1 }] } });
    expect((await api('DELETE', `/api/musicians/${mid}`, { cookie: admin })).status).toBe(200);
    expect((await api('GET', `/api/musicians/${mid}`, { cookie: admin })).status).toBe(404);

    const mid2 = await createMusician(admin, 'Com Historico');
    await entry(admin, [{ itemTypeId: 'tipo-gravata', condition: 'novo', quantity: 2 }]);
    const b = (await availableBucket(admin, 'tipo-gravata')).buckets[0];
    await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid2, lines: [{ itemTypeId: 'tipo-gravata', bucketKey: b.bucket_key, quantity: 1 }] } });
    const r = await api('DELETE', `/api/musicians/${mid2}`, { cookie: admin });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('COM_HISTORICO');
  });

  it('o perfil de consulta não pode eliminar', async () => {
    const consulta = await createUser(admin, 'consulta', 'consulta-elim@bmg.test');
    const mid = await createMusician(admin, 'Protegido');
    expect((await api('DELETE', `/api/musicians/${mid}`, { cookie: consulta })).status).toBe(403);
  });

  it('elimina tipo, tamanho e localização sem uso; recusa quando estão em uso', async () => {
    const t = await api('POST', '/api/item-types', { cookie: admin, body: { name: 'Faixa', category: 'Acessórios', codePrefix: 'FAI', hasSize: true, sizeKind: 'livre', allowsInscription: false, trackingMode: 'quantidade', procurementEnabled: true, stockEnabled: true } });
    const s = await api('POST', `/api/item-types/${t.body.id}/sizes`, { cookie: admin, body: { label: 'Única' } });
    expect((await api('DELETE', `/api/item-types/${t.body.id}/sizes/${s.body.id}`, { cookie: admin })).status).toBe(200);
    expect((await api('DELETE', `/api/item-types/${t.body.id}`, { cookie: admin })).status).toBe(200);
    expect((await api('DELETE', '/api/item-types/tipo-gravata', { cookie: admin })).status).toBe(409);
    const loc = await api('POST', '/api/locations', { cookie: admin, body: { name: 'Local temporário' } });
    expect((await api('DELETE', `/api/locations/${loc.body.id}`, { cookie: admin })).status).toBe(200);
    const used = await api('POST', '/api/locations', { cookie: admin, body: { name: 'Local usado' } });
    await entry(admin, [{ itemTypeId: 'tipo-cinto', condition: 'bom', quantity: 1, locationId: used.body.id }]);
    expect((await api('DELETE', `/api/locations/${used.body.id}`, { cookie: admin })).status).toBe(409);
  });

  it('anula uma entrega completa e o stock regressa', async () => {
    const mid = await createMusician(admin, 'Entrega Anulada');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-58', condition: 'novo', quantity: 1 }]);
    const d = await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id }] } });
    const r = await api('POST', `/api/deliveries/${d.body.id}/cancel`, { cookie: admin, body: { reason: 'Músico errado' } });
    expect(r.status).toBe(200);
    const g = await api('GET', `/api/inventory/garments/${e.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('disponivel');
    expect((await api('GET', `/api/deliveries/${d.body.id}`, { cookie: admin })).body.delivery.status).toBe('anulada');
  });

  it('anula um empréstimo sem devoluções e elimina a festa vazia', async () => {
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Festa por engano', startDate: '2026-11-01' } });
    const g = await createMusician(admin, 'Convidado Anulado', { kind: 'convidado' });
    await entry(admin, [{ itemTypeId: 'tipo-bone', sizeId: 'tam-bone-57', condition: 'bom', quantity: 3 }]);
    const b = (await availableBucket(admin, 'tipo-bone', 'tam-bone-57')).buckets[0];
    const l = await api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: g, lines: [{ itemTypeId: 'tipo-bone', bucketKey: b.bucket_key, quantity: 2 }] } });
    expect((await api('DELETE', `/api/events/${ev.body.id}`, { cookie: admin })).status).toBe(409);
    expect((await api('POST', `/api/loans/${l.body.id}/cancel`, { cookie: admin, body: { reason: 'Registado por engano' } })).status).toBe(200);
    expect((await availableBucket(admin, 'tipo-bone', 'tam-bone-57')).buckets[0].quantity).toBe(b.quantity);
    expect((await api('DELETE', `/api/events/${ev.body.id}`, { cookie: admin })).status).toBe(200);
    const cons = await api('GET', '/api/inventory/consistency', { cookie: admin });
    expect(cons.body.ok).toBe(true);
  });

  it('anula uma recolha antes da inspeção: a peça volta ao músico', async () => {
    const mid = await createMusician(admin, 'Recolha Anulada');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-60', condition: 'novo', quantity: 1 }]);
    await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id }] } });
    const r = await api('POST', '/api/returns', {
      cookie: admin,
      body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id, observedCondition: 'bom' }, { itemTypeId: 'tipo-casaco', observedCondition: 'mau' }] },
    });
    const det = await api('GET', `/api/returns/${r.body.id}`, { cookie: admin });
    const created = det.body.lines.find((x: any) => x.garment_id !== e.garments[0].id).garment_id;
    expect((await api('POST', `/api/returns/${r.body.id}/cancel`, { cookie: admin, body: { reason: 'Registo duplicado' } })).status).toBe(200);
    const g = await api('GET', `/api/inventory/garments/${e.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('atribuido');
    expect(g.body.garment.holder_musician_id).toBe(mid);
    const c2 = await api('GET', `/api/inventory/garments/${created}`, { cookie: admin });
    expect(c2.body.garment.status).toBe('rejeitado');
    const rt = await api('GET', `/api/musicians/${mid}/returnables`, { cookie: admin });
    expect(rt.body.garments).toHaveLength(1);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM garment_returns WHERE id = ?').bind(r.body.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
    const cons = await api('GET', '/api/inventory/consistency', { cookie: admin });
    expect(cons.body.ok).toBe(true);
  });
});
