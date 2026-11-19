import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlaylists } from '@/api/queries';
import { LargeTitle } from '@/components/LargeTitle';
import { songCount, useThemeColor } from '@/components/theme';
import { isFavoritesPlaylist } from '@/library/favorites';
import { FAVORITES_PIN, usePins } from '@/library/pins';
import { askEnableSimpleMode } from '@/simple/actions';
import { setSimplePlaylists, setSubscriptionShown, useSimpleMode } from '@/simple/store';
import { useSource, type Playlist } from '@/sources';
import { useSubscriptions } from '@/subscriptions/store';

/**
 * Qué aparece en el inicio del modo sencillo: qué suscripciones («Mis oraciones») y qué playlists («Mis
 * canciones»). Se prepara aquí, con la app normal, antes de activar el modo.
 */
export default function SimpleModeSettings() {
  const insets = useSafeAreaInsets();
  const source = useSource();
  const subs = useSubscriptions();
  const { hiddenSubscriptions, playlists: chosen } = useSimpleMode();
  const pins = usePins();
  const all = usePlaylists().data ?? [];

  // Sin elegir: las fijadas de la Biblioteca.
  const pinnedIds = pins
    .map((pin) => (pin === FAVORITES_PIN ? all.find((p) => isFavoritesPlaylist(p, source)) : all.find((p) => p.id === pin)))
    .filter((p): p is Playlist => !!p)
    .map((p) => p.id);
  const shownPlaylists = chosen ?? pinnedIds;

  const togglePlaylist = (id: string) =>
    setSimplePlaylists(shownPlaylists.includes(id) ? shownPlaylists.filter((p) => p !== id) : [...shownPlaylists, id]);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <LargeTitle title="Modo sencillo" back />

      <Section title="Mis oraciones" footer="Las suscripciones marcadas salen en el inicio sencillo, con su oración más nueva lista para escuchar.">
        {subs.length === 0 && <Empty text="Aún no tienes suscripciones (Biblioteca → Suscripciones)." />}
        {subs.map((s, i) => (
          <Check
            key={s.id}
            label={s.title}
            detail={s.kind === 'youtube' ? 'Canal de YouTube' : 'Podcast'}
            checked={!hiddenSubscriptions.includes(s.id)}
            last={i === subs.length - 1}
            onPress={() => setSubscriptionShown(s.id, hiddenSubscriptions.includes(s.id))}
          />
        ))}
      </Section>

      <Section
        title="Mis canciones"
        footer={chosen ? 'Salen las playlists marcadas (en el orden en que las marcaste).' : 'Ahora salen tus playlists fijadas de la Biblioteca. Marca o desmarca para elegir otras.'}
      >
        {all.length === 0 && <Empty text="Aún no tienes playlists." />}
        {all.map((p, i) => (
          <Check
            key={p.id}
            label={p.name}
            detail={songCount(p.songCount)}
            checked={shownPlaylists.includes(p.id)}
            last={i === all.length - 1}
            onPress={() => togglePlaylist(p.id)}
          />
        ))}
        {chosen && (
          <Pressable onPress={() => setSimplePlaylists(null)} className="active:opacity-60">
            <Text className="text-accent text-base ml-4 py-3">Volver a usar las fijadas</Text>
          </Pressable>
        )}
      </Section>

      <Pressable onPress={askEnableSimpleMode} className="mx-5 mt-8 rounded-xl bg-accent py-3.5 items-center active:opacity-80">
        <Text className="text-accent-foreground text-base font-semibold">Activar el modo sencillo</Text>
      </Pressable>
    </ScrollView>
  );
}

function Section({ title, footer, children }: { title: string; footer?: string; children: React.ReactNode }) {
  return (
    <View className="mt-6">
      <Text className="text-muted text-xs font-semibold uppercase px-9 mb-1.5">{title}</Text>
      <View className="mx-5 rounded-xl bg-card overflow-hidden">{children}</View>
      {!!footer && <Text className="text-muted text-xs px-9 mt-1.5">{footer}</Text>}
    </View>
  );
}

function Check({ label, detail, checked, last, onPress }: { label: string; detail: string; checked: boolean; last?: boolean; onPress: () => void }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  return (
    <Pressable onPress={onPress} className="active:opacity-60" accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View className={`flex-row items-center ml-4 pr-4 py-2.5 ${last ? '' : 'border-b border-separator'}`}>
        <View className="flex-1">
          <Text className="text-foreground text-base" numberOfLines={1}>{label}</Text>
          <Text className="text-muted text-xs">{detail}</Text>
        </View>
        <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={checked ? accent : muted} />
      </View>
    </Pressable>
  );
}

function Empty({ text }: { text: string }) {
  return <Text className="text-muted text-sm px-4 py-3">{text}</Text>;
}
