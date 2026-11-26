//! The Tauri commands for life phases. Each one is a thin wrapper around
//! `phases.rs`, which holds the rules and does the logging. Every write runs
//! in one transaction, so a change and its log entry land together.
//!
//! Undo has no command of its own here: phase actions show up in the
//! Protokoll like any other action and go through `undo_action` /
//! `undo_entry` (see `action_log_commands`).

use rusqlite::Connection;
use tauri::State;

use crate::phases::{self, GroupPatch, PhaseGroupView, PhaseInput, PhasePatch, PhaseView, SaveOutcome};
use crate::state::AppStateHandle;

fn with_project<T>(state: &State<AppStateHandle>, write: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let result = write(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

/// Every Themenbereich with its phases, top to bottom. Moves the end of
/// each "läuft noch" phase to today first (unlogged), so whatever reads the
/// list — opening the stream, or reloading after midnight — sees the
/// current end.
#[tauri::command(async)]
pub fn list_phase_groups(state: State<AppStateHandle>) -> Result<Vec<PhaseGroupView>, String> {
    with_project(&state, |conn| {
        phases::refresh_ongoing(conn, &phases::today())?;
        phases::list_groups(conn)
    })
}

/// The twelve colours of the colour popup, in the order new phases get them.
#[tauri::command]
pub fn get_phase_palette() -> Vec<String> {
    phases::PALETTE.iter().map(|c| c.to_string()).collect()
}

#[tauri::command(async)]
pub fn create_phase_group(state: State<AppStateHandle>, name: String) -> Result<PhaseGroupView, String> {
    with_project(&state, |conn| phases::create_group(conn, &name))
}

/// Renames and/or toggles "Überlappung erlaubt". Switching it off while
/// phases overlap comes back as `overlap` with the pairs, unchanged.
#[tauri::command(async)]
pub fn update_phase_group(
    state: State<AppStateHandle>,
    id: String,
    patch: GroupPatch,
) -> Result<SaveOutcome<PhaseGroupView>, String> {
    with_project(&state, |conn| phases::update_group(conn, &id, &patch))
}

/// Moves a Themenbereich to `toIndex` (0 = top). Returns the whole list.
#[tauri::command(async)]
pub fn move_phase_group(
    state: State<AppStateHandle>,
    id: String,
    to_index: u32,
) -> Result<Vec<PhaseGroupView>, String> {
    with_project(&state, |conn| phases::move_group(conn, &id, to_index as usize))
}

#[tauri::command(async)]
pub fn remove_phase_group(state: State<AppStateHandle>, id: String) -> Result<(), String> {
    with_project(&state, |conn| phases::remove_group(conn, &id))
}

/// The Themenbereich's eye. Stored, not logged.
#[tauri::command(async)]
pub fn set_phase_group_visibility(
    state: State<AppStateHandle>,
    id: String,
    visible: bool,
) -> Result<PhaseGroupView, String> {
    with_project(&state, |conn| phases::set_group_visible(conn, &id, visible))
}

#[tauri::command(async)]
pub fn create_phase(
    state: State<AppStateHandle>,
    group_id: String,
    input: PhaseInput,
) -> Result<SaveOutcome<PhaseView>, String> {
    with_project(&state, |conn| phases::create_phase(conn, &group_id, &input, &phases::today()))
}

/// Changes any of title, dates, colour, "läuft noch"; fields left out stay.
#[tauri::command(async)]
pub fn update_phase(
    state: State<AppStateHandle>,
    id: String,
    patch: PhasePatch,
) -> Result<SaveOutcome<PhaseView>, String> {
    with_project(&state, |conn| phases::update_phase(conn, &id, &patch, &phases::today()))
}

#[tauri::command(async)]
pub fn remove_phase(state: State<AppStateHandle>, id: String) -> Result<(), String> {
    with_project(&state, |conn| phases::remove_phase(conn, &id))
}

/// One phase's eye. Returns its whole group, whose tri-state may have
/// changed. Stored, not logged.
#[tauri::command(async)]
pub fn set_phase_visibility(
    state: State<AppStateHandle>,
    id: String,
    visible: bool,
) -> Result<PhaseGroupView, String> {
    with_project(&state, |conn| phases::set_phase_visible(conn, &id, visible))
}
