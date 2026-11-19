import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Switch, Text, View } from 'react-native';
import { withUniwind } from 'uniwind';
import { contextMenu } from '@/components/desktop/contextMenu';
import { LargeTitle } from '@/components/LargeTitle';
import { EmptyState } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { confirmUnsubscribe, openSubscription as open, promptSubscribe } from '@/subscriptions/actions';
import { canDownloadEpisodes, syncDownloads } from '@/subscriptions/downloads';
import { relativeDate } from '@/subscriptions/format';
import { newCount, refreshAll, setDownloadWifiOnly, type Subscription, useDownloadWifiOnly, useSubscriptions, visibleEpisodes } from '@/subscriptions/store';

const StyledImage = withUniwind(Image);

/** Canales de YouTube y podcasts a los que te suscribiste, con cuántos episodios nuevos tiene cada uno. */
export default function SuscripcionesScreen() {
  const subs = useSubscriptions();
  const accent = useThemeColor('accent');
  const [refreshing, setRefreshing] = useState(false);

  // Al entrar se revisan (cada feed como mucho cada 15 min); deslizando hacia abajo, todos ya.
  useEffect(() => {
    void refreshAll();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshAll({ force: true });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <FlatList
      data={subs}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={
        <LargeTitle
          title="Suscripciones"
          back
          right={
            <Pressable onPress={() => promptSubscribe(open)} hitSlop={12} className="flex-row items-center gap-1 active:opacity-50">
              <Ionicons name="add" size={24} color={accent} />
              <Text className="text-accent text-base">Añadir</Text>
            </Pressable>
          }
        />
      }
      ListEmptyComponent={
        <EmptyState
          icon="radio-outline"
          title="Aún no tienes suscripciones"
          subtitle="Sigue un canal de YouTube (oraciones, misa, predicaciones…) o un podcast: toca «Añadir» y pega su enlace o el de cualquiera de sus videos."
        />
      }
      ListFooterComponent={subs.length > 0 && canDownloadEpisodes ? <WifiOnly /> : null}
      refreshing={refreshing}
      onRefresh={refresh}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => <SubscriptionRow sub={item} />}
    />
  );
}

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const fresh = newCount(sub);
  const latest = visibleEpisodes(sub)[0];
  const detail = sub.error
    ? sub.error
    : [sub.kind === 'youtube' ? 'YouTube' : 'Podcast', latest ? `último ${relativeDate(latest.published)}` : 'sin episodios'].join(' · ');
  const more = () => confirmUnsubscribe(sub);

  return (
    <Pressable onPress={() => open(sub)} onLongPress={more} {...contextMenu(more)} className="flex-row items-center px-5 active:bg-card">
      <View className={`w-14 h-14 bg-card overflow-hidden items-center justify-center ${sub.kind === 'youtube' ? 'rounded-full' : 'rounded-lg'}`}>
        <Ionicons name={sub.kind === 'youtube' ? 'logo-youtube' : 'mic'} size={22} color={muted} />
        {sub.image && <StyledImage source={{ uri: sub.image }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
      </View>
      <View className="flex-1 flex-row items-center ml-3 py-3 border-b border-separator">
        <View className="flex-1">
          <Text className="text-foreground text-base" numberOfLines={1}>{sub.title}</Text>
          <Text className={`text-sm ${sub.error ? 'text-accent' : 'text-muted'}`} numberOfLines={1}>{detail}</Text>
        </View>
        {fresh > 0 && (
          <View style={{ backgroundColor: accent }} className="min-w-6 h-6 px-2 rounded-full items-center justify-center ml-2" accessibilityLabel={`${fresh} nuevos`}>
            <Text className="text-white text-xs font-bold">{fresh}</Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={18} color={muted} style={{ marginLeft: 8 }} />
      </View>
    </Pressable>
  );
}

/** Las descargas automáticas de episodios, solo con Wi-Fi (o una red sin límite de datos). */
function WifiOnly() {
  const wifiOnly = useDownloadWifiOnly();
  const accent = useThemeColor('accent');
  return (
    <View className="mx-5 mt-6">
      <View className="flex-row items-center rounded-xl bg-card px-4 py-3">
        <Text className="flex-1 text-foreground text-base">Descargar episodios solo con Wi-Fi</Text>
        <Switch
          value={wifiOnly}
          onValueChange={(v) => {
            setDownloadWifiOnly(v);
            void syncDownloads();
          }}
          trackColor={{ true: accent }}
        />
      </View>
      <Text className="text-muted text-xs mt-2 px-1">
        Cada suscripción descarga sola sus episodios más nuevos (se cambia en su menú …) y los borra cuando los terminas.
      </Text>
    </View>
  );
}
