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

use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

/// What both the tray menu and the in-app control render. There is one source
/// of truth: the SharedUpdateState populated by the signed updater.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub label: String,
    pub update_available: bool,
    pub available_version: Option<String>,
}

type CheckResult = Result<Option<tauri_plugin_updater::Update>, tauri_plugin_updater::Error>;

pub fn current_info(app: &AppHandle<Wry>) -> UpdateInfo {
    let (label, available_version) = match app.try_state::<SharedUpdateState>() {
        Some(state) => {
            let guard = state.inner().lock().unwrap();
            let version = guard.pending.as_ref().map(|update| update.version.clone());
            (guard.label.clone(), version)
        }
        None => ("Check for Updates".to_string(), None)
    };
    UpdateInfo {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        update_available: available_version.is_some(),
        label,
        available_version,
    }
}

/// Record one check result, refresh the tray, and return the shared status.
fn record_check(app: &AppHandle<Wry>, result: CheckResult) -> UpdateInfo {
    match result {
        Ok(Some(update)) => {
            let label = format!("\u{2b06} Install v{} Update", update.version);
            println!("[updater] update available: v{}", update.version);
            if let Some(state) = app.try_state::<SharedUpdateState>() {
                let mut guard = state.inner().lock().unwrap();
                guard.pending = Some(update);
                guard.label = label;
            }
            crate::tray::refresh_menu(app);
        }
        Ok(None) => {
            println!("[updater] already on the latest version (v{})", env!("CARGO_PKG_VERSION"));
            if let Some(state) = app.try_state::<SharedUpdateState>() {
                let mut guard = state.inner().lock().unwrap();
                guard.pending = None;
                guard.label = format!("\u{2713} Up to date (v{})", env!("CARGO_PKG_VERSION"));
            }
            crate::tray::refresh_menu(app);
        }
        Err(e) => {
            // Endpoint 404 (no manifest yet) or offline: keep the default label.
            println!("[updater] check skipped/failed: {}", e);
        }
    }
    current_info(app)
}

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
    let _ = record_check(app, result);
}

/// Tauri command used by the in-app control. Awaits the signed check and
/// returns the same state the tray renders, so the two never disagree.
#[tauri::command]
pub async fn check_updates(app: tauri::AppHandle) -> UpdateInfo {
    let handle = app.clone();
    let spawned = tauri::async_runtime::spawn(async move {
        let updater = handle.updater()?;
        updater.check().await
    });
    match spawned.await {
        Ok(result) => record_check(&app, result),
        Err(e) => {
            println!("[updater] check task failed: {}", e);
            current_info(&app)
        }
    }
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateInfo {
    current_info(&app)
}

#[tauri::command]
pub fn install_update(app: tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || run_install(&handle));
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
