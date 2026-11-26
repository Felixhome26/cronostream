use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RECENT_FILENAME: &str = "recent_projects.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecentProjectEntry {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    /// Opened automatically at the next app start. At most one entry has it.
    #[serde(default)]
    pub is_default: bool,
}

fn recent_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht ermitteln: {e}", e = e))?;
    fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht anlegen: {e}", e = e))?;
    Ok(dir.join(RECENT_FILENAME))
}

pub fn load_recent(app: &AppHandle) -> Vec<RecentProjectEntry> {
    let Ok(path) = recent_file_path(app) else {
        return Vec::new();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_recent(app: &AppHandle, list: &[RecentProjectEntry]) -> Result<(), String> {
    let path = recent_file_path(app)?;
    let contents = serde_json::to_string_pretty(list)
        .map_err(|e| crate::trf!("Konnte zuletzt genutzte Streams nicht speichern: {e}", e = e))?;
    crate::safe_io::write_durably(&path, contents)
        .map_err(|e| crate::trf!("Konnte zuletzt genutzte Streams nicht speichern: {e}", e = e))
}

/// Adds (or bumps) a project at the top of the recent-projects list.
pub fn touch_recent(app: &AppHandle, path: &str, name: &str) -> Result<(), String> {
    let mut list = load_recent(app);
    // Bumping to the front must not lose the "default" mark.
    let is_default = list.iter().any(|e| e.path == path && e.is_default);
    list.retain(|e| e.path != path);
    list.insert(
        0,
        RecentProjectEntry {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: chrono::Utc::now().to_rfc3339(),
            is_default,
        },
    );
    save_recent(app, &list)
}

/// Marks one project as the one opened at app start (or, with `enabled ==
/// false`, clears the mark). Only one entry can hold it, so setting it
/// elsewhere takes it away from the previous one.
pub fn set_default(app: &AppHandle, path: &str, enabled: bool) -> Result<(), String> {
    let mut list = load_recent(app);
    for entry in list.iter_mut() {
        entry.is_default = enabled && entry.path == path;
    }
    save_recent(app, &list)
}

pub fn remove_recent(app: &AppHandle, path: &str) -> Result<(), String> {
    let mut list = load_recent(app);
    list.retain(|e| e.path != path);
    save_recent(app, &list)
}

/// Updates the display name of an existing recent-projects entry in place,
/// without bumping it to the front or touching `last_opened` (unlike
/// `touch_recent`) — renaming shouldn't reorder the list. A no-op if the
/// project isn't in the list.
pub fn rename_recent(app: &AppHandle, path: &str, new_name: &str) -> Result<(), String> {
    let mut list = load_recent(app);
    match list.iter_mut().find(|e| e.path == path) {
        Some(entry) => {
            entry.name = new_name.to_string();
            save_recent(app, &list)
        }
        None => Ok(()),
    }
}
