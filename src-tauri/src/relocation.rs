//! A stream folder that no longer sits where its database says.
//!
//! The database stores absolute paths for the files the project owns
//! (`items.stored_path`/`thumbnail_path`, `diary_attachments.stored_path`).
//! The app's own backup and duplicate rewrite them (`copy_task::rewrite_item_paths`),
//! but a folder moved or copied by hand, or a drive that is mounted under
//! another path on the next computer (another drive letter, another user's
//! `/media/<name>`), keeps pointing at the old place: files then show as
//! missing, or — for a hand-made copy — quietly point at the original's files.
//!
//! On opening, `detect` notices that and `relocate` rewrites the paths onto
//! the folder that is actually open, after a snapshot of the database. A path
//! written on Windows is split on both separators, so a stick written there
//! is understood on Linux and the other way round; any other path only on
//! `/`, since on Linux and macOS `\` is an ordinary character of a file name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::state::AppStateHandle;

/// The project's own folders, as `project_files` knows them.
const OWNED_DIRS: [&str; 3] = ["originals", "thumbnails", "diary"];

/// How many of the paths under the old root are looked up on disk. Enough
/// to tell "the files are here" from "they are not", without a stat call
/// for every file of a large stream on a slow stick.
const SAMPLE_SIZE: usize = 500;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relocation {
    /// Where the database thinks the project is, as it was written there.
    pub old_root: String,
    /// Paths that point there.
    pub total: usize,
    /// Of `checked` of them, how many exist under the open folder.
    pub checked: usize,
    pub present: usize,
}

/// Whether a stored path was written on Windows: a drive letter or a network
/// share in front. Only there is `\` a separator.
fn written_on_windows(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with(r"\\") || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// Splits a stored path into the project root it was written under (as
/// written) and the parts from the project's own folder on. The last
/// directory named like one of the project's folders counts, so a root that
/// itself contains, say, an "originals" folder is still found correctly.
fn split_stored(path: &str) -> Option<(&str, Vec<&str>)> {
    let windows = written_on_windows(path);
    let mut segments: Vec<(usize, &str)> = Vec::new();
    let mut start = 0;
    for (i, ch) in path.char_indices() {
        if ch == '/' || (windows && ch == '\\') {
            if i > start {
                segments.push((start, &path[start..i]));
            }
            start = i + 1;
        }
    }
    if start < path.len() {
        segments.push((start, &path[start..]));
    }
    // Directories only: the last segment is the file itself.
    let dirs = segments.len().checked_sub(1)?;
    let index = (0..dirs).rev().find(|&i| OWNED_DIRS.contains(&segments[i].1))?;
    let root = path[..segments[index].0].trim_end_matches(['/', '\\']);
    if root.is_empty() {
        return None;
    }
    Some((root, segments[index..].iter().map(|(_, s)| *s).collect()))
}

fn join(root: &Path, rel: &[&str]) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel {
        path.push(part);
    }
    path
}

