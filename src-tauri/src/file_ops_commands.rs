//! Die Befehle hinter den Reitern „Datei-Operationen" und „Papierkorb".
//!
//! Both tabs are views on the *project's own* items rather than on the
//! filesystem — the file browser's other tabs all walk directories, these
//! two walk `items`. The split between them is a single column:
//! "Datei-Operationen" lists what is live (`removed_at IS NULL`),
//! "Papierkorb" lists what has been taken off the timeline. There is no
//! `is_trashed` flag and no second soft-delete mechanism; the Papierkorb is
//! a filter over what `items.removed_at` has always recorded.
//!
//! Nothing here invents a new deletion path either. Removing goes through
//! `timeline_commands::remove_items_by_ids` (the same bulk removal the file
//! browser uses), restoring goes through the action log's own undo (a
//! restore *is* the undo of a removal), and the permanent delete reuses
//! `purge_item_row`. The one genuinely new behaviour is
//! `purge_items_and_log`, which additionally erases the file's log history —
//! see `action_log::delete_entries_for_item` for why that deliberately
//! breaks the module's "never delete the log" rule.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::action_log;
use crate::schema::LIVE_ITEMS;
use crate::state::AppStateHandle;
use crate::project_files::PendingDeletions;
use crate::timeline_commands;

/// One project file as the two tabs' tile grid needs it.
///
/// `path` is the item's in-project copy (`stored_path`), not its original
/// source: these tabs act on what the stream holds, and the user's
/// originals outside the project folder are never touched here. That also
/// makes `path` a stable identity for the frontend's mark/selection state,
/// matching how the browsing grid keys tiles by path.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub id: String,
    pub path: String,
    /// What the user sees on the tile — the display name they set, else the
    /// real filename.
    pub name: String,
    pub kind: String,
    pub thumbnail_path: Option<String>,
    pub resolved_timestamp: String,
    pub file_size_bytes: Option<i64>,
    pub rotation: i32,
    /// The original file's own dates, carried along so the preview panel
    /// can show the same "Erstellt/Geändert" pair it shows while browsing.
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    /// When the item was inserted into the stream (RFC3339) — what the
    /// "eingefügt" mode of the range filter compares against.
    pub added_at: Option<String>,
    /// When this item was taken off the timeline; `None` for a live one.
    pub removed_at: Option<String>,
    /// False once the in-project copy is gone — true for a Papierkorb row
    /// whose file was deleted by "Nur Datei löschen" (or by the
    /// "Dateien beim Entfernen löschen" setting). The tile then has no
    /// preview to show and only "Aus der Datenbank entfernen" left to
    /// offer, so the UI has to be able to tell.
    pub file_present: bool,
}

/// Which calendar year an item's timestamp falls in, in the *local* zone.
///
/// Not derived from the stored string: `resolved_timestamp` is RFC3339 with
/// the item's own UTC offset (an EXIF date carries the camera's real
/// offset), so slicing the first four characters would file a
/// New-Year's-Eve photo under the wrong year. Same reasoning as
/// `timeline_commands::search_items`, which parses rather than compares
/// text for its day range.
fn local_year(timestamp: &str) -> Option<i32> {
    use chrono::Datelike;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| parsed.with_timezone(&chrono::Local).year())
}

