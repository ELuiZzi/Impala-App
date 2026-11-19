import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Marquee } from '@/components/Marquee';
import { AnimatedBackdrop } from '@/components/player/AnimatedBackdrop';
import { FeedFeedback, useFeedGestures } from '@/components/player/useFeedGestures';
import { closeSheet, isSheetOpen, showSheet, type SheetOption } from '@/components/sheets/store';
import { showToast } from '@/components/Toast';
import { CLIP_MS } from '@/discover/bestPart';
import {
  addToPlaylist,
  discoverFilters,
  genres,
  setFilters,
  like,
  leaveDiscover,
  listenWhole,
  next,
  openDiscover,
  previous,
  togglePause,
  useDiscover,
} from '@/discover/session';
import { usePreview } from '@/player/preview';
import { useSource } from '@/sources';

/**
 * Descubrir: una canción nueva tras otra, al estilo TikTok. Cada una empieza en el coro y dura ~30 s (o entera,
 * si se pide). Deslizar arriba = siguiente, abajo = anterior; tocar = pausa; doble toque = me gusta (a favoritas,
 * descargándola). Suena en el reproductor de vista previa: al salir, vuelve lo que sonaba.
 */
export default function DiscoverScreen() {
  const source = useSource();
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(600);
  const [artSize, setArtSize] = useState(300);
  // Carátulas que no cargaron: se usa la miniatura del video (siempre existe).
  const [broken, setBroken] = useState<Record<string, true>>({});
  const status = useDiscover((s) => s.status);
  const track = useDiscover((s) => s.items[s.index] ?? null);
  const index = useDiscover((s) => s.index);
  const liked = useDiscover((s) => (track ? !!s.liked[track.videoId] : false));
  const full = useDiscover((s) => s.full);
  const preview = usePreview((s) => (track && s.id === track.videoId ? s.status : null));

  // Entrar en la pestaña: suena (sigue donde se quedó); salir: se calla y vuelve la música principal.
  useFocusEffect(
    useCallback(() => {
      void openDiscover(source);
      const stopDesktop = Platform.OS === 'web' ? desktopInput() : undefined;
      return () => {
        stopDesktop?.();
        leaveDiscover();
      };
    }, [source]),
  );
  const genre = useDiscover((s) => s.filters.genre);

  const feed = useFeedGestures({
    enabled: !!track,
    height,
    pageKey: track?.videoId,
    canNext: !!track,
    canPrevious: index > 0,
    onNext: () => void next(),
    onPrevious: () => void previous(),
    onTap: togglePause,
    onDoubleTap: like,
  });

  const playing = preview === 'playing' || preview === 'loading';

  return (
    <View className="flex-1 bg-black overflow-hidden">
      <StatusBar style="light" />
      <AnimatedBackdrop artworkUrl={track?.thumbnail ?? undefined} playing={playing} />
      <View style={{ paddingTop: insets.top + 8 }} className="px-5 flex-row items-center">
        <Text className="text-white text-2xl font-bold flex-1">Descubrir</Text>
        {genre ? (
          <Pressable onPress={openGenres} className="flex-row items-center rounded-full bg-white px-3 py-1 active:opacity-70" accessibilityLabel={`Género: ${genre.name}`}>
            <Ionicons name="musical-notes" size={14} color="black" />
            <Text className="text-black text-xs font-semibold ml-1">{genre.name}</Text>
          </Pressable>
        ) : track?.source === 'explore' && track.seed ? (
          <View className="flex-row items-center rounded-full bg-white/15 px-3 py-1">
            <Ionicons name="compass-outline" size={14} color="white" />
            <Text className="text-white text-xs font-semibold ml-1">{track.seed}</Text>
          </View>
        ) : null}
        <Pressable onPress={openFilters} hitSlop={10} className="ml-3 w-9 h-9 rounded-full bg-white/15 items-center justify-center active:opacity-50" accessibilityLabel="Filtros de Descubrir">
          <Ionicons name="options-outline" size={20} color="white" />
        </Pressable>
      </View>

      {!track ? (
        <Waiting status={status} onRetry={() => void openDiscover(source)} />
      ) : (
        <>
          <GestureDetector gesture={feed.gesture}>
            <View
              collapsable={false}
              className="flex-1"
              onLayout={(e) => {
                const { width, height: h } = e.nativeEvent.layout;
                setHeight(h);
                setArtSize(Math.min(width - 64, h - 150, 420));
              }}
            >
              <Reanimated.View style={feed.pageStyle} className="flex-1 items-center justify-center px-8">
                <View style={{ width: artSize, height: artSize, elevation: 18 }} className="rounded-2xl bg-white/10">
                  <Image
                    key={track.videoId}
                    source={{ uri: broken[track.videoId] || !track.thumbnail ? `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg` : track.thumbnail }}
                    onError={() => setBroken((b) => ({ ...b, [track.videoId]: true }))}
                    contentFit="cover"
                    cachePolicy="disk"
                    style={{ width: '100%', height: '100%', borderRadius: 16 }}
                  />
                  {preview === 'loading' ? (
                    <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                      <ActivityIndicator size="large" color="white" />
                    </View>
                  ) : preview === 'paused' || preview === null ? (
                    <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                      <View className="w-20 h-20 rounded-full bg-black/40 items-center justify-center">
                        <Ionicons name="play" size={44} color="white" style={{ marginLeft: 4 }} />
                      </View>
                    </View>
                  ) : null}
                </View>
                <View style={{ width: artSize }} className="mt-5">
                  <View className="flex-row items-center">
                    <Marquee className="text-white text-xl font-bold" containerClassName="flex-shrink">
                      {track.title}
                    </Marquee>
                    {track.explicit && (
                      <View className="ml-1.5 rounded-sm bg-white/25 px-1">
                        <Text className="text-white text-[10px] font-bold">E</Text>
                      </View>
                    )}
                  </View>
                  <Marquee className="text-white/70 text-base">{[track.artist, track.album].filter(Boolean).join(' · ')}</Marquee>
                </View>
              </Reanimated.View>
              <FeedFeedback tapPulse={feed.tapPulse} burst={feed.burst} tapIcon={feed.tapIcon} />
            </View>
          </GestureDetector>

          {/* Fuera del detector: sus toques y los Pressable no se excluyen entre sí. */}
          {/* En pantallas anchas (PC) los botones no se reparten por todo el ancho. */}
          <View style={{ maxWidth: 560, width: '100%', alignSelf: 'center' }} className="px-8 pb-4">
            <ClipProgress videoId={track.videoId} full={full} />
            {/* Sin botón «Siguiente»: se pasa deslizando (o con la rueda / ↓ en el PC). */}
            <View className="flex-row items-center justify-around mt-4">
              <RoundAction icon={liked ? 'star' : 'star-outline'} label={liked ? 'Te gusta' : 'Me gusta'} color={liked ? '#FFD60A' : 'white'} onPress={like} />
              <RoundAction icon="add" label="Playlist" onPress={addToPlaylist} />
              <RoundAction icon={full ? 'infinite' : 'timer-outline'} label="Entera" active={full} onPress={listenWhole} />
            </View>
            {index === 0 && (
              <Text className="text-white/50 text-xs text-center mt-3">
                {Platform.OS === 'web'
                  ? 'Rueda del ratón o ↓ para la siguiente · Espacio para pausar · L si te gusta'
                  : 'Desliza hacia arriba para la siguiente · doble toque si te gusta'}
              </Text>
            )}
          </View>
        </>
      )}
    </View>
  );
}

