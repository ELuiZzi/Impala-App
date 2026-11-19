import '../../global.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { type Href, router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { queryClient } from '@/api/queryClient';
import { AuthProvider, useAuth } from '@/auth/session';
import { AlertHost } from '@/components/AlertHost';
import { DesktopShortcuts } from '@/components/desktop/DesktopShortcuts';
import { PlayerBar } from '@/components/desktop/PlayerBar';
import { Sheets } from '@/components/sheets/Sheets';
import { Toast } from '@/components/Toast';
import { UpdateDialog } from '@/components/UpdateDialog';
import { touchFocusHandlers } from '@/components/touchFocus';
import { useThemeColor } from '@/components/theme';
import { syncFavoritesPlaylist } from '@/library/favorites';
import { setTailscaleEnabled, startTailscaleLifecycle } from '@/net/tailscale';
import { loadOffline } from '@/offline/store';
import { initPlayer, resetPlayer, syncPlayer } from '@/player/store';
import { maybeServerSession, useMaybeSource, type MusicSource } from '@/sources';
import { checkSubscriptions, scheduleBackgroundChecks, startForegroundChecks } from '@/subscriptions/background';
import { listenNotificationTaps } from '@/subscriptions/notify';
import { setEpisodeSession, startEpisodeTracking } from '@/subscriptions/playback';
import { simpleMode, useSimpleMode } from '@/simple/store';
import { watchLocalLibrary } from '@/sources/local';
import { checkAudioPermission, useAudioPermission } from '@/sources/permission';

// El índice de descargas se lee una vez al arrancar (también sin conexión).
loadOffline();
// Enciende Tailscale cada vez que la app vuelve a primer plano (solo con el servidor propio).
startTailscaleLifecycle();

export default function RootLayout() {
  return (
    // Las filas de las listas animan sus textos largos solo cerca del dedo (Marquee + touchFocus).
    <GestureHandlerRootView style={{ flex: 1 }} {...touchFocusHandlers}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <View className="flex-1">
            <RootStack />
          </View>
          {/* Solo en el PC: la barra de reproducción, abajo y a todo lo ancho. */}
          <PlayerBar />
          <DesktopShortcuts />
          <Sheets />
          <Toast />
          <AlertHost />
          <UpdateDialog />
        </AuthProvider>
        <StatusBar style="auto" />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function RootStack() {
  const { session, mode, isLoading } = useAuth();
  const source = useMaybeSource();
  const permission = useAudioPermission();
  const background = useThemeColor('background');
  const local = mode === 'local';
  // Con la música del teléfono, sin permiso para leerla solo se ve la pantalla que lo pide.
  const ready = local ? permission === 'granted' : !!session;
  // Modo sencillo: solo sus pantallas (ni pestañas ni Ajustes hasta salir de él).
  const simple = useSimpleMode().enabled;
  const previousSource = useRef<MusicSource | null>(null);

  // Evita destellos blancos entre transiciones en modo oscuro.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(background);
  }, [background]);

  // Conecta con el servicio de reproducción. Al cambiar de fuente (o de cuenta) se detiene lo que
  // sonaba: sus canciones son de la otra fuente.
  useEffect(() => {
    if (isLoading || !source) return;
    const previous = previousSource.current;
    previousSource.current = source;
    setTailscaleEnabled(source.kind === 'subsonic');
    void (async () => {
      if (previous && previous !== source) await resetPlayer();
      await initPlayer(source);
      // Episodios de las suscripciones: guardar dónde se quedó cada uno (y el servidor, si hay, para su audio;
      // en modo local no hay: maybeServerSession da null en vez de lanzar un error).
      setEpisodeSession(maybeServerSession(source));
      startEpisodeTracking();
    })();
  }, [source, isLoading]);

  // Crea "Canciones Favoritas" si aún no existe y la iguala a las estrellas.
  useEffect(() => {
    if (!isLoading && source && ready) syncFavoritesPlaylist(source).catch(() => {});
  }, [source, isLoading, ready]);

  // La biblioteca del teléfono se refresca sola cuando cambian los archivos.
  useEffect(() => {
    if (local && ready) return watchLocalLibrary();
  }, [local, ready]);

  // Suscripciones: revisar al abrir (y cada hora en el PC), programar la revisión en segundo plano y abrir la
  // suscripción al tocar un aviso de episodio nuevo.
  useEffect(() => {
    if (!ready) return;
    void scheduleBackgroundChecks();
    void checkSubscriptions({ notify: false });
    const stopChecks = startForegroundChecks();
    // Un instante para que la navegación esté montada (si el aviso abrió la app).
    const stopTaps = listenNotificationTaps((url) =>
      setTimeout(() => {
        // En el modo sencillo, la página sencilla de esa suscripción.
        const sencillo = simpleMode().enabled ? url.replace('/biblioteca/suscripciones/', '/sencillo/') : url;
        router.push(sencillo as Href);
      }, 300),
    );
    return () => {
      stopChecks();
      stopTaps();
    };
  }, [ready]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      syncPlayer();
      void checkSubscriptions({ notify: false });
      // Pudo dar (o quitar) el permiso desde los ajustes de Android.
      void checkAudioPermission();
    });
    return () => sub.remove();
  }, []);

  if (isLoading || (local && permission === 'unknown')) return <View className="flex-1 bg-background" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={ready && simple}>
        <Stack.Screen name="sencillo/index" />
        <Stack.Screen name="sencillo/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="sencillo/reproduciendo" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      </Stack.Protected>
      <Stack.Protected guard={ready && !simple}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="ajustes" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="modo-sencillo" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="youtube-album/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="youtube-artist/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen
          name="reproduciendo"
          // Transparente para que, al deslizarlo hacia abajo, se vea la pantalla de debajo.
          options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: 'transparent' } }}
        />
        <Stack.Screen name="recortar" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen
          name="cola"
          // Transparente como el reproductor: al deslizarla hacia abajo se ve el reproductor debajo.
          options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: 'transparent' } }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!ready}>
        <Stack.Screen name="permiso" />
      </Stack.Protected>
      {/* Conectar con un servidor propio: desde Ajustes o desde la pantalla del permiso. */}
      <Stack.Screen name="login" options={{ animation: 'slide_from_right' }} />
    </Stack>
  );
}
