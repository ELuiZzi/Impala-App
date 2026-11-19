import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { DATA_SAVER_FORMAT } from '@/api/subsonic';
import { useSource, type Song, type StreamQuality } from '@/sources';
import { Artwork } from '@/components/Artwork';
import { PLAYER_BAR_HEIGHT, useDesktop } from '@/components/desktop/layout';
import { AnimatedBackdrop } from '@/components/player/AnimatedBackdrop';
import { useCloseWhenEmpty } from '@/components/player/useCloseWhenEmpty';
import { LyricsView } from '@/components/player/Lyrics';
import { Scrubber } from '@/components/player/Scrubber';
import { openPlayerActions, openTuning } from '@/components/sheets/songActions';
import { albumName, artistName } from '@/components/theme';
import { setFavorite, toggleFavorite, useIsFavorite } from '@/library/favorites';
import { isDownloaded, localCoverUri, useOffline } from '@/offline/store';
import { describeGymRamp, stopGymRamp, useGymRamp } from '@/player/gym';
import { isSleepTimerActive, useSleepRemaining, useSleepTimer } from '@/player/sleep';
import { isNormal, tuningLabel, useTuning } from '@/player/tuning';
import { currentSong, cycleRepeat, hasNextTrack, isEpisodeId, next, playerState, previous, previousTrack, seekTo, togglePlay, toggleShuffle, usePlayer } from '@/player/store';
import { markGestureHintSeen, setPlayerControls, shouldShowGestureHint, usePlayerControls } from '@/player/controls';
import { FeedFeedback, useFeedGestures } from '@/components/player/useFeedGestures';
import { GestureHint } from '@/components/player/GestureHint';
import { Marquee } from '@/components/Marquee';

/** Deslizar hacia abajo más de esta fracción de la pantalla (o lanzar rápido) cierra el reproductor. */
const DISMISS_FRACTION = 0.2;
const DISMISS_VELOCITY = 900;
/** Aleatorio y repetir (modo con gestos): cuánto se quedan si no se tocan, y tras tocar uno. */
const MODES_AUTO_HIDE_MS = 4000;
const MODES_AFTER_PRESS_MS = 700;

/** La letra con un solo botón que va pasando: oculta → en el reproductor → a pantalla completa → oculta. */
type LyricsMode = 'off' | 'inline' | 'full';
const NEXT_LYRICS: Record<LyricsMode, LyricsMode> = { off: 'inline', inline: 'full', full: 'off' };

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'dsf']);

/** "Hi-Res Lossless · FLAC 24-bit/96 kHz", "Lossless · FLAC 16-bit/44.1 kHz", "Opus · 192 kbps (ahorro)"… */
function qualityLabel(song: Song, quality: StreamQuality | null, downloaded: boolean): { icon: keyof typeof Ionicons.glyphMap; text: string } | null {
  if (quality === 'ahorro' && !downloaded) {
    return { icon: 'leaf-outline', text: `Ahorro de datos · Opus ${DATA_SAVER_FORMAT.maxBitRate} kbps` };
  }
  const suffix = song.suffix?.toLowerCase();
  if (!suffix) return null;
  const khz = song.samplingRate ? `${+(song.samplingRate / 1000).toFixed(1)} kHz` : '';
  if (LOSSLESS.has(suffix)) {
    // Criterio de Apple Music: Hi-Res solo por encima de 48 kHz; hasta 24-bit/48 kHz es "Lossless".
    const hiRes = (song.samplingRate ?? 0) > 48000;
    const detail = [song.bitDepth ? `${song.bitDepth}-bit` : '', khz].filter(Boolean).join('/');
    return { icon: 'radio-outline', text: `${hiRes ? 'Hi-Res Lossless' : 'Lossless'} · ${suffix.toUpperCase()}${detail ? ` ${detail}` : ''}` };
  }
  return { icon: 'musical-note-outline', text: [suffix.toUpperCase(), song.bitRate ? `${song.bitRate} kbps` : ''].filter(Boolean).join(' · ') };
}

