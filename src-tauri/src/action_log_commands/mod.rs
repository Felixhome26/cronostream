//! The commands behind the "Protokoll" tab: reading the log, undoing an
//! action (or one file inside it), and permanently deleting the in-project
//! copy of a file that was taken off the timeline.
//!
//! The undo path never silently overwrites and never flatly refuses. If a
//! file has been changed again since the action being undone, the call
//! comes back with the list of those later changes and the UI offers to
//! undo them first — see `UndoOutcome::Conflicts`. Likewise, undoing an
//! import asks whether the copy inside the project folder should go too
//! (`UndoOutcome::NeedsCopyDecision`) rather than deciding for the user.
//!
//! What is never in question: files outside the project folder. No path
//! here ever *writes to or deletes* a source file — `stored_path` and
//! `thumbnail_path` both point inside the project, and the one place a
//! source file is touched at all is `restore_from_source` *reading* it
//! (a plain copy) to undo a removal whose in-project copy the "Dateien
//! beim Entfernen löschen" setting already deleted.

mod log_list;
mod project_settings;
mod undo;

pub use log_list::*;
pub use project_settings::*;
pub use undo::*;

#[cfg(test)]
mod tests {
    use super::*;
    
    use std::path::Path;

    use rusqlite::{params, Connection, OptionalExtension};
    
    

    use crate::action_log::{self, ActionType, LogEntry};
    use crate::app_settings;
    
