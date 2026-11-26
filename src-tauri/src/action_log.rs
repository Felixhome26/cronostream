//! The action log behind the "Protokoll" tab: every action the user takes
//! is recorded here, forever, with enough state to reverse it. This module
//! owns the write side (recording, grouping) and the reasoning about
//! whether an undo is safe; executing an undo lives with the commands that
//! perform the original action.
//!
//! Two design points worth knowing before changing anything here:
//!
//! **Removal is a flag, not a payload.** Removing a file from the timeline
//! sets `items.removed_at` and leaves the row and the in-project copy
//! alone, so undoing it is a one-column UPDATE. The alternative — deleting
//! the row and storing enough of it in the log to rebuild it — would make
//! this table carry a copy of nearly every `items` column, for the one
//! action type that is most likely to happen in bulk. See `schema::SCHEMA`.
//!
//! **Order is the rowid.** `action_log.id` is monotonic, so "did anything
//! happen to this file after action X" is `action_id > X`, with no
//! timestamp comparison and no index beyond the one on `(item_id,
//! action_id)`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Two consecutive single-file actions of the same type this close together
/// collapse into one log entry, so correcting five dates in a row reads as
/// one "5× Datum geändert" node rather than five separate lines. The window
/// slides with each addition: an uninterrupted stream of edits keeps
/// extending the same group, a pause longer than this starts a new one.
const GROUPING_WINDOW_MS: i64 = 60_000;

/// What part of an item an action changes. Two actions conflict only if
/// they touch the same field — undoing a rename is unaffected by a later
/// date correction, and nagging about it would train the user to click
/// through the warning that actually matters.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Field {
    /// Whether the item is in the timeline at all.
    Presence,
    DisplayName,
    Timestamp,
    /// A project setting rather than a file.
    Setting,
    /// Which file sits behind the item (a replacement swaps it; nothing
    /// else touches it).
    File,
    /// The editable fields of a Themenbereich or a phase (name, dates,
    /// colour, "läuft noch", "Überlappung erlaubt"). Two such changes only
    /// conflict if they share a field — see `later_phase_conflicts`.
    Content,
    /// The vertical order of the Themenbereiche.
    Order,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActionType {
    /// Files copied into the project.
    Import,
    /// Removed from the timeline; files stay on disk.
    Remove,
    /// Removed *and* the in-project copy deleted. Not reversible.
    Purge,
    Rename,
    /// Date corrected by hand (typed, or by dragging the tile).
    DateChange,
    /// Date taken over from an imported AI metadata suggestion.
    AiDateChange,
    SettingChange,
    /// The in-project file was swapped for another version of itself (e.g.
    /// a later compressed video). Undone by re-importing the source file.
    Replace,
    // Life phases (`phases.rs`). Their entries live in
    // `action_log_phase_entry`, not `action_log_entry` — `is_phase` says
    // which table an action's entries are in.
    PhaseGroupCreate,
    /// Name or "Überlappung erlaubt" of a Themenbereich changed.
    PhaseGroupUpdate,
    PhaseGroupReorder,
    /// Takes the group's live phases with it, and undoing it brings them
    /// back in the same entry.
    PhaseGroupRemove,
    PhaseCreate,
    /// Title, dates, colour or "läuft noch" changed.
    PhaseUpdate,
    PhaseRemove,
}

