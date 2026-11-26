mod action_log;
mod adpcm_wav;
mod archive_check;
mod action_log_commands;
mod ai_metadata;
mod app_settings;
mod backup;
mod browse_commands;
mod capture;
mod cluster_tree;
#[cfg(target_os = "linux")]
mod linux_drag;
mod commands;
mod copy_task;
mod debug_log;
mod delete_commands;
mod diary;
mod disk_search;
mod disk_search_index;
mod dropped_files;
mod doc_card;
mod doc_text;
mod duplicate_commands;
mod duplicate_hash;
mod file_ops_commands;
pub mod email;
pub mod exif_date;
pub mod filename_date;
mod ffmpeg_tool;
mod former_name;
mod fsbrowse;
mod i18n;
mod i18n_messages;
mod items;
pub mod lock;
mod media_date;
mod media_server;
mod playback_compat;
#[cfg(any(windows, target_os = "macos"))]
mod native_thumb;
pub mod pdf_preview;
mod desktop_integration;
mod pending_drops;
mod phase_commands;
mod phases;
pub mod preview;
mod preview_cache;
mod print_export;
mod privacy;
mod progress;
mod project;
mod project_files;
mod quick_access;
mod recent;
mod relocation;
mod record_commands;
mod review_commands;
mod safe_io;
mod schema;
mod search_history;
mod settings;
mod similar_images;
mod state;
mod timeline_commands;
mod transfer_commands;
mod ui_theme;
mod update_check;
mod uninstall;
mod video_preview;
mod video_regen_commands;
mod watch_folder;
mod windows_links;
#[cfg(windows)]
mod win_drop;

use std::sync::atomic::{AtomicBool, Ordering};

use state::AppStateHandle;
use std::ffi::OsStr;
use tauri::{Emitter, Manager};

/// Window label of the small always-on-top drag & drop window. It renders
/// the same `index.html` as the main window — `main.tsx` branches on this
/// label and mounts `<DropZone />` instead of `<App />`, so there's no
/// second Vite entry point to keep in sync.
pub(crate) const DROPZONE_LABEL: &str = "dropzone";

/// Its title bar text, translated via `i18n::tr` — at build time here and
/// again by `set_ui_language` on every switch, since the window is created
/// hidden at startup, before the frontend has reported the language.
pub(crate) const DROPZONE_TITLE: &str = "CronoStream – Ablage";

/// Label of the main window, which comes from `tauri.conf.json`. It has
/// `"create": false` there because a start with `DROPZONE_ARG` doesn't open
/// it at all; see `show_main_window`.
const MAIN_LABEL: &str = "main";

/// Start argument for running only the drop box, as a circle (the start menu
/// and autostart entries from `desktop_integration.rs` use it).
pub(crate) const DROPZONE_ARG: &str = "--ablage";

/// Mirrored by `FULL_SIZE` and `MINI_DIAMETER` in DropZone.tsx.
const DROPZONE_SIZE: (f64, f64) = (260.0, 380.0);
const DROPZONE_MINI_DIAMETER: f64 = 104.0;

/// Tray icon that stands for the drop box while its window is gone.
#[cfg(not(target_os = "linux"))]
pub(crate) const TRAY_ID: &str = "dropzone";
#[cfg(not(target_os = "linux"))]
const TRAY_OPEN: &str = "tray-open";
#[cfg(not(target_os = "linux"))]
const TRAY_QUIT: &str = "tray-quit";

/// Set once the tray icon exists. From then on the drop box window is
/// destroyed rather than kept around when put away (so its webview's memory
/// is freed), and closing the last window no longer ends the process.
static TRAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Also rebuilt by `set_ui_language`, since the process may start before the
/// language is known.
#[cfg(not(target_os = "linux"))]
pub(crate) fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let open = MenuItem::with_id(app, TRAY_OPEN, i18n::tr("Ablage öffnen"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, i18n::tr("Beenden"), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

/// Opens the circle from the tray on a thread of its own: building a window
/// inside a tray event handler can deadlock on Windows.
fn open_circle_from_tray(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = show_dropzone_circle(&app);
    });
}

