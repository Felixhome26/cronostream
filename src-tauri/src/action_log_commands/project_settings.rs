//! The per-stream settings: their keys, where each one is read from
//! (this project or app-wide), and the commands that read and change them.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::action_log::{self, ActionType, LogEntry};
use crate::app_settings;
use crate::items;
use crate::settings;
use crate::state::AppStateHandle;
use crate::timeline_commands;

/// Key for the tile-drag-to-reschedule toggle — project-scoped since
/// 2026-10-10 (previously a per-machine `localStorage` preference; moving
/// it here was an explicit decision, not an oversight, since it changes a
/// stream restored elsewhere to carry the same setting along).
pub(crate) const TILE_DRAG_ENABLED_KEY: &str = "tile_drag_enabled";

/// Key for the detail viewer's timestamp-overlay toggle (Einstellungen).
/// Missing row defaults to `true` (see get_project_settings) — unlike
/// tile_drag_enabled, this setting exists to let someone turn the overlay
/// *off*, not to opt into it.
pub(crate) const SHOW_TIMESTAMP_OVERLAY_KEY: &str = "show_timestamp_overlay";

/// Keys for "Navigation in der Detailansicht": which files the viewer's
/// prev/next arrows step through. Mode is `all` (default, the viewer's
/// long-standing behaviour), `category` (only the opened file's own type)
/// or `custom`, in which case the types key holds the comma-separated list
/// of enabled types. A missing types row means all four are enabled; an
/// empty one means none (deliberate, the viewer still keeps the open file).
pub(crate) const VIEWER_NAV_MODE_KEY: &str = "viewer_nav_mode";
pub(crate) const VIEWER_NAV_TYPES_KEY: &str = "viewer_nav_types";
pub(super) const VIEWER_NAV_TYPES: [&str; 4] = ["image", "video", "audio", "document"];

/// Key for the timeline's vertical lane order: the four type groups, top to
/// bottom, comma-separated. A lane only appears at all when the stream
/// actually holds files of that group, so this is an order over all four
/// and not a visibility list — the groups with nothing in them are skipped
/// while the rest keep their relative order.
///
/// A stored value is normalised rather than trusted (see
/// `parse_lane_order`): unknown names dropped, duplicates ignored, missing
/// groups appended in default order. So no edit, downgrade or hand-written
/// row can ever leave a category without a place in the stack.
pub(crate) const LANE_ORDER_KEY: &str = "lane_order";
pub(super) const LANE_ORDER_DEFAULT: [&str; 4] = ["document", "image", "video", "audio"];

/// The stored lane order, completed to all four groups.
pub(super) fn parse_lane_order(stored: Option<String>) -> Vec<String> {
    let mut order: Vec<String> = Vec::with_capacity(LANE_ORDER_DEFAULT.len());
    if let Some(raw) = stored {
        for name in raw.split(',').map(str::trim) {
            if LANE_ORDER_DEFAULT.contains(&name) && !order.iter().any(|o| o == name) {
                order.push(name.to_string());
            }
        }
    }
    for name in LANE_ORDER_DEFAULT {
        if !order.iter().any(|o| o == name) {
            order.push(name.to_string());
        }
    }
    order
}

/// The two axes of "what a stack does", plus the brake for the one
/// combination that needs it.
///
/// `pile_action` is *what* opening a stack does: `fan` opens it in place at
/// the current zoom (big preview, members in a row underneath), `zoom`
/// zooms the timeline in until the stack comes apart on its own — falling
/// back to a fan when the zoom that would take is past the limit, which is
/// why a handful of files minutes apart still fan out.
///
/// `pile_trigger` is *what* opens it: `click`, or `hover` (the pointer
/// resting on it). A click always does the same thing immediately, so the
/// trigger only decides whether hovering *also* does.
///
/// `hover_zoom_brake` matters only for hover + zoom. A zoom moves fresh
/// content under a pointer that never moved, which hands out another
/// mouseenter and would zoom again, and again: `step` re-arms only once the
/// pointer has really travelled, `cascade` deliberately lets it run until
/// the stack dissolves, and `click_only` keeps zooming on the click and has
/// hover fan the stack out instead.
///
/// The defaults are click + fan: a stack opens only when clicked, and opens
/// in place. Hover fanning and zoom-on-click stay available in the dialog;
/// a stream that never stored a value follows these defaults.
pub(crate) const PILE_ACTION_KEY: &str = "pile_action";
pub(crate) const PILE_TRIGGER_KEY: &str = "pile_trigger";
pub(crate) const HOVER_ZOOM_BRAKE_KEY: &str = "hover_zoom_brake";

