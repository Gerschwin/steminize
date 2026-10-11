// In-app updates. The webview finds out which release is newest (the About dialog already asks GitHub), then asks this module to fetch
// that release's `latest.json`, check the update's signature against the public key built into the app, download it and install it.
// An update that was not signed with the project's private key is refused, whatever the address says, but the address is also
// limited to this project's own release downloads so the app can't be pointed anywhere else.
//
// Only some installs can update themselves: Windows and macOS always; on Linux only the AppImage (a .deb or .rpm is owned by the
// system's package manager, so the About dialog sends those people to the releases page instead).

use std::sync::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASE_PREFIX: &str = "https://github.com/Gerschwin/steminize/releases/download/";

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
}

/// True for an address inside this project's release downloads, ending in latest.json, with nothing odd in it.
fn allowed_endpoint(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(RELEASE_PREFIX) else { return false };
    let mut parts = rest.split('/');
    let (Some(tag), Some(file), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    file == "latest.json" && tag.starts_with('v') && tag.len() <= 32 && tag[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Whether this install can replace itself.
#[tauri::command]
pub fn update_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Fetches `endpoint` (a release's latest.json) and keeps the update it describes if it is newer than this app.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Pending>, endpoint: String) -> Result<Option<UpdateInfo>, String> {
    if !allowed_endpoint(&endpoint) {
        return Err("that isn't an address Steminize updates from".into());
    }
    let url = endpoint.parse().map_err(|e| format!("bad address: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo { version: update.version.clone() };
            *state.0.lock().map_err(|_| "update state is locked")? = Some(update);
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Downloads and installs the update found by `update_check`, reporting progress, then restarts the app.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, Pending>) -> Result<(), String> {
    let update = state.0.lock().map_err(|_| "update state is locked")?.take().ok_or("no update has been checked")?;
    let mut got: u64 = 0;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                got += chunk as u64;
                let _ = progress_app.emit("update-progress", (got, total.unwrap_or(0)));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::allowed_endpoint;

    #[test]
    fn only_this_projects_release_json_is_allowed() {
        assert!(allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/v0.9.5/latest.json"));
        assert!(allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/v1.0.0/latest.json"));
        assert!(!allowed_endpoint("https://github.com/evil/steminize/releases/download/v0.9.5/latest.json"));
        assert!(!allowed_endpoint("http://github.com/Gerschwin/steminize/releases/download/v0.9.5/latest.json"));
        assert!(!allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/v0.9.5/other.json"));
        assert!(!allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/v0.9.5/x/latest.json"));
        assert!(!allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/../latest.json"));
        assert!(!allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/v0.9.5/latest.json?x=1"));
        assert!(!allowed_endpoint("https://github.com/Gerschwin/steminize/releases/download/untagged-abc/latest.json"));
        assert!(!allowed_endpoint("https://github.com.evil.com/Gerschwin/steminize/releases/download/v0.9.5/latest.json"));
    }
}
