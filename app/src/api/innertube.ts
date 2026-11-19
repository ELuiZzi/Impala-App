/**
 * InnerTube: la API interna con la que las apps de YouTube y YouTube Music hablan con sus servidores.
 * El teléfono la consulta directamente, sin pasar por el servidor de Impala: búsquedas, álbumes y
 * artistas llegan en ~0,5 s, y el audio de las vistas previas se pide desde la IP del propio teléfono
 * (las URLs de googlevideo quedan ligadas a la IP que las pidió). Si YouTube cambia algo y esto
 * falla, la app vuelve a preguntar al servidor, donde yt-dlp y ytmusicapi se actualizan solos.
 *
 * Solo usa fetch: también corre en Node para probarlo contra YouTube.
 */

/** Un cliente de InnerTube: lo que la app de YouTube correspondiente envía como contexto. */
export type InnertubeClient = {
  /** clientName del contexto. */
  name: string;
  /** Su número (cabecera X-YouTube-Client-Name). */
  id: number;
  version: string;
  userAgent: string;
  /** Más campos del contexto (dispositivo, sistema…). */
  context?: Record<string, string | number>;
};

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;

/** "20261011": las versiones de las apps web llevan la fecha; la del día siempre se acepta (como ytmusicapi). */
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** YouTube Music web: búsquedas, álbumes y artistas. */
const webRemix = (): InnertubeClient => ({ name: 'WEB_REMIX', id: 67, version: `1.${today()}.01.00`, userAgent: DESKTOP_UA });
/** YouTube web: búsqueda general de videos. */
const web = (): InnertubeClient => ({ name: 'WEB', id: 1, version: `2.${today()}.00.00`, userAgent: DESKTOP_UA });

/**
 * Cliente para el audio: el de YouTube en Apple Vision (el predeterminado de yt-dlp desde 2026.08). Da
 * URLs de audio directas, sin descifrar firmas ni PO token, también para las pistas de YouTube Music
 * (con ANDROID, IOS o ANDROID_VR esas responden 403). Solo necesita un visitorData.
 */
