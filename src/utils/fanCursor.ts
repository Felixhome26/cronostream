import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";

// "Mauszeiger folgt dem aufgeklappten Stapel": when a stack fans out
// centred in the viewport, the real pointer is placed on the small tile
// whose file the big preview above is showing.
//
// This is a *native* window call, not a web one. A page in a browser cannot
// move the pointer — only the Pointer Lock API comes close, and that hides
// it instead of placing it. Tauri's `setCursorPosition` goes through the OS
// (under X11, `XWarpPointer`), which is why it works here at all. The
// permission it needs, `core:window:allow-set-cursor-position`, is granted
// in `src-tauri/capabilities/default.json`.
//
// Where it cannot work: a pure Wayland session, which has no protocol for
// an application to place the pointer and refuses by design. X11, Windows
// and macOS allow it.
//
// The on/off choice used to live in localStorage here. It is a normal
// setting now (`fan_cursor_follow`, app-scoped by default — see
// `app_settings.rs`), so this file only does the moving.

/// Whether the one-off diagnostic below has already been logged.
let reportedOnce = false;

/// Moves the pointer to a viewport position (CSS pixels — i.e. the same
/// space as `clientX`/`clientY`).
///
/// Tauri documents the argument as window coordinates, and the webview
/// fills the window's client area, so viewport coordinates are the right
/// thing to pass. The first call of a session also logs what it asked for
/// alongside the window's own idea of its client-area origin: if a platform
/// ever disagrees about that origin, the pointer lands at an offset, and
/// this line is what makes that visible instead of mysterious.
export function warpPointerTo(clientX: number, clientY: number): void {
  try {
    const win = getCurrentWindow();
    void win
      .setCursorPosition(new LogicalPosition(clientX, clientY))
      .then(() => {
        // Dev builds only: the line is a diagnostic, not output for users.
        if (reportedOnce || !import.meta.env.DEV) return;
        reportedOnce = true;
        void win
          .innerPosition()
          .then((inner) => {
            console.log(
              `[fanCursor] warp → client (${Math.round(clientX)}, ${Math.round(clientY)}); ` +
                `window inner origin (${inner.x}, ${inner.y}) physical`,
            );
          })
          .catch(() => {});
      })
      .catch((err) => {
        // Deliberately not swallowed: a refusal here (missing permission, or
        // a Wayland session) is the whole explanation for "the setting does
        // nothing", and silence made that look like a bug in the geometry.
        console.warn("[fanCursor] Zeiger konnte nicht gesetzt werden:", err);
      });
  } catch (err) {
    // Not running inside Tauri, or the API is unavailable.
    console.warn("[fanCursor] Fenster-API nicht verfügbar:", err);
  }
}