/// Key for "Mauszeiger folgt dem aufgeklappten Stapel". App-scoped by
/// default, unlike everything else here: whether the pointer can be placed
/// at all is a property of the window system (X11, Windows and macOS allow
/// it, a pure Wayland session does not), not of a stream — so a
/// project-scoped choice would travel to a machine that cannot honour it.
pub(crate) const FAN_CURSOR_FOLLOW_KEY: &str = "fan_cursor_follow";

/// Keys for the two optional grids of the timeline ("Wochenraster anzeigen",
/// "Stundenraster anzeigen"). A missing row means on, which is the five zoom
/// levels the timeline has always had. Purely a display choice read by the
/// frontend — nothing on this side depends on either.
pub(crate) const SHOW_WEEK_GRID_KEY: &str = "show_week_grid";
pub(crate) const SHOW_HOUR_GRID_KEY: &str = "show_hour_grid";

/// Key for "Mausrad öffnet und schließt die Detailansicht". A missing row
/// means on. Purely an input choice read by the frontend.
pub(crate) const WHEEL_VIEWER_KEY: &str = "wheel_viewer";

/// Key for the file browser views that show the floating timeline preview
/// ("Peek") and its way back, comma-separated view names. An empty value is
/// real ("nowhere"), not unset; unset means the default, Datei-Operationen.
/// Unknown names are dropped on read, so an edited or future-version row
/// cannot make the preview appear on a view that does not exist.
pub(crate) const PEEK_TABS_KEY: &str = "peek_tabs";
pub(super) const PEEK_TABS: [&str; 11] = [
    "grid", "single", "search", "manifest", "ai_metadata", "file_ops", "protocol", "duplicates", "trash", "backup",
    "settings",
];
pub(super) const PEEK_TABS_DEFAULT: &str = "file_ops";

/// Every setting the dialog exposes, with the scope it resolves through
/// until the user picks one. Kept as a single table so the read path, the
/// scope command and the project-open sync cannot drift apart — each of
/// those walks this list rather than repeating a key set of its own.
pub(crate) const SETTINGS: &[(&str, &str)] = &[
    (TILE_DRAG_ENABLED_KEY, app_settings::SCOPE_PROJECT),
    (SHOW_TIMESTAMP_OVERLAY_KEY, app_settings::SCOPE_PROJECT),
    (VIEWER_NAV_MODE_KEY, app_settings::SCOPE_PROJECT),
    (VIEWER_NAV_TYPES_KEY, app_settings::SCOPE_PROJECT),
    (PILE_ACTION_KEY, app_settings::SCOPE_PROJECT),
    (PILE_TRIGGER_KEY, app_settings::SCOPE_PROJECT),
    (HOVER_ZOOM_BRAKE_KEY, app_settings::SCOPE_PROJECT),
    (FAN_CURSOR_FOLLOW_KEY, app_settings::SCOPE_APP),
    (SHOW_WEEK_GRID_KEY, app_settings::SCOPE_PROJECT),
    (SHOW_HOUR_GRID_KEY, app_settings::SCOPE_PROJECT),
    (WHEEL_VIEWER_KEY, app_settings::SCOPE_PROJECT),
    (LANE_ORDER_KEY, app_settings::SCOPE_PROJECT),
    (PEEK_TABS_KEY, app_settings::SCOPE_APP),
    (timeline_commands::DELETE_FILES_ON_REMOVE_KEY, app_settings::SCOPE_PROJECT),
    (items::DEFAULT_VIDEO_FRAME_PERCENT_KEY, app_settings::SCOPE_PROJECT),
    (items::QUICK_HASH_ON_INGEST_KEY, app_settings::SCOPE_PROJECT),
    (items::QUICK_HASH_PREFILTER_KEY, app_settings::SCOPE_PROJECT),
    (timeline_commands::EARLIEST_DATE_YEAR_KEY, app_settings::SCOPE_PROJECT),
];

/// Refuses any key the settings dialog does not own.
///
/// The `settings` table also holds rows that must never be written from the
/// frontend or from an undo — the privacy password and recovery hashes,
/// `project_name` — so every path that takes a key from outside (the two
/// commands below, undoing a logged setting change) goes through this.
pub(crate) fn ensure_known_setting(key: &str) -> Result<(), String> {
    if SETTINGS.iter().any(|(k, _)| *k == key) {
        Ok(())
    } else {
        Err(crate::trf!("Unbekannte Einstellung: {key}", key = key))
    }
}

pub(super) fn default_scope_of(key: &str) -> &'static str {
    SETTINGS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, scope)| *scope)
        .unwrap_or(app_settings::SCOPE_PROJECT)
}

