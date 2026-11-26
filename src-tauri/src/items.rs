use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::doc_card;
use crate::doc_text;
use crate::email;
use crate::fsbrowse::{self, FileKind};
use crate::pdf_preview;
use crate::preview;
use crate::settings;
use crate::video_preview;

pub(crate) const DEFAULT_VIDEO_FRAME_PERCENT_KEY: &str = "default_video_frame_percent";
const DEFAULT_VIDEO_FRAME_PERCENT: f64 = 10.0;

/// "Beim Einfügen auf Duplikate prüfen": whether every newly added file
/// gets its `quick_hash` computed right away (instead of only lazily on
/// first use — disk search, pending-drop check for audio/documents) *and*
/// compared against the rest of the project, see
/// `duplicate_hash::duplicates_among`. On by default — this is the whole
/// point of the setting, catching an accidental double-import right when it
/// happens rather than relying on the user to notice or to run the
/// Einstellungen scan later. Costs real time on a large batch, which is why
/// it stays a setting rather than being unconditional.
pub(crate) const QUICK_HASH_ON_INGEST_KEY: &str = "quick_hash_on_ingest";

#[derive(Serialize, Clone, Debug)]
pub struct AddedItem {
    pub id: String,
    pub original_filename: String,
    pub kind: FileKind,
    pub resolved_timestamp: String,
    pub timestamp_source: String,
}

/// Everything about adding a file that *doesn't* need the database
/// connection — the copy, timestamp resolution, and thumbnail generation.
/// Deliberately separate from the DB insert (see `commit_prepared_item`)
/// so a batch of these can be prepared in parallel across threads
/// (rusqlite::Connection isn't Sync, so the DB write itself still has to
/// happen back on a single thread, but that part is fast — copying and
/// decoding/resizing images is where the time actually goes).
pub struct PreparedItem {
    id: Uuid,
    original_filename: String,
    stored_path: PathBuf,
    thumbnail_path: Option<PathBuf>,
    kind: FileKind,
    resolved_timestamp: String,
    timestamp_source: String,
    fs_created: Option<String>,
    fs_modified: Option<String>,
    source_path: String,
    source_folder_path: Option<String>,
    video_frame_percent: Option<f64>,
    extracted_text: Option<String>,
    file_size_bytes: Option<u64>,
    /// The file's embedded (EXIF) date if it has one — kept independently of
    /// which candidate actually won, so the `embedded_metadata_at` column
    /// records it even when the user picked a filesystem date instead.
    exif_candidate: Option<String>,
    /// Header fields of an e-mail (`FileKind::Email` only) — small enough
    /// to ship with every `list_items` call, unlike `extracted_text` and
    /// the HTML body (see `get_item_email_html`), which stay lazy-loaded.
    email_subject: Option<String>,
    email_sender: Option<String>,
    email_date: Option<String>,
    /// Computed here (real file I/O, see `prepare_item`'s `compute_quick_hash`
    /// parameter) rather than in `commit_prepared_item`, so it runs on the
    /// same parallel worker as the copy/thumbnail/text-extraction work
    /// instead of serializing onto the single DB-writing thread afterward.
    quick_hash: Option<u64>,
}

pub(crate) fn fs_times(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return (None, None);
    };
    let to_rfc3339 = |t: std::io::Result<std::time::SystemTime>| -> Option<String> {
        let t = t.ok()?;
        let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
        chrono::DateTime::<chrono::Utc>::from_timestamp(duration.as_secs() as i64, 0)
            .map(|dt| dt.to_rfc3339())
    };
    (to_rfc3339(metadata.created()), to_rfc3339(metadata.modified()))
}

/// Every date we know about for a file, plus which one the automatic
/// priority chain settles on.
///
/// The timeline only ever stores one timestamp, but the review screen lets
/// the user switch between the alternatives before a file is added — which
/// means the candidates have to survive side by side rather than being
/// collapsed into a single winner as early as possible.
#[derive(Serialize, Clone, Debug)]
pub struct DateCandidates {
    pub exif: Option<String>,
    /// The timestamp the file's own name carries, where it has one — see
    /// `filename_date`. Ranked below embedded metadata but above the
    /// filesystem dates, because a name is copied with the file while
    /// those are rewritten by every copy.
    pub filename: Option<String>,
    pub fs_created: Option<String>,
    pub fs_modified: Option<String>,
    /// "exif" | "filename" | "fs_created" | "fs_modified" — the automatic choice.
    pub auto_source: String,
    pub auto_value: String,
}

