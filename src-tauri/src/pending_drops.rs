use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use walkdir::WalkDir;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::fsbrowse::{self, FileKind, MAX_WALK_ENTRIES};
use crate::state::AppStateHandle;

/// Waiting list for files dropped onto the always-on-top mini window.
///
/// Deliberately its own database in the app config dir rather than a table
/// in the active project's `cronostream.db`: the mini window is reachable
/// from the tray at any time, including when no project is open at all, so
/// there may be no project database to write to when a drop happens. The
/// WAL/synchronous setup mirrors `preview_cache` (same reasoning: a small
/// sidecar DB that several windows touch).
///
/// A real newtype, not a `type X = Mutex<Connection>` alias: Tauri's
/// `app.manage()` keys state by the concrete Rust type, and `manage()` is
/// first-wins (a later call for an already-managed type is silently a
/// no-op, returning `false`). `preview_cache::PreviewCacheHandle` is also a
/// bare `Mutex<Connection>` alias, so without this wrapper both handles
/// would collide on the exact same type and every `State<PendingDropsHandle>`
/// would silently resolve to the *preview cache's* connection instead,
/// producing "no such table: pending_drops" against the wrong database.
pub struct PendingDropsHandle(pub Mutex<Connection>);

/// Emitted to *all* windows whenever the waiting list changes, so the mini
/// window and the main app's badge stay in sync without polling.
pub const CHANGED_EVENT: &str = "pending-drops-changed";

