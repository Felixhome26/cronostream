//! Reading the log for the "Protokoll" tab: actions page by page, and the
//! files inside one of them.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::action_log::ActionType;
use crate::state::AppStateHandle;

/// How many actions one page of the log holds. The log is unbounded, so it
/// is always paged — and entries within an action are fetched separately
/// (`list_action_entries`), so opening the tab never loads the 147 rows of
/// a bulk import it isn't showing yet.
pub(super) const DEFAULT_PAGE_SIZE: u32 = 50;

/// Turning a page's `EntryRow`s into `EntryView`s stats every file they
/// touch (see `finish_entries`) — on a slow or struggling disk that can
/// take a while, so the UI gets told how far along it is.
pub(super) const ACTION_LOG_PROGRESS_EVENT: &str = "action-log-progress";

#[derive(Serialize, Clone)]
pub(super) struct ActionLogProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub id: i64,
    pub item_id: Option<String>,
    pub label: String,
    pub before_value: Option<String>,
    pub after_value: Option<String>,
    pub reverted: bool,
    /// False when there is nothing left to restore — the action type is not
    /// reversible (a permanent delete), or the file has since been
    /// permanently deleted and its row is gone.
    pub can_undo: bool,
    /// True for a file that is off the timeline but still taking up space
    /// in the project folder: the entry offers "endgültig löschen".
    pub can_purge: bool,
    /// The item's thumbnail, for the hover preview — only while the `items`
    /// row still exists (never after a permanent delete, which erases the
    /// thumbnail file along with the row; see `purge_item_row`).
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionView {
    pub id: i64,
    pub action_type: String,
    pub performed_at: i64,
    pub entry_count: i64,
    pub reverted_count: i64,
    /// Inline entries. For a single-file action that is the whole story, so
    /// the UI needs no expand step; for a bulk action it holds the search
    /// matches, or nothing at all when there is no search (the tree is
    /// fetched on expand).
    pub entries: Vec<EntryView>,
}

