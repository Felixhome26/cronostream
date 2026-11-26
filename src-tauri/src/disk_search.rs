use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

use crate::disk_search_index::{self, DiskSearchIndexHandle, IndexedEntry};
use crate::duplicate_hash::{self, DiskSearchDuplicate};
use crate::fsbrowse::{self, FileKind, MAX_WALK_ENTRIES as MAX_INDEX_ENTRIES};
use crate::state::AppStateHandle;

const PROGRESS_EVENT: &str = "disk-search-progress";
const DONE_EVENT: &str = "disk-search-done";
const EMIT_INTERVAL_MS: u128 = 150;

/// Registry of in-flight disk searches, keyed by task id — same
/// register/cancel/unregister shape as `copy_task::CopyTasks`, so
/// `cancel_disk_search` can signal a running background walk.
#[derive(Default)]
pub struct DiskSearchTasks(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DiskSearchTasks {
    fn register(&self, task_id: String) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(task_id, flag.clone());
        flag
    }

    fn unregister(&self, task_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(task_id);
        }
    }

    /// Stops every running search — on app exit.
    pub fn cancel_all(&self) {
        if let Ok(map) = self.0.lock() {
            map.values().for_each(|flag| flag.store(true, Ordering::SeqCst));
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DateField {
    Created,
    Modified,
}

/// The two actions behind the "Index" controls in the search UI. There is
/// deliberately no third "always walk fresh, never touch the cache" mode —
/// every search either reads the cached index (building it transparently
/// the first time, see `get_or_build_index`) or explicitly rebuilds it.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndexMode {
    /// "Neu indizieren" — always walks the disk and overwrites the cached
    /// index for this root.
    Reindex,
    /// "Schnell aus Cache laden" — serves the existing cached index for
    /// this root without touching the disk at all.
    UseCache,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskSearchParams {
    pub root_path: String,
    pub include_subfolders: bool,
    /// Empty/absent = every kind matches.
    #[serde(default)]
    pub kinds: Vec<FileKind>,
    /// Optional filename filter — case-insensitive substring match against
    /// the file name (not the full path). `None`/empty = every name
    /// matches, i.e. just "show everything of the selected kinds".
    #[serde(default)]
    pub name_contains: Option<String>,
    pub date_field: DateField,
    /// Inclusive, "YYYY-MM-DD" — compared against the file's UTC calendar
    /// day (same filesystem timestamps `fsbrowse::list_dir` already reports
    /// in UTC), not an exact instant.
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    /// The "Duplikate ausblenden" toggle: collapses hits that are the same
    /// *content* found at more than one path within this very search (e.g.
    /// the same photo sitting in two different subfolders) down to a
    /// single representative. Has nothing to do with the project — a
    /// search hit that merely happens to already be in the project is a
    /// separate concern, see `hide_already_in_project` below. Off = no
    /// comparison runs at all, every path found is kept and offered.
    #[serde(default)]
    pub dedupe_within_results: bool,
    /// The "Bereits im Projekt enthaltene Dateien ausblenden" toggle: off
    /// skips the whole project comparison (no size/hash check against the
    /// project runs at all, every hit's `duplicate` stays `None`); on runs
    /// it and hits whose *content* matches something already in the
    /// project (even under a different path/name) are hidden from the
    /// results entirely — see `search_disk`.
    #[serde(default)]
    pub hide_already_in_project: bool,
    /// Shared by both toggles above, only consulted when at least one of
    /// them is on — the "Inhaltsprüfung" toggle: false = "schnell" (size +
    /// `quick_hash` only), true = "gründlich" (also confirms with a full
    /// `blake3` content hash). See `duplicate_hash::find_duplicate`.
    #[serde(default)]
    pub verify_duplicate_content: bool,
    pub index_mode: IndexMode,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiskSearchHit {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    /// Filled in after the walk, once there is an open project to compare
    /// against (see `search_disk`) — `None` during the walk itself, and
    /// still `None` afterward if nothing in the project matches.
    #[serde(default)]
    pub duplicate: Option<DiskSearchDuplicate>,
}

/// Which step a progress event belongs to — each has its own total/ETA,
/// since "files matching the filters", "hits to compare against each
/// other" and "hits to compare against the project" are unrelated counts.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SearchPhase {
    /// The cheap pre-count (`count_entries`) that `get_or_build_index` runs
    /// before the real walk, just to know the cap and the real walk's
    /// `total` — has no `total` of its own (that's exactly what it's
    /// finding out), so the UI shows a running count instead of a percent.
    Counting,
    Scanning,
    DedupingResults,
    CheckingAgainstProject,
}

#[derive(Serialize, Clone)]
struct DiskSearchProgress {
    task_id: String,
    phase: SearchPhase,
    done: usize,
    total: usize,
    /// Human-readable description of what's happening right now (the file
    /// currently being looked at), so the UI can show more than a bare
    /// percentage while a long search/hash run is in progress.
    current_action: String,
    estimated_seconds_remaining: Option<f64>,
}

#[derive(Serialize, Clone)]
struct DiskSearchDone {
    task_id: String,
    hits: Vec<DiskSearchHit>,
    cancelled: bool,
    error: Option<String>,
    /// How many hits were removed as duplicates of another hit in this
    /// same search (see `dedupe_within_results`) — they're taken out of
    /// `hits` entirely, so this is the only way to still say how many.
    within_results_duplicates_removed: usize,
    /// How many (already-deduped) hits were removed because their content
    /// matched something already in the project (see
    /// `hide_already_in_project`) — same reasoning.
    already_in_project_hidden: usize,
}

/// Elapsed-time-based ETA: `done`/`elapsed` gives a rate, which projects
/// the remaining `total - done` items forward. Deliberately simple (no
/// smoothing/averaging) — good enough for a progress bar, and self-
/// correcting every time it's recomputed as the real rate becomes clearer.
fn estimate_remaining_seconds(started: Instant, done: usize, total: usize) -> Option<f64> {
    if done == 0 || total == 0 || done >= total {
        return None;
    }
    let elapsed = started.elapsed().as_secs_f64();
    let rate = done as f64 / elapsed.max(0.001);
    Some(((total - done) as f64 / rate).max(0.0))
}

fn parse_date_bound(s: &Option<String>) -> Option<NaiveDate> {
    s.as_deref().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
}

fn system_time_to_epoch_secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    let t = t.ok()?;
    let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(duration.as_secs() as i64)
}

fn epoch_to_date(secs: Option<i64>) -> Option<NaiveDate> {
    secs.and_then(|s| chrono::DateTime::<chrono::Utc>::from_timestamp(s, 0)).map(|dt| dt.date_naive())
}

fn epoch_to_rfc3339(secs: Option<i64>) -> Option<String> {
    secs.and_then(|s| chrono::DateTime::<chrono::Utc>::from_timestamp(s, 0)).map(|dt| dt.to_rfc3339())
}

/// Hard ceiling on how many files a single index build will walk. Not a
/// tuning knob for performance — a safety backstop: a root picked via the
/// folder tree can be an entire drive (the tree's "Laufwerke" shortcuts are
/// real mount points, see `quick_access.rs`), and an unbounded recursive
/// `WalkDir` plus a per-file `metadata()` call over such a root, on a
/// large/NTFS-via-FUSE drive in particular, can realistically take the
/// whole system down under sustained I/O + memory pressure rather than
/// just "take a while". Refusing past this count is cheap insurance against
/// exactly that, confirmed the hard way (2026-10-13: a test run froze the
/// machine and left the NTFS `$MFT`/`$MFTMirr` out of sync after the
/// forced reset). 200k is generous for a genuine personal photo/video
/// archive while still refusing an accidental whole-drive scan outright.
/// Shared with the grid view's own recursive walk (`fsbrowse::list_dir_recursive`)
/// so both unbounded-walk entry points stay governed by one cap — see the
/// `MAX_WALK_ENTRIES` import at the top of this file.

/// Cheap pre-count of how many files `build_full_index` would visit, capped
/// at `MAX_INDEX_ENTRIES + 1` — stops walking the instant the cap is
/// exceeded rather than finishing an unbounded count first, so a huge root
/// is rejected quickly instead of after a long, heavy scan. Only looks at
/// directory-entry types (no per-file stat, classification or filtering)
/// below the cap, so it stays proportionally cheap to the real walk.
/// `.same_file_system(true)` additionally stops the walk from ever
/// wandering into a *different* mounted filesystem than the one `root`
/// itself is on, in case `root` sits above more than one mount.
///
/// `on_progress(found_so_far, current_name)` is throttled the same way as
/// `build_full_index`'s own callback — this walk has no `total` to report
/// (finding it out is the point), only a running count, so the UI shows
/// that instead of a percentage while this runs.
fn count_entries(root: &Path, on_progress: impl FnMut(usize, &str)) -> usize {
    count_entries_capped(root, MAX_INDEX_ENTRIES, on_progress)
}

/// `count_entries`' actual implementation, with the cap as a parameter so
/// the "stops early once exceeded" behavior is testable without having to
/// create hundreds of thousands of real files.
fn count_entries_capped(root: &Path, cap: usize, mut on_progress: impl FnMut(usize, &str)) -> usize {
    let mut found = 0usize;
    let mut last_emit = Instant::now();
    WalkDir::new(root)
        .min_depth(1)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            !e.file_name()
                .to_str()
                .map(|n| n.starts_with('.'))
                .unwrap_or(false)
        })
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_type().is_dir())
        .inspect(|e| {
            found += 1;
            if last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS {
                on_progress(found, &e.file_name().to_string_lossy());
                last_emit = Instant::now();
            }
        })
        .take(cap + 1)
        .count()
}

