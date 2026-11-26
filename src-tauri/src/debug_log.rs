use std::path::Path;
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager};

/// Temporary diagnostic aid: persists frontend errors (window.onerror,
/// unhandled promise rejections, React error boundary catches) to a file,
/// since the developer can't always watch the webview's devtools console
/// live. Appends, and rotates at `ROTATE_AT_BYTES`.
#[tauri::command(async)]
pub fn debug_log(app: AppHandle, message: String) {
    append(&app, &message);
}

/// Size at which `debug.log` is moved aside to `debug.log.1` (replacing the
/// previous one) and started afresh, so the log keeps at most twice this.
/// It used to grow for as long as the app was in use.
const ROTATE_AT_BYTES: u64 = 5 * 1024 * 1024;

/// Serializes appends, so a rotation can't happen between another thread's
/// size check and its write.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// The same appender, callable from Rust — used for backend diagnostics that
/// the developer needs to be able to read back after the fact rather than
/// catch live on the dev terminal.
pub fn append(app: &AppHandle, message: &str) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let line = format!("[{}] {}\n", chrono::Local::now().to_rfc3339(), message);
    let _guard = LOG_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    append_to(&dir.join("debug.log"), &line, ROTATE_AT_BYTES);
}

fn append_to(path: &Path, line: &str, rotate_at: u64) {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= rotate_at) {
        let mut previous = path.as_os_str().to_owned();
        previous.push(".1");
        let _ = std::fs::rename(path, previous);
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_log_is_moved_aside_and_started_afresh() {
        let dir = std::env::temp_dir().join(format!("cronostream-debug-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("debug.log");
        append_to(&log, "first\n", 10);
        append_to(&log, "second\n", 10);
        // 13 bytes now, over the limit of 10: the next line starts a new file.
        append_to(&log, "third\n", 10);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "third\n");
        assert_eq!(std::fs::read_to_string(dir.join("debug.log.1")).unwrap(), "first\nsecond\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
