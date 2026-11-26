//! Writing files so that an interruption leaves no damage behind, and
//! containing panics from the many file parsers the app runs in-process.
//!
//! A plain `fs::copy` straight to its final name leaves a half-written file
//! there when the disk fills up, a USB drive is pulled or the power goes —
//! and even a finished copy may still sit only in the page cache when the
//! database row pointing at it is already committed. `copy_durably` writes
//! to a `.part` file, flushes it to the disk, and only then gives it its
//! real name: the final path is either absent or complete.

use std::fs;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

/// The temporary name a file is written under before it is complete —
/// next to its final name, so the closing rename never crosses a
/// filesystem boundary.
fn part_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dst.with_file_name(name)
}

/// Flushes a written file's data to the disk. Opened for writing because
/// Windows refuses to flush a handle without write access.
pub fn sync_file(path: &Path) -> io::Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

/// Makes a rename inside `dir` survive a power loss. Best effort: not
/// every platform lets a directory be opened and flushed (Windows does not
/// need it), so a failure here is not an error.
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Copies `src` to `dst` so that `dst` is either missing or complete and on
/// the disk — never a partial file. On any failure the temporary file is
/// removed again.
pub fn copy_durably(src: &Path, dst: &Path) -> io::Result<u64> {
    let part = part_path(dst);
    let result = (|| {
        let bytes = fs::copy(src, &part)?;
        sync_file(&part)?;
        fs::rename(&part, dst)?;
        Ok(bytes)
    })();
    match result {
        Ok(bytes) => {
            if let Some(dir) = dst.parent() {
                sync_dir(dir);
            }
            Ok(bytes)
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Writes `bytes` to `path` the same way: never a half-written file under
/// the real name, and on the disk before this returns. For files whose
/// loss would hurt (settings, the recent list, diary text, a kept database).
pub fn write_durably(path: &Path, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    write_via_part(path, bytes.as_ref(), true)
}

/// Like `write_durably` but without forcing it to the disk — for files that
/// can be made again (thumbnails), where an interruption must only never
/// leave a half-written file behind for the viewer to choke on.
pub fn write_atomically(path: &Path, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    write_via_part(path, bytes.as_ref(), false)
}

fn write_via_part(path: &Path, bytes: &[u8], durable: bool) -> io::Result<()> {
    let part = part_path(path);
    let result = (|| {
        fs::write(&part, bytes)?;
        if durable {
            sync_file(&part)?;
        }
        fs::rename(&part, path)
    })();
    match result {
        Ok(()) => {
            if durable {
                if let Some(dir) = path.parent() {
                    sync_dir(dir);
                }
            }
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Runs `work`, turning a panic inside it into an ordinary error. For the
/// third-party decoders and parsers (images, PDF, Office, mail) a single
/// broken file can trip: that file fails, the import of the others goes on,
/// and no lock is left poisoned by it.
pub fn catch_panic<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match panic::catch_unwind(AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            Err(crate::trf!("Interner Fehler beim Verarbeiten der Datei. {detail}", detail = detail).trim_end().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cronostream-safe-io-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_and_leaves_no_part_file() {
        let dir = scratch();
        let src = dir.join("a.jpg");
        fs::write(&src, b"hallo").unwrap();
        let dst = dir.join("b.jpg");

        assert_eq!(copy_durably(&src, &dst).unwrap(), 5);
        assert_eq!(fs::read(&dst).unwrap(), b"hallo");
        assert!(!part_path(&dst).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_copy_leaves_neither_target_nor_part_file() {
        let dir = scratch();
        let dst = dir.join("b.jpg");

        assert!(copy_durably(&dir.join("gibtesnicht.jpg"), &dst).is_err());
        assert!(!dst.exists());
        assert!(!part_path(&dst).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_durably_replaces_the_file_in_one_step() {
        let dir = scratch();
        let path = dir.join("settings.json");
        fs::write(&path, b"alt").unwrap();

        write_durably(&path, b"neu").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"neu");
        assert!(!part_path(&path).exists());

        // A target that cannot be written (its folder is gone) fails
        // without leaving a part file behind.
        assert!(write_durably(&dir.join("fehlt/x.json"), b"x").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_panic_becomes_an_error() {
        let result: Result<(), String> = catch_panic(|| panic!("kaputtes JPEG"));
        let message = result.unwrap_err();
        assert!(message.contains("kaputtes JPEG"), "{message}");
    }

    #[test]
    fn a_normal_result_passes_through() {
        assert_eq!(catch_panic(|| Ok(7)), Ok(7));
        assert_eq!(catch_panic::<()>(|| Err("nein".into())), Err("nein".to_string()));
    }
}