/// Collects all date candidates for a file and applies the documented
/// priority to pick a default: embedded metadata first (EXIF, images only —
/// video container timestamps were measured against this library and found
/// to be the time the *file* was written, which for converted footage is
/// not the capture at all), then the timestamp in the filename, then the
/// filesystem dates.
///
/// If the creation date lies *after* the modification date, the file was
/// evidently copied in later (e.g. moved from another drive) — the
/// creation date reflects the copy, not the original file, so the
/// modification date is used instead.
pub fn compute_date_candidates(
    path: &Path,
    kind: FileKind,
    fs_created: &Option<String>,
    fs_modified: &Option<String>,
) -> DateCandidates {
    // WhatsApp strips EXIF and the name carries the send date — that date
    // is the one the file belongs under, so it outranks everything else.
    let whatsapp = crate::filename_date::read_whatsapp_date(path);

    let exif = if kind == FileKind::Image {
        crate::exif_date::read_datetime_original(path)
    } else if kind == FileKind::Email {
        // A mail carries its own send time in the `Date` header — that, not
        // the date of the .eml file on disk (which is when it was saved or
        // dragged out of the mail client), is where it belongs on the
        // timeline. Occupies the same "embedded metadata" slot as EXIF.
        email::parse_meta(path).ok().and_then(|meta| meta.date)
    } else {
        None
    };

    let filename = crate::filename_date::read_from_filename(path);

    let (auto_value, auto_source) = if let Some(whatsapp_dt) = &whatsapp {
        (whatsapp_dt.clone(), "filename")
    } else if let Some(exif_dt) = &exif {
        (exif_dt.clone(), "exif")
    } else if let Some(name_dt) = &filename {
        (name_dt.clone(), "filename")
    } else if let (Some(created), Some(modified)) = (fs_created, fs_modified) {
        if created.as_str() > modified.as_str() {
            (modified.clone(), "fs_modified")
        } else {
            (created.clone(), "fs_created")
        }
    } else if let Some(created) = fs_created {
        (created.clone(), "fs_created")
    } else if let Some(modified) = fs_modified {
        (modified.clone(), "fs_modified")
    } else {
        (chrono::Utc::now().to_rfc3339(), "fs_modified")
    };

    DateCandidates {
        exif,
        filename,
        fs_created: fs_created.clone(),
        fs_modified: fs_modified.clone(),
        auto_source: auto_source.to_string(),
        auto_value,
    }
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn is_pdf(path: &Path) -> bool {
    has_ext(path, "pdf")
}

fn is_legacy_doc(path: &Path) -> bool {
    has_ext(path, "doc")
}

/// Filename with its extension stripped, used as the legacy `.doc` title
/// everywhere (generated card image, pre-filled display name) — falls back
/// to the full filename if it has no extension to strip for some reason.
fn filename_without_extension(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
}

pub(crate) fn year_month(timestamp: &str) -> (String, String) {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| (format!("{:04}", dt.year()), format!("{:02}", dt.month())))
        .unwrap_or_else(|_| ("0000".to_string(), "00".to_string()))
}

use chrono::Datelike;

