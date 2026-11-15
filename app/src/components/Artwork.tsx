import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { withUniwind } from 'uniwind';
import { localCoverUri, useOffline } from '@/offline/store';
import { useSource } from '@/sources';
import { useThemeColor } from './theme';

const StyledImage = withUniwind(Image);

type Props = {
  coverArt?: string;
  /** Tamaño solicitado a la fuente (px); se pide el doble para pantallas de alta densidad. */
  size: number;
  className?: string;
  icon?: keyof typeof Ionicons.glyphMap;
};

/** Carátula cacheada en disco; si no hay, muestra un ícono sobre fondo neutro. */
export function Artwork({ coverArt, size, className = '', icon = 'musical-notes' }: Props) {
  const source = useSource();
  const muted = useThemeColor('muted');
  // Si la canción está descargada, su carátula también: así se ve sin conexión.
  const local = useOffline(() => (source.capabilities.offlineDownloads ? localCoverUri(coverArt) : null));
  const uri = local ?? source.coverUrl(coverArt, Math.min(size * 2, 1200));

  return (
    <View className={`overflow-hidden bg-card items-center justify-center ${className}`}>
      <Ionicons name={icon} size={Math.max(16, size * 0.38)} color={muted} />
      {uri && (
        <StyledImage
          source={{ uri }}
          className="absolute inset-0"
          cachePolicy="disk"
          contentFit="cover"
          transition={150}
          recyclingKey={coverArt}
        />
      )}
    </View>
  );
}
