//! The two search histories: the in-app search's, kept per stream in the
//! stream's own database (`search_history` table), and the disk search's,
//! kept once for the whole app in a JSON file in the config folder.
//!
//! An entry is an opaque JSON string the frontend builds from one search
//! (text plus every filter it restores). The backend never looks inside: it
//! only keeps the newest `MAX_ENTRIES` distinct strings, newest first. The
//! frontend writes the JSON with a fixed key order, so repeating the same
//! search yields the same string and only moves it back to the top.
//!
//! Not part of the action log: a history entry is a convenience, not
//! content, and undoing one would make no sense.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager, State};

use crate::state::AppStateHandle;

pub const MAX_ENTRIES: usize = 50;

const DISK_FILENAME: &str = "disk_search_history.json";

/// Serializes read-modify-write of the JSON file: two quick searches in a
/// row must not both read the old list and have the second write drop the
/// first one's entry.
static DISK_LOCK: Mutex<()> = Mutex::new(());

/// Where a history lives. Anything else from the frontend is a bug.
enum Scope {
    Stream,
    Disk,
}

fn scope(name: &str) -> Result<Scope, String> {
    match name {
        "stream" => Ok(Scope::Stream),
        "disk" => Ok(Scope::Disk),
        other => Err(format!("unknown search history scope: {other}")),
    }
}

/// Moves `payload` to the front of `list` (adding it if new) and cuts the
/// list to `MAX_ENTRIES`.
fn bump(list: &mut Vec<String>, payload: &str) {
    list.retain(|p| p != payload);
    list.insert(0, payload.to_string());
    list.truncate(MAX_ENTRIES);
}

// --- stream (project database) --------------------------------------------

fn stream_list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT payload FROM search_history ORDER BY used_at DESC, rowid DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![MAX_ENTRIES as i64], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn stream_add(conn: &Connection, payload: &str) -> Result<(), String> {
    // Nanosecond precision so two entries added within the same second
    // still sort in the order they were made.
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    conn.execute(
        "INSERT INTO search_history (payload, used_at) VALUES (?1, ?2)
         ON CONFLICT(payload) DO UPDATE SET used_at = excluded.used_at",
        params![payload, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM search_history WHERE payload NOT IN (
             SELECT payload FROM search_history ORDER BY used_at DESC, rowid DESC LIMIT ?1
         )",
        params![MAX_ENTRIES as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// --- disk (app config folder) ---------------------------------------------

fn disk_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht ermitteln: {e}", e = e))?;
    fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht anlegen: {e}", e = e))?;
    Ok(dir.join(DISK_FILENAME))
}

/// A missing or unreadable file is simply an empty history.
fn disk_load(app: &AppHandle) -> Vec<String> {
    let Ok(path) = disk_path(app) else { return Vec::new() };
    let Ok(contents) = fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn disk_save(app: &AppHandle, list: &[String]) -> Result<(), String> {
    let path = disk_path(app)?;
    let contents = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    crate::safe_io::write_durably(&path, contents).map_err(|e| e.to_string())
}

fn disk_update(app: &AppHandle, f: impl FnOnce(&mut Vec<String>)) -> Result<(), String> {
    let _guard = DISK_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut list = disk_load(app);
    f(&mut list);
    disk_save(app, &list)
}

// --- commands -------------------------------------------------------------

/// Newest first, at most `MAX_ENTRIES`. With no stream open the stream
/// history is just empty rather than an error — the dropdown has nothing to
/// show, which is all that means.
#[tauri::command(async)]
pub fn list_search_history(app: AppHandle, state: State<AppStateHandle>, scope_name: String) -> Result<Vec<String>, String> {
    match scope(&scope_name)? {
        Scope::Stream => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            match guard.current_project.as_ref() {
                Some(current) => stream_list(&current.conn),
                None => Ok(Vec::new()),
            }
        }
        Scope::Disk => {
            let _guard = DISK_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            Ok(disk_load(&app))
        }
    }
}

#[tauri::command(async)]
pub fn add_search_history(app: AppHandle, state: State<AppStateHandle>, scope_name: String, payload: String) -> Result<(), String> {
    if payload.trim().is_empty() {
        return Ok(());
    }
    match scope(&scope_name)? {
        Scope::Stream => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            stream_add(&current.conn, &payload)
        }
        Scope::Disk => disk_update(&app, |list| bump(list, &payload)),
    }
}

#[tauri::command(async)]
pub fn remove_search_history(app: AppHandle, state: State<AppStateHandle>, scope_name: String, payload: String) -> Result<(), String> {
    match scope(&scope_name)? {
        Scope::Stream => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            current
                .conn
                .execute("DELETE FROM search_history WHERE payload = ?1", params![payload])
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Scope::Disk => disk_update(&app, |list| list.retain(|p| p != &payload)),
    }
}

#[tauri::command(async)]
pub fn clear_search_history(app: AppHandle, state: State<AppStateHandle>, scope_name: String) -> Result<(), String> {
    match scope(&scope_name)? {
        Scope::Stream => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            current
                .conn
                .execute("DELETE FROM search_history", [])
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Scope::Disk => disk_update(&app, |list| list.clear()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_moves_repeat_to_front_and_caps() {
        let mut list: Vec<String> = (0..MAX_ENTRIES).map(|i| i.to_string()).collect();
        bump(&mut list, "7");
        assert_eq!(list[0], "7");
        assert_eq!(list.len(), MAX_ENTRIES);
        bump(&mut list, "neu");
        assert_eq!(list[0], "neu");
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list.iter().filter(|p| *p == "7").count(), 1);
    }

    #[test]
    fn stream_add_dedupes_orders_and_caps() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        for i in 0..(MAX_ENTRIES + 5) {
            stream_add(&conn, &format!("q{i}")).unwrap();
        }
        stream_add(&conn, "q10").unwrap();
        let list = stream_list(&conn).unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0], "q10");
        assert_eq!(list[1], format!("q{}", MAX_ENTRIES + 4));
        assert_eq!(list.iter().filter(|p| *p == "q10").count(), 1);
    }
}
