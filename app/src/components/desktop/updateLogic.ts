/**
 * Lo que no depende de la plataforma en las actualizaciones del teléfono: leer la respuesta de
 * `GET /repos/<repo>/releases/latest` de GitHub, comparar versiones y elegir el APK.
 *
 * Convención de las versiones publicadas (ver README → Publicar una versión): etiqueta `v<versión>` (v1.6.1) y el
 * APK como `Impala-<versión>.apk` (arm64-v8a). Una versión sin APK (p. ej. solo para PC) no se ofrece en el teléfono.
 */
export type GithubAsset = { name: string; size: number; browser_download_url: string };
export type GithubRelease = {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  assets?: GithubAsset[];
};

export type AvailableUpdate = {
  version: string;
  notes: string;
  url: string;
  fileName: string;
  size: number;
};

/** "v1.6.1" → [1, 6, 1]; null si no es una versión. */
export function parseVersion(text: string): number[] | null {
  const match = /^\s*v?(\d+(?:\.\d+)*)/i.exec(text);
  return match ? match[1].split('.').map(Number) : null;
}

/** >0 si a es más nueva que b, <0 si es más vieja, 0 si son iguales (1.6 = 1.6.0). */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** El APK de la versión: `Impala-<versión>.apk` y, si no está con ese nombre, el único .apk que haya. */
export function pickApk(assets: GithubAsset[] | undefined, version: string): GithubAsset | null {
  const apks = (assets ?? []).filter((a) => /\.apk$/i.test(a.name));
  const exact = apks.find((a) => a.name.toLowerCase() === `impala-${version}.apk`.toLowerCase());
  return exact ?? (apks.length === 1 ? apks[0] : null);
}

/** Las notas de la versión (markdown) como texto sencillo para el diálogo. */
export function plainNotes(markdown: string | null | undefined): string {
  return (markdown ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** La actualización que ofrecer, o null si la versión publicada no es más nueva o no trae APK. */
export function availableUpdate(release: GithubRelease, installed: string): AvailableUpdate | null {
  if (release.draft || release.prerelease) return null;
  const latest = parseVersion(release.tag_name);
  const current = parseVersion(installed);
  if (!latest || !current || compareVersions(latest, current) <= 0) return null;
  const version = latest.join('.');
  const apk = pickApk(release.assets, version);
  if (!apk) return null;
  return { version, notes: plainNotes(release.body), url: apk.browser_download_url, fileName: apk.name, size: apk.size };
}