impl ActionType {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionType::Import => "import",
            ActionType::Remove => "remove",
            ActionType::Purge => "purge",
            ActionType::Rename => "rename",
            ActionType::DateChange => "date_change",
            ActionType::AiDateChange => "ai_date_change",
            ActionType::SettingChange => "setting_change",
            ActionType::Replace => "replace",
            ActionType::PhaseGroupCreate => "phase_group_create",
            ActionType::PhaseGroupUpdate => "phase_group_update",
            ActionType::PhaseGroupReorder => "phase_group_reorder",
            ActionType::PhaseGroupRemove => "phase_group_remove",
            ActionType::PhaseCreate => "phase_create",
            ActionType::PhaseUpdate => "phase_update",
            ActionType::PhaseRemove => "phase_remove",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "import" => ActionType::Import,
            "remove" => ActionType::Remove,
            "purge" => ActionType::Purge,
            "rename" => ActionType::Rename,
            "date_change" => ActionType::DateChange,
            "ai_date_change" => ActionType::AiDateChange,
            "setting_change" => ActionType::SettingChange,
            "replace" => ActionType::Replace,
            "phase_group_create" => ActionType::PhaseGroupCreate,
            "phase_group_update" => ActionType::PhaseGroupUpdate,
            "phase_group_reorder" => ActionType::PhaseGroupReorder,
            "phase_group_remove" => ActionType::PhaseGroupRemove,
            "phase_create" => ActionType::PhaseCreate,
            "phase_update" => ActionType::PhaseUpdate,
            "phase_remove" => ActionType::PhaseRemove,
            _ => return None,
        })
    }

    pub fn field(self) -> Field {
        match self {
            ActionType::Import | ActionType::Remove | ActionType::Purge => Field::Presence,
            ActionType::Rename => Field::DisplayName,
            ActionType::DateChange | ActionType::AiDateChange => Field::Timestamp,
            ActionType::SettingChange => Field::Setting,
            ActionType::Replace => Field::File,
            ActionType::PhaseGroupCreate
            | ActionType::PhaseGroupRemove
            | ActionType::PhaseCreate
            | ActionType::PhaseRemove => Field::Presence,
            ActionType::PhaseGroupUpdate | ActionType::PhaseUpdate => Field::Content,
            ActionType::PhaseGroupReorder => Field::Order,
        }
    }

    /// Whether this action's entries are in `action_log_phase_entry`.
    pub fn is_phase(self) -> bool {
        matches!(
            self,
            ActionType::PhaseGroupCreate
                | ActionType::PhaseGroupUpdate
                | ActionType::PhaseGroupReorder
                | ActionType::PhaseGroupRemove
                | ActionType::PhaseCreate
                | ActionType::PhaseUpdate
                | ActionType::PhaseRemove
        )
    }

    /// Permanently deleting a file destroys the only copy the project had,
    /// so there is nothing left to restore. It is still logged — the user
    /// should be able to see that it happened and when.
    pub fn is_undoable(self) -> bool {
        self != ActionType::Purge
    }
}

/// One item's share of an action. `before_*` is what undoing restores;
/// `after_value` is only ever shown to the user ("von X zu Y"), never
/// applied.
#[derive(Clone, Debug)]
pub struct LogEntry {
    /// `None` for actions that aren't about a file (a settings change).
    pub item_id: Option<String>,
    /// How this entry names itself in the log. Denormalized on purpose: a
    /// permanently deleted file has no `items` row left to join against,
    /// and a history that becomes unreadable is not a history.
    pub label: String,
    pub before_value: Option<String>,
    pub after_value: Option<String>,
    /// Only a date change restores a second field alongside the timestamp:
    /// the `timestamp_source` it had before (exif/fs_created/manual/...).
    pub before_source: Option<String>,
}

impl LogEntry {
    /// An entry that needs no restorable state — import and removal are
    /// reversed by flipping `items.removed_at`, not from a payload.
    pub fn presence(item_id: &str, label: &str) -> Self {
        LogEntry {
            item_id: Some(item_id.to_string()),
            label: label.to_string(),
            before_value: None,
            after_value: None,
            before_source: None,
        }
    }

