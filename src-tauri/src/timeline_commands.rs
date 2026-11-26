use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::action_log::{self, ActionType, LogEntry};
use crate::project_files::PendingDeletions;
use crate::schema::LIVE_ITEMS;
use crate::settings;
use crate::state::AppStateHandle;

/// Key for "Dateien beim Entfernen löschen" — when on, taking a file off
/// the timeline immediately purges its in-project copy too (see
/// `remove_item`/`remove_items_by_source_paths`), instead of leaving that
/// as a separate "endgültig löschen" step in the Protokoll tab.
pub(crate) const DELETE_FILES_ON_REMOVE_KEY: &str = "delete_files_on_remove";

fn delete_files_on_remove(conn: &Connection) -> bool {
    settings::get(conn, DELETE_FILES_ON_REMOVE_KEY)
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// The name to show for an item in the action log: what the user sees on
/// the tile, falling back to the real filename.
pub(crate) fn item_label(conn: &rusqlite::Connection, id: &str) -> String {
    conn.query_row(
        "SELECT COALESCE(display_name, original_filename) FROM items WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| id.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct ItemInfo {
    pub id: String,
    pub original_filename: String,
    pub display_name: Option<String>,
    pub stored_path: String,
    pub thumbnail_path: Option<String>,
    pub file_type: String,
    pub resolved_timestamp: String,
    pub timestamp_source: String,
    pub import_batch_id: Option<String>,
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    pub file_size_bytes: Option<u64>,
    pub rotation: i32,
    /// The user's free-text note for this file, shown under the detail
    /// view. `None` when no note has been written yet — the `notes` row
    /// is deleted again as soon as the field is emptied, so "no row" and
    /// "empty text" are never both representable.
    pub note: Option<String>,
    /// `FileKind::Email` only — small header fields, cheap enough to ship
    /// with every item unlike the body (see `get_item_email_html`).
    pub email_subject: Option<String>,
    pub email_sender: Option<String>,
    pub email_date: Option<String>,
    /// `file_type == "diary"` only: the entry's text, small enough to ship
    /// with every item (unlike a document's `extracted_text`).
    pub diary_text: Option<String>,
    pub attachment_count: u32,
}

/// Hands back a raw `tauri::ipc::Response` (JSON bytes) instead of
/// `Vec<ItemInfo>`: the reply travels over the custom protocol rather than
/// being passed through the webview as a JSON string, and the frontend
/// parses it itself (see `listItems` in `src/types.ts`).
///
/// Worth knowing what this did and did not buy, because the obvious reading
/// is wrong. Opening the 1779-item project blocks the webview's JS thread
/// for ~3 seconds, and the frontend measures this command at 3.4s against
/// 0.26s of backend time here. That looks like a transport cost, and it is
/// not: `loadMediaServerInfo`, whose reply is a host and a port, was
/// measured at 3277ms in the same window, and both replies landed in the
/// same instant, right after a 200ms heartbeat timer missed 16 consecutive
/// ticks and fired them all within 11ms — with React rendering nothing at
/// all in that window. So the JS thread is blocked by something else
/// entirely and every reply simply queues behind it, regardless of size.
/// Switching to raw bytes did not shorten the block.
///
/// It stays because it is the right shape anyway (1.2 MB need not become a
/// JS string first), but the remaining ~3s stall at mount is UNEXPLAINED —
/// do not read this signature as the fix for it.
///
/// `async` + `spawn_blocking`: on a cold page/disk cache this is real I/O
/// (confirmed via measurement: 3.3s on a cold open vs. ~210ms warm, on the
/// same project), and as a plain sync `fn` that ties up whatever thread
/// Tauri dispatches it on — on this Linux/WebKitGTK build that turned out
/// to visibly freeze the webview (even its CSS spinner animation) for the
/// duration, same as every other command in this codebase that needed this
/// fix. Re-fetches state by `AppHandle` inside the closure since a
/// `tauri::State` borrow can't cross into a `'static` spawn_blocking
/// closure — see `add_items` for the same pattern.
#[tauri::command]
pub async fn list_items(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        let mut stmt = current
            .conn
            .prepare(
                "SELECT i.id, i.original_filename, i.display_name, i.stored_path, i.thumbnail_path,
                        i.file_type, i.resolved_timestamp, i.timestamp_source, i.import_batch_id,
                        i.fs_created_at, i.fs_modified_at, i.file_size_bytes, i.rotation,
                        n.text, i.email_subject, i.email_sender, i.email_date,
                        CASE WHEN i.file_type = 'diary' THEN i.extracted_text END,
                        CASE WHEN i.file_type = 'diary'
                             THEN (SELECT COUNT(*) FROM diary_attachments d WHERE d.diary_id = i.id)
                             ELSE 0 END
                 FROM items i LEFT JOIN notes n ON n.item_id = i.id
                 -- `datetime()`, not the raw column: the stored strings are
                 -- RFC3339 WITH an offset, and sorting them as text puts
                 -- 14:00+02:00 after 13:00+00:00 though it is the earlier
                 -- instant. Every row used to be UTC, which made text order
                 -- accidentally right; an EXIF date now carries the camera's
                 -- real offset (see exif_date.rs), so it no longer is. Same
                 -- trap `search_items` below sorts in Rust to avoid.
                 WHERE i.removed_at IS NULL ORDER BY datetime(i.resolved_timestamp) ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(ItemInfo {
                    id: row.get(0)?,
                    original_filename: row.get(1)?,
                    display_name: row.get(2)?,
                    stored_path: row.get(3)?,
                    thumbnail_path: row.get(4)?,
                    file_type: row.get(5)?,
                    resolved_timestamp: row.get(6)?,
                    timestamp_source: row.get(7)?,
                    import_batch_id: row.get(8)?,
                    fs_created_at: row.get(9)?,
                    fs_modified_at: row.get(10)?,
                    file_size_bytes: row.get::<_, Option<i64>>(11)?.map(|v| v as u64),
                    rotation: row.get(12)?,
                    note: row.get(13)?,
                    email_subject: row.get(14)?,
                    email_sender: row.get(15)?,
                    email_date: row.get(16)?,
                    diary_text: row.get(17)?,
                    attachment_count: row.get(18)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut items = rows.collect::<Result<Vec<ItemInfo>, _>>().map_err(|e| e.to_string())?;
        if let Some(hidden) = crate::privacy::hidden_ids(current, crate::privacy::Surface::Timeline)? {
            items.retain(|item| !hidden.contains(&item.id));
        }
        // Serialised here, inside the blocking thread, rather than by
        // letting Tauri serialise the return value — that is the whole
        // point of handing back a raw `Response`.
        serde_json::to_vec(&items).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn update_display_name(
    state: State<AppStateHandle>,
    id: String,
    display_name: String,
) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let trimmed = display_name.trim();
    let value: Option<&str> = if trimmed.is_empty() { None } else { Some(trimmed) };

    // Read before writing, so the log entry can restore it. The filename is
    // the entry's label: unlike the display name it never changes, so the
    // history stays recognisable after several renames.
    let (previous, filename): (Option<String>, String) = current
        .conn
        .query_row(
            "SELECT display_name, original_filename FROM items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| crate::trf!("Eintrag nicht gefunden: {e}", e = e))?;

    current
        .conn
        .execute(
            "UPDATE items SET display_name = ?1 WHERE id = ?2",
            params![value, id],
        )
        .map_err(|e| crate::trf!("Konnte Anzeigename nicht speichern: {e}", e = e))?;

    // A rename that changes nothing isn't worth a log entry — the viewer's
    // name field commits on blur, so clicking in and out of it without
    // typing would otherwise fill the log with no-ops.
    if previous.as_deref() != value {
        let _ = action_log::record(
            &current.conn,
            ActionType::Rename,
            &[LogEntry {
                item_id: Some(id.clone()),
                label: filename,
                before_value: previous,
                after_value: value.map(|v| v.to_string()),
                before_source: None,
            }],
        );
    }
    Ok(())
}

/// The free-text note shown under the detail view. Saved on every change
/// without a confirmation step, so this is deliberately cheap: one row per
/// item, replaced wholesale, and emptying the field drops the row again.
///
/// Not written to the action log: a note is typed character by character,
/// and an entry per keystroke (or even per debounce window) would bury the
/// imports and renames the log exists for.
#[tauri::command(async)]
pub fn update_note(app: AppHandle, state: State<AppStateHandle>, id: String, note: String) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let trimmed = note.trim();
    if trimmed.is_empty() {
        current
            .conn
            .execute("DELETE FROM notes WHERE item_id = ?1", params![id])
            .map_err(|e| crate::trf!("Konnte Notiz nicht löschen: {e}", e = e))?;
        return Ok(());
    }

    set_note_text(&current.conn, &id, trimmed)?;
    if crate::privacy::note_hides_item(current, trimmed)? {
        let _ = app.emit(crate::privacy::NOTE_HID_ITEM_EVENT, ());
    }
    Ok(())
}

/// Replaces an item's note wholesale with `text`, which must already be
/// trimmed and non-empty — the shared upsert `update_note` and
/// `append_note_term` both reduce to once they've decided what the new text
/// should be.
fn set_note_text(conn: &Connection, item_id: &str, text: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE notes SET text = ?1 WHERE item_id = ?2",
            params![text, item_id],
        )
        .map_err(|e| crate::trf!("Konnte Notiz nicht speichern: {e}", e = e))?;

    if changed == 0 {
        conn.execute(
            "INSERT INTO notes (id, item_id, text, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                item_id,
                text,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| crate::trf!("Konnte Notiz nicht speichern: {e}", e = e))?;
    }
    Ok(())
}

/// Adds `term` to an item's existing note rather than replacing it — what
/// "Notiz hinzufügen" in Datei-Operationen does for each marked file, one
/// at a time, so a file that already carries notes from elsewhere keeps
/// them.
///
/// Comma-separated, matching how the note field reads as free text rather
/// than a tag list. A term already present (compared trimmed, case- and
/// whitespace-insensitively isn't attempted — exact trimmed match is
/// enough for the common "I already tagged this" case) is left alone so
/// running the action twice on the same files doesn't duplicate it.
pub(crate) fn append_note_term(conn: &Connection, item_id: &str, term: &str) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT text FROM notes WHERE item_id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let next = match existing {
        None => term.to_string(),
        Some(text) if text.split(',').any(|part| part.trim() == term) => return Ok(()),
        Some(text) => format!("{text}, {term}"),
    };

    set_note_text(conn, item_id, &next)
}

/// Key for "Frühestes erlaubtes Jahr" — the lower bound for any date the
/// user sets by hand. Guards against typos like 0020 the same way the
/// future check guards against 2100.
pub(crate) const EARLIEST_DATE_YEAR_KEY: &str = "earliest_date_year";
pub(crate) const DEFAULT_EARLIEST_DATE_YEAR: i32 = 1900;

pub(crate) fn earliest_date_year(conn: &Connection) -> i32 {
    settings::get(conn, EARLIEST_DATE_YEAR_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(DEFAULT_EARLIEST_DATE_YEAR)
}

/// Rejects a hand-set timestamp that lies in the future (a typo like the
/// year 2100 would make the timeline build every year up to it) or before
/// the configured earliest year. One minute of slack on the future side for
/// clock differences between frontend and backend.
pub(crate) fn ensure_date_allowed(conn: &Connection, timestamp: &str) -> Result<(), String> {
    use chrono::Datelike;
    let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).map_err(|_| crate::i18n::tr("Ungültiges Datum.").to_string())?;
    if parsed > chrono::Utc::now() + chrono::Duration::minutes(1) {
        return Err(crate::i18n::tr("Das Datum darf nicht in der Zukunft liegen.").to_string());
    }
    let min_year = earliest_date_year(conn);
    if parsed.with_timezone(&chrono::Local).year() < min_year {
        return Err(crate::trf!("Das Datum darf nicht vor dem Jahr {min_year} liegen.", min_year = min_year));
    }
    Ok(())
}

/// Manual override of a file's timeline position (per the project decision,
/// this is one of two ways to correct a wrong date — the other being
/// dragging the tile on the timeline, which also calls this command).
#[tauri::command(async)]
pub fn update_timestamp(
    state: State<AppStateHandle>,
    id: String,
    timestamp: String,
) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    ensure_date_allowed(&current.conn, &timestamp)?;

    let (previous, previous_source, label): (String, String, String) = current
        .conn
        .query_row(
            "SELECT resolved_timestamp, timestamp_source,
                    COALESCE(display_name, original_filename)
             FROM items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| crate::trf!("Eintrag nicht gefunden: {e}", e = e))?;

    current
        .conn
        .execute(
            "UPDATE items SET resolved_timestamp = ?1, timestamp_source = 'manual' WHERE id = ?2",
            params![timestamp, id],
        )
        .map_err(|e| crate::trf!("Konnte Datum nicht speichern: {e}", e = e))?;

    // Dragging a tile fires this on every drop, including one that lands
    // where it started.
    if previous != timestamp {
        let _ = action_log::record(
            &current.conn,
            ActionType::DateChange,
            &[LogEntry {
                item_id: Some(id.clone()),
                label,
                before_value: Some(previous),
                after_value: Some(timestamp.clone()),
                before_source: Some(previous_source),
            }],
        );
    }
    Ok(())
}

#[derive(serde::Deserialize, Debug)]
pub struct TimestampEntry {
    pub id: String,
    pub timestamp: String,
}

/// Manual batch counterpart to `update_timestamp` — the "Datum im
/// Stream ändern" dialog in Datei-Operationen/Papierkorb uses this for
/// both of its modes: setting one shared date on every selected file (the
/// frontend just repeats the same `timestamp` for each `id`) and editing
/// several files individually in one go. Mirrors
/// `ai_metadata::apply_ai_metadata_suggestions` almost line for line, the
/// only difference being `timestamp_source = 'manual'` and the log action
/// type — grouped into one `DateChange` entry for the whole batch, so
/// undoing it in the Protokoll tab reverts everything the dialog changed
/// together, not one file at a time.
/// `async` + `spawn_blocking` + one transaction, same reasoning as
/// `ai_metadata::apply_ai_metadata_suggestions`, which this mirrors.
#[tauri::command]
pub async fn update_timestamps_batch(app: AppHandle, entries: Vec<TimestampEntry>, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        for entry in &entries {
            ensure_date_allowed(&current.conn, &entry.timestamp).map_err(|e| format!("{e} ({})", entry.id))?;
        }

        let total = entries.len();
        let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut updated = 0usize;
        let mut log_entries = Vec::new();

        for (done, entry) in entries.iter().enumerate() {
            let previous: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT resolved_timestamp, timestamp_source,
                            COALESCE(display_name, original_filename)
                     FROM items WHERE id = ?1",
                    params![entry.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();

            let changed = tx
                .execute(
                    "UPDATE items SET resolved_timestamp = ?1, timestamp_source = 'manual' WHERE id = ?2",
                    params![entry.timestamp, entry.id],
                )
                .map_err(|e| crate::trf!("Konnte Datum nicht speichern: {e}", e = e))?;
            updated += changed;

            if changed > 0 {
                if let Some((before, before_source, label)) = previous {
                    // Same "a drop that lands where it started" guard as
                    // `update_timestamp` — "Für alle setzen" on a batch that
                    // already shares that date would otherwise log a no-op
                    // change for every file in it.
                    if before != entry.timestamp {
                        log_entries.push(LogEntry {
                            item_id: Some(entry.id.clone()),
                            label,
                            before_value: Some(before),
                            after_value: Some(entry.timestamp.clone()),
                            before_source: Some(before_source),
                        });
                    }
                }
            }
            crate::progress::emit_progress(&app, &operation_id, done + 1, total, &entry.id);
        }

        if !log_entries.is_empty() {
            let _ = action_log::record(&tx, ActionType::DateChange, &log_entries);
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Rotates an item already in the project by `delta` degrees (±90/180),
/// wrapping into 0/90/180/270 and persisting it on the item's own row —
/// this is purely a display-time transform (applied in the frontend), the
/// stored original and thumbnail files are never touched.
#[tauri::command(async)]
pub fn rotate_item(state: State<AppStateHandle>, id: String, delta: i32) -> Result<i32, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let existing: i32 = current
        .conn
        .query_row("SELECT rotation FROM items WHERE id = ?1", params![id], |row| row.get(0))
        .map_err(|e| crate::trf!("Eintrag nicht gefunden: {e}", e = e))?;
    let new_rotation = (((existing + delta) % 360) + 360) % 360;

    current
        .conn
        .execute("UPDATE items SET rotation = ?1 WHERE id = ?2", params![new_rotation, id])
        .map_err(|e| crate::trf!("Konnte Drehung nicht speichern: {e}", e = e))?;

    Ok(new_rotation)
}

/// Takes a file off the timeline. Nothing is deleted by default: the row
/// is flagged (`items.removed_at`) and the in-project copy stays where it
/// is, so the action log can put it back with a single click. Deleting the
/// copy for real is normally a separate, explicit step ("Endgültig
/// löschen" in the log — see `action_log_commands::purge_items`) — unless
/// the "Dateien beim Entfernen löschen" setting is on, in which case that
/// second step happens automatically right here, logged as its own Purge
/// entry immediately following the Remove one (exactly what doing both
/// steps by hand would produce).
///
/// This replaced an immediate delete plus a two-click "Wirklich entfernen?"
/// confirmation: with the log as the safety net, the confirmation was
/// asking the user to be careful about something that is now reversible
/// (when the setting is off).
#[tauri::command(async)]
pub fn remove_item(state: State<AppStateHandle>, id: String) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let conn = &current.conn;

    let label = item_label(conn, &id);
    let changed = conn
        .execute(
            "UPDATE items SET removed_at = ?1 WHERE id = ?2 AND removed_at IS NULL",
            params![chrono::Utc::now().to_rfc3339(), id],
        )
        .map_err(|e| crate::trf!("Konnte Eintrag nicht entfernen: {e}", e = e))?;

    if changed > 0 {
        let _ = action_log::record(conn, ActionType::Remove, &[LogEntry::presence(&id, &label)]);

        if delete_files_on_remove(conn) {
            let mut deletions = PendingDeletions::default();
            if let Some(purged_label) = purge_item_row(conn, &id, &mut deletions) {
                let _ = action_log::record(conn, ActionType::Purge, &[LogEntry::gone(&purged_label)]);
            }
            // No transaction here: the row's DELETE has already committed.
            deletions.run(&current.path);
        }
    }
    Ok(())
}

/// Deletes one already-removed item's in-project copy, thumbnail and row —
/// the file-system/DB half of a permanent delete. Callers record the Purge
/// action themselves, since how it's grouped differs (one combined entry
/// for a bulk "endgültig löschen", one entry per item when it follows an
/// automatic remove). Returns the item's label on success, for that log
/// entry.
///
/// The files themselves are only queued in `deletions`: the caller runs
/// them once the row's deletion has committed, so a failed commit can never
/// leave a row whose file is already gone.
pub(crate) fn purge_item_row(conn: &Connection, item_id: &str, deletions: &mut PendingDeletions) -> Option<String> {
    let (stored_path, thumbnail_path, label, file_type): (String, Option<String>, String, String) = conn
        .query_row(
            "SELECT stored_path, thumbnail_path, COALESCE(display_name, original_filename), file_type
             FROM items WHERE id = ?1 AND removed_at IS NOT NULL",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .ok()
        .flatten()?;

    conn.execute("DELETE FROM items WHERE id = ?1", params![item_id]).ok()?;
    deletions.item_files(&stored_path, thumbnail_path.as_deref());
    if file_type == crate::diary::DIARY_KIND {
        crate::diary::purge_diary_files(conn, item_id, &stored_path, deletions);
    }
    Some(label)
}

/// Same removal as `remove_item`, but looked up by the original (outside the
/// project) source path rather than the item id — used by the file browser,
/// which only knows source paths, to let already-added files be deselected
/// from the project in bulk.
///
/// Logged as a single action covering every file, so unticking a folder's
/// worth of files reads as one entry in the log and undoes as one — and if
/// "Dateien beim Entfernen löschen" is on, the resulting purge is likewise
/// one combined entry rather than one per file, matching how the explicit
/// "endgültig löschen" bulk action already groups itself.
/// `async` + `spawn_blocking`, same reasoning as `add_items`/`open_project`:
/// `remove_items_by_ids` below can touch hundreds of rows (and, with
/// "Dateien beim Entfernen löschen" on, as many files) and must not sit on
/// the IPC thread. `operation_id` is the id the frontend registered with
/// `ProgressContext.startOperation` before calling this.
#[tauri::command]
pub async fn remove_items_by_source_paths(
    app: AppHandle,
    paths: Vec<String>,
    operation_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let conn = &current.conn;

        let mut ids = Vec::new();
        for path in paths {
            let found: Option<String> = conn
                .query_row(
                    &format!("SELECT id FROM items WHERE source_path = ?1 AND {LIVE_ITEMS}"),
                    params![path],
                    |row| row.get(0),
                )
                .ok();
            if let Some(id) = found {
                ids.push(id);
            }
        }

        remove_items_by_ids(conn, &current.path, &ids, |done, total, current_label| {
            crate::progress::emit_progress(&app, &operation_id, done, total, current_label);
        })?;
        Ok(())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// The shared bulk-removal core: soft-removes every live item in `ids`,
/// logs it as *one* Remove action, and — if "Dateien beim Entfernen
/// löschen" is on — follows it with one combined Purge, exactly as doing
/// both steps by hand would. Returns how many items actually moved.
///
/// Factored out so every bulk caller agrees on the semantics rather than
/// re-implementing them: the file browser's "remove selected" (by source
/// path, above), the "Datei-Operationen" tab's batch removal (by item id),
/// and the source side of a cross-project *move* (see
/// `transfer_commands::transfer_items`) are all the same removal.
///
/// Runs as one transaction rather than autocommitting every `UPDATE`/
/// `DELETE` individually — with SQLite's default journal mode that's one
/// disk fsync per statement, so for a few hundred ids the difference between
/// this and the old per-statement commits is most of the wall-clock time,
/// not just whether the IPC thread is blocked meanwhile. `on_progress(done,
/// total, current_label)` is called once per processed id — a no-op closure
/// for callers that don't surface progress (the cross-project move).
pub(crate) fn remove_items_by_ids(
    conn: &Connection,
    project_path: &Path,
    ids: &[String],
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut removed_ids = Vec::new();
    let mut entries = Vec::new();
    let total = ids.len();
    let mut deletions = PendingDeletions::default();

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    for (done, id) in ids.iter().enumerate() {
        let label: Option<String> = tx
            .query_row(
                &format!(
                    "SELECT COALESCE(display_name, original_filename)
                     FROM items WHERE id = ?1 AND {LIVE_ITEMS}"
                ),
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        // Already off the timeline (or gone entirely) — nothing to remove,
        // and logging it would offer an undo that restores nothing.
        let Some(label) = label else { continue };

        tx.execute("UPDATE items SET removed_at = ?1 WHERE id = ?2", params![now, id])
            .map_err(|e| crate::trf!("Konnte Eintrag nicht entfernen: {e}", e = e))?;

        on_progress(done + 1, total, &label);
        entries.push(LogEntry::presence(id, &label));
        removed_ids.push(id.clone());
    }

    if !entries.is_empty() {
        let _ = action_log::record(&tx, ActionType::Remove, &entries);

        if delete_files_on_remove(&tx) {
            let purge_total = removed_ids.len();
            let purged_entries: Vec<LogEntry> = removed_ids
                .iter()
                .enumerate()
                .filter_map(|(done, id)| {
                    let purged = purge_item_row(&tx, id, &mut deletions);
                    if let Some(label) = &purged {
                        on_progress(done + 1, purge_total, label);
                    }
                    purged.map(|label| LogEntry::gone(&label))
                })
                .collect();
            if !purged_entries.is_empty() {
                let _ = action_log::record(&tx, ActionType::Purge, &purged_entries);
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    deletions.run(project_path);
    Ok(removed_ids.len())
}

/// Fetches the full extracted text for a Word/ODT/RTF/txt item, for the
/// internal text viewer — kept out of `list_items` (which would otherwise
/// ship every document's entire text on every timeline load) and loaded
/// on demand instead, for the same reason `extracted_text` is kept out of
/// `list_items`: it would otherwise be shipped on every timeline load.
#[tauri::command(async)]
pub fn get_item_text(state: State<AppStateHandle>, id: String) -> Result<Option<String>, String> {
    let (text, filename, stored_path): (Option<String>, String, String) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        current
            .conn
            .query_row(
                "SELECT extracted_text, original_filename, stored_path FROM items WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| crate::trf!("Eintrag nicht gefunden: {e}", e = e))?
    };
    if text.is_some() || !filename.to_lowercase().ends_with(".txt") {
        return Ok(text);
    }

    // A .txt imported while non-UTF-8 files were still rejected has no
    // stored text. Read it now (outside the lock) and keep it, so the
    // viewer and the search have it from here on.
    let Some(text) = crate::doc_text::extract_text(Path::new(&stored_path)).ok().filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(current) = guard.current_project.as_ref() {
        let _ = current
            .conn
            .execute("UPDATE items SET extracted_text = ?1 WHERE id = ?2 AND extracted_text IS NULL", params![text, id]);
    }
    Ok(Some(text))
}

/// Fetches the sanitised HTML body of an e-mail item, for the viewer's
/// preferred rendering — re-parses the original file fresh (via
/// `email::extract_html`) rather than caching it in the database, since
/// unlike the small header fields this can be arbitrarily large and the
/// original file already lives permanently in `originals/`. `None` when
/// the mail has no genuine HTML part (plain-text mails fall back to
/// `get_item_text`, which reads the already-stored `extracted_text`).
#[tauri::command(async)]
pub fn get_item_email_html(state: State<AppStateHandle>, id: String) -> Result<Option<String>, String> {
    // The lock only for the path lookup: parsing a large .msg ran with it
    // held, and hovering over a mail tile alone was enough to stall others.
    let stored_path = email_stored_path(&state, &id)?;
    crate::email::extract_html(Path::new(&stored_path))
}

#[tauri::command(async)]
pub fn get_item_email_recipients(state: State<AppStateHandle>, id: String) -> Result<crate::email::EmailRecipients, String> {
    // The lock only for the path lookup: parsing a large .msg ran with it
    // held, and hovering over a mail tile alone was enough to stall others.
    let stored_path = email_stored_path(&state, &id)?;
    crate::email::extract_recipients(Path::new(&stored_path))
}

fn email_stored_path(state: &State<AppStateHandle>, id: &str) -> Result<String, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    current
        .conn
        .query_row("SELECT stored_path FROM items WHERE id = ?1", params![id], |row| row.get(0))
        .map_err(|e| crate::trf!("Eintrag nicht gefunden: {e}", e = e))
}

#[tauri::command(async)]
pub fn get_item_email_attachments(state: State<AppStateHandle>, id: String) -> Result<Vec<crate::email::EmailAttachment>, String> {
    let stored_path = email_stored_path(&state, &id)?;
    crate::email::list_attachments(Path::new(&stored_path))
}

/// Extracts one attachment into a temp folder and returns its path; the
/// frontend then opens it with the system's default program.
#[tauri::command(async)]
pub fn extract_item_email_attachment(state: State<AppStateHandle>, id: String, index: usize) -> Result<String, String> {
    let stored_path = email_stored_path(&state, &id)?;
    let dest = std::env::temp_dir().join("cronostream-attachments").join(format!("{id}-{index}"));
    let target = crate::email::save_attachment(Path::new(&stored_path), index, &dest)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Finds the items an active search matches: a case-insensitive substring
/// of the display name, the original filename or the extracted document
/// text (see `extracted_text`), plus an optional inclusive day range.
/// Returns only the matching ids, in chronological order — the frontend
/// already holds the full `ItemInfo` of every item (see `list_items`), so
/// sending them a second time would be pure duplication.
///
/// Why this is a DB query at all: `extracted_text` is deliberately NOT part
/// of `ItemInfo`, so the frontend simply has no document text to search in
/// (same reasoning as `get_item_text` above).
///
/// Why the matching then happens in Rust rather than in SQL: SQLite's
/// `LIKE` and `lower()` only case-fold ASCII, so searching for "müller"
/// would silently miss "Müller" — unacceptable for a German-first app, and
/// exactly the kind of near-miss a user would never suspect. Rust's
/// `to_lowercase` is Unicode-aware. The date range is parsed for the same
/// reason: `resolved_timestamp` is RFC3339 with a per-item UTC offset, so
/// comparing it lexically against a "YYYY-MM-DD" bound would be off by up
/// to a day; taking each item's own LOCAL calendar day instead matches the
/// inclusive whole-day convention the rest of the app already filters by
/// (see `src/utils/printRange.ts`).
///
/// Not optimized beyond that: a full scan is fine at MVP scale, and the
/// document text is only read when there is a text query to apply to it.
/// FTS5 is the answer if a project ever grows large enough for this to be
/// noticeable, not before.
#[tauri::command(async)]
pub fn search_items(
    state: State<AppStateHandle>,
    query: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<String>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let needle = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let from = from.filter(|d| !d.is_empty());
    let to = to.filter(|d| !d.is_empty());

    // The note joins in unconditionally — the `notes` row is at most one per
    // item (see the unique index in `schema.rs`), so it can't multiply the
    // result rows, and a note is short enough that it costs nothing next to
    // `extracted_text`.
    let sql = if needle.is_some() {
        format!(
            "SELECT items.id, display_name, original_filename, resolved_timestamp,
                    extracted_text, notes.text, att.names
             FROM items LEFT JOIN notes ON notes.item_id = items.id
             LEFT JOIN (SELECT diary_id, group_concat(original_filename, char(10)) AS names
                        FROM diary_attachments GROUP BY diary_id) att ON att.diary_id = items.id
             WHERE {LIVE_ITEMS}"
        )
    } else {
        // A pure date filter must not haul every document's full text out
        // of the database for nothing.
        format!("SELECT id, display_name, original_filename, resolved_timestamp, NULL, NULL, NULL FROM items WHERE {LIVE_ITEMS}")
    };

    let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?;

    let mut stmt = current.conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut hits: Vec<(i64, String)> = Vec::new();
    for row in rows {
        let (id, display_name, original_filename, timestamp, text, note, attachment_names) = row.map_err(|e| e.to_string())?;

        if hidden.as_ref().is_some_and(|hidden| hidden.contains(&id)) {
            continue;
        }

        // An unparseable timestamp can't be placed on a time axis, so the
        // timeline drops those items outright (see `reloadItems`) — a
        // search hit the user then couldn't be taken to would be worse
        // than no hit at all.
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&timestamp) else { continue };
        let day = parsed.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
        if from.as_deref().is_some_and(|f| day.as_str() < f) {
            continue;
        }
        if to.as_deref().is_some_and(|t| day.as_str() > t) {
            continue;
        }

        if let Some(needle) = &needle {
            let hit = display_name.as_deref().is_some_and(|n| n.to_lowercase().contains(needle))
                || original_filename.to_lowercase().contains(needle)
                || text.as_deref().is_some_and(|t| t.to_lowercase().contains(needle))
                || note.as_deref().is_some_and(|n| n.to_lowercase().contains(needle))
                || attachment_names.as_deref().is_some_and(|n| n.to_lowercase().contains(needle));
            if !hit {
                continue;
            }
        }

        hits.push((parsed.timestamp_millis(), id));
    }

    // Sorted on the parsed instant rather than by SQL `ORDER BY`, which
    // would order the RFC3339 strings lexically and so mis-order items
    // whose stored offsets differ.
    hits.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(hits.into_iter().map(|(_, id)| id).collect())
}

pub(crate) fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("webp") => "image/webp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("wma") => "audio/x-ms-wma",
        Some("aiff") => "audio/aiff",
        Some("weba") => "audio/webm",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        Some("wmv") => "video/x-ms-wmv",
        Some("flv") => "video/x-flv",
        Some("3gp") => "video/3gpp",
        Some("mpg") | Some("mpeg") => "video/mpeg",
        _ => "application/octet-stream",
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cronostream-remove-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir.canonicalize().unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn file_in(project: &Path, rel: &str) -> PathBuf {
        let path = project.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"x").unwrap();
        path
    }

    fn insert_item(conn: &Connection, id: &str, stored: &Path, thumb: &Path) {
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES (?1, 'a.jpg', ?2, ?3, 'image',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            params![id, stored.to_string_lossy(), thumb.to_string_lossy()],
        )
        .unwrap();
    }

    fn row_exists(conn: &Connection, id: &str) -> bool {
        conn.query_row("SELECT COUNT(*) FROM items WHERE id = ?1", params![id], |row| row.get::<_, i64>(0))
            .unwrap()
            > 0
    }

    /// "Dateien beim Entfernen löschen" on: the bulk removal purges the
    /// project's own copy and thumbnail once the transaction has committed.
    #[test]
    fn removing_with_delete_on_remove_deletes_the_projects_own_files() {
        let scratch = Scratch::new();
        let project = scratch.0.join("P");
        fs::create_dir_all(&project).unwrap();
        let conn = crate::project::open_project_db(&project).unwrap();
        settings::set(&conn, DELETE_FILES_ON_REMOVE_KEY, "true").unwrap();
        let stored = file_in(&project, "originals/2024/01/a.jpg");
        let thumb = file_in(&project, "thumbnails/2024/01/a.jpg");
        insert_item(&conn, "a", &stored, &thumb);

        let removed = remove_items_by_ids(&conn, &project, &["a".to_string()], |_, _, _| {}).unwrap();

        assert_eq!(removed, 1);
        assert!(!row_exists(&conn, "a"));
        assert!(!stored.exists());
        assert!(!thumb.exists());
    }

    /// A project folder copied by hand still has the original's paths in
    /// its database. Purging there must drop the row but never touch the
    /// files of the project it was copied from.
    #[test]
    fn a_hand_copied_project_never_deletes_the_originals_files() {
        let scratch = Scratch::new();
        let original = scratch.0.join("Original");
        let copy = scratch.0.join("Kopie");
        fs::create_dir_all(&copy).unwrap();
        let foreign_stored = file_in(&original, "originals/2024/01/a.jpg");
        let foreign_thumb = file_in(&original, "thumbnails/2024/01/a.jpg");

        let conn = crate::project::open_project_db(&copy).unwrap();
        settings::set(&conn, DELETE_FILES_ON_REMOVE_KEY, "true").unwrap();
        insert_item(&conn, "a", &foreign_stored, &foreign_thumb);

        remove_items_by_ids(&conn, &copy, &["a".to_string()], |_, _, _| {}).unwrap();

        assert!(!row_exists(&conn, "a"));
        assert!(foreign_stored.exists(), "the other project's original must survive");
        assert!(foreign_thumb.exists(), "the other project's thumbnail must survive");
    }
}
