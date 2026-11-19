import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArtistPage } from '@/components/ArtistPage';
import { PreviewBar } from '@/components/player/PreviewBar';

/** Artista de YouTube Music. id "_" = solo se conoce el nombre (p. ej. desde una canción de YouTube). */
export default function YoutubeArtistScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1">
      <ArtistPage youtubeId={id && id !== '_' ? id : undefined} name={name || undefined} />
      <PreviewBar bottom={Math.max(insets.bottom, 14) + 8} />
    </View>
  );
}
