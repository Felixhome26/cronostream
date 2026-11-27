use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

/// Shared safety cap for every unbounded recursive directory walk in the
/// app (the disk-wide search in `disk_search.rs` and the grid's "show
/// subfolder files" toggle below) — see `disk_search`'s doc comment on its
/// own re-export of this constant for the 2026-10-13 incident that made it
/// necessary. Defined here, not in `disk_search.rs`, since `disk_search`
/// already depends on this module and not the other way around.
pub(crate) const MAX_WALK_ENTRIES: usize = 200_000;

/// Broad "common formats" classification (see project concept: MVP covers
/// the common formats; legacy/RAW/exotic formats are a later increment).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Image,
    Video,
    Audio,
    Document,
    Email,
    Other,
}

impl FileKind {
    /// Stable string form for storage (the disk-search index's `kind`
    /// column) — kept separate from the `Serialize` derive above so a
    /// serde attribute change for the IPC-facing JSON shape can never
    /// silently change what's already on disk in a cache database.
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Image => "image",
            FileKind::Video => "video",
            FileKind::Audio => "audio",
            FileKind::Document => "document",
            FileKind::Email => "email",
            FileKind::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "image" => FileKind::Image,
            "video" => FileKind::Video,
            "audio" => FileKind::Audio,
            "document" => FileKind::Document,
            "email" => FileKind::Email,
            "other" => FileKind::Other,
            _ => return None,
        })
    }
}

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "wmv", "flv", "3gp", "mpg", "mpeg"];
// ".weba" is audio in a WebM container — the extension the in-app
// microphone recording is stored under, so it is classified as audio
// instead of landing in VIDEO_EXTS' ".webm" (see
// `record_commands::extension_for`).
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "m4a", "flac", "ogg", "aac", "wma", "aiff", "weba"];
const DOCUMENT_EXTS: &[&str] = &["pdf", "docx", "doc", "odt", "rtf", "txt", "csv", "xls", "xlsx"];
const EMAIL_EXTS: &[&str] = &["eml", "msg"];

pub fn classify(path: &Path) -> FileKind {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if IMAGE_EXTS.contains(&ext.as_str()) {
        FileKind::Image
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        FileKind::Video
    } else if AUDIO_EXTS.contains(&ext.as_str()) {
        FileKind::Audio
    } else if DOCUMENT_EXTS.contains(&ext.as_str()) {
        FileKind::Document
    } else if EMAIL_EXTS.contains(&ext.as_str()) {
        FileKind::Email
    } else if crate::email::looks_like_email(path) {
        // Reached only for an extension that isn't recognised by any list
        // above (including none at all) — i.e. exactly the files that
        // would otherwise fall through to `Other`. Mail clients commonly
        // drop a dragged message with no extension at all (see the two
        // test files this was built against), so sniffing the header
        // block is the only way to catch those.
        FileKind::Email
    } else {
        FileKind::Other
    }
}

