const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Fuerza una versión de CMake en todos los módulos nativos (app y librerías).
 *
 * En Windows, el CMake 3.22.1 que usa AGP por defecto trae ninja 1.10, que no soporta
 * rutas de más de 260 caracteres y rompe el build de librerías con codegen
 * (p. ej. react-native-gesture-handler). Desde CMake 3.31 el SDK incluye ninja 1.12,
 * que sí las soporta si Windows tiene LongPathsEnabled=1.
 */
const MARKER = '// impala: withCmakeVersion';

module.exports = function withCmakeVersion(config, { version = '3.31.6' } = {}) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withCmakeVersion solo soporta build.gradle en Groovy');
    }
    const contents = cfg.modResults.contents;
    if (contents.includes(MARKER)) return cfg;

    // Debe registrarse antes de "expo-root-project", que evalúa los subproyectos de inmediato;
    // después AGP ya ha leído la versión y Gradle falla con "It is too late to set version".
    const anchor = 'apply plugin: "expo-root-project"';
    if (!contents.includes(anchor)) throw new Error(`withCmakeVersion: no se encontró '${anchor}' en build.gradle`);

    const block = `${MARKER}
subprojects {
  ['com.android.application', 'com.android.library'].each { id ->
    plugins.withId(id) {
      android.externalNativeBuild.cmake.version = '${version}'
    }
  }
}

`;
    cfg.modResults.contents = contents.replace(anchor, block + anchor);
    return cfg;
  });
};
