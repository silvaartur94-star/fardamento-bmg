// Arranque de desenvolvimento: API (wrangler dev, porta 8787) + frontend (Vite, porta 5173, com proxy de /api).
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
