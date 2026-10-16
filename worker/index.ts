import { Hono } from 'hono';
import type { AppEnv } from './env';
import { ApiError, uuid } from './lib/core';
import { csrfGuard, loadSession, requireAuth } from './auth/session';
import { authRoutes, setupRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { itemTypeRoutes, locationRoutes, settingsRoutes } from './routes/reference';
import { musicianRoutes } from './routes/musicians';
import { requestRoutes } from './routes/requests';
import { deliveryRoutes } from './routes/deliveries';
import { returnRoutes } from './routes/returns';
import { inventoryRoutes } from './routes/inventory';
import { auditRoutes, incidentRoutes, movementRoutes } from './routes/movements';
import { campaignRoutes, eventRoutes } from './routes/events';
import { loanRoutes } from './routes/loans';
import { attachmentRoutes } from './routes/attachments';
import { dashboardRoutes } from './routes/dashboard';
import { reportRoutes } from './routes/reports';

const app = new Hono<AppEnv>();

// Cabeçalhos de segurança e identificador de correlação em todas as respostas da API.
app.use('/api/*', async (c, next) => {
  c.set('requestId', c.req.header('CF-Ray') ?? uuid());
  await next();
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  if (!c.res.headers.get('Content-Security-Policy')) c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  if (c.env.ENVIRONMENT === 'production') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

app.use('/api/*', csrfGuard);
app.use('/api/*', loadSession);

app.get('/api/health', (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));
app.route('/api/auth', authRoutes);
app.route('/api/setup', setupRoutes);

// A partir daqui, todos os endpoints exigem sessão iniciada (e permissões específicas em cada rota).
app.use('/api/*', requireAuth);
app.route('/api/users', userRoutes);
app.route('/api/item-types', itemTypeRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/musicians', musicianRoutes);
app.route('/api/requests', requestRoutes);
app.route('/api/deliveries', deliveryRoutes);
app.route('/api/returns', returnRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/stock-movements', movementRoutes);
app.route('/api/incidents', incidentRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api/campaigns', campaignRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/loans', loanRoutes);
app.route('/api/attachments', attachmentRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/reports', reportRoutes);

app.all('/api/*', () => {
  throw new ApiError(404, 'NAO_ENCONTRADO', 'Recurso inexistente.');
});

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  // Nunca devolver detalhes internos ao cliente; registar apenas o essencial.
  console.error(JSON.stringify({ requestId: c.get('requestId'), path: new URL(c.req.url).pathname, error: err instanceof Error ? err.message : String(err) }));
  return c.json({ error: { code: 'ERRO_INTERNO', message: 'Ocorreu um erro inesperado. Tente novamente; se persistir, contacte o administrador.', requestId: c.get('requestId') } }, 500);
});

// Pedidos que não são da API: servir a aplicação (SPA) a partir dos ficheiros estáticos.
app.all('*', async (c) => {
  if (!c.env.ASSETS) return c.text('Not found', 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
