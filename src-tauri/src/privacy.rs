//! The private mode: files whose note contains a chosen text can be hidden
//! with a key combination, and showing them again takes a password.
//!
//! This is a screen, not encryption. The files stay untouched on disk and in
//! the database; the filter only decides what the app's own lists hand to the
//! frontend. The combination in particular is stored readable, because the
//! app has to recognise it without asking for anything first.
//!
//! All of it is per project and lives in the `settings` table, so the
//! protection travels with a copied stream. The rows are written only
//! here, never through `set_project_setting`: a password hash has no business
//! in the Protokoll, and every change has to pass the password check.
//!
//! Whether the private files are showing is deliberately not stored at all.
//! It sits on `CurrentProject`, so every opened project starts hidden.

use std::collections::HashSet;
use std::time::Duration;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::settings;
use crate::state::{lock_project, AppStateHandle, CurrentProject};

const PASSWORD_HASH_KEY: &str = "privacy_password_hash";
const RECOVERY_HASH_KEY: &str = "privacy_recovery_hash";
const SHORTCUT_KEY: &str = "privacy_shortcut";
const MARKER_KEY: &str = "privacy_marker";
const SCOPE_KEY: &str = "privacy_scope";
const AUTO_HIDE_MINUTES_KEY: &str = "privacy_auto_hide_minutes";
const SHOW_INDICATOR_KEY: &str = "privacy_show_indicator";
const ALL_KEYS: [&str; 7] = [
    PASSWORD_HASH_KEY,
    RECOVERY_HASH_KEY,
    SHORTCUT_KEY,
    MARKER_KEY,
    SCOPE_KEY,
    AUTO_HIDE_MINUTES_KEY,
    SHOW_INDICATOR_KEY,
];

const SCOPE_TIMELINE: &str = "timeline";
const SCOPE_VIEWS: &str = "views";
const SCOPE_EVERYWHERE: &str = "everywhere";
const DEFAULT_SCOPE: &str = SCOPE_VIEWS;

const MIN_PASSWORD_CHARS: usize = 4;
const MAX_AUTO_HIDE_MINUTES: u32 = 1440;
const MAX_FAILURE_DELAY_SECONDS: u32 = 5;

/// Told to the frontend when a note just written makes its file private while
/// private files are hidden, so the file disappears right away and not only
/// at the next reload.
pub const NOTE_HID_ITEM_EVENT: &str = "privacy-note-hid-item";

/// What a list is, for the question "does the chosen scope reach it?".
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Surface {
    /// The timeline itself. Every scope covers it.
    Timeline,
    /// Search and the file lists.
    Views,
    /// Protokoll and everything that writes files out of the project.
    Everywhere,
}

fn widest_surface_of(scope: &str) -> Surface {
    match scope {
        SCOPE_TIMELINE => Surface::Timeline,
        SCOPE_EVERYWHERE => Surface::Everywhere,
        _ => Surface::Views,
    }
}

/// Case folded in Rust because SQLite's `lower()` only knows ASCII, the same
/// reason `search_items` matches over here.
fn note_is_private(note: &str, marker: &str) -> bool {
    note.to_lowercase().contains(&marker.to_lowercase())
}

fn private_ids(conn: &Connection, marker: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT item_id, text FROM notes WHERE item_id IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut ids = HashSet::new();
    for row in rows {
        let (id, note) = row.map_err(|e| e.to_string())?;
        if note_is_private(&note, marker) {
            ids.insert(id);
        }
    }
    Ok(ids)
}

fn is_configured(conn: &Connection) -> Result<bool, String> {
    Ok(settings::get(conn, PASSWORD_HASH_KEY)?.is_some())
}

/// The ids this list has to leave out right now. `None` means nothing is
/// hidden from it, which is the case for every project that never set the
/// private mode up, so those pay for one settings read and nothing else.
pub fn hidden_ids(current: &CurrentProject, surface: Surface) -> Result<Option<HashSet<String>>, String> {
    if current.privacy.revealed || !is_configured(&current.conn)? {
        return Ok(None);
    }
    let scope = settings::get(&current.conn, SCOPE_KEY)?.unwrap_or_else(|| DEFAULT_SCOPE.to_string());
    if surface > widest_surface_of(&scope) {
        return Ok(None);
    }
    let Some(marker) = settings::get(&current.conn, MARKER_KEY)? else {
        return Ok(None);
    };
    Ok(Some(private_ids(&current.conn, &marker)?))
}