/// Left click opens the circle directly.
#[cfg(not(target_os = "linux"))]
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(false)
        .tooltip(i18n::tr(DROPZONE_TITLE))
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => open_circle_from_tray(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_circle_from_tray(tray.app_handle());
            }
        });
    if let Some(icon) = ui_theme::tray_icon() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Linux tray: a StatusNotifierItem of our own, because the AppIndicator
/// behind Tauri's tray never reports a left click (it always opens the menu).
#[cfg(target_os = "linux")]
mod linux_tray {
    use std::sync::OnceLock;

    use ksni::blocking::{Handle, TrayMethods};

    use crate::i18n;

    pub(crate) struct DropTray {
        app: tauri::AppHandle,
    }

    static HANDLE: OnceLock<Handle<DropTray>> = OnceLock::new();

    impl ksni::Tray for DropTray {
        fn id(&self) -> String {
            "com.felixheck.cronostream.ablage".into()
        }

        fn title(&self) -> String {
            i18n::tr(crate::DROPZONE_TITLE).into()
        }

        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let Ok(img) = image::load_from_memory_with_format(crate::ui_theme::tray_png(), image::ImageFormat::Png)
            else {
                return Vec::new();
            };
            let (width, height) = (img.width() as i32, img.height() as i32);
            let mut data = img.into_rgba8().into_vec();
            for pixel in data.chunks_exact_mut(4) {
                pixel.rotate_right(1); // RGBA -> ARGB
            }
            vec![ksni::Icon { width, height, data }]
        }

        fn activate(&mut self, _x: i32, _y: i32) {
            crate::open_circle_from_tray(&self.app);
        }

        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::StandardItem;
            vec![
                StandardItem {
                    label: i18n::tr("Ablage öffnen").into(),
                    activate: Box::new(|tray: &mut Self| crate::open_circle_from_tray(&tray.app)),
                    ..Default::default()
                }
                .into(),
                StandardItem {
                    label: i18n::tr("Beenden").into(),
                    activate: Box::new(|tray: &mut Self| tray.app.exit(0)),
                    ..Default::default()
                }
                .into(),
            ]
        }
    }

    pub(crate) fn build(app: &tauri::AppHandle) -> Result<(), String> {
        let handle = DropTray { app: app.clone() }.spawn().map_err(|e| e.to_string())?;
        let _ = HANDLE.set(handle);
        Ok(())
    }

    /// Re-reads title, menu and icon after a language or theme switch.
    pub(crate) fn refresh() {
        if let Some(handle) = HANDLE.get() {
            handle.update(|_| {});
        }
    }
}

#[cfg(target_os = "linux")]
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    linux_tray::build(app)
}

/// Builds the tray icon unless it exists already. False if it can't be
/// built; a missing AppIndicator library panics instead of returning an
/// error.
fn ensure_tray(app: &tauri::AppHandle) -> bool {
    static BUILDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = BUILDING.lock().unwrap_or_else(|e| e.into_inner());
    if TRAY_ACTIVE.load(Ordering::SeqCst) {
        return true;
    }
    let built = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_tray(app))) {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            eprintln!("Ablage: Tray-Icon nicht erstellt: {e}");
            false
        }
        Err(_) => {
            eprintln!("Ablage: Tray-Icon nicht erstellt (AppIndicator-Bibliothek fehlt?)");
            false
        }
    };
    if built {
        TRAY_ACTIVE.store(true, Ordering::SeqCst);
    }
    built
}

