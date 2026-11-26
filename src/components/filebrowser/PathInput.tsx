import { useState } from "react";
import { t } from "../../i18n";

interface Props {
  onNavigate: (path: string) => Promise<void> | void;
}

/// A plain text field for pasting/typing a full folder path from another
/// file manager. Deliberately swallows the backend's raw error on failure —
/// per the app's design philosophy, the user only ever sees a friendly,
/// translated message, never an OS-level error string.
export default function PathInput({ onNavigate }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      await onNavigate(trimmed);
      setError(false);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="path-input">
      <div className="path-input__row">
        <input
          type="text"
          className="path-input__field"
          value={value}
          placeholder={t("browser.tree.pathPlaceholder")}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button type="button" className="btn--text" onClick={submit}>
          {t("browser.tree.goButton")}
        </button>
      </div>
      {error && <div className="path-input__error">{t("browser.tree.pathNotFound")}</div>}
    </div>
  );
}
