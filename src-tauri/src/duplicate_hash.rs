use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::Serialize;
use tauri::Manager;

/// Fast, non-cryptographic fingerprint (FNV-1a over the size plus up to the
/// first and last 64KB) — cheap enough that reading two whole files
/// wouldn't be worth it, but reliable enough to rule files in or out before
/// ever reaching for a real content hash. Used both by the existing
/// pending-drops duplicate check (`browse_commands::check_pending_duplicates`)
/// and by the disk search's duplicate detection below.
pub(crate) fn quick_hash(path: &Path) -> std::io::Result<u64> {
    const SAMPLE: u64 = 64 * 1024;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut hash = 0xcbf29ce484222325u64;
    let feed = |hash: &mut u64, bytes: &[u8]| {
        for &b in bytes {
            *hash ^= b as u64;
            *hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    feed(&mut hash, &len.to_le_bytes());

    let head_len = SAMPLE.min(len) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)?;
    feed(&mut hash, &head);

    if len > SAMPLE {
        let tail_start = len - SAMPLE;
        file.seek(SeekFrom::Start(tail_start))?;
        let mut tail = vec![0u8; SAMPLE as usize];
        file.read_exact(&mut tail)?;
        feed(&mut hash, &tail);
    }
    Ok(hash)
}

/// Real whole-file content hash (BLAKE3) — the expensive, final-word tier,
/// only ever reached when `quick_hash` already agrees and the user has
/// switched the disk search's "auch Dateiinhalt vergleichen" toggle to
/// "sicher". Streamed in 64KB chunks so a large video doesn't need to be
/// read into memory at once.
pub(crate) fn blake3_hash(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Returns `item_id`'s cached quick-hash, computing and caching it first if
/// this is the first time anything has asked. Computed from the item's own
/// in-project copy (`stored_path`), never from the source file that
/// triggered the lookup — the cached value is reused across every future
/// disk search, not just this one.
pub(crate) fn ensure_item_quick_hash(conn: &Connection, item_id: &str, stored_path: &Path) -> Option<u64> {
    let cached: Option<i64> = conn
        .query_row("SELECT quick_hash FROM item_hashes WHERE item_id = ?1", params![item_id], |row| row.get(0))
        .optional()
        .ok()
        .flatten();
    if let Some(h) = cached {
        return Some(h as u64);
    }

    let hash = quick_hash(stored_path).ok()?;
    store_quick_hash(conn, item_id, hash);
    Some(hash)
}

/// Writes an already-known `quick_hash` for `item_id` — no file I/O, just
/// the cache write `ensure_item_quick_hash` itself does after computing one.
/// Split out so a caller that already has the value (an ingest that
/// computed it in parallel, see `items::prepare_item`, or a batch backfill,
/// see `scan_project_for_duplicates`) doesn't have to go through the
/// lazy-compute path just to store it.
pub(crate) fn store_quick_hash(conn: &Connection, item_id: &str, hash: u64) {
    let _ = conn.execute(
        "INSERT INTO item_hashes (item_id, quick_hash) VALUES (?1, ?2)
         ON CONFLICT(item_id) DO UPDATE SET quick_hash = excluded.quick_hash",
        params![item_id, hash as i64],
    );
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiskSearchDuplicate {
    pub existing_item_id: String,
    pub existing_display_name: String,
    pub existing_thumbnail_path: Option<String>,
    pub existing_resolved_timestamp: String,
    /// Whether the match was confirmed by a real content hash (the "sicher"
    /// tier) rather than just size + `quick_hash` ("schnell"). Lets the
    /// frontend show the match with the right amount of confidence.
    pub content_verified: bool,
}

/// Checks whether a disk-search hit at `path`/`size` matches a file already
/// in the project — cheapest signal first, each stage only run for
/// candidates that passed the previous one:
/// 1. **Size** — a plain SQL filter, free (already known from the scan).
/// 2. **`quick_hash`** — bounded read (≤128KB) of both the disk file and
///    the candidate's in-project copy.
/// 3. **`blake3` full hash** — only when `verify_content` is true, i.e. the
///    search's "auch Dateiinhalt vergleichen" toggle is set to "sicher".
///
/// Returns the first matching candidate, or `None` if nothing on disk with
/// the same size is in the project, or none of them actually match.
#[cfg(test)]
pub(crate) fn find_duplicate(conn: &Connection, path: &Path, size: u64, verify_content: bool) -> Option<DiskSearchDuplicate> {
    find_duplicate_with(
        &|work| {
            work(conn);
            Ok(())
        },
        path,
        size,
        verify_content,
    )
}

/// One database step for `find_duplicate_with`: runs the closure with the
/// connection — in the app under the project lock, just for that step — or
/// fails when the project is gone.
pub(crate) type WithDb<'a> = dyn Fn(&mut dyn FnMut(&Connection)) -> Result<(), String> + 'a;

/// The same answer as `find_duplicate`, with the database touched only in
/// two short steps — the candidates and their cached hashes up front, any
/// newly computed hashes at the end — and all the reading and hashing of
/// files in between, with nothing locked. Run under the project lock as a
/// whole, a disk search over a few thousand hits held that lock for
/// minutes, and every other command waited behind it.
pub(crate) fn find_duplicate_with(
    with_db: &WithDb,
    path: &Path,
    size: u64,
    verify_content: bool,
) -> Option<DiskSearchDuplicate> {
    struct Candidate {
        id: String,
        stored_path: String,
        display_name: Option<String>,
        original_filename: String,
        thumbnail_path: Option<String>,
        resolved_timestamp: String,
        quick_hash: Option<u64>,
        content_hash: Option<String>,
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    with_db(&mut |conn| {
        let Ok(mut stmt) = conn.prepare(
            "SELECT i.id, i.stored_path, i.display_name, i.original_filename, i.thumbnail_path,
                    i.resolved_timestamp, h.quick_hash, h.blake3_hash
             FROM items i LEFT JOIN item_hashes h ON h.item_id = i.id
             WHERE i.removed_at IS NULL AND i.file_size_bytes = ?1",
        ) else {
            return;
        };
        let rows = stmt.query_map(params![size as i64], |row| {
            Ok(Candidate {
                id: row.get(0)?,
                stored_path: row.get(1)?,
                display_name: row.get(2)?,
                original_filename: row.get(3)?,
                thumbnail_path: row.get(4)?,
                resolved_timestamp: row.get(5)?,
                quick_hash: row.get::<_, Option<i64>>(6)?.map(|h| h as u64),
                content_hash: row.get(7)?,
            })
        });
        if let Ok(rows) = rows {
            candidates = rows.flatten().collect();
        }
    })
    .ok()?;

    if candidates.is_empty() {
        return None;
    }

    let source_quick_hash = quick_hash(path).ok()?;
    let mut new_quick: Vec<(String, u64)> = Vec::new();
    let mut new_content: Vec<(String, String)> = Vec::new();
    let mut found = None;

    for candidate in &candidates {
        let stored_path = Path::new(&candidate.stored_path);
        let item_hash = match candidate.quick_hash {
            Some(hash) => hash,
            None => {
                let Ok(hash) = quick_hash(stored_path) else { continue };
                new_quick.push((candidate.id.clone(), hash));
                hash
            }
        };
        if item_hash != source_quick_hash {
            continue;
        }

        let content_verified = if verify_content {
            let Some(source_content_hash) = blake3_hash(path).ok() else { continue };
            let item_content_hash = match &candidate.content_hash {
                Some(hash) => hash.clone(),
                None => {
                    let Ok(hash) = blake3_hash(stored_path) else { continue };
                    new_content.push((candidate.id.clone(), hash.clone()));
                    hash
                }
            };
            if source_content_hash != item_content_hash {
                continue;
            }
            true
        } else {
            false
        };

        found = Some(DiskSearchDuplicate {
            existing_item_id: candidate.id.clone(),
            existing_display_name: candidate.display_name.clone().unwrap_or_else(|| candidate.original_filename.clone()),
            existing_thumbnail_path: candidate.thumbnail_path.clone(),
            existing_resolved_timestamp: candidate.resolved_timestamp.clone(),
            content_verified,
        });
        break;
    }

    // Kept for the next search, as `ensure_item_*_hash` would have — best
    // effort: a project closed meanwhile simply doesn't get them.
    if !new_quick.is_empty() || !new_content.is_empty() {
        let _ = with_db(&mut |conn| {
            for (id, hash) in &new_quick {
                store_quick_hash(conn, id, *hash);
            }
            for (id, hash) in &new_content {
                let _ = conn.execute(
                    "INSERT INTO item_hashes (item_id, blake3_hash) VALUES (?1, ?2)
                     ON CONFLICT(item_id) DO UPDATE SET blake3_hash = excluded.blake3_hash",
                    params![id, hash],
                );
            }
        });
    }
    found
}

/// Checks each of `paths` (files currently shown in the regular folder
/// browser, not a disk search) against the open project and returns just
/// the ones whose content already exists there — the "Bereits im Projekt
/// enthaltene Dateien ausblenden" toggle in the Übersicht grid filters its
/// tiles down to the complement of this list. Always "schnell" (size +
/// `quick_hash` only): the everyday browsing grid doesn't expose the
/// gründlich/schnell choice the disk search does, to keep it simple there.
///
/// Doesn't call `find_duplicate` per path (that would mean one `items`
/// query per path, same size group re-fetched over and over) — instead
/// loads every live item's size once up front, then only ever does the real
/// per-file I/O (`quick_hash` of the browsed file) in parallel, same
/// reasoning as `scan_project_for_duplicates`'s own split. The project-side
/// `ensure_item_quick_hash` lookups stay sequential (they need the single
/// `Connection`), but only run for the — usually few — same-size
/// candidates, not for every browsed path regardless of whether anything
/// could even match.
#[tauri::command]
pub async fn check_already_in_project(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::state::AppStateHandle>();

        // The state lock is held for the size index here and for the final
        // comparison below, not for the parallel hashing in between.
        let (project_path, by_size) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let mut stmt = current
                .conn
                .prepare("SELECT id, stored_path, file_size_bytes FROM items WHERE removed_at IS NULL AND file_size_bytes IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let mut by_size: HashMap<u64, Vec<(String, String)>> = HashMap::new();
            for (id, stored_path, size) in stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
                .map_err(|e| e.to_string())?
                .flatten()
            {
                by_size.entry(size as u64).or_default().push((id, stored_path));
            }
            (current.path.clone(), by_size)
        };

        // Pure file I/O, no `Connection` involved — safe to spread across
        // workers. A path whose size has no same-size item at all is
        // rejected here without ever reading it, since it cannot possibly
        // match regardless of its hash.
        let by_size = &by_size;
        let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(paths.len().max(1));
        let mut chunks: Vec<Vec<String>> = (0..worker_count.max(1)).map(|_| Vec::new()).collect();
        for (i, path) in paths.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(path);
        }
        let candidates_by_path: Vec<(String, u64, u64)> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .filter_map(|path| {
                                let size = std::fs::metadata(&path).ok()?.len();
                                if !by_size.contains_key(&size) {
                                    return None;
                                }
                                let hash = quick_hash(Path::new(&path)).ok()?;
                                Some((path, size, hash))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        // Small by construction: only paths that already passed the size
        // pre-filter above reach this sequential, `Connection`-owning part.
        let guard = crate::state::lock_project(&state, &project_path)?;
        let conn = &guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.conn;
        let mut matches = Vec::new();
        'paths: for (path, size, source_hash) in candidates_by_path {
            let Some(size_candidates) = by_size.get(&size) else { continue };
            for (id, stored_path) in size_candidates {
                let Some(item_hash) = ensure_item_quick_hash(conn, id, Path::new(stored_path)) else { continue };
                if item_hash == source_hash {
                    matches.push(path);
                    continue 'paths;
                }
            }
        }
        Ok(matches)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// A set of live items that `quick_hash` cannot tell apart — the same
/// "schnell" confidence `find_duplicate` relies on elsewhere, not a full
/// content hash. Driven by the Einstellungen "Jetzt Duplikat-Prüfung
/// durchführen" button and by the "Beim Einfügen auf Duplikate prüfen"
/// setting's own check, so the frontend can hand the ids straight to
/// Datei-Operationen for the user to look at and decide what to keep.
#[derive(Serialize, Clone, Debug)]
pub struct DuplicateGroup {
    pub item_ids: Vec<String>,
}

/// Groups `candidate_ids` (the items a batch just inserted) with any other
/// live item sharing their `quick_hash` — the "Beim Einfügen auf Duplikate
/// prüfen" setting's own check. Deliberately scoped to just this batch
/// rather than reusing `scan_project_for_duplicates`: importing something
/// unrelated must never re-surface an old duplicate pair the user already
/// knows about and chose to leave alone.
///
/// No file I/O here — every candidate's hash is expected to already be
/// cached (computed in `items::prepare_item`, on the same parallel worker as
/// the rest of the insert, whenever this setting is on). Two queries total,
/// not two per candidate: with a large batch into a large stream, one
/// lookup per candidate (even an indexed one) still means hundreds of
/// round trips on the connection that's held for the whole import.
pub(crate) fn duplicates_among(conn: &Connection, candidate_ids: &[String]) -> Vec<DuplicateGroup> {
    if candidate_ids.is_empty() {
        return Vec::new();
    }

    // Step A: every candidate's own hash, one query for the whole batch.
    let id_placeholders = candidate_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let id_params: Vec<&dyn ToSql> = candidate_ids.iter().map(|id| id as &dyn ToSql).collect();
    let mut seen_hashes: HashSet<i64> = HashSet::new();
    {
        let Ok(mut stmt) = conn.prepare(&format!("SELECT quick_hash FROM item_hashes WHERE item_id IN ({id_placeholders})"))
        else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map(id_params.as_slice(), |row| row.get::<_, i64>(0)) else {
            return Vec::new();
        };
        seen_hashes.extend(rows.flatten());
    }
    if seen_hashes.is_empty() {
        return Vec::new();
    }

    // Step B: every live item sharing any of those hashes, one query for
    // every candidate hash at once, then grouped by hash in memory.
    let hashes: Vec<i64> = seen_hashes.into_iter().collect();
    let hash_placeholders = hashes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let hash_params: Vec<&dyn ToSql> = hashes.iter().map(|h| h as &dyn ToSql).collect();
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT item_hashes.quick_hash, items.id FROM item_hashes
         JOIN items ON items.id = item_hashes.item_id
         WHERE item_hashes.quick_hash IN ({hash_placeholders}) AND items.removed_at IS NULL"
    )) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(hash_params.as_slice(), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))) else {
        return Vec::new();
    };

    let mut members_by_hash: HashMap<i64, Vec<String>> = HashMap::new();
    for (hash, item_id) in rows.flatten() {
        members_by_hash.entry(hash).or_default().push(item_id);
    }

    members_by_hash
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|item_ids| DuplicateGroup { item_ids })
        .collect()
}