export default function ReproduciendoScreen() {
  const source = useSource();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const desktop = useDesktop();
  const song = usePlayer(currentSong);
  const wantsToPlay = usePlayer((s) => s.playWhenReady);
  const buffering = usePlayer((s) => s.playbackState === 'buffering');
  const positionMs = usePlayer((s) => s.positionMs);
  const bufferedMs = usePlayer((s) => s.bufferedMs);
  const durationMs = usePlayer((s) => s.durationMs ?? (currentSong(s)?.duration ?? 0) * 1000);
  const repeatMode = usePlayer((s) => s.repeatMode);
  const shuffle = usePlayer((s) => s.shuffle);
  const favorite = useIsFavorite(song?.id);
  const quality = usePlayer((s) => s.quality);
  const error = usePlayer((s) => s.error);
  const downloaded = useOffline(() => (song && source.capabilities.offlineDownloads ? isDownloaded(song.id) : false));
  const canNext = usePlayer(hasNextTrack);
  const canPrevious = usePlayer((s) => s.index > 0 || (s.repeatMode === 'all' && s.queue.length > 1));
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('off');
  const showLyrics = lyricsMode !== 'off';
  // Letra a pantalla completa: solo la letra y una cabecera pequeña con la canción.
  const lyricsFullscreen = lyricsMode === 'full';
  const cycleLyrics = () => setLyricsMode((m) => NEXT_LYRICS[m]);

  // Con gestos (por defecto) se ocultan los botones de reproducción; en el PC siempre botones.
  const gestureMode = usePlayerControls() === 'gestos' && !desktop;
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (gestureMode) shouldShowGestureHint().then(setHint);
  }, [gestureMode]);
  const closeHint = () => {
    setHint(false);
    void markGestureHintSeen();
  };

  // Con gestos, aleatorio y repetir aparecen al mantener pulsada la carátula y se van al usarlos (o solos).
  const [modesOpen, setModesOpen] = useState(false);
  const modesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideModes = (afterMs: number) => {
    if (modesTimer.current) clearTimeout(modesTimer.current);
    modesTimer.current = setTimeout(() => setModesOpen(false), afterMs);
  };
  const openModes = () => {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Long_Press).catch(() => {});
    setModesOpen(true);
    hideModes(MODES_AUTO_HIDE_MS);
  };
  // Tras tocar uno se ve un momento su nuevo estado y desaparecen.
  const pressMode = (action: () => unknown) => {
    void action();
    hideModes(MODES_AFTER_PRESS_MS);
  };
  useEffect(() => () => {
    if (modesTimer.current) clearTimeout(modesTimer.current);
  }, []);

  // Atrás sale de la pantalla completa (a la letra en el reproductor) antes de cerrar el reproductor.
  useEffect(() => {
    if (!lyricsFullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setLyricsMode('inline');
      return true;
    });
    return () => sub.remove();
  }, [lyricsFullscreen]);

  // Deslizar hacia abajo para cerrar: la pantalla sigue al dedo y, al soltar, o se va o vuelve a su
  // sitio. failOffsetX deja pasar los arrastres horizontales de la barra de progreso. Con gestos se
  // cierra con dos dedos (uno solo es la canción anterior).
  const dragY = useSharedValue(0);
  // Con la letra abierta, el gesto convive con su desplazamiento: fuera de la letra cierra como siempre;
  // sobre la letra, solo si está arriba del todo (si no, el arrastre desplaza la letra).
  const lyricsScroll = Gesture.Native();
  const lyricsScrollY = useSharedValue(0);
  const touchingLyrics = useSharedValue(false);
  const following = useSharedValue(false);
  lyricsScroll
    .onBegin(() => {
      touchingLyrics.value = true;
    })
    .onFinalize(() => {
      touchingLyrics.value = false;
    });
  const makeDismissPan = () =>
    Gesture.Pan()
      .minPointers(gestureMode ? 2 : 1)
      .activeOffsetY(12)
      .failOffsetX([-20, 20])
      .simultaneousWithExternalGesture(lyricsScroll)
      .onStart(() => {
        following.value = gestureMode || !touchingLyrics.value || lyricsScrollY.value <= 1;
      })
      .onUpdate((e) => {
        if (following.value) dragY.value = Math.max(0, e.translationY);
      })
      .onEnd((e) => {
        if (!following.value) return;
        following.value = false;
        if (e.translationY > height * DISMISS_FRACTION || e.velocityY > DISMISS_VELOCITY) {
          dragY.value = withTiming(height, { duration: 200 }, (finished) => {
            if (finished) scheduleOnRN(router.back);
          });
        } else {
          dragY.value = withSpring(0, { damping: 22, stiffness: 240 });
        }
      });
  const dismissPan = makeDismissPan();
  // Una segunda copia va sobre la carátula, junto a los gestos de un dedo: el detector de dentro se
  // quedaba con los toques de dos dedos y el de fuera no llegaba a activarse.
  const artDismissPan = makeDismissPan();

  // Deslizar arriba/abajo cambia de canción (siempre a la anterior, sin reiniciar la actual), tocar pausa
  // y doble toque marca como favorita (si ya lo es, sigue siéndolo: solo se ve la estrella).
  const feed = useFeedGestures({
    enabled: gestureMode && !showLyrics && !hint,
    height,
    pageKey: song?.uid,
    canNext,
    canPrevious,
    onNext: () => void next(),
    onPrevious: () => void previousTrack(),
    onTap: () => {
      setModesOpen(false);
      void togglePlay();
      return wantsToPlay ? 'pause' : 'play';
    },
    extra: gestureMode ? [artDismissPan] : [],
    onDoubleTap: () => {
      if (song && !favorite && !isEpisodeId(song.id)) setFavorite(source, song, true).catch(() => {});
    },
    onLongPress: openModes,
  });
  // Solo el valor compartido: el worklet no puede copiar el objeto entero (lleva el gesto).
  const feedPageY = feed.pageY;
  const titleStyle = useAnimatedStyle(() => {
    const y = feedPageY.get();
    return { transform: [{ translateY: y * 0.25 }], opacity: 1 - Math.min(1, Math.abs(y) / height) };
  });

  // Como Apple Music: la carátula se encoge al pausar.
  const [scale] = useState(() => new Animated.Value(wantsToPlay ? 1 : 0.84));
  useEffect(() => {
    Animated.spring(scale, { toValue: wantsToPlay ? 1 : 0.84, friction: 7, tension: 60, useNativeDriver: true }).start();
  }, [wantsToPlay, scale]);

  useCloseWhenEmpty(!song);

  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));
  if (!song) return null;

  const artSize = Math.min(width - 64, 420);
  const base = qualityLabel(song, quality, downloaded);
  // Las descargas son siempre el archivo original y suenan desde el teléfono.
  const label = downloaded && base ? { icon: 'arrow-down-circle' as const, text: `Descargada · ${base.text}` } : base;
  const subtitle = [artistName(song.artist), albumName(song.album)].filter(Boolean).join(' — ');
  // Episodio de una suscripción: sin favorita, menú de canción ni letra; retroceder/adelantar en vez de anterior/siguiente.
  const episode = isEpisodeId(song.id);
  const lyricsOn = source.capabilities.lyrics && !episode;
  const jump = (deltaMs: number) => seekTo(Math.max(0, Math.min(playerState().positionMs + deltaMs, (durationMs || Infinity) - 1000)));
  // La carátula pequeña basta para sacar sus colores; si está descargada, la del teléfono.
  const artworkUrl = (downloaded ? localCoverUri(song.coverArt) : null) ?? source.coverUrl(song.coverArt, 200);

  const lyricsView = <LyricsView song={song} onSeek={seekTo} scrollGesture={lyricsScroll} scrollY={lyricsScrollY} />;

  // Título, progreso, controles y botones de abajo: iguales en el teléfono y en el PC.
  const controls = (
    <>
      <View className="flex-row items-center mb-5">
        <Reanimated.View style={gestureMode ? titleStyle : undefined} className="flex-1">
          <Marquee className="text-white text-[22px] font-bold">{song.title}</Marquee>
          <Marquee className="text-white/65 text-[19px]">{subtitle}</Marquee>
        </Reanimated.View>
        {!episode && (
          <>
            <Pressable
              onPress={() => toggleFavorite(source, song).catch(() => {})}
              hitSlop={12}
              className="ml-3 w-9 h-9 rounded-full bg-white/15 items-center justify-center active:opacity-50"
              accessibilityLabel={favorite ? 'Quitar de favoritas' : 'Marcar como favorita'}
            >
              <Ionicons name={favorite ? 'star' : 'star-outline'} size={19} color="white" />
            </Pressable>
            <Pressable
              onPress={() => openPlayerActions(source, song)}
              hitSlop={12}
              className="ml-3 w-9 h-9 rounded-full bg-white/15 items-center justify-center active:opacity-50"
              accessibilityLabel="Más opciones"
            >
              <Ionicons name="ellipsis-horizontal" size={19} color="white" />
            </Pressable>
          </>
        )}
      </View>

      <Scrubber positionMs={positionMs} bufferedMs={bufferedMs} durationMs={durationMs || null} onSeek={seekTo} />

      <View className="h-6 mt-1 flex-row items-center justify-center gap-1.5">
        {error ? (
          <Text className="text-accent text-xs font-semibold">{error}</Text>
        ) : label ? (
          <>
            <Ionicons name={label.icon} size={13} color="rgba(255,255,255,0.6)" />
            <Text className="text-white/60 text-xs font-semibold">{label.text}</Text>
          </>
        ) : null}
      </View>

      {/* Aleatorio y repetición justo encima de los controles; resaltados cuando están activos. Para cerrar se desliza hacia abajo.
          Con gestos no hay ninguno de los dos: se maneja tocando y deslizando la carátula. */}
      {gestureMode && !episode ? <View className="h-4" /> : (<>
      {!episode && <View className="flex-row items-center justify-between mt-3">
        <ModeButton icon="shuffle" active={shuffle} onPress={toggleShuffle} label={shuffle ? 'Desactivar aleatorio' : 'Activar aleatorio'} />
        <ModeButton
          icon="repeat"
          active={repeatMode !== 'off'}
          badge={repeatMode === 'one' ? '1' : undefined}
          onPress={cycleRepeat}
          label={repeatMode === 'off' ? 'Repetir todo' : repeatMode === 'all' ? 'Repetir una' : 'No repetir'}
        />
      </View>}

      <View className="flex-row items-center justify-around mt-1 mb-6">
        {episode ? (
          <JumpButton seconds={-15} onPress={() => jump(-15_000)} />
        ) : (
          <Pressable onPress={previous} hitSlop={12} className="active:opacity-50">
            <Ionicons name="play-back" size={44} color="white" />
          </Pressable>
        )}
        <Pressable onPress={togglePlay} hitSlop={12} className="w-20 h-20 items-center justify-center active:opacity-50">
          {buffering && wantsToPlay ? (
            <ActivityIndicator size="large" color="white" />
          ) : (
            <Ionicons name={wantsToPlay ? 'pause' : 'play'} size={64} color="white" />
          )}
        </Pressable>
        {episode ? (
          <JumpButton seconds={30} onPress={() => jump(30_000)} />
        ) : (
          <Pressable onPress={next} hitSlop={12} className="active:opacity-50">
            <Ionicons name="play-forward" size={44} color="white" />
          </Pressable>
        )}
      </View>
      </>)}

      <View className="flex-row items-center justify-center gap-6 px-2">
        <SleepIndicator song={song} />
        <TuningIndicator song={song} />
        <GymIndicator />
        {/* En el PC la letra está siempre a la derecha: no hace falta el botón. */}
        {lyricsOn && !desktop && <LyricsButton mode={lyricsMode} onPress={cycleLyrics} />}
        {desktop && lyricsOn && (
          <Pressable
            onPress={() => setLyricsMode('full')}
            hitSlop={12}
            className="active:opacity-50"
            accessibilityLabel="Letra a pantalla completa"
          >
            <Ionicons name="expand" size={21} color="rgba(255,255,255,0.6)" />
          </Pressable>
        )}
        <Pressable onPress={() => router.push('/cola')} hitSlop={12} className="active:opacity-50" accessibilityLabel="A continuación">
          <Ionicons name="list" size={22} color="rgba(255,255,255,0.6)" />
        </Pressable>
      </View>
    </>
  );

  // PC: carátula y controles a la izquierda, letra a la derecha; con ratón se cierra con el botón (o Escape).
  if (desktop && !lyricsFullscreen) {
    const column = Math.min(480, Math.max(320, width * 0.36));
    // Lo que queda de alto tras la barra de reproducción, los márgenes y los controles (~400 px).
    const desktopArt = Math.max(120, Math.min(column, height - PLAYER_BAR_HEIGHT - 480));
    return (
      <View className="flex-1 bg-black overflow-hidden">
        <StatusBar style="light" />
        <AnimatedBackdrop artworkUrl={artworkUrl} playing={wantsToPlay} />
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="absolute left-5 top-5 z-10 w-10 h-10 rounded-full bg-white/15 items-center justify-center active:opacity-50"
          accessibilityLabel="Cerrar"
        >
          <Ionicons name="chevron-down" size={24} color="white" />
        </Pressable>
        <View className="flex-1 flex-row px-12 py-8 gap-12">
          <View style={{ width: column }} className="justify-center">
            <View className="items-center mb-8">
              <Animated.View style={{ width: desktopArt, height: desktopArt, transform: [{ scale }] }} className="rounded-2xl">
                <Artwork coverArt={song.coverArt} size={600} className="w-full h-full rounded-2xl" />
              </Animated.View>
            </View>
            {controls}
          </View>
          {lyricsOn && <View className="flex-1 py-4">{lyricsView}</View>}
        </View>
      </View>
    );
  }

  return (
    <GestureDetector gesture={dismissPan}>
      <Reanimated.View style={dragStyle} className="flex-1 bg-black overflow-hidden">
        <StatusBar style="light" hidden={lyricsFullscreen} />
        <AnimatedBackdrop artworkUrl={artworkUrl} playing={wantsToPlay} />

        {lyricsFullscreen ? (
          <View style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom }} className="flex-1 px-6">
            {/* Cabecera mínima: la canción, reproducir/pausar y salir de la pantalla completa. */}
            <View className="flex-row items-center gap-3">
              <Artwork coverArt={song.coverArt} size={120} className="w-12 h-12 rounded-md" />
              <View className="flex-1">
                <Marquee className="text-white text-base font-bold">{song.title}</Marquee>
                <Marquee className="text-white/65 text-sm">{subtitle}</Marquee>
              </View>
              <Pressable
                onPress={togglePlay}
                hitSlop={10}
                className="w-10 h-10 rounded-full bg-white/15 items-center justify-center active:opacity-50"
                accessibilityLabel={wantsToPlay ? 'Pausar' : 'Reproducir'}
              >
                {buffering && wantsToPlay ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <Ionicons name={wantsToPlay ? 'pause' : 'play'} size={20} color="white" />
                )}
              </Pressable>
              {!desktop && <LyricsButton mode="full" onPress={cycleLyrics} />}
              <Pressable
                onPress={() => setLyricsMode('inline')}
                hitSlop={10}
                className="w-10 h-10 rounded-full bg-white/15 items-center justify-center active:opacity-50"
                accessibilityLabel="Salir de pantalla completa"
              >
                <Ionicons name="contract" size={20} color="white" />
              </Pressable>
            </View>
            <View className="flex-1 mt-2">{lyricsView}</View>
          </View>
        ) : (
          <View style={{ paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 16) + 20 }} className="flex-1 px-8">
            {showLyrics ? (
              <View className="flex-1 my-3">{lyricsView}</View>
            ) : (
              // Con gestos, toda esta zona (no los botones) responde a deslizar, tocar, doble toque y mantener.
              <View className="flex-1">
              <GestureDetector gesture={feed.gesture}>
                <View collapsable={false} className="flex-1 items-center justify-center">
                  <Reanimated.View style={gestureMode ? feed.pageStyle : undefined}>
                    <Animated.View
                      style={{ width: artSize, height: artSize, transform: [{ scale }], elevation: 18 }}
                      className="rounded-2xl"
                    >
                      <Artwork coverArt={song.coverArt} size={600} className="w-full h-full rounded-2xl" />
                      {gestureMode && (buffering && wantsToPlay ? (
                        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                          <ActivityIndicator size="large" color="white" />
                        </View>
                      ) : !wantsToPlay ? (
                        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                          <View className="w-20 h-20 rounded-full bg-black/40 items-center justify-center">
                            <Ionicons name="play" size={44} color="white" style={{ marginLeft: 4 }} />
                          </View>
                        </View>
                      ) : null)}
                    </Animated.View>
                  </Reanimated.View>
                  {gestureMode && <FeedFeedback tapPulse={feed.tapPulse} burst={feed.burst} tapIcon={feed.tapIcon} />}
                </View>
              </GestureDetector>
              {/* Fuera del detector: sus toques y los Pressable no se excluyen entre sí. */}
              {gestureMode && modesOpen && (
                <Reanimated.View
                  entering={FadeIn.duration(160)}
                  exiting={FadeOut.duration(220)}
                  className="absolute bottom-2 left-0 right-0 flex-row justify-center gap-3"
                >
                  <ModePill icon="shuffle" active={shuffle} text="Aleatorio" onPress={() => pressMode(toggleShuffle)} label={shuffle ? 'Desactivar aleatorio' : 'Activar aleatorio'} />
                  <ModePill
                    icon="repeat"
                    active={repeatMode !== 'off'}
                    badge={repeatMode === 'one' ? '1' : undefined}
                    text={repeatMode === 'one' ? 'Repetir una' : repeatMode === 'all' ? 'Repetir todo' : 'Repetir'}
                    onPress={() => pressMode(cycleRepeat)}
                    label={repeatMode === 'off' ? 'Repetir todo' : repeatMode === 'all' ? 'Repetir una' : 'No repetir'}
                  />
                </Reanimated.View>
              )}
              </View>
            )}

            {controls}
          </View>
        )}
        {hint && gestureMode && !lyricsFullscreen && (
          <GestureHint
            onDismiss={closeHint}
            onUseButtons={() => {
              closeHint();
              void setPlayerControls('botones');
            }}
          />
        )}
      </Reanimated.View>
    </GestureDetector>
  );
}

