import { useEffect, useState } from "react";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import type { DesktopIntegrationStatus } from "../../types";
import { openUninstallDialog } from "../UninstallDialog";
import PreferencesGroup from "./settings/PreferencesGroup";
import PreferencesRow from "./settings/PreferencesRow";

/// Only in the installed app (an AppImage, a Windows release build) — the
/// same condition the start menu entries have, so their status decides.
export default function UninstallSection() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    invoke<DesktopIntegrationStatus>("get_desktop_integration")
      .then((status) => setAvailable(status.available))
      .catch(() => {});
  }, []);

  if (!available) return null;
  return (
    <PreferencesGroup title={t("settings.groupUninstall")}>
      <PreferencesRow
        label={t("uninstall.settingsLabel")}
        hint={t("uninstall.settingsHint")}
        control={
          <button type="button" className="btn btn--danger" onClick={openUninstallDialog}>
            {t("uninstall.settingsButton")}
          </button>
        }
      />
    </PreferencesGroup>
  );
}
