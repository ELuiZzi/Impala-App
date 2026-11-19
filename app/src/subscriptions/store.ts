import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { type Episode, type FeedKind, FeedError, mergeEpisodes, parseFeed } from './feeds';
import { isTopicChannel, resolveSource } from './resolve';

/** Hasta dónde se escuchó un episodio. */
export type EpisodeProgress = {
  positionMs: number;
  durationMs: number | null;
  /** Escuchado entero (llegó al final o pasó del 95 %): vuelve a empezar desde el principio. */
  done: boolean;
  /** ISO de la última vez que sonó. */
  at: string;
};

/**
 * Suscripciones a canales de YouTube y podcasts, guardadas en el equipo (subscriptions.json en los documentos
 * de la app, como local-library.json). Valen igual en modo local y con servidor: solo guardan feeds y episodios.
 */
export type Subscription = {
  /** «yt:UC…» o «rss:<enlace del feed>». */
  id: string;
  kind: FeedKind;
  feedUrl: string;
  channelId: string | null;
  title: string;
  author: string | null;
  image: string | null;
  /** Página del canal o del podcast. */
  link: string | null;
  /** Fechas ISO. */
  added: string;
  checked: string | null;
  /** Para preguntar «¿ha cambiado?» y no volver a bajar el feed entero (hay feeds de 20 MB). */
  etag: string | null;
  lastModified: string | null;
  /** Último error al actualizar (se ven los episodios que ya había). */
  error: string | null;
  /** Más nuevos primero, como mucho KEEP. */
  episodes: Episode[];
  /** Última vez que se abrió su página (ISO): lo publicado después es «nuevo». */
  lastOpened: string | null;
  /** YouTube: no mostrar los Shorts. */
  hideShorts: boolean;
  /** Por id de episodio. */
  progress: Record<string, EpisodeProgress>;
  /** Descargar solos los N episodios más nuevos sin escuchar (0 = no). */
  autoDownload: number;
  /** Avisar cuando llega un episodio nuevo. */
  notify: boolean;
  /** Episodios descargados en el teléfono (archivo privado de la app), por id de episodio. */
  downloads: Record<string, { uri: string; at: string }>;
};

/** Opciones de «descargar automáticamente». */
export const AUTO_DOWNLOAD_OPTIONS = [0, 1, 3, 5, 10];
const DEFAULT_AUTO_DOWNLOAD = 3;

/** Velocidades para los episodios (sin cambiar el tono). */
export const EPISODE_SPEEDS = [1, 1.25, 1.5, 1.75, 2];

/** Episodios que se guardan por suscripción. */
const KEEP = 100;
/** Sin `force`, no se vuelve a pedir un feed revisado hace menos de esto. */
const MIN_INTERVAL_MS = 15 * 60_000;
const TIMEOUT_MS = 20_000;
/** Feeds que se piden a la vez al actualizar todo. */
const PARALLEL = 3;

const FILE = new File(Paths.document, 'subscriptions.json');
let list: Subscription[] | null = null;
let speed = 1;
/** Descargar episodios solo con Wi-Fi (o una red sin límite de datos). */
let wifiOnly = true;
const listeners = new Set<() => void>();

function load(): Subscription[] {
  if (list) return list;
  list = [];
  try {
    if (FILE.exists) {
      const parsed = JSON.parse(FILE.textSync()) as { subscriptions?: unknown; episodeSpeed?: unknown; wifiOnly?: unknown } | null;
      if (typeof parsed?.episodeSpeed === 'number' && EPISODE_SPEEDS.includes(parsed.episodeSpeed)) speed = parsed.episodeSpeed;
      if (typeof parsed?.wifiOnly === 'boolean') wifiOnly = parsed.wifiOnly;
      if (Array.isArray(parsed?.subscriptions)) {
        list = parsed.subscriptions
          .filter((s): s is Subscription => !!s && typeof s.id === 'string' && typeof s.feedUrl === 'string' && Array.isArray(s.episodes))
          .map((s) => ({
            ...s,
            lastOpened: s.lastOpened ?? s.added ?? null,
            hideShorts: !!s.hideShorts,
            progress: s.progress ?? {},
            autoDownload: typeof s.autoDownload === 'number' ? s.autoDownload : DEFAULT_AUTO_DOWNLOAD,
            notify: s.notify ?? true,
            downloads: s.downloads ?? {},
          }));
      }
    }
  } catch {
    // Archivo dañado: se empieza de cero antes que bloquear la app.
  }
  return list;
}