/// Creates the mini window. Called once at startup (hidden) and again as a
/// fallback from `show_dropzone_window` if the window no longer exists —
/// so "open the drop box" can never dead-end with nothing happening.
fn build_dropzone_window(
    app: &tauri::AppHandle,
    start_mini: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let (width, height) = if start_mini {
        (DROPZONE_MINI_DIAMETER, DROPZONE_MINI_DIAMETER)
    } else {
        DROPZONE_SIZE
    };
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        DROPZONE_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(i18n::tr(DROPZONE_TITLE))
    .inner_size(width, height)
    // Fixed size via min = max instead of `.resizable(false)`: GTK pins a
    // non-resizable window to its default size, so it could never shrink to
    // the minimised circle (DropZone.tsx).
    .min_inner_size(width, height)
    .max_inner_size(width, height)
    .always_on_top(true)
    // No system title bar: the window's own top bar already shows the
    // title, the count and a close button, and doubles as the drag handle
    // (`data-tauri-drag-region` in DropZone.tsx).
    .decorations(false)
    // Transparent so the minimised circle (DropZone.tsx) has no square
    // backdrop; the normal view fills the whole window opaquely.
    .transparent(true)
    // Windows draws a shadow around an undecorated window by default, and
    // with it a 1px white frame (rounded on Windows 11): the square that
    // showed around the circle. No effect on Linux.
    .shadow(false)
    .visible(false)
    .skip_taskbar(true);
    if start_mini {
        builder = builder.initialization_script("window.__CS_DROPZONE_START_MINI__ = true;");
    }
    builder.build()
}

fn dropzone_position_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("dropzone_position.txt"))
}

/// Debounced by the window itself, since it moves many times per drag.
#[tauri::command(async)]
fn save_dropzone_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let path = dropzone_position_file(&app).ok_or("no config directory")?;
    std::fs::write(path, format!("{x} {y}")).map_err(|e| e.to_string())
}

/// Puts the window back where it was last left, unless that spot is on no
/// screen any more (a monitor that has since been unplugged), and then
/// wholly onto the screen (`fit_on_screen`).
fn restore_dropzone_position(window: &tauri::WebviewWindow) {
    let saved = dropzone_position_file(window.app_handle())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|saved| {
            let mut parts = saved.split_whitespace().map(str::parse::<i32>);
            match (parts.next(), parts.next()) {
                (Some(Ok(x)), Some(Ok(y))) => Some(tauri::PhysicalPosition::new(x, y)),
                _ => None,
            }
        })
        .filter(|pos| monitor_at(window, *pos).is_some());
    fit_on_screen(window, saved, None);
}

fn monitor_at(window: &tauri::WebviewWindow, pos: tauri::PhysicalPosition<i32>) -> Option<tauri::Monitor> {
    window.available_monitors().ok()?.into_iter().find(|monitor| {
        let (origin, size) = (monitor.position(), monitor.size());
        (origin.x..origin.x + size.width as i32).contains(&pos.x)
            && (origin.y..origin.y + size.height as i32).contains(&pos.y)
    })
}

/// Moves the window just far enough to lie wholly inside the work area of
/// its screen (without the taskbar). Only the top-left corner is saved, so
/// a circle left at the right edge would otherwise open the full view,
/// which is wider, cut off past the edge; small screens made that common.
/// `pos` is where the window is being put, if that is new: GTK moves and
/// resizes asynchronously, so the window's own figures can still be the
/// old ones. `logical_size` likewise is the size it is about to get.
fn fit_on_screen(
    window: &tauri::WebviewWindow,
    pos: Option<tauri::PhysicalPosition<i32>>,
    logical_size: Option<(f64, f64)>,
) {
    let Some(pos) = pos.or_else(|| window.outer_position().ok()) else { return };
    let (width, height) = match logical_size {
        Some((w, h)) => {
            let scale = window.scale_factor().unwrap_or(1.0);
            ((w * scale).round() as i32, (h * scale).round() as i32)
        }
        None => match window.outer_size() {
            Ok(size) => (size.width as i32, size.height as i32),
            Err(_) => return,
        },
    };
    let monitor = monitor_at(window, pos)
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let target = match monitor {
        Some(monitor) => {
            let area = monitor.work_area();
            let (left, top) = (area.position.x, area.position.y);
            let right = left + area.size.width as i32;
            let bottom = top + area.size.height as i32;
            tauri::PhysicalPosition::new(
                pos.x.min(right - width).max(left),
                pos.y.min(bottom - height).max(top),
            )
        }
        None => pos,
    };
    let moved_by_us = pos != window.outer_position().unwrap_or(pos);
    if target != pos || moved_by_us {
        let _ = window.set_position(target);
    }
}

