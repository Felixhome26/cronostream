//! "Archiv prüfen": a read-only health check of the open Stream, for an
//! archive meant to last decades on disks that do fail.
//!
//! It looks for four things: files the timeline lists but the folder lost,
//! thumbnails that went missing, files lying in the project's own folders
//! that no entry knows (left over from an interrupted copy, put there by
//! hand), and — when asked to read every file in full — content that changed
//! without the app changing it. The last one compares against the BLAKE3
//! fingerprint in `item_hashes.blake3_hash`: written by the disk search's
//! thorough comparison already, and on the first full check for every file
//! that has none yet. Replacing a file in the app deletes that row (see
//! `items::swap_item_file_prepared`), so a deliberate change never shows up.
//!
//! Nothing is changed by the check itself apart from those new fingerprints.
//! The only repair it offers is regenerating missing thumbnails, on request.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::fsbrowse::FileKind;
use crate::state::AppStateHandle;

/// The project's own folders; the same three `project_files` owns.
const OWNED_DIRS: [&str; 3] = ["originals", "thumbnails", "diary"];
/// Most files listed per finding; the counts stay exact beyond it.
const LIST_LIMIT: usize = 200;
/// Stops the walk of the project's folders on a runaway tree.
const WALK_LIMIT: usize = 500_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: Option<String>,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub items_checked: usize,
    pub missing_files: Vec<Finding>,
    pub missing_files_count: usize,
    pub missing_thumbnails: Vec<Finding>,
    pub missing_thumbnails_count: usize,
    pub stray_files: Vec<Finding>,
    pub stray_files_count: usize,
    pub stray_bytes: u64,
    /// Only filled when the contents were read (`deep`).
    pub changed_files: Vec<Finding>,
    pub changed_files_count: usize,
    pub contents_checked: bool,
    /// Files that got their first fingerprint in this run.
    pub fingerprints_added: usize,
}

struct ItemRow {
    id: String,
    name: String,
    stored_path: String,
    thumbnail_path: Option<String>,
    live: bool,
    fingerprint: Option<String>,
}

/// A file attached to a diary entry; `live` and the privacy check follow the entry.
struct AttachmentRow {
    diary_id: String,
    name: String,
    stored_path: String,
    live: bool,
}

/// `path` relative to the project root, with `/` separators, if it lies
/// inside it — the form both sides of the stray-file comparison use.
fn relative_key(project_root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(project_root).ok()?;
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
}

/// `relative_key` for the paths in the database, which may spell the folder
/// differently from how it was opened — through a symlink, or in other
/// letter case on Windows — while meaning the same place. Without this,
/// every file of such a stream was listed as having no entry. A path's
/// folder is resolved once and remembered, so this stays a handful of calls
/// even for a large stream.
struct KeyResolver<'a> {
    root: &'a Path,
    canonical_root: Option<PathBuf>,
    resolved_dirs: HashMap<PathBuf, Option<PathBuf>>,
}

impl<'a> KeyResolver<'a> {
    fn new(root: &'a Path) -> Self {
        KeyResolver { root, canonical_root: root.canonicalize().ok(), resolved_dirs: HashMap::new() }
    }

    fn key(&mut self, path: &Path) -> Option<String> {
        if let Some(key) = relative_key(self.root, path) {
            return Some(key);
        }
        let canonical_root = self.canonical_root.as_deref()?;
        if let Some(key) = relative_key(canonical_root, path) {
            return Some(key);
        }
        let (dir, name) = (path.parent()?, path.file_name()?);
        let resolved = self.resolved_dirs.entry(dir.to_path_buf()).or_insert_with(|| dir.canonicalize().ok()).as_deref()?;
        relative_key(canonical_root, &resolved.join(name))
    }
}

fn add(list: &mut Vec<Finding>, count: &mut usize, finding: Finding) {
    *count += 1;
    if list.len() < LIST_LIMIT {
        list.push(finding);
    }
}

