use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::action_log_commands;
use crate::lock::{self, LockState};
use crate::media_server;
use crate::project::{self, ProjectInfo};
use crate::recent::{self, RecentProjectEntry};
use crate::state::{AppStateHandle, CurrentProject};

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenProjectResult {
    Opened { project: ProjectInfo },
    NotAProject,
    LockStale { pid: u32 },
    LockActive { pid: u32 },
}

/// The cheap half of opening a project — folder/lock checks only, no DB
/// touch. Lets the frontend switch away from the start screen immediately
/// once it knows there's no conflict dialog to show, instead of only after
/// `open_project` (which can take a while on a large project) has fully
/// returned. Only used ahead of the *first* open attempt (`force: false`);
/// `confirmForceOpen`'s retry already has its answer to the lock prompt and
/// calls `open_project` with `force: true` directly.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenPrecheckResult {
    Ready,
    NotAProject,
    LockStale { pid: u32 },
    LockActive { pid: u32 },
}

/// The lock check for opening, minus the one lock that is no conflict: our
/// own, on the stream this process still has open. That is what a reload of
/// the window (F5/Ctrl+R) leaves behind — the backend keeps the stream while
/// the fresh page starts on the start screen — and reporting it as "open in
/// another window" was wrong, there is no other window. `activate_project`
/// closes the old state itself when it reopens the same folder.
fn lock_state_for_open(app: &AppHandle, path: &Path) -> LockState {
    let found = lock::check_for_open(path);
    if let LockState::Active { pid } = found {
        if pid == std::process::id() {
            let state = app.state::<AppStateHandle>();
            let ours = state
                .lock()
                .ok()
                .is_some_and(|guard| guard.current_project.as_ref().is_some_and(|current| same_folder(&current.path, path)));
            if ours {
                return LockState::Free;
            }
        }
    }
    found
}

#[tauri::command(async)]
pub fn precheck_open_project(app: AppHandle, path: String) -> OpenPrecheckResult {
    let path_buf = PathBuf::from(&path);
    if !project::is_project_folder(&path_buf) {
        return OpenPrecheckResult::NotAProject;
    }
    match lock_state_for_open(&app, &path_buf) {
        LockState::Active { pid } => OpenPrecheckResult::LockActive { pid },
        LockState::Stale { pid } => OpenPrecheckResult::LockStale { pid },
        LockState::Free => OpenPrecheckResult::Ready,
    }
}

