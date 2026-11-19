/**
 * Motor de Descubrir: decide qué canción viene después. Sin dependencias (corre igual en Node para las pruebas,
 * app/test/discover.test.mjs): lo que necesita de fuera (radios de YouTube Music, exploración, semillas de la
 * biblioteca, qué ya tienes) llega por `EngineDeps`. Lo aprendido (`Learned`) lo guarda store.ts.
 *
 * - Semillas: los «me gusta» de Descubrir (los más recientes primero) y canciones de la biblioteca (favoritas, las
 *   más escuchadas). Cada semilla aporta su radio (~50 canciones parecidas).
 * - Mezcla: se va tomando de las radios por turnos, para que no salgan 10 seguidas del mismo estilo; 1 de cada
 *   EXPLORE_EVERY viene de «Ánimo y géneros» (algo distinto).
 * - Sin repetir: nada de lo ya mostrado (historial en el equipo), ni lo que ya tienes en la biblioteca, ni el mismo
 *   artista dos veces en ARTIST_GAP canciones.
 * - Aprende: «me gusta» → esa canción pasa a ser semilla y su artista sube; pasar antes de SKIP_MS → el artista
 *   baja (y a BAN_SCORE no vuelve a salir); escucharla entera → el artista sube un poco.
 */

export type DiscoverTrack = {
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  thumbnail: string | null;
  explicit: boolean;
  /** De la radio de una semilla o de la exploración (un estado de ánimo / género). */
  source: 'radio' | 'explore';
  /** La semilla (videoId) o el género del que salió. */
  seed?: string;
};

export type Learned = {
  /** videoId → cuándo se mostró (ms). Solo los SEEN_MAX más recientes. */
  seen: Record<string, number>;
  /** «Me gusta», el más reciente primero (como mucho LIKES_MAX): son las mejores semillas. */
  likes: DiscoverTrack[];
  /** Artista (normalizado) → puntuación: sube con «me gusta» y escuchas completas, baja al pasar rápido. */
  artists: Record<string, number>;
};

export type EngineDeps = {
  radio(videoId: string): Promise<DiscoverTrack[]>;
  /** Canciones para explorar (de un género o estado de ánimo distinto a lo habitual). */
  explore(): Promise<DiscoverTrack[]>;
  /** videoIds semilla de la biblioteca (favoritas, más escuchadas); se piden una vez. */
  librarySeeds(): Promise<string[]>;
  /** ¿Ya está en la biblioteca? (no se ofrece de nuevo) */
  owned(track: DiscoverTrack): boolean;
  /** Filtros del usuario (idioma, explícitas): si dice que no, no entra en la cola. */
  allow?(track: DiscoverTrack): boolean;
  /**
   * ¿Usar lo personal como semilla (los «me gusta» y lo ya mostrado)? No con un género elegido: si no, los «me
   * gusta» de otros estilos lo mezclarían todo.
   */
  personal?(): boolean;
  random?: () => number;
  now?: () => number;
};

export type Feedback = 'like' | 'skip' | 'complete';

export const EXPLORE_EVERY = 5;
/** Canciones que se toman de cada exploración: así la siguiente prueba otro género o estado de ánimo. */
export const EXPLORE_BATCH = 4;
export const ARTIST_GAP = 4;
export const SKIP_MS = 5000;
export const BAN_SCORE = -3;
const SEEN_MAX = 5000;
const LIKES_MAX = 50;
const SCORE_MAX = 5;
/** Con menos de esto en las radios cargadas, se pide la de otra semilla. */
const POOL_LOW = 15;
/** Radios que se mezclan como mínimo (si hay semillas), para no empezar con 10 seguidas del mismo estilo. */
const MIN_SEEDS = 3;
/** Intentos de rellenar la cola (cada radio pedida cuenta uno), para no quedarse en bucle sin red. */
const MAX_FETCHES = 6;

export const emptyLearned = (): Learned => ({ seen: {}, likes: [], artists: {} });

