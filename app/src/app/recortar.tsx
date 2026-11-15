import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ImpalaPlayer from '../../modules/impala-player';
import { invalidateLibrary, queryClient } from '@/api/queryClient';
import { useTrimInfo, useWaveform } from '@/api/trim';
import { sourceKey, useSource, type Song } from '@/sources';
import { Artwork } from '@/components/Artwork';
import { ErrorState, Loading } from '@/components/states';
import { artistName, useThemeColor } from '@/components/theme';
import { showToast } from '@/components/Toast';
import {
  addCut,
  formatTime,
  keptDuration,
  keptRanges,
  markerTime,
  moveMarker,
  previewStart,
  previewToOriginal,
  removeCut,
  sameMarker,
  type Marker,
  type TrimState,
} from '@/components/trim/ranges';
import { downloadSongs, isDownloaded, removeDownload } from '@/offline/store';
import { stopPreview as stopYoutubePreview } from '@/player/preview';
import { isCurrentSong, isPlaying, reloadSong } from '@/player/store';
import { Marquee } from '@/components/Marquee';

/** Navidrome tarda unos segundos en ver el archivo nuevo; después se refresca la biblioteca. */
const LIBRARY_REFRESH_DELAY_MS = 5000;
const WAVE_HEIGHT = 120;

/**
 * Recortar una canción: arrastrar el inicio y el final para quitar la intro o el final y añadir
 * cortes intermedios (un tramo A–B que se quita; lo de después se junta con lo de antes). "Escuchar"
 * reproduce solo lo que se conserva, para oír las uniones antes de guardar. Guardar sobrescribe el
 * archivo (en el servidor o en el teléfono); el original queda guardado y se puede restaurar desde aquí.
 */
export default function RecortarScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const source = useSource();
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const song = useQuery({ queryKey: sourceKey(source, 'song', id), queryFn: () => source.getSong(id) });
  const info = useTrimInfo(id);
  const peaks = useWaveform(id);

  if (info.isError || song.isError) {
    const error = info.error ?? song.error;
    return (
      <View style={{ paddingTop: insets.top }} className="flex-1 bg-background">
        <Header onClose={() => router.back()} />
        <ErrorState error={error} onRetry={() => (info.refetch(), song.refetch())} />
      </View>
    );
  }
  if (!info.data || !song.data) {
    return (
      <View style={{ paddingTop: insets.top }} className="flex-1 bg-background">
        <Header onClose={() => router.back()} />
        <Loading />
      </View>
    );
  }
  return (
    <Editor
      // Tras guardar o restaurar cambia la duración: el editor empieza de cero con la canción nueva.
      key={info.data.duration}
      song={song.data}
      duration={info.data.duration}
      info={info.data}
      peaks={peaks.data ?? null}
      accent={accent}
      onChanged={() => {
        void info.refetch();
        void peaks.refetch();
        void song.refetch();
      }}
    />
  );
}

function Header({ onClose, right }: { onClose: () => void; right?: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between px-5 py-3">
      <Pressable onPress={onClose} hitSlop={12} className="active:opacity-50">
        <Text className="text-accent text-base">Cancelar</Text>
      </Pressable>
      <Text className="text-foreground text-base font-semibold">Recortar</Text>
      <View className="min-w-16 items-end">{right}</View>
    </View>
  );
}

