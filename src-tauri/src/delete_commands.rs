//! Deleting a whole stream, and restoring one that was deleted.
//!
//! This is the only code in the app that removes a folder from the user's
//! disk recursively, so the guards come before anything else here. The one
//! that matters most is `ensure_safe_to_delete`: nothing is deleted unless
//! the folder actually *is* a stream (it contains `cronostream.db`),
//! which by itself rules out every "wrong path" accident — a typo, an
//! empty string, a parent folder, the home directory.
//!
//! The second safeguard is disclosure rather than code: the confirmation
//! dialog is fed by `inspect_stream_deletion`, which lists anything in
//! the folder that is *not* part of the stream. Those files get
//! deleted too, so the user has to have seen them first.
//!
//! "Protokoll behalten" keeps the project's database — and only the
//! database — in the app's config folder. That is what makes the deletion
//! reversible: the database still knows every item's name, corrected date,
//! rotation and history, plus where each file originally came from, so the
//! Stream can be rebuilt by re-importing from those sources. The media
//! files themselves are gone, which is the point: they are the gigabytes.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::fsbrowse;
use crate::items;
use crate::lock::{self, LockState, LOCK_FILENAME};
use crate::project::{self, DB_FILENAME};
use crate::recent;
use crate::schema::LIVE_ITEMS;
use crate::settings;
use crate::state::AppStateHandle;

/// Where kept databases of deleted streams live, inside the app config
/// folder. One file per deletion, named by a fresh id.
pub(crate) const DELETED_DIR: &str = "deleted_streams";

/// Written into the kept database so it knows what it is. `project_name` is
/// already there from the project itself.
const DELETED_AT_KEY: &str = "deleted_at";
const DELETED_FROM_KEY: &str = "deleted_from_path";

const RESTORE_PROGRESS_EVENT: &str = "restore-progress";

#[derive(Serialize, Clone)]
struct RestoreProgress {
    done: usize,
    total: usize,
    current: String,
}

/// The files and folders a stream owns. Anything else in the project
/// folder belongs to the user and must be shown before it is deleted.
fn is_own_entry(name: &str) -> bool {
    name == "originals"
        || name == "thumbnails"
        // Diary entries and their attachments.
        || name == "diary"
        || name == LOCK_FILENAME
        || name == lock::LEGACY_LOCK_FILENAME
        // The database under its name and under the one it had before the
        // app was renamed from LifeStream, each with its family:
        || [DB_FILENAME, project::LEGACY_DB_FILENAME].iter().any(|db| {
            name.strip_prefix(db).is_some_and(|rest| {
                // SQLite's write-ahead log and shared-memory sidecars.
                matches!(rest, "" | "-wal" | "-shm")
                    // Copies of the database the app keeps before changing it
                    // wholesale: before adjusting the paths of a moved folder
                    // (`relocation`) and, in a backup, before an update
                    // replaces it (`copy_task`).
                    || rest.starts_with(".vor-pfadanpassung-")
                    || rest == crate::copy_task::PREVIOUS_DATABASE_SUFFIX
            })
        })
}

