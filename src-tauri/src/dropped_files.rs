//! Lasting copies of things dragged in from a mail program.
//!
//! The drop box only remembers paths (`pending_drops.rs`) and keeps them
//! across restarts, so a dropped file has to stay where it is until it is
//! imported or removed. Mail programs don't hand over such files:
//!
//! - Classic Outlook on Windows drags messages and attachments as *virtual
//!   files* (`FileGroupDescriptorW` + `FileContents`), with no path at all.
//!   `win_drop.rs` writes them here.
//! - Evolution on Linux writes the dragged messages into a fresh
//!   `/tmp/drag-n-drop-XXXXXX/` folder as one mbox file, several messages
//!   in one file when several were dragged. `/tmp` is emptied on reboot, and
//!   the app reads one message per file, so all but the first would be lost.
//!
//! `adopt` therefore copies e-mails found in a temporary folder here and
//! splits mbox files into one `.eml` per message. Every stored file gets a
//! folder of its own (`<store>/<uuid>/<name>`): the original name stays
//! visible in the drop box and two dropped files of the same name never
//! collide. A stored file goes when its drop-box entry is removed or
//! imported (`discard`), and `sweep` clears whatever was left behind (diary
//! attachments, which the diary copies on saving; a crash in between).

use std::collections::HashSet;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::fsbrowse::{self, FileKind};

const DIR_NAME: &str = "dropped_files";

/// Longest stored name in characters. Windows paths are limited to 260
/// characters unless long paths are switched on, and the local app data
/// folder plus a uuid already take about a hundred.
const MAX_NAME_CHARS: usize = 120;

/// Unreferenced stored files younger than this are kept by `sweep`: a drop
/// whose path is just on its way into the drop box (or into a diary entry
/// being edited) must not be swept away under it.
pub const SWEEP_MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn store_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join(DIR_NAME))
}

/// A file name that is safe on every system, from a name a mail program or
/// a mail's subject suggests: only its last path component (a name like
/// `..\..\evil.exe` or `a/b.eml` must not leave the stored file's folder),
/// no characters Windows forbids, no control characters, no reserved
/// device names, no trailing dots or spaces, and not too long.
pub fn sanitize_file_name(raw: &str, fallback: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = last
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).to_string();
    if name.chars().all(|c| c == '.' || c == '_') {
        name = fallback.to_string();
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    if name.chars().count() > MAX_NAME_CHARS {
        // Shortened in front of the extension, which tells the app (and
        // the system) what the file is.
        let ext = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .filter(|e| e.chars().count() <= 10);
        let keep = MAX_NAME_CHARS - ext.as_ref().map_or(0, |e| e.chars().count() + 1);
        let mut short: String = name.chars().take(keep).collect();
        short = short.trim_end_matches(['.', ' ']).to_string();
        if let Some(ext) = ext {
            short.push('.');
            short.push_str(&ext);
        }
        name = short;
    }
    name
}

/// A new, empty place for one stored file: `<store>/<uuid>/<name>`.
pub fn new_slot(store: &Path, name: &str) -> io::Result<PathBuf> {
    let dir = store.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir)?;
    Ok(dir.join(sanitize_file_name(name, "dropped-file")))
}

/// Removes a slot again, after a failed or abandoned write.
pub fn remove_slot(store: &Path, file: &Path) {
    if is_in_store(store, file) {
        let _ = fs::remove_file(file);
        if let Some(dir) = file.parent() {
            let _ = fs::remove_dir(dir);
        }
    }
}

/// Whether `path` is a file this module stored: exactly `<store>/<x>/<y>`,
/// judged on the path's components alone, so `..` can't reach outside.
pub fn is_in_store(store: &Path, path: &Path) -> bool {
    let Ok(rest) = path.strip_prefix(store) else { return false };
    let parts: Vec<_> = rest.components().collect();
    parts.len() == 2 && parts.iter().all(|c| matches!(c, Component::Normal(_)))
}

/// Deletes a stored file and its folder, once nothing waits for it any
/// more. Paths outside the store are left alone: those are the user's own
/// files.
pub fn discard(store: &Path, path: &Path) {
    remove_slot(store, path);
}

