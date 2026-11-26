//! The staging area for recordings made by `capture.rs`: the finished
//! take waits here while the user checks it and gives it a name, and the
//! normal add-to-project path picks it up from here.
//!
//! The detour via a file is not laziness: `items::prepare_item` — and with
//! it the duplicate check, the thumbnail and the date candidates — works on
//! something it can `std::fs::copy` and read metadata from, not on a
//! buffer. The staging file is therefore deliberately short-lived: the
//! frontend hands its path straight to `add_items_with_dates` and then has
//! it deleted again (`discard_recording`), so a cancelled or added
//! recording never leaves anything behind in the temp directory.

use std::path::{Path, PathBuf};

#[cfg(test)]
use uuid::Uuid;

/// One subdirectory per recording below this, so the file inside it can
/// carry the name the user typed without two recordings of the same name
/// ever colliding.
pub(crate) fn staging_root() -> PathBuf {
    std::env::temp_dir().join("cronostream-recordings")
}

/// Checks that `path` really lies inside the staging root. `starts_with` alone compares components textually
/// and does not resolve `..` or symlinks, so a path that only looks
/// contained could still land outside the root once the OS resolves it.
fn resolve_staged(path: &Path) -> Result<(), String> {
    let outside = || crate::i18n::tr("Dieser Pfad gehört nicht zum Aufnahme-Zwischenspeicher.").to_string();
    let canonical_path = path.canonicalize().map_err(|e| crate::trf!("Konnte den Pfad nicht auflösen: {e}", e = e))?;
    let canonical_root = staging_root()
        .canonicalize()
        .map_err(|e| crate::trf!("Konnte den Zwischenspeicher nicht auflösen: {e}", e = e))?;
    if canonical_path.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err(outside())
    }
}

/// The name the user typed, made safe to use as a file name. Nothing is
/// lost by being strict here: the name the user actually sees is stored
/// separately as the item's display name (`update_display_name`), this is
/// only what the file on disk — and with it the action log's label — is
/// called.
fn sanitize_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();

    // Collapses the runs of whitespace the replacement above can leave
    // behind, and trims the result in one go.
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // Byte-safe truncation: `chars()` can't split a multi-byte character in
    // half the way slicing would.
    let stem = collapsed.chars().take(80).collect::<String>();
    // A trailing dot is legal on Linux but not on Windows, and would also
    // run into the extension that gets appended next.
    let stem = stem.trim_end_matches('.').trim();

    if stem.is_empty() {
        "Aufnahme".to_string()
    } else {
        stem.to_string()
    }
}

/// Gives the finished take the name the user typed, right before it is
/// added — the file name is what the action log and an export show, so
/// "aufnahme.mp4" for every recording would be a poor label. Returns the
/// new path, which is what goes on to `add_items_with_dates`.
#[tauri::command(async)]
pub fn name_recording(path: String, name: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    resolve_staged(&path)?;
    // Built from the path as given, not the canonical one: on macOS the
    // temp dir is reached through a symlink (/var → /private/var), and
    // `discard_recording` compares against the unresolved root.
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();
    let dir = path.parent().ok_or(crate::i18n::tr("Die Aufnahme hat keinen Ordner."))?;
    let target = dir.join(format!("{}.{extension}", sanitize_file_stem(&name)));
    if target != path {
        std::fs::rename(&path, &target).map_err(|e| crate::trf!("Konnte die Aufnahme nicht umbenennen: {e}", e = e))?;
    }
    Ok(target.to_string_lossy().to_string())
}

