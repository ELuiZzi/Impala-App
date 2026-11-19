// Cargador para Node: entiende los atajos «@/…» de la app (app/src) y las importaciones sin extensión de .ts.
// Uso: node --import ./tools/node-alias/register.mjs script.mjs   (Node 23.6+ ejecuta .ts directamente)
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../../app/src/', import.meta.url);

export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) spec = new URL(spec.slice(2), SRC).href;
  if ((spec.startsWith('.') || spec.startsWith('file:')) && !/\.\w+$/.test(spec)) {
    const base = spec.startsWith('file:') ? spec : new URL(spec, ctx.parentURL).href;
    if (existsSync(fileURLToPath(`${base}.ts`))) spec = `${base}.ts`;
  }
  return next(spec, ctx);
}
