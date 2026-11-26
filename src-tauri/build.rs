fn main() {
    // Permissions for the app's own commands exist only for commands declared
    // here. The dashboard is served by the local router, which is a remote origin
    // for IPC, so it reaches the updater only through a capability that names
    // these permissions (src-tauri/capabilities/dashboard-updater.json). A command
    // added to `generate_handler!` for the dashboard must be added here too.
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "check_updates",
        "update_status",
        "install_update",
    ]);
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(app_manifest),
    )
    .expect("tauri-build failed");
}
