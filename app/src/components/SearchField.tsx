import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, TextInput, View } from 'react-native';
import { useThemeColor } from './theme';

/** "Beyoncé" y "beyonce" juntas; sin acentos ni mayúsculas. */
export const fold = (text: string | null | undefined) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** ¿Alguno de los campos contiene la búsqueda? Una búsqueda vacía lo acepta todo. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = fold(query.trim());
  return !q || fields.some((field) => fold(field).includes(q));
}

/** Caja de búsqueda de la cabecera de una lista (Canciones, Artistas, Álbumes, Descargadas, playlists). */
export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (text: string) => void; placeholder: string }) {
  const muted = useThemeColor('muted');
  return (
    <View className="mx-5 flex-row items-center bg-card rounded-xl px-3">
      <Ionicons name="search" size={16} color={muted} />
      <TextInput
        className="flex-1 text-foreground text-base py-2 ml-2"
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={muted}
        autoCorrect={false}
        returnKeyType="search"
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChangeText('')} hitSlop={10} accessibilityLabel="Borrar búsqueda">
          <Ionicons name="close-circle" size={16} color={muted} />
        </Pressable>
      )}
    </View>
  );
}
