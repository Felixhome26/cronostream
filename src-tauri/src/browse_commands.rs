use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::action_log;
use crate::duplicate_hash::{self, DuplicateGroup};
use crate::fsbrowse::{self, DirListing, FileKind};
use crate::items::{self, AddedItem};
use crate::preview;
use crate::preview_cache::{self, PreviewCacheHandle};
use crate::settings;
use crate::state::AppStateHandle;

const LAST_BROWSED_FOLDER_KEY: &str = "last_browsed_folder";
/// Emitted once per file as `add_items` works through a batch — the copy +
/// thumbnail/frame-extraction step (`items::prepare_item`) is the only part
/// slow enough to matter, so that's what's counted here.
const ADD_ITEMS_PROGRESS_EVENT: &str = "add-items-progress";

#[derive(Serialize, Clone)]
struct AddItemsProgress {
    done: usize,
    total: usize,
    current: String,
}

/// All pending manual-rotation overrides for files not yet added to the
/// project (see `rotate_path`), keyed by absolute path. The table only ever
/// holds a handful of rows at a time (one per not-yet-imported file the
/// user happened to rotate), so loading it whole is cheap.
pub(crate) fn load_path_rotations(conn: &rusqlite::Connection) -> HashMap<String, i32> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn.prepare("SELECT path, rotation FROM path_rotations") else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))) else {
        return map;
    };
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    map
}

/// Rotation of every already-imported, not-removed item, keyed by its
/// original filesystem path (`source_path`) — used to make the browser
/// show the same rotation as the timeline for files it has already added.
fn load_item_rotations(conn: &rusqlite::Connection) -> HashMap<String, i32> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn.prepare("SELECT source_path, rotation FROM items WHERE source_path IS NOT NULL AND removed_at IS NULL") else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))) else {
        return map;
    };
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    map
}

#[tauri::command]
pub async fn list_directory(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    path: Option<String>,
    recursive: Option<bool>,
) -> Result<DirListing, String> {
    let never_cancelled = Arc::new(AtomicBool::new(false));
    list_directory_inner(app, &state, path, recursive.unwrap_or(false), never_cancelled, |_| {}).await
}

/// Streamed form of `list_directory` with `recursive: true`, for the
/// grid's "Dateien in Unterordnern anzeigen": files arrive on `on_batch`
/// while the walk is still running, and `cancel_list_directory(task_id)`
/// ends it early. Resolves with the complete, sorted listing (or an error
/// once cancelled).
#[tauri::command]
pub async fn list_directory_streamed(
    app: AppHandle,
    state: State<'_, AppStateHandle>,
    tasks: State<'_, ListingTasks>,
    task_id: String,
    path: String,
    on_batch: Channel<Vec<fsbrowse::DirEntryInfo>>,
) -> Result<DirListing, String> {
    let cancel = tasks.register(&task_id);
    let result = list_directory_inner(app, &state, Some(path), true, cancel, move |batch| {
        let _ = on_batch.send(batch);
    })
    .await;
    tasks.unregister(&task_id);
    result
}