/// Whether this file can be added to a project. Images/audio/video (via
/// ffmpeg) and PDFs (via PDFium) get a real visual preview; PDFs also get
/// their text extracted via PDFium as well (see
/// `pdf_preview::extract_text`) so their content is searchable too. Word
/// (.docx), OpenDocument (.odt) and RTF get their full text extracted
/// instead (see `doc_text`) — no visual page render, but no LibreOffice (or
/// any other external tool) needed either, which matters for shipping this
/// cross-platform without asking the user to install anything. Legacy
/// binary `.doc` can't be read at all without a real OLE-file parser we
/// don't have, so it instead gets a generated placeholder card (filename +
/// filesystem metadata, see `doc_card`). Spreadsheets (csv/xls/xlsx) and
/// every other `FileKind::Other` extension get neither a preview nor
/// extracted text — just the filename and an "open with default app"
/// action in the UI, rather than being refused outright. E-mails
/// (`.eml`/`.msg`, or no extension at all if `email::looks_like_email`
/// recognises the header block — that heuristic only applies to raw
/// RFC822, not the binary `.msg` format) are the one `Other`-like
/// exception with real content to show: subject/sender/date plus the
/// body, see `email`.
pub fn can_add(path: &Path, kind: FileKind) -> bool {
    match kind {
        FileKind::Image | FileKind::Audio | FileKind::Video | FileKind::Email => true,
        FileKind::Document => path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .is_some_and(|e| {
                matches!(
                    e.as_str(),
                    "pdf" | "docx" | "odt" | "rtf" | "txt" | "doc" | "csv" | "xls" | "xlsx"
                )
            }),
        // No preview possible, but nothing stops us from storing the file
        // and letting the user open it with its registered default app —
        // see `kind_str` for the "other" file_type this produces.
        FileKind::Other => true,
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub kind: Option<FileKind>,
    pub can_add: bool,
    pub size: Option<u64>,
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    /// Manual rotation (0/90/180/270) chosen in the browser before this file
    /// is added to the project — filled in by the caller (`list_directory`)
    /// from the `path_rotations` table, since this pure fs scan has no DB
    /// access. Always 0 here.
    pub rotation: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
}

fn system_time_to_rfc3339(t: std::io::Result<std::time::SystemTime>) -> Option<String> {
    let t = t.ok()?;
    let duration = t.duration_since(UNIX_EPOCH).ok()?;
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(duration.as_secs() as i64, 0)?;
    Some(dt.to_rfc3339())
}

pub fn default_start_dir() -> PathBuf {
    dirs::picture_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn list_dir(path: &Path) -> Result<DirListing, String> {
    let mut entries = Vec::new();

    let read_dir = fs::read_dir(path).map_err(|e| crate::trf!("Konnte Ordner nicht lesen: {e}", e = e))?;
    for entry in read_dir.flatten() {
        let entry_path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/folders (dotfiles) and our own project internals.
        if file_name.starts_with('.') {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = metadata.is_dir();
        let kind = if is_dir { None } else { Some(classify(&entry_path)) };
        let can_add_file = kind.map(|k| can_add(&entry_path, k)).unwrap_or(false);

        entries.push(DirEntryInfo {
            name: file_name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            kind,
            can_add: can_add_file,
            size: if is_dir { None } else { Some(metadata.len()) },
            fs_created_at: system_time_to_rfc3339(metadata.created()),
            fs_modified_at: system_time_to_rfc3339(metadata.modified()),
            rotation: 0,
        });
    }

    // Folders first, then alphabetical within each group.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(DirListing {
        path: path.to_string_lossy().to_string(),
        parent: path.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
    })
}

/// Like `list_dir`, but flattens every file from every level below `path`
/// into one list instead of just the direct children — backs the grid
/// view's "Dateien in Unterordnern anzeigen" toggle. Folder entries are
/// omitted entirely in this mode: with files from several levels mixed
/// together, a folder tile would no longer mean "step into this", so the
/// folder tree in the sidebar remains the only way to navigate while this
/// is on.
///
/// Same safety posture as the disk-wide search's own walk
/// (`disk_search::build_full_index`): hidden files/folders skipped,
/// `.same_file_system(true)` so a mountpoint buried in the tree is never
/// wandered into, and capped at `MAX_WALK_ENTRIES` so an accidentally huge
/// root (or one sitting on a mountpoint) is refused outright rather than
/// risking the same kind of runaway scan that corrupted a drive on
/// 2026-10-13.
///
/// `cancel` is checked once per file, so leaving the view or switching the
/// toggle off ends a long walk right away instead of letting it run to the
/// end unseen. `on_batch` receives the files found so far in slices (at
/// most every `BATCH_SIZE` files or `BATCH_INTERVAL`), so the grid can show
/// the first ones long before the walk is done; the returned listing is
/// the complete, sorted one.
pub fn list_dir_recursive(
    path: &Path,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(&[DirEntryInfo]),
) -> Result<DirListing, String> {
    const BATCH_SIZE: usize = 500;
    const BATCH_INTERVAL: Duration = Duration::from_millis(250);

    let mut entries = Vec::new();
    let mut scanned_count = 0usize;
    let mut sent = 0usize;
    let mut last_sent_at = Instant::now();

    for entry in WalkDir::new(path).min_depth(1).same_file_system(true).into_iter().filter_entry(|e| {
        !e.file_name()
            .to_str()
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
    }) {
        if cancel.load(Ordering::Relaxed) {
            return Err("Abgebrochen.".to_string());
        }
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_dir() {
            continue;
        }
        scanned_count += 1;
        if scanned_count > MAX_WALK_ENTRIES {
            return Err(crate::trf!(
                "Dieser Ordner enthält mit allen Unterordnern mehr als {MAX_WALK_ENTRIES} Dateien – zu viele, um alles auf einmal anzuzeigen. Bitte „Dateien in Unterordnern anzeigen“ ausschalten oder einen spezifischeren Unterordner wählen.",
                MAX_WALK_ENTRIES = MAX_WALK_ENTRIES
            ));
        }

        let entry_path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = Some(classify(entry_path));
        let can_add_file = kind.map(|k| can_add(entry_path, k)).unwrap_or(false);

        entries.push(DirEntryInfo {
            name: file_name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: false,
            kind,
            can_add: can_add_file,
            size: Some(metadata.len()),
            fs_created_at: system_time_to_rfc3339(metadata.created()),
            fs_modified_at: system_time_to_rfc3339(metadata.modified()),
            rotation: 0,
        });
        if entries.len() - sent >= BATCH_SIZE || (entries.len() > sent && last_sent_at.elapsed() >= BATCH_INTERVAL) {
            on_batch(&entries[sent..]);
            sent = entries.len();
            last_sent_at = Instant::now();
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirListing {
        path: path.to_string_lossy().to_string(),
        parent: path.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
    })
}
