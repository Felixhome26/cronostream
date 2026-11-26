import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Tracks fullscreen state and provides a toggle, with ESC always exiting
 * fullscreen — available on every screen, not just once a project is open,
 * so the user is never stuck in fullscreen with no way out.
 *
 * The app starts maximized, not fullscreen (see tauri.conf.json), so the
 * initial guess is `false` — guessing `true` made the "exit fullscreen"
 * button flash on every start until the first isFullscreen() round-trip
 * came back.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.isFullscreen().then(setIsFullscreen).catch(() => {});

    // Asks the window first: setFullscreen(false) on a window that isn't
    // fullscreen can still make some window managers drop a maximized
    // window back to its configured size (seen on X11), and Esc reaches
    // this handler from every view that lets it through.
    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      appWindow
        .isFullscreen()
        .then((full) => {
          if (!full) return;
          return appWindow.setFullscreen(false).then(() => setIsFullscreen(false));
        })
        .catch(() => {});
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function toggleFullscreen() {
    const appWindow = getCurrentWindow();
    const next = !isFullscreen;
    await appWindow.setFullscreen(next);
    setIsFullscreen(next);
  }

  return { isFullscreen, toggleFullscreen };
}