/// Clears stored files that nothing refers to any more and that are older
/// than `min_age`.
pub fn sweep(store: &Path, referenced: &HashSet<PathBuf>, min_age: Duration) {
    let Ok(entries) = fs::read_dir(store) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let dir = entry.path();
        // Only real folders, never a symlink: removing one would follow it.
        let Ok(meta) = fs::symlink_metadata(&dir) else { continue };
        if !meta.is_dir() {
            continue;
        }
        let young = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age < min_age);
        if young {
            continue;
        }
        let in_use = fs::read_dir(&dir)
            .map(|files| files.flatten().any(|f| referenced.contains(&f.path())))
            .unwrap_or(true);
        if !in_use {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct AdoptResult {
    /// The paths to use from here on: unchanged, or the stored copies.
    pub paths: Vec<String>,
    /// Names of dropped files that could not be taken over.
    pub failed: Vec<String>,
}

/// Whether a file lies where it won't last: in the system's temporary
/// folder, or in classic Outlook's attachment cache (`Content.Outlook`,
/// emptied whenever Outlook likes).
fn is_volatile(path: &Path, temp_dirs: &[PathBuf]) -> bool {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let in_temp = temp_dirs.iter().any(|t| path.starts_with(t) || canonical.starts_with(t));
    in_temp
        || canonical
            .components()
            .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("Content.Outlook"))
}

fn temp_dirs() -> Vec<PathBuf> {
    let temp = std::env::temp_dir();
    let mut dirs = vec![temp.clone()];
    if let Ok(canonical) = fs::canonicalize(&temp) {
        if canonical != temp {
            dirs.push(canonical);
        }
    }
    dirs
}

fn starts_with_mbox_line(path: &Path) -> bool {
    let mut head = [0u8; 5];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"From "
}

