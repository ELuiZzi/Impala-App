//! Archivos de la app y credenciales (Fase 1 de la versión de PC).
//!
//! La app usa `expo-file-system` con rutas `impala://document/...` e `impala://cache/...` (ver
//! app/src/platform/web/file-system.ts). Aquí se guardan en la carpeta de datos de la app
//! (`%APPDATA%\com.luizzi.impala\document`) y en su caché (`%LOCALAPPDATA%\com.luizzi.impala\cache`).
//! La sesión del servidor va al Administrador de credenciales de Windows.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Las rutas de la app son las URL de su protocolo propio (files.rs): en Windows, los esquemas propios se sirven
/// como http://<esquema>.localhost. Así la misma URI sirve para leer un archivo y para reproducirlo.
const DOCUMENT: &str = "http://impala.localhost/document";
const CACHE: &str = "http://impala.localhost/cache";
/// Solo se cargan al arrancar los archivos de texto pequeños: ajustes, índices y caché de letras.
const TEXT_EXTENSIONS: [&str; 3] = ["json", "txt", "lrc"];
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const KEYRING_SERVICE: &str = "Impala";

#[derive(Serialize)]
pub struct FileEntry {
    uri: String,
    /// None si es binario (audio, carátulas) o demasiado grande: solo se sabe que existe.
    text: Option<String>,
    size: u64,
}

#[derive(Serialize)]
pub struct Snapshot {
    files: Vec<FileEntry>,
    dirs: Vec<String>,
}

fn roots(app: &AppHandle) -> Result<[(&'static str, PathBuf); 2], String> {
    let path = app.path();
    let data = path.app_data_dir().map_err(|e| e.to_string())?.join("document");
    let cache = path.app_cache_dir().map_err(|e| e.to_string())?.join("cache");
    Ok([(DOCUMENT, data), (CACHE, cache)])
}

/// `http://impala.localhost/document/a/b.json` → ruta en disco. Rechaza `..` y cualquier cosa fuera de las dos raíces.
pub fn resolve(app: &AppHandle, uri: &str) -> Result<PathBuf, String> {
    for (prefix, root) in roots(app)? {
        let Some(rest) = uri.strip_prefix(prefix) else { continue };
        if !(rest.is_empty() || rest.starts_with('/')) {
            continue;
        }
        let mut path = root;
        for part in rest.split('/').filter(|p| !p.is_empty()) {
            if part == "." || part == ".." || part.contains(['\\', ':']) {
                return Err(format!("ruta no válida: {uri}"));
            }
            path.push(part);
        }
        return Ok(path);
    }
    Err(format!("ruta fuera de la app: {uri}"))
}

fn walk(dir: &Path, uri: &str, out: &mut Snapshot) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Restos de una escritura cortada a medias.
        if name.ends_with(".impala-tmp") {
            continue;
        }
        let child = format!("{uri}/{name}");
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            out.dirs.push(child.clone());
            walk(&entry.path(), &child, out);
        } else {
            let is_text = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
            let text = (is_text && meta.len() <= MAX_TEXT_BYTES)
                .then(|| fs::read_to_string(entry.path()).ok())
                .flatten();
            out.files.push(FileEntry { uri: child, text, size: meta.len() });
        }
    }
}

/// Todo lo guardado, para que la app lo lea de forma síncrona (como en el teléfono) desde el arranque.
#[tauri::command]
pub fn fs_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    let mut out = Snapshot { files: Vec::new(), dirs: Vec::new() };
    for (prefix, root) in roots(&app)? {
        walk(&root, prefix, &mut out);
    }
    Ok(out)
}

/// Escribe por completo (archivo temporal y renombrar): un cierre a medias no deja el JSON roto.
#[tauri::command]
pub fn fs_write(app: AppHandle, uri: String, text: String) -> Result<(), String> {
    let path = resolve(&app, &uri)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.clone().into_os_string();
    tmp.push(".impala-tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_delete(app: AppHandle, uri: String) -> Result<(), String> {
    match fs::remove_file(resolve(&app, &uri)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn fs_mkdir(app: AppHandle, uri: String) -> Result<(), String> {
    fs::create_dir_all(resolve(&app, &uri)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_rmdir(app: AppHandle, uri: String) -> Result<(), String> {
    let path = resolve(&app, &uri)?;
    if roots(&app)?.iter().any(|(_, root)| *root == path) {
        return Err("no se puede borrar una carpeta raíz".into());
    }
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn keyring_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match keyring_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring_entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match keyring_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
