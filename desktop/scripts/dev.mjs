// `npm run dev`: arranca Metro (la app web de ../app), espera a que responda y abre la ventana de Tauri.
// tauri dev solo espera 180 s a su beforeDevCommand y, en Windows sin watchman, el primer arranque de
// Metro puede tardar más. Si ya hay un Metro en el puerto, se reutiliza.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEV_URL = 'http://localhost:8081';
const appDir = fileURLToPath(new URL('../../app', import.meta.url));
const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const children = [];

const run = (cmd, args, cwd) => {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true });
  children.push(child);
  return child;
};

async function responds() {
  try {
    return (await fetch(DEV_URL, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

// `npm run dev -- --clear`: Metro sin caché (en Windows, sin watchman, a veces sirve un archivo viejo).
const clear = process.argv.includes('--clear') ? ['--clear'] : [];

if (!(await responds())) {
  run('npx', ['expo', 'start', '--web', '--port', '8081', ...clear], appDir);
  const deadline = Date.now() + 15 * 60_000;
  while (!(await responds())) {
    if (Date.now() > deadline) throw new Error(`Metro no respondió en ${DEV_URL}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const tauri = run('npx', ['tauri', 'dev'], desktopDir);
tauri.on('exit', (code) => {
  for (const child of children) child.kill();
  process.exit(code ?? 0);
});
