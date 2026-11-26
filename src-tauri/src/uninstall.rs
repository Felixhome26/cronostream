//! Removing CronoStream from the computer: "CronoStream vollständig
//! entfernen" in the settings, and the start menu entry "CronoStream
//! deinstallieren" (`UNINSTALL_ARG`), which opens the same dialog.
//!
//! What goes is everything the app put down outside the streams: settings,
//! recent list, log, the drop box's waiting list, the disk search index, the
//! databases kept of deleted streams, the webview's storage, the caches, the
//! menu and autostart entries, and the same under the former name,
//! LifeStream. The streams themselves stay, unless the dialog picks them one
//! by one (`streams`).
//!
//! Linux has no installer: the folders are deleted by a small shell process
//! that waits for this one to exit, since the webview keeps writing its
//! storage until the very end and a folder deleted before that comes back.
//! The AppImage goes too if the dialog says so.
//!
//! On Windows the folders go with Tauri's uninstaller, started passive with
//! `/WIPEALL` (see `installer-hooks.nsh`), which removes the program, its
//! start menu folder and the autostart value as well. The app itself only
//! deletes the chosen streams and the autostart value beforehand.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::delete_commands;
use crate::state::AppStateHandle;

/// Start argument of the "CronoStream deinstallieren" menu entries, on Linux
/// (`desktop_integration.rs`) and on Windows (`installer-hooks.nsh`).
pub(crate) const UNINSTALL_ARG: &str = "--deinstallieren";

/// Tells a main window that is already showing to open the dialog.
const REQUEST_EVENT: &str = "uninstall-requested";

/// Held until the frontend asks for it: a main window created for the start
/// argument isn't listening yet when the request comes in.
static REQUESTED: AtomicBool = AtomicBool::new(false);

/// How long the dialog's answer gets to reach the frontend before the app
/// exits.
const EXIT_DELAY: Duration = Duration::from_millis(400);

/// For a start with `UNINSTALL_ARG`, whether as this process's first or
/// forwarded from a second start.
pub(crate) fn request(app: &AppHandle) {
    REQUESTED.store(true, Ordering::SeqCst);
    let _ = app.emit(REQUEST_EVENT, ());
}

