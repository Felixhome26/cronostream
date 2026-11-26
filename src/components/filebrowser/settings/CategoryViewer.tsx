import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../../busy";
import { t } from "../../../i18n";
import { SETTING_KEYS, type VideoRegenProgress, type ViewerNavMode, type ViewerNavType } from "../../../types";
import ChoiceRow from "./ChoiceRow";
import PreferencesGroup from "./PreferencesGroup";
import PreferencesRow, { Reveal, Switch, ToggleRow } from "./PreferencesRow";
import { useSettings } from "./SettingsContext";

const NAV_MODES: ViewerNavMode[] = ["category", "all", "custom"];
const NAV_TYPES: { type: ViewerNavType; labelKey: string }[] = [
  { type: "image", labelKey: "timeline.laneImages" },
  { type: "video", labelKey: "timeline.laneVideos" },
  { type: "audio", labelKey: "timeline.laneAudios" },
  { type: "document", labelKey: "timeline.laneDocuments" },
];

export default function CategoryViewer() {
  const { settings, onChange } = useSettings();
  const [framePercent, setFramePercent] = useState(String(settings.defaultVideoFramePercent));
  const [regenNow, setRegenNow] = useState(false);
  const [applying, setApplying] = useState(false);
  const [regenProgress, setRegenProgress] = useState<VideoRegenProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFramePercent(String(settings.defaultVideoFramePercent));
  }, [settings.defaultVideoFramePercent]);

  useEffect(() => {
    const unlisten = listen<VideoRegenProgress>("video-regen-progress", (event) => {
      setRegenProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const parsedPercent = Number(framePercent);
  const percentValid = Number.isFinite(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100;
  const percentChanged = percentValid && parsedPercent !== settings.defaultVideoFramePercent;

  async function applyFramePercent() {
    if (!percentValid) return;
    setApplying(true);
    setError(null);
    try {
      // Saved first (and logged/undoable on its own) regardless of whether
      // regeneration is also requested — the two are separate concerns:
      // one changes what *future* imports use, the other is an explicit,
      // possibly slow, one-off pass over what's already there.
      onChange({ defaultVideoFramePercent: parsedPercent });

      if (regenNow) {
        setRegenProgress({ done: 0, total: 0, current: "" });
        await invoke<number>("regenerate_video_thumbnails", { percent: parsedPercent });
        setRegenProgress(null);
        setRegenNow(false);
        setError(null);
      }
    } catch (e) {
      setError(typeof e === "string" ? e : t("settings.videoFrameError"));
      setRegenProgress(null);
    } finally {
      setApplying(false);
    }
  }

  const regenPercentDone =
    regenProgress && regenProgress.total > 0 ? Math.round((regenProgress.done / regenProgress.total) * 100) : 0;

  return (
    <>
      <PreferencesGroup>
        <ChoiceRow
          label={t("settings.viewerNavTitle")}
          hint={t("settings.viewerNavIntro")}
          options={NAV_MODES}
          optionKeyPrefix="settings.viewerNav"
          value={settings.viewerNavMode}
          onPick={(viewerNavMode) => onChange({ viewerNavMode })}
          scopeKeys={[SETTING_KEYS.viewerNavMode, SETTING_KEYS.viewerNavTypes]}
        >
          <Reveal open={settings.viewerNavMode === "custom"}>
            <div className="prefs-subs">
              {NAV_TYPES.map(({ type, labelKey }) => {
                const on = settings.viewerNavTypes.includes(type);
                return (
                  <div key={type} className="prefs-subs__item">
                    <span>{t(labelKey)}</span>
                    <Switch
                      compact
                      on={on}
                      label={t(labelKey)}
                      onToggle={() =>
                        onChange({
                          viewerNavTypes: on
                            ? settings.viewerNavTypes.filter((x) => x !== type)
                            : [...settings.viewerNavTypes, type],
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </Reveal>
        </ChoiceRow>
        <ToggleRow
          id="setting-timestamp-overlay"
          label={t("settings.timestampOverlay")}
          hint={t("settings.timestampOverlayHint")}
          on={settings.showTimestampOverlay}
          onToggle={() => onChange({ showTimestampOverlay: !settings.showTimestampOverlay })}
          scopeKeys={[SETTING_KEYS.timestampOverlay]}
        />
      </PreferencesGroup>
      <PreferencesGroup>
        <PreferencesRow
          id="setting-video-frame"
          label={t("settings.videoFrame")}
          hint={t("settings.videoFrameHint")}
          scopeKeys={[SETTING_KEYS.videoFramePercent]}
          control={
            <span className="prefs-input">
              <input
                id="setting-video-frame"
                type="number"
                min={0}
                max={100}
                step={1}
                className="text-input settings-row__number"
                value={framePercent}
                onChange={(ev) => setFramePercent(ev.target.value)}
                disabled={applying}
              />
              <span>%</span>
              <button
                className="btn"
                onClick={() => void applyFramePercent()}
                disabled={applying || !percentValid || (!percentChanged && !regenNow)}
              >
                {t("settings.videoFrameApply")}
              </button>
            </span>
          }
        >
          {!percentValid && <span className="prefs-row__error">{t("settings.videoFrameInvalid")}</span>}
          <label className="settings-row__checkbox">
            <input type="checkbox" checked={regenNow} onChange={(ev) => setRegenNow(ev.target.checked)} disabled={applying} />
            <span>{t("settings.videoFrameRegenNow")}</span>
          </label>
          <span className="prefs-row__hint">{t("settings.videoFrameRegenHint")}</span>
          {regenProgress && (
            <div className="settings-row__regen-progress">
              <div className="progress-bar">
                <div className="progress-bar__fill" style={{ width: `${regenPercentDone}%` }} />
              </div>
              <p className="progress-bar__status">
                {regenProgress.total > 0
                  ? `${regenProgress.done} / ${regenProgress.total}${regenProgress.current ? ` – ${regenProgress.current}` : ""}`
                  : t("settings.videoFrameRegenPreparing")}
              </p>
            </div>
          )}
          {error && <span className="prefs-row__error">{error}</span>}
        </PreferencesRow>
      </PreferencesGroup>
    </>
  );
}
