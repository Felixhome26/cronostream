import { useState } from "react";
import { t, tCount } from "../../i18n";

interface Props {
  /// How many files the term will be added to.
  count: number;
  onCancel: () => void;
  onConfirm: (term: string) => void;
}

/// "Notiz hinzufügen" — the one-field dialog behind the Datei-Operationen
/// dropdown entry of the same name. The term typed here is added to every
/// marked file's note (see `add_note_to_items`/`append_note_term`), not
/// used to replace it: a file that already carries a note from elsewhere
/// keeps it.
export default function AddNoteDialog({ count, onCancel, onConfirm }: Props) {
  const [term, setTerm] = useState("");
  const trimmed = term.trim();

  function confirm() {
    if (trimmed === "") return;
    onConfirm(trimmed);
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-card" onMouseDown={(ev) => ev.stopPropagation()}>
        <h2 className="modal-card__title">{t("fileOps.addNoteTitle")}</h2>
        <p className="modal-card__body">
          {tCount(count, "fileOps.fileSelected", "fileOps.filesSelected")}
        </p>
        <input
          className="text-input"
          autoFocus
          value={term}
          onChange={(ev) => setTerm(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") confirm();
            if (ev.key === "Escape") onCancel();
          }}
          placeholder={t("fileOps.addNotePlaceholder")}
          aria-label={t("fileOps.addNoteTitle")}
        />
        <div className="modal-card__actions">
          <button className="btn" onClick={onCancel}>
            {t("browser.folderCancel")}
          </button>
          <button className="btn btn--primary" onClick={confirm} disabled={trimmed === ""}>
            {t("fileOps.addNoteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
