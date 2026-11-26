//! The creation date a video, a sound recording or a document carries inside
//! itself — the container's or the document's own metadata, as opposed to
//! the filesystem's dates, which every copy rewrites.
//!
//! Only ever offered as an extra choice (the review screen's date dropdown,
//! the AI export), never picked automatically: for a phone video it is the
//! moment of recording, but a converted or re-saved file carries the moment
//! of conversion instead — measured on this project's own test files, which
//! is why `items::compute_date_candidates` leaves video containers out of
//! the automatic choice.

use std::io::Read;
use std::path::Path;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Datelike, FixedOffset, Local, NaiveDateTime, TimeZone};

use crate::fsbrowse::FileKind;

/// A probe of a few container tags takes well under a second (about 60 ms
/// measured); anything longer means ffprobe is stuck on the file.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// ffprobe processes running at once across the whole app (the review
/// screen, the date dropdowns, the AI export), so reading these dates never
/// crowds out the thumbnails and imports running beside it.
const MAX_PROBES: usize = 2;

static PROBES_RUNNING: Mutex<usize> = Mutex::new(0);
static PROBE_FREED: Condvar = Condvar::new();

/// One of the `MAX_PROBES` slots, held for the duration of one ffprobe run.
struct ProbeSlot;

impl ProbeSlot {
    fn acquire() -> Self {
        let mut running = PROBES_RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        while *running >= MAX_PROBES {
            running = PROBE_FREED.wait(running).unwrap_or_else(PoisonError::into_inner);
        }
        *running += 1;
        ProbeSlot
    }
}

impl Drop for ProbeSlot {
    fn drop(&mut self) {
        *PROBES_RUNNING.lock().unwrap_or_else(PoisonError::into_inner) -= 1;
        PROBE_FREED.notify_one();
    }
}
/// How much of a PDF's start and end is searched for its info dictionary
/// and XMP packet, where the creation date lives in practice.
const PDF_SCAN_BYTES: u64 = 1024 * 1024;
/// Upper bound for the small XML part of an office file that holds the date.
const META_XML_MAX_BYTES: u64 = 1024 * 1024;

/// The file's own creation date as RFC 3339, if it has a plausible one.
pub fn read(path: &Path, kind: FileKind) -> Option<String> {
    let found = match kind {
        FileKind::Video | FileKind::Audio => from_container(path),
        FileKind::Document => {
            let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
            match ext.as_deref() {
                Some("pdf") => from_pdf(path),
                Some("docx" | "xlsx" | "pptx") => from_zip_xml(path, "docProps/core.xml", "<dcterms:created"),
                Some("odt" | "ods" | "odp") => from_zip_xml(path, "meta.xml", "<meta:creation-date"),
                _ => None,
            }
        }
        _ => None,
    }?;
    plausible(found).map(|dt| dt.to_rfc3339())
}

/// Zero dates (1904/1970 epochs of the formats) and dates in the future are
/// a missing value written as a number, not a date.
fn plausible(dt: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    let now = chrono::Utc::now();
    (dt.year() > 1970 && dt <= now + chrono::Duration::days(1)).then_some(dt)
}

/// A wall-clock time without zone, read as this computer's local time.
fn local(naive: NaiveDateTime) -> Option<DateTime<FixedOffset>> {
    Local.from_local_datetime(&naive).earliest().map(|dt| dt.fixed_offset())
}

// ---- video and audio ---------------------------------------------------------

fn from_container(path: &Path) -> Option<DateTime<FixedOffset>> {
    let mut command = crate::ffmpeg_tool::command("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags=com.apple.quicktime.creationdate,creation_time",
            "-of",
            "json",
        ])
        .arg(path);
    let output = {
        let _slot = ProbeSlot::acquire();
        crate::ffmpeg_tool::output_with_timeout(&mut command, PROBE_TIMEOUT).ok()?
    };
    if !output.status.success() {
        return None;
    }
    parse_ffprobe_tags(&String::from_utf8_lossy(&output.stdout))
}

