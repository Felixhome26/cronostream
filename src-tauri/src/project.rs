use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::schema::{self, SCHEMA};
use crate::settings;

pub const DB_FILENAME: &str = "cronostream.db";
/// The database's name before the app was renamed from LifeStream. A stream
/// that still has it gets the new name when it is opened (`adopt_legacy_db`).
pub const LEGACY_DB_FILENAME: &str = "lifestream.db";
pub(crate) const PROJECT_NAME_KEY: &str = "project_name";

#[derive(Serialize, Clone, Debug)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
}

/// The stream's database file, under whichever name it has right now. Only
/// reads: a stream still carrying the LifeStream name keeps it here, since
/// callers peek at streams that may be open elsewhere, and renaming a
/// database under an open connection leaves SQLite's journal behind under
/// the old name. The rename happens in `adopt_legacy_db`, on opening.
pub fn db_path(project_path: &Path) -> PathBuf {
    let path = project_path.join(DB_FILENAME);
    if path.exists() {
        return path;
    }
    let legacy = project_path.join(LEGACY_DB_FILENAME);
    if legacy.is_file() {
        legacy
    } else {
        path
    }
}

/// Renames a stream's database from its LifeStream name. Called only where
/// no connection of this app can be open on it: when the stream is opened,
/// before its connection is (`commands::activate_project`), and on a backup
/// about to be updated. Returns whether the database was renamed.
///
/// Closing a connection folds SQLite's side files back into the database,
/// so the one file is all there is to rename: a database moved without its
/// write-ahead log or journal would lose what they still hold. Whenever that
/// can't be ensured (an old LifeStream has the stream open, a read-only
/// drive), the database keeps its old name and is used under it.
pub fn adopt_legacy_db(project_path: &Path) -> bool {
    let current = project_path.join(DB_FILENAME);
    let legacy = project_path.join(LEGACY_DB_FILENAME);
    if current.exists() || !legacy.is_file() {
        return false;
    }
    if matches!(crate::lock::check_legacy(project_path), crate::lock::LockState::Active { .. }) {
        return false;
    }
    if !settle_side_files(&legacy) {
        return false;
    }
    if current.exists() || fs::rename(&legacy, &current).is_err() {
        return false;
    }
    let _ = fs::remove_file(project_path.join(crate::lock::LEGACY_LOCK_FILENAME));
    true
}

/// Folds a database's write-ahead log and a journal a crash left behind
/// back into the database file, so that file alone holds everything and can
/// be renamed, copied or replaced. Returns whether it worked; it doesn't
/// while another connection is open on the database, or on a read-only
/// drive. A leftover `-shm` (only an index of the log) is removed then.
///
/// Opens without `SQLITE_OPEN_CREATE`: a database that is not (or no
/// longer) there fails instead of being created empty.
pub fn settle_side_files(db: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    // The first read plays back a journal a crash left behind; closing the
    // last connection checkpoints and removes the write-ahead log.
    if conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).is_err() {
        return false;
    }
    if conn.close().is_err() {
        return false;
    }
    let side_file = |suffix: &str| {
        let mut name = db.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    if side_file("-wal").exists() || side_file("-journal").exists() {
        return false;
    }
    let _ = fs::remove_file(side_file("-shm"));
    true
}

pub fn is_project_folder(project_path: &Path) -> bool {
    db_path(project_path).is_file()
}

fn project_name_from_path(project_path: &Path) -> String {
    project_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| project_path.to_string_lossy().to_string())
}

/// Strips characters that aren't safe in folder names across Windows/macOS/
/// Linux, so the user-entered project name can double as the folder name.
pub fn sanitize_folder_name(name: &str) -> String {
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    name.chars()
        .filter(|c| !INVALID.contains(c) && !c.is_control())
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .trim()
        .to_string()
}

/// Creates a brand-new project named `name` as a new subfolder of
/// `parent_path` (the folder the user picked as the storage location).
/// Fails if a folder with that name already exists there.
pub fn create_project_in(parent_path: &Path, name: &str) -> Result<PathBuf, String> {
    let folder_name = sanitize_folder_name(name);
    if folder_name.is_empty() {
        return Err(crate::i18n::tr("Bitte einen gültigen Namen eingeben.").into());
    }

    let project_path = parent_path.join(&folder_name);
    if project_path.exists() {
        return Err(
            crate::i18n::tr("Ein Ordner mit diesem Namen existiert bereits an diesem Ort. Bitte einen anderen Namen wählen.").into(),
        );
    }

    create_project_at(&project_path, name)?;
    Ok(project_path)
}

