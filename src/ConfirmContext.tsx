import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "./i18n";

/// One app-wide "are you sure?" dialog for the actions that cannot be
/// undone (permanently deleting files). Promise-based, so a call site reads
/// as `if (!(await confirm({...}))) return;` right in front of the action
/// instead of threading open/closed state through every component.

interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  /// Locks the confirm button this many seconds, so the click can't be
  /// the tail end of the click that opened the dialog. Default 2.
  countdownSeconds?: number;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

const DEFAULT_COUNTDOWN_SECONDS = 2;

interface Pending extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [remaining, setRemaining] = useState(0);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open answers the first with "no"
        // rather than leaving its caller waiting forever.
        pendingRef.current?.resolve(false);
        setRemaining(options.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS);
        setPending({ ...options, resolve });
      }),
    [],
  );

  const answer = useCallback((confirmed: boolean) => {
    pendingRef.current?.resolve(confirmed);
    setPending(null);
  }, []);

  useEffect(() => {
    if (!pending || remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((prev) => prev - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [pending, remaining]);

  // While open, the dialog owns the keyboard: captured before any of the
  // views' own window listeners, so e.g. Entf in the viewer behind it can't
  // fire a second removal.
  useEffect(() => {
    if (!pending) return;
    function onKeyDown(ev: KeyboardEvent) {
      ev.stopPropagation();
      if (ev.key === "Escape") {
        ev.preventDefault();
        answer(false);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (remaining <= 0) answer(true);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pending, remaining, answer]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="modal-overlay confirm-dialog" onMouseDown={() => answer(false)}>
          <div className="modal-card" role="alertdialog" aria-modal="true" onMouseDown={(ev) => ev.stopPropagation()}>
            <h2 className="modal-card__title">{pending.title}</h2>
            <p className="modal-card__body">{pending.body}</p>
            <div className="modal-card__actions">
              <button className="btn" autoFocus onClick={() => answer(false)}>
                {t("confirm.cancel")}
              </button>
              <button className="btn btn--danger" disabled={remaining > 0} onClick={() => answer(true)}>
                {remaining > 0 ? `${pending.confirmLabel} (${remaining})` : pending.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
