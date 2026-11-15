//! Recortar y descargar de YouTube en la música del equipo (Fase 6 de la versión de PC), con el ffmpeg que va dentro
//! de la app (src-tauri/binaries, `npm run ffmpeg`). El recorte hace lo mismo que el servidor
//! (server/uploader/src/trimmer.js): sin pérdida se recodifica con el mismo códec (muestras idénticas); con pérdida
//! se copian las tramas (el corte cae en la trama más cercana).

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::files::Transfers;
use crate::library::{audio_path, resolve_folder};
use crate::storage::resolve;

const LOSSLESS: [&str; 9] = ["flac", "alac", "wavpack", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s16be", "pcm_s24be", "pcm_f32le"];
const LOSSY_COPY: [&str; 4] = ["mp3", "aac", "opus", "vorbis"];
/// Contenedores que guardan la carátula como un flujo de vídeo (attached_pic).
const COVER_AS_STREAM: [&str; 4] = ["mp3", "m4a", "mp4", "flac"];
/// YouTube frena las descargas enteras a velocidad de reproducción: se piden tramos de 10 MB (como yt-dlp).
const YT_CHUNK: u64 = 10 * 1024 * 1024;

/// ffmpeg.exe junto al ejecutable de Impala (Tauri copia ahí los binaries/ al compilar y al instalar).
fn ffmpeg() -> Result<PathBuf, String> {
    let dir = std::env::current_exe().map_err(|e| e.to_string())?.parent().map(Path::to_path_buf).ok_or("sin carpeta")?;
    let exe = dir.join("ffmpeg.exe");
    if exe.exists() { Ok(exe) } else { Err("Falta ffmpeg.exe junto a Impala (npm run ffmpeg en desktop/)".into()) }
}

/// Ejecuta ffmpeg sin abrir una consola. Devuelve la salida estándar; si falla, la última línea de error.
fn run(args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(ffmpeg()?);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("No se pudo ejecutar ffmpeg: {e}"))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(format!("ffmpeg falló: {}", err.trim().lines().last().unwrap_or("error desconocido")))
}

/// Códec del primer audio y bits por muestra, leídos de lo que ffmpeg dice del archivo («Audio: flac, 44100 Hz, stereo, s32 (24 bit)»).
fn codec_of(path: &Path) -> Option<(String, Option<u32>)> {
    let mut cmd = Command::new(ffmpeg().ok()?);
    cmd.args(["-hide_banner", "-i"]).arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let line = text.lines().find(|l| l.contains("Audio: "))?;
    let rest = line.split("Audio: ").nth(1)?;
    let codec = rest.split([' ', ',', '(']).next()?.to_string();
    let bits = rest.split('(').filter_map(|p| p.split(" bit)").next()).find_map(|n| n.trim().parse().ok());
    Some((codec, bits))
}

fn method(codec: &str) -> Option<&'static str> {
    if LOSSLESS.contains(&codec) {
        Some("reencode")
    } else if LOSSY_COPY.contains(&codec) {
        Some("copy")
    } else {
        None
    }
}

fn song(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    audio_path(app, id).ok_or_else(|| "La canción ya no está en el equipo".to_string())
}

fn ext(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    duration_ms: u64,
    codec: String,
    container: String,
    suffix: Option<String>,
    size: u64,
    modified: u64,
    can_trim: bool,
}

