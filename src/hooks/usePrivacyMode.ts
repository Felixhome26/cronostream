import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../busy";
import type { PrivacyStatus } from "../types";
import { comboFromEvent, isPrivacyCapturing } from "../utils/privacyShortcut";

const IDLE_CHECK_MS = 15_000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;

interface PrivacyContextValue {
  status: PrivacyStatus | null;
  /// After the settings section changed something: the status is read again
  /// and the lists reload, since marker and scope decide what they contain.
  onSettingsChanged: () => void;
}

export const PrivacyContext = createContext<PrivacyContextValue | null>(null);

export function usePrivacy(): PrivacyContextValue | null {
  return useContext(PrivacyContext);
}

/// The running half of the private mode: knows whether private files are
/// showing, listens for the combination, and hides them again after the
/// chosen idle time. Belongs to `ProjectShell`, so it only runs with a project
/// open, and the combination works from every view and dialog in it.
///
/// `onVisibilityChanged` is told after every change of what is hidden, with
/// `hiding` set when files just went away.
export function usePrivacyMode(onVisibilityChanged: (hiding: boolean) => void, onListsChanged: () => void) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  // The listeners below stay attached across renders, and these callbacks
  // close over `ProjectShell`'s current state.
  const onVisibilityChangedRef = useRef(onVisibilityChanged);
  onVisibilityChangedRef.current = onVisibilityChanged;

  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await invoke<PrivacyStatus>("privacy_get_status"));
    } catch {
      // A status that can't be read leaves the mode looking off, which hides
      // nothing further than the backend already does.
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  const hide = useCallback(async () => {
    try {
      await invoke("privacy_hide");
      setStatus((prev) => (prev ? { ...prev, revealed: false } : prev));
      onVisibilityChangedRef.current(true);
    } catch {
      // Only fails with no project open, where there is nothing to hide.
    }
  }, []);

  const reveal = useCallback(async (password: string) => {
    await invoke("privacy_reveal", { password });
    setStatus((prev) => (prev ? { ...prev, revealed: true } : prev));
    setPromptOpen(false);
    onVisibilityChangedRef.current(false);
  }, []);

  const configured = status?.configured ?? false;
  const revealed = status?.revealed ?? false;
  const shortcut = status?.shortcut ?? null;
  const autoHideMinutes = status?.autoHideMinutes ?? 0;

  // Capture phase on the window, so a focused input or a dialog can't keep
  // the combination from arriving, and nothing else acts on the same keys.
  useEffect(() => {
    if (!configured || !shortcut) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (isPrivacyCapturing() || comboFromEvent(ev) !== shortcut) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.repeat) return;
      if (revealed) void hide();
      else setPromptOpen(true);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [configured, shortcut, revealed, hide]);

  useEffect(() => {
    if (!configured || !revealed || autoHideMinutes <= 0) return;
    let lastActivity = Date.now();
    const noteActivity = () => {
      lastActivity = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, noteActivity, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity >= autoHideMinutes * 60_000) void hide();
    }, IDLE_CHECK_MS);
    return () => {
      window.clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, noteActivity, { capture: true });
    };
  }, [configured, revealed, autoHideMinutes, hide]);

  // A note was just given the marker while private files are hidden.
  useEffect(() => {
    const unlisten = listen("privacy-note-hid-item", () => onVisibilityChangedRef.current(true));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const onSettingsChanged = useCallback(() => {
    void reloadStatus();
    onListsChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadStatus]);

  return { status, promptOpen, closePrompt: () => setPromptOpen(false), reveal, onSettingsChanged };
}
