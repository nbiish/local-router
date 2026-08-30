use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let status_i = MenuItem::with_id(app, "status", "● Local Router (127.0.0.1:11434)", false, None::<&str>)?;
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

    let _tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Local Router (127.0.0.1:11434)")
        .on_menu_event(move |app: &AppHandle<Wry>, event| {
            let id = event.id.as_ref();
            match id {
                "dashboard" => {
                    open_or_show_window(app, "http://127.0.0.1:11434/config");
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
                    let _ = open::that("http://127.0.0.1:11434/config");
                }
                "quit" => {
                    println!("[tray] Quit requested. Exiting Local Router.");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                open_or_show_window(app, "http://127.0.0.1:11434/config");
            }
        })
        .build(app)?;

    Ok(())
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