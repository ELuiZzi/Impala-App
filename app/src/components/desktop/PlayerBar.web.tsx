import Ionicons from '@expo/vector-icons/Ionicons';
import { router, usePathname } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Artwork } from '@/components/Artwork';
import { openPlayerActions } from '@/components/sheets/songActions';
import { artistName, formatDuration, useThemeColor } from '@/components/theme';
import { toggleFavorite, useIsFavorite } from '@/library/favorites';
import { currentSong, cycleRepeat, next, previous, seekTo, togglePlay, toggleShuffle, usePlayer } from '@/player/store';
import { useMaybeSource } from '@/sources';
import { PLAYER_BAR_HEIGHT, useDesktop } from './layout';
import { setVolume, toggleMute, useVolume } from './volume';
import { Marquee } from '@/components/Marquee';

/**
 * Barra de reproducción del PC, siempre abajo (como en Spotify o Apple Music para escritorio): la canción
 * (clic: Reproduciendo), los controles con la barra de progreso y, a la derecha, letra, cola y volumen.
 */
export function PlayerBar() {
  const desktop = useDesktop();
  const source = useMaybeSource();
  const song = usePlayer(currentSong);
  const favorite = useIsFavorite(song?.id);
  const pathname = usePathname();
  const muted = useThemeColor('muted');
  const foreground = useThemeColor('foreground');
  const accent = useThemeColor('accent');
  const error = usePlayer((s) => s.error);

  if (!desktop || !song || !source) return null;
  const onPlayer = pathname === '/reproduciendo';

  return (
    <View style={{ height: PLAYER_BAR_HEIGHT }} className="flex-row items-center px-4 gap-4 bg-card border-t border-separator">
      {/* La canción */}
      <View className="flex-row items-center gap-3" style={{ width: '28%', minWidth: 220 }}>
        <Pressable onPress={() => (onPlayer ? router.back() : router.push('/reproduciendo'))} className="active:opacity-70" accessibilityLabel="Reproduciendo">
          <Artwork coverArt={song.coverArt} size={120} className="w-14 h-14 rounded-md" />
        </Pressable>
        <View className="flex-1">
          <Marquee className="text-foreground text-sm font-semibold">{song.title}</Marquee>
          <Marquee className={`text-xs ${error ? 'text-accent' : 'text-muted'}`}>{error ?? artistName(song.artist)}</Marquee>
        </View>
        <IconButton icon={favorite ? 'star' : 'star-outline'} color={favorite ? accent : muted} size={18} label="Favorita" onPress={() => toggleFavorite(source, song).catch(() => {})} />
      </View>

      {/* Controles y progreso */}
      <View className="flex-1 items-center">
        <Controls />
        <Progress />
      </View>

      {/* Letra, cola, menú y volumen */}
      <View className="flex-row items-center justify-end gap-1" style={{ width: '28%', minWidth: 220 }}>
        <IconButton icon="chatbox-ellipses-outline" color={onPlayer ? accent : muted} label="Letra" onPress={() => (onPlayer ? router.back() : router.push('/reproduciendo'))} />
        <IconButton icon="list" color={pathname === '/cola' ? accent : muted} label="A continuación" onPress={() => (pathname === '/cola' ? router.back() : router.push('/cola'))} />
        <IconButton icon="ellipsis-horizontal" color={muted} label="Más opciones" onPress={() => openPlayerActions(source, song)} />
        <Volume color={foreground} muted={muted} accent={accent} />
      </View>
    </View>
  );
}

