//! The app-wide half of the settings system.
//!
//! Every setting in the dialog answers two questions: *what* is it set to,
//! and *where does that choice live* — in this one stream, or on this
//! machine for all of them. The project database (`settings` table, see
//! `settings.rs`) answers the first for project-scoped settings. This file
//! answers it for app-scoped ones, and owns the second question outright:
//! the scope of a setting is itself a machine-level fact, so it is stored
//! here regardless of which way it points.
//!
//! Why the scope lives here and not in the project: a project-scoped choice
//! that travelled with a restored or duplicated stream would drag the
//! *scope* along too, so opening someone else's stream could silently
//! re-point your own settings. Keeping the scope machine-local means a
//! Stream carries values, never the decision about where values come
//! from.
//!
//! A project-scoped setting keeps its row in the project database even
//! while the app-wide value is in force, so switching back restores exactly
//! the value that stream had before — nothing is overwritten by the
//! detour through app scope.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILENAME: &str = "app_settings.json";

pub const SCOPE_PROJECT: &str = "project";
pub const SCOPE_APP: &str = "app";

/// One setting's app-wide record.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Entry {
    /// `"project"` or `"app"` — where this setting's value is read from.
    /// Absent entries fall back to the setting's own default scope (see
    /// `SETTINGS` in `action_log_commands.rs`).
    pub scope: Option<String>,
    /// The app-wide value, in the same string encoding the project database
    /// uses. `None` until the setting has been app-scoped at least once.
    pub value: Option<String>,
}

pub type Store = BTreeMap<String, Entry>;

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht ermitteln: {e}", e = e))?;
    fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte Konfigurationsordner nicht anlegen: {e}", e = e))?;
    Ok(dir.join(FILENAME))
}

/// Never fails: a missing or unreadable file means "nothing chosen yet",
/// which is exactly the empty store. Settings must not be able to stop the
/// app from starting.
pub fn load(app: &AppHandle) -> Store {
    let Ok(path) = store_path(app) else {
        return Store::new();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return Store::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let contents = serde_json::to_string_pretty(store)
        .map_err(|e| crate::trf!("Konnte App-Einstellungen nicht speichern: {e}", e = e))?;
    // Via a temporary file: a crash mid-write would otherwise leave broken
    // JSON that `load` reads as "no settings" and the next save makes final.
    crate::safe_io::write_durably(&path, contents).map_err(|e| crate::trf!("Konnte App-Einstellungen nicht speichern: {e}", e = e))
}

/// Which scope `key` currently resolves through, falling back to the
/// setting's own default when the user has never chosen.
pub fn scope_of(store: &Store, key: &str, default_scope: &str) -> String {
    store
        .get(key)
        .and_then(|e| e.scope.clone())
        .filter(|s| s == SCOPE_PROJECT || s == SCOPE_APP)
        .unwrap_or_else(|| default_scope.to_string())
}

/// The stored app-wide value, if this setting has ever had one.
pub fn value_of(store: &Store, key: &str) -> Option<String> {
    store.get(key).and_then(|e| e.value.clone())
}

pub fn set_value(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let mut store = load(app);
    store.entry(key.to_string()).or_default().value = Some(value.to_string());
    save(app, &store)
}

/// Points `key` at a scope and seeds that scope with `value` in one write,
/// so the value in force cannot change as a side effect of moving the
/// setting between scopes.
///
/// `value` is `None` for a setting that has never been set at all: there is
/// nothing to carry across, and the setting's own default has to keep
/// applying on both sides of the switch. Storing a placeholder instead
/// would make "never chosen" indistinguishable from a real value and quietly
/// defeat that default.
pub fn set_scope(app: &AppHandle, key: &str, scope: &str, value: Option<&str>) -> Result<(), String> {
    let mut store = load(app);
    let entry = store.entry(key.to_string()).or_default();
    entry.scope = Some(scope.to_string());
    if scope == SCOPE_APP {
        if let Some(value) = value {
            entry.value = Some(value.to_string());
        }
    }
    save(app, &store)
}
