import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import { listen } from "@tauri-apps/api/event";
import { t, tCount } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import { useToast } from "../../ToastContext";
import { useConfirm } from "../../ConfirmContext";
import { formatDateTime } from "../../utils/datetime";
import { describePhaseChange, isPhaseAction } from "../../utils/phases";
import { fileUrl, loadMediaServerInfo, type MediaServerInfo } from "../../utils/mediaServer";
import type {
  ActionLogAction,
  ActionLogConflict,
  ActionLogEntry,
  ActionLogProgress,
  ActionLogType,
  UndoOutcome,
} from "../../types";

const ACTION_LOG_PROGRESS_EVENT = "action-log-progress";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

// Onboarding, hint 3 of 3 (see the in-app-help guide) — same one-shot toast
// pattern as Timeline's zoom hint and FileBrowser's copy-protection hint.
const SAFETY_NET_HINT_DISMISSED_KEY = "cronostream.onboarding.safetyNetHintShown";
const SAFETY_NET_HINT_VERSION = "1";
let safetyNetHintShownThisSession = false;

// Fast to appear, instant to disappear — skimming a long log means passing
// over many rows without triggering a preview for each one, but pausing on
// one should show it without a noticeable lag.
const PREVIEW_SHOW_DELAY_MS = 120;
const PREVIEW_TILE_WIDTH = 160;
const PREVIEW_TILE_HEIGHT = 120;
const PREVIEW_GAP = 8;

interface HoverPreview {
  url: string;
  top: number;
  left: number;
}

/// What the undo flow is currently waiting on the user to answer. Both
/// questions come back from the backend rather than being decided here —
/// see `UndoOutcome` in `action_log_commands.rs`.
type PendingUndo =
  | { target: UndoTarget; kind: "conflicts"; conflicts: ActionLogConflict[] }
  | { target: UndoTarget; kind: "copyDecision"; labels: string[]; cascade: boolean };

type UndoTarget = { kind: "action"; id: number } | { kind: "entry"; id: number };

function formatWhen(millis: number): string {
  return formatDateTime(millis) ?? String(millis);
}

/// Shows a stored date the way the rest of the app does, and anything that
/// isn't a date (a display name, a setting value) unchanged.
function formatValue(value: string | null): string {
  if (value == null || value === "") return t("log.value.none");
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return formatDateTime(parsed) ?? value;
  }
  return value;
}

function actionTypeLabel(type: ActionLogType): string {
  return t(`log.type.${type}`);
}

/// The one-line summary of an action. A single-file action says what
/// happened to that file; a bulk one counts, which is the whole point of
/// grouping ("147 Dateien eingefügt").
function summaryFor(action: ActionLogAction): string {
  const single = action.entryCount === 1 ? action.entries[0] : undefined;
  if (single) {
    switch (action.actionType) {
      case "rename":
        return `${formatValue(single.beforeValue)} → ${formatValue(single.afterValue)}`;
      case "date_change":
      case "ai_date_change":
        return `${single.label}: ${formatValue(single.beforeValue)} → ${formatValue(single.afterValue)}`;
      case "setting_change":
        return `${single.label}: ${formatValue(single.beforeValue)} → ${formatValue(single.afterValue)}`;
      case "phase_update":
      case "phase_group_update":
      case "phase_group_reorder":
      case "phase_group_remove": {
        const change = describePhaseChange(action.actionType, single.beforeValue, single.afterValue);
        return change ? `${single.label} — ${change}` : single.label;
      }
      default:
        return single.label;
    }
  }
  return `${action.entryCount} ${t(`log.count.${action.actionType}`)}`;
}

