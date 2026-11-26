//! Copying — or moving — items from the open stream into another one.
//!
//! The default is still a copy: the source project is not modified at all,
//! which is the same principle that applies to the user's original files
//! everywhere else in the app. The target gets a normal import entry in its
//! own action log, so the transfer is undoable there like any other import.
//!
//! **Moving was added 2026-10-17 as a second, opt-in mode** (`move_mode`),
//! not as a replacement — the user asked for both buttons in
//! "Datei-Operationen". It is deliberately built as "copy, then remove the
//! source the ordinary way" rather than as a distinct operation: the source
//! side goes through `timeline_commands::remove_items_by_ids`, so a move
//! leaves the source in the Papierkorb with a normal undoable Remove entry
//! instead of destroying anything. Only items that actually arrived in the
//! target are removed, so a half-failed move never loses the files it
//! could not copy. Nothing about the user's originals outside either
//! project folder changes on this path either.
//!
//! An item travels with everything that belongs to it: its note (which also
//! carries the private-mode marker) and, for a diary entry, its text and
//! every attachment. The item row, the note and the attachment rows are
//! written in one transaction, and the files are cleaned up again if that
//! fails — so "arrived" always means all of it, and a move never removes a
//! source item whose note or attachments are missing in the target.
//!
//! The target is a *second* project database, opened just for the duration
//! of the transfer. That is the one place in the app where two project
//! databases are open at once, so the rules are worth stating:
//!   * the target must not be the project that is currently open (there is
//!     no sense in copying a project into itself, and it would mean two
//!     connections to one file);
//!   * if another live instance holds the target's lock, the transfer is
//!     refused rather than risking two writers;
//!   * the target's lock is deliberately *not* acquired. Acquiring it would
//!     mean a failed transfer could leave behind a lock owned by this still
//!     running process, which the staleness check cannot clear — the
//!     project would stay unopenable until the app is restarted. Refusing
//!     on an active lock covers the case that actually matters.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::action_log::{self, ActionType, LogEntry};
use crate::items;
use crate::lock::{self, LockState};
use crate::project;
use crate::recent;
use crate::schema::LIVE_ITEMS;
use crate::state::AppStateHandle;

const TRANSFER_PROGRESS_EVENT: &str = "transfer-progress";

#[derive(Serialize, Clone)]
struct TransferProgress {
    done: usize,
    total: usize,
    current: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferSkipped {
    /// The item's id in the *source* project, so the UI can mark exactly
    /// the files that stayed behind.
    pub item_id: String,
    pub label: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub transferred: usize,
    pub skipped: Vec<TransferSkipped>,
    /// The target's display name, for the summary message.
    pub target_name: String,
    /// How many source items were taken off this project's timeline
    /// afterwards — always 0 for a plain copy. Reported separately from
    /// `transferred` because the two can differ: a file skipped as already
    /// present in the target is not removed here.
    pub removed_from_source: usize,
}

/// Everything needed to recreate one item in the target project. Read out
/// of the source database up front so the (slow) copying never holds a
/// statement open on it.
struct SourceItem {
    /// The item's id in the *source* project — only needed by `move_mode`,
    /// which has to remove exactly those items that made it across.
    id: String,
    original_filename: String,
    stored_path: String,
    thumbnail_path: Option<String>,
    file_type: String,
    display_name: Option<String>,
    resolved_timestamp: String,
    timestamp_source: String,
    fs_created_at: Option<String>,
    fs_modified_at: Option<String>,
    embedded_metadata_at: Option<String>,
    source_path: Option<String>,
    source_folder_path: Option<String>,
    video_frame_percent: Option<f64>,
    extracted_text: Option<String>,
    file_size_bytes: Option<i64>,
    rotation: i32,
    email_subject: Option<String>,
    email_sender: Option<String>,
    email_date: Option<String>,
    /// The item's note, if it has one.
    note: Option<String>,
    /// A diary entry's attached files, in their order; empty for any other
    /// item.
    attachments: Vec<SourceAttachment>,
}

/// One row of `diary_attachments` in the source.
struct SourceAttachment {
    original_filename: String,
    stored_path: String,
    file_type: String,
    position: i64,
    added_at: String,
}

impl SourceItem {
    fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.original_filename)
    }

    fn is_diary(&self) -> bool {
        self.file_type == crate::diary::DIARY_KIND
    }
}

/// A stream the open one can be copied into: an existing project folder
/// that isn't the open project itself.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferTarget {
    pub path: String,
    pub name: String,
    pub item_count: i64,
    /// True when another running instance has this project open, so the
    /// transfer would be refused — the UI can say so before the attempt.
    pub busy: bool,
}

/// Validates a folder as a transfer target and reports what is in it, so the
/// UI can confirm "copy 12 files into ‚Urlaube' (430 files)" rather than just
/// a path. Used by `list_transfer_targets` to build the whole pick list.
fn inspect_target(target_path: &Path, current_path: &Path) -> Result<TransferTarget, String> {
    if !project::is_project_folder(target_path) {
        return Err(crate::i18n::tr("In diesem Ordner liegt kein Stream.").to_string());
    }
    if same_folder(target_path, current_path) {
        return Err(crate::i18n::tr("Das ist der gerade geöffnete Stream. Bitte einen anderen wählen.").to_string());
    }

    let conn = project::open_project_db(target_path)?;
    let info = project::project_info(&conn, target_path);
    let item_count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM items WHERE {LIVE_ITEMS}"), [], |row| row.get(0))
        .unwrap_or(0);

    Ok(TransferTarget {
        path: info.path,
        name: info.name,
        item_count,
        busy: matches!(lock::check(target_path), LockState::Active { .. }),
    })
}

