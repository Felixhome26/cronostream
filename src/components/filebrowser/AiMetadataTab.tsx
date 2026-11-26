import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../busy";
import { writeText as writeClipboardText, readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { confidenceLabel, t } from "../../i18n";
import type { ActionLogEntry, AiApplyEntry, AiApplyResult, AiSuggestion } from "../../types";
import { combineDateWithTimeOfDay, toDateOnlyValue } from "../../utils/datetime";
import { useToast } from "../../ToastContext";
import { useProgress } from "../../ProgressContext";
import AiSuggestionDetail from "./AiSuggestionDetail";
import AiFileSelectStep from "./AiFileSelectStep";
import AiInstructionsStep from "./AiInstructionsStep";
import { formatDate, formatDateTime } from "../../utils/datetime";

type Step = "select" | "instructions" | "import";

// Same versioning scheme as the grid's and viewer's one-time hints (see
// `SELECTION_HINT_VERSION` in `FileTileGrid.tsx`): bump this if the wording
// below ever changes enough that even someone who dismissed it should see
// it again.
const COPY_HINT_DISMISSED_KEY = "cronostream.aiMetadataTab.copyHintDismissed";
const COPY_HINT_VERSION = "1";

// Compared by calendar day only (local time), not time of day — the AI
// guessing a different hour on the same day the item already had doesn't
// move it anywhere on the (day-granular) timeline, so it still counts as
// "unchanged" for the review screen's highlight and filter.
function sameDay(isoA: string | null, isoB: string): boolean {
  if (!isoA) return false;
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// The review screen never shows or edits a time of day (see `sameDay` and
// the suggested-date input below) — only the date is ever in question
// here, so showing a time next to it would be misleading/redundant.
function formatDateOnly(iso: string): string {
  return formatDate(iso) ?? iso;
}

interface Props {
  /// Forwarded to `AiFileSelectStep` — see its own doc comment.
  restrictToIds?: string[];
  /// Called when the user dismisses the "N Daten übernommen" confirmation
  /// after applying suggestions — `FileBrowser` wires this to closing the
  /// whole browser overlay (back to the timeline), since finishing a
  /// correction round is a natural point to leave the file manager, not
  /// just switch tabs within it.
  onClose?: () => void;
}

export default function AiMetadataTab({ restrictToIds, onClose }: Props) {
  const showToast = useToast();
  const { startOperation, finishOperation } = useProgress();
  const [step, setStep] = useState<Step>("select");
  const [toast, setToast] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  // Keyed by suggestion id. Valid rows start pre-accepted (with the
  // suggested date) so reviewing a long list is mostly "scan and uncheck
  // the odd one out" rather than clicking every single row — the actual
  // write only happens once the user presses "Übernehmen", so this is
  // still a reviewed, explicit action, never an automatic one.
  const [accepted, setAccepted] = useState<Map<string, boolean>>(new Map());
  const [editedDates, setEditedDates] = useState<Map<string, string>>(new Map());
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [detailSuggestion, setDetailSuggestion] = useState<AiSuggestion | null>(null);
  // Set once `applyAccepted` succeeds — shown as a dedicated confirmation
  // dialog rather than the auto-dismissing toast, since silently vanishing
  // after a couple of seconds made it too easy to miss that dates had
  // actually been written.
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  // The per-file before/after rows of that same apply, fetched via the
  // action log so the confirmation dialog can offer "Änderungen anzeigen" —
  // view-only here; undoing a change stays the Protokoll tab's job.
  const [changeEntries, setChangeEntries] = useState<ActionLogEntry[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  // The ids the most recent clipboard copy sent to the AI — compared against
  // `receivedIds` to find which ones never came back, regardless of how many
  // import rounds it took to collect them.
  const [expectedIds, setExpectedIds] = useState<string[]>([]);
  // Every id ever seen in an imported round, kept even after the matching
  // suggestion is removed from `suggestions` once applied — `missingIds`
  // must not count an already-applied (and thus no longer listed) id as
  // "the AI never answered this", so this tracks "answered at all",
  // separately from "still pending review".
  const [receivedIds, setReceivedIds] = useState<Set<string>>(new Set());
  const [followupBusy, setFollowupBusy] = useState(false);
  // Right after copying, nothing has been imported yet, so "every expected
  // id is missing" would be trivially true — not an incomplete AI reply,
  // just a reply that hasn't happened yet. Only start treating unmatched
  // expected ids as "the AI skipped these" once at least one import round
  // has actually completed.
  const [hasImportedOnce, setHasImportedOnce] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleFilesChosen(ids: string[]) {
    setSelectedIds(ids);
    setStep("instructions");
  }

  function handleCopied(ids: string[], savedAsFile = false) {
    setExpectedIds(ids);
    setHasImportedOnce(false);
    setReceivedIds(new Set());
    if (localStorage.getItem(COPY_HINT_DISMISSED_KEY) !== COPY_HINT_VERSION) {
      showToast(t(savedAsFile ? "browser.aiMetadata.savedNotification" : "browser.aiMetadata.copiedNotification"), {
        durationMs: 8000,
        action: {
          label: t("browser.dontShowAgain"),
          onClick: () => localStorage.setItem(COPY_HINT_DISMISSED_KEY, COPY_HINT_VERSION),
        },
      });
    }
    setStep("import");
  }

  function handleCopyFailed() {
    setToast(t("browser.aiMetadata.exportFailed"));
  }

  // Merges a newly imported round into whatever's already on the review
  // screen rather than replacing it — a "Nachträge einfügen" round adds the
  // previously missing entries without discarding decisions already made
  // on earlier ones. Where the same id was returned twice, the new round
  // wins outright (overwrites both the suggestion and its accept state),
  // on the assumption that a re-sent item was re-sent because the first
  // answer was unusable anyway.
  function applyParsedResult(result: AiSuggestion[]) {
    setHasImportedOnce(true);
    setReceivedIds((prev) => {
      const next = new Set(prev);
      for (const s of result) next.add(s.id);
      return next;
    });
    setSuggestions((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      for (const s of result) byId.set(s.id, s);
      return Array.from(byId.values());
    });
    setAccepted((prev) => {
      const next = new Map(prev);
      for (const s of result) {
        if (s.valid) next.set(s.id, true);
        else next.delete(s.id);
      }
      return next;
    });
    setEditedDates((prev) => {
      const next = new Map(prev);
      for (const s of result) next.set(s.id, toDateOnlyValue(s.suggested_timestamp));
      return next;
    });
  }

  async function importFromClipboard() {
    setImportBusy(true);
    try {
      const content = await readClipboardText();
      if (!content || !content.trim()) {
        setToast(t("browser.aiMetadata.importFailed"));
        return;
      }
      const result = await invoke<AiSuggestion[]>("parse_ai_metadata_text", { content });
      applyParsedResult(result);
    } catch {
      setToast(t("browser.aiMetadata.importFailed"));
    } finally {
      setImportBusy(false);
    }
  }

  function toggleAccepted(id: string) {
    setAccepted((prev) => {
      const next = new Map(prev);
      next.set(id, !next.get(id));
      return next;
    });
  }

  // Sets every currently visible, valid row to the same accepted state —
  // invalid rows have no checkbox to begin with (see the disabled row
  // checkbox below) and are left untouched. Scoped to `visibleSuggestions`
  // rather than all of `suggestions` so toggling all while "unveränderte
  // ausblenden" is active only affects the rows actually on screen.
  function toggleAllVisible(next: boolean) {
    setAccepted((prev) => {
      const map = new Map(prev);
      for (const { s } of visibleSuggestions) {
        if (s.valid) map.set(s.id, next);
      }
      return map;
    });
  }

  function updateEditedDate(id: string, value: string) {
    setEditedDates((prev) => new Map(prev).set(id, value));
  }

  async function applyAccepted() {
    const entries: AiApplyEntry[] = [];
    for (const suggestion of suggestions) {
      if (!suggestion.valid || !accepted.get(suggestion.id) || !suggestion.current_timestamp) continue;
      const dateOnly = editedDates.get(suggestion.id);
      const timestamp = dateOnly ? combineDateWithTimeOfDay(dateOnly, suggestion.current_timestamp) : null;
      if (!timestamp) continue;
      entries.push({ id: suggestion.id, timestamp });
    }
    if (entries.length === 0) return;

    setApplyBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.aiMetadata.applyButton"), total: entries.length });
    try {
      const result = await invoke<AiApplyResult>("apply_ai_metadata_suggestions", { entries, operationId });
      const appliedIds = new Set(entries.map((e) => e.id));
      setSuggestions((prev) => prev.filter((s) => !appliedIds.has(s.id)));
      setAppliedCount(result.applied);
      setShowChanges(false);
      if (result.actionId != null) {
        try {
          setChangeEntries(await invoke<ActionLogEntry[]>("list_action_entries", { actionId: result.actionId }));
        } catch {
          setChangeEntries([]);
        }
      } else {
        setChangeEntries([]);
      }
    } catch {
      setToast(t("browser.aiMetadata.applyFailed"));
    } finally {
      setApplyBusy(false);
      finishOperation(operationId);
    }
  }

  // A date-change entry's "before"/"after" are full timestamps, not just the
  // day — reuses `sameDay` (see its own doc comment) so "changed" here means
  // exactly what the review screen's own "unverändert" filter already means.
  function isUnchangedChange(entry: ActionLogEntry): boolean {
    return entry.afterValue != null && sameDay(entry.beforeValue, entry.afterValue);
  }

  const missingIds = useMemo(() => {
    if (!hasImportedOnce || expectedIds.length === 0) return [];
    return expectedIds.filter((id) => !receivedIds.has(id));
  }, [hasImportedOnce, expectedIds, receivedIds]);

  async function copyMissingToClipboard() {
    if (missingIds.length === 0) return;
    setFollowupBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.aiMetadata.missingCopyButton"), total: missingIds.length });
    try {
      const content = await invoke<string>("build_ai_metadata_export_text", {
        ids: missingIds,
        extraInstructions: null,
        followup: true,
        operationId,
      });
      await writeClipboardText(content);
      setToast(t("browser.aiMetadata.followupCopied"));
    } catch {
      setToast(t("browser.aiMetadata.exportFailed"));
    } finally {
      setFollowupBusy(false);
      finishOperation(operationId);
    }
  }

  const acceptedCount = suggestions.filter((s) => s.valid && accepted.get(s.id)).length;
  const annotatedSuggestions = useMemo(
    () => suggestions.map((s) => ({ s, unchanged: s.valid && sameDay(s.current_timestamp, s.suggested_timestamp) })),
    [suggestions],
  );
  const unchangedCount = annotatedSuggestions.filter((a) => a.unchanged).length;
  const changedAppliedCount = changeEntries.filter((e) => !isUnchangedChange(e)).length;
  const unchangedAppliedCount = changeEntries.filter(isUnchangedChange).length;
  const visibleSuggestions = hideUnchanged ? annotatedSuggestions.filter((a) => !a.unchanged) : annotatedSuggestions;
  const visibleValidSuggestions = visibleSuggestions.filter((a) => a.s.valid);
  const allVisibleAccepted =
    visibleValidSuggestions.length > 0 && visibleValidSuggestions.every((a) => accepted.get(a.s.id));

  return (
    <div className="ai-metadata">
      {step === "select" && <AiFileSelectStep restrictToIds={restrictToIds} onNext={handleFilesChosen} />}

      {step === "instructions" && (
        <AiInstructionsStep
          selectedIds={selectedIds}
          onCopied={handleCopied}
          onCopyFailed={handleCopyFailed}
          onBack={() => setStep("select")}
        />
      )}

      {step === "import" && (
        <div className="ai-metadata__panel ai-metadata__panel--import">
          <h2>{t("browser.aiMetadata.importStepTitle")}</h2>
          <p className="ai-metadata__instructions">{t("browser.aiMetadata.importStepDescription")}</p>

          {missingIds.length > 0 && (
            <div className="ai-metadata__missing-hint">
              <p>{t("browser.aiMetadata.missingHint").replace("{count}", String(missingIds.length))}</p>
              <button className="btn btn--secondary" onClick={copyMissingToClipboard} disabled={followupBusy}>
                {t("browser.aiMetadata.missingCopyButton")} ({missingIds.length})
              </button>
            </div>
          )}

          <button className="btn btn--primary" onClick={importFromClipboard} disabled={importBusy}>
            {t("browser.aiMetadata.importFromClipboardButton")}
          </button>

          {suggestions.length > 0 && (
            <>
              <label className="ai-metadata__hide-unchanged">
                <input type="checkbox" checked={hideUnchanged} onChange={(e) => setHideUnchanged(e.target.checked)} />
                {t("browser.aiMetadata.hideUnchanged")} ({unchangedCount})
              </label>

              <div className="ai-metadata__review-list">
                <div className="ai-metadata__review-row ai-metadata__review-row--header">
                  <input
                    type="checkbox"
                    checked={allVisibleAccepted}
                    disabled={visibleValidSuggestions.length === 0}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    title={t("browser.aiMetadata.selectAll")}
                  />
                  <span>{t("browser.aiMetadata.colFile")}</span>
                  <span>{t("browser.aiMetadata.colCurrent")}</span>
                  <span />
                  <span>{t("browser.aiMetadata.colSuggested")}</span>
                  <span>{t("browser.aiMetadata.colConfidence")}</span>
                  <span>{t("browser.aiMetadata.colReason")}</span>
                </div>
                {visibleSuggestions.map(({ s, unchanged }) => (
                  <div
                    key={s.id}
                    className={
                      "ai-metadata__review-row" +
                      (s.valid ? "" : " ai-metadata__review-row--invalid") +
                      (unchanged ? " ai-metadata__review-row--unchanged" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={s.valid && (accepted.get(s.id) ?? false)}
                      disabled={!s.valid}
                      onChange={() => toggleAccepted(s.id)}
                    />
                    <span className="ai-metadata__review-name" title={s.original_filename ?? s.id}>
                      {s.original_filename ?? s.id}
                    </span>
                    <span className="ai-metadata__review-current">
                      {s.current_timestamp ? formatDateOnly(s.current_timestamp) : "–"}
                    </span>
                    <span className="ai-metadata__review-arrow">→</span>
                    {s.valid ? (
                      <input
                        type="date"
                        className="ai-metadata__review-input"
                        value={editedDates.get(s.id) ?? ""}
                        onChange={(e) => updateEditedDate(s.id, e.target.value)}
                      />
                    ) : (
                      <span className="ai-metadata__review-error">{s.error}</span>
                    )}
                    <span
                      className={
                        "ai-metadata__review-confidence" +
                        (s.valid && s.confidence ? " ai-metadata__review-confidence--" + s.confidence : "")
                      }
                    >
                      {s.valid && s.confidence ? confidenceLabel(s.confidence) : ""}
                    </span>
                    <span
                      className={"ai-metadata__review-reason" + (s.valid ? " ai-metadata__review-reason--clickable" : "")}
                      onClick={() => s.valid && setDetailSuggestion(s)}
                      title={s.valid ? t("browser.aiMetadata.detailHint") : undefined}
                    >
                      {s.valid ? s.reason : ""}
                    </span>
                  </div>
                ))}
              </div>

              <button className="btn btn--primary" onClick={applyAccepted} disabled={applyBusy || acceptedCount === 0}>
                {t("browser.aiMetadata.applyButton")} ({acceptedCount})
              </button>
            </>
          )}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {detailSuggestion && (
        <AiSuggestionDetail suggestion={detailSuggestion} onClose={() => setDetailSuggestion(null)} />
      )}

      {appliedCount !== null && (
        <div className="review-modal__backdrop">
          <div className={"review-modal ai-metadata__applied-modal" + (showChanges ? " ai-metadata__applied-modal--list" : "")}>
            <div className="review-modal__header">
              <h2>{showChanges ? t("browser.aiMetadata.changeListTitle") : t("browser.aiMetadata.appliedTitle")}</h2>
            </div>

            {!showChanges && (
              <>
                <p className="review-modal__intro">
                  {appliedCount} {t("browser.aiMetadata.appliedToastSuffix")}
                </p>
                <p className="review-modal__intro">
                  {t("browser.aiMetadata.appliedBreakdown")
                    .replace("{changed}", String(changedAppliedCount))
                    .replace("{unchanged}", String(unchangedAppliedCount))}
                </p>
              </>
            )}

            {showChanges && (
              <div className="ai-metadata__change-list">
                <div className="ai-metadata__change-row ai-metadata__change-row--header">
                  <span>{t("browser.aiMetadata.colFile")}</span>
                  <span>{t("browser.aiMetadata.changeListBefore")}</span>
                  <span />
                  <span>{t("browser.aiMetadata.changeListAfter")}</span>
                </div>
                {changeEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={
                      "ai-metadata__change-row" + (isUnchangedChange(entry) ? " ai-metadata__change-row--unchanged" : "")
                    }
                  >
                    <span className="ai-metadata__change-label" title={entry.label}>
                      {entry.label}
                    </span>
                    <span>{formatDateTime(entry.beforeValue) ?? "–"}</span>
                    <span className="ai-metadata__review-arrow">→</span>
                    <span>{formatDateTime(entry.afterValue) ?? "–"}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="review-modal__footer">
              {!showChanges && changeEntries.length > 0 && (
                <button className="btn--text" onClick={() => setShowChanges(true)}>
                  {t("browser.aiMetadata.showChangesButton")}
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={() => {
                  setAppliedCount(null);
                  setShowChanges(false);
                  onClose?.();
                }}
              >
                {t("browser.aiMetadata.closeWorkflowButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
