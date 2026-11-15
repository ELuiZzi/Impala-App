import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { ImportPc } from '@/components/desktop/ImportPc';
import { LargeTitle } from '@/components/LargeTitle';
import { EmptyState } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { serverSession, useSource } from '@/sources';
import {
  addFiles,
  folderLabel,
  loadFolder,
  pickFolder,
  refreshFiles,
  uploadAll,
  useUploads,
  type UploadItem,
} from '@/upload/store';
import { DEVICE } from '@/components/device';
import { ListMarquee } from '@/components/Marquee';

/** Navidrome detecta los archivos nuevos en ~2 s; esperamos un poco antes de refrescar la biblioteca. */
const LIBRARY_REFRESH_DELAY_MS = 4000;

/** En el PC no hay carpeta de paso: se eligen o arrastran archivos y se suben (ImportPc). */
export default function ImportarScreen() {
  return Platform.OS === 'web' ? <ImportPc /> : <ImportarTelefono />;
}

function ImportarTelefono() {
  const source = useSource();
  const queryClient = useQueryClient();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const folder = useUploads((s) => s.folder);
  const folderLost = useUploads((s) => s.folderLost);
  const items = useUploads((s) => s.items);
  const running = useUploads((s) => s.running);
  const adding = useUploads((s) => s.adding);
  const pending = items.filter((it) => it.status.kind !== 'done').length;

  useEffect(() => {
    if (source.capabilities.upload) loadFolder();
  }, [source]);

  async function choose() {
    try {
      await pickFolder();
    } catch {
      // El usuario cerró el selector sin elegir carpeta.
    }
  }

  async function add(cut: boolean) {
    try {
      const r = await addFiles(cut);
      if (!r) return;
      const notes = [
        r.skipped.length > 0 && `Omitidos (no son audio o ya estaban en la carpeta): ${r.skipped.join(', ')}`,
        r.failed.length > 0 && `No se pudieron copiar: ${r.failed.join(', ')}`,
        r.notDeleted.length > 0 && `Se copiaron, pero el original no se pudo borrar: ${r.notDeleted.join(', ')}`,
      ].filter(Boolean);
      if (notes.length > 0) Alert.alert(`${r.added} archivo${r.added === 1 ? '' : 's'} añadido${r.added === 1 ? '' : 's'}`, notes.join('\n\n'));
    } catch (e) {
      Alert.alert('No se pudieron añadir los archivos', e instanceof Error ? e.message : undefined);
    }
  }

  async function start() {
    const { uploaded, failed } = await uploadAll(serverSession(source));
    if (uploaded > 0) setTimeout(() => queryClient.invalidateQueries(), LIBRARY_REFRESH_DELAY_MS);
    if (failed > 0) {
      Alert.alert('Algunas subidas fallaron', `${failed} archivo(s) no se subieron y se conservan en el ${DEVICE}.`);
    }
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
      {/* Sin servidor («Este dispositivo») no hay adónde subir: solo Apple Music. */}
      {source.capabilities.upload && (
        <>
      <View className="mx-5 mt-4 mb-4 rounded-xl bg-card p-4 gap-1.5">
        <Text className="text-foreground text-base font-semibold">Cómo funciona</Text>
        <Text className="text-muted text-sm">
          Mueve tus canciones a la carpeta elegida, o tráelas desde cualquier parte con Copiar o Cortar. Al subirlas, Impala compara la huella MD5 con la copia del servidor y
          solo entonces las borra del {DEVICE}.
        </Text>
      </View>

      <Pressable onPress={choose} disabled={running} className="mx-5 mb-4 flex-row items-center rounded-xl bg-card px-4 py-3 active:opacity-60">
        <Ionicons name="folder-open" size={22} color={accent} />
        <View className="flex-1 ml-3">
          <Text className="text-foreground text-base" numberOfLines={1}>
            {folder ? folderLabel(folder) : 'Elegir carpeta'}
          </Text>
          <Text className="text-muted text-xs">
            {folderLost ? 'Ya no hay acceso a la carpeta anterior; elígela de nuevo' : folder ? 'Tocar para cambiar' : 'Impala solo tendrá acceso a esta carpeta'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={muted} />
      </Pressable>

      {folder && (
        <View className="mx-5 mb-4 flex-row gap-3">
          <AddButton icon="copy-outline" label="Copiar archivos" disabled={running || adding} onPress={() => add(false)} />
          <AddButton icon="cut-outline" label="Cortar archivos" disabled={running || adding} onPress={() => add(true)} />
        </View>
      )}
      {adding && (
        <View className="mx-5 mb-4 flex-row items-center gap-2">
          <ActivityIndicator size="small" color={accent} />
          <Text className="text-muted text-sm">Añadiendo archivos a la carpeta…</Text>
        </View>
      )}

      {folder && items.length > 0 && (
        <Pressable
          onPress={start}
          disabled={running || pending === 0}
          className={`mx-5 mb-3 rounded-xl py-3.5 items-center bg-accent ${running || pending === 0 ? 'opacity-50' : 'active:opacity-80'}`}
        >
          {running ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-accent-foreground text-base font-semibold">
              {pending === 0 ? 'Todo subido' : `Subir y borrar ${pending} archivo${pending === 1 ? '' : 's'}`}
            </Text>
          )}
        </Pressable>
      )}
        </>
      )}
    </View>
  );

  return (
    <FlatList
      data={source.capabilities.upload ? items : []}
      keyExtractor={(it) => it.uri}
      ListHeaderComponent={header}
      ListEmptyComponent={
        folder && source.capabilities.upload ? <EmptyState icon="musical-notes-outline" title="No hay audio en la carpeta" subtitle="Mueve aquí archivos FLAC, MP3, Opus…" /> : null
      }
      refreshing={false}
      onRefresh={source.capabilities.upload ? refreshFiles : undefined}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => <UploadRow item={item} />}
    />
  );
}

function AddButton(props: { icon: keyof typeof Ionicons.glyphMap; label: string; disabled: boolean; onPress: () => void }) {
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

function UploadRow({ item }: { item: UploadItem }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const { status } = item;
  const mb = (item.size / 1024 ** 2).toFixed(1);

  const detail =
    status.kind === 'hashing' ? 'Calculando huella…'
    : status.kind === 'uploading' ? `Subiendo… ${Math.round(status.progress * 100)}%`
    : status.kind === 'done' ? (status.duplicate ? `Ya estaba en el servidor · borrado del ${DEVICE}` : `Subido y verificado · borrado del ${DEVICE}`)
    : status.kind === 'error' ? status.message
    : `${mb} MB`;

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
        <Text className={`text-xs ${status.kind === 'error' ? 'text-accent' : 'text-muted'}`} numberOfLines={2}>{detail}</Text>
        {status.kind === 'uploading' && (
          <View className="h-1 mt-1.5 rounded-full bg-separator overflow-hidden">
            <View style={{ width: `${status.progress * 100}%` }} className="h-full bg-accent" />
          </View>
        )}
      </View>
    </View>
  );
}
