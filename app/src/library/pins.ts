import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * Playlists fijadas en la parte de arriba de la Biblioteca, en el orden en que se fijaron (o en el
 * que el usuario las colocó arrastrándolas).
 * FAVORITES_PIN representa "Canciones Favoritas" (su id no se conoce hasta crearla en el servidor):
 * está fijada por defecto, pero se puede quitar como cualquier otra.
 */
export const FAVORITES_PIN = 'favorites';

// Cada fuente de música tiene sus fijadas y sus acciones: el servidor conserva las claves de la 1.4 y
// el teléfono usa las suyas. AuthProvider cambia el ámbito al cambiar de fuente.
type Scope = 'server' | 'local';
let scope: Scope = 'server';
const scoped = (key: string) => (scope === 'local' ? `${key}.local` : key);

/** Cambia a las fijadas de otra fuente; se recargan la próxima vez que se lean. */
export function setPinScope(next: Scope) {
  if (next === scope) return;
  scope = next;
  pins = [FAVORITES_PIN];
  loaded = false;
  actions = {};
  actionsLoaded = false;
  if (listeners.size) void load();
  if (actionListeners.size) void loadActions();
  listeners.forEach((l) => l());
  actionListeners.forEach((l) => l());
}

const KEY = 'impala.pinnedPlaylists';
let pins: string[] = [FAVORITES_PIN];
let loaded = false;
const listeners = new Set<() => void>();

function set(next: string[]) {
  pins = next;
  listeners.forEach((l) => l());
  SecureStore.setItemAsync(scoped(KEY), JSON.stringify(next)).catch(() => {});
}

async function load() {
  if (loaded) return;
  loaded = true;
  const from = scope;
  try {
    const stored = await SecureStore.getItemAsync(scoped(KEY));
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (from === scope && Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      pins = parsed;
      listeners.forEach((l) => l());
    }
  } catch {
    // Sin preferencia guardada: se queda la de por defecto.
  }
}

export function usePins(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void load();
      return () => void listeners.delete(l);
    },
    () => pins,
  );
}

export function pin(id: string) {
  if (!pins.includes(id)) set([...pins, id]);
}
export function unpin(id: string) {
  set(pins.filter((p) => p !== id));
  if (id in actions) setPinAction(id, 'open');
}

/**
 * Nuevo orden de las fijadas que se ven. Las que no aparecen en `visible` (playlists que aún no se
 * cargaron o ya no existen) conservan su sitio relativo al final.
 */
export function reorderPins(visible: string[]) {
  const rest = pins.filter((p) => !visible.includes(p));
  set([...visible.filter((p) => pins.includes(p)), ...rest]);
}

// --- Acción al tocar -----------------------------------------------------------------------------
// Tocar una playlist fijada puede abrirla (lo habitual), reproducirla en el orden que el usuario
// eligió para ella o reproducirla en aleatorio.

export type PinAction = 'open' | 'play' | 'shuffle';

const ACTIONS_KEY = 'impala.pinActions';
let actions: Record<string, PinAction> = {};
let actionsLoaded = false;
const actionListeners = new Set<() => void>();

async function loadActions() {
  if (actionsLoaded) return;
  actionsLoaded = true;
  const from = scope;
  try {
    const stored = await SecureStore.getItemAsync(scoped(ACTIONS_KEY));
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (from === scope && parsed && typeof parsed === 'object') {
      const next: Record<string, PinAction> = {};
      for (const [id, action] of Object.entries(parsed as Record<string, unknown>)) {
        if (action === 'play' || action === 'shuffle') next[id] = action;
      }
      actions = next;
      actionListeners.forEach((l) => l());
    }
  } catch {
    // Sin preferencia guardada: todas se abren al tocarlas.
  }
}

export function usePinActions(): Record<string, PinAction> {
  return useSyncExternalStore(
    (l) => {
      actionListeners.add(l);
      void loadActions();
      return () => void actionListeners.delete(l);
    },
    () => actions,
  );
}

export function setPinAction(id: string, action: PinAction) {
  const next = { ...actions };
  if (action === 'open') delete next[id];
  else next[id] = action;
  actions = next;
  actionListeners.forEach((l) => l());
  SecureStore.setItemAsync(scoped(ACTIONS_KEY), JSON.stringify(next)).catch(() => {});
}