#[tauri::command]
pub async fn media_probe(app: AppHandle, id: String) -> Result<AudioProbe, String> {
    let path = song(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let duration_ms = lofty::read_from_path(&path).map(|t| t.properties().duration().as_millis() as u64).unwrap_or(0);
        let (codec, _) = codec_of(&path).ok_or("No se pudo leer el audio del archivo")?;
        let suffix = ext(&path);
        Ok(AudioProbe {
            duration_ms,
            can_trim: method(&codec).is_some(),
            codec,
            container: if suffix == "m4a" { "mp4".into() } else { suffix.clone() },
            suffix: (!suffix.is_empty()).then_some(suffix),
            size: meta.len(),
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Picos de la forma de onda (0 a 1): mono a 1 kHz y el máximo de cada tramo (como el servidor).
#[tauri::command]
pub async fn media_waveform(app: AppHandle, id: String, points: usize) -> Result<Vec<f32>, String> {
    let path = song(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let input = path.to_string_lossy().into_owned();
        let pcm = run(&["-v", "error", "-i", &input, "-vn", "-ac", "1", "-ar", "1000", "-f", "s16le", "-"])?;
        let samples: Vec<i16> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        if samples.is_empty() || points == 0 {
            return Ok(Vec::new());
        }
        let per = samples.len() as f64 / points as f64;
        let peaks: Vec<f32> = (0..points)
            .map(|p| {
                let start = (p as f64 * per) as usize;
                let end = (((p + 1) as f64 * per) as usize).min(samples.len());
                samples[start..end.max(start)].iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f32
            })
            .collect();
        let max = peaks.iter().cloned().fold(0.0, f32::max);
        Ok(peaks.into_iter().map(|v| if max > 0.0 { (v / max * 1000.0).round() / 1000.0 } else { 0.0 }).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Escribe en `output` (un archivo de la app) la canción con solo los tramos `keep` (s). Devuelve la duración (ms).
#[tauri::command]
pub async fn media_trim(app: AppHandle, id: String, keep: Vec<[f64; 2]>, output: String) -> Result<u64, String> {
    let input = song(&app, &id)?;
    let output = resolve(&app, &output)?;
    tauri::async_runtime::spawn_blocking(move || cut(&input, &output, &keep)).await.map_err(|e| e.to_string())?
}

fn cut(input: &Path, output: &Path, keep: &[[f64; 2]]) -> Result<u64, String> {
    let (codec, bits) = codec_of(input).ok_or("No se pudo leer el audio del archivo")?;
    let how = method(&codec).ok_or_else(|| format!("No se pueden recortar archivos {}", codec.to_uppercase()))?;
    if let Some(dir) = output.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out_ext = ext(output);
    let cover = COVER_AS_STREAM.contains(&out_ext.as_str());
    let input_s = input.to_string_lossy().into_owned();
    let output_s = output.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into()];

    if how == "reencode" {
        let parts: Vec<String> = keep.iter().enumerate().map(|(i, [s, e])| format!("[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]")).collect();
        let inputs: String = (0..keep.len()).map(|i| format!("[a{i}]")).collect();
        let graph = format!("{};{inputs}concat=n={}:v=0:a=1[out]", parts.join(";"), keep.len());
        args.extend(["-i".into(), input_s.clone(), "-filter_complex".into(), graph, "-map".into(), "[out]".into()]);
        if cover {
            args.extend(["-map", "0:v?", "-c:v", "copy", "-disposition:v", "attached_pic"].map(String::from));
        }
        args.extend(["-map_metadata".into(), "0".into(), "-c:a".into(), codec.clone()]);
        if codec == "flac" {
            if let Some(b) = bits {
                args.extend(["-bits_per_raw_sample".into(), b.to_string()]);
            }
            args.extend(["-compression_level".into(), "8".into()]);
        }
    } else {
        // Copia de tramas, en dos pasos: cada tramo se corta aparte con -ss/-to (sus tiempos empiezan en 0) y luego
        // se unen enteros. Con inpoint/outpoint del demuxer concat (lo que hace el servidor), el archivo empezaba en el
        // tiempo del primer corte (p. ej. 4,96 s) y el reproductor del PC mostraba el progreso desplazado.
        let list = output.with_extension("ffconcat");
        let mut text = String::from("ffconcat version 1.0\n");
        for (i, [s, e]) in keep.iter().enumerate() {
            let segment = output.with_extension(format!("parte{i}.{out_ext}"));
            let segment_s = segment.to_string_lossy().into_owned();
            let cut = run(&[
                "-v", "error", "-y", "-ss", &s.to_string(), "-to", &e.to_string(), "-i", &input_s,
                "-map", "0:a", "-c", "copy", "-avoid_negative_ts", "make_zero", &segment_s,
            ]);
            if let Err(err) = cut {
                remove_segments(output, keep.len(), &out_ext);
                return Err(err);
            }
            text.push_str(&format!("file '{}'\n", segment_s.replace('\'', "'\\''")));
        }
        fs::write(&list, text).map_err(|e| e.to_string())?;
        args.extend(["-f", "concat", "-safe", "0", "-i"].map(String::from));
        args.push(list.to_string_lossy().into_owned());
        args.extend(["-i".into(), input_s.clone(), "-map".into(), "0:a".into()]);
        if cover {
            args.extend(["-map", "1:v?", "-disposition:v", "attached_pic"].map(String::from));
        }
        args.extend(["-map_metadata", "1", "-c", "copy"].map(String::from));
    }
    if out_ext == "mp3" {
        args.extend(["-id3v2_version".into(), "3".into()]);
    }
    args.push(output_s);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run(&refs);
    let _ = fs::remove_file(output.with_extension("ffconcat"));
    remove_segments(output, keep.len(), &out_ext);
    result?;

    // Ogg/Opus guarda la carátula en una etiqueta que ffmpeg no sabe volver a escribir: se copian las etiquetas
    // del original (con la carátula) con lofty.
    if matches!(out_ext.as_str(), "opus" | "ogg" | "oga") {
        if let Ok(original) = lofty::read_from_path(input) {
            if let Some(tag) = original.primary_tag() {
                let _ = tag.save_to_path(output, WriteOptions::default());
            }
        }
    }
    Ok(lofty::read_from_path(output).map(|t| t.properties().duration().as_millis() as u64).unwrap_or(0))
}

fn remove_segments(output: &Path, count: usize, ext: &str) {
    for i in 0..count {
        let _ = fs::remove_file(output.with_extension(format!("parte{i}.{ext}")));
    }
}

/// Copia la canción a un archivo de la app (el original que se guarda antes de recortar).
#[tauri::command]
pub fn media_copy(app: AppHandle, id: String, output: String) -> Result<(), String> {
    let input = song(&app, &id)?;
    let output = resolve(&app, &output)?;
    if let Some(dir) = output.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::copy(input, output).map(|_| ()).map_err(|e| e.to_string())
}

/// Sustituye el archivo de la canción por `input` (de la app): primero a un temporal junto a ella y luego se
/// renombra, para no dejar la canción a medias.
#[tauri::command]
pub fn media_overwrite(app: AppHandle, id: String, input: String) -> Result<bool, String> {
    let target = song(&app, &id)?;
    let source = resolve(&app, &input)?;
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(".impala-tmp");
    let tmp = PathBuf::from(tmp);
    fs::copy(&source, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

// --- Descargas de YouTube al equipo -----------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeDownload {
    job_id: String,
    url: String,
    user_agent: Option<String>,
    content_length: Option<u64>,
    base_name: String,
    folder: String,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    track: Option<u32>,
    year: Option<u32>,
    cover_urls: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    id: String,
    uri: String,
    file_name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeProgress {
    stage: &'static str,
    progress: f64,
}

/// Descarga el m4a, lo remultiplexa con ffmpeg (YouTube lo da fragmentado), le pone etiquetas y carátula cuadrada y
/// lo guarda en la carpeta (normalmente Music/Impala). Se cancela con fs_cancel(jobId).
#[tauri::command]
pub async fn youtube_download(app: AppHandle, transfers: State<'_, Transfers>, job: YoutubeDownload, on_progress: Channel<YoutubeProgress>) -> Result<Saved, String> {
    let cancelled = transfers.start(&job.job_id);
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(format!("yt-{}", job.job_id));
    let result = youtube(&job, &work, &cancelled, &on_progress).await;
    let _ = fs::remove_dir_all(&work);
    transfers.finish(&job.job_id);
    result
}

async fn youtube(job: &YoutubeDownload, work: &Path, cancelled: &std::sync::atomic::AtomicBool, progress: &Channel<YoutubeProgress>) -> Result<Saved, String> {
    tokio::fs::create_dir_all(work).await.map_err(|e| e.to_string())?;
    let raw = work.join("raw.m4a");
    let client = reqwest::Client::builder()
        .user_agent(job.user_agent.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| "Mozilla/5.0".into()))
        .build()
        .map_err(|e| e.to_string())?;

    let mut out = tokio::fs::File::create(&raw).await.map_err(|e| e.to_string())?;
    let mut total = job.content_length.filter(|n| *n > 0);
    let mut pos = 0u64;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Descarga cancelada".into());
        }
        let end = total.map(|t| (pos + YT_CHUNK).min(t) - 1);
        let sep = if job.url.contains('?') { '&' } else { '?' };
        let url = match end {
            Some(e) => format!("{}{sep}range={pos}-{e}", job.url),
            None => job.url.clone(),
        };
        let mut res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("YouTube respondió HTTP {}", res.status().as_u16()));
        }
        if total.is_none() {
            total = res.content_length().filter(|n| *n > 0);
        }
        let before = pos;
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Descarga cancelada".into());
            }
            out.write_all(&chunk).await.map_err(|e| e.to_string())?;
            pos += chunk.len() as u64;
            if let Some(t) = total {
                let _ = progress.send(YoutubeProgress { stage: "downloading", progress: pos as f64 / t as f64 });
            }
        }
        match (end, total) {
            (None, _) => break,
            _ if pos == before => return Err("YouTube cortó la descarga".into()),
            (_, Some(t)) if pos >= t => break,
            _ => {}
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    let _ = progress.send(YoutubeProgress { stage: "processing", progress: 1.0 });

    // Carátula: la primera que se descargue, recortada en cuadrado por ffmpeg.
    let mut cover: Option<Vec<u8>> = None;
    for url in &job.cover_urls {
        let Ok(res) = client.get(url).send().await else { continue };
        if !res.status().is_success() {
            continue;
        }
        let Ok(bytes) = res.bytes().await else { continue };
        let src = work.join("cover-src");
        let dst = work.join("cover.jpg");
        if fs::write(&src, &bytes).is_err() {
            continue;
        }
        let ok = run(&[
            "-v", "error", "-y", "-i", &src.to_string_lossy(),
            "-vf", "crop='min(iw,ih)':'min(iw,ih)'", "-q:v", "2", "-frames:v", "1", &dst.to_string_lossy(),
        ]);
        if ok.is_ok() {
            if let Ok(data) = fs::read(&dst) {
                cover = Some(data);
                break;
            }
        }
    }

    let remuxed = work.join("audio.m4a");
    run(&["-v", "error", "-y", "-i", &raw.to_string_lossy(), "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", &remuxed.to_string_lossy()])?;
    write_tags(&remuxed, job, cover)?;

    // A la carpeta, sin pisar nada: «Artista - Título (2).m4a» si ya existe.
    let folder = resolve_folder(&job.folder);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let safe: String = job.base_name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let safe = safe.trim().trim_end_matches('.').to_string();
    let mut target = folder.join(format!("{safe}.m4a"));
    let mut n = 2;
    while target.exists() {
        target = folder.join(format!("{safe} ({n}).m4a"));
        n += 1;
    }
    fs::copy(&remuxed, &target).map_err(|e| e.to_string())?;
    let id = crate::library::song_id(&target);
    Ok(Saved {
        uri: format!("http://impala.localhost/local/{id}"),
        id,
        file_name: target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    })
}

fn write_tags(path: &Path, job: &YoutubeDownload, cover: Option<Vec<u8>>) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().ok_or("sin etiquetas")?;
    tag.set_title(job.title.clone());
    if let Some(a) = &job.artist {
        tag.set_artist(a.clone());
    }
    if let Some(a) = &job.album {
        tag.set_album(a.clone());
    }
    if let Some(a) = &job.album_artist {
        tag.insert_text(ItemKey::AlbumArtist, a.clone());
    }
    if let Some(t) = job.track {
        tag.set_track(t);
    }
    if let Some(y) = job.year {
        tag.insert_text(ItemKey::Year, y.to_string());
    }
    if let Some(data) = cover {
        tag.push_picture(Picture::unchecked(data).pic_type(PictureType::CoverFront).mime_type(MimeType::Jpeg).build());
    }
    tagged.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}