fn load_rows(conn: &Connection) -> Result<(Vec<ItemRow>, Vec<AttachmentRow>), String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id, COALESCE(i.display_name, i.original_filename), i.stored_path, i.thumbnail_path,
                    i.removed_at IS NULL, h.blake3_hash
             FROM items i LEFT JOIN item_hashes h ON h.item_id = i.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ItemRow {
                id: row.get(0)?,
                name: row.get(1)?,
                stored_path: row.get(2)?,
                thumbnail_path: row.get(3)?,
                live: row.get(4)?,
                fingerprint: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.diary_id, a.original_filename, a.stored_path, i.removed_at IS NULL
             FROM diary_attachments a LEFT JOIN items i ON i.id = a.diary_id",
        )
        .map_err(|e| e.to_string())?;
    let attachments = stmt
        .query_map([], |row| {
            Ok(AttachmentRow {
                diary_id: row.get(0)?,
                name: row.get(1)?,
                stored_path: row.get(2)?,
                live: row.get::<_, Option<bool>>(3)?.unwrap_or(false),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok((rows, attachments))
}

/// Every file under the project's own folders, as relative keys with sizes.
fn walk_owned(project_root: &Path) -> HashMap<String, u64> {
    let mut files = HashMap::new();
    for dir in OWNED_DIRS {
        let walker = walkdir::WalkDir::new(project_root.join(dir)).same_file_system(true).follow_links(false);
        for entry in walker.into_iter().flatten() {
            if files.len() >= WALK_LIMIT {
                return files;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(key) = relative_key(project_root, entry.path()) {
                files.insert(key, entry.metadata().map(|m| m.len()).unwrap_or(0));
            }
        }
    }
    files
}

/// The check proper, on rows already read. `hash` reads a file in full
/// (BLAKE3), `on_progress` is called once per live entry.
fn check(
    project_root: &Path,
    rows: &[ItemRow],
    attachments: &[AttachmentRow],
    hidden: &HashSet<String>,
    deep: bool,
    hash: impl Fn(&Path) -> Option<String> + Sync,
    on_progress: impl Fn(usize, usize, &str) + Sync,
) -> (ArchiveReport, Vec<(String, String)>) {
    let mut report = ArchiveReport { contents_checked: deep, ..Default::default() };

    // Stray files: everything in the folders no row refers to. Removed
    // entries count as referring — their copy is kept on purpose until it
    // is deleted for good.
    let mut keys = KeyResolver::new(project_root);
    let mut referenced: HashSet<String> = HashSet::new();
    for row in rows {
        for path in std::iter::once(row.stored_path.as_str()).chain(row.thumbnail_path.as_deref()) {
            if let Some(key) = keys.key(Path::new(path)) {
                referenced.insert(key);
            }
        }
    }
    for attachment in attachments {
        if let Some(key) = keys.key(Path::new(&attachment.stored_path)) {
            referenced.insert(key);
        }
    }
    let mut stray: Vec<(String, u64)> = walk_owned(project_root).into_iter().filter(|(key, _)| !referenced.contains(key)).collect();
    stray.sort();
    for (key, size) in stray {
        report.stray_bytes += size;
        let name = key.rsplit('/').next().unwrap_or(&key).to_string();
        let path = project_root.join(&key).to_string_lossy().into_owned();
        add(&mut report.stray_files, &mut report.stray_files_count, Finding { id: None, name, path });
    }

    // Missing files and thumbnails, and (deep) changed contents — live
    // entries only, and none the private mode is hiding.
    let live: Vec<&ItemRow> = rows.iter().filter(|r| r.live && !hidden.contains(&r.id)).collect();
    report.items_checked = live.len();
    let done = AtomicUsize::new(0);
    let total = live.len();
    let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(total.max(1));
    let results: Vec<(usize, bool, bool, Option<String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..worker_count)
            .map(|worker| {
                let live = &live;
                let done = &done;
                let hash = &hash;
                let on_progress = &on_progress;
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for index in (worker..live.len()).step_by(worker_count) {
                        let row = live[index];
                        let stored = Path::new(&row.stored_path);
                        let file_ok = stored.is_file();
                        let thumb_ok = row.thumbnail_path.as_deref().is_none_or(|t| Path::new(t).is_file());
                        let fingerprint = if deep && file_ok { hash(stored) } else { None };
                        out.push((index, file_ok, thumb_ok, fingerprint));
                        on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total, &row.name);
                    }
                    out
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut results = results;
    results.sort_by_key(|r| r.0);

    let mut new_fingerprints = Vec::new();
    for (index, file_ok, thumb_ok, fingerprint) in results {
        let row = live[index];
        let finding = |path: &str| Finding { id: Some(row.id.clone()), name: row.name.clone(), path: path.to_string() };
        if !file_ok {
            add(&mut report.missing_files, &mut report.missing_files_count, finding(&row.stored_path));
            continue;
        }
        if !thumb_ok {
            let thumb = row.thumbnail_path.clone().unwrap_or_default();
            add(&mut report.missing_thumbnails, &mut report.missing_thumbnails_count, finding(&thumb));
        }
        if let Some(now) = fingerprint {
            match &row.fingerprint {
                Some(before) if *before != now => {
                    add(&mut report.changed_files, &mut report.changed_files_count, finding(&row.stored_path))
                }
                Some(_) => {}
                None => new_fingerprints.push((row.id.clone(), now)),
            }
        }
    }
    // A diary entry's attachments are files of their own, listed under the
    // entry; few enough to look up right here.
    for attachment in attachments {
        if attachment.live && !hidden.contains(&attachment.diary_id) && !Path::new(&attachment.stored_path).is_file() {
            let finding =
                Finding { id: Some(attachment.diary_id.clone()), name: attachment.name.clone(), path: attachment.stored_path.clone() };
            add(&mut report.missing_files, &mut report.missing_files_count, finding);
        }
    }

    report.fingerprints_added = new_fingerprints.len();
    (report, new_fingerprints)
}

fn store_fingerprints(conn: &Connection, fingerprints: &[(String, String)]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, hash) in fingerprints {
        tx.execute(
            "INSERT INTO item_hashes (item_id, blake3_hash) VALUES (?1, ?2)
             ON CONFLICT(item_id) DO UPDATE SET blake3_hash = excluded.blake3_hash",
            params![id, hash],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Runs the check on the open stream. The app lock is held only to read
/// the entries and to store new fingerprints, not while the files are read.
#[tauri::command]
pub async fn check_archive(app: AppHandle, deep: bool, operation_id: String) -> Result<ArchiveReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let (project_root, rows, attachments, hidden) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let (rows, attachments) = load_rows(&current.conn)?;
            let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?.unwrap_or_default();
            (current.path.clone(), rows, attachments, hidden)
        };
        let (report, fingerprints) = check(
            &project_root,
            &rows,
            &attachments,
            &hidden,
            deep,
            |path| crate::duplicate_hash::blake3_hash(path).ok(),
            |done, total, name| crate::progress::emit_progress(&app, &operation_id, done, total, name),
        );
        if !fingerprints.is_empty() {
            let guard = crate::state::lock_project(&state, &project_root)?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            store_fingerprints(&current.conn, &fingerprints)?;
        }
        Ok(report)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Thumbnails made at the same time: a large repair finishes in reasonable
/// time, and the app stays responsive while it runs.
const REGENERATE_WORKERS: usize = 2;

/// Whether a thumbnail may be written at `thumb`: inside the project's own
/// thumbnails folder as spelled, without `..`, and — as far as the folders
/// on the way exist — still there once symlinks are resolved. A thumbnail
/// that is itself a symlink is refused too, since ffmpeg writes through it.
fn inside_thumbnails(project_root: &Path, thumb: &Path) -> bool {
    let folder = project_root.join("thumbnails");
    if !thumb.starts_with(&folder) || thumb.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    if thumb.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink()) {
        return false;
    }
    let Some(existing) = thumb.ancestors().skip(1).find(|dir| dir.exists()) else { return false };
    let (Ok(existing), Ok(root)) = (existing.canonicalize(), project_root.canonicalize()) else { return false };
    // The project folder itself when the whole thumbnails folder is gone:
    // it is then created afresh, inside the project.
    existing.starts_with(root.join("thumbnails")) || existing == root
}

fn regenerate_one(stored: &Path, thumb: &Path, kind: &str, frame_percent: f64) -> Result<(), String> {
    crate::safe_io::catch_panic(|| match FileKind::from_str(kind) {
        Some(FileKind::Image) => crate::preview::store_image_thumbnail(stored, thumb),
        Some(FileKind::Video) => crate::video_preview::extract_frame(stored, frame_percent, thumb),
        Some(FileKind::Document) if thumb.extension().is_some() => {
            crate::pdf_preview::render_first_page(stored, &thumb.with_extension("")).and_then(|written| {
                if written == thumb {
                    Ok(())
                } else {
                    std::fs::rename(&written, thumb).map_err(|e| e.to_string())
                }
            })
        }
        _ => Err(String::new()),
    })
}

/// Regenerates every missing thumbnail of the open stream from its file,
/// where the kind has one (photos, videos, PDFs): all the entries the check
/// counts, not only the ones it lists. Returns how many were made. The app
/// lock is held only to read the entries.
#[tauri::command]
pub async fn regenerate_thumbnails(app: AppHandle, operation_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let (project_root, rows, hidden, frame_percent) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let mut stmt = current
                .conn
                .prepare(
                    "SELECT id, stored_path, thumbnail_path, file_type, video_frame_percent FROM items
                     WHERE removed_at IS NULL AND thumbnail_path IS NOT NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows: Vec<(String, String, String, String, Option<f64>)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?.unwrap_or_default();
            (current.path.clone(), rows, hidden, crate::items::default_video_frame_percent(&current.conn))
        };
        // The same entries the check reports as missing a thumbnail.
        let jobs: Vec<_> = rows
            .into_iter()
            .filter(|(id, stored, thumb, _, _)| {
                !hidden.contains(id) && !Path::new(thumb).is_file() && Path::new(stored).is_file()
            })
            .filter(|(_, _, thumb, _, _)| inside_thumbnails(&project_root, Path::new(thumb)))
            .collect();
        let total = jobs.len();
        let (next, done, made) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..REGENERATE_WORKERS.min(total.max(1)) {
                scope.spawn(|| loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((_, stored, thumb, kind, percent)) = jobs.get(index) else { break };
                    if regenerate_one(Path::new(stored), Path::new(thumb), kind, percent.unwrap_or(frame_percent)).is_ok() {
                        made.fetch_add(1, Ordering::Relaxed);
                    }
                    crate::progress::emit_progress(&app, &operation_id, done.fetch_add(1, Ordering::Relaxed) + 1, total, stored);
                });
            }
        });
        Ok(made.into_inner())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-archive-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("originals/2020/05")).unwrap();
        std::fs::create_dir_all(dir.join("thumbnails/2020/05")).unwrap();
        dir
    }

    fn row(root: &Path, id: &str, file: &str, live: bool, fingerprint: Option<&str>) -> ItemRow {
        ItemRow {
            id: id.into(),
            name: file.into(),
            stored_path: root.join("originals/2020/05").join(file).to_string_lossy().into_owned(),
            thumbnail_path: Some(root.join("thumbnails/2020/05").join(format!("{id}.jpg")).to_string_lossy().into_owned()),
            live,
            fingerprint: fingerprint.map(String::from),
        }
    }

    fn write(path: &str, content: &[u8]) {
        std::fs::write(path, content).unwrap();
    }

    fn fake_hash(path: &Path) -> Option<String> {
        std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    #[test]
    fn finds_missing_files_thumbnails_and_strays() {
        let root = temp_dir();
        let rows = vec![row(&root, "a", "a.jpg", true, None), row(&root, "b", "b.jpg", true, None), row(&root, "r", "r.jpg", false, None)];
        write(&rows[0].stored_path, b"a");
        write(rows[0].thumbnail_path.as_deref().unwrap(), b"t");
        // b: file present, thumbnail gone. r: removed, its copy kept on purpose.
        write(&rows[1].stored_path, b"b");
        write(&rows[2].stored_path, b"r");
        // Left behind by an interrupted copy.
        write(&root.join("originals/2020/05/x.jpg.part").to_string_lossy(), b"12345");
        let mut rows = rows;
        rows.push(row(&root, "m", "m.jpg", true, None));

        let (report, fingerprints) = check(&root, &rows, &[], &HashSet::new(), false, fake_hash, |_, _, _| {});
        assert_eq!(report.items_checked, 3);
        assert_eq!(report.missing_files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["m.jpg"]);
        assert_eq!(report.missing_thumbnails.iter().map(|f| f.id.as_deref().unwrap()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(report.stray_files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["x.jpg.part"]);
        assert_eq!(report.stray_bytes, 5);
        assert!(!report.contents_checked && fingerprints.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_full_check_adds_fingerprints_once_and_then_finds_changes() {
        let root = temp_dir();
        let rows = vec![row(&root, "a", "a.jpg", true, Some("alt")), row(&root, "b", "b.jpg", true, Some("b")), row(&root, "c", "c.jpg", true, None)];
        for r in &rows {
            write(&r.stored_path, r.id.as_bytes());
            write(r.thumbnail_path.as_deref().unwrap(), b"t");
        }
        let (report, fingerprints) = check(&root, &rows, &[], &HashSet::new(), true, fake_hash, |_, _, _| {});
        assert!(report.contents_checked);
        // a: content "a" against the stored "alt" → changed. b: unchanged. c: new.
        assert_eq!(report.changed_files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a.jpg"]);
        assert_eq!(fingerprints, vec![("c".to_string(), "c".to_string())]);
        assert_eq!(report.fingerprints_added, 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn private_entries_and_diary_attachments_are_respected() {
        let root = temp_dir();
        std::fs::create_dir_all(root.join("diary/d1/anhang")).unwrap();
        let attachment = root.join("diary/d1/anhang/foto.jpg");
        write(&attachment.to_string_lossy(), b"x");
        let mut private = row(&root, "p", "p.jpg", true, None);
        private.thumbnail_path = None;
        let hidden: HashSet<String> = ["p".to_string()].into();
        let attachments = [
            AttachmentRow { diary_id: "d1".into(), name: "foto.jpg".into(), stored_path: attachment.to_string_lossy().into_owned(), live: true },
            // Gone from the disk, of a private entry: not reported either.
            AttachmentRow { diary_id: "p".into(), name: "weg.jpg".into(), stored_path: root.join("diary/p/weg.jpg").to_string_lossy().into_owned(), live: true },
        ];
        let (report, _) = check(&root, &[private], &attachments, &hidden, false, fake_hash, |_, _, _| {});
        assert_eq!(report.items_checked, 0);
        assert_eq!(report.missing_files_count, 0);
        assert_eq!(report.stray_files_count, 0);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_diary_attachment_is_reported_under_its_entry() {
        let root = temp_dir();
        let gone = root.join("diary/d1/anhang/brief.pdf").to_string_lossy().into_owned();
        let attachments = [
            AttachmentRow { diary_id: "d1".into(), name: "brief.pdf".into(), stored_path: gone.clone(), live: true },
            // A removed entry keeps its attachments on purpose; nothing to report.
            AttachmentRow { diary_id: "d2".into(), name: "alt.pdf".into(), stored_path: gone.clone(), live: false },
        ];
        let (report, _) = check(&root, &[], &attachments, &HashSet::new(), false, fake_hash, |_, _, _| {});
        assert_eq!(report.missing_files, vec![Finding { id: Some("d1".into()), name: "brief.pdf".into(), path: gone }]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The database spells the folder as it was when the files came in; the
    /// stream is opened here through a symlink. Its files still have
    /// their entries.
    #[cfg(unix)]
    #[test]
    fn a_stream_opened_through_a_symlink_has_no_strays() {
        let root = temp_dir();
        let link = root.with_file_name(format!("{}-link", root.file_name().unwrap().to_string_lossy()));
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let rows = vec![row(&root, "a", "a.jpg", true, None)];
        write(&rows[0].stored_path, b"a");
        write(rows[0].thumbnail_path.as_deref().unwrap(), b"t");
        let (report, _) = check(&link, &rows, &[], &HashSet::new(), false, fake_hash, |_, _, _| {});
        assert_eq!((report.stray_files_count, report.missing_files_count), (0, 0));
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn thumbnails_are_only_written_inside_the_thumbnails_folder() {
        let root = temp_dir();
        let thumbs = root.join("thumbnails");
        assert!(inside_thumbnails(&root, &thumbs.join("2020/05/a.jpg")));
        assert!(inside_thumbnails(&root, &thumbs.join("2031/01/new.jpg")), "missing folders are created inside");
        assert!(!inside_thumbnails(&root, &thumbs.join("../originals/2020/05/a.jpg")));
        assert!(!inside_thumbnails(&root, &root.join("originals/2020/05/a.jpg")));
        // A folder on the way that leads elsewhere.
        let elsewhere = temp_dir();
        std::os::unix::fs::symlink(&elsewhere, thumbs.join("2019")).unwrap();
        assert!(!inside_thumbnails(&root, &thumbs.join("2019/a.jpg")));
        // The thumbnail itself a link: ffmpeg would write through it.
        std::os::unix::fs::symlink(elsewhere.join("x.jpg"), thumbs.join("2020/05/link.jpg")).unwrap();
        assert!(!inside_thumbnails(&root, &thumbs.join("2020/05/link.jpg")));
        // The whole thumbnails folder gone: made afresh inside the project.
        std::fs::remove_dir_all(&thumbs).unwrap();
        assert!(inside_thumbnails(&root, &thumbs.join("2020/05/a.jpg")));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    #[test]
    fn stored_fingerprints_keep_the_quick_hash() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
             VALUES ('a', 'a.jpg', '/x/a.jpg', 'image', '2020-01-01T00:00:00Z', 'exif', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO item_hashes (item_id, quick_hash) VALUES ('a', 42)", []).unwrap();
        store_fingerprints(&conn, &[("a".into(), "abc".into())]).unwrap();
        let (quick, full): (i64, String) =
            conn.query_row("SELECT quick_hash, blake3_hash FROM item_hashes WHERE item_id = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((quick, full.as_str()), (42, "abc"));
    }
}
