import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueries } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';
import { usePlaylists } from '@/api/queries';
import { invalidatePlaylists } from '@/api/queryClient';
import { isFavoritesPlaylist, setFavorite } from '@/library/favorites';
import { sourceKey, useMaybeSource, type Song } from '@/sources';
import { Artwork } from '../Artwork';
import { COVER_STYLES, PlaylistCover } from '../PlaylistCover';
import { PlaylistArt } from '../rows';
import { DIRECTION_LABELS, SORT_LABELS, type SortState } from '../SongFilter';
import { showToast } from '../Toast';
import { useThemeColor } from '../theme';
import { closeSheet, showSheet, useSheet, type SheetOption } from './store';
import { TuningSheet } from './TuningSheet';
import { ListMarquee, Marquee } from '@/components/Marquee';

const StyledImage = withUniwind(Image);

/** Hojas inferiores globales: menú de acciones, selector de playlist y cuadro de texto. */
export function Sheets() {
  const sheet = useSheet();
  const source = useMaybeSource();
  if (!sheet || !source) return null;

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={closeSheet}>
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
        {/* La hoja de orden deja ver la lista detrás, que se reordena mientras se eligen opciones. */}
        <Pressable onPress={closeSheet} className={`absolute inset-0 ${sheet.kind === 'sort' ? 'bg-black/20' : 'bg-black/50'}`} />
        {sheet.kind === 'actions' && <ActionsSheet {...sheet} />}
        {sheet.kind === 'playlistPicker' && <PlaylistPicker songs={sheet.songs} pending={sheet.pending} />}
        {sheet.kind === 'prompt' && <PromptSheet {...sheet} />}
        {sheet.kind === 'sort' && <SortSheet {...sheet} />}
        {sheet.kind === 'coverStyle' && <CoverStyleSheet {...sheet} />}
        {sheet.kind === 'tuning' && <TuningSheet {...sheet} />}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Orden de una lista en una hoja flotante que ocupa casi media pantalla: arriba el sentido
 * (ascendente/descendente) y debajo los criterios. Cada toque se aplica al instante.
 */
function SortSheet({ sorts, value, initial, onChange }: Extract<NonNullable<ReturnType<typeof useSheet>>, { kind: 'sort' }>) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const card = useThemeColor('card');
  const [state, setState] = useState(value);
  const update = (next: SortState) => {
    setState(next);
    onChange(next);
  };
  const [ascLabel, descLabel] = DIRECTION_LABELS[state.sort];

  return (
    <View
      // Ligeramente translúcida: se adivina la lista detrás.
      style={{ minHeight: height * 0.46, maxHeight: height * 0.62, marginBottom: Math.max(insets.bottom, 12), backgroundColor: `${card}FA` }}
      className="mx-3 rounded-3xl pt-2 pb-3 overflow-hidden"
    >
      <View className="self-center w-10 h-1.5 rounded-full bg-separator mb-3" />
      <View className="flex-row items-center justify-between px-5 mb-3">
        <Text className="text-foreground text-lg font-bold">Ordenar por</Text>
        <Pressable onPress={closeSheet} hitSlop={10} className="active:opacity-50">
          <Text className="text-accent text-base font-semibold">Listo</Text>
        </Pressable>
      </View>
      {/* Sentido: control segmentado. */}
      <View className="mx-5 mb-2 flex-row rounded-xl bg-background p-1">
        {[false, true].map((descending) => {
          const active = state.descending === descending;
          return (
            <Pressable
              key={String(descending)}
              onPress={() => update({ ...state, descending })}
              className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-lg py-2 ${active ? 'bg-accent' : 'active:opacity-60'}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Ionicons name={descending ? 'arrow-down' : 'arrow-up'} size={15} color={active ? '#ffffff' : muted} />
              <Text className={`text-sm font-semibold ${active ? 'text-accent-foreground' : 'text-muted'}`} numberOfLines={1}>
                {descending ? descLabel : ascLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView>
        {sorts.map((s, i) => {
          const active = state.sort === s;
          return (
            <Pressable
              key={s}
              onPress={() => update({ sort: s, descending: state.sort === s ? state.descending : false })}
              className="flex-row items-center px-5 active:bg-separator"
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
            >
              <Text className={`flex-1 py-3.5 text-base ${active ? 'text-accent font-semibold' : 'text-foreground'} ${i === sorts.length - 1 ? '' : 'border-b border-separator'}`}>
                {SORT_LABELS[s]}
                {s === initial ? <Text className="text-muted text-sm font-normal">  · habitual</Text> : null}
              </Text>
              {active && <Ionicons name="checkmark" size={22} color={accent} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Estilo de la carátula genérica de una playlist: cuadrícula de degradados para elegir. */
function CoverStyleSheet({ name, current, onSelect }: Extract<NonNullable<ReturnType<typeof useSheet>>, { kind: 'coverStyle' }>) {
  const { width } = useWindowDimensions();
  const accent = useThemeColor('accent');
  const [selected, setSelected] = useState(current);
  const columns = 4;
  const size = Math.floor((Math.min(width, 520) - 40 - (columns - 1) * 12) / columns);
  return (
    <Panel>
      <Text className="text-foreground text-lg font-bold px-5 pb-1">Estilo de la portada</Text>
      <Text className="text-muted text-sm px-5 pb-3">Toca un degradado para usarlo en «{name}».</Text>
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 20 }}>
        {[null, ...COVER_STYLES.map((_, i) => i)].map((style) => {
          const active = selected === style;
          return (
            <Pressable
              key={String(style)}
              onPress={() => {
                setSelected(style);
                onSelect(style);
              }}
              className="active:opacity-70"
              accessibilityLabel={style === null ? 'Automático' : `Degradado ${style + 1}`}
            >
              <View style={{ width: size, height: size, borderWidth: 3, borderColor: active ? accent : 'transparent' }} className="rounded-xl overflow-hidden">
                <PlaylistCover name={name} size={size} style={style} className="flex-1" />
              </View>
              <Text className={`text-xs text-center mt-1 ${active ? 'text-accent font-semibold' : 'text-muted'}`}>{style === null ? 'Automático' : COVER_STYLES[style].name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View className="px-5 mt-3">
        <Pressable onPress={closeSheet} className="rounded-xl py-3 items-center bg-accent active:opacity-80">
          <Text className="text-accent-foreground text-base font-semibold">Listo</Text>
        </Pressable>
      </View>
    </Panel>
  );
}

export function Panel({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }} className="bg-card rounded-t-3xl pt-2">
      <View className="self-center w-10 h-1.5 rounded-full bg-separator mb-2" />
      {children}
    </View>
  );
}

function OptionRow({ option, last }: { option: SheetOption; last?: boolean }) {
  const accent = useThemeColor('accent');
  const foreground = useThemeColor('foreground');
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await option.onPress();
        } finally {
          setBusy(false);
        }
      }}
      className="flex-row items-center px-5 active:bg-separator"
    >
      <View className="w-7 items-center">
        {busy ? <ActivityIndicator color={accent} /> : <Ionicons name={option.icon} size={22} color={option.destructive ? accent : foreground} />}
      </View>
      <Text className={`flex-1 ml-4 py-3.5 text-base ${option.destructive ? 'text-accent' : 'text-foreground'} ${last ? '' : 'border-b border-separator'}`}>
        {option.label}
      </Text>
    </Pressable>
  );
}

function ActionsSheet({ title, subtitle, coverArt, thumbnail, options }: Extract<NonNullable<ReturnType<typeof useSheet>>, { kind: 'actions' }>) {
  return (
    <Panel>
      <View className="flex-row items-center px-5 pb-3 mb-1 border-b border-separator">
        {thumbnail ? (
          <StyledImage source={{ uri: thumbnail }} contentFit="cover" cachePolicy="disk" className="w-12 h-12 rounded-lg bg-background" />
        ) : (
          <Artwork coverArt={coverArt} size={48} className="w-12 h-12 rounded-lg" />
        )}
        <View className="flex-1 ml-3">
          <Marquee className="text-foreground text-base font-semibold">{title}</Marquee>
          {subtitle ? <Marquee className="text-muted text-sm">{subtitle}</Marquee> : null}
        </View>
      </View>
      {options.map((o, i) => (
        <OptionRow key={o.label} option={o} last={i === options.length - 1} />
      ))}
    </Panel>
  );
}

type Membership = 'all' | 'some' | 'none';

/**
 * Casillas de las playlists propias, marcadas si ya contienen las canciones. "Listo" añade las
 * canciones a las recién marcadas y las quita de las desmarcadas. En "Canciones Favoritas" eso
 * equivale a poner o quitar la estrella.
 */
function PlaylistPicker({ songs, pending }: { songs: Song[]; pending?: { title: string; resolve: () => Promise<Song[]> } }) {
  const source = useMaybeSource();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const playlists = usePlaylists();
  const own = (playlists.data ?? []).filter((p) => !source || source.isOwnPlaylist(p));
  // Mismas claves que usePlaylist: se reutiliza la caché de las pantallas de playlist.
  const contents = useQueries({
    queries: own.map((p) => ({
      queryKey: source ? sourceKey(source, 'playlist', p.id) : ['playlist', p.id],
      queryFn: () => source!.getPlaylist(p.id),
      enabled: !!source,
    })),
  });
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!source) return null;
  const ids = songs.map((s) => s.id);

  const membership = (i: number): Membership | null => {
    if (pending) return 'none'; // aún no está en la biblioteca: no puede estar en ninguna
    const entries = contents[i]?.data?.entry;
    if (!contents[i]?.data) return null;
    const present = new Set((entries ?? []).map((e) => e.id));
    const count = ids.filter((id) => present.has(id)).length;
    return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
  };

  const toggle = (id: string, initial: Membership) =>
    setChanges((c) => {
      const next = !(id in c ? c[id] : initial === 'all');
      const rest = { ...c };
      delete rest[id];
      // Volver al estado inicial deshace el cambio; una playlist parcial alterna entre todas y ninguna.
      return initial !== 'some' && next === (initial === 'all') ? rest : { ...rest, [id]: next };
    });

  async function save(target: Song[], entriesOf: (i: number) => Song[]) {
    const targetIds = target.map((s) => s.id);
    for (const [i, p] of own.entries()) {
      if (!(p.id in changes)) continue;
      const add = changes[p.id];
      const entries = entriesOf(i);
      if (isFavoritesPlaylist(p, source!)) {
        const present = new Set(entries.map((e) => e.id));
        for (const song of target) if (present.has(song.id) !== add) await setFavorite(source!, song, add);
      } else if (add) {
        const present = new Set(entries.map((e) => e.id));
        const missing = targetIds.filter((id) => !present.has(id));
        if (missing.length > 0) await source!.addToPlaylist(p.id, missing);
      } else {
        const remove = entries.flatMap((e, index) => (targetIds.includes(e.id) ? [index] : []));
        if (remove.length > 0) await source!.removeFromPlaylist(p.id, remove);
      }
    }
    await invalidatePlaylists(source!);
  }

  async function apply() {
    if (pending) {
      // Se cierra ya; las playlists se actualizan cuando la canción termine de descargarse.
      const count = Object.values(changes).filter(Boolean).length;
      closeSheet();
      showToast(`«${pending.title}» se añadirá a ${count === 1 ? '1 playlist' : `${count} playlists`} al terminar de descargarse`, 'cloud-download-outline');
      pending
        .resolve()
        .then((resolved) => save(resolved, () => []))
        .then(() => showToast(`«${pending.title}» añadida a tus playlists`))
        .catch((e) => Alert.alert('No se pudo añadir a las playlists', e instanceof Error ? e.message : undefined));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save(songs, (i) => contents[i]?.data?.entry ?? []);
      closeSheet();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron guardar los cambios');
    } finally {
      setBusy(false);
    }
  }

  const createNew = () =>
    showSheet({
      kind: 'prompt',
      title: 'Nueva playlist',
      placeholder: 'Nombre',
      confirmLabel: 'Crear',
      onSubmit: async (name) => {
        if (pending) {
          closeSheet();
          showToast(`«${pending.title}» irá a «${name}» al terminar de descargarse`, 'cloud-download-outline');
          pending
            .resolve()
            .then(async (resolved) => {
              await source.createPlaylist(name, resolved.map((s) => s.id));
              await invalidatePlaylists(source);
              showToast(`Playlist «${name}» creada`);
            })
            .catch((e) => Alert.alert('No se pudo crear la playlist', e instanceof Error ? e.message : undefined));
          return;
        }
        await source.createPlaylist(name, ids);
        await invalidatePlaylists(source);
        closeSheet();
      },
    });

  const dirty = Object.keys(changes).length > 0;

  return (
    <Panel>
      <Text className="text-foreground text-lg font-bold px-5 pb-2">Añadir a playlists</Text>
      <ScrollView style={{ maxHeight: 440 }}>
        <Pressable onPress={createNew} className="flex-row items-center px-5 py-2 active:bg-separator">
          <View className="w-12 h-12 rounded-lg bg-background items-center justify-center">
            <Ionicons name="add" size={26} color={accent} />
          </View>
          <Text className="flex-1 ml-3 text-accent text-base">Nueva playlist…</Text>
        </Pressable>
        {playlists.isPending && <ActivityIndicator className="my-4" color={accent} />}
        {own.map((p, i) => {
          const initial = membership(i);
          const checked = p.id in changes ? changes[p.id] : initial === 'all';
          const icon = checked ? 'checkbox' : initial === 'some' && !(p.id in changes) ? 'remove-circle' : 'square-outline';
          return (
            <Pressable
              key={p.id}
              disabled={!initial || busy}
              onPress={() => initial && toggle(p.id, initial)}
              className="flex-row items-center px-5 py-2 active:bg-separator"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: initial === 'some' && !(p.id in changes) ? 'mixed' : checked }}
            >
              <PlaylistArt playlist={p} size={48} className="w-12 h-12 rounded-lg" />
              <View className="flex-1 ml-3">
                <ListMarquee className="text-foreground text-base">{p.name}</ListMarquee>
                <Text className="text-muted text-sm">{p.songCount} {p.songCount === 1 ? 'canción' : 'canciones'}</Text>
              </View>
              {initial ? <Ionicons name={icon} size={26} color={checked || icon === 'remove-circle' ? accent : muted} /> : <ActivityIndicator color={muted} />}
            </Pressable>
          );
        })}
      </ScrollView>
      {error && <Text className="text-accent text-sm px-5 mt-2">{error}</Text>}
      <View className="flex-row gap-3 px-5 mt-3">
        <Pressable onPress={closeSheet} className="flex-1 rounded-xl py-3 items-center bg-background active:opacity-60">
          <Text className="text-foreground text-base">Cancelar</Text>
        </Pressable>
        <Pressable
          onPress={apply}
          disabled={!dirty || busy}
          className={`flex-1 rounded-xl py-3 items-center bg-accent ${dirty && !busy ? 'active:opacity-80' : 'opacity-40'}`}
        >
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-accent-foreground text-base font-semibold">Listo</Text>}
        </Pressable>
      </View>
    </Panel>
  );
}

function PromptSheet({ title, placeholder, initialValue, confirmLabel, onSubmit }: Extract<NonNullable<ReturnType<typeof useSheet>>, { kind: 'prompt' }>) {
  const [text, setText] = useState(initialValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = useThemeColor('muted');
  const valid = text.trim().length > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <Text className="text-foreground text-lg font-bold px-5 pb-3">{title}</Text>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={muted}
        returnKeyType="done"
        onSubmitEditing={submit}
        className="mx-5 bg-background text-foreground text-base rounded-xl px-4 py-3"
      />
      {error && <Text className="text-accent text-sm px-5 mt-2">{error}</Text>}
      <View className="flex-row gap-3 px-5 mt-4">
        <Pressable onPress={closeSheet} className="flex-1 rounded-xl py-3 items-center bg-background active:opacity-60">
          <Text className="text-foreground text-base">Cancelar</Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={!valid || busy}
          className={`flex-1 rounded-xl py-3 items-center bg-accent ${valid && !busy ? 'active:opacity-80' : 'opacity-40'}`}
        >
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-accent-foreground text-base font-semibold">{confirmLabel}</Text>}
        </Pressable>
      </View>
    </Panel>
  );
}
