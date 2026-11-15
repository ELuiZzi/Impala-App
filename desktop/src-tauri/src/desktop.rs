//! La ventana en Windows (Fase 3 de la versión de PC): icono en la bandeja con controles, cerrar a la bandeja
//! (la música sigue sonando) y la preferencia guardada en `%APPDATA%\com.luizzi.impala\ventana.json`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, Window, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const TRAY_ID: &str = "main";

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct WindowPrefs {
    /// Cerrar la ventana la esconde en la bandeja en vez de salir.
    close_to_tray: bool,
}

impl Default for WindowPrefs {
    fn default() -> Self {
        Self { close_to_tray: true }
    }
}

pub struct Prefs(pub Mutex<WindowPrefs>);

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ventana.json"))
}

pub fn load_prefs(app: &AppHandle) -> WindowPrefs {
    prefs_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_close_to_tray(prefs: State<Prefs>) -> bool {
    prefs.0.lock().map(|p| p.close_to_tray).unwrap_or(true)
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, prefs: State<Prefs>, enabled: bool) -> Result<(), String> {
    let mut p = prefs.0.lock().map_err(|e| e.to_string())?;
    p.close_to_tray = enabled;
    if let Some(path) = prefs_path(&app) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(path, serde_json::to_string(&*p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// El texto del icono de la bandeja al pasar el ratón: la canción que suena.
#[tauri::command]
pub fn set_tray_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(if text.is_empty() { "Impala".to_string() } else { text }));
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Salir de verdad (menú de la bandeja): guarda tamaño y posición de la ventana antes.
fn quit(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::all());
    app.exit(0);
}

/// Los controles de la bandeja los ejecuta la app (ver app/src/components/desktop/DesktopShortcuts.web.tsx).
fn send_action(app: &AppHandle, action: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__impalaTray && window.__impalaTray({action:?})"));
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Mostrar Impala", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle", "Reproducir / pausar", true, None::<&str>)?,
            &MenuItem::with_id(app, "previous", "Anterior", true, None::<&str>)?,
            &MenuItem::with_id(app, "next", "Siguiente", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Salir de Impala", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Impala")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            action => send_action(app, action),
        })
        .on_tray_icon_event(|tray, event| {
            // Clic izquierdo: mostrar la ventana (el derecho abre el menú).
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Cerrar la ventana la esconde en la bandeja (si está activado): la música sigue sonando.
/// Soltar archivos o carpetas en la ventana los manda a Importar (app/src/upload/pc.ts).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
        let files = crate::files::collect_dropped(paths.clone());
        if let (Some(w), Ok(json)) = (window.app_handle().get_webview_window("main"), serde_json::to_string(&files)) {
            let _ = w.eval(format!("window.__impalaDrop && window.__impalaDrop({json})"));
        }
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let to_tray = app.state::<Prefs>().0.lock().map(|p| p.close_to_tray).unwrap_or(true);
        if to_tray && window.label() == "main" {
            api.prevent_close();
            let _ = app.save_window_state(StateFlags::all());
            let _ = window.hide();
        }
    }
}
