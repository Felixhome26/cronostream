import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, runBusy } from "../busy";
import { listen } from "@tauri-apps/api/event";
import { t, tn } from "../i18n";
import { useToast } from "../ToastContext";
import type { AddItemsResult, DuplicateMatch, EmailHeader, PendingDropInfo } from "../types";
import { fileUrl, loadMediaServerInfo, type MediaServerInfo } from "../utils/mediaServer";
import { isOutgoingFileDrag } from "../hooks/useFileDragOut";
import { globalFileDropsSuppressed } from "../utils/dropSuppression";
import { dropProblem, onFileDrop } from "../utils/fileDrop";
import { notifyDuplicatesFound } from "../utils/duplicateImportToast";
import { datedPathFor, ensureDateInfos, forgetDateChoices } from "../utils/dateChoices";
import { useProgress } from "../ProgressContext";
import DateChoiceSelect from "./DateChoiceSelect";
import { useEmailHeaders } from "../hooks/useEmailHeaders";
import { formatDateTime } from "../utils/datetime";
import { emailSenderName } from "../utils/timeline/itemText";

const KIND_ICON: Record<string, string> = {
  image: "🖼️",
  audio: "🎧",
  video: "🎬",
  document: "📄",
  email: "✉️",
  other: "❓",
};

const SPREADSHEET_EXTS = new Set(["csv", "xls", "xlsx"]);

/// Spreadsheets get their own icon even though they're `kind: "document"`
/// on the backend (see `fsbrowse::classify`) — everything else just falls
/// back to `KIND_ICON`.
function iconForDrop(drop: PendingDropInfo): string {
  const ext = drop.file_name.split(".").pop()?.toLowerCase();
  if (drop.kind === "document" && ext && SPREADSHEET_EXTS.has(ext)) {
    return "📊";
  }
  return KIND_ICON[drop.kind] ?? KIND_ICON.other;
}

// Same worker-pool size as the file browser's grid: these decodes compete
// for the same CPU/IPC budget, and the drop box holds a handful of files
// rather than a whole Pictures folder, so there's nothing to gain from
// pushing it higher.
const THUMBNAIL_CONCURRENCY = 2;

