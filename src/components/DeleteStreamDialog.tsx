import { useEffect, useState } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import type { DeletionOutcome, DeletionPreview } from "../types";

/// How long the final button stays locked. Short enough not to feel like a
/// punishment, long enough that the click can't be the tail end of the
/// double-click that opened the dialog.
const COUNTDOWN_SECONDS = 5;

interface DeleteStreamDialogProps {
  path: string;
  onCancel: () => void;
  onDeleted: (outcome: DeletionOutcome) => void;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/// Deleting a whole stream, with its folder, from the disk.
///
/// Two deliberate pieces of friction, because this is the only
/// irreversible action in the app:
///   * two separate confirmations, the second one stating the consequence
///     in full rather than repeating the question;
///   * a short countdown on the final button, so the decision can't be a
///     reflex.
///
/// And one piece of honesty: anything in the folder that isn't part of the
/// stream is listed by name, because it gets deleted as well.
export default function DeleteStreamDialog({
  path,
  onCancel,
  onDeleted,
}: DeleteStreamDialogProps) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [step, setStep] = useState<"details" | "final">("details");
  const [keepLog, setKeepLog] = useState(true);
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape cancels like the other dialogs do, but not while the deletion
  // is already running.
  useWindowKeydown((ev) => {
    if (ev.key === "Escape" && !busy) onCancel();
  });

  useEffect(() => {
    void (async () => {
      try {
        setPreview(await invoke<DeletionPreview>("inspect_stream_deletion", { path }));
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [path]);

  // The countdown only runs on the second step, and restarts if the user
  // steps back and forth.
  useEffect(() => {
    if (step !== "final") {
      setRemaining(COUNTDOWN_SECONDS);
      return;
    }
    const timer = window.setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  async function runDelete() {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await invoke<DeletionOutcome>("delete_stream", { path, keepLog }));
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  if (error && !preview) {
    return (
      <div className="modal-overlay">
        <div className="modal-card">
          <h3 className="modal-card__title">{t("delete.title")}</h3>
          <p className="modal-card__body">{error}</p>
          <div className="modal-card__actions">
            <button className="btn--text" onClick={onCancel}>
              {t("delete.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="modal-overlay">
        <div className="modal-card">
          <p className="modal-card__body">{t("delete.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide">
        {step === "details" ? (
          <>
            <h3 className="modal-card__title">{t("delete.title")}</h3>
            <p className="modal-card__body">
              <strong>{preview.name}</strong> — {preview.itemCount} {t("delete.filesSuffix")},{" "}
              {formatBytes(preview.sizeBytes)}
            </p>
            <p className="modal-card__body">{t("delete.explain")}</p>

            {preview.foreignEntries.length > 0 && (
              <div className="delete-dialog__foreign">
                <p>{t("delete.foreignHeading")}</p>
                <ul>
                  {preview.foreignEntries.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}

            <label className="delete-dialog__keep">
              <input
                type="checkbox"
                checked={keepLog}
                onChange={(ev) => setKeepLog(ev.target.checked)}
              />
              <span>
                <strong>{t("delete.keepLog")}</strong>
                <span className="modal-card__hint delete-dialog__keep-hint">
                  {keepLog
                    ? `${t("delete.keepLogOn")} ${preview.restorableCount} ${t("delete.keepLogRestorable")}`
                    : t("delete.keepLogOff")}
                </span>
              </span>
            </label>

            <div className="modal-card__actions">
              <button className="btn--text" onClick={onCancel}>
                {t("delete.cancel")}
              </button>
              <button className="btn btn--danger" onClick={() => setStep("final")}>
                {t("delete.next")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="modal-card__title">{t("delete.finalTitle")}</h3>
            <p className="modal-card__body">
              {t("delete.finalBody")} <strong>{preview.path}</strong>
            </p>
            <p className="modal-card__body">
              {keepLog ? t("delete.finalKeptLog") : t("delete.finalNoLog")}
            </p>
            {error && <p className="delete-dialog__error">{error}</p>}
            <div className="modal-card__actions">
              <button className="btn--text" onClick={() => setStep("details")} disabled={busy}>
                {t("delete.back")}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void runDelete()}
                disabled={busy || remaining > 0}
              >
                {remaining > 0
                  ? `${t("delete.confirm")} (${remaining})`
                  : t("delete.confirm")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