/// The item's local calendar day, as `YYYY-MM-DD` — what the free Von/Bis
/// range compares against, for the same reason `search_items` does it this
/// way: an inclusive whole-day bound, judged in the zone the user sees.
fn local_day(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| parsed.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

/// Reads every item on the requested side of `removed_at`, newest-first is
/// *not* used — chronological order matches the timeline the user knows.
fn read_entries(conn: &Connection, trashed: bool) -> Result<Vec<ProjectFileEntry>, String> {
    let presence = if trashed { "removed_at IS NOT NULL" } else { LIVE_ITEMS };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, stored_path, COALESCE(display_name, original_filename), file_type,
                    thumbnail_path, resolved_timestamp, file_size_bytes, rotation, removed_at,
                    fs_created_at, fs_modified_at, added_at
             FROM items WHERE {presence}
             -- datetime(), not the raw column: see list_items for why text
             -- order over offset-carrying RFC3339 is wrong.
             ORDER BY datetime(resolved_timestamp) ASC"
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let path: String = row.get(1)?;
            Ok(ProjectFileEntry {
                id: row.get(0)?,
                file_present: std::path::Path::new(&path).is_file(),
                path,
                name: row.get(2)?,
                kind: row.get(3)?,
                thumbnail_path: row.get(4)?,
                resolved_timestamp: row.get(5)?,
                file_size_bytes: row.get(6)?,
                rotation: row.get(7)?,
                removed_at: row.get(8)?,
                fs_created_at: row.get(9)?,
                fs_modified_at: row.get(10)?,
                added_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Item ids on the requested side of `removed_at` whose filename or
/// extracted text contains `query`, case- and Unicode-fold-insensitively —
/// the same matching `timeline_commands::search_items` uses (SQLite's own
/// `LIKE`/`lower()` are not Unicode-aware, so "müller" would miss "Müller").
///
/// Kept separate from `read_entries` rather than adding a field to
/// `ProjectFileEntry`: `extracted_text` is often the largest column on the
/// row, and every plain listing (the common case — this filter is rarely
/// active) would otherwise carry it across the IPC boundary for nothing.
fn ids_matching_text(conn: &Connection, trashed: bool, query: &str) -> Result<std::collections::HashSet<String>, String> {
    let presence = if trashed { "removed_at IS NOT NULL" } else { LIVE_ITEMS };
    let needle = query.to_lowercase();

    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, COALESCE(display_name, original_filename), original_filename, extracted_text
             FROM items WHERE {presence}"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut ids = std::collections::HashSet::new();
    for row in rows {
        let (id, name, original_filename, extracted_text) = row.map_err(|e| e.to_string())?;
        let matches = name.to_lowercase().contains(&needle)
            || original_filename.to_lowercase().contains(&needle)
            || extracted_text.is_some_and(|text| text.to_lowercase().contains(&needle));
        if matches {
            ids.insert(id);
        }
    }
    Ok(ids)
}

/// The years that actually hold files, ascending — the left-hand navigation
/// of both tabs.
///
/// Derived from the project database, never from the folder layout on disk:
/// `originals/<year>/<month>/` mirrors the dates, but an item whose date was
/// corrected after import still sits in its original year folder, so the
/// filesystem would answer a different (and wrong) question.
#[tauri::command(async)]
pub fn list_project_years(
    state: State<AppStateHandle>,
    trashed: Option<bool>,
    text: Option<String>,
) -> Result<Vec<i32>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let trashed = trashed.unwrap_or(false);
    let presence = if trashed { "removed_at IS NOT NULL" } else { LIVE_ITEMS };

    // Matches the "Text" filter's own narrowing, so the year rail's counts
    // (built from `list_project_files` over the same text) never claim a
    // year that the filtered list doesn't actually contain.
    let text = text.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
    let allowed_ids = match &text {
        Some(query) => Some(ids_matching_text(&current.conn, trashed, query)?),
        None => None,
    };

    let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?;

    let mut stmt = current
        .conn
        .prepare(&format!("SELECT id, resolved_timestamp FROM items WHERE {presence}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    let mut years: Vec<i32> = Vec::new();
    for row in rows {
        let (id, timestamp) = row.map_err(|e| e.to_string())?;
        if hidden.as_ref().is_some_and(|hidden| hidden.contains(&id)) {
            continue;
        }
        if let Some(allowed) = &allowed_ids {
            if !allowed.contains(&id) {
                continue;
            }
        }
        if let Some(year) = local_year(&timestamp) {
            if !years.contains(&year) {
                years.push(year);
            }
        }
    }
    years.sort_unstable();
    Ok(years)
}

/// The files of one year, of a free Von/Bis range, or of the whole project.
///
/// `year` and `from`/`to` are alternatives, and "Alle Jahre" is simply
/// neither being set — the frontend's year rail and its date-range toggle
/// are two ways to narrow the same list, so the backend takes both and lets
/// whichever is present win (`year` first).
#[tauri::command(async)]
pub fn list_project_files(
    state: State<AppStateHandle>,
    trashed: Option<bool>,
    year: Option<i32>,
    from: Option<String>,
    to: Option<String>,
    text: Option<String>,
) -> Result<Vec<ProjectFileEntry>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let trashed = trashed.unwrap_or(false);

    let mut all = read_entries(&current.conn, trashed)?;
    if let Some(hidden) = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)? {
        all.retain(|entry| !hidden.contains(&entry.id));
    }

    // "Text": filename or extracted file content, narrowed before the
    // year/range filters below so all three combine (same as year and
    // range already do with each other).
    let text = text.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
    if let Some(query) = &text {
        let ids = ids_matching_text(&current.conn, trashed, query)?;
        all.retain(|entry| ids.contains(&entry.id));
    }

    if let Some(year) = year {
        return Ok(all
            .into_iter()
            .filter(|entry| local_year(&entry.resolved_timestamp) == Some(year))
            .collect());
    }

    let from = from.filter(|d| !d.is_empty());
    let to = to.filter(|d| !d.is_empty());
    if from.is_none() && to.is_none() {
        return Ok(all);
    }

    Ok(all
        .into_iter()
        .filter(|entry| {
            let Some(day) = local_day(&entry.resolved_timestamp) else { return false };
            if from.as_deref().is_some_and(|f| day.as_str() < f) {
                return false;
            }
            if to.as_deref().is_some_and(|t| day.as_str() > t) {
                return false;
            }
            true
        })
        .collect())
}

/// Appends " (2)", " (3)", … to `base` until `dir/base.ext` doesn't exist
/// yet — the same collision handling a filesystem copy-paste gives you,
/// so two files that happen to share a name in the project don't clobber
/// each other in the destination folder.
fn unique_dest_path(dir: &std::path::Path, base: &str, ext: &str) -> std::path::PathBuf {
    let candidate = dir.join(if ext.is_empty() { base.to_string() } else { format!("{base}.{ext}") });
    if !candidate.exists() {
        return candidate;
    }
    let mut n = 2;
    loop {
        let name = if ext.is_empty() { format!("{base} ({n})") } else { format!("{base} ({n}).{ext}") };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// "Pfadliste als Textdatei" — writes the given text to a path the user
/// picked in the save dialog.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, content).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// "In Ordner kopieren…" — a plain filesystem copy of the marked files'
/// in-project copies into any folder the user picks, under their original
/// filename. Unlike "Kopieren nach…" (which copies into another
/// stream's own database via `transfer_items`), this doesn't touch any
/// project at all: no import, no log entry, nothing to undo — it's the
/// same thing as dragging the files out of the project folder in a file
/// manager.
/// `async` + `spawn_blocking`: one `fs::copy` per item, real I/O that must
/// not sit on the IPC thread for a large selection.
#[tauri::command]
pub async fn copy_project_items_to_folder(
    app: AppHandle,
    item_ids: Vec<String>,
    dest_folder: String,
    operation_id: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let dest_dir = std::path::Path::new(&dest_folder);
        if !dest_dir.is_dir() {
            return Err(crate::i18n::tr("Zielordner nicht gefunden.").to_string());
        }

        // Only the path lookup needs the state lock — the copying itself
        // runs without it, so other commands aren't stalled meanwhile.
        let rows: Vec<Option<(String, String)>> = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            item_ids
                .iter()
                .map(|item_id| {
                    current
                        .conn
                        .query_row(
                            "SELECT stored_path, original_filename FROM items WHERE id = ?1",
                            params![item_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(|e| e.to_string())
                })
                .collect::<Result<_, _>>()?
        };

        let total = rows.len();
        let mut copied = 0usize;
        for (done, row) in rows.into_iter().enumerate() {
            let Some((stored_path, original_filename)) = row else { continue };
            if !std::path::Path::new(&stored_path).is_file() {
                continue;
            }

            let name_path = std::path::Path::new(&original_filename);
            let stem = name_path.file_stem().and_then(|s| s.to_str()).unwrap_or(&original_filename);
            let ext = name_path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let dest_path = unique_dest_path(dest_dir, stem, ext);

            crate::safe_io::copy_durably(std::path::Path::new(&stored_path), &dest_path)
                .map_err(|e| crate::trf!("Konnte „{original_filename}“ nicht kopieren: {e}", original_filename = original_filename, e = e))?;
            copied += 1;
            crate::progress::emit_progress(&app, &operation_id, done + 1, total, &original_filename);
        }
        Ok(copied)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// "Aus dem stream entfernen" — the soft removal, in bulk.
///
/// Thin on purpose: it is the file browser's existing bulk removal, reached
/// by item id instead of by source path, so both produce one Remove action
/// in the log and both honour "Dateien beim Entfernen löschen" identically.
/// `async` + `spawn_blocking`, same reasoning as
/// `timeline_commands::remove_items_by_source_paths`.
#[tauri::command]
pub async fn remove_project_items(app: AppHandle, item_ids: Vec<String>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        timeline_commands::remove_items_by_ids(&current.conn, &current.path, &item_ids, |done, total, current_label| {
            crate::progress::emit_progress(&app, &operation_id, done, total, current_label);
        })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// "Notiz hinzufügen" — tags every marked file with the same term, added to
/// whatever note it already has rather than replacing it (see
/// `timeline_commands::append_note_term`). Two or more files that end up
/// sharing the exact same note text become each other's cluster: the
/// Timeline viewer makes an identical note clickable and hands the whole
/// group off to this very tab (`onSendSelectionToFileOps`).
#[tauri::command(async)]
pub fn add_note_to_items(app: AppHandle, state: State<AppStateHandle>, item_ids: Vec<String>, term: String) -> Result<(), String> {
    let trimmed = term.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::tr("Die Notiz darf nicht leer sein.").to_string());
    }

    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    for item_id in &item_ids {
        timeline_commands::append_note_term(&current.conn, item_id, trimmed)?;
    }
    if crate::privacy::note_hides_item(current, trimmed)? {
        let _ = app.emit(crate::privacy::NOTE_HID_ITEM_EVENT, ());
    }
    Ok(())
}

/// "Links/Rechts drehen" for all marked photos at once. Same display-time
/// transform as `timeline_commands::rotate_item` (only `items.rotation`
/// changes, the files stay untouched), applied to every id in one go.
/// Non-image rows are skipped in SQL, so the frontend's "photos only" gate
/// is not the only thing standing between a video and a stored rotation.
#[tauri::command(async)]
pub fn rotate_items(state: State<AppStateHandle>, item_ids: Vec<String>, delta: i32) -> Result<usize, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let mut changed = 0;
    for id in &item_ids {
        changed += current
            .conn
            .execute(
                "UPDATE items SET rotation = (((rotation + ?1) % 360) + 360) % 360
                 WHERE id = ?2 AND file_type = 'image'",
                params![delta, id],
            )
            .map_err(|e| crate::trf!("Konnte Drehung nicht speichern: {e}", e = e))?;
    }
    Ok(changed)
}

/// "Wiederherstellen" — puts Papierkorb files back on the timeline.
///
/// Routed through the action log's own undo rather than a fresh
/// `removed_at = NULL` update, because the removal being reversed may have
/// taken the in-project copy with it (the "Dateien beim Entfernen löschen"
/// setting, or "Nur Datei löschen" in this very tab). `undo_entries`
/// already knows to re-import from the original source in that case, and
/// already refuses to put a file back whose source has since been imported
/// again. Reimplementing any of that here would be a second, worse answer
/// to a solved problem.
///
/// `cascade` is passed as true: the user pointed at *these files*, not at a
/// log entry, so later unrelated-field changes should not turn a restore
/// into a conflict dialog. `delete_copy` is irrelevant for a Remove entry
/// and only set to silence the import-only question.
///
/// Items with no Remove entry to undo — removed before the log existed, or
/// restored from a deleted stream (which sets `removed_at` without
/// logging, by design) — fall back to a plain un-removal, but only while
/// their copy is actually there to come back to.
/// `async` + `spawn_blocking`: a restore that fell back to re-importing from
/// the source (see above) does real file I/O per item, same reasoning as
/// every other bulk command in this module.
#[tauri::command]
pub async fn restore_project_items(app: AppHandle, item_ids: Vec<String>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<AppStateHandle>();
    let total = item_ids.len();

    // The newest un-reverted Remove entry is the one that put each file
    // where it is; anything older was already undone or superseded.
    let remove_entry_of = |conn: &rusqlite::Connection, item_id: &str| -> Result<Option<i64>, String> {
        conn.query_row(
            "SELECT e.id FROM action_log_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.item_id = ?1 AND a.action_type = 'remove' AND e.reverted = 0
             ORDER BY e.action_id DESC, e.id DESC LIMIT 1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    };

    // Files whose copy is gone are re-imported from their source. That copy
    // happens first, with nothing locked (see
    // `action_log_commands::undo_with_prepared_restores`); the restore loop
    // below then only does short database work under the lock.
    let (project_path, jobs) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let mut entry_ids = Vec::new();
        for item_id in &item_ids {
            entry_ids.extend(remove_entry_of(&current.conn, item_id)?);
        }
        (current.path.clone(), crate::action_log_commands::restore_jobs(&current.conn, &entry_ids)?)
    };
    let mut prepared = crate::action_log_commands::PreparedRestores::prepare(&project_path, jobs);

    let result = (|| -> Result<usize, String> {
    let guard = crate::state::lock_project(&state, &project_path)?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let conn = &current.conn;

    let mut restored = 0usize;
    for (done, item_id) in item_ids.iter().enumerate() {
        let entry_id = remove_entry_of(conn, item_id)?;

        match entry_id {
            Some(entry_id) => {
                let outcome = crate::action_log_commands::undo_entries(
                    conn,
                    &current.path,
                    &[entry_id],
                    Some(false),
                    true,
                    &mut prepared,
                );
                // One file that can't come back (re-imported meanwhile, source
                // gone) must not stop the rest: it is simply not counted, and
                // the toast reports the restore as partial.
                if let Ok(crate::action_log_commands::UndoOutcome::Done { undone }) = outcome {
                    if undone > 0 {
                        restored += 1;
                    }
                }
            }
            None => {
                let stored_path: Option<String> = conn
                    .query_row(
                        "SELECT stored_path FROM items WHERE id = ?1 AND removed_at IS NOT NULL",
                        params![item_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some(stored_path) = stored_path else { continue };
                if !std::path::Path::new(&stored_path).is_file() {
                    continue;
                }
                let changed = conn
                    .execute("UPDATE items SET removed_at = NULL WHERE id = ?1", params![item_id])
                    .map_err(|e| crate::trf!("Konnte Datei nicht wiederherstellen: {e}", e = e))?;
                if changed > 0 {
                    restored += 1;
                }
            }
        }
        crate::progress::emit_progress(&app, &operation_id, done + 1, total, item_id);
    }
    Ok(restored)
    })();
    prepared.discard_unused();
    result
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// "Nur Datei löschen" — frees the disk space, keeps the item.
///
/// The row stays, with its date, rotation, display name, notes, log history
/// and `source_path` intact, so the file can still be brought back by
/// re-importing from the original (see
/// `action_log_commands::restore_from_source`, which the restore above
/// reaches). This is the manual counterpart to what the "Dateien beim
/// Entfernen löschen" setting does automatically — and deliberately *not*
/// logged as a Purge: a Purge entry means "this file's row is gone and
/// nothing can be restored", which is exactly not the case here. Writing
/// one would make the log claim a finality that hasn't happened.
///
/// Only ever touches already-removed items: deleting the copy of a file
/// still on the timeline would leave a tile pointing at nothing.
///
/// `async` + `spawn_blocking` (real file I/O per item) and one transaction
/// around the bookkeeping `UPDATE`s, same reasoning as
/// `timeline_commands::remove_items_by_ids`.
#[tauri::command]
pub async fn delete_item_files_only(app: AppHandle, item_ids: Vec<String>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let conn = &current.conn;
        let total = item_ids.len();

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut deleted = 0usize;
        let mut deletions = PendingDeletions::default();
        for (done, item_id) in item_ids.iter().enumerate() {
            let row: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT stored_path, thumbnail_path FROM items
                     WHERE id = ?1 AND removed_at IS NOT NULL",
                    params![item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((stored_path, thumbnail_path)) = row else { continue };

            // Inside the project folder only (`project_files` refuses anything
            // else), and only once the bookkeeping below has committed.
            deletions.item_files(&stored_path, thumbnail_path.as_deref());
            // The thumbnail is gone, so the column must not keep claiming one;
            // `stored_path` stays, since it is where a restore writes the file
            // back to and `file_present` is answered by asking the disk.
            tx.execute("UPDATE items SET thumbnail_path = NULL WHERE id = ?1", params![item_id])
                .map_err(|e| crate::trf!("Konnte Eintrag nicht aktualisieren: {e}", e = e))?;
            deleted += 1;
            crate::progress::emit_progress(&app, &operation_id, done + 1, total, &stored_path);
        }
        tx.commit().map_err(|e| e.to_string())?;
        deletions.run(&current.path);
        Ok(deleted)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// "Löschen + Entfernung aus der Datenbank" — the complete, irreversible
/// erasure: file, thumbnail, `items` row, and the file's whole log history.
///
/// The first three are the app's long-standing permanent delete
/// (`purge_item_row`). The fourth is new and is the point of this command:
/// a recognised mis-import should be undoable without a trace, not leave a
/// log full of lines about files that no longer exist. It is a deliberate
/// break with the log's "never delete" rule — the reasoning, and why it
/// must not be "fixed" back, is on `action_log::delete_entries_for_item`.
///
/// No Purge entry is recorded either, for the same reason: this action's
/// whole purpose is leaving nothing behind, so logging it would defeat it.
/// That is why this is a separate command rather than a flag on
/// `purge_items`, whose own "endgültig löschen" button in the Protokoll tab
/// still logs normally and still keeps the history readable.
///
/// Guarded the same way every other permanent delete is: only items already
/// off the timeline, enforced by `purge_item_row`'s own `removed_at IS NOT
/// NULL` check.
///
/// `async` + `spawn_blocking` + one transaction, same reasoning as
/// `delete_item_files_only` above.
#[tauri::command]
pub async fn purge_items_and_log(app: AppHandle, item_ids: Vec<String>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let conn = &current.conn;
        let total = item_ids.len();

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut purged = 0usize;
        let mut deletions = PendingDeletions::default();
        for (done, item_id) in item_ids.iter().enumerate() {
            let Some(label) = timeline_commands::purge_item_row(&tx, item_id, &mut deletions) else { continue };
            // After the row, so a failure to delete the row can't leave the
            // history already erased for a file that is still listed.
            action_log::delete_entries_for_item(&tx, item_id)?;
            purged += 1;
            crate::progress::emit_progress(&app, &operation_id, done + 1, total, &label);
        }
        // Files only after the commit: should erasing one row's history fail
        // above, nothing has been deleted yet and every row is still intact.
        tx.commit().map_err(|e| e.to_string())?;
        deletions.run(&current.path);
        Ok(purged)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

// ---------------------------------------------------------------------------
// "Datei im Stream ersetzen"
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementCandidate {
    pub path: String,
    pub name: String,
    pub size_bytes: Option<u64>,
}

/// One project file for which the chosen folder holds at least one
/// possible replacement.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementMatch {
    pub item_id: String,
    pub name: String,
    pub kind: String,
    pub current_size_bytes: Option<i64>,
    /// False when the original source file is gone: the replacement would
    /// still work, but could no longer be undone from the Protokoll.
    pub source_available: bool,
    pub candidates: Vec<ReplacementCandidate>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementScan {
    pub matches: Vec<ReplacementMatch>,
    /// How many project files were checked, and how many files the folder held.
    pub checked_items: usize,
    pub folder_files: usize,
}

/// How deep below the chosen folder candidates are looked for, and the most
/// directory entries visited — a safety cap in the spirit of the disk
/// search, so a mistakenly chosen huge folder cannot run away.
const REPLACE_SCAN_MAX_DEPTH: usize = 6;
const REPLACE_SCAN_MAX_ENTRIES: usize = 200_000;

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// True if `stem` occurs in `haystack` as a whole "word": the characters
/// directly before and after it are not letters/digits. `IMG_0012` therefore
/// matches `IMG_0012_komprimiert` but not `IMG_00123`.
fn contains_whole_stem(haystack: &str, stem: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(stem) {
        let start = from + pos;
        let end = start + stem.len();
        let before_ok = haystack[..start].chars().next_back().is_none_or(|c| !is_name_char(c));
        let after_ok = haystack[end..].chars().next().is_none_or(|c| !is_name_char(c));
        if before_ok && after_ok {
            return true;
        }
        // Advance by one character, not one byte, to stay on a boundary.
        from = start + haystack[start..].chars().next().map_or(1, |c| c.len_utf8());
    }
    false
}

/// Looks through `folder` for files that could replace live project files.
///
/// A file in the folder is a candidate for an item when the item's filename
/// without extension appears in the candidate's name as a whole word (see
/// `contains_whole_stem`) and both are the same kind of file (video for
/// video, …). When one folder file fits several items, only the item with
/// the longest matching name gets it — `clip_2_komprimiert` belongs to
/// `clip_2`, not to `clip`. `item_ids` limits the check to those items;
/// `None` checks every live item of the project.
#[tauri::command]
pub async fn find_replacement_matches(
    app: AppHandle,
    item_ids: Option<Vec<String>>,
    folder: String,
) -> Result<ReplacementScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&folder);
        if !root.is_dir() {
            return Err(crate::i18n::tr("Ordner nicht gefunden.").to_string());
        }

        struct Item {
            id: String,
            filename: String,
            stem: String,
            kind: String,
            size: Option<i64>,
            source_path: Option<String>,
        }

        let items: Vec<Item> = {
            let state = app.state::<AppStateHandle>();
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let wanted: Option<std::collections::HashSet<&String>> = item_ids.as_ref().map(|ids| ids.iter().collect());
            let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?;
            let mut stmt = current
                .conn
                .prepare(&format!(
                    "SELECT id, original_filename, file_type, file_size_bytes, source_path FROM items WHERE {LIVE_ITEMS}"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                let (id, filename, kind, size, source_path) = row.map_err(|e| e.to_string())?;
                if hidden.as_ref().is_some_and(|hidden| hidden.contains(&id)) || wanted.as_ref().is_some_and(|w| !w.contains(&id)) {
                    continue;
                }
                let stem = std::path::Path::new(&filename)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if stem.is_empty() {
                    continue;
                }
                out.push(Item { id, filename, stem, kind, size, source_path });
            }
            out
        };

        let mut by_item: std::collections::HashMap<usize, Vec<ReplacementCandidate>> = std::collections::HashMap::new();
        let mut folder_files = 0usize;
        for (visited, entry) in walkdir::WalkDir::new(root)
            .max_depth(REPLACE_SCAN_MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .enumerate()
        {
            if visited >= REPLACE_SCAN_MAX_ENTRIES {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
            if name.starts_with('.') {
                continue;
            }
            folder_files += 1;

            let kind = crate::items::kind_str(crate::fsbrowse::classify(path));
            let cand_stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            let size = entry.metadata().ok().map(|m| m.len());

            let mut best_len = 0usize;
            let mut best: Vec<usize> = Vec::new();
            for (idx, item) in items.iter().enumerate() {
                if item.kind != kind || item.stem.len() < best_len || !contains_whole_stem(&cand_stem, &item.stem) {
                    continue;
                }
                // The very same file (the untouched original), or an
                // identical copy of what the project already holds, is no
                // replacement.
                let path_str = path.to_string_lossy();
                if item.source_path.as_deref() == Some(path_str.as_ref())
                    || (name == item.filename && size.is_some() && size.map(|s| s as i64) == item.size)
                {
                    continue;
                }
                if item.stem.len() > best_len {
                    best_len = item.stem.len();
                    best.clear();
                }
                best.push(idx);
            }
            for idx in best {
                by_item.entry(idx).or_default().push(ReplacementCandidate {
                    path: path.to_string_lossy().to_string(),
                    name: name.clone(),
                    size_bytes: size,
                });
            }
        }

        let mut matches: Vec<ReplacementMatch> = by_item
            .into_iter()
            .map(|(idx, mut candidates)| {
                candidates.sort_by(|a, b| a.name.cmp(&b.name));
                let item = &items[idx];
                ReplacementMatch {
                    item_id: item.id.clone(),
                    name: item.filename.clone(),
                    kind: item.kind.clone(),
                    current_size_bytes: item.size,
                    source_available: item.source_path.as_deref().is_some_and(|p| std::path::Path::new(p).is_file()),
                    candidates,
                }
            })
            .collect();
        matches.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        Ok(ReplacementScan { matches, checked_items: items.len(), folder_files })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementRequest {
    pub item_id: String,
    pub new_path: String,
}

/// One replaced file, for the report shown after the operation.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub name: String,
    pub new_name: String,
    pub old_size_bytes: i64,
    pub new_size_bytes: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub replaced: usize,
    pub files: Vec<ReplacedFile>,
    /// "Dateiname: Grund" for every file that could not be replaced; those
    /// keep their old file untouched.
    pub failed: Vec<String>,
    /// Old size minus new size over all replaced files (negative if larger).
    pub saved_bytes: i64,
}

/// "Datei im Stream ersetzen" — swaps each item's in-project file for
/// the chosen new version (see `items::swap_item_file`): the old copy is
/// deleted, the new one takes its place with a fresh thumbnail, size and
/// hash, everything else about the item stays. One Replace action is logged
/// for the whole batch; undoing it re-imports the originals from their
/// source folders.
///
/// `async` + `spawn_blocking`: copying a video and extracting a frame per
/// item is real I/O that must not sit on the IPC thread.
#[tauri::command]
pub async fn replace_project_items(
    app: AppHandle,
    replacements: Vec<ReplacementRequest>,
    operation_id: String,
) -> Result<ReplaceOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let project_path = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.path.clone()
        };
        let total = replacements.len();

        let mut log_entries: Vec<action_log::LogEntry> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        let mut saved_bytes = 0i64;
        let mut files: Vec<ReplacedFile> = Vec::new();

        for (done, request) in replacements.iter().enumerate() {
            // Three steps, so the lock is never held across the slow part:
            // read what the swap needs, copy and thumbnail the new file with
            // nothing locked (a video takes a while), then a short locked
            // database step that points the item at it.
            let inputs = {
                let guard = crate::state::lock_project(&state, &project_path)?;
                let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
                let conn = &current.conn;
                let row: Option<(String, Option<i64>)> = conn
                    .query_row(
                        &format!("SELECT original_filename, file_size_bytes FROM items WHERE id = ?1 AND {LIVE_ITEMS}"),
                        params![request.item_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                match row {
                    None => None,
                    Some(row) => Some((row, crate::items::swap_inputs(conn, &request.item_id)?)),
                }
            };
            let Some(((filename, old_size), inputs)) = inputs else {
                failed.push(crate::trf!("{id}: nicht mehr im Stream", id = request.item_id));
                continue;
            };

            let new_path = std::path::Path::new(&request.new_path);
            if !new_path.is_file() {
                failed.push(crate::trf!("{filename}: neue Datei nicht gefunden", filename = filename));
                continue;
            }
            let new_name = new_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

            let swapped = inputs.prepare(&project_path, new_path).and_then(|prepared| {
                let guard = match crate::state::lock_project(&state, &project_path) {
                    Ok(guard) => guard,
                    Err(e) => {
                        crate::items::remove_stored_files(&prepared.stored_files());
                        return Err(e);
                    }
                };
                let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
                crate::items::swap_item_file_prepared(&current.conn, &project_path, &request.item_id, prepared)
            });
            match swapped {
                Ok(()) => {
                    let new_size = std::fs::metadata(new_path).map(|m| m.len() as i64).unwrap_or(0);
                    saved_bytes += old_size.unwrap_or(0) - new_size;
                    files.push(ReplacedFile {
                        name: filename.clone(),
                        new_name: new_name.clone(),
                        old_size_bytes: old_size.unwrap_or(0),
                        new_size_bytes: new_size,
                    });
                    log_entries.push(action_log::LogEntry {
                        item_id: Some(request.item_id.clone()),
                        label: filename.clone(),
                        before_value: None,
                        after_value: Some(new_name),
                        before_source: None,
                    });
                    crate::progress::emit_progress(&app, &operation_id, done + 1, total, &filename);
                }
                Err(e) => failed.push(format!("{filename}: {e}")),
            }
        }

        if !log_entries.is_empty() {
            let guard = crate::state::lock_project(&state, &project_path)?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let _ = action_log::record(&current.conn, action_log::ActionType::Replace, &log_entries);
        }
        Ok(ReplaceOutcome { replaced: log_entries.len(), files, failed, saved_bytes })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}
