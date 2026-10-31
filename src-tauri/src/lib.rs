mod secrets;
mod transfers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            updater_configured,
            secret_get,
            secret_set,
            secret_delete,
            secret_storage_info,
            clipboard_read_text,
            transfers::transfer_import,
            transfers::transfer_read,
            transfers::transfer_size,
            transfers::transfer_append,
            transfers::transfer_digest,
            transfers::transfer_discard,
            transfers::transfer_export
        ])
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if app.config().plugins.0.contains_key("updater") {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(target_os = "linux")]
            enable_webrtc(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mob");
}

// WebKitGTK ships with WebRTC switched off; the live view uses it when GStreamer's webrtcbin is
// installed, and otherwise falls back to the WebSocket stream played through Media Source.
#[cfg(target_os = "linux")]
fn enable_webrtc(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};
    for window in app.webview_windows().into_values() {
        window.with_webview(|webview| {
            if let Some(settings) = webview.inner().settings() {
                settings.set_enable_webrtc(true);
                settings.set_enable_mediasource(true);
            }
        })?;
    }
    Ok(())
}

#[tauri::command]
fn updater_configured(app: tauri::AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

// Async commands run off the main thread, so a keychain prompt cannot freeze the window.
#[tauri::command]
async fn secret_get(account: String) -> Result<Option<String>, String> {
    secrets::get(&account)
}

#[tauri::command]
async fn secret_set(account: String, value: String) -> Result<String, String> {
    secrets::set(&account, &value).map(|backend| backend.to_string())
}

#[tauri::command]
async fn secret_delete(account: String) -> Result<(), String> {
    secrets::delete(&account)
}

#[tauri::command]
async fn secret_storage_info() -> secrets::StorageInfo {
    secrets::storage_info()
}

/// Reads clipboard text via the OS clipboard APIs (not WebKit).
/// WebKitGTK 2.54.0–2.54.1 can SIGSEGV in Clipboard::formats when paste runs against an empty
/// or one-shot clipboard (https://bugs.webkit.org/show_bug.cgi?id=324466). Pairing paste uses this
/// command instead of the webview's native paste path.
#[tauri::command]
fn clipboard_read_text() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .map_err(|e| format!("Could not read the clipboard: {e}"))
}

#[cfg(test)]
mod clipboard_tests {
    #[test]
    fn clipboard_read_does_not_panic() {
        // May Err if no display/clipboard; must not panic.
        let _ = super::clipboard_read_text();
    }
}