/// Rejects every path that must not be deleted recursively, and returns the
/// canonical path if it passes.
///
/// `config_dir` and `home_dir` are passed in rather than read from Tauri so
/// this can be tested directly — it is the one function in the app where a
/// mistake costs the user their files.
fn ensure_safe_to_delete(
    path: &Path,
    config_dir: &Path,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    // Resolving symlinks and `..` first means every check below sees the
    // path that would really be deleted, not the spelling it arrived in.
    let path = path
        .canonicalize()
        .map_err(|_| crate::i18n::tr("Dieser Ordner existiert nicht (mehr).").to_string())?;

    if !path.is_dir() {
        return Err(crate::i18n::tr("Das ist kein Ordner.").to_string());
    }

    // The decisive guard: only a folder that really holds a stream can
    // be deleted as one.
    if !project::is_project_folder(&path) {
        return Err(crate::i18n::tr("In diesem Ordner liegt kein Stream.").to_string());
    }

    // Defence in depth, in case a stream was created somewhere it
    // never should have been: a path this shallow is a drive or a
    // top-level system folder, never a project worth deleting blind.
    if path.components().count() < 3 {
        return Err(crate::i18n::tr("Dieser Ordner liegt zu weit oben im Dateisystem, um gelöscht zu werden.").to_string());
    }

    if let Some(home) = home_dir.and_then(|h| h.canonicalize().ok()) {
        if path == home {
            return Err(crate::i18n::tr("Das ist der Benutzerordner und wird nicht gelöscht.").to_string());
        }
    }

    // The kept databases live in the config folder, so deleting it (or
    // anything containing it) would destroy the very thing that makes
    // deletions reversible.
    if let Ok(config) = config_dir.canonicalize() {
        if path == config || config.starts_with(&path) || path.starts_with(&config) {
            return Err(crate::i18n::tr("Dieser Ordner gehört zu CronoStream selbst und wird nicht gelöscht.").to_string());
        }
    }

    Ok(path)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeletionPreview {
    pub path: String,
    pub name: String,
    pub item_count: i64,
    pub size_bytes: u64,
    /// Entries in the project folder that are not part of the stream.
    /// They would be deleted as well, so the dialog shows them by name.
    pub foreign_entries: Vec<String>,
    /// How many items could later be restored from their original source
    /// files, if the database is kept.
    pub restorable_count: i64,
}

/// Everything the confirmation dialog needs to state plainly what is about
/// to be destroyed.
#[tauri::command(async)]
pub fn inspect_stream_deletion(app: AppHandle, path: String) -> Result<DeletionPreview, String> {
    let config_dir = config_dir(&app)?;
    let home = app.path().home_dir().ok();
    let path = ensure_safe_to_delete(Path::new(&path), &config_dir, home.as_deref())?;

    let conn = project::open_project_db(&path)?;
    let name = project::project_info(&conn, &path).name;
    let item_count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM items WHERE {LIVE_ITEMS}"), [], |row| row.get(0))
        .unwrap_or(0);
    let restorable_count = count_restorable(&conn);

    let mut foreign_entries = Vec::new();
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_own_entry(&name) {
                foreign_entries.push(name);
            }
        }
    }
    foreign_entries.sort();

    Ok(DeletionPreview {
        path: path.to_string_lossy().to_string(),
        name,
        item_count,
        size_bytes: folder_size(&path),
        foreign_entries,
        restorable_count,
    })
}

/// Counts the items whose original source file is still where it was when
/// they were imported — the ones a restore could actually bring back.
fn count_restorable(conn: &Connection) -> i64 {
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT source_path FROM items WHERE source_path IS NOT NULL AND {LIVE_ITEMS}"
    )) else {
        return 0;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return 0;
    };
    rows.flatten().filter(|p| Path::new(p).is_file()).count() as i64
}

pub(crate) fn folder_size(path: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += folder_size(&entry.path()),
            Ok(meta) => total += meta.len(),
            Err(_) => {}
        }
    }
    total
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht ermitteln: {e}", e = e))?;
    fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht anlegen: {e}", e = e))?;
    Ok(dir)
}

fn deleted_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join(DELETED_DIR);
    fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Ordner nicht anlegen: {e}", e = e))?;
    Ok(dir)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeletionOutcome {
    pub name: String,
    pub freed_bytes: u64,
    /// Set when the database was kept, so the UI can point at the restore
    /// list.
    pub kept_id: Option<String>,
}

/// Deletes a stream's folder from disk, optionally keeping its database
/// first so the deletion can be undone later.
#[tauri::command(async)]
pub fn delete_stream(
    app: AppHandle,
    state: tauri::State<AppStateHandle>,
    path: String,
    keep_log: bool,
) -> Result<DeletionOutcome, String> {
    let config = config_dir(&app)?;
    let home = app.path().home_dir().ok();
    let path = ensure_safe_to_delete(Path::new(&path), &config, home.as_deref())?;

    {
        let guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(current) = guard.current_project.as_ref() {
            if current.path.canonicalize().map(|p| p == path).unwrap_or(false) {
                return Err(crate::i18n::tr("Dieser Stream ist gerade geöffnet und muss zuerst geschlossen werden.").to_string());
            }
        }
    }

    if let LockState::Active { .. } = lock::check(&path) {
        return Err(
            crate::i18n::tr("Dieser Stream ist gerade in einem anderen Fenster geöffnet und muss dort zuerst geschlossen werden.")
                .to_string(),
        );
    }

    let outcome = perform_deletion(&path, keep_log, &deleted_dir(&app)?)?;
    let _ = recent::remove_recent(&app, &path.to_string_lossy());
    Ok(outcome)
}

