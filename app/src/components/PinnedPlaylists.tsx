import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useScrollViewOffset,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { usePlaylists } from '@/api/queries';
import { queryClient } from '@/api/queryClient';
import { isFavoritesPlaylist, useEnsureFavoritesPlaylist } from '@/library/favorites';
import { FAVORITES_PIN, reorderPins, setPinAction, unpin, usePinActions, usePins, type PinAction } from '@/library/pins';
import { playSongs } from '@/player/store';
import { sourceKey, useSource, type MusicSource, type Playlist } from '@/sources';
import { PlaylistArt } from './rows';
import { closeSheet, showSheet } from './sheets/store';
import { sortPlaylistSongs } from './SongFilter';
import { useThemeColor } from './theme';
import { showToast } from './Toast';
import { ListMarquee } from '@/components/Marquee';

const TILE = 128;
const GAP = 12;
const SLOT = TILE + GAP;
const PAD = 20;
const TOP = 8;
const HEIGHT = TOP + TILE + 30;
/** Fase 1: lo que hay que mantener pulsado para que la carátula se levante. */
const LIFT_MS = 500;
/** Con las carátulas temblando basta un toque largo corto para volver a arrastrar. */
const EDIT_LIFT_MS = 200;
/** Lo que hay que mover el dedo, ya levantada, para que sea un arrastre y no el menú. */
const MOVE_THRESHOLD = 8;
/** Arrastrando cerca de un borde, la fila se desplaza sola. */
const EDGE = 56;
const EDGE_SPEED = 9;
const SPRING = { damping: 20, stiffness: 240 };

const ACTION_LABELS: Record<PinAction, string> = { open: 'Abrir', play: 'Reproducir', shuffle: 'Aleatorio' };
const ACTION_ICONS: Record<PinAction, keyof typeof Ionicons.glyphMap> = { open: 'open-outline', play: 'play', shuffle: 'shuffle' };

const haptic = (type: Haptics.AndroidHaptics) => void Haptics.performAndroidHapticsAsync(type).catch(() => {});

type Pinned = { pin: string; playlist: Playlist };

/** Reproduce una playlist sin abrirla: en el orden que el usuario guardó para ella o en aleatorio. */
export async function playPinned(source: MusicSource, playlist: Playlist, shuffle: boolean) {
  try {
    const full = await queryClient.fetchQuery({
      queryKey: sourceKey(source, 'playlist', playlist.id),
      queryFn: () => source.getPlaylist(playlist.id),
    });
    const songs = full.entry ?? [];
    if (songs.length === 0) return showToast('La playlist está vacía', 'alert-circle');
    await (shuffle ? playSongs(songs, 0, { shuffle: true }) : playSongs(sortPlaylistSongs(playlist.id, songs), 0, { shuffle: false }));
  } catch {
    showToast('No se pudo reproducir la playlist', 'alert-circle');
  }
}

/**
 * Acceso rápido a las playlists fijadas, arriba de la Biblioteca.
 *
 * Tocar una hace su "acción al tocar" (abrirla, reproducirla o en aleatorio). Mantenerla pulsada la
 * levanta (escala y vibración) y entonces:
 * - si se suelta sin mover el dedo, aparece su menú;
 * - si se mueve, sigue al dedo para reordenarla y todas tiemblan, como los iconos de iOS, con un "−"
 *   rojo para dejar de fijarlas. "Listo" (o tocar una carátula) termina.
 */
