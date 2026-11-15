import { useLocalSearchParams } from 'expo-router';
import { ArtistPage } from '@/components/ArtistPage';

export default function ArtistaScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ArtistPage libraryId={id} />;
}
