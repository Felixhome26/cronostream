use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

const FILE_NAME: &str = "preview_cache.sqlite";

/// Upper bound for the cached image bytes of each of the two tables. The
/// cache used to grow without limit, and one disk search over a big photo
/// folder could leave gigabytes behind. Evicting only ever costs a preview
/// being decoded again the next time it is shown.
const TABLE_BUDGET_BYTES: i64 = 512 * 1024 * 1024;

/// How many writes go by between two budget checks: summing the sizes is a
/// scan over the whole table (the blobs themselves aren't read), cheap but
/// not something every single insert needs to pay for.
const PRUNE_EVERY_WRITES: u32 = 200;

static WRITES_SINCE_PRUNE: AtomicU32 = AtomicU32::new(0);

/// Where the cache lives: the user's cache folder (`~/.cache/cronostream` on
/// Linux), where a cache belongs — not the config folder, which people back
/// up. Falls back to `fallback_dir` on a system without a cache folder.
fn cache_file(fallback_dir: &Path) -> PathBuf {
    dirs::cache_dir()
        .map(|dir| dir.join("cronostream"))
        .unwrap_or_else(|| fallback_dir.to_path_buf())
        .join(FILE_NAME)
}

/// Removes the cache an older version kept in the config folder. Nothing
/// in it is lost: every entry is regenerated from its source file on demand.
fn remove_legacy_cache(app_config_dir: &Path, current: &Path) {
    let legacy = app_config_dir.join(FILE_NAME);
    if legacy == current {
        return;
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut name = legacy.clone().into_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// Persistent cache for browse-time previews, keyed by absolute path plus
/// the source file's mtime/size — so a changed file is regenerated but an
/// unchanged one (the common case: re-opening the same folder) is served
/// straight from disk instead of re-decoding/re-resizing every time.
pub type PreviewCacheHandle = Mutex<Connection>;

pub fn open(app_config_dir: &Path) -> rusqlite::Result<Connection> {
    let file = cache_file(app_config_dir);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    remove_legacy_cache(app_config_dir, &file);
    let conn = Connection::open(&file)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         CREATE TABLE IF NOT EXISTS preview_cache (
             path TEXT PRIMARY KEY,
             mtime INTEGER NOT NULL,
             size INTEGER NOT NULL,
             data BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS full_preview_cache_sized (
             path TEXT NOT NULL,
             max_dim INTEGER NOT NULL,
             mtime INTEGER NOT NULL,
             size INTEGER NOT NULL,
             data BLOB NOT NULL,
             PRIMARY KEY (path, max_dim)
         );
         -- Superseded by the table above, which keys by rendition size too.
         -- Dropped rather than migrated: every row in it is a rendition
         -- this version would no longer produce (single 2048px tier, and
         -- generated before the orientation/colour-space fixes), and the
         -- whole cache regenerates on demand anyway.
         DROP TABLE IF EXISTS full_preview_cache;",
    )?;
    prune(&conn);
    Ok(conn)
}

/// Drops the oldest entries of a table until its cached bytes fit the
/// budget. "Oldest" is insertion order: `INSERT OR REPLACE` gives a
/// regenerated entry a new rowid, so what was written longest ago goes first.
fn prune_table(conn: &Connection, table: &str, budget: i64) -> rusqlite::Result<()> {
    let total: i64 = conn.query_row(&format!("SELECT COALESCE(SUM(length(data)), 0) FROM {table}"), [], |row| row.get(0))?;
    let mut excess = total - budget;
    if excess <= 0 {
        return Ok(());
    }
    // A quarter of the budget below the limit, so the next check doesn't
    // find the table over budget again after a handful of writes.
    excess += budget / 4;
    let mut cutoff: Option<i64> = None;
    {
        let mut stmt = conn.prepare(&format!("SELECT rowid, length(data) FROM {table} ORDER BY rowid"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            cutoff = Some(row.get(0)?);
            excess -= row.get::<_, i64>(1)?;
            if excess <= 0 {
                break;
            }
        }
    }
    if let Some(cutoff) = cutoff {
        conn.execute(&format!("DELETE FROM {table} WHERE rowid <= ?1"), params![cutoff])?;
    }
    Ok(())
}

fn prune(conn: &Connection) {
    for table in ["preview_cache", "full_preview_cache_sized"] {
        let _ = prune_table(conn, table, TABLE_BUDGET_BYTES);
    }
}

fn note_write(conn: &Connection) {
    if WRITES_SINCE_PRUNE.fetch_add(1, Ordering::Relaxed) + 1 >= PRUNE_EVERY_WRITES {
        WRITES_SINCE_PRUNE.store(0, Ordering::Relaxed);
        prune(conn);
    }
}

pub fn get(conn: &Connection, path: &str, mtime: i64, size: i64) -> Option<Vec<u8>> {
    conn.query_row(
        "SELECT data FROM preview_cache WHERE path = ?1 AND mtime = ?2 AND size = ?3",
        params![path, mtime, size],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set(conn: &Connection, path: &str, mtime: i64, size: i64, data: &[u8]) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO preview_cache (path, mtime, size, data) VALUES (?1, ?2, ?3, ?4)",
        params![path, mtime, size, data],
    );
    note_write(conn);
}

/// The sharp views need far larger renditions than the browse grid's 480px
/// tiles — and two different ones at that: the single-image view fills a
/// whole window, the file browser's preview panel a column of it. All of
/// them are keyed by path, so they'd overwrite each other in one table —
/// hence a second table (keyed by path *and* rendition size) rather than a
/// second cache file, keeping everything in the same database/connection
/// as before.
pub fn get_full(conn: &Connection, path: &str, max_dim: u32, mtime: i64, size: i64) -> Option<Vec<u8>> {
    conn.query_row(
        "SELECT data FROM full_preview_cache_sized WHERE path = ?1 AND max_dim = ?2 AND mtime = ?3 AND size = ?4",
        params![path, max_dim, mtime, size],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_full(conn: &Connection, path: &str, max_dim: u32, mtime: i64, size: i64, data: &[u8]) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO full_preview_cache_sized (path, max_dim, mtime, size, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![path, max_dim, mtime, size, data],
    );
    note_write(conn);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruning_drops_the_oldest_entries_until_the_table_fits_its_budget() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE preview_cache (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);").unwrap();
        // Ten entries of a fifth of the budget each.
        for i in 0..10 {
            conn.execute(
                "INSERT INTO preview_cache (path, mtime, size, data) VALUES (?1, 0, 0, zeroblob(?2))",
                params![format!("/p/{i}"), 200],
            )
            .unwrap();
        }
        prune_table(&conn, "preview_cache", 1000).unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT path FROM preview_cache ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // 10 fifths is 5 fifths over; another quarter of headroom drops 7.
        assert_eq!(left, vec!["/p/7", "/p/8", "/p/9"]);
    }

    #[test]
    fn a_table_within_its_budget_is_left_alone() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE preview_cache (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);").unwrap();
        conn.execute("INSERT INTO preview_cache VALUES ('/a', 0, 0, zeroblob(500))", []).unwrap();
        prune_table(&conn, "preview_cache", 1000).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM preview_cache", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
