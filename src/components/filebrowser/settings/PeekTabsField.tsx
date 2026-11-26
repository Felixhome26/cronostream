import { t } from "../../../i18n";
import { SETTING_KEYS } from "../../../types";
import PreferencesRow, { Switch } from "./PreferencesRow";
import { useSettings } from "./SettingsContext";

/// The views that can show the timeline preview, grouped the way the file
/// browser's rail groups them. Names are `BrowserTab` values.
const PEEK_GROUPS: { categoryKey: string; tabs: { tab: string; labelKey: string }[] }[] = [
  {
    categoryKey: "browser.categories.add",
    tabs: [
      { tab: "grid", labelKey: "browser.tabs.grid" },
      { tab: "single", labelKey: "browser.tabs.single" },
      { tab: "search", labelKey: "browser.tabs.search" },
      { tab: "manifest", labelKey: "browser.tabs.manifest" },
    ],
  },
  { categoryKey: "browser.categories.review", tabs: [{ tab: "ai_metadata", labelKey: "browser.tabs.aiMetadata" }] },
  {
    categoryKey: "browser.categories.manage",
    tabs: [
      { tab: "file_ops", labelKey: "browser.tabs.fileOps" },
      { tab: "protocol", labelKey: "browser.tabs.protocol" },
      { tab: "duplicates", labelKey: "browser.tabs.duplicates" },
      { tab: "trash", labelKey: "browser.tabs.trash" },
      { tab: "backup", labelKey: "browser.tabs.backup" },
    ],
  },
  { categoryKey: "browser.categories.settings", tabs: [{ tab: "settings", labelKey: "browser.tabs.settings" }] },
];

/// Where the floating timeline preview is offered: one switch per view of the
/// file browser, grouped by workflow phase, laid out as columns. Changing the
/// list never touches the open view — it only decides whether the preview
/// shows up.
export default function PeekTabsField() {
  const { settings, onChange } = useSettings();
  const tabs = settings.peekTabs;
  return (
    <PreferencesRow
      label={t("settings.peekTitle")}
      hint={t("settings.peekShort")}
      detail={t("settings.peekDesc")}
      scopeKeys={[SETTING_KEYS.peekTabs]}
      stacked
      control={
        <div className="prefs-peek">
          {PEEK_GROUPS.map((group) => (
            <div key={group.categoryKey} className="prefs-peek__group">
              <span className="prefs-peek__title">{t(group.categoryKey)}</span>
              {group.tabs.map(({ tab, labelKey }) => {
                const on = tabs.includes(tab);
                return (
                  <div key={tab} className="prefs-peek__item">
                    <span>{t(labelKey)}</span>
                    <Switch
                      compact
                      on={on}
                      label={t(labelKey)}
                      onToggle={() => onChange({ peekTabs: on ? tabs.filter((x) => x !== tab) : [...tabs, tab] })}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      }
    />
  );
}
