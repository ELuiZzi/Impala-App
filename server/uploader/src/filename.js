import path from 'node:path';

export const AUDIO_EXTENSIONS = new Set([
  '.flac', '.mp3', '.opus', '.ogg', '.oga', '.m4a', '.aac', '.wav', '.aif', '.aiff', '.wma', '.ape', '.wv', '.dsf',
]);

// ext4 admite 255 bytes por nombre; dejamos margen para el sufijo " (N)".
const MAX_NAME_BYTES = 200;

/**
 * Convierte el nombre que envía el cliente en uno seguro para el disco.
 * Devuelve { base, ext } o null si la extensión no es de audio.
 */
export function sanitizeFilename(original) {
  // Algunos clientes envían rutas completas; nos quedamos con el último segmento.
  const lastSegment = String(original ?? '').split(/[\\/]/).pop();
  const ext = path.extname(lastSegment).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return null;

  let base = lastSegment.slice(0, -ext.length).normalize('NFC');
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, '')   // caracteres de control
    .replace(/[<>:"|?*]/g, ' ')               // reservados en Windows/Samba
    .replace(/\s+/g, ' ')
    .replace(/^[\s.\-–—•]+|[\s.\-–—•]+$/g, ''); // guiones, puntos y viñetas sueltos en los extremos

  base = truncateBytes(base, MAX_NAME_BYTES).trim();
  return { base: base || 'Sin título', ext };
}

function truncateBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out;
}

/** "Canción.flac", "Canción (2).flac", "Canción (3).flac"… */
export function candidateName({ base, ext }, attempt) {
  return attempt === 1 ? `${base}${ext}` : `${base} (${attempt})${ext}`;
}
