import { t, tn } from "../../i18n";
import type { TransferResult } from "../../types";

interface Props {
  mode: "copy" | "move";
  result: TransferResult;
  /** Confirming marks the skipped files in Datei-Operationen. */
  onConfirm: () => void;
}

/// Shown when a transfer left files behind, whatever the reason. A dialog
/// and not a toast, because the user has to act on these files themselves:
/// after confirming they are marked in Datei-Operationen, where a moved
/// file that is already in the target can be removed in the usual way.
export default function TransferReportDialog({ mode, result, onConfirm }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide replace-dialog" role="dialog" aria-modal="true">
        <h2 className="modal-card__title">{t("transfer.reportTitle")}</h2>
        <p className="modal-card__body">
          <strong>
            {tn(result.transferred, mode === "move" ? "fileOps.movedToast" : "fileOps.copiedToast")} {result.targetName}
          </strong>
          {`, ${tn(result.skipped.length, "transfer.reportSkipped")}`}
        </p>
        <div className="replace-dialog__list">
          {result.skipped.map((s) => (
            <div key={s.itemId} className="replace-dialog__row" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
              <span className="replace-dialog__cand" title={s.label}>
                {s.label}
              </span>
              <span className="replace-dialog__size" title={s.reason}>
                {s.reason}
              </span>
            </div>
          ))}
        </div>
        <p className="modal-card__hint">{t(mode === "move" ? "transfer.reportHintMove" : "transfer.reportHintCopy")}</p>
        <div className="modal-card__actions">
          <button className="btn btn--primary" autoFocus onClick={onConfirm}>
            {t("transfer.reportConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
