import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { LargeTitle } from '@/components/LargeTitle';
import { EmptyState } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { serverSession, useSource } from '@/sources';
import { clearDone, pickPcFiles, removePcFile, uploadPcFiles, usePcUploads, type PcUploadItem } from '@/upload/pc';
import { ListMarquee } from '@/components/Marquee';

/** Navidrome detecta los archivos nuevos en ~2 s; esperamos un poco antes de refrescar la biblioteca. */
const LIBRARY_REFRESH_DELAY_MS = 4000;

/**
 * Importar en el PC: elegir canciones o una carpeta (o arrastrarlas a la ventana) y subirlas al servidor.
 * Los originales se quedan en el equipo.
 */
export function ImportPc() {
  const source = useSource();
  const queryClient = useQueryClient();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const items = usePcUploads((s) => s.items);
  const running = usePcUploads((s) => s.running);
  const pending = items.filter((it) => it.status.kind !== 'done').length;
  const done = items.length - pending;

  async function pick(folder: boolean) {
    try {
      const added = await pickPcFiles(folder);
      if (added === 0 && folder) Alert.alert('Sin canciones nuevas', 'En esa carpeta no hay audio que no esté ya en la lista.');
    } catch (e) {
      Alert.alert('No se pudieron elegir los archivos', e instanceof Error ? e.message : String(e));
    }
  }

  async function start() {
    const { uploaded, failed } = await uploadPcFiles(serverSession(source));
    if (uploaded > 0) setTimeout(() => queryClient.invalidateQueries(), LIBRARY_REFRESH_DELAY_MS);
    if (failed > 0) Alert.alert('Algunas subidas fallaron', `${failed} archivo(s) no se subieron. Puedes volver a intentarlo.`);
  }

  const header = (
    <View>
      <LargeTitle title="Importar" back />
      {source.capabilities.appleMusicImport && (
        <Pressable
          onPress={() => router.push('/biblioteca/apple-music')}
          className="mx-5 mt-2 flex-row items-center rounded-xl bg-card px-4 py-3 active:opacity-60"
        >
          <Ionicons name="logo-apple" size={22} color={accent} />
          <View className="flex-1 ml-3">
            <Text className="text-foreground text-base">Playlist de Apple Music</Text>
            <Text className="text-muted text-xs">Las canciones que falten se descargan de YouTube</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={muted} />
        </Pressable>
      )}

      {/* Sin servidor (fuente «Este equipo») no hay adónde subir: solo Apple Music. */}
      {source.capabilities.upload && (
        <>
      <View className="mx-5 mt-4 mb-4 rounded-xl border-2 border-dashed border-separator px-6 py-8 items-center gap-2">
        <Ionicons name="cloud-upload-outline" size={40} color={accent} />
        <Text className="text-foreground text-base font-semibold">Arrastra aquí canciones o carpetas</Text>
        <Text className="text-muted text-sm text-center">
          O elígelas abajo. Al subirlas, Impala comprueba con la huella MD5 que la copia del servidor es idéntica. Los
          originales se quedan en tu equipo.
        </Text>
      </View>

      <View className="mx-5 mb-4 flex-row gap-3">
        <Button icon="musical-notes-outline" label="Elegir canciones…" disabled={running} onPress={() => pick(false)} />
        <Button icon="folder-open-outline" label="Elegir carpeta…" disabled={running} onPress={() => pick(true)} />
      </View>

      {items.length > 0 && (
        <View className="mx-5 mb-3 flex-row gap-3">
          <Pressable
            onPress={start}
            disabled={running || pending === 0}
            className={`flex-1 rounded-xl py-3.5 items-center bg-accent ${running || pending === 0 ? 'opacity-50' : 'active:opacity-80'}`}
          >
            {running ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text className="text-accent-foreground text-base font-semibold">
                {pending === 0 ? 'Todo subido' : `Subir ${pending} archivo${pending === 1 ? '' : 's'}`}
              </Text>
            )}
          </Pressable>
          {done > 0 && !running && (
            <Pressable onPress={clearDone} className="rounded-xl px-4 py-3.5 bg-card active:opacity-60">
              <Text className="text-accent text-base">Quitar los subidos</Text>
            </Pressable>
          )}
        </View>
      )}
        </>
      )}
    </View>
  );

  return (
    <FlatList
      data={source.capabilities.upload ? items : []}
      keyExtractor={(it) => it.path}
      ListHeaderComponent={header}
      ListEmptyComponent={source.capabilities.upload ? <EmptyState icon="musical-notes-outline" title="Aún no hay canciones para subir" subtitle="FLAC, MP3, Opus, M4A, WAV…" /> : null}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => <Row item={item} running={running} />}
    />
  );
}

function Button(props: { icon: keyof typeof Ionicons.glyphMap; label: string; disabled: boolean; onPress: () => void }) {
  const accent = useThemeColor('accent');
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-card py-3 ${props.disabled ? 'opacity-50' : 'active:opacity-60'}`}
    >
      <Ionicons name={props.icon} size={20} color={accent} />
      <Text className="text-accent text-base">{props.label}</Text>
    </Pressable>
  );
}

function Row({ item, running }: { item: PcUploadItem; running: boolean }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const { status } = item;
  const mb = (item.size / 1024 ** 2).toFixed(1);
  const detail =
    status.kind === 'hashing' ? 'Calculando huella…'
    : status.kind === 'uploading' ? `Subiendo… ${Math.round(status.progress * 100)}%`
    : status.kind === 'done' ? (status.duplicate ? 'Ya estaba en el servidor' : 'Subido y verificado')
    : status.kind === 'error' ? status.message
    : `${mb} MB · ${item.path}`;

  return (
    <View className="flex-row items-center px-5">
      <View className="w-7 items-center">
        {status.kind === 'done' ? (
          <Ionicons name="checkmark-circle" size={22} color="#34c759" />
        ) : status.kind === 'error' ? (
          <Ionicons name="alert-circle" size={22} color={accent} />
        ) : status.kind === 'hashing' || status.kind === 'uploading' ? (
          <ActivityIndicator size="small" color={accent} />
        ) : (
          <Ionicons name="musical-note" size={20} color={muted} />
        )}
      </View>
      <View className="flex-1 ml-3 py-3 border-b border-separator">
        <ListMarquee className={`text-base ${status.kind === 'done' ? 'text-muted' : 'text-foreground'}`}>{item.name}</ListMarquee>
        <Text className={`text-xs ${status.kind === 'error' ? 'text-accent' : 'text-muted'}`} numberOfLines={1}>{detail}</Text>
        {status.kind === 'uploading' && (
          <View className="h-1 mt-1.5 rounded-full bg-separator overflow-hidden">
            <View style={{ width: `${status.progress * 100}%` }} className="h-full bg-accent" />
          </View>
        )}
      </View>
      {!running && status.kind !== 'done' && (
        <Pressable onPress={() => removePcFile(item.path)} hitSlop={10} className="ml-2 p-1 active:opacity-50" accessibilityLabel="Quitar de la lista">
          <Ionicons name="close" size={18} color={muted} />
        </Pressable>
      )}
    </View>
  );
}
