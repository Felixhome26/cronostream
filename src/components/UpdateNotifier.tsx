import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { useToast } from "../ToastContext";
import { DOWNLOAD_URL, markAnnounced, runAutoUpdateCheck, wasAnnounced } from "../utils/updateCheck";
import { useWelcomeOpen } from "../utils/welcome";

/// How long after the start the background check begins: the start itself
/// (opening a stream, thumbnails) comes first.
const START_DELAY_MS = 15_000;
const HINT_DURATION_MS = 15_000;

/// Renders nothing; asks once a day (at most) whether a newer version exists
/// and, if so, shows a toast with a button to the download page, once per
/// version. A failed check (offline, server down) is silent by design.
export default function UpdateNotifier() {
  const showToast = useToast();
  const welcomeOpen = useWelcomeOpen();
  const [found, setFound] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void runAutoUpdateCheck().then((version) => {
        if (!cancelled && version && !wasAnnounced(version)) setFound(version);
      });
    }, START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // Toasts sit above dialogs, so the hint waits for the welcome dialog to close.
  useEffect(() => {
    if (!found || welcomeOpen) return;
    markAnnounced(found);
    setFound(null);
    showToast(t("update.available").replace("{version}", found), {
      durationMs: HINT_DURATION_MS,
      action: {
        label: t("update.download"),
        onClick: () => {
          openUrl(DOWNLOAD_URL).catch(() => showToast(t("update.openError")));
        },
      },
    });
  }, [found, welcomeOpen, showToast]);

  return null;
}