/// The streams the open one could be copied into — the same list the
/// start screen shows as "recent", minus the open project itself and any
/// entry that no longer resolves to a real stream folder (moved,
/// renamed outside the app, or deleted). Picking a target is then choosing
/// from this list rather than browsing the filesystem, so the user can't
/// point the copy at an unrelated folder by mistake.
#[tauri::command(async)]
pub fn list_transfer_targets(app: AppHandle, state: tauri::State<AppStateHandle>) -> Result<Vec<TransferTarget>, String> {
    // Only the open project's path is needed from the lock; opening every
    // other stream's database below must not keep it held.
    let current_path = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.path.clone()
    };

    Ok(recent::load_recent(&app)
        .into_iter()
        .filter_map(|entry| inspect_target(&PathBuf::from(&entry.path), &current_path).ok())
        .collect())
}

/// Creates a brand-new, empty stream to use as a transfer target without
/// opening it: the open project stays active. The new one is entered into the
/// recent list, so it is the same kind of app-verified target as every other
/// entry of `list_transfer_targets`.
#[tauri::command(async)]
pub fn create_transfer_target(app: AppHandle, name: String, parent_path: String) -> Result<TransferTarget, String> {
    let project_path = project::create_project_in(&PathBuf::from(parent_path), &name)?;
    let conn = project::open_project_db(&project_path)?;
    let info = project::project_info(&conn, &project_path);
    recent::touch_recent(&app, &info.path, &info.name)?;

    Ok(TransferTarget { path: info.path, name: info.name, item_count: 0, busy: false })
}

/// Compares two project folders by their canonical paths, so the same
/// project reached by different spellings (a symlink, a trailing slash, a
/// relative path) is still recognised as the same one.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        // A path that can't be canonicalized doesn't exist; falling back to
        // a literal comparison is the conservative answer.
        _ => a == b,
    }
}

/// Copies — or, with `move_mode`, moves — the given items of the open
/// stream into another one. See the module docs for why a move is
/// expressed as a copy followed by the ordinary soft removal.
#[tauri::command]
pub async fn transfer_items(
    app: AppHandle,
    target_path: String,
    item_ids: Vec<String>,
    move_mode: Option<bool>,
    include_duplicates: Option<bool>,
) -> Result<TransferResult, String> {
    let include_duplicates = include_duplicates.unwrap_or(false);
    // Copying originals and thumbnails is plain file I/O, and a transfer
    // can easily be hundreds of files — same reasoning as `add_items`.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let item_ids = crate::privacy::without_hidden(&state, item_ids, crate::privacy::Surface::Everywhere)?;

        // The state lock covers only these checks and reading the source
        // rows, plus the final removal of a move — not the copying in
        // between, which goes through the target's own connection.
        let target = PathBuf::from(&target_path);
        let (project_path, sources) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

            if !project::is_project_folder(&target) {
                return Err(crate::i18n::tr("In diesem Ordner liegt kein Stream.").to_string());
            }
            if same_folder(&target, &current.path) {
                return Err(crate::i18n::tr("Das ist der gerade geöffnete Stream. Bitte einen anderen wählen.").to_string());
            }
            if let LockState::Active { .. } = lock::check(&target) {
                return Err(
                    crate::i18n::tr("Dieser Stream ist gerade in einem anderen Fenster geöffnet und muss dort zuerst geschlossen werden.")
                        .to_string(),
                );
            }
            if item_ids.is_empty() {
                return Err(crate::i18n::tr("Es ist nichts ausgewählt.").to_string());
            }

            (current.path.clone(), read_source_items(&current.conn, &item_ids)?)
        };
        let target_conn = project::open_project_db(&target)?;
        let target_name = project::project_info(&target_conn, &target).name;

        let batch_id = if sources.len() > 1 {
            Some(Uuid::new_v4().to_string())
        } else {
            None
        };

        let total = sources.len();
        let mut skipped = Vec::new();
        let mut log_entries = Vec::new();
        // Only the items whose files *and* row actually landed in the
        // target — a move must never remove the source of a file that
        // didn't make it across.
        let mut arrived_source_ids: Vec<String> = Vec::new();

        for (index, item) in sources.iter().enumerate() {
            let _ = app.emit(
                TRANSFER_PROGRESS_EVENT,
                TransferProgress { done: index, total, current: item.label().to_string() },
            );

            // Same rule as a normal import — the same source file does not
            // go into one stream twice — extended by a content
            // comparison. Skipped when the user chose "Trotzdem kopieren"
            // in the dialog that `preview_transfer_duplicates` feeds.
            if !include_duplicates {
                if let Some(found) = find_duplicate_in_target(&target_conn, item) {
                    skipped.push(TransferSkipped {
                        item_id: item.id.clone(),
                        label: item.label().to_string(),
                        reason: found.reason(),
                    });
                    continue;
                }
            }

            match transfer_one(&target, &target_conn, item, batch_id.as_deref()) {
                Ok(new_id) => {
                    log_entries.push(LogEntry::presence(&new_id, &item.original_filename));
                    arrived_source_ids.push(item.id.clone());
                }
                Err(reason) => skipped.push(TransferSkipped { item_id: item.id.clone(), label: item.label().to_string(), reason }),
            }
        }

        // Logged in the *target*, as a normal import — that is where
        // something actually changed, and it makes the transfer undoable
        // over there like any other import. For a plain copy nothing is
        // logged in the source, because nothing happened to it.
        if !log_entries.is_empty() {
            let _ = action_log::record(&target_conn, ActionType::Import, &log_entries);
        }

        // The second half of a move, and only now that the copies are
        // confirmed: the ordinary bulk removal, which logs one undoable
        // Remove in *this* project and leaves the items in its Papierkorb.
        // So an unwanted move is reversible from both ends — undo the
        // import in the target, restore from the Papierkorb here.
        let removed_from_source = if move_mode.unwrap_or(false) && !arrived_source_ids.is_empty() {
            let guard = crate::state::lock_project(&state, &project_path)?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            crate::timeline_commands::remove_items_by_ids(&current.conn, &current.path, &arrived_source_ids, |_, _, _| {})?
        } else {
            0
        };

        let _ = app.emit(
            TRANSFER_PROGRESS_EVENT,
            TransferProgress { done: total, total, current: String::new() },
        );

        Ok(TransferResult { transferred: log_entries.len(), skipped, target_name, removed_from_source })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// What the target already holds that matches a source item.