/// Takes hidden ids out of a list a command was handed. The lists those ids
/// come from are already filtered, so this only catches a selection made
/// before the files were hidden.
pub fn without_hidden(state: &AppStateHandle, ids: Vec<String>, surface: Surface) -> Result<Vec<String>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let Some(hidden) = hidden_ids(current, surface)? else {
        return Ok(ids);
    };
    Ok(ids.into_iter().filter(|id| !hidden.contains(id)).collect())
}

/// Whether writing `note` just made a file vanish from the timeline.
pub fn note_hides_item(current: &CurrentProject, note: &str) -> Result<bool, String> {
    if current.privacy.revealed || !is_configured(&current.conn)? {
        return Ok(false);
    }
    let marker = settings::get(&current.conn, MARKER_KEY)?;
    Ok(marker.is_some_and(|marker| note_is_private(note, &marker)))
}

fn hash_secret(secret: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| crate::trf!("Konnte das Passwort nicht verarbeiten: {e}", e = e))
}

fn secret_matches(stored_hash: &str, secret: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_hash) else {
        return false;
    };
    Argon2::default().verify_password(secret.as_bytes(), &parsed).is_ok()
}

/// 64 random bits as `XXXX-XXXX-XXXX-XXXX`: long enough not to be guessed
/// behind the wait after a wrong try, short enough to copy onto paper.
fn generate_recovery_code() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string().to_uppercase();
    hex.as_bytes()[..16]
        .chunks(4)
        .map(|group| String::from_utf8_lossy(group).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// So a code typed from paper counts however it was spaced or cased.
fn normalized_recovery_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(crate::i18n::tr("Das Passwort muss mindestens 4 Zeichen lang sein.").to_string());
    }
    Ok(())
}

/// The frontend's capture already refuses these; checked again because a
/// combination that could be typed by accident would hide files mid-sentence.
fn validate_shortcut(shortcut: &str) -> Result<(), String> {
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts.pop().unwrap_or("");
    let has_command_modifier = parts.iter().any(|part| matches!(*part, "Ctrl" | "Alt" | "Meta"));
    if key.is_empty() || !has_command_modifier {
        return Err(crate::i18n::tr("Die Tastenkombination braucht Strg oder Alt und eine weitere Taste.").to_string());
    }
    Ok(())
}

fn validated_marker(marker: &str) -> Result<String, String> {
    let trimmed = marker.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::tr("Der Notizinhalt darf nicht leer sein.").to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if matches!(scope, SCOPE_TIMELINE | SCOPE_VIEWS | SCOPE_EVERYWHERE) {
        return Ok(());
    }
    Err(crate::i18n::tr("Unbekannter Geltungsbereich.").to_string())
}

fn validate_auto_hide(minutes: u32) -> Result<(), String> {
    if minutes > MAX_AUTO_HIDE_MINUTES {
        return Err(crate::i18n::tr("Die Wartezeit darf höchstens 1440 Minuten betragen.").to_string());
    }
    Ok(())
}

/// Checks a secret against the stored hash without holding the state lock:
/// the hash is slow on purpose, and the wait after a wrong try must not stall
/// the rest of the app. The wait grows with each failure in a row and is what
/// makes trying passwords by hand pointless.
fn check_secret(app: &AppHandle, hash_key: &str, secret: &str, wrong_message: &'static str) -> Result<(), String> {
    let state = app.state::<AppStateHandle>();
    let (project_path, stored_hash) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        (current.path.clone(), settings::get(&current.conn, hash_key)?)
    };
    let stored_hash = stored_hash.ok_or(crate::i18n::tr("Der Privatmodus ist nicht eingerichtet."))?;
    let matches = secret_matches(&stored_hash, secret);

    let failures = {
        let mut guard = lock_project(&state, &project_path)?;
        let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;
        current.privacy.failed_attempts = if matches { 0 } else { current.privacy.failed_attempts + 1 };
        current.privacy.failed_attempts
    };
    if matches {
        return Ok(());
    }
    std::thread::sleep(Duration::from_secs(u64::from(failures.min(MAX_FAILURE_DELAY_SECONDS))));
    Err(crate::i18n::tr(wrong_message).to_string())
}

fn check_password(app: &AppHandle, password: &str) -> Result<(), String> {
    check_secret(app, PASSWORD_HASH_KEY, password, "Das Passwort ist falsch.")
}

