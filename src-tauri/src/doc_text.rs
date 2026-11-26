use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

/// The most a document's text part may unpack to. A .docx is a zip, and a
/// small (broken or crafted) one can claim gigabytes — reading that whole
/// would exhaust memory and take the app down mid-import. Real documents
/// stay far below: even a several-hundred-page Word file's XML is tens of MB.
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;
/// Plain text kept for the viewer and search; a longer .txt (a log file,
/// a data dump) is cut there rather than stored in full in the database.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// RTF is read whole before parsing; embedded pictures make it large, but
/// not this large.
const MAX_RTF_BYTES: u64 = 64 * 1024 * 1024;

/// Reads at most `limit` bytes; `true` when the source had more.
fn read_capped(reader: impl Read, limit: u64) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    Ok((bytes, truncated))
}

/// Extracts the plain text content of a Word (.docx), OpenDocument (.odt),
/// Rich Text (.rtf) or plain (.txt) file — no LibreOffice or any other
/// external tool involved, so this works identically and without any
/// install step on Linux/Windows/macOS. Legacy binary `.doc` is not covered
/// here (would need a real OLE-file parser, not just a zip+XML or text
/// reader) and keeps being refused by `fsbrowse::can_add`.
pub fn extract_text(path: &Path) -> Result<String, String> {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("docx") => extract_from_zip_xml(path, "word/document.xml", b"w:p"),
        Some("odt") => extract_from_zip_xml(path, "content.xml", b"text:p"),
        Some("rtf") => extract_rtf(path),
        Some("txt") => extract_txt(path),
        _ => Err(crate::i18n::tr("Textextraktion für diesen Dateityp nicht unterstützt.").to_string()),
    }
}

fn extract_txt(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let (bytes, truncated) = read_capped(file, MAX_TEXT_BYTES).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    Ok(decode_text(bytes, truncated))
}

/// Plain text in whatever encoding it came in: UTF-8 (with or without
/// BOM), UTF-16 with a BOM (Windows Notepad's "Unicode"), and otherwise
/// Windows-1252 — the "ANSI" of older Windows editors, in which ä/ö/ü/ß
/// and § are single bytes that are never valid UTF-8. Those files used to
/// be rejected and ended up with no text in the viewer at all.
fn decode_text(bytes: Vec<u8>, truncated: bool) -> String {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return decode_text(rest.to_vec(), truncated);
    }
    if let Some(le) = bytes.strip_prefix(b"\xFF\xFE") {
        return decode_utf16(le, u16::from_le_bytes);
    }
    if let Some(be) = bytes.strip_prefix(b"\xFE\xFF") {
        return decode_utf16(be, u16::from_be_bytes);
    }
    match String::from_utf8(bytes) {
        Ok(text) => text,
        // Cut inside a multi-byte character at the cap: keep the complete
        // part. `error_len() == None` means the bytes end mid-character.
        Err(e) if truncated && e.utf8_error().error_len().is_none() => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).unwrap_or_default()
        }
        Err(e) => crate::email::decode_windows1252(e.as_bytes()),
    }
}

fn decode_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let units = bytes.chunks_exact(2).map(|pair| unit([pair[0], pair[1]]));
    char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
}

fn extract_rtf(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let (bytes, truncated) = read_capped(file, MAX_RTF_BYTES).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    if truncated {
        return Err(crate::i18n::tr("Die RTF-Datei ist zu groß für die Textansicht.").to_string());
    }
    // RTF is nominally 7-bit ASCII with escapes for everything else, but be
    // lenient about stray non-UTF-8 bytes rather than failing outright.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let document = rtf_parser::RtfDocument::try_from(content).map_err(|e| crate::trf!("Konnte RTF nicht lesen: {e}", e = e))?;
    Ok(document.get_text())
}