pub fn open(app_config_dir: &Path) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_config_dir).ok();
    let conn = Connection::open(app_config_dir.join("pending_drops.sqlite"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         CREATE TABLE IF NOT EXISTS pending_drops (
             path TEXT PRIMARY KEY,
             added_at TEXT NOT NULL
         );
         -- Files sent to one specific stream (\"in anderen stream
         -- einfügen\"). Kept apart from `pending_drops` because those are
         -- offered to whichever project happens to be open, while these wait
         -- for one particular project and are only offered once it is opened.
         CREATE TABLE IF NOT EXISTS project_pending_drops (
             project_path TEXT NOT NULL,
             path TEXT NOT NULL,
             added_at TEXT NOT NULL,
             PRIMARY KEY (project_path, path)
         );",
    )?;
    crate::watch_folder::init_schema(&conn)?;
    Ok(conn)
}

#[derive(Serialize)]
pub struct PendingDropInfo {
    pub path: String,
    pub file_name: String,
    /// Computed live from the path via `fsbrowse::classify` instead of being
    /// stored — the classification rules live in one place and a widened
    /// extension list applies to already-waiting drops too.
    pub kind: FileKind,
    pub can_add: bool,
    /// Whether the file is still on disk. Checked on every listing so a
    /// file moved or deleted after being dropped shows up as such in the
    /// UI instead of silently failing the import later.
    pub exists: bool,
}

/// Recursively collects every regular file under `dir` into `out`, skipping
/// hidden entries (dotfiles/dot-folders) exactly like `fsbrowse::list_dir`
/// does for the interactive browser — a dropped folder's `.git` or similar
/// shouldn't flood the waiting list.
///
/// Bounded the same way the disk search is: it never leaves the dropped
/// folder's filesystem (a mount point inside it is not walked into), never
/// follows symlinks, and gives up past `MAX_WALK_ENTRIES` entries. Dropping
/// a home folder or a whole drive by accident used to walk all of it — the
/// pattern behind the crash and filesystem damage of 13.10.2026.
fn collect_files_recursive(dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let walk = WalkDir::new(dir)
        .min_depth(1)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'));
    for (seen, entry) in walk.enumerate() {
        if seen >= MAX_WALK_ENTRIES {
            return Err(crate::trf!(
                "„{path}“ enthält mit allen Unterordnern mehr als {MAX_WALK_ENTRIES} Einträge — das ist zu viel für die Ablage. Bitte einen kleineren Ordner ablegen.",
                path = dir.display(),
                MAX_WALK_ENTRIES = MAX_WALK_ENTRIES
            ));
        }
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_file() {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    Ok(())
}

fn normalize_project_path(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).to_string()
}

fn current_project_key(state: &State<AppStateHandle>) -> Option<String> {
    let guard = state.lock().ok()?;
    let key = guard
        .current_project
        .as_ref()
        .map(|c| normalize_project_path(&c.path.to_string_lossy()));
    key
}

/// Recent streams other than the one currently open — the targets
/// offered by "in anderen Stream einfügen".
#[tauri::command(async)]
pub fn list_other_projects(
    app: AppHandle,
    state: State<AppStateHandle>,
) -> Vec<crate::recent::RecentProjectEntry> {
    let current = current_project_key(&state);
    crate::recent::load_recent(&app)
        .into_iter()
        .filter(|e| Some(normalize_project_path(&e.path)) != current)
        .collect()
}

/// Puts files on the waiting list of one specific stream. Returns how
/// many were newly queued (already-queued paths are ignored).
#[tauri::command(async)]
pub fn add_pending_drops_to_project(
    app: AppHandle,
    state: State<PendingDropsHandle>,
    project_path: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let key = normalize_project_path(&project_path);
    let now = chrono::Utc::now().to_rfc3339();
    let mut inserted = 0usize;
    for path in paths {
        if !PathBuf::from(&path).is_file() {
            continue;
        }
        inserted += conn
            .execute(
                "INSERT OR IGNORE INTO project_pending_drops (project_path, path, added_at) VALUES (?1, ?2, ?3)",
                params![key, path, now],
            )
            .map_err(|e| e.to_string())?;
    }
    if inserted > 0 {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(inserted)
}

#[tauri::command(async)]
pub fn add_pending_drops(
    app: AppHandle,
    state: State<PendingDropsHandle>,
    paths: Vec<String>,
) -> Result<usize, String> {
    // UTC like every other timestamp written to a database here
    // (`items`, `recent`) — `added_at` is only used for stable ordering,
    // and UTC RFC3339 strings sort correctly as text.
    let now = chrono::Utc::now().to_rfc3339();
    // A dropped folder is expanded into its files up front, so the dedupe
    // loop below never has to distinguish folders from files — it only
    // ever sees real file paths, same as a plain multi-file drop. Before
    // the lock, so a large folder doesn't hold up the drop list meanwhile.
    let mut expanded = Vec::new();
    for path in paths {
        let path_buf = PathBuf::from(&path);
        if path_buf.is_dir() {
            collect_files_recursive(&path_buf, &mut expanded)?;
        } else if path_buf.is_file() {
            expanded.push(path);
        }
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    // One transaction: thousands of single-statement commits are one disk
    // flush each.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut inserted = 0usize;
    for path in expanded {
        // `OR IGNORE` on the primary key *is* the dedupe against paths that
        // are already waiting — no separate lookup needed.
        let changed = tx
            .execute(
                "INSERT OR IGNORE INTO pending_drops (path, added_at) VALUES (?1, ?2)",
                params![path, now],
            )
            .map_err(|e| e.to_string())?;
        inserted += changed;
    }
    tx.commit().map_err(|e| e.to_string())?;
    if inserted > 0 {
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(inserted)
}

#[tauri::command(async)]
pub fn list_pending_drops(
    state: State<PendingDropsHandle>,
    app_state: State<AppStateHandle>,
    include_project: Option<bool>,
) -> Result<Vec<PendingDropInfo>, String> {
    let project_key = if include_project.unwrap_or(false) {
        current_project_key(&app_state)
    } else {
        None
    };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut paths: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT path FROM pending_drops ORDER BY added_at ASC, rowid ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            paths.push(row.map_err(|e| e.to_string())?);
        }
    }
    if let Some(key) = project_key {
        let mut stmt = conn
            .prepare("SELECT path FROM project_pending_drops WHERE project_path = ?1 ORDER BY added_at ASC, rowid ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let path = row.map_err(|e| e.to_string())?;
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }

    let mut out = Vec::new();
    for path in paths {
        let path_buf = PathBuf::from(&path);
        let kind = fsbrowse::classify(&path_buf);
        out.push(PendingDropInfo {
            file_name: path_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone()),
            can_add: fsbrowse::can_add(&path_buf, kind),
            exists: path_buf.is_file(),
            kind,
            path,
        });
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn remove_pending_drop(
    app: AppHandle,
    state: State<PendingDropsHandle>,
    app_state: State<AppStateHandle>,
    path: String,
) -> Result<(), String> {
    let project_key = current_project_key(&app_state);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM pending_drops WHERE path = ?1", params![path])
        .map_err(|e| e.to_string())?;
    if let Some(key) = project_key {
        conn.execute(
            "DELETE FROM project_pending_drops WHERE project_path = ?1 AND path = ?2",
            params![key, path],
        )
        .map_err(|e| e.to_string())?;
    }
    discard_unreferenced(&app, &conn, std::slice::from_ref(&path));
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Whether any waiting list (the general one or a stream's) still holds
/// `path`.
fn is_referenced(conn: &Connection, path: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pending_drops WHERE path = ?1)
             OR EXISTS(SELECT 1 FROM project_pending_drops WHERE path = ?1)",
        params![path],
        |row| row.get::<_, bool>(0),
    )
    // When in doubt, keep the file.
    .unwrap_or(true)
}

/// Deletes the lasting copies (`dropped_files.rs`) of mails that no list
/// waits for any more — after an import (the project has its own copy by
/// then) or a removal. The user's own files are never touched.
fn discard_unreferenced(app: &AppHandle, conn: &Connection, paths: &[String]) {
    let Some(store) = crate::dropped_files::store_dir(app) else { return };
    for path in paths {
        let file = Path::new(path);
        if crate::dropped_files::is_in_store(&store, file) && !is_referenced(conn, path) {
            crate::dropped_files::discard(&store, file);
        }
    }
}

/// At startup: clears lasting copies left over from earlier runs that no
/// list refers to (diary attachments are copied into the stream on saving,
/// so theirs are no longer needed; or the app ended in between).
pub fn sweep_dropped_files(app: &AppHandle) {
    let Some(store) = crate::dropped_files::store_dir(app) else { return };
    let referenced = {
        let Some(state) = app.try_state::<PendingDropsHandle>() else { return };
        let Ok(conn) = state.0.lock() else { return };
        let mut referenced = std::collections::HashSet::new();
        for table in ["pending_drops", "project_pending_drops"] {
            let Ok(mut stmt) = conn.prepare(&format!("SELECT path FROM {table}")) else { return };
            let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else { return };
            for row in rows {
                // A row that can't be read might be one of the stored
                // files: better to sweep nothing this time.
                let Ok(path) = row else { return };
                referenced.insert(PathBuf::from(path));
            }
        }
        referenced
    };
    crate::dropped_files::sweep(&store, &referenced, crate::dropped_files::SWEEP_MIN_AGE);
}

/// Batch form of `remove_pending_drop` for after an import: one
/// transaction and a single change event, instead of one event per path —
/// each event makes every listening window reload the whole drop list.
#[tauri::command(async)]
pub fn remove_pending_drops(
    app: AppHandle,
    state: State<PendingDropsHandle>,
    app_state: State<AppStateHandle>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let project_key = current_project_key(&app_state);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for path in &paths {
        tx.execute("DELETE FROM pending_drops WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;
        if let Some(key) = &project_key {
            tx.execute(
                "DELETE FROM project_pending_drops WHERE project_path = ?1 AND path = ?2",
                params![key, path],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    discard_unreferenced(&app, &conn, &paths);
    drop(conn);
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dropped_folder_yields_its_visible_files_only() {
        let dir = std::env::temp_dir().join(format!("cronostream-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.join("sub/b.jpg"), b"x").unwrap();
        std::fs::write(dir.join(".git/config"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.jpg"), b"x").unwrap();

        let mut found = Vec::new();
        collect_files_recursive(&dir, &mut found).unwrap();
        found.sort();
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].ends_with("a.jpg") && found[1].ends_with("b.jpg"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