/// A stream chosen in the uninstall dialog, deleted with every guard of
/// `delete_stream` but without keeping its database: the app and with it
/// the restore list are about to go as well. The caller closes the stream
/// first if it is the open one.
pub(crate) fn delete_stream_for_uninstall(app: &AppHandle, path: &Path) -> Result<(), String> {
    let config = config_dir(app)?;
    let home = app.path().home_dir().ok();
    let path = ensure_safe_to_delete(path, &config, home.as_deref())?;
    if let LockState::Active { .. } = lock::check(&path) {
        return Err(
            crate::i18n::tr("Dieser Stream ist gerade in einem anderen Fenster geöffnet und muss dort zuerst geschlossen werden.")
                .to_string(),
        );
    }
    perform_deletion(&path, false, &config.join(DELETED_DIR))?;
    let _ = recent::remove_recent(app, &path.to_string_lossy());
    Ok(())
}

/// The deletion itself, once every guard in `ensure_safe_to_delete` has
/// passed and `path` is known to be a canonical stream folder.
///
/// Split out from the command so the whole delete/restore round trip can be
/// tested without a running app — the one behaviour here that must never
/// regress is that nothing is deleted unless the database was safely kept
/// first.
fn perform_deletion(
    path: &Path,
    keep_log: bool,
    kept_dir: &Path,
) -> Result<DeletionOutcome, String> {
    let conn = project::open_project_db(path)?;
    let name = project::project_info(&conn, path).name;
    let freed_bytes = folder_size(path);

    // The database is kept *before* anything is deleted, and the copy is
    // opened and read to prove it survived. A kept database that turns out
    // to be unusable after the media files are gone would be the worst
    // possible outcome of this command, so it is checked while there is
    // still something to lose.
    let kept_id = if keep_log {
        let id = Uuid::new_v4().to_string();
        fs::create_dir_all(kept_dir).map_err(|e| crate::trf!("Konnte Ordner nicht anlegen: {e}", e = e))?;
        let destination = kept_dir.join(format!("{id}.db"));

        settings::set(&conn, DELETED_AT_KEY, &chrono::Utc::now().to_rfc3339())?;
        settings::set(&conn, DELETED_FROM_KEY, &path.to_string_lossy())?;
        // Collapse the write-ahead log into the database file, so copying
        // that one file really carries every last change.
        let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        drop(conn);

        // On the disk before the project folder goes: this copy is all that
        // is left of the stream afterwards.
        crate::safe_io::copy_durably(&project::db_path(path), &destination)
            .map_err(|e| crate::trf!("Konnte das Protokoll nicht sichern: {e}", e = e))?;

        let readable = Connection::open(&destination)
            .and_then(|c| c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0)));
        if readable.is_err() {
            let _ = fs::remove_file(&destination);
            return Err(crate::i18n::tr("Das Protokoll konnte nicht gesichert werden, es wurde nichts gelöscht.").to_string());
        }
        Some(id)
    } else {
        drop(conn);
        None
    };

    fs::remove_dir_all(path).map_err(|e| crate::trf!("Konnte den Ordner nicht löschen: {e}", e = e))?;

    Ok(DeletionOutcome { name, freed_bytes, kept_id })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeletedStream {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: String,
    pub item_count: i64,
    /// Items whose original source file is still in place, i.e. what a
    /// restore would actually bring back right now.
    pub restorable_count: i64,
}

/// The streams that were deleted with their database kept, so they can
/// still be restored.
#[tauri::command(async)]
pub fn list_deleted_streams(app: AppHandle) -> Result<Vec<DeletedStream>, String> {
    let dir = deleted_dir(&app)?;
    let mut out = Vec::new();

    let Ok(entries) = fs::read_dir(&dir) else { return Ok(out) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
        let Ok(conn) = Connection::open(&path) else { continue };

        let item_count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM items WHERE {LIVE_ITEMS}"), [], |row| row.get(0))
            .unwrap_or(0);

        out.push(DeletedStream {
            id,
            name: settings::get(&conn, crate::project::PROJECT_NAME_KEY)
                .ok()
                .flatten()
                .unwrap_or_else(|| "Stream".to_string()),
            original_path: settings::get(&conn, DELETED_FROM_KEY).ok().flatten().unwrap_or_default(),
            deleted_at: settings::get(&conn, DELETED_AT_KEY).ok().flatten().unwrap_or_default(),
            item_count,
            restorable_count: count_restorable(&conn),
        });
    }

    // Newest deletion first.
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub project_path: String,
    pub name: String,
    pub restored: usize,
    /// Restored, but the source file has changed since it was first
    /// imported (different size or modification date).
    pub changed: Vec<String>,
    /// The source file is gone, so there was nothing to bring back. The
    /// item keeps its history but stays off the timeline.
    pub missing: Vec<String>,
}

