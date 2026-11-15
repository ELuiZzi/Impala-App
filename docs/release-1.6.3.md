# Impala 1.6.3

## Novedades

- **Aleatorio y repetir con gestos**: en el reproductor con gestos, mantén pulsada la carátula y aparecen los botones
  de aleatorio y repetir. Al tocar uno cambia y desaparecen; si no tocas ninguno, se van solos. El reproductor sigue
  igual de limpio el resto del tiempo.
- **Fondo con más vida**: las manchas de color del reproductor se mueven un poco más.

## Correcciones

- **Aleatorio sin trabarse**: activar o quitar el aleatorio (desde la app o desde la notificación) con una cola larga
  dejaba la app trabada varios segundos. Ahora la cola se reordena de una sola vez: con 348 canciones pasó de unos
  5 segundos a medio segundo.
- **Playlists grandes de Apple Music también con servidor propio**: el servidor ya importa playlists de más de 300
  canciones completas (hasta 1000), como el modo local desde la 1.6.2. Hace falta actualizar el servidor.

## Instalar

**Teléfono**: si ya tienes Impala 1.6.2, la app te avisará de esta versión y la instala encima conservándolo todo.
También puedes descargar `Impala-1.6.3.apk` (Android 7 o superior, arm64) y abrirlo.

Código y documentación: https://github.com/ELuiZzi/Impala-App