/// Reads one page of the log, newest first.
///
/// `query` searches the labels of the entries — the file names as they were
/// at the time — and keeps any action with at least one match, carrying the
/// matching entries inline so a file found inside a 147-file import shows
/// up directly under its group. Matching happens in Rust, not SQL, for the
/// same reason as `search_items`: SQLite's `lower()`/`LIKE` only case-fold
/// ASCII, so "müller" would silently miss "Müller".
#[tauri::command]
pub async fn list_action_log(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    query: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<ActionView>, String> {
    let needle = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = offset.unwrap_or(0);

    // Phase 1, with the project lock held: everything here is a plain,
    // indexed SQLite read, so it stays fast regardless of how slow the
    // disk under the project folder is. What it does *not* do yet is stat
    // any file — that's `finish_entries` below, deliberately run after the
    // lock is dropped so a struggling disk (e.g. the external NTFS drive
    // this project has lived on) stalls only this command, not every other
    // one waiting on the same `AppStateHandle` mutex.
    struct ActionRows {
        id: i64,
        action_type: String,
        performed_at: i64,
        entry_count: i64,
        reverted_count: i64,
        rows: Vec<EntryRow>,
    }

    let gathered: Vec<ActionRows> = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let conn = &current.conn;
        let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Everywhere)?;

        // With a search active, paging over actions would hide matches
        // behind pages of non-matching actions. Scan and page over the
        // *matches* instead; the labels are short and the index on
        // `action_id` keeps it to one pass. Hidden private files thin the
        // pages out the same way.
        let scan_all = needle.is_some() || hidden.is_some();
        let action_ids: Vec<i64> = if scan_all {
            let mut stmt = conn
                .prepare("SELECT id FROM action_log ORDER BY id DESC")
                .map_err(|e| e.to_string())?;
            let ids = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            ids
        } else {
            let mut stmt = conn
                .prepare("SELECT id FROM action_log ORDER BY id DESC LIMIT ?1 OFFSET ?2")
                .map_err(|e| e.to_string())?;
            let ids = stmt
                .query_map(params![limit, offset], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            ids
        };

        let mut gathered = Vec::new();
        let mut skipped = 0u32;

        for action_id in action_ids {
            let (action_type, performed_at): (String, i64) = conn
                .query_row(
                    "SELECT action_type, performed_at FROM action_log WHERE id = ?1",
                    params![action_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;

            let is_phase = is_phase_action(&action_type);
            let (mut entry_count, mut reverted_count): (i64, i64) = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*), COALESCE(SUM(reverted), 0) FROM {} WHERE action_id = ?1",
                        entry_table(is_phase)
                    ),
                    params![action_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;

            // An action about nothing but hidden files is left out entirely;
            // a mixed one keeps its other files and a count that matches them.
            if let (Some(hidden), false) = (&hidden, is_phase) {
                let (hidden_count, hidden_reverted) = hidden_entry_counts(conn, action_id, hidden)?;
                if hidden_count > 0 && hidden_count == entry_count {
                    continue;
                }
                entry_count -= hidden_count;
                reverted_count -= hidden_reverted;
            }

            let mut rows = if needle.is_some() || entry_count == 1 {
                if is_phase {
                    load_phase_entry_rows(conn, action_id, needle.as_deref())?
                } else {
                    load_entry_rows(conn, action_id, &action_type, needle.as_deref())?
                }
            } else {
                Vec::new()
            };
            if let Some(hidden) = &hidden {
                rows.retain(|row| !row.item_id.as_ref().is_some_and(|id| hidden.contains(id)));
            }

            if needle.is_some() && rows.is_empty() {
                continue;
            }
            if scan_all {
                // Paging applies to matching actions only.
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if gathered.len() as u32 >= limit {
                    break;
                }
            }

            gathered.push(ActionRows {
                id: action_id,
                action_type,
                performed_at,
                entry_count,
                reverted_count,
                rows,
            });
        }

        gathered
    };

    // Phase 2, lock-free: the only slow part (a couple of `Path::exists`
    // calls per entry) runs on a blocking-friendly thread, with a progress
    // event after every action so a page full of single-file actions still
    // shows movement instead of a frozen spinner.
    let total: usize = gathered.iter().map(|a| a.rows.len()).sum();
    tauri::async_runtime::spawn_blocking(move || {
        let mut done = 0usize;
        let mut views = Vec::with_capacity(gathered.len());
        for action in gathered {
            let entry_count_in_batch = action.rows.len();
            let entries = finish_entries(&action.action_type, action.rows);
            done += entry_count_in_batch;
            if total > 0 {
                let _ = app.emit(ACTION_LOG_PROGRESS_EVENT, ActionLogProgress { done, total });
            }
            views.push(ActionView {
                id: action.id,
                action_type: action.action_type,
                performed_at: action.performed_at,
                entry_count: action.entry_count,
                reverted_count: action.reverted_count,
                entries,
            });
        }
        views
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))
}

/// The per-file rows of one action — what the tree shows when a bulk
/// operation is expanded.
#[tauri::command]
pub async fn list_action_entries(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    action_id: i64,
) -> Result<Vec<EntryView>, String> {
    let (action_type, rows) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        let action_type: String = current
            .conn
            .query_row(
                "SELECT action_type FROM action_log WHERE id = ?1",
                params![action_id],
                |row| row.get(0),
            )
            .map_err(|e| crate::trf!("Protokolleintrag nicht gefunden: {e}", e = e))?;

        let mut rows = if is_phase_action(&action_type) {
            load_phase_entry_rows(&current.conn, action_id, None)?
        } else {
            load_entry_rows(&current.conn, action_id, &action_type, None)?
        };
        if let Some(hidden) = crate::privacy::hidden_ids(current, crate::privacy::Surface::Everywhere)? {
            rows.retain(|row| !row.item_id.as_ref().is_some_and(|id| hidden.contains(id)));
        }
        (action_type, rows)
    };

    let total = rows.len();
    tauri::async_runtime::spawn_blocking(move || {
        if total == 0 {
            return finish_entries(&action_type, rows);
        }
        // A bulk action's entries are stat-checked one at a time so the
        // progress bar still moves on a slow disk — the same event the
        // page-level load uses, since the two never run at once (expanding
        // only happens once the page itself has finished loading).
        let mut out = Vec::with_capacity(rows.len());
        for (done, row) in rows.into_iter().enumerate() {
            out.push(finish_entry(&action_type, row));
            let _ = app.emit(ACTION_LOG_PROGRESS_EVENT, ActionLogProgress { done: done + 1, total });
        }
        out
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))
}

