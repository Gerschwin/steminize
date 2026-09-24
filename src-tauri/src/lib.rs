// The desktop app is a thin native shell around the same web app:
// separation runs in the webview (WebGPU where available, otherwise CPU/WASM).
// The two plugins provide native "Save as" / folder dialogs and file writing.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Stemdeck");
}
