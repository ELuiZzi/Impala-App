import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColor } from '@/components/theme';
import { DEFAULT_FOLDER } from '@/sources/localData';
import { requestAudioPermission, useAudioPermission } from '@/sources/permission';

/**
 * Antes de leer la música del teléfono: explica para qué hace falta el permiso y lo pide. Si se niega,
 * la app no se bloquea: se puede volver a pedir, darlo desde los ajustes de Android o usar un servidor.
 */
export default function PermisoScreen() {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const permission = useAudioPermission();
  const [busy, setBusy] = useState(false);
  const blocked = permission === 'blocked';
  const folder = DEFAULT_FOLDER.replace(/\/$/, '');

  async function ask() {
    if (blocked) return Linking.openSettings();
    setBusy(true);
    try {
      await requestAudioPermission();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}
    >
      <View className="w-20 h-20 rounded-3xl bg-card items-center justify-center mb-6">
        <Ionicons name="musical-notes" size={40} color={accent} />
      </View>
      <Text className="text-foreground text-3xl font-bold">Tu música, en tu teléfono</Text>
      <Text className="text-muted text-base mt-3 leading-6">
        Impala reproduce las canciones guardadas en la carpeta <Text className="text-foreground font-semibold">{folder}</Text> (y sus
        subcarpetas). Para verlas necesita permiso para leer la música y el audio del teléfono.
      </Text>
      <Text className="text-muted text-base mt-3 leading-6">
        Solo las lee para mostrarlas y reproducirlas: no se suben a ningún sitio. En Ajustes puedes elegir otras carpetas.
      </Text>

      {permission === 'denied' && (
        <Text className="text-accent text-sm mt-6">Sin este permiso Impala no puede ver tu música. Puedes volver a intentarlo.</Text>
      )}
      {blocked && (
        <Text className="text-accent text-sm mt-6">
          Android ya no deja preguntar de nuevo. Dalo en Ajustes de Android → Permisos → Música y audio (o Almacenamiento).
        </Text>
      )}

      <Pressable onPress={ask} disabled={busy} className="mt-8 rounded-xl py-4 items-center bg-accent active:opacity-80">
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text className="text-accent-foreground text-base font-semibold">{blocked ? 'Abrir ajustes de Android' : 'Permitir acceso'}</Text>
        )}
      </Pressable>

      <Pressable onPress={() => router.push('/login')} className="mt-4 py-3 items-center active:opacity-60">
        <Text className="text-accent text-base">Usar mi servidor propio</Text>
      </Pressable>
    </ScrollView>
  );
}
