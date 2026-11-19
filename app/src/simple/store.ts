import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

/**
 * Modo sencillo: letra grande, pocos botones y nada escondido, pensado para quien solo quiere escuchar sus
 * oraciones y sus canciones (se puede dejar puesto en el teléfono de otra persona). Con un código de 4 cifras,
 * salir del modo pide el código, para que no se quite por error. Se guarda en simple-mode.json.
 */
export type SimpleMode = {
  enabled: boolean;
  pin: string | null;
  /** Suscripciones que no aparecen en el inicio sencillo. */
  hiddenSubscriptions: string[];
  /** Playlists del inicio sencillo, en orden; null = las fijadas de la Biblioteca. */
  playlists: string[] | null;
};

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const FILE = new File(Paths.document, 'simple-mode.json');
let state: SimpleMode | null = null;
const listeners = new Set<() => void>();

function load(): SimpleMode {
  if (state) return state;
  state = { enabled: false, pin: null, hiddenSubscriptions: [], playlists: null };
  try {
    if (FILE.exists) {
      const parsed = JSON.parse(FILE.textSync()) as Partial<SimpleMode> | null;
      state = {
        enabled: parsed?.enabled === true,
        pin: typeof parsed?.pin === 'string' && /^\d{4}$/.test(parsed.pin) ? parsed.pin : null,
        hiddenSubscriptions: isStrings(parsed?.hiddenSubscriptions) ? parsed.hiddenSubscriptions : [],
        playlists: isStrings(parsed?.playlists) ? parsed.playlists : null,
      };
    }
  } catch {
    // Archivo dañado: modo normal.
  }
  return state;
}

function save(next: SimpleMode) {
  state = next;
  listeners.forEach((l) => l());
  try {
    FILE.write(JSON.stringify(next));
  } catch (e) {
    console.warn('No se pudo guardar el modo sencillo', e);
  }
}

export const simpleMode = (): SimpleMode => load();

export function useSimpleMode(): SimpleMode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    load,
  );
}

/** Activa el modo sencillo; `pin` (4 cifras) protege la salida. */
export function enableSimpleMode(pin: string | null) {
  save({ ...load(), enabled: true, pin: pin && /^\d{4}$/.test(pin) ? pin : null });
}

/** Sale del modo; lo elegido para el inicio sencillo se conserva para la próxima vez. */
export function disableSimpleMode() {
  save({ ...load(), enabled: false, pin: null });
}

export function setSubscriptionShown(id: string, shown: boolean) {
  const hidden = load().hiddenSubscriptions.filter((h) => h !== id);
  save({ ...load(), hiddenSubscriptions: shown ? hidden : [...hidden, id] });
}

/** Las playlists del inicio sencillo (null vuelve a «las fijadas»). */
export function setSimplePlaylists(ids: string[] | null) {
  save({ ...load(), playlists: ids });
}
