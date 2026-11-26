import type { ReactNode } from "react";
import { t } from "../i18n";
import { formatTime, SKIP_SECONDS, SPEEDS, type MediaControls } from "../hooks/useMediaControls";

interface Props extends MediaControls {
  /** Extra controls rendered at the far right of the secondary row (e.g. fullscreen). */
  rightExtra?: ReactNode;
}

// Shared control bar (play/pause, seek, skip, speed, volume) rendered by
// both AudioPlayer and VideoPlayer — see useMediaControls for the state
// machine behind it.
export default function MediaControlsBar({
  playing,
  currentTime,
  duration,
  buffered,
  volume,
  muted,
  rate,
  speedMenuOpen,
  setSpeedMenuOpen,
  error,
  converting,
  speedRef,
  togglePlay,
  skip,
  handleSeekInput,
  commitSeek,
  toggleMute,
  handleVolumeChange,
  applyRate,
  rightExtra,
}: Props) {
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <>
      {error && <div className="audio-player__error">⚠ {error}</div>}
      {converting && <div className="audio-player__note">{t("player.converting")}</div>}

      <div className="audio-player__row">
        <button
          type="button"
          className="audio-player__play"
          onClick={togglePlay}
          aria-label={playing ? t("player.pause") : t("player.play")}
        >
          {playing ? "⏸" : "▶"}
        </button>

        <span className="audio-player__time">{formatTime(currentTime)}</span>

        <div className="audio-player__seek">
          <div className="audio-player__seek-track">
            <div className="audio-player__seek-buffered" style={{ width: `${bufferedPercent}%` }} />
            <div className="audio-player__seek-fill" style={{ width: `${progressPercent}%` }} />
            <div className="audio-player__seek-thumb" style={{ left: `${progressPercent}%` }} />
          </div>
          <input
            type="range"
            className="audio-player__seek-input"
            min={0}
            max={duration || 0}
            step={0.01}
            value={currentTime}
            onChange={(ev) => handleSeekInput(Number(ev.target.value))}
            onMouseUp={(ev) => commitSeek(Number((ev.target as HTMLInputElement).value))}
            onTouchEnd={(ev) => commitSeek(Number((ev.target as HTMLInputElement).value))}
            onKeyUp={(ev) => commitSeek(Number((ev.target as HTMLInputElement).value))}
          />
        </div>

        <span className="audio-player__time">{formatTime(duration)}</span>
      </div>

      <div className="audio-player__row audio-player__row--secondary">
        <button type="button" className="audio-player__skip" onClick={() => skip(-SKIP_SECONDS)} aria-label={t("player.skipBack")}>
          ⟲ {SKIP_SECONDS}
        </button>
        <button type="button" className="audio-player__skip" onClick={() => skip(SKIP_SECONDS)} aria-label={t("player.skipForward")}>
          {SKIP_SECONDS} ⟳
        </button>

        <div className="audio-player__speed" ref={speedRef}>
          <button
            type="button"
            className="audio-player__speed-btn"
            onClick={() => setSpeedMenuOpen((v) => !v)}
            aria-label={t("player.speed")}
          >
            {rate}×
          </button>
          {speedMenuOpen && (
            <div className="audio-player__speed-menu">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={"audio-player__speed-option" + (speed === rate ? " audio-player__speed-option--active" : "")}
                  onClick={() => applyRate(speed)}
                >
                  {speed}×
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="audio-player__spacer" />

        <div className="audio-player__volume">
          <button
            type="button"
            className="audio-player__volume-btn"
            onClick={toggleMute}
            aria-label={muted || volume === 0 ? t("player.unmute") : t("player.mute")}
          >
            {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
          </button>
          <input
            type="range"
            className="audio-player__volume-input"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(ev) => handleVolumeChange(Number(ev.target.value))}
            aria-label={t("player.volume")}
          />
        </div>

        {rightExtra}
      </div>
    </>
  );
}