/// Reads the project's configured default video-frame percentage once, up
/// front, so the (CPU-bound, parallelizable) prepare phase never needs the
/// database connection at all.
pub fn default_video_frame_percent(conn: &Connection) -> f64 {
    settings::get(conn, DEFAULT_VIDEO_FRAME_PERCENT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(DEFAULT_VIDEO_FRAME_PERCENT)
}

pub(crate) fn quick_hash_on_ingest_enabled(conn: &Connection) -> bool {
    settings::get(conn, QUICK_HASH_ON_INGEST_KEY).ok().flatten().as_deref() == Some("true")
}

/// Sub-setting of `QUICK_HASH_ON_INGEST_KEY`: whether a newly inserted file
/// is only hashed once an existing live item already shares its exact size
/// and filename (the default), or unconditionally for every file regardless
/// of whether anything on file size/name even suggests a possible
/// duplicate. The prefilter costs nothing extra — size and filename are
/// already known from the file being imported, no content read — so it
/// only ever saves the 128KB `quick_hash` read for a file that has no
/// candidate to begin with. Turning it off trades that saving for also
/// catching a duplicate that was renamed along the way.
pub(crate) const QUICK_HASH_PREFILTER_KEY: &str = "quick_hash_use_prefilter";

pub(crate) fn quick_hash_prefilter_enabled(conn: &Connection) -> bool {
    settings::get(conn, QUICK_HASH_PREFILTER_KEY).ok().flatten().map(|v| v == "true").unwrap_or(true)
}

/// Decides, for each of `paths` about to be imported, whether "Beim
/// Einfügen auf Duplikate prüfen" should hash it — a per-path answer
/// because the prefilter sub-setting can rule individual files out, unlike
/// the plain on/off master setting. Returns an empty map when the master
/// setting is off; callers treat a missing path the same as `false`.
///
/// Pure metadata work (file size + name), never a content read, so running
/// it for the whole batch upfront costs nothing next to the hashing it
/// might save.
pub(crate) fn quick_hash_decisions(conn: &Connection, paths: &[String]) -> HashMap<String, bool> {
    if !quick_hash_on_ingest_enabled(conn) {
        return HashMap::new();
    }
    if !quick_hash_prefilter_enabled(conn) {
        return paths.iter().map(|p| (p.clone(), true)).collect();
    }
    paths
        .iter()
        .map(|path| {
            let has_candidate = std::fs::metadata(path)
                .ok()
                .and_then(|metadata| {
                    let name = Path::new(path).file_name()?.to_string_lossy().to_string();
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM items
                         WHERE removed_at IS NULL AND file_size_bytes = ?1 AND original_filename = ?2 COLLATE NOCASE)",
                        params![metadata.len() as i64, name],
                        |row| row.get::<_, bool>(0),
                    )
                    .ok()
                })
                .unwrap_or(false);
            (path.clone(), has_candidate)
        })
        .collect()
}

/// Copies a file into the project and generates its thumbnail: the part of
/// adding a file that touches the disk, and nothing else.
///
/// Shared by the import path (`prepare_item`) and by restoring a deleted
/// stream from its kept database, so there is exactly one definition of
/// where a file goes and how its preview is made. Those two must not drift
/// apart — a restored project whose thumbnails were generated differently
/// from an imported one would be a bug nobody notices until the previews
/// look wrong.
///
/// The year/month folders come from the item's own resolved timestamp, so
/// the project folder stays browsable in a normal file manager. The short
/// id prefix only prevents filename collisions within one month; it is
/// unrelated to the item's database id.
#[allow(clippy::too_many_arguments)]
pub(crate) fn copy_and_thumbnail(
    project_path: &Path,
    source_path: &Path,
    kind: FileKind,
    resolved_timestamp: &str,
    file_size_bytes: Option<u64>,
    fs_created: &Option<String>,
    fs_modified: &Option<String>,
    video_frame_percent: f64,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let original_filename = source_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or(crate::i18n::tr("Ungültiger Dateiname"))?;
    let (year, month) = year_month(resolved_timestamp);
    let short_id = Uuid::new_v4().simple().to_string()[..8].to_string();

    let originals_dir = project_path.join("originals").join(&year).join(&month);
    std::fs::create_dir_all(&originals_dir).map_err(|e| crate::trf!("Konnte Zielordner nicht anlegen: {e}", e = e))?;
    let stored_path: PathBuf = originals_dir.join(format!("{short_id}_{original_filename}"));
    crate::safe_io::copy_durably(source_path, &stored_path).map_err(|e| crate::trf!("Konnte Datei nicht kopieren: {e}", e = e))?;

    let thumbnails_dir = project_path.join("thumbnails").join(&year).join(&month);

    // The decoders behind the thumbnail are where a broken file trips; a
    // failure (or panic) there must not leave the copy just made behind as
    // a file no row will ever point to.
    let thumbnail = crate::safe_io::catch_panic(|| make_thumbnail(
        source_path,
        kind,
        &thumbnails_dir,
        &short_id,
        file_size_bytes,
        fs_created,
        fs_modified,
        video_frame_percent,
    ));
    match thumbnail {
        Ok(thumbnail_path) => Ok((stored_path, thumbnail_path)),
        Err(e) => {
            let _ = std::fs::remove_file(&stored_path);
            remove_thumbnails_with_prefix(&thumbnails_dir, &short_id);
            Err(e)
        }
    }
}