/// The action history, with the undo controls. This is the app's safety
/// net: because every action can be reversed from here, the destructive
/// flows elsewhere no longer ask "are you sure?" before removing anything.
export default function ProtocolTab({ onUndone }: { onUndone?: () => void } = {}) {
  const [actions, setActions] = useState<ActionLogAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandingId, setExpandingId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ActionLogProgress | null>(null);
  const { startOperation, finishOperation } = useProgress();
  const showToast = useToast();
  const confirm = useConfirm();
  const [hasMore, setHasMore] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [entriesByAction, setEntriesByAction] = useState<Record<number, ActionLogEntry[]>>({});
  const [selectedForPurge, setSelectedForPurge] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingUndo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mediaServer, setMediaServer] = useState<MediaServerInfo | null>(null);
  const [preview, setPreview] = useState<HoverPreview | null>(null);
  const previewTimer = useRef<number | null>(null);

  useEffect(() => {
    loadMediaServerInfo().then(setMediaServer).catch(() => setMediaServer(null));
  }, []);

  // Onboarding, hint 3 of 3: the first time this tab is opened, name the
  // safety net it is — every other "are you sure?" dialog in the app was
  // deliberately dropped in favor of this.
  useEffect(() => {
    if (safetyNetHintShownThisSession) return;
    safetyNetHintShownThisSession = true;
    if (localStorage.getItem(SAFETY_NET_HINT_DISMISSED_KEY) === SAFETY_NET_HINT_VERSION) return;
    showToast(t("log.onboardingSafetyNetHint"), {
      durationMs: 8000,
      action: {
        label: t("browser.dontShowAgain"),
        onClick: () => localStorage.setItem(SAFETY_NET_HINT_DISMISSED_KEY, SAFETY_NET_HINT_VERSION),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The backend stats every file behind a page of the log off the
  // project-wide lock (see action_log_commands.rs), which keeps the rest
  // of the app responsive but can still take a while on a slow disk — this
  // is what tells the progress bar below how far along that is.
  useEffect(() => {
    const unlisten = listen<ActionLogProgress>(ACTION_LOG_PROGRESS_EVENT, (event) => {
      setProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Soft-removed files keep their thumbnail (the row and its file both
  // survive), so this works there unchanged; a permanently deleted file has
  // no `thumbnailPath` left (see EntryView in action_log_commands.rs) and
  // simply never schedules a preview.
  const schedulePreview = useCallback(
    (thumbnailPath: string | null | undefined, target: HTMLElement) => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
      if (!thumbnailPath || !mediaServer) return;
      const url = fileUrl(mediaServer, thumbnailPath);
      previewTimer.current = window.setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const maxLeft = window.innerWidth - PREVIEW_TILE_WIDTH - 4;
        setPreview({
          url,
          left: Math.min(maxLeft, Math.max(4, rect.left)),
          top: Math.max(4, rect.top - PREVIEW_TILE_HEIGHT - PREVIEW_GAP),
        });
      }, PREVIEW_SHOW_DELAY_MS);
    },
    [mediaServer],
  );

  const cancelPreview = useCallback(() => {
    if (previewTimer.current) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    setPreview(null);
  }, []);

  // A shown tile's position is computed once, from the anchor's rect at
  // hover time — scrolling the list would leave it floating over the wrong
  // row, so any scroll just dismisses it.
  useEffect(() => {
    if (!preview) return;
    window.addEventListener("scroll", cancelPreview, { capture: true });
    return () => window.removeEventListener("scroll", cancelPreview, { capture: true });
  }, [preview, cancelPreview]);

  // Searching re-queries the backend (labels live in the database, and a
  // page of actions in memory is not the whole log), so the keystrokes get
  // debounced rather than firing a query each.
  const debounce = useRef<number | null>(null);
  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [rawQuery]);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      setProgress(null);
      try {
        const page = await invoke<ActionLogAction[]>("list_action_log", {
          query: query || null,
          limit: PAGE_SIZE,
          offset,
        });
        setActions((prev) => (append ? [...prev, ...page] : page));
        setHasMore(page.length === PAGE_SIZE);
      } catch (err) {
        setMessage(String(err));
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [query],
  );

  // A new search starts a fresh list, and anything expanded belonged to the
  // old one.
  useEffect(() => {
    setExpanded(new Set());
    setEntriesByAction({});
    void load(0, false);
  }, [load]);

  const reload = useCallback(async () => {
    setExpanded(new Set());
    setEntriesByAction({});
    setSelectedForPurge(new Set());
    await load(0, false);
  }, [load]);

  async function toggleExpanded(action: ActionLogAction) {
    const next = new Set(expanded);
    if (next.has(action.id)) {
      next.delete(action.id);
      setExpanded(next);
      return;
    }
    next.add(action.id);
    setExpanded(next);

    // A bulk action's per-file rows are fetched on demand — opening the tab
    // must not pull in every entry of every import ever made.
    if (!entriesByAction[action.id] && action.entries.length < action.entryCount) {
      setExpandingId(action.id);
      setProgress(null);
      try {
        const entries = await invoke<ActionLogEntry[]>("list_action_entries", {
          actionId: action.id,
        });
        setEntriesByAction((prev) => ({ ...prev, [action.id]: entries }));
      } catch (err) {
        setMessage(String(err));
      } finally {
        setExpandingId(null);
        setProgress(null);
      }
    }
  }

  function entriesOf(action: ActionLogAction): ActionLogEntry[] {
    return entriesByAction[action.id] ?? action.entries;
  }

  /// Runs an undo and routes whatever the backend answers: done, refused
  /// with a reason, or a question that has to be put to the user first.
  const runUndo = useCallback(
    async (target: UndoTarget, deleteCopy: boolean | null, cascade: boolean) => {
      setBusy(true);
      try {
        const command = target.kind === "action" ? "undo_action" : "undo_entry";
        const args =
          target.kind === "action"
            ? { actionId: target.id, deleteCopy, cascade }
            : { entryId: target.id, deleteCopy, cascade };
        const outcome = await invoke<UndoOutcome>(command, args);

        switch (outcome.status) {
          case "done":
            setPending(null);
            setMessage(`${outcome.undone} ${t("log.undoneSuffix")}`);
            await reload();
            onUndone?.();
            break;
          case "blocked":
            setPending(null);
            setMessage(outcome.reason);
            break;
          case "conflicts":
            setPending({ target, kind: "conflicts", conflicts: outcome.conflicts });
            break;
          case "needsCopyDecision":
            setPending({ target, kind: "copyDecision", labels: outcome.labels, cascade });
            break;
        }
      } catch (err) {
        setPending(null);
        setMessage(String(err));
      } finally {
        setBusy(false);
      }
    },
    [reload, onUndone],
  );

  /// Every file in the visible log that is off the timeline but still on
  /// disk — the candidates for permanently clearing out.
  const purgeable = useMemo(() => {
    const ids = new Map<string, string>();
    for (const action of actions) {
      for (const entry of entriesOf(action)) {
        if (entry.canPurge && entry.itemId) ids.set(entry.itemId, entry.label);
      }
    }
    return ids;
  }, [actions, entriesByAction]);

  async function purgeSelected() {
    if (selectedForPurge.size === 0 || busy) return;
    const confirmed = await confirm({
      title: `${t("log.purgeSelected")}?`,
      body: `${tCount(selectedForPurge.size, "fileOps.fileSelected", "fileOps.filesSelected")}. ${t("log.confirmPurgeBody")}`,
      confirmLabel: t("log.purgeSelected"),
    });
    if (!confirmed) return;
    setBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("log.purgeSelected"), total: selectedForPurge.size });
    try {
      const purged = await invoke<number>("purge_items", {
        itemIds: Array.from(selectedForPurge),
        operationId,
      });
      setMessage(`${purged} ${t("log.purgedSuffix")}`);
      await reload();
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
      finishOperation(operationId);
    }
  }

  function togglePurgeSelection(itemId: string) {
    setSelectedForPurge((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <div className="protocol">
      <div className="protocol__toolbar">
        <input
          className="protocol__search"
          type="search"
          value={rawQuery}
          onChange={(ev) => setRawQuery(ev.target.value)}
          placeholder={t("log.searchPlaceholder")}
        />
        {purgeable.size > 0 && (
          <div className="protocol__bulk">
            <button
              className="btn--text"
              onClick={() => setSelectedForPurge(new Set(purgeable.keys()))}
              disabled={busy}
            >
              {t("log.selectAll")}
            </button>
            <button
              className="btn--text"
              onClick={() => setSelectedForPurge(new Set())}
              disabled={busy || selectedForPurge.size === 0}
            >
              {t("log.deselectAll")}
            </button>
            <button
              className="btn btn--danger"
              onClick={purgeSelected}
              disabled={busy || selectedForPurge.size === 0}
            >
              {t("log.purgeSelected")} ({selectedForPurge.size})
            </button>
          </div>
        )}
      </div>

      <p className="protocol__hint">{t("log.hint")}</p>

      {message && (
        <div className="protocol__message">
          <span>{message}</span>
          <button className="btn--text" onClick={() => setMessage(null)} title={t("toast.close")} aria-label={t("toast.close")}>
            ✕
          </button>
        </div>
      )}

      {(loading || expandingId !== null) && progress && progress.total > 0 && (
        <div className="protocol__progress">
          <div className="progress-bar">
            <div
              className="progress-bar__fill"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <p className="progress-bar__status">
            {progress.done} / {progress.total}
          </p>
        </div>
      )}

      {loading && actions.length === 0 && !progress ? (
        <p className="protocol__empty">{t("log.loading")}</p>
      ) : actions.length === 0 ? (
        <p className="protocol__empty">{query ? t("log.noMatches") : t("log.empty")}</p>
      ) : (
        <ul className="protocol__list">
          {actions.map((action) => {
            const entries = entriesOf(action);
            const isOpen = expanded.has(action.id);
            const fullyReverted = action.revertedCount >= action.entryCount;
            const isTree = action.entryCount > 1;

            return (
              <li key={action.id} className="protocol__action">
                <div className="protocol__action-row">
                  {isTree ? (
                    <button
                      className="protocol__twisty"
                      onClick={() => void toggleExpanded(action)}
                      aria-expanded={isOpen}
                      title={isOpen ? t("log.collapse") : t("log.expand")}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  ) : (
                    <span className="protocol__twisty protocol__twisty--leaf">•</span>
                  )}

                  <div className="protocol__action-text">
                    <span className="protocol__type">{actionTypeLabel(action.actionType)}</span>
                    <span
                      className="protocol__summary"
                      onMouseEnter={
                        action.entryCount === 1
                          ? (ev) => schedulePreview(action.entries[0]?.thumbnailPath, ev.currentTarget)
                          : undefined
                      }
                      onMouseLeave={action.entryCount === 1 ? cancelPreview : undefined}
                    >
                      {summaryFor(action)}
                    </span>
                  </div>

                  <span className="protocol__when">{formatWhen(action.performedAt)}</span>

                  {fullyReverted ? (
                    <span className="protocol__reverted">{t("log.alreadyUndone")}</span>
                  ) : action.actionType === "purge" ? (
                    <span className="protocol__reverted">{t("log.notUndoable")}</span>
                  ) : (
                    <button
                      className="btn--text"
                      onClick={() => void runUndo({ kind: "action", id: action.id }, null, false)}
                      disabled={busy}
                    >
                      {isTree ? t("log.undoAll") : t("log.undo")}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <ul className="protocol__entries">
                    {entries.map((entry) => (
                      <li key={entry.id} className="protocol__entry">
                        {entry.canPurge && entry.itemId && (
                          <input
                            type="checkbox"
                            checked={selectedForPurge.has(entry.itemId)}
                            onChange={() => togglePurgeSelection(entry.itemId!)}
                            title={t("log.selectForPurge")}
                          />
                        )}
                        <span
                          className="protocol__entry-label"
                          onMouseEnter={(ev) => schedulePreview(entry.thumbnailPath, ev.currentTarget)}
                          onMouseLeave={cancelPreview}
                        >
                          {entry.label}
                        </span>
                        {isPhaseAction(action.actionType)
                          ? (() => {
                              const change = describePhaseChange(action.actionType, entry.beforeValue, entry.afterValue);
                              return change ? <span className="protocol__entry-change">{change}</span> : null;
                            })()
                          : entry.beforeValue != null && (
                              <span className="protocol__entry-change">
                                {formatValue(entry.beforeValue)} → {formatValue(entry.afterValue)}
                              </span>
                            )}
                        {entry.reverted && <span className="protocol__reverted">{t("log.alreadyUndone")}</span>}
                        {!entry.reverted && entry.canUndo && (
                          <button
                            className="btn--text"
                            onClick={() => void runUndo({ kind: "entry", id: entry.id }, null, false)}
                            disabled={busy}
                          >
                            {t("log.undo")}
                          </button>
                        )}
                        {/* Independent of `reverted`: for an Import entry, canPurge only
                            turns true once its own undo reverted it (see can_purge in
                            action_log_commands.rs) — "already undone" and "orphaned copy
                            can be purged" both apply at the same time there. */}
                        {entry.canPurge && entry.itemId && (
                          <button
                            className="btn--text protocol__purge"
                            onClick={() => {
                              setSelectedForPurge(new Set([entry.itemId!]));
                            }}
                            disabled={busy}
                          >
                            {t("log.purgeOne")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <button
          className="btn--text protocol__more"
          onClick={() => void load(actions.length, true)}
          disabled={loading}
        >
          {t("log.loadMore")}
        </button>
      )}

      {preview && (
        <div
          className="protocol__preview-tile"
          style={{ left: preview.left, top: preview.top }}
        >
          <img src={preview.url} alt="" />
        </div>
      )}

      {pending?.kind === "conflicts" && (
        <div className="modal-overlay">
          <div className="modal-card modal-card--wide">
            <h3 className="modal-card__title">{t("log.conflictTitle")}</h3>
            <p className="modal-card__body">{t("log.conflictBody")}</p>
            <ul className="protocol__conflicts">
              {pending.conflicts.map((conflict) => (
                <li key={conflict.entryId}>
                  <strong>{actionTypeLabel(conflict.actionType)}</strong> — {conflict.label}
                  <span className="protocol__when">{formatWhen(conflict.performedAt)}</span>
                </li>
              ))}
            </ul>
            <div className="modal-card__actions">
              <button className="btn--text" onClick={() => setPending(null)} disabled={busy}>
                {t("log.cancel")}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void runUndo(pending.target, null, true)}
                disabled={busy}
              >
                {t("log.conflictUndoAll")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pending?.kind === "copyDecision" && (
        <div className="modal-overlay">
          <div className="modal-card modal-card--wide">
            <h3 className="modal-card__title">{t("log.copyTitle")}</h3>
            <p className="modal-card__body">{t("log.copyBody")}</p>
            <ul className="protocol__conflicts">
              {pending.labels.slice(0, 10).map((label) => (
                <li key={label}>{label}</li>
              ))}
              {pending.labels.length > 10 && <li>…</li>}
            </ul>
            <p className="modal-card__hint">{t("log.copySourceNote")}</p>
            <div className="modal-card__actions">
              <button className="btn--text" onClick={() => setPending(null)} disabled={busy}>
                {t("log.cancel")}
              </button>
              <button
                className="btn--text"
                onClick={() => void runUndo(pending.target, false, pending.cascade)}
                disabled={busy}
              >
                {t("log.copyKeep")}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void runUndo(pending.target, true, pending.cascade)}
                disabled={busy}
              >
                {t("log.copyDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
