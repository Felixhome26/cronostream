use std::path::Path;

use ab_glyph::{Font, FontRef, PxScale};
use image::{Rgb, RgbImage};
use imageproc::drawing::{draw_filled_rect_mut, draw_hollow_rect_mut, draw_text_mut, text_size};
use imageproc::rect::Rect;

// Bundled rather than relying on a system font — this card has to render
// identically on Linux/Windows/macOS with nothing to install, and system
// font availability isn't guaranteed. DejaVu Sans is Bitstream Vera
// licensed, explicitly redistributable (see assets/fonts/DejaVu-LICENSE.txt).
static FONT_REGULAR_BYTES: &[u8] = include_bytes!("../assets/fonts/DejaVuSans.ttf");
static FONT_BOLD_BYTES: &[u8] = include_bytes!("../assets/fonts/DejaVuSans-Bold.ttf");

const CARD_SIZE: u32 = 640;
const BG: Rgb<u8> = Rgb([24, 24, 24]);
const BORDER: Rgb<u8> = Rgb([210, 210, 210]);
const BORDER_INNER: Rgb<u8> = Rgb([110, 110, 110]);
const ICON_COLOR: Rgb<u8> = Rgb([230, 230, 230]);
const TITLE_COLOR: Rgb<u8> = Rgb([240, 240, 240]);
const META_COLOR: Rgb<u8> = Rgb([150, 150, 150]);

pub struct DocMetadata {
    pub size_bytes: Option<u64>,
    /// RFC 3339 timestamps, as stored for every item's fs_created/fs_modified.
    pub fs_created: Option<String>,
    pub fs_modified: Option<String>,
}

