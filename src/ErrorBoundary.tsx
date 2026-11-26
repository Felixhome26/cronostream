import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "./busy";
import { t } from "./i18n";

interface Props {
  children: ReactNode;
  /** A boundary around one part of the app (the detail view, the toolbox, a
   *  dialog) instead of the whole of it: its fallback is a small card over
   *  that part, and "Schließen" calls `onClose` — the rest of the app keeps
   *  running. Without it, this is the app-wide crash screen. */
  local?: boolean;
  /** Called by the local fallback's button, after the boundary has reset.
   *  Should close the part that failed; left out, the part is rendered again. */
  onClose?: () => void;
  /** The app-wide crash screen of the main window: closes the open
   *  Stream before reloading. The backend keeps it open across a reload
   *  of the page, and reopening it would then report it as already open. */
  releaseProjectOnReload?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort safety net: without this, an uncaught render error anywhere
 * in the app unmounts the whole React tree and leaves a silent blank
 * window — the worst possible failure mode for "no technical knowledge
 * required" and impossible to diagnose remotely. This shows a plain-
 * language message plus the technical detail instead, and lets the user
 * get back to the start screen rather than being stuck.
 *
 * Also used locally (see `local`), so a failure in one view only takes
 * that view down.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CronoStream crashed:", error, info.componentStack);
    invoke("debug_log", {
      message: `React crash${this.props.local ? " (local)" : ""}: ${error.stack ?? error.message}\ncomponentStack:${info.componentStack}`,
    }).catch(() => {});
  }

  private async reload() {
    if (this.props.releaseProjectOnReload) {
      await invoke("close_current_project").catch(() => {});
    }
    window.location.reload();
  }

  private close() {
    this.setState({ error: null });
    this.props.onClose?.();
  }

  render() {
    if (this.state.error && this.props.local) {
      return (
        <div className="modal-overlay" role="alertdialog" aria-modal="true">
          <div className="modal-card">
            <h2 className="modal-card__title">{t("crash.localTitle")}</h2>
            <p className="modal-card__body">{t("crash.localBody")}</p>
            <pre className="crash-screen__detail">{this.state.error.message}</pre>
            <div className="modal-card__actions">
              <button className="btn btn--primary" autoFocus onClick={() => this.close()}>
                {t("crash.localClose")}
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <h1>{t("crash.title")}</h1>
          <p>{t("crash.body")}</p>
          <pre className="crash-screen__detail">{this.state.error.message}</pre>
          <button className="btn btn--primary" onClick={() => void this.reload()}>
            {t("crash.reload")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