#[tauri::command]
pub fn take_uninstall_request() -> bool {
    REQUESTED.swap(false, Ordering::SeqCst)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallTarget {
    /// What the path is, for the dialog's wording: `settings`, `webview`,
    /// `cache`, `recordings`, `legacy`, `menu`, `startMenu`, `autostart`,
    /// `program`.
    kind: &'static str,
    path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallStream {
    path: String,
    name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPlan {
    /// Only in an installed app: an AppImage, or a Windows release build
    /// next to its uninstaller. Otherwise `unavailable_reason` says why.
    available: bool,
    unavailable_reason: Option<String>,
    platform: &'static str,
    /// Everything that will be removed, as far as it exists.
    targets: Vec<UninstallTarget>,
    /// The streams the app knows of (its recent list), to pick from.
    streams: Vec<UninstallStream>,
    /// The AppImage file, offered for deletion on its own.
    appimage: Option<String>,
    /// Deleted streams whose database is kept for a restore. That chance
    /// goes with the settings folder.
    kept_deleted_streams: usize,
}

/// Where the removal is handed over to, once the streams are gone.
enum Finisher {
    /// The AppImage file; the folders go after the exit.
    Linux { appimage: PathBuf },
    /// `uninstall.exe` next to the program.
    Windows { uninstaller: PathBuf },
}

fn finisher() -> Result<Finisher, String> {
    if cfg!(windows) {
        if cfg!(debug_assertions) {
            return Err(crate::i18n::tr("Das Entfernen ist nur in der installierten App möglich.").to_string());
        }
        let uninstaller = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe")))
            .filter(|path| path.is_file())
            .ok_or_else(|| crate::i18n::tr("Das Deinstallationsprogramm von CronoStream wurde nicht gefunden.").to_string())?;
        return Ok(Finisher::Windows { uninstaller });
    }
    match crate::desktop_integration::appimage_path() {
        Some(appimage) => Ok(Finisher::Linux { appimage }),
        None => Err(crate::i18n::tr("Das Entfernen ist nur in der installierten App möglich.").to_string()),
    }
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// The app's folders on this system, each with its kind. On Linux the data
/// and local data folder are the same, on Windows the local data and cache
/// folder; `collect_targets` drops the doubles.
fn app_folders(app: &AppHandle) -> Vec<(&'static str, PathBuf)> {
    let paths = app.path();
    let mut folders = Vec::new();
    if let Ok(dir) = paths.app_config_dir() {
        folders.push(("settings", dir));
    }
    for dir in [paths.app_data_dir(), paths.app_local_data_dir(), paths.app_cache_dir()].into_iter().flatten() {
        folders.push(("webview", dir));
    }
    // The preview and playback caches (`preview_cache.rs`, `playback_compat.rs`).
    if let Some(cache) = dirs::cache_dir() {
        folders.push(("cache", cache.join("cronostream")));
    }
    folders.push(("recordings", crate::record_commands::staging_root()));
    // Left over under the former name if a folder couldn't be taken over
    // (`former_name::adopt_app_folders`).
    let legacy = crate::former_name::LEGACY_IDENTIFIER;
    for base in [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()].into_iter().flatten() {
        folders.push(("legacy", base.join(legacy)));
    }
    if let Some(cache) = dirs::cache_dir() {
        folders.push(("legacy", cache.join("lifestream")));
    }
    folders
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn size_of(path: &Path) -> u64 {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_dir() => delete_commands::folder_size(path),
        Ok(meta) => meta.len(),
        Err(_) => 0,
    }
}

fn collect_targets(app: &AppHandle) -> Vec<(&'static str, PathBuf)> {
    let mut targets: Vec<(&'static str, PathBuf)> = app_folders(app);
    if cfg!(target_os = "linux") {
        for file in crate::desktop_integration::linux_entry_files(app) {
            targets.push(("menu", file));
        }
    }
    let mut seen = HashSet::new();
    targets.retain(|(_, path)| exists(path) && seen.insert(path.clone()));
    targets
}

/// Only what is plainly the app's own goes to `rm -rf`: an absolute path
/// whose name carries the app's name, current or former. A path that went
/// wrong somewhere (an empty variable, the home folder) can't pass.
fn is_own_path(path: &Path) -> bool {
    if !path.is_absolute() || path.components().count() < 3 {
        return false;
    }
    let Some(name) = path.file_name() else { return false };
    let name = name.to_string_lossy().to_lowercase();
    name.contains("cronostream") || name.contains("lifestream")
}

fn kept_deleted_streams(app: &AppHandle) -> usize {
    let Ok(dir) = app.path().app_config_dir() else { return 0 };
    std::fs::read_dir(dir.join(delete_commands::DELETED_DIR))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "db"))
                .count()
        })
        .unwrap_or(0)
}

fn known_streams(app: &AppHandle) -> Vec<UninstallStream> {
    let mut seen = HashSet::new();
    crate::recent::load_recent(app)
        .into_iter()
        .filter_map(|entry| {
            let path = PathBuf::from(&entry.path);
            if !crate::project::is_project_folder(&path) {
                return None;
            }
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if !seen.insert(canonical) {
                return None;
            }
            Some(UninstallStream { size_bytes: delete_commands::folder_size(&path), path: entry.path, name: entry.name })
        })
        .collect()
}

/// Everything the dialog shows before anything is removed.
#[tauri::command(async)]
pub fn get_uninstall_plan(app: AppHandle) -> UninstallPlan {
    let finisher = finisher();
    let mut targets: Vec<UninstallTarget> = collect_targets(&app)
        .into_iter()
        .map(|(kind, path)| UninstallTarget { kind, size_bytes: size_of(&path), path: path.to_string_lossy().to_string() })
        .collect();
    if let Ok(Finisher::Windows { uninstaller }) = &finisher {
        if let Some(dir) = uninstaller.parent() {
            targets.insert(0, UninstallTarget { kind: "program", path: dir.to_string_lossy().to_string(), size_bytes: size_of(dir) });
        }
        // The start menu folder and the desktop shortcut (`windows_links`).
        if let Some(places) = crate::windows_links::places(&app) {
            let start_menu = places.start_menu_dir();
            if start_menu.is_dir() {
                targets.push(UninstallTarget { kind: "startMenu", path: start_menu.to_string_lossy().to_string(), size_bytes: 0 });
            }
            for link in places.existing().into_iter().filter(|path| !path.starts_with(start_menu)) {
                targets.push(UninstallTarget { kind: "menu", path: link.to_string_lossy().to_string(), size_bytes: 0 });
            }
        }
        if crate::desktop_integration::windows_autostart_set() {
            targets.push(UninstallTarget {
                kind: "autostart",
                path: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\CronoStream Ablage".into(),
                size_bytes: 0,
            });
        }
    }
    UninstallPlan {
        available: finisher.is_ok(),
        unavailable_reason: finisher.as_ref().err().cloned(),
        platform: platform_name(),
        targets,
        streams: known_streams(&app),
        appimage: match &finisher {
            Ok(Finisher::Linux { appimage }) => Some(appimage.to_string_lossy().to_string()),
            _ => None,
        },
        kept_deleted_streams: kept_deleted_streams(&app),
    }
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Deletes the chosen streams, then hands over to the uninstaller (Windows)
/// or the cleanup after the exit (Linux), and ends the app. A stream that
/// can't be deleted stops everything before the app itself is touched, so
/// the dialog can be tried again.
#[tauri::command(async)]
pub fn run_uninstall(
    app: AppHandle,
    state: State<AppStateHandle>,
    streams: Vec<String>,
    delete_appimage: bool,
) -> Result<(), String> {
    let finisher = finisher()?;

    let open = state.lock().ok().and_then(|guard| guard.current_project.as_ref().map(|c| c.path.clone()));
    if let Some(open) = open {
        if streams.iter().any(|stream| same_folder(&open, Path::new(stream))) {
            crate::commands::close_current(&app, &state)?;
        }
    }
    let failed: Vec<String> = streams
        .iter()
        .filter_map(|stream| {
            delete_commands::delete_stream_for_uninstall(&app, Path::new(stream))
                .err()
                .map(|e| format!("{stream}: {e}"))
        })
        .collect();
    if !failed.is_empty() {
        return Err(crate::trf!(
            "Diese Streams konnten nicht gelöscht werden, sonst wurde noch nichts entfernt:\n{list}",
            list = failed.join("\n")
        ));
    }

    match finisher {
        Finisher::Linux { appimage } => {
            let mut paths: Vec<PathBuf> =
                collect_targets(&app).into_iter().map(|(_, path)| path).filter(|path| is_own_path(path)).collect();
            if delete_appimage {
                paths.push(appimage);
            }
            spawn_cleanup_after_exit(&paths)
                .map_err(|e| crate::trf!("Konnte das Aufräumen nicht starten: {e}", e = e))?;
        }
        Finisher::Windows { uninstaller } => {
            crate::desktop_integration::remove_windows_autostart();
            // `/P`: passive, no second confirmation; the dialog was it.
            // `/WIPEALL`: the app data goes too (installer-hooks.nsh).
            Command::new(&uninstaller)
                .args(["/P", "/WIPEALL"])
                .spawn()
                .map_err(|e| crate::trf!("Konnte das Deinstallationsprogramm nicht starten: {e}", e = e))?;
        }
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_DELAY);
        app.exit(0);
    });
    Ok(())
}

