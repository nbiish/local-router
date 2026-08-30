mod daemon;
mod tray;

use daemon::DaemonManager;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let daemon = Arc::new(DaemonManager::new(11434));
    let daemon_clone = Arc::clone(&daemon);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacConfig::default(),
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // 1. Ensure daemon is active on 11434
            daemon_clone.ensure_started();

            // 2. Setup native corner system tray icon
            tray::setup_tray(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Clicking 'X' on window hides it to system tray rather than killing server
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Local Router desktop application");
}