export function PinnedPlaylists() {
  const source = useSource();
  const pins = usePins();
  const actions = usePinActions();
  const playlists = usePlaylists();
  useEnsureFavoritesPlaylist(playlists.data);
  const { width: screenWidth } = useWindowDimensions();
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const all = playlists.data ?? [];
  const pinned = pins
    .map((pin) => ({ pin, playlist: pin === FAVORITES_PIN ? all.find((p) => isFavoritesPlaylist(p, source)) : all.find((p) => p.id === pin) }))
    .filter((x): x is Pinned => !!x.playlist);
  const order = pinned.map((x) => x.pin).join('\n');
  const count = pinned.length;

  // Posición (índice) de cada carátula: el arrastre la cambia en el hilo de UI sin pasar por React.
  const positions = useSharedValue<Record<string, number>>(Object.fromEntries(pinned.map((x, i) => [x.pin, i])));
  useEffect(() => {
    positions.set(Object.fromEntries(order.split('\n').map((pin, i) => [pin, i])));
  }, [order, positions]);

  // Estado del arrastre (solo hay uno a la vez).
  const active = useSharedValue<string | null>(null);
  const moved = useSharedValue(false);
  const startX = useSharedValue(0);
  const startScroll = useSharedValue(0);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const fingerX = useSharedValue(0);
  const dragX = useSharedValue(0);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollX = useScrollViewOffset(scrollRef);
  const contentWidth = PAD * 2 + count * SLOT - GAP + (editing ? SLOT : 0);
  const maxScroll = Math.max(0, contentWidth - screenWidth);

  // Cada fotograma del arrastre: desplaza la fila si el dedo está en un borde, coloca la carátula bajo
  // el dedo y, si pasa la mitad de otra, intercambia sus sitios.
  const frame = useFrameCallback(() => {
    const key = active.get();
    if (key === null || !moved.get()) return;
    let scroll = scrollX.get();
    const finger = fingerX.get();
    const step = finger < EDGE ? -EDGE_SPEED : finger > screenWidth - EDGE ? EDGE_SPEED : 0;
    if (step !== 0) {
      const next = Math.min(maxScroll, Math.max(0, scroll + step));
      if (next !== scroll) {
        scrollTo(scrollRef, next, 0, false);
        scroll = next;
      }
    }
    const x = startX.get() + tx.get() + (scroll - startScroll.get());
    dragX.set(x);
    const map = positions.get();
    const from = map[key];
    const to = Math.min(count - 1, Math.max(0, Math.round(x / SLOT)));
    if (from === undefined || to === from) return;
    const next: Record<string, number> = {};
    for (const [pin, pos] of Object.entries(map)) {
      if (pin === key) next[pin] = to;
      else if (from < to && pos > from && pos <= to) next[pin] = pos - 1;
      else if (from > to && pos >= to && pos < from) next[pin] = pos + 1;
      else next[pin] = pos;
    }
    positions.set(next);
    scheduleOnRN(haptic, Haptics.AndroidHaptics.Segment_Tick);
  }, false);

  useEffect(() => {
    frame.setActive(dragging);
  }, [dragging, frame]);

  // Si la fila se acorta (se quitó una fijada o terminó la edición), no queda un hueco al final.
  useEffect(() => {
    if (scrollX.get() > maxScroll) scrollRef.current?.scrollTo({ x: maxScroll, animated: true });
  }, [maxScroll, scrollX, scrollRef]);

  // Al salir de la Biblioteca se deja de editar.
  useFocusEffect(useCallback(() => () => setEditing(false), []));

  if (count === 0) return null;

  const open = (p: Playlist) => router.push({ pathname: '/biblioteca/playlist/[id]', params: { id: p.id } });

  const tap = (item: Pinned) => {
    if (editing) return setEditing(false);
    const action = actions[item.pin] ?? 'open';
    if (action === 'open') open(item.playlist);
    else void playPinned(source, item.playlist, action === 'shuffle');
  };

  const chooseAction = (item: Pinned) => {
    const current = actions[item.pin] ?? 'open';
    showSheet({
      kind: 'actions',
      title: 'Acción al tocar',
      subtitle: item.playlist.name,
      coverArt: item.playlist.coverArt,
      options: (['open', 'play', 'shuffle'] as const).map((action) => ({
        label: action === 'play' ? 'Reproducir (en tu orden)' : ACTION_LABELS[action],
        icon: action === current ? 'checkmark-circle' : ACTION_ICONS[action],
        onPress: () => (closeSheet(), setPinAction(item.pin, action)),
      })),
    });
  };

  const menu = (item: Pinned) => {
    const current = actions[item.pin] ?? 'open';
    showSheet({
      kind: 'actions',
      title: item.playlist.name,
      coverArt: item.playlist.coverArt,
      options: [
        { label: 'Abrir', icon: 'open-outline', onPress: () => (closeSheet(), open(item.playlist)) },
        { label: `Acción al tocar: ${ACTION_LABELS[current]}`, icon: 'hand-left-outline', onPress: () => chooseAction(item) },
        { label: 'Dejar de fijar', icon: 'pin-outline', onPress: () => (closeSheet(), unpin(item.pin)) },
      ],
    });
  };

  /** Al soltar tras arrastrar: guarda el nuevo orden. */
  const commit = (map: Record<string, number>) => {
    reorderPins(Object.keys(map).sort((a, b) => map[a] - map[b]));
    setDragging(false);
  };

  const drag: DragState = { active, moved, startX, startScroll, tx, ty, fingerX, dragX, positions, scrollX };

  return (
    <Animated.ScrollView
      ref={scrollRef}
      horizontal
      scrollEnabled={!dragging}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ width: contentWidth, height: HEIGHT }}
    >
      {pinned.map((item, i) => (
        <PinnedTile
          key={item.pin}
          item={item}
          index={i}
          action={actions[item.pin] ?? 'open'}
          editing={editing}
          drag={drag}
          onTap={() => tap(item)}
          onLift={() => {
            haptic(Haptics.AndroidHaptics.Long_Press);
            setDragging(true);
          }}
          onDragStart={() => {
            haptic(Haptics.AndroidHaptics.Drag_Start);
            setEditing(true);
          }}
          onMenu={() => {
            setDragging(false);
            if (!editing) menu(item);
          }}
          onDrop={commit}
          onRemove={() => {
            // Sin fijadas no queda nada que ordenar.
            if (count === 1) setEditing(false);
            unpin(item.pin);
          }}
        />
      ))}
      {editing && (
        <Pressable
          onPress={() => setEditing(false)}
          style={{ position: 'absolute', left: PAD + count * SLOT, top: TOP + TILE / 2 - 18 }}
          className="h-9 px-4 rounded-full bg-accent items-center justify-center active:opacity-70"
          accessibilityLabel="Terminar de ordenar"
        >
          <Text className="text-white text-sm font-semibold">Listo</Text>
        </Pressable>
      )}
    </Animated.ScrollView>
  );
}

