import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { useToast } from "../ToastContext";

const SUPPORT_URL = "https://felixheck.de/cronostream/donatenow.html";

// Coffee-cup button for the header row (project view) and the start screen's
// top-right corner. In flow of the header instead of floating over the content,
// so it can neither cover nor be covered by anything. An inline SVG rather than
// the ☕ emoji: doesn't depend on an emoji font being installed.
export default function SupportLink({ className = "" }: { className?: string }) {
  const showToast = useToast();

  return (
    <button
      type="button"
      className={"icon-btn support-link" + (className ? " " + className : "")}
      title={t("support.title")}
      aria-label={t("support.title")}
      onClick={() => {
        openUrl(SUPPORT_URL).catch(() => showToast(t("support.openError")));
      }}
    >
      <svg
        className="support-link__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 2v2" />
        <path d="M10 2v2" />
        <path d="M14 2v2" />
        <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
      </svg>
    </button>
  );
}