function save(next: Subscription[]) {
  list = next;
  listeners.forEach((l) => l());
  try {
    FILE.write(JSON.stringify({ version: 1, episodeSpeed: speed, wifiOnly, subscriptions: next }));
  } catch (e) {
    console.warn('No se pudieron guardar las suscripciones', e);
  }
}

function patch(id: string, change: Partial<Subscription>) {
  save(load().map((s) => (s.id === id ? { ...s, ...change } : s)));
}

export const subscriptions = (): Subscription[] => load();
export const subscription = (id: string): Subscription | undefined => load().find((s) => s.id === id);

export function useSubscriptions(): Subscription[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    load,
  );
}

type FetchResult = { notModified: true } | { notModified: false; xml: string; etag: string | null; lastModified: string | null };

/** Pide el feed; con etag/lastModified, el servidor puede contestar 304 (no ha cambiado) sin mandarlo entero. */
async function fetchFeed(url: string, etag: string | null, lastModified: string | null): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        ...(etag ? { 'If-None-Match': etag } : {}),
        ...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
      },
    });
    if (res.status === 304) return { notModified: true };
    if (res.status === 404) throw new FeedError('El feed ya no existe (404)');
    if (!res.ok) throw new FeedError(`El servidor del feed respondió ${res.status}`);
    return { notModified: false, xml: await res.text(), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  } catch (e) {
    if (e instanceof FeedError) throw e;
    throw new FeedError(controller.signal.aborted ? 'El feed tardó demasiado en responder' : 'Sin conexión con el feed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Suscribirse a lo que pegó el usuario (enlace de canal, de video, @usuario o feed de podcast). Si ya estaba
 * suscrito, devuelve esa suscripción. Lanza FeedError con un mensaje para mostrar.
 */
export async function addSubscription(input: string): Promise<Subscription> {
  const source = await resolveSource(input);
  const id = source.kind === 'youtube' ? `yt:${source.channelId}` : `rss:${source.feedUrl}`;
  const existing = subscription(id);
  if (existing) return existing;

  const res = await fetchFeed(source.feedUrl, null, null);
  if (res.notModified) throw new FeedError('El feed no respondió bien');
  const feed = parseFeed(res.xml, KEEP);
  if (source.kind === 'podcast' && feed.kind !== 'podcast') throw new FeedError('Ese enlace no es el feed de un podcast');
  if (!feed.episodes.length && source.kind === 'podcast') throw new FeedError('Ese podcast no tiene episodios con audio');
  if (!feed.episodes.length && (isTopicChannel(feed.title) || isTopicChannel(source.title))) {
    throw new FeedError('Ese es un canal automático de YouTube Music, sin videos: busca el canal oficial del artista');
  }

  const now = new Date().toISOString();
  const sub: Subscription = {
    id,
    kind: feed.kind,
    feedUrl: source.feedUrl,
    channelId: source.kind === 'youtube' ? source.channelId : null,
    // El del feed respeta mayúsculas y minúsculas (el de la ficha del canal a veces va todo en mayúsculas).
    title: feed.title || source.title || 'Suscripción',
    author: feed.author,
    image: source.image ?? feed.image,
    link: feed.link,
    added: now,
    checked: now,
    etag: res.etag,
    lastModified: res.lastModified,
    error: null,
    episodes: feed.episodes,
    // Lo que ya había al suscribirse no cuenta como nuevo.
    lastOpened: now,
    hideShorts: false,
    progress: {},
    autoDownload: DEFAULT_AUTO_DOWNLOAD,
    notify: true,
    downloads: {},
  };
  // Si mientras tanto se añadió la misma (dos toques seguidos), no se duplica.
  if (!subscription(id)) save([...load(), sub]);
  return subscription(id) ?? sub;
}

/** Los episodios que se muestran (sin Shorts si así se eligió). */
export const visibleEpisodes = (s: Subscription): Episode[] => (s.hideShorts ? s.episodes.filter((e) => !e.short) : s.episodes);

/** Publicado después de la última vez que se abrió la suscripción. */
export const isNew = (s: Subscription, e: Episode): boolean => !!e.published && !!s.lastOpened && e.published > s.lastOpened;

export const newCount = (s: Subscription): number => visibleEpisodes(s).filter((e) => isNew(s, e)).length;

/** Al abrir su página: lo que hay deja de ser «nuevo» (la página guarda cuáles lo eran al entrar). */
export function markOpened(id: string) {
  patch(id, { lastOpened: new Date().toISOString() });
}

export function setHideShorts(id: string, hide: boolean) {
  patch(id, { hideShorts: hide });
}

/** Guarda hasta dónde se escuchó un episodio (o lo marca como escuchado / no escuchado). */
export function setProgress(subId: string, episodeId: string, progress: Omit<EpisodeProgress, 'at'> | null) {
  const sub = subscription(subId);
  if (!sub) return;
  const next = { ...sub.progress };
  if (progress) next[episodeId] = { ...progress, at: new Date().toISOString() };
  else delete next[episodeId];
  patch(subId, { progress: next });
}

export const episodeSpeed = () => (load(), speed);

export function useEpisodeSpeed(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    episodeSpeed,
  );
}

export function setEpisodeSpeed(value: number) {
  speed = EPISODE_SPEEDS.includes(value) ? value : 1;
  save(load());
}

export function setAutoDownload(id: string, count: number) {
  patch(id, { autoDownload: AUTO_DOWNLOAD_OPTIONS.includes(count) ? count : DEFAULT_AUTO_DOWNLOAD });
}

export function setNotify(id: string, notify: boolean) {
  patch(id, { notify });
}

/** Anota (o quita, con null) el archivo descargado de un episodio. */
export function setDownload(subId: string, episodeId: string, uri: string | null) {
  const sub = subscription(subId);
  if (!sub) return;
  const next = { ...sub.downloads };
  if (uri) next[episodeId] = { uri, at: new Date().toISOString() };
  else delete next[episodeId];
  patch(subId, { downloads: next });
}

export const downloadWifiOnly = () => (load(), wifiOnly);

export function useDownloadWifiOnly(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    downloadWifiOnly,
  );
}

