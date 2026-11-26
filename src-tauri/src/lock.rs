use std::fs;
use std::path::{Path, PathBuf};

use sysinfo::{Pid, System};

pub const LOCK_FILENAME: &str = ".cronostream.lock";
/// The lock file's name before the app was renamed from LifeStream.
pub const LEGACY_LOCK_FILENAME: &str = ".lifestream.lock";

pub enum LockState {
    /// No lock present, free to open.
    Free,
    /// A lock is present but the owning process is no longer running
    /// (e.g. the app crashed last time) — safe to offer "open anyway".
    Stale { pid: u32 },
    /// A lock is present and the owning process is still alive — refuse,
    /// opening the same SQLite file from two live instances risks corruption.
    Active { pid: u32 },
}

fn lock_file_path(project_path: &Path) -> PathBuf {
    project_path.join(LOCK_FILENAME)
}

/// The lock file holds `"<pid>:<start_time>"` rather than just a PID — the
/// OS reuses PIDs fairly quickly after a process exits, so a crashed/killed
/// instance's PID can end up belonging to a totally unrelated process by
/// the time the app is reopened. Recording the owning process's start time
/// alongside its PID lets `check` tell "still the same process" apart from
/// "a different process just happens to have that PID now" — without it,
/// the latter was misreported as `Active`, permanently refusing to open a
/// project that was actually free. Old-format lock files (plain PID, no
/// `:start_time`) still parse, just without that extra check.
fn own_start_time(sys: &System, pid: u32) -> u64 {
    sys.process(Pid::from_u32(pid)).map(|p| p.start_time()).unwrap_or(0)
}

pub fn check(project_path: &Path) -> LockState {
    check_file(&lock_file_path(project_path))
}

/// The lock of an old LifeStream (the app's former name), which a stream
/// may still carry. `project::adopt_legacy_db` reads it so as not to rename
/// the database of a stream such a version still has open.
pub fn check_legacy(project_path: &Path) -> LockState {
    check_file(&project_path.join(LEGACY_LOCK_FILENAME))
}

/// Whether a stream may be opened: its own lock, and the lock of an old
/// LifeStream still running on it, which counts as the stream being open
/// elsewhere just the same. A stale old lock counts for nothing; adopting
/// the database on opening clears it away.
pub fn check_for_open(project_path: &Path) -> LockState {
    if let LockState::Active { pid } = check_legacy(project_path) {
        return LockState::Active { pid };
    }
    check(project_path)
}

fn check_file(lock_path: &Path) -> LockState {
    let Ok(contents) = fs::read_to_string(lock_path) else {
        return LockState::Free;
    };
    let trimmed = contents.trim();
    let (pid_str, recorded_start_time) = match trimmed.split_once(':') {
        Some((pid_str, start_str)) => (pid_str, start_str.parse::<u64>().ok()),
        None => (trimmed, None),
    };
    let Ok(pid) = pid_str.parse::<u32>() else {
        // Unreadable/corrupt lock file — treat as stale, harmless to take over.
        return LockState::Stale { pid: 0 };
    };

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    match sys.process(Pid::from_u32(pid)) {
        Some(process) => {
            let same_process = recorded_start_time.map_or(true, |t| t == process.start_time());
            if same_process {
                LockState::Active { pid }
            } else {
                LockState::Stale { pid }
            }
        }
        None => LockState::Stale { pid },
    }
}

pub fn acquire(project_path: &Path) -> Result<(), String> {
    let lock_path = lock_file_path(project_path);
    let pid = std::process::id();
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let start_time = own_start_time(&sys, pid);
    fs::write(&lock_path, format!("{pid}:{start_time}"))
        .map_err(|e| crate::trf!("Konnte Sperrdatei des Streams nicht anlegen: {e}", e = e))
}

pub fn release(project_path: &Path) {
    let lock_path = lock_file_path(project_path);
    let _ = fs::remove_file(lock_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_lifestream_counts_as_the_stream_being_open() {
        let dir = std::env::temp_dir().join(format!("cronostream-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(matches!(check_for_open(&dir), LockState::Free));
        fs::write(dir.join(LEGACY_LOCK_FILENAME), "999999999").unwrap();
        assert!(matches!(check_for_open(&dir), LockState::Free), "a stale old lock is ignored");
        fs::write(dir.join(LEGACY_LOCK_FILENAME), std::process::id().to_string()).unwrap();
        assert!(matches!(check_for_open(&dir), LockState::Active { .. }));
        let _ = fs::remove_dir_all(&dir);
    }
}
