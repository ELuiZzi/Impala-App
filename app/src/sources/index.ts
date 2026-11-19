import { useAuth } from '@/auth/session';
import type { Session } from '@/api/subsonic';
import { localSource } from './local';
import { serverSession, SubsonicSource } from './subsonic';
import type { MusicSource } from './types';

export type * from './types';
export { serverSession };
export { DeleteCancelledError } from './errors';

/** Una instancia por sesión: las pantallas reciben siempre el mismo objeto mientras no cambie. */
let cached: { session: Session; source: SubsonicSource } | null = null;

function serverSource(session: Session): MusicSource {
  if (cached?.session !== session) cached = { session, source: new SubsonicSource(session) };
  return cached.source;
}

/** La fuente activa: el servidor propio si se eligió (y hay sesión) o, si no, la música del teléfono. */
export function useMaybeSource(): MusicSource | null {
  const { session, mode } = useAuth();
  return mode === 'server' && session ? serverSource(session) : localSource;
}

/** Para pantallas protegidas: ahí siempre hay una fuente activa. */
export function useSource(): MusicSource {
  const source = useMaybeSource();
  if (!source) throw new Error('No hay ninguna fuente de música activa');
  return source;
}

/** La sesión del servidor de la fuente activa (YouTube, Apple Music, subir archivos). */
export function useServerSession(): Session {
  return serverSession(useSource());
}

/** Igual, pero null si la fuente activa no es un servidor: las consultas que lo necesitan se desactivan. */
export function useMaybeServerSession(): Session | null {
  return maybeServerSession(useSource());
}

/** La sesión del servidor de una fuente, o null si es la música del equipo (sin lanzar error). */
export const maybeServerSession = (source: MusicSource): Session | null => (source instanceof SubsonicSource ? source.session : null);

/** Clave de React Query de una fuente: [...source.key, ...partes]. */
export const sourceKey = (source: MusicSource, ...parts: unknown[]) => [...source.key, ...parts];