/// A shell of the system's own, away from the AppImage's libraries (the
/// environment is cleared) and in a process group of its own, waits up to a
/// minute for this process to end and then deletes `paths`.
#[cfg(unix)]
fn spawn_cleanup_after_exit(paths: &[PathBuf]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    const SCRIPT: &str = r#"pid=$1; shift; n=0
while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n + 1)); done
rm -rf -- "$@""#;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(SCRIPT)
        .arg("cronostream-uninstall")
        .arg(std::process::id().to_string())
        .args(paths)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
}

#[cfg(not(unix))]
fn spawn_cleanup_after_exit(_paths: &[PathBuf]) -> std::io::Result<()> {
    Err(std::io::Error::other("not on unix"))
}

#[cfg(test)]
mod tests {
    use super::is_own_path;
    use std::path::Path;

    #[test]
    fn only_the_apps_own_paths_may_be_removed() {
        assert!(is_own_path(Path::new("/home/a/.config/com.felixheck.cronostream")));
        assert!(is_own_path(Path::new("/home/a/.cache/lifestream")));
        assert!(is_own_path(Path::new("/home/a/.local/share/applications/com.felixheck.cronostream.desktop")));
        assert!(is_own_path(Path::new("/tmp/cronostream-recordings")));
        assert!(!is_own_path(Path::new("/home/a/.config")));
        assert!(!is_own_path(Path::new("/home/a")));
        assert!(!is_own_path(Path::new("/cronostream")));
        assert!(!is_own_path(Path::new("relative/cronostream/x")));
    }
}
