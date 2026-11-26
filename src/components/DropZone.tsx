import { useCallback, useEffect, useState } from "react";
import { invoke } from "../busy";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { useTheme } from "../theme";
import { dropProblem, onFileDrop } from "../utils/fileDrop";
import type { PendingDropInfo } from "../types";
import "../App.css";

const KIND_ICON: Record<string, string> = {
  image: "🖼️",
  audio: "🎧",
  video: "🎬",
  document: "📄",
  other: "📎",
};

/// The always-on-top mini window (window label "dropzone", see
/// `src-tauri/src/lib.rs`). Deliberately does one single thing: take files
/// dropped from the OS file manager and park them in the persisted waiting
/// list. No previews (that would make a tiny floating window expensive),
/// no project logic, no import — importing happens in the main app, where
/// a project is actually open (see `PendingDrops.tsx`).
// Normal size mirrors `build_dropzone_window` in lib.rs. The circle's
// diameter gives ~9 % of the normal area: π·52² ≈ 8 500 vs 260·380 = 98 800.
const FULL_SIZE = { w: 260, h: 380 };
const MINI_DIAMETER = 104;

interface DropZoneProps {
  mini: boolean;
  onMiniChange: (mini: boolean) => void;
}

export default function DropZone({ mini, onMiniChange: setMini }: DropZoneProps) {
  const [drops, setDrops] = useState<PendingDropInfo[]>([]);
  // Both are the bare monogram on a transparent ground, so the circle's own
  // --cs-bg shows through; favicon.png is the variant for dark backgrounds.
  const logoSrc = useTheme() === "light" ? "/favicon_light.png" : "/favicon.png";
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The circle needs the page itself transparent, not just the window.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // An effect rather than part of the click handler, so the window can't end
  // up out of step with `mini`: a page reload resets the state to the full
  // view, and Fast Refresh re-runs this after an edit of the size above.
  useEffect(() => {
    const win = getCurrentWindow();
    const { w, h } = mini ? { w: MINI_DIAMETER, h: MINI_DIAMETER } : FULL_SIZE;
    const size = new LogicalSize(w, h);
    void (async () => {
      try {
        // min = max keeps the size fixed (see `build_dropzone_window`). Loosen
        // the bound that's in the way first, or GTK clamps the other one.
        if (mini) {
          await win.setMinSize(size);
          await win.setMaxSize(size);
        } else {
          await win.setMaxSize(size);
          await win.setMinSize(size);
        }
        await win.setSize(size);
        // The circle grows from its top-left corner, so near the right or
        // bottom edge the full view would end up partly off screen.
        await invoke("fit_dropzone_on_screen", { width: w, height: h });
      } catch (e) {
        console.error("dropzone resize failed", e);
      }
    })();
  }, [mini]);

  useEffect(() => {
    // A second start of the app with `--ablage` asks for the circle.
    const unlistenMini = listen<boolean>("dropzone-set-mini", (event) => setMini(event.payload));
    let saveTimer: number | undefined;
    const unlistenMoved = getCurrentWindow().onMoved(({ payload }) => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        invoke("save_dropzone_position", { x: payload.x, y: payload.y }).catch(() => {});
      }, 500);
    });
    return () => {
      window.clearTimeout(saveTimer);
      void unlistenMini.then((un) => un());
      void unlistenMoved.then((un) => un());
    };
  }, [setMini]);

  const load = useCallback(async () => {
    try {
      setDrops(await invoke<PendingDropInfo[]>("list_pending_drops"));
      setError(null);
    } catch {
      setError(t("dropzone.loadError"));
    }
  }, []);

  useEffect(() => {
    void load();
    // The main window removes entries too (on import), so mirror the
    // backend's change event instead of polling.
    const unlistenChanged = listen("pending-drops-changed", () => {
      void load();
    });
    return () => {
      void unlistenChanged.then((un) => un());
    };
  }, [load]);

  useEffect(() => {
    // Native drag & drop (see utils/fileDrop.ts): the webview reports
    // OS-level drops with real filesystem paths, which is exactly what
    // `add_items` needs later. HTML5 dragover/drop wouldn't give us paths.
    const unlisten = onFileDrop((event) => {
      // "enter" fires once when the pointer crosses into the window,
      // "over" repeatedly while moving inside it — both mean "highlight".
      if (event.type === "enter" || event.type === "over") {
        setDragOver(true);
      } else if (event.type === "drop") {
        setDragOver(false);
        // Shown after the reload, which clears the error line.
        const problem = dropProblem(event);
        const showProblem = () => {
          if (problem) setError(problem);
        };
        if (event.paths.length > 0) {
          invoke("add_pending_drops", { paths: event.paths })
            // The backend's change event normally refreshes us; reloading
            // here too keeps the list right even if nothing was inserted
            // (all paths already waiting) and no event was emitted.
            .then(() => load())
            .then(showProblem)
            .catch(() => setError(t("dropzone.loadError")));
        } else {
          showProblem();
        }
      } else {
        setDragOver(false);
      }
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, [load]);

  async function remove(path: string) {
    try {
      await invoke("remove_pending_drop", { path });
    } catch {
      // The change event (or the next load) reconciles anyway.
    }
    void load();
  }

  async function clearAll() {
    try {
      await invoke("remove_pending_drops", { paths: drops.map((d) => d.path) });
    } catch {
      // The change event (or the next load) reconciles anyway.
    }
    void load();
  }

  if (mini) {
    return (
      <div
        className={`dropzone-mini${dragOver ? " dropzone-mini--over" : ""}`}
        data-tauri-drag-region
        onDoubleClick={() => setMini(false)}
        // Right click puts the circle away into the tray icon.
        onContextMenu={(ev) => {
          ev.preventDefault();
          void invoke("minimize_dropzone");
        }}
        title={t("dropzone.restore")}
      >
        <img className="dropzone-mini__logo" src={logoSrc} alt="" draggable={false} data-tauri-drag-region />
        {drops.length > 0 && (
          <span className="dropzone-mini__count" data-tauri-drag-region>
            {drops.length}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`dropzone${dragOver ? " dropzone--over" : ""}`}
      // WebKitGTK's native menu ("Reload", "Inspect Element", …) otherwise
      // pops up on right-click. `App.tsx` does the same for the main
      // window, but that component isn't mounted here.
      onContextMenu={(ev) => ev.preventDefault()}
    >
      {/* The window has no system title bar, so this bar is what moves it.
          Tauri only starts a drag when the pressed element itself carries
          the attribute, hence on the texts too — but not on the ✕. */}
      <div className="dropzone__topbar" data-tauri-drag-region>
        <img className="dropzone__logo" src={logoSrc} alt="" draggable={false} data-tauri-drag-region />
        <div className="dropzone__heading" data-tauri-drag-region>
          <span className="dropzone__title" data-tauri-drag-region>
            {t("dropzone.title")}
          </span>
          {drops.length > 0 && (
            <span className="dropzone__count" data-tauri-drag-region>
              {drops.length} {t("dropzone.countSuffix")}
            </span>
          )}
        </div>
        <button
          className="dropzone__hide"
          onClick={() => setMini(true)}
          title={t("dropzone.minimize")}
          aria-label={t("dropzone.minimize")}
        >
          &minus;
        </button>
        <button
          className="dropzone__hide"
          onClick={() => void invoke("close_dropzone_window")}
          title={t("dropzone.hide")}
          aria-label={t("dropzone.hide")}
        >
          ✕
        </button>
      </div>

      <div className="dropzone__list">
        {error && <div className="dropzone__error">{error}</div>}
        {drops.length === 0 && !error ? (
          <div className="dropzone__empty">{t("dropzone.empty")}</div>
        ) : (
          drops.map((drop) => (
            <div
              className={`dropzone__row${drop.exists ? "" : " dropzone__row--missing"}`}
              key={drop.path}
              title={drop.path}
            >
              <span className="dropzone__icon">{KIND_ICON[drop.kind] ?? KIND_ICON.other}</span>
              <span className="dropzone__name">{drop.file_name}</span>
              <button
                className="dropzone__remove"
                onClick={() => void remove(drop.path)}
                title={t("dropzone.remove")}
                aria-label={t("dropzone.remove")}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="dropzone__hint">
        <span>{dragOver ? t("dropzone.dropHere") : t("dropzone.hint")}</span>
        {drops.length > 0 && (
          <button className="dropzone__clear" onClick={() => void clearAll()}>
            {t("dropzone.clearAll")}
          </button>
        )}
      </div>
    </div>
  );
}
