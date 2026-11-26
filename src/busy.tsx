import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { t } from "./i18n";

/// App-wide "still alive" indicator: a spinner that shows whenever the app
/// is waiting on something slow, without being wired to the actual
/// progress of anything. Every backend call goes through `invoke` below,
/// so most waits are covered automatically; flows made of several steps
/// with frontend work in between wrap themselves in `runBusy` so the
/// spinner doesn't drop out between two calls.

/// Commands that are expected to take long but never leave the user
/// waiting on them: previews stream in while the user keeps browsing, and
/// background jobs (disk search, backup, copying, recording, ffmpeg
/// download) have their own progress display. `open_path_checked` may sit
/// in its "open this program?" question for as long as the user takes.
const IGNORED_COMMANDS = new Set([
  "debug_log",
  "get_file_preview",
  "get_full_image_preview",
  "get_email_text_preview",
  "get_document_text_preview",
  // The date inside a file, read in the background where its choice is shown.
  "get_media_dates",
  // Verwalten → Archiv prüfen / Duplikate: own progress display.
  "check_archive",
  "regenerate_thumbnails",
  "scan_similar_images",
  "build_cluster_trees",
  "search_disk",
  "start_backup",
  "start_duplicate_project",
  "install_ffmpeg",
  "prepare_playback_copy",
  "capture_open",
  "capture_record",
  "capture_pause",
  "capture_stop",
  "capture_close",
  "open_path_checked",
]);

let pending = 0;
const listeners = new Set<() => void>();

function changePending(delta: number) {
  pending += delta;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/// Drop-in replacement for `@tauri-apps/api/core`'s `invoke` that counts
/// the call as "busy" while it runs.
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (IGNORED_COMMANDS.has(cmd)) return tauriInvoke<T>(cmd, args, options);
  changePending(1);
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } finally {
    changePending(-1);
  }
}

/// Keeps the spinner up for the whole of `work` — for flows that chain
/// several calls with frontend work in between (an import, then reloading
/// the views it changed).
export async function runBusy<T>(work: () => Promise<T>): Promise<T> {
  changePending(1);
  try {
    return await work();
  } finally {
    changePending(-1);
  }
}

/// Only waits longer than this get a spinner — a quick call would just
/// make it flash.
const SHOW_DELAY_MS = 400;
/// Stays up this long after the last call ends, so back-to-back calls
/// read as one wait instead of a flicker.
const HIDE_DELAY_MS = 300;

export function BusyIndicator() {
  const busy = useSyncExternalStore(subscribe, () => pending > 0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(busy), busy ? SHOW_DELAY_MS : HIDE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  if (!visible) return null;
  return (
    <div className="busy-indicator" role="status" aria-live="polite">
      <span className="busy-indicator__spinner" aria-hidden="true" />
      <span className="busy-indicator__label">{t("busy.working")}</span>
    </div>
  );
}
