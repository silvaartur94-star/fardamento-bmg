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

  it('não elimina peças entregues a músicos (tudo ou nada)', async () => {
    const mid = await createMusician(admin, 'Tem Casaco');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', sizeId: 'tam-casaco-62', condition: 'bom', quantity: 2 }]);
    await api('POST', '/api/deliveries', { cookie: admin, body: { musicianId: mid, lines: [{ itemTypeId: 'tipo-casaco', garmentId: e.garments[0].id }] } });
    const r = await api('POST', '/api/inventory/garments/delete', { cookie: admin, body: { ids: e.garments.map((g) => g.id), reason: 'teste' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PECAS_COM_HISTORICO');
    expect((await api('GET', `/api/inventory/garments/${e.garments[1].id}`, { cookie: admin })).status).toBe(200);
  });

  it('só administradores podem eliminar', async () => {
    const gestor = await createUser(admin, 'gestor', 'gestor-elim-inv@bmg.test');
    const e = await entry(admin, [{ itemTypeId: 'tipo-casaco', condition: 'bom', quantity: 1 }]);
    expect((await api('POST', '/api/inventory/garments/delete', { cookie: gestor, body: { ids: [e.garments[0].id], reason: 'teste' } })).status).toBe(403);
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
