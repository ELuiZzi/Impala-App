import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import ImpalaLibrary from '../../modules/impala-library';
import {
  canUpdate,
  checkForUpdates,
  dismissUpdate,
  install,
  installedVersion,
  openInstallSettings,
  skipUpdate,
  startUpdate,
  updateStore,
} from './desktop/updates';

function formatMB(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Diálogo de una versión nueva de Impala (solo Android; ver desktop/updates.ts). Comprueba al arrancar y guía la
 * descarga y la instalación: Android siempre pide al usuario que toque «Instalar».
 */
export function UpdateDialog() {
  const state = useSyncExternalStore(updateStore.subscribe, updateStore.get);

  useEffect(() => {
    if (!canUpdate) return;
    const timer = setTimeout(() => void checkForUpdates(false), 5000);
    return () => clearTimeout(timer);
  }, []);

  // Volviendo del ajuste «Instalar apps desconocidas»: si ya lo permitió, se abre el instalador.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && updateStore.get().stage === 'permission' && ImpalaLibrary.canInstallPackages()) void install();
    });
    return () => sub.remove();
  }, []);

  if (state.stage === 'idle') return null;
  const { update } = state;

  let body: React.ReactNode;
  let actions: { label: string; onPress: () => void; primary?: boolean }[];
  switch (state.stage) {
    case 'available':
      body = (
        <>
          <Text className="text-muted text-sm mb-3">
            Tienes la {installedVersion()}. Se descarga el APK ({formatMB(update.size)}) y Android te pedirá que toques «Instalar»:
            Impala no puede instalarse sola. Tu música, playlists y sesión se conservan.
          </Text>
          {update.notes ? (
            <ScrollView style={{ maxHeight: 260 }} className="rounded-xl bg-background px-3 py-2">
              <Text className="text-foreground text-sm leading-5">{update.notes}</Text>
            </ScrollView>
          ) : null}
        </>
      );
      actions = [
        { label: 'Actualizar', onPress: () => void startUpdate(), primary: true },
        { label: 'Más tarde', onPress: dismissUpdate },
        { label: 'Omitir esta versión', onPress: () => void skipUpdate() },
      ];
      break;
    case 'downloading':
      body = (
        <>
          <Text className="text-muted text-sm mb-3">
            Descargando… {Math.round(state.progress * 100)} % de {formatMB(update.size)}
          </Text>
          <View className="h-1.5 rounded-full bg-background overflow-hidden">
            <View className="h-full bg-accent" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </View>
        </>
      );
      actions = [{ label: 'Cancelar', onPress: dismissUpdate }];
      break;
    case 'permission':
      body = (
        <Text className="text-muted text-sm">
          Para instalar la actualización, Android necesita que permitas a Impala instalar apps. En el ajuste que se abre,
          activa el permiso para Impala («Permitir desde esta fuente» o «Confiar en esta fuente») y vuelve: el instalador se abrirá solo. Solo se usa para las versiones de Impala.
        </Text>
      );
      actions = [
        { label: 'Abrir ajustes', onPress: openInstallSettings, primary: true },
        { label: 'Más tarde', onPress: dismissUpdate },
      ];
      break;
    case 'ready':
      body = (
        <Text className="text-muted text-sm">
          Descargada. Toca «Instalar» en la ventana de Android; Impala se cerrará y se abrirá ya actualizada. Si la cerraste,
          ábrela otra vez desde aquí.
        </Text>
      );
      actions = [
        { label: 'Abrir el instalador', onPress: () => void install(), primary: true },
        { label: 'Cerrar', onPress: dismissUpdate },
      ];
      break;
    case 'error':
      body = <Text className="text-muted text-sm">No se pudo descargar: {state.message}</Text>;
      actions = [
        { label: 'Reintentar', onPress: () => void startUpdate(), primary: true },
        { label: 'Más tarde', onPress: dismissUpdate },
      ];
      break;
  }

  return (
    <Modal transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={state.stage === 'downloading' ? undefined : dismissUpdate}>
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        <View className="w-full max-w-md rounded-3xl bg-card p-5">
          <Text className="text-foreground text-xl font-bold mb-2">Impala {update.version} disponible</Text>
          {body}
          <View className="mt-4 gap-1">
            {actions.map((a) => (
              <Pressable
                key={a.label}
                onPress={a.onPress}
                className={`rounded-full py-3 items-center active:opacity-60 ${a.primary ? 'bg-accent' : ''}`}
              >
                <Text className={`text-base font-semibold ${a.primary ? 'text-white' : 'text-accent'}`}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
