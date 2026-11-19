//! La fuente «Este equipo» (Fase 5 de la versión de PC): la música de las carpetas elegidas, con sus etiquetas.
//!
//! Las carpetas llegan como en Android: relativas a la carpeta del usuario con barra final («Music/Impala/» es
//! C:\Users\…\Music\Impala) o absolutas si están en otro sitio («D:/Música/»). Cada canción se identifica por una
//! huella de su ruta (estable entre arranques). Lo leído se guarda en `biblioteca-local.json`: al volver a abrir
//! solo se leen los archivos nuevos o cambiados. Un vigilante avisa a la app cuando algo cambia en las carpetas.

use lofty::prelude::*;
use lofty::tag::ItemKey;
use md5::{Digest, Md5};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const AUDIO_EXTENSIONS: [&str; 13] = ["flac", "mp3", "opus", "ogg", "oga", "m4a", "aac", "wav", "aif", "aiff", "wma", "ape", "wv"];
const COVER_NAMES: [&str; 6] = ["cover", "folder", "front", "album", "albumart", "portada"];
const INDEX_VERSION: u32 = 1;

/// Una canción tal como la espera app/modules/impala-library (DeviceSong).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSong {
    id: String,
    uri: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    track: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<u32>,
    duration_ms: u64,
    date_added: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit_rate: Option<u32>,
    /// Carpeta con barra final, en el mismo formato que las elegidas («Music/Impala/Rock/»).
    folder: String,
}

/// Lo que se guarda de cada archivo para no volver a leerlo si no cambió.
#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    modified: u64,
    size: u64,
    song: DeviceSong,
    /// Tiene carátula incrustada (para servirla sin buscar).
    embedded_cover: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct IndexFile {
    version: u32,
    /// Ruta absoluta → lo leído.
    entries: HashMap<String, Entry>,
}

#[derive(Default)]
pub struct Library {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    index: IndexFile,
    /// id de canción → ruta; id de álbum → rutas de sus canciones (para la carátula).
    songs: HashMap<String, PathBuf>,
    albums: HashMap<String, Vec<PathBuf>>,
    /// Carpetas elegidas ya resueltas: solo se sirven archivos de dentro.
    roots: Vec<PathBuf>,
    watcher: Option<RecommendedWatcher>,
}