/** Con velocidad o tono distintos de lo normal: «Sped up 1,25×»; tocarlo abre el ajuste. */
function TuningIndicator({ song }: { song: Song }) {
  const tuning = useTuning(song.id);
  if (isNormal(tuning)) return null;
  return (
    <Pressable
      onPress={() => openTuning(song)}
      hitSlop={10}
      className="flex-row items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 active:opacity-50"
      accessibilityLabel="Velocidad y tono"
    >
      <Ionicons name="speedometer" size={13} color="white" />
      <Text className="text-white text-xs font-semibold" numberOfLines={1}>{tuningLabel(tuning).replace('Personalizado ', '')}</Text>
    </Pressable>
  );
}

/** Con el temporizador de reposo activo: luna y tiempo restante; tocarlo abre las opciones. */
function SleepIndicator({ song }: { song: Song }) {
  const source = useSource();
  const timer = useSleepTimer();
  const remaining = useSleepRemaining(timer.endsAt);
  if (!isSleepTimerActive(timer)) return null;
  return (
    <Pressable
      onPress={() => openPlayerActions(source, song)}
      hitSlop={10}
      className="flex-row items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 active:opacity-50"
      accessibilityLabel="Temporizador de reposo"
    >
      <Ionicons name="moon" size={13} color="white" />
      <Text className="text-white text-xs font-semibold">{timer.endOfTrack ? 'Al terminar' : remaining}</Text>
    </Pressable>
  );
}

