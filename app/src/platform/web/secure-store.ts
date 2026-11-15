/**
 * Sustituto de `expo-secure-store` en PC (Metro lo usa solo al compilar para web, ver metro.config.js).
 *
 * La sesión del servidor (usuario y token) va al Administrador de credenciales de Windows; el resto de
 * preferencias (fijadas, calidad, traducción…) son archivos de la app, como cualquier otro ajuste.
 * En un navegador, sin Tauri, todo va a localStorage.
 */
import { File, Paths } from './file-system';
import { invoke, isTauri } from './tauri';

/** Las claves con credenciales; el resto no tiene nada secreto. */
const SECRET_KEYS = new Set(['impala.session']);

/** Cada preferencia, un archivo: document/preferencias/<clave>.txt */
const prefFile = (key: string) => new File(Paths.document, 'preferencias', `${key.replace(/[^\w.-]/g, '_')}.txt`);

/** La Fase 0 guardaba todo en localStorage («impala-secure:<clave>»): se mueve a su sitio una vez. */
export async function migrateSecureStore(): Promise<void> {
  if (!isTauri()) return;
  const PREFIX = 'impala-secure:';
  let s: Storage;
  try {
    s = globalThis.localStorage;
  } catch {
    return;
  }
  const keys = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => !!k?.startsWith(PREFIX));
  for (const stored of keys) {
    const key = stored.slice(PREFIX.length);
    const value = s.getItem(stored);
    if (value != null && (await getItemAsync(key)) == null) await setItemAsync(key, value);
    s.removeItem(stored);
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  if (isTauri() && SECRET_KEYS.has(key)) return invoke<string | null>('secret_get', { key });
  return getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (isTauri() && SECRET_KEYS.has(key)) return invoke('secret_set', { key, value });
  setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (isTauri() && SECRET_KEYS.has(key)) return invoke('secret_delete', { key });
  const file = prefFile(key);
  if (file.exists) file.delete();
}

export function getItem(key: string): string | null {
  const file = prefFile(key);
  return file.exists ? file.textSync() : null;
}

export function setItem(key: string, value: string): void {
  prefFile(key).write(value);
}