struct DuplicateMatch {
    /// Display name of the item in the target.
    existing_name: String,
    /// False: same original source path. True: same content, found by size
    /// plus fingerprint and confirmed with a full hash.
    by_content: bool,
}

impl DuplicateMatch {
    fn reason(&self) -> String {
        if self.by_content {
            crate::trf!("Gleicher Inhalt ist dort schon vorhanden: {name}", name = self.existing_name)
        } else {
            crate::i18n::tr("Ist dort schon vorhanden.").to_string()
        }
    }
}

/// Looks for a live item in the target that is the same file as `item`:
/// first by original source path (free), then by content. The content
/// comparison only looks at target items of the same size; their
/// fingerprints are computed and cached now if they are missing (older
/// projects, or ingest with the quick hash switched off), and a fingerprint
/// match is confirmed with a full BLAKE3 hash, since the fingerprint only
/// samples the start and end of a file.
fn find_duplicate_in_target(conn: &Connection, item: &SourceItem) -> Option<DuplicateMatch> {
    // A diary entry has no source file and deliberately no size (see
    // `diary.rs`), so neither check below fits. The same entry is one with
    // the same text at the same moment.
    if item.is_diary() {
        let existing: Option<String> = conn
            .query_row(
                &format!(
                    "SELECT original_filename FROM items
                     WHERE file_type = ?1 AND resolved_timestamp = ?2 AND COALESCE(extracted_text, '') = ?3
                       AND {LIVE_ITEMS} LIMIT 1"
                ),
                params![crate::diary::DIARY_KIND, item.resolved_timestamp, item.extracted_text.as_deref().unwrap_or("")],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        return existing.map(|existing_name| DuplicateMatch { existing_name, by_content: false });
    }

    if let Some(source_path) = &item.source_path {
        let existing: Option<String> = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(display_name, original_filename) FROM items
                     WHERE source_path = ?1 AND {LIVE_ITEMS} LIMIT 1"
                ),
                params![source_path],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(existing_name) = existing {
            return Some(DuplicateMatch { existing_name, by_content: false });
        }
    }

    let source_file = Path::new(&item.stored_path);
    let size = match item.file_size_bytes {
        Some(size) => size,
        None => std::fs::metadata(source_file).ok()?.len() as i64,
    };
    let candidates: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, stored_path, COALESCE(display_name, original_filename) FROM items
                 WHERE file_size_bytes = ?1 AND {LIVE_ITEMS}"
            ))
            .ok()?;
        let rows = stmt
            .query_map(params![size], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .ok()?;
        rows.flatten().collect()
    };
    if candidates.is_empty() {
        return None;
    }

    let source_quick = crate::duplicate_hash::quick_hash(source_file).ok()?;
    let mut source_full: Option<String> = None;
    for (id, stored_path, name) in candidates {
        let candidate_file = Path::new(&stored_path);
        if crate::duplicate_hash::ensure_item_quick_hash(conn, &id, candidate_file) != Some(source_quick) {
            continue;
        }
        if source_full.is_none() {
            source_full = Some(crate::duplicate_hash::blake3_hash(source_file).ok()?);
        }
        if crate::duplicate_hash::blake3_hash(candidate_file).ok() == source_full {
            return Some(DuplicateMatch { existing_name: name, by_content: true });
        }
    }
    None
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferDuplicate {
    pub item_id: String,
    pub label: String,
    /// The matching item in the target.
    pub existing_name: String,
    pub by_content: bool,
}

