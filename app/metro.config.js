const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

// En PC (web) estos módulos de Expo no funcionan igual: se sustituyen por versiones propias con la misma API.
const webShims = {
  'expo-file-system': path.resolve(__dirname, 'src/platform/web/file-system.ts'),
  'expo-secure-store': path.resolve(__dirname, 'src/platform/web/secure-store.ts'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && webShims[moduleName]) {
    return { type: 'sourceFile', filePath: webShims[moduleName] };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// withUniwindConfig debe ser el envoltorio más externo.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
});