/// Apple's own tag first: it is the moment of recording, with the zone it
/// was recorded in. `creation_time` is UTC and, for footage that has been
/// converted, the moment of conversion.
fn parse_ffprobe_tags(json: &str) -> Option<DateTime<FixedOffset>> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let tags = value.get("format")?.get("tags")?;
    let tag = |name: &str| tags.get(name).and_then(|v| v.as_str()).map(str::trim);
    if let Some(apple) = tag("com.apple.quicktime.creationdate") {
        if let Some(dt) = parse_iso(apple) {
            return Some(dt);
        }
    }
    tag("creation_time").and_then(parse_iso)
}

/// RFC 3339, also with a zone written without colon ("+0200").
fn parse_iso(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .or_else(|| DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%z").ok())
        .or_else(|| DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%z").ok())
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok().and_then(local))
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok().and_then(local))
}

// ---- PDF ---------------------------------------------------------------------

fn from_pdf(path: &Path) -> Option<DateTime<FixedOffset>> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut head = Vec::new();
    (&mut file).take(PDF_SCAN_BYTES).read_to_end(&mut head).ok()?;
    let mut text = String::from_utf8_lossy(&head).into_owned();
    if len > PDF_SCAN_BYTES {
        use std::io::{Seek, SeekFrom};
        let start = len.saturating_sub(PDF_SCAN_BYTES).max(PDF_SCAN_BYTES);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = Vec::new();
        file.take(PDF_SCAN_BYTES).read_to_end(&mut tail).ok()?;
        text.push_str(&String::from_utf8_lossy(&tail));
    }
    pdf_date_in(&text)
}

/// The info dictionary's `/CreationDate (D:…)`, else the XMP packet's
/// `xmp:CreateDate`.
fn pdf_date_in(text: &str) -> Option<DateTime<FixedOffset>> {
    if let Some(at) = text.find("/CreationDate") {
        let rest = &text[at + "/CreationDate".len()..];
        if let Some(open) = rest.find('(') {
            if open < 8 {
                let value = &rest[open + 1..];
                if let Some(close) = value.find(')') {
                    if let Some(dt) = parse_pdf_date(&value[..close]) {
                        return Some(dt);
                    }
                }
            }
        }
    }
    let at = text.find("xmp:CreateDate")?;
    let rest = &text[at + "xmp:CreateDate".len()..];
    // Either an attribute (xmp:CreateDate="…") or an element (>…<).
    let rest = rest.trim_start_matches(['=', '"', '>', ' ']);
    let end = rest.find(['"', '<'])?;
    parse_iso(rest[..end].trim())
}

/// "D:YYYYMMDDHHmmSSOHH'mm'" with everything after the year optional.
fn parse_pdf_date(raw: &str) -> Option<DateTime<FixedOffset>> {
    let s = raw.trim().trim_start_matches("D:");
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let num = |from: usize, len: usize, default: u32| -> u32 {
        digits.get(from..from + len).and_then(|d| d.parse().ok()).unwrap_or(default)
    };
    let date = chrono::NaiveDate::from_ymd_opt(num(0, 4, 0) as i32, num(4, 2, 1), num(6, 2, 1))?;
    let naive = date.and_hms_opt(num(8, 2, 0), num(10, 2, 0), num(12, 2, 0))?;
    let zone = &s[digits.len()..];
    match zone.chars().next() {
        Some('Z') => Some(naive.and_utc().fixed_offset()),
        Some(sign @ ('+' | '-')) => {
            let parts: Vec<u32> = zone[1..].split('\'').filter_map(|p| p.trim().parse().ok()).collect();
            let (hours, minutes) = (parts.first().copied().unwrap_or(0), parts.get(1).copied().unwrap_or(0));
            // A damaged file can carry any number here; beyond a day it is
            // no zone, and multiplying it out would overflow.
            if hours > 23 || minutes > 59 {
                return None;
            }
            let seconds = (hours * 3600 + minutes * 60) as i32;
            let offset = FixedOffset::east_opt(if sign == '-' { -seconds } else { seconds })?;
            offset.from_local_datetime(&naive).single()
        }
        _ => local(naive),
    }
}

// ---- office documents --------------------------------------------------------

/// The text of the `tag` element in a zip part: Word/Excel/PowerPoint keep
/// it in docProps/core.xml (with zone), LibreOffice in meta.xml (local time).
fn from_zip_xml(path: &Path, part: &str, tag: &str) -> Option<DateTime<FixedOffset>> {
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let entry = archive.by_name(part).ok()?;
    let mut xml = String::new();
    entry.take(META_XML_MAX_BYTES).read_to_string(&mut xml).ok()?;
    xml_element_text(&xml, tag).and_then(|value| parse_iso(value.trim()))
}

