use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::{Condvar, Mutex, OnceLock};

use base64::Engine;
use fast_image_resize::{ResizeAlg, ResizeOptions, Resizer};

use crate::{doc_card, pdf_preview, video_preview};

const BROWSE_PREVIEW_MAX_DIM: u32 = 480;
const STORED_THUMBNAIL_MAX_DIM: u32 = 640;
/// Comfortably above any current display's short edge, so the single-image
/// view never looks soft, while still being a fraction of a modern camera
/// original's pixel count (and of the base64 payload shipping it would cost).
pub const FULL_PREVIEW_MAX_DIM: u32 = 2048;
/// The file browser's side preview panel is 560 CSS px wide by default and
/// stays under ~1000 even dragged right out, so serving it the 2048 tier
/// above meant paying for roughly four times the pixels it could ever
/// show — in resize, in JPEG encode, in base64 payload and in webview
/// decode. It gets its own tier instead.
pub const GRID_PREVIEW_MAX_DIM: u32 = 1280;

/// Snaps a frontend-requested preview size onto one of the two tiers above,
/// so a stray value can't fragment the on-disk cache into a dozen
/// near-identical renditions of every photo.
pub fn clamp_full_preview_dim(requested: Option<u32>) -> u32 {
    match requested {
        Some(dim) if dim <= GRID_PREVIEW_MAX_DIM => GRID_PREVIEW_MAX_DIM,
        _ => FULL_PREVIEW_MAX_DIM,
    }
}

/// How many full-resolution decodes may run at once. This used to be
/// unbounded: every click spawned its own blocking task, so clicking
/// through a folder of 24 MP photos could leave half a dozen full decodes
/// in flight simultaneously, each holding its own uncompressed copy of the
/// image — and the one the user was actually waiting on then crawled behind
/// the others' CPU and memory pressure. Two slots keep a second core busy
/// (decode and resize are each single-threaded) while still bounding peak
/// memory; the single-image view prefetches with concurrency 1, so the
/// image on screen can never be pushed more than one slot back.
const FULL_PREVIEW_PARALLELISM: usize = 2;

fn full_preview_slots() -> &'static (Mutex<usize>, Condvar) {
    static SLOTS: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();
    SLOTS.get_or_init(|| (Mutex::new(FULL_PREVIEW_PARALLELISM), Condvar::new()))
}

/// Returns the slot even if the work it guards panics.
struct SlotGuard;

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let (lock, condvar) = full_preview_slots();
        let mut free = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *free += 1;
        condvar.notify_one();
    }
}

/// Runs `work` holding one of the slots above, blocking until one frees up.
/// Deliberately *not* wrapped around the cache lookup that precedes it at
/// the call site: a cache hit has to stay instant even while two decodes
/// are grinding away.
pub fn with_full_preview_slot<T>(work: impl FnOnce() -> T) -> T {
    let (lock, condvar) = full_preview_slots();
    let mut free = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    while *free == 0 {
        free = condvar.wait(free).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    *free -= 1;
    drop(free);
    let _guard = SlotGuard;
    work()
}

pub fn jpeg_bytes_to_data_url(bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:image/jpeg;base64,{encoded}")
}

fn read_as_jpeg_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| crate::trf!("Konnte Vorschau nicht lesen: {e}", e = e))
}

/// Browse-time preview for a video: extracts one frame to a throwaway temp
/// file, reads it back, then deletes the temp file — nothing is kept on
/// disk unless/until the file is actually added to a project.
pub fn video_preview_bytes(path: &Path, frame_percent: f64) -> Result<Vec<u8>, String> {
    let tmp = std::env::temp_dir().join(format!("cronostream-preview-{}.jpg", uuid::Uuid::new_v4()));
    video_preview::extract_frame(path, frame_percent, &tmp)?;
    let result = read_as_jpeg_bytes(&tmp);
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Browse-time preview for a PDF: same throwaway-temp-file approach as
/// `video_preview_bytes`, rendering the first page via PDFium.
pub fn pdf_preview_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let tmp_prefix = std::env::temp_dir().join(format!("cronostream-preview-{}", uuid::Uuid::new_v4()));
    let produced = pdf_preview::render_first_page(path, &tmp_prefix)?;
    let result = read_as_jpeg_bytes(&produced);
    let _ = std::fs::remove_file(&produced);
    result
}