function Editor({ song, duration, info, peaks, accent, onChanged }: {
  song: Song;
  duration: number;
  info: NonNullable<ReturnType<typeof useTrimInfo>['data']>;
  peaks: number[] | null;
  accent: string;
  onChanged: () => void;
}) {
  const source = useSource();
  const insets = useSafeAreaInsets();
  const [trim, setTrim] = useState<TrimState>({ start: 0, end: duration, cuts: [] });
  const [selected, setSelected] = useState<Marker | null>({ kind: 'start' });
  const [width, setWidth] = useState(0);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ playing: boolean; at: number | null }>({ playing: false, at: null });
  const pausedMain = useRef(false);
  // Los tramos con los que se lanzó la vista previa: sus eventos se traducen con ellos.
  const previewTrim = useRef<TrimState | null>(null);

  const changed = trim.start > 0 || trim.end < duration || trim.cuts.length > 0;
  const result = keptDuration(trim);

  // --- Vista previa -------------------------------------------------------------------------------

  const stop = useCallback(() => {
    previewTrim.current = null;
    ImpalaPlayer.stopPreview().catch(() => {});
    setPreview({ playing: false, at: null });
  }, []);

  useEffect(() => {
    const sub = ImpalaPlayer.addListener('onPreview', (e) => {
      const t = previewTrim.current;
      if (!t) return;
      if (e.state === 'ended' || e.state === 'error' || e.state === 'stopped') {
        previewTrim.current = null;
        setPreview({ playing: false, at: null });
        if (e.state === 'error') showToast('No se pudo reproducir la canción', 'alert-circle');
        return;
      }
      setPreview({ playing: true, at: previewToOriginal(t, e.itemIndex ?? 0, e.positionMs ?? 0) });
    });
    return () => {
      sub.remove();
      ImpalaPlayer.stopPreview().catch(() => {});
      // La música que sonaba antes de entrar sigue donde estaba.
      if (pausedMain.current) ImpalaPlayer.play().catch(() => {});
    };
  }, []);

  const listen = async (from: Marker | null) => {
    stopYoutubePreview();
    if (isPlaying()) {
      pausedMain.current = true;
      await ImpalaPlayer.pause().catch(() => {});
    }
    const clips = keptRanges(trim).map(([a, b]) => [Math.round(a * 1000), Math.round(b * 1000)] as [number, number]);
    const { index, positionMs } = previewStart(trim, from ? markerTime(trim, from) : null);
    previewTrim.current = trim;
    setPreview({ playing: true, at: null });
    await ImpalaPlayer.startPreviewClips(source.streamUrl(song.id, 'original'), clips, index, positionMs).catch(() => stop());
  };

  // Cambiar las marcas invalida lo que suena.
  const update = (next: TrimState) => {
    if (previewTrim.current) stop();
    setTrim(next);
  };

  // --- Marcas ---------------------------------------------------------------------------------------

  const nudge = (delta: number) => selected && update(moveMarker(trim, selected, markerTime(trim, selected) + delta, duration));

  const addIntermediateCut = () => {
    // Donde va sonando la vista previa; si no suena nada, en el centro del tramo más largo.
    const added = addCut(trim, preview.at);
    if (!added) return showToast('No hay sitio para otro corte en esa parte', 'alert-circle');
    update(added.state);
    setSelected({ kind: 'cut', index: added.index, edge: 0 });
  };

  const removeSelectedCut = () => {
    if (selected?.kind !== 'cut') return;
    update(removeCut(trim, selected.index));
    setSelected({ kind: 'start' });
  };

  // --- Guardar y restaurar ----------------------------------------------------------------------------

  // Si suena esta canción, se pausa mientras se sobrescribe su archivo (vuelve a sonar al salir del editor).
  const holdMain = async () => {
    if (isCurrentSong(song.id) && isPlaying()) {
      pausedMain.current = true;
      await ImpalaPlayer.pause().catch(() => {});
    }
  };

  const afterChange = (message: string) => {
    showToast(message, 'cut');
    // La descarga del teléfono es el archivo anterior: se vuelve a bajar.
    const downloaded = isDownloaded(song.id);
    if (downloaded) removeDownload(song.id);
    // El reproductor tenía abierto el archivo anterior: se vuelve a abrir (si no, audio corrupto).
    void reloadSong(song).catch(() => {});
    if (downloaded) downloadSongs(source, [song]);
    void queryClient.invalidateQueries({ queryKey: sourceKey(source, 'lyrics', song.id) });
    setTimeout(() => invalidateLibrary(source), LIBRARY_REFRESH_DELAY_MS);
    onChanged();
  };

  const save = () => {
    const removed = duration - result;
    Alert.alert(
      'Guardar el recorte',
      `Se quitarán ${formatTime(removed)} de «${song.title}» (quedará en ${formatTime(result)}) y se sobrescribirá el archivo${source.kind === 'local' ? '' : ' en el servidor'}. ` +
        (info.backup ? 'El original sigue guardado: puedes restaurarlo desde aquí.' : 'Se guarda una copia del original para poder restaurarlo desde aquí.'),
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Recortar',
          style: 'destructive',
          onPress: async () => {
            stop();
            setSaving(true);
            try {
              await holdMain();
              await source.trim(song.id, keptRanges(trim));
              afterChange('Canción recortada');
            } catch (e) {
              Alert.alert('No se pudo recortar', e instanceof Error ? e.message : undefined);
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  };

  const restore = () =>
    Alert.alert('Restaurar el original', `«${song.title}» vuelve a como estaba antes del primer recorte (${formatTime(info.backup!.duration)}).`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar',
        onPress: async () => {
          stop();
          setSaving(true);
          try {
            await holdMain();
            await source.restore(song.id);
            afterChange('Se restauró el original');
          } catch (e) {
            Alert.alert('No se pudo restaurar', e instanceof Error ? e.message : undefined);
          } finally {
            setSaving(false);
          }
        },
      },
    ]);

  const x = (t: number) => (t / duration) * width;
  const selectedTime = selected ? markerTime(trim, selected) : null;
  const selectedLabel = !selected
    ? ''
    : selected.kind === 'start'
      ? 'Inicio'
      : selected.kind === 'end'
        ? 'Final'
        : `Corte ${selected.index + 1} · ${selected.edge === 0 ? 'desde' : 'hasta'}`;

  return (
    <View style={{ paddingTop: insets.top }} className="flex-1 bg-background">
      <Header
        onClose={() => router.back()}
        right={
          saving ? (
            <ActivityIndicator color={accent} />
          ) : (
            <Pressable onPress={save} disabled={!changed || !info.canTrim || !info.admin} hitSlop={12} className="active:opacity-50">
              <Text className={`text-base font-semibold ${changed && info.canTrim && info.admin ? 'text-accent' : 'text-muted'}`}>Guardar</Text>
            </Pressable>
          )
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View className="flex-row items-center px-5 pb-4">
          <Artwork coverArt={song.coverArt} size={112} className="w-14 h-14 rounded-lg" />
          <View className="flex-1 ml-3">
            <Marquee className="text-foreground text-base font-semibold">{song.title}</Marquee>
            <Marquee className="text-muted text-sm">{artistName(song.artist)}</Marquee>
          </View>
        </View>

        {!info.admin ? (
          <Notice icon="lock-closed-outline" text="Solo un administrador del servidor puede recortar canciones." />
        ) : !info.canTrim ? (
          <Notice icon="alert-circle-outline" text={`Este archivo (${info.codec.toUpperCase()}) no se puede recortar.`} />
        ) : null}

        {/* Forma de onda con las marcas. */}
        <View className="mx-5 mt-2" style={{ height: WAVE_HEIGHT + 28 }} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
          {width > 0 && (
            <>
              <View style={{ position: 'absolute', top: 14, left: 0, right: 0, height: WAVE_HEIGHT }}>
                {peaks ? <Waveform peaks={peaks} color={accent} /> : <View className="flex-1 items-center justify-center"><ActivityIndicator color={accent} /></View>}
                {/* Lo que se quita, atenuado: antes del inicio, después del final y los cortes. */}
                <Shade left={0} width={x(trim.start)} />
                <Shade left={x(trim.end)} width={width - x(trim.end)} />
                {trim.cuts.map(([a, b], i) => (
                  <Pressable
                    key={i}
                    onPress={() => setSelected({ kind: 'cut', index: i, edge: 0 })}
                    style={{ position: 'absolute', top: 0, bottom: 0, left: x(a), width: x(b) - x(a) }}
                    className="bg-red-500/35 items-center justify-center"
                  >
                    <Ionicons name="cut" size={14} color="white" />
                  </Pressable>
                ))}
                {preview.at !== null && <View pointerEvents="none" style={{ position: 'absolute', top: -6, bottom: -6, left: x(preview.at) - 1, width: 2 }} className="bg-foreground" />}
              </View>
              <Handle t={trim.start} x={x} marker={{ kind: 'start' }} {...{ trim, duration, width, selected, setSelected, update, color: accent }} />
              <Handle t={trim.end} x={x} marker={{ kind: 'end' }} {...{ trim, duration, width, selected, setSelected, update, color: accent }} />
              {trim.cuts.flatMap(([a, b], i) => [
                <Handle key={`${i}a`} t={a} x={x} marker={{ kind: 'cut', index: i, edge: 0 }} {...{ trim, duration, width, selected, setSelected, update, color: '#ef4444' }} />,
                <Handle key={`${i}b`} t={b} x={x} marker={{ kind: 'cut', index: i, edge: 1 }} {...{ trim, duration, width, selected, setSelected, update, color: '#ef4444' }} />,
              ])}
            </>
          )}
        </View>
        <View className="flex-row justify-between mx-5 mt-1">
          <Text className="text-muted text-xs">0:00</Text>
          <Text className="text-muted text-xs">{formatTime(duration)}</Text>
        </View>

        {/* Ajuste fino de la marca elegida. */}
        {selected && selectedTime !== null && (
          <View className="mx-5 mt-5 rounded-xl bg-card px-4 py-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-muted text-sm">{selectedLabel}</Text>
              <Text className="text-foreground text-lg font-semibold" style={{ fontVariant: ['tabular-nums'] }}>{formatTime(selectedTime)}</Text>
            </View>
            <View className="flex-row justify-between mt-3">
              {[-1, -0.1, 0.1, 1].map((d) => (
                <Pressable key={d} onPress={() => nudge(d)} className="px-4 py-2 rounded-lg bg-background active:opacity-60">
                  <Text className="text-foreground text-sm font-semibold">{d > 0 ? '+' : '−'}{Math.abs(d)} s</Text>
                </Pressable>
              ))}
            </View>
            <View className="flex-row gap-3 mt-3">
              <Pressable onPress={() => listen(selected)} className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg bg-background py-2 active:opacity-60">
                <Ionicons name="ear-outline" size={16} color={accent} />
                <Text className="text-accent text-sm font-semibold">Escuchar aquí</Text>
              </Pressable>
              {selected.kind === 'cut' && (
                <Pressable onPress={removeSelectedCut} className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg bg-background py-2 active:opacity-60">
                  <Ionicons name="trash-outline" size={16} color={accent} />
                  <Text className="text-accent text-sm font-semibold">Quitar corte</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        <View className="flex-row gap-3 mx-5 mt-4">
          <Pressable
            onPress={() => (preview.playing ? stop() : listen(null))}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-card py-3 active:opacity-60"
          >
            <Ionicons name={preview.playing ? 'stop' : 'play'} size={18} color={accent} />
            <Text className="text-accent text-base font-semibold">{preview.playing ? 'Detener' : 'Escuchar'}</Text>
          </Pressable>
          <Pressable onPress={addIntermediateCut} className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-card py-3 active:opacity-60">
            <Ionicons name="cut-outline" size={18} color={accent} />
            <Text className="text-accent text-base font-semibold">Añadir corte</Text>
          </Pressable>
        </View>

        <View className="mx-5 mt-5 gap-1">
          <Text className="text-foreground text-sm">
            Quedará en <Text className="font-semibold">{formatTime(result)}</Text> de {formatTime(duration)}
            {changed ? ` (se quitan ${formatTime(duration - result)})` : ''}
          </Text>
          <Text className="text-muted text-xs">
            Arrastra las marcas para quitar la intro o el final. «Añadir corte» quita un trozo intermedio: lo que hay después se
            junta con lo de antes. «Escuchar» reproduce solo lo que se conserva.
            {info.method === 'copy'
              ? ' Este formato se corta sin recodificar (sin perder calidad): el corte puede desviarse unas décimas de segundo.'
              : ' Este formato se corta sin pérdida y con precisión exacta.'}
          </Text>
        </View>

        {info.backup && info.admin && (
          <Pressable onPress={restore} disabled={saving} className="mx-5 mt-6 flex-row items-center gap-2 active:opacity-60">
            <Ionicons name="arrow-undo-outline" size={18} color={accent} />
            <Text className="text-accent text-base">Restaurar el original ({formatTime(info.backup.duration)})</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

function Notice({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const muted = useThemeColor('muted');
  return (
    <View className="mx-5 mb-3 flex-row items-center gap-2 rounded-xl bg-card px-4 py-3">
      <Ionicons name={icon} size={18} color={muted} />
      <Text className="flex-1 text-muted text-sm">{text}</Text>
    </View>
  );
}

function Shade({ left, width }: { left: number; width: number }) {
  if (width <= 0) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left, width }} className="bg-background/75" />;
}

/** Barras de la forma de onda; no cambia al mover las marcas. */
const Waveform = memo(function Waveform({ peaks, color }: { peaks: number[]; color: string }) {
  return (
    <View className="flex-1 flex-row items-center">
      {peaks.map((p, i) => (
        <View key={i} style={{ flex: 1, height: Math.max(2, p * WAVE_HEIGHT), backgroundColor: color, opacity: 0.85, marginHorizontal: 0.25 }} />
      ))}
    </View>
  );
});

/** Marca arrastrable (inicio, final o borde de un corte): una línea con un asa arriba. */
function Handle({ t, x, marker, trim, duration, width, selected, setSelected, update, color }: {
  t: number;
  x: (t: number) => number;
  marker: Marker;
  trim: TrimState;
  duration: number;
  width: number;
  selected: Marker | null;
  setSelected: (m: Marker) => void;
  update: (s: TrimState) => void;
  color: string;
}) {
  // Dónde estaba la marca al empezar a arrastrarla.
  const startT = useSharedValue(t);
  const active = sameMarker(selected, marker);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin(() => {
      startT.set(t);
      setSelected(marker);
    })
    .onUpdate((e) => update(moveMarker(trim, marker, startT.get() + (e.translationX / width) * duration, duration)));

  return (
    <GestureDetector gesture={pan}>
      <View style={{ position: 'absolute', top: 0, bottom: 0, left: x(t) - 16, width: 32 }} className="items-center">
        <View style={{ width: active ? 18 : 14, height: 14, borderRadius: 4, backgroundColor: color, opacity: active ? 1 : 0.85 }} />
        <View style={{ width: active ? 3 : 2, flex: 1, backgroundColor: color }} />
      </View>
    </GestureDetector>
  );
}
