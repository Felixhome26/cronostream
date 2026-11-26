import { useState } from "react";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import { useToast } from "../../ToastContext";
import { useProgress } from "../../ProgressContext";
import type { ProjectFileEntry, TimestampEntry } from "../../types";
import { formatDateTime, fromDatetimeLocalValue, toDatetimeLocalValue } from "../../utils/datetime";
import SegmentedDateTimeInput from "../SegmentedDateTimeInput";
import HelpHint from "./HelpHint";

interface Props {
  entries: ProjectFileEntry[];
  thumbnailUrls: Map<string, string>;
  onCancel: () => void;
  /// Called after a successful save — the caller reloads its own list
  /// (`ProjectFilesView.reload`) rather than this dialog trying to patch
  /// state it doesn't own.
  onSaved: () => void;
}

/// Adds `minutes` to a "YYYY-MM-DDTHH:mm" value (the same local-time shape
/// `toDatetimeLocalValue`/`fromDatetimeLocalValue` use) — `new Date` parses
/// that shape as local time with no timezone suffix, same as
/// `fromDatetimeLocalValue` already relies on elsewhere in this file.
function offsetDatetimeLocalValue(value: string, minutes: number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  d.setMinutes(d.getMinutes() + minutes);
  return toDatetimeLocalValue(d.toISOString());
}

/// "Datum im Stream ändern" — reached from the context menu in
/// Datei-Operationen/Papierkorb. One file or several, shown as a list of
/// small cards each with its own free-form date field (the same
/// `SegmentedDateTimeInput` the timeline viewer uses for a single file),
/// plus — when there's more than one — a "für alle übernehmen" field that
/// copies one value into every card's draft at once. Nothing is written
/// until "Speichern": copying into the drafts and committing are two
/// separate steps, so "für alle" can be undone by just editing a card
/// again before saving.
export default function ChangeDateDialog({ entries, thumbnailUrls, onCancel, onSaved }: Props) {
  const showToast = useToast();
  const { startOperation, finishOperation } = useProgress();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map((entry) => [entry.id, toDatetimeLocalValue(entry.resolvedTimestamp)])),
  );
  const [bulkValue, setBulkValue] = useState(() => drafts[entries[0]?.id] ?? "");
  // Minutes added per file past the first when "für alle übernehmen" is
  // used on more than one file — lets a batch of imports that all landed on
  // the same guessed timestamp get spread out instead of literally
  // overlapping. 0 reproduces the old "every file gets the exact same
  // value" behaviour.
  const [offsetMinutes, setOffsetMinutes] = useState(5);
  const [saving, setSaving] = useState(false);

  function applyToAll() {
    setDrafts(
      Object.fromEntries(entries.map((entry, index) => [entry.id, offsetDatetimeLocalValue(bulkValue, index * offsetMinutes)])),
    );
  }

  async function save() {
    const timestampEntries: TimestampEntry[] = [];
    for (const entry of entries) {
      const iso = fromDatetimeLocalValue(drafts[entry.id]);
      if (!iso) continue;
      if (iso === entry.resolvedTimestamp) continue;
      // The date field only snaps future values back on blur; Enter reaches
      // this save before that state has landed.
      timestampEntries.push({ id: entry.id, timestamp: new Date(iso) > new Date() ? new Date().toISOString() : iso });
    }
    if (timestampEntries.length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("fileOps.changeDateTitle"), total: timestampEntries.length });
    try {
      const updated = await invoke<number>("update_timestamps_batch", { entries: timestampEntries, operationId });
      showToast(`${updated} ${t("fileOps.dateChangedToast")}`);
      onSaved();
    } catch (err) {
      showToast(String(err));
    } finally {
      setSaving(false);
      finishOperation(operationId);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal-card modal-card--wide"
        onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          // Enter confirms, except in the "für alle" row (where it would
          // otherwise skip the copy step) or on a focused button/number field. The date segments are inputs too.
          if (ev.key !== "Enter" || saving) return;
          const target = ev.target as HTMLElement;
          if (target.closest(".change-date__bulk") || target.tagName === "BUTTON" || (target.tagName === "INPUT" && !target.classList.contains("dt-input__field"))) return;
          ev.preventDefault();
          void save();
        }}
      >
        <h2 className="modal-card__title">{t("fileOps.changeDateTitle")}</h2>

        {entries.length > 1 && (
          <div className="change-date__bulk">
            <SegmentedDateTimeInput value={bulkValue} onChange={setBulkValue} />
            <label className="change-date__offset">
              {t("fileOps.offsetLabel")}
              <input
                type="number"
                min={0}
                className="change-date__offset-input"
                value={offsetMinutes}
                onChange={(ev) => setOffsetMinutes(Math.max(0, Number(ev.target.value) || 0))}
                disabled={saving}
              />
              {t("fileOps.offsetUnit")}
            </label>
            <button className="btn" onClick={applyToAll} disabled={saving}>
              {t("fileOps.applyToAll")}
            </button>
            <HelpHint text={t("fileOps.applyToAllHint")} />
          </div>
        )}

        <div className="change-date__list">
          {entries.map((entry) => (
            <div key={entry.id} className="change-date__row">
              <div className="change-date__thumb">
                {thumbnailUrls.has(entry.path) ? (
                  <img src={thumbnailUrls.get(entry.path)} alt="" />
                ) : (
                  <span className="file-tile__icon">🗂️</span>
                )}
              </div>
              <div className="change-date__info">
                <div className="change-date__name">{entry.name}</div>
                <div className="change-date__current">
                  {t("fileOps.currentDate")}: {formatDateTime(entry.resolvedTimestamp)}
                </div>
              </div>
              <SegmentedDateTimeInput
                className="change-date__input"
                value={drafts[entry.id]}
                onChange={(value) => setDrafts((prev) => ({ ...prev, [entry.id]: value }))}
              />
            </div>
          ))}
        </div>

        <div className="modal-card__actions">
          <button className="btn" onClick={onCancel} disabled={saving}>
            {t("browser.folderCancel")}
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {t("fileOps.saveDate")}
          </button>
        </div>
      </div>
    </div>
  );
}