/// Initializes a brand-new project at `project_path`: creates the originals/
/// and thumbnails/ subfolders and a fresh SQLite database with the schema.
/// The chosen display `name` is stored inside the project itself (not just
/// derived from the folder name), so it stays correct even if the folder is
/// later renamed or moved.
fn create_project_at(project_path: &Path, name: &str) -> Result<ProjectInfo, String> {
    if is_project_folder(project_path) {
        return Err(crate::i18n::tr("Dieser Ordner enthält bereits einen Stream.").into());
    }

    fs::create_dir_all(project_path.join("originals"))
        .map_err(|e| crate::trf!("Konnte Ordnerstruktur nicht anlegen: {e}", e = e))?;
    fs::create_dir_all(project_path.join("thumbnails"))
        .map_err(|e| crate::trf!("Konnte Ordnerstruktur nicht anlegen: {e}", e = e))?;

    let conn = Connection::open(db_path(project_path))
        .map_err(|e| crate::trf!("Konnte Datenbank des Streams nicht anlegen: {e}", e = e))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| crate::trf!("Konnte Datenbankschema nicht anlegen: {e}", e = e))?;
    settings::set(&conn, PROJECT_NAME_KEY, name)?;

    Ok(ProjectInfo {
        path: project_path.to_string_lossy().to_string(),
        name: name.to_string(),
    })
}

/// Opens the SQLite connection for an existing project folder (must already
/// contain a cronostream.db, see `is_project_folder`).
pub fn open_project_db(project_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path(project_path))
        .map_err(|e| crate::trf!("Konnte Datenbank des Streams nicht öffnen: {e}", e = e))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| crate::trf!("Konnte Datenbankschema nicht prüfen: {e}", e = e))?;
    schema::migrate(&conn)?;
    Ok(conn)
}

/// The project's display name: read from its own settings if present
/// (the source of truth), falling back to the folder name for robustness.
pub fn project_info(conn: &Connection, project_path: &Path) -> ProjectInfo {
    let name = settings::get(conn, PROJECT_NAME_KEY)
        .ok()
        .flatten()
        .unwrap_or_else(|| project_name_from_path(project_path));
    ProjectInfo {
        path: project_path.to_string_lossy().to_string(),
        name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-project-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn legacy_stream() -> PathBuf {
        let dir = scratch();
        let conn = Connection::open(dir.join(LEGACY_DB_FILENAME)).unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('alt');")
            .unwrap();
        drop(conn);
        dir
    }

    #[test]
    fn a_lifestream_database_is_renamed_with_its_contents() {
        let dir = legacy_stream();
        fs::write(dir.join(crate::lock::LEGACY_LOCK_FILENAME), "999999999").unwrap();
        assert!(adopt_legacy_db(&dir));
        assert_eq!(db_path(&dir), dir.join(DB_FILENAME));
        assert!(!dir.join(LEGACY_DB_FILENAME).exists());
        assert!(!dir.join(crate::lock::LEGACY_LOCK_FILENAME).exists());
        let conn = Connection::open(dir.join(DB_FILENAME)).unwrap();
        let v: String = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "alt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stream_an_old_lifestream_has_open_keeps_its_database_name() {
        let dir = legacy_stream();
        fs::write(dir.join(crate::lock::LEGACY_LOCK_FILENAME), std::process::id().to_string()).unwrap();
        assert!(!adopt_legacy_db(&dir));
        assert_eq!(db_path(&dir), dir.join(LEGACY_DB_FILENAME));
        assert!(!dir.join(DB_FILENAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn looking_up_a_lifestream_database_renames_nothing() {
        let dir = legacy_stream();
        assert!(is_project_folder(&dir));
        assert_eq!(db_path(&dir), dir.join(LEGACY_DB_FILENAME));
        assert!(dir.join(LEGACY_DB_FILENAME).is_file());
        assert!(!dir.join(DB_FILENAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adopting_without_a_lifestream_database_creates_none() {
        let dir = scratch();
        assert!(!adopt_legacy_db(&dir));
        assert!(!dir.join(LEGACY_DB_FILENAME).exists());
        assert!(!dir.join(DB_FILENAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
