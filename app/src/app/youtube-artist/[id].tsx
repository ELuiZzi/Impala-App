import { useLocalSearchParams } from 'expo-router';
import { ArtistPage } from '@/components/ArtistPage';

/** Artista de YouTube Music. id "_" = solo se conoce el nombre (p. ej. desde una canción de YouTube). */
export default function YoutubeArtistScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  return <ArtistPage youtubeId={id && id !== '_' ? id : undefined} name={name || undefined} />;
}
