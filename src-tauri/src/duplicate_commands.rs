use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::copy_task::{self, CopyTasks};
use crate::project::{self, PROJECT_NAME_KEY};
use crate::recent;
use crate::settings;
use crate::state::AppStateHandle;

/// Starts a cancellable, progress-reporting copy of `source_path` into a new
/// `new_name` folder under `destination_parent`. Returns a task id the
/// frontend uses to track `copy-progress` events and to cancel. Once the
/// copy finishes, the duplicate is renamed (its own `project_name` setting,
/// not the source's) and added to the recent-projects list.
#[tauri::command(async)]
pub fn start_duplicate_project(
    app: AppHandle,
    tasks: State<CopyTasks>,
    source_path: String,
    destination_parent: String,
    new_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !project::is_project_folder(&src) {
        return Err(crate::i18n::tr("Dieser Ordner enthält keinen Stream.").into());
    }

    let trimmed_name = new_name.trim().to_string();
    let folder_name = project::sanitize_folder_name(&trimmed_name);
    if folder_name.is_empty() {
        return Err(crate::i18n::tr("Bitte einen gültigen Namen eingeben.").into());
    }

    let dst = Path::new(&destination_parent).join(&folder_name);
    if dst.exists() {
        return Err(
            crate::i18n::tr("Ein Ordner mit diesem Namen existiert bereits an diesem Ort. Bitte einen anderen Namen wählen.").into(),
        );
    }
    if copy_task::staging_path(&dst).exists() {
        return Err(crate::trf!(
            "Ein unvollständiger früherer Versuch liegt noch unter „{path}“. Bitte diesen Ordner prüfen und löschen, dann erneut starten.",
            path = copy_task::staging_path(&dst).display()
        ));
    }
    copy_task::ensure_destination_outside_source(&src, &dst)?;

    let (task_id, cancel) = tasks.register();
    let src_for_rewrite = src.clone();
    let name_for_db = trimmed_name.clone();
    copy_task::spawn_copy(
        app,
        task_id.clone(),
        "duplicate".to_string(),
        src,
        dst,
        cancel,
        move |_app, staging, dst_path| {
            // Filenames stay byte-identical (`sanitize = false`) — only the
            // project-root prefix changes — so the duplicate is a project
            // in its own right rather than one that only looks complete
            // because the original it was copied from is still there.
            copy_task::rewrite_item_paths(staging, &src_for_rewrite, dst_path, false)?;
            let conn = project::open_project_db(staging)?;
            settings::set(&conn, PROJECT_NAME_KEY, &name_for_db)?;
            drop(conn);
            Ok(())
        },
        // Only once the duplicate has its final name: an entry written
        // before the rename would point at nothing if the rename failed.
        // The copy itself is complete either way, so an unwritable recent
        // list is logged, not reported as a failed duplicate.
        move |app, dst_path| {
            if let Err(e) = recent::touch_recent(app, &dst_path.to_string_lossy(), &trimmed_name) {
                eprintln!("Zuletzt geöffnet nicht aktualisiert: {e}");
            }
        },
    );

    Ok(task_id)
}

#[tauri::command(async)]
pub fn cancel_copy_task(tasks: State<CopyTasks>, task_id: String) -> Result<(), String> {
    tasks.cancel(&task_id)
}

/// Renames a stream's display name — either the currently open project
/// (writes straight to its open connection) or a project from the recent
/// list that isn't open right now (briefly opens its database just for
/// this). Updates the recent-projects entry to match, without reordering.
#[tauri::command(async)]
pub fn rename_project(
    app: AppHandle,
    state: State<AppStateHandle>,
    path: String,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::tr("Bitte einen gültigen Namen eingeben.").into());
    }

    let guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(current) = guard.current_project.as_ref() {
        if current.path.to_string_lossy() == path {
            settings::set(&current.conn, PROJECT_NAME_KEY, trimmed)?;
            return recent::rename_recent(&app, &path, trimmed);
        }
    }
    drop(guard);

    let conn = project::open_project_db(Path::new(&path))?;
    settings::set(&conn, PROJECT_NAME_KEY, trimmed)?;
    recent::rename_recent(&app, &path, trimmed)
}
