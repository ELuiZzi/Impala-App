const { withMainActivity } = require('expo/config-plugins');

/**
 * Ignora el ajuste de accesibilidad "Texto en negrita" de Android (Configuration.fontWeightAdjustment)
 * dentro de la app.
 *
 * React Native mide el texto con el grosor normal pero Android lo dibuja con el grosor ajustado
 * (más ancho), así que con ese ajuste activo el texto se recorta: "Dirección" → "Direcció",
 * "Cerrar sesión" → "Cerrar". Sin el ajuste, medición y dibujo coinciden.
 */
const MARKER = '// impala: withoutFontWeightAdjustment';

const OVERRIDE = `
  ${MARKER}
  override fun attachBaseContext(newBase: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        newBase.resources.configuration.fontWeightAdjustment != 0) {
      val config = Configuration(newBase.resources.configuration)
      config.fontWeightAdjustment = 0
      super.attachBaseContext(newBase.createConfigurationContext(config))
    } else {
      super.attachBaseContext(newBase)
    }
  }
`;

module.exports = function withoutFontWeightAdjustment(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('withoutFontWeightAdjustment: se esperaba MainActivity.kt');
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;

    for (const imp of ['android.content.Context', 'android.content.res.Configuration', 'android.os.Build']) {
      if (!src.includes(`import ${imp}\n`)) src = src.replace(/^(package [^\n]+\n)/, `$1import ${imp}\n`);
    }

    const classDecl = /class MainActivity : ReactActivity\(\) \{\n/;
    if (!classDecl.test(src)) throw new Error('withoutFontWeightAdjustment: no se encontró la clase MainActivity');
    cfg.modResults.contents = src.replace(classDecl, (m) => m + OVERRIDE);
    return cfg;
  });
};