/** Qué canciones propone Descubrir: idioma, explícitas y género. Cada cambio se aplica desde la siguiente. */
function openFilters() {
  const f = discoverFilters();
  const toggle = (patch: Parameters<typeof setFilters>[0]) => () => {
    setFilters(patch);
    openFilters();
  };
  showSheet({
    kind: 'actions',
    title: 'Qué te propone Descubrir',
    subtitle: 'Se aplica desde la siguiente canción',
    icon: 'options-outline',
    options: [
      { label: `Solo en español: ${f.spanishOnly ? 'sí' : 'no'}`, icon: f.spanishOnly ? 'checkmark-circle' : 'language-outline', onPress: toggle({ spanishOnly: !f.spanishOnly }) },
      { label: `Canciones explícitas: ${f.noExplicit ? 'ocultas' : 'se muestran'}`, icon: f.noExplicit ? 'eye-off-outline' : 'eye-outline', onPress: toggle({ noExplicit: !f.noExplicit }) },
      { label: `Género: ${f.genre?.name ?? 'según lo que escuchas'}`, icon: 'musical-notes-outline', onPress: () => void openGenres() },
    ],
  });
}

/** Elegir un género o estado de ánimo de YouTube Music (o volver a lo de siempre). Cambia de canción al momento. */
async function openGenres() {
  const list = await genres().catch(() => null);
  if (!list?.length) return showToast('No se pudieron cargar los géneros. Revisa tu conexión.', 'cloud-offline-outline');
  const current = discoverFilters().genre;
  const pick = (genre: { name: string; params: string } | null) => () => {
    closeSheet();
    setFilters({ genre });
    void next({ silent: true });
    showToast(genre ? `Descubrir: ${genre.name}` : 'Descubrir: según lo que escuchas', 'musical-notes');
  };
  const options: SheetOption[] = [
    { label: 'Según lo que escuchas', icon: current ? 'sparkles-outline' : 'checkmark-circle', onPress: pick(null) },
    ...list.map(
      (m): SheetOption => ({
        label: m.name,
        icon: current?.params === m.params ? 'checkmark-circle' : m.group.startsWith('Género') ? 'musical-note-outline' : 'happy-outline',
        onPress: pick({ name: m.name, params: m.params }),
      }),
    ),
  ];
  showSheet({ kind: 'actions', title: 'Género o estado de ánimo', subtitle: 'Canciones de YouTube Music de ese estilo', icon: 'musical-notes-outline', options });
}

