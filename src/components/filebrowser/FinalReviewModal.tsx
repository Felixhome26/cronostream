import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import { canCarryMediaDate, MEDIA_DATE_CHUNK, readMediaDates } from "../../utils/dateChoices";
import { t } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import { useToast } from "../../ToastContext";
import type { AddItemsResult, DateSource, DatedPath, FileDateInfo } from "../../types";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../../utils/datetime";
import { formatDateTime } from "../../utils/datetime";
import { notifyDuplicatesFound } from "../../utils/duplicateImportToast";

interface Props {
  items: FileDateInfo[];
  onClose: () => void;
  /// Called after a successful insert, with the paths that actually landed
  /// on the timeline — the caller drops those from its picked list.
  onInserted: (insertedPaths: string[], message: string) => void;
  /// Called with every item id from every duplicate group "Beim Einfügen
  /// auf Duplikate prüfen" found in this batch, once the user chooses to
  /// hand them off via the toast's action button — see `notifyDuplicatesFound`.
  onDuplicatesFound: (ids: string[]) => void;
}

interface RowChoice {
  source: DateSource;
  /// Only meaningful while `source === "manual"`, but kept filled from the
  /// automatic value so switching to manual starts from something sensible
  /// rather than an empty field.
  manual: string;
}

function formatDate(iso: string | null): string {
  return formatDateTime(iso) ?? "–";
}

/// `media`: the date inside the file, once read (see the loading effect).
function chosenTimestamp(info: FileDateInfo, choice: RowChoice, media: string | null | undefined): string | null {
  switch (choice.source) {
    case "exif":
      return info.exif;
    case "meta":
      return media ?? null;
    case "filename":
      return info.filename;
    case "fs_created":
      return info.fs_created;
    case "fs_modified":
      return info.fs_modified;
    case "manual":
      return fromDatetimeLocalValue(choice.manual);
    // Set only by the in-app recording flow (`RecordMedia.tsx`), which
    // stamps its own date and never passes through this screen — so there
    // is no candidate to return, and the row would count as unresolved.
    case "recording":
      return null;
  }
}

