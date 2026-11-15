import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, type PanGestureHandlerEventPayload } from 'react-native-gesture-handler';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ReorderableList, { useReorderableDrag } from 'react-native-reorderable-list';
import { scheduleOnRN } from 'react-native-worklets';
import { Artwork } from '@/components/Artwork';
import { useDesktop } from '@/components/desktop/layout';
import { useCloseWhenEmpty } from '@/components/player/useCloseWhenEmpty';
import { artistName, songCount } from '@/components/theme';
import { ListMarquee, Marquee } from '@/components/Marquee';
import {
  currentSong,
  moveInQueue,
  removeFromQueue,
  shuffleUpcoming,
  skipTo,
  usePlayer,
  type QueueEntry,
} from '@/player/store';

/** Deslizar hacia abajo más de esta fracción de la pantalla (o lanzar rápido) cierra la cola. */
const DISMISS_FRACTION = 0.2;
const DISMISS_VELOCITY = 900;

/**
 * "A continuación": la cola posterior a la canción actual, reordenable arrastrando el asa ≡.
 * Se cierra deslizando hacia abajo (como el reproductor): desde la cabecera siempre, y desde la lista
 * cuando está arriba del todo y no se está reordenando.
 */
export default function ColaScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const desktop = useDesktop();
  const dragY = useSharedValue(0);
  const listAtTop = useSharedValue(true);
  const reordering = useSharedValue(false);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const release = (e: PanGestureHandlerEventPayload) => {
    'worklet';
    if (e.translationY > height * DISMISS_FRACTION || e.velocityY > DISMISS_VELOCITY) {
      dragY.set(
        withTiming(height, { duration: 200 }, (finished) => {
          if (finished) scheduleOnRN(router.back);
        }),
      );
    } else {
      dragY.set(withSpring(0, { damping: 22, stiffness: 240 }));
    }
  };

  // La cabecera (asa, canción actual, "A continuación") no se desplaza: cualquier arrastre hacia abajo cierra.
  const headerPan = Gesture.Pan()
    .activeOffsetY(12)
    .failOffsetX([-20, 20])
    .onUpdate((e) => dragY.set(Math.max(0, e.translationY)))
    .onEnd(release);

  // Sobre la lista se decide a mano: si está desplazada, se arrastra hacia arriba o se está
  // reordenando, el gesto se rinde y la lista se comporta como siempre. Se activa con poco
  // recorrido (antes que el desplazamiento nativo, que lo cancelaría) y convive con el gesto
  // de reordenar de la lista, que se activa con cualquier movimiento.
  const reorderPan = Gesture.Pan();
  const listPan = Gesture.Pan()
    .manualActivation(true)
    .simultaneousWithExternalGesture(reorderPan)
    .onTouchesDown((e) => {
      // Un toque nuevo: si el anterior tomó el asa sin llegar a arrastrar, onDragEnd no llegó.
      reordering.set(false);
      startX.set(e.allTouches[0].absoluteX);
      startY.set(e.allTouches[0].absoluteY);
    })
    .onTouchesMove((e, state) => {
      const touch = e.allTouches[0];
      const dx = touch.absoluteX - startX.get();
      const dy = touch.absoluteY - startY.get();
      if (reordering.get() || !listAtTop.get() || Math.abs(dx) > 20 || dy < -6) state.fail();
      else if (dy > 6) state.activate();
    })
    .onUpdate((e) => dragY.set(Math.max(0, e.translationY)))
    .onEnd(release);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      listAtTop.set(e.contentOffset.y <= 0);
    },
  });
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.get() }] }));
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const song = usePlayer(currentSong);
  const upcoming = useMemo(() => queue.slice(index + 1), [queue, index]);
  const repeatMode = usePlayer((s) => s.repeatMode);
  // Con "Repetir todo", al terminar la última vuelve a empezar: se muestran también esas canciones.
  const wrapped = useMemo(() => (repeatMode === 'all' ? queue.slice(0, index + 1) : []), [queue, index, repeatMode]);

  useCloseWhenEmpty(!song);
  if (!song) return null;

  const panel = (
    <Animated.View style={[{ paddingTop: insets.top + 6 }, dragStyle]} className={`flex-1 bg-neutral-950 ${desktop ? 'border-l border-white/10' : ''}`}>
      <StatusBar style="light" />
      <GestureDetector gesture={headerPan}>
        <View collapsable={false}>
          <Pressable onPress={() => router.back()} hitSlop={16} className="self-center items-center active:opacity-50">
            <View className="w-10 h-1.5 rounded-full bg-white/30" />
            <Ionicons name="chevron-down" size={22} color="rgba(255,255,255,0.6)" />
          </Pressable>

          <Text className="text-white/60 text-xs font-semibold uppercase px-5 mt-2 mb-2">Reproduciendo</Text>
          <View className="flex-row items-center px-5 pb-4 border-b border-white/10">
            <Artwork coverArt={song.coverArt} size={56} className="w-14 h-14 rounded-lg" />
            <View className="flex-1 ml-3">
              <Marquee className="text-white text-base font-semibold">{song.title}</Marquee>
              <Marquee className="text-white/60 text-sm">{artistName(song.artist)}</Marquee>
            </View>
          </View>

          <View className="flex-row items-center justify-between px-5 pt-4 pb-2">
            <View>
              <Text className="text-white text-lg font-bold">A continuación</Text>
              <Text className="text-white/50 text-xs">
                {repeatMode === 'one'
                  ? 'Se repite la canción actual'
                  : upcoming.length === 0 && wrapped.length === 0
                    ? 'No hay más canciones'
                    : upcoming.length === 0
                      ? 'Es la última; luego vuelve a empezar'
                      : [songCount(upcoming.length), wrapped.length > 0 ? 'luego vuelve a empezar' : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <Pressable
              onPress={shuffleUpcoming}
              disabled={upcoming.length < 2}
              className={`flex-row items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ${upcoming.length < 2 ? 'opacity-40' : 'active:opacity-60'}`}
            >
              <Ionicons name="shuffle" size={16} color="white" />
              <Text className="text-white text-sm font-semibold">Mezclar</Text>
            </Pressable>
          </View>
        </View>
      </GestureDetector>

      <GestureDetector gesture={listPan}>
        <View collapsable={false} className="flex-1">
          <ReorderableList
            data={upcoming}
            keyExtractor={(e) => e.uid}
            onReorder={({ from, to }) => moveInQueue(index + 1 + from, index + 1 + to)}
            onScroll={onScroll}
        panGesture={reorderPan}
            onDragStart={() => {
              'worklet';
              reordering.set(true);
            }}
            onDragEnd={() => {
              'worklet';
              reordering.set(false);
            }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            ListFooterComponent={
              wrapped.length > 0 ? (
                <View>
                  <View className="flex-row items-center gap-1.5 px-5 pt-5 pb-2">
                    <Ionicons name="repeat" size={14} color="rgba(255,255,255,0.5)" />
                    <Text className="text-white/50 text-xs font-semibold uppercase">Al repetir</Text>
                  </View>
                  {wrapped.map((entry, i) => (
                    <RepeatRow key={entry.uid} entry={entry} current={i === index} onPress={() => skipTo(i)} />
                  ))}
                </View>
              ) : null
            }
            renderItem={({ item, index: i }) => (
              <QueueRow
                entry={item}
                onPress={() => skipTo(index + 1 + i)}
                onRemove={() => removeFromQueue(index + 1 + i)}
                // Al tocar el asa ya se sabe que viene un reordenado: el gesto de cerrar no debe adelantarse.
                onGrab={() => reordering.set(true)}
              />
            )}
          />
        </View>
      </GestureDetector>
    </Animated.View>
  );

  // PC: panel a la derecha sobre lo que había debajo; un clic fuera lo cierra.
  if (desktop) {
    return (
      <View className="flex-1 flex-row">
        <Pressable onPress={() => router.back()} className="flex-1 bg-black/30" accessibilityLabel="Cerrar la cola" />
        <View style={{ width: 420 }}>{panel}</View>
      </View>
    );
  }
  return panel;
}

/** Canción que sonará al volver a empezar la cola; tocarla salta a ella. */
function RepeatRow({ entry, current, onPress }: { entry: QueueEntry; current: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center pl-11 pr-4 active:bg-white/5">
      <Artwork coverArt={entry.coverArt} size={44} className="w-11 h-11 rounded-md ml-1 opacity-70" />
      <View className="flex-1 ml-3 py-2.5 border-b border-white/10">
        <ListMarquee always={current} className="text-white/80 text-base">{entry.title}</ListMarquee>
        <ListMarquee always={current} className="text-white/45 text-sm">{current ? 'Sonando ahora' : artistName(entry.artist)}</ListMarquee>
      </View>
    </Pressable>
  );
}

function QueueRow({ entry, onPress, onRemove, onGrab }: { entry: QueueEntry; onPress: () => void; onRemove: () => void; onGrab: () => void }) {
  const drag = useReorderableDrag();
  return (
    <Pressable onPress={onPress} className="flex-row items-center pl-2 pr-2 bg-neutral-950 active:bg-white/5">
      <Pressable onPress={onRemove} hitSlop={8} className="p-1.5 active:opacity-50">
        <Ionicons name="remove-circle" size={22} color="rgba(255,255,255,0.45)" />
      </Pressable>
      <Artwork coverArt={entry.coverArt} size={44} className="w-11 h-11 rounded-md ml-1" />
      <View className="flex-1 ml-3 py-2.5 border-b border-white/10">
        <ListMarquee className="text-white text-base">{entry.title}</ListMarquee>
        <ListMarquee className="text-white/55 text-sm">{artistName(entry.artist)}</ListMarquee>
      </View>
      <Pressable
        onPressIn={() => {
          onGrab();
          drag();
        }}
        hitSlop={8}
        className="p-2"
      >
        <Ionicons name="reorder-three" size={26} color="rgba(255,255,255,0.5)" />
      </Pressable>
    </Pressable>
  );
}
