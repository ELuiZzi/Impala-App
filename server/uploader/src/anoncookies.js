import fs from 'node:fs/promises';

const HOME = 'https://www.youtube.com/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
/** Una identidad anónima se renueva al menos cada tanto, aunque no haya fallado. */
const MAX_AGE_MS = 6 * 60 * 60_000;
/** No se pide otra identidad más de una vez por este intervalo (rotar en bucle también cuenta como abuso). */
const MIN_ROTATE_MS = 60_000;
const TIMEOUT_MS = 15_000;

/**
 * Cookies de una visita anónima a youtube.com (VISITOR_INFO1_LIVE, YSC…), en formato Netscape para
 * yt-dlp. Sin cookies, cada petición de yt-dlp parece un visitante nuevo y sin historial, que es lo
 * que YouTube más limita; con una visita anónima coherente (y renovada cuando YouTube la bloquea) los
 * controles "confirm you're not a bot" son menos frecuentes. No usa ninguna cuenta.
 *
 * El bloqueo HTTP 429 es de la IP: esto no lo evita por sí solo, ayuda junto con el ritmo de descargas.
 */
export function createAnonCookies({ file, fetchImpl = fetch, now = Date.now }) {
  let createdAt = 0;
  let creating = null;

  /** Ruta del archivo listo para --cookies, o null si no se pudo obtener una visita. */
  async function path() {
    if (createdAt && now() - createdAt < MAX_AGE_MS) return file;
    return refresh();
  }

  /** Nueva identidad anónima (tras un control anti-bots). */
  async function rotate() {
    if (createdAt && now() - createdAt < MIN_ROTATE_MS) return file;
    return refresh();
  }

  function refresh() {
    creating ??= (async () => {
      try {
        const res = await fetchImpl(HOME, {
          headers: { 'user-agent': USER_AGENT, 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const cookies = (res.headers.getSetCookie?.() ?? []).map(parseSetCookie).filter(Boolean);
        if (!cookies.some((c) => c.name === 'VISITOR_INFO1_LIVE')) throw new Error('YouTube no devolvió cookies de visitante');
        await fs.writeFile(file, toNetscape(cookies, now()), { mode: 0o600 });
        createdAt = now();
        console.log('youtube: nueva visita anónima');
        return file;
      } catch (err) {
        console.error('youtube: no se pudo crear una visita anónima:', err.message);
        return createdAt ? file : null; // la anterior sigue sirviendo mejor que nada
      } finally {
        creating = null;
      }
    })();
    return creating;
  }

  return { path, rotate };
}

/** "NAME=valor; Domain=.youtube.com; Expires=…; Secure" → { name, value, domain, path, secure, expires } */
export function parseSetCookie(header) {
  const [pair, ...attrs] = String(header).split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: '.youtube.com', path: '/', secure: false, expires: 0 };
  for (const attr of attrs) {
    const [k, ...v] = attr.split('=');
    const key = k.trim().toLowerCase();
    const value = v.join('=').trim();
    if (key === 'domain' && value) cookie.domain = value.startsWith('.') ? value : `.${value}`;
    else if (key === 'path' && value) cookie.path = value;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'expires') cookie.expires = Math.floor((Date.parse(value) || 0) / 1000);
  }
  return cookie;
}

/** Formato cookies.txt de Netscape (el que lee yt-dlp); las caducadas se omiten. */
export function toNetscape(cookies, nowMs) {
  const lines = ['# Netscape HTTP Cookie File', '# Visita anónima generada por Impala (sin cuenta)'];
  for (const c of cookies) {
    if (c.expires && c.expires * 1000 < nowMs) continue;
    lines.push([c.domain, 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE', String(c.expires || 0), c.name, c.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