fn hash(text: &str) -> String {
    let digest = Md5::digest(text.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// El id de una canción: huella de su ruta (la misma en cada arranque; también la usa media.rs al descargar).
pub fn song_id(path: &Path) -> String {
    hash(&path.to_string_lossy().to_lowercase())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:/"))
}

/// La carpeta Música de Windows, esté donde esté (se puede mover a otro disco, como D:\Música).
fn music_dir() -> PathBuf {
    dirs::audio_dir().unwrap_or_else(|| home().join("Music"))
}

/// «Music/Impala/» → <carpeta Música>\Impala (como en Android, «Music/» es la carpeta Música, no una ruta
/// literal); «Documents/x/» → C:\Users\…\Documents\x; «D:/Otra/» se queda tal cual.
pub fn resolve_folder(folder: &str) -> PathBuf {
    let clean = folder.trim_end_matches(['/', '\\']);
    if Path::new(clean).is_absolute() || clean.chars().nth(1) == Some(':') {
        return PathBuf::from(clean);
    }
    let mut parts = clean.split('/').filter(|p| !p.is_empty());
    let mut path = match parts.clone().next() {
        Some("Music") => {
            parts.next();
            music_dir()
        }
        _ => home(),
    };
    for part in parts {
        path.push(part);
    }
    path
}

/// Ruta → formato de las carpetas elegidas, con barra final: «Music/…» dentro de Música, relativa a la carpeta
/// del usuario si está dentro de ella y, si no, la ruta completa.
fn folder_label(dir: &Path) -> String {
    let rel = |base: &Path| dir.strip_prefix(base).ok().map(|r| r.to_string_lossy().replace('\\', "/"));
    let text = if let Some(r) = rel(&music_dir()) {
        if r.is_empty() { "Music".to_string() } else { format!("Music/{r}") }
    } else if let Some(r) = rel(&home()) {
        r
    } else {
        dir.to_string_lossy().replace('\\', "/")
    };
    if text.is_empty() { String::new() } else { format!("{}/", text.trim_end_matches('/')) }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn index_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("biblioteca-local.json"))
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn text(tag: Option<&lofty::tag::Tag>, key: ItemKey) -> Option<String> {
    tag.and_then(|t| t.get_string(key)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Lee las etiquetas de un archivo. Sin etiquetas, el título es el nombre del archivo (como Android).
fn read_song(path: &Path, size: u64, created: u64) -> Entry {
    let file_name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let suffix = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    let tagged = lofty::read_from_path(path).ok();
    let tag = tagged.as_ref().and_then(|t| t.primary_tag().or_else(|| t.first_tag()));
    let props = tagged.as_ref().map(|t| t.properties());

    let artist = text(tag, ItemKey::TrackArtist);
    let album_artist = text(tag, ItemKey::AlbumArtist);
    let album = text(tag, ItemKey::AlbumTitle);
    let year = text(tag, ItemKey::Year)
        .or_else(|| text(tag, ItemKey::RecordingDate))
        .and_then(|y| y.get(0..4).and_then(|y| y.parse().ok()));
    let folder = path.parent().map(folder_label).unwrap_or_default();
    let id = song_id(path);
    // Un álbum: mismo nombre y mismo artista del álbum; sin nombre de álbum, los sueltos de cada carpeta.
    let album_key = match &album {
        Some(a) => format!("{}|{}", a.to_lowercase(), album_artist.as_deref().or(artist.as_deref()).unwrap_or("").to_lowercase()),
        None => format!("carpeta|{}", folder.to_lowercase()),
    };
    let embedded_cover = tag.is_some_and(|t| !t.pictures().is_empty());

    Entry {
        modified: 0,
        size,
        embedded_cover,
        song: DeviceSong {
            uri: format!("http://impala.localhost/local/{id}"),
            id,
            title: text(tag, ItemKey::TrackTitle).unwrap_or(file_name),
            artist_id: artist.as_ref().map(|a| hash(&format!("artista|{}", a.to_lowercase()))),
            artist,
            album_artist,
            album_id: Some(hash(&album_key)),
            album,
            track: tag.and_then(|t| t.track()),
            disc: tag.and_then(|t| t.disk()),
            year,
            duration_ms: props.map(|p| p.duration().as_millis() as u64).unwrap_or(0),
            date_added: created,
            mime_type: suffix.as_deref().map(|s| crate::files::mime_for(s).to_string()),
            suffix,
            size,
            bit_rate: props.and_then(|p| p.audio_bitrate()),
            folder,
        },
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            // Carpetas ocultas o del sistema ($RECYCLE.BIN, .git…).
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with('.') && !name.starts_with('$') {
                walk(&path, out);
            }
        } else if is_audio(&path) {
            out.push(path);
        }
    }
}

fn load_index(app: &AppHandle, inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.loaded = true;
    let parsed: Option<IndexFile> = index_path(app).and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok());
    if let Some(index) = parsed.filter(|i| i.version == INDEX_VERSION) {
        inner.index = index;
    }
}

fn save_index(app: &AppHandle, index: &IndexFile) {
    let Some(path) = index_path(app) else { return };
    if let Ok(json) = serde_json::to_string(index) {
        let tmp = path.with_extension("json.impala-tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(tmp, path);
        }
    }
}

/// Las canciones de esas carpetas y sus subcarpetas. Lo que no cambió sale del índice guardado.
#[tauri::command]
pub async fn library_songs(app: AppHandle, folders: Vec<String>) -> Result<Vec<DeviceSong>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan(&handle, folders)).await.map_err(|e| e.to_string())
}