/**
 * En el PC: rueda del ratón (una canción por giro), ↓/↑ o AvPág/RePág, Espacio para pausar y L para «me gusta».
 * Se escucha en la fase de captura y se marca como usado: los atajos generales (Espacio = música principal) no actúan.
 */
function desktopInput() {
  const typing = (el: HTMLElement | null) =>
    !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'));
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isSheetOpen() || typing(e.target as HTMLElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    let action: (() => void) | null = null;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') action = () => void next();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') action = () => void previous();
    else if (e.key === ' ' || e.code === 'Space') action = () => void togglePause();
    else if (e.key.toLowerCase() === 'l') action = like;
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  let wheel = 0;
  let lockedUntil = 0;
  const onWheel = (e: WheelEvent) => {
    // Con una hoja abierta (p. ej. la lista de géneros), la rueda la desplaza a ella.
    if (isSheetOpen()) return;
    const now = Date.now();
    if (now < lockedUntil) return;
    wheel += e.deltaY;
    if (Math.abs(wheel) < 60) return;
    lockedUntil = now + 700;
    if (wheel > 0) void next();
    else void previous();
    wheel = 0;
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('wheel', onWheel, { passive: true });
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', onWheel);
  };
}

/** Barra fina: lo que queda de los 30 s (o de la canción, si se escucha entera). */
function ClipProgress({ videoId, full }: { videoId: string; full: boolean }) {
  const startMs = useDiscover((s) => s.startMs);
  const fraction = usePreview((s) => {
    if (s.id !== videoId) return 0;
    if (full) return s.durationMs ? s.positionMs / s.durationMs : 0;
    return Math.min(1, Math.max(0, (s.positionMs - startMs) / CLIP_MS));
  });
  return (
    <View className="h-1 rounded-full bg-white/20 overflow-hidden">
      <View style={{ width: `${Math.round(fraction * 1000) / 10}%` }} className="h-full bg-white" />
    </View>
  );
}

function RoundAction({
  icon,
  label,
  onPress,
  color = 'white',
  active = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  color?: string;
  active?: boolean;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={6} className="items-center active:opacity-50" accessibilityLabel={label}>
      <View className={`w-14 h-14 rounded-full items-center justify-center ${active ? 'bg-white' : 'bg-white/15'}`}>
        <Ionicons name={icon} size={26} color={active ? 'black' : color} />
      </View>
      <Text className="text-white/80 text-xs mt-1.5">{label}</Text>
    </Pressable>
  );
}

function Waiting({ status, onRetry }: { status: string; onRetry: () => void }) {
  if (status === 'empty' || status === 'error') {
    return (
      <View className="flex-1 items-center justify-center px-10">
        <Ionicons name="cloud-offline-outline" size={56} color="white" />
        <Text className="text-white text-lg font-bold mt-4 text-center">No se encontraron canciones</Text>
        <Text className="text-white/60 text-sm mt-1 text-center">Descubrir necesita internet para buscar música nueva en YouTube Music.</Text>
        <Pressable onPress={onRetry} className="mt-6 rounded-full bg-white px-6 py-3 active:opacity-70" accessibilityLabel="Reintentar">
          <Text className="text-black font-bold">Reintentar</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View className="flex-1 items-center justify-center px-10">
      <ActivityIndicator size="large" color="white" />
      <Text className="text-white/70 text-sm mt-4 text-center">Buscando canciones para ti…</Text>
    </View>
  );
}
