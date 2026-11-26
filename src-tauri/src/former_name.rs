//! Carries a machine's data over from the app's former name, LifeStream:
//! its folders (settings, deleted streams, the webview's storage with the
//! language and theme, the preview cache). Each stream's own database is
//! renamed separately, the first time it is opened (`project::adopt_legacy_db`).

use std::fs;
use std::path::Path;

pub const LEGACY_IDENTIFIER: &str = "com.felixheck.lifestream";
/// Must match `identifier` in tauri.conf.json.
const IDENTIFIER: &str = "com.felixheck.cronostream";

/// Runs before Tauri starts: the webview opens its storage folder as it is
/// created, and a folder renamed after that would go unnoticed until the
/// next start, with the settings of the old one missing meanwhile.
pub fn adopt_app_folders() {
    // Linux and macOS share some of these folders, Windows keeps them apart.
    // A folder already moved is simply gone the second time.
    let bases = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()];
    for base in bases.into_iter().flatten() {
        adopt(&base.join(LEGACY_IDENTIFIER), &base.join(IDENTIFIER));
    }
    if let Some(cache) = dirs::cache_dir() {
        adopt(&cache.join("lifestream"), &cache.join("cronostream"));
    }
    if let Some(config) = dirs::config_dir() {
        let config = config.join(IDENTIFIER);
        adopt(&config.join("deleted_lifestreams"), &config.join(crate::delete_commands::DELETED_DIR));
    }
}

/// Never over a folder the renamed app already uses: it may already hold
/// the user's newer data.
fn adopt(legacy: &Path, current: &Path) {
    if legacy.is_dir() && !current.exists() {
        if let Err(e) = fs::rename(legacy, current) {
            eprintln!("Konnte {} nicht übernehmen: {e}", legacy.display());
        }
    }
}
