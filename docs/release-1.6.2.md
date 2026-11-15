# Impala 1.6.2

## Correcciones

- **Playlists grandes de Apple Music**: al importar una playlist de más de 300 canciones solo llegaban las primeras
  300 (la página de Apple no muestra más). Ahora Impala pide el resto igual que lo hace la web de Apple Music al bajar
  por la lista, y se importan completas (hasta 1000 canciones). Si Apple no lo permite, se importan las que haya y se
  avisa de que la playlist puede tener más.
- **Buscar dentro de una lista**: al buscar en una playlist, en «Canciones» o en «Descargadas» y tocar una canción,
  solo sonaban los resultados de la búsqueda. Ahora suena la lista entera, empezando por la canción que tocaste; la
  búsqueda solo cambia lo que se ve. «Reproducir» y «Aleatorio» también usan la lista completa.

## Instalar

**Teléfono**: si ya tienes Impala 1.6.1, la app te avisará de esta versión y la instala encima conservándolo todo.
También puedes descargar `Impala-1.6.2.apk` (Android 7 o superior, arm64) y abrirlo.

Código y documentación: https://github.com/ELuiZzi/Impala-App
