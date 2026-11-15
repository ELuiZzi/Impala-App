import { LinearGradient } from 'expo-linear-gradient';
import { Text, View } from 'react-native';
import { useCoverStyle } from '@/library/coverStyles';

type Point = { x: number; y: number };
export type CoverStyle = {
  name: string;
  colors: [string, string, ...string[]];
  start: Point;
  end: Point;
  /** Segundo degradado encima (brillo o sombra) para dar profundidad. */
  overlay?: { colors: [string, string, ...string[]]; start: Point; end: Point };
};

const diagonal = { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };
const vertical = { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } };
const across = { start: { x: 1, y: 0 }, end: { x: 0, y: 1 } };
const shine = { colors: ['rgba(255,255,255,0.28)', 'rgba(255,255,255,0)'] as [string, string], start: { x: 0, y: 0 }, end: { x: 0.7, y: 0.7 } };
const shade = { colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.35)'] as [string, string], start: { x: 0.5, y: 0.3 }, end: { x: 0.5, y: 1 } };

/**
 * Degradados de las carátulas genéricas, al estilo de las playlists de Apple Music. Los doce
 * primeros son los automáticos (salen del nombre); el resto solo se eligen a mano.
 */
export const COVER_STYLES: CoverStyle[] = [
  { name: 'Atardecer', colors: ['#FF5F6D', '#FFC371'], ...diagonal },
  { name: 'Uva', colors: ['#A235FA', '#5B2BE0'], ...diagonal },
  { name: 'Océano', colors: ['#00C6FF', '#0072FF'], ...diagonal },
  { name: 'Algodón', colors: ['#F7797D', '#C471ED'], ...diagonal },
  { name: 'Menta', colors: ['#11998E', '#38EF7D'], ...diagonal },
  { name: 'Neón', colors: ['#FC466B', '#3F5EFB'], ...diagonal },
  { name: 'Brasa', colors: ['#F2994A', '#EB5757'], ...diagonal },
  { name: 'Índigo', colors: ['#4776E6', '#8E54E9'], ...diagonal },
  { name: 'Bosque', colors: ['#1D976C', '#2C7744'], ...diagonal },
  { name: 'Fuego', colors: ['#EE0979', '#FF6A00'], ...diagonal },
  { name: 'Cielo', colors: ['#2193B0', '#6DD5ED'], ...diagonal },
  { name: 'Orquídea', colors: ['#834D9B', '#D04ED6'], ...diagonal },
  { name: 'Aurora', colors: ['#00F5A0', '#00D9F5', '#7F00FF'], ...across, overlay: shade },
  { name: 'Miami', colors: ['#FF0080', '#FF8C00', '#40E0D0'], ...diagonal, overlay: shine },
  { name: 'Medianoche', colors: ['#232526', '#414345', '#1C1C1E'], ...vertical, overlay: shine },
  { name: 'Lava', colors: ['#200122', '#6F0000', '#FF4E00'], ...vertical },
  { name: 'Pastel', colors: ['#FBC2EB', '#A6C1EE'], ...diagonal, overlay: shine },
  { name: 'Limón', colors: ['#FDFC47', '#24FE41'], ...across, overlay: shade },
  { name: 'Galaxia', colors: ['#0F0C29', '#302B63', '#24243E'], ...diagonal, overlay: { colors: ['rgba(255,0,153,0.35)', 'rgba(255,0,153,0)'], start: { x: 1, y: 0 }, end: { x: 0.3, y: 0.6 } } },
  { name: 'Coral', colors: ['#FF9A8B', '#FF6A88', '#FF99AC'], ...vertical, overlay: shine },
  { name: 'Gym', colors: ['#F00000', '#DC281E', '#1A1A1A'], ...vertical, overlay: shade },
  { name: 'Oro', colors: ['#F7971E', '#FFD200'], ...diagonal, overlay: shine },
  { name: 'Hielo', colors: ['#E0EAFC', '#CFDEF3', '#89F7FE'], ...vertical },
  { name: 'Vino', colors: ['#870000', '#190A05'], ...diagonal, overlay: shine },
];

const AUTOMATIC = 12;

/** El mismo nombre siempre da el mismo degradado. */
function automaticFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % AUTOMATIC;
}

type Props = {
  name: string;
  size: number;
  className?: string;
  /** Estilo elegido a mano para esta playlist (si no se pasa `style`). */
  playlistId?: string;
  /** Estilo explícito (índice en COVER_STYLES); null = automático por nombre. */
  style?: number | null;
};

/** Carátula genérica de una playlist: degradado de color con su nombre escrito encima. */
export function PlaylistCover({ name, size, className = '', playlistId, style }: Props) {
  const chosen = useCoverStyle(style === undefined ? playlistId : undefined);
  const index = style !== undefined ? style : chosen;
  const cover = COVER_STYLES[index ?? automaticFor(name)] ?? COVER_STYLES[automaticFor(name)];
  const fontSize = Math.max(9, Math.round(size * 0.13));
  return (
    <View className={`overflow-hidden ${className}`}>
      <LinearGradient colors={cover.colors} start={cover.start} end={cover.end} style={{ flex: 1 }}>
        {cover.overlay && <LinearGradient colors={cover.overlay.colors} start={cover.overlay.start} end={cover.overlay.end} style={{ position: 'absolute', inset: 0 }} />}
        <View style={{ flex: 1, justifyContent: 'flex-end', padding: Math.max(4, size * 0.08) }}>
          <Text
            numberOfLines={size < 64 ? 2 : 3}
            style={{ color: 'white', fontSize, lineHeight: fontSize * 1.1, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 4 }}
          >
            {name}
          </Text>
        </View>
      </LinearGradient>
    </View>
  );
}
