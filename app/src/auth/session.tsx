import * as SecureStore from 'expo-secure-store';
import { createContext, use, useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { createSession, type Session } from '@/api/subsonic';
import { setPinScope } from '@/library/pins';

const STORAGE_KEY = 'impala.session';
const MODE_KEY = 'impala.sourceMode';

/** De dónde sale la música: el teléfono o el servidor propio (ver src/sources). */
export type SourceMode = 'local' | 'server';

type AuthState = {
  /** La sesión del servidor guardada; se conserva aunque se use la música del teléfono. */
  session: Session | null;
  /** La fuente activa. Solo es 'server' si hay sesión. */
  mode: SourceMode;
  isLoading: boolean;
  /** Inicia sesión en el servidor y pasa a usarlo. */
  signIn: (server: string, username: string, password: string) => Promise<void>;
  /** Olvida la sesión del servidor y vuelve a la música del teléfono. */
  signOut: () => Promise<void>;
  /** Cambia de fuente sin tocar la sesión guardada. */
  setMode: (mode: SourceMode) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [storedMode, setStoredMode] = useState<SourceMode | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      SecureStore.getItemAsync(STORAGE_KEY).then((raw) => (raw ? (JSON.parse(raw) as Session) : null)).catch(() => null),
      SecureStore.getItemAsync(MODE_KEY).catch(() => null),
    ])
      .then(([stored, mode]) => {
        setSession(stored);
        setStoredMode(mode === 'local' || mode === 'server' ? mode : null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const setMode = useCallback((next: SourceMode) => {
    setStoredMode(next);
    SecureStore.setItemAsync(MODE_KEY, next).catch(() => {});
  }, []);

  const signIn = useCallback(
    async (server: string, username: string, password: string) => {
      const next = await createSession(server, username, password);
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
      setSession(next);
      setMode('server');
    },
    [setMode],
  );

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    setSession(null);
    setMode('local');
  }, [setMode]);

  // Quien actualiza desde la 1.4 tiene sesión y ningún modo guardado: sigue con su servidor. Sin
  // sesión (instalación nueva o tras cerrarla) la app usa la música del teléfono.
  const mode: SourceMode = session && (storedMode ?? 'server') === 'server' ? 'server' : 'local';

  // Las playlists fijadas son de cada fuente (sus ids no se comparten).
  useEffect(() => {
    if (!isLoading) setPinScope(mode);
  }, [isLoading, mode]);

  const value = useMemo(
    () => ({ session, mode, isLoading, signIn, signOut, setMode }),
    [session, mode, isLoading, signIn, signOut, setMode],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