/// The value in force for `key`.
///
/// The project row is kept in step with the app-wide value whenever a
/// setting is app-scoped (see `set_project_setting` and
/// `sync_app_scoped_into_project`), so that every existing reader of the
/// project database — the import path's video-frame percentage,
/// `delete_files_on_remove` — stays correct without knowing about scopes at
/// all. Preferring the app store here anyway is the belt to that braces: it
/// is right even on the first read after a project is opened, before any
/// sync has had a chance to run.
pub(super) fn resolved(conn: &Connection, store: &app_settings::Store, key: &str) -> Result<Option<String>, String> {
    if app_settings::scope_of(store, key, default_scope_of(key)) == app_settings::SCOPE_APP {
        if let Some(value) = app_settings::value_of(store, key) {
            return Ok(Some(value));
        }
    }
    settings::get(conn, key)
}

/// Writes every app-scoped setting's value into a freshly opened project's
/// own `settings` rows, so the readers that only ever see the project
/// database agree with what the dialog shows. Best-effort by design: a
/// project that cannot be written to (read-only medium) must still open.
pub fn sync_app_scoped_into_project(app: &AppHandle, conn: &Connection) {
    let store = app_settings::load(app);
    for (key, default_scope) in SETTINGS {
        if app_settings::scope_of(&store, key, default_scope) != app_settings::SCOPE_APP {
            continue;
        }
        if let Some(value) = app_settings::value_of(&store, key) {
            let _ = settings::set(conn, key, &value);
        }
    }
}


#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub tile_drag_enabled: bool,
    pub default_video_frame_percent: f64,
    pub delete_files_on_remove: bool,
    pub show_timestamp_overlay: bool,
    pub viewer_nav_mode: String,
    pub viewer_nav_types: Vec<String>,
    pub pile_action: String,
    pub pile_trigger: String,
    pub hover_zoom_brake: String,
    pub fan_cursor_follow: bool,
    pub show_week_grid: bool,
    pub show_hour_grid: bool,
    pub wheel_viewer: bool,
    pub quick_hash_on_ingest: bool,
    pub quick_hash_use_prefilter: bool,
    pub earliest_date_year: i32,
    /// The four type groups in the order their lanes stack, top to bottom.
    pub lane_order: Vec<String>,
    /// File browser views that show the timeline preview and its return pill.
    pub peek_tabs: Vec<String>,
    /// Per setting key, whether its value currently comes from this project
    /// or from the machine-wide store — what the dialog's Projekt/App
    /// control shows. Every key in `SETTINGS` appears here.
    pub scopes: BTreeMap<String, String>,
}

/// Every setting the dialog shows, each resolved through its own scope (see
/// `resolved`), plus the scope map itself. A missing value falls back to
/// that setting's own long-standing default, which is why each one parses
/// with its own `unwrap_or` rather than sharing one.
#[tauri::command(async)]
pub fn get_project_settings(app: AppHandle, state: State<AppStateHandle>) -> Result<ProjectSettings, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    let conn = &current.conn;
    let store = app_settings::load(&app);

    let flag = |key: &str, default: bool| -> Result<bool, String> {
        Ok(resolved(conn, &store, key)?.map(|v| v == "true").unwrap_or(default))
    };

    let tile_drag_enabled = flag(TILE_DRAG_ENABLED_KEY, false)?;
    let delete_files_on_remove = flag(timeline_commands::DELETE_FILES_ON_REMOVE_KEY, false)?;
    let show_timestamp_overlay = flag(SHOW_TIMESTAMP_OVERLAY_KEY, true)?;
    let fan_cursor_follow = flag(FAN_CURSOR_FOLLOW_KEY, false)?;
    let show_week_grid = flag(SHOW_WEEK_GRID_KEY, true)?;
    let show_hour_grid = flag(SHOW_HOUR_GRID_KEY, true)?;
    let wheel_viewer = flag(WHEEL_VIEWER_KEY, true)?;
    let quick_hash_on_ingest = flag(items::QUICK_HASH_ON_INGEST_KEY, true)?;
    let quick_hash_use_prefilter = flag(items::QUICK_HASH_PREFILTER_KEY, true)?;

    let viewer_nav_mode = resolved(conn, &store, VIEWER_NAV_MODE_KEY)?
        .filter(|v| matches!(v.as_str(), "all" | "category" | "custom"))
        .unwrap_or_else(|| "all".to_string());
    let viewer_nav_types = match resolved(conn, &store, VIEWER_NAV_TYPES_KEY)? {
        Some(v) => v
            .split(',')
            .filter(|t| VIEWER_NAV_TYPES.contains(t))
            .map(str::to_string)
            .collect(),
        None => VIEWER_NAV_TYPES.iter().map(|t| t.to_string()).collect(),
    };

    let pile_action = resolved(conn, &store, PILE_ACTION_KEY)?
        .filter(|v| matches!(v.as_str(), "fan" | "zoom"))
        .unwrap_or_else(|| "fan".to_string());
    let pile_trigger = resolved(conn, &store, PILE_TRIGGER_KEY)?
        .filter(|v| matches!(v.as_str(), "click" | "hover"))
        .unwrap_or_else(|| "click".to_string());
    let hover_zoom_brake = resolved(conn, &store, HOVER_ZOOM_BRAKE_KEY)?
        .filter(|v| matches!(v.as_str(), "step" | "cascade" | "click_only"))
        .unwrap_or_else(|| "click_only".to_string());

    // Parsed here rather than through `items::default_video_frame_percent`,
    // which reads the project row directly and so cannot see an app-scoped
    // value on the very first read of a freshly opened project. The sync on
    // open makes the two agree; this just never depends on it having run.
    let default_video_frame_percent = resolved(conn, &store, items::DEFAULT_VIDEO_FRAME_PERCENT_KEY)?
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(10.0);

    let earliest_date_year = resolved(conn, &store, timeline_commands::EARLIEST_DATE_YEAR_KEY)?
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(timeline_commands::DEFAULT_EARLIEST_DATE_YEAR);

    let lane_order = parse_lane_order(resolved(conn, &store, LANE_ORDER_KEY)?);

    let peek_tabs = resolved(conn, &store, PEEK_TABS_KEY)?
        .unwrap_or_else(|| PEEK_TABS_DEFAULT.to_string())
        .split(',')
        .map(str::trim)
        .filter(|t| PEEK_TABS.contains(t))
        .map(str::to_string)
        .collect();

    let scopes = SETTINGS
        .iter()
        .map(|(key, default_scope)| {
            (key.to_string(), app_settings::scope_of(&store, key, default_scope))
        })
        .collect();

    Ok(ProjectSettings {
        tile_drag_enabled,
        default_video_frame_percent,
        delete_files_on_remove,
        show_timestamp_overlay,
        viewer_nav_mode,
        viewer_nav_types,
        pile_action,
        pile_trigger,
        hover_zoom_brake,
        fan_cursor_follow,
        show_week_grid,
        show_hour_grid,
        wheel_viewer,
        quick_hash_on_ingest,
        quick_hash_use_prefilter,
        earliest_date_year,
        lane_order,
        peek_tabs,
        scopes,
    })
}

