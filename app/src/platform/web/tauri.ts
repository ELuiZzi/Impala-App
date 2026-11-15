/**
 * Puente con la parte en Rust de la app de PC (desktop/src-tauri). Fuera de la ventana de Tauri (la app
 * web abierta en un navegador, para desarrollar) no existe y los sustitutos usan localStorage.
 */
type TauriInternals = { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };

function internals(): TauriInternals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

export const isTauri = (): boolean => internals() !== undefined;

export function invoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = internals();
  if (!tauri) return Promise.reject(new Error(`Solo disponible en la app de PC (${cmd})`));
  return tauri.invoke<T>(cmd, args);
}