/** Con el volumen gradual subiendo: pesa y volumen actual → máximo; tocarlo permite detenerlo. */
function GymIndicator() {
  const gym = useGymRamp();
  if (!gym.active) return null;
  return (
    <Pressable
      onPress={() =>
        Alert.alert('Volumen gradual', describeGymRamp(gym), [
          { text: 'Seguir', style: 'cancel' },
          { text: 'Detener', style: 'destructive', onPress: () => void stopGymRamp() },
        ])
      }
      hitSlop={10}
      className="flex-row items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 active:opacity-50"
      accessibilityLabel="Volumen gradual"
    >
      <Ionicons name="barbell" size={13} color="white" />
      <Text className="text-white text-xs font-semibold">{gym.currentPercent} % → {gym.targetPercent} %</Text>
    </Pressable>
  );
}

/**
 * El único botón de la letra, que va pasando de paso: apagado (gris) → letra en el reproductor (píldora
 * clara, con un «ampliar» pequeño: el siguiente toque la pone a pantalla completa) → pantalla completa
 * (píldora clara con una «x» pequeña: el siguiente toque la oculta).
 */
function LyricsButton({ mode, onPress }: { mode: LyricsMode; onPress: () => void }) {
  const on = mode !== 'off';
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      className={`w-9 h-9 rounded-lg items-center justify-center active:opacity-50 ${on ? 'bg-white/90' : ''}`}
      accessibilityLabel={mode === 'off' ? 'Mostrar letra' : mode === 'inline' ? 'Letra a pantalla completa' : 'Ocultar letra'}
    >
      <Ionicons name="chatbox-ellipses" size={20} color={on ? 'black' : 'rgba(255,255,255,0.6)'} />
      {on && (
        <View className="absolute -right-1.5 -top-1.5 w-4 h-4 rounded-full bg-black items-center justify-center border border-white/80">
          <Ionicons name={mode === 'inline' ? 'expand' : 'close'} size={9} color="white" />
        </View>
      )}
    </Pressable>
  );
}

