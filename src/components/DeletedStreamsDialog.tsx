import { useCallback, useEffect, useState } from "react";
import { invoke } from "../busy";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import type { DeletedStream, RestoreProgress, RestoreReport } from "../types";
import { formatDateTime } from "../utils/datetime";

interface DeletedStreamsDialogProps {
  onClose: () => void;
  /** Called after a successful restore, so the start screen can refresh
   *  its tile list — the restored stream belongs there again. */
  onRestored: (report: RestoreReport) => void;
}

function formatWhen(iso: string): string {
  return formatDateTime(iso) ?? "–";
}

/// The streams that were deleted with their database kept, and the way
/// back from there.
///
/// Restoring rebuilds the stream from the kept database plus the
/// original source files — so it only works as far as those files are still
/// where they were. The list says up front how many of them are still
/// reachable, so nobody starts a restore expecting more than it can give.
export default function DeletedStreamsDialog({
  onClose,
  onRestored,
}: DeletedStreamsDialogProps) {
  const [entries, setEntries] = useState<DeletedStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<DeletedStream | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  // Escape steps back the way the visible "Abbrechen"/"Schließen" buttons
  // do: out of the restore form or the discard question first, then out of
  // the dialog. Ignored while something is running.
  useWindowKeydown((ev) => {
    if (ev.key !== "Escape" || busy) return;
    if (restoring) setRestoring(null);
    else if (confirmDiscard) setConfirmDiscard(null);
    else onClose();
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await invoke<DeletedStream[]>("list_deleted_streams"));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unlisten = listen<RestoreProgress>("restore-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  async function runRestore() {
    if (!restoring) return;
    const name = restoreName.trim();
    if (!name) {
      setError(t("restore.nameMissing"));
      return;
    }
    const parent = await openDialog({
      directory: true,
      multiple: false,
      title: t("restore.pickLocation"),
    });
    if (typeof parent !== "string") return;

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: restoring.itemCount, current: "" });
    try {
      const result = await invoke<RestoreReport>("restore_stream", {
        id: restoring.id,
        parentPath: parent,
        name,
      });
      setReport(result);
      setRestoring(null);
      onRestored(result);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function discard(id: string) {
    setBusy(true);
    try {
      await invoke("discard_deleted_stream", { id });
      setConfirmDiscard(null);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide">
        <h3 className="modal-card__title">{t("restore.title")}</h3>
        <p className="modal-card__body">{t("restore.explain")}</p>

        {error && <p className="delete-dialog__error">{error}</p>}

        {report && (
          <div className="restore__report">
            <p>
              <strong>{report.name}</strong>: {report.restored} {t("restore.restoredSuffix")}
            </p>
            {report.changed.length > 0 && (
              <p className="modal-card__hint">
                {t("restore.changedHeading")} {report.changed.join(", ")}
              </p>
            )}
            {report.missing.length > 0 && (
              <p className="modal-card__hint">
                {t("restore.missingHeading")} {report.missing.join(", ")}
              </p>
            )}
          </div>
        )}

        {restoring ? (
          <div className="restore__form">
            <p className="modal-card__body">
              <strong>{restoring.name}</strong> — {restoring.restorableCount} {t("restore.ofSuffix")}{" "}
              {restoring.itemCount} {t("restore.filesAvailable")}
            </p>
            {restoring.restorableCount < restoring.itemCount && (
              <p className="modal-card__hint">{t("restore.partialWarning")}</p>
            )}
            <input
              className="text-input"
              value={restoreName}
              onChange={(ev) => setRestoreName(ev.target.value)}
              placeholder={t("restore.namePlaceholder")}
              disabled={busy}
            />
            {progress && (
              <p className="modal-card__hint">
                {progress.done} / {progress.total} {progress.current && `– ${progress.current}`}
              </p>
            )}
            <div className="modal-card__actions">
              <button className="btn--text" onClick={() => setRestoring(null)} disabled={busy}>
                {t("restore.cancel")}
              </button>
              <button className="btn btn--primary" onClick={() => void runRestore()} disabled={busy}>
                {t("restore.pickLocationButton")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {loading ? (
              <p className="modal-card__hint">{t("restore.loading")}</p>
            ) : entries.length === 0 ? (
              <p className="modal-card__hint">{t("restore.empty")}</p>
            ) : (
              <ul className="restore__list">
                {entries.map((entry) => (
                  <li key={entry.id} className="restore__row">
                    <div className="restore__row-main">
                      <strong>{entry.name}</strong>
                      <span className="modal-card__hint">
                        {t("restore.deletedOn")} {formatWhen(entry.deletedAt)} · {entry.restorableCount}{" "}
                        {t("restore.ofSuffix")} {entry.itemCount} {t("restore.filesAvailable")}
                      </span>
                      <span className="modal-card__hint restore__row-path">{entry.originalPath}</span>
                    </div>
                    {confirmDiscard === entry.id ? (
                      <>
                        <button
                          className="btn--text"
                          onClick={() => setConfirmDiscard(null)}
                          disabled={busy}
                        >
                          {t("restore.cancel")}
                        </button>
                        <button
                          className="btn btn--danger"
                          onClick={() => void discard(entry.id)}
                          disabled={busy}
                        >
                          {t("restore.discardConfirm")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn--primary"
                          onClick={() => {
                            setRestoring(entry);
                            setRestoreName(entry.name);
                            setReport(null);
                            setError(null);
                          }}
                          disabled={busy || entry.restorableCount === 0}
                          title={entry.restorableCount === 0 ? t("restore.nothingLeft") : undefined}
                        >
                          {t("restore.restore")}
                        </button>
                        <button
                          className="btn--text"
                          onClick={() => setConfirmDiscard(entry.id)}
                          disabled={busy}
                          title={t("restore.discardHint")}
                        >
                          {t("restore.discard")}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="modal-card__actions">
              <button className="btn--text" onClick={onClose} disabled={busy}>
                {t("restore.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
