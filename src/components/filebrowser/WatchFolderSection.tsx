import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import type { WatchFolderStatus } from "../../types";
import PreferencesGroup from "./settings/PreferencesGroup";
import PreferencesRow, { ToggleRow } from "./settings/PreferencesRow";

/// App-wide by nature (the drop box belongs to the app, not to one
/// stream), so without the scope control of the other settings. The
/// watching itself runs in the backend, also while only the drop box circle
/// is open.
export default function WatchFolderSection() {
  const [status, setStatus] = useState<WatchFolderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<WatchFolderStatus>("get_watch_folder")
      .then(setStatus)
      .catch(() => {});
  }, []);

  async function apply(path: string | null, recursive: boolean) {
    try {
      setStatus(await invoke<WatchFolderStatus>("set_watch_folder", { path, recursive }));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : t("watchFolder.error"));
    }
  }

  async function choose() {
    const folder = await openDialog({ directory: true, multiple: false, title: t("watchFolder.chooseTitle") });
    if (!folder || Array.isArray(folder)) return;
    await apply(folder, status?.recursive ?? true);
  }

  if (!status) return null;
  const chosen = status.path !== null;

  return (
    <PreferencesGroup title={t("watchFolder.group")}>
      <PreferencesRow
        label={t("watchFolder.label")}
        hint={t("watchFolder.hint")}
        stacked
        control={
          <div className="prefs-row__actions">
            {chosen && (
              <span className="prefs-row__value" title={status.path ?? undefined}>
                {status.path}
              </span>
            )}
            <button type="button" className="btn" onClick={() => void choose()}>
              {t(chosen ? "watchFolder.change" : "watchFolder.choose")}
            </button>
            {chosen && (
              <button type="button" className="btn" onClick={() => void apply(null, status.recursive)}>
                {t("watchFolder.clear")}
              </button>
            )}
          </div>
        }
      >
        {chosen && !status.exists && <p className="prefs-row__error">{t("watchFolder.missing")}</p>}
        {error && <p className="prefs-row__error">{error}</p>}
      </PreferencesRow>
      {chosen && (
        <ToggleRow
          id="setting-watch-recursive"
          sub
          label={t("watchFolder.recursive")}
          hint={t("watchFolder.recursiveHint")}
          on={status.recursive}
          onToggle={() => void apply(status.path, !status.recursive)}
        />
      )}
    </PreferencesGroup>
  );
}
