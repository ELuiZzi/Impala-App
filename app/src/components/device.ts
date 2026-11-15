import { Platform } from 'react-native';

/** Cómo se llama el dispositivo en los textos: «teléfono» en Android y «equipo» en la app de PC. */
export const DEVICE = Platform.OS === 'web' ? 'equipo' : 'teléfono';