// A view preference, not project data — same reasoning as the timeline's
// cluster type filter: it just saves re-ticking the same box next time.
const CHECK_WITH_AI_STORAGE_KEY = "cronostream.checkWithAiAfterImport";
function loadCheckWithAiAfterImport(): boolean {
  try {
    return localStorage.getItem(CHECK_WITH_AI_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// Its manual counterpart — jumps into Datei-Operationen instead, restricted
// to the batch just inserted.
const MANUAL_REVIEW_STORAGE_KEY = "cronostream.manualReviewAfterImport";
function loadManualReviewAfterImport(): boolean {
  try {
    return localStorage.getItem(MANUAL_REVIEW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/// Only these ever produce a real visual preview — see `fsbrowse::can_add`
/// and the `get_file_preview` match in `browse_commands.rs`. Asking for a
/// preview of anything else is a guaranteed round-trip to an error, so the
/// tile goes straight to its generic icon instead.
function isPreviewable(drop: PendingDropInfo): boolean {
  if (!drop.exists) return false;
  if (drop.kind === "image" || drop.kind === "video") return true;
  if (drop.kind === "document") {
    const ext = drop.file_name.split(".").pop()?.toLowerCase();
    return ext === "pdf" || ext === "doc";
  }
  return false;
}

/// Sender and send date below a mail's subject.
function MailLines({ header }: { header: EmailHeader }) {
  const date = formatDateTime(header.date);
  return (
    <>
      {header.sender && (
        <div className="pending-tile__mail pending-tile__mail--sender" title={header.sender}>
          {emailSenderName(header.sender)}
        </div>
      )}
      {date && (
        <div className="pending-tile__mail">
          {t("email.date")}: {date}
        </div>
      )}
    </>
  );
}

interface PendingDropsProps {
  /// Called after files were actually added, so the timeline can refresh.
  onImported: () => void;
  onToast: (message: string) => void;
  /// Called right after a successful import when the "KI überprüfen" box is
  /// checked — `ids` are exactly the items just imported from this drop
  /// batch, so the KI-Metadaten export list can be scoped to only them
  /// instead of making the user find and select them among every other item
  /// in the project.
  onCheckWithAi: (ids: string[]) => void;
  /// Same idea, for "Daten manuell überprüfen / korrigieren" — jumps into
  /// Datei-Operationen restricted to the batch instead. Takes priority over
  /// `onCheckWithAi` when both boxes are checked; `alsoCheckWithAi` tells
  /// the browser to offer "Weiter zur KI-Prüfung" once that's done.
  onManualReview: (ids: string[], alsoCheckWithAi: boolean) => void;
}

/// Badge next to the "+" FAB showing how many files are waiting in the mini
/// window's drop box, plus the modal that lets them be reviewed and
/// imported. The import itself is the existing `add_items` command —
/// nothing drop-specific about it, the paths just came from a different
/// place.
export default function PendingDrops({ onImported, onToast, onCheckWithAi, onManualReview }: PendingDropsProps) {
  const showToast = useToast();
  const { startOperation, finishOperation } = useProgress();
  const [drops, setDrops] = useState<PendingDropInfo[]>([]);
  const [open, setOpen] = useState(false);
  // Highlights the whole timeline while a native drag hovers the main
  // window — same signal `DropZone.tsx` shows for the mini window, just
  // rendered as a full-window overlay here instead of a border.
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // Whether a successful import should jump straight into the KI-Metadaten
  // review instead of just confirming with a toast. A sticky preference —
  // most users either always want the review or never do.
  const [checkWithAiAfterImport, setCheckWithAiAfterImportState] = useState(loadCheckWithAiAfterImport);
  function setCheckWithAiAfterImport(value: boolean) {
    setCheckWithAiAfterImportState(value);
    try {
      localStorage.setItem(CHECK_WITH_AI_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // not critical — just means the box resets next launch
    }
  }
  const [manualReviewAfterImport, setManualReviewAfterImportState] = useState(loadManualReviewAfterImport);
  function setManualReviewAfterImport(value: boolean) {
    setManualReviewAfterImportState(value);
    try {
      localStorage.setItem(MANUAL_REVIEW_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // not critical — just means the box resets next launch
    }
  }
  // Dropped files that look like something already in the project (same
  // filename+size, confirmed by content hash for audio/documents — see
  // `check_pending_duplicates`), keyed by the dropped path. These are
  // excluded from the normal "Hinzufügen" count/flow; the comparison view
  // lets the user glance at both before discarding them individually or
  // all at once.
  const [duplicates, setDuplicates] = useState<Record<string, DuplicateMatch>>({});
  const duplicateCheckId = useRef(0);
  const [mediaServer, setMediaServer] = useState<MediaServerInfo | null>(null);
  // Accumulates across every "Hinzufügen" click while the panel stays
  // open, so closing it can summarize the whole visit in one toast rather
  // than only the most recent batch. A ref, not state: the close that an
  // emptied list triggers runs inside the same add, before a state update
  // would have reached closeModal, which then said "0 hinzugefügt".
  const insertedThisOpen = useRef(0);

  useEffect(() => {
    loadMediaServerInfo().then(setMediaServer).catch(() => {});
  }, []);

  useEffect(() => {
    if (open) insertedThisOpen.current = 0;
  }, [open]);

  // Re-checked whenever the open panel's contents change (a discard or an
  // import shrinks `drops`), so the duplicate markers never go stale.
  useEffect(() => {
    if (!open || drops.length === 0) {
      setDuplicates({});
      return;
    }
    const requestId = ++duplicateCheckId.current;
    invoke<Record<string, DuplicateMatch>>("check_pending_duplicates", { paths: drops.map((d) => d.path) })
      .then((result) => {
        if (duplicateCheckId.current === requestId) setDuplicates(result);
      })
      .catch(() => {
        if (duplicateCheckId.current === requestId) setDuplicates({});
      });
  }, [open, drops]);

  const mailHeaders = useEmailHeaders(
    open ? drops.filter((d) => d.kind === "email" && d.exists).map((d) => d.path) : [],
  );

  // The dates each waiting file could be filed under, for the tile dropdowns.
  useEffect(() => {
    if (open && drops.length > 0) void ensureDateInfos(drops.map((d) => d.path));
  }, [open, drops]);

  const load = useCallback(async () => {
    try {
      setDrops(await invoke<PendingDropInfo[]>("list_pending_drops", { includeProject: true }));
    } catch {
      // Nothing to show is the right fallback for a passive badge.
      setDrops([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const unlisten = listen("pending-drops-changed", () => {
      void load();
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, [load]);

  // Dropping files straight onto the main window (as opposed to the mini
  // drop-box window — see `DropZone.tsx`) goes one step further than just
  // queueing them: it opens this same review modal right away, since the
  // user is already looking at the project and almost certainly wants to
  // import now. Dropping more files while the modal is open just adds more
  // tiles to the grid — `add_pending_drops` + the `pending-drops-changed`
  // listener above already handle that for free.
  useEffect(() => {
    // A file being dragged OUT of CronoStream (useFileDragOut) passes over
    // this window too; releasing it here is a cancel, not an import.
    const ignored = () => isOutgoingFileDrag() || globalFileDropsSuppressed();
    const unlisten = onFileDrop((event) => {
      if (ignored()) {
        setDragOver(false);
        return;
      }
      if (event.type === "enter" || event.type === "over") {
        setDragOver(true);
      } else if (event.type === "drop") {
        setDragOver(false);
        const problem = dropProblem(event);
        if (problem) onToast(problem);
        const paths = event.paths;
        if (paths.length > 0) {
          invoke("add_pending_drops", { paths })
            .then(() => {
              void load();
              setOpen(true);
            })
            .catch(() => onToast(t("pending.addError")));
        }
      } else {
        setDragOver(false);
      }
    }, () => !ignored());
    return () => {
      void unlisten.then((un) => un());
    };
  }, [load, onToast]);

  // An empty drop box shouldn't leave a dangling modal open. Routed through
  // closeModal (not a bare setOpen(false)) so this counts as a close for
  // the summary toast too — only when the panel was actually open, so
  // mounting with an empty tray doesn't fire it.
  useEffect(() => {
    if (open && drops.length === 0) void closeModal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drops.length]);

  // ---- Thumbnails ---------------------------------------------------
  // Same machinery as the file browser grid, minus the IntersectionObserver:
  // the drop box is a short list the user reviews as a whole, so everything
  // in it is wanted — just throttled through a small worker pool so a dozen
  // decodes can't swamp the IPC bridge at once. `get_file_preview` is
  // backed by the persistent preview cache (keyed by path+mtime+size), so
  // files already seen in the file browser come back without any decode.
  const requested = useRef<Set<string>>(new Set());
  const queue = useRef<string[]>([]);
  const activeWorkers = useRef(0);
  const pendingPreviews = useRef<Record<string, string>>({});
  const flushScheduled = useRef(false);
  // While an import runs, stop *starting* new decodes — both compete for
  // CPU and the import is what the user is waiting on.
  const pausedForAdd = useRef(false);

  // Completed thumbnails are flushed in batches: one setState per image
  // would re-render the whole grid on every single completion.
  const schedulePreviewFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    setTimeout(() => {
      flushScheduled.current = false;
      const updates = pendingPreviews.current;
      pendingPreviews.current = {};
      if (Object.keys(updates).length === 0) return;
      setPreviews((prev) => ({ ...prev, ...updates }));
    }, 150);
  }, []);

  const drainQueue = useCallback(() => {
    if (pausedForAdd.current) return;
    while (activeWorkers.current < THUMBNAIL_CONCURRENCY && queue.current.length > 0) {
      const path = queue.current.shift()!;
      activeWorkers.current++;
      invoke<string>("get_file_preview", { path })
        .then((dataUrl) => {
          pendingPreviews.current[path] = dataUrl;
          schedulePreviewFlush();
        })
        .catch(() => {
          // leave uncached — the tile keeps showing its generic icon
        })
        .finally(() => {
          activeWorkers.current--;
          drainQueue();
        });
    }
  }, [schedulePreviewFlush]);

  // Queue previews only while the modal is actually open: generating them
  // for a closed modal is pure background work competing with the timeline.
  useEffect(() => {
    if (!open) return;
    for (const drop of drops) {
      if (!isPreviewable(drop) || requested.current.has(drop.path)) continue;
      requested.current.add(drop.path);
      queue.current.push(drop.path);
    }
    drainQueue();
  }, [open, drops, drainQueue]);

  // A path that leaves the drop box may come back later as a different file
  // (same name, re-dropped) — drop its cached preview so it isn't shown
  // stale. The backend cache still keys on mtime+size, so a re-fetch is
  // free when the file genuinely hasn't changed.
  useEffect(() => {
    const live = new Set(drops.map((d) => d.path));
    for (const path of requested.current) {
      if (!live.has(path)) requested.current.delete(path);
    }
    setPreviews((prev) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [path, url] of Object.entries(prev)) {
        if (live.has(path)) next[path] = url;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [drops]);

  // Esc closes, like the app's other modal layers.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  async function discard(path: string) {
    try {
      await invoke("remove_pending_drop", { path });
    } catch {
      // ignored — the change event reconciles the list
    }
    void load();
  }

  // One spinner for the whole import, including the reloads after it —
  // see `runBusy`.
  function addAll() {
    return runBusy(addAllNow);
  }

  async function addAllNow() {
    const paths = drops.filter((d) => d.can_add && d.exists).map((d) => d.path);
    if (paths.length === 0) return;
    // A file whose dates cannot be read cannot be imported either (missing, a folder).
    await ensureDateInfos(paths);
    const entries = paths.map(datedPathFor).filter((e) => e !== null);
    if (entries.length === 0) {
      onToast(t("pending.addError"));
      return;
    }
    setBusy(true);
    pausedForAdd.current = true;
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("pending.panelTitle"), total: entries.length });
    try {
      const result = await invoke<AddItemsResult>("add_items_with_dates", { entries, operationId });
      // `add_items` reports successes without their source path, so the
      // successful set is "everything we asked for, minus what it skipped".
      // Skipped ones (e.g. duplicates) stay in the drop box with their
      // reason shown, so the user decides whether to discard them.
      const skipped = new Set(result.skipped.map((s) => s.path));
      const addedPaths = entries.map((e) => e.path).filter((path) => !skipped.has(path));
      // One batch call, so the drop list reloads once instead of once per file.
      await invoke("remove_pending_drops", { paths: addedPaths }).catch(() => {});
      forgetDateChoices(addedPaths);
      // Counted before the reload: an empty list closes the panel from there.
      insertedThisOpen.current += result.added.length;
      await load();
      if (result.added.length > 0) onImported();
      // One toast only — two back-to-back setToast calls would just hide
      // the first. A skip reason is the more useful of the two (same
      // precedence as the file browser's own add flow).
      if (result.skipped.length > 0) {
        onToast(result.skipped[0].reason);
      } else if (result.added.length > 0) {
        onToast(tn(result.added.length, "pending.addedToastSuffix"));
      }
      // "Daten manuell überprüfen"/"Mit KI überprüfen" checked: jump
      // straight into that review instead of leaving the user to find
      // these files again on their own. Manual takes priority — see
      // `onManualReview`'s own doc comment.
      if (result.added.length > 0) {
        const ids = result.added.map((item) => item.id);
        if (manualReviewAfterImport) {
          onManualReview(ids, checkWithAiAfterImport);
          setOpen(false);
        } else if (checkWithAiAfterImport) {
          onCheckWithAi(ids);
          setOpen(false);
        }
      }
      notifyDuplicatesFound(showToast, result.duplicates, (dupIds) => onManualReview(dupIds, false));
    } catch (e) {
      onToast(typeof e === "string" ? e : t("pending.addError"));
    } finally {
      finishOperation(operationId);
      setBusy(false);
      pausedForAdd.current = false;
      drainQueue();
    }
  }

  // The drag-over overlay has to show even with an empty tray (dragging a
  // file in for the very first time), so it renders ahead of the "nothing
  // to show" bail-out below rather than being folded into the same return.
  if (drops.length === 0) {
    return dragOver ? (
      <div className="timeline-drop-overlay">
        <div className="timeline-drop-overlay__hint">{t("timeline.dropHere")}</div>
      </div>
    ) : null;
  }

  const addableCount = drops.filter((d) => d.can_add && d.exists && !duplicates[d.path]).length;
  const hasDuplicates = Object.keys(duplicates).length > 0;

  async function discardAllDuplicates() {
    const paths = Object.keys(duplicates).filter((p) => drops.some((d) => d.path === p));
    await invoke("remove_pending_drops", { paths }).catch(() => {});
    await load();
  }

  async function clearAll() {
    await invoke("remove_pending_drops", { paths: drops.map((d) => d.path) }).catch(() => {});
    await load();
  }

  // Always summarizes the visit on the way out — how many files this
  // panel actually added, and (so that number has context) how many the
  // project holds now in total.
  async function closeModal() {
    const inserted = insertedThisOpen.current;
    setOpen(false);
    try {
      const total = await invoke<number>("count_live_items");
      onToast(`${tn(inserted, "pending.addedToastSuffix")} · ${tn(total, "pending.closeToastTotalSuffix")}`);
    } catch {
      // no project open, or the count failed — closing still proceeds
    }
  }

  return (
    <>
      {dragOver && (
        <div className="timeline-drop-overlay">
          <div className="timeline-drop-overlay__hint">{t("timeline.dropHere")}</div>
        </div>
      )}

      {drops.length > 0 && (
        <button
          className="fab fab--pending"
          onClick={() => setOpen((v) => !v)}
          title={t("pending.badge")}
          aria-label={t("pending.badge")}
        >
          📥
          <span className="fab__badge">{drops.length}</span>
        </button>
      )}

      {open && (
        // Click-outside-to-close lives on the backdrop; the modal itself
        // stops propagation so clicks inside never reach it.
        <div className="pending-modal" onMouseDown={closeModal}>
          <div className="pending-modal__panel" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="pending-modal__header">
              <div className="pending-modal__title">{t("pending.panelTitle")}</div>
              <button
                className="icon-btn"
                onClick={closeModal}
                title={t("pending.close")}
                aria-label={t("pending.close")}
              >
                ✕
              </button>
            </div>

            <div className="pending-modal__explain">{t("pending.panelExplain")}</div>

            <div className="pending-modal__grid">
              {drops.map((drop) => {
                const preview = previews[drop.path];
                const duplicate = duplicates[drop.path];
                const mail = mailHeaders[drop.path];

                // A likely duplicate gets its own full-width row instead
                // of the normal single-thumbnail tile, so there's room
                // to actually compare the two images rather than
                // trusting a text label — see check_pending_duplicates.
                if (duplicate) {
                  const existingThumb =
                    mediaServer && duplicate.existing_thumbnail_path
                      ? fileUrl(mediaServer, duplicate.existing_thumbnail_path)
                      : null;
                  return (
                    <div className="pending-tile pending-tile--duplicate" key={drop.path} title={drop.path}>
                      <div className="pending-tile__compare">
                        <div className="pending-tile__compare-col">
                          {existingThumb ? (
                            <img className="pending-tile__compare-img" src={existingThumb} alt="" draggable={false} />
                          ) : (
                            <span className="pending-tile__icon">{KIND_ICON[drop.kind] ?? KIND_ICON.other}</span>
                          )}
                          <span className="pending-tile__compare-label">
                            {t("pending.duplicateExistingLabel")}
                          </span>
                          <span className="pending-tile__compare-meta">{duplicate.existing_display_name}</span>
                        </div>
                        <div className="pending-tile__compare-col">
                          {preview ? (
                            <img className="pending-tile__compare-img" src={preview} alt="" draggable={false} />
                          ) : (
                            <span className="pending-tile__icon">{KIND_ICON[drop.kind] ?? KIND_ICON.other}</span>
                          )}
                          <span className="pending-tile__compare-label">
                            {t("pending.duplicateDroppedLabel")}
                          </span>
                          <span className="pending-tile__compare-meta">{mail?.subject || drop.file_name}</span>
                          {mail && <MailLines header={mail} />}
                        </div>
                        <button
                          className="pending-tile__remove"
                          onClick={() => void discard(drop.path)}
                          title={t("dropzone.remove")}
                          aria-label={t("dropzone.remove")}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="pending-tile__note">{t("pending.duplicateNote")}</div>
                    </div>
                  );
                }

                const unusable = !drop.exists || !drop.can_add;
                return (
                  <div
                    className={`pending-tile${unusable ? " pending-tile--unusable" : ""}`}
                    key={drop.path}
                    title={drop.path}
                  >
                    <div className="pending-tile__thumb">
                      {preview ? (
                        <img className="pending-tile__img" src={preview} alt="" draggable={false} />
                      ) : (
                        <span className="pending-tile__icon">{iconForDrop(drop)}</span>
                      )}
                      <button
                        className="pending-tile__remove"
                        onClick={() => void discard(drop.path)}
                        title={t("dropzone.remove")}
                        aria-label={t("dropzone.remove")}
                      >
                        ✕
                      </button>
                    </div>
                    {drop.exists && drop.can_add && <DateChoiceSelect path={drop.path} disabled={busy} />}
                    <div className="pending-tile__name" title={mail ? drop.file_name : undefined}>
                      {mail?.subject || drop.file_name}
                    </div>
                    {mail && <MailLines header={mail} />}
                    {/* A file can disappear between being dropped and being
                        imported — say so plainly instead of letting the
                        import fail with a technical error later. */}
                    {!drop.exists ? (
                      <div className="pending-tile__note">{t("pending.missing")}</div>
                    ) : (
                      !drop.can_add && (
                        <div className="pending-tile__note">{t("pending.notSupported")}</div>
                      )
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pending-modal__footer">
              <div className="pending-modal__checkboxes">
                <label className="pending-modal__ai-checkbox">
                  <input
                    type="checkbox"
                    checked={manualReviewAfterImport}
                    onChange={(ev) => setManualReviewAfterImport(ev.target.checked)}
                  />
                  <span>{t("pending.manualReviewAfterImport")}</span>
                </label>
                <label className="pending-modal__ai-checkbox">
                  <input
                    type="checkbox"
                    checked={checkWithAiAfterImport}
                    onChange={(ev) => setCheckWithAiAfterImport(ev.target.checked)}
                  />
                  <span>{t("pending.checkWithAiAfterImport")}</span>
                </label>
              </div>
              {hasDuplicates && (
                <button className="btn--text" onClick={() => void discardAllDuplicates()} disabled={busy}>
                  {t("pending.discardAllDuplicates")}
                </button>
              )}
              {drops.length > 0 && (
                <button className="btn--text" onClick={() => void clearAll()} disabled={busy}>
                  {t("pending.clearAll")}
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={() => void addAll()}
                disabled={busy || addableCount === 0}
              >
                {busy ? t("pending.adding") : `${t("pending.add")} (${addableCount})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
