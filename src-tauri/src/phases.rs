//! Life phases on the timeline ("Lebensphasen"): Themenbereiche
//! (`phase_groups`, e.g. "Wohnorte") holding dated phases (e.g. "Berlin
//! 2012–2018"). This module owns the model, its validation and every write,
//! including the action-log entries those writes produce and how each kind
//! is undone. The Tauri commands in `phase_commands.rs` are thin wrappers.
//!
//! Rules worth knowing before changing anything (agreed with the user, see
//! `docs/phasen-entscheidungen.md`):
//!
//! - **Days only.** Dates are ISO `YYYY-MM-DD` strings, the end inclusive,
//!   so string comparison is date order and "ends 30.6., next starts 1.7."
//!   is not an overlap.
//! - **Every change is logged and undoable**, except the eye toggles
//!   (`visible`), which are stored but deliberately not logged, and the
//!   "läuft noch" derivation (`refresh_ongoing`), which is not a user
//!   action.
//! - **Removal is a flag** (`removed_at`), like `items`. Removing a
//!   Themenbereich removes its live phases with it, and undoing that brings
//!   exactly those back in the same log entry.
//! - **Overlap is per Themenbereich.** With "Überlappung erlaubt" off, no
//!   two live phases of the group may share a day: a write that would break
//!   that comes back as `SaveOutcome::Overlap` without changing anything,
//!   and switching the toggle off while overlaps exist is refused the same
//!   way, naming the pairs.

use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::action_log::{self, ActionType, JsonFields, PhaseLogEntry, PhaseTarget, ORDER_TARGET_ID};
use crate::action_log_commands::UndoOutcome;

/// The colours a new phase is given, in order: the first one not yet used
/// by a live phase of the same Themenbereich. Also what the colour popup
/// offers (`get_phase_palette`), so the two cannot drift apart.
pub const PALETTE: [&str; 24] = [
    "#3584e4", "#33d17a", "#f6d32d", "#ff7800", "#e01b24", "#9141ac",
    "#986a44", "#2190a4", "#c061cb", "#26a269", "#1a5fb4", "#a51d2d",
    "#99c1f1", "#8ff0a4", "#f9f06b", "#ffbe6f", "#f66151", "#dc8add",
    "#cdab8f", "#5bc8af", "#e66100", "#e5a50a", "#613583", "#5e5c64",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseView {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub start_date: String,
    pub end_date: String,
    pub color: String,
    pub visible: bool,
    pub ongoing: bool,
}

/// The eye on a Themenbereich. `Partial` when only some of its phases are
/// shown.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Visible,
    Hidden,
    Partial,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhaseGroupView {
    pub id: String,
    pub name: String,
    pub sort_index: i64,
    pub visibility: Visibility,
    pub overlap_allowed: bool,
    /// When the group or one of its phases (removed ones included) was last
    /// created, changed or removed, in ms; 0 without a log entry. Visibility
    /// and reordering are not edits.
    pub last_edited_at: i64,
    /// Live phases, by start date (phases are never ordered by hand).
    pub phases: Vec<PhaseView>,
}

/// Two phases of one Themenbereich sharing at least one day.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlapPair {
    pub first: PhaseView,
    pub second: PhaseView,
}

/// A write that the overlap rule can refuse. A refusal changes nothing and
/// logs nothing; the UI shows the pairs inline.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome<T> {
    Saved { value: T },
    Overlap { pairs: Vec<OverlapPair> },
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupPatch {
    pub name: Option<String>,
    pub overlap_allowed: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhaseInput {
    pub title: String,
    pub start_date: String,
    pub end_date: String,
    /// `None` picks the next free palette colour.
    pub color: Option<String>,
    #[serde(default)]
    pub ongoing: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhasePatch {
    pub title: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub color: Option<String>,
    pub ongoing: Option<bool>,
}

// ---------------------------------------------------------------------------
// Validation and the overlap rule
// ---------------------------------------------------------------------------

/// Today as the user's calendar has it — what "läuft noch" extends to.
pub fn today() -> String {
    chrono::Local::now().date_naive().format("%Y-%m-%d").to_string()
}

/// Normalises a day to zero-padded `YYYY-MM-DD`, which is what makes plain
/// string comparison correct everywhere else in this module.
fn parse_day(value: &str) -> Result<String, String> {
    let date = NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .map_err(|_| crate::trf!("Ungültiges Datum: „{value}“", value = value))?;
    if !(1..=9999).contains(&date.year()) {
        return Err(crate::trf!("Ungültiges Datum: „{value}“", value = value));
    }
    Ok(date.format("%Y-%m-%d").to_string())
}

fn day_before(day: &str) -> Option<String> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    date.pred_opt().map(|d| d.format("%Y-%m-%d").to_string())
}

fn parse_color(value: &str) -> Result<String, String> {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::trf!("Ungültige Farbe: „{value}“", value = value));
    }
    Ok(format!("#{}", hex.to_ascii_lowercase()))
}

fn non_empty(value: &str, what: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(crate::trf!("{what} darf nicht leer sein.", what = what));
    }
    Ok(trimmed.to_string())
}

fn ordered_span(start: &str, end: &str) -> Result<(String, String), String> {
    let (start, end) = (parse_day(start)?, parse_day(end)?);
    if start > end {
        return Err("Das Enddatum liegt vor dem Startdatum.".to_string());
    }
    Ok((start, end))
}

