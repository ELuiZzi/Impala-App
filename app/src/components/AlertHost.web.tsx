import { useEffect, useSyncExternalStore } from 'react';
import { Alert, Pressable, Text, View, type AlertButton } from 'react-native';

/**
 * En web, Alert.alert de React Native no hace nada: sin esto no saldrían las confirmaciones (cerrar sesión,
 * borrar una playlist…) ni los avisos de error. Se sustituye por un diálogo propio, con los mismos botones.
 */
type Dialog = { id: number; title: string; message?: string; buttons: AlertButton[] };

const queue: Dialog[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  queue.push({ id: nextId++, title, message, buttons: buttons?.length ? buttons : [{ text: 'Aceptar' }] });
  notify();
};

function close(dialog: Dialog, button?: AlertButton) {
  const index = queue.indexOf(dialog);
  if (index >= 0) queue.splice(index, 1);
  notify();
  button?.onPress?.();
}

export function AlertHost() {
  const dialog = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => queue[0] ?? null,
  );

  // Escape = el botón de cancelar (o cerrar, si solo hay uno).
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Con un diálogo abierto, Escape es solo suyo (no cierra además el reproductor: ver DesktopShortcuts).
      e.preventDefault();
      const cancel = dialog.buttons.find((b) => b.style === 'cancel') ?? (dialog.buttons.length === 1 ? dialog.buttons[0] : undefined);
      if (cancel) close(dialog, cancel);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialog]);

  if (!dialog) return null;
  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }}
      className="items-center justify-center bg-black/50 px-6"
    >
      <View accessibilityRole="alert" className="w-full max-w-sm rounded-2xl bg-card p-5">
        <Text className="text-foreground text-lg font-bold">{dialog.title}</Text>
        {!!dialog.message && <Text className="text-muted text-sm mt-2 leading-5">{dialog.message}</Text>}
        <View className="flex-row flex-wrap justify-end gap-2 mt-5">
          {dialog.buttons.map((b, i) => (
            <Pressable
              key={`${b.text}-${i}`}
              onPress={() => close(dialog, b)}
              className={`rounded-full px-4 py-2 active:opacity-60 ${b.style === 'cancel' ? '' : 'bg-accent/15'}`}
            >
              <Text className={`text-base font-medium ${b.style === 'cancel' ? 'text-muted' : 'text-accent'}`}>{b.text ?? 'Aceptar'}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}