fn read_auto_hide(conn: &Connection) -> Result<u32, String> {
    Ok(settings::get(conn, AUTO_HIDE_MINUTES_KEY)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0))
}

/// On unless turned off, so a project set up before this option keeps its eye.
fn read_show_indicator(conn: &Connection) -> Result<bool, String> {
    Ok(settings::get(conn, SHOW_INDICATOR_KEY)?.is_none_or(|value| value != "0"))
}

fn write_show_indicator(conn: &Connection, show: bool) -> Result<(), String> {
    settings::set(conn, SHOW_INDICATOR_KEY, if show { "1" } else { "0" })
}

async fn run_blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// What the app needs while running. Carries the combination in the clear
/// because the key listener lives in the frontend; the settings section is
/// what keeps it masked on screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStatus {
    configured: bool,
    revealed: bool,
    shortcut: Option<String>,
    auto_hide_minutes: u32,
    show_indicator: bool,
}

#[tauri::command(async)]
pub fn privacy_get_status(state: tauri::State<AppStateHandle>) -> Result<PrivacyStatus, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    Ok(PrivacyStatus {
        configured: is_configured(&current.conn)?,
        revealed: current.privacy.revealed,
        shortcut: settings::get(&current.conn, SHORTCUT_KEY)?,
        auto_hide_minutes: read_auto_hide(&current.conn)?,
        show_indicator: read_show_indicator(&current.conn)?,
    })
}

/// First setup. Returns the recovery code, which is shown once and never
/// again. Leaves the files showing: nothing has been hidden yet, and the first
/// press of the combination is how the person tries it out.
#[tauri::command]
pub async fn privacy_setup(
    app: AppHandle,
    password: String,
    shortcut: String,
    marker: String,
    scope: String,
    auto_hide_minutes: u32,
    show_indicator: bool,
) -> Result<String, String> {
    run_blocking(move || {
        validate_password(&password)?;
        validate_shortcut(&shortcut)?;
        let marker = validated_marker(&marker)?;
        validate_scope(&scope)?;
        validate_auto_hide(auto_hide_minutes)?;

        let recovery_code = generate_recovery_code();
        let password_hash = hash_secret(&password)?;
        let recovery_hash = hash_secret(&normalized_recovery_code(&recovery_code))?;

        let state = app.state::<AppStateHandle>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;
        if is_configured(&current.conn)? {
            return Err(crate::i18n::tr("Der Privatmodus ist bereits eingerichtet.").to_string());
        }
        let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        settings::set(&tx, PASSWORD_HASH_KEY, &password_hash)?;
        settings::set(&tx, RECOVERY_HASH_KEY, &recovery_hash)?;
        settings::set(&tx, SHORTCUT_KEY, &shortcut)?;
        settings::set(&tx, MARKER_KEY, &marker)?;
        settings::set(&tx, SCOPE_KEY, &scope)?;
        settings::set(&tx, AUTO_HIDE_MINUTES_KEY, &auto_hide_minutes.to_string())?;
        write_show_indicator(&tx, show_indicator)?;
        tx.commit().map_err(|e| e.to_string())?;
        current.privacy.revealed = true;
        Ok(recovery_code)
    })
    .await
}

/// The section's contents, handed over only against the password.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyDetails {
    shortcut: String,
    marker: String,
    scope: String,
    auto_hide_minutes: u32,
    show_indicator: bool,
}

fn read_details(conn: &Connection) -> Result<PrivacyDetails, String> {
    Ok(PrivacyDetails {
        shortcut: settings::get(conn, SHORTCUT_KEY)?.unwrap_or_default(),
        marker: settings::get(conn, MARKER_KEY)?.unwrap_or_default(),
        scope: settings::get(conn, SCOPE_KEY)?.unwrap_or_else(|| DEFAULT_SCOPE.to_string()),
        auto_hide_minutes: read_auto_hide(conn)?,
        show_indicator: read_show_indicator(conn)?,
    })
}