#[tauri::command(async)]
pub fn cancel_list_directory(tasks: State<ListingTasks>, task_id: String) {
    if let Ok(map) = tasks.0.lock() {
        if let Some(flag) = map.get(&task_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Cancel flags of the running streamed listings, by the frontend's task id.
#[derive(Default)]
pub struct ListingTasks(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl ListingTasks {
    fn register(&self, task_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.0.lock() {
            map.insert(task_id.to_string(), flag.clone());
        }
        flag
    }

    fn unregister(&self, task_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(task_id);
        }
    }
}

async fn list_directory_inner(
    app: AppHandle,
    state: &AppStateHandle,
    path: Option<String>,
    recursive: bool,
    cancel: Arc<AtomicBool>,
    mut on_batch: impl FnMut(Vec<fsbrowse::DirEntryInfo>) + Send + 'static,
) -> Result<DirListing, String> {
    // Rotations are looked up once, up front, so the batches streamed out
    // of the walk can carry them too. Already-imported files take theirs
    // from the item's own row (the timeline is the source of truth there —
    // see `rotate_path`), overriding a leftover `path_rotations` row.
    let (resolved_path, rotations): (PathBuf, HashMap<String, i32>) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let resolved = match path {
            Some(p) => PathBuf::from(p),
            None => settings::get(&current.conn, LAST_BROWSED_FOLDER_KEY)?
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .unwrap_or_else(fsbrowse::default_start_dir),
        };
        let mut rotations = load_path_rotations(&current.conn);
        rotations.extend(load_item_rotations(&current.conn));
        (resolved, rotations)
    };

    // Only this one directory (not recursive) — the browse-time audio
    // preview plays straight from the source file via the local media
    // server (see media_server.rs), before it's been added to the project.
    // Widening to every folder the user ever navigates through is harmless
    // (read-only, local files) but kept minimal rather than scoping the
    // whole filesystem up front. When the recursive toggle is on, the
    // server needs to serve files several levels below the listed folder
    // too, so it's scoped recursively for exactly that listing — before
    // the walk, since streamed files can be previewed while it runs.
    app.state::<crate::media_server::MediaServerHandle>()
        .allow_dir(&resolved_path, recursive);

    // Scanning (fs::read_dir + a metadata/stat call per entry) is blocking
    // I/O — spawn it off rather than running it inline, same reasoning as
    // get_file_preview below. The recursive walk reuses the disk-wide
    // search's own safety cap (`fsbrowse::MAX_WALK_ENTRIES`), so this can't
    // repeat the 2026-10-13 incident just because "Dateien in Unterordnern
    // anzeigen" got flipped on over a huge tree.
    let rotations = Arc::new(rotations);
    let walk_rotations = rotations.clone();
    let mut listing = tauri::async_runtime::spawn_blocking(move || {
        if recursive {
            fsbrowse::list_dir_recursive(&resolved_path, &cancel, |batch| {
                let mut batch = batch.to_vec();
                apply_rotations(&mut batch, &walk_rotations);
                on_batch(batch);
            })
        } else {
            fsbrowse::list_dir(&resolved_path)
        }
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))??;
    apply_rotations(&mut listing.entries, &rotations);

    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    settings::set(&current.conn, LAST_BROWSED_FOLDER_KEY, &listing.path)?;

    Ok(listing)
}

fn apply_rotations(entries: &mut [fsbrowse::DirEntryInfo], rotations: &HashMap<String, i32>) {
    if rotations.is_empty() {
        return;
    }
    for entry in entries {
        if let Some(&rotation) = rotations.get(&entry.path) {
            entry.rotation = rotation;
        }
    }
}

/// Browse-time preview for any addable file kind — dispatches to the right
/// generator (image resize / ffmpeg frame / PDFium page) based on the
/// file's extension.
///
/// Explicitly spawned onto Tokio's blocking-task pool rather than left as a
/// plain sync command: image decode/resize (and shelling out to ffmpeg/
/// PDFium) is real CPU/IO work, and relying on Tauri's default dispatch
/// for a sync command was still visibly freezing the UI with only a
/// handful of concurrent calls — this guarantees it runs off whatever
/// thread handles IPC/UI work, independent of that default.
///
/// Generated bytes are cached on disk keyed by path + mtime + size, so
/// re-opening the same folder (the common case while browsing) serves
/// straight from the cache instead of re-decoding every file again.
#[tauri::command]
pub async fn get_file_preview(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        if let Ok(conn) = cache_state.lock() {
            if let Some(cached) = preview_cache::get(&conn, &path, mtime, size) {
                return Ok(preview::jpeg_bytes_to_data_url(&cached));
            }
        }

        let has_ext = |ext: &str| path_obj.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext));
        let bytes = match fsbrowse::classify(path_obj) {
            FileKind::Image => preview::image_preview_bytes(path_obj),
            FileKind::Video => preview::video_preview_bytes(path_obj, 10.0),
            FileKind::Document if has_ext("pdf") => preview::pdf_preview_bytes(path_obj),
            FileKind::Document if has_ext("doc") => preview::doc_card_preview_bytes(path_obj),
            // docx/odt/rtf/txt have no visual preview — they show a static
            // icon in the browser (and their extracted text once added),
            // same as audio and e-mail.
            FileKind::Document | FileKind::Audio | FileKind::Email | FileKind::Other => Err(crate::i18n::tr("Keine Vorschau für diesen Dateityp.").into()),
        }?;

        if let Ok(conn) = cache_state.lock() {
            preview_cache::set(&conn, &path, mtime, size, &bytes);
        }

        Ok(preview::jpeg_bytes_to_data_url(&bytes))
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// How much of a mail's body the tile preview asks for. Enough to fill the
/// preview panel's text block several times over, so the panel decides what
/// fits rather than this cap deciding it — but bounded, since a mail body
/// can be arbitrarily long and this crosses the IPC boundary.
const EMAIL_PREVIEW_CHARS: usize = 2000;

/// Subject, sender and send date of mails not necessarily part of the stream
/// yet, keyed by path — for the preview panel and the drop box. A mail that
/// can't be parsed is left out, and the caller falls back to the file details.
#[tauri::command]
pub async fn get_email_headers(paths: Vec<String>) -> Result<HashMap<String, crate::email::EmailMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter_map(|path| {
                let meta = crate::safe_io::catch_panic(|| crate::email::parse_meta(Path::new(&path))).ok()?;
                Some((path, meta))
            })
            .collect()
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))
}

