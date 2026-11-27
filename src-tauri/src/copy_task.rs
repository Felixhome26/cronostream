use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::lock::{LEGACY_LOCK_FILENAME, LOCK_FILENAME};

const PROGRESS_EVENT: &str = "copy-progress";
const EMIT_INTERVAL_MS: u128 = 150;

/// Registry of in-flight copy operations, keyed by task id, so a separate
/// `cancel_copy_task` command can signal a running background thread.
#[derive(Default)]
pub struct CopyTasks(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl CopyTasks {
    pub fn register(&self) -> (String, Arc<AtomicBool>) {
        let task_id = uuid::Uuid::new_v4().to_string();
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(task_id.clone(), flag.clone());
        (task_id, flag)
    }

    pub fn cancel(&self, task_id: &str) -> Result<(), String> {
        let map = self.0.lock().map_err(|e| e.to_string())?;
        match map.get(task_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            None => Err(crate::i18n::tr("Dieser Vorgang läuft nicht (mehr).").into()),
        }
    }

    fn unregister(&self, task_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(task_id);
        }
    }

    /// Asks every running copy to stop — on app exit, so a backup is
    /// cleaned up by its own thread rather than cut off mid-file.
    pub fn cancel_all(&self) {
        if let Ok(map) = self.0.lock() {
            map.values().for_each(|flag| flag.store(true, Ordering::SeqCst));
        }
    }

    pub fn is_idle(&self) -> bool {
        self.0.lock().map(|map| map.is_empty()).unwrap_or(true)
    }
}

#[derive(Serialize, Clone)]
struct CopyProgressPayload {
    task_id: String,
    kind: String,
    copied_files: u64,
    total_files: u64,
    copied_bytes: u64,
    total_bytes: u64,
    status: String,
    error: Option<String>,
    result_path: Option<String>,
}

/// The lock files, under the app's current name and under LifeStream's: a
/// copy is never open anywhere, whoever holds the original.
fn should_skip(name: &std::ffi::OsStr) -> bool {
    name == LOCK_FILENAME || name == LEGACY_LOCK_FILENAME
}

/// The database and SQLite's side files, at the project root only, under
/// the current name or the LifeStream one a stream may still carry. They are
/// never copied file by file: a copy taken while the app writes can catch
/// the database and its journal at different moments. `snapshot_database`
/// writes one consistent copy instead, always under the current name.
fn is_database_file(name: &std::ffi::OsStr) -> bool {
    [crate::project::DB_FILENAME, crate::project::LEGACY_DB_FILENAME].iter().any(|db| {
        [db.to_string(), format!("{db}-journal"), format!("{db}-wal"), format!("{db}-shm")]
            .iter()
            .any(|candidate| name == candidate.as_str())
    })
}

/// Writes a consistent copy of `src`'s database into `dst_dir`, through its
/// own read-only connection: `VACUUM INTO` reads one snapshot, however much
/// the open project writes meanwhile.
fn snapshot_database(src: &Path, dst_dir: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        crate::project::db_path(src),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| crate::trf!("Konnte die Datenbank nicht lesen: {e}", e = e))?;
    conn.busy_timeout(std::time::Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    let target = dst_dir.join(crate::project::DB_FILENAME);
    conn.execute("VACUUM INTO ?1", rusqlite::params![target.to_string_lossy()])
        .map_err(|e| crate::trf!("Konnte die Datenbank nicht sichern: {e}", e = e))?;
    crate::safe_io::sync_file(&target).map_err(|e| crate::trf!("Konnte die Datenbank nicht sichern: {e}", e = e))
}

/// Where a copy is assembled before it gets its real name, next to it. An
/// interrupted copy (app closed, crash, drive pulled) is left behind under
/// this name — plainly unfinished, never a folder that looks like a
/// complete backup.
pub fn staging_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".partial");
    dst.with_file_name(name)
}

/// Characters rejected by the filesystems a backup commonly lands on
/// (exFAT/NTFS/FAT32 — the usual formats for an external backup drive),
/// even though they're perfectly valid on the ext4/btrfs volume the project
/// itself lives on. A colon is the one that actually turns up in practice:
/// imported `.eml`/`.msg` files keep their subject line in the filename
/// (`Re: ...`), and `fs::copy` fails outright the moment it hits one.
const RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*', '\\'];

/// Replaces characters from `RESERVED_CHARS` (and control characters) with
/// `_`, and strips the trailing dots/spaces Windows-family filesystems also
/// reject. Only used for backup destinations (see `sanitize_names` on
/// `CopyState`) — "Projekt duplizieren" keeps filenames byte-identical, it
/// only rewrites the project-root prefix (see `rewrite_item_paths`).
fn sanitize_component(name: &std::ffi::OsStr) -> std::ffi::OsString {
    let lossy = name.to_string_lossy();
    let cleaned: String = lossy
        .chars()
        .map(|ch| if RESERVED_CHARS.contains(&ch) || (ch as u32) < 0x20 { '_' } else { ch })
        .collect();
    let trimmed = cleaned.trim_end_matches([' ', '.']);
    if trimmed.is_empty() {
        std::ffi::OsString::from("_")
    } else {
        std::ffi::OsString::from(trimmed)
    }
}

