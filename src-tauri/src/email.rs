use std::io::Read;
use std::path::Path;

use mail_parser::{Addr, MessageParser, MimeHeaders, PartType};
use msg_parser::{Outlook, Person};

/// Whether `path` is the binary Outlook `.msg` format (OLE/CFBF container)
/// rather than a raw RFC822/MIME `.eml` — decided purely by extension since,
/// unlike `.eml`, `.msg` has no plain-text heuristic (`looks_like_email`
/// only ever sniffs headers, which a binary container doesn't have).
fn is_msg_format(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("msg"))
}

/// Reads a single ANSI (Windows-1252, MAPI type `0x001E`) string property
/// directly out of a `.msg` file's OLE storage, decoding it correctly.
///
/// Exists because `msg_parser`'s own decoder for this type
/// (`PtypDecoder::decode`'s `"0x001E"` arm) reads the bytes as UTF-8
/// instead of Windows-1252 — the encoding this MAPI string type actually
/// uses. Any ANSI property with a non-ASCII byte in it (an umlaut, an
/// em-dash, anything outside 7-bit ASCII) is then invalid UTF-8, so
/// `String::from_utf8` fails and `msg_parser` silently drops the whole
/// property — not garbled, just missing. Seen on a real mail from 2006
/// whose plain-text body was there in the file (2207 bytes) but came back
/// as `outlook.body == ""`, purely because the German text contained
/// umlauts. `msg_parser`'s OLE reader is private (`mod ole;`, not `pub`),
/// so there's no way to ask it to retry with a different encoding — this
/// re-opens the same file with a separate OLE crate instead.
///
/// `mapi_tag` is the 4-hex-digit MAPI property id as used in the stream
/// name, e.g. `"1000"` for the plain-text body (`PR_BODY`) or `"1013"` for
/// the HTML body (`PR_BODY_HTML`). Returns `None` if the file can't be
/// opened as a compound document, the stream doesn't exist (most messages
/// store these properties as Unicode instead, under a `...001F` stream
/// `msg_parser` already reads correctly), or it reads as empty.
fn read_ansi_mapi_string(path: &Path, mapi_tag: &str) -> Option<String> {
    let mut file = cfb::open(path).ok()?;
    let mut stream = file.open_stream(format!("/__substg1.0_{mapi_tag}001E")).ok()?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).ok()?;
    // MAPI ANSI strings are conventionally NUL-terminated; strip a single
    // trailing NUL rather than leaving it in the text.
    if bytes.last() == Some(&0) {
        bytes.pop();
    }
    if bytes.is_empty() {
        return None;
    }
    Some(decode_windows1252(&bytes))
}

/// Windows-1252 is identical to Latin-1 (ISO-8859-1) outside the 0x80-0x9F
/// range, which Windows-1252 uses for curly quotes, en/em-dashes, €, etc.
/// instead of the C1 control codes Latin-1 has there — exactly the
/// characters a real-world German/English business mail is likely to
/// contain, so mapping them matters, not just the umlauts.
pub(crate) fn decode_windows1252(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| windows1252_char(b)).collect()
}

fn windows1252_char(b: u8) -> char {
    match b {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        // The undefined C1 slots (0x81/0x8D/0x8F/0x90/0x9D) and everything
        // else map 1:1 onto Unicode, same as Latin-1.
        _ => b as char,
    }
}

fn format_person(person: &Person) -> String {
    match (person.name.is_empty(), person.email.is_empty()) {
        (false, false) => format!("{} <{}>", person.name, person.email),
        (false, true) => person.name.clone(),
        (true, false) => person.email.clone(),
        (true, true) => String::new(),
    }
}