/// Pure kind/size/date check, shared by every place that decides whether a
/// file matches the current search — keeps the live walk and the cached-
/// index path from being able to silently drift apart on what counts as a
/// match. `include_subfolders` is deliberately not part of this: it's
/// applied separately in `filter_indexed_entries`, since the cached index
/// always covers the whole subtree regardless of that setting.
fn passes_value_filters(
    params: &DiskSearchParams,
    name: &str,
    kind: FileKind,
    size: u64,
    created: Option<NaiveDate>,
    modified: Option<NaiveDate>,
) -> bool {
    if !params.kinds.is_empty() && !params.kinds.contains(&kind) {
        return false;
    }
    // Case-insensitive, Unicode-aware (`to_lowercase()`, not an ASCII-only
    // fold) so e.g. a German "müller" still matches "Müller" — same
    // reasoning as the timeline's own `search_items`.
    if let Some(needle) = params.name_contains.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        if !name.to_lowercase().contains(&needle.to_lowercase()) {
            return false;
        }
    }
    if params.size_min.is_some_and(|min| size < min) {
        return false;
    }
    if params.size_max.is_some_and(|max| size > max) {
        return false;
    }

    let date_from = parse_date_bound(&params.date_from);
    let date_to = parse_date_bound(&params.date_to);
    if date_from.is_none() && date_to.is_none() {
        return true;
    }
    let relevant = match params.date_field {
        DateField::Created => created,
        DateField::Modified => modified,
    };
    match relevant {
        Some(d) => !(date_from.is_some_and(|from| d < from) || date_to.is_some_and(|to| d > to)),
        // No reliable timestamp to compare — excluded rather than guessed
        // at, once the user has actually set a date filter.
        None => false,
    }
}