/// Browse-time preview for a legacy `.doc` file: the same generated
/// placeholder card used when actually adding it (see `doc_card`), built
/// from filename + filesystem metadata — same throwaway-temp-file approach
/// as the other browse previews above.
pub fn doc_card_preview_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let to_rfc3339 = |t: std::io::Result<std::time::SystemTime>| -> Option<String> {
        let t = t.ok()?;
        let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
        chrono::DateTime::<chrono::Utc>::from_timestamp(duration.as_secs() as i64, 0).map(|dt| dt.to_rfc3339())
    };
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let meta = doc_card::DocMetadata {
        size_bytes: Some(metadata.len()),
        fs_created: to_rfc3339(metadata.created()),
        fs_modified: to_rfc3339(metadata.modified()),
    };

    let tmp = std::env::temp_dir().join(format!("cronostream-preview-{}.jpg", uuid::Uuid::new_v4()));
    doc_card::render_doc_card(&title, &meta, &tmp)?;
    let result = read_as_jpeg_bytes(&tmp);
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Many cameras (and RAW files) embed a small ready-made JPEG preview in
/// their EXIF data (IFD1 thumbnail). Reading that out directly is ~100x
/// faster than decoding the full-resolution image just to shrink it back
/// down, and is exactly what it's there for.
///
/// Returns the raw thumbnail bytes alongside the file's EXIF Orientation
/// (IFD0 — the main image's orientation also governs the embedded
/// thumbnail, which normally carries no orientation tag of its own).
fn extract_embedded_exif_thumbnail(path: &Path) -> Option<(Vec<u8>, u16)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    // The embedded preview JPEG lives in IFD1 ("THUMBNAIL"), referenced by
    // an offset + length pair relative to the start of the TIFF/EXIF
    // buffer — not exposed as a single convenience accessor by this crate.
    let offset = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let length = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;

    let bytes = exif.buf().get(offset..offset.checked_add(length)?)?.to_vec();
    let orientation = read_orientation_from_exif(&exif);
    Some((bytes, orientation))
}

/// Reads the standard EXIF Orientation tag (1-8, default 1 = "normal") from
/// an already-parsed EXIF container.
fn read_orientation_from_exif(exif: &exif::Exif) -> u16 {
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v as u16)
        .unwrap_or(1)
}

/// Reads the EXIF Orientation tag directly from a file path. Used for the
/// full-decode path, where `image::open` doesn't apply it itself — the
/// `image` crate deliberately leaves EXIF-based rotation to the caller.
pub(crate) fn read_orientation(path: &Path) -> u16 {
    (|| -> Option<u16> {
        let file = File::open(path).ok()?;
        let mut reader = BufReader::new(file);
        let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
        Some(read_orientation_from_exif(&exif))
    })()
    .unwrap_or(1)
}

/// Applies a standard EXIF Orientation value (1-8) to a decoded image so it
/// displays upright — matches how browsers auto-rotate JPEGs based on this
/// same tag, which is why a full-resolution view (reading the original
/// file's bytes directly) looks correct while a naively-decoded-and-resized
/// thumbnail doesn't: the orientation tag was simply never applied to it.
pub(crate) fn apply_orientation(img: image::DynamicImage, orientation: u16) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Computes output dimensions that fit within `max_dim` x `max_dim` while
/// preserving aspect ratio — matches the behavior of `image::DynamicImage::resize`.
fn fit_within(src_w: u32, src_h: u32, max_dim: u32) -> (u32, u32) {
    if src_w <= max_dim && src_h <= max_dim {
        return (src_w, src_h);
    }
    let ratio = (max_dim as f64 / src_w as f64).min(max_dim as f64 / src_h as f64);
    (
        ((src_w as f64 * ratio).round() as u32).max(1),
        ((src_h as f64 * ratio).round() as u32).max(1),
    )
}

