use crate::daemon::DaemonManager;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

const TRAY_ID: &str = "main-tray";
const DASHBOARD_URL: &str = "http://127.0.0.1:11434/config";

fn status_text(running: bool) -> String {
    if running {
        "● Local Router (127.0.0.1:11434)".to_string()
    } else {
        "○ Local Router offline (127.0.0.1:11434)".to_string()
    }
}

fn build_menu(app: &AppHandle<Wry>, running: bool) -> tauri::Result<Menu<Wry>> {
    let status_i = MenuItem::with_id(app, "status", status_text(running), false, None::<&str>)?;
    let dashboard_i = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
    let providers_i = MenuItem::with_id(app, "providers", "Providers & Keys", true, None::<&str>)?;
    let fallback_i = MenuItem::with_id(app, "fallback", "Fallback Routes", true, None::<&str>)?;
    let thinking_i = MenuItem::with_id(app, "thinking", "Prompt & Thinking", true, None::<&str>)?;
    let logs_i = MenuItem::with_id(app, "logs", "Expert Logs", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let restart_i = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit Local Router", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_i,
            &dashboard_i,
            &providers_i,
            &fallback_i,
            &thinking_i,
            &logs_i,
            &separator1,
            &restart_i,
            &separator2,
            &quit_i,
        ],
    )?;
    Ok(menu)
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, true)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(false)
        .tooltip("Local Router (127.0.0.1:11434)")
        .on_menu_event(|app: &AppHandle<Wry>, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                open_or_show_window(app, DASHBOARD_URL);
            }
        });

    // Full-color branded icon from the bundled window icons. Template mode is
    // off on purpose: it would mask the artwork into a monochrome shape.
    match app.default_window_icon() {
        Some(icon) => {
            builder = builder.icon(icon.clone());
        }
        None => {
            eprintln!("[tray] No bundled window icon found; the tray icon will be blank.");
        }
    }

    builder.build(app)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle<Wry>, id: &str) {
    match id {
        "dashboard" => {
            open_or_show_window(app, DASHBOARD_URL);
        }
        "providers" => {
            open_or_show_window(app, "http://127.0.0.1:11434/config/providers");
        }
        "fallback" => {
            open_or_show_window(app, "http://127.0.0.1:11434/config/fallback");
        }
        "thinking" => {
            open_or_show_window(app, "http://127.0.0.1:11434/config/thinking");
        }
        "logs" => {
            let _ = open::that("http://127.0.0.1:11434/api/logs");
        }
        "restart" => {
            println!("[tray] Restart requested from tray context menu.");
            let app = app.clone();
            // Restart blocks for seconds (CLI stop + readiness wait); keep it
            // off the main thread so the UI never freezes.
            std::thread::spawn(move || restart_daemon_and_refresh(&app));
        }
        "quit" => {
            println!("[tray] Quit requested. Exiting Local Router.");
            // Daemon cleanup happens in the RunEvent::Exit handler in lib.rs.
            app.exit(0);
        }
        _ => {}
    }
}

/// Restart the daemon off-thread, then refresh the tray status item and reopen
/// the dashboard. Tray menu handles are not thread-safe, so the menu is rebuilt
/// on the main thread and swapped in via TrayIcon::set_menu.
fn restart_daemon_and_refresh(app: &AppHandle<Wry>) {
    let state = app.state::<Arc<DaemonManager>>().inner().clone();
    state.restart();
    let running = state.is_running();
    let app_in_closure = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Some(tray) = app_in_closure.tray_by_id(TRAY_ID) {
            match build_menu(&app_in_closure, running) {
                Ok(menu) => {
                    if let Err(e) = tray.set_menu(Some(menu)) {
                        eprintln!("[tray] Failed to refresh tray menu: {}", e);
                    }
                }
                Err(e) => eprintln!("[tray] Failed to rebuild tray menu: {}", e),
            }
        }
        open_or_show_window(&app_in_closure, DASHBOARD_URL);
    }) {
        eprintln!("[tray] Failed to refresh tray status on the main thread: {}", e);
    }
}

fn open_or_show_window(app: &AppHandle<Wry>, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        if let Ok(parsed_url) = url.parse() {
            let _ = window.navigate(parsed_url);
        }
    } else {
        let _ = open::that(url);
    }
}
