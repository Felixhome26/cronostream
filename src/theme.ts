import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Theme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark"];

/// One choice per computer, like the language: the start screen has no
/// project to read it from, and the drop box window (same origin) shares it.
/// The inline script in index.html reads the same key before the first
/// paint, so the two have to stay in step.
const THEME_STORAGE_KEY = "cronostream.theme";

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}

/// Dark unless light was picked — also for anything else stored there,
/// such as the "system" an earlier build offered.
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return "dark";
}

/// The backend keeps the theme so the next start can give the native
/// window the right background before the page has painted. Plain
/// `invoke`, not the busy-tracking wrapper: this is instant.
function syncBackendTheme(theme: Theme) {
  try {
    invoke("set_ui_theme", { theme }).catch(() => {});
  } catch {
    // Outside Tauri (browser test setups) `invoke` throws synchronously.
  }
}

/// Whether a theme was ever picked on this computer. The welcome dialog asks
/// for one on the first start, while this is still false.
export function hasStoredTheme(): boolean {
  try {
    return isTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return false;
  }
}

let activeTheme: Theme = readStoredTheme();
document.documentElement.dataset.theme = activeTheme;
syncBackendTheme(activeTheme);

const themeListeners = new Set<() => void>();

function apply(theme: Theme) {
  if (theme === activeTheme) return;
  activeTheme = theme;
  document.documentElement.dataset.theme = theme;
  syncBackendTheme(theme);
  for (const listener of themeListeners) listener();
}

// The other window (main app vs. drop box) changed it.
window.addEventListener("storage", (ev) => {
  if (ev.key === THEME_STORAGE_KEY && isTheme(ev.newValue)) apply(ev.newValue);
});

/// Switches the theme and remembers it on this computer.
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not remembered, but still applied for this session.
  }
  apply(theme);
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/// The current theme, re-rendering the caller whenever it changes.
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, () => activeTheme);
}