export function setDownloadWifiOnly(value: boolean) {
  wifiOnly = value;
  save(load());
}

export function removeSubscription(id: string) {
  save(load().filter((s) => s.id !== id));
}

/** Vuelve a leer un feed. Devuelve los ids de los episodios que no se conocían ([] si no cambió o falló). */
export async function refreshSubscription(id: string, { force = false } = {}): Promise<string[]> {
  const sub = subscription(id);
  if (!sub) return [];
  // Si la última vez falló (sin conexión…), se reintenta ya.
  if (!force && !sub.error && sub.checked && Date.now() - Date.parse(sub.checked) < MIN_INTERVAL_MS) return [];
  const checked = new Date().toISOString();
  try {
    const res = await fetchFeed(sub.feedUrl, sub.etag, sub.lastModified);
    if (res.notModified) {
      patch(id, { checked, error: null });
      return [];
    }
    const feed = parseFeed(res.xml, KEEP);
    const known = new Set(sub.episodes.map((e) => e.id));
    const added = feed.episodes.filter((e) => !known.has(e.id)).map((e) => e.id);
    // El que hubiera en el archivo ahora (otra actualización pudo terminar antes).
    const current = subscription(id);
    if (!current) return [];
    patch(id, {
      checked,
      error: null,
      etag: res.etag,
      lastModified: res.lastModified,
      title: current.kind === 'youtube' ? current.title : feed.title || current.title,
      author: feed.author ?? current.author,
      image: current.kind === 'youtube' ? current.image : (feed.image ?? current.image),
      episodes: mergeEpisodes(current.episodes, feed.episodes, KEEP),
    });
    return added;
  } catch (e) {
    patch(id, { checked, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Actualiza todas (de PARALLEL en PARALLEL). Devuelve los episodios nuevos de cada suscripción. */
export async function refreshAll({ force = false } = {}): Promise<Record<string, string[]>> {
  const ids = load().map((s) => s.id);
  const added: Record<string, string[]> = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      added[id] = await refreshSubscription(id, { force });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  return added;
}
