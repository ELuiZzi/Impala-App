/** Los eventos del módulo, con la misma forma que los de ImpalaPlayerModule.kt (addListener / remove). */
type Listener = (event: any) => void;
const listeners = new Map<string, Set<Listener>>();

export function addListener(name: string, listener: Listener) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(listener);
  return { remove: () => void listeners.get(name)?.delete(listener) };
}

export function removeAllListeners(name: string) {
  listeners.delete(name);
}

export function emit(name: string, event?: unknown) {
  listeners.get(name)?.forEach((l) => {
    try {
      l(event);
    } catch (e) {
      console.error(`Error en un listener de ${name}:`, e);
    }
  });
}
