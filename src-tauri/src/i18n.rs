//! Backend half of the UI language (the frontend's is `src/i18n.ts`).
//!
//! Messages are written in German right where they are raised and that
//! German text doubles as the lookup key (gettext style), so a call site
//! still reads as the message it shows and can be found by searching for
//! the text the user saw. English and Spanish live in `i18n_messages.rs`.
//! A message missing there falls back to the German original rather than
//! to an empty string or a raw key.
//!
//! The frontend reports the language via `set_ui_language` at startup and
//! on every switch. Until then — and in the CLI tools under `src/bin`,
//! which never call it — everything stays German.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use tauri::Manager;

const DE: u8 = 0;
const EN: u8 = 1;
const ES: u8 = 2;

static LANGUAGE: AtomicU8 = AtomicU8::new(DE);

/// 0 German, 1 English, 2 Spanish: the order of `i18n_messages::MESSAGES`
/// and of other three-language lists.
pub(crate) fn language_index() -> usize {
    LANGUAGE.load(Ordering::Relaxed) as usize
}

#[tauri::command]
pub fn set_ui_language(app: tauri::AppHandle, language: String) {
    let code = match language.as_str() {
        "en" => EN,
        "es" => ES,
        _ => DE,
    };
    LANGUAGE.store(code, Ordering::Relaxed);
    // The one piece of UI text the backend owns: the drop box's title bar.
    if let Some(window) = app.get_webview_window(crate::DROPZONE_LABEL) {
        let _ = window.set_title(tr(crate::DROPZONE_TITLE));
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(tray) = app.tray_by_id(crate::TRAY_ID) {
        if let Ok(menu) = crate::tray_menu(&app) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_tooltip(Some(tr(crate::DROPZONE_TITLE)));
    }
    #[cfg(target_os = "linux")]
    crate::linux_tray::refresh();
}

/// The operating system's UI language as "de"/"en"/"es", or `None` when it
/// is none of those. Read from the OS itself rather than the WebView's
/// `navigator.language`, whose value differs between WebKitGTK and WebView2.
#[tauri::command]
pub fn system_language() -> Option<String> {
    let locale = sys_locale::get_locale()?;
    let code = locale.get(..2)?.to_ascii_lowercase();
    matches!(code.as_str(), "de" | "en" | "es").then_some(code)
}

fn table() -> &'static HashMap<&'static str, (&'static str, &'static str)> {
    static TABLE: OnceLock<HashMap<&'static str, (&'static str, &'static str)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        crate::i18n_messages::MESSAGES
            .iter()
            .map(|&(de, en, es)| (de, (en, es)))
            .collect()
    })
}

/// The message `de` in the current UI language.
/// The refusal every command gives when no stream is open — one place
/// instead of the same literal in every command.
pub fn no_stream_open() -> &'static str {
    tr("Kein Stream geöffnet")
}

pub fn tr(de: &'static str) -> &'static str {
    match LANGUAGE.load(Ordering::Relaxed) {
        DE => de,
        language => match table().get(de) {
            Some(&(en, es)) => {
                if language == EN {
                    en
                } else {
                    es
                }
            }
            None => de,
        },
    }
}

/// `format!` for a translated message: `trf!("Konnte {what} nicht lesen: {e}", what = name, e = e)`.
/// Placeholders are named and filled after the lookup, because the word
/// order differs between languages and a positional `{}` could not follow.
#[macro_export]
macro_rules! trf {
    ($de:literal $(, $name:ident = $value:expr)* $(,)?) => {{
        #[allow(unused_mut)]
        let mut message = $crate::i18n::tr($de).to_string();
        $(
            message = message.replace(concat!("{", stringify!($name), "}"), &($value).to_string());
        )*
        message
    }};
}