/// One log entry as read from the database, before the filesystem checks
/// (`finish_entry`) that turn it into an `EntryView`. Keeping the split
/// means the database — fast, and guarded by the project-wide lock — and
/// the disk — potentially slow, and not guarded by anything — are never
/// touched in the same step.
pub(super) struct EntryRow {
    id: i64,
    item_id: Option<String>,
    label: String,
    before_value: Option<String>,
    after_value: Option<String>,
    reverted: bool,
    /// (removed_at, stored_path, source_path, thumbnail_path) — `None` when
    /// the entry has no item, or the item's row is gone (permanently
    /// deleted).
    item_state: Option<(Option<String>, String, Option<String>, Option<String>)>,
    is_currently_removed: bool,
}

pub(super) fn is_phase_action(action_type: &str) -> bool {
    ActionType::from_str(action_type).is_some_and(|t| t.is_phase())
}

/// Where an action's entries are: phase actions keep theirs in
/// `action_log_phase_entry` (see `action_log::record_phase`).
pub(super) fn entry_table(is_phase: bool) -> &'static str {
    if is_phase {
        "action_log_phase_entry"
    } else {
        "action_log_entry"
    }
}

/// The entries of a phase action, shaped like file entries so the
/// Protokoll lists them the same way. Their ids are negated (see
/// `phases::public_entry_id`); `before_value`/`after_value` carry the JSON
/// of the changed fields. No file is behind them, so `finish_entry` leaves
/// them undoable exactly while they are not reverted.
pub(super) fn load_phase_entry_rows(conn: &Connection, action_id: i64, needle: Option<&str>) -> Result<Vec<EntryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, before_json, after_json, reverted
             FROM action_log_phase_entry WHERE action_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![action_id], |row| {
            Ok(EntryRow {
                id: crate::phases::public_entry_id(row.get(0)?),
                item_id: None,
                label: row.get(1)?,
                before_value: row.get(2)?,
                after_value: row.get(3)?,
                reverted: row.get::<_, i64>(4)? != 0,
                item_state: None,
                is_currently_removed: false,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| needle.is_none_or(|n| row.label.to_lowercase().contains(n)))
        .collect())
}