/// Header names whose presence as a line start (before the first blank
/// line that ends the header block) is good evidence a file is a raw
/// RFC822/MIME e-mail — checked against files with no (or an unrecognised)
/// extension, since mail clients often drop a dragged message without one.
/// Requiring at least two matches (see `looks_like_email`) keeps an
/// ordinary text file that happens to mention "Subject:" once from being
/// misclassified.
const EMAIL_HEADER_MARKERS: &[&str] = &[
    "return-path:",
    "received:",
    "message-id:",
    "from:",
    "to:",
    "subject:",
    "date:",
    "mime-version:",
    "delivered-to:",
    "content-type:",
];

/// Only called for files that would otherwise fall through to
/// `FileKind::Other` — known extensions (jpg, pdf, …) never reach this.
/// Reads just the first few KB, not the whole file: enough to cover the
/// header block of any real e-mail without the I/O cost of opening every
/// extension-less file in full.
pub fn looks_like_email(path: &Path) -> bool {
    // Regular files only, checked without opening: opening a FIFO blocks
    // until something writes to it — a named pipe in a browsed folder
    // would hang the listing (and the disk search) for good.
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut buf = [0u8; 4096];
    let Ok(n) = file.read(&mut buf) else { return false };
    let head = String::from_utf8_lossy(&buf[..n]);

    // Only the header block (before the first blank line) is relevant —
    // matching header-looking words inside the body would defeat the point.
    let header_block = head.split("\r\n\r\n").next().unwrap_or(&head).split("\n\n").next().unwrap_or(&head).to_lowercase();

    let has_mbox_from_line = header_block.starts_with("from ");
    let marker_count = EMAIL_HEADER_MARKERS.iter().filter(|marker| header_block.lines().any(|line| line.starts_with(**marker))).count();

    marker_count + usize::from(has_mbox_from_line) >= 2
}

#[derive(serde::Serialize)]
pub struct EmailMeta {
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub date: Option<String>,
}

fn format_addr(addr: &Addr) -> String {
    match (addr.name(), addr.address()) {
        (Some(name), Some(email)) => format!("{name} <{email}>"),
        (Some(name), None) => name.to_string(),
        (None, Some(email)) => email.to_string(),
        (None, None) => String::new(),
    }
}

/// Parses just the headers needed for the timeline hover tooltip, the
/// viewer's header line and the previews before an import — cheap compared to `extract_plain_text`/
/// `extract_html`, which also decode the body.
pub fn parse_meta(path: &Path) -> Result<EmailMeta, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        return Ok(EmailMeta {
            subject: Some(outlook.subject).filter(|s| !s.is_empty()),
            sender: Some(format_person(&outlook.sender)).filter(|s| !s.is_empty()),
            // `message_delivery_time` is empty for drafts/never-sent messages
            // (same gap `client_submit_time` — set when the sender hit send —
            // covers), mirroring the `.eml` side's single `Date` header.
            date: Some(outlook.message_delivery_time).filter(|s| !s.is_empty()).or(Some(outlook.client_submit_time).filter(|s| !s.is_empty())),
        });
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;

    Ok(EmailMeta {
        subject: message.subject().map(|s| s.to_string()),
        sender: message.from().and_then(|addr| addr.first()).map(format_addr),
        date: message.date().map(|d| d.to_rfc3339()),
    })
}

/// Recipients shown in the viewer header. Read lazily from the stored
/// original rather than persisted, like the body — only the open viewer
/// needs them.
#[derive(serde::Serialize)]
pub struct EmailRecipients {
    pub to: Vec<String>,
    pub cc: Vec<String>,
}

pub fn extract_recipients(path: &Path) -> Result<EmailRecipients, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        let collect = |list: Vec<Person>| -> Vec<String> { list.iter().map(format_person).filter(|s| !s.is_empty()).collect() };
        return Ok(EmailRecipients { to: collect(outlook.to), cc: collect(outlook.cc) });
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;

    let collect = |list: Option<&mail_parser::Address>| -> Vec<String> {
        list.map(|a| a.iter().map(format_addr).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
    };
    Ok(EmailRecipients { to: collect(message.to()), cc: collect(message.cc()) })
}

#[derive(serde::Serialize)]
pub struct EmailAttachment {
    pub index: usize,
    pub name: String,
    pub size: usize,
}

