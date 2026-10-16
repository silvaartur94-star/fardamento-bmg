// Exporta a base de dados D1 de produção para um ficheiro SQL datado (pasta backups/).
// Requer sessão Wrangler autenticada (wrangler login) com acesso à conta.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('backups', { recursive: true });
const file = `backups/fardamento-bmg-${stamp}.sql`;
execFileSync('npx', ['wrangler', 'd1', 'export', 'fardamento-bmg', '--remote', '--env', 'production', `--output=${file}`], { stdio: 'inherit' });
console.log(`Cópia de segurança criada: ${file}`);
