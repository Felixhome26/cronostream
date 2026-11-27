import { t, tn } from "../../i18n";
import type { ReplaceOutcome } from "../../types";
import { formatBytes } from "../DeleteStreamDialog";

interface Props {
  outcome: ReplaceOutcome;
  onClose: () => void;
}

/// Success report after "Datei im Stream ersetzen". Deliberately a
/// dialog and not a toast: it stays until the user closes it, because the
/// per-file sizes and any failures are worth reading.
export default function ReplaceReportDialog({ outcome, onClose }: Props) {
  const oldTotal = outcome.files.reduce((sum, f) => sum + f.oldSizeBytes, 0);
  const newTotal = outcome.files.reduce((sum, f) => sum + f.newSizeBytes, 0);
  const saved = outcome.savedBytes;
  const percent = oldTotal > 0 ? Math.round((Math.abs(saved) / oldTotal) * 100) : 0;
  const sorted = [...outcome.files].sort((a, b) => b.oldSizeBytes - b.newSizeBytes - (a.oldSizeBytes - a.newSizeBytes));

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide replace-dialog" role="dialog" aria-modal="true">
        <h2 className="modal-card__title">{t("replace.reportTitle")}</h2>
        <p className="modal-card__body">
          <strong>
            {tn(outcome.replaced, "replace.reportReplaced")}
          </strong>
          {outcome.failed.length > 0 && `, ${tn(outcome.failed.length, "fileOps.replaceFailedToast")}`}
        </p>
        <div className="replace-report__totals">
          <div>
            <span>{t("replace.reportBefore")}</span>
            <strong>{formatBytes(oldTotal)}</strong>
          </div>
          <div>
            <span>{t("replace.reportAfter")}</span>
            <strong>{formatBytes(newTotal)}</strong>
          </div>
          <div>
            <span>{saved >= 0 ? t("replace.reportSaved") : t("replace.reportGrown")}</span>
            <strong>
              {formatBytes(Math.abs(saved))} ({percent} %)
            </strong>
          </div>
        </div>
        {sorted.length > 0 && (
          <div className="replace-dialog__list">
            {sorted.map((f, i) => (
              <div key={`${f.name}-${i}`} className="replace-dialog__row">
                <span className="replace-dialog__name" title={f.name}>
                  <span>{f.name}</span>
                </span>
                <span className="replace-dialog__cand" title={f.newName}>
                  → {f.newName}
                </span>
                <span className="replace-dialog__size">
                  {formatBytes(f.oldSizeBytes)} → {formatBytes(f.newSizeBytes)}
                </span>
              </div>
            ))}
          </div>
        )}
        {outcome.failed.length > 0 && (
          <>
            <p className="replace-dialog__warn">{t("replace.reportFailedTitle")}</p>
            <div className="replace-dialog__list">
              {outcome.failed.map((line, i) => (
                <div key={i} className="replace-dialog__row">
                  <span style={{ gridColumn: "1 / -1" }}>{line}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="modal-card__hint">{t("replace.reportUndoHint")}</p>
        <div className="modal-card__actions">
          <button className="btn btn--primary" autoFocus onClick={onClose}>
            {t("replace.reportClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