/// Generates a stand-in thumbnail for a file we have no real content
/// preview for (currently: legacy binary `.doc`, which would need a real
/// OLE-file parser to read) — a dark card matching the timeline's own tile
/// styling (black background, thin border), showing the filename and
/// whatever filesystem metadata is available, so the tile carries real
/// information instead of just a bare icon.
pub fn render_doc_card(title: &str, meta: &DocMetadata, dest: &Path) -> Result<(), String> {
    let font_regular = FontRef::try_from_slice(FONT_REGULAR_BYTES).map_err(|_| crate::i18n::tr("Konnte Schriftart nicht laden.").to_string())?;
    let font_bold = FontRef::try_from_slice(FONT_BOLD_BYTES).map_err(|_| crate::i18n::tr("Konnte Schriftart nicht laden.").to_string())?;

    let mut img = RgbImage::from_pixel(CARD_SIZE, CARD_SIZE, BG);

    // A double border reads as more "designed" than one flat rectangle,
    // echoing the thin-white-border look the real timeline tiles have.
    draw_hollow_rect_mut(&mut img, Rect::at(16, 16).of_size(CARD_SIZE - 32, CARD_SIZE - 32), BORDER);
    draw_hollow_rect_mut(&mut img, Rect::at(26, 26).of_size(CARD_SIZE - 52, CARD_SIZE - 52), BORDER_INNER);

    let title_scale = PxScale::from(32.0);
    let max_text_width = CARD_SIZE as i32 - 110;
    let title_line_height = 42i32;
    let lines = wrap_text(title, &font_bold, title_scale, max_text_width, 4);

    // Index 0 de, 1 en, 2 es — see `crate::i18n::language_index`.
    let language = crate::i18n::language_index().min(2);
    let meta_lines: Vec<String> = [
        meta.size_bytes.map(|b| crate::trf!("Größe: {size}", size = format_size(b, language))),
        meta.fs_created.as_deref().and_then(|d| format_date(d, language)).map(|d| crate::trf!("Erstellt: {date}", date = d)),
        meta.fs_modified.as_deref().and_then(|d| format_date(d, language)).map(|d| crate::trf!("Geändert: {date}", date = d)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let meta_scale = PxScale::from(21.0);
    let meta_line_height = 29i32;

    // The icon/title/metadata block is centered as a whole within the
    // frame — a short one-line filename with no metadata would otherwise
    // leave a large dead gap between a top-anchored icon and a
    // bottom-anchored metadata block.
    const ICON_H: i32 = 138;
    const ICON_TITLE_GAP: i32 = 46;
    const TITLE_META_GAP: i32 = 44;
    let title_block_h = lines.len() as i32 * title_line_height;
    let meta_block_h = if meta_lines.is_empty() { 0 } else { TITLE_META_GAP + meta_lines.len() as i32 * meta_line_height };
    let total_h = ICON_H + ICON_TITLE_GAP + title_block_h + meta_block_h;
    let top = ((CARD_SIZE as i32 - total_h) / 2).max(60);

    draw_document_icon(&mut img, (CARD_SIZE as i32 - 110) / 2, top, 110, ICON_H);

    let mut y = top + ICON_H + ICON_TITLE_GAP;
    for line in &lines {
        let (w, _) = text_size(title_scale, &font_bold, line);
        draw_text_mut(&mut img, TITLE_COLOR, (CARD_SIZE as i32 - w as i32) / 2, y, title_scale, &font_bold, line);
        y += title_line_height;
    }

    let mut my = y + TITLE_META_GAP;
    for line in &meta_lines {
        let (w, _) = text_size(meta_scale, &font_regular, line);
        draw_text_mut(&mut img, META_COLOR, (CARD_SIZE as i32 - w as i32) / 2, my, meta_scale, &font_regular, line);
        my += meta_line_height;
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::trf!("Konnte Vorschau-Ordner nicht anlegen: {e}", e = e))?;
    }
    img.save(dest).map_err(|e| crate::trf!("Konnte Vorschaubild nicht speichern: {e}", e = e))
}

/// A "page with a folded corner" glyph with a few horizontal text-line bars
/// drawn on it — a bare rectangle reads as "page" at best and as "nothing
/// in particular" at the small scale a timeline tile renders at (fan-out,
/// fisheye shrink); the classic text-line treatment is what actually makes
/// "this is a document" legible at a glance. Built from primitives rather
/// than a font icon/emoji, so it doesn't depend on whatever emoji font
/// coverage happens to be installed.
fn draw_document_icon(img: &mut RgbImage, x: i32, y: i32, w: i32, h: i32) {
    draw_filled_rect_mut(img, Rect::at(x, y).of_size(w as u32, h as u32), ICON_COLOR);
    let fold = 26i32;
    for dy in 0..fold {
        for dx in 0..(fold - dy) {
            let px = x + w - fold + dx;
            let py = y + dy;
            if px >= 0 && py >= 0 && (px as u32) < img.width() && (py as u32) < img.height() {
                img.put_pixel(px as u32, py as u32, BG);
            }
        }
    }

    let margin = (w as f32 * 0.16) as i32;
    let line_h = (h as f32 * 0.045).max(3.0) as i32;
    let gap = (h as f32 * 0.1) as i32;
    let full_width = w - margin * 2;
    // Last line shorter than the rest, same convention every "document"
    // icon/favicon uses, so it doesn't read as a uniform striped block.
    let widths = [full_width, full_width, full_width, (full_width as f32 * 0.6) as i32];
    let mut line_y = y + fold + gap;
    for line_w in widths {
        if line_y + line_h > y + h {
            break;
        }
        draw_filled_rect_mut(img, Rect::at(x + margin, line_y).of_size(line_w.max(1) as u32, line_h as u32), BG);
        line_y += line_h + gap;
    }
}

/// Greedy word-wrap against the actual rendered width of each candidate
/// line (no font metrics shortcut). Wraps the *entire* text first — titles
/// here are short filenames, never long enough for that to matter — then
/// truncates to `max_lines`, only then appending "…" to the last kept line,
/// and only if something was actually cut off. Checking length after the
/// fact (rather than bailing out of the wrap loop once `max_lines` lines
/// are filled) avoids tagging an exact fit with a spurious "…".
fn wrap_text(text: &str, font: &impl Font, scale: PxScale, max_width: i32, max_lines: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate = if current.is_empty() { word.to_string() } else { format!("{current} {word}") };
        let (w, _) = text_size(scale, font, &candidate);
        if w as i32 > max_width && !current.is_empty() {
            lines.push(std::mem::replace(&mut current, word.to_string()));
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }

    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(last) = lines.last_mut() {
            last.push('…');
        }
    }
    lines
}

/// "1,5 MB" in German and Spanish, "1.5 MB" in English (`language` as
/// `crate::i18n::language_index`).
fn format_size(bytes: u64, language: usize) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let number = if unit == 0 { format!("{value:.0}") } else { format!("{value:.1}") };
    let number = if language == 1 { number } else { number.replace('.', ",") };
    format!("{number} {}", UNITS[unit])
}

