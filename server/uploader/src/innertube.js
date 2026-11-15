/**
 * InnerTube desde el servidor: lo mismo que hace el teléfono en modo local (app/src/api/innertube.ts).
 * Una sola petición al reproductor con un cliente "sin JavaScript" (el que indica yt-dlp, o VISIONOS)
 * da las URLs directas del audio y los datos del video en ~1 s, frente a los ~30 s de la extracción
 * completa de yt-dlp (varios clientes, PO token, retos JS). Si YouTube cambia algo, quien llama vuelve
 * a yt-dlp, que se actualiza cada día.
 */

const TIMEOUT_MS = 12_000;
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** El de yt-dlp desde 2026.08: URLs de audio directas, sin firmas ni PO token, también para YouTube Music. */
export const VISIONOS = {
  name: 'VISIONOS',
  id: 101,
  version: '1.02',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  context: { deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471' },
};

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const web = () => ({ name: 'WEB', id: 1, version: `2.${today()}.00.00`, userAgent: WEB_UA });

export class InnertubeError extends Error {}

/**
 * clientFor: () => Promise<cliente | null> (el de yt-dlp; null → VISIONOS).
 */
export function createInnertube({ fetchImpl = fetch, clientFor = async () => null } = {}) {
  let visitor = null;
  let pendingVisitor = null;

  async function call(endpoint, body, client, visitorData) {
    const res = await fetchImpl(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': client.userAgent,
        'x-youtube-client-name': String(client.id),
        'x-youtube-client-version': client.version,
        origin: 'https://www.youtube.com',
        ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
      },
      body: JSON.stringify({
        context: { client: { clientName: client.name, clientVersion: client.version, hl: 'en', ...client.context, ...(visitorData ? { visitorData } : {}) }, user: {} },
        ...body,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new InnertubeError(json?.error?.message ?? `YouTube respondió HTTP ${res.status}`);
    return json;
  }

  async function visitorData(fresh) {
    if (fresh) visitor = null;
    if (visitor) return visitor;
    pendingVisitor ??= call('visitor_id', {}, web())
      .then((r) => {
        const value = r?.responseContext?.visitorData;
        if (typeof value !== 'string' || !value) throw new InnertubeError('YouTube no dio un visitorData');
        visitor = value;
        return value;
      })
      .finally(() => (pendingVisitor = null));
    return pendingVisitor;
  }

  /** La respuesta del reproductor; "Sign in to confirm…" depende del visitante: se reintenta con otro. */
  async function player(videoId) {
    const client = (await clientFor().catch(() => null)) ?? VISIONOS;
    for (let attempt = 0; ; attempt++) {
      const vd = await visitorData(attempt > 0);
      const r = await call('player', { videoId, contentCheckOk: true, racyCheckOk: true }, client, vd);
      const status = r?.playabilityStatus?.status;
      if (status === 'OK') return { response: r, userAgent: client.userAgent };
      if (status === 'LOGIN_REQUIRED' && attempt === 0) continue;
      throw new InnertubeError(r?.playabilityStatus?.reason ?? `YouTube no permite este video (${status ?? 'sin respuesta'})`);
    }
  }

  /**
   * Datos del video con el formato de yt-dlp (lo justo para `--load-info-json`, tagsFor y los tags):
   * yt-dlp ya no extrae nada, solo descarga por tramos y post-procesa (audio, tags, carátula).
   */
  async function info(videoId) {
    const { response: r, userAgent } = await player(videoId);
    const details = r.videoDetails ?? {};
    const micro = r.microformat?.playerMicroformatRenderer ?? {};
    const headers = { 'User-Agent': userAgent };
    const formats = (r.streamingData?.adaptiveFormats ?? [])
      .filter((f) => typeof f.url === 'string' && String(f.mimeType).startsWith('audio/'))
      .map((f) => audioFormat(f, headers));
    if (formats.length === 0) throw new InnertubeError('YouTube no ofreció audio directo para este video');
    const duration = Number(details.lengthSeconds) || null;
    const thumbnails = thumbnailsFor(videoId);
    const date = String(micro.publishDate ?? micro.uploadDate ?? '').slice(0, 10).replace(/-/g, '');
    const live = details.isLiveContent && (details.isLive || details.isUpcoming) ? (details.isUpcoming ? 'is_upcoming' : 'is_live') : 'not_live';
    const result = {
      id: videoId,
      title: details.title ?? null,
      fulltitle: details.title ?? null,
      channel: details.author ?? null,
      uploader: details.author ?? null,
      channel_id: details.channelId ?? null,
      duration,
      view_count: Number(details.viewCount) || null,
      live_status: live,
      upload_date: /^\d{8}$/.test(date) ? date : null,
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      original_url: `https://www.youtube.com/watch?v=${videoId}`,
      webpage_url_basename: 'watch',
      webpage_url_domain: 'youtube.com',
      extractor: 'youtube',
      extractor_key: 'Youtube',
      thumbnails,
      formats,
      _type: 'video',
      ...musicMetadata(details.shortDescription),
    };
    return result;
  }

  /** La URL del mejor audio m4a (como el teléfono), para las vistas previas. */
  async function audioStream(videoId) {
    const i = await info(videoId);
    const format = i.formats.find((f) => f.format_id === '140') ?? i.formats.filter((f) => f.ext === 'm4a').sort((a, b) => b.abr - a.abr)[0] ?? i.formats[0];
    return { url: format.url, headers: format.http_headers, mimeType: format.mime_type };
  }

  return { info, audioStream, resetVisitor: () => (visitor = null) };
}

/**
 * Las miniaturas estándar de i.ytimg.com, de peor a mejor (como las lista yt-dlp; si la mejor no existe,
 * prueba la siguiente). WebP primero: al convertirla a JPEG se le aplica el recorte a cuadrado.
 */
const THUMB_NAMES = ['default', 'mqdefault', 'hqdefault', 'sddefault', 'hq720', 'maxresdefault'];
export function thumbnailsFor(videoId) {
  return THUMB_NAMES.flatMap((name, i) => [
    { id: `${name}-jpg`, url: `https://i.ytimg.com/vi/${videoId}/${name}.jpg`, preference: i * 2 - 20 },
    { id: `${name}-webp`, url: `https://i.ytimg.com/vi_webp/${videoId}/${name}.webp`, preference: i * 2 - 19 },
  ]);
}

function audioFormat(f, headers) {
  const mime = String(f.mimeType);
  const codecs = /codecs="([^"]+)"/.exec(mime)?.[1] ?? null;
  const ext = mime.startsWith('audio/mp4') ? 'm4a' : 'webm';
  return {
    format_id: String(f.itag),
    url: f.url,
    ext,
    audio_ext: ext,
    video_ext: 'none',
    acodec: codecs ?? (ext === 'm4a' ? 'mp4a.40.2' : 'opus'),
    vcodec: 'none',
    abr: (f.averageBitrate ?? f.bitrate ?? 0) / 1000,
    tbr: (f.averageBitrate ?? f.bitrate ?? 0) / 1000,
    asr: Number(f.audioSampleRate) || null,
    audio_channels: f.audioChannels ?? null,
    filesize: Number(f.contentLength) || null,
    protocol: 'https',
    mime_type: mime,
    http_headers: headers,
    // Por tramos de 10 MB, como hace yt-dlp con YouTube: el archivo entero lo frenan a velocidad de reproducción.
    downloader_options: { http_chunk_size: 10 * 1024 * 1024 },
  };
}

/**
 * Las pistas de YouTube Music ("Auto-generated by YouTube") describen pista, artistas y álbum en la
 * descripción; yt-dlp los saca igual (track/artists/album/release_year).
 */
export function musicMetadata(description) {
  const text = String(description ?? '');
  if (!/Auto-generated by YouTube\.\s*$/.test(text)) return {};
  const m = /(?<track>[^·\n]+)·(?<artist>[^\n]+)\n+(?<album>[^\n]+)(?:[\s\S]+?℗\s*(?<year>\d{4})(?!\d))?/.exec(text);
  if (!m) return {};
  const artists = m.groups.artist.split(' · ').map((a) => a.trim()).filter(Boolean);
  const year = m.groups.year ? Number(m.groups.year) : null;
  return {
    track: m.groups.track.trim(),
    artists,
    artist: artists.join(', '),
    album: m.groups.album.trim(),
    ...(year ? { release_year: year } : {}),
  };
}
