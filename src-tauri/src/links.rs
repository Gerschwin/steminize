// Opens a link in the user's default browser. A Tauri webview doesn't do this for `target="_blank"`
// links by itself, so the About dialog, the Models "browse" link and the lyrics search would all be
// dead in the desktop app. The webview asks through this command instead, and only https links to
// the sites the app itself links to are honoured, so a page can't use it to launch anything else.

const ALLOWED_HOSTS: &[&str] = &["github.com", "huggingface.co", "onnxruntime.ai", "tauri.app", "genius.com"];

fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !url.chars().any(|c| c.is_control() || c.is_whitespace()) && ALLOWED_HOSTS.contains(&host)
}

#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err("that link isn't one Steminize opens".into());
    }
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        let mut child = cmd.arg(&url).spawn().map_err(|e| format!("couldn't open the browser: {e}"))?;
        // Reap the launcher so it doesn't linger as a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("opening links isn't supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn allows_only_https_links_to_known_hosts() {
        assert!(allowed("https://github.com/Gerschwin/steminize/releases"));
        assert!(allowed("https://genius.com/search?q=some%20song"));
        assert!(allowed("https://huggingface.co/StemSplitio/htdemucs-onnx"));
        assert!(!allowed("http://github.com/x"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("https://evil.example/https://github.com"));
        assert!(!allowed("https://github.com.evil.example/x"));
        assert!(!allowed("https://user@github.com/x"));
        assert!(!allowed("https://github.com/a b"));
        assert!(!allowed("https://github.com/a\nb"));
        assert!(!allowed("javascript:alert(1)"));
    }
}