/// The name comes from the (untrusted) mail and ends up as a file name on
/// disk, so path separators and control characters must not survive.
fn clean_filename(raw: &str, index: usize) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { crate::trf!("Anlage {number}", number = index + 1) } else { cleaned }
}

fn attachment_name(part: &mail_parser::MessagePart, index: usize) -> String {
    let raw = part.attachment_name().map(str::to_string).unwrap_or_else(|| crate::trf!("Anlage {number}", number = index + 1));
    clean_filename(&raw, index)
}

/// `.msg` attachments carry both a short 8.3 name and (usually) the full
/// original filename — the latter is what the mail client showed, so it
/// wins whenever present.
fn msg_attachment_name(attachment: &msg_parser::Attachment, index: usize) -> String {
    let raw = if !attachment.long_file_name.is_empty() {
        attachment.long_file_name.as_str()
    } else if !attachment.file_name.is_empty() {
        attachment.file_name.as_str()
    } else if !attachment.display_name.is_empty() {
        attachment.display_name.as_str()
    } else {
        return crate::trf!("Anlage {number}", number = index + 1);
    };
    clean_filename(raw, index)
}

/// Attachments listed in the viewer's attachment section. Read lazily from
/// the stored original, like the body.
pub fn list_attachments(path: &Path) -> Result<Vec<EmailAttachment>, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        return Ok(outlook
            .attachments
            .iter()
            .enumerate()
            .map(|(index, attachment)| EmailAttachment { index, name: msg_attachment_name(attachment, index), size: attachment.payload_bytes.len() })
            .collect());
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;
    Ok(message
        .attachments()
        .enumerate()
        .map(|(index, part)| EmailAttachment { index, name: attachment_name(part, index), size: part.contents().len() })
        .collect())
}

/// Writes one attachment into `dest_dir` and returns the file's path, so the
/// caller can hand it to the system's default program.
pub fn save_attachment(path: &Path, index: usize, dest_dir: &Path) -> Result<std::path::PathBuf, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        let attachment = outlook.attachments.get(index).ok_or_else(|| crate::i18n::tr("Anlage nicht gefunden.").to_string())?;

        std::fs::create_dir_all(dest_dir).map_err(|e| crate::trf!("Konnte Ordner nicht anlegen: {e}", e = e))?;
        let target = dest_dir.join(msg_attachment_name(attachment, index));
        std::fs::write(&target, &attachment.payload_bytes).map_err(|e| crate::trf!("Konnte Anlage nicht schreiben: {e}", e = e))?;
        return Ok(target);
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;
    let part = message.attachments().nth(index).ok_or_else(|| crate::i18n::tr("Anlage nicht gefunden.").to_string())?;

    std::fs::create_dir_all(dest_dir).map_err(|e| crate::trf!("Konnte Ordner nicht anlegen: {e}", e = e))?;
    let target = dest_dir.join(attachment_name(part, index));
    std::fs::write(&target, part.contents()).map_err(|e| crate::trf!("Konnte Anlage nicht schreiben: {e}", e = e))?;
    Ok(target)
}

/// Strips tags from an HTML fragment for a best-effort plain-text rendering
/// — used only as the `.msg` body fallback below, where the alternative is
/// showing nothing at all. Block-level tags become newlines so paragraphs
/// don't run together; everything else is just dropped.
fn html_to_plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if html.as_bytes()[i] == b'<' {
            let Some(end_rel) = html[i..].find('>') else { break };
            let tag = html[i + 1..i + end_rel].trim_start_matches('/');
            let tag_name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
            if matches!(tag_name.to_lowercase().as_str(), "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                out.push('\n');
            }
            i += end_rel + 1;
        } else if let Some(next_lt) = html[i..].find('<') {
            out.push_str(&html[i..i + next_lt]);
            i += next_lt;
        } else {
            out.push_str(&html[i..]);
            break;
        }
    }
    let decoded = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    decoded.lines().map(str::trim).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// Plain-text rendering of the body, for search (`extracted_text`) and as