fn xml_element_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let at = xml.find(tag)?;
    let rest = &xml[at..];
    let open_end = rest.find('>')?;
    let body = &rest[open_end + 1..];
    let close = body.find('<')?;
    Some(&body[..close])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_apples_recording_date_over_the_container_date() {
        let json = r#"{"format":{"tags":{"creation_time":"2019-06-12T12:30:00.000000Z","com.apple.quicktime.creationdate":"2019-06-12T14:23:01+0200"}}}"#;
        assert_eq!(parse_ffprobe_tags(json).unwrap().to_rfc3339(), "2019-06-12T14:23:01+02:00");
        let json = r#"{"format":{"tags":{"creation_time":"2019-06-12T12:30:00.000000Z"}}}"#;
        assert_eq!(parse_ffprobe_tags(json).unwrap().to_rfc3339(), "2019-06-12T12:30:00+00:00");
        assert!(parse_ffprobe_tags(r#"{"format":{}}"#).is_none());
    }

    #[test]
    fn zero_and_future_dates_are_not_dates() {
        assert!(plausible(parse_iso("1970-01-01T00:00:00Z").unwrap()).is_none());
        assert!(plausible(parse_iso("1904-01-01T00:00:00Z").unwrap()).is_none());
        assert!(plausible(parse_iso("2999-01-01T00:00:00Z").unwrap()).is_none());
        assert!(plausible(parse_iso("2003-05-01T10:00:00Z").unwrap()).is_some());
    }

    #[test]
    fn reads_pdf_dates_with_and_without_zone() {
        assert_eq!(parse_pdf_date("D:20190612142301+02'00'").unwrap().to_rfc3339(), "2019-06-12T14:23:01+02:00");
        assert_eq!(parse_pdf_date("D:20190612142301Z").unwrap().to_rfc3339(), "2019-06-12T14:23:01+00:00");
        assert_eq!(parse_pdf_date("D:20190612").unwrap().date_naive().to_string(), "2019-06-12");
        assert!(parse_pdf_date("D:2019").is_none());
        assert!(parse_pdf_date("D:20190612142301+99999999'00'").is_none(), "a damaged zone is no date");
        assert!(parse_pdf_date("D:20190612142301+02'75'").is_none());
        let text = "1 0 obj << /Producer (x) /CreationDate (D:20030501100000-05'00') >> endobj";
        assert_eq!(pdf_date_in(text).unwrap().to_rfc3339(), "2003-05-01T10:00:00-05:00");
        let xmp = r#"<xmp:CreateDate>2011-02-03T04:05:06+01:00</xmp:CreateDate>"#;
        assert_eq!(pdf_date_in(xmp).unwrap().to_rfc3339(), "2011-02-03T04:05:06+01:00");
    }

    #[test]
    fn reads_the_creation_date_of_word_and_libreoffice_files() {
        let dir = std::env::temp_dir().join(format!("cronostream-media-date-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, part: &str, xml: &str| {
            let path = dir.join(name);
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            zip.start_file(part, zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut zip, xml.as_bytes()).unwrap();
            zip.finish().unwrap();
            path
        };
        let docx = write(
            "brief.docx",
            "docProps/core.xml",
            r#"<cp:coreProperties><dcterms:created xsi:type="dcterms:W3CDTF">2012-03-04T05:06:07Z</dcterms:created></cp:coreProperties>"#,
        );
        assert_eq!(read(&docx, FileKind::Document).unwrap(), "2012-03-04T05:06:07+00:00");
        let odt = write("brief.odt", "meta.xml", "<office:meta><meta:creation-date>2012-03-04T05:06:07</meta:creation-date></office:meta>");
        let local = NaiveDateTime::parse_from_str("2012-03-04T05:06:07", "%Y-%m-%dT%H:%M:%S").unwrap();
        assert_eq!(read(&odt, FileKind::Document).unwrap(), super::local(local).unwrap().to_rfc3339());
        assert!(read(&dir.join("fehlt.docx"), FileKind::Document).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
