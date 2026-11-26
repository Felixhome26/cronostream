use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;

pub struct CurrentProject {
    pub path: PathBuf,
    #[allow(dead_code)]
    pub conn: Connection,
    pub privacy: PrivacySession,
}

/// The private mode's state for this opening of the project (see privacy.rs).
/// Not stored anywhere, so private files are hidden again after every open.
#[derive(Default)]
pub struct PrivacySession {
    pub revealed: bool,
    pub failed_attempts: u32,
}

#[derive(Default)]
pub struct AppState {
    pub current_project: Option<CurrentProject>,
}

/// The app-wide state behind one lock. A thin wrapper around `Mutex` whose
/// only difference is what happens after a panic while the lock was held:
/// a plain `Mutex` stays poisoned, and from then on every command (open,
/// close, even quitting cleanly) would fail until the app is restarted.
/// The state itself is safe to keep using — the connection rolls back any
/// transaction the panic interrupted — so `lock` hands it out regardless.
///
/// It still returns a `Result` (that can never be an error) so the call
/// sites keep reading like the `Mutex` they were written against.
#[derive(Default)]
pub struct AppStateHandle(Mutex<AppState>);

impl AppStateHandle {
    pub fn lock(&self) -> Result<MutexGuard<'_, AppState>, Infallible> {
        Ok(self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Re-takes the state lock for the write phase of a background job that let
/// it go during its slow part (copying, hashing) — and refuses if the user
/// closed or switched the project in the meantime, so the job never writes
/// its results into the wrong project's database.
pub fn lock_project<'a>(state: &'a AppStateHandle, expected: &Path) -> Result<MutexGuard<'a, AppState>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    match &guard.current_project {
        Some(current) if current.path == expected => Ok(guard),
        _ => Err(crate::i18n::tr("Der Stream wurde während des Vorgangs geschlossen.").to_string()),
    }
}
