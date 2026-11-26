import { useSyncExternalStore } from "react";

const WELCOME_HIDDEN_KEY = "cronostream.welcome.hidden";
const DESKTOP_SETUP_OFFERED_KEY = "cronostream.desktopSetup.offered";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Only means the question comes up once more.
  }
}

export const isWelcomeHidden = () => read(WELCOME_HIDDEN_KEY);
export const setWelcomeHidden = (hidden: boolean) => write(WELCOME_HIDDEN_KEY, hidden);

export const isDesktopSetupOffered = () => read(DESKTOP_SETUP_OFFERED_KEY);
export const markDesktopSetupOffered = () => write(DESKTOP_SETUP_OFFERED_KEY, true);

// Whether the welcome dialog is on screen. The timeline's onboarding toast
// waits on it: toasts sit above modals, so one fired meanwhile would cover
// the dialog's own buttons.
let welcomeOpen = false;
const openListeners = new Set<() => void>();

export function setWelcomeOpen(open: boolean) {
  if (welcomeOpen === open) return;
  welcomeOpen = open;
  openListeners.forEach((listener) => listener());
}

export function useWelcomeOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    () => welcomeOpen,
  );
}
