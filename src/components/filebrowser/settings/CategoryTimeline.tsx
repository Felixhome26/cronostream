import { t } from "../../../i18n";
import { SETTING_KEYS } from "../../../types";
import LaneOrderField from "./LaneOrderField";
import PeekTabsField from "./PeekTabsField";
import PreferencesGroup from "./PreferencesGroup";
import { ToggleRow } from "./PreferencesRow";
import { useSettings } from "./SettingsContext";

export default function CategoryTimeline() {
  const { settings, onChange } = useSettings();
  return (
    <>
      <PreferencesGroup intro={t("settings.lanesIntro")}>
        <LaneOrderField />
      </PreferencesGroup>
      <PreferencesGroup title={t("settings.groupTiles")}>
        <ToggleRow
          id="setting-tile-drag"
          label={t("settings.tileDrag")}
          hint={t("settings.tileDragHint")}
          on={settings.tileDragEnabled}
          onToggle={() => onChange({ tileDragEnabled: !settings.tileDragEnabled })}
          scopeKeys={[SETTING_KEYS.tileDrag]}
        />
      </PreferencesGroup>
      <PreferencesGroup>
        <PeekTabsField />
      </PreferencesGroup>
    </>
  );
}
