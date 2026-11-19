import { youtube, YoutubeError } from '@/api/innertube';
import { classifyInput, FeedError, youtubeFeedUrl } from './feeds';

/** A qué se suscribe: un canal de YouTube o el feed RSS de un podcast. */
export type SubscriptionSource =
  | { kind: 'youtube'; channelId: string; feedUrl: string; title: string | null; image: string | null }
  | { kind: 'podcast'; feedUrl: string; title: null; image: null };

const text = (t: any): string => (t?.runs ?? []).map((r: any) => r.text).join('') || t?.simpleText || '';
const biggest = (thumbs: any[] | undefined): string | null => {
  const list = (thumbs ?? []).filter((t) => typeof t?.url === 'string');
  if (!list.length) return null;
  const url: string = list.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url;
  return url.startsWith('//') ? `https:${url}` : url;
};

/** YouTube contestó con un error (no existe…): null. Sin conexión: un error para mostrar. */
const orNotFound = (e: unknown) => {
  if (e instanceof YoutubeError) return null;
  throw new FeedError('Sin conexión con YouTube');
};

/** @usuario, /c/… o /user/… → id del canal (UC…), con la API de YouTube. */
async function channelFromUrl(url: string): Promise<string> {
  const r = await youtube('navigation/resolve_url', { url }).catch(orNotFound);
  const id: string | undefined = r?.endpoint?.browseEndpoint?.browseId;
  if (!id?.startsWith('UC')) throw new FeedError('No se encontró ese canal de YouTube');
  return id;
}

/** El canal que subió un video. */
async function channelFromVideo(videoId: string): Promise<string> {
  const r = await youtube('player', { videoId }).catch(orNotFound);
  const id: string | undefined = r?.videoDetails?.channelId;
  if (!id?.startsWith('UC')) throw new FeedError('No se encontró el canal de ese video');
  return id;
}

/** Canal automático de YouTube Music («Artista - Topic»): solo tiene pistas de audio, ningún video que seguir. */
export const isTopicChannel = (title: string | null | undefined) => !!title && / - (Topic|Tema|Thema|Sujet|Argomento|Tópico)$/i.test(title.trim());

/** Para comparar nombres: sin acentos, mayúsculas ni signos. */
export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * El canal oficial de un artista (el de YouTube Music suele ser el automático, sin videos): el primer canal
 * verificado de la búsqueda cuyo nombre coincida con el del artista. null si no hay uno claro.
 */
export async function officialChannelFor(artist: string): Promise<string | null> {
  const r = await youtube('search', { query: artist, params: 'EgIQAg==' }).catch(() => null);
  const sections = r?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const channels = sections.flatMap((s: any) => (s.itemSectionRenderer?.contents ?? []).map((i: any) => i.channelRenderer).filter(Boolean));
  const want = normalize(artist);
  const matches = (c: any) => {
    const name = normalize(text(c.title));
    return !!name && (name === want || name.startsWith(`${want} `) || want.startsWith(`${name} `));
  };
  const pick =
    channels.find((c: any) => !isTopicChannel(text(c.title)) && c.ownerBadges?.length && matches(c)) ??
    channels.find((c: any) => !isTopicChannel(text(c.title)) && matches(c));
  return pick?.channelId ?? null;
}

/** Nombre y foto del canal (el feed no trae la foto). Si falla, se sigue sin ellos. */
export async function channelInfo(channelId: string): Promise<{ title: string | null; image: string | null }> {
  try {
    const r = await youtube('browse', { browseId: channelId });
    const meta = r?.metadata?.channelMetadataRenderer;
    return { title: meta?.title || text(r?.header?.pageHeaderRenderer?.pageTitle) || null, image: biggest(meta?.avatar?.thumbnails) };
  } catch {
    return { title: null, image: null };
  }
}

/**
 * Lo que pegó el usuario (enlace de canal, de video, @usuario, id UC… o enlace RSS) → la fuente a la que
 * suscribirse. Lanza FeedError con un mensaje para mostrar si no se reconoce.
 */
export async function resolveSource(input: string): Promise<SubscriptionSource> {
  const c = classifyInput(input);
  switch (c.kind) {
    case 'invalid':
      throw new FeedError(c.reason);
    case 'podcast':
      return { kind: 'podcast', feedUrl: c.url, title: null, image: null };
    default: {
      const channelId =
        c.kind === 'youtube-channel' ? c.channelId : c.kind === 'youtube-video' ? await channelFromVideo(c.videoId) : await channelFromUrl(c.url);
      const info = await channelInfo(channelId);
      return { kind: 'youtube', channelId, feedUrl: youtubeFeedUrl(channelId), ...info };
    }
  }
}
