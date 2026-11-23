//! Navigation policy for the desktop webview.
//!
//! The window shows the router's dashboard (127.0.0.1:11434). External links
//! (donate page, GitHub, docs) must open in the USER'S BROWSER — never navigate
//! the webview itself, which traps the app window on a website with no back
//! button (reported by the operator: the ♥ donate link stranded the app).

use tauri::{webview::WebviewWindowBuilder, AppHandle, Url, WebviewUrl, Wry};

/// True when the URL is the router's own dashboard surface.
pub fn is_dashboard_url(url: &Url) -> bool {
    let local_host = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    local_host && url.port_or_known_default() == Some(11434)
}

/// Build the single main window with the navigation guard attached.
pub fn build_main_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let dashboard: Url = "http://127.0.0.1:11434/config".parse().expect("static url");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(dashboard))
        .title("Local Router — AI Model Gateway")
        .inner_size(1200.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .resizable(true)
        .visible(true)
        .disable_drag_drop_handler()
        .on_navigation(|url| {
            if is_dashboard_url(url) {
                true
            } else {
                // External destination: hand it to the OS browser and keep the
                // app window on the dashboard.
                println!("[nav] external link opened in system browser: {}", url);
                let _ = open::that(url.as_str());
                false
            }
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_dashboard_url;
    use tauri::Url;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn dashboard_urls_pass() {
        assert!(is_dashboard_url(&u("http://127.0.0.1:11434/config")));
        assert!(is_dashboard_url(&u("http://127.0.0.1:11434/config/providers")));
        assert!(is_dashboard_url(&u("http://localhost:11434/")));
    }

    #[test]
    fn external_urls_are_handed_to_the_browser() {
        assert!(!is_dashboard_url(&u("https://local-router.com/donate")));
        assert!(!is_dashboard_url(&u("https://github.com/nbiish/local-router")));
        assert!(!is_dashboard_url(&u("http://127.0.0.1:9999/")));
        assert!(!is_dashboard_url(&u("http://127.0.0.1.evil.example:11434/")));
    }
}
