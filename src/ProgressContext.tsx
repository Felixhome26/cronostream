import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

interface ProgressEventPayload {
  id: string;
  done: number;
  total: number;
  current: string;
}

interface Operation {
  id: string;
  label: string;
  done: number;
  total: number;
  current: string;
}

interface ProgressApi {
  /// Registers a running bulk operation so it shows up in the global
  /// indicator. `id` must match the id the backend command emits progress
  /// events under (see `progress::emit_progress` on the Rust side) —
  /// typically a fresh UUID generated per call, since several bulk
  /// operations could in principle run at once.
  startOperation: (op: { id: string; label: string; total: number }) => void;
  /// Removes an operation from the indicator — call this once the
  /// `invoke(...)` promise that started it has settled (success or error),
  /// not when it merely reaches done === total, since the backend command
  /// may still be doing bookkeeping (e.g. writing the log entry) after the
  /// last progress event.
  finishOperation: (id: string) => void;
}

const ProgressContext = createContext<ProgressApi | null>(null);

/// Listens once for the backend's single shared progress event
/// ("cronostream-progress") and fans updates out by `id` — so a new bulk
/// command only needs to call `startOperation`/`finishOperation` around its
/// `invoke(...)`, not add its own `listen()`/cleanup boilerplate.
export function ProgressProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<Operation[]>([]);

  useEffect(() => {
    const unlistenPromise = listen<ProgressEventPayload>("cronostream-progress", (event) => {
      const update = event.payload;
      setOperations((prev) => prev.map((op) => (op.id === update.id ? { ...op, done: update.done, total: update.total, current: update.current } : op)));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const startOperation = useCallback((op: { id: string; label: string; total: number }) => {
    setOperations((prev) => [...prev.filter((o) => o.id !== op.id), { ...op, done: 0, current: "" }]);
  }, []);

  const finishOperation = useCallback((id: string) => {
    setOperations((prev) => prev.filter((o) => o.id !== id));
  }, []);

  const api = useRef<ProgressApi>({ startOperation, finishOperation });
  api.current = { startOperation, finishOperation };

  return (
    <ProgressContext.Provider value={api.current}>
      {children}
      {operations.length > 0 && (
        <div className="progress-indicator-stack">
          {operations.map((op) => {
            const percent = op.total > 0 ? Math.min(100, Math.round((op.done / op.total) * 100)) : 0;
            return (
              <div className="progress-indicator" key={op.id} role="status" aria-live="polite">
                <span className="progress-indicator__label">{op.label}</span>
                <div className="progress-bar">
                  <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
                </div>
                <span className="progress-indicator__status">
                  {op.done} / {op.total}
                  {op.current ? ` — ${op.current}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ProgressContext.Provider>
  );
}

export function useProgress(): ProgressApi {
  const ctx = useContext(ProgressContext);
  if (!ctx) {
    throw new Error("useProgress must be used within a ProgressProvider");
  }
  return ctx;
}
