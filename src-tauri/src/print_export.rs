use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ToSql};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::preview;
use crate::settings;
use crate::state::AppStateHandle;

const PROGRESS_EVENT: &str = "print-export-progress";
/// Last target folder the user exported into, remembered per project so the
/// staging folder is pre-filled the next time the tab is opened.
const TARGET_FOLDER_KEY: &str = "print_export_target_folder";
/// Re-encode quality for the (rare) rotated images — high enough that a
/// print of it is indistinguishable from the original, which is the whole
/// point of this feature.
const ROTATED_JPEG_QUALITY: u8 = 95;
/// Safety net against a pathological folder (or a bug) spinning forever
/// while looking for a free " (n)" suffix.
const MAX_NAME_ATTEMPTS: u32 = 9999;

/// One image offered in the print-export list: the item's own data plus
/// whether it is currently ticked and whether it has already been written
/// into a target folder before.
#[derive(Serialize, Clone, Debug)]
pub struct PrintCandidate {
    pub id: String,
    pub original_filename: String,
    pub display_name: Option<String>,
    pub stored_path: String,
    pub thumbnail_path: Option<String>,
    pub resolved_timestamp: String,
    pub timestamp_source: String,
    pub added_at: String,
    pub file_size_bytes: Option<u64>,
    pub rotation: i32,
    pub selected: bool,
    pub exported_at: Option<String>,
    pub exported_file_name: Option<String>,
    pub exported_folder: Option<String>,
}

/// Images only — this is explicitly a photo-print workflow, so videos,
/// audio and documents are never listed. Driven from `items` with the
/// print tables LEFT JOINed on, which also means a leftover row for an
/// item that was since removed from the project simply never shows up.
#[tauri::command(async)]
pub fn list_print_candidates(state: State<AppStateHandle>) -> Result<Vec<PrintCandidate>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let mut stmt = current
        .conn
        .prepare(
            "SELECT i.id, i.original_filename, i.display_name, i.stored_path, i.thumbnail_path,
                    i.resolved_timestamp, i.timestamp_source, i.added_at, i.file_size_bytes, i.rotation,
                    s.item_id IS NOT NULL, e.exported_at, e.file_name, e.target_folder
             FROM items i
             LEFT JOIN print_selection s ON s.item_id = i.id
             LEFT JOIN print_exports e ON e.item_id = i.id
             WHERE i.file_type = 'image' AND i.removed_at IS NULL
             -- Text order would mis-sort mixed UTC offsets, and this
             -- order is visible: it decides which of two photos from the
             -- same minute keeps the plain filename and which gets the
             -- (2) suffix.
             -- See `timeline_commands::list_items`.
             ORDER BY datetime(i.resolved_timestamp) ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PrintCandidate {
                id: row.get(0)?,
                original_filename: row.get(1)?,
                display_name: row.get(2)?,
                stored_path: row.get(3)?,
                thumbnail_path: row.get(4)?,
                resolved_timestamp: row.get(5)?,
                timestamp_source: row.get(6)?,
                added_at: row.get(7)?,
                file_size_bytes: row.get::<_, Option<i64>>(8)?.map(|v| v as u64),
                rotation: row.get(9)?,
                selected: row.get(10)?,
                exported_at: row.get(11)?,
                exported_file_name: row.get(12)?,
                exported_folder: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Replaces the whole ticked set in one transaction rather than diffing it —
/// the frontend always knows the complete selection, and "replace" can't
/// drift out of sync the way incremental add/remove calls can.
#[tauri::command(async)]
pub fn set_print_selection(state: State<AppStateHandle>, ids: Vec<String>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;

    let tx = current
        .conn
        .transaction()
        .map_err(|e| crate::trf!("Konnte Auswahl nicht speichern: {e}", e = e))?;
    tx.execute("DELETE FROM print_selection", [])
        .map_err(|e| crate::trf!("Konnte Auswahl nicht speichern: {e}", e = e))?;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO print_selection (item_id) VALUES (?1)")
            .map_err(|e| crate::trf!("Konnte Auswahl nicht speichern: {e}", e = e))?;
        for id in &ids {
            stmt.execute(params![id])
                .map_err(|e| crate::trf!("Konnte Auswahl nicht speichern: {e}", e = e))?;
        }
    }
    tx.commit().map_err(|e| crate::trf!("Konnte Auswahl nicht speichern: {e}", e = e))?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_print_export_target(state: State<AppStateHandle>) -> Result<Option<String>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    settings::get(&current.conn, TARGET_FOLDER_KEY)
}

/// Forgets which images were already handed off, so a new print run starts
/// from a clean slate. Never touches files in the target folder.
#[tauri::command(async)]
pub fn clear_print_export_history(state: State<AppStateHandle>) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    current
        .conn
        .execute("DELETE FROM print_exports", [])
        .map_err(|e| crate::trf!("Konnte Export-Historie nicht löschen: {e}", e = e))?;
    Ok(())
}

