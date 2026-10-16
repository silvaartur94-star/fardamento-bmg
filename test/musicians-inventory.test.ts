import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { adminCookie, api, availableBucket, createMusician, entry, idemKey } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminCookie();
});

describe('Músicos e necessidades', () => {
  it('cria e edita um músico, preservando acentos e cedilhas', async () => {
    const id = await createMusician(admin, 'João Gonçalves Ribeiro', { internalCode: 'M-001' });
    const r = await api('PATCH', `/api/musicians/${id}`, { cookie: admin, body: { contact: '912 345 678', notes: 'Clarinete' } });
    expect(r.status).toBe(200);
    const d = await api('GET', `/api/musicians/${id}`, { cookie: admin });
    expect(d.body.musician.full_name).toBe('João Gonçalves Ribeiro');
    expect(d.body.musician.contact).toBe('912 345 678');
  });

  it('deteta possíveis duplicados e códigos repetidos', async () => {
    await createMusician(admin, 'Ana Sofia Pereira');
    const dup = await api('POST', '/api/musicians', { cookie: admin, body: { fullName: 'ana sofia  PEREIRA' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIVEL_DUPLICADO');
    const code = await api('POST', '/api/musicians', { cookie: admin, body: { fullName: 'Pessoa Diferente', internalCode: 'm-001', confirmDuplicate: true } });
    expect(code.status).toBe(409);
    expect(code.body.error.code).toBe('CODIGO_DUPLICADO');
  });

  it('regista várias camisas por músico e calcula o que falta', async () => {
    const id = await createMusician(admin, 'Rui Camisas');
    const r = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: id, itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-m', quantity: 3 } });
    expect(r.status).toBe(201);
    const list = await api('GET', `/api/requests?musicianId=${id}&pendingOnly=1`, { cookie: admin });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].quantity_requested).toBe(3);
    expect(list.body.items[0].quantity_missing).toBe(3);
    const again = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: id, itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-m', quantity: 1 } });
    expect(again.status).toBe(409);
  });

  it('regista necessidade de sapatos sem gerar encomenda nem stock', async () => {
    const id = await createMusician(admin, 'Marta Sapatos');
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_movements').first<{ n: number }>();
    const r = await api('POST', '/api/requests', { cookie: admin, body: { musicianId: id, itemTypeId: 'tipo-sapatos', sizeText: '42,5', quantity: 1 } });
    expect(r.status).toBe(201);
    const req = await env.DB.prepare('SELECT * FROM musician_item_requests WHERE id = ?').bind(r.body.id).first<any>();
    expect(req.status).toBe('por_avaliar');
    expect(req.size_text).toBe('42,5');
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_movements').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    const order = await api('PATCH', `/api/requests/${r.body.id}`, { cookie: admin, body: { quantityOrdered: 1 } });
    expect(order.status).toBe(422);
    const summary = await api('GET', '/api/requests/summary', { cookie: admin });
    expect(summary.body.items.some((i: any) => i.item_type_id === 'tipo-sapatos')).toBe(false);
    expect(summary.body.shoes.length).toBeGreaterThan(0);
    const st = await api('PATCH', `/api/requests/${r.body.id}`, { cookie: admin, body: { status: 'confirmada' } });
    expect(st.status).toBe(200);
    const inv = await api('POST', '/api/inventory/entries', { cookie: admin, body: { kind: 'stock_inicial', items: [{ itemTypeId: 'tipo-sapatos', condition: 'novo', quantity: 1 }] } });
    expect(inv.status).toBe(422);
  });
});

describe('Inventário', () => {
  it('regista stock inicial com peças individuais de código único', async () => {
    const r = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-50', condition: 'bom', quantity: 3, inscriptions: ['Joaquim', '', 'Manuel'] }]);
    expect(r.garments).toHaveLength(3);
    const codes = r.garments.map((g) => g.code);
    expect(new Set(codes).size).toBe(3);
    codes.forEach((c) => expect(c).toMatch(/^CAS-\d{5}$/));
    const g = await api('GET', `/api/inventory/garments/${r.garments[0].id}`, { cookie: admin });
    expect(g.body.garment.status).toBe('disponivel');
    expect(g.body.garment.inscription).toBe('Joaquim');
    expect(g.body.movements[0].movement_type).toBe('stock_inicial');
  });

  it('regista quantidades agregadas e distingue estimado de contado', async () => {
    await entry(admin, [
      { itemTypeId: 'tipo-gravata', condition: 'bom', quantity: 10 },
      { itemTypeId: 'tipo-gravata', condition: 'razoavel', quantity: 4, verification: 'estimado' },
    ]);
    const b = await api('GET', '/api/inventory/balances?itemTypeId=tipo-gravata', { cookie: admin });
    const bom = b.body.items.find((x: any) => x.condition === 'bom' && x.status === 'disponivel');
    const raz = b.body.items.find((x: any) => x.condition === 'razoavel');
    expect(bom.quantity).toBeGreaterThanOrEqual(10);
    expect(raz.verification).toBe('estimado');
  });

  it('impede stock negativo', async () => {
    await entry(admin, [{ itemTypeId: 'tipo-cinto', condition: 'bom', quantity: 2 }]);
    const r = await api('POST', '/api/inventory/adjust', {
      cookie: admin,
      body: { itemTypeId: 'tipo-cinto', condition: 'bom', status: 'disponivel', delta: -5, reason: 'teste negativo' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STOCK_INSUFICIENTE');
    const direct = await env.DB.prepare("UPDATE stock_balances SET quantity = -1 WHERE item_type_id = 'tipo-cinto'").run().catch((e) => e);
    expect(String(direct)).toMatch(/CHECK/);
  });

  it('regista receção de artigos novos', async () => {
    const r = await entry(admin, [{ itemTypeId: 'tipo-camisa', sizeId: 'tam-camisa-l', condition: 'novo', quantity: 20 }], 'rececao_nova');
    const m = await api('GET', `/api/stock-movements?operationId=${r.operationId}`, { cookie: admin });
    expect(m.body.items[0].movement_type).toBe('rececao_nova');
    expect(m.body.items[0].quantity).toBe(20);
  });

  it('quarentena, reparação e abate retiram a peça do stock disponível, com histórico', async () => {
    const r = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-52', condition: 'razoavel', quantity: 1 }]);
    const id = r.garments[0].id;
    const t = (body: unknown) => api('POST', `/api/inventory/garments/${id}/transition`, { cookie: admin, body });
    expect((await t({ toStatus: 'quarentena', reason: 'Cheiro a humidade' })).status).toBe(200);
    let av = await availableBucket(admin, 'tipo-casaco', 'tam-casaco-52');
    expect(av.garments.some((g) => g.id === id)).toBe(false);
    expect((await t({ toStatus: 'reparacao', reason: 'Costura' })).status).toBe(200);
    expect((await t({ toStatus: 'disponivel', toCondition: 'bom' })).status).toBe(200);
    av = await availableBucket(admin, 'tipo-casaco', 'tam-casaco-52');
    expect(av.garments.some((g) => g.id === id)).toBe(true);
    expect((await t({ toStatus: 'abatido' })).status).toBe(422); // motivo obrigatório
    expect((await t({ toStatus: 'abatido', reason: 'Rasgado' })).status).toBe(200);
    expect((await t({ toStatus: 'disponivel' })).status).toBe(409); // abatido não volta
    const h = await api('GET', `/api/inventory/garments/${id}`, { cookie: admin });
    expect(h.body.movements.map((m: any) => m.movement_type)).toEqual(['abate', 'regresso_reparacao', 'envio_reparacao', 'quarentena', 'stock_inicial']);
  });

  it('não permite alterar o estado de uma peça sem movimento nem apagar movimentos', async () => {
    const r = await entry(admin, [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 1 }]);
    const upd = await env.DB.prepare("UPDATE garments SET status = 'abatido' WHERE id = ?").bind(r.garments[0].id).run().catch((e) => e);
    expect(String(upd)).toContain('ESTADO_SEM_MOVIMENTO');
    const del = await env.DB.prepare('DELETE FROM stock_movements').run().catch((e) => e);
    expect(String(del)).toContain('MOVIMENTO_IMUTAVEL');
  });

  it('estorno de movimento preserva o original', async () => {
    await entry(admin, [{ itemTypeId: 'tipo-bone', sizeId: 'tam-bone-56', condition: 'bom', quantity: 5 }]);
    const bal = (await availableBucket(admin, 'tipo-bone', 'tam-bone-56')).buckets[0];
    const mv = await api('POST', '/api/inventory/balances/move', { cookie: admin, body: { bucketKey: bal.bucket_key, quantity: 2, toStatus: 'quarentena' } });
    expect(mv.status).toBe(200);
    const rev = await api('POST', `/api/stock-movements/${mv.body.movementId}/reverse`, { cookie: admin, body: { reason: 'Engano' } });
    expect(rev.status).toBe(200);
    const twice = await api('POST', `/api/stock-movements/${mv.body.movementId}/reverse`, { cookie: admin, body: { reason: 'Engano' } });
    expect(twice.status).toBe(409);
    const after = (await availableBucket(admin, 'tipo-bone', 'tam-bone-56')).buckets[0];
    expect(after.quantity).toBe(bal.quantity);
  });

  it('contagem física gera propostas de ajuste confirmadas com motivo', async () => {
    const loc = await api('POST', '/api/locations', { cookie: admin, body: { name: 'Armário da sede' } });
    await entry(admin, [
      { itemTypeId: 'tipo-gravata', condition: 'novo', quantity: 6, locationId: loc.body.id },
      { itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-44', condition: 'bom', quantity: 2, locationId: loc.body.id },
    ]);
    const ic = await api('POST', '/api/inventory/counts', { cookie: admin, body: { name: 'Contagem de teste', locationId: loc.body.id } });
    expect(ic.status).toBe(201);
    const d = await api('GET', `/api/inventory/counts/${ic.body.id}`, { cookie: admin });
    const lines = d.body.lines.map((l: any) => ({ id: l.id, countedQuantity: l.kind === 'quantidade' ? 5 : l.garment_code === d.body.lines.find((x: any) => x.kind === 'peca').garment_code ? 0 : 1 }));
    expect((await api('PUT', `/api/inventory/counts/${ic.body.id}/lines`, { cookie: admin, body: { lines } })).status).toBe(200);
    const p = await api('GET', `/api/inventory/counts/${ic.body.id}/proposals`, { cookie: admin });
    expect(p.body.proposals).toHaveLength(2);
    expect((await api('POST', `/api/inventory/counts/${ic.body.id}/confirm`, { cookie: admin, body: { confirm: true } })).status).toBe(422);
    const ok = await api('POST', `/api/inventory/counts/${ic.body.id}/confirm`, { cookie: admin, body: { confirm: true, reason: 'Contagem anual' } });
    expect(ok.status).toBe(200);
    expect(ok.body.adjustments).toBe(2);
    const b = await api('GET', `/api/inventory/balances?itemTypeId=tipo-gravata&locationId=${loc.body.id}`, { cookie: admin });
    expect(b.body.items[0].quantity).toBe(5);
    const cons = await api('GET', '/api/inventory/consistency', { cookie: admin });
    expect(cons.body.ok).toBe(true);
  });

  it('não permite mudar o modo de gestão de um tipo com stock', async () => {
    const r = await api('PATCH', '/api/item-types/tipo-gravata', { cookie: admin, body: { trackingMode: 'individual' } });
    expect(r.status).toBe(409);
  });

  it('o mesmo pedido repetido (duplo clique) não duplica a entrada', async () => {
    const key = idemKey();
    const body = { kind: 'stock_inicial', items: [{ itemTypeId: 'tipo-cinto', condition: 'novo', quantity: 7 }] };
    const a = await api('POST', '/api/inventory/entries', { cookie: admin, body, headers: { 'Idempotency-Key': key } });
    const b = await api('POST', '/api/inventory/entries', { cookie: admin, body, headers: { 'Idempotency-Key': key } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.operationId).toBe(a.body.operationId);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE operation_id = ?').bind(a.body.operationId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});