/// the viewer's fallback when the mail has no real HTML part. `mail-parser`
/// auto-converts from HTML when there is no genuine text/plain part, so
/// this is never empty just because a mail happens to be HTML-only.
pub fn extract_plain_text(path: &Path) -> Result<String, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        if !outlook.body.is_empty() {
            return Ok(outlook.body);
        }
        // Recovers an ANSI-encoded body that `msg_parser` silently dropped
        // (see `read_ansi_mapi_string`) — tried before the HTML/RTF
        // fallbacks below since this is the mail's actual plain-text body,
        // not an approximation derived from another format.
        if let Some(text) = read_ansi_mapi_string(path, "1000") {
            return Ok(text);
        }
        if !outlook.html.is_empty() {
            return Ok(html_to_plain_text(&outlook.html));
        }
        if let Some(html) = read_ansi_mapi_string(path, "1013") {
            return Ok(html_to_plain_text(&html));
        }
        // Calendar invites (`IPM.Appointment`/`IPM.Schedule.Meeting`) and
        // some older senders only populate the RTF body, leaving both
        // `body` and `html` empty. `html_from_rtf` only recovers text when
        // the RTF was itself generated *from* HTML (it looks for a
        // `\fromhtml1` marker) — a genuinely RTF-authored mail has no such
        // marker, so that call returns `None` and this used to just give
        // up here, even though the RTF plainly has text in it. Falling
        // back to reading the decompressed RTF directly — the same reader
        // `.rtf` documents use (`doc_text::extract_text`) — covers that
        // case too.
        if let Some(html) = outlook.html_from_rtf() {
            return Ok(html_to_plain_text(&html));
        }
        if let Some(rtf_bytes) = outlook.rtf_decompressed() {
            let rtf_text = String::from_utf8_lossy(&rtf_bytes).into_owned();
            if let Ok(document) = rtf_parser::RtfDocument::try_from(rtf_text) {
                return Ok(document.get_text());
            }
        }
        return Ok(String::new());
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;
    Ok(message.body_text(0).map(|c| c.into_owned()).unwrap_or_default())
}