/// Full recursive inventory of every non-hidden file under `root` —
/// deliberately filter-free and always recursive, regardless of
/// `include_subfolders` (which only matters once *reading* an index, see
/// `filter_indexed_entries`) — so the cached result stays reusable for any
/// future filter combination on this root without walking the disk again.
/// `on_progress(done, total, current_action)` is throttled, not per entry.
fn build_full_index(
    root: &Path,
    cancel: &AtomicBool,
    total_estimate: usize,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<Vec<IndexedEntry>, String> {
    if !root.is_dir() {
        return Err(crate::i18n::tr("Dieser Ordner existiert nicht (mehr).").to_string());
    }

    let mut entries = Vec::new();
    let mut scanned = 0usize;
    let mut last_emit = Instant::now();
    for entry in WalkDir::new(root).min_depth(1).same_file_system(true).into_iter().filter_entry(|e| {
        !e.file_name()
            .to_str()
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
    }) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_dir() {
            continue;
        }
        scanned += 1;
        if last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS {
            let current_action = entry.file_name().to_string_lossy().to_string();
            on_progress(scanned, total_estimate.max(scanned), &current_action);
            last_emit = Instant::now();
        }
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else { continue };

        entries.push(IndexedEntry {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            kind: fsbrowse::classify(path),
            size: metadata.len(),
            created_secs: system_time_to_epoch_secs(metadata.created()),
            modified_secs: system_time_to_epoch_secs(metadata.modified()),
        });
    }

    Ok(entries)
}

