//! The one place that deletes a project's own files.
//!
//! Paths in the database are absolute. A project folder copied or moved by
//! hand — rather than through the app's own duplicate/backup, which rewrites
//! them (`copy_task::rewrite_item_paths`) — keeps pointing at the old
//! folder, and a delete driven by those paths alone would then erase files
//! in a *different* stream or in a backup. Every delete of project
//! content goes through here instead, and is refused unless the path lies
//! inside this project's own `originals/`, `thumbnails/` or `diary/` folder.
//!
//! `PendingDeletions` is the other half: deletes that belong to a database
//! change are collected while its transaction runs and only carried out
//! once it has committed. A failed commit (disk full, I/O error) or a crash
//! in between then leaves at worst an orphaned file — never a row back on
//! the timeline whose file is already gone.

use std::path::{Path, PathBuf};

/// The folders inside a project that hold files the project owns. Nothing
/// outside them is ever deleted through this module.
const OWNED_DIRS: [&str; 3] = ["originals", "thumbnails", "diary"];

/// Where `path` really is, if that is strictly inside one of the project's
/// own folders (never one of those folders itself). Only the parent is
/// resolved, so `..` and a symlinked folder are judged by where they lead,
/// while a symlink *as the last component* is judged — and later removed —
/// as the link itself, not whatever it points to. `None` when the location
/// cannot be resolved (usually: it no longer exists) or lies elsewhere.
fn owned_location(project_root: &Path, path: &Path) -> Option<PathBuf> {
    let root = project_root.canonicalize().ok()?;
    let name = path.file_name()?;
    let location = path.parent()?.canonicalize().ok()?.join(name);
    OWNED_DIRS
        .iter()
        .map(|dir| root.join(dir))
        .any(|owned| location.starts_with(&owned) && location != owned)
        .then_some(location)
}

fn refuse(project_root: &Path, path: &Path) {
    eprintln!(
        "Löschen verweigert: {} liegt nicht im Projektordner {}",
        path.display(),
        project_root.display()
    );
}

/// Deletes one file of the project. A path outside the project's own
/// folders is left alone. Returns whether a file was removed.
pub fn remove_file(project_root: &Path, path: &Path) -> bool {
    if path.symlink_metadata().is_err() {
        return false;
    }
    match owned_location(project_root, path) {
        Some(location) => std::fs::remove_file(location).is_ok(),
        None => {
            refuse(project_root, path);
            false
        }
    }
}

/// Deletes a whole folder of the project (a diary entry's own folder).
/// Same rule as `remove_file`. Returns whether the folder was removed.
pub fn remove_dir_all(project_root: &Path, dir: &Path) -> bool {
    if dir.symlink_metadata().is_err() {
        return false;
    }
    match owned_location(project_root, dir) {
        Some(location) => std::fs::remove_dir_all(location).is_ok(),
        None => {
            refuse(project_root, dir);
            false
        }
    }
}

/// An item's in-project copy and its thumbnail.
pub fn remove_item_files(project_root: &Path, stored_path: &str, thumbnail_path: Option<&str>) {
    remove_file(project_root, Path::new(stored_path));
    if let Some(thumb) = thumbnail_path {
        remove_file(project_root, Path::new(thumb));
    }
}

/// Files and folders whose rows are being deleted in a transaction that has
/// not committed yet. Call `run` right after the commit; dropping it
/// without (because the commit failed) keeps every file where it is.
#[derive(Default)]
#[must_use = "the files are only deleted by calling `run` after the commit"]
pub struct PendingDeletions {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

impl PendingDeletions {
    pub fn item_files(&mut self, stored_path: &str, thumbnail_path: Option<&str>) {
        self.files.push(PathBuf::from(stored_path));
        if let Some(thumb) = thumbnail_path {
            self.files.push(PathBuf::from(thumb));
        }
    }

    pub fn file(&mut self, path: impl Into<PathBuf>) {
        self.files.push(path.into());
    }

    pub fn dir(&mut self, path: impl Into<PathBuf>) {
        self.dirs.push(path.into());
    }

