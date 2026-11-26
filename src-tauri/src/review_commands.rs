//! Commands behind the two review flows of the file browser: the
//! single-image view's picked list, and the text-manifest import. Both end
//! in the same screen, where every file's date can be switched between its
//! candidates (or typed by hand) before anything is written to the project.
//!
//! Note the deliberate distinction from the document support in `doc_text`:
//! there, a `.txt` file *is* the item being added. Here, a `.txt` file is a
//! list of paths pointing at other files, and is never added itself.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::browse_commands::{commit_prepared_batch, AddItemsResult, SkippedItem, ALREADY_ADDED_REASON};
use crate::fsbrowse::{self, FileKind};
use crate::items;
use crate::preview;
use crate::preview_cache::{self, PreviewCacheHandle};
use crate::state::AppStateHandle;

/// A file the user is about to add, with every date we could find for it.
/// `auto_source`/`auto_value` are what the automatic priority chain picked,
/// i.e. what the review screen preselects.
#[derive(Serialize, Clone, Debug)]
pub struct FileDateInfo {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub exif: Option<String>,
    pub filename: Option<String>,
    pub fs_created: Option<String>,
    pub fs_modified: Option<String>,
    pub auto_source: String,
    pub auto_value: String,
    pub can_add: bool,
}

/// Errors here are deliberately short, plain-language, and user-facing —
/// they end up in the import summary, never as a raw OS message.
fn build_file_date_info(path: &Path) -> Result<FileDateInfo, String> {
    let metadata = std::fs::metadata(path).map_err(|_| crate::i18n::tr("Datei nicht gefunden").to_string())?;
    if metadata.is_dir() {
        return Err(crate::i18n::tr("Das ist ein Ordner, keine Datei").to_string());
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| crate::i18n::tr("Ungültiger Dateiname").to_string())?;

    let kind = fsbrowse::classify(path);
    let (fs_created, fs_modified) = items::fs_times(path);
    let candidates = items::compute_date_candidates(path, kind, &fs_created, &fs_modified);

    Ok(FileDateInfo {
        path: path.to_string_lossy().to_string(),
        name,
        kind,
        exif: candidates.exif,
        filename: candidates.filename,
        fs_created: candidates.fs_created,
        fs_modified: candidates.fs_modified,
        auto_source: candidates.auto_source,
        auto_value: candidates.auto_value,
        can_add: fsbrowse::can_add(path, kind),
    })
}

/// Date candidates for paths the frontend already knows exist (they came
/// from a live directory listing), so unreadable ones are simply left out
/// rather than failing the whole call.
///
/// Reading EXIF means opening and parsing each file — blocking I/O, same
/// reasoning as the preview commands — and, for more than a handful of
/// paths, real enough work to parallelize the same way `add_items` does
/// instead of doing it one file at a time. `operation_id` identifies the
/// progress registration on the frontend (see `ProgressContext`); callers
/// with just one or two paths (the single-image view) can pass any id and
/// simply never register it, since there's nothing worth showing progress
/// for at that size.
#[tauri::command]
pub async fn get_date_candidates(app: AppHandle, paths: Vec<String>, operation_id: String) -> Result<Vec<FileDateInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = paths.len();
        let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(paths.len().max(1));
        let mut chunks: Vec<Vec<String>> = vec![Vec::new(); worker_count.max(1)];
        for (i, path) in paths.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(path);
        }

        let progress_done = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let progress_done = &progress_done;
                    let app = &app;
                    let operation_id = &operation_id;
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .filter_map(|p| {
                                let result = build_file_date_info(Path::new(&p)).ok();
                                let done = progress_done.fetch_add(1, Ordering::SeqCst) + 1;
                                crate::progress::emit_progress(app, operation_id, done, total, &p);
                                result
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))
}

/// How many files `get_media_dates` reads at the same time. Low on purpose:
/// it runs beside thumbnails and imports the user is waiting on, and
/// `media_date` caps the ffprobe processes app-wide anyway.
const MEDIA_DATE_WORKERS: usize = 2;

#[derive(Serialize)]
pub struct MediaDate {
    pub path: String,
    pub value: Option<String>,
}