/// Applies the search's filters (kind/size/date, plus `include_subfolders`
/// — restricting to `root`'s direct children when it's off) against an
/// already-built index, turning each surviving `IndexedEntry` into a
/// `DiskSearchHit`.
fn filter_indexed_entries(root: &Path, entries: &[IndexedEntry], params: &DiskSearchParams) -> Vec<DiskSearchHit> {
    entries
        .iter()
        .filter(|e| {
            if !params.include_subfolders && Path::new(&e.path).parent() != Some(root) {
                return false;
            }
            passes_value_filters(params, &e.name, e.kind, e.size, epoch_to_date(e.created_secs), epoch_to_date(e.modified_secs))
        })
        .map(|e| DiskSearchHit {
            path: e.path.clone(),
            name: e.name.clone(),
            kind: e.kind,
            size: e.size,
            fs_created_at: epoch_to_rfc3339(e.created_secs),
            fs_modified_at: epoch_to_rfc3339(e.modified_secs),
            duplicate: None,
        })
        .collect()
}

/// Collapses hits that are the same file *content* found at more than one
/// path within this search's own results (e.g. the same photo sitting in
/// two different subfolders) down to a single representative — the first
/// one encountered in `hits`' order, so the kept copy is at least
/// predictable. Independent of the project entirely: compares hits only
/// against each other, never touches `items`.
///
/// Only ever compares within same-size groups (content-identical files are
/// always size-identical), with `quick_hash` as the first real comparison
/// and an optional full `blake3` read behind it for "gründlich" — the same
/// cheap-to-expensive cascade `duplicate_hash::find_duplicate` uses against
/// the project, just pointed at the result set instead.
fn dedupe_within_results(
    hits: Vec<DiskSearchHit>,
    verify_content: bool,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Vec<DiskSearchHit> {
    let total = hits.len();
    // size -> (quick_hash, index into `kept`) for every representative
    // already kept under that size.
    let mut seen_by_size: HashMap<u64, Vec<(u64, usize)>> = HashMap::new();
    let mut kept: Vec<DiskSearchHit> = Vec::new();
    let mut last_emit = Instant::now();

    for (i, hit) in hits.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let done = i + 1;
        if last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS || done == total {
            on_progress(done, total, &hit.name);
            last_emit = Instant::now();
        }

        let quick = duplicate_hash::quick_hash(Path::new(&hit.path)).ok();
        let same_size = seen_by_size.entry(hit.size).or_default();
        let is_duplicate = quick.is_some_and(|qh| {
            same_size.iter().any(|&(existing_qh, idx)| {
                if existing_qh != qh {
                    return false;
                }
                if !verify_content {
                    return true;
                }
                let a = duplicate_hash::blake3_hash(Path::new(&hit.path)).ok();
                let b = duplicate_hash::blake3_hash(Path::new(&kept[idx].path)).ok();
                a.is_some() && a == b
            })
        });

        if is_duplicate {
            continue;
        }
        if let Some(qh) = quick {
            same_size.push((qh, kept.len()));
        }
        kept.push(hit);
    }

    kept
}

/// Resolves `params.root_path` to a usable index: serves the cached one
/// when `index_mode` is `UseCache` and a cache already exists for this
/// root; otherwise (an explicit `Reindex`, or a first-ever "Schnell aus
/// Cache laden" with nothing cached yet — handled transparently rather
/// than coming back empty, per this app's zero-technical-knowledge design
/// standard) walks the disk and replaces the cached entries for this root.
/// A cancelled walk still returns its partial results (so the caller can
/// show them) but is never written to the cache — a half-finished index
/// must not look like a complete one to a later "schnell aus Cache laden".
fn get_or_build_index(
    app: &AppHandle,
    params: &DiskSearchParams,
    cancel: &AtomicBool,
    mut on_scan_progress: impl FnMut(usize, usize, &str),
) -> Result<Vec<IndexedEntry>, String> {
    let root = Path::new(&params.root_path);
    if !root.is_dir() {
        return Err(crate::i18n::tr("Dieser Ordner existiert nicht (mehr).").to_string());
    }
    let root_key = root.to_string_lossy().to_string();

    if params.index_mode == IndexMode::UseCache {
        let cached = {
            let state = app.state::<DiskSearchIndexHandle>();
            let guard = state.0.lock().map_err(|e| e.to_string())?;
            if disk_search_index::has_root(&guard, &root_key) {
                Some(disk_search_index::load_root(&guard, &root_key)?)
            } else {
                None
            }
        };
        if let Some(entries) = cached {
            return Ok(entries);
        }
    }

    // `total` is unknown while this runs — that's exactly what it's
    // finding out — so it's passed through as 0, which the caller (see
    // `search_disk`) reads as "still counting" rather than "0 of 0 done".
    let total = count_entries(root, |found, current_name| on_scan_progress(found, 0, current_name));
    if total > MAX_INDEX_ENTRIES {
        return Err(crate::trf!(
            "Dieser Ordner enthält mehr als {MAX_INDEX_ENTRIES} Dateien — das ist zu groß, um ihn auf einmal zu durchsuchen. Bitte einen spezifischeren Unterordner wählen.",
            MAX_INDEX_ENTRIES = MAX_INDEX_ENTRIES
        ));
    }
    let entries = build_full_index(root, cancel, total, &mut on_scan_progress)?;

    if !cancel.load(Ordering::SeqCst) {
        let state = app.state::<DiskSearchIndexHandle>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        disk_search_index::replace_root(&mut guard, &root_key, &entries)?;
    }

    Ok(entries)
}