/// One image to export, with the filename the frontend derived from its
/// timeline date. The *name* is built in the frontend on purpose: it has to
/// follow the selected UI language's date format (de/en/es), and the chosen
/// language lives there (see `src/utils/printFilename.ts`).
#[derive(Deserialize, Debug, Clone)]
pub struct PrintExportEntry {
    pub id: String,
    /// Filename without extension, already locale-formatted. Still
    /// sanitized here — a value arriving from the frontend must never be
    /// able to steer the write outside the chosen folder.
    pub base_name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PrintExportFailure {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PrintExportSummary {
    pub exported: usize,
    pub failed: Vec<PrintExportFailure>,
    pub target_folder: String,
}

#[derive(Serialize, Clone)]
struct PrintExportProgress {
    done: usize,
    total: usize,
    current: String,
}

/// Strips everything that isn't safe in a filename on Windows/macOS/Linux.
/// The frontend's formatter already avoids these, so this is purely a
/// belt-and-braces guard against a crafted/buggy `base_name` — in
/// particular path separators and `..`.
///
/// Commas are turned into hyphens rather than dropped: they are legal in a
/// filename but travel badly (CSV manifests, shell one-liners, print
/// service upload forms all read them as separators). Enforced here, at the
/// one place that actually writes files, so it holds no matter which caller
/// built the name.
fn sanitize_base_name(name: &str) -> String {
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = name
        .chars()
        .filter(|c| !INVALID.contains(c) && !c.is_control())
        .map(|c| if c == ',' { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "Bild".to_string()
    } else {
        cleaned
    }
}

/// Finds a free name in `dir`, appending " - 2", " - 3", … on collision.
/// Collisions are expected and normal here: the target folder is a staging
/// area that already holds earlier exports, and several photos can share
/// the same minute.
fn unique_path(dir: &Path, base: &str, ext: &str) -> Result<PathBuf, String> {
    let candidate = dir.join(format!("{base}.{ext}"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for n in 2..=MAX_NAME_ATTEMPTS {
        let candidate = dir.join(format!("{base} - {n}.{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(crate::i18n::tr("Zu viele Dateien mit diesem Namen im Zielordner.").to_string())
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "jpg".to_string())
}

/// Target extension for an export. Unrotated images keep their own (they
/// are copied byte for byte); rotated ones are re-encoded, and PNG stays
/// PNG (lossless, may carry transparency) while everything else becomes
/// JPEG — the format every print service accepts.
fn export_extension(source: &Path, rotation: i32) -> String {
    let ext = extension_of(source);
    if rotation == 0 {
        ext
    } else if ext == "png" {
        "png".to_string()
    } else {
        "jpg".to_string()
    }
}

/// Writes `source` to `dest` with the item's manual rotation burnt into the
/// pixels.
///
/// Needed because the rotation the user set in CronoStream lives only in the
/// database — it is a display-time transform, the stored file is never
/// touched (see `rotate_item`). A print service just prints the pixels it
/// receives, so a photo corrected in the app would otherwise come back
/// sideways. The file's EXIF orientation is applied first, exactly as the
/// app's own viewer does (browser orientation handling + manual rotation on
/// top), and the result is written without an orientation tag — so it is
/// correct whether or not the receiving side honours EXIF.
fn write_rotated(source: &Path, rotation: i32, dest: &Path) -> Result<(), String> {
    let img = crate::preview::open_image(source)?;
    let img = preview::apply_orientation(img, preview::read_orientation(source));
    let img = match ((rotation % 360) + 360) % 360 {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };

    if extension_of(dest) == "png" {
        img.save(dest).map_err(|e| crate::trf!("Konnte Bild nicht schreiben: {e}", e = e))?;
        return Ok(());
    }

    let file = std::fs::File::create(dest).map_err(|e| crate::trf!("Konnte Bild nicht schreiben: {e}", e = e))?;
    let mut writer = std::io::BufWriter::new(file);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, ROTATED_JPEG_QUALITY);
    // JPEG has no alpha channel — flatten to RGB8 rather than letting the
    // encoder reject an RGBA source outright.
    encoder
        .encode_image(&image::DynamicImage::ImageRgb8(img.to_rgb8()))
        .map_err(|e| crate::trf!("Konnte Bild nicht schreiben: {e}", e = e))?;
    Ok(())
}

struct ResolvedEntry {
    id: String,
    base_name: String,
    stored_path: String,
    rotation: i32,
    /// Filename this item already occupies in *this* target folder from an
    /// earlier run, if that file is still there.
    previous_file_name: Option<String>,
}

fn resolve_entries(
    conn: &Connection,
    entries: &[PrintExportEntry],
    dest: &Path,
) -> Result<Vec<ResolvedEntry>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&String> = entries.iter().map(|e| &e.id).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, stored_path, rotation FROM items WHERE id IN ({placeholders}) AND removed_at IS NULL"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn ToSql> = ids.iter().map(|id| *id as &dyn ToSql).collect();
    let mut found = std::collections::HashMap::new();
    let rows = stmt
        .query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i32>(2)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, stored_path, rotation) = row.map_err(|e| e.to_string())?;
        found.insert(id, (stored_path, rotation));
    }

    // Re-exporting an image the user already sent to this same folder must
    // replace that file, not drop a second copy next to it — the folder is
    // a hand-off pile for a print service, and a stray duplicate there
    // means a photo gets printed twice.
    let mut previous = std::collections::HashMap::new();
    let dest_folder = dest.to_string_lossy().to_string();
    let mut stmt = conn
        .prepare("SELECT item_id, file_name FROM print_exports WHERE target_folder = ?1")
        .map_err(|e| e.to_string())?;
    let history = stmt
        .query_map(params![dest_folder], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in history {
        let (item_id, file_name) = row.map_err(|e| e.to_string())?;
        if dest.join(&file_name).is_file() {
            previous.insert(item_id, file_name);
        }
    }

    // Keeps the frontend's order (which is the order shown in the list, so
    // the user can predict which photo gets the plain name and which gets
    // the " - 2" suffix).
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let (stored_path, rotation) = found.get(&entry.id)?.clone();
            Some(ResolvedEntry {
                id: entry.id.clone(),
                base_name: sanitize_base_name(&entry.base_name),
                stored_path,
                rotation,
                previous_file_name: previous.get(&entry.id).cloned(),
            })
        })
        .collect())
}

/// Copies every selected image into `dest_folder` under its locale-formatted
/// date filename, remembers what was written, and reports per-file failures
/// instead of aborting the whole run on the first bad file.
#[tauri::command]
pub async fn run_print_export(
    app: AppHandle,
    entries: Vec<PrintExportEntry>,
    dest_folder: String,
) -> Result<PrintExportSummary, String> {
    // Copying (and occasionally re-encoding) a few hundred full-resolution
    // photos is real I/O + CPU work — off the IPC thread with it, same
    // reasoning as `add_items`.
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_folder);
        if !dest.is_dir() {
            return Err(crate::i18n::tr("Der Zielordner existiert nicht.").to_string());
        }

