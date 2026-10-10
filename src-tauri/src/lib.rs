// The desktop app is a thin native shell around the same web app:
// separation runs in the webview (WebGPU where available, otherwise CPU/WASM).
// The two plugins provide native "Save as" / folder dialogs and file writing.
// The ytdlp module adds the one thing a browser tab can't do itself: "From YouTube" import.
mod engine;
mod library;
mod links;
mod native_audio;
mod native_input;
mod native_playback;
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
    // A GTK_OVERLAY_SCROLLING=0 env var was tried here to stop GTK's auto-hiding overlay scrollbar
    // from floating over content at a pane's edge. It did — by switching to a real native GTK
    // scrollbar widget — but that widget's width comes from the GTK theme, ignores this app's CSS
    // entirely, and turned out much wider than intended, leaving a large dead gap next to it instead
    // (measured ~24px against a `::-webkit-scrollbar` width of 10px). Reverted: see the dedicated
    // padding on .side/.stage in styles.css instead, which gives the (thin, overlay) scrollbar room
    // to float without touching content — plain CSS, so it's actually verifiable and portable.

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
        .invoke_handler(tauri::generate_handler![ytdlp::ytdlp_search, ytdlp::ytdlp_download, ytdlp::ytdlp_read, ytdlp::ytdlp_cleanup, links::open_link,
            library::lib_list, library::lib_write_meta, library::lib_write_file, library::lib_read_file,
            library::lib_list_files, library::lib_remove_file, library::lib_delete, library::lib_free_space,
            native_audio::native_audio_devices, native_audio::native_monitor_start, native_audio::native_monitor_stop, native_audio::native_monitor_stats, native_audio::native_loopback,
            native_playback::native_engine_start, native_playback::native_engine_stop, native_playback::native_engine_load, native_playback::native_engine_play,
            native_playback::native_engine_pause, native_playback::native_engine_seek, native_playback::native_engine_loop, native_playback::native_engine_tempo,
            native_playback::native_engine_gains, native_playback::native_engine_practice, native_playback::native_engine_rate,
            native_playback::native_engine_track, native_playback::native_engine_volume,
            native_playback::native_input_start, native_playback::native_input_stop, native_playback::native_input_set, native_playback::native_input_snapshot,
            native_playback::native_record_start, native_playback::native_record_stop])
        .run(tauri::generate_context!())
        .expect("error while running Steminize");
}