type DragState = {
  active: SharedValue<string | null>;
  moved: SharedValue<boolean>;
  startX: SharedValue<number>;
  startScroll: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  fingerX: SharedValue<number>;
  dragX: SharedValue<number>;
  positions: SharedValue<Record<string, number>>;
  scrollX: SharedValue<number>;
};

function PinnedTile({ item, index, action, editing, drag, onTap, onLift, onDragStart, onMenu, onDrop, onRemove }: {
  item: Pinned;
  index: number;
  action: PinAction;
  editing: boolean;
  drag: DragState;
  onTap: () => void;
  onLift: () => void;
  onDragStart: () => void;
  onMenu: () => void;
  onDrop: (positions: Record<string, number>) => void;
  onRemove: () => void;
}) {
  const { pin, playlist } = item;
  const { active, moved, startX, startScroll, tx, ty, fingerX, dragX, positions, scrollX } = drag;
  const background = useThemeColor('background');
  const x = useSharedValue(index * SLOT);
  const lift = useSharedValue(1);
  const pressed = useSharedValue(false);
  const wobble = useSharedValue(0);

  // Las demás se apartan con un muelle cuando la arrastrada pasa por encima.
  useAnimatedReaction(
    () => positions.get()[pin],
    (pos, prev) => {
      if (pos === undefined || (active.get() === pin && moved.get())) return;
      x.set(prev === null || prev === undefined ? pos * SLOT : withSpring(pos * SLOT, SPRING));
    },
  );

  // Temblor de iOS: cada carátula empieza en un momento distinto para que no vayan al unísono.
  useEffect(() => {
    if (!editing) {
      wobble.set(withTiming(0, { duration: 120 }));
      return;
    }
    const phase = Math.random() * 120;
    wobble.set(
      withDelay(phase, withRepeat(withSequence(withTiming(-1.8, { duration: 115 }), withTiming(1.8, { duration: 115 })), -1, true)),
    );
  }, [editing, wobble]);

  const pan = Gesture.Pan()
    .activateAfterLongPress(editing ? EDIT_LIFT_MS : LIFT_MS)
    .onBegin(() => {
      pressed.set(true);
    })
    .onStart((e) => {
      // Fase 1: la carátula se levanta.
      active.set(pin);
      moved.set(false);
      startX.set((positions.get()[pin] ?? index) * SLOT);
      startScroll.set(scrollX.get());
      tx.set(0);
      ty.set(0);
      fingerX.set(e.absoluteX);
      lift.set(withSpring(1.08, SPRING));
      scheduleOnRN(onLift);
    })
    .onUpdate((e) => {
      tx.set(e.translationX);
      ty.set(e.translationY);
      fingerX.set(e.absoluteX);
      // Fase 2: si el dedo se mueve, es un arrastre (el menú ya no aparecerá).
      if (!moved.get() && Math.hypot(e.translationX, e.translationY) > MOVE_THRESHOLD) {
        moved.set(true);
        dragX.set(startX.get());
        scheduleOnRN(onDragStart);
      }
    })
    .onEnd(() => {
      if (moved.get()) scheduleOnRN(onDrop, positions.get());
      else scheduleOnRN(onMenu);
    })
    .onFinalize(() => {
      pressed.set(false);
      if (active.get() === pin) {
        if (moved.get()) {
          x.set(dragX.get());
          x.set(withSpring((positions.get()[pin] ?? index) * SLOT, SPRING));
        }
        active.set(null);
        moved.set(false);
      }
      lift.set(withSpring(1, SPRING));
    });

  const tapGesture = Gesture.Tap()
    .maxDuration(LIFT_MS - 50)
    .maxDistance(10)
    .onEnd((_e, success) => {
      if (success) scheduleOnRN(onTap);
    });

  const style = useAnimatedStyle(() => {
    const dragged = active.get() === pin && moved.get();
    return {
      zIndex: active.get() === pin ? 10 : 0,
      opacity: pressed.get() && active.get() !== pin ? 0.75 : 1,
      transform: [
        { translateX: dragged ? dragX.get() : x.get() },
        { translateY: dragged ? ty.get() : 0 },
        { scale: lift.get() },
        { rotate: `${active.get() === pin ? 0 : wobble.get()}deg` },
      ],
    };
  });

  return (
    <Animated.View style={[{ position: 'absolute', left: PAD, top: TOP, width: TILE }, style]}>
      <GestureDetector gesture={Gesture.Race(pan, tapGesture)}>
        <View collapsable={false}>
          <PlaylistArt playlist={playlist} size={TILE} className="w-32 h-32 rounded-xl" />
          <ListMarquee rowHeight={170} className="text-foreground text-sm" containerClassName="mt-1.5">{playlist.name}</ListMarquee>
          {!editing && action !== 'open' && (
            <View className="absolute right-2 bottom-9 w-7 h-7 rounded-full bg-black/60 items-center justify-center" pointerEvents="none">
              <Ionicons name={ACTION_ICONS[action]} size={15} color="white" />
            </View>
          )}
        </View>
      </GestureDetector>
      {editing && (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={{ position: 'absolute', left: 6, top: 6, borderColor: background }}
          className="w-7 h-7 rounded-full bg-red-500 border-2 items-center justify-center active:opacity-70"
          accessibilityLabel={`Dejar de fijar ${playlist.name}`}
        >
          <Ionicons name="remove" size={18} color="white" />
        </Pressable>
      )}
    </Animated.View>
  );
}
