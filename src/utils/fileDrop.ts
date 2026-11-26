import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { t } from "../i18n";

/// Files dragged onto a window from outside, for every drop target of the
/// app (main window, drop box, diary attachments).
///
/// Two sources: Tauri's own drag-and-drop events (Linux, macOS), and on
/// Windows the app's own drop target (`src-tauri/src/win_drop.rs`), which
/// also takes the virtual files classic Outlook drags mails as. Before a
/// drop is handed on, `adopt_dropped_paths` makes the paths last: e-mails a
/// mail program left in a temporary folder are copied into the app's store,
/// and an mbox file with several messages (Evolution) is split into one
/// file per message (`src-tauri/src/dropped_files.rs`).
export type FileDropEvent =
  | { type: "enter" | "over" | "leave" }
  | { type: "drop"; paths: string[]; failed: string[] };

type NativeDrop = { label: string; type: "enter" | "over" | "leave" | "drop"; paths: string[]; failed: string[] };

/// `accept` is asked at the moment of the drop (not after the paths were
/// made lasting): a drop it turns down reaches the handler as "leave".
export function onFileDrop(
  handler: (event: FileDropEvent) => void,
  accept: () => boolean = () => true,
): Promise<UnlistenFn> {
  const webview = getCurrentWebview();
  const drop = (paths: string[], failed: string[]) => {
    if (!accept()) {
      handler({ type: "leave" });
      return;
    }
    if (paths.length === 0) {
      handler({ type: "drop", paths, failed });
      return;
    }
    invoke<{ paths: string[]; failed: string[] }>("adopt_dropped_paths", { paths })
      .then((r) => handler({ type: "drop", paths: r.paths, failed: [...failed, ...r.failed] }))
      // Taken as they came: still better than losing the drop.
      .catch(() => handler({ type: "drop", paths, failed }));
  };
  const tauriDrop = webview.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "drop") drop(p.paths, []);
    else handler({ type: p.type });
  });
  const nativeDrop = listen<NativeDrop>("native-file-drop", (event) => {
    const p = event.payload;
    if (p.label !== webview.label) return;
    if (p.type === "drop") drop(p.paths, p.failed);
    else handler({ type: p.type });
  });
  return Promise.all([tauriDrop, nativeDrop]).then(([a, b]) => () => {
    a();
    b();
  });
}

/// What to tell the user about a drop's leftovers, or null when everything
/// arrived: names that couldn't be taken over, or that nothing usable came
/// at all (a mail program that hands over neither a file nor a message).
export function dropProblem(event: { paths: string[]; failed: string[] }): string | null {
  if (event.failed.length > 0) {
    return t("drop.failed").replace("{names}", event.failed.join(", "));
  }
  if (event.paths.length === 0) return t("drop.nothingUsable");
  return null;
}
