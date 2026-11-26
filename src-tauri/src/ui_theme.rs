//! Backend half of the UI theme (the frontend's is `src/theme.ts`).
//!
//! The choice itself lives in the webview's localStorage, which Rust can't
//! read. The backend needs it for what the page can't paint itself: the
//! main window's background before the page has painted (otherwise a light
//! setup opens on a flash of the dark default), and the app icon in the
//! taskbar, the tray and the start menu entry. The frontend reports it at
//! startup and on every switch, and it is kept in a file so the next start
//! — including the drop box alone at login — can use it before any page
//! has loaded.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::window::Color;
use tauri::Manager;

/// The two `--cs-bg` values in App.css.
const DARK_BG: Color = Color(0x0a, 0x0a, 0x0e, 0xff);
const LIGHT_BG: Color = Color(0xf2, 0xec, 0xe0, 0xff);

/// The app icon: dark tile, or the same tile with a cream inside.
pub const DARK_ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
pub const LIGHT_ICON: &[u8] = include_bytes!("../icons/light/128x128@2x.png");
const DARK_TRAY_ICON: &[u8] = include_bytes!("../icons/128x128.png");
const LIGHT_TRAY_ICON: &[u8] = include_bytes!("../icons/light/128x128.png");

static LIGHT: AtomicBool = AtomicBool::new(false);

fn theme_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("ui_theme.txt"))
}

/// Loads the theme last reported. Dark when there is none yet (first start).
pub fn init(app: &tauri::AppHandle) {
    let saved = theme_file(app).and_then(|path| std::fs::read_to_string(path).ok());
    LIGHT.store(saved.as_deref().map(str::trim) == Some("light"), Ordering::Relaxed);
}

pub fn is_light() -> bool {
    LIGHT.load(Ordering::Relaxed)
}

/// Background for a main window about to be built.
pub fn window_background() -> Color {
    if is_light() {
        LIGHT_BG
    } else {
        DARK_BG
    }
}

/// The tray icon as PNG bytes, for the Linux tray's own pixmap.
pub fn tray_png() -> &'static [u8] {
    if is_light() {
        LIGHT_TRAY_ICON
    } else {
        DARK_TRAY_ICON
    }
}

fn decode(png: &[u8]) -> Option<tauri::image::Image<'static>> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let (width, height) = (img.width(), img.height());
    Some(tauri::image::Image::new_owned(img.into_rgba8().into_vec(), width, height))
}

/// The tray icon for Tauri's own tray (Windows, macOS).
#[cfg(not(target_os = "linux"))]
pub fn tray_icon() -> Option<tauri::image::Image<'static>> {
    decode(tray_png())
}

/// The taskbar icon for a window about to be built or switched.
pub fn window_icon() -> Option<tauri::image::Image<'static>> {
    decode(if is_light() { LIGHT_ICON } else { DARK_ICON })
}

#[tauri::command(async)]
pub fn set_ui_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    if theme != "light" && theme != "dark" {
        return Err(format!("unknown theme: {theme}"));
    }
    let light = theme == "light";
    let changed = LIGHT.swap(light, Ordering::Relaxed) != light;
    // Saved first: the next start reads the theme from here, and nothing
    // below may keep it from being written.
    let path = theme_file(&app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, theme).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window(crate::MAIN_LABEL) {
        // Right now too, so a resize or a slow repaint doesn't show the old one.
        let _ = window.set_background_color(Some(window_background()));
        if let Some(icon) = window_icon() {
            let _ = window.set_icon(icon);
        }
    }
    if changed {
        // On a thread of its own: this command runs inside Tauri's async
        // runtime, and ksni's blocking handle panics when it starts its own
        // there, so the tray kept the old icon and the theme was never saved.
        #[cfg(target_os = "linux")]
        std::thread::spawn(crate::linux_tray::refresh);
        #[cfg(not(target_os = "linux"))]
        if let (Some(tray), Some(icon)) = (app.tray_by_id(crate::TRAY_ID), tray_icon()) {
            let _ = tray.set_icon(Some(icon));
        }
    }
    // Cinnamon and most Linux taskbars take the icon from the start menu
    // entry the window matches, not from the window itself.
    crate::desktop_integration::refresh_icon(&app);
    Ok(())
}
