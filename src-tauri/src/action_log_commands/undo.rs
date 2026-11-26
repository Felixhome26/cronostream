//! Undoing an action or one file of it, and permanently deleting copies
//! of files that were taken off the timeline.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::action_log::{self, ActionType, Conflict, LogEntry};
use crate::items;
use crate::settings;
use crate::state::AppStateHandle;
use crate::project_files::{self, PendingDeletions};
use crate::timeline_commands;

use super::log_list::{entry_table, is_phase_action};

/// What happened — or what the UI has to ask before it can happen.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UndoOutcome {
    /// Reversed. `undone` counts the entries actually restored, including
    /// any later changes undone along the way.
    #[serde(rename_all = "camelCase")]
    Done { undone: usize },
    /// Nothing to reverse, with a plain-language reason to show.
    #[serde(rename_all = "camelCase")]
    Blocked { reason: String },
    /// The file changed again after this action. These are those later
    /// changes, newest first; re-call with `cascade: true` to undo them in
    /// that order first.
    #[serde(rename_all = "camelCase")]
    Conflicts { conflicts: Vec<Conflict> },
    /// Undoing an import: should the copy in the project folder go too?
    /// Re-call with `deleteCopy` set either way.
    #[serde(rename_all = "camelCase")]
    NeedsCopyDecision { labels: Vec<String> },
}

/// Undoes a single file's share of an action.
///
/// `async` + `spawn_blocking`: undoing a removal whose copy is gone, or a
/// replacement, re-imports files — see `undo_with_prepared_restores`.
#[tauri::command]
pub async fn undo_entry(
    app: AppHandle,
    entry_id: i64,
    delete_copy: Option<bool>,
    cascade: Option<bool>,
) -> Result<UndoOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        // A negative id is a phase entry (see `phases::public_entry_id`).
        if entry_id < 0 {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            return crate::phases::undo_phase_entries(&current.conn, &[-entry_id], cascade.unwrap_or(false));
        }
        undo_with_prepared_restores(&state, &[entry_id], delete_copy, cascade.unwrap_or(false))
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Undoes a whole action — every file in it that has not been undone
/// already. `async` + `spawn_blocking`, same reasoning as `undo_entry`.
#[tauri::command]
pub async fn undo_action(
    app: AppHandle,
    action_id: i64,
    delete_copy: Option<bool>,
    cascade: Option<bool>,
) -> Result<UndoOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        undo_action_now(&state, action_id, delete_copy, cascade)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

