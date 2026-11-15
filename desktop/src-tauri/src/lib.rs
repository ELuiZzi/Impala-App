mod desktop;
mod files;
mod library;
mod media;
mod storage;

use std::sync::Mutex;
use tauri::Manager;

/// En desarrollo, los errores y avisos de la consola de la ventana llegan aquí (ver app/index.web.ts):
/// así se ven en la terminal de `npm run dev` sin abrir las herramientas de desarrollo.
#[tauri::command]
fn dev_log(level: String, message: String) {
    eprintln!("[ventana {level}] {message}");
}

/// Dónde busca el updater las versiones nuevas: `latest.json` de la última versión de GitHub Releases del
/// repositorio de `expo.extra.githubRepo` en app/app.json (el mismo dato que usa el teléfono; se lee al compilar).
fn updater_endpoint() -> serde_json::Value {
    let app: serde_json::Value = serde_json::from_str(include_str!("../../../app/app.json")).expect("app/app.json no es JSON");
    let repo = app["expo"]["extra"]["githubRepo"].as_str().expect("falta expo.extra.githubRepo en app/app.json");
    serde_json::json!([format!("https://github.com/{repo}/releases/latest/download/latest.json")])
}

/// Impala para PC: ventana con la app web de `app/` (Expo exportado a web).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if let Some(updater) = context.config_mut().plugins.0.get_mut("updater") {
        updater["endpoints"] = updater_endpoint();
    }
    tauri::Builder::default()
        // Abrir Impala otra vez muestra la ventana que ya hay (también si estaba en la bandeja).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main(app)))
        // Recuerda tamaño, posición y si estaba maximizada.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Peticiones a otros sitios (YouTube, LRCLIB, el uploader del servidor) desde Rust: sin CORS.
        .plugin(tauri_plugin_http::init())
        // Selector de archivos de Windows (Importar).
        .plugin(tauri_plugin_dialog::init())
        // Actualizaciones desde GitHub Releases (latest.json, firmadas) y reiniciar tras instalarlas.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Audio y carátulas guardados, para el reproductor: http://impala.localhost/... (files.rs).
        .register_asynchronous_uri_scheme_protocol("impala", files::protocol)
        .manage(files::Transfers::default())
        .manage(library::Library::default())
        .setup(|app| {
            let prefs = desktop::load_prefs(app.handle());
            app.manage(desktop::Prefs(Mutex::new(prefs)));
            desktop::setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(desktop::on_window_event)
        .invoke_handler(tauri::generate_handler![
            dev_log,
            desktop::get_close_to_tray,
            desktop::set_close_to_tray,
            desktop::set_tray_tooltip,
            files::fs_download,
            files::fs_cancel,
            files::pick_audio,
            files::upload_file,
            library::library_songs,
            library::library_folders,
            library::library_music_folder,
            library::library_pick_folder,
            library::library_ensure_folder,
            library::library_sidecar_lyrics,
            library::library_delete,
            library::library_reveal,
            media::media_probe,
            media::media_waveform,
            media::media_trim,
            media::media_copy,
            media::media_overwrite,
            media::youtube_download,
            storage::fs_snapshot,
            storage::fs_write,
            storage::fs_delete,
            storage::fs_mkdir,
            storage::fs_rmdir,
            storage::secret_get,
            storage::secret_set,
            storage::secret_delete,
        ])
        .run(context)
        .expect("no se pudo abrir Impala");
}