    /// For a permanent delete, whose row is gone by the time this is
    /// recorded — no `item_id` to reference, just the label (see the
    /// field's own doc comment above).
    pub fn gone(label: &str) -> Self {
        LogEntry {
            item_id: None,
            label: label.to_string(),
            before_value: None,
            after_value: None,
            before_source: None,
        }
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Records an action and returns its id.
///
/// Logging must never be the reason a user action fails: callers treat the
/// `Err` here as something to report, not to roll back on, since the action
/// itself has already happened by the time this is called.
pub fn record(conn: &Connection, action_type: ActionType, entries: &[LogEntry]) -> Result<i64, String> {
    if entries.is_empty() {
        return Err("Protokolleintrag ohne Inhalt".to_string());
    }

    let now = now_millis();

    if let Some(action_id) = coalesce_target(conn, action_type, now, entries.len(), "action_log_entry")? {
        let entry = &entries[0];

        // The same file edited twice inside the window updates its existing
        // entry rather than adding a second one, so `before_value` keeps
        // pointing at the state before the *first* edit — which is what
        // undoing the group has to restore — and the group stays at one
        // row per file.
        let updated = conn
            .execute(
                "UPDATE action_log_entry SET after_value = ?1
                 WHERE action_id = ?2 AND item_id IS ?3 AND reverted = 0",
                params![entry.after_value, action_id, entry.item_id],
            )
            .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;

        if updated == 0 {
            insert_entry(conn, action_id, entry)?;
        }

        conn.execute(
            "UPDATE action_log SET performed_at = ?1 WHERE id = ?2",
            params![now, action_id],
        )
        .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;

        return Ok(action_id);
    }

    conn.execute(
        "INSERT INTO action_log (performed_at, action_type) VALUES (?1, ?2)",
        params![now, action_type.as_str()],
    )
    .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
    let action_id = conn.last_insert_rowid();

    for entry in entries {
        insert_entry(conn, action_id, entry)?;
    }

    Ok(action_id)
}

fn insert_entry(conn: &Connection, action_id: i64, entry: &LogEntry) -> Result<(), String> {
    conn.execute(
        "INSERT INTO action_log_entry
            (action_id, item_id, label, before_value, after_value, before_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            action_id,
            entry.item_id,
            entry.label,
            entry.before_value,
            entry.after_value,
            entry.before_source,
        ],
    )
    .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
    Ok(())
}

/// The action a new one should be folded into, if any.
///
/// Only single-file actions ever merge. An action that was itself a batch
/// — a 147-file import, a bulk removal from the file browser — keeps its
/// own identity, because "undo the whole operation" on a merged pair of
/// imports would undo an import the user never pointed at.
///
/// `entry_table` is where this action type keeps its entries
/// (`action_log_entry`, or `action_log_phase_entry` for phase actions) —
/// always a constant, never user input.
fn coalesce_target(
    conn: &Connection,
    action_type: ActionType,
    now: i64,
    entry_count_of_new: usize,
    entry_table: &str,
) -> Result<Option<i64>, String> {
    if entry_count_of_new != 1 {
        return Ok(None);
    }

    // Only the newest action is a candidate: anything logged in between
    // means these two weren't consecutive, whatever the clock says.
    let newest: Option<(i64, String, i64)> = conn
        .query_row(
            "SELECT id, action_type, performed_at FROM action_log ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?;

    let Some((action_id, existing_type, performed_at)) = newest else {
        return Ok(None);
    };

    if existing_type != action_type.as_str() || now - performed_at > GROUPING_WINDOW_MS {
        return Ok(None);
    }

    // A group that is already (partly) undone must not grow: the user has
    // reverted it, and folding a fresh edit into it would resurrect it as
    // half-applied.
    let (entry_count, reverted_count): (i64, i64) = conn
        .query_row(
            &format!("SELECT COUNT(*), COALESCE(SUM(reverted), 0) FROM {entry_table} WHERE action_id = ?1"),
            params![action_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?;

    if entry_count != 1 || reverted_count != 0 {
        return Ok(None);
    }

    Ok(Some(action_id))
}

/// Erases one file's entire history from the log, and tidies up any action
/// left holding nothing.
///
/// **This is a deliberate departure from the "unlimited retention, never
/// delete" rule stated at the top of this module — do not "fix" it back.**
/// The rule exists so a permanently deleted file's history stays readable
/// (hence the denormalized `label`). The user's counter-requirement, added
/// 2026-10-17, is that a recognised mis-import — the motivating case was
/// >1000 `.msg` files imported by mistake — can be undone *without a
/// trace*, not merely have its files removed. So the Papierkorb's
/// "Löschen + Entfernung aus der Datenbank" calls this. It is a UX
/// decision, not a performance one: SQLite handles these row counts
/// effortlessly either way.
///
/// Granularity is the file, never the action: deleting one file out of a
/// 147-file bulk import removes only that file's own `action_log_entry`
/// row, and the other 146 stay listed under the same action. An action
/// whose last entry just went away is deleted too — otherwise the log
/// would grow "Sammelaktion über 0 Dateien" ghost rows that can neither be
/// expanded nor undone.
///
/// Returns how many entry rows were removed.
pub fn delete_entries_for_item(conn: &Connection, item_id: &str) -> Result<usize, String> {
    let removed = conn
        .execute("DELETE FROM action_log_entry WHERE item_id = ?1", params![item_id])
        .map_err(|e| crate::trf!("Konnte Protokolleinträge nicht löschen: {e}", e = e))?;

    if removed > 0 {
        delete_orphaned_actions(conn)?;
    }
    Ok(removed)
}

/// Drops every `action_log` header with no entry rows left.
///
/// Swept globally rather than per item on purpose: one pass after a bulk
/// purge is cheaper than one per file, and an action can only *become*
/// empty through the deletion above — nothing else in the app ever removes
/// an entry row, and `record` refuses an action with no entries outright.
/// A phase action has its entries in `action_log_phase_entry` and none in
/// `action_log_entry`, so both tables must be empty for a header to count
/// as orphaned — checking only the file table would wipe every phase
/// action on the next permanent delete.
fn delete_orphaned_actions(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM action_log
         WHERE NOT EXISTS (SELECT 1 FROM action_log_entry WHERE action_id = action_log.id)
           AND NOT EXISTS (SELECT 1 FROM action_log_phase_entry WHERE action_id = action_log.id)",
        [],
    )
    .map_err(|e| crate::trf!("Konnte leere Protokollaktionen nicht aufräumen: {e}", e = e))
}

/// A later action standing in the way of undoing an earlier one.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub entry_id: i64,
    pub action_id: i64,
    pub action_type: String,
    pub performed_at: i64,
    pub label: String,
}

/// The changes made to the same field of the same item *after* the given
/// entry, newest first.
///
/// This is what turns a blocked undo into an offer: rather than refusing
/// ("the file changed since") or silently overwriting, the UI lists these
/// and offers to undo them in this order first. Nothing here is a
/// judgement about whether the undo should proceed — it is the list the
/// user gets to see.
pub fn later_conflicts(conn: &Connection, entry_id: i64) -> Result<Vec<Conflict>, String> {
    let target: Option<(i64, Option<String>, String)> = conn
        .query_row(
            "SELECT e.action_id, e.item_id, a.action_type
             FROM action_log_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.id = ?1",
            params![entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?;

    let Some((action_id, Some(item_id), action_type)) = target else {
        // No such entry, or a settings entry — settings aren't per-item, so
        // there is no "same file changed since" to reason about.
        return Ok(Vec::new());
    };

    let Some(field) = ActionType::from_str(&action_type).map(|t| t.field()) else {
        return Ok(Vec::new());
    };

    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.action_id, a.action_type, a.performed_at, e.label
             FROM action_log_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.item_id = ?1 AND e.action_id > ?2 AND e.reverted = 0
             ORDER BY e.action_id DESC, e.id DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![item_id, action_id], |row| {
            Ok(Conflict {
                entry_id: row.get(0)?,
                action_id: row.get(1)?,
                action_type: row.get(2)?,
                performed_at: row.get(3)?,
                label: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut conflicts = Vec::new();
    for row in rows {
        let conflict = row.map_err(|e| e.to_string())?;
        if ActionType::from_str(&conflict.action_type).map(|t| t.field()) == Some(field) {
            conflicts.push(conflict);
        }
    }
    Ok(conflicts)
}

/// What a phase log entry is about. See `action_log_phase_entry` in
/// `schema.rs`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PhaseTarget {
    Group,
    Phase,
    /// The order of all Themenbereiche at once; `target_id` is always
    /// `ORDER_TARGET_ID`.
    Order,
}

impl PhaseTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            PhaseTarget::Group => "group",
            PhaseTarget::Phase => "phase",
            PhaseTarget::Order => "order",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "group" => PhaseTarget::Group,
            "phase" => PhaseTarget::Phase,
            "order" => PhaseTarget::Order,
            _ => return None,
        })
    }
}

/// The fixed `target_id` of order entries — one pseudo-target, so that
/// several moves in a row coalesce into one entry whose `before` is the
/// order before the first move.
pub const ORDER_TARGET_ID: &str = "order";

pub type JsonFields = serde_json::Map<String, serde_json::Value>;

/// One phase action's single entry. `before`/`after` carry only the fields
/// the action changed; `before` is what undoing restores, `after` is only
/// ever shown.
#[derive(Clone, Debug)]
pub struct PhaseLogEntry {
    pub target: PhaseTarget,
    pub target_id: String,
    /// The group's name or the phase's title, as it is after the action.
    pub label: String,
    pub before: Option<JsonFields>,
    pub after: Option<JsonFields>,
}

fn json_text(fields: &Option<JsonFields>) -> Option<String> {
    fields.as_ref().map(|f| serde_json::Value::Object(f.clone()).to_string())
}

pub fn parse_json_fields(text: Option<&str>) -> Option<JsonFields> {
    match serde_json::from_str::<serde_json::Value>(text?) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Records a phase action and returns its id. The counterpart of `record`,
/// with the same 60-second grouping: a consecutive action of the same type
/// on a single target joins the newest action, and the same target changed
/// twice updates its one entry.
///
/// Merging is field-wise, not wholesale like `record`: renaming a phase and
/// then recolouring it inside the window leaves one entry whose `before`
/// holds the original title *and* the original colour — each the value
/// from before the first change to that field — and whose `after` holds
/// the latest of each.
///
/// Same contract as `record`: the change itself has already happened, so
/// an `Err` here is something to report, not a reason to roll back.
pub fn record_phase(conn: &Connection, action_type: ActionType, entry: &PhaseLogEntry) -> Result<i64, String> {
    let now = now_millis();

    if let Some(action_id) = coalesce_target(conn, action_type, now, 1, "action_log_phase_entry")? {
        let existing: Option<(i64, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT id, before_json, after_json FROM action_log_phase_entry
                 WHERE action_id = ?1 AND target_id = ?2 AND reverted = 0",
                params![action_id, entry.target_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?;

        match existing {
            Some((entry_id, before_json, after_json)) => {
                let before = merge_fields(parse_json_fields(before_json.as_deref()), entry.before.clone(), false);
                let after = merge_fields(parse_json_fields(after_json.as_deref()), entry.after.clone(), true);
                conn.execute(
                    "UPDATE action_log_phase_entry SET label = ?1, before_json = ?2, after_json = ?3 WHERE id = ?4",
                    params![entry.label, json_text(&before), json_text(&after), entry_id],
                )
                .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
            }
            None => insert_phase_entry(conn, action_id, entry)?,
        }

        conn.execute(
            "UPDATE action_log SET performed_at = ?1 WHERE id = ?2",
            params![now, action_id],
        )
        .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
        return Ok(action_id);
    }

    conn.execute(
        "INSERT INTO action_log (performed_at, action_type) VALUES (?1, ?2)",
        params![now, action_type.as_str()],
    )
    .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
    let action_id = conn.last_insert_rowid();
    insert_phase_entry(conn, action_id, entry)?;
    Ok(action_id)
}

fn insert_phase_entry(conn: &Connection, action_id: i64, entry: &PhaseLogEntry) -> Result<(), String> {
    conn.execute(
        "INSERT INTO action_log_phase_entry
            (action_id, target_kind, target_id, label, before_json, after_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            action_id,
            entry.target.as_str(),
            entry.target_id,
            entry.label,
            json_text(&entry.before),
            json_text(&entry.after),
        ],
    )
    .map_err(|e| crate::trf!("Konnte Protokoll nicht schreiben: {e}", e = e))?;
    Ok(())
}

/// Field-wise union. `newer_wins` decides who keeps a field both sides
/// have: the newer value for `after`, the older one for `before`.
fn merge_fields(older: Option<JsonFields>, newer: Option<JsonFields>, newer_wins: bool) -> Option<JsonFields> {
    match (older, newer) {
        (None, newer) => newer,
        (older, None) => older,
        (Some(mut older), Some(newer)) => {
            for (key, value) in newer {
                if newer_wins || !older.contains_key(&key) {
                    older.insert(key, value);
                }
            }
            Some(older)
        }
    }
}

/// The later phase changes standing in the way of undoing entry
/// `entry_id` (a row id of `action_log_phase_entry`), newest first — the
/// counterpart of `later_conflicts`, offered to the user the same way.
///
/// "Later" is the entry's row id: the 60-second grouping only ever extends
/// the newest action, so row order is the order in which entries were last
/// written. Which later changes count:
/// - a phase's presence (created/removed): later presence changes of that
///   phase, and later presence changes of its Themenbereich (removing a
///   group removed the phase with it);
/// - a phase's or group's content: later content changes of the same
///   target that touch at least one of the same fields, and a later
///   removal of the target (or of a phase's group);
/// - a group's presence: *every* later change to the group or to any of
///   its phases — undoing the creation of a group must first undo what was
///   built inside it, or the phases would be left in a group that is gone;
/// - the order: every later move.
pub fn later_phase_conflicts(conn: &Connection, entry_id: i64) -> Result<Vec<Conflict>, String> {
    let target: Option<(String, String, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT a.action_type, e.target_kind, e.target_id, e.before_json, e.after_json
             FROM action_log_phase_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.id = ?1",
            params![entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?;

    let Some((action_type, kind, target_id, before_json, after_json)) = target else {
        return Ok(Vec::new());
    };
    let (Some(action_type), Some(kind)) = (ActionType::from_str(&action_type), PhaseTarget::from_str(&kind)) else {
        return Ok(Vec::new());
    };
    let field = action_type.field();
    let changed = changed_keys(before_json.as_deref(), after_json.as_deref());

    // The group a phase belongs to, or the phases a group holds — phases
    // never change group, so this is stable across the whole history.
    let related: Vec<String> = match kind {
        PhaseTarget::Phase => conn
            .query_row("SELECT group_id FROM phases WHERE id = ?1", params![target_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| crate::trf!("Konnte Protokoll nicht lesen: {e}", e = e))?
            .into_iter()
            .collect(),
        PhaseTarget::Group => {
            let mut stmt = conn
                .prepare("SELECT id FROM phases WHERE group_id = ?1")
                .map_err(|e| e.to_string())?;
            let ids = stmt
                .query_map(params![target_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            ids
        }
        PhaseTarget::Order => Vec::new(),
    };

    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.action_id, a.action_type, a.performed_at, e.label,
                    e.target_kind, e.target_id, e.before_json, e.after_json
             FROM action_log_phase_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.id > ?1 AND e.reverted = 0
             ORDER BY e.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![entry_id], |row| {
            Ok((
                Conflict {
                    entry_id: row.get(0)?,
                    action_id: row.get(1)?,
                    action_type: row.get(2)?,
                    performed_at: row.get(3)?,
                    label: row.get(4)?,
                },
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut conflicts = Vec::new();
    for row in rows {
        let (conflict, later_kind, later_target, later_before, later_after) = row.map_err(|e| e.to_string())?;
        let Some(later_field) = ActionType::from_str(&conflict.action_type).map(|t| t.field()) else {
            continue;
        };
        let later_kind = PhaseTarget::from_str(&later_kind);
        let same_target = later_target == target_id;
        let shares_a_field = || {
            let later_changed = changed_keys(later_before.as_deref(), later_after.as_deref());
            later_changed.iter().any(|key| changed.contains(key))
        };

        // Removed since (the target itself, or a phase's group with it).
        let removed_since = later_field == Field::Presence
            && (same_target
                || (kind == PhaseTarget::Phase
                    && later_kind == Some(PhaseTarget::Group)
                    && related.contains(&later_target)));

        let counts = match (kind, field) {
            (PhaseTarget::Order, _) => later_kind == Some(PhaseTarget::Order),
            // Restoring an old value onto something that has been removed
            // since would change what comes back with a later restore, so
            // the removal is undone first.
            (_, Field::Content) => {
                (same_target && later_field == Field::Content && shares_a_field()) || removed_since
            }
            (PhaseTarget::Phase, _) => removed_since,
            (PhaseTarget::Group, _) => {
                same_target || (later_kind == Some(PhaseTarget::Phase) && related.contains(&later_target))
            }
        };
        if counts {
            conflicts.push(conflict);
        }
    }
    Ok(conflicts)
}

fn changed_keys(before: Option<&str>, after: Option<&str>) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for fields in [parse_json_fields(before), parse_json_fields(after)].into_iter().flatten() {
        for key in fields.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn
    }

    fn entry(item: &str) -> LogEntry {
        LogEntry {
            item_id: Some(item.to_string()),
            label: format!("{item}.jpg"),
            before_value: Some("vorher".to_string()),
            after_value: Some("nachher".to_string()),
            before_source: None,
        }
    }

    fn entry_count(conn: &Connection, action_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM action_log_entry WHERE action_id = ?1",
            params![action_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn consecutive_single_edits_of_different_files_merge_into_one_action() {
        let conn = test_conn();
        let first = record(&conn, ActionType::DateChange, &[entry("a")]).unwrap();
        let second = record(&conn, ActionType::DateChange, &[entry("b")]).unwrap();

        assert_eq!(first, second, "a second date change should join the same group");
        assert_eq!(entry_count(&conn, first), 2);
    }

    #[test]
    fn editing_the_same_file_twice_keeps_one_entry_and_the_original_before_value() {
        let conn = test_conn();
        let action = record(&conn, ActionType::DateChange, &[entry("a")]).unwrap();

        let mut second = entry("a");
        second.before_value = Some("nachher".to_string());
        second.after_value = Some("final".to_string());
        record(&conn, ActionType::DateChange, &[second]).unwrap();

        assert_eq!(entry_count(&conn, action), 1);
        let (before, after): (String, String) = conn
            .query_row(
                "SELECT before_value, after_value FROM action_log_entry WHERE action_id = ?1",
                params![action],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        // Undoing has to land on the state before the *first* of the two
        // edits, not the intermediate one.
        assert_eq!(before, "vorher");
        assert_eq!(after, "final");
    }

    #[test]
    fn a_batch_never_merges_with_anything() {
        let conn = test_conn();
        let batch = record(&conn, ActionType::Import, &[entry("a"), entry("b")]).unwrap();
        let single = record(&conn, ActionType::Import, &[entry("c")]).unwrap();

        assert_ne!(batch, single, "a bulk import keeps its own identity");
        assert_eq!(entry_count(&conn, batch), 2);
        assert_eq!(entry_count(&conn, single), 1);
    }

    #[test]
    fn a_different_action_in_between_breaks_the_group() {
        let conn = test_conn();
        let first = record(&conn, ActionType::DateChange, &[entry("a")]).unwrap();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let third = record(&conn, ActionType::DateChange, &[entry("b")]).unwrap();

        assert_ne!(first, third);
    }

    #[test]
    fn an_already_undone_group_does_not_grow() {
        let conn = test_conn();
        let first = record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        conn.execute("UPDATE action_log_entry SET reverted = 1", []).unwrap();

        let second = record(&conn, ActionType::Rename, &[entry("b")]).unwrap();
        assert_ne!(first, second);
    }

    /// The motivating case for `delete_entries_for_item`: one file out of a
    /// bulk import is permanently deleted, and only *its* line disappears.
    #[test]
    fn deleting_one_files_history_leaves_its_batch_siblings_listed() {
        let conn = test_conn();
        let batch = record(&conn, ActionType::Import, &[entry("a"), entry("b"), entry("c")]).unwrap();

        let removed = delete_entries_for_item(&conn, "b").unwrap();
        assert_eq!(removed, 1);

        // The action itself survives, with the two untouched files still on it.
        assert_eq!(entry_count(&conn, batch), 2);
        let remaining: Vec<String> = conn
            .prepare("SELECT item_id FROM action_log_entry WHERE action_id = ?1 ORDER BY item_id")
            .unwrap()
            .query_map(params![batch], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["a".to_string(), "c".to_string()]);
    }

    /// Every file of an action gone means the action has nothing left to
    /// say — it must not linger as a "bulk action over 0 files" ghost row.
    #[test]
    fn an_action_whose_last_entry_is_deleted_goes_away_with_it() {
        let conn = test_conn();
        record(&conn, ActionType::Import, &[entry("a"), entry("b")]).unwrap();

        delete_entries_for_item(&conn, "a").unwrap();
        let actions: i64 = conn
            .query_row("SELECT COUNT(*) FROM action_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(actions, 1, "one file left, so the action is still real");

        delete_entries_for_item(&conn, "b").unwrap();
        let actions: i64 = conn
            .query_row("SELECT COUNT(*) FROM action_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(actions, 0, "the emptied action is cleaned up");
    }

    /// A file's history spans several actions (imported, renamed, removed) —
    /// permanently deleting it has to clear all of them, while an unrelated
    /// file's own actions stay untouched.
    #[test]
    fn a_files_whole_history_across_actions_is_erased_at_once() {
        let conn = test_conn();
        record(&conn, ActionType::Import, &[entry("a"), entry("b")]).unwrap();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        record(&conn, ActionType::DateChange, &[entry("a")]).unwrap();
        record(&conn, ActionType::Rename, &[entry("b")]).unwrap();

        delete_entries_for_item(&conn, "a").unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM action_log_entry WHERE item_id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0, "nothing about this file is left in the log");

        let other: i64 = conn
            .query_row("SELECT COUNT(*) FROM action_log_entry WHERE item_id = 'b'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(other, 2, "the other file keeps its import and its rename");
    }

    /// A settings change has no `item_id` at all — a file deletion must not
    /// sweep it away as collateral.
    #[test]
    fn entries_without_an_item_are_never_touched() {
        let conn = test_conn();
        record(
            &conn,
            ActionType::SettingChange,
            &[LogEntry {
                item_id: None,
                label: "tile_drag_enabled".to_string(),
                before_value: None,
                after_value: Some("true".to_string()),
                before_source: None,
            }],
        )
        .unwrap();
        record(&conn, ActionType::Import, &[entry("a")]).unwrap();

        delete_entries_for_item(&conn, "a").unwrap();

        let settings_entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM action_log_entry WHERE item_id IS NULL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(settings_entries, 1);
    }

    #[test]
    fn only_later_changes_to_the_same_field_count_as_conflicts() {
        let conn = test_conn();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let rename_entry: i64 = conn
            .query_row("SELECT id FROM action_log_entry", [], |row| row.get(0))
            .unwrap();

        // A later date change touches a different field — undoing the
        // rename is unaffected by it.
        record(&conn, ActionType::DateChange, &[entry("a")]).unwrap();
        assert!(later_conflicts(&conn, rename_entry).unwrap().is_empty());

        // A later rename of the same file does conflict.
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let conflicts = later_conflicts(&conn, rename_entry).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].action_type, "rename");
    }

    #[test]
    fn a_later_change_to_a_different_file_is_not_a_conflict() {
        let conn = test_conn();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let rename_entry: i64 = conn
            .query_row("SELECT id FROM action_log_entry", [], |row| row.get(0))
            .unwrap();

        record(&conn, ActionType::Import, &[entry("b"), entry("c")]).unwrap();
        record(&conn, ActionType::Rename, &[entry("b")]).unwrap();

        assert!(later_conflicts(&conn, rename_entry).unwrap().is_empty());
    }

    #[test]
    fn a_reverted_later_change_stops_being_a_conflict() {
        let conn = test_conn();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let first_entry: i64 = conn
            .query_row("SELECT MIN(id) FROM action_log_entry", [], |row| row.get(0))
            .unwrap();

        // Separate action (same type merges, so force a gap with another type).
        record(&conn, ActionType::DateChange, &[entry("x")]).unwrap();
        record(&conn, ActionType::Rename, &[entry("a")]).unwrap();
        let last_entry: i64 = conn
            .query_row("SELECT MAX(id) FROM action_log_entry", [], |row| row.get(0))
            .unwrap();

        assert_eq!(later_conflicts(&conn, first_entry).unwrap().len(), 1);

        conn.execute(
            "UPDATE action_log_entry SET reverted = 1 WHERE id = ?1",
            params![last_entry],
        )
        .unwrap();
        assert!(later_conflicts(&conn, first_entry).unwrap().is_empty());
    }
}
