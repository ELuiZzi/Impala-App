import { createHash, timingSafeEqual } from 'node:crypto';

const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const sha256 = (value) => createHash('sha256').update(value).digest();

/**
 * Acepta dos formas de autenticarse:
 * - `Authorization: Bearer <UPLOAD_TOKEN>`: para scripts y curl.
 * - Credenciales Subsonic en la query (`u`, `t`, `s`), las mismas que ya usa la app: se validan
 *   contra Navidrome (`/rest/ping`) por la red interna de Docker, así el teléfono no necesita
 *   ningún secreto adicional. Las válidas se recuerdan 10 minutos.
 */
export function createAuth({ token, navidromeUrl, fetchImpl = fetch }) {
  const expected = sha256(token);
  const validUntil = new Map();

  async function validSubsonic({ u, t, s }) {
    if (typeof u !== 'string' || typeof t !== 'string' || typeof s !== 'string' || !navidromeUrl) return false;
    const key = `${u}\n${t}\n${s}`;
    if ((validUntil.get(key) ?? 0) > Date.now()) return true;

    const params = new URLSearchParams({ u, t, s, v: '1.16.1', c: 'impala-uploader', f: 'json' });
    let body;
    try {
      const res = await fetchImpl(`${navidromeUrl}/rest/ping?${params}`, { signal: AbortSignal.timeout(5000) });
      body = await res.json();
    } catch {
      throw httpError(503, 'No se pudo validar la sesión con Navidrome');
    }
    const ok = body?.['subsonic-response']?.status === 'ok';
    if (ok) {
      if (validUntil.size >= MAX_CACHE_ENTRIES) validUntil.clear();
      validUntil.set(key, Date.now() + CACHE_MS);
    }
    return ok;
  }

  return async (req, _res, next) => {
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (bearer) {
      if (timingSafeEqual(sha256(bearer[1]), expected)) return next();
      throw httpError(401, 'Token inválido');
    }
    if (await validSubsonic(req.query)) return next();
    throw httpError(401, 'Credenciales inválidas');
  };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