/// Called by DropZone.tsx after each switch between circle and full view,
/// with the new size: the circle grows to the right and downwards.
#[tauri::command(async)]
fn fit_dropzone_on_screen(window: tauri::WebviewWindow, width: f64, height: f64) {
    if window.label() == DROPZONE_LABEL {
        fit_on_screen(&window, None, Some((width, height)));
    }
}

fn present_dropzone(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    restore_dropzone_position(window);
    let _ = window.set_focus();
}

/// Opens the mini window from the 📥 button in the main window.
///
/// Deliberately a command rather than `WebviewWindow.getByLabel(...).show()`
/// in JS: that would mean granting the main window `core:window:allow-show`
/// + `allow-set-focus`, and it couldn't recreate a missing window.
#[tauri::command(async)]
fn show_dropzone_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(DROPZONE_LABEL) {
        Some(window) => window,
        None => build_dropzone_window(&app, false).map_err(|e| e.to_string())?,
    };
    present_dropzone(&window);
    Ok(())
}

/// What a start with `DROPZONE_ARG` opens, whether as this process's first
/// window or forwarded from a second start (`tauri_plugin_single_instance`).
fn show_dropzone_circle(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(DROPZONE_LABEL) {
        Some(window) => {
            let _ = window.emit("dropzone-set-mini", true);
            window
        }
        None => build_dropzone_window(app, true)?,
    };
    present_dropzone(&window);
    Ok(())
}

/// Opens the main window, creating it if this process was started for the
/// drop box alone or the window has been closed since.
fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .background_color(ui_theme::window_background());
    if let Some(icon) = ui_theme::window_icon() {
        builder = builder.icon(icon)?;
    }
    builder.build()?;
    Ok(())
}

/// Puts the drop box away. With no main window left, it was the last thing
/// the user could see of the app, so the process goes with it instead of
/// lingering invisibly.
fn close_dropzone(app: &tauri::AppHandle) {
    if app.get_webview_window(MAIN_LABEL).is_none() && TRAY_ACTIVE.load(Ordering::SeqCst) {
        minimize_dropzone_to_tray(app);
        return;
    }
    if let Some(window) = app.get_webview_window(DROPZONE_LABEL) {
        let _ = window.hide();
    }
    if app.get_webview_window(MAIN_LABEL).is_none() {
        app.exit(0);
    }
}

/// Destroys the window (and its webview) so only the tray icon, and the few
/// MB of the Rust process, remain.
fn minimize_dropzone_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(DROPZONE_LABEL) {
        let _ = window.destroy();
    }
}

/// Right click on the circle. Builds the tray icon first if the drop box was
/// opened from the main window; does nothing if that fails, since the drop
/// box would then be unreachable. On the main thread: tray icons outside
/// Linux have to be built there.
#[tauri::command(async)]
fn minimize_dropzone(app: tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if ensure_tray(&handle) {
            minimize_dropzone_to_tray(&handle);
        }
    });
}

#[tauri::command(async)]
fn close_dropzone_window(app: tauri::AppHandle) {
    close_dropzone(&app);
}

/// Turns off WebKitGTK's DMA-BUF renderer, unless the variable is already
/// set (so `WEBKIT_DISABLE_DMABUF_RENDERER=0` brings it back for a
/// comparison). With it, hardware-decoded video (VA-API on Intel) is handed
/// to the compositor as shared GPU buffers, and when compositing a frame
/// takes long — a large project's timeline behind the viewer — the decoder
/// recycles a buffer that is still on screen: the picture flickers and jumps
/// back and forth every few seconds while VLC plays the same file cleanly.
/// The fallback path copies frames instead and has no such race; page
/// compositing stays GPU-accelerated either way.
///
/// Must run before anything creates the webview (or spawns threads that
/// might read the environment), hence first thing in `run`.
#[cfg(target_os = "linux")]
fn configure_webkit_env() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_none() {
        std::env::set_var(VAR, "1");
    }
}

