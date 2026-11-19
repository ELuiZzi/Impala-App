const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Permite conexiones http:// sin cifrar. Muchos podcasts aún sirven el feed, el audio o las redirecciones de
 * estadísticas por http (Libsyn, Podtrac…), y un servidor propio en la red de casa puede no tener https.
 * Sin esto, Android (targetSdk ≥ 28) las bloquea y el podcast no se puede leer, escuchar ni descargar.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) throw new Error('withCleartextTraffic: no hay <application> en el manifiesto');
    app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