/// Whether two inclusive day ranges share at least one day.
pub fn spans_overlap(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> bool {
    a_start <= b_end && b_start <= a_end
}

/// Every overlapping pair, in start order.
pub fn overlapping_pairs(phases: &[PhaseView]) -> Vec<OverlapPair> {
    let mut sorted: Vec<&PhaseView> = phases.iter().collect();
    sorted.sort_by(|a, b| (&a.start_date, &a.end_date, &a.id).cmp(&(&b.start_date, &b.end_date, &b.id)));
    let mut pairs = Vec::new();
    for (i, first) in sorted.iter().enumerate() {
        for second in &sorted[i + 1..] {
            if second.start_date > first.end_date {
                break;
            }
            pairs.push(OverlapPair {
                first: (*first).clone(),
                second: (*second).clone(),
            });
        }
    }
    pairs
}

/// The pairs a phase with this span would form with the group's other live
/// phases.
fn overlaps_with(others: &[PhaseView], candidate: &PhaseView) -> Vec<OverlapPair> {
    others
        .iter()
        .filter(|other| other.id != candidate.id)
        .filter(|other| spans_overlap(&candidate.start_date, &candidate.end_date, &other.start_date, &other.end_date))
        .map(|other| OverlapPair {
            first: candidate.clone(),
            second: other.clone(),
        })
        .collect()
}

fn describe_pairs(pairs: &[OverlapPair]) -> String {
    pairs
        .iter()
        .map(|p| {
            crate::trf!(
                "„{a}“ ({a_start} – {a_end}) und „{b}“ ({b_start} – {b_end})",
                a = p.first.title,
                a_start = p.first.start_date,
                a_end = p.first.end_date,
                b = p.second.title,
                b_start = p.second.start_date,
                b_end = p.second.end_date
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

struct GroupRow {
    id: String,
    name: String,
    sort_index: i64,
    visible: bool,
    overlap_allowed: bool,
    removed: bool,
}

fn load_group(conn: &Connection, id: &str) -> Result<Option<GroupRow>, String> {
    conn.query_row(
        "SELECT id, name, sort_index, visible, overlap_allowed, removed_at IS NOT NULL
         FROM phase_groups WHERE id = ?1",
        params![id],
        |row| {
            Ok(GroupRow {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_index: row.get(2)?,
                visible: row.get::<_, i64>(3)? != 0,
                overlap_allowed: row.get::<_, i64>(4)? != 0,
                removed: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| crate::trf!("Konnte Themenbereich nicht lesen: {e}", e = e))
}

fn live_group(conn: &Connection, id: &str) -> Result<GroupRow, String> {
    match load_group(conn, id)? {
        Some(group) if !group.removed => Ok(group),
        _ => Err(crate::i18n::tr("Dieser Themenbereich existiert nicht mehr.").to_string()),
    }
}

const PHASE_COLUMNS: &str = "id, group_id, title, start_date, end_date, color, visible, ongoing";

fn phase_from_row(row: &rusqlite::Row) -> rusqlite::Result<PhaseView> {
    Ok(PhaseView {
        id: row.get(0)?,
        group_id: row.get(1)?,
        title: row.get(2)?,
        start_date: row.get(3)?,
        end_date: row.get(4)?,
        color: row.get(5)?,
        visible: row.get::<_, i64>(6)? != 0,
        ongoing: row.get::<_, i64>(7)? != 0,
    })
}

/// A phase whatever its state, with whether it is removed.
fn load_phase(conn: &Connection, id: &str) -> Result<Option<(PhaseView, bool)>, String> {
    conn.query_row(
        &format!("SELECT {PHASE_COLUMNS}, removed_at IS NOT NULL FROM phases WHERE id = ?1"),
        params![id],
        |row| Ok((phase_from_row(row)?, row.get::<_, i64>(8)? != 0)),
    )
    .optional()
    .map_err(|e| crate::trf!("Konnte Phase nicht lesen: {e}", e = e))
}

fn live_phases_of(conn: &Connection, group_id: &str) -> Result<Vec<PhaseView>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PHASE_COLUMNS} FROM phases
             WHERE group_id = ?1 AND removed_at IS NULL
             ORDER BY start_date, end_date, title, id"
        ))
        .map_err(|e| e.to_string())?;
    let phases = stmt
        .query_map(params![group_id], phase_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::trf!("Konnte Phasen nicht lesen: {e}", e = e));
    phases
}

/// Live groups, top to bottom. Ties (a restored group landing on a slot a
/// move has reused) fall back to creation order, so the result is always
/// the same for the same data.
fn live_group_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM phase_groups WHERE removed_at IS NULL ORDER BY sort_index, created_at, id")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    ids
}

pub fn group_visibility(stored_visible: bool, phases: &[PhaseView]) -> Visibility {
    if phases.is_empty() {
        return if stored_visible { Visibility::Visible } else { Visibility::Hidden };
    }
    let shown = phases.iter().filter(|p| p.visible).count();
    if shown == phases.len() {
        Visibility::Visible
    } else if shown == 0 {
        Visibility::Hidden
    } else {
        Visibility::Partial
    }
}

fn last_edited_at(conn: &Connection, group_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(a.performed_at), 0)
         FROM action_log_phase_entry e JOIN action_log a ON a.id = e.action_id
         WHERE (e.target_kind = 'group' AND e.target_id = ?1)
            OR (e.target_kind = 'phase' AND e.target_id IN (SELECT id FROM phases WHERE group_id = ?1))",
        params![group_id],
        |row| row.get(0),
    )
    .map_err(|e| crate::trf!("Konnte Themenbereich nicht lesen: {e}", e = e))
}

fn group_view(conn: &Connection, group: GroupRow) -> Result<PhaseGroupView, String> {
    let phases = live_phases_of(conn, &group.id)?;
    Ok(PhaseGroupView {
        last_edited_at: last_edited_at(conn, &group.id)?,
        visibility: group_visibility(group.visible, &phases),
        id: group.id,
        name: group.name,
        sort_index: group.sort_index,
        overlap_allowed: group.overlap_allowed,
        phases,
    })
}

fn live_group_view(conn: &Connection, id: &str) -> Result<PhaseGroupView, String> {
    let group = live_group(conn, id)?;
    group_view(conn, group)
}

/// Every live Themenbereich with its live phases, top to bottom.
pub fn list_groups(conn: &Connection) -> Result<Vec<PhaseGroupView>, String> {
    live_group_ids(conn)?
        .iter()
        .map(|id| live_group_view(conn, id))
        .collect()
}

// ---------------------------------------------------------------------------
// "läuft noch"
// ---------------------------------------------------------------------------

/// The end an ongoing phase has on `today`: today, but never earlier than
/// its stored end, and — in a group without overlap — never into the next
/// phase (it stops the day before that one starts, which is what "until I
/// moved" means).
fn ongoing_end(
    conn: &Connection,
    group_id: &str,
    phase_id: &str,
    start: &str,
    end: &str,
    overlap_allowed: bool,
    today: &str,
) -> Result<String, String> {
    let mut target = today.to_string();
    if !overlap_allowed {
        let next_start: Option<String> = conn
            .query_row(
                "SELECT MIN(start_date) FROM phases
                 WHERE group_id = ?1 AND id != ?2 AND removed_at IS NULL AND start_date > ?3",
                params![group_id, phase_id, start],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if let Some(cap) = next_start.as_deref().and_then(day_before) {
            if cap < target {
                target = cap;
            }
        }
    }
    Ok(if target.as_str() > end { target } else { end.to_string() })
}

/// Moves the end of every live "läuft noch" phase forward to `today`.
/// Run whenever the phases are read, which covers opening the stream
/// and a date change alike. A derivation, not a user action: never logged.
/// Returns how many phases moved.
pub fn refresh_ongoing(conn: &Connection, today: &str) -> Result<usize, String> {
    let candidates: Vec<(String, String, String, String, bool)> = {
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.group_id, p.start_date, p.end_date, g.overlap_allowed
                 FROM phases p JOIN phase_groups g ON g.id = p.group_id
                 WHERE p.ongoing = 1 AND p.removed_at IS NULL AND g.removed_at IS NULL
                   AND p.end_date < ?1
                 ORDER BY p.start_date",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![today], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)? != 0))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let mut moved = 0;
    for (id, group_id, start, end, overlap_allowed) in candidates {
        let new_end = ongoing_end(conn, &group_id, &id, &start, &end, overlap_allowed, today)?;
        if new_end != end {
            conn.execute("UPDATE phases SET end_date = ?1 WHERE id = ?2", params![new_end, id])
                .map_err(|e| crate::trf!("Konnte Phase nicht aktualisieren: {e}", e = e))?;
            moved += 1;
        }
    }
    Ok(moved)
}

// ---------------------------------------------------------------------------
// Writes (each logs itself)
// ---------------------------------------------------------------------------

fn now_text() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn fields(pairs: &[(&str, Value)]) -> JsonFields {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// The log's own failure is never the user's: the change has happened.
fn log(conn: &Connection, action_type: ActionType, entry: PhaseLogEntry) {
    let _ = action_log::record_phase(conn, action_type, &entry);
}

pub fn create_group(conn: &Connection, name: &str) -> Result<PhaseGroupView, String> {
    let name = non_empty(name, crate::i18n::tr("Der Name"))?;
    let id = uuid::Uuid::new_v4().to_string();
    // Over all rows, removed ones included, so a restored group never
    // shares a slot with one created while it was gone.
    let sort_index: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_index), -1) + 1 FROM phase_groups", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO phase_groups (id, name, sort_index, visible, overlap_allowed, created_at)
         VALUES (?1, ?2, ?3, 1, 0, ?4)",
        params![id, name, sort_index, now_text()],
    )
    .map_err(|e| crate::trf!("Konnte Themenbereich nicht anlegen: {e}", e = e))?;

    log(
        conn,
        ActionType::PhaseGroupCreate,
        PhaseLogEntry {
            target: PhaseTarget::Group,
            target_id: id.clone(),
            label: name.clone(),
            before: None,
            after: Some(fields(&[("name", json!(name)), ("overlapAllowed", json!(false))])),
        },
    );
    live_group_view(conn, &id)
}

pub fn update_group(conn: &Connection, id: &str, patch: &GroupPatch) -> Result<SaveOutcome<PhaseGroupView>, String> {
    let group = live_group(conn, id)?;
    let mut before = JsonFields::new();
    let mut after = JsonFields::new();

    let name = match &patch.name {
        Some(name) => non_empty(name, crate::i18n::tr("Der Name"))?,
        None => group.name.clone(),
    };
    if name != group.name {
        before.insert("name".into(), json!(group.name));
        after.insert("name".into(), json!(name));
    }

    let overlap_allowed = patch.overlap_allowed.unwrap_or(group.overlap_allowed);
    if overlap_allowed != group.overlap_allowed {
        if !overlap_allowed {
            let pairs = overlapping_pairs(&live_phases_of(conn, id)?);
            if !pairs.is_empty() {
                return Ok(SaveOutcome::Overlap { pairs });
            }
        }
        before.insert("overlapAllowed".into(), json!(group.overlap_allowed));
        after.insert("overlapAllowed".into(), json!(overlap_allowed));
    }

    if !after.is_empty() {
        conn.execute(
            "UPDATE phase_groups SET name = ?1, overlap_allowed = ?2 WHERE id = ?3",
            params![name, overlap_allowed, id],
        )
        .map_err(|e| crate::trf!("Konnte Themenbereich nicht speichern: {e}", e = e))?;
        log(
            conn,
            ActionType::PhaseGroupUpdate,
            PhaseLogEntry {
                target: PhaseTarget::Group,
                target_id: id.to_string(),
                label: name,
                before: Some(before),
                after: Some(after),
            },
        );
    }
    Ok(SaveOutcome::Saved {
        value: live_group_view(conn, id)?,
    })
}

/// Writes `order` as the new top-to-bottom order. Ids that are not live
/// groups are skipped; live groups missing from it keep their relative
/// order after the listed ones — so an old order restored by an undo never
/// loses a group created since.
fn apply_group_order(conn: &Connection, order: &[String]) -> Result<(), String> {
    let live = live_group_ids(conn)?;
    let mut final_order: Vec<&String> = order.iter().filter(|id| live.contains(id)).collect();
    for id in &live {
        if !final_order.contains(&id) {
            final_order.push(id);
        }
    }
    for (index, id) in final_order.iter().enumerate() {
        conn.execute(
            "UPDATE phase_groups SET sort_index = ?1 WHERE id = ?2",
            params![index as i64, id],
        )
        .map_err(|e| crate::trf!("Konnte Reihenfolge nicht speichern: {e}", e = e))?;
    }
    Ok(())
}

/// The names of these groups, in the given order.
fn group_names(conn: &Connection, ids: &[String]) -> Result<Vec<String>, String> {
    ids.iter()
        .map(|id| Ok(load_group(conn, id)?.map(|g| g.name).unwrap_or_default()))
        .collect()
}

/// Moves a Themenbereich to position `to_index` (0 = top) — the drag
/// handle and Alt+↑/↓ alike. Returns the new list.
pub fn move_group(conn: &Connection, id: &str, to_index: usize) -> Result<Vec<PhaseGroupView>, String> {
    let group = live_group(conn, id)?;
    let before = live_group_ids(conn)?;
    let from = before.iter().position(|g| g == id).ok_or(crate::i18n::tr("Themenbereich nicht gefunden"))?;
    let to = to_index.min(before.len() - 1);
    if from != to {
        let mut after = before.clone();
        let moved = after.remove(from);
        after.insert(to, moved);
        apply_group_order(conn, &after)?;
        // Ids are what undo needs; the names beside them are what the
        // Protokoll shows (as they were when the move was made).
        let names_before = group_names(conn, &before)?;
        let names_after = group_names(conn, &after)?;
        log(
            conn,
            ActionType::PhaseGroupReorder,
            PhaseLogEntry {
                target: PhaseTarget::Order,
                target_id: ORDER_TARGET_ID.to_string(),
                label: group.name,
                before: Some(fields(&[("order", json!(before)), ("orderNames", json!(names_before))])),
                after: Some(fields(&[("order", json!(after)), ("orderNames", json!(names_after))])),
            },
        );
    }
    list_groups(conn)
}

/// Removes a Themenbereich and its live phases. The ids of those phases go
/// into the log entry, so the undo brings back exactly them — not a phase
/// that had already been removed on its own before.
pub fn remove_group(conn: &Connection, id: &str) -> Result<(), String> {
    let group = live_group(conn, id)?;
    let phase_ids: Vec<String> = live_phases_of(conn, id)?.into_iter().map(|p| p.id).collect();
    let now = now_text();
    conn.execute("UPDATE phase_groups SET removed_at = ?1 WHERE id = ?2", params![now, id])
        .map_err(|e| crate::trf!("Konnte Themenbereich nicht entfernen: {e}", e = e))?;
    conn.execute(
        "UPDATE phases SET removed_at = ?1 WHERE group_id = ?2 AND removed_at IS NULL",
        params![now, id],
    )
    .map_err(|e| crate::trf!("Konnte Phasen nicht entfernen: {e}", e = e))?;

    log(
        conn,
        ActionType::PhaseGroupRemove,
        PhaseLogEntry {
            target: PhaseTarget::Group,
            target_id: id.to_string(),
            label: group.name,
            before: Some(fields(&[("phaseIds", json!(phase_ids))])),
            after: None,
        },
    );
    Ok(())
}

/// The Themenbereich's eye: shows or hides all of its phases at once. Not
/// logged.
pub fn set_group_visible(conn: &Connection, id: &str, visible: bool) -> Result<PhaseGroupView, String> {
    live_group(conn, id)?;
    conn.execute("UPDATE phase_groups SET visible = ?1 WHERE id = ?2", params![visible, id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE phases SET visible = ?1 WHERE group_id = ?2 AND removed_at IS NULL",
        params![visible, id],
    )
    .map_err(|e| e.to_string())?;
    live_group_view(conn, id)
}

/// One phase's eye. The group's own flag follows (shown while any of its
/// phases is), so a group emptied of visible phases reads as hidden. Not
/// logged. Returns the whole group, whose tri-state may have changed.
pub fn set_phase_visible(conn: &Connection, id: &str, visible: bool) -> Result<PhaseGroupView, String> {
    let Some((phase, false)) = load_phase(conn, id)? else {
        return Err(crate::i18n::tr("Diese Phase existiert nicht mehr.").to_string());
    };
    conn.execute("UPDATE phases SET visible = ?1 WHERE id = ?2", params![visible, id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE phase_groups SET visible = EXISTS(
             SELECT 1 FROM phases WHERE group_id = ?1 AND removed_at IS NULL AND visible = 1)
         WHERE id = ?1",
        params![phase.group_id],
    )
    .map_err(|e| e.to_string())?;
    live_group_view(conn, &phase.group_id)
}

/// The first palette colour no live phase of any Themenbereich uses, so
/// bars in different rows don't look alike; once all are taken somewhere,
/// the first one free in the phase's own Themenbereich, as before.
fn next_free_color(conn: &Connection, phases: &[PhaseView]) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT p.color FROM phases p JOIN phase_groups g ON g.id = p.group_id
             WHERE p.removed_at IS NULL AND g.removed_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let used = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let free = |taken: &dyn Fn(&str) -> bool| PALETTE.iter().find(|color| !taken(color)).copied();
    let color = free(&|c| used.iter().any(|u| u.eq_ignore_ascii_case(c)))
        .or_else(|| free(&|c| phases.iter().any(|p| p.color.eq_ignore_ascii_case(c))))
        .unwrap_or(PALETTE[phases.len() % PALETTE.len()]);
    Ok(color.to_string())
}

pub fn create_phase(
    conn: &Connection,
    group_id: &str,
    input: &PhaseInput,
    today: &str,
) -> Result<SaveOutcome<PhaseView>, String> {
    let group = live_group(conn, group_id)?;
    let title = non_empty(&input.title, crate::i18n::tr("Der Titel"))?;
    let (start_date, end_date) = ordered_span(&input.start_date, &input.end_date)?;
    let others = live_phases_of(conn, group_id)?;
    let color = match &input.color {
        Some(color) => parse_color(color)?,
        None => next_free_color(conn, &others)?,
    };

    let mut phase = PhaseView {
        id: uuid::Uuid::new_v4().to_string(),
        group_id: group_id.to_string(),
        title,
        start_date,
        end_date,
        color,
        // A new phase is shown, unless its group is switched off entirely.
        visible: group_visibility(group.visible, &others) != Visibility::Hidden,
        ongoing: input.ongoing,
    };

    if !group.overlap_allowed {
        let pairs = overlaps_with(&others, &phase);
        if !pairs.is_empty() {
            return Ok(SaveOutcome::Overlap { pairs });
        }
    }
    // Ticking "läuft noch" is the user's action, so the end it implies
    // today is part of what gets logged. Later days' moves are not.
    if phase.ongoing {
        phase.end_date = ongoing_end(conn, group_id, &phase.id, &phase.start_date, &phase.end_date, group.overlap_allowed, today)?;
    }

    conn.execute(
        "INSERT INTO phases (id, group_id, title, start_date, end_date, color, visible, ongoing, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            phase.id,
            phase.group_id,
            phase.title,
            phase.start_date,
            phase.end_date,
            phase.color,
            phase.visible,
            phase.ongoing,
            now_text()
        ],
    )
    .map_err(|e| crate::trf!("Konnte Phase nicht anlegen: {e}", e = e))?;

    log(
        conn,
        ActionType::PhaseCreate,
        PhaseLogEntry {
            target: PhaseTarget::Phase,
            target_id: phase.id.clone(),
            label: phase.title.clone(),
            before: None,
            after: Some(content_fields(&phase)),
        },
    );
    Ok(SaveOutcome::Saved { value: phase })
}

/// The logged, undoable fields of a phase. `visible` is not one of them.
fn content_fields(phase: &PhaseView) -> JsonFields {
    fields(&[
        ("title", json!(phase.title)),
        ("startDate", json!(phase.start_date)),
        ("endDate", json!(phase.end_date)),
        ("color", json!(phase.color)),
        ("ongoing", json!(phase.ongoing)),
    ])
}

pub fn update_phase(
    conn: &Connection,
    id: &str,
    patch: &PhasePatch,
    today: &str,
) -> Result<SaveOutcome<PhaseView>, String> {
    let Some((current, false)) = load_phase(conn, id)? else {
        return Err(crate::i18n::tr("Diese Phase existiert nicht mehr.").to_string());
    };
    let group = live_group(conn, &current.group_id)?;

    let mut next = current.clone();
    if let Some(title) = &patch.title {
        next.title = non_empty(title, crate::i18n::tr("Der Titel"))?;
    }
    let (start_date, end_date) = ordered_span(
        patch.start_date.as_deref().unwrap_or(&current.start_date),
        patch.end_date.as_deref().unwrap_or(&current.end_date),
    )?;
    next.start_date = start_date;
    next.end_date = end_date;
    if let Some(color) = &patch.color {
        next.color = parse_color(color)?;
    }
    if let Some(ongoing) = patch.ongoing {
        next.ongoing = ongoing;
    }

    if !group.overlap_allowed {
        let pairs = overlaps_with(&live_phases_of(conn, &group.id)?, &next);
        if !pairs.is_empty() {
            return Ok(SaveOutcome::Overlap { pairs });
        }
    }
    if next.ongoing {
        next.end_date = ongoing_end(conn, &group.id, id, &next.start_date, &next.end_date, group.overlap_allowed, today)?;
    }

    let old_fields = content_fields(&current);
    let new_fields = content_fields(&next);
    let mut before = JsonFields::new();
    let mut after = JsonFields::new();
    for (key, value) in &new_fields {
        if old_fields.get(key) != Some(value) {
            before.insert(key.clone(), old_fields[key].clone());
            after.insert(key.clone(), value.clone());
        }
    }

    if !after.is_empty() {
        write_content(conn, &next)?;
        log(
            conn,
            ActionType::PhaseUpdate,
            PhaseLogEntry {
                target: PhaseTarget::Phase,
                target_id: id.to_string(),
                label: next.title.clone(),
                before: Some(before),
                after: Some(after),
            },
        );
    }
    Ok(SaveOutcome::Saved { value: next })
}

fn write_content(conn: &Connection, phase: &PhaseView) -> Result<(), String> {
    conn.execute(
        "UPDATE phases SET title = ?1, start_date = ?2, end_date = ?3, color = ?4, ongoing = ?5 WHERE id = ?6",
        params![phase.title, phase.start_date, phase.end_date, phase.color, phase.ongoing, phase.id],
    )
    .map_err(|e| crate::trf!("Konnte Phase nicht speichern: {e}", e = e))?;
    Ok(())
}

pub fn remove_phase(conn: &Connection, id: &str) -> Result<(), String> {
    let Some((phase, false)) = load_phase(conn, id)? else {
        return Err(crate::i18n::tr("Diese Phase existiert nicht mehr.").to_string());
    };
    conn.execute("UPDATE phases SET removed_at = ?1 WHERE id = ?2", params![now_text(), id])
        .map_err(|e| crate::trf!("Konnte Phase nicht entfernen: {e}", e = e))?;
    log(
        conn,
        ActionType::PhaseRemove,
        PhaseLogEntry {
            target: PhaseTarget::Phase,
            target_id: id.to_string(),
            label: phase.title,
            before: None,
            after: None,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/// Phase entries leave the backend with negated ids (in `EntryView` and in
/// `Conflict`), because their row ids are a second sequence that overlaps
/// `action_log_entry`'s. `undo_entry` routes a negative id here, so a
/// Protokoll tab that knows nothing about phases can never undo a file by
/// passing a phase entry's id.
pub fn public_entry_id(row_id: i64) -> i64 {
    -row_id
}

struct PhaseUndoTarget {
    action_type: ActionType,
    target_id: String,
    label: String,
    before: Option<JsonFields>,
    reverted: bool,
}

fn load_undo_target(conn: &Connection, entry_id: i64) -> Result<Option<PhaseUndoTarget>, String> {
    let row: Option<(String, String, String, Option<String>, i64)> = conn
        .query_row(
            "SELECT a.action_type, e.target_id, e.label, e.before_json, e.reverted
             FROM action_log_phase_entry e JOIN action_log a ON a.id = e.action_id
             WHERE e.id = ?1",
            params![entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((action_type, target_id, label, before_json, reverted)) = row else {
        return Ok(None);
    };
    let Some(action_type) = ActionType::from_str(&action_type).filter(|t| t.is_phase()) else {
        return Ok(None);
    };
    Ok(Some(PhaseUndoTarget {
        action_type,
        target_id,
        label,
        before: action_log::parse_json_fields(before_json.as_deref()),
        reverted: reverted != 0,
    }))
}

enum Applied {
    Done,
    /// Already in the restored state — the entry stays unreverted.
    NoOp,
    Blocked(String),
}

/// Undoes phase entries (row ids of `action_log_phase_entry`), with the
/// same contract as `action_log_commands::undo_entries`: later changes in
/// the way come back as `Conflicts` unless `cascade` is set, in which case
/// they are undone first, newest first.
///
/// The whole plan runs inside a savepoint. Restoring something can still
/// collide with the overlap rule (a phase was added into the gap since),
/// and then nothing of the plan stays applied — the user gets the reason
/// and a state that is exactly what it was.
pub(crate) fn undo_phase_entries(conn: &Connection, entry_ids: &[i64], cascade: bool) -> Result<UndoOutcome, String> {
    let mut plan: Vec<i64> = Vec::new();
    for &entry_id in entry_ids {
        let Some(target) = load_undo_target(conn, entry_id)? else {
            return Ok(UndoOutcome::Blocked {
                reason: crate::i18n::tr("Dieser Protokolleintrag existiert nicht mehr.").to_string(),
            });
        };
        if target.reverted {
            continue;
        }
        let conflicts = action_log::later_phase_conflicts(conn, entry_id)?;
        if !conflicts.is_empty() {
            if !cascade {
                let conflicts = conflicts
                    .into_iter()
                    .map(|mut c| {
                        c.entry_id = public_entry_id(c.entry_id);
                        c
                    })
                    .collect();
                return Ok(UndoOutcome::Conflicts { conflicts });
            }
            plan.extend(conflicts.iter().map(|c| c.entry_id));
        }
        plan.push(entry_id);
    }

    if plan.is_empty() {
        return Ok(UndoOutcome::Blocked {
            reason: crate::i18n::tr("Diese Aktion wurde bereits rückgängig gemacht.").to_string(),
        });
    }
    // Newest first: every step then lands on the state the next one
    // recorded as its "before" (see `later_phase_conflicts` on why row
    // order is time order).
    plan.sort_unstable_by(|a, b| b.cmp(a));
    plan.dedup();

    conn.execute_batch("SAVEPOINT phase_undo").map_err(|e| e.to_string())?;
    let result = run_plan(conn, &plan);
    let finish = match &result {
        Ok(UndoOutcome::Done { .. }) => "RELEASE phase_undo",
        _ => "ROLLBACK TO phase_undo; RELEASE phase_undo",
    };
    conn.execute_batch(finish).map_err(|e| e.to_string())?;
    result
}

fn run_plan(conn: &Connection, plan: &[i64]) -> Result<UndoOutcome, String> {
    let mut undone = 0;
    for &entry_id in plan {
        let Some(target) = load_undo_target(conn, entry_id)? else { continue };
        if target.reverted {
            continue;
        }
        match apply_phase_undo(conn, &target)? {
            Applied::Done => {
                conn.execute(
                    "UPDATE action_log_phase_entry SET reverted = 1 WHERE id = ?1",
                    params![entry_id],
                )
                .map_err(|e| crate::trf!("Konnte Protokoll nicht aktualisieren: {e}", e = e))?;
                undone += 1;
            }
            Applied::NoOp => {}
            Applied::Blocked(reason) => return Ok(UndoOutcome::Blocked { reason }),
        }
    }
    Ok(UndoOutcome::Done { undone })
}

fn removed_group_reason(name: &str) -> String {
    crate::trf!("Der Themenbereich „{name}“ ist entfernt. Zuerst muss das Entfernen rückgängig gemacht werden.", name = name)
}

/// Would the group's live phases, with `candidate` in place of its stored
/// version, break the overlap rule? `None` if fine, otherwise the reason.
fn overlap_block(conn: &Connection, group: &GroupRow, candidate: &PhaseView) -> Result<Option<String>, String> {
    if group.overlap_allowed {
        return Ok(None);
    }
    let pairs = overlaps_with(&live_phases_of(conn, &group.id)?, candidate);
    Ok((!pairs.is_empty()).then(|| {
        crate::trf!(
            "Das Rückgängigmachen würde Phasen überschneiden lassen: {pairs}. Überlappung ist in „{group}“ nicht erlaubt.",
            pairs = describe_pairs(&pairs),
            group = group.name
        )
    }))
}

fn json_str(fields: &JsonFields, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_string)
}

fn json_bool(fields: &JsonFields, key: &str) -> Option<bool> {
    fields.get(key).and_then(Value::as_bool)
}

fn json_ids(fields: &JsonFields, key: &str) -> Vec<String> {
    fields
        .get(key)
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn apply_phase_undo(conn: &Connection, target: &PhaseUndoTarget) -> Result<Applied, String> {
    let empty = JsonFields::new();
    let before = target.before.as_ref().unwrap_or(&empty);
    let id = target.target_id.as_str();

    match target.action_type {
        ActionType::PhaseGroupCreate => {
            let Some(group) = load_group(conn, id)? else { return Ok(Applied::NoOp) };
            if group.removed {
                return Ok(Applied::NoOp);
            }
            // Its phases have been undone first by the cascade (every later
            // change inside the group is a conflict of this entry), so this
            // is only a safety net against leaving a phase in a group that
            // no longer exists.
            let now = now_text();
            conn.execute("UPDATE phase_groups SET removed_at = ?1 WHERE id = ?2", params![now, id])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE phases SET removed_at = ?1 WHERE group_id = ?2 AND removed_at IS NULL",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(Applied::Done)
        }

        ActionType::PhaseGroupUpdate => {
            let Some(group) = load_group(conn, id)? else { return Ok(Applied::NoOp) };
            if group.removed {
                return Ok(Applied::Blocked(removed_group_reason(&group.name)));
            }
            let name = json_str(before, "name").unwrap_or_else(|| group.name.clone());
            let overlap_allowed = json_bool(before, "overlapAllowed").unwrap_or(group.overlap_allowed);
            if !overlap_allowed && group.overlap_allowed {
                let pairs = overlapping_pairs(&live_phases_of(conn, id)?);
                if !pairs.is_empty() {
                    return Ok(Applied::Blocked(crate::trf!(
                        "„Überlappung erlaubt“ kann nicht zurückgenommen werden, solange sich Phasen überschneiden: {pairs}.",
                        pairs = describe_pairs(&pairs)
                    )));
                }
            }
            conn.execute(
                "UPDATE phase_groups SET name = ?1, overlap_allowed = ?2 WHERE id = ?3",
                params![name, overlap_allowed, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(Applied::Done)
        }

        ActionType::PhaseGroupReorder => {
            apply_group_order(conn, &json_ids(before, "order"))?;
            Ok(Applied::Done)
        }

        ActionType::PhaseGroupRemove => {
            let Some(group) = load_group(conn, id)? else { return Ok(Applied::NoOp) };
            if !group.removed {
                return Ok(Applied::NoOp);
            }
            conn.execute("UPDATE phase_groups SET removed_at = NULL WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            for phase_id in json_ids(before, "phaseIds") {
                conn.execute(
                    "UPDATE phases SET removed_at = NULL WHERE id = ?1 AND group_id = ?2",
                    params![phase_id, id],
                )
                .map_err(|e| e.to_string())?;
            }
            // Nothing can have been added to the group while it was gone,
            // so this only guards against a log that was edited by hand.
            if !group.overlap_allowed {
                let pairs = overlapping_pairs(&live_phases_of(conn, id)?);
                if !pairs.is_empty() {
                    return Ok(Applied::Blocked(crate::trf!(
                        "Die Phasen von „{group}“ würden sich überschneiden: {pairs}.",
                        group = group.name,
                        pairs = describe_pairs(&pairs)
                    )));
                }
            }
            Ok(Applied::Done)
        }

        ActionType::PhaseCreate => {
            let Some((_, false)) = load_phase(conn, id)? else { return Ok(Applied::NoOp) };
            conn.execute("UPDATE phases SET removed_at = ?1 WHERE id = ?2", params![now_text(), id])
                .map_err(|e| e.to_string())?;
            Ok(Applied::Done)
        }

        ActionType::PhaseUpdate => {
            let Some((current, removed)) = load_phase(conn, id)? else { return Ok(Applied::NoOp) };
            let Some(group) = load_group(conn, &current.group_id)? else { return Ok(Applied::NoOp) };
            if group.removed {
                return Ok(Applied::Blocked(removed_group_reason(&group.name)));
            }
            if removed {
                return Ok(Applied::Blocked(crate::trf!(
                    "Die Phase „{label}“ ist entfernt. Zuerst muss das Entfernen rückgängig gemacht werden.",
                    label = target.label
                )));
            }
            let restored = PhaseView {
                title: json_str(before, "title").unwrap_or_else(|| current.title.clone()),
                start_date: json_str(before, "startDate").unwrap_or_else(|| current.start_date.clone()),
                end_date: json_str(before, "endDate").unwrap_or_else(|| current.end_date.clone()),
                color: json_str(before, "color").unwrap_or_else(|| current.color.clone()),
                ongoing: json_bool(before, "ongoing").unwrap_or(current.ongoing),
                ..current
            };
            // Only one side of the span may have been restored, so the pair
            // has to be checked again as a whole.
            if restored.start_date > restored.end_date {
                return Ok(Applied::Blocked(crate::trf!(
                    "In „{title}“ läge das Enddatum danach vor dem Startdatum.",
                    title = restored.title
                )));
            }
            if let Some(reason) = overlap_block(conn, &group, &restored)? {
                return Ok(Applied::Blocked(reason));
            }
            write_content(conn, &restored)?;
            Ok(Applied::Done)
        }

        ActionType::PhaseRemove => {
            let Some((phase, removed)) = load_phase(conn, id)? else { return Ok(Applied::NoOp) };
            if !removed {
                return Ok(Applied::NoOp);
            }
            let Some(group) = load_group(conn, &phase.group_id)? else { return Ok(Applied::NoOp) };
            if group.removed {
                return Ok(Applied::Blocked(removed_group_reason(&group.name)));
            }
            if let Some(reason) = overlap_block(conn, &group, &phase)? {
                return Ok(Applied::Blocked(reason));
            }
            conn.execute("UPDATE phases SET removed_at = NULL WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(Applied::Done)
        }

        // Not phase actions — `load_undo_target` never yields these.
        ActionType::Import
        | ActionType::Remove
        | ActionType::Purge
        | ActionType::Rename
        | ActionType::DateChange
        | ActionType::AiDateChange
        | ActionType::SettingChange
        | ActionType::Replace => Ok(Applied::NoOp),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn
    }

    fn input(title: &str, start: &str, end: &str) -> PhaseInput {
        PhaseInput {
            title: title.to_string(),
            start_date: start.to_string(),
            end_date: end.to_string(),
            color: None,
            ongoing: false,
        }
    }

    fn saved<T: std::fmt::Debug>(outcome: SaveOutcome<T>) -> T {
        match outcome {
            SaveOutcome::Saved { value } => value,
            other => panic!("expected saved, got {other:?}"),
        }
    }

    fn add(conn: &Connection, group: &str, title: &str, start: &str, end: &str) -> PhaseView {
        saved(create_phase(conn, group, &input(title, start, end), "2026-10-28").unwrap())
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// The newest log entry of this type about this target.
    fn entry_of(conn: &Connection, action_type: &str, target_id: &str) -> i64 {
        conn.query_row(
            "SELECT e.id FROM action_log_phase_entry e JOIN action_log a ON a.id = e.action_id
             WHERE a.action_type = ?1 AND e.target_id = ?2 ORDER BY e.id DESC LIMIT 1",
            params![action_type, target_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn phase(conn: &Connection, id: &str) -> (PhaseView, bool) {
        load_phase(conn, id).unwrap().unwrap()
    }

    #[test]
    fn days_touching_end_to_start_do_not_overlap_but_a_shared_day_does() {
        assert!(!spans_overlap("2010-01-01", "2010-06-30", "2010-07-01", "2010-12-31"));
        assert!(spans_overlap("2010-01-01", "2010-07-01", "2010-07-01", "2010-12-31"));
        assert!(spans_overlap("2010-01-01", "2010-12-31", "2010-03-01", "2010-04-01"), "containment");
        assert!(spans_overlap("2010-03-01", "2010-03-01", "2010-03-01", "2010-03-01"), "single day");
    }

    #[test]
    fn dates_are_normalised_and_bad_spans_refused() {
        assert_eq!(parse_day(" 2010-3-5 ").unwrap(), "2010-03-05");
        assert!(parse_day("2010-02-30").is_err());
        assert!(parse_day("05.03.2010").is_err());
        assert!(ordered_span("2011-01-01", "2010-01-01").is_err());
        assert_eq!(parse_color("3584E4").unwrap(), "#3584e4");
        assert!(parse_color("#12345").is_err());
    }

    #[test]
    fn an_overlapping_phase_is_refused_without_writing_or_logging_anything() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let berlin = add(&conn, &group.id, "Berlin", "2010-01-01", "2010-12-31");
        let entries_before = count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry");

        match create_phase(&conn, &group.id, &input("Hamburg", "2010-12-31", "2011-05-01"), "2026-10-28").unwrap() {
            SaveOutcome::Overlap { pairs } => {
                assert_eq!(pairs.len(), 1);
                assert_eq!(pairs[0].second.id, berlin.id);
            }
            other => panic!("expected overlap, got {other:?}"),
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM phases"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry"), entries_before);

        // Starting the day after is fine.
        add(&conn, &group.id, "Hamburg", "2011-01-01", "2011-05-01");
        // And moving an existing phase into another is refused just the same.
        let outcome = update_phase(
            &conn,
            &berlin.id,
            &PhasePatch { end_date: Some("2011-02-01".into()), ..Default::default() },
            "2026-10-28",
        )
        .unwrap();
        assert!(matches!(outcome, SaveOutcome::Overlap { .. }));
        assert_eq!(phase(&conn, &berlin.id).0.end_date, "2010-12-31");
    }

    #[test]
    fn with_overlap_allowed_phases_may_overlap_and_switching_it_off_names_the_pairs() {
        let conn = test_conn();
        let group = create_group(&conn, "Projekte").unwrap();
        saved(update_group(&conn, &group.id, &GroupPatch { overlap_allowed: Some(true), ..Default::default() }).unwrap());
        let a = add(&conn, &group.id, "A", "2010-01-01", "2012-12-31");
        let b = add(&conn, &group.id, "B", "2012-06-01", "2014-01-01");
        add(&conn, &group.id, "C", "2015-01-01", "2015-12-31");

        match update_group(&conn, &group.id, &GroupPatch { overlap_allowed: Some(false), ..Default::default() }).unwrap() {
            SaveOutcome::Overlap { pairs } => {
                assert_eq!(pairs.len(), 1, "only A and B overlap");
                assert_eq!((pairs[0].first.id.as_str(), pairs[0].second.id.as_str()), (a.id.as_str(), b.id.as_str()));
            }
            other => panic!("expected overlap, got {other:?}"),
        }
        assert!(live_group(&conn, &group.id).unwrap().overlap_allowed, "the toggle stays on");

        // Once the overlap is gone, switching it off works.
        remove_phase(&conn, &b.id).unwrap();
        let group = saved(
            update_group(&conn, &group.id, &GroupPatch { overlap_allowed: Some(false), ..Default::default() }).unwrap(),
        );
        assert!(!group.overlap_allowed);
    }

    /// The case the user asked for by name: removing a Themenbereich takes
    /// its phases along, and undoing that brings them back in the same log
    /// line — but not a phase that had been removed on its own before.
    #[test]
    fn undoing_a_group_removal_brings_back_exactly_its_phases_in_one_entry() {
        let conn = test_conn();
        let group = create_group(&conn, "Schule").unwrap();
        let kept = add(&conn, &group.id, "Grundschule", "1990-08-01", "1994-07-31");
        let earlier = add(&conn, &group.id, "Gymnasium", "1994-08-01", "2003-06-30");
        remove_phase(&conn, &earlier.id).unwrap();
        remove_group(&conn, &group.id).unwrap();

        assert!(list_groups(&conn).unwrap().is_empty());
        assert!(phase(&conn, &kept.id).1, "removed along with its group");

        let entry = entry_of(&conn, "phase_group_remove", &group.id);
        let action: i64 = conn
            .query_row("SELECT action_id FROM action_log_phase_entry WHERE id = ?1", params![entry], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count(&conn, &format!("SELECT COUNT(*) FROM action_log_phase_entry WHERE action_id = {action}")),
            1,
            "one log line for the group and its phases"
        );

        let outcome = undo_phase_entries(&conn, &[entry], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");

        let groups = list_groups(&conn).unwrap();
        assert_eq!(groups.len(), 1);
        let titles: Vec<&str> = groups[0].phases.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, vec!["Grundschule"], "the separately removed phase stays removed");
    }

    #[test]
    fn undoing_an_update_restores_only_the_fields_it_changed() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let berlin = add(&conn, &group.id, "Berlin", "2010-01-01", "2012-12-31");
        let first_color = berlin.color.clone();

        // Two edits in a row inside the grouping window: one entry, whose
        // `before` holds the original of each field.
        let rename = PhasePatch { title: Some("Berlin-Mitte".into()), ..Default::default() };
        saved(update_phase(&conn, &berlin.id, &rename, "2026-10-28").unwrap());
        let recolor = PhasePatch { color: Some("#000000".into()), ..Default::default() };
        saved(update_phase(&conn, &berlin.id, &recolor, "2026-10-28").unwrap());
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM action_log a JOIN action_log_phase_entry e ON e.action_id = a.id WHERE a.action_type = 'phase_update'"),
            1
        );
        let edit = entry_of(&conn, "phase_update", &berlin.id);

        // Something else in between, so the next edit is an action of its own.
        create_group(&conn, "Beruf").unwrap();
        let later_end = PhasePatch { end_date: Some("2013-06-30".into()), ..Default::default() };
        saved(update_phase(&conn, &berlin.id, &later_end, "2026-10-28").unwrap());

        // The later end-date change touches no field of the first edit, so
        // it neither blocks the undo nor gets reset by it.
        let outcome = undo_phase_entries(&conn, &[edit], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        let (now, _) = phase(&conn, &berlin.id);
        assert_eq!(now.title, "Berlin");
        assert_eq!(now.color, first_color);
        assert_eq!(now.end_date, "2013-06-30");
    }

    #[test]
    fn a_later_change_to_the_same_field_is_offered_as_a_cascade() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let p = add(&conn, &group.id, "A", "2010-01-01", "2010-12-31");

        saved(update_phase(&conn, &p.id, &PhasePatch { title: Some("B".into()), ..Default::default() }, "2026-10-28").unwrap());
        let first = entry_of(&conn, "phase_update", &p.id);
        create_group(&conn, "Trenner").unwrap();
        saved(update_phase(&conn, &p.id, &PhasePatch { title: Some("C".into()), ..Default::default() }, "2026-10-28").unwrap());

        match undo_phase_entries(&conn, &[first], false).unwrap() {
            UndoOutcome::Conflicts { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert!(conflicts[0].entry_id < 0, "phase entries leave the backend negated");
            }
            other => panic!("expected conflicts, got {other:?}"),
        }
        assert_eq!(phase(&conn, &p.id).0.title, "C", "refused, so nothing moved");

        let outcome = undo_phase_entries(&conn, &[first], true).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 2 }), "{outcome:?}");
        assert_eq!(phase(&conn, &p.id).0.title, "A");
    }

    /// Undoing the creation of a Themenbereich must not strand the phases
    /// built in it since: they are the cascade.
    #[test]
    fn undoing_a_group_creation_first_undoes_what_was_built_inside_it() {
        let conn = test_conn();
        let group = create_group(&conn, "Beruf").unwrap();
        let created = entry_of(&conn, "phase_group_create", &group.id);
        let job = add(&conn, &group.id, "Junior", "2018-01-01", "2021-03-31");

        match undo_phase_entries(&conn, &[created], false).unwrap() {
            UndoOutcome::Conflicts { conflicts } => assert_eq!(conflicts.len(), 1),
            other => panic!("expected conflicts, got {other:?}"),
        }

        let outcome = undo_phase_entries(&conn, &[created], true).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 2 }), "{outcome:?}");
        assert!(list_groups(&conn).unwrap().is_empty());
        assert!(phase(&conn, &job.id).1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM phase_groups"), 1, "soft-removed, never deleted");
    }

    /// A restore that would break the overlap rule is refused as a whole:
    /// no part of the plan stays applied.
    #[test]
    fn a_restore_that_would_overlap_is_refused_and_changes_nothing() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let old = add(&conn, &group.id, "Alt", "2010-01-01", "2011-12-31");
        remove_phase(&conn, &old.id).unwrap();
        let removal = entry_of(&conn, "phase_remove", &old.id);
        add(&conn, &group.id, "Neu", "2011-06-01", "2012-12-31");

        match undo_phase_entries(&conn, &[removal], false).unwrap() {
            UndoOutcome::Blocked { reason } => assert!(reason.contains("überschneiden"), "{reason}"),
            other => panic!("expected blocked, got {other:?}"),
        }
        assert!(phase(&conn, &old.id).1, "still removed");
        assert_eq!(
            count(&conn, &format!("SELECT reverted FROM action_log_phase_entry WHERE id = {removal}")),
            0
        );
    }

    #[test]
    fn moves_in_a_row_are_one_entry_and_undo_restores_the_order_before_the_first() {
        let conn = test_conn();
        let a = create_group(&conn, "A").unwrap();
        let b = create_group(&conn, "B").unwrap();
        let c = create_group(&conn, "C").unwrap();
        let names = |conn: &Connection| -> Vec<String> { list_groups(conn).unwrap().into_iter().map(|g| g.name).collect() };

        move_group(&conn, &c.id, 0).unwrap();
        move_group(&conn, &a.id, 2).unwrap();
        assert_eq!(names(&conn), vec!["C", "B", "A"]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry WHERE target_kind = 'order'"), 1);

        let entry = entry_of(&conn, "phase_group_reorder", ORDER_TARGET_ID);
        let outcome = undo_phase_entries(&conn, &[entry], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        assert_eq!(names(&conn), vec!["A", "B", "C"]);
        let _ = b;
    }

    #[test]
    fn a_reorder_entry_carries_the_names_for_the_protokoll_not_only_ids() {
        let conn = test_conn();
        create_group(&conn, "A").unwrap();
        create_group(&conn, "B").unwrap();
        let c = create_group(&conn, "C").unwrap();
        move_group(&conn, &c.id, 0).unwrap();

        let (before, after): (String, String) = conn
            .query_row(
                "SELECT before_json, after_json FROM action_log_phase_entry WHERE target_kind = 'order'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(before.contains(r#""orderNames":["A","B","C"]"#), "{before}");
        assert!(after.contains(r#""orderNames":["C","A","B"]"#), "{after}");
    }

    #[test]
    fn a_later_move_is_a_cascade_for_an_earlier_one_and_a_new_group_keeps_its_place() {
        let conn = test_conn();
        let a = create_group(&conn, "A").unwrap();
        create_group(&conn, "B").unwrap();
        let c = create_group(&conn, "C").unwrap();
        let names = |conn: &Connection| -> Vec<String> { list_groups(conn).unwrap().into_iter().map(|g| g.name).collect() };

        move_group(&conn, &c.id, 0).unwrap();
        let first = entry_of(&conn, "phase_group_reorder", ORDER_TARGET_ID);
        create_group(&conn, "D").unwrap();
        move_group(&conn, &a.id, 3).unwrap();
        assert_eq!(names(&conn), vec!["C", "B", "D", "A"]);

        match undo_phase_entries(&conn, &[first], false).unwrap() {
            UndoOutcome::Conflicts { conflicts } => assert_eq!(conflicts.len(), 1),
            other => panic!("expected conflicts, got {other:?}"),
        }
        let outcome = undo_phase_entries(&conn, &[first], true).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 2 }), "{outcome:?}");
        assert_eq!(names(&conn), vec!["A", "B", "C", "D"], "D was created since and stays last");
    }

    #[test]
    fn undoing_a_rename_of_a_group_restores_the_name_and_a_later_rename_is_a_cascade() {
        let conn = test_conn();
        let group = create_group(&conn, "Alt").unwrap();
        let rename = |name: &str| GroupPatch { name: Some(name.into()), ..Default::default() };

        saved(update_group(&conn, &group.id, &rename("Neu")).unwrap());
        let first = entry_of(&conn, "phase_group_update", &group.id);
        create_group(&conn, "Trenner").unwrap();
        saved(update_group(&conn, &group.id, &rename("Neuer")).unwrap());

        match undo_phase_entries(&conn, &[first], false).unwrap() {
            UndoOutcome::Conflicts { conflicts } => assert_eq!(conflicts.len(), 1),
            other => panic!("expected conflicts, got {other:?}"),
        }
        let outcome = undo_phase_entries(&conn, &[first], true).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 2 }), "{outcome:?}");
        assert_eq!(live_group(&conn, &group.id).unwrap().name, "Alt");
    }

    #[test]
    fn undoing_a_group_removal_puts_it_back_in_its_place_even_after_a_new_group() {
        let conn = test_conn();
        create_group(&conn, "A").unwrap();
        let b = create_group(&conn, "B").unwrap();
        create_group(&conn, "C").unwrap();
        remove_group(&conn, &b.id).unwrap();
        let removal = entry_of(&conn, "phase_group_remove", &b.id);
        create_group(&conn, "D").unwrap();

        let outcome = undo_phase_entries(&conn, &[removal], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        let names: Vec<String> = list_groups(&conn).unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, vec!["A", "B", "C", "D"]);
    }

    /// A phase removed on its own, then its whole group: bringing the phase
    /// back first needs the group back, which the cascade does.
    #[test]
    fn restoring_a_phase_whose_group_was_removed_since_goes_through_the_cascade() {
        let conn = test_conn();
        let group = create_group(&conn, "Schule").unwrap();
        let a = add(&conn, &group.id, "A", "1990-01-01", "1994-12-31");
        add(&conn, &group.id, "B", "1995-01-01", "1999-12-31");
        remove_phase(&conn, &a.id).unwrap();
        let phase_removal = entry_of(&conn, "phase_remove", &a.id);
        remove_group(&conn, &group.id).unwrap();

        match undo_phase_entries(&conn, &[phase_removal], false).unwrap() {
            UndoOutcome::Conflicts { conflicts } => assert_eq!(conflicts.len(), 1),
            other => panic!("expected conflicts, got {other:?}"),
        }
        let outcome = undo_phase_entries(&conn, &[phase_removal], true).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 2 }), "{outcome:?}");
        let groups = list_groups(&conn).unwrap();
        let titles: Vec<&str> = groups[0].phases.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, vec!["A", "B"]);
    }

    #[test]
    fn a_removed_phase_is_gone_from_the_list_and_back_in_it_after_undo() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let p = add(&conn, &group.id, "Berlin", "2010-01-01", "2012-12-31");
        remove_phase(&conn, &p.id).unwrap();
        assert!(list_groups(&conn).unwrap()[0].phases.is_empty());

        let removal = entry_of(&conn, "phase_remove", &p.id);
        let outcome = undo_phase_entries(&conn, &[removal], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        let again = &list_groups(&conn).unwrap()[0].phases;
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, p.id);

        // Undone once, it is not offered a second time.
        let outcome = undo_phase_entries(&conn, &[removal], false).unwrap();
        assert!(matches!(outcome, UndoOutcome::Blocked { .. }), "{outcome:?}");
    }

    #[test]
    fn the_eyes_are_stored_with_a_tri_state_but_never_logged() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let a = add(&conn, &group.id, "A", "2010-01-01", "2010-12-31");
        add(&conn, &group.id, "B", "2011-01-01", "2011-12-31");
        let logged = count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry");

        let view = set_phase_visible(&conn, &a.id, false).unwrap();
        assert_eq!(view.visibility, Visibility::Partial);
        let view = set_group_visible(&conn, &group.id, false).unwrap();
        assert_eq!(view.visibility, Visibility::Hidden);
        assert!(view.phases.iter().all(|p| !p.visible));
        let view = set_group_visible(&conn, &group.id, true).unwrap();
        assert_eq!(view.visibility, Visibility::Visible);

        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry"), logged);
    }

    #[test]
    fn an_ongoing_phase_follows_today_unlogged_and_stops_before_the_next_one() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let mut here = input("Hier", "2020-01-01", "2021-01-01");
        here.ongoing = true;
        // Ticking "läuft noch" is logged, including the end it implies today.
        let here = saved(create_phase(&conn, &group.id, &here, "2021-06-01").unwrap());
        assert_eq!(here.end_date, "2021-06-01");
        let logged = count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry");

        // Later days move it on, without a log entry.
        assert_eq!(refresh_ongoing(&conn, "2026-10-28").unwrap(), 1);
        assert_eq!(phase(&conn, &here.id).0.end_date, "2026-10-28");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log_phase_entry"), logged);

        // A move already planned: the ongoing phase ends the day before.
        add(&conn, &group.id, "Dort", "2027-01-01", "2030-12-31");
        refresh_ongoing(&conn, "2027-03-01").unwrap();
        assert_eq!(phase(&conn, &here.id).0.end_date, "2026-12-31");

        // An end already in the future is left alone.
        let other = create_group(&conn, "Beruf").unwrap();
        let mut future = input("Vertrag", "2025-01-01", "2028-12-31");
        future.ongoing = true;
        let future = saved(create_phase(&conn, &other.id, &future, "2026-10-28").unwrap());
        refresh_ongoing(&conn, "2027-03-01").unwrap();
        assert_eq!(phase(&conn, &future.id).0.end_date, "2028-12-31");
    }

    /// Permanently deleting a file sweeps log headers left without entries.
    /// A phase action has none in `action_log_entry` and must survive that.
    #[test]
    fn deleting_a_files_history_never_sweeps_away_phase_actions() {
        let conn = test_conn();
        create_group(&conn, "Wohnorte").unwrap();
        action_log::record(&conn, ActionType::Import, &[action_log::LogEntry::presence("x", "x.jpg")]).unwrap();

        action_log::delete_entries_for_item(&conn, "x").unwrap();

        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log WHERE action_type = 'phase_group_create'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM action_log WHERE action_type = 'import'"), 0);
    }

    #[test]
    fn new_phases_get_the_next_free_palette_colour_of_their_group() {
        let conn = test_conn();
        let group = create_group(&conn, "Wohnorte").unwrap();
        let first = add(&conn, &group.id, "A", "2010-01-01", "2010-12-31");
        let second = add(&conn, &group.id, "B", "2011-01-01", "2011-12-31");
        assert_eq!(first.color, PALETTE[0]);
        assert_eq!(second.color, PALETTE[1]);
        remove_phase(&conn, &first.id).unwrap();
        assert_eq!(add(&conn, &group.id, "C", "2012-01-01", "2012-12-31").color, PALETTE[0]);
    }

    #[test]
    fn a_new_phase_avoids_colours_used_in_other_themenbereiche() {
        let conn = test_conn();
        let ages = create_group(&conn, "Hundeleben").unwrap();
        let trips = create_group(&conn, "Reisen").unwrap();
        add(&conn, &ages.id, "Welpenzeit", "2021-03-20", "2022-02-01");
        add(&conn, &ages.id, "Junghund", "2022-02-02", "2024-02-01");
        assert_eq!(add(&conn, &trips.id, "Nordsee", "2022-08-13", "2022-08-20").color, PALETTE[2]);
    }
}
