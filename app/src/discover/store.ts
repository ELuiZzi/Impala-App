import { File, Paths } from 'expo-file-system';
import type { MusicSource, Song } from '@/sources';
import { artistKey, type DiscoverTrack, emptyLearned, type Learned } from './engine';
import { defaultFilters, type Filters } from './filters';
import { songVideoId } from './youtube';

/**
 * Lo que Descubrir guarda en el equipo (discover.json): lo ya mostrado, los «me gusta» y la puntuación de cada
 * artista, más las semillas de la biblioteca ya buscadas en YouTube Music (para no buscarlas cada vez).
 * Nada sale del equipo.
 */
type Saved = Learned & { seedIds: Record<string, string>; filters: Filters };

const FILE = new File(Paths.document, 'discover.json');
let saved: Saved | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function loadLearned(): Saved {
  if (saved) return saved;
  saved = { ...emptyLearned(), seedIds: {}, filters: defaultFilters() };
  try {
    if (FILE.exists) {
      const p = JSON.parse(FILE.textSync()) as Partial<Saved> | null;
      if (p && typeof p === 'object') {
        saved = {
          seen: p.seen && typeof p.seen === 'object' ? p.seen : {},
          likes: Array.isArray(p.likes) ? p.likes.filter((t) => t && typeof t.videoId === 'string') : [],
          artists: p.artists && typeof p.artists === 'object' ? p.artists : {},
          seedIds: p.seedIds && typeof p.seedIds === 'object' ? p.seedIds : {},
          filters: { ...defaultFilters(), ...(p.filters && typeof p.filters === 'object' ? p.filters : {}) },
        };
      }
    }
  } catch {
    // Dañado: se empieza de cero (solo se pierde lo aprendido).
  }
  return saved;
}

/** Guarda lo aprendido (agrupando: como mucho una escritura cada 2 s). */
export function saveLearned(learned: Learned) {
  // Solo estos campos: el motor recibe al empezar el objeto guardado entero, y una copia vieja de los filtros o de
  // las semillas pisaría los cambios hechos después.
  const { seen, likes, artists } = learned;
  saved = { ...loadLearned(), seen, likes, artists };
  scheduleWrite();
}

export const loadFilters = (): Filters => loadLearned().filters;

export function saveFilters(filters: Filters) {
  saved = { ...loadLearned(), filters };
  scheduleWrite();
}

function scheduleWrite() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      FILE.write(JSON.stringify(saved));
    } catch (e) {
      console.warn('No se pudo guardar Descubrir', e);
    }
  }, 2000);
}

/** Olvidar todo lo aprendido (las semillas ya buscadas se conservan). */
export function resetLearned() {
  saveLearned(emptyLearned());
}

const songKey = (artist: string | null | undefined, title: string) =>
  `${artistKey(artist ?? '')}|${title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}`;

/** Índice de canciones de la biblioteca para no ofrecer lo que ya tienes (por artista + título, sin versiones). */
export function ownedIndex(songs: Pick<Song, 'artist' | 'title'>[]): (t: DiscoverTrack) => boolean {
  const keys = new Set(songs.map((s) => songKey(s.artist, s.title)));
  return (t) => keys.has(songKey(t.artist, t.title));
}

/**
 * Semillas de la biblioteca: hasta `max` canciones favoritas y de los álbumes más escuchados, traducidas a su
 * videoId de YouTube Music (se recuerdan para la próxima vez).
 */
export async function librarySeedIds(source: MusicSource, max = 8): Promise<string[]> {
  const data = loadLearned();
  const wanted: { key: string; artist: string | null | undefined; title: string }[] = [];
  const favorites = await source.getFavorites().catch(() => [] as Song[]);
  for (const s of favorites.slice(0, max)) wanted.push({ key: songKey(s.artist, s.title), artist: s.artist, title: s.title });
  if (wanted.length < max) {
    const frequent = await source.getAlbumList('frequent', max - wanted.length).catch(() => []);
    for (const a of frequent) wanted.push({ key: songKey(a.artist, a.name), artist: a.artist, title: a.name });
  }
  // Todas a la vez: una por una tardaba ~1 s por semilla la primera vez.
  const ids = await Promise.all(
    wanted.map(async (w) => {
      let id: string | null = data.seedIds[w.key] ?? null;
      if (!id) {
        id = await songVideoId(w.artist, w.title).catch(() => null);
        if (id) data.seedIds[w.key] = id;
      }
      return id;
    }),
  );
  saveLearned(data);
  return [...new Set(ids.filter((id): id is string => !!id))];
}