/// Refuses a copy whose destination would sit inside its own source.
///
/// `copy_recursive` creates `dst` and only then reads `src`. With `dst`
/// under `src`, `read_dir` hands back the destination folder that was just
/// created, the walk descends into it and starts copying what it has itself
/// written — and keeps going until the disk is full. The `scan` beforehand
/// doesn't help: it only establishes the progress total, it doesn't bound
/// the walk.
///
/// Checked against resolved paths, so a destination that reaches back into
/// the source through a symlink is caught too. Called by the commands
/// rather than from `spawn_copy`, so the user gets a plain refusal in the
/// dialog they started the copy from, instead of an error arriving through
/// the progress channel after the fact.
pub fn ensure_destination_outside_source(src: &Path, dst: &Path) -> Result<(), String> {
    let resolved_src = src
        .canonicalize()
        .map_err(|_| crate::i18n::tr("Der Quellordner ist nicht lesbar.").to_string())?;

    // `dst` is the folder about to be created, so there is nothing to
    // resolve about it yet — its parent is what decides where it lands.
    let parent = dst
        .parent()
        .ok_or_else(|| crate::i18n::tr("Das Ziel hat keinen übergeordneten Ordner.").to_string())?;
    let name = dst
        .file_name()
        .ok_or_else(|| crate::i18n::tr("Das Ziel hat keinen Namen.").to_string())?;
    let resolved_dst = parent
        .canonicalize()
        .map_err(|_| crate::i18n::tr("Dieser Zielordner existiert nicht.").to_string())?
        .join(name);

    if resolved_dst.starts_with(&resolved_src) {
        return Err(
            crate::i18n::tr("Das Ziel liegt im Quellordner selbst – die Kopie würde sich dort endlos selbst kopieren. Bitte einen Ort außerhalb wählen.")
                .to_string(),
        );
    }
    Ok(())
}

fn scan(dir: &Path, is_root: bool, files: &mut u64, bytes: &mut u64) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if should_skip(&entry.file_name()) || (is_root && is_database_file(&entry.file_name())) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            scan(&entry.path(), false, files, bytes)?;
        } else if file_type.is_file() {
            *files += 1;
            *bytes += entry.metadata()?.len();
        }
    }
    Ok(())
}

struct CopyState<'a> {
    app: &'a AppHandle,
    task_id: &'a str,
    kind: &'a str,
    cancel: &'a AtomicBool,
    /// The copy's own destination, so the walk can never descend into it —
    /// see `copy_recursive`.
    dst_root: &'a Path,
    /// The project folder being copied: its database is skipped there (see
    /// `is_database_file`), but a file of that name deeper down is content.
    src_root: &'a Path,
    /// Backup only (never duplicate — see `sanitize_component`'s doc
    /// comment): rewrite destination filenames so a filesystem that
    /// rejects characters like `:` never aborts the copy over one.
    sanitize_names: bool,
    /// Updating an existing backup (see `spawn_backup_update`): a file the
    /// backup already holds in the same size, and not older than the
    /// source, is left as it is; everything else is replaced through a
    /// temporary file, so an interrupted update never leaves half a file.
    update_existing: bool,
    copied_files: u64,
    copied_bytes: u64,
    total_files: u64,
    total_bytes: u64,
    last_emit: Instant,
}

enum CopyOutcome {
    Done,
    Cancelled,
}

impl CopyState<'_> {
    fn emit(&self, status: &str, error: Option<String>, result_path: Option<String>) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            CopyProgressPayload {
                task_id: self.task_id.to_string(),
                kind: self.kind.to_string(),
                copied_files: self.copied_files,
                total_files: self.total_files,
                copied_bytes: self.copied_bytes,
                total_bytes: self.total_bytes,
                status: status.to_string(),
                error,
                result_path,
            },
        );
    }

    fn maybe_emit_progress(&mut self) {
        if self.last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS {
            self.emit("running", None, None);
            self.last_emit = Instant::now();
        }
    }
}

