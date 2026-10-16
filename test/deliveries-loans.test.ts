import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { adminCookie, api, availableBucket, createMusician, entry, idemKey } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminCookie();
});

describe('Entregas e recolhas', () => {
  it('entrega peças a um músico, atualiza stock, ficha e necessidade', async () => {
    const mid = await createMusician(admin, 'Carlos Entregas');
    const reqC = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: mid, itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-48', quantity: 1, returnExpected: 1 } });
    const reqS = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: mid, itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-s', quantity: 3 } });
    const e = await entry(admin, [
      { itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-48', condition: 'novo', quantity: 1, inscriptions: ['Carlos'] },
      { itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-s', condition: 'novo', quantity: 5 },
    ]);
    const bucket = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-s')).buckets[0];
    const d = await api('POST', '/api/deliveries', {
      cookie: admin,
      headers: { 'Idempotency-Key': idemKey() },
      body: {
        musicianId: mid,
        lines: [
          { itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id, requestId: reqC.body.id },
          { itemTypeId: 'tipo-camisa', bucketKey: bucket.bucket_key, quantity: 2, requestId: reqS.body.id },
        ],
      },
    });
    expect(d.status).toBe(201);
    const g = await api('GET', `/api/inventory/garments/${e.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('atribuido');
    expect(g.body.garment.holder_musician_id).toBe(mid);
    const after = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-s')).buckets[0];
    expect(after.quantity).toBe(bucket.quantity - 2);
    const m = await api('GET', `/api/musicians/${mid}`, { cookie: admin });
    const shirt = m.body.requests.find((r: any) => r.item_type_id === 'tipo-camisa');
    expect(shirt.quantity_delivered).toBe(2);
    expect(shirt.quantity_missing).toBe(1);
    expect(shirt.progress).toBe('parcial');
    expect(m.body.holdings).toHaveLength(1);
  });

  it('impede entregas superiores ao stock disponível ou à necessidade', async () => {
    const mid = await createMusician(admin, 'Teresa Excesso');
    await entry(admin, [{ itemTypeId: 'tipo-bone', sizeId: 'tam-bone-60', condition: 'novo', quantity: 2 }]);
    const bucket = (await availableBucket(admin, 'tipo-bone', 'tam-bone-60')).buckets[0];
    const r = await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-bone', bucketKey: bucket.bucket_key, quantity: 3 }] } });
    expect(r.status).toBe(409);
    const req = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: mid, itemTypeId: 'tipo-bone', sizeId: 'tam-bone-60', quantity: 1 } });
    const r2 = await api('POST', '/api/deliveries', {
      cookie: admin,
      body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-bone', bucketKey: bucket.bucket_key, quantity: 2, requestId: req.body.id }] },
    });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('ENTREGA_EXCEDE_NECESSIDADE');
    // Nada foi movimentado (operação atómica).
    expect((await availableBucket(admin, 'tipo-bone', 'tam-bone-60')).buckets[0].quantity).toBe(2);
  });

  it('recebe fardamento antigo sem o tornar disponível; inspeção decide o destino', async () => {
    const mid = await createMusician(admin, 'Paulo Antigo');
    const loc = await api('POST', '/api/locations', { cookie: admin, body: { name: 'Sala de inspeção' } });
    const r = await api('POST', '/api/returns', {
      cookie: admin,
      headers: { 'Idempotency-Key': idemKey() },
      body: {
        musicianId: mid,
        initialObservations: 'Entregue num saco',
        lines: [
          { itemTypeId: 'tipo-casaco', sizeText: '50', inscription: 'P. Antigo', observedCondition: 'bom', locationId: loc.body.id },
          { itemTypeId: 'tipo-casaco', observedCondition: 'mau', locationId: loc.body.id },
          { itemTypeId: 'tipo-casaco', observedCondition: 'razoavel', locationId: loc.body.id },
          { itemTypeId: 'tipo-gravata', quantity: 2, observedCondition: 'inutilizavel', locationId: loc.body.id },
        ],
      },
    });
    expect(r.status).toBe(201);
    const det = await api('GET', `/api/returns/${r.body.id}`, { cookie: admin });
    expect(det.body.lines).toHaveLength(4);
    for (const l of det.body.lines.filter((x: any) => x.garment_id)) expect(l.garment_status).toBe('pendente_inspecao');
    const av = await availableBucket(admin, 'tipo-casaco');
    expect(av.garments.some((g: any) => det.body.lines.some((l: any) => l.garment_id === g.id))).toBe(false);

    const [good, bad, mid2] = det.body.lines.filter((x: any) => x.garment_id);
    const tie = det.body.lines.find((x: any) => !x.garment_id);
    const insp = await api('POST', `/api/returns/${r.body.id}/lines/${good.id}/inspect`, {
      cookie: admin,
      body: { inspectedCondition: 'bom', inspectionResult: 'Sem defeitos', proposedDestination: 'disponivel' },
    });
    expect(insp.status).toBe(200);
    // Peça em mau estado não pode ser reintegrada.
    const refused = await api('POST', `/api/returns/${r.body.id}/decisions`, { cookie: admin, body: { decisions: [{ lineId: bad.id, destination: 'disponivel' }] } });
    expect(refused.status).toBe(422);
    const dec = await api('POST', `/api/returns/${r.body.id}/decisions`, {
      cookie: admin,
      headers: { 'Idempotency-Key': idemKey() },
      body: {
        decisions: [
          { lineId: good.id, destination: 'disponivel' },
          { lineId: bad.id, destination: 'reparacao', inspectionResult: 'Botões em falta' },
          { lineId: mid2.id, destination: 'quarentena' },
          { lineId: tie.id, destination: 'abatido', inspectionResult: 'Manchas permanentes' },
        ],
      },
    });
    expect(dec.status).toBe(200);
    const final = await api('GET', `/api/returns/${r.body.id}`, { cookie: admin });
    expect(final.body.return.inspection_status).toBe('concluida');
    const statuses = Object.fromEntries(final.body.lines.map((l: any) => [l.id, l.garment_status]));
    expect(statuses[good.id]).toBe('disponivel');
    expect(statuses[bad.id]).toBe('reparacao');
    expect(statuses[mid2.id]).toBe('quarentena');
    const again = await api('POST', `/api/returns/${r.body.id}/decisions`, { cookie: admin, body: { decisions: [{ lineId: good.id, destination: 'abatido', inspectionResult: 'x' }] } });
    expect(again.status).toBe(409);
    const ab = await env.DB.prepare("SELECT quantity FROM stock_balances WHERE item_type_id = 'tipo-gravata' AND status = 'abatido'").first<{ quantity: number }>();
    expect(ab!.quantity).toBeGreaterThanOrEqual(2);
  });

  it('associa a devolução à peça atribuída anteriormente', async () => {
    const mid = await createMusician(admin, 'Sónia Associação');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-46', condition: 'novo', quantity: 1 }]);
    await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id }] } });
    const rt = await api('GET', `/api/musicians/${mid}/returnables`, { cookie: admin });
    expect(rt.body.garments[0].id).toBe(e.garments[0].id);
    const r = await api('POST', '/api/returns', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id, observedCondition: 'bom' }] } });
    expect(r.status).toBe(201);
    const g = await api('GET', `/api/inventory/garments/${e.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('pendente_inspecao');
    expect(g.body.garment.holder_musician_id).toBeNull();
  });
});

describe('Festas, campanhas e empréstimos', () => {
  let eventA: string;
  let campaign: string;
  beforeAll(async () => {
    const c = await api('POST', '/api/campaigns', { cookie: admin, body: { name: 'Festas de verão 2026', startDate: '2026-07-01', endDate: '2026-09-15' } });
    campaign = c.body.id;
    const a = await api('POST', '/api/events', { cookie: admin, body: { campaignId: campaign, name: 'Festa de São João', startDate: '2026-07-10' } });
    await api('POST', '/api/events', { cookie: admin, body: { campaignId: campaign, name: 'Festa da Senhora da Hora', startDate: '2026-08-15' } });
    eventA = a.body.id;
    await entry(admin, [
      { itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-54', condition: 'bom', quantity: 3 },
      { itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-xl', condition: 'bom', quantity: 10 },
    ]);
  });

  it('cria uma campanha com várias festas', async () => {
    const r = await api('GET', `/api/campaigns/${campaign}`, { cookie: admin });
    expect(r.body.events).toHaveLength(2);
  });

  it('empresta peças a vários músicos, devolve parcialmente e mantém pendências', async () => {
    const av = await availableBucket(admin, 'tipo-casaco', 'tam-casaco-54');
    const shirts = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-xl')).buckets[0];
    const l1 = await api('POST', '/api/loans', {
      cookie: admin,
      headers: { 'Idempotency-Key': idemKey() },
      body: {
        eventId: eventA,
        newMusician: { fullName: 'Convidado Trompete', kind: 'convidado', originBand: 'Banda de Ermesinde', confirmDuplicate: true },
        dueDate: '2026-07-12',
        lines: [
          { itemTypeId: 'tipo-casaco', garmentId: av.garments[0].id },
          { itemTypeId: 'tipo-camisa', bucketKey: shirts.bucket_key, quantity: 2 },
        ],
      },
    });
    expect(l1.status).toBe(201);
    const guest2 = await createMusician(admin, 'Convidado Tuba', { kind: 'convidado' });
    const l2 = await api('POST', '/api/loans', { cookie: admin, body: { eventId: eventA, musicianId: guest2, lines: [{ itemTypeId: 'tipo-casaco', garmentId: av.garments[1].id }] } });
    expect(l2.status).toBe(201);

    // Peça emprestada não aparece como disponível nem pode ser emprestada outra vez.
    const av2 = await availableBucket(admin, 'tipo-casaco', 'tam-casaco-54');
    expect(av2.garments.some((g: any) => g.id === av.garments[0].id)).toBe(false);
    const dup = await api('POST', '/api/loans', { cookie: admin, body: { eventId: eventA, musicianId: guest2, lines: [{ itemTypeId: 'tipo-casaco', garmentId: av.garments[0].id }] } });
    expect(dup.status).toBe(409);

    const det = await api('GET', `/api/loans/${l1.body.id}`, { cookie: admin });
    const shirtLine = det.body.lines.find((l: any) => l.item_type_id === 'tipo-camisa');
    const coatLine = det.body.lines.find((l: any) => l.item_type_id === 'tipo-casaco');
    const p1 = await api('POST', `/api/loans/${l1.body.id}/returns`, { cookie: admin, body: { returns: [{ lineId: shirtLine.id, quantity: 1, condition: 'bom' }] } });
    expect(p1.status).toBe(200);
    const over = await api('POST', `/api/loans/${l1.body.id}/returns`, { cookie: admin, body: { returns: [{ lineId: shirtLine.id, quantity: 2, condition: 'bom' }] } });
    expect(over.status).toBe(409);
    const damaged = await api('POST', `/api/loans/${l1.body.id}/returns`, { cookie: admin, body: { returns: [{ lineId: coatLine.id, quantity: 1, condition: 'mau', damaged: true, notes: 'Manga rasgada' }] } });
    expect(damaged.status).toBe(200);
    const coat = await api('GET', `/api/inventory/garments/${av.garments[0].id}`, { cookie: admin });
    expect(coat.body.garment.status).toBe('pendente_inspecao');
    const forced = await api('POST', `/api/loans/${l1.body.id}/returns`, { cookie: admin, body: { returns: [{ lineId: shirtLine.id, quantity: 1, condition: 'mau', destination: 'disponivel' }] } });
    expect(forced.status).toBe(422);

    const ev = await api('GET', `/api/events/${eventA}`, { cookie: admin });
    expect(ev.body.reconciliation.totals).toMatchObject({ lent: 4, returned: 2, pending: 2, damaged: 1 });
    expect(ev.body.reconciliation.byMusician).toHaveLength(2);

    const close = await api('POST', `/api/events/${eventA}/close`, { cookie: admin, body: {} });
    expect(close.status).toBe(409);
    expect(close.body.error.code).toBe('PENDENCIAS');
    const close2 = await api('POST', `/api/events/${eventA}/close`, { cookie: admin, body: { confirmPending: true, notes: 'Contactar convidados' } });
    expect(close2.status).toBe(200);
    const evc = await api('GET', `/api/events/${eventA}`, { cookie: admin });
    expect(evc.body.event.closed_with_pending).toBe(1);
    const pend = await api('GET', '/api/loans?state=pendentes', { cookie: admin });
    expect(pend.body.total).toBeGreaterThanOrEqual(2);
    const cons = await api('GET', '/api/inventory/consistency', { cookie: admin });
    expect(cons.body.ok).toBe(true);
  });

  it('dois empréstimos simultâneos da mesma peça: apenas um tem sucesso', async () => {
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Procissão', startDate: '2026-09-01' } });
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-56', condition: 'bom', quantity: 1 }]);
    const g1 = await createMusician(admin, 'Concorrente Um', { kind: 'convidado' });
    const g2 = await createMusician(admin, 'Concorrente Dois', { kind: 'convidado' });
    const send = (m: string) => api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: m, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id }] } });
    const [a, b] = await Promise.all([send(g1), send(g2)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM loan_lines WHERE garment_id = ?').bind(e.garments[0].id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('pedido repetido de empréstimo com a mesma chave não duplica', async () => {
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Arraial', startDate: '2026-09-05' } });
    const g = await createMusician(admin, 'Convidado Repetido', { kind: 'convidado' });
    const b = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-xl')).buckets[0];
    const key = idemKey();
    const body = { eventId: ev.body.id, musicianId: g, lines: [{ itemTypeId: 'tipo-camisa', bucketKey: b.bucket_key, quantity: 1 }] };
    const [x, y] = [await api('POST', '/api/loans', { cookie: admin, body, headers: { 'Idempotency-Key': key } }), await api('POST', '/api/loans', { cookie: admin, body, headers: { 'Idempotency-Key': key } })];
    expect(x.status).toBe(201);
    expect(y.body.id).toBe(x.body.id);
    const after = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-xl')).buckets[0];
    expect(after.quantity).toBe(b.quantity - 1);
  });

  it('entrega e empresta lotes com localização (chave de lote longa)', async () => {
    const loc = await api('POST', '/api/locations', { cookie: admin, body: { name: 'Armário com nome comprido para teste' } });
    await entry(admin, [{ itemTypeId: 'tipo-gravata', condition: 'novo', quantity: 3, locationId: loc.body.id }]);
    const b = (await availableBucket(admin, 'tipo-gravata')).buckets.find((x: any) => x.location_id === loc.body.id);
    expect(b.bucket_key.length).toBeGreaterThan(64);
    const mid = await createMusician(admin, 'Lote Longo');
    const d = await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-gravata', bucketKey: b.bucket_key, quantity: 1 }] } });
    expect(d.status).toBe(201);
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Festa Lote', startDate: '2026-09-20' } });
    const l = await api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: mid, lines: [{ itemTypeId: 'tipo-gravata', bucketKey: b.bucket_key, quantity: 1 }] } });
    expect(l.status).toBe(201);
  });

  it('regista perda de peça emprestada', async () => {
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Festa da Perda', startDate: '2026-09-10' } });
    const g = await createMusician(admin, 'Convidado Perda', { kind: 'convidado' });
    const b = (await availableBucket(admin, 'tipo-camisa', 'tam-camisa-xl')).buckets[0];
    const l = await api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: g, lines: [{ itemTypeId: 'tipo-camisa', bucketKey: b.bucket_key, quantity: 2 }] } });
    const det = await api('GET', `/api/loans/${l.body.id}`, { cookie: admin });
    const r = await api('POST', `/api/loans/${l.body.id}/lines/${det.body.lines[0].id}/lost`, { cookie: admin, body: { quantity: 1, reason: 'Não devolvida' } });
    expect(r.status).toBe(200);
    const after = await api('GET', `/api/loans/${l.body.id}`, { cookie: admin });
    expect(after.body.lines[0].pending_quantity).toBe(1);
    expect(after.body.lines[0].lost_quantity).toBe(1);
  });
});