/// Number of live (not removed) items per project, for the start screen's
/// tile overlay. Opens each database read-only and without migrating — this
/// is a passive peek at projects that are not open — so a project that is
/// missing, locked or unreadable simply has no entry instead of failing the
/// whole call.
#[tauri::command]
pub async fn count_project_items(paths: Vec<String>) -> std::collections::HashMap<String, i64> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = std::collections::HashMap::new();
        for path in paths {
            let db = project::db_path(std::path::Path::new(&path));
            if !db.is_file() {
                continue;
            }
            let Ok(conn) = rusqlite::Connection::open_with_flags(
                &db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ) else {
                continue;
            };
            if let Ok(count) = conn.query_row(
                &format!("SELECT COUNT(*) FROM items WHERE {}", crate::schema::LIVE_ITEMS),
                [],
                |row| row.get::<_, i64>(0),
            ) {
                out.insert(path, count);
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(async)]
pub fn list_recent_projects(app: AppHandle) -> Vec<RecentProjectEntry> {
    recent::load_recent(&app)
}

#[tauri::command(async)]
pub fn remove_recent_project(app: AppHandle, path: String) -> Result<(), String> {
    recent::remove_recent(&app, &path)
}

#[tauri::command(async)]
pub fn set_default_project(app: AppHandle, path: String, enabled: bool) -> Result<(), String> {
    recent::set_default(&app, &path, enabled)
}

fn activate_project(
    app: &AppHandle,
    state: &State<AppStateHandle>,
    path: PathBuf,
) -> Result<ProjectInfo, String> {
    // Reopening the stream that is already open: its lock and connection
    // have to go first, or the reopen would find its own lock and the
    // rename below would run under an open connection. Any *other* stream
    // stays open until the new one has opened successfully, so a failed
    // switch leaves the user where they were.
    let reopening = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard.current_project.as_ref().is_some_and(|current| same_folder(&current.path, &path))
    };
    if reopening {
        close_current(app, state)?;
    }

    // The one place a database still under its LifeStream name gets the new
    // one: no connection of this app is open on it here, and the stream is
    // about to be opened under whichever name it ends up with.
    project::adopt_legacy_db(&path);
    let conn = project::open_project_db(&path)?;
    lock::acquire(&path)?;

    // From here on the lock is ours: every way out that does not end with
    // the stream open has to give it back, or the stream counts as "open
    // elsewhere" until the app restarts.
    let info = project::project_info(&conn, &path);
    // The start screen list is a convenience; a config folder that cannot
    // be written to is no reason to refuse opening the stream itself.
    if let Err(e) = recent::touch_recent(app, &info.path, &info.name) {
        eprintln!("Zuletzt geöffnet nicht aktualisiert: {e}");
    }

    // Any setting the user put in app scope has to reach this project's own
    // `settings` rows, because the code that acts on those settings (the
    // import path's video-frame percentage, `delete_files_on_remove`) reads
    // the project database and knows nothing about scopes. Done on open, so
    // it is in place before anything can read it.
    action_log_commands::sync_app_scoped_into_project(app, &conn);

    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(e) => {
            lock::release(&path);
            return Err(e.to_string());
        }
    };
    // Only one project may be active at a time.
    if let Some(previous) = guard.current_project.take() {
        lock::release(&previous.path);
        // The media server's grant goes with it — it is scoped to "the
        // open project", and a grant left behind would keep serving a
        // project nobody has open any more.
        app.state::<media_server::MediaServerHandle>().revoke_dir(&previous.path);
    }
    // Lets the local media server (see media_server.rs) stream this
    // project's audio into the webview — granted per-project since that
    // server's scope has no notion of "whatever project is currently open".
    app.state::<media_server::MediaServerHandle>().allow_dir(&path, true);
    guard.current_project = Some(CurrentProject { path, conn, privacy: Default::default() });

    Ok(info)
}

/// Gives up the open stream (if any): its lock, its media grant, its
/// connection.
pub(crate) fn close_current(app: &AppHandle, state: &State<AppStateHandle>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(current) = guard.current_project.take() {
        lock::release(&current.path);
        app.state::<media_server::MediaServerHandle>().revoke_dir(&current.path);
    }
    Ok(())
}

/// The same folder through any spelling (symlink, trailing slash, `..`).
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Creates a new project as a subfolder of `parent_path`, named `name`
/// (sanitized for the filesystem). Fails if a folder with that name already
/// exists there — the user is asked to pick a different name.
#[tauri::command(async)]
pub fn create_project(
    app: AppHandle,
    state: State<AppStateHandle>,
    name: String,
    parent_path: String,
) -> Result<ProjectInfo, String> {
    let project_path = project::create_project_in(&PathBuf::from(parent_path), &name)?;
    activate_project(&app, &state, project_path)
}

/// Opens an existing project. `async` + `spawn_blocking` because
/// `activate_project` does real I/O (opening the SQLite connection, running
/// `schema::migrate`) that must not sit on the IPC thread — same reasoning
/// as `add_items`. Re-fetches state by `AppHandle` inside the closure since
/// a `tauri::State` borrow can't cross into a `'static` spawn_blocking
/// closure.
#[tauri::command]
pub async fn open_project(app: AppHandle, path: String, force: bool) -> Result<OpenProjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path);

        if !project::is_project_folder(&path_buf) {
            return Ok(OpenProjectResult::NotAProject);
        }

        if !force {
            match lock_state_for_open(&app, &path_buf) {
                LockState::Active { pid } => return Ok(OpenProjectResult::LockActive { pid }),
                LockState::Stale { pid } => return Ok(OpenProjectResult::LockStale { pid }),
                LockState::Free => {}
            }
        }

        let state = app.state::<AppStateHandle>();
        let info = activate_project(&app, &state, path_buf)?;
        Ok(OpenProjectResult::Opened { project: info })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[tauri::command(async)]
pub fn close_current_project(app: AppHandle, state: State<AppStateHandle>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(current) = guard.current_project.take() {
        lock::release(&current.path);
        // Same as when switching projects, see `activate_project`.
        app.state::<media_server::MediaServerHandle>().revoke_dir(&current.path);
    }
    Ok(())
}
