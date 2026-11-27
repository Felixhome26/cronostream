import { t, tn } from "../../i18n";
import type { TransferDuplicate } from "../../types";

interface Props {
  mode: "copy" | "move";
  total: number;
  targetName: string;
  duplicates: TransferDuplicate[];
  onSkip: () => void;
  onIncludeAll: () => void;
  onCancel: () => void;
}

/// Asked before anything is copied: some of the files are already in the
/// target stream (same original path or same content). The choice is
/// all-or-nothing — skip the listed ones, or transfer everything anyway.
export default function TransferDuplicatesDialog({ mode, total, targetName, duplicates, onSkip, onIncludeAll, onCancel }: Props) {
  const allDuplicates = duplicates.length === total;
  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide replace-dialog" role="dialog" aria-modal="true">
        <h2 className="modal-card__title">{t("transfer.duplicatesTitle")}</h2>
        <p className="modal-card__body">
          {total === 1
            ? tn(1, "transfer.duplicatesSummarySingle", { target: targetName })
            : tn(duplicates.length, "transfer.duplicatesSummary", { total, target: targetName })}
        </p>
        <div className="replace-dialog__list">
          {duplicates.map((d) => (
            <div key={d.itemId} className="replace-dialog__row" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
              <span className="replace-dialog__cand" title={d.label}>
                {d.label}
              </span>
              <span className="replace-dialog__size" title={d.existingName}>
                {d.byContent ? t("transfer.duplicateByContent") : t("transfer.duplicateByPath")}: {d.existingName}
              </span>
            </div>
          ))}
        </div>
        <div className="modal-card__actions">
          <button className="btn" onClick={onCancel}>
            {t("browser.folderCancel")}
          </button>
          <button className="btn" onClick={onIncludeAll}>
            {t(mode === "move" ? "transfer.duplicatesMoveAnyway" : "transfer.duplicatesCopyAnyway")}
          </button>
          {!allDuplicates && (
            <button className="btn btn--primary" autoFocus onClick={onSkip}>
              {t("transfer.duplicatesSkip")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