/// SIMD-accelerated downscale (via `fast_image_resize`) + JPEG encode.
/// Replaces the plain `image` crate's scalar resize, which was the
/// dominant cost for large modern camera photos.
///
/// The EXIF `orientation` is applied *here*, after the downscale, rather
/// than by the caller beforehand: `apply_orientation` allocates a whole
/// second copy of whatever it is handed and fills it by transposing
/// (cache-hostile, so disproportionately slow), which on a 24 MP original
/// is ~72 MB and a large chunk of the total time — on the few hundred
/// kilopixels that come out of the resize it is free. Fitting into the
/// `max_dim` box before the rotation is equivalent: a 90/270° turn just
/// transposes a box that already fits.
fn resize_and_encode_jpeg(img: &image::DynamicImage, max_dim: u32, orientation: u16) -> Result<Vec<u8>, String> {
    let (dst_w, dst_h) = fit_within(img.width(), img.height(), max_dim);

    // RGB8, not RGBA8: a JPEG decodes as RGB already, so the RGBA this used
    // to force meant copy-converting the *full-resolution* image (~96 MB for
    // a 24 MP photo) only to then make the resizer carry a fourth, constant
    // channel through its whole convolution. `as_rgb8` borrows outright in
    // the overwhelmingly common case and only the odd grayscale/RGBA/16-bit
    // source still pays for a conversion.
    let converted;
    let rgb_src: &image::RgbImage = match img.as_rgb8() {
        Some(rgb) => rgb,
        None => {
            converted = img.to_rgb8();
            &converted
        }
    };
    let src_view = fast_image_resize::images::ImageRef::new(
        rgb_src.width(),
        rgb_src.height(),
        rgb_src.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )
    .map_err(|e| crate::trf!("Konnte Bild nicht lesen: {e}", e = e))?;

    let mut dst_image = fast_image_resize::images::Image::new(dst_w, dst_h, fast_image_resize::PixelType::U8x3);

    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src_view,
            &mut dst_image,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3)),
        )
        .map_err(|e| crate::trf!("Konnte Bild nicht skalieren: {e}", e = e))?;

    let rgb = image::RgbImage::from_raw(dst_w, dst_h, dst_image.into_vec())
        .ok_or(crate::i18n::tr("Konnte skaliertes Bild nicht zusammensetzen"))?;
    let oriented = apply_orientation(image::DynamicImage::ImageRgb8(rgb), orientation);

    let mut bytes: Vec<u8> = Vec::new();
    oriented
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
        .map_err(|e| crate::trf!("Konnte Vorschau nicht erzeugen: {e}", e = e))?;
    Ok(bytes)
}

/// `image::open`, plus a fallback for the one common TIFF flavour the `tiff`
/// crate refuses: CCITT Group 3 ("Fax3") bilevel scans, as produced by fax
/// software and some document scanners. The crate decodes Group 4 but not
/// Group 3, and fails with "compression method Fax3 is unsupported" — which
/// made such files un-importable. Everything else still goes through
/// `image::open` untouched.
pub fn open_image(path: &Path) -> Result<image::DynamicImage, String> {
    match image::open(path) {
        Ok(img) => Ok(img),
        Err(err) => {
            let is_tiff = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("tif") || e.eq_ignore_ascii_case("tiff"))
                .unwrap_or(false);
            if is_tiff {
                if let Some(img) = decode_fax3_tiff(path) {
                    return Ok(img);
                }
            }
            Err(crate::trf!("Konnte Bild nicht lesen: {err}", err = err))
        }
    }
}

/// Minimal first-page TIFF reader for Fax3 (1-D, EOL-delimited) data: parses
/// just the tags needed to find and decode the strips, and renders white/black
/// runs as an 8-bit greyscale image. Returns `None` for anything else (2-D
/// coding, other compression, truncated file) so the caller reports the
/// original error.
fn decode_fax3_tiff(path: &Path) -> Option<image::DynamicImage> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 8 {
        return None;
    }
    let le = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u32> {
        let b: [u8; 2] = data.get(o..o + 2)?.try_into().ok()?;
        Some(if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) } as u32)
    };
    let u32_at = |o: usize| -> Option<u32> {
        let b: [u8; 4] = data.get(o..o + 4)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;

    // Values of a tag as a list (SHORT or LONG), wherever they are stored.
    let values = |tag: u32| -> Option<Vec<u32>> {
        for i in 0..count {
            let e = ifd + 2 + i * 12;
            if u16_at(e)? != tag {
                continue;
            }
            let typ = u16_at(e + 2)?;
            let n = u32_at(e + 4)? as usize;
            let size = if typ == 3 { 2 } else { 4 };
            let start = if n * size <= 4 { e + 8 } else { u32_at(e + 8)? as usize };
            return (0..n)
                .map(|k| if typ == 3 { u16_at(start + k * 2) } else { u32_at(start + k * 4) })
                .collect();
        }
        None
    };
    let first = |tag: u32| values(tag).and_then(|v| v.first().copied());

    if first(259)? != 3 {
        return None; // not Group 3
    }
    if first(293).unwrap_or(0) & 1 != 0 {
        return None; // T4Options bit 0: 2-D coding, not supported by the decoder
    }
    let width = first(256)?;
    let height = first(257)?;
    if width == 0 || height == 0 || width > u16::MAX as u32 || width as u64 * height as u64 > 400_000_000 {
        return None;
    }
    let rows_per_strip = first(278).unwrap_or(height).max(1);
    let offsets = values(273)?;
    let counts = values(279)?;
    let reverse_bits = first(266).unwrap_or(1) == 2;

    let mut pixels = vec![255u8; (width * height) as usize];
    let mut row = 0u32;
    for (strip, (&off, &len)) in offsets.iter().zip(counts.iter()).enumerate() {
        let bytes = data.get(off as usize..(off as usize).checked_add(len as usize)?)?;
        let strip_end = ((strip as u32 + 1) * rows_per_strip).min(height);
        row = strip as u32 * rows_per_strip;
        let input = bytes.iter().map(|&b| if reverse_bits { b.reverse_bits() } else { b });
        // A strip that ends in garbage still yields the lines before it.
        let _ = fax::decoder::decode_g3(input, |transitions| {
            if row >= strip_end {
                return;
            }
            let base = (row * width) as usize;
            for (x, color) in fax::decoder::pels(transitions, width as u16).enumerate() {
                if color == fax::Color::Black {
                    pixels[base + x] = 0;
                }
            }
            row += 1;
        });
    }
    let _ = row;
    let grey = image::GrayImage::from_raw(width, height, pixels)?;
    Some(image::DynamicImage::ImageLuma8(grey))
}

