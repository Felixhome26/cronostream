import { t } from "../../../i18n";
import { SETTING_KEYS, type HoverZoomBrake, type PileAction, type PileTrigger } from "../../../types";
import ChoiceRow from "./ChoiceRow";
import PreferencesGroup from "./PreferencesGroup";
import { ToggleRow } from "./PreferencesRow";
import { useSettings } from "./SettingsContext";

const PILE_ACTIONS: PileAction[] = ["fan", "zoom"];
const PILE_TRIGGERS: PileTrigger[] = ["hover", "click"];
const HOVER_ZOOM_BRAKES: HoverZoomBrake[] = ["step", "cascade", "click_only"];

export default function CategoryPiles() {
  const { settings, onChange } = useSettings();
  // The hover-zoom brake only decides anything when hovering is what opens
  // a stack AND the behaviour is zooming. Shown either way (so it can be
  // set up in advance, and so it doesn't appear out of nowhere later) but
  // dimmed and labelled with why it is currently dormant.
  const brakeActive = settings.pileTrigger === "hover" && settings.pileAction === "zoom";
  return (
    <>
      <PreferencesGroup intro={t("settings.pilesIntro")}>
        <ChoiceRow
          label={t("settings.pileTrigger")}
          hint={t("settings.pileTriggerDesc")}
          options={PILE_TRIGGERS}
          optionKeyPrefix="settings.pileTrigger"
          value={settings.pileTrigger}
          onPick={(pileTrigger) => onChange({ pileTrigger })}
          scopeKeys={[SETTING_KEYS.pileTrigger]}
        />
        <ChoiceRow
          label={t("settings.pileAction")}
          hint={t("settings.pileActionDesc")}
          options={PILE_ACTIONS}
          optionKeyPrefix="settings.pileAction"
          value={settings.pileAction}
          onPick={(pileAction) => onChange({ pileAction })}
          scopeKeys={[SETTING_KEYS.pileAction]}
        />
        <ChoiceRow
          label={t("settings.hoverZoomBrake")}
          hint={t("settings.hoverZoomBrakeDesc")}
          options={HOVER_ZOOM_BRAKES}
          optionKeyPrefix="settings.hoverZoomBrake"
          value={settings.hoverZoomBrake}
          onPick={(hoverZoomBrake) => onChange({ hoverZoomBrake })}
          note={brakeActive ? undefined : t("settings.hoverZoomBrakeInactive")}
          scopeKeys={[SETTING_KEYS.hoverZoomBrake]}
        />
        <ToggleRow
          id="setting-fan-cursor"
          label={t("settings.fanCursor")}
          hint={t("settings.fanCursorShort")}
          detail={`${t("settings.fanCursorHint")} ${t("settings.fanCursorNeedsFan")}`}
          on={settings.fanCursorFollow}
          onToggle={() => onChange({ fanCursorFollow: !settings.fanCursorFollow })}
          scopeKeys={[SETTING_KEYS.fanCursorFollow]}
        />
        <ToggleRow
          id="setting-wheel-viewer"
          label={t("settings.wheelViewer")}
          hint={t("settings.wheelViewerShort")}
          detail={t("settings.wheelViewerHint")}
          on={settings.wheelViewer}
          onToggle={() => onChange({ wheelViewer: !settings.wheelViewer })}
          scopeKeys={[SETTING_KEYS.wheelViewer]}
        />
      </PreferencesGroup>
      {/* Which grids the zoom passes through. Both rows say what the switch
          costs in tile size right under the label, not only behind the (?):
          that side effect is the whole reason to hesitate over them. */}
      <PreferencesGroup title={t("settings.zoomGridTitle")}>
        <ToggleRow
          id="setting-show-week-grid"
          label={t("settings.showWeekGrid")}
          hint={t("settings.showWeekGridShort")}
          detail={t("settings.showWeekGridHint")}
          on={settings.showWeekGrid}
          onToggle={() => onChange({ showWeekGrid: !settings.showWeekGrid })}
          scopeKeys={[SETTING_KEYS.showWeekGrid]}
        />
        <ToggleRow
          id="setting-show-hour-grid"
          label={t("settings.showHourGrid")}
          hint={t("settings.showHourGridShort")}
          detail={t("settings.showHourGridHint")}
          on={settings.showHourGrid}
          onToggle={() => onChange({ showHourGrid: !settings.showHourGrid })}
          scopeKeys={[SETTING_KEYS.showHourGrid]}
        />
      </PreferencesGroup>
    </>
  );
}
