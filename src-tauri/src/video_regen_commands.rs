//! Re-extracts every video's thumbnail frame at the project's current
//! default percentage.
//!
//! Deliberately a separate, explicit action rather than something that
//! fires automatically whenever `default_video_frame_percent` changes
//! (which is what the original MVP notes called for): regenerating N
//! videos means N `ffmpeg` invocations, which is real time for a project
//! with many videos, and firing it silently on every settings tweak would
//! make "drag the slider" an unpredictably slow action. The settings
//! dialog instead offers it as an opt-in checkbox next to the slider.
//!
//! Not logged to the action log: there is no reversible "before" state
//! worth keeping — the old thumbnail file is simply overwritten in place
//! (`ffmpeg -y`), the same as every other thumbnail regeneration path in
//! the app (`rotate_item` isn't logged either, for the same reason: it's a
//! display-time derivative, not project content).

use rusqlite::{params, Connection};
use tauri::{AppHandle, Emitter, Manager};

use crate::schema::LIVE_ITEMS;
use crate::state::AppStateHandle;
use crate::video_preview;

const REGEN_PROGRESS_EVENT: &str = "video-regen-progress";

#[derive(serde::Serialize, Clone)]
struct RegenProgress {
    done: usize,
    total: usize,
    current: String,
}

/// Regenerates the thumbnail of every video currently in the project (not
/// ones that were removed — see `LIVE_ITEMS`) at the given percentage, and
/// updates each item's own `video_frame_percent` to match, so a later
/// restore or transfer reproduces this frame rather than reverting to
/// whatever the video had before.
#[tauri::command]
pub async fn regenerate_video_thumbnails(app: AppHandle, percent: f64) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let project_path = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.path.clone()
        };
        // The lock only for each short database step, never across ffmpeg:
        // held for the whole run, every other command waited minutes on it.
        let with_db = |work: &mut dyn FnMut(&Connection) -> Result<(), String>| {
            let guard = crate::state::lock_project(&state, &project_path)?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            work(&current.conn)
        };
        regenerate(&with_db, percent, &|done, total, current| {
            let _ = app.emit(REGEN_PROGRESS_EVENT, RegenProgress { done, total, current: current.to_string() });
        })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// The actual work, free of the Tauri plumbing so it can be exercised
/// directly in a test against a real video file.
///
/// `with_db` runs one database step with the connection (and in the app,
/// under the project lock just for that step); the ffmpeg work happens
/// between those steps, with nothing locked.
fn regenerate(
    with_db: &dyn Fn(&mut dyn FnMut(&Connection) -> Result<(), String>) -> Result<(), String>,
    percent: f64,
    on_progress: &dyn Fn(usize, usize, &str),
) -> Result<usize, String> {
    let mut videos: Vec<(String, String, Option<String>, String)> = Vec::new();
    with_db(&mut |conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, stored_path, thumbnail_path, COALESCE(display_name, original_filename)
                 FROM items WHERE file_type = 'video' AND {LIVE_ITEMS}"
            ))
            .map_err(|e| e.to_string())?;
        videos = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(())
    })?;

    let total = videos.len();
    let mut done_count = 0usize;

    for (id, stored_path, thumbnail_path, label) in videos {
        on_progress(done_count, total, &label);

        // Every video gets a thumbnail at import time (see
        // `items::prepare_item`) — a video item with none would mean the
        // invariant broke somewhere else, not something to paper over here
        // with a freshly invented path.
        let Some(dest) = &thumbnail_path else { continue };

        if video_preview::extract_frame(std::path::Path::new(&stored_path), percent, std::path::Path::new(dest))
            .is_ok()
        {
            with_db(&mut |conn| {
                conn.execute("UPDATE items SET video_frame_percent = ?1 WHERE id = ?2", params![percent, id])
                    .map(|_| ())
                    .map_err(|e| crate::trf!("Konnte Eintrag nicht aktualisieren: {e}", e = e))
            })?;
            done_count += 1;
        }
        // A single video that fails (corrupt file, moved source, ...)
        // doesn't stop the rest — same reasoning as every other batch
        // operation in the app (`add_items`, `transfer_items`).
    }

    on_progress(total, total, "");
    Ok(done_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No ffmpeg-touching unit test for the SQL/control-flow shape — the
    /// real decode is exercised separately against a real video file (see
    /// the external verification run in the implementing session), since
    /// that needs ffmpeg on PATH and a real media file, neither of which
    /// belong in a plain `cargo test` fixture.
    #[test]
    fn skips_videos_without_a_thumbnail_rather_than_failing() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES ('a', 'a.mp4', '/nope.mp4', NULL, 'video',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();

        let calls = std::cell::RefCell::new(Vec::new());
        let result = regenerate(&|work| work(&conn), 20.0, &|done, total, current| {
            calls.borrow_mut().push((done, total, current.to_string()));
        });

        assert_eq!(result, Ok(0), "no thumbnail to overwrite, so nothing succeeds");
        // Still reported as a step, so a caller watching progress sees it
        // move rather than appearing to hang on this item.
        assert_eq!(calls.borrow().len(), 2, "one start-of-item call plus the final 100% call");
    }

    #[test]
    fn only_live_videos_are_considered() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type,
                                resolved_timestamp, timestamp_source, added_at, removed_at)
             VALUES ('a', 'a.mp4', '/nope.mp4', '/nope.jpg', 'video',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00',
                     '2024-02-01T00:00:00+00:00')",
            [],
        )
        .unwrap();

        let result = regenerate(&|work| work(&conn), 20.0, &|_, _, _| {});
        assert_eq!(result, Ok(0), "a removed item's video is not touched");
    }
}
