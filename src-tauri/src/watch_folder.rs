use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::fsbrowse::MAX_WALK_ENTRIES;
use crate::pending_drops::{PendingDropsHandle, CHANGED_EVENT};

/// The watched folder: files that newly appear in it are put on the waiting
/// list of the drop box automatically.
///
/// Runs as a plain polling thread rather than on file system events. The
/// folder is typically fed by a sync tool or a scanner and may sit on an
/// NTFS or network drive, where events are unreliable; and polling gives the
/// two things this needs anyway for free: catching up on what arrived while
/// the app was not running, and waiting until a file has stopped growing
/// before it is picked up. The thread lives in whichever process is running
/// (the single-instance plugin guarantees there is only one), so it works
/// with only the drop box circle open and no main window.
const CONFIG_FILE: &str = "watch_folder.json";

/// Pause between two scans. Stretched when a scan itself takes long, so a
/// huge folder never keeps a core busy.
const SCAN_INTERVAL: Duration = Duration::from_secs(5);

/// Written by the sync tools and browsers while a file is still incomplete or
/// by editors as scratch files — never a finished file worth picking up.
const TEMP_EXTENSIONS: &[&str] = &[
    "part", "partial", "tmp", "temp", "crdownload", "download", "swp", "lock", "lck", "bak~",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Config {
    path: Option<String>,
    #[serde(default = "default_recursive")]
    recursive: bool,
}

fn default_recursive() -> bool {
    true
}

#[derive(Serialize)]
pub struct WatchFolderStatus {
    pub path: Option<String>,
    pub recursive: bool,
    /// Whether the folder is currently reachable (an unplugged drive is not).
    pub exists: bool,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CONFIG_FILE))
}

/// Never fails: a missing or broken file means "no folder chosen".
fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app).ok_or_else(|| "config dir".to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::safe_io::write_durably(&path, contents).map_err(|e| e.to_string())
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "-- What has already been handed to the waiting list, with the size and
         -- change time it had then. Removing a file from the drop box must not
         -- bring it back on the next scan, but a file that is replaced by a
         -- changed one is new again.
         CREATE TABLE IF NOT EXISTS watch_folder_seen (
             path TEXT PRIMARY KEY,
             size INTEGER NOT NULL,
             mtime INTEGER NOT NULL
         );",
    )
}