/// Browse-time preview for an image: tries the embedded EXIF thumbnail
/// first (fast path), falls back to decoding and downscaling the full
/// image via SIMD resize. Shipping the original file's bytes untouched was
/// tried as a speedup (skips decode/resize entirely) but caused the whole
/// system to choke when browsing a folder of modern multi-MB photos —
/// dozens of full-size images held as base64 strings and decoded by the
/// webview at once is far heavier than one small decode per file in Rust.
pub fn image_preview_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if let Some((embedded, orientation)) = extract_embedded_exif_thumbnail(path) {
        if orientation == 1 {
            return Ok(embedded); // already upright — ship as-is, no decode needed
        }
        // Rotated camera shot: the embedded thumbnail carries no orientation
        // tag of its own (that's on the main image), so left untouched it
        // displays sideways/upside-down even though the full-resolution
        // view (which browsers auto-rotate per that same tag) looks right.
        // Still far cheaper than decoding the full original, since this is
        // only the small embedded preview.
        if let Ok(thumb_img) = image::load_from_memory(&embedded) {
            return resize_and_encode_jpeg(&thumb_img, BROWSE_PREVIEW_MAX_DIM, orientation);
        }
    }

    let img = open_image(path)?;
    resize_and_encode_jpeg(&img, BROWSE_PREVIEW_MAX_DIM, read_orientation(path))
}

/// Sharp rendition for the single-image view (`FULL_PREVIEW_MAX_DIM`) and
/// for the file browser's preview panel (`GRID_PREVIEW_MAX_DIM`).
/// Deliberately skips the embedded-EXIF-thumbnail fast path
/// `image_preview_bytes` relies on — those previews are a few hundred
/// pixels wide at best, fine for a grid tile but visibly blurry filling a
/// panel — so this always decodes the real image. The result is cached per
/// tier (see `preview_cache::set_full`), which is what keeps paging back
/// and forth through a folder instant despite that cost.
///
/// The one-line timing on stderr is a deliberate diagnostic: it only fires
/// on an actual cache miss, and the decode/resize split is the quickest way
/// to see where a slow folder's time really goes.
pub fn full_image_preview_bytes(path: &Path, max_dim: u32) -> Result<Vec<u8>, String> {
    let started = std::time::Instant::now();
    let img = open_image(path)?;
    let decode_ms = started.elapsed().as_millis();

    let resize_started = std::time::Instant::now();
    let bytes = resize_and_encode_jpeg(&img, max_dim, read_orientation(path))?;
    eprintln!(
        "[preview] {} ({}x{} -> {max_dim}px): dekodieren {decode_ms} ms, skalieren+kodieren {} ms, {} KB",
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        img.width(),
        img.height(),
        resize_started.elapsed().as_millis(),
        bytes.len() / 1024,
    );
    Ok(bytes)
}

/// Generates and writes a downscaled JPEG thumbnail for an image being added
/// to a project, at `dest_path`. Always resizes the full image (never the
/// low-res embedded EXIF preview) since this copy is kept long-term.
pub fn store_image_thumbnail(source_path: &Path, dest_path: &Path) -> Result<(), String> {
    let img = open_image(source_path)?;
    let bytes = resize_and_encode_jpeg(&img, STORED_THUMBNAIL_MAX_DIM, read_orientation(source_path))?;
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::trf!("Konnte Vorschau-Ordner nicht anlegen: {e}", e = e))?;
    }
    crate::safe_io::write_atomically(dest_path, bytes).map_err(|e| crate::trf!("Konnte Vorschaubild nicht speichern: {e}", e = e))
}