/// Whether a root as written in the database is the open folder: the same
/// spelling, or — while the old spelling still resolves — the same place
/// under another name (a symlink, a `..`).
fn is_open_root(root: &str, project_root: &Path) -> bool {
    let normalise = |s: &str| {
        let s = if cfg!(windows) || written_on_windows(s) { s.replace('\\', "/") } else { s.to_string() };
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    if normalise(root) == normalise(&project_root.to_string_lossy()) {
        return true;
    }
    matches!((Path::new(root).canonicalize(), project_root.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn stored_paths(conn: &Connection) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for sql in [
        "SELECT stored_path FROM items",
        "SELECT thumbnail_path FROM items WHERE thumbnail_path IS NOT NULL",
        "SELECT stored_path FROM diary_attachments",
    ] {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows {
            paths.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(paths)
}

/// The old place the project's paths point at, if they point somewhere else
/// than `project_root` and its files are actually found under `project_root`.
/// `None` when everything already points here — or when the files aren't here
/// either, since rewriting the paths would then help nothing.
pub fn detect(conn: &Connection, project_root: &Path) -> Result<Option<Relocation>, String> {
    let paths = stored_paths(conn)?;
    let mut by_root: HashMap<&str, Vec<Vec<&str>>> = HashMap::new();
    for path in &paths {
        if let Some((root, rel)) = split_stored(path) {
            by_root.entry(root).or_default().push(rel);
        }
    }
    let mut foreign: Vec<(&str, Vec<Vec<&str>>)> =
        by_root.into_iter().filter(|(root, _)| !is_open_root(root, project_root)).collect();
    // The most common old place first; the name only breaks ties, so the
    // answer is the same on every open.
    foreign.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(b.0)));
    let Some((old_root, rels)) = foreign.into_iter().next() else { return Ok(None) };

    let step = rels.len().div_ceil(SAMPLE_SIZE).max(1);
    let sample: Vec<&Vec<&str>> = rels.iter().step_by(step).collect();
    let present = sample.iter().filter(|rel| join(project_root, rel).exists()).count();
    if present == 0 {
        return Ok(None);
    }
    Ok(Some(Relocation { old_root: old_root.to_string(), total: rels.len(), checked: sample.len(), present }))
}

/// `path` moved from `old_root` onto `project_root`; `None` for a path that
/// was written under any other root, which stays as it is.
fn rebased(path: &str, old_root: &str, project_root: &Path) -> Option<String> {
    let (root, rel) = split_stored(path)?;
    (root == old_root).then(|| join(project_root, &rel).to_string_lossy().into_owned())
}

/// Rewrites every path written under `old_root` onto `project_root`, in one
/// transaction. Returns how many paths changed.
pub fn relocate(conn: &Connection, project_root: &Path, old_root: &str) -> Result<usize, String> {
    let items: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, stored_path, thumbnail_path FROM items").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let attachments: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, stored_path FROM diary_attachments").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (id, stored, thumbnail) in items {
        let new_stored = rebased(&stored, old_root, project_root);
        let new_thumbnail = thumbnail.as_deref().and_then(|p| rebased(p, old_root, project_root));
        changed += usize::from(new_stored.is_some()) + usize::from(new_thumbnail.is_some());
        if new_stored.is_none() && new_thumbnail.is_none() {
            continue;
        }
        tx.execute(
            "UPDATE items SET stored_path = ?1, thumbnail_path = ?2 WHERE id = ?3",
            params![new_stored.unwrap_or(stored), new_thumbnail.or(thumbnail), id],
        )
        .map_err(|e| e.to_string())?;
    }
    for (id, stored) in attachments {
        let Some(new_stored) = rebased(&stored, old_root, project_root) else { continue };
        tx.execute("UPDATE diary_attachments SET stored_path = ?1 WHERE id = ?2", params![new_stored, id])
            .map_err(|e| e.to_string())?;
        changed += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

/// A copy of the database as it is now, next to it, before `relocate`
/// changes it: `cronostream.db.vor-pfadanpassung-<time>`.
fn snapshot(conn: &Connection, project_root: &Path) -> Result<PathBuf, String> {
    let name = format!("cronostream.db.vor-pfadanpassung-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let target = project_root.join(name);
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
        .map_err(|e| crate::trf!("Konnte die Datenbank nicht sichern: {e}", e = e))?;
    crate::safe_io::sync_file(&target).map_err(|e| crate::trf!("Konnte die Datenbank nicht sichern: {e}", e = e))?;
    Ok(target)
}

/// Whether the open stream's paths point at another place (see `detect`).
#[tauri::command(async)]
pub fn check_project_relocation(state: State<AppStateHandle>) -> Result<Option<Relocation>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    detect(&current.conn, &current.path)
}

/// Snapshots the database, then moves every path written under `old_root`
/// onto the open folder. Returns how many paths changed.
#[tauri::command(async)]
pub fn relocate_project_paths(state: State<AppStateHandle>, old_root: String) -> Result<usize, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    snapshot(&current.conn, &current.path)?;
    relocate(&current.conn, &current.path, &old_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-relocation-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A project database at `root` whose rows were written under `written_root`.
    fn project(root: &Path, written_root: &str, sep: &str, files: &[&str]) -> Connection {
        let conn = crate::project::open_project_db(root).unwrap();
        for (i, file) in files.iter().enumerate() {
            let stored = format!("{written_root}{sep}originals{sep}2020{sep}05{sep}{file}");
            let thumb = format!("{written_root}{sep}thumbnails{sep}2020{sep}05{sep}{file}.jpg");
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, thumbnail_path, file_type, resolved_timestamp,
                                    timestamp_source, added_at)
                 VALUES (?1, ?2, ?3, ?4, 'image', '2020-05-01T10:00:00Z', 'exif', '2020-05-01T10:00:00Z')",
                params![format!("id{i}"), file, stored, thumb],
            )
            .unwrap();
            std::fs::create_dir_all(root.join("originals/2020/05")).unwrap();
            std::fs::write(root.join("originals/2020/05").join(file), b"x").unwrap();
        }
        conn
    }

    #[test]
    fn splits_unix_and_windows_paths_at_the_last_project_folder() {
        assert_eq!(
            split_stored("/media/a/originals/CS/originals/2020/05/x.jpg"),
            Some(("/media/a/originals/CS", vec!["originals", "2020", "05", "x.jpg"]))
        );
        assert_eq!(
            split_stored(r"E:\Familie\CronoStream\diary\abc\brief.pdf"),
            Some((r"E:\Familie\CronoStream", vec!["diary", "abc", "brief.pdf"]))
        );
        assert_eq!(split_stored("/somewhere/else/x.jpg"), None);
        assert_eq!(split_stored("/originals/x.jpg"), None);
        assert_eq!(
            split_stored(r"\\nas\fotos\CS\thumbnails\2020\05\x.jpg"),
            Some((r"\\nas\fotos\CS", vec!["thumbnails", "2020", "05", "x.jpg"]))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_backslash_in_a_linux_file_name_stays_part_of_the_name() {
        assert_eq!(
            split_stored(r"/home/a/CS/originals/2019/05/ab12_Rechnung\2019.pdf"),
            Some(("/home/a/CS", vec!["originals", "2019", "05", r"ab12_Rechnung\2019.pdf"]))
        );
        let root = temp_dir("backslash");
        let conn = project(&root, "/old/place", "/", &[r"Rechnung\2019.pdf"]);
        relocate(&conn, &root, "/old/place").unwrap();
        let stored: String = conn.query_row("SELECT stored_path FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(PathBuf::from(stored), root.join("originals/2020/05").join(r"Rechnung\2019.pdf"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_project_where_it_was_written_needs_nothing() {
        let root = temp_dir("same");
        let conn = project(&root, &root.to_string_lossy(), "/", &["a.jpg", "b.jpg"]);
        assert_eq!(detect(&conn, &root).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_moved_folder_is_found_and_rewritten() {
        let root = temp_dir("moved");
        let conn = project(&root, "/media/old-user/Stick/Mein Leben", "/", &["a.jpg", "b.jpg"]);
        let found = detect(&conn, &root).unwrap().unwrap();
        assert_eq!(found.old_root, "/media/old-user/Stick/Mein Leben");
        assert_eq!((found.total, found.checked, found.present), (4, 4, 2));

        assert_eq!(relocate(&conn, &root, &found.old_root).unwrap(), 4);
        let stored: String = conn.query_row("SELECT stored_path FROM items WHERE id = 'id0'", [], |r| r.get(0)).unwrap();
        let thumb: String = conn.query_row("SELECT thumbnail_path FROM items WHERE id = 'id0'", [], |r| r.get(0)).unwrap();
        assert_eq!(PathBuf::from(stored), root.join("originals/2020/05/a.jpg"));
        assert_eq!(PathBuf::from(thumb), root.join("thumbnails/2020/05/a.jpg.jpg"));
        assert_eq!(detect(&conn, &root).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_stick_written_on_windows_is_understood_here() {
        let root = temp_dir("windows");
        let conn = project(&root, r"E:\CronoStream", r"\", &["a.jpg"]);
        let found = detect(&conn, &root).unwrap().unwrap();
        assert_eq!(found.old_root, r"E:\CronoStream");
        relocate(&conn, &root, &found.old_root).unwrap();
        let stored: String = conn.query_row("SELECT stored_path FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(PathBuf::from(stored), root.join("originals").join("2020").join("05").join("a.jpg"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nothing_is_offered_when_the_files_are_not_here_either() {
        let root = temp_dir("empty");
        let conn = project(&root, "/old/place", "/", &["a.jpg"]);
        std::fs::remove_dir_all(root.join("originals")).unwrap();
        assert_eq!(detect(&conn, &root).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn diary_attachments_move_along_and_other_roots_stay() {
        let root = temp_dir("diary");
        let conn = project(&root, "/old/place", "/", &["a.jpg"]);
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
             VALUES ('d1', 'Eintrag', '/old/place/diary/d1/entry.txt', 'diary', '2020-05-01T10:00:00Z', 'manual', '2020-05-01T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO diary_attachments (id, diary_id, original_filename, stored_path, file_type, position, added_at)
             VALUES ('att', 'd1', 'foto.jpg', '/old/place/diary/d1/anhang/foto.jpg', 'image', 0, '2020-05-01T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp, timestamp_source, added_at)
             VALUES ('x', 'x.jpg', '/elsewhere/originals/2020/05/x.jpg', 'image', '2020-05-01T10:00:00Z', 'exif', '2020-05-01T10:00:00Z')",
            [],
        )
        .unwrap();
        relocate(&conn, &root, "/old/place").unwrap();
        let attachment: String = conn.query_row("SELECT stored_path FROM diary_attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(PathBuf::from(attachment), root.join("diary/d1/anhang/foto.jpg"));
        let other: String = conn.query_row("SELECT stored_path FROM items WHERE id = 'x'", [], |r| r.get(0)).unwrap();
        assert_eq!(other, "/elsewhere/originals/2020/05/x.jpg");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_snapshot_keeps_the_database_as_it_was() {
        let root = temp_dir("snapshot");
        let conn = project(&root, "/old/place", "/", &["a.jpg"]);
        let copy = snapshot(&conn, &root).unwrap();
        relocate(&conn, &root, "/old/place").unwrap();
        let before = Connection::open(&copy).unwrap();
        let stored: String = before.query_row("SELECT stored_path FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "/old/place/originals/2020/05/a.jpg");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