/// Shared implementation for the two zip-of-XML office formats: reads one
/// entry out of the zip, then concatenates every XML text node, inserting a
/// newline at the close of each paragraph tag (`w:p` for DOCX, `text:p` for
/// ODT) so the result reads as actual paragraphs instead of one run-on line.
fn extract_from_zip_xml(path: &Path, xml_entry: &str, paragraph_end_tag: &[u8]) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| crate::i18n::tr("Ungültiges Dokumentformat.").to_string())?;
    let entry = archive.by_name(xml_entry).map_err(|_| crate::i18n::tr("Ungültiges Dokumentformat.").to_string())?;
    // The declared size first (cheap), then a capped read in case the
    // declaration lies.
    if entry.size() > MAX_XML_BYTES {
        return Err(crate::i18n::tr("Das Dokument ist zu groß für die Textansicht.").to_string());
    }
    let (xml_bytes, truncated) =
        read_capped(entry, MAX_XML_BYTES).map_err(|e| crate::trf!("Konnte Dokumentinhalt nicht lesen: {e}", e = e))?;
    if truncated {
        return Err(crate::i18n::tr("Das Dokument ist zu groß für die Textansicht.").to_string());
    }

    let mut reader = Reader::from_reader(xml_bytes.as_slice());
    let mut buf = Vec::new();
    let mut text = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Text(e)) => {
                let unescaped = e.decode().unwrap_or_default();
                // A text node that's *only* whitespace AND contains a
                // newline is structural indentation between tags (from
                // pretty-printed XML, e.g. after being re-saved by some
                // editor) — not real document content, so it's dropped.
                // A lone space with no newline is kept: that's exactly how
                // Word splits "foo bar" across two <w:r> runs with
                // xml:space="preserve" on the space-only one, and trimming
                // it would wrongly glue the two words together.
                if unescaped.contains('\n') && unescaped.trim().is_empty() {
                    // skip
                } else {
                    text.push_str(&unescaped);
                }
            }
            // `&amp;`, `&#228;` and the like arrive as events of their own
            // between the text around them.
            Ok(Event::GeneralRef(r)) => {
                if let Ok(Some(ch)) = r.resolve_char_ref() {
                    text.push(ch);
                } else if let Some(resolved) = r.decode().ok().and_then(|name| quick_xml::escape::resolve_xml_entity(&name)) {
                    text.push_str(resolved);
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == paragraph_end_tag => text.push('\n'),
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(dir: &std::path::Path, filename: &str, entry_name: &str, xml: &str) -> std::path::PathBuf {
        let path = dir.join(filename);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(entry_name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn a_long_txt_is_cut_at_the_limit_on_a_character_boundary() {
        let dir = std::env::temp_dir().join(format!("cronostream-doc-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lang.txt");
        // "ä" is two bytes, so the cut lands inside one somewhere.
        std::fs::write(&path, "ä".repeat(MAX_TEXT_BYTES as usize)).unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.len() as u64 <= MAX_TEXT_BYTES);
        assert!(text.chars().all(|c| c == 'ä'));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_capped_reports_whether_there_was_more() {
        assert_eq!(read_capped(&b"abc"[..], 3).unwrap(), (b"abc".to_vec(), false));
        assert_eq!(read_capped(&b"abcd"[..], 3).unwrap(), (b"abc".to_vec(), true));
    }

    #[test]
    fn extracts_docx_text_across_paragraphs() {
        let dir = std::env::temp_dir();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                <w:p><w:r><w:t>Hallo Welt, dies ist ein Test.</w:t></w:r></w:p>
                <w:p><w:r><w:t>Zweiter Absatz mit Umlauten: äöüß.</w:t></w:r></w:p>
            </w:body>
        </w:document>"#;
        let path = write_zip(&dir, "cronostream-test.docx", "word/document.xml", xml);
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "Hallo Welt, dies ist ein Test.\nZweiter Absatz mit Umlauten: äöüß.");
    }

    #[test]
    fn resolves_entity_and_character_references() {
        let dir = std::env::temp_dir();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                <w:p><w:r><w:t>M&amp;M &lt;3 K&#228;se &#x2013; &quot;gut&quot;</w:t></w:r></w:p>
            </w:body>
        </w:document>"#;
        let path = write_zip(&dir, "cronostream-test-entities.docx", "word/document.xml", xml);
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "M&M <3 Käse – \"gut\"");
    }

    #[test]
    fn extracts_odt_text_across_paragraphs() {
        let dir = std::env::temp_dir();
        let xml = r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
            <office:body><office:text>
                <text:p>Erster Absatz im ODT.</text:p>
                <text:p>Zweiter Absatz.</text:p>
            </office:text></office:body>
        </office:document-content>"#;
        let path = write_zip(&dir, "cronostream-test.odt", "content.xml", xml);
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "Erster Absatz im ODT.\nZweiter Absatz.");
    }

    #[test]
    fn preserves_inter_run_space_while_dropping_indentation_whitespace() {
        let dir = std::env::temp_dir();
        // Pretty-printed with indentation (newline + spaces between tags,
        // must be dropped) AND a word split across two runs with a
        // space-only run in between (must be kept, or "foo"+"bar" glue
        // together into "foobar").
        let xml = "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\n    <w:body>\n        <w:p><w:r><w:t>foo</w:t></w:r><w:r><w:t xml:space=\"preserve\"> </w:t></w:r><w:r><w:t>bar</w:t></w:r></w:p>\n    </w:body>\n</w:document>";
        let path = write_zip(&dir, "cronostream-test-spacing.docx", "word/document.xml", xml);
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "foo bar");
    }

    #[test]
    fn extracts_rtf_text() {
        let dir = std::env::temp_dir();
        let path = dir.join("cronostream-test.rtf");
        std::fs::write(&path, r#"{ \rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Hallo in {\b fett}.\par }"#).unwrap();
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "Hallo in fett.");
    }

    #[test]
    fn extracts_plain_txt() {
        let dir = std::env::temp_dir();
        let path = dir.join("cronostream-test.txt");
        std::fs::write(&path, "Einfacher Text.").unwrap();
        let text = extract_text(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "Einfacher Text.");
    }
}
