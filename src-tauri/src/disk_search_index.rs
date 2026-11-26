use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::fsbrowse::FileKind;

/// Persistent cache of a full recursive file listing per searched root
/// folder — lets "schnell aus Cache laden" skip walking the disk entirely,
/// and lets re-filtering an already-indexed root (a different file type, a
/// different size range, ...) stay instant instead of re-walking for every
/// tweak. Keyed by (root_path, path), so indexing one root never touches
/// another root's cached rows — same reasoning as `preview_cache`'s
/// per-file cache, just partitioned per search root instead of per file.
///
/// A real newtype, not a `type X = Mutex<Connection>` alias: Tauri's
/// `manage()` keys on the exact Rust type, and a bare alias here would
/// resolve to the *same* type as `preview_cache::PreviewCacheHandle` (also
/// `Mutex<Connection>`) — exactly the collision documented in `lib.rs`'s
/// `assert!`s, which is why every sidecar DB handle in this app is a
/// newtype instead.
pub struct DiskSearchIndexHandle(pub Mutex<Connection>);

/// One cached file, independent of any particular search's filters — the
/// kind/size/timestamps needed to re-evaluate any future filter combination
/// against this root without touching the disk again.
#[derive(Clone, Debug)]
pub struct IndexedEntry {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub created_secs: Option<i64>,
    pub modified_secs: Option<i64>,
}

pub fn open(app_config_dir: &Path) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_config_dir).ok();
    let conn = Connection::open(app_config_dir.join("disk_search_index.sqlite"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         CREATE TABLE IF NOT EXISTS disk_search_index (
             root_path TEXT NOT NULL,
             path TEXT NOT NULL,
             name TEXT NOT NULL,
             kind TEXT NOT NULL,
             size INTEGER NOT NULL,
             created_secs INTEGER,
             modified_secs INTEGER,
             PRIMARY KEY (root_path, path)
         );
         CREATE INDEX IF NOT EXISTS idx_disk_search_index_root ON disk_search_index(root_path);",
    )?;
    Ok(conn)
}

pub fn has_root(conn: &Connection, root_path: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM disk_search_index WHERE root_path = ?1)",
        params![root_path],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

/// Replaces every cached row for `root_path` with `entries` in one
/// transaction ("Neu indizieren") — same delete-then-reinsert-in-a-
/// transaction shape as `print_export::set_print_selection`, so a search
/// reading the cache mid-reindex can never see a half-written root.
pub fn replace_root(conn: &mut Connection, root_path: &str, entries: &[IndexedEntry]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| crate::trf!("Konnte Such-Index nicht speichern: {e}", e = e))?;
    tx.execute("DELETE FROM disk_search_index WHERE root_path = ?1", params![root_path])
        .map_err(|e| crate::trf!("Konnte Such-Index nicht speichern: {e}", e = e))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO disk_search_index (root_path, path, name, kind, size, created_secs, modified_secs)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| crate::trf!("Konnte Such-Index nicht speichern: {e}", e = e))?;
        for e in entries {
            stmt.execute(params![root_path, e.path, e.name, e.kind.as_str(), e.size as i64, e.created_secs, e.modified_secs])
                .map_err(|e| crate::trf!("Konnte Such-Index nicht speichern: {e}", e = e))?;
        }
    }
    tx.commit().map_err(|e| crate::trf!("Konnte Such-Index nicht speichern: {e}", e = e))
}

pub fn load_root(conn: &Connection, root_path: &str) -> Result<Vec<IndexedEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT path, name, kind, size, created_secs, modified_secs FROM disk_search_index WHERE root_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![root_path], |row| {
            let kind_str: String = row.get(2)?;
            Ok(IndexedEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                kind: FileKind::from_str(&kind_str).unwrap_or(FileKind::Other),
                size: row.get::<_, i64>(3)? as u64,
                created_secs: row.get(4)?,
                modified_secs: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirrors `open`'s schema without touching a real app_config_dir.
        conn.execute_batch(
            "CREATE TABLE disk_search_index (
                root_path TEXT NOT NULL,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_secs INTEGER,
                modified_secs INTEGER,
                PRIMARY KEY (root_path, path)
            );",
        )
        .unwrap();
        conn
    }

    fn entry(path: &str, name: &str) -> IndexedEntry {
        IndexedEntry {
            path: path.to_string(),
            name: name.to_string(),
            kind: FileKind::Image,
            size: 100,
            created_secs: Some(1000),
            modified_secs: Some(2000),
        }
    }

    #[test]
    fn a_fresh_root_has_no_index_yet() {
        let conn = test_conn();
        assert!(!has_root(&conn, "/some/root"));
    }

    #[test]
    fn indexing_a_root_makes_it_loadable() {
        let mut conn = test_conn();
        replace_root(&mut conn, "/root", &[entry("/root/a.jpg", "a.jpg")]).unwrap();

        assert!(has_root(&conn, "/root"));
        let loaded = load_root(&conn, "/root").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "a.jpg");
    }

    #[test]
    fn reindexing_a_root_replaces_its_old_entries_entirely() {
        let mut conn = test_conn();
        replace_root(&mut conn, "/root", &[entry("/root/old.jpg", "old.jpg")]).unwrap();
        replace_root(&mut conn, "/root", &[entry("/root/new.jpg", "new.jpg")]).unwrap();

        let loaded = load_root(&conn, "/root").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "new.jpg");
    }

    #[test]
    fn indexing_one_root_never_touches_another() {
        let mut conn = test_conn();
        replace_root(&mut conn, "/root-a", &[entry("/root-a/a.jpg", "a.jpg")]).unwrap();
        replace_root(&mut conn, "/root-b", &[entry("/root-b/b.jpg", "b.jpg")]).unwrap();

        assert_eq!(load_root(&conn, "/root-a").unwrap().len(), 1);
        assert_eq!(load_root(&conn, "/root-b").unwrap().len(), 1);
    }
}
