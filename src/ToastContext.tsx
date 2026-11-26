import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { t } from "./i18n";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  message: string;
  action?: ToastAction;
}

/// Returns a function that takes the toast down early — for a hint that
/// belongs to one view and must not outlive it (it stayed up over the start
/// screen and its dialogs after leaving the timeline).
type ShowToast = (message: string, options?: ToastOptions) => () => void;

const ToastContext = createContext<ShowToast | null>(null);

const DEFAULT_DURATION_MS = 3000;
// One shared place across the whole app, not one per view — see
// ToastContext's doc comment on why this replaced three independent
// instances (StartScreen/ProjectShell/FileBrowser).
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const toastsRef = useRef<ToastEntry[]>([]);
  toastsRef.current = toasts;

  const showToast = useCallback<ShowToast>((message, options) => {
    // A toast whose text is already on screen is not stacked a second time
    // (e.g. a hint re-triggered by switching views back and forth).
    const shown = toastsRef.current.find((toast) => toast.message === message);
    if (shown) return () => setToasts((prev) => prev.filter((toast) => toast.id !== shown.id));
    const id = nextId.current++;
    setToasts((prev) => {
      const next = [...prev, { id, message, action: options?.action }];
      // Oldest drops immediately rather than queueing — a backlog of
      // stale toasts waiting their turn would outlive the events they
      // describe.
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
    const remove = () => setToasts((prev) => prev.filter((t) => t.id !== id));
    setTimeout(remove, options?.durationMs ?? DEFAULT_DURATION_MS);
    return remove;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <span>{toast.message}</span>
            {toast.action && (
              <>
                <button className="toast__action" onClick={toast.action.onClick}>
                  {toast.action.label}
                </button>
                {/* Only toasts carrying an action get a close button: those
                    are the long-lived explainers, where the choice between
                    "away for now" and "never again" actually matters. A
                    plain status message disappears on its own long before
                    anyone would aim at a cross. */}
                <button
                  className="toast__close"
                  onClick={() => dismiss(toast.id)}
                  title={t("toast.close")}
                  aria-label={t("toast.close")}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Returns a plain `showToast(message, options?)` function — kept as a
// function rather than an object so call sites that only used to hold a
// string setter don't need to change shape beyond the rename.
export function useToast(): ShowToast {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