/// The creation date inside each video, recording or document (see
/// `media_date`), apart from `get_date_candidates`: it needs an ffprobe run
/// or a document read per file, and is only ever an extra choice, never the
/// automatic one. Marking, the drop box and adding therefore never wait for
/// it; the frontend asks for it only where the choice is about to be shown,
/// a few paths at a time. Paths of other kinds come back with no value.
#[tauri::command]
pub async fn get_media_dates(paths: Vec<String>) -> Result<Vec<MediaDate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // One shared queue rather than chunks fixed in advance, so a file
        // that takes long holds up only its own worker.
        let next = AtomicUsize::new(0);
        let worker_count = MEDIA_DATE_WORKERS.min(paths.len().max(1));
        let mut found: Vec<(usize, Option<String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..worker_count)
                .map(|_| {
                    let (next, paths) = (&next, &paths);
                    scope.spawn(move || {
                        let mut out = Vec::new();
                        loop {
                            let index = next.fetch_add(1, Ordering::Relaxed);
                            let Some(path) = paths.get(index) else { break };
                            let path = Path::new(path);
                            let value = crate::safe_io::catch_panic(|| Ok(crate::media_date::read(path, fsbrowse::classify(path))))
                                .ok()
                                .flatten();
                            out.push((index, value));
                        }
                        out
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        found.sort_by_key(|(index, _)| *index);
        found.into_iter().map(|(index, value)| MediaDate { path: paths[index].clone(), value }).collect()
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))
}

#[derive(Serialize)]
pub struct ManifestImportResult {
    pub valid: Vec<FileDateInfo>,
    pub total_lines: usize,
    pub invalid_count: usize,
}

/// Reads a text file listing one file path per line and turns every usable
/// line into a review entry. Unusable lines (missing file, a folder, a type
/// that can't be added) are counted, not reported individually — the UI
/// shows a single "x of y not found" summary rather than a wall of errors.
///
/// Parallelized the same way `get_date_candidates`/`add_items` are — a
/// manifest can easily list hundreds of paths, each needing its own EXIF
/// read. `operation_id` identifies the progress registration on the
/// frontend (see `ProgressContext`).
#[tauri::command]
pub async fn import_paths_from_manifest(app: AppHandle, manifest_path: String, operation_id: String) -> Result<ManifestImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|_| crate::i18n::tr("Diese Textdatei konnte nicht gelesen werden.").to_string())?;

        let lines: Vec<&str> = content
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect();
        let total_lines = lines.len();

        let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(total_lines.max(1));
        let mut chunks: Vec<Vec<&str>> = vec![Vec::new(); worker_count.max(1)];
        for (i, line) in lines.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(line);
        }

        let progress_done = AtomicUsize::new(0);
        let valid: Vec<FileDateInfo> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let progress_done = &progress_done;
                    let app = &app;
                    let operation_id = &operation_id;
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .filter_map(|line| {
                                let result = build_file_date_info(Path::new(line)).ok().filter(|info| info.can_add);
                                let done = progress_done.fetch_add(1, Ordering::SeqCst) + 1;
                                crate::progress::emit_progress(app, operation_id, done, total_lines, line);
                                result
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        Ok(ManifestImportResult {
            invalid_count: total_lines - valid.len(),
            total_lines,
            valid,
        })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// One file plus the date the user settled on for it.
#[derive(Deserialize, Clone, Debug)]
pub struct DatedPath {
    pub path: String,
    pub timestamp: String,
    pub timestamp_source: String,
}

/// The review screen's "add to timeline" action. Mirrors `add_items`
/// (duplicate check up front, parallel prepare, sequential commit, one
/// shared import batch) but writes the user's chosen date per file instead
/// of resolving one automatically. Unlike `add_items`, this reports
/// progress through the shared `ProgressContext` channel rather than its
/// own — its callers (the manual review screen, the recorder) never had a
/// listener for `add_items`'s own event, so there's no existing UI wired
/// to leave alone here.
#[tauri::command]
pub async fn add_items_with_dates(app: AppHandle, entries: Vec<DatedPath>, operation_id: String) -> Result<AddItemsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();

        let batch_id = if entries.len() > 1 {
            Some(uuid::Uuid::new_v4().to_string())
        } else {
            None
        };

        let mut skipped = Vec::new();
        let mut overrides: HashMap<String, (String, String)> = HashMap::new();
        let mut to_prepare: Vec<String> = Vec::new();

        // State lock only for this read phase and the final inserts (see
        // `commit_prepared_batch`), not for the copying in between.
        let (project_path, default_percent, quick_hash_decisions) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

            for entry in entries {
                if items::source_already_added(&current.conn, &entry.path) {
                    skipped.push(SkippedItem { path: entry.path, reason: crate::i18n::tr(ALREADY_ADDED_REASON).to_string() });
                    continue;
                }

                // Validated here rather than inside the parallel prepare, so a
                // malformed date never costs a file copy that has to be undone.
                // The same bounds as a manual date change: a camera clock set
                // to 2100 must not stretch the timeline out to 2100.
                if let Err(reason) = crate::timeline_commands::ensure_date_allowed(&current.conn, &entry.timestamp) {
                    skipped.push(SkippedItem { path: entry.path, reason });
                    continue;
                }

                overrides.insert(entry.path.clone(), (entry.timestamp, entry.timestamp_source));
                to_prepare.push(entry.path);
            }

            (
                current.path.clone(),
                items::default_video_frame_percent(&current.conn),
                items::quick_hash_decisions(&current.conn, &to_prepare),
            )
        };

        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(to_prepare.len().max(1));

        let to_prepare_count = to_prepare.len();
        let mut chunks: Vec<Vec<String>> = vec![Vec::new(); worker_count.max(1)];
        for (i, path) in to_prepare.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(path);
        }

        let overrides = &overrides;
        let quick_hash_decisions = &quick_hash_decisions;
        let progress_total = to_prepare_count;
        let progress_done = AtomicUsize::new(0);
        let prepared_results: Vec<(String, Result<items::PreparedItem, String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let project_path = &project_path;
                    let progress_done = &progress_done;
                    let app = &app;
                    let operation_id = &operation_id;
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .map(|path| {
                                let date_override = overrides.get(&path).cloned();
                                let compute_quick_hash = quick_hash_decisions.get(&path).copied().unwrap_or(false);
                                let result = items::prepare_item(
                                    project_path,
                                    Path::new(&path),
                                    default_percent,
                                    date_override,
                                    compute_quick_hash,
                                );
                                let done = progress_done.fetch_add(1, Ordering::SeqCst) + 1;
                                crate::progress::emit_progress(app, operation_id, done, progress_total, &path);
                                (path, result)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        commit_prepared_batch(&state, &project_path, prepared_results, batch_id.as_deref(), skipped)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Sharp rendition for the single-image view and for the file browser's
/// preview panel, cached on disk in its own tier so it never competes with
/// the browse grid's small previews. `max_dim` picks between those two
/// renditions (see `preview::clamp_full_preview_dim`); omitting it yields
/// the largest one.
#[tauri::command]
pub async fn get_full_image_preview(app: AppHandle, path: String, max_dim: Option<u32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let max_dim = preview::clamp_full_preview_dim(max_dim);
        // Logged to the app's debug.log (not just stderr) so a slow folder
        // can be diagnosed from the file afterwards instead of having to be
        // caught live on the dev terminal.
        let started = std::time::Instant::now();
        let path_obj = Path::new(&path);
        let metadata = std::fs::metadata(path_obj).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = metadata.len() as i64;

        let cache_state = app.state::<PreviewCacheHandle>();
        let cached = |conn: &rusqlite::Connection| preview_cache::get_full(conn, &path, max_dim, mtime, size);
        if let Ok(conn) = cache_state.lock() {
            if let Some(hit) = cached(&conn) {
                log_preview_timing(&app, &path, max_dim, "Cache", started, hit.len());
                return Ok(preview::jpeg_bytes_to_data_url(&hit));
            }
        }

        if fsbrowse::classify(path_obj) != FileKind::Image {
            return Err("Diese Ansicht zeigt nur Bilder.".to_string());
        }

        // Generation is the expensive part, so only it waits for a slot —
        // and once a slot frees up, the cache is re-checked: while this
        // request was queued, the very same rendition may have been
        // produced by another one (the grid's click and the single view's
        // prefetch both land here).
        let bytes = preview::with_full_preview_slot(|| -> Result<Vec<u8>, String> {
            if let Ok(conn) = cache_state.lock() {
                if let Some(hit) = cached(&conn) {
                    return Ok(hit);
                }
            }
            let bytes = preview::full_image_preview_bytes(path_obj, max_dim)?;
            if let Ok(conn) = cache_state.lock() {
                preview_cache::set_full(&conn, &path, max_dim, mtime, size, &bytes);
            }
            Ok(bytes)
        })?;

        log_preview_timing(&app, &path, max_dim, "neu erzeugt", started, bytes.len());
        Ok(preview::jpeg_bytes_to_data_url(&bytes))
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

fn log_preview_timing(app: &AppHandle, path: &str, max_dim: u32, source: &str, started: std::time::Instant, bytes: usize) {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    crate::debug_log::append(
        app,
        &format!(
            "[preview] {name} -> {max_dim}px, {source}: {} ms gesamt, {} KB",
            started.elapsed().as_millis(),
            bytes / 1024
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_rejected_with_a_plain_message() {
        let err = build_file_date_info(Path::new("/definitely/not/here.jpg")).unwrap_err();
        assert_eq!(err, "Datei nicht gefunden");
    }

    #[test]
    fn directory_is_rejected() {
        let dir = std::env::temp_dir();
        let err = build_file_date_info(&dir).unwrap_err();
        assert_eq!(err, "Das ist ein Ordner, keine Datei");
    }

    #[test]
    fn plain_file_falls_back_to_filesystem_dates() {
        let path = std::env::temp_dir().join(format!("cronostream-review-test-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"not really a png").unwrap();

        let info = build_file_date_info(&path).unwrap();
        assert_eq!(info.kind, FileKind::Image);
        assert!(info.can_add);
        // No EXIF in this file, so the automatic choice has to be one of the
        // filesystem dates — and whichever it is must carry a real value.
        assert!(info.exif.is_none());
        assert!(matches!(info.auto_source.as_str(), "fs_created" | "fs_modified"));
        assert!(!info.auto_value.is_empty());

        std::fs::remove_file(&path).ok();
    }
}
