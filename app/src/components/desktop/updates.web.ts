import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { Alert } from 'react-native';
import { isTauri } from '@/platform/web/tauri';
import { showToast } from '../Toast';

/**
 * Actualizaciones de la app de PC: el plugin de Tauri lee latest.json de la última versión publicada en GitHub
 * (desktop/src-tauri/tauri.conf.json) y solo acepta instaladores firmados con la clave de Impala. Se comprueba al
 * arrancar (sin avisar si no hay nada) y desde Ajustes.
 */
export const canUpdate = isTauri() && !__DEV__;

let checking = false;

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!canUpdate || checking) return;
  checking = true;
  try {
    const update = await check();
    if (!update) {
      if (manual) showToast('Tienes la última versión de Impala', 'checkmark-circle');
      return;
    }
    const notes = update.body?.trim();
    Alert.alert(
      `Impala ${update.version} disponible`,
      `${notes ? `${notes}\n\n` : ''}Se descarga, se instala y Impala se vuelve a abrir (lo que suena se detiene).`,
      [
        { text: 'Más tarde', style: 'cancel' },
        {
          text: 'Actualizar',
          onPress: async () => {
            showToast('Descargando la actualización…', 'cloud-download-outline');
            try {
              await update.downloadAndInstall();
              await relaunch();
            } catch (e) {
              Alert.alert('No se pudo actualizar', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  } catch (e) {
    // Sin conexión o sin versiones publicadas todavía: solo se avisa si se pidió a mano.
    if (!manual) return;
    const message = e instanceof Error ? e.message : String(e);
    Alert.alert(
      'No se pudo comprobar',
      /release JSON/i.test(message)
        ? 'Todavía no hay versiones de Impala para PC publicadas en GitHub, o no hay conexión.'
        : message,
    );
  } finally {
    checking = false;
  }
}
