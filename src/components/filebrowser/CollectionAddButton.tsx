import { useEffect, useState } from "react";
import { invoke, runBusy } from "../../busy";
import type { AddItemsResult } from "../../types";
import type { PathCollection } from "../../hooks/useCollection";
import type { PickedList } from "../../hooks/usePickedList";
import { t, tn } from "../../i18n";
import { useToast } from "../../ToastContext";
import { notifyDuplicatesFound } from "../../utils/duplicateImportToast";
import { datedPathFor, ensureDateInfos, forgetDateChoices } from "../../utils/dateChoices";
import { useProgress } from "../../ProgressContext";

// Same sticky preference the drop box uses (see `PendingDrops`): whether a
// finished import jumps straight into the KI-Metadaten review.
const CHECK_WITH_AI_STORAGE_KEY = "cronostream.checkWithAiAfterImport";
// Its manual counterpart — jumps into Datei-Operationen instead, restricted
// to the batch just inserted.
const MANUAL_REVIEW_STORAGE_KEY = "cronostream.manualReviewAfterImport";

function loadCheckWithAi(): boolean {
  try {
    return localStorage.getItem(CHECK_WITH_AI_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadManualReview(): boolean {
  try {
    return localStorage.getItem(MANUAL_REVIEW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

interface Props {
  collection: PathCollection;
  /// Marks made in the single-image view count towards the same list.
  picks: PickedList;
  addedPaths: Set<string>;
  onInserted: (insertedPaths: string[], message: string) => void;
  onCheckWithAi: (ids: string[]) => void;
  /// Jumps into Datei-Operationen restricted to the batch just inserted —
  /// called instead of `onCheckWithAi` when "Daten manuell überprüfen /
  /// korrigieren" is ticked, regardless of whether the AI checkbox is also
  /// ticked (manual review always comes first; see its own second
  /// argument). `FileBrowser` is the one that then offers "Weiter zur
  /// KI-Prüfung" if `alsoCheckWithAi` is true.
  onManualReview: (ids: string[], alsoCheckWithAi: boolean) => void;
}

/// Floating "add to timeline" button, shown over every adding view of the
/// file manager while anything is collected. Opens a confirmation (with the
/// same "check with AI afterwards" offer as the drop box) before the whole
/// collection is added at once.
export default function CollectionAddButton({
  collection,
  picks,
  addedPaths,
  onInserted,
  onCheckWithAi,
  onManualReview,
}: Props) {
  const showToast = useToast();
  const { startOperation, finishOperation } = useProgress();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkWithAi, setCheckWithAiState] = useState(loadCheckWithAi);
  const [manualReview, setManualReviewState] = useState(loadManualReview);

  const all = new Set<string>([...collection.paths, ...picks.picked.keys()]);
  const paths = [...all].filter((p) => !addedPaths.has(p));

  // Marks for files that have since become part of the stream (added via
  // another route) would otherwise sit in the list forever.
  useEffect(() => {
    const stale = [...all].filter((p) => addedPaths.has(p));
    if (stale.length === 0) return;
    collection.remove(stale);
    stale.forEach((p) => picks.remove(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedPaths]);

  useEffect(() => {
    if (!open || busy) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy]);

  useEffect(() => {
    if (open && paths.length === 0) setOpen(false);
  }, [open, paths.length]);

  function setCheckWithAi(value: boolean) {
    setCheckWithAiState(value);
    try {
      localStorage.setItem(CHECK_WITH_AI_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // not critical
    }
  }

  function setManualReview(value: boolean) {
    setManualReviewState(value);
    try {
      localStorage.setItem(MANUAL_REVIEW_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // not critical
    }
  }

  function discard(path: string) {
    collection.remove([path]);
    picks.remove(path);
  }

  // One spinner for the whole import, including the reloads after it —
  // see `runBusy`.
  function addAll() {
    return runBusy(addAllNow);
  }

  async function addAllNow() {
    const toAdd = [...paths];
    if (toAdd.length === 0) return;
    setBusy(true);
    await ensureDateInfos(toAdd);
    const entries = toAdd.map(datedPathFor).filter((e) => e !== null);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.collect.title"), total: entries.length });
    try {
      if (entries.length === 0) throw t("pending.addError");
      const result = await invoke<AddItemsResult>("add_items_with_dates", { entries, operationId });
      const sent = entries.map((e) => e.path);
      const skipped = new Set(result.skipped.map((s) => s.path));
      const inserted = sent.filter((p) => !skipped.has(p));
      // Everything that was processed leaves the list — a skipped duplicate
      // would otherwise stay stuck on it. The skip reason is toasted below.
      // A path whose dates could not be read was never sent, so it stays
      // listed rather than vanishing as if it had been imported.
      collection.remove(sent);
      sent.forEach((p) => picks.remove(p));
      forgetDateChoices(sent);
      if (result.added.length > 0) {
        onInserted(inserted, `${t("browser.addedToast")} (${result.added.length})`);
      }
      if (result.skipped.length > 0) showToast(result.skipped[0].reason);
      else if (sent.length < toAdd.length) showToast(t("pending.addError"));
      if (sent.length === toAdd.length) setOpen(false);
      if (result.added.length > 0) {
        const ids = result.added.map((item) => item.id);
        if (manualReview) {
          onManualReview(ids, checkWithAi);
        } else if (checkWithAi) {
          onCheckWithAi(ids);
        }
      }
      notifyDuplicatesFound(showToast, result.duplicates, (dupIds) => onManualReview(dupIds, false));
    } catch (e) {
      showToast(typeof e === "string" ? e : t("pending.addError"));
    } finally {
      finishOperation(operationId);
      setBusy(false);
    }
  }

  if (paths.length === 0) return null;

  return (
    <>
      <button className="collect-fab" onClick={() => setOpen(true)} title={t("browser.collect.title")}>
        <span className="collect-fab__icon">📥</span>
        {t("browser.collect.button")}
        <span className="collect-fab__count">{paths.length}</span>
      </button>

      {open && (
        <div className="modal-overlay" onMouseDown={() => !busy && setOpen(false)}>
          <div className="modal-card modal-card--wide" onMouseDown={(ev) => ev.stopPropagation()}>
            <h3 className="modal-card__title">{t("browser.collect.title")}</h3>
            <p className="modal-card__body">
              {tn(paths.length, "browser.collect.explain")}
            </p>
            <div className="collect-list">
              {paths.map((p) => (
                <div className="collect-list__row" key={p} title={p}>
                  <span className="collect-list__name">{baseName(p)}</span>
                  <button
                    className="icon-btn"
                    disabled={busy}
                    onClick={() => discard(p)}
                    title={t("browser.collect.remove")}
                    aria-label={t("browser.collect.remove")}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <label className="collect-ai">
              <input
                type="checkbox"
                checked={manualReview}
                disabled={busy}
                onChange={(e) => setManualReview(e.target.checked)}
              />
              {t("pending.manualReviewAfterImport")}
            </label>
            <label className="collect-ai">
              <input type="checkbox" checked={checkWithAi} disabled={busy} onChange={(e) => setCheckWithAi(e.target.checked)} />
              {t("pending.checkWithAiAfterImport")}
            </label>
            <div className="modal-card__actions">
              <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
                {t("browser.folderCancel")}
              </button>
              <button className="btn btn--primary" disabled={busy} onClick={addAll}>
                {t("browser.collect.confirm")} ({paths.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