/// Writes a setting to whichever scope it currently resolves through.
///
/// The project row is written either way: for a project-scoped setting it
/// *is* the value, and for an app-scoped one it keeps the readers that only
/// ever look at the project database (the import path's video-frame
/// percentage, `delete_files_on_remove`) in step with what is actually in
/// force. Only the project-scoped write is logged — the action log belongs
/// to one stream, so recording a machine-wide change in it would offer
/// an undo that silently reaches outside the project it is listed under.
#[tauri::command(async)]
pub fn set_project_setting(
    app: AppHandle,
    state: State<AppStateHandle>,
    key: String,
    value: String,
) -> Result<(), String> {
    ensure_known_setting(&key)?;
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let store = app_settings::load(&app);
    let app_scoped = app_settings::scope_of(&store, &key, default_scope_of(&key)) == app_settings::SCOPE_APP;

    let previous = resolved(&current.conn, &store, &key)?;
    if previous.as_deref() == Some(value.as_str()) {
        return Ok(());
    }

    if app_scoped {
        app_settings::set_value(&app, &key, &value)?;
        let _ = settings::set(&current.conn, &key, &value);
        return Ok(());
    }

    settings::set(&current.conn, &key, &value)?;
    let _ = action_log::record(
        &current.conn,
        ActionType::SettingChange,
        &[LogEntry {
            item_id: None,
            label: key,
            before_value: previous,
            after_value: Some(value),
            before_source: None,
        }],
    );
    Ok(())
}

/// Moves one setting between "nur dieser Stream" and "alle auf diesem
/// Rechner".
///
/// Deliberately never changes the value in force: the scope being left and
/// the scope being entered are both seeded with the value that was already
/// showing. So the switch answers only "where should this be remembered",
/// and never surprises the user by also changing what the setting does.
#[tauri::command(async)]
pub fn set_setting_scope(
    app: AppHandle,
    state: State<AppStateHandle>,
    key: String,
    scope: String,
) -> Result<(), String> {
    if scope != app_settings::SCOPE_PROJECT && scope != app_settings::SCOPE_APP {
        return Err(format!("Unbekannter Geltungsbereich: {scope}"));
    }
    ensure_known_setting(&key)?;
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

    let store = app_settings::load(&app);
    let in_force = resolved(&current.conn, &store, &key)?;

    app_settings::set_scope(&app, &key, &scope, in_force.as_deref())?;
    if let Some(value) = in_force {
        // Keeps the project row equal to the value in force, whichever
        // scope now owns it — see `set_project_setting` for why the readers
        // downstream depend on that.
        let _ = settings::set(&current.conn, &key, &value);
    }
    Ok(())
}
