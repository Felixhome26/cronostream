import { t, tn } from "../../i18n";
import { printExportNameExample } from "../../utils/printFilename";

interface Props {
  /// Marked files that are photos and will be exported.
  photoCount: number;
  /// Marked files that are not photos (videos, PDFs, …) and are left out.
  skippedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/// "Druckexport" — the explanation shown before the folder is picked.
/// Print shops often print date and time on the back of a photo, and their
/// web interfaces can sort photos into a photo book by that timestamp, so
/// the exported copies are named after the date from the timeline. The text
/// is written for people who have never thought about file names.
export default function PrintExportDialog({ photoCount, skippedCount, onCancel, onConfirm }: Props) {
  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-card" onMouseDown={(ev) => ev.stopPropagation()}>
        <h2 className="modal-card__title">{t("fileOps.printExportTitle")}</h2>
        <p className="modal-card__body">{t("fileOps.printExportIntro")}</p>
        <ul className="modal-card__body">
          <li>{t("fileOps.printExportPoint1")}</li>
          <li>{t("fileOps.printExportPoint2")}</li>
          <li>{t("fileOps.printExportPoint3")}</li>
        </ul>
        <p className="modal-card__body">
          {t("fileOps.printExportExample")} <strong>{printExportNameExample()}</strong>
        </p>
        <p className="modal-card__body">
          {tn(photoCount, "fileOps.printExportPhotoCount")}
          {skippedCount > 0 && ` ${tn(skippedCount, "fileOps.printExportSkipped")}`}
        </p>
        <div className="modal-card__actions">
          <button className="btn" onClick={onCancel}>
            {t("browser.folderCancel")}
          </button>
          <button className="btn btn--primary" onClick={onConfirm} disabled={photoCount === 0}>
            {t("fileOps.printExportConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
