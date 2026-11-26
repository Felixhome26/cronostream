//! Tagebucheinträge: free-text entries placed on the timeline by hand, with
//! any number of attached files.
//!
//! An entry is an ordinary `items` row with `file_type = 'diary'`, so removal,
//! the action log, date dragging, the search and the file managers all treat
//! it like any other item without special cases. The text lives in
//! `extracted_text` (which `search_items` already searches). `stored_path`
//! points at a mirror of the text, `diary/<id>/entry.txt` — not needed to
//! display the entry, but every existing "is the copy still on disk" check
//! (undo of a removal, purge) keys on that file, and a diary row without one
//! would count as unrestorable.
//! `file_size_bytes` stays NULL on purpose: the duplicate scans only look at rows
//! with a size, and two short entries must never be reported as copies. Attachments are copied to `diary/<id>/anhang/`
//! and listed in `diary_attachments`.

use std::path::{Path, PathBuf};

use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::action_log::{self, ActionType, LogEntry};
use crate::project_files::PendingDeletions;
use crate::state::AppStateHandle;

pub const DIARY_KIND: &str = "diary";
pub(crate) const ENTRY_FILE: &str = "entry.txt";
pub(crate) const ATTACHMENT_DIR: &str = "anhang";

/// One file the dialog wants attached: either a path on disk (file dialog,
/// drag & drop) or raw bytes (an image pasted from the clipboard, which has
/// no file yet).
#[derive(Deserialize, Debug)]
pub struct AttachmentInput {
    pub path: Option<String>,
    pub name: String,
    pub data_base64: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiaryAttachment {
    pub id: String,
    pub original_filename: String,
    pub stored_path: String,
    pub file_type: String,
}

struct StagedAttachment {
    id: String,
    name: String,
    stored: PathBuf,
    kind: &'static str,
}

pub(crate) fn entry_dir(project: &Path, id: &str) -> PathBuf {
    project.join("diary").join(id)
}

/// A file name that is safe on every platform and cannot climb out of the
/// attachment folder: only the last path component, separators and
/// reserved characters replaced.
pub(crate) fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        crate::i18n::tr("Anhang").to_string()
    } else {
        cleaned
    }
}

pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Anhang");
    let ext = path.extension().and_then(|e| e.to_str());
    for n in 2.. {
        let file = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(file);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// What the file managers and the action log call the entry: the first line
/// of its text, so a list of entries is readable without opening each.
fn title_from_text(text: &str) -> String {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let title: String = first.chars().take(60).collect();
    // Stored as the entry's name, so the language at creation time sticks.
    if title.is_empty() {
        crate::i18n::tr("Tagebucheintrag").to_string()
    } else {
        title
    }
}

fn stage_attachment(dir: &Path, input: &AttachmentInput) -> Result<StagedAttachment, String> {
    std::fs::create_dir_all(dir).map_err(|e| crate::trf!("Konnte Anhang-Ordner nicht anlegen: {e}", e = e))?;
    let name = safe_name(&input.name);
    let stored = unique_path(dir, &name);

    match (&input.path, &input.data_base64) {
        (Some(path), _) => {
            let source = Path::new(path);
            if !source.is_file() {
                return Err(crate::trf!("„{name}“ ist keine Datei.", name = input.name));
            }
            crate::safe_io::copy_durably(source, &stored)
                .map_err(|e| crate::trf!("Konnte „{name}“ nicht kopieren: {e}", name = input.name, e = e))?;
        }
        (None, Some(data)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| crate::trf!("Ungültige Bilddaten: {e}", e = e))?;
            crate::safe_io::write_durably(&stored, bytes)
                .map_err(|e| crate::trf!("Konnte „{name}“ nicht speichern: {e}", name = input.name, e = e))?;
        }
        (None, None) => return Err(format!("Anhang „{}“ hat weder Pfad noch Daten.", input.name)),
    }

    let kind = crate::items::kind_str(crate::fsbrowse::classify(&stored));
    let final_name = stored.file_name().and_then(|n| n.to_str()).unwrap_or(&name).to_string();
    Ok(StagedAttachment { id: uuid::Uuid::new_v4().to_string(), name: final_name, stored, kind })
}

fn project_path(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppStateHandle>();
    let guard = state.lock().map_err(|e| e.to_string())?;
    Ok(guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.path.clone())
}