/// Name for one message of an mbox file: `<date>_<subject>.eml`, the way
/// Evolution names a single dragged message.
fn eml_name(contents: &[u8], fallback: &str, index: usize) -> String {
    let parsed = mail_parser::MessageParser::default().parse_headers(contents);
    let subject = parsed.as_ref().and_then(|m| m.subject()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let date = parsed.as_ref().and_then(|m| m.date()).map(|d| {
        format!("{:04}{:02}{:02}{:02}{:02}{:02}_", d.year, d.month, d.day, d.hour, d.minute, d.second)
    });
    let base = match subject {
        Some(subject) => format!("{}{subject}", date.unwrap_or_default()),
        None => format!("{fallback} {}", index + 1),
    };
    // Shortened before the extension goes on, so it's never cut off.
    let mut base = sanitize_file_name(&base, fallback);
    if base.chars().count() > MAX_NAME_CHARS - 4 {
        base = base.chars().take(MAX_NAME_CHARS - 4).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    format!("{base}.eml")
}

fn write_new(store: &Path, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
    let file = new_slot(store, name)?;
    let result = fs::File::create(&file).and_then(|mut f| {
        f.write_all(contents)?;
        f.sync_all()
    });
    match result {
        Ok(()) => Ok(file),
        Err(e) => {
            remove_slot(store, &file);
            Err(e)
        }
    }
}

/// Splits an mbox file into one `.eml` per message, without the mbox
/// `From ` lines. `None` when it holds one message and may stay as it is.
fn split_mbox(store: &Path, path: &Path, must_copy: bool) -> io::Result<Option<Vec<PathBuf>>> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let fallback = if stem.is_empty() { "E-Mail".to_string() } else { stem.clone() };
    let reader = BufReader::new(fs::File::open(path)?);
    let mut messages = mail_parser::mailbox::mbox::MessageIterator::new(reader);
    let Some(first) = messages.next().transpose()? else { return Ok(None) };
    let second = messages.next().transpose()?;
    if second.is_none() && !must_copy {
        return Ok(None);
    }
    let mut written = Vec::new();
    let mut write = |contents: &[u8], name: String| -> io::Result<()> {
        written.push(write_new(store, &name, contents)?);
        Ok(())
    };
    let outcome = (|| {
        if second.is_none() {
            // One message: keeps the name the mail program gave it.
            let name = if stem.is_empty() { eml_name(first.contents(), &fallback, 0) } else { format!("{}.eml", sanitize_file_name(&stem, &fallback)) };
            return write(first.contents(), name);
        }
        let first_name = eml_name(first.contents(), &fallback, 0);
        write(first.contents(), first_name)?;
        let second = second.expect("checked above");
        write(second.contents(), eml_name(second.contents(), &fallback, 1))?;
        for (i, message) in messages.enumerate() {
            let message = message?;
            write(message.contents(), eml_name(message.contents(), &fallback, i + 2))?;
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(Some(written)),
        Err(e) => {
            for file in &written {
                remove_slot(store, file);
            }
            Err(e)
        }
    }
}

/// A plain copy that keeps the modification time: the app may date a file
/// by it.
fn copy_keeping_mtime(store: &Path, path: &Path) -> io::Result<PathBuf> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let file = new_slot(store, &name)?;
    let result = (|| {
        fs::copy(path, &file)?;
        if let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) {
            let f = fs::OpenOptions::new().write(true).open(&file)?;
            f.set_modified(modified)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(file),
        Err(e) => {
            remove_slot(store, &file);
            Err(e)
        }
    }
}

/// Makes dropped paths last (see the module comment). Everything that
/// isn't an e-mail, or is one that already lies somewhere lasting and holds
/// a single message, passes through untouched — a normal file drop costs a
/// look at the path and nothing more.
pub fn adopt(store: &Path, temp_dirs: &[PathBuf], paths: Vec<String>) -> AdoptResult {
    let mut out = AdoptResult::default();
    for raw in paths {
        let path = PathBuf::from(&raw);
        let is_email = fs::metadata(&path).is_ok_and(|m| m.is_file())
            && !is_in_store(store, &path)
            && fsbrowse::classify(&path) == FileKind::Email;
        if !is_email {
            out.paths.push(raw);
            continue;
        }
        let volatile = is_volatile(&path, temp_dirs);
        let result = if starts_with_mbox_line(&path) {
            split_mbox(store, &path, volatile).map(|split| split.unwrap_or_else(|| vec![path.clone()]))
        } else if volatile {
            copy_keeping_mtime(store, &path).map(|copy| vec![copy])
        } else {
            Ok(vec![path.clone()])
        };
        match result {
            Ok(files) => out.paths.extend(files.into_iter().map(|f| f.to_string_lossy().to_string())),
            Err(_) => out.failed.push(
                path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(raw),
            ),
        }
    }
    out
}

/// Called by the frontend for every drop (`src/utils/fileDrop.ts`) before
/// the paths go into the drop box or a diary entry.
#[tauri::command(async)]
pub fn adopt_dropped_paths(app: AppHandle, paths: Vec<String>) -> Result<AdoptResult, String> {
    let store = store_dir(&app).ok_or_else(|| "no app data folder".to_string())?;
    Ok(adopt(&store, &temp_dirs(), paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-dropped-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_are_kept_inside_their_folder() {
        assert_eq!(sanitize_file_name("..\\..\\Windows\\evil.exe", "x"), "evil.exe");
        assert_eq!(sanitize_file_name("a/b/../c.eml", "x"), "c.eml");
        assert_eq!(sanitize_file_name("Re: Termin? <heute>.msg", "x"), "Re_ Termin_ _heute_.msg");
        assert_eq!(sanitize_file_name("..", "x"), "x");
        assert_eq!(sanitize_file_name("", "x"), "x");
        assert_eq!(sanitize_file_name("con.msg", "x"), "_con.msg");
        assert_eq!(sanitize_file_name("Bericht. ", "x"), "Bericht");
        let long = format!("{}.msg", "ä".repeat(300));
        let short = sanitize_file_name(&long, "x");
        assert!(short.ends_with(".msg") && short.chars().count() == MAX_NAME_CHARS, "{short}");
    }

    #[test]
    fn only_slots_count_as_stored() {
        let store = Path::new("/data/dropped_files");
        assert!(is_in_store(store, Path::new("/data/dropped_files/abc/mail.eml")));
        assert!(!is_in_store(store, Path::new("/data/dropped_files/abc/../../x/mail.eml")));
        assert!(!is_in_store(store, Path::new("/data/dropped_files/mail.eml")));
        assert!(!is_in_store(store, Path::new("/home/me/mail.eml")));
    }

    const MAIL_A: &str = "From a@example.invalid Mon Jul 14 10:15:00 2025\nFrom: A <a@example.invalid>\nSubject: Sommerfest\nDate: Mon, 14 Jul 2025 10:15:00 +0200\n\nHallo\n>From the garden\n\n";
    const MAIL_B: &str = "From b@example.invalid Tue Sep  2 18:40:00 2025\nFrom: B <b@example.invalid>\nSubject: Fotos\nDate: Tue, 02 Sep 2025 18:40:00 +0200\n\nAnbei\n";

    #[test]
    fn an_mbox_with_several_messages_becomes_one_eml_each() {
        let root = scratch();
        let (store, temp) = (root.join("store"), root.join("tmp"));
        fs::create_dir_all(temp.join("drag-n-drop-X")).unwrap();
        let mbox = temp.join("drag-n-drop-X/Nachrichten von Inbox");
        fs::write(&mbox, format!("{MAIL_A}{MAIL_B}")).unwrap();

        let result = adopt(&store, &[temp.clone()], vec![mbox.to_string_lossy().to_string()]);
        assert!(result.failed.is_empty());
        let names: Vec<_> = result.paths.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(names, ["20250714101500_Sommerfest.eml", "20250902184000_Fotos.eml"]);
        let first = fs::read_to_string(&result.paths[0]).unwrap();
        assert!(first.starts_with("From: A") && first.contains("\nFrom the garden"), "{first}");
        assert!(result.paths.iter().all(|p| is_in_store(&store, Path::new(p))));
        assert!(mbox.exists(), "the mail program's own file stays");

        // Removing the entry takes the stored copy and its folder along.
        let first = PathBuf::from(&result.paths[0]);
        discard(&store, &first);
        assert!(!first.exists() && !first.parent().unwrap().exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_single_dragged_message_in_temp_is_stored_under_its_name() {
        let root = scratch();
        let (store, temp) = (root.join("store"), root.join("tmp"));
        fs::create_dir_all(temp.join("drag-n-drop-Y")).unwrap();
        let mail = temp.join("drag-n-drop-Y/20250714101500_Sommerfest im Garten");
        fs::write(&mail, MAIL_A).unwrap();
        let photo = root.join("bild.jpg");
        fs::write(&photo, b"jpg").unwrap();

        let result = adopt(&store, &[temp], vec![mail.to_string_lossy().to_string(), photo.to_string_lossy().to_string()]);
        assert_eq!(result.paths.len(), 2);
        assert!(result.paths[0].ends_with("20250714101500_Sommerfest im Garten.eml"), "{:?}", result.paths);
        assert!(is_in_store(&store, Path::new(&result.paths[0])));
        assert_eq!(result.paths[1], photo.to_string_lossy(), "other files pass through");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_email_somewhere_lasting_stays_where_it_is() {
        let root = scratch();
        let store = root.join("store");
        let mail = root.join("Archiv/Sommerfest.eml");
        fs::create_dir_all(mail.parent().unwrap()).unwrap();
        fs::write(&mail, &MAIL_A[MAIL_A.find('\n').unwrap() + 1..]).unwrap();
        let result = adopt(&store, &[root.join("tmp")], vec![mail.to_string_lossy().to_string()]);
        assert_eq!(result.paths, [mail.to_string_lossy().to_string()]);
        assert!(!store.exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweep_keeps_referenced_and_recent_files() {
        let root = scratch();
        let store = root.join("store");
        let kept = write_new(&store, "kept.eml", b"x").unwrap();
        let orphan = write_new(&store, "orphan.eml", b"x").unwrap();
        let referenced: HashSet<PathBuf> = [kept.clone()].into_iter().collect();
        sweep(&store, &referenced, SWEEP_MIN_AGE);
        assert!(orphan.exists(), "too young to be swept");
        sweep(&store, &referenced, Duration::ZERO);
        assert!(kept.exists() && !orphan.exists());
        fs::remove_dir_all(&root).ok();
    }
}
