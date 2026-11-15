import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/session';
import { useThemeColor } from '@/components/theme';

/** Conectar con un servidor propio (Navidrome). Se llega desde Ajustes → Fuente de música o desde el permiso. */
export default function LoginScreen() {
  const { signIn, mode, session } = useAuth();
  const insets = useSafeAreaInsets();
  const muted = useThemeColor('muted');
  const accent = useThemeColor('accent');
  const [server, setServer] = useState(session?.server ?? '');
  const [username, setUsername] = useState(session?.username ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  // Tras conectar se vuelve a donde estaba (Ajustes), ya con el servidor como fuente. Espera a que la
  // fuente cambie: hasta entonces las pantallas de la biblioteca podrían seguir protegidas.
  useEffect(() => {
    if (!connected || mode !== 'server') return;
    if (router.canGoBack()) router.back();
    else router.replace('/biblioteca');
  }, [connected, mode]);

  const canSubmit = server.trim() && username.trim() && password && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(server, username, password);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  const input = 'bg-card text-foreground text-base rounded-xl px-4 py-3.5';

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}
      >
        {router.canGoBack() && (
          <Pressable onPress={() => router.back()} hitSlop={12} className="absolute left-4 active:opacity-50" style={{ top: insets.top + 12 }}>
            <Ionicons name="chevron-back" size={28} color={accent} />
          </Pressable>
        )}
        <Image source={require('../../assets/icon.png')} style={{ width: 84, height: 84, borderRadius: 20, marginBottom: 20 }} />
        <Text className="text-accent text-5xl font-bold">Impala</Text>
        <Text className="text-muted text-base mt-2 mb-10">Tu música, desde tu servidor.</Text>

        <View className="gap-3">
          <Text className="text-muted text-xs font-semibold uppercase ml-1">Servidor</Text>
          <TextInput
            className={input}
            value={server}
            onChangeText={setServer}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://servidor.ts.net"
            placeholderTextColor={muted}
          />
          <Text className="text-muted text-xs font-semibold uppercase ml-1 mt-3">Cuenta de Navidrome</Text>
          <TextInput
            className={input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            placeholder="Usuario"
            placeholderTextColor={muted}
          />
          <TextInput
            className={input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            placeholder="Contraseña"
            placeholderTextColor={muted}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>

        {error && <Text className="text-accent text-sm mt-4 ml-1">{error}</Text>}

        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          className={`mt-8 rounded-xl py-4 items-center bg-accent ${canSubmit ? 'active:opacity-80' : 'opacity-40'}`}
        >
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text className="text-accent-foreground text-base font-semibold">Conectar</Text>}
        </Pressable>

        <Text className="text-muted text-xs text-center mt-6">
          La dirección https de tu Navidrome: de Tailscale (opcional) o pública.
        </Text>
        <Text className="text-muted text-xs text-center mt-2">
          La contraseña no se guarda: solo un token derivado, cifrado en el dispositivo.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
