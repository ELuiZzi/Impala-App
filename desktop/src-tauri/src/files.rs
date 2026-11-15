//! Archivos grandes (Fase 4 de la versión de PC): servir audio y carátulas guardados al WebView, descargar
//! (canciones sin conexión) y subir al servidor (Importar). Todo en Rust: por IPC solo viajan rutas y progreso.

use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::ipc::Channel;
use tauri::{AppHandle, State, UriSchemeContext, UriSchemeResponder};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

use crate::storage::resolve;

/// Audio que acepta el microservicio de ingestión (las mismas que app/src/upload/store.ts).
const AUDIO_EXTENSIONS: [&str; 14] = ["flac", "mp3", "opus", "ogg", "oga", "m4a", "aac", "wav", "aif", "aiff", "wma", "ape", "wv", "dsf"];
/// Respuesta máxima a una petición de rango abierta («bytes=N-»): el <audio> pide el resto en otra.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;

/// Tipo MIME por extensión (en minúsculas, sin punto).
pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "opus" | "ogg" | "oga" => "audio/ogg",
        "m4a" | "aac" | "mp4" => "audio/mp4",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "wma" => "audio/x-ms-wma",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn mime(path: &Path) -> &'static str {
    mime_for(&path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default())
}

// --- Protocolo impala:// (en Windows, http://impala.localhost/...) ------------------------------

/// Sirve los archivos de la app al WebView con soporte de rangos (para buscar dentro de una canción) y
/// CORS abierto: el reproductor pasa el audio por Web Audio, que deja en silencio lo que no lo tenga.
pub fn protocol(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let path = percent_decode(request.uri().path());
        let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
        let response = if let Some(id) = path.strip_prefix("/local/") {
            // Música del equipo (library.rs): solo de las carpetas elegidas.
            match crate::library::audio_path(&app, id) {
                Some(p) => serve(&p, range),
                None => error(StatusCode::NOT_FOUND, "no está en las carpetas elegidas"),
            }
        } else if let Some(album) = path.strip_prefix("/local-cover/") {
            match crate::library::album_cover(&app, album) {
                Some((bytes, mime)) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::CACHE_CONTROL, "max-age=3600")
                    .body(bytes)
                    .unwrap(),
                None => error(StatusCode::NOT_FOUND, "sin carátula"),
            }
        } else {
            match resolve(&app, &format!("http://impala.localhost{path}")) {
                Ok(p) => serve(&p, range),
                Err(e) => error(StatusCode::FORBIDDEN, &e),
            }
        };
        responder.respond(response);
    });
}

fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&path[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

fn serve(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let Ok(mut file) = std::fs::File::open(path) else { return error(StatusCode::NOT_FOUND, "no existe") };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, mime(path));

    // «bytes=inicio-[fin]»; sin rango (carátulas, JSON) va el archivo entero.
    let parsed = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
        let (a, b) = r.split_once('-')?;
        let start: u64 = a.trim().parse().ok()?;
        let end: Option<u64> = b.trim().parse().ok();
        Some((start, end))
    });
    let Some((start, end)) = parsed else {
        let mut body = Vec::with_capacity(size as usize);
        if file.read_to_end(&mut body).is_err() {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer");
        }
        return builder.status(StatusCode::OK).body(body).unwrap();
    };
    if start >= size {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Vec::new())
            .unwrap();
    }
    let end = end.unwrap_or(start + MAX_CHUNK - 1).min(size - 1).min(start + MAX_CHUNK * 4 - 1);
    let mut body = vec![0u8; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer");
    }
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .body(body)
        .unwrap()
}

// --- Descargas (canciones sin conexión) ---------------------------------------------------------

#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Transfers {
    pub fn start(&self, key: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(key.to_string(), flag.clone());
        flag
    }
    pub fn finish(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    done: u64,
    total: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("Impala").build().map_err(|e| e.to_string())
}

/// Descarga `url` en el archivo de la app `uri` (primero a un temporal: una descarga cortada no deja un archivo a
/// medias). Devuelve el tamaño final. `fs_cancel(uri)` la corta.
#[tauri::command]
pub async fn fs_download(app: AppHandle, transfers: State<'_, Transfers>, url: String, uri: String, on_progress: Channel<Progress>) -> Result<u64, String> {
    let path = resolve(&app, &uri)?;
    let cancelled = transfers.start(&uri);
    let result = download(&url, &path, &cancelled, &on_progress).await;
    transfers.finish(&uri);
    result
}