/// The database half of `load_entries`: every row of `action_id`, with the
/// `needle` label filter already applied, but no `Path::exists` calls yet.
/// How many of an action's entries, and how many of its reverted ones, are
/// about files the private mode is hiding.
pub(super) fn hidden_entry_counts(conn: &Connection, action_id: i64, hidden: &std::collections::HashSet<String>) -> Result<(i64, i64), String> {
    let mut stmt = conn
        .prepare("SELECT item_id, reverted FROM action_log_entry WHERE action_id = ?1 AND item_id IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![action_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut counts = (0, 0);
    for row in rows {
        let (item_id, reverted) = row.map_err(|e| e.to_string())?;
        if hidden.contains(&item_id) {
            counts.0 += 1;
            counts.1 += reverted;
        }
    }
    Ok(counts)
}

pub(super) fn load_entry_rows(
    conn: &Connection,
    action_id: i64,
    action_type: &str,
    needle: Option<&str>,
) -> Result<Vec<EntryRow>, String> {
    let parsed = ActionType::from_str(action_type);

    let mut stmt = conn
        .prepare(
            "SELECT id, item_id, label, before_value, after_value, reverted
             FROM action_log_entry WHERE action_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![action_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)? != 0,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let (id, item_id, label, before_value, after_value, reverted) = row.map_err(|e| e.to_string())?;

        if let Some(needle) = needle {
            if !label.to_lowercase().contains(needle) {
                continue;
            }
        }

        // One lookup answers three questions: whether the item still exists
        // at all (a permanently deleted one can never be restored), whether
        // its copy is sitting removed-but-present in the project folder
        // (what "endgültig löschen" is for), and — if that copy is already
        // gone, e.g. via "Dateien beim Entfernen löschen" — whether the
        // original source file is still there to undo by re-importing from
        // (see `restore_from_source`).
        let item_state: Option<(Option<String>, String, Option<String>, Option<String>)> = match &item_id {
            Some(id) => conn
                .query_row(
                    "SELECT removed_at, stored_path, source_path, thumbnail_path FROM items WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?,
            None => None,
        };

        // True for whichever side of the entry currently has the item off
        // the timeline with its copy still sitting there. For a Remove
        // entry that's the un-reverted state (the removal is in effect);
        // for an Import entry it's the opposite — reverted means its own
        // undo (with "Kopie löschen" unticked) just soft-removed the item,
        // same as `apply_undo`'s Import arm now does instead of a hard
        // DELETE. Every other action type never takes an item off the
        // timeline, so it never offers "endgültig löschen".
        let is_currently_removed = match parsed {
            Some(ActionType::Remove) => !reverted,
            Some(ActionType::Import) => reverted,
            _ => false,
        };

        out.push(EntryRow {
            id,
            item_id,
            label,
            before_value,
            after_value,
            reverted,
            item_state,
            is_currently_removed,
        });
    }
    Ok(out)
}

/// The filesystem half of `load_entries` — every `Path::exists`/`is_file`
/// call lives here, and only here, so it's easy to see what actually needs
/// to run off the project lock.
pub(super) fn finish_entry(action_type: &str, row: EntryRow) -> EntryView {
    let parsed = ActionType::from_str(action_type);
    let undoable_type = parsed.map(|t| t.is_undoable()).unwrap_or(false);
    let is_removal = parsed == Some(ActionType::Remove);

    let item_exists = row.item_id.is_none() || row.item_state.is_some();
    let can_purge = row.is_currently_removed
        && row
            .item_state
            .as_ref()
            .is_some_and(|(removed_at, stored_path, _, _)| removed_at.is_some() && Path::new(stored_path).exists());
    // Only a removal needs this extra check — every other undoable action
    // type never deletes the file it touches.
    let file_restorable = if parsed == Some(ActionType::Replace) {
        // Undone by re-importing the original, so that must still exist.
        row.item_state
            .as_ref()
            .is_some_and(|(_, _, source_path, _)| source_path.as_deref().is_some_and(|p| Path::new(p).is_file()))
    } else {
        !is_removal
            || row.item_state.as_ref().is_some_and(|(_, stored_path, source_path, _)| {
                Path::new(stored_path).exists() || source_path.as_deref().is_some_and(|p| Path::new(p).is_file())
            })
    };
    let thumbnail_path = row.item_state.as_ref().and_then(|(_, _, _, thumbnail_path)| thumbnail_path.clone());

    EntryView {
        id: row.id,
        item_id: row.item_id,
        label: row.label,
        before_value: row.before_value,
        after_value: row.after_value,
        reverted: row.reverted,
        can_undo: undoable_type && !row.reverted && item_exists && file_restorable,
        can_purge,
        thumbnail_path,
    }
}

pub(super) fn finish_entries(action_type: &str, rows: Vec<EntryRow>) -> Vec<EntryView> {
    rows.into_iter().map(|row| finish_entry(action_type, row)).collect()
}

#[cfg(test)]
pub(super) fn load_entries(
    conn: &Connection,
    action_id: i64,
    action_type: &str,
    needle: Option<&str>,
) -> Result<Vec<EntryView>, String> {
    let rows = load_entry_rows(conn, action_id, action_type, needle)?;
    Ok(finish_entries(action_type, rows))
}
