import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { SETTING_KEYS } from "../../../types";
import PreferencesGroup from "./PreferencesGroup";
import PreferencesRow, { Reveal, ToggleRow } from "./PreferencesRow";
import { useSettings } from "./SettingsContext";
import { useSavedFlash } from "./useSavedFlash";

export default function CategoryFiles({ onGoToDuplicates }: { onGoToDuplicates: () => void }) {
  const { settings, onChange } = useSettings();
  const [earliestYear, setEarliestYear] = useState(String(settings.earliestDateYear));
  const [saved, flashSaved] = useSavedFlash();

  useEffect(() => {
    setEarliestYear(String(settings.earliestDateYear));
  }, [settings.earliestDateYear]);

  const parsed = Number(earliestYear);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= new Date().getFullYear();

  function applyEarliestYear() {
    if (valid && parsed !== settings.earliestDateYear) {
      onChange({ earliestDateYear: parsed });
      flashSaved();
    }
  }

  return (
    <>
      <PreferencesGroup>
        <ToggleRow
          id="setting-delete-on-remove"
          label={t("settings.deleteOnRemove")}
          hint={t("settings.deleteOnRemoveHint")}
          on={settings.deleteFilesOnRemove}
          onToggle={() => onChange({ deleteFilesOnRemove: !settings.deleteFilesOnRemove })}
          scopeKeys={[SETTING_KEYS.deleteOnRemove]}
        />
        <ToggleRow
          id="setting-quick-hash-on-ingest"
          label={t("settings.quickHashOnIngest")}
          hint={t("settings.quickHashOnIngestHint")}
          on={settings.quickHashOnIngest}
          onToggle={() => onChange({ quickHashOnIngest: !settings.quickHashOnIngest })}
          scopeKeys={[SETTING_KEYS.quickHashOnIngest]}
        />
        <Reveal open={settings.quickHashOnIngest}>
          <ToggleRow
            id="setting-quick-hash-prefilter"
            sub
            label={t("settings.quickHashUsePrefilter")}
            hint={t("settings.quickHashUsePrefilterHint")}
            on={settings.quickHashUsePrefilter}
            onToggle={() => onChange({ quickHashUsePrefilter: !settings.quickHashUsePrefilter })}
            scopeKeys={[SETTING_KEYS.quickHashUsePrefilter]}
          />
        </Reveal>
        <PreferencesRow
          id="setting-earliest-year"
          label={t("settings.earliestYear")}
          hint={t("settings.earliestYearHint")}
          scopeKeys={[SETTING_KEYS.earliestDateYear]}
          control={
            <span className="prefs-input">
              <input
                id="setting-earliest-year"
                type="number"
                min={1}
                max={new Date().getFullYear()}
                step={1}
                className="text-input settings-row__number"
                value={earliestYear}
                onChange={(ev) => setEarliestYear(ev.target.value)}
                onBlur={applyEarliestYear}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") applyEarliestYear();
                }}
              />
              {saved && (
                <span className="prefs-saved" role="status">
                  ✓ {t("settings.saved")}
                </span>
              )}
            </span>
          }
        >
          {!valid && <span className="prefs-row__error">{t("settings.earliestYearInvalid")}</span>}
        </PreferencesRow>
      </PreferencesGroup>
      <PreferencesGroup>
        <PreferencesRow
          label={t("settings.goToDuplicatesIntro")}
          control={
            <button type="button" className="btn" onClick={onGoToDuplicates}>
              {t("settings.goToDuplicates")}
            </button>
          }
        />
      </PreferencesGroup>
    </>
  );
}
