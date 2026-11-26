import { useEffect, useState } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";
import { hasStoredTheme, setTheme, useTheme } from "../theme";
import SegmentedControl from "./filebrowser/settings/SegmentedControl";
import type { DesktopEntries, DesktopIntegrationStatus } from "../types";
import {
  isDesktopSetupOffered,
  markDesktopSetupOffered,
  setWelcomeHidden,
  setWelcomeOpen,
} from "../utils/welcome";

const ICON_PATHS = {
  local: "M6 11V8a6 6 0 0 1 12 0v3m-13 0h14v10H5z",
  time: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  safe: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
} as const;
const POINTS = ["local", "time", "safe"] as const;
const SETUP_OPTIONS: (keyof DesktopEntries)[] = ["app", "dropzone", "desktop", "autostart"];

/// Ticked unless they exist already: on Windows the installer has made the
/// start menu entries, and the desktop shortcut only if it was ticked there,
/// so what exists is kept and nothing left out there comes back.
const SETUP_DEFAULTS: DesktopEntries = { app: true, dropzone: true, desktop: false, autostart: true };

interface Props {
  onClose: () => void;
}

/// Shown when the main window opens, until "don't show again" is ticked. In
/// the installed app (AppImage, Windows) it also makes the one-time offer of
/// start menu, desktop and autostart entries (`desktop_integration.rs`),
/// rather than a second dialog right after this one; the same choices stay
/// available in the settings.
export default function WelcomeDialog({ onClose }: Props) {
  const theme = useTheme();
  const logoSrc = theme === "light" ? "/favicon_light.png" : "/favicon.png";
  // First start only: until a theme is stored, the dialog asks for one. Read
  // once, so the choice stays on screen after picking.
  const [askTheme] = useState(() => !hasStoredTheme());
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [offerSetup, setOfferSetup] = useState(false);
  const [options, setOptions] = useState<(keyof DesktopEntries)[]>([]);
  const [entries, setEntries] = useState<DesktopEntries>(SETUP_DEFAULTS);
  const [error, setError] = useState(false);

  useEffect(() => {
    setWelcomeOpen(true);
    return () => setWelcomeOpen(false);
  }, []);

  useEffect(() => {
    if (isDesktopSetupOffered()) return;
    invoke<DesktopIntegrationStatus>("get_desktop_integration")
      .then((status) => {
        setOptions(SETUP_OPTIONS.filter((option) => status.supported[option]));
        setEntries({
          app: SETUP_DEFAULTS.app || status.entries.app,
          dropzone: SETUP_DEFAULTS.dropzone || status.entries.dropzone,
          desktop: SETUP_DEFAULTS.desktop || status.entries.desktop,
          autostart: SETUP_DEFAULTS.autostart || status.entries.autostart,
        });
        setOfferSetup(status.available);
      })
      .catch(() => {});
  }, []);

  async function finish() {
    if (offerSetup) {
      try {
        await invoke("set_desktop_integration", { entries });
        markDesktopSetupOffered();
      } catch {
        setError(true);
        return;
      }
    }
    // Leaving with the preselected theme counts as a choice, so the
    // question does not come back on the next start.
    if (askTheme) setTheme(theme);
    if (dontShowAgain) setWelcomeHidden(true);
    onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card--wide welcome" role="dialog" aria-labelledby="welcome-title">
        <header className="welcome__header">
          <img className="welcome__logo" src={logoSrc} alt="" aria-hidden="true" />
          <h3 className="modal-card__title" id="welcome-title">
            {t("welcome.title")}
          </h3>
          <p className="welcome__intro">{t("welcome.intro")}</p>
        </header>
        <button className="icon-btn welcome__close" onClick={() => void finish()} aria-label={t("welcome.start")}>
          ✕
        </button>

        <ul className="welcome__cards">
          {POINTS.map((key) => (
            <li className="welcome__card" key={key}>
              <svg className="welcome__card-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d={ICON_PATHS[key]} />
              </svg>
              <div>
                <h4 className="welcome__card-title">{t(`welcome.${key}Title`)}</h4>
                <p className="welcome__card-text">{t(`welcome.${key}Text`)}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="welcome__help">{t("welcome.help")}</p>

        {askTheme && (
          <fieldset className="welcome__setup welcome__theme">
            <legend>{t("welcome.themeTitle")}</legend>
            <SegmentedControl
              label={t("welcome.themeTitle")}
              value={theme}
              onPick={setTheme}
              options={[
                { value: "light", label: t("settings.themeLight") },
                { value: "dark", label: t("settings.themeDark") },
              ]}
            />
            <p className="welcome__setup-hint">{t("welcome.setupHint")}</p>
          </fieldset>
        )}

        {offerSetup && (
          <fieldset className="welcome__setup">
            <legend>{t("welcome.setupTitle")}</legend>
            {options.map((option) => (
              <label className="welcome__check" key={option}>
                <input
                  type="checkbox"
                  checked={entries[option]}
                  onChange={(ev) => setEntries({ ...entries, [option]: ev.target.checked })}
                />
                {t(`desktop.${option}`)}
              </label>
            ))}
            <p className="welcome__setup-hint">{t("welcome.setupHint")}</p>
            {error && <p className="delete-dialog__error">{t("desktop.error")}</p>}
          </fieldset>
        )}

        <div className="modal-card__actions welcome__actions">
          <label className="welcome__check welcome__dont-show">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(ev) => setDontShowAgain(ev.target.checked)}
            />
            {t("welcome.dontShowAgain")}
          </label>
          <button className="btn btn--primary" onClick={() => void finish()}>
            {t("welcome.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