    pub fn run(self, project_root: &Path) {
        for file in &self.files {
            remove_file(project_root, file);
        }
        for dir in &self.dirs {
            remove_dir_all(project_root, dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cronostream-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir.canonicalize().unwrap())
        }

        /// A project folder with one original, one thumbnail and one diary
        /// entry folder; returns their paths.
        fn project(&self, name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
            let project = self.0.join(name);
            let original = project.join("originals/2024/01/a.jpg");
            let thumb = project.join("thumbnails/2024/01/a.jpg");
            let diary = project.join("diary/abc");
            for file in [&original, &thumb, &diary.join("entry.txt")] {
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, b"x").unwrap();
            }
            (project, original, thumb, diary)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn deletes_the_projects_own_files() {
        let scratch = Scratch::new();
        let (project, original, thumb, diary) = scratch.project("P");

        remove_item_files(&project, &original.to_string_lossy(), Some(&thumb.to_string_lossy()));
        assert!(remove_dir_all(&project, &diary));

        assert!(!original.exists());
        assert!(!thumb.exists());
        assert!(!diary.exists());
    }

    /// The case this module exists for: a hand-copied project whose
    /// database still points at the folder it was copied from.
    #[test]
    fn refuses_files_of_another_project() {
        let scratch = Scratch::new();
        let (_, other_original, other_thumb, other_diary) = scratch.project("Original");
        let (copy, ..) = scratch.project("Kopie");

        remove_item_files(&copy, &other_original.to_string_lossy(), Some(&other_thumb.to_string_lossy()));
        assert!(!remove_dir_all(&copy, &other_diary));

        assert!(other_original.exists());
        assert!(other_thumb.exists());
        assert!(other_diary.join("entry.txt").exists());
    }

    #[test]
    fn refuses_a_path_that_climbs_out_of_the_project() {
        let scratch = Scratch::new();
        let (project, ..) = scratch.project("P");
        let (_, other_original, ..) = scratch.project("Q");
        let sneaky = project.join("originals/../../Q/originals/2024/01/a.jpg");

        assert!(!remove_file(&project, &sneaky));
        assert!(other_original.exists());
    }

    #[test]
    fn refuses_the_owned_folders_themselves_and_the_project_root() {
        let scratch = Scratch::new();
        let (project, original, ..) = scratch.project("P");

        assert!(!remove_dir_all(&project, &project.join("originals")));
        assert!(!remove_dir_all(&project, &project.join("diary")));
        assert!(!remove_dir_all(&project, &project));
        assert!(!remove_file(&project, &project.join("cronostream.db")));
        assert!(original.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_is_judged_by_where_it_leads() {
        let scratch = Scratch::new();
        let (project, ..) = scratch.project("P");
        let (_, other_original, ..) = scratch.project("Q");
        let link = project.join("originals/2024/verlinkt");
        std::os::unix::fs::symlink(other_original.parent().unwrap(), &link).unwrap();

        assert!(!remove_file(&project, &link.join("a.jpg")));
        assert!(other_original.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_project_is_removed_as_a_link_not_followed() {
        let scratch = Scratch::new();
        let (project, ..) = scratch.project("P");
        let (_, other_original, ..) = scratch.project("Q");
        let link = project.join("originals/2024/01/link.jpg");
        std::os::unix::fs::symlink(&other_original, &link).unwrap();

        assert!(remove_file(&project, &link));
        assert!(link.symlink_metadata().is_err());
        assert!(other_original.exists());
    }

    #[test]
    fn pending_deletions_only_happen_on_run() {
        let scratch = Scratch::new();
        let (project, original, thumb, diary) = scratch.project("P");

        let mut pending = PendingDeletions::default();
        pending.item_files(&original.to_string_lossy(), Some(&thumb.to_string_lossy()));
        pending.dir(&diary);
        drop(pending);
        assert!(original.exists() && thumb.exists() && diary.exists());

        let mut pending = PendingDeletions::default();
        pending.item_files(&original.to_string_lossy(), Some(&thumb.to_string_lossy()));
        pending.dir(&diary);
        pending.run(&project);
        assert!(!original.exists() && !thumb.exists() && !diary.exists());
    }
}
