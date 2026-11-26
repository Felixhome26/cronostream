use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Shared progress channel for long-running bulk commands (removing,
/// purging, importing, batch-editing many items). One event name for all of
/// them, distinguished by `id` — the frontend's `ProgressContext` is the
/// single listener and fans updates out to whichever operation registered
/// that id, so a new bulk command only needs to call `emit_progress`, not
/// wire up its own event name and its own frontend listener. The
/// human-readable label shown in the UI is supplied by the frontend's own
/// `startOperation` call, not here — the backend only ever reports counts.
///
/// Deliberately *not* used for the single-file, already-parallel `add_items`
/// path (see `browse_commands::ADD_ITEMS_PROGRESS_EVENT`) — that one predates
/// this module and has its own well-established listener in `PendingDrops`/
/// `CollectionAddButton`; left as is rather than churned for its own sake.
pub const PROGRESS_EVENT: &str = "cronostream-progress";

#[derive(Serialize, Clone)]
pub struct ProgressUpdate {
    pub id: String,
    pub done: usize,
    pub total: usize,
    pub current: String,
}

/// Reports one step of a running bulk operation. `id` must be the same
/// value the frontend passed to `startOperation` (a fresh UUID generated
/// per call, not a constant — several bulk operations of the same kind
/// could in principle overlap). Errors emitting are ignored, same as every
/// other progress event in this codebase: a dropped UI update must never
/// fail the operation itself.
pub fn emit_progress(app: &AppHandle, id: &str, done: usize, total: usize, current: &str) {
    let _ = app.emit(PROGRESS_EVENT, ProgressUpdate { id: id.to_string(), done, total, current: current.to_string() });
}
