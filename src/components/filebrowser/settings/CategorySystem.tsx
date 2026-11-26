import { LANGUAGES, LANGUAGE_NATIVE_NAMES, currentLanguage, setLanguage, t } from "../../../i18n";
import { setTheme, useTheme } from "../../../theme";
import AppStartSection from "../AppStartSection";
import UninstallSection from "../UninstallSection";
import WatchFolderSection from "../WatchFolderSection";
import PreferencesGroup from "./PreferencesGroup";
import PreferencesRow from "./PreferencesRow";
import SegmentedControl from "./SegmentedControl";

/// Language, appearance and start-up. Everything here is machine-wide by
/// nature, so no row carries a scope symbol.
export default function CategorySystem() {
  const theme = useTheme();
  return (
    <>
      <PreferencesGroup title={t("settings.groupLanguage")}>
        <PreferencesRow
          label={t("settings.language")}
          hint={t("settings.languageHint")}
          stacked
          control={
            <SegmentedControl
              label={t("settings.language")}
              value={currentLanguage()}
              onPick={setLanguage}
              // Each name in its own language, so the right one can be found
              // whatever the UI currently reads.
              options={LANGUAGES.map((language) => ({
                value: language,
                label: LANGUAGE_NATIVE_NAMES[language],
                lang: language,
              }))}
            />
          }
        />
      </PreferencesGroup>
      <PreferencesGroup title={t("settings.groupAppearance")}>
        <PreferencesRow
          label={t("settings.theme")}
          hint={t("settings.themeHint")}
          stacked
          control={
            <SegmentedControl
              label={t("settings.theme")}
              value={theme}
              onPick={setTheme}
              options={[
                { value: "light", label: t("settings.themeLight") },
                { value: "dark", label: t("settings.themeDark") },
              ]}
            />
          }
        />
      </PreferencesGroup>
      <AppStartSection />
      <WatchFolderSection />
      <UninstallSection />
    </>
  );
}
