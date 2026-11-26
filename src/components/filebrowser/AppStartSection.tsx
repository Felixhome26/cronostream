import { useEffect, useState } from "react";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import type { DesktopEntries, DesktopIntegrationStatus } from "../../types";
import PreferencesGroup from "./settings/PreferencesGroup";
import { ToggleRow } from "./settings/PreferencesRow";
import { isWelcomeHidden, markDesktopSetupOffered, setWelcomeHidden } from "../../utils/welcome";

const ENTRY_OPTIONS: (keyof DesktopEntries)[] = ["app", "dropzone", "desktop", "autostart"];

/// App-wide by nature, so without the scope control of the other settings.
/// The entries exist for an AppImage and an installed Windows app alike, and
/// stay out of sight otherwise (`tauri dev`).
export default function AppStartSection() {
  const [showWelcome, setShowWelcome] = useState(() => !isWelcomeHidden());
  const [entries, setEntries] = useState<DesktopEntries | null>(null);
  const [options, setOptions] = useState<(keyof DesktopEntries)[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    invoke<DesktopIntegrationStatus>("get_desktop_integration")
      .then((status) => {
        if (!status.available) return;
        setOptions(ENTRY_OPTIONS.filter((option) => status.supported[option]));
        setEntries(status.entries);
      })
      .catch(() => {});
  }, []);

  async function toggleEntry(option: keyof DesktopEntries) {
    if (!entries) return;
    try {
      const status = await invoke<DesktopIntegrationStatus>("set_desktop_integration", {
        entries: { ...entries, [option]: !entries[option] },
      });
      setEntries(status.entries);
      setError(false);
      markDesktopSetupOffered();
    } catch {
      setError(true);
    }
  }

  return (
    <PreferencesGroup title={t("settings.groupStart")}>
      <ToggleRow
        id="setting-show-welcome"
        label={t("settings.showWelcome")}
        hint={t("settings.showWelcomeHint")}
        on={showWelcome}
        onToggle={() => {
          setWelcomeHidden(showWelcome);
          setShowWelcome(!showWelcome);
        }}
      />
      {entries &&
        options.map((option) => (
          <ToggleRow
            key={option}
            id={`setting-desktop-${option}`}
            label={t(`desktop.${option}`)}
            hint={t(`desktop.${option}Hint`)}
            on={entries[option]}
            onToggle={() => void toggleEntry(option)}
          />
        ))}
      {error && <p className="prefs-row__error prefs-row__error--pad">{t("desktop.error")}</p>}
    </PreferencesGroup>
  );
}