/// Whether to run through XWayland rather than as a native Wayland client:
/// on a Wayland session, unless the user chose a backend themselves, and only
/// if an X server is actually there, because GTK can't start otherwise.
fn should_force_x11(
    gdk_backend: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    display: Option<&OsStr>,
) -> bool {
    let is_set = |value: Option<&OsStr>| value.is_some_and(|v| !v.is_empty());
    gdk_backend.is_none() && is_set(wayland_display) && is_set(display)
}

/// Wayland doesn't let a client place its own window or keep it on top, and
/// the drop box circle needs both (it stays over other windows and comes back
/// where it was left). It's one process, so the main window comes along: under
/// fractional scaling it may look slightly softer than a native one.
///
/// Must run before GTK starts, for the same reason as `configure_webkit_env`.
#[cfg(target_os = "linux")]
fn configure_display_backend() {
    const VAR: &str = "GDK_BACKEND";
    let (backend, wayland, display) = (
        std::env::var_os(VAR),
        std::env::var_os("WAYLAND_DISPLAY"),
        std::env::var_os("DISPLAY"),
    );
    if should_force_x11(backend.as_deref(), wayland.as_deref(), display.as_deref()) {
        std::env::set_var(VAR, "x11");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        configure_webkit_env();
        configure_display_backend();
    }
    former_name::adopt_app_folders();

    tauri::Builder::default()
        // Has to be the first plugin. One process serves both windows: the
        // change event that keeps the drop box and the main window's waiting
        // list in step doesn't cross processes.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = if argv.iter().any(|arg| arg == DROPZONE_ARG) {
                show_dropzone_circle(app)
            } else {
                show_main_window(app)
            };
            if argv.iter().any(|arg| arg == uninstall::UNINSTALL_ARG) {
                uninstall::request(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .manage(AppStateHandle::default())
        .manage(copy_task::CopyTasks::default())
        .manage(disk_search::DiskSearchTasks::default())
        .manage(browse_commands::ListingTasks::default())
        .manage(media_server::start())
        .setup(|app| {
            // Before any window or tray icon is built: they take its colours.
            ui_theme::init(app.handle());
            let cache_dir = app.path().app_config_dir()?;
            let cache_conn = preview_cache::open(&cache_dir)?;
            // `manage()` is first-wins: a later call for an already-managed
            // *exact Rust type* silently no-ops instead of erroring, which
            // is exactly how a bare `type X = Mutex<Connection>` alias
            // collision between two sidecar DB handles went unnoticed
            // during development (both resolved to this first instance).
            // Asserting the return value turns a future repeat of that
            // mistake into an immediate panic instead of a silently wrong
            // database connection.
            assert!(
                app.manage::<preview_cache::PreviewCacheHandle>(std::sync::Mutex::new(cache_conn)),
                "PreviewCacheHandle was already managed"
            );

            let drops_conn = pending_drops::open(&cache_dir)?;
            assert!(
                app.manage(pending_drops::PendingDropsHandle(std::sync::Mutex::new(drops_conn))),
                "PendingDropsHandle was already managed"
            );
            watch_folder::start(app.handle().clone());
            {
                // Off the startup path: it lists a folder and may delete some.
                let app = app.handle().clone();
                std::thread::spawn(move || pending_drops::sweep_dropped_files(&app));
            }

            let disk_search_index_conn = disk_search_index::open(&cache_dir)?;
            assert!(
                app.manage(disk_search_index::DiskSearchIndexHandle(std::sync::Mutex::new(disk_search_index_conn))),
                "DiskSearchIndexHandle was already managed"
            );

            // The bundled PDFium library (see pdf_preview.rs).
            if let Ok(resources) = app.path().resource_dir() {
                pdf_preview::set_library_dir(resources.join("pdfium"));
            }

            desktop_integration::refresh(app.handle());
            // The main window opens as for a plain start (below) and shows
            // the dialog once its frontend asks (`take_uninstall_request`).
            if std::env::args().any(|arg| arg == uninstall::UNINSTALL_ARG) {
                uninstall::request(app.handle());
            }

            if std::env::args().any(|arg| arg == DROPZONE_ARG) {
                // Without a tray icon the circle would have nowhere to go,
                // so it is shown as before.
                if ensure_tray(app.handle()) {
                    eprintln!("Ablage: Tray-Icon erstellt, kein Fenster offen");
                } else {
                    show_dropzone_circle(app.handle())?;
                }
            } else {
                show_main_window(app.handle())?;
                // Built up front (hidden) rather than on demand, so the
                // webview is already warm the first time the user opens it.
                build_dropzone_window(app.handle(), false)?;
            }

            Ok(())
        })
        // Windows: classic Outlook drags mails as virtual files, which the
        // webview's own drop handling ignores (win_drop.rs). Its drop target
        // is put in place once a page has loaded, when the webview's own one
        // exists and can be replaced.
        .on_page_load(|_webview, _payload| {
            #[cfg(windows)]
            if matches!(_payload.event(), tauri::webview::PageLoadEvent::Finished) {
                win_drop::install(_webview);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == DROPZONE_LABEL {
                    // Hidden rather than closed: it is reopened from inside
                    // the app, and keeping the webview alive makes that
                    // instant.
                    api.prevent_close();
                    close_dropzone(app);
                } else {
                    let dropzone_open = app
                        .get_webview_window(DROPZONE_LABEL)
                        .is_some_and(|dropzone| dropzone.is_visible().unwrap_or(false));
                    let in_tray = TRAY_ACTIVE.load(Ordering::SeqCst);
                    if dropzone_open || in_tray {
                        // The drop box stays and the process with it, but the
                        // project must be let go of now. On a thread for the
                        // reason given at `ExitRequested` below.
                        if !dropzone_open {
                            // Back to just the tray icon, as after the start
                            // with `DROPZONE_ARG`.
                            minimize_dropzone_to_tray(app);
                        }
                        let app = app.clone();
                        std::thread::spawn(move || shut_down(&app));
                    } else {
                        // Has to be said explicitly: Tauri only auto-exits
                        // once *all* windows are gone, and the hidden dropzone
                        // window would otherwise keep the process alive
                        // invisibly. Going through `exit` also keeps the
                        // `ExitRequested` handler below (and with it the
                        // project lock release) on the path.
                        app.exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "linux")]
            linux_drag::start_file_drag,
            commands::list_recent_projects,
            relocation::check_project_relocation,
            archive_check::check_archive,
            archive_check::regenerate_thumbnails,
            backup::check_backup_update,
            backup::start_backup_update,
            similar_images::scan_similar_images,
            relocation::relocate_project_paths,
            i18n::set_ui_language,
            i18n::system_language,
            ui_theme::set_ui_theme,
            update_check::check_for_update,
            diary::save_diary_entry,
            diary::get_diary_attachments,
            diary::stage_clipboard_image,
            commands::count_project_items,
            commands::remove_recent_project,
            commands::set_default_project,
            commands::create_project,
            commands::precheck_open_project,
            commands::open_project,
            commands::close_current_project,
            browse_commands::list_directory,
            browse_commands::list_directory_streamed,
            browse_commands::cancel_list_directory,
            browse_commands::get_file_preview,
            browse_commands::get_email_text_preview,
            browse_commands::get_email_headers,
            browse_commands::get_document_text_preview,
            browse_commands::add_items,
            browse_commands::list_added_source_paths,
            browse_commands::get_reveal_targets,
            browse_commands::reveal_in_folder,
            browse_commands::open_path_checked,
            browse_commands::rotate_path,
            browse_commands::check_pending_duplicates,
            browse_commands::count_live_items,
            browse_commands::project_disk_usage,
            cluster_tree::build_cluster_trees,
            quick_access::list_quick_access,
            record_commands::name_recording,
            record_commands::discard_recording,
            capture::list_capture_devices,
            capture::capture_open,
            capture::capture_record,
            capture::capture_pause,
            capture::capture_stop,
            capture::capture_close,
            ffmpeg_tool::ffmpeg_status,
            ffmpeg_tool::install_ffmpeg,
            review_commands::get_date_candidates,
            review_commands::get_media_dates,
            review_commands::import_paths_from_manifest,
            review_commands::add_items_with_dates,
            review_commands::get_full_image_preview,
            timeline_commands::list_items,
            timeline_commands::update_display_name,
            timeline_commands::update_note,
            timeline_commands::update_timestamp,
            timeline_commands::update_timestamps_batch,
            timeline_commands::remove_item,
            timeline_commands::rotate_item,
            timeline_commands::remove_items_by_source_paths,
            timeline_commands::get_item_text,
            timeline_commands::get_item_email_html,
            timeline_commands::get_item_email_recipients,
            timeline_commands::get_item_email_attachments,
            timeline_commands::extract_item_email_attachment,
            timeline_commands::search_items,
            search_history::list_search_history,
            search_history::add_search_history,
            search_history::remove_search_history,
            search_history::clear_search_history,
            action_log_commands::list_action_log,
            action_log_commands::list_action_entries,
            action_log_commands::undo_entry,
            action_log_commands::undo_action,
            action_log_commands::purge_items,
            action_log_commands::set_project_setting,
            action_log_commands::set_setting_scope,
            phase_commands::list_phase_groups,
            phase_commands::get_phase_palette,
            phase_commands::create_phase_group,
            phase_commands::update_phase_group,
            phase_commands::move_phase_group,
            phase_commands::remove_phase_group,
            phase_commands::set_phase_group_visibility,
            phase_commands::create_phase,
            phase_commands::update_phase,
            phase_commands::remove_phase,
            phase_commands::set_phase_visibility,
            file_ops_commands::list_project_years,
            file_ops_commands::list_project_files,
            file_ops_commands::remove_project_items,
            file_ops_commands::restore_project_items,
            file_ops_commands::delete_item_files_only,
            file_ops_commands::purge_items_and_log,
            file_ops_commands::copy_project_items_to_folder,
            file_ops_commands::find_replacement_matches,
            file_ops_commands::replace_project_items,
            file_ops_commands::write_text_file,
            file_ops_commands::add_note_to_items,
            file_ops_commands::rotate_items,
            transfer_commands::list_transfer_targets,
            transfer_commands::create_transfer_target,
            transfer_commands::transfer_items,
            transfer_commands::preview_transfer_duplicates,
            delete_commands::inspect_stream_deletion,
            delete_commands::delete_stream,
            delete_commands::list_deleted_streams,
            delete_commands::restore_stream,
            delete_commands::discard_deleted_stream,
            action_log_commands::get_project_settings,
            video_regen_commands::regenerate_video_thumbnails,
            privacy::privacy_get_status,
            privacy::privacy_setup,
            privacy::privacy_unlock_settings,
            privacy::privacy_update_settings,
            privacy::privacy_reveal,
            privacy::privacy_hide,
            privacy::privacy_reset_password,
            privacy::privacy_disable,
            privacy::privacy_is_hidden,
            print_export::list_print_candidates,
            print_export::set_print_selection,
            print_export::get_print_export_target,
            print_export::clear_print_export_history,
            print_export::run_print_export,
            ai_metadata::export_ai_metadata,
            ai_metadata::build_ai_metadata_export_text,
            ai_metadata::parse_ai_metadata_import,
            ai_metadata::parse_ai_metadata_text,
            ai_metadata::apply_ai_metadata_suggestions,
            media_server::get_media_server_info,
            playback_compat::prepare_playback_copy,
            backup::start_backup,
            duplicate_commands::start_duplicate_project,
            duplicate_commands::cancel_copy_task,
            duplicate_commands::rename_project,
            debug_log::debug_log,
            show_dropzone_window,
            close_dropzone_window,
            minimize_dropzone,
            fit_dropzone_on_screen,
            save_dropzone_position,
            desktop_integration::get_desktop_integration,
            desktop_integration::set_desktop_integration,
            uninstall::get_uninstall_plan,
            uninstall::run_uninstall,
            uninstall::take_uninstall_request,
            pending_drops::add_pending_drops,
            dropped_files::adopt_dropped_paths,
            pending_drops::add_pending_drops_to_project,
            pending_drops::list_other_projects,
            pending_drops::list_pending_drops,
            pending_drops::remove_pending_drop,
            pending_drops::remove_pending_drops,
            watch_folder::get_watch_folder,
            watch_folder::set_watch_folder,
            disk_search::search_disk,
            disk_search::cancel_disk_search,
            disk_search::has_disk_search_index,
            duplicate_hash::check_already_in_project,
            duplicate_hash::scan_project_for_duplicates,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // The last window going away (code `None`) is the normal
                // state while the drop box sits in the tray.
                if code.is_none() && TRAY_ACTIVE.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    return;
                }
                if EXIT_CLEANUP_DONE.load(Ordering::SeqCst) {
                    return;
                }
                // The cleanup may have to wait — for a job that holds the
                // project lock to finish its write, for ffmpeg to stop — and
                // this handler runs on the main thread. Waiting here froze
                // the window, which is exactly when people kill the app,
                // mid-write. So the exit is held back, the windows go away
                // at once, and the waiting happens on a thread of its own,
                // which exits for real once everything is put away.
                api.prevent_exit();
                if EXIT_CLEANUP_STARTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                for window in app_handle.webview_windows().values() {
                    let _ = window.hide();
                }
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    shut_down(&app);
                    EXIT_CLEANUP_DONE.store(true, Ordering::SeqCst);
                    app.exit(0);
                });
            }
        });
}