/// The date as the frontend writes it (`src/utils/datetime.ts`):
/// de 12.03.2024, en 03/12/2024, es 12/03/2024.
fn format_date(rfc3339: &str, language: usize) -> Option<String> {
    let pattern = match language {
        1 => "%m/%d/%Y",
        2 => "%d/%m/%Y",
        _ => "%d.%m.%Y",
    };
    chrono::DateTime::parse_from_rfc3339(rfc3339).ok().map(|dt| dt.format(pattern).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font() -> FontRef<'static> {
        FontRef::try_from_slice(FONT_REGULAR_BYTES).unwrap()
    }

    #[test]
    fn wrap_text_does_not_append_ellipsis_on_an_exact_fit() {
        let f = font();
        // Four short words, generous width (one word per line), exactly
        // max_lines=4 — every word fits, nothing should be dropped.
        let lines = wrap_text("Eins Zwei Drei Vier", &f, PxScale::from(20.0), 60, 4);
        assert_eq!(lines.len(), 4);
        assert!(!lines.last().unwrap().ends_with('…'), "exact fit must not get an ellipsis: {lines:?}");
    }

    #[test]
    fn wrap_text_appends_ellipsis_only_when_truncated() {
        let f = font();
        let lines = wrap_text("Eins Zwei Drei Vier Fuenf Sechs", &f, PxScale::from(20.0), 60, 4);
        assert_eq!(lines.len(), 4);
        assert!(lines.last().unwrap().ends_with('…'));
    }

    #[test]
    fn wrap_text_handles_short_single_line_text() {
        let f = font();
        let lines = wrap_text("Kurztitel", &f, PxScale::from(20.0), 600, 4);
        assert_eq!(lines, vec!["Kurztitel".to_string()]);
    }

    #[test]
    fn format_size_picks_sensible_units() {
        assert_eq!(format_size(500, 0), "500 B");
        assert_eq!(format_size(2048, 1), "2.0 KB");
        assert_eq!(format_size(5 * 1024 * 1024, 1), "5.0 MB");
    }

    #[test]
    fn format_size_uses_a_decimal_comma_in_german_and_spanish() {
        assert_eq!(format_size(1536, 0), "1,5 KB");
        assert_eq!(format_size(1536, 2), "1,5 KB");
        assert_eq!(format_size(1536, 1), "1.5 KB");
    }

    #[test]
    fn format_date_follows_the_ui_language() {
        assert_eq!(format_date("2024-03-12T10:00:00+00:00", 0), Some("12.03.2024".to_string()));
        assert_eq!(format_date("2024-03-12T10:00:00+00:00", 1), Some("03/12/2024".to_string()));
        assert_eq!(format_date("2024-03-12T10:00:00+00:00", 2), Some("12/03/2024".to_string()));
        assert_eq!(format_date("not a date", 0), None);
    }

    #[test]
    fn render_doc_card_short_title_no_metadata_still_produces_valid_image() {
        let dir = std::env::temp_dir();
        let dest = dir.join("cronostream-test-doc-card-short.jpg");
        let meta = DocMetadata { size_bytes: None, fs_created: None, fs_modified: None };
        render_doc_card("Rechnung", &meta, &dest).unwrap();
        let img = image::open(&dest).unwrap();
        assert_eq!(img.width(), CARD_SIZE);
        std::fs::remove_file(&dest).ok();
    }

    #[test]
    fn render_doc_card_writes_a_readable_image() {
        let dir = std::env::temp_dir();
        let dest = dir.join("cronostream-test-doc-card.jpg");
        let meta = DocMetadata {
            size_bytes: Some(123_456),
            fs_created: Some("2024-01-02T00:00:00+00:00".to_string()),
            fs_modified: Some("2024-06-15T00:00:00+00:00".to_string()),
        };
        render_doc_card("Ein ziemlich langer Dateiname für den Lebenslauf", &meta, &dest).unwrap();
        let img = image::open(&dest).unwrap();
        assert_eq!(img.width(), CARD_SIZE);
        assert_eq!(img.height(), CARD_SIZE);
        std::fs::remove_file(&dest).ok();
    }
}
