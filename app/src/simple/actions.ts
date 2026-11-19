import { router } from 'expo-router';
import { Alert } from 'react-native';
import { closeSheet, showSheet } from '@/components/sheets/store';
import { disableSimpleMode, enableSimpleMode, simpleMode } from './store';

/** Desde Ajustes: explica el modo, ofrece protegerlo con un código y lo activa. */
export function askEnableSimpleMode() {
  const enable = (pin: string | null) => {
    enableSimpleMode(pin);
    router.replace('/sencillo');
  };
  Alert.alert(
    'Modo sencillo',
    'Letra grande y pocos botones: solo las oraciones y las playlists que elegiste en «Elegir qué oraciones y playlists se ven». ¿Quieres un código de 4 cifras para salir, para que no se quite por error?',
    [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sin código', onPress: () => enable(null) },
      {
        text: 'Con código',
        onPress: () =>
          showSheet({
            kind: 'prompt',
            title: 'Código para salir (4 cifras)',
            placeholder: '0000',
            confirmLabel: 'Activar',
            numeric: true,
            maxLength: 4,
            onSubmit: (text) => {
              if (!/^\d{4}$/.test(text)) throw new Error('Escribe 4 cifras');
              closeSheet();
              enable(text);
            },
          }),
      },
    ],
  );
}

/** Desde el modo sencillo: pide el código si lo hay y vuelve a la app normal. */
export function askExitSimpleMode() {
  const exit = () => {
    disableSimpleMode();
    router.replace('/biblioteca');
  };
  const { pin } = simpleMode();
  if (!pin) {
    Alert.alert('Salir del modo sencillo', '¿Volver a la app completa?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', onPress: exit },
    ]);
    return;
  }
  showSheet({
    kind: 'prompt',
    title: 'Código para salir',
    placeholder: '0000',
    confirmLabel: 'Salir',
    numeric: true,
    secure: true,
    maxLength: 4,
    onSubmit: (text) => {
      if (text !== simpleMode().pin) throw new Error('Código incorrecto');
      closeSheet();
      exit();
    },
  });
}
