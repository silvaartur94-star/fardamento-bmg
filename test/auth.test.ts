import { describe, expect, it, beforeAll } from 'vitest';
import { ADMIN, SETUP_TOKEN, adminCookie, api, createUser, login } from './helpers';

describe('Inicialização e autenticação', () => {
  it('recusa criar o administrador com código de inicialização errado', async () => {
    const r = await api('POST', '/api/setup/admin', { body: { setupToken: 'errado-errado-errado', ...ADMIN } });
    expect(r.status).toBe(403);
  });

  it('recusa palavra-passe fraca no administrador inicial', async () => {
    const r = await api('POST', '/api/setup/admin', { body: { setupToken: SETUP_TOKEN, ...ADMIN, password: 'curta' } });
    expect(r.status).toBe(422);
  });

  it('cria o primeiro administrador uma única vez', async () => {
    await adminCookie();
    const again = await api('POST', '/api/setup/admin', { body: { setupToken: SETUP_TOKEN, name: 'Outro', email: 'outro@bmg.test', password: 'Outra-Segura-2026' } });
    expect(again.status).toBe(409);
    const st = await api('GET', '/api/setup/status');
    expect(st.body.needsAdmin).toBe(false);
  });

  it('login válido devolve cookie HttpOnly e SameSite=Strict', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
    expect(r.status).toBe(200);
    const set = r.headers.get('Set-Cookie') ?? '';
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).not.toContain(ADMIN.password);
  });

  it('login inválido é recusado sem revelar se o email existe', async () => {
    const a = await api('POST', '/api/auth/login', { body: { email: ADMIN.email, password: 'errada-errada' } });
    const b = await api('POST', '/api/auth/login', { body: { email: 'naoexiste@bmg.test', password: 'errada-errada' } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('limita tentativas falhadas por email', async () => {
    const email = 'limite@bmg.test';
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await api('POST', '/api/auth/login', { body: { email, password: 'x-errada-x' } })).status;
    expect(last).toBe(429);
  });

  it('endpoint protegido sem sessão devolve 401', async () => {
    for (const p of ['/api/musicians', '/api/inventory/garments', '/api/users', '/api/audit', '/api/reports/datasets/inventario/csv', '/api/dashboard']) {
      const r = await api('GET', p);
      expect(r.status, p).toBe(401);
    }
  });

  it('pedido de alteração sem cabeçalho CSRF é recusado', async () => {
    const cookie = await adminCookie();
    const r = await api('POST', '/api/musicians', { cookie, body: { fullName: 'Sem Csrf' }, csrf: false });
    expect(r.status).toBe(403);
    const o = await api('POST', '/api/musicians', { cookie, body: { fullName: 'Origem Estranha' }, headers: { Origin: 'https://malicioso.example' } });
    expect(o.status).toBe(403);
  });

  it('logout termina a sessão', async () => {
    const cookie = await login(ADMIN.email, ADMIN.password);
    expect((await api('GET', '/api/musicians', { cookie })).status).toBe(200);
    expect((await api('POST', '/api/auth/logout', { cookie })).status).toBe(200);
    expect((await api('GET', '/api/musicians', { cookie })).status).toBe(401);
  });
});

describe('Permissões por perfil (verificadas no servidor)', () => {
  let admin: string;
  let gestor: string;
  let consulta: string;
  beforeAll(async () => {
    admin = await adminCookie();
    gestor = await createUser(admin, 'gestor', 'gestor@bmg.test');
    consulta = await createUser(admin, 'consulta', 'consulta@bmg.test');
  });

  it('consulta pode ler mas não modificar nem movimentar stock', async () => {
    expect((await api('GET', '/api/musicians', { cookie: consulta })).status).toBe(200);
    expect((await api('GET', '/api/inventory/garments', { cookie: consulta })).status).toBe(200);
    expect((await api('POST', '/api/musicians', { cookie: consulta, body: { fullName: 'Proibido' } })).status).toBe(403);
    const e = await api('POST', '/api/inventory/entries', {
      cookie: consulta,
      body: { kind: 'stock_inicial', items: [{ itemTypeId: 'tipo-gravata', condition: 'bom', quantity: 1 }] },
    });
    expect(e.status).toBe(403);
    expect((await api('POST', '/api/inventory/adjust', { cookie: consulta, body: {} })).status).toBe(403);
  });

  it('não administradores não acedem à gestão de contas nem à auditoria', async () => {
    for (const c of [gestor, consulta]) {
      expect((await api('GET', '/api/users', { cookie: c })).status).toBe(403);
      expect((await api('POST', '/api/users', { cookie: c, body: { name: 'X', email: 'x@x.pt', role: 'admin', password: 'Abcdefghij1' } })).status).toBe(403);
      expect((await api('GET', '/api/audit', { cookie: c })).status).toBe(403);
      expect((await api('POST', '/api/item-types', { cookie: c, body: {} })).status).toBe(403);
    }
  });

  it('o gestor pode gerir músicos e inventário mas não fazer ajustes administrativos', async () => {
    expect((await api('POST', '/api/musicians', { cookie: gestor, body: { fullName: 'Músico do Gestor' } })).status).toBe(201);
    const adj = await api('POST', '/api/inventory/adjust', {
      cookie: gestor,
      body: { itemTypeId: 'tipo-gravata', condition: 'bom', status: 'disponivel', delta: 1, reason: 'teste' },
    });
    expect(adj.status).toBe(403);
  });

  it('desativar um utilizador revoga as suas sessões', async () => {
    const tmp = await createUser(admin, 'consulta', 'temporario@bmg.test');
    const list = await api('GET', '/api/users', { cookie: admin });
    const u = list.body.items.find((x: any) => x.email === 'temporario@bmg.test');
    expect((await api('PATCH', `/api/users/${u.id}`, { cookie: admin, body: { active: false } })).status).toBe(200);
    expect((await api('GET', '/api/musicians', { cookie: tmp })).status).toBe(401);
  });

  it('redefinição de palavra-passe com ligação de utilização única', async () => {
    await createUser(admin, 'consulta', 'reset@bmg.test');
    const list = await api('GET', '/api/users', { cookie: admin });
    const u = list.body.items.find((x: any) => x.email === 'reset@bmg.test');
    const link = await api('POST', `/api/users/${u.id}/reset-link`, { cookie: admin });
    const token = String(link.body.url).split('#token=')[1];
    expect((await api('POST', '/api/auth/reset-password', { body: { token, newPassword: 'Nova-Palavra-2026' } })).status).toBe(200);
    expect((await api('POST', '/api/auth/reset-password', { body: { token, newPassword: 'Outra-Palavra-2026' } })).status).toBe(422);
    await login('reset@bmg.test', 'Nova-Palavra-2026');
  });

  it('a auditoria regista ações sem guardar palavras-passe', async () => {
    const r = await api('GET', '/api/audit?pageSize=200', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    const text = JSON.stringify(r.body.items);
    expect(text).not.toContain('Utilizador-Seguro-1');
    expect(text).not.toContain(ADMIN.password);
    expect(text).not.toContain('pbkdf2');
  });
});

describe('Recuperação de acesso de administrador', () => {
  it('redefine a palavra-passe do administrador com o SETUP_TOKEN', async () => {
    await adminCookie();
    const bad = await api('POST', '/api/setup/recover', { body: { setupToken: 'codigo-errado-errado', email: ADMIN.email, newPassword: 'Recuperada-2026!' } });
    expect(bad.status).toBe(403);
    const notAdmin = await api('POST', '/api/setup/recover', { body: { setupToken: SETUP_TOKEN, email: 'consulta@bmg.test', newPassword: 'Recuperada-2026!' } });
    expect(notAdmin.status).toBe(403);
    const ok = await api('POST', '/api/setup/recover', { body: { setupToken: SETUP_TOKEN, email: ADMIN.email, newPassword: 'Recuperada-2026!' } });
    expect(ok.status).toBe(200);
    await login(ADMIN.email, 'Recuperada-2026!');
    // repõe a palavra-passe original para os restantes testes
    await api('POST', '/api/setup/recover', { body: { setupToken: SETUP_TOKEN, email: ADMIN.email, newPassword: ADMIN.password } });
  });
});
