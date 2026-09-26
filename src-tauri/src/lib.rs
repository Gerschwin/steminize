// The desktop app is a thin native shell around the same web app:
// separation runs in the webview (WebGPU where available, otherwise CPU/WASM).
// The two plugins provide native "Save as" / folder dialogs and file writing.
// The ytdlp module adds the one thing a browser tab can't do itself: "From YouTube" import.
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK (the Linux webview) hides SharedArrayBuffer from web content even on a cross-origin
    // isolated page, so ONNX Runtime silently falls back to one WASM thread and separation runs on a
    // single core. JavaScriptCore has an option that exposes it; it is read when the web process
    // starts, so it must be set before the webview is created. A value set by the user wins.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("JSC_useSharedArrayBuffer").is_none() {
            std::env::set_var("JSC_useSharedArrayBuffer", "true");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![ytdlp::ytdlp_search, ytdlp::ytdlp_download, ytdlp::ytdlp_cleanup])
        .run(tauri::generate_context!())
        .expect("error while running Steminize");
}