/// The last step before anything is written to the project: every file with
/// its name, its available dates, and which one it will be placed under.
/// Used by both pick sources (single-image view and manifest import), each
/// with its own list — this component never mixes them.
export default function FinalReviewModal({ items, onClose, onInserted, onDuplicatesFound }: Props) {
  const [choices, setChoices] = useState<Map<string, RowChoice>>(
    () => new Map(items.map((i) => [i.path, { source: i.auto_source, manual: toDatetimeLocalValue(i.auto_value) }])),
  );
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const { startOperation, finishOperation } = useProgress();
  const showToast = useToast();
  // The date inside each video, recording and document, read in the
  // background once the screen is open, a few files at a time; its choice
  // appears per row as soon as it is known. Nothing here waits for it: it
  // is never the automatic choice. Paused while inserting, so the import
  // gets the machine, and stopped when the screen closes.
  const [mediaDates, setMediaDates] = useState<Map<string, string | null>>(() => new Map());
  const busyRef = useRef(false);
  busyRef.current = busy;
  const mediaRequested = useRef(new Set<string>());
  // Keyed by the paths, not `items`: the callers build that array afresh on
  // every render, which would restart the reading each time.
  const mediaPathsKey = JSON.stringify(items.filter(canCarryMediaDate).map((i) => i.path));
  useEffect(() => {
    let cancelled = false;
    const paths = (JSON.parse(mediaPathsKey) as string[]).filter((p) => !mediaRequested.current.has(p));
    void (async () => {
      for (let i = 0; i < paths.length; i += MEDIA_DATE_CHUNK) {
        while (busyRef.current && !cancelled) await new Promise((resolve) => setTimeout(resolve, 250));
        if (cancelled) return;
        const chunk = paths.slice(i, i + MEDIA_DATE_CHUNK);
        chunk.forEach((p) => mediaRequested.current.add(p));
        try {
          const found = await readMediaDates(chunk);
          setMediaDates((prev) => new Map([...prev, ...found]));
        } catch {
          // Only an extra choice: a failed read leaves it out.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaPathsKey]);

  function choiceFor(info: FileDateInfo): RowChoice {
    return choices.get(info.path) ?? { source: info.auto_source, manual: toDatetimeLocalValue(info.auto_value) };
  }

  function updateChoice(path: string, patch: Partial<RowChoice>) {
    setChoices((prev) => {
      const next = new Map(prev);
      const existing = next.get(path);
      if (existing) next.set(path, { ...existing, ...patch });
      return next;
    });
  }

  // A row is only blocking if its chosen date can't be resolved at all —
  // which in practice only happens if the manual field is cleared or typed
  // into incompletely, since the candidate options are never offered unless
  // they hold a value.
  const invalidCount = useMemo(
    () => items.filter((info) => chosenTimestamp(info, choiceFor(info), mediaDates.get(info.path)) === null).length,
    [items, choices, mediaDates],
  );

  async function insert() {
    const entries: DatedPath[] = [];
    for (const info of items) {
      const choice = choiceFor(info);
      const timestamp = chosenTimestamp(info, choice, mediaDates.get(info.path));
      if (!timestamp) continue;
      entries.push({ path: info.path, timestamp, timestamp_source: choice.source });
    }
    if (entries.length === 0) return;

    setBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.review.title"), total: entries.length });
    try {
      const result = await invoke<AddItemsResult>("add_items_with_dates", { entries, operationId });
      setSkipped(result.skipped);
      const insertedPaths = entries.map((e) => e.path).filter((p) => !result.skipped.some((s) => s.path === p));

      if (result.skipped.length === 0) {
        onInserted(insertedPaths, `${t("browser.review.insertedToast")} (${result.added.length})`);
      } else if (result.added.length > 0) {
        // Partial success: keep the dialog open so the problem rows stay
        // visible, but drop what did land so it can't be added twice.
        onInserted(insertedPaths, `${t("browser.review.insertedToast")} (${result.added.length})`);
      }
      notifyDuplicatesFound(showToast, result.duplicates, onDuplicatesFound);
    } catch {
      setSkipped([{ path: "", reason: t("browser.review.insertFailed") }]);
    } finally {
      setBusy(false);
      finishOperation(operationId);
    }
  }

  return (
    <div className="review-modal__backdrop" onClick={onClose}>
      <div className="review-modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-modal__header">
          <h2>{t("browser.review.title")}</h2>
          <button className="btn--text" onClick={onClose}>
            {t("browser.review.close")}
          </button>
        </div>

        <p className="review-modal__intro">{t("browser.review.intro")}</p>

        <div className="review-modal__list">
          {items.length === 0 && <div className="review-modal__empty">{t("browser.review.empty")}</div>}
          {items.map((info) => {
            const choice = choiceFor(info);
            const media = mediaDates.get(info.path);
            const unresolved = chosenTimestamp(info, choice, media) === null;
            const candidates: { source: DateSource; label: string; value: string | null }[] = [
              { source: "exif", label: t("browser.review.sourceExif"), value: info.exif },
              { source: "meta", label: t("browser.review.sourceMeta"), value: media ?? null },
              { source: "filename", label: t("browser.review.sourceFilename"), value: info.filename },
              { source: "fs_created", label: t("browser.review.sourceCreated"), value: info.fs_created },
              { source: "fs_modified", label: t("browser.review.sourceModified"), value: info.fs_modified },
            ];
            return (
              <div className="review-row" key={info.path}>
                <div className="review-row__name" title={info.path}>
                  {info.name}
                </div>
                <div className="review-row__choices">
                  {candidates.map(
                    (candidate) =>
                      candidate.value && (
                        <label
                          key={candidate.source}
                          className={
                            "review-choice" + (choice.source === candidate.source ? " review-choice--active" : "")
                          }
                        >
                          <input
                            type="radio"
                            name={`date-${info.path}`}
                            checked={choice.source === candidate.source}
                            onChange={() => updateChoice(info.path, { source: candidate.source })}
                          />
                          <span className="review-choice__label">{candidate.label}</span>
                          <span className="review-choice__value">{formatDate(candidate.value)}</span>
                        </label>
                      ),
                  )}
                  <label className={"review-choice" + (choice.source === "manual" ? " review-choice--active" : "")}>
                    <input
                      type="radio"
                      name={`date-${info.path}`}
                      checked={choice.source === "manual"}
                      onChange={() => updateChoice(info.path, { source: "manual" })}
                    />
                    <span className="review-choice__label">{t("browser.review.sourceManual")}</span>
                    <input
                      type="datetime-local"
                      className="review-choice__manual"
                      value={choice.manual}
                      onChange={(e) => updateChoice(info.path, { source: "manual", manual: e.target.value })}
                    />
                  </label>
                </div>
                {unresolved && <div className="review-row__warning">{t("browser.review.invalidDate")}</div>}
              </div>
            );
          })}
        </div>

        {skipped.length > 0 && (
          <div className="review-modal__skipped">
            {skipped.map((s, i) => (
              <div key={`${s.path}-${i}`}>{s.reason}</div>
            ))}
          </div>
        )}

        <div className="review-modal__footer">
          {invalidCount > 0 && <span className="review-modal__hint">{t("browser.review.fixDatesHint")}</span>}
          <button
            className="btn btn--primary"
            onClick={insert}
            disabled={busy || items.length === 0 || invalidCount > 0}
          >
            {t("browser.review.insertButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
