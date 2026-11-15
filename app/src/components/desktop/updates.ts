import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import ImpalaLibrary from '../../../modules/impala-library';
import { showToast } from '../Toast';
import { availableUpdate, type AvailableUpdate, type GithubRelease } from './updateLogic';

/**
 * Actualizaciones del teléfono (en PC, ver updates.web.ts): pregunta a GitHub por la última versión publicada en el
 * repositorio de `expo.extra.githubRepo` (app.json) y, si hay una más nueva con APK, la ofrece en UpdateDialog. La
 * API sin cuenta admite 60 consultas por hora y por IP: al abrir la app se mira como mucho cada 12 h; a mano, siempre.
 * No usa el servidor propio: funciona igual con «Este dispositivo».
 */
export const canUpdate = Platform.OS === 'android' && !__DEV__;

const REPO = (Constants.expoConfig?.extra?.githubRepo as string | undefined) ?? 'ELuiZzi/Impala-App';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const KEY_LAST_CHECK = 'impala.update.lastCheck';
const KEY_SKIPPED = 'impala.update.skipped';

export type UpdateState =
  | { stage: 'idle' }
  | { stage: 'available'; update: AvailableUpdate }
  | { stage: 'downloading'; update: AvailableUpdate; progress: number }
  | { stage: 'permission'; update: AvailableUpdate; path: string }
  | { stage: 'ready'; update: AvailableUpdate; path: string }
  | { stage: 'error'; update: AvailableUpdate; message: string };

let state: UpdateState = { stage: 'idle' };
const listeners = new Set<() => void>();

function setState(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

export const updateStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export function installedVersion(): string {
  try {
    return ImpalaLibrary.getAppVersion().versionName;
  } catch {
    return Constants.expoConfig?.version ?? '0';
  }
}

let checking = false;

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!canUpdate || checking || state.stage !== 'idle') return;
  checking = true;
  try {
    // Solo pruebas (adb): Android/data/com.luizzi.impala/files/update-test.json sustituye a la respuesta de GitHub.
    const override = ImpalaLibrary.readUpdateOverride();
    if (!override && !manual) {
      const last = Number(await SecureStore.getItemAsync(KEY_LAST_CHECK).catch(() => null)) || 0;
      if (Date.now() - last < CHECK_EVERY_MS) return;
    }
    let release: GithubRelease;
    if (override) {
      release = JSON.parse(override) as GithubRelease;
    } else {
      await SecureStore.setItemAsync(KEY_LAST_CHECK, String(Date.now())).catch(() => {});
      const response = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) {
        // 404: aún no hay versiones publicadas; 403/429: límite de consultas. Al abrir la app no se avisa.
        if (manual) {
          showToast(
            response.status === 404
              ? 'Todavía no hay versiones publicadas'
              : response.status === 403 || response.status === 429
                ? 'GitHub no responde ahora; prueba en un rato'
                : `No se pudo comprobar (error ${response.status})`,
            'alert-circle-outline',
          );
        }
        return;
      }
      release = (await response.json()) as GithubRelease;
    }
    const update = availableUpdate(release, installedVersion());
    if (!update) {
      if (manual) showToast('Tienes la última versión de Impala', 'checkmark-circle');
      return;
    }
    const skipped = await SecureStore.getItemAsync(KEY_SKIPPED).catch(() => null);
    if (!manual && skipped === update.version) return;
    setState({ stage: 'available', update });
  } catch {
    if (manual) showToast('No se pudo comprobar: revisa la conexión', 'alert-circle-outline');
  } finally {
    checking = false;
  }
}

export function dismissUpdate() {
  if (state.stage === 'downloading') ImpalaLibrary.cancelUpdateDownload();
  setState({ stage: 'idle' });
}

export async function skipUpdate() {
  if (state.stage === 'idle') return;
  await SecureStore.setItemAsync(KEY_SKIPPED, state.update.version).catch(() => {});
  setState({ stage: 'idle' });
}

export async function startUpdate() {
  if (state.stage !== 'available' && state.stage !== 'error') return;
  const { update } = state;
  setState({ stage: 'downloading', update, progress: 0 });
  const sub = ImpalaLibrary.addListener('onUpdateDownload', ({ progress }) => {
    if (state.stage === 'downloading') setState({ stage: 'downloading', update, progress });
  });
  try {
    const path = await ImpalaLibrary.downloadUpdate(update.url, update.fileName, update.size);
    setState({ stage: 'ready', update, path });
    await install();
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_CANCELLED') return;
    setState({ stage: 'error', update, message: e instanceof Error ? e.message : String(e) });
  } finally {
    sub.remove();
  }
}

/** Abre el instalador; si Android aún no deja a Impala instalar apps, primero se explica y se lleva a su ajuste. */
export async function install() {
  if (state.stage !== 'ready' && state.stage !== 'permission') return;
  const { update, path } = state;
  if (!ImpalaLibrary.canInstallPackages()) {
    setState({ stage: 'permission', update, path });
    return;
  }
  setState({ stage: 'ready', update, path });
  try {
    await ImpalaLibrary.installUpdate(path);
  } catch (e) {
    setState({ stage: 'error', update, message: e instanceof Error ? e.message : String(e) });
  }
}

export function openInstallSettings() {
  ImpalaLibrary.openInstallSettings();
}
