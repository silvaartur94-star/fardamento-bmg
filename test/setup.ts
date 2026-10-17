import { applyD1Migrations, env } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      FILES: R2Bucket;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// A migração 0004 passa todos os artigos a peças individuais. Nos testes, alguns tipos
// voltam ao modo «por quantidade» para que esse modo de gestão continue coberto.
await env.DB.prepare(
  "UPDATE item_types SET tracking_mode = 'quantidade' WHERE id IN ('tipo-calcas', 'tipo-camisa', 'tipo-cinto', 'tipo-bone', 'tipo-gravata') AND tracking_mode = 'individual'",
).run();
