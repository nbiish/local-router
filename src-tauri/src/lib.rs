mod daemon;
mod tray;
mod updater;

use daemon::DaemonManager;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let daemon = Arc::new(DaemonManager::new(11434));
    let daemon_for_setup = Arc::clone(&daemon);
    let daemon_for_exit = Arc::clone(&daemon);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&daemon))
        .manage(updater::default_state())
        .setup(move |app| {
            // 1. Ensure backend daemon is active on 11434
            daemon_for_setup.ensure_started();

            // 2. Setup native corner system tray icon (the single tray; no
            //    config-level trayIcon block)
            tray::setup_tray(app.handle())?;

            // 3. Probe the update endpoint in the background so the tray can
            //    surface a newer remote release without blocking launch.
            updater::background_check(app.handle());

            // 4. Show and focus main application window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window minimizes to corner tray so background routing continues
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Local Router desktop application");

    app.run(move |_app_handle, event| {
        // Quit paths (tray Quit item, Cmd+Q, logout) all land here. Only the
        // daemon this app started is stopped; an externally started daemon
        // keeps running.
        if let tauri::RunEvent::Exit = event {
            daemon_for_exit.stop();
        }
    });
}
