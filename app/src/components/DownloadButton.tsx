import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable } from 'react-native';
import { downloadSongs, downloadStatusOf, useOffline } from '@/offline/store';
import { useSource, type Song } from '@/sources';
import { useThemeColor } from './theme';

/** Botón de la cabecera de un álbum: descarga todas sus canciones; marca de verificación si ya están. */
export function DownloadButton({ songs }: { songs: Song[] }) {
  const source = useSource();
  const accent = useThemeColor('accent');
  // Resumen en un string estable para que useSyncExternalStore no re-renderice en bucle.
  const summary = useOffline((s) => {
    const kinds = songs.map((song) => downloadStatusOf(s, song.id));
    if (kinds.length > 0 && kinds.every((k) => k === 'downloaded')) return 'all';
    if (kinds.some((k) => k === 'downloading' || k === 'queued')) return 'working';
    return 'none';
  });

  if (summary === 'working') return <ActivityIndicator color={accent} />;
  return (
    <Pressable
      onPress={() => downloadSongs(source, songs)}
      disabled={summary === 'all' || songs.length === 0}
      hitSlop={12}
      className="active:opacity-50"
    >
      <Ionicons name={summary === 'all' ? 'checkmark-circle' : 'arrow-down-circle-outline'} size={28} color={accent} />
    </Pressable>
  );
}
