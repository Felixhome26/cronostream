use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::copy_task::{self, CopyTasks};
use crate::project::PROJECT_NAME_KEY;
use crate::state::AppStateHandle;

/// Starts a cancellable, progress-reporting copy of the entire active
/// project folder (originals, thumbnails, database — everything except the
/// lock file) into a new timestamped subfolder of `destination_parent`.
/// This is the project's manual backup feature: a full, self-contained copy
/// the user can keep wherever they like. Returns a task id the frontend
/// uses to track `copy-progress` events and to cancel.
#[tauri::command(async)]
pub fn start_backup(
    app: AppHandle,
    state: State<AppStateHandle>,
    tasks: State<CopyTasks>,
    destination_parent: String,
) -> Result<String, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let project_name = current
        .path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Stream".to_string());
    let src = current.path.clone();
    drop(guard);

    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let backup_dir = Path::new(&destination_parent).join(format!("{project_name}-Backup-{timestamp}"));

    if backup_dir.exists() || copy_task::staging_path(&backup_dir).exists() {
        return Err(crate::i18n::tr("Dieses Backup-Ziel existiert bereits. Bitte erneut versuchen.").into());
    }
    // A backup into the project's own folder is the easy mistake here: the
    // folder dialog opens somewhere, and the project folder is a perfectly
    // plausible-looking place to put a backup. See the function's own doc
    // comment for what that would do.
    copy_task::ensure_destination_outside_source(&src, &backup_dir)?;

    let (task_id, cancel) = tasks.register();
    let src_for_rewrite = src.clone();
    copy_task::spawn_copy(
        app,
        task_id.clone(),
        "backup".to_string(),
        src,
        backup_dir,
        cancel,
        move |_app, staging, dst| copy_task::rewrite_item_paths(staging, &src_for_rewrite, dst, true),
        |_app, _dst| {},
    );

    Ok(task_id)
}

/// Share of a backup's entries that must also be in the open stream for
/// the backup to count as one of it. Generous on purpose: entries deleted
/// for good since the last backup are in the backup only.
const RELATED_SHARE: f64 = 0.5;

fn open_backup_db(backup: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(crate::project::db_path(backup), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| crate::trf!("Konnte die Datenbank nicht lesen: {e}", e = e))
}

/// Whether the stream at `backup` is a backup of the one with `ids`:
/// most of its entries are entries of this one. An empty backup counts.
/// A duplicate shares the entries too — `has_own_changes` and the names are
/// what tell it apart, and only ask, see `check_backup_update`.
fn is_backup_of(backup: &Path, ids: &HashSet<String>) -> Result<bool, String> {
    let conn = open_backup_db(backup)?;
    let mut stmt = conn.prepare("SELECT id FROM items").map_err(|e| e.to_string())?;
    let backup_ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if backup_ids.is_empty() {
        return Ok(true);
    }
    let shared = backup_ids.iter().filter(|id| ids.contains(*id)).count();
    Ok(shared as f64 >= backup_ids.len() as f64 * RELATED_SHARE)
}

/// Whether the backup holds changes made in it rather than here: its latest
/// action is not in this stream's log under the same number, time and
/// kind. A backup is a snapshot of this log, so its latest action stays here
/// — unless every file of that action was deleted for good since, which is
/// why this only asks and never refuses. A backup without a log has none.
fn has_own_changes(backup: &Connection, current: &Connection) -> bool {
    let latest: Option<(i64, i64, String)> = backup
        .query_row("SELECT id, performed_at, action_type FROM action_log ORDER BY id DESC LIMIT 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .ok()
        .flatten();
    let Some((id, performed_at, action_type)) = latest else { return false };
    let known = current
        .query_row(
            "SELECT 1 FROM action_log WHERE id = ?1 AND performed_at = ?2 AND action_type = ?3",
            params![id, performed_at, action_type],
            |_| Ok(()),
        )
        .optional();
    !matches!(known, Ok(Some(())))
}

/// What the user should know before `start_backup_update` replaces the
/// database of the picked folder (it is kept beside it, see
/// `copy_task::PREVIOUS_DATABASE_SUFFIX`, and no file is deleted).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupUpdateCheck {
    pub backup_name: String,
    pub current_name: String,
    /// Both carry a stored name, and the names differ — a duplicate is named
    /// on its own, a backup carries the name of what it backs up.
    pub other_name: bool,
    pub own_changes: bool,
}

fn update_check(backup: &Path, backup_conn: &Connection, current: &Connection, current_root: &Path) -> BackupUpdateCheck {
    let stored = |conn: &Connection| crate::settings::get(conn, PROJECT_NAME_KEY).ok().flatten();
    let folder = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (backup_stored, current_stored) = (stored(backup_conn), stored(current));
    BackupUpdateCheck {
        other_name: matches!((&backup_stored, &current_stored), (Some(a), Some(b)) if a != b),
        backup_name: backup_stored.unwrap_or_else(|| folder(backup)),
        current_name: current_stored.unwrap_or_else(|| folder(current_root)),
        own_changes: has_own_changes(backup_conn, current),
    }
}

