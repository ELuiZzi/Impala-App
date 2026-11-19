// Entrada de la app (Android). En PC se usa index.web.ts, que antes carga los archivos guardados.
// La revisión de suscripciones en segundo plano se define antes que nada: Android puede arrancar solo el JS.
import './src/subscriptions/background';
import 'expo-router/entry';