/// Sanitised HTML of the body, only when the mail actually carries a real
/// `text/html` part (as opposed to `mail-parser` synthesising one from
/// plain text, which `body_html` also does — checked explicitly via
/// `html_part` so a text-only mail doesn't get a pointless HTML rendering).
/// Remote `img`/`background` URLs are stripped (kept to `data:` only) so
/// opening a mail never fires a tracking-pixel request; pictures embedded in
/// the mail itself (`cid:`) are inlined first, see `inline_cid_images`.
pub fn extract_html(path: &Path) -> Result<Option<String>, String> {
    if is_msg_format(path) {
        let outlook = Outlook::from_path(path).map_err(|e| crate::trf!("Ungültiges .msg-Format: {e}", e = e))?;
        // Some senders (notably older Outlook builds) only store the RTF
        // body — `html` is then empty and `html_from_rtf` recovers an
        // approximation from it, same fallback the crate's own docs show.
        // The ANSI re-read (see `read_ansi_mapi_string`) comes first,
        // since — same as in `extract_plain_text` — it recovers the mail's
        // actual HTML rather than an RTF-derived approximation.
        let raw_html = if !outlook.html.is_empty() {
            Some(outlook.html)
        } else if let Some(html) = read_ansi_mapi_string(path, "1013") {
            Some(html)
        } else {
            outlook.html_from_rtf()
        };
        let images = outlook
            .attachments
            .iter()
            .filter(|attachment| !attachment.content_id.is_empty())
            .filter_map(|attachment| {
                let mime = msg_image_mime(attachment)?;
                Some((attachment.content_id.as_str(), mime, attachment.payload_bytes.as_slice()))
            })
            .collect::<Vec<_>>();
        return Ok(raw_html.map(|html| sanitize_html(&inline_cid_images(&html, &images))));
    }

    let bytes = std::fs::read(path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let message = MessageParser::default().parse(&bytes).ok_or_else(|| crate::i18n::tr("Ungültiges E-Mail-Format.").to_string())?;

    let is_real_html = message.html_part(0).is_some_and(|part| matches!(part.body, PartType::Html(_)));
    if !is_real_html {
        return Ok(None);
    }

    let raw_html = message.body_html(0).map(|c| c.into_owned()).unwrap_or_default();
    let images = message
        .parts
        .iter()
        .filter_map(|part| {
            let content_type = part.content_type()?;
            if !content_type.ctype().eq_ignore_ascii_case("image") {
                return None;
            }
            let mime = format!("image/{}", content_type.subtype()?.to_ascii_lowercase());
            Some((part.content_id()?, mime, part.contents()))
        })
        .collect::<Vec<_>>();
    Ok(Some(sanitize_html(&inline_cid_images(&raw_html, &images))))
}

/// Inline pictures embedded in one mail, decoded, at most this much: they
/// travel to the viewer inside the HTML, and one mail full of large photos
/// shouldn't stall it. Pictures past the limit stay empty frames.
const MAX_INLINE_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Mail programs attach pictures shown in the text as parts of their own and
/// point at them with `cid:<content-id>`, which means nothing to the viewer.
/// Each such reference becomes the picture itself as a `data:` URL.
/// `images` are `(content-id, mime type, bytes)`.
fn inline_cid_images(html: &str, images: &[(&str, String, &[u8])]) -> String {
    use base64::Engine;

    let mut by_id = std::collections::HashMap::new();
    let mut budget = MAX_INLINE_IMAGE_BYTES;
    for (id, mime, bytes) in images {
        let id = id.trim().trim_start_matches('<').trim_end_matches('>').to_ascii_lowercase();
        if bytes.len() > budget || by_id.contains_key(&id) {
            continue;
        }
        budget -= bytes.len();
        by_id.insert(id, format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    }
    if by_id.is_empty() {
        return html.to_string();
    }

    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut rest = 0;
    while let Some(found) = lower[rest..].find("cid:") {
        let start = rest + found;
        let end = html[start..]
            .find(|c: char| c == '"' || c == '\'' || c == '>' || c == ')' || c.is_whitespace())
            .map_or(html.len(), |len| start + len);
        out.push_str(&html[rest..start]);
        match by_id.get(&lower[start + 4..end]) {
            Some(data_url) => out.push_str(data_url),
            None => out.push_str(&html[start..end]),
        }
        rest = end;
    }
    out.push_str(&html[rest..]);
    out
}

/// The picture type of an `.msg` attachment: its MIME tag where set, else
/// guessed from the extension. `None` for anything that isn't a picture.
fn msg_image_mime(attachment: &msg_parser::Attachment) -> Option<String> {
    let tag = attachment.mime_tag.trim().to_ascii_lowercase();
    if tag.starts_with("image/") {
        return Some(tag);
    }
    let mime = match attachment.extension.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(mime.to_string())
}

fn sanitize_html(html: &str) -> String {
    ammonia::Builder::default()
        // Only so pictures embedded in the mail survive; the filter below
        // keeps `data:` to `<img src>` with a picture type.
        .add_url_schemes(&["data"])
        .attribute_filter(|element, attribute, value| {
            let is_image_src = (element == "img" || element == "image") && attribute == "src";
            let is_data = value.trim_start().get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"));
            if is_data {
                let is_picture = value.trim_start().get(..11).is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"));
                return (is_image_src && is_picture).then(|| value.into());
            }
            // Anything else in a picture slot is remote: a tracking pixel.
            if is_image_src || attribute == "background" {
                None
            } else {
                Some(value.into())
            }
        })
        .clean(html)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_eml(dir: &std::path::Path, filename: &str, content: &str) -> std::path::PathBuf {
        let path = dir.join(filename);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn detects_email_without_extension() {
        let dir = std::env::temp_dir();
        let path = write_eml(
            &dir,
            "cronostream-test-email-noext",
            "From felix@example.com Mon Oct 12 13:12:22 2026\r\nReturn-Path: <felix@example.com>\r\nFrom: Felix <felix@example.com>\r\nTo: test@example.com\r\nSubject: Hallo\r\nDate: Mon, 12 Oct 2026 13:12:22 +0200\r\n\r\nBody text.\r\n",
        );
        assert!(looks_like_email(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn does_not_misclassify_plain_text() {
        let dir = std::env::temp_dir();
        let path = write_eml(&dir, "cronostream-test-plain-noext", "Just a note about nothing in particular.\nSecond line.\n");
        assert!(!looks_like_email(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn parses_subject_sender_and_date() {
        let dir = std::env::temp_dir();
        let path = write_eml(
            &dir,
            "cronostream-test-meta.eml",
            "From: Felix Heck <felix@example.com>\r\nTo: test@example.com\r\nSubject: Testbetreff\r\nDate: Mon, 12 Oct 2026 13:12:22 +0200\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHallo Welt.\r\n",
        );
        let meta = parse_meta(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(meta.subject.as_deref(), Some("Testbetreff"));
        assert_eq!(meta.sender.as_deref(), Some("Felix Heck <felix@example.com>"));
        assert!(meta.date.unwrap().starts_with("2026-10-12"));
    }

    #[test]
    fn html_only_mail_has_no_genuine_text_part_but_extract_plain_text_still_works() {
        let dir = std::env::temp_dir();
        let path = write_eml(
            &dir,
            "cronostream-test-html.eml",
            "From: a@example.com\r\nSubject: HTML Mail\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Hallo <b>Welt</b></p><img src=\"https://tracker.example.com/pixel.gif\"></body></html>\r\n",
        );
        let text = extract_plain_text(&path).unwrap();
        let html = extract_html(&path).unwrap().unwrap();
        std::fs::remove_file(&path).ok();
        assert!(text.contains("Hallo"));
        assert!(html.contains("<b>Welt</b>"));
        assert!(!html.contains("tracker.example.com"));
    }

    #[test]
    fn embedded_pictures_are_kept_and_cid_references_inlined() {
        let dir = std::env::temp_dir();
        let path = write_eml(
            &dir,
            "cronostream-test-inline.eml",
            concat!(
                "From: a@example.com\r\nSubject: Bilder\r\nMIME-Version: 1.0\r\n",
                "Content-Type: multipart/related; boundary=\"b\"\r\n\r\n",
                "--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n",
                "<p><img src=\"data:image/png;base64,AAAA\"><img src=\"CID:Bild1@Example\">",
                "<img src=\"cid:fehlt@example\"><img src=\"https://tracker.example.com/p.gif\">",
                "<a href=\"data:text/html;base64,PHNjcmlwdD4=\">Link</a></p>\r\n",
                "--b\r\nContent-Type: image/png\r\nContent-ID: <bild1@example>\r\n",
                "Content-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b--\r\n",
            ),
        );
        let html = extract_html(&path).unwrap().unwrap();
        std::fs::remove_file(&path).ok();
        assert!(html.contains(r#"src="data:image/png;base64,AAAA""#), "{html}");
        assert!(html.contains(r#"src="data:image/png;base64,iVBORw0KGgo=""#), "{html}");
        assert!(!html.contains("tracker.example.com"), "{html}");
        assert!(!html.contains("data:text/html"), "{html}");
        // An unknown content-id isn't a picture we have; it stays a dead link.
        assert!(!html.contains("cid:fehlt"), "{html}");
    }

    #[test]
    fn text_only_mail_has_no_html_part() {
        let dir = std::env::temp_dir();
        let path = write_eml(&dir, "cronostream-test-textonly.eml", "From: a@example.com\r\nSubject: Text Mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHallo Welt.\r\n");
        let html = extract_html(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(html, None);
    }
}