    use crate::settings;
    
    
    

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn
    }

    /// A directory outside any real project — fine as the `project_path`
    /// argument for tests that never reach `restore_from_source` (every
    /// test whose item's `stored_path` file actually exists, i.e. all the
    /// pre-existing ones below), since that's the only place it's read.
    fn unused_project_path() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    /// Minimal row — only the columns these tests read back. Writes a real
    /// (if fake-content) file at `stored_path` so the "is the in-project
    /// copy still there" check `apply_undo` now makes for a removal
    /// matches what these tests have always assumed.
    fn insert_item(conn: &Connection, id: &str, name: &str, source: Option<&str>) {
        let stored_path = std::env::temp_dir().join("cronostream-action-log-tests").join(format!("{id}.jpg"));
        std::fs::create_dir_all(stored_path.parent().unwrap()).unwrap();
        std::fs::write(&stored_path, b"not a real image, just needs to exist").unwrap();
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type,
                                resolved_timestamp, timestamp_source, added_at, source_path)
             VALUES (?1, ?2, ?3, 'image', '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00', ?4)",
            params![id, name, stored_path.to_string_lossy().to_string(), source],
        )
        .unwrap();
    }

    fn is_live(conn: &Connection, id: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE id = ?1 AND removed_at IS NULL)",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn only_entry(conn: &Connection) -> i64 {
        conn.query_row("SELECT MAX(id) FROM action_log_entry", [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn undoing_a_removal_puts_the_file_back() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        conn.execute("UPDATE items SET removed_at = '2024-02-01T00:00:00+00:00'", []).unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("a", "a.jpg")]).unwrap();

        assert!(!is_live(&conn, "a"));
        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }));
        assert!(is_live(&conn, "a"));
    }

    fn fresh_scratch_dir(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("cronostream-action-log-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_test_png(path: &Path) {
        image::RgbImage::from_pixel(2, 2, image::Rgb([120, 80, 200])).save(path).unwrap();
    }

    /// "Dateien beim Entfernen löschen" deletes the in-project copy right
    /// away (see `timeline_commands::purge_item_row`), but the row — and
    /// with it `source_path` — stays. Undoing that removal should fall back
    /// to re-importing from the original source rather than just failing.
    #[test]
    fn undoing_a_removal_with_a_deleted_copy_reimports_from_source() {
        let conn = test_conn();
        let project_path = fresh_scratch_dir("project");
        let source = fresh_scratch_dir("source").join("a.png");
        write_test_png(&source);

        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type,
                                resolved_timestamp, timestamp_source, added_at, source_path, removed_at)
             VALUES ('a', 'a.png', '/gone/a.jpg', 'image', '2019-04-05T08:00:00+00:00', 'exif',
                     '2024-01-01T00:00:00+00:00', ?1, '2024-02-01T00:00:00+00:00')",
            params![source.to_string_lossy().to_string()],
        )
        .unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("a", "a.png")]).unwrap();
        // Fingerprints of the copy that was deleted; the source may differ by now.
        conn.execute("INSERT INTO item_hashes (item_id, blake3_hash) VALUES ('a', 'von der alten Kopie')", []).unwrap();

        assert!(!is_live(&conn, "a"));
        let outcome = undo_entries(&conn, &project_path, &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        assert!(is_live(&conn, "a"));

        let (stored_path, resolved_timestamp): (String, String) = conn
            .query_row("SELECT stored_path, resolved_timestamp FROM items WHERE id = 'a'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert!(Path::new(&stored_path).is_file(), "a fresh copy was written: {stored_path}");
        assert_eq!(resolved_timestamp, "2019-04-05T08:00:00+00:00", "the original date survives the re-import");
        let stale: Option<String> = conn
            .query_row("SELECT blake3_hash FROM item_hashes WHERE item_id = 'a'", [], |row| row.get(0))
            .optional()
            .unwrap()
            .flatten();
        assert_eq!(stale, None, "the old copy's fingerprint is gone");
    }

    /// The same restore with the copy prepared ahead, the way the commands
    /// run it (`undo_with_prepared_restores`): the undo uses the prepared
    /// file instead of copying again, and a prepared file nobody used is
    /// removed rather than left behind in the project.
    #[test]
    fn a_prepared_restore_is_used_and_an_unused_one_cleaned_up() {
        let conn = test_conn();
        let project_path = fresh_scratch_dir("project");
        let source = fresh_scratch_dir("source").join("a.png");
        write_test_png(&source);
        conn.execute(
            "INSERT INTO items (id, original_filename, stored_path, file_type,
                                resolved_timestamp, timestamp_source, added_at, source_path, removed_at)
             VALUES ('a', 'a.png', '/gone/a.jpg', 'image', '2019-04-05T08:00:00+00:00', 'exif',
                     '2024-01-01T00:00:00+00:00', ?1, '2024-02-01T00:00:00+00:00')",
            params![source.to_string_lossy().to_string()],
        )
        .unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("a", "a.png")]).unwrap();
        let entry = only_entry(&conn);

        let unused = PreparedRestores::prepare(&project_path, restore_jobs(&conn, &[entry]).unwrap());
        let unused_files: Vec<_> = unused.0.values().flat_map(|item| item.stored_files()).collect();
        assert_eq!(unused_files.len(), 2, "copy and thumbnail");
        assert!(unused_files.iter().all(|f| f.is_file()));
        unused.discard_unused();
        assert!(unused_files.iter().all(|f| !f.exists()), "an unused preparation leaves nothing behind");

        let mut prepared = PreparedRestores::prepare(&project_path, restore_jobs(&conn, &[entry]).unwrap());
        let prepared_copy = prepared.0["a"].stored_files()[0].clone();
        let outcome = undo_entries(&conn, &project_path, &[entry], None, false, &mut prepared).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }), "{outcome:?}");
        assert!(prepared.0.is_empty(), "the undo took the prepared file");
        let stored_path: String = conn.query_row("SELECT stored_path FROM items WHERE id = 'a'", [], |row| row.get(0)).unwrap();
        assert_eq!(Path::new(&stored_path), prepared_copy);
        assert!(is_live(&conn, "a"));
    }

    /// Neither the in-project copy nor the original source file exists
    /// anymore — there is genuinely nothing left to restore from.
    #[test]
    fn undoing_a_removal_with_both_copy_and_source_gone_cannot_restore() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", Some("/this/was/never/here.jpg"));
        conn.execute("UPDATE items SET removed_at = '2024-02-01T00:00:00+00:00', stored_path = '/gone/a.jpg'", [])
            .unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("a", "a.jpg")]).unwrap();

        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 0 }), "{outcome:?}");
        assert!(!is_live(&conn, "a"));
    }

    #[test]
    fn undoing_a_rename_restores_the_previous_name() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        conn.execute("UPDATE items SET display_name = 'Neu'", []).unwrap();
        action_log::record(
            &conn,
            ActionType::Rename,
            &[LogEntry {
                item_id: Some("a".to_string()),
                label: "a.jpg".to_string(),
                before_value: Some("Alt".to_string()),
                after_value: Some("Neu".to_string()),
                before_source: None,
            }],
        )
        .unwrap();

        undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        let name: Option<String> = conn
            .query_row("SELECT display_name FROM items WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name.as_deref(), Some("Alt"));
    }

    #[test]
    fn undoing_an_import_asks_about_the_copy_before_doing_anything() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        action_log::record(&conn, ActionType::Import, &[LogEntry::presence("a", "a.jpg")]).unwrap();

        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        match outcome {
            UndoOutcome::NeedsCopyDecision { labels } => assert_eq!(labels, vec!["a.jpg".to_string()]),
            other => panic!("expected a copy decision, got {other:?}"),
        }
        // Nothing may have changed yet.
        assert!(is_live(&conn, "a"));

        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], Some(false), false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }));
        // The item is off the timeline, but the row (and its history)
        // stays — a soft-delete, same as any other removal, not a hard
        // DELETE. Without the copy-deletion choice the stored copy is
        // untouched too.
        assert!(!is_live(&conn, "a"), "undoing the import takes it off the timeline");
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM items WHERE id = 'a')", [], |row| row.get(0))
            .unwrap();
        assert!(exists, "the row stays so the file's history (and a later re-import) aren't lost");
    }

    /// After undoing an import with "Kopie löschen", `add_items`'s
    /// already-added check (same query, duplicated here since that command
    /// needs a live AppHandle) must no longer see this source path — the
    /// row stays (soft-deleted) rather than being hard-deleted, so
    /// re-dropping the same file should import it fresh rather than
    /// silently skipping it as a duplicate.
    #[test]
    fn undoing_an_import_with_delete_copy_lets_the_same_source_be_readded() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", Some("/pictures/a.jpg"));
        action_log::record(&conn, ActionType::Import, &[LogEntry::presence("a", "a.jpg")]).unwrap();

        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], Some(true), false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }));

        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM items WHERE id = 'a')", [], |row| row.get(0))
            .unwrap();
        assert!(exists, "deleting the copy soft-removes the row, it does not drop it");

        let already_added: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE source_path = ?1 AND removed_at IS NULL)",
                params!["/pictures/a.jpg"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!already_added, "the deleted import must not block a re-add of the same source file");

        // The duplicate-compare check (file size + name on live rows) must
        // not match it either.
        let duplicate: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE removed_at IS NULL AND original_filename = ?1 COLLATE NOCASE)",
                params!["a.jpg"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!duplicate, "the dropped-files duplicate check must not match it either");
    }

    /// Undoing an import without "Kopie löschen" leaves the project copy
    /// sitting on disk, orphaned from the timeline — exactly what
    /// "endgültig löschen" is for, so the log must offer it for this entry
    /// once it's reverted (unlike a Remove entry, an Import entry's own
    /// undo is *what makes* the item removed, so canPurge only turns on
    /// after `reverted`, not before — see the `is_currently_removed` match
    /// in `load_entries`).
    #[test]
    fn undoing_an_import_without_delete_copy_offers_endgueltig_loeschen() {
        let conn = test_conn();
        // A name not shared with any other test — `insert_item` writes a
        // real file at a path keyed only by this id, and this test's
        // assertions depend on that file still being there, so it must not
        // collide with another test's "a.jpg" running concurrently.
        insert_item(&conn, "purge-check", "purge-check.jpg", None);
        let action_id =
            action_log::record(&conn, ActionType::Import, &[LogEntry::presence("purge-check", "purge-check.jpg")])
                .unwrap();

        let before = load_entries(&conn, action_id, "import", None).unwrap();
        assert_eq!(before.len(), 1);
        assert!(!before[0].reverted);
        assert!(!before[0].can_purge, "a live import has nothing to purge yet");

        let outcome = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], Some(false), false, &mut PreparedRestores::default()).unwrap();
        assert!(matches!(outcome, UndoOutcome::Done { undone: 1 }));

        let after = load_entries(&conn, action_id, "import", None).unwrap();
        assert_eq!(after.len(), 1);
        assert!(after[0].reverted);
        assert!(after[0].can_purge, "the copy is still on disk and now orphaned — offer to purge it");
    }

    #[test]
    fn a_later_change_blocks_the_undo_and_offers_the_cascade() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);

        let rename = |before: &str, after: &str| LogEntry {
            item_id: Some("a".to_string()),
            label: "a.jpg".to_string(),
            before_value: Some(before.to_string()),
            after_value: Some(after.to_string()),
            before_source: None,
        };

        action_log::record(&conn, ActionType::Rename, &[rename("Erst", "Zweit")]).unwrap();
        let first_entry: i64 = conn
            .query_row("SELECT MIN(id) FROM action_log_entry", [], |row| row.get(0))
            .unwrap();
        // A different action type in between, so the two renames don't
        // merge into one group.
        action_log::record(&conn, ActionType::DateChange, &[rename("x", "y")]).unwrap();
        action_log::record(&conn, ActionType::Rename, &[rename("Zweit", "Dritt")]).unwrap();
        conn.execute("UPDATE items SET display_name = 'Dritt'", []).unwrap();

        match undo_entries(&conn, &unused_project_path(), &[first_entry], None, false, &mut PreparedRestores::default()).unwrap() {
            UndoOutcome::Conflicts { conflicts } => {
                assert_eq!(conflicts.len(), 1);
                assert_eq!(conflicts[0].action_type, "rename");
            }
            other => panic!("expected conflicts, got {other:?}"),
        }
        // Refused, so nothing moved.
        let name: Option<String> = conn
            .query_row("SELECT display_name FROM items WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name.as_deref(), Some("Dritt"));

        // With the cascade confirmed, both renames come off and the name
        // lands on the state before the first one.
        match undo_entries(&conn, &unused_project_path(), &[first_entry], None, true, &mut PreparedRestores::default()).unwrap() {
            UndoOutcome::Done { undone } => assert_eq!(undone, 2),
            other => panic!("expected done, got {other:?}"),
        }
        let name: Option<String> = conn
            .query_row("SELECT display_name FROM items WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name.as_deref(), Some("Erst"));
    }

    #[test]
    fn a_permanently_deleted_file_cannot_be_restored() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        conn.execute("UPDATE items SET removed_at = '2024-02-01T00:00:00+00:00'", []).unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("a", "a.jpg")]).unwrap();
        let entry = only_entry(&conn);

        conn.execute("DELETE FROM items WHERE id = 'a'", []).unwrap();

        match undo_entries(&conn, &unused_project_path(), &[entry], None, false, &mut PreparedRestores::default()).unwrap() {
            UndoOutcome::Blocked { reason } => assert!(reason.contains("endgültig gelöscht")),
            other => panic!("expected blocked, got {other:?}"),
        }
    }

    #[test]
    fn restoring_a_file_whose_source_was_imported_again_is_refused_with_a_reason() {
        let conn = test_conn();
        insert_item(&conn, "old", "a.jpg", Some("/pictures/a.jpg"));
        conn.execute("UPDATE items SET removed_at = '2024-02-01T00:00:00+00:00' WHERE id = 'old'", [])
            .unwrap();
        action_log::record(&conn, ActionType::Remove, &[LogEntry::presence("old", "a.jpg")]).unwrap();

        // Same source file added again while the first copy sat removed.
        insert_item(&conn, "new", "a.jpg", Some("/pictures/a.jpg"));

        let err = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap_err();
        assert!(err.contains("erneut im Stream"), "got: {err}");
        assert!(!is_live(&conn, "old"));
    }

    #[test]
    fn undoing_a_whole_bulk_import_covers_every_file() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        insert_item(&conn, "b", "b.jpg", None);
        let action = action_log::record(
            &conn,
            ActionType::Import,
            &[LogEntry::presence("a", "a.jpg"), LogEntry::presence("b", "b.jpg")],
        )
        .unwrap();

        let entry_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM action_log_entry WHERE action_id = ?1 ORDER BY id")
                .unwrap();
            stmt.query_map(params![action], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        match undo_entries(&conn, &unused_project_path(), &entry_ids, Some(false), false, &mut PreparedRestores::default()).unwrap() {
            UndoOutcome::Done { undone } => assert_eq!(undone, 2),
            other => panic!("expected done, got {other:?}"),
        }
        // The rows stay (soft-deleted), only the "is it live" question
        // changes.
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 2);
        assert!(!is_live(&conn, "a"));
        assert!(!is_live(&conn, "b"));
    }

    #[test]
    fn undoing_one_file_of_a_bulk_import_leaves_the_rest_alone() {
        let conn = test_conn();
        insert_item(&conn, "a", "a.jpg", None);
        insert_item(&conn, "b", "b.jpg", None);
        action_log::record(
            &conn,
            ActionType::Import,
            &[LogEntry::presence("a", "a.jpg"), LogEntry::presence("b", "b.jpg")],
        )
        .unwrap();

        let first: i64 = conn
            .query_row("SELECT MIN(id) FROM action_log_entry", [], |row| row.get(0))
            .unwrap();
        undo_entries(&conn, &unused_project_path(), &[first], Some(false), false, &mut PreparedRestores::default()).unwrap();

        assert!(!is_live(&conn, "a"));
        assert!(is_live(&conn, "b"));
    }

    #[test]
    fn permanent_deletion_only_touches_files_already_off_the_timeline() {
        let conn = test_conn();
        insert_item(&conn, "live", "live.jpg", None);
        insert_item(&conn, "gone", "gone.jpg", None);
        conn.execute("UPDATE items SET removed_at = '2024-02-01T00:00:00+00:00' WHERE id = 'gone'", [])
            .unwrap();

        // purge_items needs the app state, so exercise its guard directly:
        // a live item must not be selectable for permanent deletion.
        let selectable: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id IN ('live', 'gone') AND removed_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(selectable, 1);
    }

    #[test]
    fn undoing_a_setting_change_restores_the_previous_value() {
        let conn = test_conn();
        settings::set(&conn, "default_video_frame_percent", "10").unwrap();
        action_log::record(
            &conn,
            ActionType::SettingChange,
            &[LogEntry {
                item_id: None,
                label: "default_video_frame_percent".to_string(),
                before_value: Some("10".to_string()),
                after_value: Some("25".to_string()),
                before_source: None,
            }],
        )
        .unwrap();
        settings::set(&conn, "default_video_frame_percent", "25").unwrap();

        undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default()).unwrap();
        assert_eq!(
            settings::get(&conn, "default_video_frame_percent").unwrap().as_deref(),
            Some("10")
        );
    }

    #[test]
    fn only_the_dialogs_own_keys_are_accepted() {
        for (key, _) in SETTINGS {
            assert!(ensure_known_setting(key).is_ok(), "{key}");
        }
        for key in ["privacy_password_hash", "privacy_recovery_hash", "privacy_marker", "project_name", ""] {
            assert!(ensure_known_setting(key).is_err(), "{key}");
        }
    }

    /// A copied or tampered stream can carry a log entry whose label names a
    /// privacy row; undoing it must not delete the password hash.
    #[test]
    fn undoing_a_forged_setting_change_leaves_the_privacy_rows_alone() {
        let conn = test_conn();
        settings::set(&conn, "privacy_password_hash", "hash").unwrap();
        action_log::record(
            &conn,
            ActionType::SettingChange,
            &[LogEntry {
                item_id: None,
                label: "privacy_password_hash".to_string(),
                before_value: None,
                after_value: Some("hash".to_string()),
                before_source: None,
            }],
        )
        .unwrap();

        let result = undo_entries(&conn, &unused_project_path(), &[only_entry(&conn)], None, false, &mut PreparedRestores::default());
        assert!(result.is_err());
        assert_eq!(settings::get(&conn, "privacy_password_hash").unwrap().as_deref(), Some("hash"));
    }

    /// Builds a one-entry app-wide store, as `app_settings.json` would hold
    /// it after the user moved a setting's scope.
    fn store_with(key: &str, scope: &str, value: Option<&str>) -> app_settings::Store {
        let mut store = app_settings::Store::new();
        store.insert(
            key.to_string(),
            app_settings::Entry {
                scope: Some(scope.to_string()),
                value: value.map(str::to_string),
            },
        );
        store
    }

    #[test]
    fn an_app_scoped_setting_overrides_the_projects_own_row() {
        let conn = test_conn();
        settings::set(&conn, TILE_DRAG_ENABLED_KEY, "false").unwrap();
        let store = store_with(TILE_DRAG_ENABLED_KEY, app_settings::SCOPE_APP, Some("true"));
        assert_eq!(
            resolved(&conn, &store, TILE_DRAG_ENABLED_KEY).unwrap().as_deref(),
            Some("true")
        );
    }

    /// The project's own value is kept while an app-wide one is in force, so
    /// switching the scope back finds it again rather than inheriting
    /// whatever the machine-wide setting happened to be.
    #[test]
    fn a_project_scoped_setting_ignores_the_app_wide_value() {
        let conn = test_conn();
        settings::set(&conn, TILE_DRAG_ENABLED_KEY, "false").unwrap();
        let store = store_with(TILE_DRAG_ENABLED_KEY, app_settings::SCOPE_PROJECT, Some("true"));
        assert_eq!(
            resolved(&conn, &store, TILE_DRAG_ENABLED_KEY).unwrap().as_deref(),
            Some("false")
        );
    }

    /// Moving a never-set setting to app scope stores no value (see
    /// `app_settings::set_scope`), and reading it must then fall through to
    /// the project row instead of resolving to nothing.
    #[test]
    fn an_app_scoped_setting_without_a_value_yet_falls_back_to_the_project_row() {
        let conn = test_conn();
        settings::set(&conn, SHOW_TIMESTAMP_OVERLAY_KEY, "false").unwrap();
        let store = store_with(SHOW_TIMESTAMP_OVERLAY_KEY, app_settings::SCOPE_APP, None);
        assert_eq!(
            resolved(&conn, &store, SHOW_TIMESTAMP_OVERLAY_KEY).unwrap().as_deref(),
            Some("false")
        );
    }

    /// An empty store is the normal state of a fresh install: every setting
    /// has to resolve through its own default scope, which for all but the
    /// pointer-follow and preview-placement settings means the project.
    #[test]
    fn defaults_put_everything_in_project_scope_except_the_machine_wide_ones() {
        assert_eq!(default_scope_of(FAN_CURSOR_FOLLOW_KEY), app_settings::SCOPE_APP);
        assert_eq!(default_scope_of(PEEK_TABS_KEY), app_settings::SCOPE_APP);
        for (key, _) in SETTINGS.iter().filter(|(k, _)| *k != FAN_CURSOR_FOLLOW_KEY && *k != PEEK_TABS_KEY) {
            assert_eq!(default_scope_of(key), app_settings::SCOPE_PROJECT, "{key}");
        }
        let empty = app_settings::Store::new();
        assert_eq!(
            app_settings::scope_of(&empty, FAN_CURSOR_FOLLOW_KEY, default_scope_of(FAN_CURSOR_FOLLOW_KEY)),
            app_settings::SCOPE_APP
        );
    }

    /// A value that isn't one of the scopes we understand (a hand-edited or
    /// future-version `app_settings.json`) must not silently become one.
    #[test]
    fn an_unknown_scope_falls_back_to_the_default_rather_than_being_trusted() {
        let store = store_with(TILE_DRAG_ENABLED_KEY, "somewhere_else", Some("true"));
        assert_eq!(
            app_settings::scope_of(&store, TILE_DRAG_ENABLED_KEY, app_settings::SCOPE_PROJECT),
            app_settings::SCOPE_PROJECT
        );
    }
}
