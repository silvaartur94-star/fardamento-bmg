import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { adminCookie, api, availableBucket, createMusician, createUser, entry } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminCookie();
});

describe('Eliminar peças do inventário', () => {
  it('elimina peças sem histórico, incluindo os seus movimentos', async () => {
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-62', condition: 'bom', quantity: 2 }]);
    const ids = e.garments.map((g) => g.id);
    await api('POST', `/api/inventory/garments/${ids[0]}/transition`, { cookie: admin, body: { toStatus: 'quarentena', reason: 'teste' } });
    const r = await api('POST', '/api/inventory/garments/delete', { cookie: admin, body: { ids, reason: 'Introduzidas em duplicado' } });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(2);
    expect((await api('GET', `/api/inventory/garments/${ids[0]}`, { cookie: admin })).status).toBe(404);
    const mv = await env.DB.prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE garment_id IN (?, ?)`).bind(ids[0], ids[1]).first<{ n: number }>();
    expect(mv!.n).toBe(0);
    const a = await env.DB.prepare("SELECT summary FROM audit_logs WHERE action = 'inventario.eliminar_pecas' ORDER BY seq DESC LIMIT 1").first<{ summary: string }>();
    expect(a!.summary).toContain('duplicado');
    const auth = await env.DB.prepare('SELECT COUNT(*) AS n FROM purge_authorizations').first<{ n: number }>();
    expect(auth!.n).toBe(0);
    // Sem autorização, continua a não ser possível apagar movimentos diretamente.
    await entry(admin, [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 1 }]);
    const direct = await env.DB.prepare('DELETE FROM stock_movements').run().catch((x) => x);
    expect(String(direct)).toContain('MOVIMENTO_IMUTAVEL');
  });

  it('elimina peças entregues, emprestadas e recolhidas, limpando o histórico', async () => {
    const mid = await createMusician(admin, 'Tem Casaco Apagar');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-62', condition: 'bom', quantity: 4 }]);
    const [g0, g1, g2, g3] = e.garments.map((g) => g.id);
    // g0 entregue (fica atribuída); g1 entregue e depois recolhida; g2 emprestada numa festa; g3 continua entregue noutra linha da mesma entrega.
    const d = await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: g0 }, { itemTypeId: 'tipo-casaco', garmentId: g1 }, { itemTypeId: 'tipo-casaco', garmentId: g3 }] } });
    expect(d.status).toBe(201);
    const ret = await api('POST', '/api/returns', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: g1, observedCondition: 'bom' }] } });
    expect(ret.status).toBe(201);
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Festa Apagar', startDate: '2026-11-21' } });
    const l = await api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: g2 }] } });
    expect(l.status).toBe(201);

    const chk = await api('POST', '/api/inventory/garments/delete-check', { cookie: admin, body: { ids: [g0, g1, g2] } });
    expect(chk.body.items.find((r: any) => r.id === g0).warning).toContain('atribuída');
    expect(chk.body.items.find((r: any) => r.id === g2).warning).toContain('emprestada');

    const r = await api('POST', '/api/inventory/garments/delete', { cookie: admin, body: { ids: [g0, g1, g2], reason: 'Peças que já não existem' } });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(3);
    for (const id of [g0, g1, g2]) expect((await api('GET', `/api/inventory/garments/${id}`, { cookie: admin })).status).toBe(404);
    // A entrega mantém-se com a peça que não foi eliminada.
    const dd = await api('GET', `/api/deliveries/${d.body.id}`, { cookie: admin });
    expect(dd.status).toBe(200);
    expect(dd.body.lines.map((x: any) => x.garment_id)).toEqual([g3]);
    // A recolha mantém o registo do artigo, sem ligação à peça.
    const rd = await api('GET', `/api/returns/${ret.body.id}`, { cookie: admin });
    expect(rd.body.lines).toHaveLength(1);
    expect(rd.body.lines[0].garment_id).toBeNull();
    const ld = await api('GET', `/api/loans/${l.body.id}`, { cookie: admin });
    expect(ld.body.lines ?? []).toHaveLength(0);
    expect((await api('GET', '/api/inventory/consistency', { cookie: admin })).body.ok).toBe(true);
    const auth = await env.DB.prepare('SELECT COUNT(*) AS n FROM purge_authorizations').first<{ n: number }>();
    expect(auth!.n).toBe(0);
  });

  it('apaga a entrega quando todas as suas peças são eliminadas (incl. fardamento que já tinha)', async () => {
    const mid = await createMusician(admin, 'Ja Tinha Apagar');
    const x = await api('POST', '/api/deliveries/existing', { cookie: admin, body: { musicianId: mid, items: [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 2 }] } });
    expect(x.status).toBe(201);
    const r = await api('POST', '/api/inventory/garments/delete', { cookie: admin, body: { ids: x.body.garmentIds, reason: 'Registado por engano' } });
    expect(r.status).toBe(200);
    expect((await api('GET', `/api/deliveries/${x.body.id}`, { cookie: admin })).status).toBe(404);
    expect((await api('GET', '/api/inventory/consistency', { cookie: admin })).body.ok).toBe(true);
  });

  it('o responsável pelo fardamento pode eliminar; a consulta não', async () => {
    const gestor = await createUser(admin, 'gestor', 'gestor-elim-inv@bmg.test');
    const consulta = await createUser(admin, 'consulta', 'consulta-elim-inv@bmg.test');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 2 }]);
    expect((await api('POST', '/api/inventory/garments/delete', { cookie: consulta, body: { ids: [e.garments[0].id], reason: 'teste' } })).status).toBe(403);
    expect((await api('POST', '/api/inventory/garments/delete', { cookie: gestor, body: { ids: [e.garments[0].id], reason: 'teste' } })).status).toBe(200);
  });

  it('elimina muitas peças de uma vez', async () => {
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 150 }]);
    const r = await api('POST', '/api/inventory/garments/delete', { cookie: admin, body: { ids: e.garments.map((g) => g.id), reason: 'Entrada em duplicado' } });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(150);
  });

  it('retira do inventário um lote por quantidade', async () => {
    await entry(admin, [{ itemTypeId: 'tipo-cinto', sizeId: null, condition: 'mau', quantity: 4 }]);
    const b = (await api('GET', '/api/inventory/balances?itemTypeId=tipo-cinto&condition=mau', { cookie: admin })).body.items[0];
    const r = await api('POST', '/api/inventory/balances/remove', { cookie: admin, body: { bucketKey: b.bucket_key, reason: 'Cintos estragados' } });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(b.quantity);
    const after = (await api('GET', '/api/inventory/balances?itemTypeId=tipo-cinto&condition=mau', { cookie: admin })).body.items;
    expect(after).toHaveLength(0);
    expect((await api('GET', '/api/inventory/consistency', { cookie: admin })).body.ok).toBe(true);
  });
});

describe('Telemóvel e lembretes', () => {
  it('guarda o telemóvel (opcional) e valida o formato', async () => {
    const ok = await api('POST', '/api/musicians', { cookie: admin, body: { fullName: 'Com Telemovel', phone: '912 345 678', confirmDuplicate: true } });
    expect(ok.status).toBe(201);
    const none = await api('POST', '/api/musicians', { cookie: admin, body: { fullName: 'Sem Telemovel', confirmDuplicate: true } });
    expect(none.status).toBe(201);
    const bad = await api('POST', '/api/musicians', { cookie: admin, body: { fullName: 'Telemovel Errado', phone: '12ab', confirmDuplicate: true } });
    expect(bad.status).toBe(422);
    const d = await api('GET', `/api/musicians/${ok.body.id}`, { cookie: admin });
    expect(d.body.musician.phone).toBe('912 345 678');
    expect((await api('POST', `/api/musicians/${ok.body.id}/contacted`, { cookie: admin, body: { channel: 'whatsapp', purpose: 'Levantar farda' } })).status).toBe(200);
  });

  it('regista lembretes de devolução de empréstimos', async () => {
    const ev = await api('POST', '/api/events', { cookie: admin, body: { name: 'Festa Lembrete', startDate: '2026-11-20' } });
    const g = await createMusician(admin, 'Convidado Lembrete', { kind: 'convidado', phone: '+351 931 111 222' });
    await entry(admin, [{ itemTypeId: 'tipo-gravata', condition: 'novo', quantity: 1 }]);
    const b = (await availableBucket(admin, 'tipo-gravata')).buckets[0];
    const l = await api('POST', '/api/loans', { cookie: admin, body: { eventId: ev.body.id, musicianId: g, lines: [{ itemTypeId: 'tipo-gravata', bucketKey: b.bucket_key, quantity: 1 }] } });
    expect((await api('POST', `/api/loans/${l.body.id}/reminded`, { cookie: admin, body: { channel: 'sms' } })).status).toBe(200);
    const evd = await api('GET', `/api/events/${ev.body.id}`, { cookie: admin });
    expect(evd.body.loans[0].musician_phone).toBe('+351 931 111 222');
    expect(evd.body.loans[0].reminder_count).toBe(1);
  });
});