fn scan(app: &AppHandle, folders: Vec<String>) -> Vec<DeviceSong> {
    let state = app.state::<Library>();
    let roots: Vec<PathBuf> = folders.iter().map(|f| resolve_folder(f)).collect();
    let mut files = Vec::new();
    for root in &roots {
        walk(root, &mut files);
    }
    files.sort();
    files.dedup();

    // El índice viejo se consulta sin bloquear a quien sirve audio mientras se leen etiquetas.
    let old = {
        let mut inner = state.inner.lock().unwrap();
        load_index(app, &mut inner);
        std::mem::take(&mut inner.index.entries)
    };
    let mut entries = HashMap::with_capacity(files.len());
    let mut changed = old.len() != files.len();
    for path in &files {
        let key = path.to_string_lossy().into_owned();
        let Ok(meta) = fs::metadata(path) else { continue };
        let modified = secs(meta.modified());
        let size = meta.len();
        let entry = match old.get(&key) {
            Some(e) if e.modified == modified && e.size == size => e.clone(),
            _ => {
                changed = true;
                let mut e = read_song(path, size, secs(meta.created()).max(1));
                e.modified = modified;
                e
            }
        };
        entries.insert(key, entry);
    }

    let mut inner = state.inner.lock().unwrap();
    inner.songs = entries.iter().map(|(p, e)| (e.song.id.clone(), PathBuf::from(p))).collect();
    let mut albums: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (p, e) in &entries {
        if let Some(album) = &e.song.album_id {
            let list = albums.entry(album.clone()).or_default();
            // Las que tienen carátula incrustada, primero.
            if e.embedded_cover { list.insert(0, PathBuf::from(p)) } else { list.push(PathBuf::from(p)) }
        }
    }
    inner.albums = albums;
    inner.index = IndexFile { version: INDEX_VERSION, entries };
    if changed {
        save_index(app, &inner.index);
    }
    if inner.roots != roots {
        inner.roots = roots.clone();
        inner.watcher = watch(app, &roots);
    }
    let mut songs: Vec<DeviceSong> = inner.index.entries.values().map(|e| e.song.clone()).collect();
    songs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    songs
}

/// Vigila las carpetas: al copiar, borrar o cambiar archivos de audio, avisa a la app (agrupado: una copia de un
/// álbum entero es un solo aviso).
fn watch(app: &AppHandle, roots: &[PathBuf]) -> Option<RecommendedWatcher> {
    let handle = app.clone();
    let last = Mutex::new(Instant::now() - Duration::from_secs(10));
    let pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if !event.paths.iter().any(|p| is_audio(p) || p.extension().is_none()) {
            return;
        }
        if pending.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let handle = handle.clone();
        let pending = pending.clone();
        let wait = {
            let mut l = last.lock().unwrap();
            let since = l.elapsed();
            *l = Instant::now();
            if since < Duration::from_secs(2) { Duration::from_secs(2) } else { Duration::from_millis(800) }
        };
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            pending.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.eval("window.__impalaLibraryChange && window.__impalaLibraryChange()");
            }
        });
    })
    .ok()?;
    for root in roots {
        let _ = watcher.watch(root, RecursiveMode::Recursive);
    }
    Some(watcher)
}

#[derive(Serialize)]
pub struct DeviceFolder {
    path: String,
    count: u32,
}

/// Carpetas con audio (y cuántas canciones hay directamente en cada una), para elegir en Ajustes: las de la
/// carpeta Música del usuario y las ya elegidas.
#[tauri::command]
pub async fn library_folders(extra: Vec<String>) -> Vec<DeviceFolder> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots: Vec<PathBuf> = dirs::audio_dir().into_iter().collect();
        roots.extend(extra.iter().map(|f| resolve_folder(f)));
        let mut files = Vec::new();
        for root in &roots {
            walk(root, &mut files);
        }
        files.sort();
        files.dedup();
        let mut counts: HashMap<String, u32> = HashMap::new();
        for f in files {
            if let Some(dir) = f.parent() {
                *counts.entry(folder_label(dir)).or_default() += 1;
            }
        }
        let mut out: Vec<DeviceFolder> = counts.into_iter().map(|(path, count)| DeviceFolder { path, count }).collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    })
    .await
    .unwrap_or_default()
}

/// La carpeta Música del usuario en el formato de las carpetas elegidas («Music/» o, si está movida, su ruta).
#[tauri::command]
pub fn library_music_folder() -> String {
    dirs::audio_dir().map(|d| folder_label(&d)).unwrap_or_else(|| "Music/".into())
}