/// Walks every live item, filling in any missing `quick_hash` as it goes
/// (see `ensure_item_quick_hash` — the same cache every other duplicate
/// check reads from), then groups the project by the result. Reports
/// progress because hashing a whole stream is real per-file I/O that
/// can take a while on a large one — same shape as `purge_items`.
#[tauri::command]
pub async fn scan_project_for_duplicates(
    app: tauri::AppHandle,
    operation_id: String,
) -> Result<Vec<DuplicateGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::state::AppStateHandle>();

        // One query, not one `ensure_item_quick_hash` lookup per row: the
        // `LEFT JOIN` already tells us which rows have a cached hash and
        // which don't, so the already-cached ones need no further work at
        // all — only the missing ones go on to the parallel phase below.
        // The state lock covers only this read and the final hash writes,
        // not the hashing of a possibly large project in between.
        let (project_path, rows) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let mut stmt = current
                .conn
                .prepare(
                    "SELECT i.id, i.stored_path, i.original_filename, h.quick_hash
                     FROM items i LEFT JOIN item_hashes h ON h.item_id = i.id
                     WHERE i.removed_at IS NULL AND i.file_type != 'diary'",
                )
                .map_err(|e| e.to_string())?;
            let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?;
            let rows: Vec<(String, String, String, Option<i64>)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .map_err(|e| e.to_string())?
                .flatten()
                .filter(|row: &(String, String, String, Option<i64>)| !hidden.as_ref().is_some_and(|hidden| hidden.contains(&row.0)))
                .collect();
            (current.path.clone(), rows)
        };

        let mut by_hash: HashMap<u64, Vec<String>> = HashMap::new();
        let mut missing: Vec<(String, String, String)> = Vec::new();
        for (id, stored_path, original_filename, cached) in rows {
            match cached {
                Some(h) => by_hash.entry(h as u64).or_default().push(id),
                None => missing.push((id, stored_path, original_filename)),
            }
        }

        // Real per-file I/O (reading up to 128KB per file) — parallelized
        // across workers the same way `add_items` parallelizes its own
        // per-file work, instead of one file at a time on this thread.
        let total = missing.len();
        let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(total.max(1));
        let mut chunks: Vec<Vec<(String, String, String)>> = (0..worker_count.max(1)).map(|_| Vec::new()).collect();
        for (i, entry) in missing.into_iter().enumerate() {
            chunks[i % worker_count.max(1)].push(entry);
        }

        let progress_done = std::sync::atomic::AtomicUsize::new(0);
        let computed: Vec<(String, Option<u64>, String)> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let progress_done = &progress_done;
                    let app = &app;
                    let operation_id = &operation_id;
                    scope.spawn(move || {
                        chunk
                            .into_iter()
                            .map(|(id, stored_path, original_filename)| {
                                let hash = quick_hash(Path::new(&stored_path)).ok();
                                let done = progress_done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                                crate::progress::emit_progress(app, operation_id, done, total, &original_filename);
                                (id, hash, original_filename)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        let guard = crate::state::lock_project(&state, &project_path)?;
        let conn = &guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?.conn;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, hash, _original_filename) in computed {
            if let Some(hash) = hash {
                store_quick_hash(&tx, &id, hash);
                by_hash.entry(hash).or_default().push(id);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        Ok(by_hash
            .into_values()
            .filter(|ids| ids.len() > 1)
            .map(|item_ids| DuplicateGroup { item_ids })
            .collect())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-duphash-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn
    }

    fn insert_item(conn: &Connection, id: &str, stored_path: &Path, size: u64) {
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, resolved_timestamp,
                                 timestamp_source, added_at, file_size_bytes)
             VALUES (?1, 'original.jpg', ?2, 'image', '2024-01-01T00:00:00+00:00', 'exif',
                     '2024-01-01T00:00:00+00:00', ?3)",
            params![id, stored_path.to_string_lossy().to_string(), size as i64],
        )
        .unwrap();
    }

    #[test]
    fn different_size_is_never_a_duplicate() {
        let dir = scratch();
        let stored = dir.join("stored.jpg");
        fs::write(&stored, vec![1u8; 100]).unwrap();
        let disk_file = dir.join("disk.jpg");
        fs::write(&disk_file, vec![1u8; 50]).unwrap();

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, 100);

        assert!(find_duplicate(&conn, &disk_file, 50, false).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_size_but_different_content_is_not_a_duplicate() {
        let dir = scratch();
        let stored = dir.join("stored.jpg");
        fs::write(&stored, vec![1u8; 100]).unwrap();
        let disk_file = dir.join("disk.jpg");
        fs::write(&disk_file, vec![2u8; 100]).unwrap();

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, 100);

        assert!(find_duplicate(&conn, &disk_file, 100, false).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identical_content_is_found_in_fast_mode_without_verification() {
        let dir = scratch();
        let stored = dir.join("stored.jpg");
        fs::write(&stored, vec![7u8; 100]).unwrap();
        let disk_file = dir.join("disk.jpg");
        fs::write(&disk_file, vec![7u8; 100]).unwrap();

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, 100);

        let dup = find_duplicate(&conn, &disk_file, 100, false).unwrap();
        assert_eq!(dup.existing_item_id, "item1");
        assert!(!dup.content_verified);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identical_content_is_confirmed_when_verification_is_on() {
        let dir = scratch();
        let stored = dir.join("stored.jpg");
        fs::write(&stored, vec![7u8; 100]).unwrap();
        let disk_file = dir.join("disk.jpg");
        fs::write(&disk_file, vec![7u8; 100]).unwrap();

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, 100);

        let dup = find_duplicate(&conn, &disk_file, 100, true).unwrap();
        assert!(dup.content_verified);
        fs::remove_dir_all(&dir).ok();
    }

    /// The whole reason the "sicher" tier exists: two files large enough
    /// that `quick_hash` only samples the first/last 64KB can share an
    /// identical sample while differing in the middle. Fast mode would
    /// wrongly call this a duplicate; verified mode must catch it.
    #[test]
    fn verification_catches_a_quick_hash_collision_in_the_middle_of_large_files() {
        let dir = scratch();
        let sample = 64 * 1024;
        let middle = 8 * 1024;

        let mut a = vec![0xAAu8; sample];
        a.extend(vec![1u8; middle]);
        a.extend(vec![0xBBu8; sample]);

        let mut b = vec![0xAAu8; sample];
        b.extend(vec![2u8; middle]);
        b.extend(vec![0xBBu8; sample]);

        assert_eq!(a.len(), b.len());

        let stored = dir.join("stored.bin");
        fs::write(&stored, &a).unwrap();
        let disk_file = dir.join("disk.bin");
        fs::write(&disk_file, &b).unwrap();

        // Sanity check: quick_hash really does collide here, otherwise this
        // test wouldn't be exercising the case it claims to.
        assert_eq!(quick_hash(&stored).unwrap(), quick_hash(&disk_file).unwrap());

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, a.len() as u64);

        assert!(find_duplicate(&conn, &disk_file, a.len() as u64, false).is_some());
        assert!(find_duplicate(&conn, &disk_file, a.len() as u64, true).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn quick_hash_is_cached_after_first_lookup() {
        let dir = scratch();
        let stored = dir.join("stored.jpg");
        fs::write(&stored, vec![7u8; 100]).unwrap();
        let disk_file = dir.join("disk.jpg");
        fs::write(&disk_file, vec![7u8; 100]).unwrap();

        let conn = test_conn();
        insert_item(&conn, "item1", &stored, 100);

        assert!(find_duplicate(&conn, &disk_file, 100, false).is_some());

        let cached: Option<i64> = conn
            .query_row("SELECT quick_hash FROM item_hashes WHERE item_id = 'item1'", [], |row| row.get(0))
            .unwrap();
        assert!(cached.is_some());
        fs::remove_dir_all(&dir).ok();
    }
}
