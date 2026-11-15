import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { withUniwind } from 'uniwind';
import { createAppleImport, IMPORT_STATUS, isImportBusy, useAppleImports, type ImportJob } from '@/api/applemusic';
import { DEVICE } from '@/components/device';
import { LargeTitle } from '@/components/LargeTitle';
import { useThemeColor } from '@/components/theme';
import { useSource } from '@/sources';
import { ListMarquee } from '@/components/Marquee';

const StyledImage = withUniwind(Image);
const APPLE_LINK = /music\.apple\.com\/[a-z]{2}\/playlist\//i;
/** Enlace a la biblioteca personal (music.apple.com/library/playlist/p.…): solo se abre con la sesión de Apple. */
const LIBRARY_LINK = /music\.apple\.com\/library\//i;

/** Pegar el enlace de una playlist pública de Apple Music y ver las importaciones recientes. */
export default function AppleMusicScreen() {
  const source = useSource();
  const muted = useThemeColor('muted');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imports = useAppleImports();
  const valid = APPLE_LINK.test(url);

  async function analyze() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await createAppleImport(source, url.trim());
      setUrl('');
      imports.refetch();
      router.push({ pathname: '/biblioteca/apple-music/[id]', params: { id: job.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer la playlist');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
      <LargeTitle title="Apple Music" back />
      <View className="mx-5 mt-2 mb-4 rounded-xl bg-card p-4 gap-1.5">
        <Text className="text-foreground text-base font-semibold">Importar una playlist</Text>
        <Text className="text-muted text-sm">
          En Apple Music abre la playlist → Compartir → Copiar enlace, y pégalo aquí. Impala busca cada canción en tu biblioteca; las que falten las
          descarga de YouTube Music{source.kind === 'local' ? ` al ${DEVICE}` : ''} y después crea la playlist con el mismo orden. La playlist debe ser pública.
        </Text>
      </View>

      <View className="mx-5 flex-row items-center bg-card rounded-xl px-3">
        <Ionicons name="link" size={18} color={muted} />
        <TextInput
          className="flex-1 text-foreground text-base py-2.5 ml-2"
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setError(null);
          }}
          placeholder="Enlace de la playlist"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={analyze}
        />
        {url.length > 0 && (
          <Pressable onPress={() => setUrl('')} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={muted} />
          </Pressable>
        )}
      </View>
      {error && <Text className="text-accent text-sm mx-5 mt-2">{error}</Text>}
      {url.length > 0 && !valid && (
        <Text className="text-muted text-sm mx-5 mt-2">
          {LIBRARY_LINK.test(url)
            ? 'Ese enlace es de tu biblioteca y solo lo puedes abrir tú. En Apple Music abre la playlist → ⋯ → Compartir playlist → Copiar: así se hace pública y el enlace queda como music.apple.com/mx/playlist/…/pl.u-…'
            : 'Debe ser un enlace de playlist de music.apple.com.'}
        </Text>
      )}
      <Pressable
        onPress={analyze}
        disabled={!valid || busy}
        className={`mx-5 mt-3 rounded-xl py-3 items-center bg-accent ${valid && !busy ? 'active:opacity-80' : 'opacity-40'}`}
      >
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-accent-foreground text-base font-semibold">Buscar canciones</Text>}
      </Pressable>

      {(imports.data?.length ?? 0) > 0 && (
        <View className="mt-8">
          <Text className="text-foreground text-[22px] font-bold px-5 mb-2">Recientes</Text>
          {imports.data!.map((job) => (
            <ImportRow key={job.id} job={job} />
          ))}
        </View>
      )}
      {imports.isError && <Text className="text-muted text-sm mx-5 mt-6">{imports.error?.message}</Text>}
    </ScrollView>
  );
}

function ImportRow({ job }: { job: ImportJob }) {
  const muted = useThemeColor('muted');
  const accent = useThemeColor('accent');
  const total = job.counts.library + job.counts.youtube + job.counts.notFound + job.counts.skipped + job.counts.added + job.counts.failed;
  const detail = job.status === 'error' ? job.error : [IMPORT_STATUS[job.status], total > 0 ? `${total} canciones` : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/biblioteca/apple-music/[id]', params: { id: job.id } })}
      className="flex-row items-center px-5 active:bg-card"
    >
      <View className="w-12 h-12 rounded-md bg-card items-center justify-center overflow-hidden">
        <Ionicons name="musical-notes" size={20} color={muted} />
        {job.artwork && <StyledImage source={{ uri: job.artwork }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
      </View>
      <View className="flex-1 flex-row items-center ml-3 py-2.5 border-b border-separator">
        <View className="flex-1">
          <ListMarquee className="text-foreground text-base">{job.name ?? 'Playlist de Apple Music'}</ListMarquee>
          <Text className={`text-sm ${job.status === 'error' ? 'text-accent' : 'text-muted'}`} numberOfLines={1}>{detail}</Text>
        </View>
        {isImportBusy(job.status) ? (
          <ActivityIndicator color={accent} />
        ) : job.status === 'done' ? (
          <Ionicons name="checkmark-circle" size={22} color="#34c759" />
        ) : (
          <Ionicons name="chevron-forward" size={18} color={muted} />
        )}
      </View>
    </Pressable>
  );
}
