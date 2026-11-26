//! Native file drag-out for Linux/GTK.
//!
//! `tauri-plugin-drag` builds its URIs as `file://` + raw path, which file
//! managers reject as soon as the path holds a space or a non-ASCII
//! character, and it offers no GNOME-style copy target. This replaces it on
//! Linux: same GTK drag mechanism, but with properly escaped URIs and the
//! targets Nemo/Nautilus/Dolphin and browsers look for. Always a COPY drag.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use base64::Engine;
use gtk::gdk;
use gtk::gdk_pixbuf::PixbufLoader;
use gtk::glib::{ObjectExt, SignalHandlerId};
use gtk::prelude::*;
use gtk::{TargetEntry, TargetFlags, TargetList};
use tauri::{command, AppHandle, Emitter, Runtime, Window};

const TARGET_URI_LIST: &str = "text/uri-list";
const TARGET_GNOME_COPIED: &str = "x-special/gnome-copied-files";
const TARGET_PLAIN_TEXT: &str = "text/plain";

fn pixbuf_from_png_data_url(icon: &str) -> Option<gtk::gdk_pixbuf::Pixbuf> {
    let b64 = icon.strip_prefix("data:image/png;base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let loader = PixbufLoader::new();
    loader.write(&bytes).ok()?;
    loader.close().ok()?;
    loader.pixbuf()
}

fn start(
    window: &gtk::ApplicationWindow,
    path: PathBuf,
    icon: Option<String>,
    on_end: impl Fn() + 'static,
) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    // gio escapes spaces, umlauts, '%', '#', ... correctly.
    let uri = gtk::gio::File::for_path(&path).uri().to_string();
    let display_path = path.to_string_lossy().into_owned();

    let targets = TargetList::new(&[
        TargetEntry::new(TARGET_URI_LIST, TargetFlags::OTHER_APP, 0),
        TargetEntry::new(TARGET_GNOME_COPIED, TargetFlags::OTHER_APP, 1),
        TargetEntry::new(TARGET_PLAIN_TEXT, TargetFlags::OTHER_APP, 2),
    ]);

    window.drag_source_set(gdk::ModifierType::BUTTON1_MASK, &[], gdk::DragAction::COPY);
    window.drag_source_set_target_list(Some(&targets));

    let handlers: Rc<RefCell<Vec<SignalHandlerId>>> = Rc::new(RefCell::new(Vec::new()));

    let data_uri = uri.clone();
    let get_id = window.connect_drag_data_get(move |_, _, data, info, _| match info {
        0 => {
            data.set_uris(&[data_uri.as_str()]);
        }
        1 => {
            let payload = format!("copy\n{}", data_uri);
            data.set(&data.target(), 8, payload.as_bytes());
        }
        _ => {
            data.set_text(&display_path);
        }
    });
    handlers.borrow_mut().push(get_id);

    let win_for_end = window.clone();
    let handlers_for_end = handlers.clone();
    let end_id = window.connect_drag_end(move |_, _| {
        for id in handlers_for_end.borrow_mut().drain(..) {
            win_for_end.disconnect(id);
        }
        // Leave no window-wide drag source behind: it would otherwise
        // start hijacking the webview's own drags.
        win_for_end.drag_source_unset();
        on_end();
    });
    handlers.borrow_mut().push(end_id);

    let Some(context) = window.drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, None, -1, -1)
    else {
        // drag-end never fires for a drag that never began.
        for id in handlers.borrow_mut().drain(..) {
            window.disconnect(id);
        }
        window.drag_source_unset();
        return Err("GTK could not start the drag".to_string());
    };

    if let Some(pixbuf) = icon.as_deref().and_then(pixbuf_from_png_data_url) {
        context.drag_set_icon_pixbuf(&pixbuf, 0, 0);
    }
    Ok(())
}

#[command]
pub async fn start_file_drag<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    path: String,
    icon: Option<String>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let emitter = window.clone();
        let on_end = move || {
            let _ = emitter.emit("file-drag-out-end", ());
        };
        let result = match window.gtk_window() {
            Ok(w) => start(&w, PathBuf::from(path), icon, on_end),
            Err(e) => Err(e.to_string()),
        };
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