fn copy_recursive(src: &Path, dst: &Path, state: &mut CopyState) -> std::io::Result<CopyOutcome> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        if state.cancel.load(Ordering::SeqCst) {
            return Ok(CopyOutcome::Cancelled);
        }
        let entry = entry?;
        if should_skip(&entry.file_name()) || (src == state.src_root && is_database_file(&entry.file_name())) {
            continue;
        }
        // Belt and braces: the commands already refuse a destination inside
        // the source (see `ensure_destination_outside_source`), which is the
        // check that actually tells the user what is wrong. If a future
        // caller forgets it, this keeps the walk from descending into its
        // own output and filling the disk — it must never be the thing
        // that saves us, only the thing that limits the damage.
        if entry.path() == state.dst_root {
            continue;
        }
        let dest_name = if state.sanitize_names {
            sanitize_component(&entry.file_name())
        } else {
            entry.file_name()
        };
        let dest_path = dst.join(&dest_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if let CopyOutcome::Cancelled = copy_recursive(&entry.path(), &dest_path, state)? {
                return Ok(CopyOutcome::Cancelled);
            }
        } else if file_type.is_file() {
            // Flushed file by file: "Backup fertig" must mean the data is on
            // the drive, not still in the cache of one about to be unplugged.
            if state.update_existing && is_up_to_date(&entry.path(), &dest_path) {
                state.copied_files += 1;
                state.copied_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                state.maybe_emit_progress();
                continue;
            }
            let copied = if state.update_existing {
                crate::safe_io::copy_durably(&entry.path(), &dest_path)
            } else {
                fs::copy(entry.path(), &dest_path).and_then(|bytes| crate::safe_io::sync_file(&dest_path).map(|_| bytes))
            };
            let bytes = copied.map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", entry.path().display())))?;
            state.copied_files += 1;
            state.copied_bytes += bytes;
            state.maybe_emit_progress();
        }
    }
    Ok(CopyOutcome::Done)
}

/// How much older than its source a backup copy may look and still count
/// as up to date. FAT and exFAT sticks (and HFS+) keep times coarser than
/// the project's disk, and on Windows and macOS a copy takes over its
/// source's time, which such a stick then rounds down — without this every
/// update there copied everything again. Missed in return: a source changed
/// within this much after its copy was written, which does not happen
/// between two backups.
const MTIME_TOLERANCE: std::time::Duration = std::time::Duration::from_secs(2);

/// Whether `dest` already holds `src`: same size and not older (within
/// `MTIME_TOLERANCE`). A backup copy is written after its source, or keeps
/// its time; a source changed since (replaced in the app, say) is newer than
/// its copy again.
fn is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (Ok(source), Ok(copy)) = (fs::metadata(src), fs::metadata(dest)) else { return false };
    if !copy.is_file() || source.len() != copy.len() {
        return false;
    }
    let (Ok(source_time), Ok(copy_time)) = (source.modified(), copy.modified()) else { return false };
    copy_time.checked_add(MTIME_TOLERANCE).is_some_and(|copy_time| copy_time >= source_time)
}

/// Rewrites one absolute path that used to live under `old_root` so it
/// lives under `new_root` instead, applying `sanitize_component` to every
/// path segment past the root when `sanitize` is set (mirroring whatever
/// `copy_recursive` actually wrote to disk — see its call site in
/// `spawn_copy`). Returns `None` for a path that isn't under `old_root` at
/// all, which the caller then leaves untouched rather than guessing.
fn rebase_path(path: &str, old_root: &Path, new_root: &Path, sanitize: bool) -> Option<String> {
    let rel = Path::new(path).strip_prefix(old_root).ok()?;
    let mut result = new_root.to_path_buf();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => {
                result.push(if sanitize { sanitize_component(part) } else { part.to_os_string() });
            }
            other => result.push(other.as_os_str()),
        }
    }
    Some(result.to_string_lossy().to_string())
}