/// Starts a cancellable disk search on a background thread and returns its
/// task id immediately — the walk itself (and the duplicate check after it)
/// can take a while on a large tree, so the frontend tracks
/// `disk-search-progress`/`disk-search-done` events (filtered by task id)
/// rather than waiting on this command's return value, same shape as
/// `copy_task::spawn_copy`. Everything below runs on this background OS
/// thread, never on the UI/IPC thread — the app stays responsive no matter
/// how long the search or the duplicate check takes.
///
/// `task_id` is supplied by the *caller*, not generated here — the frontend
/// subscribes to `disk-search-progress`/`disk-search-done` for this exact
/// id before it ever invokes this command. A small folder can finish (and
/// emit `disk-search-done`) within a few milliseconds; if the id instead
/// came back as this command's return value, the frontend would only learn
/// it, and only then attach its listener, after that round trip — a real
/// race that silently drops the done event for anything fast enough to
/// finish first, leaving the UI stuck in "searching" forever with nothing
/// left to cancel (confirmed 2026-10-13: a 117-file search left every
/// thread idle/asleep, not looping — the search had already finished).
#[tauri::command(async)]
pub fn search_disk(app: AppHandle, tasks: State<DiskSearchTasks>, task_id: String, params: DiskSearchParams) {
    let cancel = tasks.register(task_id.clone());

    let app_for_thread = app.clone();
    let task_id_for_thread = task_id.clone();
    std::thread::spawn(move || {
        let root = Path::new(&params.root_path).to_path_buf();
        let scan_started = Instant::now();
        let progress_task_id = task_id_for_thread.clone();
        let index_result = get_or_build_index(&app_for_thread, &params, &cancel, |done, total, current_action| {
            // `total == 0` is `count_entries`' own signal that it's still
            // counting (see `get_or_build_index`) — there is no real "0 of
            // 0 scanned" state once the walk proper starts, since that one
            // always knows at least `done` as its own total floor.
            let phase = if total == 0 { SearchPhase::Counting } else { SearchPhase::Scanning };
            let _ = app_for_thread.emit(
                PROGRESS_EVENT,
                DiskSearchProgress {
                    task_id: progress_task_id.clone(),
                    phase,
                    done,
                    total,
                    current_action: current_action.to_string(),
                    estimated_seconds_remaining: estimate_remaining_seconds(scan_started, done, total),
                },
            );
        });

        let mut cancelled = cancel.load(Ordering::SeqCst);
        let (mut hits, error) = match index_result {
            Ok(entries) => (filter_indexed_entries(&root, &entries, &params), None),
            Err(e) => (Vec::new(), Some(e)),
        };

        // "Duplikate ausblenden" — hits that are the same content found at
        // more than one path within this search itself, collapsed to one
        // representative. Runs purely against the result set, no project
        // involved at all, so it's independent of whether a project is
        // even open. Skipped entirely on error/cancellation, and when the
        // toggle is off every path found is kept untouched.
        let mut within_results_duplicates_removed = 0usize;
        if params.dedupe_within_results && error.is_none() && !cancelled {
            let dedupe_started = Instant::now();
            let before = hits.len();
            let progress_task_id = task_id_for_thread.clone();
            hits = dedupe_within_results(hits, params.verify_duplicate_content, &cancel, |done, total, current_action| {
                let _ = app_for_thread.emit(
                    PROGRESS_EVENT,
                    DiskSearchProgress {
                        task_id: progress_task_id.clone(),
                        phase: SearchPhase::DedupingResults,
                        done,
                        total,
                        current_action: current_action.to_string(),
                        estimated_seconds_remaining: estimate_remaining_seconds(dedupe_started, done, total),
                    },
                );
            });
            within_results_duplicates_removed = before - hits.len();
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
            }
        }

        // "Bereits im Projekt enthaltene Dateien ausblenden" — compares the
        // (already deduped) hits against the open project's own files,
        // runs after filtering/deduping, not per entry during the walk: it
        // needs the open project's connection, and there is no point
        // hashing a file an earlier step already discarded. Skipped
        // entirely on error/cancellation (nothing meaningful to compare
        // then) and when the toggle is off — that toggle switches the
        // whole project comparison on and off, not just whether matches
        // are hidden afterward, so a user who doesn't care never pays for
        // the size/hash comparisons at all.
        if params.hide_already_in_project && error.is_none() && !cancelled {
            let dup_total = hits.len();
            let dup_started = Instant::now();
            let mut last_emit = Instant::now();
            let state = app_for_thread.state::<AppStateHandle>();
            let project_path = state
                .lock()
                .ok()
                .and_then(|guard| guard.current_project.as_ref().map(|current| current.path.clone()));
            if let Some(project_path) = project_path {
                // The lock only for each hit's two short database steps (see
                // `find_duplicate_with`); the hashing runs unlocked.
                let with_db = |work: &mut dyn FnMut(&rusqlite::Connection)| {
                    let guard = crate::state::lock_project(&state, &project_path)?;
                    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
                    work(&current.conn);
                    Ok(())
                };
                for (i, hit) in hits.iter_mut().enumerate() {
                    if cancel.load(Ordering::SeqCst) {
                        cancelled = true;
                        break;
                    }
                    hit.duplicate = duplicate_hash::find_duplicate_with(
                        &with_db,
                        Path::new(&hit.path),
                        hit.size,
                        params.verify_duplicate_content,
                    );

                    let done = i + 1;
                    if last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS || done == dup_total {
                        let _ = app_for_thread.emit(
                            PROGRESS_EVENT,
                            DiskSearchProgress {
                                task_id: task_id_for_thread.clone(),
                                phase: SearchPhase::CheckingAgainstProject,
                                done,
                                total: dup_total,
                                current_action: hit.name.clone(),
                                estimated_seconds_remaining: estimate_remaining_seconds(dup_started, done, dup_total),
                            },
                        );
                        last_emit = Instant::now();
                    }
                }
            }
        }

        // Only applies once the project comparison actually ran; otherwise
        // every hit's `duplicate` is `None` already and this is a no-op.
        let already_in_project_hidden = if params.hide_already_in_project {
            let before = hits.len();
            hits.retain(|hit| hit.duplicate.is_none());
            before - hits.len()
        } else {
            0
        };

        let _ = app_for_thread.emit(
            DONE_EVENT,
            DiskSearchDone {
                task_id: task_id_for_thread.clone(),
                hits,
                cancelled,
                error,
                within_results_duplicates_removed,
                already_in_project_hidden,
            },
        );
        app_for_thread.state::<DiskSearchTasks>().unregister(&task_id_for_thread);
    });
}

