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
        .setup(|_app| {
            // WebKitGTK denies getUserMedia unless the host allows it, which broke the Live input
            // drawer with "The request is not allowed by the user agent". Allow audio capture only.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::glib::prelude::Cast;
                        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
                        let view = webview.inner();
                        if let Some(settings) = WebViewExt::settings(&view) {
                            settings.set_enable_media_stream(true);
                        }
                        view.connect_permission_request(|_, request| {
                            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                                return false; // anything else keeps WebKit's default (deny)
                            };
                            if media.is_for_video_device() {
                                request.deny();
                            } else {
                                request.allow();
                            }
                            true
                        });
                    });
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![ytdlp::ytdlp_search, ytdlp::ytdlp_download, ytdlp::ytdlp_read, ytdlp::ytdlp_cleanup])
        .run(tauri::generate_context!())
        .expect("error while running Steminize");
}