pub(super) fn undo_action_now(
    state: &AppStateHandle,
    action_id: i64,
    delete_copy: Option<bool>,
    cascade: Option<bool>,
) -> Result<UndoOutcome, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let action_type: Option<String> = current
        .conn
        .query_row("SELECT action_type FROM action_log WHERE id = ?1", params![action_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let is_phase = action_type.as_deref().is_some_and(is_phase_action);

    let mut stmt = current
        .conn
        .prepare(&format!(
            "SELECT id FROM {} WHERE action_id = ?1 AND reverted = 0 ORDER BY id ASC",
            entry_table(is_phase)
        ))
        .map_err(|e| e.to_string())?;
    let entry_ids: Vec<i64> = stmt
        .query_map(params![action_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if entry_ids.is_empty() {
        return Ok(UndoOutcome::Blocked {
            reason: crate::i18n::tr("Diese Aktion wurde bereits vollständig rückgängig gemacht.").to_string(),
        });
    }

    if is_phase {
        return crate::phases::undo_phase_entries(&current.conn, &entry_ids, cascade.unwrap_or(false));
    }
    drop(stmt);
    drop(guard);
    undo_with_prepared_restores(state, &entry_ids, delete_copy, cascade.unwrap_or(false))
}

/// `undo_entries` in three steps, so the project lock is never held while
/// files are copied: which entries will re-import a file is read under the
/// lock, those files are copied in and thumbnailed without it
/// (`PreparedRestores`), and the undo itself then runs under the lock again
/// using them. Undoing a large removal used to copy every file back with
/// the lock held, and the whole app waited.
pub(crate) fn undo_with_prepared_restores(
    state: &AppStateHandle,
    entry_ids: &[i64],
    delete_copy: Option<bool>,
    cascade: bool,
) -> Result<UndoOutcome, String> {
    let (project_path, jobs) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        (current.path.clone(), restore_jobs(&current.conn, entry_ids)?)
    };
    let mut prepared = PreparedRestores::prepare(&project_path, jobs);
    let outcome = (|| {
        let guard = crate::state::lock_project(state, &project_path)?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        undo_entries(&current.conn, &project_path, entry_ids, delete_copy, cascade, &mut prepared)
    })();
    prepared.discard_unused();
    outcome
}

/// A file an undo will copy back in: the source of a removal whose
/// in-project copy is gone, or the original of a replacement.
pub(crate) struct RestoreJob {
    item_id: String,
    source: std::path::PathBuf,
    inputs: items::SwapInputs,
}

/// Which of `entry_ids` will re-import a file, and what each needs — the
/// same conditions `apply_undo` checks, read under the lock.
pub(crate) fn restore_jobs(conn: &Connection, entry_ids: &[i64]) -> Result<Vec<RestoreJob>, String> {
    let mut jobs = Vec::new();
    for &entry_id in entry_ids {
        let Some(target) = load_target(conn, entry_id)? else { continue };
        if target.reverted {
            continue;
        }
        let Some(item_id) = target.item_id else { continue };
        let (stored_path, source_path): (Option<String>, Option<String>) = conn
            .query_row("SELECT stored_path, source_path FROM items WHERE id = ?1", params![item_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or((None, None));
        let Some(source) = source_path.map(std::path::PathBuf::from).filter(|p| p.is_file()) else { continue };
        let needs_copy = match target.action_type {
            ActionType::Remove => !stored_path.as_deref().is_some_and(|p| Path::new(p).is_file()),
            ActionType::Replace => true,
            _ => false,
        };
        if needs_copy {
            let inputs = items::swap_inputs(conn, &item_id)?;
            jobs.push(RestoreJob { item_id, source, inputs });
        }
    }
    Ok(jobs)
}

/// Files copied into the project ahead of an undo, by item id. Whatever the
/// undo does not use — it was refused, or turned out not to need one — is
/// removed again by `discard_unused`.
#[derive(Default)]
pub(crate) struct PreparedRestores(pub(super) HashMap<String, items::PreparedItem>);

impl PreparedRestores {
    /// No database access and no lock: copying and thumbnailing only. A file
    /// that fails here is simply missing from the map, and the undo then
    /// tries it the usual way and reports the error itself.
    pub(crate) fn prepare(project_path: &Path, jobs: Vec<RestoreJob>) -> Self {
        let mut prepared = HashMap::new();
        for job in jobs {
            if let Ok(item) = job.inputs.prepare(project_path, &job.source) {
                prepared.insert(job.item_id, item);
            }
        }
        PreparedRestores(prepared)
    }

    fn take(&mut self, item_id: &str) -> Option<items::PreparedItem> {
        self.0.remove(item_id)
    }

    pub(crate) fn discard_unused(self) {
        for item in self.0.into_values() {
            items::remove_stored_files(&item.stored_files());
        }
    }
}

/// The shared core. Checks everything that could stop the undo *before*
/// changing anything, so a refusal never leaves half the work applied.
///
/// `pub(crate)` so the Papierkorb's "Wiederherstellen" can reach it: a
/// restore *is* the undo of a removal, and routing it through here rather
/// than writing a second `removed_at = NULL` path keeps the duplicate
/// check, the re-import-from-source fallback and the `reverted` bookkeeping
/// from drifting apart. See `file_ops_commands::restore_project_items`.
pub(crate) fn undo_entries(
    conn: &Connection,
    project_path: &Path,
    entry_ids: &[i64],
    delete_copy: Option<bool>,
    cascade: bool,
    prepared: &mut PreparedRestores,
) -> Result<UndoOutcome, String> {
    let mut plan: Vec<i64> = Vec::new();

    for &entry_id in entry_ids {
        let Some(target) = load_target(conn, entry_id)? else {
            return Ok(UndoOutcome::Blocked {
                reason: crate::i18n::tr("Dieser Protokolleintrag existiert nicht mehr.").to_string(),
            });
        };

        if target.reverted {
            continue;
        }

        if !target.action_type.is_undoable() {
            return Ok(UndoOutcome::Blocked {
                reason: crate::i18n::tr("Endgültig gelöschte Dateien können nicht wiederhergestellt werden.")
                    .to_string(),
            });
        }

        if let Some(item_id) = &target.item_id {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM items WHERE id = ?1)",
                    params![item_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Ok(UndoOutcome::Blocked {
                    reason: crate::trf!(
                        "„{label}“ wurde endgültig gelöscht und kann nicht wiederhergestellt werden.",
                        label = target.label
                    ),
                });
            }
        }

        let conflicts = action_log::later_conflicts(conn, entry_id)?;
        if !conflicts.is_empty() {
            if !cascade {
                return Ok(UndoOutcome::Conflicts { conflicts });
            }
            // Newest first, so each undo restores the state the one before
            // it recorded as "before".
            for conflict in conflicts {
                if !plan.contains(&conflict.entry_id) {
                    plan.push(conflict.entry_id);
                }
            }
        }

        if !plan.contains(&entry_id) {
            plan.push(entry_id);
        }
    }

    if plan.is_empty() {
        return Ok(UndoOutcome::Blocked {
            reason: crate::i18n::tr("Diese Aktion wurde bereits rückgängig gemacht.").to_string(),
        });
    }

    // Undoing an import means the file leaves the project — and its copy
    // inside the project folder would otherwise be orphaned, so the user
    // decides. Asked once for the whole plan rather than per file.
    if delete_copy.is_none() {
        let import_labels = plan
            .iter()
            .filter_map(|&id| load_target(conn, id).ok().flatten())
            .filter(|t| t.action_type == ActionType::Import)
            .map(|t| t.label)
            .collect::<Vec<_>>();
        if !import_labels.is_empty() {
            return Ok(UndoOutcome::NeedsCopyDecision { labels: import_labels });
        }
    }

    precheck_plan(conn, &plan)?;

    let mut undone = 0usize;
    for entry_id in plan {
        let Some(target) = load_target(conn, entry_id)? else { continue };
        if target.reverted {
            continue;
        }
        if apply_undo(conn, project_path, &target, delete_copy.unwrap_or(false), prepared)? {
            conn.execute(
                "UPDATE action_log_entry SET reverted = 1 WHERE id = ?1",
                params![entry_id],
            )
            .map_err(|e| crate::trf!("Konnte Protokoll nicht aktualisieren: {e}", e = e))?;
            undone += 1;
        }
    }

    Ok(UndoOutcome::Done { undone })
}

pub(super) struct UndoTarget {
    action_type: ActionType,
    item_id: Option<String>,
    label: String,
    before_value: Option<String>,
    before_source: Option<String>,
    reverted: bool,
}

pub(super) fn load_target(conn: &Connection, entry_id: i64) -> Result<Option<UndoTarget>, String> {
    let row: Option<(String, Option<String>, String, Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT a.action_type, e.item_id, e.label, e.before_value, e.before_source, e.reverted
             FROM action_log_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.id = ?1",
            params![entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((action_type, item_id, label, before_value, before_source, reverted)) = row else {
        return Ok(None);
    };
    let Some(action_type) = ActionType::from_str(&action_type) else {
        return Ok(None);
    };

    Ok(Some(UndoTarget {
        action_type,
        item_id,
        label,
        before_value,
        before_source,
        reverted: reverted != 0,
    }))
}

/// Reverses one entry. Returns false if it turned out to be a no-op, so the
/// caller doesn't mark it reverted on a row that didn't move.
pub(super) fn apply_undo(
    conn: &Connection,
    project_path: &Path,
    target: &UndoTarget,
    delete_copy: bool,
    prepared: &mut PreparedRestores,
) -> Result<bool, String> {
    match target.action_type {
        ActionType::Purge => Ok(false),

        ActionType::Import => {
            let Some(item_id) = &target.item_id else { return Ok(false) };
            let paths: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT stored_path, thumbnail_path FROM items WHERE id = ?1 AND removed_at IS NULL",
                    params![item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((stored_path, thumbnail_path)) = paths else { return Ok(false) };

            // Soft-delete, like every other removal — never a hard DELETE.
            // A hard delete erased the row's own signal that the file is
            // gone, so re-dropping the same source file right after looked
            // to `add_items` like nothing had ever happened to it instead
            // of a fresh import (the "already in the project" / duplicate
            // checks only trust `removed_at IS NULL`). Keeping the row also
            // means the file could later be brought back the same way a
            // removed item is, instead of this being a dead end.
            let changed = conn
                .execute(
                    "UPDATE items SET removed_at = ?1 WHERE id = ?2 AND removed_at IS NULL",
                    params![chrono::Utc::now().to_rfc3339(), item_id],
                )
                .map_err(|e| crate::trf!("Konnte Eintrag nicht entfernen: {e}", e = e))?;

            if delete_copy {
                // Inside the project folder only — `stored_path` is the
                // copy this import created, never the user's original, and
                // `project_files` refuses anything outside the project. The
                // row's UPDATE above has already committed.
                project_files::remove_item_files(project_path, &stored_path, thumbnail_path.as_deref());
            }
            Ok(changed > 0)
        }

        ActionType::Remove => {
            let Some(item_id) = &target.item_id else { return Ok(false) };

            refuse_if_reimported(conn, item_id, &target.label)?;

            // The common case — the in-project copy is still sitting right
            // where the removal left it. If "Dateien beim Entfernen
            // löschen" already deleted it, fall back to re-importing from
            // the original source file instead (restore_from_source),
            // rather than reviving a row that points at a file that's gone.
            let stored_path: Option<String> = conn
                .query_row("SELECT stored_path FROM items WHERE id = ?1", params![item_id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let copy_present = stored_path.as_deref().is_some_and(|p| Path::new(p).is_file());

            if copy_present {
                let changed = conn
                    .execute(
                        "UPDATE items SET removed_at = NULL WHERE id = ?1",
                        params![item_id],
                    )
                    .map_err(|e| crate::trf!("Konnte Datei nicht wiederherstellen: {e}", e = e))?;
                Ok(changed > 0)
            } else if let Some(item) = prepared.take(item_id) {
                items::update_restored_item_files(conn, item_id, item)?;
                Ok(true)
            } else {
                restore_from_source(conn, project_path, item_id)
            }
        }

        ActionType::Rename => {
            let Some(item_id) = &target.item_id else { return Ok(false) };
            conn.execute(
                "UPDATE items SET display_name = ?1 WHERE id = ?2",
                params![target.before_value, item_id],
            )
            .map_err(|e| crate::trf!("Konnte Anzeigename nicht wiederherstellen: {e}", e = e))?;
            Ok(true)
        }

        ActionType::DateChange | ActionType::AiDateChange => {
            let Some(item_id) = &target.item_id else { return Ok(false) };
            let (Some(before), Some(source)) = (&target.before_value, &target.before_source) else {
                return Ok(false);
            };
            conn.execute(
                "UPDATE items SET resolved_timestamp = ?1, timestamp_source = ?2 WHERE id = ?3",
                params![before, source, item_id],
            )
            .map_err(|e| crate::trf!("Konnte Datum nicht wiederherstellen: {e}", e = e))?;
            Ok(true)
        }

        // "Datei im Stream ersetzen" is undone by re-importing the
        // item's original source file over the replacement. If that source
        // is gone the entry is not undoable (`finish_entry` already says so).
        ActionType::Replace => {
            let Some(item_id) = &target.item_id else { return Ok(false) };
            let source_path: Option<String> = conn
                .query_row("SELECT source_path FROM items WHERE id = ?1", params![item_id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            let Some(source_path) = source_path.filter(|p| Path::new(p).is_file()) else {
                return Err(replace_source_missing(&target.label));
            };
            match prepared.take(item_id) {
                Some(item) => items::swap_item_file_prepared(conn, project_path, item_id, item)?,
                None => items::swap_item_file(conn, project_path, item_id, Path::new(&source_path))?,
            }
            Ok(true)
        }

        // Phase actions never reach this path: their entries are not in
        // `action_log_entry` (see `phases::undo_phase_entries`).
        ActionType::PhaseGroupCreate
        | ActionType::PhaseGroupUpdate
        | ActionType::PhaseGroupReorder
        | ActionType::PhaseGroupRemove
        | ActionType::PhaseCreate
        | ActionType::PhaseUpdate
        | ActionType::PhaseRemove => Ok(false),

        ActionType::SettingChange => {
            // The label comes from the stream's own log, which a copied or
            // tampered stream controls — it must not reach the privacy rows.
            super::project_settings::ensure_known_setting(&target.label)?;
            match &target.before_value {
                // No previous value means the setting didn't exist before,
                // so restoring it means removing it again rather than
                // writing an empty string.
                None => {
                    conn.execute("DELETE FROM settings WHERE key = ?1", params![target.label])
                        .map_err(|e| crate::trf!("Konnte Einstellung nicht zurücksetzen: {e}", e = e))?;
                }
                Some(value) => settings::set(conn, &target.label, value)?,
            }
            Ok(true)
        }
    }
}

/// The same source file may have been imported again while this one sat
/// removed. Restoring it as well would put the same photo on the timeline
/// twice, which is exactly what the duplicate check exists to prevent.
pub(super) fn refuse_if_reimported(conn: &Connection, item_id: &str, label: &str) -> Result<(), String> {
    let duplicate: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM items live
                JOIN items removed ON removed.id = ?1
                WHERE live.id != removed.id
                  AND live.source_path IS NOT NULL
                  AND live.source_path = removed.source_path
                  AND live.removed_at IS NULL
             )",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if duplicate {
        return Err(crate::trf!("„{label}“ ist inzwischen erneut im Stream. Zuerst muss dieser Import rückgängig gemacht werden.", label = label));
    }
    Ok(())
}

pub(super) fn replace_source_missing(label: &str) -> String {
    crate::trf!(
        "Die Originaldatei von „{label}“ liegt nicht mehr im Quellordner. Das Ersetzen kann nicht rückgängig gemacht werden.",
        label = label
    )
}

/// The refusals `apply_undo` can hit, checked for the whole plan before
/// anything is applied — so an undo of 200 files that would fail at the
/// 150th refuses up front instead of stopping with 149 already reverted.
pub(super) fn precheck_plan(conn: &Connection, plan: &[i64]) -> Result<(), String> {
    for &entry_id in plan {
        let Some(target) = load_target(conn, entry_id)? else { continue };
        if target.reverted {
            continue;
        }
        if target.action_type == ActionType::SettingChange {
            super::project_settings::ensure_known_setting(&target.label)?;
        }
        let Some(item_id) = &target.item_id else { continue };
        match target.action_type {
            ActionType::Remove => refuse_if_reimported(conn, item_id, &target.label)?,
            ActionType::Replace => {
                let source_present = conn
                    .query_row("SELECT source_path FROM items WHERE id = ?1", params![item_id], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .optional()
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .is_some_and(|p| Path::new(&p).is_file());
                if !source_present {
                    return Err(replace_source_missing(&target.label));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Undoes a removal whose in-project copy is already gone (deleted by the
/// "Dateien beim Entfernen löschen" setting) by re-copying the file from
/// its original source location and regenerating its thumbnail — called
/// only once `apply_undo` has confirmed the stored copy itself is missing.
///
/// The item's existing date/timestamp-source (passed through as
/// `prepare_item`'s `date_override`) and rotation are kept exactly as they
/// already were; only the file-derived columns — `stored_path`,
/// `thumbnail_path`, `file_size_bytes`, `video_frame_percent`,
/// `extracted_text` — are refreshed from the freshly re-copied file. If the
/// source file has also since moved, been renamed or deleted, this is a
/// plain "not restorable" (`Ok(false)`), same as any other removal whose
/// copy can't be brought back.
pub(super) fn restore_from_source(conn: &Connection, project_path: &Path, item_id: &str) -> Result<bool, String> {
    let row: Option<(Option<String>, String, String, Option<f64>)> = conn
        .query_row(
            "SELECT source_path, resolved_timestamp, timestamp_source, video_frame_percent
             FROM items WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((source_path, resolved_timestamp, timestamp_source, video_frame_percent)) = row else {
        return Ok(false);
    };
    let Some(source_path) = source_path.filter(|p| Path::new(p).is_file()) else {
        return Ok(false);
    };

    let prepared = items::prepare_item(
        project_path,
        Path::new(&source_path),
        video_frame_percent.unwrap_or_else(|| items::default_video_frame_percent(conn)),
        Some((resolved_timestamp, timestamp_source)),
        items::quick_hash_on_ingest_enabled(conn),
    )?;
    items::update_restored_item_files(conn, item_id, prepared)?;

    Ok(true)
}

/// Permanently deletes the in-project copies of files that were taken off
/// the timeline, and records that it happened.
///
/// This is the only path that deletes anything irreversibly, and it is
/// always an explicit choice: either the "endgültig löschen" button on a
/// removal entry, or the log's select-all checkboxes for clearing out
/// everything that has been removed. Files outside the project folder are
/// untouched — `project_files` refuses them, whatever the stored path says.
/// The files go only after the transaction committed.
///
/// `async` + `spawn_blocking` + one transaction, same reasoning as
/// `file_ops_commands::purge_items_and_log`.
#[tauri::command]
pub async fn purge_items(app: AppHandle, item_ids: Vec<String>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let conn = &current.conn;
        let total = item_ids.len();

        let mut deletions = PendingDeletions::default();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // Only ever files that are already off the timeline: permanent
        // deletion is the second step of a removal, never a shortcut past it
        // — enforced by `purge_item_row`'s own `removed_at IS NOT NULL` check.
        let log_entries: Vec<LogEntry> = item_ids
            .iter()
            .enumerate()
            .filter_map(|(done, id)| {
                let purged = timeline_commands::purge_item_row(&tx, id, &mut deletions);
                if let Some(label) = &purged {
                    crate::progress::emit_progress(&app, &operation_id, done + 1, total, label);
                }
                purged.map(|label| LogEntry::gone(&label))
            })
            .collect();
        let purged = log_entries.len();

        if !log_entries.is_empty() {
            let _ = action_log::record(&tx, ActionType::Purge, &log_entries);
        }
        tx.commit().map_err(|e| e.to_string())?;
        deletions.run(&current.path);
        Ok(purged)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}