/// The opening text of an `.msg`/`.eml` file, for the tile preview.
///
/// Mail is the one addable kind with real content but no renderable
/// thumbnail (see `get_file_preview`'s Email arm), so the grid used to show
/// nothing but a ✉ and a filename — and `.msg` filenames are routinely
/// meaningless. This hands the panel the first few lines of the body
/// instead.
///
/// No new parsing: `email::extract_plain_text` already handles both
/// formats, including the RTF fallback that gives appointment `.msg` files
/// (which carry no plain-text part) a readable body. Path-based rather than
/// item-based on purpose, so the same command serves a file being browsed
/// before import and an item's stored copy in "Datei-Operationen".
///
/// `Ok(None)` for a mail whose body is empty — the panel then keeps its
/// icon rather than showing an empty text block.
#[tauri::command]
pub async fn get_email_text_preview(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = crate::email::extract_plain_text(Path::new(&path))?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(trimmed.chars().take(EMAIL_PREVIEW_CHARS).collect()))
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// How much of a document's text the tile preview asks for — same budget
/// as `get_email_text_preview`, for the same reason: enough to fill the
/// preview panel several times over, bounded because the file can be
/// arbitrarily long.
const DOCUMENT_PREVIEW_CHARS: usize = 2000;

/// The start of a .txt/.docx/.odt/.rtf file's text, for the tile preview.
///
/// These are the document kinds with real content but no renderable
/// thumbnail (see `get_file_preview`'s Document arm, which only renders
/// `.pdf` and `.doc`) — the grid used to show nothing but a 📄 and a
/// filename. `doc_text::extract_text` already does the parsing (it's what
/// import uses to fill `items.extracted_text`); this just calls it on a
/// file that may not be imported yet. Path-based for the same reason
/// `get_email_text_preview` is: the same command serves a file being
/// browsed before import and an item's stored copy in
/// "Datei-Operationen"/"Papierkorb".
///
/// `.pdf` and `.doc` aren't handled here — they already get an image
/// preview, which stays primary for them. Spreadsheets (csv/xls/xlsx) have
/// no extracted text at all (see `doc_text::extract_text`) and keep their
/// icon, same as before.
///
/// `Ok(None)` for an unsupported extension or empty text — the panel then
/// keeps its icon rather than showing an empty text block.
#[tauri::command]
pub async fn get_document_text_preview(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = match crate::doc_text::extract_text(Path::new(&path)) {
            Ok(text) => text,
            Err(_) => return Ok(None),
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(trimmed.chars().take(DOCUMENT_PREVIEW_CHARS).collect()))
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[derive(Serialize)]
pub struct SkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct AddItemsResult {
    pub added: Vec<AddedItem>,
    pub skipped: Vec<SkippedItem>,
    /// Groups among `added` that collide with each other or with an
    /// existing item by `quick_hash` — empty unless "Beim Einfügen auf
    /// Duplikate prüfen" is on. See `duplicate_hash::duplicates_among`.
    pub duplicates: Vec<DuplicateGroup>,
}

#[tauri::command]
pub async fn add_items(app: AppHandle, paths: Vec<String>) -> Result<AddItemsResult, String> {
    // Copying originals and generating thumbnails (image resize / ffmpeg /
    // PDFium) per file is real I/O + CPU work — spawn the whole batch off
    // the async/IPC thread, same reasoning as get_file_preview. Re-fetches
    // state by AppHandle inside the closure since a tauri::State borrow
    // can't cross into a 'static spawn_blocking closure.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();

        let batch_id = if paths.len() > 1 {
            Some(uuid::Uuid::new_v4().to_string())
        } else {
            None
        };

        let mut skipped = Vec::new();

        // Only this read phase and the final inserts hold the state lock —
        // the copying in between can take minutes for a big batch, and
        // holding the lock through it would stall every other command
        // (search, notes, the drop box) until the import is done.
        let (project_path, default_percent, quick_hash_decisions, to_prepare) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

            // Duplicate check is a cheap DB lookup — do it up front, single-
            // threaded, so we never waste parallel decode work on a file
            // that's getting skipped anyway.
            let mut to_prepare = Vec::new();
            for path in paths {
                if items::source_already_added(&current.conn, &path) {
                    skipped.push(SkippedItem { path, reason: crate::i18n::tr(ALREADY_ADDED_REASON).to_string() });
                } else {
                    to_prepare.push(path);
                }
            }
            (
                current.path.clone(),
                items::default_video_frame_percent(&current.conn),
                items::quick_hash_decisions(&current.conn, &to_prepare),
                to_prepare,
            )
        };

        // The expensive part — copying + decoding/resizing each file into
        // a thumbnail — has no shared mutable state and can run on several
        // files at once. Only the final DB insert needs the (non-Sync)
        // connection, so that stays single-threaded, after this.
        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(to_prepare.len().max(1));

        let mut chunks: Vec<Vec<String>> = vec![Vec::new(); worker_count.max(1)];
        for (i, path) in to_prepare.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(path);
        }

        let progress_total = chunks.iter().map(|c| c.len()).sum();
        let progress_done = AtomicUsize::new(0);
        let quick_hash_decisions = &quick_hash_decisions;
        let prepared_results: Vec<(String, Result<items::PreparedItem, String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let project_path = &project_path;
                    let progress_done = &progress_done;
                    let app = &app;
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .map(|path| {
                                let compute_quick_hash = quick_hash_decisions.get(&path).copied().unwrap_or(false);
                                let result =
                                    items::prepare_item(project_path, Path::new(&path), default_percent, None, compute_quick_hash);
                                let done = progress_done.fetch_add(1, Ordering::SeqCst) + 1;
                                let file_name = Path::new(&path)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| path.clone());
                                let _ = app.emit(
                                    ADD_ITEMS_PROGRESS_EVENT,
                                    AddItemsProgress { done, total: progress_total, current: file_name },
                                );
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

pub(crate) const ALREADY_ADDED_REASON: &str = "Diese Datei ist bereits im Stream vorhanden.";

/// The DB half of an import, shared by `add_items` and
/// `add_items_with_dates`: runs after their lock-free prepare phase and
/// takes the state lock only for the inserts, all in one transaction (one
/// disk sync instead of one per file). The "already in the project" check
/// runs again here because another import may have added the same file
/// while this one was still copying. Copies that end up not committed are
/// removed again rather than left as orphans in `originals/`.
pub(crate) fn commit_prepared_batch(
    state: &AppStateHandle,
    project_path: &Path,
    prepared_results: Vec<(String, Result<items::PreparedItem, String>)>,
    batch_id: Option<&str>,
    mut skipped: Vec<SkippedItem>,
) -> Result<AddItemsResult, String> {
    let guard = match crate::state::lock_project(state, project_path) {
        Ok(guard) => guard,
        Err(e) => {
            for (_, result) in prepared_results {
                if let Ok(prepared) = result {
                    items::remove_stored_files(&prepared.stored_files());
                }
            }
            return Err(e);
        }
    };
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let rotations = load_path_rotations(&tx);
    let mut added = Vec::new();
    let mut committed_files = Vec::new();
    for (path, result) in prepared_results {
        let prepared = match result {
            Ok(prepared) => prepared,
            Err(reason) => {
                skipped.push(SkippedItem { path, reason });
                continue;
            }
        };
        let files = prepared.stored_files();
        if items::source_already_added(&tx, &path) {
            items::remove_stored_files(&files);
            skipped.push(SkippedItem { path, reason: crate::i18n::tr(ALREADY_ADDED_REASON).to_string() });
            continue;
        }
        let rotation = rotations.get(&path).copied().unwrap_or(0);
        match items::commit_prepared_item(&tx, prepared, batch_id, rotation) {
            Ok(item) => {
                // The override has done its job — it now lives on the
                // item's own `rotation` column.
                let _ = tx.execute("DELETE FROM path_rotations WHERE path = ?1", params![path]);
                committed_files.extend(files);
                added.push(item);
            }
            Err(reason) => {
                items::remove_stored_files(&files);
                skipped.push(SkippedItem { path, reason });
            }
        }
    }

    let duplicates = if items::quick_hash_on_ingest_enabled(&tx) {
        duplicate_hash::duplicates_among(&tx, &added.iter().map(|a| a.id.clone()).collect::<Vec<_>>())
    } else {
        Vec::new()
    };

    log_import(&tx, &added);
    if let Err(e) = tx.commit() {
        items::remove_stored_files(&committed_files);
        return Err(crate::trf!("Konnte Import nicht speichern: {e}", e = e));
    }
    Ok(AddItemsResult { added, skipped, duplicates })
}

/// Records a finished import as one action, so a 147-file batch is one node
/// in the log ("147 Bilder eingefügt") that can be undone as a whole or
/// per file. Files that were skipped are deliberately not logged: nothing
/// happened to them, so there is nothing to undo.
pub(crate) fn log_import(conn: &rusqlite::Connection, added: &[AddedItem]) {
    if added.is_empty() {
        return;
    }
    let entries: Vec<action_log::LogEntry> = added
        .iter()
        .map(|item| action_log::LogEntry::presence(&item.id, &item.original_filename))
        .collect();
    let _ = action_log::record(conn, action_log::ActionType::Import, &entries);
}

/// Rotates a file shown in the browser by `delta` degrees (±90/180),
/// wrapping into 0/90/180/270. The timeline is the source of truth once a
/// file is imported: if `path` already matches an item's `source_path`,
/// this updates that item's own `rotation` column directly (same effect as
/// `rotate_item`) so the timeline and the browser never disagree about a
/// file's rotation. Only for a not-yet-imported file is the value kept in
/// `path_rotations` (keyed by absolute path) until the file is actually
/// added to the project, at which point it becomes the new item's
/// `rotation` column and this override is dropped (see
/// `add_items`/`add_items_with_dates`).
#[tauri::command(async)]
pub fn rotate_path(state: State<AppStateHandle>, path: String, delta: i32) -> Result<i32, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let imported_item: Option<(String, i32)> = current
        .conn
        .query_row(
            "SELECT id, rotation FROM items WHERE source_path = ?1 AND removed_at IS NULL",
            params![path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((item_id, existing)) = imported_item {
        let new_rotation = (((existing + delta) % 360) + 360) % 360;
        current
            .conn
            .execute("UPDATE items SET rotation = ?1 WHERE id = ?2", params![new_rotation, item_id])
            .map_err(|e| crate::trf!("Konnte Drehung nicht speichern: {e}", e = e))?;
        return Ok(new_rotation);
    }

    let existing: i32 = current
        .conn
        .query_row("SELECT rotation FROM path_rotations WHERE path = ?1", params![path], |row| row.get(0))
        .unwrap_or(0);
    let new_rotation = (((existing + delta) % 360) + 360) % 360;

    if new_rotation == 0 {
        current
            .conn
            .execute("DELETE FROM path_rotations WHERE path = ?1", params![path])
            .map_err(|e| crate::trf!("Konnte Drehung nicht speichern: {e}", e = e))?;
    } else {
        current
            .conn
            .execute(
                "INSERT INTO path_rotations (path, rotation) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET rotation = excluded.rotation",
                params![path, new_rotation],
            )
            .map_err(|e| crate::trf!("Konnte Drehung nicht speichern: {e}", e = e))?;
    }

    Ok(new_rotation)
}

#[tauri::command(async)]
pub fn list_added_source_paths(state: State<AppStateHandle>) -> Result<Vec<String>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    items::list_added_source_paths(&current.conn)
}

/// Where a file can be shown in the system file manager: its copy inside
/// the stream folder and the original it was imported from.
#[derive(Serialize)]
pub struct RevealTargets {
    /// `None` when the file is not (or no longer) part of the stream.
    pub stored_path: Option<String>,
    pub source_path: Option<String>,
    /// Whether the source file is still there — the source folder may
    /// have been moved, renamed or sit on a disconnected drive.
    pub source_exists: bool,
}

/// Looks up an item by its stream id, or by a path that is either its
/// stored copy or its source file.
#[tauri::command(async)]
pub fn get_reveal_targets(
    state: State<AppStateHandle>,
    id: Option<String>,
    path: Option<String>,
) -> Result<RevealTargets, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let row: Option<(String, Option<String>)> = if let Some(id) = id {
        current
            .conn
            .query_row("SELECT stored_path, source_path FROM items WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok()
    } else if let Some(path) = path {
        current
            .conn
            .query_row(
                "SELECT stored_path, source_path FROM items
                 WHERE (source_path = ?1 OR stored_path = ?1) AND removed_at IS NULL LIMIT 1",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    } else {
        None
    };
    let Some((stored_path, source_path)) = row else {
        return Ok(RevealTargets { stored_path: None, source_path: None, source_exists: false });
    };
    let source_exists = source_path.as_deref().is_some_and(|p| Path::new(p).exists());
    Ok(RevealTargets { stored_path: Some(stored_path), source_path, source_exists })
}

/// A dropped file that looks like something already in the project —
/// surfaced in the pending-drops review so the user can glance at both
/// before deciding to skip it, rather than a drop silently vanishing on
/// `add_items`'s own exact-path dedupe.
#[derive(Serialize, Clone)]
pub struct DuplicateMatch {
    pub existing_item_id: String,
    pub existing_thumbnail_path: Option<String>,
    pub existing_display_name: String,
    pub existing_resolved_timestamp: String,
}

/// Same filename (case-insensitive) and exact file size as something
/// already in the project is the base signal for every kind — enough on
/// its own for images/video, since the comparison view lets the user just
/// look at both thumbnails. Audio and documents have no equivalent quick
/// visual check, so those additionally need a matching `quick_hash` before
/// being surfaced as a match at all.
///
/// `async` + `spawn_blocking`: runs automatically on every drop, before the
/// user has done anything that would justify a progress bar, but still
/// real per-file I/O (a `stat` plus, for audio/documents, hashing both
/// sides) that must not sit on the IPC thread for a large drop.
#[tauri::command]
pub async fn check_pending_duplicates(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<HashMap<String, DuplicateMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();

        // The state lock is taken per file and only around the DB lookup —
        // the file metadata reads and the quick-hash confirmations run
        // without it, so a long drop list doesn't stall other commands.
        let mut out = HashMap::new();
        for path in paths {
            let path_buf = Path::new(&path);
            let Some(file_name) = path_buf.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            let Ok(metadata) = std::fs::metadata(path_buf) else { continue };
            let size = metadata.len() as i64;

            let candidates = {
                let guard = state.lock().map_err(|e| e.to_string())?;
                let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
                let mut stmt = current
                    .conn
                    .prepare(
                        "SELECT id, thumbnail_path, display_name, original_filename, resolved_timestamp, stored_path, file_type
                         FROM items
                         WHERE removed_at IS NULL AND file_size_bytes = ?1 AND original_filename = ?2 COLLATE NOCASE",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![size, file_name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .collect::<Vec<_>>();
                rows
            };

            for (id, thumbnail_path, display_name, original_filename, resolved_timestamp, stored_path, file_type) in candidates {
                if file_type == "audio" || file_type == "document" {
                    let confirmed = crate::duplicate_hash::quick_hash(path_buf)
                        .ok()
                        .zip(crate::duplicate_hash::quick_hash(Path::new(&stored_path)).ok())
                        .is_some_and(|(a, b)| a == b);
                    if !confirmed {
                        continue;
                    }
                }
                out.insert(
                    path.clone(),
                    DuplicateMatch {
                        existing_item_id: id,
                        existing_thumbnail_path: thumbnail_path,
                        existing_display_name: display_name.unwrap_or(original_filename),
                        existing_resolved_timestamp: resolved_timestamp,
                    },
                );
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Total number of items currently on the timeline — used for the
/// pending-drops panel's closing summary ("N added, M in the project now").
#[tauri::command(async)]
pub fn count_live_items(state: State<AppStateHandle>) -> Result<i64, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    current
        .conn
        .query_row(
            &format!("SELECT COUNT(*) FROM items WHERE {}", crate::schema::LIVE_ITEMS),
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

/// Total size on disk of the whole open project folder (originals,
/// thumbnails and the database itself) — same `folder_size` walk the
/// "delete this stream" confirmation dialog uses, just against the
/// already-open project rather than an arbitrary path.
#[tauri::command(async)]
pub fn project_disk_usage(state: State<AppStateHandle>) -> Result<u64, String> {
    // The walk itself can take a moment on a large project — the lock is
    // only held long enough to copy the path, not for the whole duration,
    // so it doesn't stall every other command that needs AppStateHandle.
    let path = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        current.path.clone()
    };
    Ok(crate::delete_commands::folder_size(&path))
}

/// Shows a file in the system file manager. Own command instead of the
/// opener plugin's: in the AppImage that call returned without effect or
/// error, and the AppImage's `LD_LIBRARY_PATH` must not leak into the
/// file manager we start.
#[tauri::command(async)]
pub fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let result = reveal_path(&p);
    if let Err(e) = &result {
        crate::debug_log::append(&app, &format!("reveal_in_folder {}: {e}", p.display()));
    }
    result
}

#[cfg(target_os = "linux")]
fn reveal_path(p: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    fn clean(cmd: &mut Command) -> &mut Command {
        for var in ["LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "GDK_PIXBUF_MODULE_FILE", "APPDIR", "APPIMAGE"] {
            cmd.env_remove(var);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
    }
    // Fully percent-encoded, so nothing in the name — an apostrophe in
    // "Mama's Foto.jpg" in particular — can end the quoted GVariant string.
    let uri = file_uri(p);
    let shown = clean(Command::new("gdbus").args([
        "call", "--session", "--dest", "org.freedesktop.FileManager1",
        "--object-path", "/org/freedesktop/FileManager1",
        "--method", "org.freedesktop.FileManager1.ShowItems",
    ]).arg(format!("['{uri}']")).arg(""))
    .status();
    if matches!(shown, Ok(s) if s.success()) {
        return Ok(());
    }
    let dir = p.parent().unwrap_or(p);
    clean(&mut Command::new("xdg-open").arg(dir)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// `file://` URI of an absolute path with every byte percent-encoded except
/// the unreserved characters and `/`. Works on the raw bytes, so a file name
/// that is not valid UTF-8 still names the right file.
#[cfg(target_os = "linux")]
fn file_uri(p: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut uri = String::from("file://");
    for &byte in p.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

#[cfg(not(target_os = "linux"))]
fn reveal_path(p: &Path) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// Extensions that run code when handed to the system's default handler
/// (Windows, macOS and Linux desktops). Files without one are still caught
/// by `has_executable_magic`.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "hta", "lnk", "url", "reg", "jar", "appref-ms", "sh", "bash", "zsh", "csh", "ksh", "fish",
    "run", "desktop", "appimage", "app", "command", "tool", "py", "pyw", "pl", "rb", "scpt", "applescript",
    "action", "workflow",
];

/// Opens a file with its default application. Own command instead of the
/// opener plugin's `openPath`, which the webview may no longer call: a
/// program or script opened that way runs, and the path can come from a
/// foreign e-mail attachment. Those ask first, in a dialog raised from
/// here, so a compromised webview can't skip the question. Returns whether
/// the file was opened.
#[tauri::command(async)]
pub fn open_path_checked(window: tauri::WebviewWindow, path: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    // Canonical first, so a harmless-looking symlink to a script is judged
    // by the file that would actually be opened.
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if looks_executable(&p) {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let confirmed = window
            .dialog()
            .message(
                crate::i18n::tr("„{name}“ ist ein Programm oder Skript und wird beim Öffnen ausgeführt. Trotzdem öffnen?")
                    .replace("{name}", &name),
            )
            .title(crate::i18n::tr("Programm öffnen?"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                crate::i18n::tr("Öffnen").to_string(),
                crate::i18n::tr("Abbrechen").to_string(),
            ))
            .parent(&window)
            .blocking_show();
        if !confirmed {
            return Ok(false);
        }
    }
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())?;
    Ok(true)
}

fn looks_executable(p: &Path) -> bool {
    if p.is_dir() {
        return false;
    }
    let by_extension = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXECUTABLE_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)));
    by_extension || has_executable_magic(p)
}

/// Native binaries (PE, ELF, Mach-O) and scripts with a shebang, whatever
/// they are named. Not the Unix executable bit: on the NTFS/exFAT drives
/// photos usually live on, every file has it.
fn has_executable_magic(p: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    let Ok(mut file) = std::fs::File::open(p) else {
        return false;
    };
    let n = file.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    const MACH_O: [[u8; 4]; 5] = [
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
    ];
    head.starts_with(b"#!") || head.starts_with(b"MZ") || head.starts_with(b"\x7fELF") || MACH_O.iter().any(|m| head == m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn a_file_uri_carries_no_quote_or_backslash() {
        let uri = file_uri(Path::new("/home/a/Mama's Foto\\ä #1.jpg"));
        assert_eq!(uri, "file:///home/a/Mama%27s%20Foto%5C%C3%A4%20%231.jpg");
    }

    #[test]
    fn looks_executable_by_extension_and_content() {
        let dir = std::env::temp_dir().join(format!("cronostream-open-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cases: [(&str, &[u8], bool); 6] = [
            ("foto.JPG", b"\xff\xd8\xff\xe0", false),
            ("brief.pdf", b"%PDF-1.7", false),
            ("anhang.EXE", b"MZ\x90\x00", true),
            ("rechnung.pdf.lnk", b"L\x00\x00\x00", true),
            ("ohne-endung", b"#!/bin/sh\n", true),
            ("elf", b"\x7fELF", true),
        ];
        for (name, content, expected) in cases {
            let path = dir.join(name);
            std::fs::write(&path, content).unwrap();
            assert_eq!(looks_executable(&path), expected, "{name}");
        }
        assert!(!looks_executable(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
