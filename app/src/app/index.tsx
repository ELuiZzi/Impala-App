import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/session';
import { useSimpleMode } from '@/simple/store';
import { useAudioPermission } from '@/sources/permission';

/**
 * Ruta inicial. Decide aquí en vez de dejarlo a Stack.Protected: si redirigiera siempre a
 * /biblioteca, sin acceso la protección devolvería a esta pantalla (la primera accesible)
 * y se formaría un bucle. Sin servidor se entra directo a la música del teléfono.
 */
export default function Index() {
  const { session, mode } = useAuth();
  const permission = useAudioPermission();
  const ready = mode === 'local' ? permission === 'granted' : !!session;
  const simple = useSimpleMode().enabled;
  return <Redirect href={!ready ? '/permiso' : simple ? '/sencillo' : '/biblioteca'} />;
}
