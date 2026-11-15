/**
 * Entrada de la app en PC. La app lee sus ajustes de forma síncrona (como en el teléfono) desde el primer
 * import, así que antes de cargarla se traen a memoria los archivos guardados en disco.
 */
import { loadFileSystem } from './src/platform/web/file-system';
import { forwardConsoleToTerminal, routeExternalFetch } from './src/platform/web/net';
import { migrateSecureStore } from './src/platform/web/secure-store';

forwardConsoleToTerminal();
routeExternalFetch();

loadFileSystem()
  .then(migrateSecureStore)
  .catch((e) => console.error('No se pudieron cargar los datos de Impala:', e))
  .finally(() => require('expo-router/entry'));