#[tauri::command(async)]
pub fn cancel_disk_search(tasks: State<DiskSearchTasks>, task_id: String) -> Result<(), String> {
    let map = tasks.0.lock().map_err(|e| e.to_string())?;
    match map.get(&task_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err(crate::i18n::tr("Diese Suche läuft nicht (mehr).").into()),
    }
}

/// Whether `root_path` already has a cached index — drives the "Aus dem
/// Index laden" toggle's enabled state in the UI: it can only be switched
/// on once this folder has actually been indexed before. The index itself
/// is filter-independent (see `get_or_build_index`'s doc comment), so this
/// deliberately does not care what filters were used last time.
#[tauri::command(async)]
pub fn has_disk_search_index(app: AppHandle, root_path: String) -> bool {
    let state = app.state::<DiskSearchIndexHandle>();
    let Ok(guard) = state.0.lock() else { return false };
    disk_search_index::has_root(&guard, &root_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-disksearch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn base_params(root: &Path) -> DiskSearchParams {
        DiskSearchParams {
            root_path: root.to_string_lossy().to_string(),
            include_subfolders: true,
            kinds: Vec::new(),
            name_contains: None,
            date_field: DateField::Modified,
            date_from: None,
            date_to: None,
            size_min: None,
            size_max: None,
            dedupe_within_results: false,
            hide_already_in_project: false,
            verify_duplicate_content: false,
            index_mode: IndexMode::Reindex,
        }
    }

    fn hit_at(path: &Path, size: u64) -> DiskSearchHit {
        DiskSearchHit {
            path: path.to_string_lossy().to_string(),
            name: path.file_name().unwrap().to_string_lossy().to_string(),
            kind: FileKind::Image,
            size,
            fs_created_at: None,
            fs_modified_at: None,
            duplicate: None,
        }
    }

    #[test]
    fn dedupe_within_results_keeps_only_the_first_copy_of_identical_content() {
        let root = scratch();
        fs::create_dir_all(root.join("sub1")).unwrap();
        fs::create_dir_all(root.join("sub2")).unwrap();
        fs::write(root.join("sub1").join("a.jpg"), b"same content").unwrap();
        fs::write(root.join("sub2").join("a.jpg"), b"same content").unwrap();

        let hits = vec![
            hit_at(&root.join("sub1").join("a.jpg"), 12),
            hit_at(&root.join("sub2").join("a.jpg"), 12),
        ];
        let cancel = AtomicBool::new(false);
        let kept = dedupe_within_results(hits, false, &cancel, |_, _, _| {});
        assert_eq!(kept.len(), 1);
        assert!(kept[0].path.ends_with("sub1/a.jpg"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dedupe_within_results_keeps_files_with_different_content() {
        let root = scratch();
        fs::write(root.join("a.jpg"), b"content a").unwrap();
        fs::write(root.join("b.jpg"), b"content b!").unwrap();

        let hits = vec![hit_at(&root.join("a.jpg"), 9), hit_at(&root.join("b.jpg"), 10)];
        let cancel = AtomicBool::new(false);
        let kept = dedupe_within_results(hits, false, &cancel, |_, _, _| {});
        assert_eq!(kept.len(), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dedupe_within_results_thorough_mode_catches_a_quick_hash_collision() {
        let root = scratch();
        let sample = 64 * 1024;
        let mut a = vec![0xAAu8; sample];
        a.extend(vec![1u8; 1024]);
        a.extend(vec![0xBBu8; sample]);
        let mut b = vec![0xAAu8; sample];
        b.extend(vec![2u8; 1024]);
        b.extend(vec![0xBBu8; sample]);
        assert_eq!(a.len(), b.len());
        fs::write(root.join("a.bin"), &a).unwrap();
        fs::write(root.join("b.bin"), &b).unwrap();

        let hits = vec![hit_at(&root.join("a.bin"), a.len() as u64), hit_at(&root.join("b.bin"), b.len() as u64)];
        let cancel = AtomicBool::new(false);

        let fast = dedupe_within_results(hits.clone(), false, &cancel, |_, _, _| {});
        assert_eq!(fast.len(), 1, "quick_hash alone collides on these two files");

        let thorough = dedupe_within_results(hits, true, &cancel, |_, _, _| {});
        assert_eq!(thorough.len(), 2, "full content hash must tell them apart");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn count_entries_capped_stops_walking_once_the_cap_is_exceeded() {
        let root = scratch();
        for i in 0..10 {
            fs::write(root.join(format!("f{i}.jpg")), b"x").unwrap();
        }

        // Cap of 5: 10 real files exist, but the walk must never need to
        // see more than 6 of them to know the cap is blown.
        assert_eq!(count_entries_capped(&root, 5, |_, _| {}), 6);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn count_entries_capped_returns_the_real_count_when_under_the_cap() {
        let root = scratch();
        for i in 0..3 {
            fs::write(root.join(format!("f{i}.jpg")), b"x").unwrap();
        }

        assert_eq!(count_entries_capped(&root, 100, |_, _| {}), 3);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn build_full_index_is_always_recursive_regardless_of_include_subfolders() {
        let root = scratch();
        fs::write(root.join("a.jpg"), b"hello").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("b.jpg"), b"world").unwrap();

        let cancel = AtomicBool::new(false);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();
        assert_eq!(entries.len(), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn filtering_without_subfolders_keeps_only_direct_children() {
        let root = scratch();
        fs::write(root.join("a.jpg"), b"hello").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("b.jpg"), b"world").unwrap();

        let cancel = AtomicBool::new(false);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();

        let mut params = base_params(&root);
        params.include_subfolders = false;
        let hits = filter_indexed_entries(&root, &entries, &params);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "a.jpg");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hidden_files_are_skipped_while_indexing() {
        let root = scratch();
        fs::write(root.join(".secret.jpg"), b"hello").unwrap();
        fs::write(root.join("visible.jpg"), b"world").unwrap();

        let cancel = AtomicBool::new(false);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.jpg");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn size_bounds_filter_out_mismatched_files() {
        let root = scratch();
        fs::write(root.join("small.jpg"), vec![0u8; 10]).unwrap();
        fs::write(root.join("big.jpg"), vec![0u8; 1000]).unwrap();

        let cancel = AtomicBool::new(false);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();

        let mut params = base_params(&root);
        params.size_min = Some(500);
        let hits = filter_indexed_entries(&root, &entries, &params);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "big.jpg");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn kind_filter_restricts_to_requested_kinds() {
        let root = scratch();
        fs::write(root.join("a.jpg"), b"hello").unwrap();
        fs::write(root.join("b.mp3"), b"world").unwrap();

        let cancel = AtomicBool::new(false);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();

        let mut params = base_params(&root);
        params.kinds = vec![FileKind::Image];
        let hits = filter_indexed_entries(&root, &entries, &params);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "a.jpg");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancelling_stops_the_walk_early() {
        let root = scratch();
        for i in 0..50 {
            fs::write(root.join(format!("f{i}.jpg")), b"x").unwrap();
        }

        let cancel = AtomicBool::new(true);
        let entries = build_full_index(&root, &cancel, 0, |_, _, _| {}).unwrap();
        assert!(entries.len() < 50);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_root_path_is_a_friendly_error() {
        let cancel = AtomicBool::new(false);
        let err = build_full_index(Path::new("/this/does/not/exist"), &cancel, 0, |_, _, _| {}).unwrap_err();
        assert!(err.contains("existiert nicht"), "{err}");
    }

    #[test]
    fn count_entries_matches_what_build_full_index_actually_visits() {
        let root = scratch();
        fs::write(root.join("a.jpg"), b"hello").unwrap();
        fs::write(root.join(".hidden"), b"skip").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("b.jpg"), b"world").unwrap();

        assert_eq!(count_entries(&root, |_, _| {}), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn eta_is_unknown_without_enough_information() {
        let started = Instant::now();
        assert!(estimate_remaining_seconds(started, 0, 10).is_none(), "nothing done yet");
        assert!(estimate_remaining_seconds(started, 5, 0).is_none(), "no known total");
        assert!(estimate_remaining_seconds(started, 10, 10).is_none(), "already finished");
    }

    #[test]
    fn eta_shrinks_as_more_work_completes() {
        let started = Instant::now() - std::time::Duration::from_secs(10);
        // 10s elapsed, 5 of 10 done → rate 0.5/s → 5 remaining ≈ 10s left.
        let early = estimate_remaining_seconds(started, 5, 10).unwrap();
        // Same elapsed, further along → less work left at a similar rate.
        let later = estimate_remaining_seconds(started, 9, 10).unwrap();
        assert!(later < early, "later={later}, early={early}");
    }

    #[test]
    fn name_contains_matches_case_and_unicode_insensitively() {
        let mut params = base_params(Path::new("/x"));
        params.name_contains = Some("MÜLLER".to_string());
        assert!(passes_value_filters(&params, "urlaub_müller_2013.jpg", FileKind::Image, 10, None, None));
        assert!(!passes_value_filters(&params, "urlaub_schmidt_2013.jpg", FileKind::Image, 10, None, None));
    }

    #[test]
    fn blank_name_contains_matches_everything() {
        let mut params = base_params(Path::new("/x"));
        params.name_contains = Some("   ".to_string());
        assert!(passes_value_filters(&params, "anything.jpg", FileKind::Image, 10, None, None));
    }

    #[test]
    fn date_filter_excludes_files_without_a_reliable_timestamp_once_set() {
        let mut params = base_params(Path::new("/x"));
        params.date_from = Some("2024-01-01".to_string());
        assert!(!passes_value_filters(&params, "a.jpg", FileKind::Image, 10, None, None));
    }

    #[test]
    fn date_filter_keeps_files_within_the_inclusive_range() {
        let mut params = base_params(Path::new("/x"));
        params.date_from = Some("2024-01-01".to_string());
        params.date_to = Some("2024-01-31".to_string());
        let mid = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
        assert!(passes_value_filters(&params, "a.jpg", FileKind::Image, 10, None, Some(mid)));

        let too_late = NaiveDate::from_ymd_opt(2024, 2, 1).unwrap();
        assert!(!passes_value_filters(&params, "a.jpg", FileKind::Image, 10, None, Some(too_late)));
    }
}
