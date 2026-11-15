import { execFile } from 'node:child_process';
import { createApp } from './app.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  musicDir: process.env.MUSIC_DIR ?? '/music',
  uploadSubdir: process.env.UPLOAD_SUBDIR ?? 'Todo',
  token: process.env.UPLOAD_TOKEN ?? '',
  // Para validar las credenciales Subsonic de la app (red interna de Docker).
  navidromeUrl: process.env.NAVIDROME_URL,
  maxFileSize: Number(process.env.MAX_FILE_MB ?? 2048) * 1024 ** 2,
  // Descargas de YouTube; vacío las desactiva.
  ytDlp: process.env.YTDLP_BIN || null,
  // Intérprete con ytmusicapi: búsqueda de canciones (el audio oficial) en YouTube Music.
  python: process.env.YTMUSIC_PYTHON || null,
  // Opcional: cookies.txt de una cuenta de YouTube (solo se usa si el archivo existe).
  ytCookiesFile: process.env.YTDLP_COOKIES || null,
  // Proveedor de PO tokens (contenedor bgutil): evita casi todos los "confirm you're not a bot".
  ytExtractorArgs: process.env.YTDLP_EXTRACTOR_ARGS || null,
  // Sin cookies propias: cookies de una visita anónima a YouTube (se renuevan ante un control anti-bots).
  ytAnonCookiesFile: process.env.YTDLP_ANON_COOKIES || null,
  // Videos ya descargados (para no duplicarlos aunque el archivo cambie byte a byte).
  ytHistoryFile: process.env.YTDLP_HISTORY_FILE || null,
  // Opcional: token de desarrollador de MusicKit. Sin él, las playlists se leen de su página pública.
  appleMusicToken: process.env.APPLE_MUSIC_TOKEN || null,
  // Importaciones en curso: se guardan aquí para retomarlas si el contenedor se reinicia.
  importsStateFile: process.env.IMPORTS_STATE_FILE || null,
  // Caché de letras (un JSON por canción).
  lyricsCacheDir: process.env.LYRICS_CACHE_DIR || null,
  // Originales de las canciones recortadas (para poder restaurarlas). Sin carpeta no se puede recortar.
  trimBackupDir: process.env.TRIM_BACKUP_DIR || null,
};

if (config.token.length < 32) {
  console.error('UPLOAD_TOKEN no definido o demasiado corto (mínimo 32 caracteres)');
  process.exit(1);
}

const app = await createApp(config);
const server = app.listen(config.port, () => {
  console.log(`impala-uploader escuchando en :${config.port} → ${config.musicDir}/${config.uploadSubdir}`);
});

// Un FLAC grande por datos móviles puede tardar más que los 5 min por defecto de Node.
server.requestTimeout = 60 * 60 * 1000;

// YouTube cambia a menudo y yt-dlp lo sigue con actualizaciones frecuentes: se actualiza al
// arrancar y una vez al día (pip del entorno virtual, que pertenece al usuario del contenedor).
if (process.env.YTDLP_UPDATE_CMD) {
  const update = () => {
    const [cmd, ...args] = process.env.YTDLP_UPDATE_CMD.split(' ');
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err) => {
      if (err) console.error('No se pudo actualizar yt-dlp:', err.message);
      else console.log('yt-dlp actualizado');
    });
  };
  update();
  setInterval(update, 24 * 60 * 60 * 1000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
