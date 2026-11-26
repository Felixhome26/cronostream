pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    thumbnail_path TEXT,
    file_type TEXT NOT NULL,
    display_name TEXT,
    resolved_timestamp TEXT NOT NULL,
    timestamp_source TEXT NOT NULL,
    fs_created_at TEXT,
    fs_modified_at TEXT,
    embedded_metadata_at TEXT,
    source_path TEXT,
    source_folder_path TEXT,
    import_batch_id TEXT,
    added_at TEXT NOT NULL,
    video_frame_percent REAL,
    extracted_text TEXT,
    file_size_bytes INTEGER,
    rotation INTEGER NOT NULL DEFAULT 0,
    -- E-mail header fields (FileKind::Email only) — small enough to ship
    -- with every list_items call, unlike extracted_text and the HTML body
    -- (see get_item_email_html), which stay lazy-loaded.
    email_subject TEXT,
    email_sender TEXT,
    email_date TEXT,
    -- Set when the user removes the file from the timeline. The row and the
    -- in-project copy on disk both stay — removal is reversible from the
    -- action log, and only "endgültig löschen" actually deletes anything.
    -- Every read of `items` that represents "what is in the project" must
    -- therefore filter on `removed_at IS NULL` (see `LIVE_ITEMS` below).
    removed_at TEXT
);

-- Manual rotation chosen in the file browser for a file not yet added to
-- the project (keyed by its absolute source path). Only a non-zero rotation
-- is ever stored (see `rotate_path`), and the row is deleted once the file
-- is actually added — from then on the rotation lives on the `items` row.
CREATE TABLE IF NOT EXISTS path_rotations (
    path TEXT PRIMARY KEY,
    rotation INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    timestamp TEXT
);

-- One note per file, which is what the viewer's note field writes (see
-- `update_note`). Enforced as an index rather than in the table definition
-- so projects created before the note field existed get it too; the
-- uniqueness is what lets `list_items` join the note on without ever
-- multiplying an item row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_item ON notes(item_id);

