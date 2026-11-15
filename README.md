# Impala

Reproductor de música para Android (React Native + Expo) y, desde la 1.6, **para Windows** (la misma app en una ventana de
Tauri, ver [Impala para PC](#impala-para-pc)). Reproduce la música guardada en el dispositivo y, opcionalmente, la de un
**servidor propio** (Navidrome en Linux, por Tailscale o una dirección pública). Se distribuye en GitHub Releases (APK e
instalador `.exe`), no en Google Play. Impala no tiene servidor central ni guarda música de nadie.

## Aviso legal

Impala es un reproductor: no aloja, distribuye ni vende música. Cada persona reproduce la música que ya tiene en su
dispositivo o en su propio servidor, y es responsable de tener derecho a usarla. Las funciones que consultan servicios de
terceros (YouTube, Apple Music, LRCLIB, traducción) usan sus interfaces públicas o internas y pueden dejar de funcionar si
esos servicios cambian; úsalas respetando sus condiciones y la ley de tu país. Impala no está afiliada a YouTube, Google,
Apple ni ninguno de esos servicios, y sus marcas pertenecen a sus dueños. Se distribuye bajo la licencia
[GPL-3.0](LICENSE), sin garantía de ningún tipo.

## Arquitectura

- **Servidor (opcional):** un PC con Linux (por ejemplo Ubuntu 24.04), accesible por Tailscale (`mi-servidor.mi-tailnet.ts.net`)
  o por una dirección pública con HTTPS.
  - **Navidrome** (API OpenSubsonic) en `127.0.0.1:4533`, lectura de `/srv/music` en solo lectura.
  - **Ingestión** (Node/Express) en `127.0.0.1:3000`, guarda todo en `/srv/music/Todo/` con el nombre original saneado. Reorganizar por metadatos queda para más adelante. *(Fase 1)*
  - **`tailscale serve`** publica ambos por HTTPS en el puerto 443, solo dentro de la tailnet.
- **App:** Expo (development build) + NativeWind + módulo nativo de audio en Kotlin sobre Media3. *(Fase 2+)*
  - Organización estilo Biblioteca de Apple Music: la carpeta del servidor no importa; la app muestra
    **Canciones** (todo), **Playlists** (del servidor, vía API), y **Artistas/Álbumes** a partir de los tags.

## Despliegue del servidor

```bash
# Copiar compose + uploader (sin node_modules ni tests) y levantar
cd server
tar --exclude=node_modules --exclude=test -czf - docker-compose.yml uploader \
  | ssh usuario@ip-del-servidor "cd /srv/impala && tar -xzf -"
ssh usuario@ip-del-servidor "cd /srv/impala && docker compose -p impala up -d --build"

# HTTPS en la tailnet (persiste tras reinicios)
ssh usuario@ip-del-servidor "tailscale serve --bg --https=443 http://127.0.0.1:4533"
ssh usuario@ip-del-servidor "tailscale serve --bg --https=443 --set-path=/upload http://127.0.0.1:3000"
```

URL: `https://mi-servidor.mi-tailnet.ts.net` (solo tailnet, sin Funnel).
El token del uploader va en `/srv/impala/.env` (permisos 600, no se versiona).

## API de ingestión

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/upload/health` | `{ "ok": true }`, sin autenticación |
| `POST` | `/upload` | `multipart/form-data` con un único campo `file`. Autenticación: `Authorization: Bearer <UPLOAD_TOKEN>` (scripts) **o** las credenciales Subsonic de la app en la query (`?u=…&t=…&s=…`), que el uploader valida contra Navidrome por la red interna de Docker y recuerda 10 min |

Respuesta `201` (nuevo) o `200` (ya existía un archivo idéntico, `duplicate: true`):

```json
{
  "file": "Todo/Tame Impala - Let it happen • sped up.opus",
  "originalName": "- Tame Impala - Let it happen • sped up -.opus",
  "size": 6612735,
  "md5": "…",
  "duplicate": false,
  "metadata": { "title": null, "artist": null, "album": null, "durationSec": 405,
                "codec": "Opus", "sampleRate": 48000, "bitsPerSample": null }
}
```

La app debe borrar el archivo local **solo** si `md5` coincide con el suyo.

### YouTube (yt-dlp)

Mismas formas de autenticación que `POST /upload`. yt-dlp corre dentro del contenedor del uploader
(entorno virtual en `/opt/yt-dlp`, se actualiza al arrancar y cada 24 h; Node resuelve los retos JS).

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/upload/youtube/search?q=…&scope=all` | `scope`: `music` (canciones, álbumes y artistas de YouTube Music, ~1 s), `videos` (búsqueda general) o `all`; la app pide `music` y `videos` por separado y muestra la música en cuanto llega. `{ results: [{ kind, id, title, artist, album, channel, durationSec, views, explicit, thumbnail }], albums: [{ id, title, artist, year, type, explicit, thumbnail }], artists: [{ id, name, thumbnail }] }`: `albums` son álbumes, EP y sencillos de YouTube Music; en `results` primero `kind: "song"` (pistas de audio oficiales de YouTube Music, vía ytmusicapi) y luego `kind: "video"` (búsqueda general). Si `q` es un enlace de YouTube (`watch?v=`, `youtu.be/`, `shorts/`, `music.youtube.com`…), devuelve solo ese video |
| `GET` | `/upload/youtube/preview/:id` | Vista previa: reenvía el audio (m4a) sin guardarlo, con soporte de `Range`. Desde la 1.4 la app pide el audio a YouTube por su cuenta y esta ruta es el respaldo (las URLs de googlevideo quedan ligadas a la IP que las pidió) |
| `GET` | `/upload/youtube/client` | `{ client: { name, id, version, userAgent, context } \| null }`: el cliente de InnerTube con el que el yt-dlp instalado pide audio sin JavaScript ni PO token (`_DEFAULT_JSLESS_CLIENTS`). La app lo usa para sus vistas previas, así sigue a YouTube cuando bloquea un cliente con solo actualizar yt-dlp |
| `GET` | `/upload/youtube/albums/:id` | `{ album: { …, cover, tracks: [{ …resultado, trackNumber }] } }` (`id`: browseId `MPREb_…`) |
| `GET` | `/upload/youtube/artists/:id` · `/upload/youtube/artists?name=…` | `{ artist: { id, name, image, songs, albums, singles } }`: `songs` son las 25 más escuchadas ahora (el orden de YouTube Music). Por id de canal (`UC…`) o por nombre (la página de un artista de la biblioteca); `404` si no está |
| `POST` | `/upload/youtube/downloads` | JSON `{ id }` (id de video de 11 caracteres) → `202 { job }`, o `{ items: [{ id, title, artist, album, albumArtist, trackNumber, year }] }` (hasta 100) → `202 { jobs }`. Con `album`, esos datos sustituyen a los de YouTube en los tags para que Navidrome agrupe el álbum. Una descarga a la vez |
| `GET` | `/upload/youtube/downloads` | `{ jobs: [{ id, videoId, title, artist, status, progress, error?, file?, duplicate?, waitingUntil }] }`, `status`: `queued` · `downloading` · `processing` · `done` · `error` · `cancelled` |
| `DELETE` | `/upload/youtube/downloads/:id` | Cancela una descarga en cola o en curso (mata yt-dlp); `409` si ya se está guardando |
| `GET` | `/upload/youtube/downloads/:id/song` | La canción de Navidrome una vez descargada e indexada (`200 { song }`), `202` mientras tanto. Lo usan las acciones del menú … de un resultado de YouTube |

Se guarda el mejor audio **sin recodificar** (normalmente Opus; YouTube no ofrece audio sin pérdida) como
`Todo/Artista - Título.opus`, con tags y carátula recortada a cuadrado. Artista y título salen de YouTube Music
cuando es una canción, o de un nombre "Artista - Título (Official Video)", o del canal.
Errores (`{ "error": "…" }`): `401` credenciales, `503` Navidrome no responde para validarlas, `415` formato no soportado, `422` no es audio válido,
`413` supera `MAX_FILE_MB` (2048), `400` petición incompleta.

**"Sign in to confirm you're not a bot"**: YouTube lo pide según la IP y la frecuencia de peticiones, no según
el video (por eso el mismo video funciona al reintentar). El contenedor `bgutil-provider` genera *PO tokens* que
yt-dlp presenta a YouTube (plugin `bgutil-ytdlp-pot-provider`), y el uploader reintenta solo dos veces si aún así
lo pide. Al descargar muchas seguidas (un álbum, una playlist importada) los controles llegan en rachas: entre descargas
hay una espera aleatoria de 30–60 s (YouTube bloqueó la IP, HTTP 429, tras ~25 descargas en 8 min) y, si el control
persiste, **toda la cola se pausa** cada vez más (2, 5, 10, 20, 30 y 60 min) hasta que YouTube vuelve a responder (el
trabajo muestra `waitingUntil`); la pausa se reinicia tras una descarga correcta y una canción solo se da por fallida tras
12 h esperando. Último recurso: exportar `cookies.txt` de una cuenta de YouTube (extensión "Get cookies.txt LOCALLY", en una
ventana de incógnito que luego se cierra) a `/srv/impala/youtube/cookies.txt`; se usa automáticamente si existe.
Con una cuenta **Premium** además aparece Opus a 256 kbps. Usar cookies arriesga que Google limite esa cuenta: mejor una secundaria.
Sin `cookies.txt`, yt-dlp usa las cookies de una **visita anónima** a youtube.com (`YTDLP_ANON_COOKIES`, `src/anoncookies.js`,
sin cuenta) en lugar de parecer un visitante nuevo en cada petición, y pide otra identidad (como mucho una por minuto) tras un
control anti-bots. El 429 es de la IP: esto lo hace menos frecuente, no lo elimina.

**Velocidad** (desde la 1.4 la app consulta YouTube directamente y estas rutas son el respaldo): `ytmusic.py serve` es un proceso persistente (`src/ytworker.js`): arrancar Python e importar ytmusicapi y
yt-dlp costaba 1–2 s por búsqueda. Atiende varias peticiones a la vez (canciones, álbumes y artistas de una búsqueda en
paralelo; los videos con yt-dlp como librería, y por línea de comandos si falla), se relanza solo si muere y se renueva cada
6 h para recoger las actualizaciones de pip. Búsquedas en caché 30 min; álbumes y artistas, 6 h.

Navidrome detecta los archivos nuevos solo (vigilante de cambios en disco, ~2 s).

### Importar playlists de Apple Music

Mismas credenciales Subsonic que el resto (Bearer no basta: la playlist se crea a nombre del usuario).

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/upload/applemusic/imports` | JSON `{ url }` (enlace `music.apple.com/…/playlist/…`, debe ser pública) → `202 { import }` |
| `GET` | `/upload/applemusic/imports` · `/:id` | Importaciones del usuario / una con sus `tracks` |
| `POST` | `/upload/applemusic/imports/:id/start` | JSON `{ name?, skip?: [índices], appendTo? }`: descarga las que faltan y crea la playlist (o, con `appendTo`, añade a esa playlist existente solo las que no tiene) |
| `POST` | `/upload/applemusic/imports/:id/cancel` | Cancela las descargas pendientes; lo ya descargado se guarda igual en la playlist |
| `POST` | `/upload/applemusic/imports/:id/retry` | Vuelve a descargar las que fallaron y sustituye el contenido de la playlist ya creada |
| `DELETE` | `/upload/applemusic/imports/:id` | Descarta una importación que no está en curso |

`status`: `reading` → `matching` → `review` (espera a la app) → `downloading` → `saving` → `done` (o `error`).
Cada canción se busca en Navidrome (`search3`) y, si falta, en YouTube Music; el emparejado (`src/match.js`) compara título
sin "(feat. …)" ni " - Remastered", artistas, palabras de versión (live, remix, sped up…) y duración. Las descargas llevan los tags de
Apple Music y se localizan en Navidrome por su ruta real. Sin `APPLE_MUSIC_TOKEN` la playlist se lee del JSON que incrusta la página
pública; con un token de desarrollador de MusicKit se usa la API oficial (pagina playlists de más de 100 canciones).
Las importaciones se guardan en `IMPORTS_STATE_FILE` (`/srv/impala/youtube/imports.json`, permisos 600: incluye el token
Subsonic de cada usuario para poder terminar el trabajo); tras un reinicio, las que estaban descargando continúan y las que
estaban analizando quedan en error para volver a pegar el enlace. Los enlaces `music.apple.com/library/playlist/p.…` son de la
biblioteca privada y no se pueden leer: hay que usar **Compartir playlist → Copiar** (`…/playlist/…/pl.u-…`).

### Letras

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/upload/lyrics/:songId` | `{ lyrics: { source: 'file' | 'lrclib' | null, synced, lines: [{ timeMs, text }] } }` |

Primero la letra del propio archivo (Navidrome, `getLyricsBySongId` de OpenSubsonic); si no hay, [LRCLIB](https://lrclib.net)
(letras sincronizadas, pública y gratuita), eligiendo la versión por duración. Se guarda en `LYRICS_CACHE_DIR`
(`/srv/impala/youtube/lyrics`, un JSON por canción); si no se encontró, se vuelve a buscar a los 3 días.

### Biblioteca

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/upload/songs/:id/trim` | Antes de recortar: `{ admin, duration, codec, method: 'reencode' \| 'copy' \| null, canTrim, backup }` |
| `GET` | `/upload/songs/:id/waveform` | `{ peaks }`: 300 picos (0–1) de la forma de onda (ffmpeg, mono a 1 kHz); en memoria mientras el archivo no cambie |
| `POST` | `/upload/songs/:id/trim` | `{ keep: [[inicio, fin], …] }` (s): conserva esos tramos y sobrescribe el archivo. Solo **administradores**. La primera vez guarda el original en `TRIM_BACKUP_DIR`; mueve la letra sincronizada guardada y pide un escaneo a Navidrome |
| `POST` | `/upload/songs/:id/restore` | Devuelve el archivo original (y su letra) y borra la copia |
| `DELETE` | `/upload/songs/:id` | Borra del disco el archivo de una canción (id de Navidrome). Solo con las credenciales Subsonic de un **administrador**: el uploader pregunta a Navidrome la ruta real (`ND_SUBSONIC_DEFAULTREPORTREALPATH=true`) y se niega a tocar nada fuera de `/music` o que no sea audio. Navidrome la retira de la biblioteca al detectar el borrado |

## Estructura

```
server/          docker-compose, uploader y scripts del servidor
app/             aplicación Android (Expo SDK 57, React Native 0.86)
  src/app/       rutas (Expo Router): login, (tabs)/biblioteca|buscar, ajustes (menú ⋯), reproduciendo, cola
  src/api/       cliente OpenSubsonic, YouTube desde el teléfono (InnerTube) + hooks de TanStack Query
  src/auth/      sesión (token md5+salt en expo-secure-store; nunca la contraseña)
  src/components/ UI estilo Apple Music (Uniwind/Tailwind 4, tema claro/oscuro en global.css)
  src/player/    estado del reproductor (store) y preferencia de calidad
  modules/impala-player/  módulo nativo Kotlin (Expo Modules API + Media3)
```

### Reproductor (`modules/impala-player`)

- `PlaybackService` (MediaSessionService) posee el ExoPlayer y la MediaSession: notificación,
  pantalla de bloqueo, botones Bluetooth, foco de audio y pausa al desconectar audífonos, sin código extra.
- `ImpalaPlayerModule` es el puente con JS: conecta un `MediaController` y emite `onStateChange`,
  `onTrackChange`, `onProgress` (cada 500 ms mientras suena) y `onError`.
- La URI de cada pista viaja en `requestMetadata.mediaUri` (Media3 no transfiere la URI del
  controlador a la sesión) y el servicio solo acepta colas de la propia app.
- Calidad: *original* (`format=raw`, bit a bit) u *ahorro* (`format=opus&maxBitRate=192`, transcodificado
  por Navidrome). En automático decide `ConnectivityManager.isActiveNetworkMetered`, que atraviesa la VPN de
  Tailscale (el tipo de red siempre aparece como VPN).
- La reproducción sigue en el servicio aunque se recargue el JS; `getState()`/`getQueue()` la recuperan.
- Edición de cola: `insertTracks` (a continuación / al final), `moveTrack`, `removeTrack` y
  `setUpcomingOrder` (mezcla lo que viene después sin cortar la canción actual, aplicando movimientos).

### Cola y playlists (Fase 5)

- **Cola** (`/cola`, desde "Reproduciendo"): arrastrar el asa ≡ para reordenar
  (`react-native-reorderable-list`), quitar, tocar para saltar y "Mezclar".
- **Menú "…"** de cada canción (también con pulsación larga): reproducir a continuación, añadir a la cola,
  añadir a una playlist (o crear una nueva), ir al álbum/artista y, dentro de una playlist, quitarla.
- **Playlists** en Navidrome vía API Subsonic: crear, renombrar, eliminar, añadir/quitar canciones y
  reordenar en modo edición (se guarda con `createPlaylist` + `playlistId`, que sustituye el contenido).
- Cada entrada de la cola lleva un `uid` propio: la misma canción puede aparecer varias veces.

### Modo offline (Fase 6)

- Descargas en `<documentos>/offline` (almacenamiento privado de la app): audio original vía endpoint
  Subsonic `download` + carátula. Índice `index.json` con los metadatos; al arrancar se limpian archivos
  huérfanos de descargas interrumpidas. Sin código nativo nuevo (`expo-file-system`).
- Descargar desde el menú "…" de una canción, el botón ⬇ de un álbum o "Descargar playlist".
- El reproductor usa el archivo local si existe; sin conexión solo encola las canciones descargadas.
- Biblioteca → **Descargadas** (con progreso y espacio usado); aviso con acceso directo si el servidor no responde.
- Ajustes → Descargas: total, espacio libre y "Eliminar todas las descargas".

### Potenciador de volumen y Tailscale

- **Potenciador** (Ajustes → Potenciador de volumen: +4, +8 o +12 dB): `VolumeBooster` pone un `LoudnessEnhancer`
  de Android sobre la sesión de audio del reproductor principal y del fader. Su limitador evita el recorte
  digital pero comprime la dinámica. La ganancia se guarda en `SharedPreferences` y se aplica al instante.
- **Tailscale** (Ajustes → Tailscale, activado por defecto): al pasar a primer plano la app envía
  `com.tailscale.ipn.CONNECT_VPN` al `IPNReceiver` de Tailscale (tarda ~1 s; lo que falló mientras tanto se
  vuelve a pedir). `SessionWatchService` apaga la VPN (`DISCONNECT_VPN`) al cerrar Impala desde recientes, o
  cuando Android lo detiene por estar minimizada sin reproducir (~1 min). Mientras suena música la VPN
  sigue encendida; reanudar desde la notificación la vuelve a encender. Cerrar la app también detiene la música.
- **Importar → Copiar / Cortar archivos**: elige audios en cualquier carpeta y los copia a la de importación;
  "Cortar" borra el original solo si la copia tiene el mismo MD5.

### Reproductor: menú … y temporizador de reposo

- Se cierra deslizando hacia abajo (ya no hay asa). El botón … junto a la estrella: añadir a playlists y temporizador de reposo.
- **Añadir a playlists**: casillas con la carátula de cada playlist propia, marcadas si ya contienen la canción; "Listo" añade
  o quita según los cambios (en "Canciones Favoritas" equivale a poner o quitar la estrella).
- **Temporizador** (`SleepTimer.kt`): 5–60 min o "al terminar la canción" (desactiva el crossfade mientras tanto). Vive junto al
  `PlaybackService`, así que sigue contando con la app minimizada; avisa al JS con `onSleepTimer`.
- **Álbumes de YouTube** (Buscar → YouTube → Álbumes): vista previa de cada pista y "Añadir a la biblioteca", que descarga el
  álbum entero con su nombre, artista, número de pista y año en los tags.

### Versión 1.2

- **Letra** (botón 💬 del reproductor): líneas grandes, la actual resaltada y centrada; tocar una línea salta a ese momento.
  Con la letra abierta, el gesto de cerrar el reproductor se desactivaba para poder desplazarla (en la 1.4 vuelve a funcionar).
- **Carátulas de playlist**: degradado (siempre el mismo para cada nombre) con el nombre escrito encima (`PlaylistCover`).
- **Playlists y Canciones**: buscador y orden (playlist, título, artista, álbum, recientes, duración) sin cambiar el orden
  guardado; Canciones carga toda la biblioteca y tiene Reproducir/Aleatorio.
- **Menú … en resultados de YouTube**: favorita, a continuación, a la cola, a playlists, descargar en el teléfono e ir al
  artista. Cada acción descarga primero en el servidor y se completa sola al indexarse (un aviso lo explica).
- **Cancelar**: descargas al teléfono (Descargadas y menú …), descargas de YouTube (tocar el indicador), un álbum entero y lo
  pendiente de una importación.
- **Importar a una playlist existente** (solo añade las que no tiene).
- **Cola con "Repetir todo"**: tras la última canción muestra las que sonarán al volver a empezar.
- **Crossfade**: en el relevo, el principal tarda en cargar mientras el fader sigue sonando y se oía un salto atrás; ahora se
  mide el desfase y, si pasa de 40 ms, se resincroniza dentro del búfer antes de cruzar volúmenes (log `ImpalaCrossfade`).

### Versión 1.3

- **Búsqueda de YouTube más rápida**: se busca mientras escribes (pausa de 0,6 s); la música de YouTube Music llega en ~1 s y
  los videos se añaden después. Los 4 primeros álbumes se cargan por adelantado y la cabecera de un álbum se ve al instante.
- **Página de artista** (como Apple Music): foto grande, **Populares** (lo más escuchado ahora según YouTube Music; las que ya
  tienes suenan de la biblioteca, las demás se escuchan como vista previa y se descargan con la flecha), sus álbumes en la
  biblioteca y los álbumes, sencillos y EP de YouTube Music que faltan. Menú …: reproducir, aleatorio, descargar en el teléfono
  y añadir a la biblioteca las populares que faltan. Se llega desde Artistas, el menú … de una canción (también de YouTube y del
  reproductor), el artista de un álbum de YouTube y los artistas de la búsqueda de YouTube.
- **Ordenar** sale de la cabecera y pasa al menú … de la playlist (y de Canciones): hoja flotante a media pantalla, translúcida,
  con ascendente/descendente; la lista de detrás se reordena al momento. Si el orden no es el habitual, una línea bajo el
  buscador lo indicaba y permitía quitarlo (en la 1.4 ya no se muestra).
- **Volumen gradual (gym)**, desde el menú … de una playlist: sube el volumen multimedia del teléfono paso a paso desde el actual
  hasta el máximo de Ajustes (60–100 %) en los minutos elegidos (5–45), solo mientras suena música (`GymRamp.kt`). Mover el
  volumen con los botones la detiene; con audífonos Android puede limitarla ("volumen seguro"). El reproductor lo muestra (45 % → 85 %).
- **Estilo de la portada** de una playlist (menú …): 24 degradados o el automático por nombre. Se guarda en el teléfono.
- **Fondo animado** del reproductor con los colores de la carátula (androidx.palette, `ArtworkColors.kt`): manchas de color que
  giran y se desplazan despacio (más lento en pausa) y se funden al cambiar de canción.
- **Letra palabra por palabra**: en la línea que suena las letras se iluminan en blanco a la velocidad de la canción, con un
  borde suave que avanza como una ola (60 fps en el hilo de UI). Si la letra trae tiempos por palabra (LRC mejorado,
  `<mm:ss.xx>`) se usan; si no, se reparten por número de letras dentro de la línea.

### Versión 1.4

- **YouTube desde el teléfono**: búsquedas, álbumes, artistas y vistas previas se piden directamente a YouTube desde la app
  (InnerTube, la API interna de las apps de YouTube: `src/api/innertube.ts` y `src/api/ytmusic.ts`), sin pasar por Tailscale
  ni esperar a Python en el servidor. Medido en el emulador (en la misma red que el servidor, el mejor caso para la 1.3): la
  música de una búsqueda llega en ~0,5 s, un álbum en ~0,3 s (0,44 s por el servidor), la página de un artista en ~0,4 s
  (1,5–4,4 s) y la vista previa suena en 1,2–2,5 s (7,7 s: el servidor tenía que arrancar yt-dlp y reenviar el audio).
  - Los parsers son un port de ytmusicapi y devuelven exactamente lo mismo que el servidor (`ytmusic.py` + `youtube.js`); se
    comprobó con 47 búsquedas, álbumes y artistas parseando las mismas respuestas de YouTube con los dos.
  - El audio de las vistas previas se pide con el cliente `VISIONOS` (el predeterminado de yt-dlp desde 2026.08): da URLs
    directas sin descifrar firmas ni PO token, también para las pistas de YouTube Music, donde `ANDROID`, `IOS` y `ANDROID_VR`
    ya dan 403. Solo necesita un `visitorData` (el de la primera respuesta de YouTube, o `youtubei/v1/visitor_id`). La app
    pregunta al servidor (`/upload/youtube/client`, cada 6 h o tras un fallo) qué cliente usa su yt-dlp, que se actualiza cada día.
  - **Respaldo**: si algo falla en el teléfono (YouTube cambió sus respuestas o bloqueó el cliente), la app pide lo mismo al
    servidor como antes. Una vista previa cuyo audio directo da 403 se reintenta una vez con otra identidad (YouTube a veces
    exige PO token a un visitante concreto) y, si tampoco suena, pasa sola al audio del servidor. El reproductor de la vista
    previa no reintenta los 4xx (`newPreviewPlayer`), así no se pierden ~6 s antes de cambiar de fuente. Las descargas a la
    biblioteca siguen en el servidor.
  - Al abrir la búsqueda de YouTube se consigue el `visitorData` y se abre la conexión con `music.youtube.com`
    (`generate_204`): la primera búsqueda no paga el DNS ni el TLS.
  - La página de un artista se enseña con su portada (una sola petición) y las listas completas (25 populares, todos los
    álbumes y sencillos) se añaden cuando llegan.
- **Enlaces de canciones de YouTube Music**: pegar un enlace de una pista (`music.youtube.com/watch?v=…`) ya no dice "sin
  resultados": aparece en Canciones.
- Los videos sin duración (radios 24/7 en directo) ya no salen en la búsqueda: no se pueden escuchar ni descargar.
- Los sencillos y álbumes de la lista completa de un artista muestran la etiqueta de explícito.
- **Orden de las listas**: ya no aparece la línea bajo el buscador que indicaba el orden. El orden elegido en cada playlist
  (y en Canciones) se guarda en el teléfono (`song-sorts.json`) y se mantiene, también tras cerrar la app, hasta que el
  usuario lo cambie en la hoja de orden del menú ….
- **Playlists fijadas** (`src/components/PinnedPlaylists.tsx`):
  - **Acción al tocar** (menú de la carátula): abrirla, **Reproducir** (en el orden que el usuario guardó para esa playlist,
    `sortPlaylistSongs`) o **Aleatorio**. Una insignia ▶/🔀 en la carátula lo recuerda. Se guarda en el teléfono por playlist.
  - **Mantener pulsada** (500 ms): la carátula se levanta (escala 1,08 y vibración, `expo-haptics`). Si se suelta sin mover el
    dedo aparece su menú; si se mueve, sigue al dedo y se reordena (las demás se apartan con un muelle; cerca de un borde la
    fila se desplaza sola). Al reordenar todas tiemblan como los iconos de iOS, con un "−" rojo para dejar de fijarlas;
    "Listo", tocar una carátula o salir de la Biblioteca termina. Ya temblando, basta mantener 200 ms para arrastrar otra.
  - Un solo `Gesture.Pan().activateAfterLongPress()` hace las dos fases (compite con un `Tap` para el toque normal); el orden
    se mueve en el hilo de UI (Reanimated) y se guarda al soltar (`reorderPins`).
- **Búsqueda en Artistas, Álbumes y Descargadas**: caja de búsqueda (`SearchField`, la misma de Canciones y las playlists)
  que filtra sin acentos ni mayúsculas. Álbumes busca por nombre o artista y, al escribir, pide las páginas que faltan para
  buscar en toda la biblioteca. En Descargadas, Reproducir/Aleatorio y tocar una canción usan solo los resultados.
- **Cerrar la cola deslizando hacia abajo** ("A continuación", desde el botón ≡ del reproductor), como el reproductor:
  desde la cabecera siempre; desde la lista cuando está arriba del todo y no se está reordenando (un `Pan` con activación
  manual, simultáneo con el gesto de reordenar de `react-native-reorderable-list`). La cola es ahora un `transparentModal`:
  al deslizarla se ve el reproductor debajo.
- **Pulseras y relojes** (Xiaomi Smart Band con Mi Fitness, etc.): controlan la música por la sesión multimedia con un
  `MediaController` del sistema. Desde Media3 1.11, sin `onConnect` propio los controladores que no son del sistema solo
  podían leer la canción (`DEFAULT_UNTRUSTED_PLAYER_COMMANDS`): la pulsera la mostraba pero sus botones no hacían nada.
  `PlaybackService` ahora los acepta con los comandos normales de reproducción (cargar canciones sigue limitado a la propia
  app en `onAddMediaItems`). Probado en el emulador con un controlador que imita a Mi Fitness (servicio de notificaciones +
  `getActiveSessions` + `TransportControls`): reproducir, pausar, siguiente, anterior, volumen y título/artista.
- **Potenciador de volumen en el reproductor** (menú … del reproductor): los mismos niveles que en Ajustes
  (`src/player/boost.ts`), se aplican al momento.
- **Recortar canciones** («Recortar…» en el menú … de una canción, también dentro de las playlists, y en el del reproductor;
  pantalla `src/app/recortar.tsx`):
  - Forma de onda con dos marcas (inicio y final) para quitar la intro o el final, y **cortes intermedios** («Añadir corte»):
    un tramo A–B que se quita; lo de después se junta con lo de antes. Ajuste fino de la marca elegida (±0,1 s / ±1 s).
  - **Escuchar** reproduce solo lo que se conserva, seguido (`startPreviewClips`: un `MediaItem` por tramo con
    `ClippingConfiguration`), y «Escuchar aquí» empieza ~3 s antes de la marca para oír la unión.
  - **Guardar** sobrescribe el archivo en el servidor (`src/trimmer.js`, ffmpeg). FLAC, ALAC, WAV y WavPack se decodifican y se
    vuelven a codificar con el mismo códec: sin pérdida y exacto a la muestra (se conserva la profundidad de bits). MP3, AAC,
    Opus y Vorbis se cortan sin recodificar (demuxer `concat` con inpoint/outpoint): no pierden calidad, el corte se desvía
    unas centésimas (MP3/AAC) o hasta ~0,5 s (Ogg/Opus, por páginas). Se conservan etiquetas y carátula; en Ogg/Opus, que
    ffmpeg no sabe reescribir, la carátula se rehace como `METADATA_BLOCK_PICTURE`.
  - El **original** se guarda la primera vez en `/srv/impala/youtube/trim-backups` y se puede **restaurar** desde el editor.
    Las letras sincronizadas guardadas se mueven al nuevo tiempo (y vuelven al restaurar); una descarga en el teléfono se
    vuelve a bajar. Solo un administrador puede guardar o restaurar.
- **Letra**:
  - En **Montserrat** (licencia OFL): Bold para la letra y Medium para la traducción. Se incrusta con el plugin de `expo-font`
    (`app.json`) como familia `Montserrat`, así que basta con `fontFamily: 'Montserrat'` y el `fontWeight`.
  - **Pantalla completa**: solo la letra, con una cabecera pequeña (carátula, canción, reproducir/pausar y salir). Atrás
    también sale de la pantalla completa. Desde la 1.6 el 💬 va pasando de paso (ver «Versión 1.6»); en el PC sigue el ⤢.
  - **Deslizar hacia abajo con la letra abierta**: fuera de la letra cierra el reproductor como siempre; sobre la letra, solo si
    está arriba del todo (si no, el arrastre la desplaza). El desplazamiento va envuelto en `Gesture.Native()`, simultáneo con
    el gesto de cerrar.
  - **Traducir al español**: burbuja que se puede mover (abajo a la izquierda al principio) y que activa o desactiva la
    traducción. Aparece bajo cada línea, más pequeña y tenue. La pide el teléfono al traductor de Google
    (`translate.googleapis.com/translate_a/t`, sin clave), con un `q` por línea, y repite una sola vez cada texto. Las líneas
    que ya están en español no se repiten, y si casi toda la letra lo está, un aviso lo dice. La preferencia y la posición de
    la burbuja se guardan en el teléfono (`src/api/translate.ts`).

### Versión 1.5


- **Aleatorio en la notificación y la pantalla de bloqueo** (Fase 0): un `CommandButton` de Media3 en la sesión cambia de
  icono según el modo y hace lo mismo que el botón de la app (`toggleShuffle`). Con la app cerrada, el servicio mezcla la
  cola por su cuenta. En el reproductor, aleatorio y repetición bajan a una fila encima de anterior/pausa/siguiente.
- **Capa de fuentes** (`src/sources/`, Fase 1): la app pide todo a «la fuente activa», un `MusicSource` (biblioteca,
  playlists, favoritas, URLs de audio y carátula, letras, borrar, recortar…) con **capacidades** que muestran u ocultan
  opciones. `SubsonicSource` envuelve Navidrome como en la 1.4 y `LocalSource` lee el teléfono.
- **Este dispositivo** (Fase 2): el módulo `modules/impala-library` lee el índice de Android (`MediaStore.Audio`) y se
  refresca al volver a la app y cuando cambian archivos (`ContentObserver`).
  - **Carpetas**: por defecto `Music/Impala` (se crea si no existe), con sus subcarpetas. En Ajustes → Este dispositivo se
    eligen otras (las que tienen audio y sus carpetas superiores).
  - **Permiso** «Música y audio» (`READ_MEDIA_AUDIO`, Android 13+) o almacenamiento (Android 12 y anteriores), pedido desde
    una pantalla que explica para qué (`src/app/permiso.tsx`). Una instalación nueva sin servidor entra directo ahí.
  - **Playlists, favoritas y escuchas locales** en un JSON del teléfono (`local-library.json`), con las mismas funciones
    que las del servidor: fijar, ordenar, acción al tocar, gym.
- **Funciones avanzadas en local** (Fase 3):
  - **Letras**: un `.lrc` junto al audio o, si no hay, LRCLIB pedido desde el teléfono, con caché.
  - **Descargas de YouTube al teléfono**: el m4a va a `Music/Impala` con título, artista, álbum y carátula, y se avisa al
    índice de Android. Canción o álbum completo, con cola y cancelar, como en el servidor.
  - **Recortar** sin recodificar: M4A/AAC con `MediaExtractor` + `MediaMuxer` (conserva la caja `udta`: etiquetas y carátula)
    y MP3 copiando tramas (ID3 intacto, trama Xing/Info corregida). El original se guarda en la app para restaurarlo y la
    letra de LRCLIB guardada se mueve al nuevo tiempo. FLAC, Opus, Vorbis y WAV no se recortan en el teléfono.
  - **Borrar canciones** del teléfono, con la confirmación del sistema (Android la exige para archivos de otras apps); se
    quitan también de las playlists locales.
- **Ajustes → Fuente de música** (Fase 4): «Este dispositivo» o «Servidor propio» (dirección https, usuario y contraseña de
  Navidrome; Tailscale es opcional y su encendido automático solo aparece con el servidor). Al cambiar de fuente se detiene
  lo que suena; la sesión del servidor se conserva y cada fuente tiene sus playlists, favoritas, fijadas y acciones al
  tocar (`setPinScope`). Quien actualiza desde la 1.4 con sesión sigue en su servidor sin reconfigurar. Calidad de
  streaming y subir archivos solo aparecen con el servidor.
- **Importar playlists de Apple Music sin servidor** (Biblioteca → Importar en «Este dispositivo»; `src/api/appleMusicLocal.ts`):
  lo mismo que el importador del uploader, pero en el teléfono. Lee la página pública de la playlist (el JSON
  `serialized-server-data`, como el servidor sin token; si Apple cambia la página avisa de ello), busca cada canción en la
  música del teléfono y las que faltan en YouTube Music (`searchSongs` de InnerTube), con el mismo emparejado por título,
  artista, versión y duración (`src/api/songMatch.ts`, copia de `match.js`). Al empezar crea la playlist local (o
  actualiza la del mismo nombre, o añade a una existente) con las que ya estaban, en el orden de Apple; las que faltan van
  a la cola de descargas del teléfono (`youtubeLocal.ts`, con progreso y cancelar) con título, artista, álbum y carátula de
  Apple Music, y cada una entra en la playlist en su sitio al terminar (con el id de `MediaStore`). Las importaciones se
  guardan en `apple-imports.json`; si se cierra la app a medias, lo pendiente queda como fallido y se puede reintentar.
- **Velocidad y tono · Sped up / Slowed** (Fase 5, menú … del reproductor → «Velocidad y tono»): preajustes *Normal*,
  *Sped up* (1,25×), *Slowed* (0,85×) y *Slowed + reverb*, cada uno con tono **Natural** (Sonic de ExoPlayer cambia la
  velocidad sin tocar el tono) o **Vinilo** (el tono sigue a la velocidad, como un disco); ajuste fino de velocidad
  (0,75×–1,35×, de 0,05 en 0,05), tono extra en semitonos (±6) y cantidad de reverberación (0–100 %, de 10 en 10;
  0 % = «Apagada»; *Slowed + reverb* usa 40 %). Se guarda como ajuste general o, con
  «Recordar solo para esta canción», por canción y fuente. `PlaybackTuning` (en `PlaybackService`) aplica
  `PlaybackParameters(velocidad, tono)` al principal y al fader según la canción que tenga cada uno, así el crossfade
  cuadra (sus tiempos se cuentan en reloj: lo que queda de pista se divide por la velocidad). La reverberación es,
  desde la 1.6, un procesador propio (`ReverbAudioProcessor`, ver «Versión 1.6»). El reproductor muestra una pastilla («Sped up 1,25×», «Slowed + reverb 0,85× · 40 %», «Personalizado 0,85× · reverb 60 %») cuando
  no es Normal; la posición, la barra, las letras y el scrobble siguen el tiempo de la canción (las letras avanzan entre
  informes a la velocidad actual).

### Versión 1.6 · reproductor

- **Un solo botón de letra** (💬): oculta → letra en el reproductor (píldora clara con un ⤢ pequeño) → pantalla completa
  (en su cabecera, el mismo botón con una ✕ pequeña) → oculta. El botón «salir de pantalla completa» y Atrás vuelven a la
  letra en el reproductor.
- **Reproductor con gestos** (por defecto; Ajustes → «Controles del reproductor: Gestos / Botones», guardado en
  SecureStore `impala.playerControls`): se ocultan anterior/reproducir/siguiente y aleatorio/repetir, y sobre la carátula
  - deslizar con un dedo **hacia arriba** → siguiente, **hacia abajo** → anterior, con la página siguiendo al dedo (sale
    por un borde y la nueva entra por el contrario; si el gesto es corto o lento vuelve a su sitio). Hacia abajo va siempre
    a la canción anterior (`previousTrack`: `skipTo(index - 1)`, sin el «reiniciar si lleva más de 3 s» del botón, que
    con un gesto de feed sorprende); en la primera, sin repetir todo, vuelve al principio;
  - **un toque** → pausa/sigue, con el icono un momento encima; **doble toque** → favorita con una explosión de estrellas
    (si ya lo era, sigue siéndolo). `Gesture.Exclusive(doble, simple)` con `maxDelay` 250 ms;
  - **cerrar con dos dedos** hacia abajo (`minPointers(2)` en el gesto de cerrar, con una segunda copia en la carátula
    junto a los gestos de un dedo: el detector interior se quedaba con los dos dedos); con botones, un dedo como siempre.
  Los gestos solo están sobre la zona de la carátula: los botones, la barra de progreso y la letra no se ven afectados; con
  la letra abierta (en el reproductor) se desplaza normal y a pantalla completa no hay gestos. La primera vez se explica
  con un aviso («Entendido» / «Cambiar a botones»). La capa es reutilizable: `useFeedGestures` + `FeedFeedback`
  (`components/player/useFeedGestures.tsx`), pensada también para un futuro «descubrir música». En el PC, siempre botones.
- **Reverberación propia** (`ReverbAudioProcessor.kt`): el `EnvironmentalReverb` de Android apenas se oía en algunos
  teléfonos (Samsung con SoundAlive/Dolby limita la parte húmeda). Ahora es un **Freeverb** (8 peines con amortiguación +
  4 pasa-todo por canal, tiempos escalados a la frecuencia de muestreo) dentro de la cadena de audio de ExoPlayer, **después
  de Sonic**: `ImpalaRenderersFactory` construye el `DefaultAudioSink` con una `AudioProcessorChain` que es la de siempre
  (saltar silencios + Sonic) más la reverberación al final, una por reproductor (principal y fader del crossfade).
  Amortiguación 0,2 (brillante). Desde la 1.6.1 la **cantidad** (0–100 %, `reverb` entero en el JSON de `tuning_*`;
  los ajustes viejos `reverb: true/false` se leen como 40/0) decide a la vez cuánto se oye y lo grande que es la sala
  (`ReverbAudioProcessor.Mix.of`): húmedo = cantidad^1,5; cola = 1 s + 5 s × cantidad (realimentación = 0,9576^(6/cola));
  seco 1,0 hasta el 50 % y luego baja hasta 0,8 en el 100 % (lo que sonaba en la 1.6.0).

  | Cantidad | Húmedo | Seco | Realimentación | Cola |
  |---|---|---|---|---|
  | 0 % | — (sin procesar) | 1,0 | — | — |
  | 10 % | 0,03 | 1,0 | 0,841 | ~1,5 s |
  | 20 % | 0,09 | 1,0 | 0,878 | ~2 s |
  | 40 % (Slowed + reverb) | 0,25 | 1,0 | 0,917 | ~3 s |
  | 50 % | 0,35 | 1,0 | 0,928 | ~3,5 s |
  | 70 % | 0,59 | 0,92 | 0,944 | ~4,5 s |
  | 100 % | 1,0 | 0,8 | 0,9576 | ~6 s |

  Húmedo, seco y realimentación se deslizan hacia el valor nuevo (un polo de 20 ms, ~60 ms en total), así que subir o
  bajar no hace chasquidos; a 0 %, cuando la parte húmeda llega a cero, se limpia la cola y solo copia. No añade latencia
  ni cambia el número de muestras (gapless, crossfade y posición intactos). Funciona con PCM 16 bits o float, mono o
  estéreo. Logcat `ImpalaTuning`: «reverberación 40 %: húmedo 0.25 seco 1.00 realimentación 0.9170 cola ~3.0 s». En el
  PC (web) la misma cantidad mueve la ganancia húmeda (0,5 × cantidad^1,5) y la seca de la convolución.

### Crossfade (Fase 7)

`CrossfadeController` (en `PlaybackService`) usa un segundo ExoPlayer, el *fader*; la MediaSession sigue
viendo un solo reproductor:

1. **Preparación**: ~4 s antes del fundido, el fader precarga la siguiente pista en pausa.
2. **Fundido**: el principal baja y el fader sube con curvas de igual potencia (cos/sin).
3. **Relevo**: el principal salta a la siguiente pista en la posición del fader y un micro-fundido de 200 ms
   le devuelve el volumen.

Se cancela al pausar, buscar, saltar o editar la cola; no se aplica entre pistas del mismo álbum, con
"repetir una" ni en pistas cortas. La duración (Ajustes → Crossfade: desactivado, 3, 4 o 5 s) se guarda en
`SharedPreferences` desde el módulo y la lee el servicio. El fader no pide foco de audio.

## Desarrollo de la app

Requisitos en Windows: Node 24, JDK 17, Android SDK (`ANDROID_HOME`), teléfono con depuración USB,
`LongPathsEnabled=1` en el registro y **CMake 3.31.6** del SDK (`sdkmanager "cmake;3.31.6"`).
El plugin `app/plugins/withCmakeVersion.js` obliga a usarlo: el CMake 3.22.1 por defecto trae ninja 1.10,
que falla con rutas de más de 260 caracteres al compilar librerías con codegen.

```bash
cd app
npm install
npx expo start --dev-client          # Metro
npx expo run:android --device SM_A546E --no-bundler   # compila e instala el development build
npm run typecheck && npm run lint
```

`android/` se genera con `expo prebuild` y no se versiona: la configuración nativa vive en `app.json`
y en los config plugins de `app/plugins/`:

| Plugin | Motivo |
|---|---|
| `withCmakeVersion` | Fuerza CMake 3.31.6 (ninja 1.12) en todos los módulos: evita el límite de 260 caracteres en Windows |
| `withoutFontWeightAdjustment` | Ignora "Texto en negrita" de Android dentro de la app: React Native mide el texto sin ese ajuste y se recortaba |

Con el teléfono por USB, `adb reverse tcp:8081 tcp:8081` permite cargar el bundle desde `localhost`
sin abrir el puerto en el firewall de Windows.

El build de desarrollo se instala como `com.luizzi.impala.dev`, así que convive con la APK final
(`com.luizzi.impala`).

## APK de release (Fase 8)

La firma usa una llave propia **fuera del repositorio**: `~/.impala/impala-release.jks` y
`~/.impala/signing.properties` (contraseñas), con permisos solo para el usuario. El plugin
`withReleaseSigning` la inyecta en Gradle (o `IMPALA_SIGNING_PROPERTIES` apunta a otra ruta).

> **Respalda `~/.impala/` en un lugar seguro.** Android solo instala actualizaciones firmadas con la
> misma llave: si se pierde, habrá que desinstalar la app (y sus descargas) para instalar una nueva versión.

```bash
cd app
npx expo prebuild --platform android --no-install   # solo si cambió app.json o un plugin
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# → app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
```

Comprueba que el APK lleva la llave de Impala y no la de depuración (el SHA-256 debe ser siempre el mismo):

```bash
"$ANDROID_HOME/build-tools/<versión>/apksigner" verify --print-certs app/build/outputs/apk/release/app-release.apk
# Signer #1 certificate DN: CN=Impala, OU=Impala, O=Impala
# Signer #1 certificate SHA-256 digest: 8c750b3e3aff75f4823a974f49aa6ee6c5ef6d341186064f15db81f5affa8acc
```

### Actualizaciones dentro de la app (teléfono)

Al abrirse (como mucho una vez cada 12 h) y desde **Ajustes → Acerca de → Buscar actualizaciones**, Impala consulta
`https://api.github.com/repos/<repo>/releases/latest` (sin cuenta: 60 consultas por hora y por IP; sin conexión, con la
versión aún sin publicar o con el límite agotado no avisa de nada). Si la etiqueta es más nueva que la versión instalada
(`versionName`) y la versión trae APK, muestra las notas con **Actualizar**, **Más tarde** y **Omitir esta versión**.
Actualizar descarga el APK a la caché (con progreso y comprobando el tamaño) y abre el instalador de Android, que siempre
pide al usuario tocar «Instalar»; la primera vez Android pide permitir a Impala «instalar apps desconocidas» (la app lo
explica y abre ese ajuste). No usa el servidor propio: funciona igual con «Este dispositivo».

El repositorio está en **un solo sitio**: `expo.extra.githubRepo` en `app/app.json` (`"ELuiZzi/Impala-App"`). Lo usan el
teléfono (`src/components/desktop/updates.ts`) y el PC (`desktop/src-tauri/src/lib.rs` lo lee al compilar).

Para probar sin publicar: `adb push update-test.json /sdcard/Android/data/com.luizzi.impala/files/` con una respuesta
de GitHub inventada (su `browser_download_url` puede ser `file:///sdcard/Android/data/com.luizzi.impala/files/x.apk`);
mientras exista, sustituye a la consulta y se comprueba en cada arranque. Bórralo al terminar.

### Publicar una versión

1. Sube `version` y `android.versionCode` en `app/app.json` (y en `android/app/build.gradle` si no se vuelve a hacer
   prebuild; el `versionCode` tiene que crecer siempre) y la versión del PC (`desktop/src-tauri/tauri.conf.json`, ...).
2. Compila el APK (arriba) y comprueba la firma con `apksigner`.
3. En GitHub, crea la versión con la etiqueta **`v<versión>`** (p. ej. `v1.6.1`), ni borrador ni pre-release, y sube:
   - **`Impala-<versión>.apk`** (arm64-v8a, exactamente ese nombre: el teléfono lo busca así),
   - el instalador del PC y `latest.json` (ver [Impala para PC](#impala-para-pc)).
4. Las notas de la versión (el texto de la versión en GitHub) son las que se ven en el diálogo del teléfono.

Una versión sin APK (solo para el PC) no se ofrece en el teléfono. Android solo instala encima un APK firmado con la
misma llave, así que **respalda `~/.impala/`** (llave y contraseñas): sin ella nadie podrá actualizar sin desinstalar.
Íconos: `npm run icons` regenera `assets/` desde `scripts/make-icons.js` (SVG → PNG): nota musical con plica de rayo sobre morado `#A235FA`.

## Impala para PC

La app de `app/` exportada a web (Expo) dentro de una ventana de **Tauri 2**
(`desktop/`): lo que en Android hace Kotlin, en PC lo hace Rust (`desktop/src-tauri/src/`) o el propio WebView.

- **Lo que cambia por plataforma** va en archivos `*.web.ts(x)`: los módulos `impala-player` (motor de audio con Web
  Audio: dos `<audio>` que se turnan, crossfade, velocidad/tono, reverb, potenciador) e `impala-library` (la música del
  equipo, leída por Rust), y `src/platform/web/` (archivos de la app en `%APPDATA%\com.luizzi.impala`, sesión en el
  Administrador de credenciales de Windows, peticiones a otros sitios desde Rust para evitar CORS).
- **Diseño de escritorio** a partir de 900 px: barra lateral, barra de reproducción con volumen, Reproduciendo en dos
  columnas, atajos de teclado, clic derecho, icono en la bandeja y cerrar a la bandeja.
- **Fuentes**: «Este dispositivo» lee las carpetas elegidas (por defecto la carpeta Música de Windows, esté donde esté)
  con `lofty`; «Servidor propio» igual que en el teléfono, más descargas sin conexión e Importar (elegir o arrastrar).
- **ffmpeg** va dentro de la app para recortar (también FLAC/WAV) y preparar las descargas de YouTube al equipo.

### Desarrollo

Requisitos: Node 24, Rust (rustup) y Visual Studio Build Tools con C++.

```bash
cd desktop
npm install
npm run ffmpeg            # una vez: descarga ffmpeg (LGPL, BtbN) y comprueba su SHA-256; no va en git
npm run dev               # Metro (app web) + ventana; los errores de la ventana salen en la terminal
npm run dev -- --clear    # si Metro sirve un archivo viejo (pasa en Windows sin watchman)
```

### Instalador y actualizaciones

Las actualizaciones las instala la propia app (plugin `updater` de Tauri: lee `latest.json` de la última versión de GitHub
Releases) y solo acepta instaladores firmados con la clave de Impala, **fuera del repositorio**: `~/.tauri/impala.key`
(sin contraseña; la pública va en `tauri.conf.json`).

> **Respalda `~/.tauri/impala.key`.** Sin ella las versiones instaladas no podrán actualizarse solas.

```bash
cd desktop
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\impala.key"; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
# → src-tauri/target/release/bundle/nsis/Impala_<versión>_x64-setup.exe y su .sig
```

Para publicar: sube la versión en `app/app.json`, `desktop/src-tauri/tauri.conf.json` (y `package.json`/`Cargo.toml`),
compila y sube a la versión de GitHub el `.exe` y un `latest.json` con la versión, las notas, la URL del `.exe` y el
contenido de su `.sig`. El instalador es para el usuario actual (sin pedir administrador) y en español; Windows
SmartScreen avisará las primeras veces porque no tiene firma de código de Windows.

## Ruta de desarrollo

0. Infraestructura: Navidrome + HTTPS por Tailscale
1. Microservicio de ingestión
2. Esqueleto de la app (login, cliente OpenSubsonic, pestañas)
3. Módulo de audio v1 (Media3: cola, pantalla de bloqueo, Bluetooth, gapless, ahorro de datos)
4. Subida desde carpeta con permiso SAF + verificación MD5 + borrado
5. Cola con arrastrar y soltar, playlists
6. Modo offline
7. Crossfade (dos reproductores)
8. Pulido y APK firmado

## Licencia

Impala es software libre bajo la [GNU General Public License v3.0](LICENSE).