#[tauri::command]
pub async fn privacy_unlock_settings(app: AppHandle, password: String) -> Result<PrivacyDetails, String> {
    run_blocking(move || {
        check_password(&app, &password)?;
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        read_details(&current.conn)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyChanges {
    shortcut: Option<String>,
    marker: Option<String>,
    scope: Option<String>,
    auto_hide_minutes: Option<u32>,
    show_indicator: Option<bool>,
    new_password: Option<String>,
}

/// Every change proves the password again rather than trusting that the
/// section was unlocked earlier, because the frontend is not what should
/// decide that.
#[tauri::command]
pub async fn privacy_update_settings(app: AppHandle, password: String, changes: PrivacyChanges) -> Result<PrivacyDetails, String> {
    run_blocking(move || {
        if let Some(shortcut) = &changes.shortcut {
            validate_shortcut(shortcut)?;
        }
        let marker = changes.marker.as_deref().map(validated_marker).transpose()?;
        if let Some(scope) = &changes.scope {
            validate_scope(scope)?;
        }
        if let Some(minutes) = changes.auto_hide_minutes {
            validate_auto_hide(minutes)?;
        }
        if let Some(new_password) = &changes.new_password {
            validate_password(new_password)?;
        }
        check_password(&app, &password)?;
        let new_hash = changes.new_password.as_deref().map(hash_secret).transpose()?;

        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(shortcut) = &changes.shortcut {
            settings::set(&tx, SHORTCUT_KEY, shortcut)?;
        }
        if let Some(marker) = &marker {
            settings::set(&tx, MARKER_KEY, marker)?;
        }
        if let Some(scope) = &changes.scope {
            settings::set(&tx, SCOPE_KEY, scope)?;
        }
        if let Some(minutes) = changes.auto_hide_minutes {
            settings::set(&tx, AUTO_HIDE_MINUTES_KEY, &minutes.to_string())?;
        }
        if let Some(show) = changes.show_indicator {
            write_show_indicator(&tx, show)?;
        }
        if let Some(new_hash) = &new_hash {
            settings::set(&tx, PASSWORD_HASH_KEY, new_hash)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        read_details(&current.conn)
    })
    .await
}

#[tauri::command]
pub async fn privacy_reveal(app: AppHandle, password: String) -> Result<(), String> {
    run_blocking(move || {
        check_password(&app, &password)?;
        let state = app.state::<AppStateHandle>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;
        current.privacy.revealed = true;
        Ok(())
    })
    .await
}

#[tauri::command(async)]
pub fn privacy_hide(state: tauri::State<AppStateHandle>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;
    current.privacy.revealed = false;
    Ok(())
}

/// Sets a new password with the recovery code. The code is used up by this
/// and replaced by the one returned, which is again shown only once.
#[tauri::command]
pub async fn privacy_reset_password(app: AppHandle, recovery_code: String, new_password: String) -> Result<String, String> {
    run_blocking(move || {
        validate_password(&new_password)?;
        check_secret(
            &app,
            RECOVERY_HASH_KEY,
            &normalized_recovery_code(&recovery_code),
            "Der Wiederherstellungscode ist falsch.",
        )?;

        let next_code = generate_recovery_code();
        let password_hash = hash_secret(&new_password)?;
        let recovery_hash = hash_secret(&normalized_recovery_code(&next_code))?;

        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
        let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        settings::set(&tx, PASSWORD_HASH_KEY, &password_hash)?;
        settings::set(&tx, RECOVERY_HASH_KEY, &recovery_hash)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(next_code)
    })
    .await
}

/// Turns the private mode off for this project. Every file is visible again;
/// the notes themselves are left alone, so setting it up again with the same
/// text brings the same files back under it.
#[tauri::command]
pub async fn privacy_disable(app: AppHandle, password: String) -> Result<(), String> {
    run_blocking(move || {
        check_password(&app, &password)?;
        let state = app.state::<AppStateHandle>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_mut().ok_or(crate::i18n::no_stream_open())?;
        for key in ALL_KEYS {
            current
                .conn
                .execute("DELETE FROM settings WHERE key = ?1", params![key])
                .map_err(|e| e.to_string())?;
        }
        current.privacy = Default::default();
        Ok(())
    })
    .await
}

/// For what is open outside the timeline's own lists when files get hidden:
/// a diary entry being edited should only close if it is one of them.
#[tauri::command(async)]
pub fn privacy_is_hidden(state: tauri::State<AppStateHandle>, id: String) -> Result<bool, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    Ok(hidden_ids(current, Surface::Timeline)?.is_some_and(|hidden| hidden.contains(&id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> CurrentProject {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        for id in ["a", "b", "c"] {
            conn.execute(
                "INSERT INTO items (id, original_filename, stored_path, file_type,
                                    resolved_timestamp, timestamp_source, added_at)
                 VALUES (?1, 'f.jpg', '/p/f.jpg', 'image',
                         '2024-01-01T00:00:00+00:00', 'exif', '2024-01-01T00:00:00+00:00')",
                params![id],
            )
            .unwrap();
        }
        for (id, text) in [("a", "Urlaub #GEHEIM-Ä"), ("b", "Urlaub")] {
            conn.execute(
                "INSERT INTO notes (id, item_id, text, created_at) VALUES (?1, ?1, ?2, '2024-01-01T00:00:00+00:00')",
                params![id, text],
            )
            .unwrap();
        }
        CurrentProject {
            path: "/p".into(),
            conn,
            privacy: Default::default(),
        }
    }

    fn configure(current: &CurrentProject, scope: &str) {
        settings::set(&current.conn, PASSWORD_HASH_KEY, "hash").unwrap();
        settings::set(&current.conn, MARKER_KEY, "#geheim-ä").unwrap();
        settings::set(&current.conn, SCOPE_KEY, scope).unwrap();
    }

    #[test]
    fn without_setup_nothing_is_hidden() {
        let current = project();
        assert!(hidden_ids(&current, Surface::Timeline).unwrap().is_none());
    }

    #[test]
    fn the_marker_matches_inside_a_note_regardless_of_case_including_umlauts() {
        let current = project();
        configure(&current, SCOPE_VIEWS);
        let hidden = hidden_ids(&current, Surface::Timeline).unwrap().unwrap();
        assert_eq!(hidden, HashSet::from(["a".to_string()]));
    }

    #[test]
    fn showing_the_files_lifts_the_filter() {
        let mut current = project();
        configure(&current, SCOPE_EVERYWHERE);
        current.privacy.revealed = true;
        assert!(hidden_ids(&current, Surface::Timeline).unwrap().is_none());
        assert!(!note_hides_item(&current, "#geheim-ä").unwrap());
    }

    #[test]
    fn each_scope_reaches_exactly_its_surfaces() {
        let reaches = |scope: &str, surface: Surface| {
            let current = project();
            configure(&current, scope);
            hidden_ids(&current, surface).unwrap().is_some()
        };
        assert!(reaches(SCOPE_TIMELINE, Surface::Timeline));
        assert!(!reaches(SCOPE_TIMELINE, Surface::Views));
        assert!(reaches(SCOPE_VIEWS, Surface::Views));
        assert!(!reaches(SCOPE_VIEWS, Surface::Everywhere));
        assert!(reaches(SCOPE_EVERYWHERE, Surface::Everywhere));
    }

    #[test]
    fn a_written_note_is_recognised_as_hiding_its_file() {
        let current = project();
        configure(&current, SCOPE_TIMELINE);
        assert!(note_hides_item(&current, "jetzt #Geheim-Ä").unwrap());
        assert!(!note_hides_item(&current, "harmlos").unwrap());
    }

    #[test]
    fn the_indicator_shows_until_turned_off() {
        let current = project();
        assert!(read_show_indicator(&current.conn).unwrap());
        write_show_indicator(&current.conn, false).unwrap();
        assert!(!read_show_indicator(&current.conn).unwrap());
        write_show_indicator(&current.conn, true).unwrap();
        assert!(read_show_indicator(&current.conn).unwrap());
    }

    #[test]
    fn a_secret_only_matches_its_own_hash() {
        let hash = hash_secret("richtig").unwrap();
        assert!(secret_matches(&hash, "richtig"));
        assert!(!secret_matches(&hash, "falsch"));
    }

    #[test]
    fn a_recovery_code_counts_however_it_was_typed() {
        let code = generate_recovery_code();
        assert_eq!(code.len(), 19);
        let hash = hash_secret(&normalized_recovery_code(&code)).unwrap();
        let typed = code.to_lowercase().replace('-', " ");
        assert!(secret_matches(&hash, &normalized_recovery_code(&typed)));
    }

    #[test]
    fn a_combination_needs_a_command_modifier_and_a_key() {
        assert!(validate_shortcut("Ctrl+Shift+P").is_ok());
        assert!(validate_shortcut("Alt+F9").is_ok());
        assert!(validate_shortcut("Shift+P").is_err());
        assert!(validate_shortcut("P").is_err());
        assert!(validate_shortcut("Ctrl+").is_err());
    }
}