async fn download(url: &str, path: &Path, cancelled: &AtomicBool, progress: &Channel<Progress>) -> Result<u64, String> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("El servidor respondió HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".impala-tmp");
    let tmp = PathBuf::from(tmp);
    let mut out = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut done = 0u64;
    let mut last_report = 0u64;
    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Relaxed) {
            drop(out);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("Descarga cancelada".into());
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(out);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e.to_string());
            }
        };
        out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last_report > 256 * 1024 {
            last_report = done;
            let _ = progress.send(Progress { done, total });
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())?;
    let _ = progress.send(Progress { done, total: total.max(done) });
    Ok(done)
}

#[tauri::command]
pub fn fs_cancel(transfers: State<'_, Transfers>, key: String) {
    if let Some(flag) = transfers.0.lock().unwrap().get(&key) {
        flag.store(true, Ordering::Relaxed);
    }
}

// --- Elegir archivos e Importar -----------------------------------------------------------------

#[derive(Serialize)]
pub struct PickedFile {
    path: String,
    name: String,
    size: u64,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Los audios de esas rutas: archivos sueltos o carpetas (con sus subcarpetas).
fn collect(paths: Vec<PathBuf>) -> Vec<PickedFile> {
    let mut out = Vec::new();
    let mut stack = paths;
    while let Some(path) = stack.pop() {
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                stack.extend(entries.flatten().map(|e| e.path()));
            }
        } else if is_audio(&path) {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(PickedFile { path: path.to_string_lossy().into_owned(), name, size });
        }
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    out
}

/// Selector de Windows: archivos de audio o una carpeta. Vacío si se cancela.
#[tauri::command]
pub async fn pick_audio(app: AppHandle, folder: bool) -> Vec<PickedFile> {
    let dialog = app.dialog().file().set_title(if folder { "Elegir carpeta con música" } else { "Elegir canciones" });
    let picked: Vec<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        if folder {
            dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()).into_iter().collect()
        } else {
            dialog
                .add_filter("Audio", &AUDIO_EXTENSIONS)
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .collect()
        }
    })
    .await
    .unwrap_or_default();
    collect(picked)
}

/// Lo mismo para lo que se arrastra a la ventana (ver desktop.rs).
pub fn collect_dropped(paths: Vec<PathBuf>) -> Vec<PickedFile> {
    collect(paths)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    status: u16,
    body: String,
    /// Huella del archivo local, para compararla con la que devuelve el servidor.
    md5: String,
}

/// Sube un archivo del PC al uploader del servidor (multipart, campo «file»), con progreso. El original no se toca.
#[tauri::command]
pub async fn upload_file(transfers: State<'_, Transfers>, path: String, url: String, on_progress: Channel<Progress>) -> Result<UploadResult, String> {
    let cancelled = transfers.start(&path);
    let result = upload(&path, &url, &cancelled, &on_progress).await;
    transfers.finish(&path);
    result
}

async fn upload(path: &str, url: &str, cancelled: &Arc<AtomicBool>, progress: &Channel<Progress>) -> Result<UploadResult, String> {
    let file_path = PathBuf::from(path);
    let md5 = {
        let p = file_path.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let mut file = std::fs::File::open(&p).map_err(|e| e.to_string())?;
            let mut hasher = Md5::new();
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let file = tokio::fs::File::open(&file_path).await.map_err(|e| e.to_string())?;
    let total = file.metadata().await.map_err(|e| e.to_string())?.len();
    let name = file_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "audio".into());
    let progress = progress.clone();
    let cancelled = cancelled.clone();
    let mut sent = 0u64;
    let mut last_report = 0u64;
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).map(move |chunk| {
        if cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("Subida cancelada"));
        }
        if let Ok(c) = &chunk {
            sent += c.len() as u64;
            if sent - last_report > 256 * 1024 || sent == total {
                last_report = sent;
                let _ = progress.send(Progress { done: sent, total });
            }
        }
        chunk
    });
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
        .file_name(name)
        .mime_str(mime(&file_path))
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = client()?.post(url).multipart(form).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(UploadResult { status, body, md5 })
}
