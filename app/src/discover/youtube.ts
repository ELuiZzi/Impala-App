import { music } from '@/api/innertube';
import { searchSongs } from '@/api/ytmusic';
import type { DiscoverTrack } from './engine';

/**
 * Lo que Descubrir pide a YouTube Music (comprobado en la Fase C0, docs/c0-descubrir.md):
 * - la «radio» de una canción (lista RDAMVM<id>): ~50 canciones parecidas por página, 99 % pistas oficiales;
 * - «Ánimo y géneros»: 12 estados de ánimo y ~32 géneros, cada uno con cientos de listas, para explorar.
 * Los parsers son tolerantes: si YouTube cambia algo, devuelven menos canciones en vez de romperse.
 * Se pide en español (HL): así los géneros y estados de ánimo se ven como en la app de YouTube Music en español.
 */
const HL = 'es';

const text = (t: any): string => (t?.runs ?? []).map((r: any) => r.text).join('') || t?.simpleText || '';

function bestThumb(thumbs: any[] | undefined): string | null {
  const url: string | undefined = thumbs?.[thumbs.length - 1]?.url;
  return url ? url.replace(/=w\d+-h\d+/, '=w544-h544') : null;
}

/** «Artista & Otro • Álbum • 2001» → artista(s) y álbum, a partir de los enlaces de cada parte. */
function byline(runs: any[] | undefined): { artist: string; album: string | null } {
  const parts: any[][] = [[]];
  for (const r of runs ?? []) {
    if (r.text === ' • ') parts.push([]);
    else parts[parts.length - 1].push(r);
  }
  const join = (p: any[] | undefined) => (p ?? []).map((r) => r.text).join('').trim();
  const albumPart = parts.find((p) => p.some((r) => String(r.navigationEndpoint?.browseEndpoint?.browseId ?? '').startsWith('MPRE')));
  return { artist: join(parts[0]) || 'Artista desconocido', album: albumPart ? join(albumPart) : null };
}

/** Los elementos de una cola de reproducción («next») de YouTube Music. Solo pistas de audio oficiales (ATV). */
export function parsePanel(contents: any[] | undefined, source: DiscoverTrack['source'], seed?: string): DiscoverTrack[] {
  const out: DiscoverTrack[] = [];
  for (const c of contents ?? []) {
    const v = c.playlistPanelVideoRenderer ?? c.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    if (!v?.videoId) continue;
    const type = v.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
    if (type && type !== 'MUSIC_VIDEO_TYPE_ATV') continue;
    const { artist, album } = byline(v.longBylineText?.runs);
    const length = text(v.lengthText);
    out.push({
      videoId: v.videoId,
      title: text(v.title) || 'Sin título',
      artist,
      album,
      durationSec: length ? length.split(':').reduce((a: number, b: string) => a * 60 + Number(b), 0) || null : null,
      thumbnail: bestThumb(v.thumbnail?.thumbnails) ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      explicit: (v.badges ?? []).some((b: any) => /explicit|explícit/i.test(b.musicInlineBadgeRenderer?.accessibilityData?.accessibilityData?.label ?? '')),
      source,
      seed,
    });
  }
  return out;
}

const panelOf = (r: any) =>
  r?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.musicQueueRenderer?.content?.playlistPanelRenderer;

/** La radio de una canción: su primera página (las siguientes repiten mucho, según la C0). La semilla no se incluye. */
export async function radio(videoId: string, signal?: AbortSignal): Promise<DiscoverTrack[]> {
  const r = await music('next', { videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true }, signal, HL);
  return parsePanel(panelOf(r)?.contents, 'radio', videoId).filter((t) => t.videoId !== videoId);
}

/** Las canciones de una lista de reproducción (las de «Ánimo y géneros»), con el mismo «next». */
async function playlistTracks(playlistId: string, signal?: AbortSignal): Promise<DiscoverTrack[]> {
  const id = playlistId.replace(/^VL/, '');
  const r = await music('next', { playlistId: id, isAudioOnly: true }, signal, HL);
  return parsePanel(panelOf(r)?.contents, 'explore');
}

export type Mood = { name: string; params: string; group: string };

/** «Ánimo y géneros»: cada botón con su nombre y lo que hay que pedir para abrirlo. */
export function parseMoods(r: any): Mood[] {
  const sections = r?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const out: Mood[] = [];
  for (const s of sections) {
    const grid = s.gridRenderer;
    const group = text(grid?.header?.gridHeaderRenderer?.title);
    for (const item of grid?.items ?? []) {
      const b = item.musicNavigationButtonRenderer;
      const params = b?.clickCommand?.browseEndpoint?.params;
      if (params) out.push({ name: text(b.buttonText), params, group });
    }
  }
  return out;
}

export async function moods(signal?: AbortSignal): Promise<Mood[]> {
  return parseMoods(await music('browse', { browseId: 'FEmusic_moods_and_genres' }, signal, HL));
}

/** Las listas de un estado de ánimo o género (ids «VL…» o «RDCLAK…»), en cualquiera de los formatos que usa. */
export function parseMoodPlaylists(r: any): string[] {
  const sections = r?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const ids: string[] = [];
  for (const s of sections) {
    const items = s.gridRenderer?.items ?? s.musicCarouselShelfRenderer?.contents ?? [];
    for (const it of items) {
      const two = it.musicTwoRowItemRenderer;
      const id = two?.navigationEndpoint?.browseEndpoint?.browseId ?? two?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId;
      if (typeof id === 'string' && /^(VL|RD|PL|OLAK)/.test(id)) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/** Canciones de una lista al azar de un estado de ánimo o género (para explorar fuera de lo de siempre). */
/** Las listas de cada estado de ánimo o género (la respuesta pesa ~2 MB: se pide una vez por sesión). */
const moodLists = new Map<string, Promise<string[]>>();
function listsOf(mood: Pick<Mood, 'params'>, signal?: AbortSignal): Promise<string[]> {
  let p = moodLists.get(mood.params);
  if (!p) {
    p = music('browse', { browseId: 'FEmusic_moods_and_genres_category', params: mood.params }, signal, HL).then(parseMoodPlaylists);
    p.catch(() => moodLists.delete(mood.params));
    moodLists.set(mood.params, p);
  }
  return p;
}

export async function moodTracks(mood: Pick<Mood, 'name' | 'params'>, random = Math.random, signal?: AbortSignal): Promise<DiscoverTrack[]> {
  const lists = await listsOf(mood, signal);
  if (!lists.length) return [];
  const pick = lists[Math.floor(random() * lists.length)];
  return (await playlistTracks(pick, signal)).map((t) => ({ ...t, source: 'explore' as const, seed: mood.name }));
}

/** El videoId de una canción de la biblioteca (para usarla como semilla): la primera de la búsqueda de canciones. */
export async function songVideoId(artist: string | null | undefined, title: string, signal?: AbortSignal): Promise<string | null> {
  const results = await searchSongs([artist, title].filter(Boolean).join(' '), signal).catch(() => []);
  return results[0]?.id ?? null;
}
