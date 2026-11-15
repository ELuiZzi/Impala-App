import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import type { Song } from '@/sources';
import { playSongs } from '@/player/store';
import { useThemeColor } from './theme';

/** "Reproducir" y "Aleatorio" bajo la cabecera de un álbum o playlist. */
export function PlayButtons({ songs }: { songs: Song[] }) {
  const accent = useThemeColor('accent');
  const disabled = songs.length === 0;
  const button = `flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-card py-3 ${disabled ? 'opacity-40' : 'active:opacity-60'}`;

  return (
    <View className="flex-row gap-3 px-5 pb-4">
      <Pressable disabled={disabled} onPress={() => playSongs(songs, 0)} className={button}>
        <Ionicons name="play" size={18} color={accent} />
        <Text className="text-accent text-base font-semibold">Reproducir</Text>
      </Pressable>
      <Pressable disabled={disabled} onPress={() => playSongs(songs, 0, { shuffle: true })} className={button}>
        <Ionicons name="shuffle" size={20} color={accent} />
        <Text className="text-accent text-base font-semibold">Aleatorio</Text>
      </Pressable>
    </View>
  );
}
