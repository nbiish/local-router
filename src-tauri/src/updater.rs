//! Self-update via tauri-plugin-updater.
//!
//! The app checks https://local-router.com/updates/latest.json (see
//! scripts/make-update-manifest.mjs for how releases publish it). Updates are
//! signature-verified against the embedded minisign public key in
//! tauri.conf.json — an unsigned or tampered update is rejected by the plugin.
//!
//! UX: on startup (delayed 20s) and on demand ("Check for Updates" tray item),
//! the menu item label becomes either "✓ Up to date (vX)" or
//! "⬆ Install vX Update"; clicking it installs and restarts.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

pub struct UpdateState {
    pub label: String,
    pub pending: Option<tauri_plugin_updater::Update>,
}

pub type SharedUpdateState = Arc<Mutex<UpdateState>>;

pub fn default_state() -> SharedUpdateState {
    Arc::new(Mutex::new(UpdateState {
        label: "Check for Updates".to_string(),
        pending: None,
    }))
}

/// Kick a silent check after startup so the tray reflects a newer remote release
/// without blocking launch. Never panics: a failed check just logs.
pub fn background_check(app: &AppHandle<Wry>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        run_check(&app);
    });
}

/// One update probe. Runs on a worker thread (blocks on the async updater).
pub fn run_check(app: &AppHandle<Wry>) {
    let handle = app.clone();
    let result = tauri::async_runtime::block_on(async move {
        let updater = handle.updater()?;
        updater.check().await
    });
    match result {
        Ok(Some(update)) => {
            let label = format!("\u{2b06} Install v{} Update", update.version);
            println!("[updater] update available: v{}", update.version);
            if let Some(state) = app.try_state::<SharedUpdateState>() {
                let mut s = state.inner().lock().unwrap();
                s.pending = Some(update);
                s.label = label;
            }
            crate::tray::refresh_menu(app);
        }
        Ok(None) => {
            println!("[updater] already on the latest version (v{})", env!("CARGO_PKG_VERSION"));
            if let Some(state) = app.try_state::<SharedUpdateState>() {
                let mut s = state.inner().lock().unwrap();
                s.pending = None;
                s.label = format!("\u{2713} Up to date (v{})", env!("CARGO_PKG_VERSION"));
            }
            crate::tray::refresh_menu(app);
        }
        Err(e) => {
            // Endpoint 404 (no manifest yet) or offline: keep the default label.
            println!("[updater] check skipped/failed: {}", e);
        }
    }
}

/// Install a previously checked update, then restart into it.
pub fn run_install(app: &AppHandle<Wry>) {
    let update = {
        let state = app.state::<SharedUpdateState>();
        let mut s = state.inner().lock().unwrap();
        s.pending.take()
    };
    let Some(update) = update else {
        run_check(app);
        return;
    };
    println!("[updater] downloading and installing v{} ...", update.version);
    let result = tauri::async_runtime::block_on(async move {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
    });
    match result {
        Ok(()) => {
            println!("[updater] installed; restarting");
            app.restart();
        }
        Err(e) => {
            println!("[updater] install failed: {}", e);
            if let Some(state) = app.try_state::<SharedUpdateState>() {
                let mut s = state.inner().lock().unwrap();
                s.label = "Update failed \u{2014} Check for Updates".to_string();
            }
            crate::tray::refresh_menu(app);
        }
    }
}