/// Creates (`id` = None) or edits an entry in one go: text, timestamp, the
/// attachments to drop and the ones to add. Returns the entry's id.
///
/// Not written to the action log on edit — same reasoning as `update_note`,
/// the text changes more often than the log should have to say so. Creating
/// one is logged as an import so the Protokoll can take it off again.
///
/// The file copying happens before the connection lock is taken: a pasted
/// screenshot or a large attachment must not stall every other command.
#[tauri::command]
pub async fn save_diary_entry(
    app: AppHandle,
    id: Option<String>,
    text: String,
    timestamp: String,
    remove_attachment_ids: Vec<String>,
    add_attachments: Vec<AttachmentInput>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        {
            let state = app.state::<AppStateHandle>();
            let guard = state.lock().map_err(|e| e.to_string())?;
            let conn = &guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.conn;
            crate::timeline_commands::ensure_date_allowed(conn, &timestamp)?;
        }
        let text = text.trim().to_string();
        let is_new = id.is_none();
        if is_new && text.is_empty() && add_attachments.is_empty() {
            return Err(crate::i18n::tr("Der Eintrag ist leer.").to_string());
        }

        let project = project_path(&app)?;
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let dir = entry_dir(&project, &id);
        let attachment_dir = dir.join(ATTACHMENT_DIR);

        let mut staged: Vec<StagedAttachment> = Vec::new();
        for input in &add_attachments {
            match stage_attachment(&attachment_dir, input) {
                Ok(s) => staged.push(s),
                Err(e) => {
                    for s in &staged {
                        let _ = std::fs::remove_file(&s.stored);
                    }
                    return Err(e);
                }
            }
        }

        let entry_file = dir.join(ENTRY_FILE);
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Eintrag nicht anlegen: {e}", e = e))?;
            crate::safe_io::write_durably(&entry_file, &text).map_err(|e| crate::trf!("Konnte Eintrag nicht speichern: {e}", e = e))?;

            let state = app.state::<AppStateHandle>();
            let guard = state.lock().map_err(|e| e.to_string())?;
            let conn = &guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.conn;
            write_entry(conn, &project, &id, is_new, &text, &timestamp, &entry_file, &remove_attachment_ids, &staged)
        })();

        if let Err(e) = result {
            for s in &staged {
                let _ = std::fs::remove_file(&s.stored);
            }
            if is_new {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return Err(e);
        }
        Ok(id)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[allow(clippy::too_many_arguments)]
fn write_entry(
    conn: &Connection,
    project: &Path,
    id: &str,
    is_new: bool,
    text: &str,
    timestamp: &str,
    entry_file: &Path,
    remove_ids: &[String],
    staged: &[StagedAttachment],
) -> Result<(), String> {
    let title = title_from_text(text);
    let mut deletions = PendingDeletions::default();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if is_new {
        tx.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp,
                                timestamp_source, added_at, extracted_text)
             VALUES (?1, ?2, ?3, ?4, ?5, 'manual', ?6, ?7)",
            params![
                id,
                title,
                entry_file.to_string_lossy().to_string(),
                DIARY_KIND,
                timestamp,
                chrono::Utc::now().to_rfc3339(),
                text
            ],
        )
        .map_err(|e| crate::trf!("Konnte Eintrag nicht speichern: {e}", e = e))?;
    } else {
        let changed = tx
            .execute(
                "UPDATE items SET original_filename = ?1, resolved_timestamp = ?2, timestamp_source = 'manual',
                                  extracted_text = ?3
                 WHERE id = ?4 AND file_type = ?5 AND removed_at IS NULL",
                params![title, timestamp, text, id, DIARY_KIND],
            )
            .map_err(|e| crate::trf!("Konnte Eintrag nicht speichern: {e}", e = e))?;
        if changed == 0 {
            return Err(crate::i18n::tr("Eintrag nicht gefunden.").to_string());
        }
    }

    for remove_id in remove_ids {
        let path: Option<String> = tx
            .query_row(
                "SELECT stored_path FROM diary_attachments WHERE id = ?1 AND diary_id = ?2",
                params![remove_id, id],
                |row| row.get(0),
            )
            .ok();
        if let Some(path) = path {
            tx.execute("DELETE FROM diary_attachments WHERE id = ?1", params![remove_id])
                .map_err(|e| e.to_string())?;
            deletions.file(path);
        }
    }

    let mut position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM diary_attachments WHERE diary_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    for s in staged {
        tx.execute(
            "INSERT INTO diary_attachments (id, diary_id, original_filename, stored_path, file_type, position, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                s.id,
                id,
                s.name,
                s.stored.to_string_lossy().to_string(),
                s.kind,
                position,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| crate::trf!("Konnte Anhang nicht speichern: {e}", e = e))?;
        position += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    deletions.run(project);

    if is_new {
        let _ = action_log::record(conn, ActionType::Import, &[LogEntry::presence(id, &title)]);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_diary_attachments(state: State<AppStateHandle>, id: String) -> Result<Vec<DiaryAttachment>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let mut stmt = current
        .conn
        .prepare(
            "SELECT id, original_filename, stored_path, file_type FROM diary_attachments
             WHERE diary_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![id], |row| {
            Ok(DiaryAttachment {
                id: row.get(0)?,
                original_filename: row.get(1)?,
                stored_path: row.get(2)?,
                file_type: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Writes a clipboard image to the recording staging area so it can go
/// through the normal add-to-project path (`add_items_with_dates`) as a plain
/// image item. The caller removes it again with `discard_recording` once added.
#[tauri::command(async)]
pub fn stage_clipboard_image(name: String, data_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| crate::trf!("Ungültige Bilddaten: {e}", e = e))?;
    let dir = crate::record_commands::staging_root().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Zwischenspeicher nicht anlegen: {e}", e = e))?;
    let path = dir.join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| crate::trf!("Konnte Bild nicht speichern: {e}", e = e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Called from `purge_item_row` when a permanently deleted item was a diary
/// entry: its attachments and its whole folder go with it — queued in
/// `deletions`, like the item's own files, until the caller has committed.
pub(crate) fn purge_diary_files(conn: &Connection, id: &str, stored_path: &str, deletions: &mut PendingDeletions) {
    let _ = conn.execute("DELETE FROM diary_attachments WHERE diary_id = ?1", params![id]);
    // Only ever the entry's own folder: it must be the parent of the mirror
    // file and named after the id, never a directory chosen by a stored path
    // — and `project_files` additionally refuses one outside the project.
    if let Some(dir) = Path::new(stored_path).parent() {
        if dir.file_name().and_then(|n| n.to_str()) == Some(id) {
            deletions.dir(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_cannot_escape_the_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\x\\bild.png"), "bild.png");
        assert_eq!(safe_name("..."), "Anhang");
    }

    #[test]
    fn title_is_first_nonempty_line() {
        assert_eq!(title_from_text("\n  Hallo Welt\nzweite Zeile"), "Hallo Welt");
        assert_eq!(title_from_text("   "), "Tagebucheintrag");
    }
}