fn is_temporary(name: &str) -> bool {
    if name.starts_with("~$") || name.ends_with('~') {
        return true;
    }
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| TEMP_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every candidate file in the folder with its size and change time (whole
/// seconds). Hidden entries, scratch files and anything outside the folder's
/// filesystem are left out; symlinks are not followed.
fn list_files(folder: &Path, recursive: bool) -> Result<Vec<(String, u64, i64)>, ()> {
    let mut walk = WalkDir::new(folder).min_depth(1).same_file_system(true);
    if !recursive {
        walk = walk.max_depth(1);
    }
    let mut out = Vec::new();
    let walk = walk
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
    for (seen, entry) in walk.enumerate() {
        if seen >= MAX_WALK_ENTRIES {
            return Err(());
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() || is_temporary(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push((entry.path().to_string_lossy().to_string(), meta.len(), mtime));
    }
    Ok(out)
}

/// One pass. `observed` holds what the previous pass saw of files that were
/// new then: a file is only picked up once it looks the same in two passes
/// in a row, i.e. is no longer being written. Returns how many files were put
/// on the waiting list.
fn scan_once(
    conn: &mut Connection,
    folder: &Path,
    recursive: bool,
    observed: &mut HashMap<String, (u64, i64)>,
) -> usize {
    let Ok(files) = list_files(folder, recursive) else {
        return 0;
    };
    let now = chrono::Utc::now().to_rfc3339();
    let Ok(tx) = conn.transaction() else { return 0 };
    let mut next_observed = HashMap::new();
    let mut added = 0usize;
    for (path, size, mtime) in files {
        let known: Option<(i64, i64)> = tx
            .query_row(
                "SELECT size, mtime FROM watch_folder_seen WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if known == Some((size as i64, mtime)) {
            continue;
        }
        if observed.get(&path) != Some(&(size, mtime)) {
            next_observed.insert(path, (size, mtime));
            continue;
        }
        let queued = tx.execute(
            "INSERT OR IGNORE INTO pending_drops (path, added_at) VALUES (?1, ?2)",
            params![path, now],
        );
        let marked = tx.execute(
            "INSERT OR REPLACE INTO watch_folder_seen (path, size, mtime) VALUES (?1, ?2, ?3)",
            params![path, size as i64, mtime],
        );
        if let (Ok(queued), Ok(_)) = (queued, marked) {
            added += queued;
        }
    }
    if tx.commit().is_err() {
        return 0;
    }
    *observed = next_observed;
    added
}

/// Starts the background thread. Cheap while no folder is chosen: it only
/// reads the small config file every few seconds, so choosing or clearing a
/// folder takes effect without a restart.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut observed: HashMap<String, (u64, i64)> = HashMap::new();
        let mut pause = SCAN_INTERVAL;
        loop {
            std::thread::sleep(pause);
            pause = SCAN_INTERVAL;
            let config = load_config(&app);
            let Some(path) = config.path.as_deref().map(PathBuf::from) else {
                observed.clear();
                continue;
            };
            if !path.is_dir() {
                observed.clear();
                continue;
            }
            let started = Instant::now();
            let added = {
                let handle = app.state::<PendingDropsHandle>();
                let Ok(mut conn) = handle.0.lock() else { continue };
                scan_once(&mut conn, &path, config.recursive, &mut observed)
            };
            if added > 0 {
                let _ = app.emit(CHANGED_EVENT, ());
            }
            pause = pause.max(started.elapsed() * 10);
        }
    });
}

#[tauri::command(async)]
pub fn get_watch_folder(app: AppHandle) -> WatchFolderStatus {
    let config = load_config(&app);
    let exists = config.path.as_deref().map(|p| Path::new(p).is_dir()).unwrap_or(false);
    WatchFolderStatus {
        path: config.path,
        recursive: config.recursive,
        exists,
    }
}

/// Chooses (or with `path: None` clears) the watched folder. What is in the
/// folder at this moment is not queued — only files arriving afterwards are —
/// so it is recorded as already seen. Choosing a download folder must not
/// flood the drop box with its whole history.
#[tauri::command(async)]
pub fn set_watch_folder(
    app: AppHandle,
    state: tauri::State<PendingDropsHandle>,
    path: Option<String>,
    recursive: bool,
) -> Result<WatchFolderStatus, String> {
    let folder = path.as_deref().filter(|p| !p.is_empty()).map(PathBuf::from);
    let mut baseline = Vec::new();
    if let Some(folder) = &folder {
        if !folder.is_dir() {
            return Err(crate::trf!("„{path}“ ist kein Ordner.", path = folder.display()));
        }
        baseline = list_files(folder, recursive).map_err(|_| {
            crate::trf!(
                "„{path}“ enthält mit allen Unterordnern zu viele Einträge, um überwacht zu werden.",
                path = folder.display()
            )
        })?;
    }
    {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM watch_folder_seen", []).map_err(|e| e.to_string())?;
        for (file, size, mtime) in baseline {
            tx.execute(
                "INSERT OR REPLACE INTO watch_folder_seen (path, size, mtime) VALUES (?1, ?2, ?3)",
                params![file, size as i64, mtime],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    save_config(
        &app,
        &Config {
            path: folder.map(|f| f.to_string_lossy().to_string()),
            recursive,
        },
    )?;
    Ok(get_watch_folder(app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn scratch_files_are_recognised() {
        assert!(is_temporary("foto.jpg.part"));
        assert!(is_temporary("Video.CRDOWNLOAD"));
        assert!(is_temporary("~$Brief.docx"));
        assert!(is_temporary("notiz.txt~"));
        assert!(!is_temporary("foto.jpg"));
        assert!(!is_temporary("Bericht.pdf"));
    }

    #[test]
    fn a_file_is_picked_up_only_when_unchanged_between_two_scans() {
        let dir = std::env::temp_dir().join(format!("cronostream-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.join("sub/b.jpg"), b"x").unwrap();
        std::fs::write(dir.join("c.jpg.part"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.jpg"), b"x").unwrap();

        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE pending_drops (path TEXT PRIMARY KEY, added_at TEXT NOT NULL);").unwrap();
        init_schema(&conn).unwrap();
        let mut observed = HashMap::new();

        assert_eq!(scan_once(&mut conn, &dir, true, &mut observed), 0, "first sight only observes");
        assert_eq!(scan_once(&mut conn, &dir, true, &mut observed), 2);
        assert_eq!(scan_once(&mut conn, &dir, true, &mut observed), 0, "nothing new");

        // Taken off the waiting list again: must not come back.
        conn.execute("DELETE FROM pending_drops", []).unwrap();
        assert_eq!(scan_once(&mut conn, &dir, true, &mut observed), 0);
        assert_eq!(scan_once(&mut conn, &dir, true, &mut observed), 0);

        // Not recursive: the subfolder is ignored.
        let paths: HashSet<_> = list_files(&dir, false).unwrap().into_iter().map(|f| f.0).collect();
        assert_eq!(paths.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
