import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSearch } from '@/api/queries';
import { isYoutubeLink } from '@/api/youtube';
import { LargeTitle } from '@/components/LargeTitle';
import { APP_MENU, OverflowMenu } from '@/components/OverflowMenu';
import { AlbumTile, ArtistRow, SongRow } from '@/components/rows';
import { YoutubeResults } from '@/components/YoutubeResults';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { useSource } from '@/sources';
import { openSongActions } from '@/components/sheets/songActions';
import { playSongs } from '@/player/store';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Source = 'biblioteca' | 'youtube';

export default function BuscarScreen() {
  const music = useSource();
  const muted = useThemeColor('muted');
  const [text, setText] = useState('');
  const [source, setSource] = useState<Source>('biblioteca');
  // En la biblioteca se busca al escribir; en YouTube también, con una pausa algo mayor (cada búsqueda
  // son cuatro peticiones a YouTube; las que quedan a medias se cancelan). Pulsar buscar no espera la pausa.
  const [submitted, setYoutubeQuery] = useState('');
  const typed = useDebounced(source === 'youtube' && text.trim().length >= 2 ? text.trim() : '', 400);
  const youtubeQuery = source !== 'youtube' || !text.trim() ? '' : submitted === text.trim() ? submitted : typed || submitted;
  const query = useDebounced(source === 'biblioteca' ? text.trim() : '', 300);
  const search = useSearch(query);
  const r = search.data;
  const hasResults = !!r && r.artists.length + r.albums.length + r.songs.length > 0;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 32 }}>
      <LargeTitle title="Buscar" right={<OverflowMenu items={APP_MENU} />} />
      <View className="mx-5 mt-2 mb-4 flex-row items-center bg-card rounded-xl px-3">
        <Ionicons name="search" size={18} color={muted} />
        <TextInput
          className="flex-1 text-foreground text-base py-2.5 ml-2"
          value={text}
          onChangeText={(value) => {
            setText(value);
            // Un enlace de YouTube pegado se busca en YouTube al instante, sin pulsar buscar.
            if (music.capabilities.youtube && isYoutubeLink(value)) {
              setSource('youtube');
              setYoutubeQuery(value.trim());
            }
          }}
          placeholder={source === 'biblioteca' ? 'Artistas, álbumes, canciones' : 'Buscar o pegar un enlace de YouTube'}
          placeholderTextColor={muted}
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => source === 'youtube' && setYoutubeQuery(text.trim())}
          clearButtonMode="while-editing"
        />
        {text.length > 0 && (
          <Pressable onPress={() => setText('')} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={muted} />
          </Pressable>
        )}
      </View>

      {music.capabilities.youtube && (
        <View className="mx-5 mb-4 flex-row rounded-lg bg-card p-0.5">
          {(['biblioteca', 'youtube'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                setSource(s);
                if (s === 'youtube') setYoutubeQuery(text.trim());
              }}
              className={`flex-1 items-center rounded-md py-1.5 ${source === s ? 'bg-background' : ''}`}
            >
              <Text className={`text-sm font-semibold ${source === s ? 'text-foreground' : 'text-muted'}`}>
                {s === 'biblioteca' ? 'Tu biblioteca' : 'YouTube'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {source === 'youtube' && <YoutubeResults query={youtubeQuery} />}
      {source === 'biblioteca' && !query && <EmptyState icon="search" title="Busca en tu biblioteca" />}
      {!!query && search.isPending && <Loading />}
      {!!query && search.isError && <ErrorState error={search.error} onRetry={search.refetch} />}
      {!!query && r && !hasResults && <EmptyState icon="sad-outline" title={`Sin resultados para “${query}”`} />}

      {!!query && r && r.artists.length > 0 && (
        <Section title="Artistas">
          {r.artists.map((a) => (
            <ArtistRow key={a.id} artist={a} onPress={() => router.push({ pathname: '/biblioteca/artista/[id]', params: { id: a.id } })} />
          ))}
        </Section>
      )}

      {!!query && r && r.albums.length > 0 && (
        <Section title="Álbumes">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}>
            {r.albums.map((a) => (
              <View key={a.id} className="w-36">
                <AlbumTile album={a} onPress={() => router.push({ pathname: '/biblioteca/album/[id]', params: { id: a.id } })} />
              </View>
            ))}
          </ScrollView>
        </Section>
      )}

      {!!query && r && r.songs.length > 0 && (
        <Section title="Canciones">
          {r.songs.map((s, i) => <SongRow key={s.id} song={s} onPress={() => playSongs(r.songs, i)} onMore={() => openSongActions(music, s)} />)}
        </Section>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-4">
      <Text className="text-foreground text-[22px] font-bold px-5 mb-2">{title}</Text>
      {children}
    </View>
  );
}