/// Rebuilds a deleted stream at a new location from its kept database
/// plus the original source files.
///
/// The kept database *becomes* the restored project's database, rather than
/// items being imported into a fresh one. That way every id stays the same,
/// and with them the whole action log, the notes and the print selection —
/// a restored stream is the same stream, not a copy of its
/// contents.
#[tauri::command]
pub async fn restore_stream(
    app: AppHandle,
    id: String,
    parent_path: String,
    name: String,
) -> Result<RestoreReport, String> {
    // Re-importing means copying every file and regenerating every
    // thumbnail (ffmpeg/PDFium included) — far too slow for the IPC
    // thread, same reasoning as `add_items`.
    tauri::async_runtime::spawn_blocking(move || {
        // Checked here for the same reason `discard_deleted_stream`
        // checks it: the id arrives from the frontend and is pasted into a
        // file path, so it has to be a single path segment and nothing else
        // — whatever it is a listing happens to have offered.
        if !is_valid_kept_id(&id) {
            return Err(crate::i18n::tr("Ungültige Kennung.").to_string());
        }
        let kept = deleted_dir(&app)?.join(format!("{id}.db"));
        if !kept.is_file() {
            return Err(crate::i18n::tr("Dieser gelöschte Stream ist nicht mehr vorhanden.").to_string());
        }

        let project_path = project::create_project_in(Path::new(&parent_path), &name)?;

        // From here on a failure would leave a half-built project behind,
        // so anything that goes wrong cleans it up again.
        let app_for_progress = app.clone();
        let result = restore_into(&kept, &project_path, &name, &move |done, total, current| {
            let _ = app_for_progress.emit(
                RESTORE_PROGRESS_EVENT,
                RestoreProgress { done, total, current: current.to_string() },
            );
        });
        match result {
            Ok(report) => {
                let _ = recent::touch_recent(&app, &report.project_path, &name);
                Ok(report)
            }
            Err(err) => {
                // A failure here would otherwise leave a half-built project
                // folder behind.
                let _ = fs::remove_dir_all(&project_path);
                Err(err)
            }
        }
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

fn restore_into(
    kept: &Path,
    project_path: &Path,
    name: &str,
    on_progress: &dyn Fn(usize, usize, &str),
) -> Result<RestoreReport, String> {
    // `create_project_in` already wrote a fresh database; the kept one
    // replaces it wholesale.
    crate::safe_io::copy_durably(kept, &project::db_path(project_path))
        .map_err(|e| crate::trf!("Konnte das Protokoll nicht einlesen: {e}", e = e))?;

    let conn = project::open_project_db(project_path)?;
    settings::set(&conn, crate::project::PROJECT_NAME_KEY, name)?;
    // It is a live project again, so the marks that made it a deleted one
    // have to go.
    let _ = conn.execute(
        "DELETE FROM settings WHERE key IN (?1, ?2)",
        params![DELETED_AT_KEY, DELETED_FROM_KEY],
    );

    let default_percent = items::default_video_frame_percent(&conn);

    struct Pending {
        id: String,
        source_path: Option<String>,
        label: String,
        resolved_timestamp: String,
        file_size_bytes: Option<i64>,
        fs_modified_at: Option<String>,
        video_frame_percent: Option<f64>,
    }

    let pending: Vec<Pending> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, source_path, COALESCE(display_name, original_filename),
                        resolved_timestamp, file_size_bytes, fs_modified_at, video_frame_percent
                 FROM items WHERE {LIVE_ITEMS}"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Pending {
                    id: row.get(0)?,
                    source_path: row.get(1)?,
                    label: row.get(2)?,
                    resolved_timestamp: row.get(3)?,
                    file_size_bytes: row.get(4)?,
                    fs_modified_at: row.get(5)?,
                    video_frame_percent: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    let total = pending.len();
    let mut restored = 0usize;
    let mut changed = Vec::new();
    let mut missing = Vec::new();

    for (index, item) in pending.iter().enumerate() {
        on_progress(index, total, &item.label);

        let source = item.source_path.as_deref().map(Path::new).filter(|p| p.is_file());
        let Some(source) = source else {
            missing.push(item.label.clone());
            mark_unavailable(&conn, &item.id);
            continue;
        };

        // The file is there, but is it still the same file? Reported rather
        // than refused: a changed source is still almost certainly the one
        // the user wants back.
        let (fs_created, fs_modified) = items::fs_times(source);
        let current_size = fs::metadata(source).ok().map(|m| m.len() as i64);
        if item.file_size_bytes.is_some() && current_size != item.file_size_bytes
            || (item.fs_modified_at.is_some() && fs_modified != item.fs_modified_at)
        {
            changed.push(item.label.clone());
        }

        let kind = fsbrowse::classify(source);
        match items::copy_and_thumbnail(
            project_path,
            source,
            kind,
            &item.resolved_timestamp,
            current_size.map(|s| s as u64),
            &fs_created,
            &fs_modified,
            item.video_frame_percent.unwrap_or(default_percent),
        ) {
            Ok((stored, thumbnail)) => {
                conn.execute(
                    "UPDATE items SET stored_path = ?1, thumbnail_path = ?2 WHERE id = ?3",
                    params![
                        stored.to_string_lossy().to_string(),
                        thumbnail.map(|p| p.to_string_lossy().to_string()),
                        item.id
                    ],
                )
                .map_err(|e| crate::trf!("Konnte Eintrag nicht aktualisieren: {e}", e = e))?;
                restored += 1;
            }
            Err(_) => {
                missing.push(item.label.clone());
                mark_unavailable(&conn, &item.id);
            }
        }
    }

    on_progress(total, total, "");

    Ok(RestoreReport {
        project_path: project_path.to_string_lossy().to_string(),
        name: name.to_string(),
        restored,
        changed,
        missing,
    })
}

/// An item whose file could not be brought back is taken off the timeline
/// rather than dropped: its name, date and history are still worth having,
/// and the Protokoll tab can show what happened to it.
///
/// Deliberately not written to the action log — nobody performed this, it
/// is the outcome of a restore, and an "undo" for it would only put back a
/// row pointing at a file that does not exist.
fn mark_unavailable(conn: &Connection, id: &str) {
    let _ = conn.execute(
        "UPDATE items SET removed_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), id],
    );
}

/// The id comes from `list_deleted_streams`, but it is still treated
/// as untrusted input before it is pasted into a file path: a single path
/// segment only, so it can never reach out of the folder it belongs to.
fn is_valid_kept_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\0')
}

/// Throws away a kept database, giving up the chance to restore that
/// stream. Only ever called from an explicit user action.
#[tauri::command(async)]
pub fn discard_deleted_stream(app: AppHandle, id: String) -> Result<(), String> {
    if !is_valid_kept_id(&id) {
        return Err(crate::i18n::tr("Ungültige Kennung.").to_string());
    }
    let file = deleted_dir(&app)?.join(format!("{id}.db"));
    if file.is_file() {
        fs::remove_file(&file).map_err(|e| crate::trf!("Konnte nicht löschen: {e}", e = e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("cronostream-delete-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Scratch { root }
        }

        /// A folder that really is a stream, nested deep enough to pass
        /// the depth guard.
        fn project(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(path.join("originals")).unwrap();
            fs::create_dir_all(path.join("thumbnails")).unwrap();
            let conn = Connection::open(project::db_path(&path)).unwrap();
            conn.execute_batch(crate::schema::SCHEMA).unwrap();
            path
        }

        fn plain_folder(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn config(&self) -> PathBuf {
            let path = self.root.join("config");
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_real_stream_folder_passes() {
        let scratch = Scratch::new();
        let project = scratch.project("Test");
        let ok = ensure_safe_to_delete(&project, &scratch.config(), None).unwrap();
        assert_eq!(ok, project.canonicalize().unwrap());
    }

    #[test]
    fn a_folder_that_is_not_a_stream_is_refused() {
        let scratch = Scratch::new();
        let plain = scratch.plain_folder("Urlaubsfotos");
        let err = ensure_safe_to_delete(&plain, &scratch.config(), None).unwrap_err();
        assert!(err.contains("kein Stream"), "{err}");
    }

    #[test]
    fn a_path_that_does_not_exist_is_refused() {
        let scratch = Scratch::new();
        let err = ensure_safe_to_delete(
            &scratch.root.join("gibtesnicht"),
            &scratch.config(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("existiert nicht"), "{err}");
    }

    #[test]
    fn an_empty_path_is_refused() {
        let scratch = Scratch::new();
        assert!(ensure_safe_to_delete(Path::new(""), &scratch.config(), None).is_err());
    }

    #[test]
    fn the_filesystem_root_is_refused() {
        let scratch = Scratch::new();
        let err = ensure_safe_to_delete(Path::new("/"), &scratch.config(), None).unwrap_err();
        // "/" holds no cronostream.db, so the project-marker guard catches
        // it before the depth check ever applies.
        assert!(err.contains("kein Stream"), "{err}");
    }

    #[test]
    fn the_home_directory_is_refused_even_if_it_holds_a_stream() {
        let scratch = Scratch::new();
        let home = scratch.project("fake-home");
        let err = ensure_safe_to_delete(&home, &scratch.config(), Some(&home)).unwrap_err();
        assert!(err.contains("Benutzerordner"), "{err}");
    }

    #[test]
    fn streams_own_config_folder_is_refused() {
        let scratch = Scratch::new();
        // A stream *at* the config folder, and one containing it: both
        // would destroy the kept databases that make deletion reversible.
        let config = scratch.config();
        let conn = Connection::open(project::db_path(&config)).unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        drop(conn);
        let err = ensure_safe_to_delete(&config, &config, None).unwrap_err();
        assert!(err.contains("CronoStream selbst"), "{err}");

        let outer = scratch.project("outer");
        let inner_config = outer.join("config");
        fs::create_dir_all(&inner_config).unwrap();
        let err = ensure_safe_to_delete(&outer, &inner_config, None).unwrap_err();
        assert!(err.contains("CronoStream selbst"), "{err}");
    }

    #[test]
    fn a_roundabout_path_is_judged_by_where_it_really_points() {
        let scratch = Scratch::new();
        let home = scratch.project("fake-home");
        // ".../fake-home/originals/.." resolves back to the home folder, so
        // it has to be refused just the same.
        let sneaky = home.join("originals").join("..");
        let err = ensure_safe_to_delete(&sneaky, &scratch.config(), Some(&home)).unwrap_err();
        assert!(err.contains("Benutzerordner"), "{err}");
    }

    #[test]
    fn foreign_files_in_the_project_folder_are_recognised_as_foreign() {
        assert!(is_own_entry("originals"));
        assert!(is_own_entry("thumbnails"));
        assert!(is_own_entry(DB_FILENAME));
        assert!(is_own_entry(LOCK_FILENAME));
        assert!(is_own_entry("cronostream.db-wal"));
        assert!(is_own_entry("diary"));
        assert!(is_own_entry("cronostream.db.vor-pfadanpassung-20261106-093737"));
        assert!(is_own_entry("cronostream.db.vor-aktualisierung"));
        assert!(is_own_entry("lifestream.db"));
        assert!(is_own_entry("lifestream.db-wal"));
        assert!(is_own_entry(".lifestream.lock"));
        assert!(is_own_entry("lifestream.db.vor-aktualisierung"));
        assert!(!is_own_entry("Notizen.txt"));
        assert!(!is_own_entry("Steuer2024"));
        assert!(!is_own_entry("cronostream.db.alt"));
    }

    #[test]
    fn a_discard_id_cannot_escape_its_folder() {
        for bad in ["", "..", "../../etc/passwd", "a/b", "x\\y", "..\\..\\x"] {
            assert!(!is_valid_kept_id(bad), "{bad:?} must be refused");
        }
        // A real id from `list_deleted_streams` is a plain UUID.
        assert!(is_valid_kept_id(&Uuid::new_v4().to_string()));
    }

    #[test]
    fn folder_size_adds_up_nested_files() {
        let scratch = Scratch::new();
        let project = scratch.project("Test");
        fs::write(project.join("originals").join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(project.join("thumbnails").join("b.bin"), vec![0u8; 500]).unwrap();
        let size = folder_size(&project);
        assert!(size >= 1500, "got {size}");
    }

    /// Writes a real 1x1 PNG, so thumbnail generation during a restore
    /// has something it can actually decode.
    fn write_png(path: &Path) {
        let img = image::RgbImage::from_pixel(2, 2, image::Rgb([200, 40, 40]));
        img.save(path).unwrap();
    }

    fn silent_progress(_done: usize, _total: usize, _current: &str) {}

    #[test]
    fn deleting_without_keeping_the_log_leaves_nothing_behind() {
        let scratch = Scratch::new();
        let project = scratch.project("Wegwerf");
        fs::write(project.join("originals").join("a.bin"), vec![0u8; 1234]).unwrap();
        let kept_dir = scratch.root.join("kept");

        let outcome = perform_deletion(&project.canonicalize().unwrap(), false, &kept_dir).unwrap();
        assert!(outcome.kept_id.is_none());
        assert!(outcome.freed_bytes >= 1234);
        assert!(!project.exists(), "the folder is gone");
        // Nothing was kept, so there is nothing to restore from.
        assert!(!kept_dir.join("x.db").exists());
    }

    #[test]
    fn a_full_delete_and_restore_round_trip_brings_everything_back() {
        let scratch = Scratch::new();
        let project = scratch.project("Erinnerungen");
        let kept_dir = scratch.root.join("kept");

        // Two items with real source files outside the project, as a real
        // import would have left them.
        let sources = scratch.plain_folder("quellen");
        let keep_source = sources.join("Bleibt.png");
        let lost_source = sources.join("Verschwindet.png");
        write_png(&keep_source);
        write_png(&lost_source);

        let conn = project::open_project_db(&project).unwrap();
        crate::settings::set(&conn, crate::project::PROJECT_NAME_KEY, "Erinnerungen").unwrap();
        for (id, name, source) in [
            ("item-eins", "Bleibt.png", &keep_source),
            ("item-zwei", "Verschwindet.png", &lost_source),
        ] {
            let size = fs::metadata(source).unwrap().len() as i64;
            let (_, modified) = items::fs_times(source);
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                    display_name, resolved_timestamp, timestamp_source, added_at,
                                    source_path, file_size_bytes, fs_modified_at, rotation)
                 VALUES (?1, ?2, '/weg', '/weg', 'image', ?3, '2019-04-05T08:00:00+00:00', 'exif',
                         '2024-01-01T00:00:00+00:00', ?4, ?5, ?6, 180)",
                params![
                    id,
                    name,
                    format!("Mein {name}"),
                    source.to_string_lossy().to_string(),
                    size,
                    modified
                ],
            )
            .unwrap();
        }
        // A piece of history that must survive the round trip.
        crate::action_log::record(
            &conn,
            crate::action_log::ActionType::Import,
            &[
                crate::action_log::LogEntry::presence("item-eins", "Bleibt.png"),
                crate::action_log::LogEntry::presence("item-zwei", "Verschwindet.png"),
            ],
        )
        .unwrap();
        drop(conn);

        let outcome =
            perform_deletion(&project.canonicalize().unwrap(), true, &kept_dir).unwrap();
        let kept_id = outcome.kept_id.expect("the database was kept");
        assert!(!project.exists(), "the project folder is gone");
        let kept_db = kept_dir.join(format!("{kept_id}.db"));
        assert!(kept_db.is_file(), "the database was kept outside the folder");

        // One source file disappears before the restore, which is exactly
        // the case the report has to be honest about.
        fs::remove_file(&lost_source).unwrap();

        let destination = scratch.plain_folder("wiederhergestellt");

        // `restore_into` is handed a folder the command has already
        // created; pointed at one that doesn't exist it must fail outright
        // rather than half-build something.
        let missing_folder = destination.join("gibtesnicht");
        assert!(restore_into(&kept_db, &missing_folder, "X", &silent_progress).is_err());

        let project_path = project::create_project_in(&destination, "Erinnerungen2").unwrap();
        let report = restore_into(&kept_db, &project_path, "Erinnerungen2", &silent_progress).unwrap();

        assert_eq!(report.restored, 1, "only the file that still exists comes back");
        assert_eq!(report.missing, vec!["Mein Verschwindet.png".to_string()]);

        let conn = project::open_project_db(&project_path).unwrap();

        // The restored item points at real files inside the new project,
        // and kept its id, name, date and rotation.
        let (stored, thumb, name, ts, rotation): (String, Option<String>, String, String, i32) = conn
            .query_row(
                "SELECT stored_path, thumbnail_path, display_name, resolved_timestamp, rotation
                 FROM items WHERE id = 'item-eins'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert!(Path::new(&stored).is_file(), "original restored: {stored}");
        assert!(stored.contains("2019"), "year/month layout kept: {stored}");
        assert!(Path::new(&thumb.unwrap()).is_file(), "thumbnail regenerated");
        assert_eq!(name, "Mein Bleibt.png");
        assert_eq!(ts, "2019-04-05T08:00:00+00:00");
        assert_eq!(rotation, 180);

        // The item whose file is gone stays, but off the timeline.
        let removed_at: Option<String> = conn
            .query_row("SELECT removed_at FROM items WHERE id = 'item-zwei'", [], |r| r.get(0))
            .unwrap();
        assert!(removed_at.is_some(), "an unavailable item is taken off the timeline");

        // Ids were preserved, so the action log still refers to real items.
        let log_entries: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM action_log_entry e
                 WHERE EXISTS(SELECT 1 FROM items i WHERE i.id = e.item_id)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(log_entries, 2, "the history survived and still matches its items");

        // And it is a live project again, not a deleted one.
        assert!(crate::settings::get(&conn, DELETED_AT_KEY).unwrap().is_none());
        assert_eq!(
            crate::settings::get(&conn, crate::project::PROJECT_NAME_KEY).unwrap().as_deref(),
            Some("Erinnerungen2")
        );
    }

    #[test]
    fn a_changed_source_file_is_restored_but_reported() {
        let scratch = Scratch::new();
        let project = scratch.project("Geaendert");
        let kept_dir = scratch.root.join("kept");
        let sources = scratch.plain_folder("quellen");
        let source = sources.join("Foto.png");
        write_png(&source);

        let conn = project::open_project_db(&project).unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, display_name,
                                resolved_timestamp, timestamp_source, added_at, source_path,
                                file_size_bytes, rotation)
             VALUES ('a', 'Foto.png', '/weg', 'image', 'Foto', '2020-01-01T00:00:00+00:00', 'exif',
                     '2024-01-01T00:00:00+00:00', ?1, 999999, 0)",
            params![source.to_string_lossy().to_string()],
        )
        .unwrap();
        drop(conn);

        let outcome = perform_deletion(&project.canonicalize().unwrap(), true, &kept_dir).unwrap();
        let kept_db = kept_dir.join(format!("{}.db", outcome.kept_id.unwrap()));

        let destination = scratch.plain_folder("ziel");
        let project_path = project::create_project_in(&destination, "Geaendert").unwrap();
        let report = restore_into(&kept_db, &project_path, "Geaendert", &silent_progress).unwrap();

        // The recorded size doesn't match the file on disk any more, so it
        // comes back but is flagged rather than silently accepted.
        assert_eq!(report.restored, 1);
        assert_eq!(report.changed, vec!["Foto".to_string()]);
        assert!(report.missing.is_empty());
    }

    #[test]
    fn restorable_counts_only_items_whose_source_still_exists() {
        let scratch = Scratch::new();
        let project = scratch.project("Test");
        let conn = Connection::open(project::db_path(&project)).unwrap();

        let present = scratch.root.join("quelle-da.jpg");
        fs::write(&present, b"x").unwrap();

        for (id, source) in [
            ("a", present.to_string_lossy().to_string()),
            ("b", scratch.root.join("weg.jpg").to_string_lossy().to_string()),
        ] {
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, file_type,
                                    resolved_timestamp, timestamp_source, added_at, source_path)
                 VALUES (?1, 'f.jpg', '/x', 'image', '2024-01-01T00:00:00+00:00', 'exif',
                         '2024-01-01T00:00:00+00:00', ?2)",
                params![id, source],
            )
            .unwrap();
        }

        assert_eq!(count_restorable(&conn), 1);
    }
}