/// Makes a freshly copied project folder (backup or duplicate) independent
/// of the one it was copied from: `items.stored_path`/`thumbnail_path` are
/// stored as absolute paths (see `items::copy_and_thumbnail`), and so is
/// `diary_attachments.stored_path`, so without this the copy's own
/// database keeps pointing at the *original* project's
/// files — the copy only ever looks complete because the original is still
/// there. Opens (and only ever touches) the database inside `db_dir` — the
/// staging folder the copy is still being assembled in — and rebases every
/// path onto `dst`, the name that folder gets once complete. The source
/// project is never written to. `source_path`/`source_folder_path`
/// are left alone — they record where a file was imported *from*, outside
/// the project, not where it lives now.
pub fn rewrite_item_paths(db_dir: &Path, old_root: &Path, dst: &Path, sanitize: bool) -> Result<(), String> {
    let mut conn = crate::project::open_project_db(db_dir)?;
    let mut stmt = conn
        .prepare("SELECT id, stored_path, thumbnail_path FROM items")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    // Diary attachments keep their own absolute paths, separate from the
    // entry's row in `items` — left alone, a backup's attachments would keep
    // pointing at (and, once deleted there, be looked for in) the original.
    let mut stmt = conn
        .prepare("SELECT id, stored_path FROM diary_attachments")
        .map_err(|e| e.to_string())?;
    let attachments: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (id, stored_path, thumbnail_path) in rows {
        let new_stored = rebase_path(&stored_path, old_root, dst, sanitize).unwrap_or(stored_path);
        let new_thumbnail = thumbnail_path
            .as_deref()
            .and_then(|p| rebase_path(p, old_root, dst, sanitize))
            .or(thumbnail_path);
        tx.execute(
            "UPDATE items SET stored_path = ?1, thumbnail_path = ?2 WHERE id = ?3",
            rusqlite::params![new_stored, new_thumbnail, id],
        )
        .map_err(|e| e.to_string())?;
    }
    for (id, stored_path) in attachments {
        let Some(new_stored) = rebase_path(&stored_path, old_root, dst, sanitize) else { continue };
        tx.execute(
            "UPDATE diary_attachments SET stored_path = ?1 WHERE id = ?2",
            rusqlite::params![new_stored, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Runs a cancellable, progress-reporting recursive folder copy on a
/// background thread, emitting `copy-progress` events the frontend listens
/// to (filtered by `task_id`). Shared by the backup and the duplicate
/// feature so there's a single place handling cancellation/cleanup. The
/// project's own lock file is never copied, so a duplicate/backup never
/// looks falsely "already open".
///
/// Everything is assembled in `staging_path(dst)` and only renamed to `dst`
/// once complete, so a copy cut short never looks finished. The database
/// goes in first, as a consistent snapshot (`snapshot_database`): a file
/// imported while the copy runs is then at worst an extra file in the copy,
/// never a row pointing at a file that was not copied.
///
/// `on_success(app, staging, dst)` runs on the background thread once all
/// bytes are copied, still before the rename (e.g. to rewrite the paths in
/// the copy's database and name the duplicate) — a failure there is treated
/// the same as a copy failure and the staging folder is removed.
///
/// `after_rename(app, dst)` runs only once the copy sits at `dst` under its
/// final name — the place for anything that points other parts of the app
/// at it (the recent list), which must not happen for a copy that might
/// still fail to arrive.
#[allow(clippy::too_many_arguments)]
pub fn spawn_copy(
    app: AppHandle,
    task_id: String,
    kind: String,
    src: PathBuf,
    dst: PathBuf,
    cancel: Arc<AtomicBool>,
    on_success: impl FnOnce(&AppHandle, &Path, &Path) -> Result<(), String> + Send + 'static,
    after_rename: impl FnOnce(&AppHandle, &Path) + Send + 'static,
) {
    std::thread::spawn(move || {
        // "duplicate" must keep byte-identical paths — its database still
        // refers to them by relative path — so only "backup" sanitizes.
        let sanitize_names = kind == "backup";
        let staging = staging_path(&dst);
        let mut state = CopyState {
            app: &app,
            task_id: &task_id,
            kind: &kind,
            cancel: &cancel,
            dst_root: &staging,
            src_root: &src,
            sanitize_names,
            update_existing: false,
            copied_files: 0,
            copied_bytes: 0,
            total_files: 0,
            total_bytes: 0,
            last_emit: Instant::now(),
        };

        if let Err(e) = scan(&src, true, &mut state.total_files, &mut state.total_bytes) {
            state.emit("error", Some(crate::trf!("Konnte Quelle nicht lesen: {e}", e = e)), None);
            app.state::<CopyTasks>().unregister(&task_id);
            return;
        }

        // `create_dir`, not `create_dir_all`: it fails if the folder already
        // exists, so the cleanup below only ever removes a folder this copy
        // created itself — never a leftover or someone else's.
        if let Err(e) = fs::create_dir(&staging) {
            let message = if e.kind() == std::io::ErrorKind::AlreadyExists {
                crate::trf!(
                    "Ein unvollständiger früherer Versuch liegt noch unter „{path}“. Bitte diesen Ordner prüfen und löschen, dann erneut starten.",
                    path = staging.display()
                )
            } else {
                crate::trf!("Konnte den Zielordner nicht anlegen: {e}", e = e)
            };
            state.emit("error", Some(message), None);
            app.state::<CopyTasks>().unregister(&task_id);
            return;
        }
        state.emit("running", None, None);

        let outcome = snapshot_database(&src, &staging)
            .and_then(|_| copy_recursive(&src, &staging, &mut state).map_err(|e| crate::trf!("Kopieren fehlgeschlagen: {e}", e = e)))
            .and_then(|outcome| match outcome {
                CopyOutcome::Cancelled => Ok(CopyOutcome::Cancelled),
                CopyOutcome::Done => {
                    on_success(&app, &staging, &dst)?;
                    if dst.exists() {
                        return Err(crate::trf!("„{path}“ existiert inzwischen bereits.", path = dst.display()));
                    }
                    fs::rename(&staging, &dst).map_err(|e| crate::trf!("Konnte die fertige Kopie nicht umbenennen: {e}", e = e))?;
                    Ok(CopyOutcome::Done)
                }
            });

        match outcome {
            Ok(CopyOutcome::Done) => {
                after_rename(&app, &dst);
                state.emit("done", None, Some(dst.to_string_lossy().to_string()))
            }
            Ok(CopyOutcome::Cancelled) => {
                let _ = fs::remove_dir_all(&staging);
                state.emit("cancelled", None, None);
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                state.emit("error", Some(e), None);
            }
        }

        app.state::<CopyTasks>().unregister(&task_id);
    });
}

/// Brings an existing backup of the project up to date in place, instead of
/// writing a new full copy: files the backup lacks or holds in another size
/// or an older version are copied (see `is_up_to_date`), the rest is left.
/// Files only the backup still has stay — a file deleted from the stream
/// by mistake is then still in the backup.
///
/// The database snapshot is taken first, as in `spawn_copy`: a file imported
/// while the files are copied is then at worst an extra file in the backup,
/// never a row pointing at a file that was not copied. It is swapped in last
/// (see `swap_in_database`), so an update cut short leaves the backup's
/// previous database, which only refers to files that are all still there.
pub fn spawn_backup_update(app: AppHandle, task_id: String, src: PathBuf, backup: PathBuf, cancel: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut state = CopyState {
            app: &app,
            task_id: &task_id,
            kind: "backup",
            cancel: &cancel,
            dst_root: &backup,
            src_root: &src,
            sanitize_names: true,
            update_existing: true,
            copied_files: 0,
            copied_bytes: 0,
            total_files: 0,
            total_bytes: 0,
            last_emit: Instant::now(),
        };
        if let Err(e) = scan(&src, true, &mut state.total_files, &mut state.total_bytes) {
            state.emit("error", Some(crate::trf!("Konnte Quelle nicht lesen: {e}", e = e)), None);
            app.state::<CopyTasks>().unregister(&task_id);
            return;
        }
        state.emit("running", None, None);

        let new_db_dir = backup.join(".cronostream-update.partial");
        let outcome = prepare_update_database(&src, &new_db_dir)
            .and_then(|_| copy_recursive(&src, &backup, &mut state).map_err(|e| crate::trf!("Kopieren fehlgeschlagen: {e}", e = e)))
            .and_then(|outcome| match outcome {
                CopyOutcome::Cancelled => Ok(CopyOutcome::Cancelled),
                CopyOutcome::Done => swap_in_database(&src, &backup, &new_db_dir).map(|_| CopyOutcome::Done),
            });
        let _ = fs::remove_dir_all(&new_db_dir);

        match outcome {
            Ok(CopyOutcome::Done) => state.emit("done", None, Some(backup.to_string_lossy().to_string())),
            Ok(CopyOutcome::Cancelled) => state.emit("cancelled", None, None),
            Err(e) => state.emit("error", Some(e), None),
        }
        app.state::<CopyTasks>().unregister(&task_id);
    });
}

/// Where an update keeps the backup database it replaced, beside the new
/// one: a folder picked by mistake (an independently continued duplicate,
/// say) can be put back from it. One copy, overwritten by the next update,
/// named after the database: `cronostream.db.vor-aktualisierung`.
pub const PREVIOUS_DATABASE_SUFFIX: &str = ".vor-aktualisierung";

fn previous_database(backup: &Path) -> PathBuf {
    backup.join(format!("{}{PREVIOUS_DATABASE_SUFFIX}", crate::project::DB_FILENAME))
}

/// First step of `spawn_backup_update`: the snapshot of the project's
/// database, taken before any file is copied.
fn prepare_update_database(src: &Path, new_db_dir: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(new_db_dir);
    fs::create_dir(new_db_dir).map_err(|e| crate::trf!("Konnte den Zielordner nicht anlegen: {e}", e = e))?;
    snapshot_database(src, new_db_dir)
}

/// Last step of `spawn_backup_update`, once every file is copied: the
/// snapshot, with its paths rebased onto the backup, replaces the backup's
/// database by a rename. The one it replaces is kept as `previous_database`.
fn swap_in_database(src: &Path, backup: &Path, new_db_dir: &Path) -> Result<(), String> {
    rewrite_item_paths(new_db_dir, src, backup, true)?;
    // A backup still under the LifeStream name gets the new one first, so
    // the snapshot replaces its database instead of landing beside it.
    // `checked_target` has made sure no one has the backup open.
    crate::project::adopt_legacy_db(backup);
    let replaced = crate::project::db_path(backup);
    if replaced.exists() {
        // A journal or write-ahead log the replaced database left behind
        // would otherwise be played back into the snapshot that takes its
        // name, and the kept copy would lack what they hold.
        if !crate::project::settle_side_files(&replaced) {
            return Err(crate::i18n::tr(
                "Die bisherige Datenbank der Sicherung hat noch nicht abgeschlossene Änderungen und lässt sich nicht ersetzen. Die Dateien sind aktualisiert, die Datenbank der Sicherung ist unverändert.",
            )
            .into());
        }
        crate::safe_io::copy_durably(&replaced, &previous_database(backup))
            .map_err(|e| crate::trf!("Konnte die bisherige Datenbank der Sicherung nicht aufbewahren: {e}", e = e))?;
    }
    let current = backup.join(crate::project::DB_FILENAME);
    fs::rename(new_db_dir.join(crate::project::DB_FILENAME), &current).map_err(|e| crate::trf!("Konnte die fertige Kopie nicht umbenennen: {e}", e = e))?;
    crate::safe_io::sync_dir(backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn an_update_swaps_in_the_snapshot_and_keeps_the_replaced_database() {
        let root = scratch();
        let src = root.join("CS");
        let backup = root.join("Sicherung");
        for (dir, id) in [(&src, "neu"), (&backup, "alt")] {
            fs::create_dir_all(dir).unwrap();
            let conn = crate::project::open_project_db(dir).unwrap();
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
                 VALUES (?1, 'a.jpg', ?2, 'image', '2020-01-01T00:00:00Z', 'exif', '2020-01-01T00:00:00Z')",
                rusqlite::params![id, dir.join("originals/2020/01/a.jpg").to_string_lossy()],
            )
            .unwrap();
        }
        let rows = |db: &Path| -> Vec<(String, String)> {
            let conn = rusqlite::Connection::open(db).unwrap();
            let mut stmt = conn.prepare("SELECT id, stored_path FROM items").unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };

        let staging = backup.join(".cronostream-update.partial");
        prepare_update_database(&src, &staging).unwrap();
        swap_in_database(&src, &backup, &staging).unwrap();

        let expected = backup.join("originals/2020/01/a.jpg").to_string_lossy().into_owned();
        assert_eq!(rows(&crate::project::db_path(&backup)), vec![("neu".to_string(), expected)]);
        assert_eq!(rows(&previous_database(&backup))[0].0, "alt");
        fs::remove_dir_all(&root).ok();
    }

    /// A stream, and a backup of it, still under the LifeStream name: the
    /// snapshot is taken from the old file, and afterwards the backup holds
    /// one database, under the new name, with the replaced one kept.
    #[test]
    fn a_lifestream_named_database_is_snapshotted_and_replaced_in_a_backup() {
        let root = scratch();
        let src = root.join("CS");
        let backup = root.join("Sicherung");
        for (dir, id) in [(&src, "neu"), (&backup, "alt")] {
            fs::create_dir_all(dir).unwrap();
            let conn = crate::project::open_project_db(dir).unwrap();
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
                 VALUES (?1, 'a.jpg', ?2, 'image', '2020-01-01T00:00:00Z', 'exif', '2020-01-01T00:00:00Z')",
                rusqlite::params![id, dir.join("originals/2020/01/a.jpg").to_string_lossy()],
            )
            .unwrap();
            drop(conn);
            let db = crate::project::DB_FILENAME;
            let legacy = crate::project::LEGACY_DB_FILENAME;
            fs::rename(dir.join(db), dir.join(legacy)).unwrap();
            fs::write(dir.join(LEGACY_LOCK_FILENAME), "999999999").unwrap();
        }

        let staging = backup.join(".cronostream-update.partial");
        prepare_update_database(&src, &staging).unwrap();
        swap_in_database(&src, &backup, &staging).unwrap();

        assert!(src.join(crate::project::LEGACY_DB_FILENAME).is_file(), "the source keeps its name");
        assert!(!backup.join(crate::project::LEGACY_DB_FILENAME).exists());
        assert!(!backup.join(LEGACY_LOCK_FILENAME).exists());
        let conn = rusqlite::Connection::open(backup.join(crate::project::DB_FILENAME)).unwrap();
        let id: String = conn.query_row("SELECT id FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(id, "neu");
        let previous = rusqlite::Connection::open(previous_database(&backup)).unwrap();
        let id: String = previous.query_row("SELECT id FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(id, "alt");
        fs::remove_dir_all(&root).ok();
    }

    /// A crash left a journal beside the backup's database: it is played
    /// back into the replaced database, never into the snapshot.
    #[test]
    fn a_journal_left_in_a_backup_does_not_reach_the_new_database() {
        let root = scratch();
        let src = root.join("CS");
        let backup = root.join("Sicherung");
        for dir in [&src, &backup] {
            fs::create_dir_all(dir).unwrap();
            drop(crate::project::open_project_db(dir).unwrap());
        }
        // A real hot journal: a transaction cut off after it reached the
        // database file, simulated by copying both files mid-transaction.
        let db = backup.join(crate::project::DB_FILENAME);
        let mut name = db.as_os_str().to_os_string();
        name.push("-journal");
        let journal = PathBuf::from(name);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA cache_size = 1; BEGIN; CREATE TABLE abgebrochen (v BLOB);").unwrap();
        for _ in 0..200 {
            conn.execute("INSERT INTO abgebrochen VALUES (randomblob(4000))", []).unwrap();
        }
        assert!(journal.exists());
        let frozen = root.join("frozen");
        fs::create_dir_all(&frozen).unwrap();
        fs::copy(&db, frozen.join("db")).unwrap();
        fs::copy(&journal, frozen.join("journal")).unwrap();
        drop(conn);
        fs::copy(frozen.join("db"), &db).unwrap();
        fs::copy(frozen.join("journal"), &journal).unwrap();

        let staging = backup.join(".cronostream-update.partial");
        prepare_update_database(&src, &staging).unwrap();
        swap_in_database(&src, &backup, &staging).unwrap();

        assert!(!journal.exists());
        let conn = rusqlite::Connection::open(&db).unwrap();
        let cut_off: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'abgebrochen'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cut_off, 0);
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_backup_copy_counts_as_up_to_date_only_with_same_size_and_not_older() {
        let root = scratch();
        let src = root.join("a.jpg");
        let copy = root.join("b.jpg");
        fs::write(&src, b"12345").unwrap();
        assert!(!is_up_to_date(&src, &copy), "missing copy");
        fs::write(&copy, b"12345").unwrap();
        assert!(is_up_to_date(&src, &copy), "written after the source");
        fs::write(&copy, b"1234").unwrap();
        assert!(!is_up_to_date(&src, &copy), "other size");
        fs::write(&copy, b"12345").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        fs::File::options().write(true).open(&src).unwrap().set_modified(later).unwrap();
        assert!(!is_up_to_date(&src, &copy), "source changed since");
        // The source's own time, rounded down by a FAT/exFAT stick.
        let rounded = later - std::time::Duration::from_millis(1500);
        fs::File::options().write(true).open(&copy).unwrap().set_modified(rounded).unwrap();
        assert!(is_up_to_date(&src, &copy), "a copy keeping its source's time on a coarse stick");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_destination_next_to_the_source_is_fine() {
        let root = scratch();
        let src = root.join("Projekt");
        let elsewhere = root.join("Sicherungen");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();

        assert!(ensure_destination_outside_source(&src, &elsewhere.join("Projekt-Backup-2026")).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_destination_inside_the_source_is_refused() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(&src).unwrap();

        let err = ensure_destination_outside_source(&src, &src.join("Projekt-Backup-2026")).unwrap_err();
        assert!(err.contains("im Quellordner selbst"), "{err}");
        fs::remove_dir_all(&root).ok();
    }

    /// The same mistake one level down — picking `originals/` as the place
    /// to put the backup rather than the project folder itself.
    #[test]
    fn a_destination_deeper_inside_the_source_is_refused() {
        let root = scratch();
        let src = root.join("Projekt");
        let inside = src.join("originals").join("2024");
        fs::create_dir_all(&inside).unwrap();

        assert!(ensure_destination_outside_source(&src, &inside.join("Backup")).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_source_folder_itself_is_refused() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(&src).unwrap();

        assert!(ensure_destination_outside_source(&src, &src).is_err());
        fs::remove_dir_all(&root).ok();
    }

    /// A destination that only *looks* outside: resolving it is what shows
    /// it reaches back into the project.
    #[cfg(unix)]
    #[test]
    fn a_destination_symlinked_into_the_source_is_refused() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(&src).unwrap();
        let link = root.join("sieht-harmlos-aus");
        std::os::unix::fs::symlink(&src, &link).unwrap();

        let err = ensure_destination_outside_source(&src, &link.join("Backup")).unwrap_err();
        assert!(err.contains("im Quellordner selbst"), "{err}");
        fs::remove_dir_all(&root).ok();
    }

    /// Not a silent pass: a destination whose parent doesn't exist says so,
    /// rather than skipping the check because it couldn't be resolved.
    #[test]
    fn an_unresolvable_destination_is_refused_rather_than_waved_through() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(&src).unwrap();

        let err = ensure_destination_outside_source(&src, &root.join("gibt-es-nicht").join("Backup")).unwrap_err();
        assert!(err.contains("existiert nicht"), "{err}");
        fs::remove_dir_all(&root).ok();
    }

    /// A trailing `..` is a spelling, not a location — what matters is where
    /// the path lands once resolved.
    #[test]
    fn a_roundabout_spelling_is_judged_by_where_it_lands() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(src.join("originals")).unwrap();

        // .../Projekt/originals/.. IS the project folder.
        let back_inside = src.join("originals").join("..").join("Backup");
        assert!(ensure_destination_outside_source(&src, &back_inside).is_err());

        // .../Projekt/.. is the folder above it, which is a fine place.
        let back_outside = src.join("..").join("Backup");
        assert!(ensure_destination_outside_source(&src, &back_outside).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    fn insert_item(conn: &rusqlite::Connection, id: &str, stored_path: &str, thumbnail_path: Option<&str>) {
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES (?1, 'x.jpg', ?2, ?3, 'image',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            rusqlite::params![id, stored_path, thumbnail_path],
        )
        .unwrap();
    }

    /// The case that sent us down this path in the first place: an email
    /// subject line in the filename (`Re: ...`) is fine on the source
    /// filesystem but invalid on the exFAT/NTFS drive a backup usually
    /// lands on. `rewrite_item_paths(..., sanitize = true)` must leave the
    /// copy's own database pointing at the name `copy_recursive` actually
    /// wrote, not the original one.
    #[test]
    fn backup_rewrite_rebases_the_root_and_sanitizes_reserved_characters() {
        let root = scratch();
        let old_root = root.join("Projekt");
        let new_root = root.join("Projekt-Backup-2026");
        fs::create_dir_all(&new_root).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        insert_item(
            &conn,
            "a",
            &old_root.join("originals/2003/04/Re: Hallo.eml").to_string_lossy(),
            Some(&old_root.join("thumbnails/2003/04/a.jpg").to_string_lossy()),
        );
        drop(conn);

        rewrite_item_paths(&new_root, &old_root, &new_root, true).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        let (stored, thumb): (String, String) = conn
            .query_row("SELECT stored_path, thumbnail_path FROM items WHERE id = 'a'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(stored, new_root.join("originals/2003/04/Re_ Hallo.eml").to_string_lossy());
        assert_eq!(thumb, new_root.join("thumbnails/2003/04/a.jpg").to_string_lossy());
        fs::remove_dir_all(&root).ok();
    }

    /// "Projekt duplizieren" must leave filenames byte-identical — only the
    /// project-root prefix changes — since nothing on disk was renamed.
    #[test]
    fn duplicate_rewrite_rebases_the_root_without_touching_filenames() {
        let root = scratch();
        let old_root = root.join("Projekt");
        let new_root = root.join("Projekt-Kopie");
        fs::create_dir_all(&new_root).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        insert_item(
            &conn,
            "a",
            &old_root.join("originals/2003/04/Re: Hallo.eml").to_string_lossy(),
            None,
        );
        drop(conn);

        rewrite_item_paths(&new_root, &old_root, &new_root, false).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        let stored: String = conn
            .query_row("SELECT stored_path FROM items WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, new_root.join("originals/2003/04/Re: Hallo.eml").to_string_lossy());
        fs::remove_dir_all(&root).ok();
    }

    /// A diary entry's attachments live in their own table with their own
    /// absolute paths; a backup must rebase (and sanitize) those too, or
    /// the backup's attachments keep pointing at the original project.
    #[test]
    fn backup_rewrite_also_rebases_diary_attachments() {
        let root = scratch();
        let old_root = root.join("Projekt");
        let new_root = root.join("Projekt-Backup-2026");
        fs::create_dir_all(&new_root).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        insert_item(&conn, "d1", &old_root.join("diary/d1/entry.txt").to_string_lossy(), None);
        conn.execute(
            "INSERT INTO diary_attachments (id, diary_id, original_filename, stored_path, file_type, position, added_at)
             VALUES ('att', 'd1', 'Re: Foto.jpg', ?1, 'image', 0, '2024-01-01T00:00:00+00:00')",
            rusqlite::params![old_root.join("diary/d1/anhang/Re: Foto.jpg").to_string_lossy()],
        )
        .unwrap();
        drop(conn);

        rewrite_item_paths(&new_root, &old_root, &new_root, true).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        let stored: String = conn
            .query_row("SELECT stored_path FROM diary_attachments WHERE id = 'att'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, new_root.join("diary/d1/anhang/Re_ Foto.jpg").to_string_lossy());
        fs::remove_dir_all(&root).ok();
    }

    /// The database reaches a backup as one consistent snapshot, not as a
    /// raw file copy — and a file named like it deeper inside the project
    /// (an imported `cronostream.db`) is still ordinary content.
    #[test]
    fn the_database_is_snapshotted_and_only_skipped_at_the_root() {
        let root = scratch();
        let src = root.join("Projekt");
        fs::create_dir_all(&src).unwrap();
        let conn = crate::project::open_project_db(&src).unwrap();
        insert_item(&conn, "a", "/x/a.jpg", None);
        let staging = root.join("Kopie.partial");
        fs::create_dir(&staging).unwrap();

        snapshot_database(&src, &staging).unwrap();
        drop(conn);

        let copy = rusqlite::Connection::open(crate::project::db_path(&staging)).unwrap();
        let count: i64 = copy.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);

        assert!(is_database_file(std::ffi::OsStr::new("cronostream.db")));
        assert!(is_database_file(std::ffi::OsStr::new("cronostream.db-journal")));
        assert!(!is_database_file(std::ffi::OsStr::new("cronostream.db.jpg")));
        assert!(is_database_file(std::ffi::OsStr::new("lifestream.db")));
        assert!(is_database_file(std::ffi::OsStr::new("lifestream.db-wal")));
        assert!(should_skip(std::ffi::OsStr::new(".lifestream.lock")));
        let (mut files, mut bytes) = (0, 0);
        fs::create_dir_all(src.join("originals")).unwrap();
        fs::write(src.join("originals/cronostream.db"), b"importiert").unwrap();
        scan(&src, true, &mut files, &mut bytes).unwrap();
        assert_eq!(files, 1, "only the imported file deeper down counts");
        fs::remove_dir_all(&root).ok();
    }

    /// A path that was never under `old_root` (shouldn't happen, but
    /// defensive) is left exactly as it was rather than mangled.
    #[test]
    fn a_path_outside_old_root_is_left_untouched() {
        let root = scratch();
        let old_root = root.join("Projekt");
        let new_root = root.join("Projekt-Backup-2026");
        fs::create_dir_all(&new_root).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        insert_item(&conn, "a", "/anderswo/komplett/ausserhalb.jpg", None);
        drop(conn);

        rewrite_item_paths(&new_root, &old_root, &new_root, true).unwrap();

        let conn = crate::project::open_project_db(&new_root).unwrap();
        let stored: String = conn
            .query_row("SELECT stored_path FROM items WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, "/anderswo/komplett/ausserhalb.jpg");
        fs::remove_dir_all(&root).ok();
    }
}