/// The checks that refuse a folder outright, shared by `check_backup_update`
/// and `start_backup_update`: not a stream, the stream itself, a
/// folder inside it, a backup open right now, or not a backup of it at all.
/// Returns the open stream's folder and the backup's.
fn checked_target(state: &State<AppStateHandle>, backup_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let (src, ids) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let mut stmt = current.conn.prepare("SELECT id FROM items").map_err(|e| e.to_string())?;
        let ids: HashSet<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        (current.path.clone(), ids)
    };
    let backup = PathBuf::from(backup_path);

    if !crate::project::is_project_folder(&backup) {
        return Err(crate::i18n::tr("Dieser Ordner enthält keinen Stream.").into());
    }
    if matches!((src.canonicalize(), backup.canonicalize()), (Ok(a), Ok(b)) if a == b) {
        return Err(crate::i18n::tr("Das ist der geöffnete Stream selbst, keine Sicherung.").into());
    }
    copy_task::ensure_destination_outside_source(&src, &backup)?;
    if matches!(crate::lock::check_for_open(&backup), crate::lock::LockState::Active { .. }) {
        return Err(crate::i18n::tr("Diese Sicherung ist gerade in CronoStream geöffnet.").into());
    }
    if !is_backup_of(&backup, &ids)? {
        return Err(crate::i18n::tr("Dieser Ordner ist keine Sicherung dieses Streams.").into());
    }
    Ok((src, backup))
}

/// Run by the frontend before `start_backup_update`: the outright refusals,
/// then what to ask about first (see `BackupUpdateCheck`).
#[tauri::command(async)]
pub fn check_backup_update(state: State<AppStateHandle>, backup_path: String) -> Result<BackupUpdateCheck, String> {
    let (src, backup) = checked_target(&state, &backup_path)?;
    let backup_conn = open_backup_db(&backup)?;
    let guard = crate::state::lock_project(&state, &src)?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    Ok(update_check(&backup, &backup_conn, &current.conn, &src))
}

/// Brings an existing backup of the open stream up to date (see
/// `copy_task::spawn_backup_update`). Refuses what `checked_target` refuses;
/// what is only worth asking about is the frontend's to ask, through
/// `check_backup_update`. Reports through the same `copy-progress` events
/// as `start_backup` and returns the task id.
#[tauri::command(async)]
pub fn start_backup_update(
    app: AppHandle,
    state: State<AppStateHandle>,
    tasks: State<CopyTasks>,
    backup_path: String,
) -> Result<String, String> {
    let (src, backup) = checked_target(&state, &backup_path)?;
    let (task_id, cancel) = tasks.register();
    copy_task::spawn_backup_update(app, task_id.clone(), src, backup, cancel);
    Ok(task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with(ids: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-backup-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::project::open_project_db(&dir).unwrap();
        for id in ids {
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
                 VALUES (?1, 'x.jpg', '/x', 'image', '2020-01-01T00:00:00Z', 'exif', '2020-01-01T00:00:00Z')",
                [id],
            )
            .unwrap();
        }
        dir
    }

    #[test]
    fn a_backup_is_recognised_by_its_entries() {
        let ids: HashSet<String> = ["a", "b", "c", "d"].map(String::from).into();
        let own = project_with(&["a", "b", "c", "old"]);
        let foreign = project_with(&["x", "y", "a"]);
        let empty = project_with(&[]);
        assert!(is_backup_of(&own, &ids).unwrap());
        assert!(!is_backup_of(&foreign, &ids).unwrap());
        assert!(is_backup_of(&empty, &ids).unwrap());
        for dir in [own, foreign, empty] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    fn log_action(conn: &Connection, id: i64, performed_at: i64) {
        conn.execute(
            "INSERT INTO action_log (id, performed_at, action_type) VALUES (?1, ?2, 'import')",
            params![id, performed_at],
        )
        .unwrap();
    }

    #[test]
    fn a_folder_continued_on_its_own_or_named_otherwise_is_asked_about() {
        let (current_dir, backup_dir) = (project_with(&["a"]), project_with(&["a"]));
        let current = crate::project::open_project_db(&current_dir).unwrap();
        let backup = crate::project::open_project_db(&backup_dir).unwrap();
        crate::settings::set(&current, PROJECT_NAME_KEY, "Mein Leben").unwrap();
        crate::settings::set(&backup, PROJECT_NAME_KEY, "Mein Leben").unwrap();
        log_action(&current, 1, 100);
        log_action(&backup, 1, 100);

        // A plain backup, and still one after this stream went on.
        let plain = BackupUpdateCheck {
            backup_name: "Mein Leben".into(),
            current_name: "Mein Leben".into(),
            other_name: false,
            own_changes: false,
        };
        assert_eq!(update_check(&backup_dir, &backup, &current, &current_dir), plain);
        log_action(&current, 2, 200);
        assert!(!has_own_changes(&backup, &current));

        // The folder went on by itself, like a duplicate continued on its own.
        log_action(&backup, 2, 250);
        crate::settings::set(&backup, PROJECT_NAME_KEY, "Für Lena").unwrap();
        let check = update_check(&backup_dir, &backup, &current, &current_dir);
        assert!(check.own_changes && check.other_name);
        assert_eq!(check.backup_name, "Für Lena");

        // No log at all (a backup from before the log existed): nothing to ask.
        let empty = Connection::open_in_memory().unwrap();
        assert!(!has_own_changes(&empty, &current));
        for dir in [current_dir, backup_dir] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
