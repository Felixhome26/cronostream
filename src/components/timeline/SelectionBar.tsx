import { t } from "../../i18n";

interface Props {
  count: number;
  onEdit: () => void;
  onClear: () => void;
}

/// The floating bar of a Ctrl-click selection: the count, the hand-off to
/// Datei-Operationen and a cross that clears it.
export default function SelectionBar({ count, onEdit, onClear }: Props) {
  return (
    <div className="timeline-selection-bar">
      <span className="timeline-selection-bar__count">
        {count} {t("timeline.selectionCountSuffix")}
      </span>
      <button className="btn btn--primary" onClick={onEdit}>
        🔧 {t("timeline.selectionEditButton")}
      </button>
      <button className="btn--text" onClick={onClear}>
        ✕
      </button>
    </div>
  );
}