/// Elegir otra carpeta con el selector de Windows (`title`: el de la ventana). None si se cancela.
#[tauri::command]
pub async fn library_pick_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().set_title(title.as_deref().unwrap_or("Elegir carpeta con música"));
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder()).await.ok().flatten()?;
    picked.into_path().ok().map(|p| folder_label(&p))
}

#[tauri::command]
pub fn library_ensure_folder(folder: String) -> bool {
    let path = resolve_folder(&folder);
    fs::create_dir_all(&path).is_ok() && path.is_dir()
}

fn song_path(state: &State<Library>, id: &str) -> Option<PathBuf> {
    state.inner.lock().unwrap().songs.get(id).cloned()
}

/// La letra de la canción: el .lrc con el mismo nombre que el audio, en su carpeta, o la incrustada en sus etiquetas
/// (USLT de MP3, LYRICS de FLAC/Opus, ©lyr de M4A). En el teléfono solo se lee el .lrc.
#[tauri::command]
pub fn library_sidecar_lyrics(state: State<Library>, id: String) -> Option<String> {
    let path = song_path(&state, &id)?;
    if let Ok(lrc) = fs::read_to_string(path.with_extension("lrc")) {
        return Some(lrc);
    }
    let tagged = lofty::read_from_path(&path).ok()?;
    tagged.tags().iter().find_map(|t| text(Some(t), ItemKey::Lyrics))
}

/// Abre la carpeta de la canción en el Explorador, con el archivo seleccionado.
#[tauri::command]
pub fn library_reveal(state: State<Library>, id: String) -> Result<(), String> {
    let path = song_path(&state, &id).ok_or("La canción ya no está en el equipo")?;
    let mut cmd = std::process::Command::new("explorer");
    // explorer quiere /select,"ruta" tal cual (con comillas solo en la ruta, que puede tener espacios).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A la papelera de reciclaje de Windows (se puede recuperar). La app ya pidió confirmación.
#[tauri::command]
pub fn library_delete(app: AppHandle, state: State<Library>, id: String) -> Result<bool, String> {
    let path = song_path(&state, &id).ok_or("La canción ya no está en el equipo")?;
    trash::delete(&path).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().unwrap();
    inner.songs.remove(&id);
    inner.index.entries.remove(&path.to_string_lossy().into_owned());
    save_index(&app, &inner.index);
    Ok(true)
}

// --- Para el protocolo (files.rs) ---------------------------------------------------------------

/// La ruta de una canción, solo si está dentro de las carpetas elegidas.
pub fn audio_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let state = app.state::<Library>();
    let inner = state.inner.lock().unwrap();
    let path = inner.songs.get(id)?.clone();
    inner.roots.iter().any(|r| path.starts_with(r)).then_some(path)
}

/// La carátula de un álbum: la incrustada en alguna de sus canciones o una imagen de su carpeta
/// (cover.jpg, folder.jpg…). Devuelve los bytes y su tipo.
pub fn album_cover(app: &AppHandle, album_id: &str) -> Option<(Vec<u8>, String)> {
    let paths = {
        let state = app.state::<Library>();
        let inner = state.inner.lock().unwrap();
        inner.albums.get(album_id)?.clone()
    };
    for path in paths.iter().take(3) {
        if let Ok(tagged) = lofty::read_from_path(path) {
            for tag in tagged.tags() {
                if let Some(pic) = tag.pictures().first() {
                    let mime = pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into());
                    return Some((pic.data().to_vec(), mime));
                }
            }
        }
    }
    let dir = paths.first()?.parent()?;
    let entries = fs::read_dir(dir).ok()?;
    let mut images: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp")))
        .collect();
    images.sort_by_key(|p| {
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        COVER_NAMES.iter().position(|n| stem == *n || stem.starts_with(n)).unwrap_or(COVER_NAMES.len())
    });
    let image = images.first()?;
    let mime = crate::files::mime_for(&image.extension()?.to_string_lossy().to_ascii_lowercase()).to_string();
    Some((fs::read(image).ok()?, mime))
}