-- Files attached to a diary entry (`items.file_type = 'diary'`, see
-- `diary.rs`). Deliberately not `items` rows themselves: an attachment
-- belongs to its entry and must not appear as a tile of its own on the
-- timeline. The copies live in the project folder under diary/<id>/anhang/.
CREATE TABLE IF NOT EXISTS diary_attachments (
    id TEXT PRIMARY KEY,
    diary_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diary_attachments_diary ON diary_attachments(diary_id, position);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Which images are currently ticked in the print-export tab. Deliberately
-- persisted in the project (not localStorage): the collected target folder
-- is a staging area that grows over several sessions, so the list of what
-- is meant to go there belongs to the stream's content, not to the
-- machine it was ticked on.
CREATE TABLE IF NOT EXISTS print_selection (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE
);

-- The in-app search's history for this stream (see `search_history.rs`).
-- `payload` is the frontend's JSON of one search (text + date range),
-- written in a fixed key order so the same search always produces the same
-- string — that is what makes it the primary key and repeating a search
-- only bumps `used_at`. Capped at `search_history::MAX_ENTRIES` rows.
CREATE TABLE IF NOT EXISTS search_history (
    payload TEXT PRIMARY KEY,
    used_at TEXT NOT NULL
);

-- One row per image that has actually been written into a target folder,
-- so the list can mark it "already exported" and the user can tell a fresh
-- pick apart from one that was handed off to the print service before.
-- Only the latest export per item is kept (re-exporting overwrites).
CREATE TABLE IF NOT EXISTS print_exports (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    exported_at TEXT NOT NULL,
    target_folder TEXT NOT NULL,
    file_name TEXT NOT NULL
);

-- The action log ("Protokoll"): every user action, kept forever, with
-- enough state to reverse it. Split into one row per *action* and one row
-- per *affected item* because the dominant case by volume is a bulk import
-- of hundreds of files, which is one action the user thinks about ("147
-- Bilder eingefügt") and wants to undo as a unit or per file.
--
-- Kept deliberately lean, since this table alone grows without bound:
--   * `id` is the rowid (INTEGER PRIMARY KEY) rather than a UUID — 8 bytes
--     instead of 36, and because SQLite hands rowids out monotonically it
--     doubles as the chronological order the undo logic compares against,
--     so no index on `performed_at` is needed at all.
--   * `performed_at` is unix milliseconds, not RFC3339 text: a third of the
--     size, and the grouping window (see `action_log::record`) is then plain
--     integer arithmetic instead of parsing a timestamp per row.
--   * nothing is stored that can be looked up: an item's current name, date
--     and kind are read from `items`, never copied in here. Only `label` is
--     denormalized, so the history of a file stays readable after the file
--     has been permanently deleted and its `items` row is gone.
CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY,
    performed_at INTEGER NOT NULL,
    action_type TEXT NOT NULL
);

-- One row per item (or setting) touched by an action. `before_value` holds
-- what is needed to reverse *this* item's share of the action and nothing
-- more: the previous display name for a rename, the previous timestamp for
-- a date change, the previous value for a setting. Import and removal need
-- no payload at all — they flip `items.removed_at`, which is reversible on
-- its own.
CREATE TABLE IF NOT EXISTS action_log_entry (
    id INTEGER PRIMARY KEY,
    action_id INTEGER NOT NULL REFERENCES action_log(id) ON DELETE CASCADE,
    -- NULL for actions that aren't about a file (a settings change).
    item_id TEXT,
    label TEXT NOT NULL,
    before_value TEXT,
    after_value TEXT,
    -- Only a date change needs a second field restored alongside the
    -- timestamp: which source it came from (exif/manual/ai/...).
    before_source TEXT,
    reverted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_action_log_entry_action ON action_log_entry(action_id);
-- Answers "what else happened to this file, and when" in one index seek —
-- the query behind the conflict check that offers to undo later changes
-- first (see `action_log::later_conflicts`).
CREATE INDEX IF NOT EXISTS idx_action_log_entry_item ON action_log_entry(item_id, action_id);

-- Lazily-filled hash cache for an item's *own* stored copy, one row per
-- item that has ever been hashed (see `duplicate_hash::ensure_item_*`).
-- Never computed up front for the whole project — only when a disk search
-- actually needs to compare against that item. `quick_hash` is the cheap
-- FNV-1a fingerprint (size + first/last 64KB); `blake3_hash` is the real
-- whole-file hash, only ever computed when the disk search's "sicher"
-- (verify-content) toggle is on.
CREATE TABLE IF NOT EXISTS item_hashes (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    quick_hash INTEGER,
    blake3_hash TEXT
);

-- Every duplicate check (ingest-time `duplicates_among`, the Einstellungen
-- "Alle Dateien jetzt prüfen" scan, the file browser's "Bereits im
-- Stream enthalten" toggle) looks up items by `quick_hash` — without
-- this, each lookup is a full table scan, which on a large stream turns
-- a batch import into what looks like a freeze.
CREATE INDEX IF NOT EXISTS idx_item_hashes_quick_hash ON item_hashes(quick_hash);

-- Life phases on the timeline (see `phases.rs`): a "Themenbereich"
-- (`phase_groups`, e.g. "Wohnorte") holds any number of dated phases. The UI
-- never calls these "Kategorie" — that word already means the four file
-- types. Both tables belong to this one stream only: they are not
-- transferred, exported or searched.
--
-- Removal is a flag here too (`removed_at`, same reasoning as `items`): it
-- is what the action log undoes, so every read meaning "what exists" must
-- filter `removed_at IS NULL`. Foreign keys are not enforced on project
-- connections, so the integrity of `phases.group_id` is kept by
-- `phases.rs` itself: a group is only ever soft-removed together with its
-- live phases, and a phase can neither be created in nor restored into a
-- removed group. Nothing is ever hard-deleted.
--
-- `visible` is the eye toggle. It is stored but deliberately never logged.
CREATE TABLE IF NOT EXISTS phase_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- Vertical order, top to bottom. Only the relative order matters;
    -- `phases::apply_group_order` renumbers it densely on every move.
    sort_index INTEGER NOT NULL,
    -- For a group without phases this is the eye's state; once phases
    -- exist, the tri-state shown is derived from theirs (see
    -- `phases::group_visibility`).
    visible INTEGER NOT NULL DEFAULT 1,
    -- Off: no two live phases of this group may share a day.
    overlap_allowed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    removed_at TEXT
);

CREATE TABLE IF NOT EXISTS phases (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES phase_groups(id),
    title TEXT NOT NULL,
    -- Whole days only, ISO `YYYY-MM-DD`, so plain string comparison is
    -- date order. `end_date` is inclusive.
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    -- `#rrggbb`, lower case.
    color TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    -- "läuft noch": `end_date` is moved forward to today whenever the
    -- phases are read (`phases::refresh_ongoing`). That move is a
    -- derivation and is never logged; the flag itself is.
    ongoing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    removed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_phases_group ON phases(group_id, start_date);

-- The action log's per-target rows for phase actions — the counterpart of
-- `action_log_entry`, sharing its `action_log` header (and with it the
-- order, the 60-second grouping and the Protokoll list). A separate table
-- because a phase change is not about a file: `before_json`/`after_json`
-- hold only the fields the action changed, as a JSON object, so undoing a
-- colour change can never also reset a title changed later.
--
-- `target_kind` is `group`, `phase`, or `order` (the order of all groups,
-- with `target_id` fixed to `order`, so that a run of moves groups into
-- one entry and any later move counts as a conflict).
CREATE TABLE IF NOT EXISTS action_log_phase_entry (
    id INTEGER PRIMARY KEY,
    action_id INTEGER NOT NULL REFERENCES action_log(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    label TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reverted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_action_log_phase_entry_action ON action_log_phase_entry(action_id);
CREATE INDEX IF NOT EXISTS idx_action_log_phase_entry_target ON action_log_phase_entry(target_id, id);
"#;

/// Every read of `items` that means "what is currently in the project" must
/// exclude softly-removed rows. Spelled out as a constant so a new query
/// can't quietly forget it — see `items.removed_at`.
pub const LIVE_ITEMS: &str = "removed_at IS NULL";

/// `CREATE TABLE IF NOT EXISTS` above leaves a project database created
/// before a column was added without it — this adds any such missing
/// column to an already-existing `items` table. Safe to call on every
/// project open; a no-op once the column is there.
pub fn migrate(conn: &rusqlite::Connection) -> Result<(), String> {
    let has_column = |name: &str| -> bool {
        conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = ?1")
            .and_then(|mut stmt| stmt.exists(rusqlite::params![name]))
            .unwrap_or(false)
    };
    if !has_column("extracted_text") {
        conn.execute("ALTER TABLE items ADD COLUMN extracted_text TEXT", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("file_size_bytes") {
        conn.execute("ALTER TABLE items ADD COLUMN file_size_bytes INTEGER", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("rotation") {
        conn.execute("ALTER TABLE items ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("removed_at") {
        conn.execute("ALTER TABLE items ADD COLUMN removed_at TEXT", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("email_subject") {
        conn.execute("ALTER TABLE items ADD COLUMN email_subject TEXT", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("email_sender") {
        conn.execute("ALTER TABLE items ADD COLUMN email_sender TEXT", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    if !has_column("email_date") {
        conn.execute("ALTER TABLE items ADD COLUMN email_date TEXT", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }

    // `undo_log` was scaffolding for this feature that never got written to
    // (the real thing is `action_log` + `action_log_entry` above, which
    // splits per-action and per-item state instead of a single JSON blob).
    // Dropping it discards nothing: no code path ever inserted a row.
    conn.execute("DROP TABLE IF EXISTS undo_log", [])
        .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;

    // One-time backfill: legacy `.doc` items used to get `display_name`
    // pre-filled with the filename stripped of its extension (see
    // `items::prepare_item`'s old `initial_display_name`), so the editable
    // name field showed "Liste" for "Liste.doc" instead of the full
    // filename every other kind falls back to. That pre-fill is gone for
    // new imports; this resets it for items an older version already
    // imported, so they fall back to `original_filename` (with its
    // extension) the same way. Only touches rows whose `display_name`
    // still matches the auto-generated stem exactly — a name the user
    // deliberately typed afterwards is left alone, even in the unlikely
    // case it happens to equal the stem too.
    //
    // Guarded by a settings flag rather than left to run on every open:
    // the `UPDATE`'s `WHERE` can't use an index (leading-wildcard `LIKE` on
    // `original_filename`, no index on `file_type` either), so it's a full
    // table scan every single time a project is opened — on a large
    // project that's a real, avoidable chunk of the "opening feels slow"
    // complaint. Once it has run it can never have anything left to do
    // (new imports never get the stem pre-fill in the first place), so
    // "ran once" and "nothing to do" are the same condition.
    const BACKFILL_DONE_KEY: &str = "doc_display_name_backfill_done";
    if crate::settings::get(conn, BACKFILL_DONE_KEY)?.is_none() {
        conn.execute(
            "UPDATE items SET display_name = NULL
             WHERE file_type = 'document'
               AND display_name IS NOT NULL
               AND lower(original_filename) LIKE '%.doc'
               AND display_name = substr(original_filename, 1, length(original_filename) - 4)",
            [],
        )
        .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
        crate::settings::set(conn, BACKFILL_DONE_KEY, "1")?;
    }

    // The perceptual fingerprint of a photo (see `similar_images`), cached
    // beside the byte fingerprints. Cleared with the row when a file is
    // replaced, like those.
    let hashes_have_dhash = conn
        .prepare("SELECT 1 FROM pragma_table_info('item_hashes') WHERE name = 'dhash'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);
    if !hashes_have_dhash {
        conn.execute("ALTER TABLE item_hashes ADD COLUMN dhash INTEGER", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
    }
    // Fingerprints of the first rule (06.11.2026: an edge now has to be
    // clear to count, see `similar_images::dhash`) are dropped once and made
    // again on the next search; they are only a cache.
    const DHASH_RULE_KEY: &str = "similar_images_dhash_rule";
    if crate::settings::get(conn, DHASH_RULE_KEY)?.as_deref() != Some("2") {
        conn.execute("UPDATE item_hashes SET dhash = NULL WHERE dhash IS NOT NULL", [])
            .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;
        crate::settings::set(conn, DHASH_RULE_KEY, "2")?;
    }

    // Lookups of one file at a time: the file browser's "already in the
    // stream" mark and rotation (by source path, per tile), duplicate
    // checks (by size, by name and size) and undo/restore. Without these
    // each of them scanned the whole table, under the app lock. Here and not
    // in `SCHEMA`, because `file_size_bytes` only exists once the column
    // migration above has run. An index never changes what a query returns.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_items_source_path ON items(source_path);
         CREATE INDEX IF NOT EXISTS idx_items_stored_path ON items(stored_path);
         CREATE INDEX IF NOT EXISTS idx_items_file_size ON items(file_size_bytes);
         CREATE INDEX IF NOT EXISTS idx_items_original_filename ON items(original_filename COLLATE NOCASE);",
    )
    .map_err(|e| crate::trf!("Konnte Datenbank nicht aktualisieren: {e}", e = e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    /// The `items` table exactly as a project created before the action log
    /// has it on disk, plus the empty `undo_log` scaffolding such a project
    /// also carries. Verified against a real 446-item project database.
    const OLD_SCHEMA: &str = r#"
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    thumbnail_path TEXT,
    file_type TEXT NOT NULL,
    display_name TEXT,
    resolved_timestamp TEXT NOT NULL,
    timestamp_source TEXT NOT NULL,
    fs_created_at TEXT,
    fs_modified_at TEXT,
    embedded_metadata_at TEXT,
    source_path TEXT,
    source_folder_path TEXT,
    import_batch_id TEXT,
    added_at TEXT NOT NULL,
    video_frame_percent REAL,
    extracted_text TEXT,
    file_size_bytes INTEGER,
    rotation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE undo_log (
    id TEXT PRIMARY KEY,
    performed_at TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);
"#;

    fn has_column(conn: &Connection, name: &str) -> bool {
        conn.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = ?1")
            .and_then(|mut stmt| stmt.exists(rusqlite::params![name]))
            .unwrap_or(false)
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            rusqlite::params![name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            != 0
    }

    #[test]
    fn an_existing_project_gains_the_action_log_without_losing_its_items() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(OLD_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES ('a', 'Böttchen.jpg', '/p/a.jpg', 'image',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();

        // What opening a project actually runs, in that order.
        conn.execute_batch(super::SCHEMA).unwrap();
        super::migrate(&conn).unwrap();

        assert!(has_column(&conn, "removed_at"));
        assert!(table_exists(&conn, "action_log"));
        assert!(table_exists(&conn, "action_log_entry"));
        assert!(!table_exists(&conn, "undo_log"), "the unused scaffolding is dropped");

        // The pre-existing item survives and reads as live, which is what
        // decides whether it still shows up on the timeline.
        let live: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM items WHERE {}", super::LIVE_ITEMS),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(live, 1);
    }

    #[test]
    fn opening_a_project_twice_changes_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        for _ in 0..3 {
            conn.execute_batch(super::SCHEMA).unwrap();
            super::migrate(&conn).unwrap();
        }
        assert!(has_column(&conn, "removed_at"));
        assert!(table_exists(&conn, "action_log"));
    }

    /// The per-file lookups must actually use the new indexes — a query
    /// written so SQLite can't (a function around the column, a different
    /// collation) would silently keep scanning the whole table.
    #[test]
    fn per_file_lookups_use_an_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA).unwrap();
        super::migrate(&conn).unwrap();
        let plan = |sql: &str| -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(3)).unwrap();
            rows.map(|r| r.unwrap()).collect::<Vec<_>>().join(" | ")
        };
        for sql in [
            "SELECT id FROM items WHERE source_path = 'x' AND removed_at IS NULL",
            "SELECT id FROM items WHERE (source_path = 'x' OR stored_path = 'x') AND removed_at IS NULL LIMIT 1",
            "SELECT id FROM items WHERE removed_at IS NULL AND file_size_bytes = 1 AND original_filename = 'a' COLLATE NOCASE",
            "SELECT EXISTS(SELECT 1 FROM items WHERE removed_at IS NULL AND original_filename = 'a' COLLATE NOCASE)",
        ] {
            let plan = plan(sql);
            assert!(plan.contains("USING INDEX"), "{sql}: {plan}");
        }
    }

    /// A project from before life phases existed: everything it already
    /// holds — items, log, settings — must come through untouched, and the
    /// phase tables must appear empty (a stream starts without any
    /// Themenbereich).
    #[test]
    fn an_existing_project_gains_the_phase_tables_without_losing_anything() {
        let conn = Connection::open_in_memory().unwrap();
        // Today's schema minus the phase tables is exactly what such a
        // project has on disk.
        conn.execute_batch(super::SCHEMA).unwrap();
        conn.execute_batch(
            "DROP TABLE phases; DROP TABLE phase_groups; DROP TABLE action_log_phase_entry;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES ('a', 'a.jpg', '/p/a.jpg', 'image',
                     '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO action_log (performed_at, action_type) VALUES (1, 'import')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO action_log_entry (action_id, item_id, label) VALUES (1, 'a', 'a.jpg')",
            [],
        )
        .unwrap();
        crate::settings::set(&conn, "project_name", "Alt").unwrap();

        conn.execute_batch(super::SCHEMA).unwrap();
        super::migrate(&conn).unwrap();

        for table in ["phase_groups", "phases", "action_log_phase_entry"] {
            assert!(table_exists(&conn, table), "{table} is created");
            let rows: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(rows, 0, "{table} starts empty");
        }

        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM items WHERE removed_at IS NULL"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM action_log"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM action_log_entry"), 1);
        assert_eq!(
            crate::settings::get(&conn, "project_name").unwrap().as_deref(),
            Some("Alt")
        );
    }

    #[test]
    fn legacy_doc_display_names_are_backfilled_to_include_the_extension() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA).unwrap();

        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type, display_name,
                                resolved_timestamp, timestamp_source, added_at)
             VALUES
             ('a', 'Liste.doc', '/p/a.doc', 'document', 'Liste',
                   '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00'),
             -- Case-insensitive extension, still auto-generated — also reset.
             ('b', 'Brief.DOC', '/p/b.doc', 'document', 'Brief',
                   '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00'),
             -- User explicitly renamed this one — left alone.
             ('c', 'Rechnung.doc', '/p/c.doc', 'document', 'Steuerunterlagen 2023',
                   '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00'),
             -- A real docx with its own display name — untouched, wrong extension.
             ('d', 'Vertrag.docx', '/p/d.docx', 'document', 'Vertrag',
                   '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();

        super::migrate(&conn).unwrap();

        let display_name = |id: &str| -> Option<String> {
            conn.query_row("SELECT display_name FROM items WHERE id = ?1", [id], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(display_name("a"), None, "auto-generated stem is reset so it falls back to the full filename");
        assert_eq!(display_name("b"), None, "matches regardless of the extension's case");
        assert_eq!(display_name("c"), Some("Steuerunterlagen 2023".to_string()), "a deliberate rename is kept");
        assert_eq!(display_name("d"), Some("Vertrag".to_string()), "non-.doc documents are untouched");
    }
}