const VISIONOS: InnertubeClient = {
  name: 'VISIONOS',
  id: 101,
  version: '1.02',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  context: { deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471' },
};

let audioClient = VISIONOS;

/**
 * Cambia el cliente del audio por el que indique el servidor: su yt-dlp se actualiza cada día y sigue
 * a YouTube cuando bloquea un cliente, sin esperar a una nueva versión de la app.
 */
export function setAudioClient(client: InnertubeClient | null) {
  audioClient = client ?? VISIONOS;
}

export class YoutubeError extends Error {}

/** hl: idioma de los textos de la respuesta (por defecto inglés, que es lo que leen los parsers de búsqueda). */
type CallOptions = { host: 'music' | 'www'; client: InnertubeClient; visitorData?: string | null; signal?: AbortSignal; hl?: string };

/** POST a un endpoint de InnerTube; un timeout evita esperar para siempre antes de probar el servidor. */
export async function call(endpoint: string, body: object, { host, client, visitorData, signal, hl = 'en' }: CallOptions): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort);
  try {
    const res = await fetch(`https://${host}.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-YouTube-Client-Name': String(client.id),
        'X-YouTube-Client-Version': client.version,
        Origin: `https://${host}.youtube.com`,
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
      },
      body: JSON.stringify({
        context: {
          client: { clientName: client.name, clientVersion: client.version, ...client.context, hl, ...(visitorData ? { visitorData } : {}) },
          user: {},
        },
        ...body,
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new YoutubeError(json?.error?.message ?? `YouTube respondió HTTP ${res.status}`);
    rememberVisitor(json?.responseContext?.visitorData);
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** YouTube Music (WEB_REMIX). */
export const music = (endpoint: string, body: object, signal?: AbortSignal, hl?: string) =>
  call(endpoint, body, { host: 'music', client: webRemix(), visitorData: visitor, signal, hl });

/** YouTube (WEB). */
export const youtube = (endpoint: string, body: object, signal?: AbortSignal) =>
  call(endpoint, body, { host: 'www', client: web(), visitorData: visitor, signal });

// --- Identidad de visitante ---------------------------------------------------------------------
// visitorData identifica a un visitante anónimo (como la cookie VISITOR_INFO1_LIVE). Sin él, el
// reproductor responde "Sign in to confirm you're not a bot". Se reutiliza el de la primera respuesta,
// así todas las peticiones parecen de la misma persona.

let visitor: string | null = null;
let pendingVisitor: Promise<string> | null = null;

function rememberVisitor(value: unknown) {
  if (!visitor && typeof value === 'string' && value) visitor = value;
}

/**
 * Olvida la identidad actual: la próxima petición consigue otra. YouTube a veces exige PO token a un
 * visitante concreto (su audio da 403 aunque la URL sea buena) y con otro vuelve a funcionar.
 */
export function resetVisitor(): void {
  visitor = null;
}

async function visitorData(fresh: boolean): Promise<string> {
  if (fresh) visitor = null;
  if (visitor) return visitor;
  pendingVisitor ??= call('visitor_id', {}, { host: 'www', client: web() })
    .then((r) => {
      const value = r?.responseContext?.visitorData;
      if (typeof value !== 'string' || !value) throw new YoutubeError('YouTube no dio un visitorData');
      visitor = value;
      return value;
    })
    .finally(() => (pendingVisitor = null));
  return pendingVisitor;
}

/**
 * Consigue el visitorData y abre las conexiones con YouTube antes de que hagan falta: la primera
 * búsqueda o vista previa no paga el DNS ni el TLS (~0,5 s cada host) ni esa petición extra.
 */
export function warmUp(): void {
  visitorData(false).catch(() => {});
  // Las búsquedas van a music.youtube.com: generate_204 abre su conexión sin crear otra identidad.
  fetch('https://music.youtube.com/generate_204').catch(() => {});
}

// --- Audio ---------------------------------------------------------------------------------------

/** contentLength: bytes, si YouTube lo indica; userAgent: el del cliente que la pidió (para descargarla igual). */
export type AudioStream = { url: string; mimeType: string; expiresAt: number; contentLength: number | null; userAgent: string };

/** Lo que el reproductor devuelve de un video, para quien solo necesita los datos (enlaces pegados). */
export type PlayerResponse = { videoDetails?: any; playabilityStatus?: any; streamingData?: any; microformat?: any };

/**
 * La respuesta del reproductor para `videoId`. "Sign in to confirm you're not a bot" depende del
 * visitante: se pide otra identidad y se reintenta una vez.
 */
export async function player(videoId: string, signal?: AbortSignal): Promise<PlayerResponse> {
  for (let attempt = 0; ; attempt++) {
    const vd = await visitorData(attempt > 0);
    const r = await call('player', { videoId, contentCheckOk: true, racyCheckOk: true }, { host: 'www', client: audioClient, visitorData: vd, signal });
    const status = r?.playabilityStatus?.status;
    if (status === 'OK') return r;
    if (status === 'LOGIN_REQUIRED' && attempt === 0) continue;
    throw new YoutubeError(r?.playabilityStatus?.reason ?? `YouTube no permite reproducir este video (${status ?? 'sin respuesta'})`);
  }
}

/**
 * URL del audio de un video, para reproducirla desde el teléfono. m4a primero: el reproductor empieza
 * a sonar antes que con WebM. Caduca a las ~6 h y solo vale para la IP que la pidió.
 */
export async function audioStream(videoId: string, signal?: AbortSignal): Promise<AudioStream> {
  const r = await player(videoId, signal);
  const formats: any[] = (r.streamingData?.adaptiveFormats ?? []).filter((f: any) => typeof f.url === 'string' && String(f.mimeType).startsWith('audio/'));
  const best = (list: any[]) => list.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  const format = formats.find((f) => f.itag === 140) ?? best(formats.filter((f) => String(f.mimeType).startsWith('audio/mp4'))) ?? best(formats);
  if (!format) throw new YoutubeError('YouTube no ofreció audio para este video');
  const expire = Number(/[?&]expire=(\d+)/.exec(format.url)?.[1]);
  const expiresAt = expire ? expire * 1000 : Date.now() + Number(r.streamingData?.expiresInSeconds ?? 3600) * 1000;
  const contentLength = Number(format.contentLength) || null;
  return { url: format.url, mimeType: String(format.mimeType), expiresAt, contentLength, userAgent: audioClient.userAgent };
}
