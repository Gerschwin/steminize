// The desktop app is a thin native shell around the same web app:
// separation runs in the webview (WebGPU where available, otherwise CPU/WASM).
// The two plugins provide native "Save as" / folder dialogs and file writing.
// The ytdlp module adds the one thing a browser tab can't do itself: "From YouTube" import.
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![ytdlp::ytdlp_search, ytdlp::ytdlp_download, ytdlp::ytdlp_cleanup])
        .run(tauri::generate_context!())
        .expect("error while running Steminize");
}