        // The state lock covers only resolving the entries and, at the
        // end, writing down what was exported — not the copying and
        // re-encoding in between, which would otherwise stall every other
        // command (closing the app included) for the whole run. Same
        // pattern as `transfer_items`.
        let state = app.state::<AppStateHandle>();
        let (project_path, resolved) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let mut entries = entries;
            if let Some(hidden) = crate::privacy::hidden_ids(current, crate::privacy::Surface::Everywhere)? {
                entries.retain(|entry| !hidden.contains(&entry.id));
            }
            (current.path.clone(), resolve_entries(&current.conn, &entries, &dest)?)
        };
        let total = resolved.len();
        // (item id, written file name), recorded once the lock is back.
        let mut written: Vec<(String, String)> = Vec::new();
        let now = chrono::Local::now().to_rfc3339();

        let mut exported = 0usize;
        let mut failed = Vec::new();

        for (index, entry) in resolved.iter().enumerate() {
            let source = Path::new(&entry.stored_path);
            let ext = export_extension(source, entry.rotation);
            // An earlier export of this very image into this very folder is
            // overwritten under its existing name; everything else gets a
            // fresh, collision-free name. The extension has to still match
            // — if the item's rotation changed since, the file format does
            // too, and the old name would then lie about its contents.
            let reusable = entry
                .previous_file_name
                .as_ref()
                .map(|name| dest.join(name))
                .filter(|path| extension_of(path) == ext);
            if reusable.is_none() {
                if let Some(stale) = &entry.previous_file_name {
                    let _ = std::fs::remove_file(dest.join(stale));
                }
            }
            let overwriting = reusable.is_some();
            let target = match reusable {
                Some(target) => target,
                None => match unique_path(&dest, &entry.base_name, &ext) {
                    Ok(target) => target,
                    Err(reason) => {
                        failed.push(PrintExportFailure {
                            id: entry.id.clone(),
                            name: entry.base_name.clone(),
                            reason,
                        });
                        continue;
                    }
                },
            };

            let result = if entry.rotation == 0 {
                std::fs::copy(source, &target)
                    .map(|_| ())
                    .map_err(|e| crate::trf!("Konnte Datei nicht kopieren: {e}", e = e))
            } else {
                write_rotated(source, entry.rotation, &target)
            };

            match result {
                Ok(()) => {
                    exported += 1;
                    let file_name = target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| entry.base_name.clone());
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        PrintExportProgress {
                            done: index + 1,
                            total,
                            current: file_name.clone(),
                        },
                    );
                    written.push((entry.id.clone(), file_name));
                }
                Err(reason) => {
                    // A half-written file would look like a successful
                    // export to the user browsing the folder — unless the
                    // write was replacing an earlier export, where the
                    // partial file is still the lesser evil compared with
                    // silently removing a photo the folder already had.
                    if !overwriting {
                        let _ = std::fs::remove_file(&target);
                    }
                    failed.push(PrintExportFailure {
                        id: entry.id.clone(),
                        name: entry.base_name.clone(),
                        reason,
                    });
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        PrintExportProgress {
                            done: index + 1,
                            total,
                            current: entry.base_name.clone(),
                        },
                    );
                }
            }
        }

        let guard = crate::state::lock_project(&state, &project_path)?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        for (item_id, file_name) in &written {
            let _ = current.conn.execute(
                "INSERT INTO print_exports (item_id, exported_at, target_folder, file_name)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(item_id) DO UPDATE SET
                    exported_at = excluded.exported_at,
                    target_folder = excluded.target_folder,
                    file_name = excluded.file_name",
                params![item_id, now, dest_folder, file_name],
            );
        }
        settings::set(&current.conn, TARGET_FOLDER_KEY, &dest_folder)?;

        Ok(PrintExportSummary {
            exported,
            failed,
            target_folder: dest_folder,
        })
    })
    .await
    .map_err(|e| crate::trf!("Export fehlgeschlagen: {e}", e = e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_separators_and_traversal() {
        assert_eq!(sanitize_base_name("09.10.2026 - 14.30 Uhr"), "09.10.2026 - 14.30 Uhr");
        // A comma never survives into a written filename, whoever built it.
        assert_eq!(sanitize_base_name("09.10.2026, 14.30 Uhr"), "09.10.2026- 14.30 Uhr");
        assert_eq!(sanitize_base_name("../../etc/passwd"), "....etcpasswd");
        assert_eq!(sanitize_base_name("a:b|c?d*e\"f<g>h"), "abcdefgh");
        assert_eq!(sanitize_base_name("   "), "Bild");
        assert_eq!(sanitize_base_name("/"), "Bild");
        assert_eq!(sanitize_base_name(".."), "Bild");
    }

    #[test]
    fn unique_path_appends_counter_on_collision() {
        let dir = std::env::temp_dir().join(format!("cronostream-print-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let first = unique_path(&dir, "09.10.2026 - 14.30 Uhr", "jpg").unwrap();
        assert_eq!(first.file_name().unwrap(), "09.10.2026 - 14.30 Uhr.jpg");
        std::fs::write(&first, b"x").unwrap();

        let second = unique_path(&dir, "09.10.2026 - 14.30 Uhr", "jpg").unwrap();
        assert_eq!(second.file_name().unwrap(), "09.10.2026 - 14.30 Uhr - 2.jpg");
        std::fs::write(&second, b"x").unwrap();

        let third = unique_path(&dir, "09.10.2026 - 14.30 Uhr", "jpg").unwrap();
        assert_eq!(third.file_name().unwrap(), "09.10.2026 - 14.30 Uhr - 3.jpg");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unrotated_keeps_extension_rotated_normalizes_it() {
        assert_eq!(export_extension(Path::new("a/b.tiff"), 0), "tiff");
        assert_eq!(export_extension(Path::new("a/b.JPG"), 0), "jpg");
        assert_eq!(export_extension(Path::new("a/b.tiff"), 90), "jpg");
        assert_eq!(export_extension(Path::new("a/b.png"), 180), "png");
        assert_eq!(export_extension(Path::new("a/b"), 0), "jpg");
    }

    /// The whole point of the rotated path: the exported pixels must come
    /// out the way the app displays them, which for 90/270° means the
    /// width and height swap.
    #[test]
    fn write_rotated_swaps_dimensions_at_90_degrees() {
        let dir = std::env::temp_dir().join(format!("cronostream-print-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.png");
        image::RgbImage::new(40, 10).save(&source).unwrap();

        let rotated = dir.join("rotated.jpg");
        write_rotated(&source, 90, &rotated).unwrap();
        let (w, h) = image::image_dimensions(&rotated).unwrap();
        assert_eq!((w, h), (10, 40));

        let upright = dir.join("upright.jpg");
        write_rotated(&source, 180, &upright).unwrap();
        assert_eq!(image::image_dimensions(&upright).unwrap(), (40, 10));

        // PNG source + PNG target stays lossless rather than silently
        // becoming a JPEG.
        let as_png = dir.join("rotated.png");
        write_rotated(&source, 270, &as_png).unwrap();
        assert_eq!(image::image_dimensions(&as_png).unwrap(), (10, 40));
        assert_eq!(image::ImageReader::open(&as_png).unwrap().format(), Some(image::ImageFormat::Png));

        std::fs::remove_dir_all(&dir).ok();
    }
}