/// Whatever a failed thumbnail run may have left in `thumbnails_dir` — every
/// rendition is named after the item's random `short_id`, so nothing else
/// can match.
fn remove_thumbnails_with_prefix(thumbnails_dir: &Path, short_id: &str) {
    let Ok(entries) = std::fs::read_dir(thumbnails_dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(short_id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_thumbnail(
    source_path: &Path,
    kind: FileKind,
    thumbnails_dir: &Path,
    short_id: &str,
    file_size_bytes: Option<u64>,
    fs_created: &Option<String>,
    fs_modified: &Option<String>,
    video_frame_percent: f64,
) -> Result<Option<PathBuf>, String> {
    let thumbnail_path: Option<PathBuf> = match kind {
        FileKind::Image => {
            let dest = thumbnails_dir.join(format!("{short_id}.jpg"));
            preview::store_image_thumbnail(source_path, &dest)?;
            Some(dest)
        }
        FileKind::Video => {
            let dest = thumbnails_dir.join(format!("{short_id}.jpg"));
            video_preview::extract_frame(source_path, video_frame_percent, &dest)?;
            Some(dest)
        }
        // Only PDFs get a real rendered page preview (via PDFium).
        // docx/odt/rtf/txt have no thumbnail at all — same as audio — and
        // show their full extracted text in the viewer instead (see
        // `extracted_text` in `prepare_item`). Legacy `.doc` gets a
        // generated placeholder card (filename + metadata) since it can't
        // be parsed at all without a real OLE-file reader.
        FileKind::Document if is_pdf(source_path) => {
            let dest_prefix = thumbnails_dir.join(short_id);
            Some(pdf_preview::render_first_page(source_path, &dest_prefix)?)
        }
        FileKind::Document if is_legacy_doc(source_path) => {
            let dest = thumbnails_dir.join(format!("{short_id}.jpg"));
            let meta = doc_card::DocMetadata {
                size_bytes: file_size_bytes,
                fs_created: fs_created.clone(),
                fs_modified: fs_modified.clone(),
            };
            doc_card::render_doc_card(&filename_without_extension(source_path), &meta, &dest)?;
            Some(dest)
        }
        FileKind::Document | FileKind::Audio | FileKind::Email | FileKind::Other => None,
    };

    Ok(thumbnail_path)
}

/// Copies the file, resolves its timestamp, and generates a thumbnail —
/// no database access, safe to run concurrently for several files at once.
///
/// `date_override` carries the timestamp the user explicitly chose on the
/// review screen (value + which source it came from). `None` keeps the
/// automatic resolution, which is what the plain add-to-project flow uses.
///
/// `compute_quick_hash` is the "Quick-Hash beim Einfügen"-Einstellung
/// (`quick_hash_on_ingest_enabled`), read once by the caller and passed in
/// rather than read from a `Connection` here — this function runs on a
/// parallel worker thread in every batch-import caller, and `Connection`
/// isn't `Sync`.
pub fn prepare_item(
    project_path: &Path,
    source_path: &Path,
    video_frame_percent_default: f64,
    date_override: Option<(String, String)>,
    compute_quick_hash: bool,
) -> Result<PreparedItem, String> {
    // Last line of defence for a parser panicking on a broken file (EXIF,
    // date sniffing): this file fails with an error, its batch goes on.
    crate::safe_io::catch_panic(|| {
        prepare_item_unguarded(project_path, source_path, video_frame_percent_default, date_override, compute_quick_hash)
    })
}

fn prepare_item_unguarded(
    project_path: &Path,
    source_path: &Path,
    video_frame_percent_default: f64,
    date_override: Option<(String, String)>,
    compute_quick_hash: bool,
) -> Result<PreparedItem, String> {
    let kind = fsbrowse::classify(source_path);
    if !fsbrowse::can_add(source_path, kind) {
        return Err(
            crate::i18n::tr("Für diesen Dateityp kann aktuell noch keine Vorschau erzeugt werden, daher kann die Datei noch nicht hinzugefügt werden.").to_string(),
        );
    }

    let original_filename = source_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or(crate::i18n::tr("Ungültiger Dateiname"))?;

    let (fs_created, fs_modified) = fs_times(source_path);
    let candidates = compute_date_candidates(source_path, kind, &fs_created, &fs_modified);
    let (resolved_timestamp, timestamp_source) =
        date_override.unwrap_or_else(|| (candidates.auto_value.clone(), candidates.auto_source.clone()));
    let file_size_bytes = std::fs::metadata(source_path).ok().map(|m| m.len());

    let id = Uuid::new_v4();

    let video_frame_percent = if kind == FileKind::Video {
        Some(video_frame_percent_default)
    } else {
        None
    };

    let (stored_path, thumbnail_path) = copy_and_thumbnail(
        project_path,
        source_path,
        kind,
        &resolved_timestamp,
        file_size_bytes,
        &fs_created,
        &fs_modified,
        video_frame_percent_default,
    )?;

    // Best-effort: a file that fails to parse (unusual encoding, corrupt
    // file, ...) still gets added — it just won't have a text viewer, same
    // as a photo with no readable EXIF still gets added with a fs-date
    // fallback. A parser that panics counts as failing to parse; caught
    // here, after the copy, so it can't leave that copy orphaned.
    let extracted_text = crate::safe_io::catch_panic(|| {
        Ok(if kind == FileKind::Document && is_pdf(source_path) {
            pdf_preview::extract_text(source_path).ok()
        } else if kind == FileKind::Document && !is_legacy_doc(source_path) {
            doc_text::extract_text(source_path).ok()
        } else if kind == FileKind::Email {
            email::extract_plain_text(source_path).ok()
        } else {
            None
        })
    })
    .ok()
    .flatten()
    .filter(|t| !t.is_empty());

    let (email_subject, email_sender, email_date) = if kind == FileKind::Email {
        match crate::safe_io::catch_panic(|| email::parse_meta(source_path)) {
            Ok(meta) => (meta.subject, meta.sender, meta.date),
            Err(_) => (None, None, None),
        }
    } else {
        (None, None, None)
    };

    let source_folder_path = source_path.parent().map(|p| p.to_string_lossy().to_string());

    // Same "best-effort, never blocks the add" reasoning as `extracted_text`
    // above — a file whose hash can't be read still gets added normally.
    let quick_hash = if compute_quick_hash { crate::duplicate_hash::quick_hash(&stored_path).ok() } else { None };

    Ok(PreparedItem {
        id,
        original_filename,
        stored_path,
        thumbnail_path,
        kind,
        resolved_timestamp,
        timestamp_source,
        fs_created,
        fs_modified,
        source_path: source_path.to_string_lossy().to_string(),
        source_folder_path,
        video_frame_percent,
        extracted_text,
        file_size_bytes,
        exif_candidate: candidates.exif,
        email_subject,
        email_sender,
        email_date,
        quick_hash,
    })
}

/// Whether `source_path` is already a live item of the project — the
/// import's "skip, already there" check.
pub(crate) fn source_already_added(conn: &Connection, source_path: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE source_path = ?1 AND removed_at IS NULL)",
        params![source_path],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

impl PreparedItem {
    /// The files `prepare_item` created inside the project folder.
    pub(crate) fn stored_files(&self) -> Vec<PathBuf> {
        std::iter::once(self.stored_path.clone()).chain(self.thumbnail_path.clone()).collect()
    }
}

/// Removes the copies of a prepared item that will never be committed (the
/// project was closed meanwhile, or the file got added by another import).
pub(crate) fn remove_stored_files(files: &[PathBuf]) {
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

/// Inserts an already-`prepare_item`'d file into the database. Fast (no
/// decode/copy work left), meant to run sequentially on the thread that
/// owns the connection after a batch has been prepared in parallel.
pub fn commit_prepared_item(
    conn: &Connection,
    prepared: PreparedItem,
    import_batch_id: Option<&str>,
    rotation: i32,
) -> Result<AddedItem, String> {
    conn.execute(
        "INSERT INTO items (
            id, original_filename, stored_path, thumbnail_path, file_type,
            resolved_timestamp, timestamp_source, fs_created_at, fs_modified_at,
            embedded_metadata_at, source_path, source_folder_path, import_batch_id, added_at,
            video_frame_percent, extracted_text, file_size_bytes, rotation,
            email_subject, email_sender, email_date
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            prepared.id.to_string(),
            prepared.original_filename,
            prepared.stored_path.to_string_lossy().to_string(),
            prepared.thumbnail_path.map(|p| p.to_string_lossy().to_string()),
            kind_str(prepared.kind),
            prepared.resolved_timestamp,
            prepared.timestamp_source,
            prepared.fs_created,
            prepared.fs_modified,
            // Recorded whenever the file actually has an embedded date, not
            // just when that date won the priority chain — otherwise picking
            // a filesystem date on the review screen would silently discard
            // the EXIF value this column exists to preserve.
            prepared.exif_candidate,
            prepared.source_path,
            prepared.source_folder_path,
            import_batch_id,
            chrono::Utc::now().to_rfc3339(),
            prepared.video_frame_percent,
            prepared.extracted_text,
            prepared.file_size_bytes,
            rotation,
            prepared.email_subject,
            prepared.email_sender,
            prepared.email_date,
        ],
    )
    .map_err(|e| crate::trf!("Konnte Eintrag nicht speichern: {e}", e = e))?;

    // The hash itself was already computed in `prepare_item` (on a parallel
    // worker, see `compute_quick_hash` there) — this is just the cheap write
    // of an already-known value, not a file read.
    if let Some(hash) = prepared.quick_hash {
        crate::duplicate_hash::store_quick_hash(conn, &prepared.id.to_string(), hash);
    }

    Ok(AddedItem {
        id: prepared.id.to_string(),
        original_filename: prepared.original_filename,
        kind: prepared.kind,
        resolved_timestamp: prepared.resolved_timestamp,
        timestamp_source: prepared.timestamp_source,
    })
}

/// Refreshes only the file-derived columns of an *existing* row from a
/// freshly `prepare_item`'d copy — used by `restore_from_source` (see
/// `action_log_commands.rs`) when a removal's in-project copy was deleted
/// (the "Dateien beim Entfernen löschen" setting) and undoing it re-copies
/// the file from its original source location. Everything else about the
/// item — its date, timestamp source, rotation, display name — is left
/// untouched; `prepare_item`'s `date_override` is what keeps the date from
/// drifting in the first place.
///
/// The cached fingerprints go, as in `swap_item_file_prepared`: the source
/// may have changed since it was first imported, and "Archiv prüfen" would
/// otherwise report the fresh copy as damaged.
pub fn update_restored_item_files(conn: &Connection, item_id: &str, prepared: PreparedItem) -> Result<(), String> {
    let quick_hash = prepared.quick_hash;
    conn.execute(
        "UPDATE items SET stored_path = ?1, thumbnail_path = ?2, file_size_bytes = ?3,
                           video_frame_percent = ?4, extracted_text = ?5, removed_at = NULL
         WHERE id = ?6",
        params![
            prepared.stored_path.to_string_lossy().to_string(),
            prepared.thumbnail_path.map(|p| p.to_string_lossy().to_string()),
            prepared.file_size_bytes,
            prepared.video_frame_percent,
            prepared.extracted_text,
            item_id,
        ],
    )
    .map_err(|e| crate::trf!("Konnte Eintrag nicht wiederherstellen: {e}", e = e))?;
    let _ = conn.execute("DELETE FROM item_hashes WHERE item_id = ?1", params![item_id]);
    if let Some(hash) = quick_hash {
        crate::duplicate_hash::store_quick_hash(conn, item_id, hash);
    }
    Ok(())
}

/// Swaps the file behind an *existing* item for `new_file`, keeping
/// everything else about the item (date and its source, rotation, display
/// name, notes, `source_path`, original filename) exactly as it was.
///
/// The new file is copied in and thumbnailed first (`prepare_item`, with the
/// item's own date passed as override so a compressed file that lost its
/// EXIF cannot move the item); only when that succeeded is the row updated
/// and the old in-project copy deleted, so a failure leaves the old file
/// untouched. The cached hashes belong to the old content and are dropped.
///
/// Shared by "Datei im Stream ersetzen" and by undoing it (where
/// `new_file` is the item's original source file), which keeps the swap
/// logic in one place. `removed_at` is deliberately left alone.
pub fn swap_item_file(conn: &Connection, project_path: &Path, item_id: &str, new_file: &Path) -> Result<(), String> {
    let inputs = swap_inputs(conn, item_id)?;
    let prepared = inputs.prepare(project_path, new_file)?;
    swap_item_file_prepared(conn, project_path, item_id, prepared)
}

/// What preparing a replacement file for an item needs from the database —
/// read under the project lock, so the slow part (`prepare`: copying,
/// thumbnailing) can run without it.
pub(crate) struct SwapInputs {
    date: (String, String),
    video_frame_percent: f64,
    compute_quick_hash: bool,
}

impl SwapInputs {
    /// Copies `new_file` in and makes its thumbnail, with the item's own date
    /// passed as override so a compressed file that lost its EXIF cannot
    /// move the item. No database access.
    pub(crate) fn prepare(self, project_path: &Path, new_file: &Path) -> Result<PreparedItem, String> {
        prepare_item(project_path, new_file, self.video_frame_percent, Some(self.date), self.compute_quick_hash)
    }
}

pub(crate) fn swap_inputs(conn: &Connection, item_id: &str) -> Result<SwapInputs, String> {
    let row: Option<(String, String, Option<f64>)> = conn
        .query_row(
            "SELECT resolved_timestamp, timestamp_source, video_frame_percent FROM items WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((resolved_timestamp, timestamp_source, video_frame_percent)) = row else {
        return Err(crate::i18n::tr("Eintrag nicht gefunden.").to_string());
    };
    Ok(SwapInputs {
        date: (resolved_timestamp, timestamp_source),
        video_frame_percent: video_frame_percent.unwrap_or_else(|| default_video_frame_percent(conn)),
        compute_quick_hash: quick_hash_on_ingest_enabled(conn),
    })
}

/// The database half of `swap_item_file`, for a replacement already
/// prepared: points the row at the new file and only then deletes the old
/// copy. On any failure the prepared files are removed again and the old
/// file is untouched.
pub(crate) fn swap_item_file_prepared(
    conn: &Connection,
    project_path: &Path,
    item_id: &str,
    prepared: PreparedItem,
) -> Result<(), String> {
    let new_stored = prepared.stored_path.to_string_lossy().to_string();
    let new_thumb = prepared.thumbnail_path.as_ref().map(|p| p.to_string_lossy().to_string());
    let discard_new = || crate::project_files::remove_item_files(project_path, &new_stored, new_thumb.as_deref());

    let old: Option<(String, Option<String>)> = match conn
        .query_row(
            "SELECT stored_path, thumbnail_path FROM items WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    {
        Ok(old) => old,
        Err(e) => {
            discard_new();
            return Err(e.to_string());
        }
    };
    let Some((old_stored, old_thumb)) = old else {
        discard_new();
        return Err(crate::i18n::tr("Eintrag nicht gefunden.").to_string());
    };

    let updated = conn.execute(
        "UPDATE items SET stored_path = ?1, thumbnail_path = ?2, file_size_bytes = ?3, file_type = ?4,
                           video_frame_percent = ?5, extracted_text = ?6
         WHERE id = ?7",
        params![
            new_stored,
            new_thumb,
            prepared.file_size_bytes,
            kind_str(prepared.kind),
            prepared.video_frame_percent,
            prepared.extracted_text,
            item_id,
        ],
    );
    if let Err(e) = updated {
        discard_new();
        return Err(crate::trf!("Konnte Eintrag nicht aktualisieren: {e}", e = e));
    }

    let _ = conn.execute("DELETE FROM item_hashes WHERE item_id = ?1", params![item_id]);
    if let Some(hash) = prepared.quick_hash {
        crate::duplicate_hash::store_quick_hash(conn, item_id, hash);
    }

    if old_stored != new_stored {
        crate::project_files::remove_item_files(project_path, &old_stored, old_thumb.as_deref());
    }
    Ok(())
}

pub(crate) fn kind_str(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Image => "image",
        FileKind::Video => "video",
        FileKind::Audio => "audio",
        FileKind::Document => "document",
        FileKind::Email => "email",
        FileKind::Other => "other",
    }
}

/// Returns the set of already-imported source paths, so the browser can
/// show an "already added" badge instead of letting the user add the same
/// file twice unknowingly (duplicate attempts are otherwise just refused
/// with a warning per the project decisions).
pub fn list_added_source_paths(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT source_path FROM items WHERE source_path IS NOT NULL AND removed_at IS NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