/** «Daft Punk & Julian Casablancas» → «daft punk» (el primer artista, sin acentos ni signos). */
export function artistKey(artist: string): string {
  return artist
    .split(/\s*(?:&|,| y | x | feat\.?| ft\.?| con )\s*/i)[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class DiscoverEngine {
  private queue: DiscoverTrack[] = [];
  /** Radios cargadas: semilla → canciones aún sin usar. */
  private pools = new Map<string, DiscoverTrack[]>();
  private exploring: DiscoverTrack[] = [];
  /** Semillas cuya radio ya se pidió en esta sesión. */
  private used = new Set<string>();
  private library: string[] | null = null;
  /** Artistas de lo último mostrado, para no repetir artista seguido. */
  private recentArtists: string[] = [];
  private slot = 0;
  private turn = 0;
  private filling: Promise<void> | null = null;
  /** Sube con cada restart(): lo que un relleno anterior aún traía (con otros filtros) se descarta. */
  private epoch = 0;
  /** No quedan semillas sin usar (hasta que llegue un «me gusta»). */
  private outOfSeeds = false;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly deps: EngineDeps;
  private learned: Learned;

  constructor(deps: EngineDeps, learned: Learned = emptyLearned()) {
    this.deps = deps;
    this.learned = learned;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  /** Lo aprendido, para guardarlo. */
  state(): Learned {
    return this.learned;
  }

  /** Lo que viene (sin sacarlo). */
  upcoming(): DiscoverTrack[] {
    return [...this.queue];
  }

  private score(t: DiscoverTrack) {
    return this.learned.artists[artistKey(t.artist)] ?? 0;
  }

  /** ¿Puede entrar en la cola? */
  private accept(t: DiscoverTrack): boolean {
    if (this.learned.seen[t.videoId] || this.queue.some((q) => q.videoId === t.videoId)) return false;
    if (this.deps.owned(t)) return false;
    if (this.deps.allow && !this.deps.allow(t)) return false;
    const key = artistKey(t.artist);
    const score = this.learned.artists[key] ?? 0;
    if (score <= BAN_SCORE) return false;
    const tail = [...this.recentArtists, ...this.queue.map((q) => artistKey(q.artist))].slice(-(ARTIST_GAP - 1));
    if (tail.includes(key)) return false;
    // Artistas que se suelen pasar: salen menos (no nunca: quizá era solo esa canción).
    if (score < 0 && this.random() < Math.min(0.8, -score * 0.3)) return false;
    return true;
  }

  /** La próxima semilla sin usar: primero los «me gusta», luego la biblioteca, luego lo bien valorado ya mostrado. */
  private async nextSeed(): Promise<string | null> {
    const personal = this.deps.personal?.() ?? true;
    if (personal) for (const like of this.learned.likes) if (!this.used.has(like.videoId)) return like.videoId;
    this.library ??= await this.deps.librarySeeds().catch(() => []);
    const fromLibrary = this.library.filter((id) => !this.used.has(id));
    if (fromLibrary.length) return fromLibrary[Math.floor(this.random() * fromLibrary.length)];
    if (!personal) return null;
    // Encadenar: la radio de algo que ya salió en Descubrir y gustó (o al menos no se pasó).
    const liked = Object.keys(this.learned.seen).filter((id) => !this.used.has(id));
    return liked.length ? liked[Math.floor(this.random() * liked.length)] : null;
  }

  private pooled() {
    let n = 0;
    for (const p of this.pools.values()) n += p.length;
    return n;
  }

  private async loadSeed(): Promise<boolean> {
    const seed = await this.nextSeed();
    if (!seed) {
      this.outOfSeeds = true;
      return false;
    }
    this.used.add(seed);
    const tracks = await this.deps.radio(seed).catch(() => [] as DiscoverTrack[]);
    this.pools.set(seed, tracks.filter((t) => t.videoId !== seed));
    return true;
  }

  /** Saca de las radios por turnos la siguiente canción aceptable (o null). */
  private fromPools(): DiscoverTrack | null {
    const seeds = [...this.pools.keys()].filter((k) => this.pools.get(k)!.length > 0);
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[(this.turn + i) % seeds.length];
      const pool = this.pools.get(seed)!;
      while (pool.length) {
        const t = pool.shift()!;
        if (this.accept(t)) {
          this.turn = (this.turn + i + 1) % Math.max(1, seeds.length);
          return t;
        }
      }
    }
    return null;
  }

  /** Hasta EXPLORE_BATCH canciones al azar de una exploración. */
  private async loadExplore() {
    const all = await this.deps.explore().catch(() => [] as DiscoverTrack[]);
    const picked: DiscoverTrack[] = [];
    while (all.length && picked.length < EXPLORE_BATCH) picked.push(all.splice(Math.floor(this.random() * all.length), 1)[0]);
    this.exploring = picked;
  }

  private fromExplore(): DiscoverTrack | null {
    while (this.exploring.length) {
      const t = this.exploring.splice(Math.floor(this.random() * this.exploring.length), 1)[0];
      if (this.accept(t)) return t;
    }
    return null;
  }

  /** Rellena la cola hasta `target` canciones (pidiendo radios si hace falta). Seguro llamarla varias veces a la vez. */
  fill(target = 10): Promise<void> {
    if (!this.filling) {
      const p: Promise<void> = this.doFill(target).finally(() => {
        if (this.filling === p) this.filling = null;
      });
      this.filling = p;
    }
    return this.filling;
  }

  private async doFill(target: number) {
    let fetches = 0;
    const epoch = this.epoch;
    while (this.queue.length < target && epoch === this.epoch) {
      // Cada EXPLORE_EVERY canciones, una de la exploración.
      const exploreTurn = (this.slot + 1) % EXPLORE_EVERY === 0;
      let pick = exploreTurn ? this.fromExplore() : null;
      if (exploreTurn && !pick && fetches < MAX_FETCHES) {
        fetches++;
        await this.loadExplore();
        pick = this.fromExplore();
      }
      if (!pick) {
        while ((this.pooled() < POOL_LOW || this.pools.size < MIN_SEEDS) && !this.outOfSeeds && fetches < MAX_FETCHES) {
          fetches++;
          await this.loadSeed();
        }
        pick = this.fromPools();
      }
      // Las radios cargadas se agotaron (todo visto o ya en la biblioteca): otra semilla o, si no hay, explorar.
      while (!pick && fetches < MAX_FETCHES) {
        fetches++;
        if (!(await this.loadSeed()) && !this.exploring.length) await this.loadExplore();
        pick = this.fromPools() ?? this.fromExplore();
      }
      if (!pick || epoch !== this.epoch) break;
      this.queue.push(pick);
      this.slot++;
    }
  }

  /** La siguiente canción (y se marca como mostrada). null si no hay más (sin red, sin semillas…). */
  async next(): Promise<DiscoverTrack | null> {
    // Sin nada preparado se espera solo a lo justo (no a llenar la cola entera); el resto se llena después.
    if (!this.queue.length) await this.fill(3);
    const t = this.queue.shift() ?? null;
    if (t) this.markSeen(t);
    void this.fill();
    return t;
  }

  private markSeen(t: DiscoverTrack) {
    this.learned.seen[t.videoId] = this.now();
    this.recentArtists = [...this.recentArtists, artistKey(t.artist)].slice(-ARTIST_GAP);
    const ids = Object.keys(this.learned.seen);
    if (ids.length > SEEN_MAX) {
      const keep = ids.sort((a, b) => this.learned.seen[b] - this.learned.seen[a]).slice(0, SEEN_MAX);
      this.learned.seen = Object.fromEntries(keep.map((id) => [id, this.learned.seen[id]]));
    }
  }

  private bump(t: DiscoverTrack, delta: number) {
    const key = artistKey(t.artist);
    const next = Math.max(-SCORE_MAX, Math.min(SCORE_MAX, (this.learned.artists[key] ?? 0) + delta));
    this.learned = { ...this.learned, artists: { ...this.learned.artists, [key]: next } };
  }

  /** Lo que hizo el usuario con una canción. `listenedMs` decide si «pasar» fue rápido. */
  feedback(t: DiscoverTrack, kind: Feedback, listenedMs = 0) {
    if (kind === 'like') {
      this.learned = { ...this.learned, likes: [t, ...this.learned.likes.filter((l) => l.videoId !== t.videoId)].slice(0, LIKES_MAX) };
      this.bump(t, 2);
      // Su radio entra pronto: se libera para pedirla en la próxima recarga.
      this.used.delete(t.videoId);
      this.outOfSeeds = false;
    } else if (kind === 'skip') {
      if (listenedMs < SKIP_MS) this.bump(t, -1);
    } else {
      this.bump(t, 1);
    }
    // Lo que ya está en la cola de un artista recién vetado sale de ella.
    if (this.score(t) <= BAN_SCORE) {
      const key = artistKey(t.artist);
      this.queue = this.queue.filter((q) => artistKey(q.artist) !== key);
    }
  }

  /** Olvidar todo lo aprendido (Ajustes → reiniciar Descubrir). */
  reset() {
    this.learned = emptyLearned();
    this.recentArtists = [];
    this.restart();
  }

  /** Empezar de nuevo con lo aprendido (cambiaron los filtros o el género): se tira lo preparado. */
  restart() {
    this.epoch++;
    this.filling = null;
    this.library = null;
    this.queue = [];
    this.pools.clear();
    this.exploring = [];
    this.used.clear();
    // recentArtists se conserva: lo que acaba de sonar sigue sin repetirse.
    this.slot = 0;
    this.outOfSeeds = false;
  }
}