/** Botón de modo (aleatorio, repetición): píldora clara cuando está activo, como en Apple Music. */
function ModeButton({ icon, active, badge, onPress, label }: {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  badge?: string;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityLabel={label} className="active:opacity-50">
      <View className={`w-10 h-8 rounded-lg items-center justify-center ${active ? 'bg-white/90' : 'bg-white/10'}`}>
        <Ionicons name={icon} size={19} color={active ? 'black' : 'rgba(255,255,255,0.75)'} />
        {badge && <Text className="absolute right-1 top-0.5 text-black text-[9px] font-bold">{badge}</Text>}
      </View>
    </Pressable>
  );
}

/** Aleatorio o repetir en el modo con gestos: más grande que ModeButton y con su nombre, flotando sobre la carátula. */
function ModePill({ icon, active, badge, text, onPress, label }: {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  badge?: string;
  text: string;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={label} className="active:opacity-60">
      <View className={`h-11 px-4 rounded-full flex-row items-center gap-2 ${active ? 'bg-white' : 'bg-black/55'}`}>
        <View>
          <Ionicons name={icon} size={20} color={active ? 'black' : 'white'} />
          {badge && <Text className="absolute -right-1.5 -top-1 text-black text-[9px] font-bold">{badge}</Text>}
        </View>
        <Text className={`text-[15px] font-semibold ${active ? 'text-black' : 'text-white'}`}>{text}</Text>
      </View>
    </Pressable>
  );
}

/** Retroceder o adelantar unos segundos (episodios): la flecha circular con los segundos dentro. */
function JumpButton({ seconds, onPress }: { seconds: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={12} className="w-14 h-14 items-center justify-center active:opacity-50" accessibilityLabel={seconds < 0 ? `Retroceder ${-seconds} segundos` : `Adelantar ${seconds} segundos`}>
      <Ionicons name={seconds < 0 ? 'refresh' : 'reload'} size={48} color="white" style={seconds < 0 ? { transform: [{ scaleX: -1 }] } : undefined} />
      <Text className="absolute text-white text-[11px] font-bold">{Math.abs(seconds)}</Text>
    </Pressable>
  );
}