/// Which of the given items the target already has — the question the
/// dialog asks before anything is copied. Same checks as the transfer
/// itself, so "skip duplicates" skips exactly what is listed here.
#[tauri::command]
pub async fn preview_transfer_duplicates(
    app: AppHandle,
    target_path: String,
    item_ids: Vec<String>,
) -> Result<Vec<TransferDuplicate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let item_ids = crate::privacy::without_hidden(&state, item_ids, crate::privacy::Surface::Everywhere)?;
        let target = PathBuf::from(&target_path);
        let sources = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            if !project::is_project_folder(&target) {
                return Err(crate::i18n::tr("In diesem Ordner liegt kein Stream.").to_string());
            }
            if same_folder(&target, &current.path) {
                return Err(crate::i18n::tr("Das ist der gerade geöffnete Stream. Bitte einen anderen wählen.").to_string());
            }
            read_source_items(&current.conn, &item_ids)?
        };
        let target_conn = project::open_project_db(&target)?;
        Ok(sources
            .iter()
            .filter_map(|item| {
                find_duplicate_in_target(&target_conn, item).map(|found| TransferDuplicate {
                    item_id: item.id.clone(),
                    label: item.label().to_string(),
                    existing_name: found.existing_name,
                    by_content: found.by_content,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

fn read_source_items(conn: &Connection, item_ids: &[String]) -> Result<Vec<SourceItem>, String> {
    let mut items = Vec::new();
    for id in item_ids {
        let found = conn
            .query_row(
                &format!(
                    "SELECT original_filename, stored_path, thumbnail_path, file_type, display_name,
                            resolved_timestamp, timestamp_source, fs_created_at, fs_modified_at,
                            embedded_metadata_at, source_path, source_folder_path,
                            video_frame_percent, extracted_text, file_size_bytes, rotation,
                            email_subject, email_sender, email_date
                     FROM items WHERE id = ?1 AND {LIVE_ITEMS}"
                ),
                params![id],
                |row| {
                    Ok(SourceItem {
                        id: id.clone(),
                        original_filename: row.get(0)?,
                        stored_path: row.get(1)?,
                        thumbnail_path: row.get(2)?,
                        file_type: row.get(3)?,
                        display_name: row.get(4)?,
                        resolved_timestamp: row.get(5)?,
                        timestamp_source: row.get(6)?,
                        fs_created_at: row.get(7)?,
                        fs_modified_at: row.get(8)?,
                        embedded_metadata_at: row.get(9)?,
                        source_path: row.get(10)?,
                        source_folder_path: row.get(11)?,
                        video_frame_percent: row.get(12)?,
                        extracted_text: row.get(13)?,
                        file_size_bytes: row.get(14)?,
                        rotation: row.get(15)?,
                        email_subject: row.get(16)?,
                        email_sender: row.get(17)?,
                        email_date: row.get(18)?,
                        note: None,
                        attachments: Vec::new(),
                    })
                },
            )
            .ok();
        let Some(mut item) = found else { continue };

        // Errors here fail the whole call rather than quietly dropping the
        // note or an attachment: a move would otherwise remove a source
        // item whose parts never went across.
        item.note = conn
            .query_row("SELECT text FROM notes WHERE item_id = ?1", params![id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if item.is_diary() {
            let mut stmt = conn
                .prepare(
                    "SELECT original_filename, stored_path, file_type, position, added_at
                     FROM diary_attachments WHERE diary_id = ?1 ORDER BY position",
                )
                .map_err(|e| e.to_string())?;
            item.attachments = stmt
                .query_map(params![id], |row| {
                    Ok(SourceAttachment {
                        original_filename: row.get(0)?,
                        stored_path: row.get(1)?,
                        file_type: row.get(2)?,
                        position: row.get(3)?,
                        added_at: row.get(4)?,
                    })
                })
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                .map_err(|e| e.to_string())?;
        }
        items.push(item);
    }
    Ok(items)
}

/// Copies one item with all its parts into the target and returns its new
/// id there. On any failure nothing of it is left behind in the target: the
/// files are removed again and no row was committed.
fn transfer_one(target: &Path, conn: &Connection, item: &SourceItem, batch_id: Option<&str>) -> Result<String, String> {
    let new_id = Uuid::new_v4().to_string();
    let copied = copy_into(target, item, &new_id)?;
    if let Err(reason) = insert_into(conn, &new_id, item, &copied, batch_id) {
        // The rows are what make the copy part of the project; without
        // them the files would just sit there unreferenced.
        copied.remove();
        return Err(reason);
    }
    Ok(new_id)
}

/// The files written into the target, so they can be cleaned up again if
/// the database rows that should reference them fail to be written.
struct CopiedFiles {
    stored: PathBuf,
    thumbnail: Option<PathBuf>,
    /// A diary entry's own folder in the target, `diary/<new id>/` — removed
    /// as a whole, which takes the text mirror and every attachment with it.
    diary_dir: Option<PathBuf>,
    /// A diary entry's attachments as copied, in the source's order.
    attachments: Vec<CopiedAttachment>,
}

struct CopiedAttachment {
    stored: PathBuf,
    original_filename: String,
    file_type: String,
    position: i64,
    added_at: String,
}

impl CopiedFiles {
    fn remove(&self) {
        let _ = std::fs::remove_file(&self.stored);
        if let Some(thumb) = &self.thumbnail {
            let _ = std::fs::remove_file(thumb);
        }
        if let Some(dir) = &self.diary_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Copies one item's original and thumbnail into the target project,
/// following the same year/month layout a normal import uses — so the
/// target folder stays browsable in a file manager, which is the whole
/// reason that layout exists. A diary entry instead gets the layout
/// `diary.rs` uses, under its new id.
fn copy_into(target: &Path, item: &SourceItem, new_id: &str) -> Result<CopiedFiles, String> {
    if item.is_diary() {
        return copy_diary_into(target, item, new_id);
    }

    let stored_source = Path::new(&item.stored_path);
    if !stored_source.is_file() {
        return Err(crate::i18n::tr("Die Datei fehlt im Quellordner.").to_string());
    }

    let (year, month) = items::year_month(&item.resolved_timestamp);
    let short_id = Uuid::new_v4().simple().to_string()[..8].to_string();

    let originals_dir = target.join("originals").join(&year).join(&month);
    std::fs::create_dir_all(&originals_dir)
        .map_err(|e| crate::trf!("Konnte Zielordner nicht anlegen: {e}", e = e))?;
    // Only ever a single file name: a name with a separator in it would
    // otherwise point into a subfolder that does not exist (or out of
    // `originals` altogether).
    let stored = originals_dir.join(format!("{short_id}_{}", crate::diary::safe_name(&item.original_filename)));
    crate::safe_io::copy_durably(stored_source, &stored).map_err(|e| crate::trf!("Konnte Datei nicht kopieren: {e}", e = e))?;

    let thumbnail = copy_thumbnail(target, item, &year, &month, &short_id);
    Ok(CopiedFiles { stored, thumbnail, diary_dir: None, attachments: Vec::new() })
}

/// The thumbnail is copied rather than regenerated: it is already the
/// right rendition, and regenerating would need ffmpeg/PDFium again for
/// video and PDF. Its extension is kept as it is — a PDF preview is not
/// necessarily a .jpg (see `pdf_preview::render_first_page`). A failed copy
/// is not worth failing the transfer over — audio and most documents have
/// none anyway, and failing would strand the original already copied.
fn copy_thumbnail(target: &Path, item: &SourceItem, year: &str, month: &str, short_id: &str) -> Option<PathBuf> {
    let thumb_source = item.thumbnail_path.as_deref().map(Path::new).filter(|p| p.is_file())?;
    let extension = thumb_source.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_string();
    let thumbnails_dir = target.join("thumbnails").join(year).join(month);
    let dest = thumbnails_dir.join(format!("{short_id}.{extension}"));
    match std::fs::create_dir_all(&thumbnails_dir).and_then(|_| crate::safe_io::copy_durably(thumb_source, &dest)) {
        Ok(_) => Some(dest),
        Err(_) => None,
    }
}

/// A diary entry: the text mirror and every attachment into
/// `diary/<new id>/`. All attachments or none — a missing or uncopyable one
/// fails the entry, since an entry that arrives without its attachments
/// would, on a move, take them out of the source with it.
fn copy_diary_into(target: &Path, item: &SourceItem, new_id: &str) -> Result<CopiedFiles, String> {
    let dir = crate::diary::entry_dir(target, new_id);
    let stored = dir.join(crate::diary::ENTRY_FILE);
    let mut copied = CopiedFiles { stored: stored.clone(), thumbnail: None, diary_dir: Some(dir.clone()), attachments: Vec::new() };

    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Zielordner nicht anlegen: {e}", e = e))?;
        // The text in the row is what the app shows; the mirror is only
        // there for the "is the copy still on disk" checks, so it is
        // rewritten from the text rather than requiring the old one.
        crate::safe_io::write_durably(&stored, item.extracted_text.as_deref().unwrap_or(""))
            .map_err(|e| crate::trf!("Konnte Datei nicht kopieren: {e}", e = e))?;

        let attachment_dir = dir.join(crate::diary::ATTACHMENT_DIR);
        for attachment in &item.attachments {
            let source = Path::new(&attachment.stored_path);
            if !source.is_file() {
                return Err(crate::trf!(
                    "Anhang „{name}“ fehlt im Quellordner.",
                    name = attachment.original_filename
                ));
            }
            std::fs::create_dir_all(&attachment_dir)
                .map_err(|e| crate::trf!("Konnte Anhang-Ordner nicht anlegen: {e}", e = e))?;
            let file_name = source
                .file_name()
                .and_then(|n| n.to_str())
                .map(crate::diary::safe_name)
                .unwrap_or_else(|| crate::diary::safe_name(&attachment.original_filename));
            let dest = crate::diary::unique_path(&attachment_dir, &file_name);
            crate::safe_io::copy_durably(source, &dest).map_err(|e| {
                crate::trf!("Konnte „{name}“ nicht kopieren: {e}", name = attachment.original_filename, e = e)
            })?;
            copied.attachments.push(CopiedAttachment {
                stored: dest,
                original_filename: attachment.original_filename.clone(),
                file_type: attachment.file_type.clone(),
                position: attachment.position,
                added_at: attachment.added_at.clone(),
            });
        }
        Ok(())
    })();

    match result {
        Ok(()) => Ok(copied),
        Err(reason) => {
            copied.remove();
            Err(reason)
        }
    }
}

/// Writes the item's rows into the target: the item, its note and a diary
/// entry's attachments, in one transaction. Everything the user set by hand
/// comes along — display name, the corrected date and where it came from,
/// the rotation, the note — while the ids and `added_at` are new, because
/// in the target this *is* a new item that arrived now.
fn insert_into(
    conn: &Connection,
    new_id: &str,
    item: &SourceItem,
    copied: &CopiedFiles,
    batch_id: Option<&str>,
) -> Result<(), String> {
    let save_failed = |e: rusqlite::Error| crate::trf!("Konnte Eintrag nicht speichern: {e}", e = e);
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(save_failed)?;

    tx.execute(
        "INSERT INTO items (
            id, original_filename, stored_path, thumbnail_path, file_type, display_name,
            resolved_timestamp, timestamp_source, fs_created_at, fs_modified_at,
            embedded_metadata_at, source_path, source_folder_path, import_batch_id, added_at,
            video_frame_percent, extracted_text, file_size_bytes, rotation,
            email_subject, email_sender, email_date
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            new_id,
            item.original_filename,
            copied.stored.to_string_lossy().to_string(),
            copied.thumbnail.as_ref().map(|p| p.to_string_lossy().to_string()),
            item.file_type,
            item.display_name,
            item.resolved_timestamp,
            item.timestamp_source,
            item.fs_created_at,
            item.fs_modified_at,
            item.embedded_metadata_at,
            item.source_path,
            item.source_folder_path,
            batch_id,
            now,
            item.video_frame_percent,
            item.extracted_text,
            item.file_size_bytes,
            item.rotation,
            item.email_subject,
            item.email_sender,
            item.email_date,
        ],
    )
    .map_err(save_failed)?;

    if let Some(text) = &item.note {
        tx.execute(
            "INSERT INTO notes (id, item_id, text, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![Uuid::new_v4().to_string(), new_id, text, now],
        )
        .map_err(|e| crate::trf!("Konnte Notiz nicht speichern: {e}", e = e))?;
    }

    for attachment in &copied.attachments {
        tx.execute(
            "INSERT INTO diary_attachments (id, diary_id, original_filename, stored_path, file_type, position, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                new_id,
                attachment.original_filename,
                attachment.stored.to_string_lossy().to_string(),
                attachment.file_type,
                attachment.position,
                attachment.added_at,
            ],
        )
        .map_err(|e| crate::trf!("Konnte Anhang nicht speichern: {e}", e = e))?;
    }

    tx.commit().map_err(save_failed)?;

    // A diary entry keeps its size NULL and so has no fingerprint either —
    // two short entries must never be reported as copies (see `diary.rs`).
    if !item.is_diary() && items::quick_hash_on_ingest_enabled(conn) {
        crate::duplicate_hash::ensure_item_quick_hash(conn, new_id, &copied.stored);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway project folder with a real database, originals and
    /// thumbnails — the transfer is mostly file handling, so testing it
    /// against in-memory databases would miss the half that matters.
    struct TempProject {
        path: PathBuf,
        conn: Connection,
    }

    impl TempProject {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("cronostream-transfer-{}", Uuid::new_v4()));
            std::fs::create_dir_all(path.join("originals")).unwrap();
            std::fs::create_dir_all(path.join("thumbnails")).unwrap();
            let conn = Connection::open(project::db_path(&path)).unwrap();
            conn.execute_batch(crate::schema::SCHEMA).unwrap();
            crate::settings::set(&conn, "project_name", name).unwrap();
            TempProject { path, conn }
        }

        /// Adds an item with real files behind it, as an import would.
        fn add_item(&self, id: &str, filename: &str, source_path: &str) {
            let stored = self.path.join("originals").join(format!("x_{filename}"));
            std::fs::write(&stored, b"original contents").unwrap();
            let thumb = self.path.join("thumbnails").join(format!("{id}.jpg"));
            std::fs::write(&thumb, b"thumb").unwrap();

            self.conn
                .execute(
                    "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                        display_name, resolved_timestamp, timestamp_source, added_at,
                                        source_path, rotation)
                     VALUES (?1, ?2, ?3, ?4, 'image', ?5, '2023-06-15T10:00:00+00:00', 'exif',
                             '2024-01-01T00:00:00+00:00', ?6, 90)",
                    params![
                        id,
                        filename,
                        stored.to_string_lossy().to_string(),
                        thumb.to_string_lossy().to_string(),
                        format!("Mein {filename}"),
                        source_path
                    ],
                )
                .unwrap();
        }

        /// Adds a diary entry the way `diary.rs` lays it out: the row, the
        /// text mirror and each attachment under `diary/<id>/anhang/`.
        fn add_diary(&self, id: &str, title: &str, text: &str, attachments: &[(&str, &[u8])]) {
            let dir = crate::diary::entry_dir(&self.path, id);
            let attachment_dir = dir.join(crate::diary::ATTACHMENT_DIR);
            std::fs::create_dir_all(&attachment_dir).unwrap();
            let entry = dir.join(crate::diary::ENTRY_FILE);
            std::fs::write(&entry, text).unwrap();
            self.conn
                .execute(
                    "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp,
                                        timestamp_source, added_at, extracted_text)
                     VALUES (?1, ?2, ?3, 'diary', '2022-03-04T08:00:00+00:00', 'manual',
                             '2024-01-01T00:00:00+00:00', ?4)",
                    params![id, title, entry.to_string_lossy().to_string(), text],
                )
                .unwrap();
            for (position, (name, bytes)) in attachments.iter().enumerate() {
                let stored = attachment_dir.join(name);
                std::fs::write(&stored, bytes).unwrap();
                self.conn
                    .execute(
                        "INSERT INTO diary_attachments (id, diary_id, original_filename, stored_path, file_type, position, added_at)
                         VALUES (?1, ?2, ?3, ?4, 'image', ?5, '2024-01-01T00:00:00+00:00')",
                        params![format!("{id}-att{position}"), id, name, stored.to_string_lossy().to_string(), position as i64],
                    )
                    .unwrap();
            }
        }

        fn add_note(&self, item_id: &str, text: &str) {
            self.conn
                .execute(
                    "INSERT INTO notes (id, item_id, text, created_at) VALUES (?1, ?2, ?3, '2024-01-01T00:00:00+00:00')",
                    params![format!("note-{item_id}"), item_id, text],
                )
                .unwrap();
        }

        fn live_count(&self) -> i64 {
            self.conn
                .query_row(&format!("SELECT COUNT(*) FROM items WHERE {LIVE_ITEMS}"), [], |r| r.get(0))
                .unwrap()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// The transfer loop without the Tauri plumbing (app state, progress
    /// events), so the copying and inserting can be tested directly.
    fn transfer(source: &TempProject, target: &TempProject, ids: &[&str]) -> (usize, Vec<TransferSkipped>) {
        let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        let sources = read_source_items(&source.conn, &ids).unwrap();
        let mut skipped = Vec::new();
        let mut log_entries = Vec::new();

        for item in &sources {
            if let Some(found) = find_duplicate_in_target(&target.conn, item) {
                skipped.push(TransferSkipped {
                    item_id: item.id.clone(),
                    label: item.label().to_string(),
                    reason: found.reason(),
                });
                continue;
            }
            match transfer_one(&target.path, &target.conn, item, None) {
                Ok(new_id) => log_entries.push(LogEntry::presence(&new_id, &item.original_filename)),
                Err(reason) => skipped.push(TransferSkipped { item_id: item.id.clone(), label: item.label().to_string(), reason }),
            }
        }
        if !log_entries.is_empty() {
            action_log::record(&target.conn, ActionType::Import, &log_entries).unwrap();
        }
        (log_entries.len(), skipped)
    }

    #[test]
    fn transferred_items_arrive_with_their_edits_and_real_files() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");

        let (count, skipped) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 1);
        assert!(skipped.is_empty());

        let (name, timestamp, source_tag, rotation, stored, thumb): (
            String, String, String, i32, String, Option<String>,
        ) = target
            .conn
            .query_row(
                "SELECT display_name, resolved_timestamp, timestamp_source, rotation,
                        stored_path, thumbnail_path FROM items",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();

        // Everything the user had set by hand comes along.
        assert_eq!(name, "Mein Foto.jpg");
        assert_eq!(timestamp, "2023-06-15T10:00:00+00:00");
        assert_eq!(source_tag, "exif");
        assert_eq!(rotation, 90);

        // And the copies are real files, in the target, under the
        // year/month layout taken from the item's own date.
        assert!(Path::new(&stored).is_file());
        assert!(stored.contains("originals"), "{stored}");
        assert!(stored.contains("2023"), "{stored}");
        assert!(stored.contains("06"), "{stored}");
        assert!(Path::new(&thumb.unwrap()).is_file());
    }

    #[test]
    fn the_source_project_is_left_completely_untouched() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        let before: String = source
            .conn
            .query_row("SELECT stored_path FROM items", [], |r| r.get(0))
            .unwrap();

        transfer(&source, &target, &["a"]);

        assert_eq!(source.live_count(), 1, "the item stays in the source");
        assert!(Path::new(&before).is_file(), "the source file stays on disk");
        // A transfer is not a change to the source, so it logs nothing there.
        let source_log: i64 = source
            .conn
            .query_row("SELECT COUNT(*) FROM action_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source_log, 0);
    }

    #[test]
    fn the_target_logs_it_as_a_normal_undoable_import() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Eins.jpg", "/pictures/Eins.jpg");
        source.add_item("b", "Zwei.jpg", "/pictures/Zwei.jpg");

        transfer(&source, &target, &["a", "b"]);

        let (action_type, entries): (String, i64) = target
            .conn
            .query_row(
                "SELECT a.action_type, COUNT(e.id) FROM action_log a
                 JOIN action_log_entry e ON e.action_id = a.id GROUP BY a.id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(action_type, "import");
        assert_eq!(entries, 2, "one log action covering both files");
    }

    #[test]
    fn a_file_already_in_the_target_is_skipped_not_duplicated() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        target.add_item("other", "Foto.jpg", "/pictures/Foto.jpg");

        let (count, skipped) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 0);
        assert_eq!(skipped.len(), 1);
        assert_eq!(target.live_count(), 1, "no duplicate was created");
    }

    #[test]
    fn the_same_content_under_another_path_is_skipped_as_a_duplicate() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        target.add_item("other", "Kopie.jpg", "/backup/Kopie.jpg");
        // `add_item` writes identical bytes and no size; give both the same one.
        for project in [&source, &target] {
            project.conn.execute("UPDATE items SET file_size_bytes = 17", []).unwrap();
        }

        let (count, skipped) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 0);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].item_id, "a");
        assert_eq!(target.live_count(), 1, "no duplicate was created");
    }

    #[test]
    fn an_item_whose_file_vanished_is_reported_rather_than_failing_the_batch() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Fehlt.jpg", "/pictures/Fehlt.jpg");
        source.add_item("b", "Da.jpg", "/pictures/Da.jpg");

        let gone: String = source
            .conn
            .query_row("SELECT stored_path FROM items WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        std::fs::remove_file(gone).unwrap();

        let (count, skipped) = transfer(&source, &target, &["a", "b"]);
        assert_eq!(count, 1, "the intact file still goes over");
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].reason.contains("fehlt"), "{:?}", skipped[0]);
    }

    #[test]
    fn a_removed_item_is_not_transferable() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        source
            .conn
            .execute("UPDATE items SET removed_at = '2026-10-10T00:00:00+00:00'", [])
            .unwrap();

        let (count, _) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 0, "what is off the timeline is not part of the project");
    }

    #[test]
    fn a_project_is_recognised_as_itself_through_a_different_path_spelling() {
        let project = TempProject::new("Quelle");
        let roundabout = project.path.join("originals").join("..");
        assert!(same_folder(&roundabout, &project.path));

        let other = TempProject::new("Ziel");
        assert!(!same_folder(&other.path, &project.path));
    }

    #[test]
    fn a_note_travels_with_its_file() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        source.add_note("a", "Oma, privat");

        let (count, _) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 1);

        let (note, owner_is_new_item): (String, bool) = target
            .conn
            .query_row(
                "SELECT n.text, n.item_id = i.id FROM notes n JOIN items i ON i.id = n.item_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(note, "Oma, privat");
        assert!(owner_is_new_item);
    }

    #[test]
    fn a_diary_entry_arrives_with_its_text_and_attachments() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        // A title with a slash: it must not end up as a path component.
        source.add_diary("d", "Urlaub 3/4", "Urlaub 3/4\nAm Strand.", &[("foto.jpg", b"jpeg"), ("brief.pdf", b"pdf")]);
        source.add_note("d", "Familie");

        let (count, skipped) = transfer(&source, &target, &["d"]);
        assert_eq!(count, 1, "{skipped:?}");

        let (new_id, title, text, stored): (String, String, String, String) = target
            .conn
            .query_row(
                "SELECT id, original_filename, extracted_text, stored_path FROM items WHERE file_type = 'diary'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_ne!(new_id, "d");
        assert_eq!(title, "Urlaub 3/4");
        assert_eq!(text, "Urlaub 3/4\nAm Strand.");
        let entry_dir = crate::diary::entry_dir(&target.path, &new_id);
        assert_eq!(PathBuf::from(&stored), entry_dir.join(crate::diary::ENTRY_FILE));
        assert_eq!(std::fs::read_to_string(&stored).unwrap(), text);

        let attachments: Vec<(String, String, i64)> = {
            let mut stmt = target
                .conn
                .prepare("SELECT original_filename, stored_path, position FROM diary_attachments WHERE diary_id = ?1 ORDER BY position")
                .unwrap();
            stmt.query_map(params![new_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].0, "foto.jpg");
        assert_eq!(attachments[1].0, "brief.pdf");
        assert_eq!(attachments[1].2, 1);
        for (_, path, _) in &attachments {
            assert!(Path::new(path).starts_with(entry_dir.join(crate::diary::ATTACHMENT_DIR)), "{path}");
        }
        assert_eq!(std::fs::read(&attachments[0].1).unwrap(), b"jpeg");

        let note: String = target
            .conn
            .query_row("SELECT text FROM notes WHERE item_id = ?1", params![new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(note, "Familie");
    }

    /// The rule a move depends on: an entry whose attachments cannot all go
    /// across is reported as not arrived — so `transfer_items` never removes
    /// it from the source — and leaves nothing behind in the target.
    #[test]
    fn a_diary_entry_missing_an_attachment_stays_behind_completely() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_diary("d", "Eintrag", "Eintrag", &[("eins.jpg", b"1"), ("zwei.jpg", b"2")]);
        let gone: String = source
            .conn
            .query_row("SELECT stored_path FROM diary_attachments WHERE original_filename = 'zwei.jpg'", [], |r| r.get(0))
            .unwrap();
        std::fs::remove_file(gone).unwrap();

        let (count, skipped) = transfer(&source, &target, &["d"]);
        assert_eq!(count, 0);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].item_id, "d");
        assert!(skipped[0].reason.contains("zwei.jpg"), "{:?}", skipped[0]);

        assert_eq!(target.live_count(), 0);
        let rows: i64 = target.conn.query_row("SELECT COUNT(*) FROM diary_attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
        let leftovers = std::fs::read_dir(target.path.join("diary")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftovers, 0, "the half-copied entry folder was removed again");
    }

    #[test]
    fn the_same_diary_entry_is_not_copied_twice() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_diary("d", "Eintrag", "Eintrag", &[]);

        assert_eq!(transfer(&source, &target, &["d"]).0, 1);
        let (count, skipped) = transfer(&source, &target, &["d"]);
        assert_eq!(count, 0);
        assert_eq!(skipped.len(), 1);
        assert_eq!(target.live_count(), 1);
    }

    #[test]
    fn a_file_name_with_a_separator_is_copied_as_one_name() {
        let source = TempProject::new("Quelle");
        let target = TempProject::new("Ziel");
        source.add_item("a", "Foto.jpg", "/pictures/Foto.jpg");
        source.conn.execute("UPDATE items SET original_filename = 'Teil 1/2.jpg'", []).unwrap();

        let (count, skipped) = transfer(&source, &target, &["a"]);
        assert_eq!(count, 1, "{skipped:?}");
        let stored: String = target.conn.query_row("SELECT stored_path FROM items", [], |r| r.get(0)).unwrap();
        assert!(Path::new(&stored).is_file());
        assert!(Path::new(&stored).parent().unwrap().ends_with("2023/06"), "{stored}");
    }
}