function Controls() {
  const wantsToPlay = usePlayer((s) => s.playWhenReady);
  const buffering = usePlayer((s) => s.playbackState === 'buffering');
  const shuffle = usePlayer((s) => s.shuffle);
  const repeatMode = usePlayer((s) => s.repeatMode);
  const foreground = useThemeColor('foreground');
  const background = useThemeColor('background');
  const muted = useThemeColor('muted');
  const accent = useThemeColor('accent');
  return (
    <View className="flex-row items-center gap-5">
      <IconButton icon="shuffle" color={shuffle ? accent : muted} size={19} label={shuffle ? 'Desactivar aleatorio' : 'Activar aleatorio'} onPress={toggleShuffle} />
      <IconButton icon="play-back" color={foreground} size={22} label="Anterior" onPress={previous} />
      <Pressable
        onPress={togglePlay}
        className="w-10 h-10 rounded-full bg-foreground items-center justify-center active:opacity-70"
        accessibilityLabel={wantsToPlay ? 'Pausar' : 'Reproducir'}
      >
        {buffering && wantsToPlay ? (
          <ActivityIndicator size="small" color={background} />
        ) : (
          <Ionicons name={wantsToPlay ? 'pause' : 'play'} size={20} color={background} style={wantsToPlay ? undefined : { marginLeft: 2 }} />
        )}
      </Pressable>
      <IconButton icon="play-forward" color={foreground} size={22} label="Siguiente" onPress={next} />
      <View>
        <IconButton
          icon="repeat"
          color={repeatMode !== 'off' ? accent : muted}
          size={19}
          label={repeatMode === 'off' ? 'Repetir todo' : repeatMode === 'all' ? 'Repetir una' : 'No repetir'}
          onPress={cycleRepeat}
        />
        {repeatMode === 'one' && <Text className="absolute -right-1 -top-0.5 text-accent text-[9px] font-bold">1</Text>}
      </View>
    </View>
  );
}

/** Barra de progreso con un <input type="range"> nativo del navegador: clic y arrastre con ratón y teclado. */
function Progress() {
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs ?? (currentSong(s)?.duration ?? 0) * 1000);
  return (
    <View className="flex-row items-center gap-2 w-full max-w-[640px] mt-1">
      <Text className="text-muted text-[11px] w-10 text-right">{formatDuration(positionMs / 1000) || '0:00'}</Text>
      <View className="flex-1">
        <Range value={durationMs ? positionMs / durationMs : 0} onChange={(r) => durationMs && seekTo(r * durationMs)} label="Posición" commitOnRelease />
      </View>
      <Text className="text-muted text-[11px] w-10">{durationMs ? formatDuration(durationMs / 1000) : '--:--'}</Text>
    </View>
  );
}

function Volume({ color, muted, accent }: { color: string; muted: string; accent: string }) {
  const volume = useVolume();
  const icon = volume === 0 ? 'volume-mute' : volume < 0.34 ? 'volume-low' : volume < 0.67 ? 'volume-medium' : 'volume-high';
  return (
    <View className="flex-row items-center gap-2 ml-2">
      <IconButton icon={icon} color={volume === 0 ? accent : muted} size={19} label={volume === 0 ? 'Activar sonido' : 'Silenciar'} onPress={toggleMute} />
      <View style={{ width: 96 }}>
        <Range value={volume} onChange={setVolume} label={`Volumen ${Math.round(volume * 100)} %`} color={color} />
      </View>
    </View>
  );
}

/** commitOnRelease: mientras se arrastra solo se mueve la barra; el cambio se aplica al soltar (buscar). */
function Range({ value, onChange, label, color, commitOnRelease }: {
  value: number;
  onChange: (ratio: number) => void;
  label: string;
  color?: string;
  commitOnRelease?: boolean;
}) {
  const accent = useThemeColor('accent');
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const commit = (raw: string) => {
    setDragging(null);
    onChange(Number(raw) / 1000);
  };
  return (
    <input
      type="range"
      min={0}
      max={1000}
      value={Math.round(Math.min(1, Math.max(0, shown)) * 1000)}
      onChange={(e) => (commitOnRelease ? setDragging(Number(e.currentTarget.value) / 1000) : onChange(Number(e.currentTarget.value) / 1000))}
      onPointerUp={(e) => commitOnRelease && commit(e.currentTarget.value)}
      onKeyUp={(e) => commitOnRelease && commit(e.currentTarget.value)}
      aria-label={label}
      title={label}
      style={{ width: '100%', accentColor: color ?? accent, cursor: 'pointer', margin: 0 }}
    />
  );
}

function IconButton({ icon, color, size = 20, label, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  size?: number;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} className="w-9 h-9 rounded-full items-center justify-center active:opacity-50">
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}