/// Removes a staging file once its recording has been added to the project
/// (or thrown away before that). Refuses anything outside the staging
/// root, so a wrong path can never delete one of the user's own files.
///
/// Note that this does leave the added item with a `source_path` that no
/// longer exists. That is the same situation as a file the user moved or
/// deleted after adding it, which the undo path already handles as a plain
/// "not restorable" (see `restore_from_source`) — and a recording has no
/// original outside the project to point at in the first place.
#[tauri::command(async)]
pub fn discard_recording(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let root = staging_root();
    if !path.starts_with(&root) {
        return Err(crate::i18n::tr("Dieser Pfad gehört nicht zum Aufnahme-Zwischenspeicher.").to_string());
    }
    // Canonicalizing needs something on disk to resolve; an already-gone
    // path is harmless, since removing it is a no-op.
    if path.exists() {
        resolve_staged(&path)?;
    }

    // Only the per-recording subdirectory, never the shared root itself.
    let dir = path
        .parent()
        .filter(|parent| *parent != root.as_path())
        .map(Path::to_path_buf);

    // Both best-effort: a staging file that is already gone is exactly the
    // state this command is asked to produce.
    let _ = std::fs::remove_file(&path);
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir(dir);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsbrowse::{self, FileKind};

    /// What `capture.rs` produces has to land as the right kind of item
    /// and be served with a playable MIME type.
    #[test]
    fn recording_extensions_classify_correctly() {
        for name in ["aufnahme.m4a", "aufnahme.weba"] {
            let audio = PathBuf::from(name);
            assert_eq!(fsbrowse::classify(&audio), FileKind::Audio, "{name}");
            assert!(crate::timeline_commands::mime_for(&audio).starts_with("audio/"), "{name}");
        }
        for name in ["aufnahme.mp4", "aufnahme.webm"] {
            let video = PathBuf::from(name);
            assert_eq!(fsbrowse::classify(&video), FileKind::Video, "{name}");
            assert!(crate::timeline_commands::mime_for(&video).starts_with("video/"), "{name}");
        }
    }

    #[test]
    fn naming_renames_inside_the_staging_directory() {
        let dir = staging_root().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aufnahme.m4a");
        std::fs::write(&path, b"x").unwrap();

        let named = name_recording(path.to_string_lossy().to_string(), "Oma / erzählt".to_string()).unwrap();
        assert!(named.ends_with("Oma erzählt.m4a"), "{named}");
        assert!(Path::new(&named).is_file());
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_stem_loses_path_separators_but_keeps_the_name() {
        assert_eq!(sanitize_file_stem("Urlaub/2026"), "Urlaub 2026");
        assert_eq!(sanitize_file_stem("C:\\Grüße"), "C Grüße");
        assert_eq!(sanitize_file_stem("  Oma   erzählt  "), "Oma erzählt");
    }

    #[test]
    fn empty_or_unusable_name_falls_back() {
        assert_eq!(sanitize_file_stem(""), "Aufnahme");
        assert_eq!(sanitize_file_stem("   "), "Aufnahme");
        assert_eq!(sanitize_file_stem("..."), "Aufnahme");
    }

    #[test]
    fn long_name_is_capped_without_splitting_a_character() {
        let stem = sanitize_file_stem(&"ä".repeat(200));
        assert_eq!(stem.chars().count(), 80);
    }

    #[test]
    fn discard_refuses_a_path_outside_the_staging_root() {
        let outside = std::env::temp_dir().join("cronostream-not-a-recording.webm");
        std::fs::write(&outside, b"x").unwrap();

        let err = discard_recording(outside.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("Zwischenspeicher"), "{err}");
        assert!(outside.is_file(), "the file outside the staging root must survive");

        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn discard_removes_the_staging_file_and_its_directory() {
        let dir = staging_root().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Aufnahme.weba");
        std::fs::write(&path, b"x").unwrap();

        discard_recording(path.to_string_lossy().to_string()).unwrap();

        assert!(!path.exists());
        assert!(!dir.exists());
    }

    #[test]
    fn discard_keeps_the_shared_staging_root() {
        let root = staging_root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("lose-aufnahme.webm");
        std::fs::write(&path, b"x").unwrap();

        discard_recording(path.to_string_lossy().to_string()).unwrap();

        assert!(!path.exists());
        assert!(root.is_dir(), "the root is shared with other recordings");
    }

    #[test]
    fn discard_of_an_already_deleted_file_succeeds() {
        let path = staging_root().join(Uuid::new_v4().to_string()).join("weg.webm");
        assert!(discard_recording(path.to_string_lossy().to_string()).is_ok());
    }

    /// The hole this check closes: `Path::starts_with` compares components,
    /// so a path that walks back out of the staging root with `..` still
    /// "starts with" it — while the OS resolves the `..` and would hand
    /// `remove_file`/`remove_dir` whatever is really at the end of it.
    #[test]
    fn discard_refuses_a_traversal_that_resolves_outside_the_staging_root() {
        let root = staging_root();
        let sub_dir = root.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&sub_dir).unwrap();

        let outside_dir = std::env::temp_dir().join(format!("cronostream-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("nicht-eine-aufnahme.webm");
        std::fs::write(&outside_file, b"x").unwrap();

        let escaped = sub_dir
            .join("..")
            .join("..")
            .join(outside_dir.file_name().unwrap())
            .join(outside_file.file_name().unwrap());
        assert!(
            escaped.starts_with(&root),
            "precondition: the unresolved path does pass a plain starts_with test"
        );

        let err = discard_recording(escaped.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("Zwischenspeicher"), "{err}");
        assert!(outside_file.is_file(), "the file outside the staging root must survive");

        let _ = std::fs::remove_dir_all(&sub_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }
}