static EXIT_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
static EXIT_CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

/// How long exiting waits for cancelled copies (backup, duplicate) to clean
/// up after themselves. A copy checks for cancellation between files, so
/// this only runs out on one enormous file — its `.partial` folder then
/// stays behind, plainly marked as unfinished.
const COPY_CLEANUP_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

fn shut_down(app: &tauri::AppHandle) {
    // A recording still running would otherwise outlive the app as an
    // orphaned ffmpeg — with the camera light on.
    capture::shutdown();
    app.state::<disk_search::DiskSearchTasks>().cancel_all();
    let copies = app.state::<copy_task::CopyTasks>();
    copies.cancel_all();
    let started = std::time::Instant::now();
    while !copies.is_idle() && started.elapsed() < COPY_CLEANUP_WAIT {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Blocks while a job is in its write phase, so it finishes that write
    // (one transaction) instead of being cut off in the middle of it.
    if let Some(mut guard) = app.state::<AppStateHandle>().lock().ok() {
        if let Some(current) = guard.current_project.take() {
            lock::release(&current.path);
            // Not everything ends here any more: the process lives on when
            // the drop box is still open. Same as `close_current_project`.
            app.state::<media_server::MediaServerHandle>().revoke_dir(&current.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::should_force_x11;
    use std::ffi::OsStr;

    #[test]
    fn x11_is_forced_only_on_wayland_with_xwayland_and_no_user_choice() {
        let set = Some(OsStr::new(":0"));
        let empty = Some(OsStr::new(""));
        assert!(should_force_x11(None, set, set));
        // Plain X11 session: nothing to do.
        assert!(!should_force_x11(None, None, set));
        // No XWayland: forcing it would keep GTK from starting at all.
        assert!(!should_force_x11(None, set, None));
        assert!(!should_force_x11(None, set, empty));
        // The user's own choice wins.
        assert!(!should_force_x11(Some(OsStr::new("wayland")), set, set));
    }
}
