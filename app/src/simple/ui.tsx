import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, type TextProps, View } from 'react-native';
import { withUniwind } from 'uniwind';
import { Artwork } from '@/components/Artwork';
import { useThemeColor } from '@/components/theme';
import { currentSong, isEpisodeId, next, playerState, previous, seekTo, togglePlay, usePlayer } from '@/player/store';

export const StyledImage = withUniwind(Image);

/**
 * Texto del modo sencillo: grande de base y que crece con la letra del sistema, pero sin pasar de 1,4× (con la
 * letra del teléfono al máximo, 1,6× o más rompería los botones).
 */
export function BigText(props: TextProps & { className?: string }) {
  return <Text maxFontSizeMultiplier={1.4} {...props} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <BigText className="text-foreground text-[28px] font-bold px-5 mt-8 mb-3">{children}</BigText>;
}

/** Botón redondo grande (mínimo 64 px, más que los 48 que pide Android para tocar con comodidad). */
export function RoundButton({
  icon,
  onPress,
  size = 64,
  label,
  busy,
  filled = true,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  size?: number;
  label: string;
  busy?: boolean;
  filled?: boolean;
}) {
  const accent = useThemeColor('accent');
  const fg = filled ? '#ffffff' : accent;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: filled ? accent : 'transparent' }}
      className="items-center justify-center active:opacity-70"
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Ionicons name={icon} size={size * 0.48} color={fg} style={icon === 'play' ? { marginLeft: size * 0.06 } : undefined} />
      )}
    </Pressable>
  );
}

/** Lo que suena ahora, con los tres botones grandes (en episodios: −15 s / +30 s en vez de anterior / siguiente). */
export function NowPlayingCard() {
  const song = usePlayer(currentSong);
  const wantsToPlay = usePlayer((s) => s.playWhenReady && s.playbackState !== 'ended');
  const buffering = usePlayer((s) => s.playWhenReady && s.playbackState === 'buffering');
  const progress = usePlayer((s) => (s.durationMs ? Math.min(1, s.positionMs / s.durationMs) : 0));
  const foreground = useThemeColor('foreground');
  if (!song) return null;
  const episode = isEpisodeId(song.id);
  const jump = (ms: number) => {
    const s = playerState();
    return seekTo(Math.max(0, Math.min(s.positionMs + ms, (s.durationMs ?? Infinity) - 1000)));
  };

  return (
    <View className="mx-5 mt-4 rounded-3xl bg-card p-4">
      {/* Tocar la carátula o el título abre el reproductor sencillo a pantalla completa. */}
      <Pressable onPress={() => router.push('/sencillo/reproduciendo')} className="flex-row items-center active:opacity-70" accessibilityLabel="Abrir el reproductor">
        <Artwork coverArt={song.coverArt} size={88} className="w-[88px] h-[88px] rounded-2xl" />
        <View className="flex-1 ml-4">
          <BigText className="text-muted text-base font-semibold">{wantsToPlay ? 'Suena ahora' : 'En pausa'}</BigText>
          <BigText className="text-foreground text-[22px] font-bold" numberOfLines={2}>{song.title}</BigText>
          {!!song.artist && <BigText className="text-muted text-lg" numberOfLines={1}>{song.artist}</BigText>}
        </View>
        <Ionicons name="chevron-up" size={26} color={foreground} />
      </Pressable>
      <View className="h-2 mt-4 rounded-full bg-separator overflow-hidden">
        <View style={{ width: `${progress * 100}%` }} className="h-full bg-accent" />
      </View>
      <View className="flex-row items-center justify-around mt-4">
        <Pressable
          onPress={() => (episode ? jump(-15_000) : previous())}
          hitSlop={10}
          className="w-16 h-16 items-center justify-center active:opacity-50"
          accessibilityLabel={episode ? 'Atrás 15 segundos' : 'Anterior'}
        >
          <Ionicons name={episode ? 'play-back-circle-outline' : 'play-skip-back'} size={episode ? 52 : 40} color={foreground} />
          {episode && <BigText className="text-foreground text-sm font-bold">15 s</BigText>}
        </Pressable>
        <RoundButton icon={wantsToPlay ? 'pause' : 'play'} onPress={togglePlay} size={84} busy={buffering} label={wantsToPlay ? 'Pausa' : 'Reproducir'} />
        <Pressable
          onPress={() => (episode ? jump(30_000) : next())}
          hitSlop={10}
          className="w-16 h-16 items-center justify-center active:opacity-50"
          accessibilityLabel={episode ? 'Adelante 30 segundos' : 'Siguiente'}
        >
          <Ionicons name={episode ? 'play-forward-circle-outline' : 'play-skip-forward'} size={episode ? 52 : 40} color={foreground} />
          {episode && <BigText className="text-foreground text-sm font-bold">30 s</BigText>}
        </Pressable>
      </View>
    </View>
  );
}

const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «Jueves 19 de noviembre». */
export const longDate = (d = new Date()) => `${DAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;

/** «Buenos días», «Buenas tardes» o «Buenas noches». */
export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}
