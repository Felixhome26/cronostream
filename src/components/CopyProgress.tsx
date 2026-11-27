import { useEffect, useRef, useState } from "react";
import { invoke } from "../busy";
import { listen } from "@tauri-apps/api/event";
import { t, tn } from "../i18n";
import type { CopyProgressPayload } from "../types";

interface CopyProgressProps {
  /// `null` while the overlay is up but the `start_*` command hasn't
  /// resolved yet — the backend's copy thread can start emitting before the
  /// frontend learns its task id, so the listener below must not wait for
  /// it (see the mount effect).
  taskId: string | null;
  title: string;
  onDone: (resultPath: string | null) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
}

/// Progress overlay for a running backend copy task (duplicate or backup).
/// Listens for `copy-progress` events filtered by `taskId`; the backend owns
/// cleanup on cancel/error, this just reflects status and offers Cancel.
export default function CopyProgress({ taskId, title, onDone, onCancelled, onError }: CopyProgressProps) {
  const [progress, setProgress] = useState<CopyProgressPayload | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const finishedRef = useRef(false);
  const taskIdRef = useRef(taskId);
  // Events that arrive before `taskId` is known — replayed once it is.
  const pendingRef = useRef<CopyProgressPayload[]>([]);
  const callbacksRef = useRef({ onDone, onCancelled, onError });
  callbacksRef.current = { onDone, onCancelled, onError };

  function handlePayload(payload: CopyProgressPayload) {
    setProgress(payload);
    if (payload.status === "done") {
      finishedRef.current = true;
      callbacksRef.current.onDone(payload.result_path ?? null);
    } else if (payload.status === "cancelled") {
      finishedRef.current = true;
      callbacksRef.current.onCancelled();
    } else if (payload.status === "error") {
      finishedRef.current = true;
      callbacksRef.current.onError(payload.error ?? t("copyProgress.errorGeneric"));
    }
  }

  // Attaches once, on mount — independent of `taskId` — so no event emitted
  // between the backend starting the copy and the frontend learning the
  // task id can be lost (Tauri doesn't queue events for late listeners).
  useEffect(() => {
    finishedRef.current = false;
    pendingRef.current = [];
    const unlistenPromise = listen<CopyProgressPayload>("copy-progress", (event) => {
      const payload = event.payload;
      const currentTaskId = taskIdRef.current;
      if (currentTaskId == null) {
        pendingRef.current.push(payload);
        return;
      }
      if (payload.task_id !== currentTaskId || finishedRef.current) return;
      handlePayload(payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    taskIdRef.current = taskId;
    if (taskId == null || finishedRef.current) return;
    const buffered = pendingRef.current.filter((p) => p.task_id === taskId);
    pendingRef.current = [];
    for (const payload of buffered) {
      if (finishedRef.current) break;
      handlePayload(payload);
    }
  }, [taskId]);

  async function handleCancel() {
    if (!taskId) return;
    setCancelling(true);
    try {
      await invoke("cancel_copy_task", { taskId });
    } catch {
      // ignore — the running task reports its own outcome via the event
    }
  }

  const totalBytes = progress?.total_bytes ?? 0;
  const copiedBytes = progress?.copied_bytes ?? 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0;

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <h3 className="modal-card__title">{title}</h3>
        <div className="progress-bar">
          <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="progress-bar__status">
          {progress
            ? `${progress.copied_files} / ${tn(progress.total_files, "copyProgress.filesSuffix")}`
            : t("copyProgress.preparing")}
        </p>
        <div className="modal-card__actions">
          <button className="btn" onClick={handleCancel} disabled={cancelling || !taskId}>
            {t("copyProgress.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
