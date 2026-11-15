const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Firma de release con una llave propia guardada FUERA del repositorio.
 *
 * Lee `~/.impala/signing.properties` (o la ruta de IMPALA_SIGNING_PROPERTIES) con:
 *   storeFile=impala-release.jks   (relativo a la carpeta del .properties)
 *   storePassword=…  keyAlias=…  keyPassword=…
 * Si no existe, la release se firma con la llave de depuración y Gradle lo avisa.
 *
 * Además, el build de depuración usa el sufijo ".dev" para que la app de desarrollo y la APK final
 * convivan en el teléfono.
 */
const MARKER = '// impala: withReleaseSigning';

const LOADER = `${MARKER}
def impalaSigningFile = new File(System.getenv('IMPALA_SIGNING_PROPERTIES') ?: "\${System.getProperty('user.home')}/.impala/signing.properties")
def impalaSigning = null
if (impalaSigningFile.exists()) {
    impalaSigning = new Properties()
    impalaSigningFile.withInputStream { impalaSigning.load(it) }
} else {
    logger.warn("Impala: no existe \${impalaSigningFile}; la release se firmará con la llave de depuración")
}

`;

const RELEASE_CONFIG = `
        release {
            if (impalaSigning != null) {
                storeFile new File(impalaSigningFile.parentFile, impalaSigning.getProperty('storeFile'))
                storePassword impalaSigning.getProperty('storePassword')
                keyAlias impalaSigning.getProperty('keyAlias')
                keyPassword impalaSigning.getProperty('keyPassword')
            }
        }`;

function replaceOnce(src, pattern, replacement, what) {
  if (!pattern.test(src)) throw new Error(`withReleaseSigning: no se encontró ${what} en app/build.gradle`);
  return src.replace(pattern, replacement);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;

    src = replaceOnce(src, /^android \{/m, `${LOADER}android {`, 'el bloque android');
    src = replaceOnce(src, /(signingConfigs \{)/, `$1${RELEASE_CONFIG}`, 'signingConfigs');
    src = replaceOnce(
      src,
      /(buildTypes \{\s*debug \{\s*signingConfig signingConfigs\.debug)/,
      `$1\n            applicationIdSuffix ".dev"`,
      'el buildType debug',
    );
    src = replaceOnce(
      src,
      /(release \{\s*(?:\/\/[^\n]*\n\s*)*)signingConfig signingConfigs\.debug/,
      '$1signingConfig impalaSigning != null ? signingConfigs.release : signingConfigs.debug',
      'la firma del buildType release',
    );

    cfg.modResults.contents = src;
    return cfg;
  });
};
