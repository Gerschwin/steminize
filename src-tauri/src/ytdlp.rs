// "From YouTube" import: search + download an audio-only stream via a standalone yt-dlp
// binary, fetched once and cached. Desktop-only (there's no way for a browser tab to do
// this), which is why this lives in the Tauri shell rather than the web app.
//
// No ffmpeg involved anywhere here: we ask yt-dlp for an audio-only format and hand the
// file straight to the app, which already decodes whatever the browser can (m4a/webm/opus).
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(serde::Serialize, Clone)]
pub struct YtResult {
    id: String,
    title: String,
    uploader: String,
    duration: Option<f64>, // seconds
    thumbnail: Option<String>,
}

#[cfg(target_os = "windows")]
const YTDLP_ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET: &str = "yt-dlp_macos";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const YTDLP_ASSET: &str = "yt-dlp_linux";
#[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
const YTDLP_ASSET: &str = "yt-dlp"; // generic build; needs a system python3 on non-x64 Linux

fn local_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// Downloads the standalone yt-dlp binary into the app's cache dir the first time it's
/// needed, then reuses it. Doesn't auto-update after that; if YouTube breaks the cached
/// version, deleting the cached binary (or a future "update yt-dlp" action) re-fetches it.
async fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("ytdlp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let path = dir.join(local_name());
    if path.exists() {
        return Ok(path);
    }
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{YTDLP_ASSET}");
    let resp = reqwest::get(&url).await.map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Couldn't download yt-dlp: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{}-{nanos}", std::process::id())
}

/// Pulls the trailing "NN.N" out of a yt-dlp `--newline` progress line like
/// `[download]  42.0% of ~3.45MiB at 1.20MiB/s ETA 00:02`, as a 0-1 fraction.
fn parse_progress(line: &str) -> Option<f64> {
    if !line.starts_with("[download]") {
        return None;
    }
    let pct = line.find('%')?;
    let start = line[..pct].rfind(|c: char| !c.is_ascii_digit() && c != '.')? + 1;
    line[start..pct].trim().parse::<f64>().ok().map(|p| (p / 100.0).clamp(0.0, 1.0))
}

#[tauri::command]
pub async fn ytdlp_search(app: AppHandle, query: String) -> Result<Vec<YtResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let bin = ensure_ytdlp(&app).await?;
    let search_arg = format!("ytsearch8:{query}");
    let args: [&str; 4] = ["--no-warnings", "--flat-playlist", "--dump-json", &search_arg];
    let output = Command::new(&bin)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let last = err.lines().last().unwrap_or("search failed");
        return Err(format!("YouTube search failed: {last}"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("Untitled").to_string();
        let uploader = v
            .get("channel")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("uploader").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        let duration = v.get("duration").and_then(|x| x.as_f64());
        let thumbnail = v
            .get("thumbnails")
            .and_then(|x| x.as_array())
            .and_then(|a| a.last())
            .and_then(|t| t.get("url"))
            .and_then(|u| u.as_str())
            .or_else(|| v.get("thumbnail").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        results.push(YtResult { id, title, uploader, duration, thumbnail });
    }
    Ok(results)
}

/// Downloads the best audio-only stream for one video into a fresh temp dir and returns its
/// path. Emits `ytdlp-progress` (0-1) on the given `id` as it goes. The caller reads the file
/// and should call `ytdlp_cleanup` with the returned path afterwards.
#[tauri::command]
pub async fn ytdlp_download(app: AppHandle, id: String) -> Result<String, String> {
    let bin = ensure_ytdlp(&app).await?;
    let base = std::env::temp_dir().join(format!("steminize-yt-{}", unique_suffix()));
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let out_arg = base.join("track.%(ext)s").to_string_lossy().into_owned();
    let url = format!("https://www.youtube.com/watch?v={id}");
    let args: [&str; 8] = [
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "-o",
        &out_arg,
        "--newline",
        "--no-playlist",
        "--no-warnings",
        &url,
    ];

    let mut child = Command::new(&bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let progress_app = app.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(frac) = parse_progress(&line) {
                let _ = progress_app.emit("ytdlp-progress", frac);
            }
        }
    });
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = out_task.await;
    let stderr_text = err_task.await.unwrap_or_default();

    if !status.success() {
        let _ = std::fs::remove_dir_all(&base);
        let last = stderr_text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("download failed");
        return Err(format!("YouTube download failed: {last}"));
    }
    let file = std::fs::read_dir(&base)
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("yt-dlp finished but produced no file")?
        .map_err(|e| e.to_string())?;
    Ok(file.path().to_string_lossy().to_string())
}

/// Removes a temp dir this module created (guarded by its own naming prefix, so this can
/// only ever clean up its own downloads, not an arbitrary path).
#[tauri::command]
pub fn ytdlp_cleanup(path: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let is_ours = parent.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("steminize-yt-"));
        if is_ours {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
    Ok(())
}
