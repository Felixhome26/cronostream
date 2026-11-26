import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../busy";
import { t } from "../i18n";
import { useToast } from "../ToastContext";
import type { AddItemsResult, DatedPath } from "../types";
import { formatDateTime } from "../utils/datetime";
import { notifyDuplicatesFound } from "../utils/duplicateImportToast";
import { mediaUrl } from "../utils/mediaServer";
import AudioPlayer from "./AudioPlayer";
import VideoPlayer from "./VideoPlayer";

export type RecordMode = "video" | "audio";

interface Device {
  id: string;
  /// Empty for the "system default" entry.
  label: string;
}

interface DeviceList {
  video: Device[];
  audio: Device[];
}

interface FfmpegStatus {
  available: boolean;
  installMethod: "package" | "manual" | "bundled";
  manualCommand: string | null;
}

type InstallProgress = { phase: "package" };

type CaptureEvent = { kind: "level"; level: number } | { kind: "error"; message: string };

type Phase = "checking" | "install" | "installing" | "starting" | "ready" | "recording" | "paused" | "review" | "saving";

/// How many level values the waveform keeps — at ~30 values per second
/// that's a few seconds of history scrolling across the stage.
const LEVEL_HISTORY = 160;

const DEVICE_KEYS: Record<"video" | "audio", string> = {
  video: "cronostream.record.videoDevice",
  audio: "cronostream.record.audioDevice",
};

/// The device remembered from last time, if it's still plugged in —
/// otherwise the first one (on Linux that's the system default).
function pickDevice(devices: Device[], kind: "video" | "audio"): string | null {
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(DEVICE_KEYS[kind]);
  } catch {
    // Storage blocked — simply no memory.
  }
  if (remembered && devices.some((device) => device.id === remembered)) return remembered;
  return devices[0]?.id ?? null;
}

function rememberDevice(kind: "video" | "audio", id: string) {
  try {
    localStorage.setItem(DEVICE_KEYS[kind], id);
  } catch {
    // Not worth bothering anyone about.
  }
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function errorText(e: unknown, fallback: string): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : fallback;
}

interface Props {
  mode: RecordMode;
  /// Called after the recording actually landed in the project, so the
  /// timeline can refresh — same contract as `PendingDrops`' `onImported`.
  onAdded: () => void;
  onToast: (message: string) => void;
  onClose: () => void;
  /// Called with every item id from every duplicate group "Beim Einfügen
  /// auf Duplikate prüfen" found for this recording, once the user chooses
  /// to hand them off via the toast's action button.
  onDuplicatesFound: (ids: string[]) => void;
}

/// Record straight into the project: webcam or microphone, check the
/// result, give it a name, done.
///
/// The recording itself happens natively, in ffmpeg (`capture.rs`) — the
/// webview's own `MediaRecorder` can't be relied on under Linux. This
/// component only shows what comes back: camera frames as JPEGs on one
/// channel, microphone levels (and a device dying mid-take) on another.
/// The finished take is a file in the staging area, played back through
/// the media server like any other item.
export default function RecordMedia({ mode, onAdded, onToast, onClose, onDuplicatesFound }: Props) {
  const showToast = useToast();
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [installText, setInstallText] = useState("");
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [videoDevice, setVideoDevice] = useState<string | null>(null);
  const [audioDevice, setAudioDevice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [takePath, setTakePath] = useState<string | null>(null);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  /// A start/pause/stop is on its way to the backend (restarting ffmpeg
  /// takes a moment) — the buttons wait for it rather than queueing more.
  const [pending, setPending] = useState(false);

  const liveImgRef = useRef<HTMLImageElement | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  /// Bumped on every (re)open, so frames from a session that was already
  /// replaced can't land in the new one's preview.
  const sessionRef = useRef(0);
  /// The backend's name for the session this component opened last —
  /// `capture_close` only ever closes that one, never a newer one.
  const tokenRef = useRef<string | null>(null);

  const showFrame = useCallback((buffer: ArrayBuffer) => {
    const img = liveImgRef.current;
    if (!img) return;
    const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
    const previous = frameUrlRef.current;
    frameUrlRef.current = url;
    img.src = url;
    if (previous) URL.revokeObjectURL(previous);
  }, []);

  /// Opens the devices and starts the live preview.
  const open = useCallback(
    async (video: string | null, audio: string | null) => {
      const session = ++sessionRef.current;
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      tokenRef.current = token;
      setError(null);
      setPhase("starting");
      levelsRef.current = [];

      const frames = new Channel<ArrayBuffer>();
      frames.onmessage = (buffer) => {
        if (sessionRef.current === session) showFrame(buffer);
      };
      const events = new Channel<CaptureEvent>();
      events.onmessage = (event) => {
        if (sessionRef.current !== session) return;
        if (event.kind === "level") {
          const levels = levelsRef.current;
          levels.push(event.level);
          if (levels.length > LEVEL_HISTORY) levels.splice(0, levels.length - LEVEL_HISTORY);
        } else {
          setError(event.message);
        }
      };

      try {
        await invoke("capture_open", { token, mode, videoDevice: video, audioDevice: audio, frames, events });
        if (sessionRef.current === session) {
          setPhase("ready");
        } else {
          // Superseded (device switched again) or the dialog was closed
          // while the device was still starting: don't leave it running.
          void invoke("capture_close", { token }).catch(() => {});
        }
      } catch (e) {
        if (sessionRef.current === session) setError(errorText(e, t("record.startError")));
      }
    },
    [mode, showFrame],
  );

  /// Device list → remembered/first device → preview.
  const loadDevicesAndOpen = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const list = await invoke<DeviceList>("list_capture_devices");
      setDevices(list);
      const video = mode === "video" ? pickDevice(list.video, "video") : null;
      const audio = pickDevice(list.audio, "audio");
      setVideoDevice(video);
      setAudioDevice(audio);
      if (mode === "video" && !video) {
        setError(t("record.noCamera"));
        return;
      }
      if (mode === "audio" && !audio) {
        setError(t("record.noMicrophone"));
        return;
      }
      await open(video, audio);
    } catch (e) {
      setError(errorText(e, t("record.startError")));
    }
  }, [mode, open]);

  const checkFfmpeg = useCallback(async () => {
    setError(null);
    setPhase("checking");
    try {
      const status = await invoke<FfmpegStatus>("ffmpeg_status");
      setFfmpeg(status);
      if (status.available) {
        await loadDevicesAndOpen();
      } else {
        setPhase("install");
      }
    } catch (e) {
      setError(errorText(e, t("record.startError")));
    }
  }, [loadDevicesAndOpen]);

  useEffect(() => {
    void checkFfmpeg();
    return () => {
      // Releases the camera/microphone and throws away unfinished segments.
      sessionRef.current++;
      if (tokenRef.current) void invoke("capture_close", { token: tokenRef.current }).catch(() => {});
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = null;
    };
  }, [checkFfmpeg]);

  async function install() {
    setError(null);
    setPhase("installing");
    setInstallText(t("record.ffmpegInstalling"));
    const progress = new Channel<InstallProgress>();
    progress.onmessage = () => setInstallText(t("record.ffmpegPackage"));
    try {
      await invoke("install_ffmpeg", { progress });
      onToast(t("record.ffmpegInstalled"));
      await checkFfmpeg();
    } catch (e) {
      setPhase("install");
      setError(errorText(e, t("record.ffmpegInstallError")));
    }
  }

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // The waveform: mirrored, rounded bars scrolling in from the right, the
  // newest one on the right edge. Drawn per animation frame rather than per
  // level event, so it stays smooth however the events are batched.
  useEffect(() => {
    if (mode !== "audio") return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const styles = getComputedStyle(canvas);
      const current = phaseRef.current;
      const active = current === "recording";
      // The foreground gold, not the fill gold: on the light theme's cream
      // the fill gold would draw bars under 2:1.
      const color = active
        ? styles.getPropertyValue("--cs-accent-fg").trim() || "#efb751"
        : styles.getPropertyValue("--cs-text-dim").trim() || "rgba(247,247,242,0.56)";

      const barWidth = 4;
      const gap = 3;
      const slots = Math.max(1, Math.floor(width / (barWidth + gap)));
      const levels = levelsRef.current.slice(-slots);
      const mid = height / 2;
      ctx.fillStyle = color;
      if (active) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      }
      for (let i = 0; i < levels.length; i++) {
        const x = width - (levels.length - i) * (barWidth + gap);
        // A floor so silence still reads as a quiet line, not as nothing.
        const bar = Math.max(barWidth, levels[i] * (height - 8));
        ctx.globalAlpha = 0.35 + 0.65 * (i / levels.length);
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, mid - bar / 2, barWidth, bar, barWidth / 2);
        } else {
          ctx.rect(x, mid - bar / 2, barWidth, bar);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  // Esc closes, like the app's other modal layers — but not mid-recording,
  // where it would throw away a take the user is still making.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      if (phase === "recording" || phase === "paused" || phase === "saving" || phase === "installing") return;
      ev.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase, onClose]);

  async function start() {
    setError(null);
    setElapsed(0);
    setPhase("starting");
    setPending(true);
    try {
      await invoke("capture_record");
      setPhase("recording");
    } catch (e) {
      setError(errorText(e, t("record.startError")));
    } finally {
      setPending(false);
    }
  }

  async function togglePause() {
    setPending(true);
    try {
      if (phase === "recording") {
        setPhase("paused");
        await invoke("capture_pause");
      } else if (phase === "paused") {
        await invoke("capture_record");
        setPhase("recording");
      }
    } catch (e) {
      setError(errorText(e, t("record.startError")));
    } finally {
      setPending(false);
    }
  }

  async function stop() {
    setPhase("starting");
    setPending(true);
    try {
      const path = await invoke<string>("capture_stop");
      setTakePath(path);
      setTakeUrl(await mediaUrl(path));
      // Pre-fill a name so saving is one click; the user can still overwrite it.
      const prefix = mode === "video" ? t("record.defaultNameVideo") : t("record.defaultNameAudio");
      setName(`${prefix} ${formatDateTime(Date.now())}`);
      setPhase("review");
    } catch (e) {
      setError(errorText(e, t("record.startError")));
    } finally {
      setPending(false);
    }
  }

  /// Throws the take away and goes back to a live preview.
  async function discard() {
    if (takePath) void invoke("discard_recording", { path: takePath }).catch(() => {});
    setTakePath(null);
    setTakeUrl(null);
    setName("");
    setElapsed(0);
    await open(videoDevice, audioDevice);
  }

  async function changeDevice(kind: "video" | "audio", id: string) {
    rememberDevice(kind, id);
    const video = kind === "video" ? id : videoDevice;
    const audio = kind === "audio" ? id : audioDevice;
    setVideoDevice(video);
    setAudioDevice(audio);
    await open(video, audio);
  }

  async function save() {
    const trimmed = name.trim();
    if (!takePath || trimmed.length === 0) return;

    setPhase("saving");
    let path: string = takePath;
    try {
      path = await invoke<string>("name_recording", { path: takePath, name: trimmed });

      // A recording has no date to discover — it is being made right now,
      // which is exactly what the date override is for.
      const entry: DatedPath = { path, timestamp: new Date().toISOString(), timestamp_source: "recording" };
      // Single recording — not worth registering with the progress
      // indicator, so the id is passed but never started.
      const result = await invoke<AddItemsResult>("add_items_with_dates", { entries: [entry], operationId: crypto.randomUUID() });

      const added = result.added[0];
      if (!added) {
        onToast(result.skipped[0]?.reason ?? t("record.addError"));
        setTakePath(path);
        setTakeUrl(await mediaUrl(path));
        setPhase("review");
        return;
      }

      // The name the user typed is the item's display name; the staging
      // file only carries a sanitized version of it.
      await invoke("update_display_name", { id: added.id, displayName: trimmed });
      await invoke("discard_recording", { path }).catch(() => {});

      onAdded();
      onToast(t("record.addedToast"));
      notifyDuplicatesFound(showToast, result.duplicates, onDuplicatesFound);
      onClose();
    } catch (e) {
      onToast(errorText(e, t("record.addError")));
      setTakePath(path);
      setPhase("review");
    }
  }

  const isRecording = phase === "recording" || phase === "paused";
  const busy = phase === "saving" || phase === "installing";
  const title = mode === "video" ? t("record.videoTitle") : t("record.audioTitle");
  const live = phase === "ready" || isRecording || phase === "starting";
  const showVideoPicker = mode === "video" && (devices?.video.length ?? 0) > 1;
  const showAudioPicker = (devices?.audio.length ?? 0) > 1;
  const pickersLocked = phase !== "ready";

  function deviceLabel(device: Device): string {
    return device.label || t("record.systemDefault");
  }

  function renderStage() {
    if (phase === "install" || phase === "installing") {
      return (
        <div className="record-modal__install">
          <div className="record-modal__install-title">{t("record.ffmpegMissing")}</div>
          <div className="record-modal__hint">
            {ffmpeg?.installMethod === "bundled"
              ? t("record.ffmpegBundledMissing")
              : ffmpeg?.installMethod === "package"
                ? t("record.ffmpegPackageExplain")
                : t("record.ffmpegManualExplain")}
          </div>
          {ffmpeg?.manualCommand && ffmpeg.installMethod === "manual" && (
            <code className="record-modal__command">{ffmpeg.manualCommand}</code>
          )}
          {error && <div className="record-modal__error-text">{error}</div>}
          {error && ffmpeg?.manualCommand && ffmpeg.installMethod === "package" && (
            <>
              <div className="record-modal__hint">{t("record.ffmpegManualFallback")}</div>
              <code className="record-modal__command">{ffmpeg.manualCommand}</code>
            </>
          )}
          {phase === "installing" ? (
            <div className="record-modal__install-progress">
              <span className="record-modal__spinner" />
              <span>{installText}</span>
            </div>
          ) : ffmpeg?.installMethod !== "package" ? (
            <button className="btn" onClick={() => void checkFfmpeg()}>
              {t("record.ffmpegRecheck")}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => void install()}>
              {t("record.ffmpegInstall")}
            </button>
          )}
        </div>
      );
    }

    if (error) {
      return (
        <div className="record-modal__error">
          <div className="record-modal__error-text">{error}</div>
          <button className="btn" onClick={() => void checkFfmpeg()}>
            {t("record.retry")}
          </button>
        </div>
      );
    }

    if (phase === "checking") return <div className="record-modal__hint">{t("record.starting")}</div>;

    if (takeUrl && (phase === "review" || phase === "saving")) {
      return mode === "video" ? (
        <VideoPlayer src={takeUrl} className="record-modal__player--video" />
      ) : (
        <AudioPlayer src={takeUrl} className="record-modal__player--audio" />
      );
    }

    if (mode === "video") {
      return (
        <>
          <img ref={liveImgRef} className="record-modal__live" alt="" />
          {phase === "starting" && <div className="record-modal__overlay-hint">{t("record.starting")}</div>}
        </>
      );
    }

    return (
      <div className="record-modal__audio-stage">
        <canvas ref={canvasRef} className={"record-modal__wave" + (live ? "" : " record-modal__wave--idle")} />
        <span className="record-modal__hint">
          {phase === "starting"
            ? t("record.starting")
            : isRecording
              ? phase === "paused"
                ? t("record.paused")
                : t("record.inProgress")
              : t("record.audioReady")}
        </span>
      </div>
    );
  }

  return (
    <div className="record-modal">
      <div className="record-modal__panel">
        <div className="record-modal__header">
          <div className="record-modal__title">{title}</div>
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={isRecording || busy}
            title={t("record.close")}
            aria-label={t("record.close")}
          >
            ✕
          </button>
        </div>

        <div className="record-modal__explain">
          {mode === "video" ? t("record.videoExplain") : t("record.audioExplain")}
        </div>

        {(showVideoPicker || showAudioPicker) && phase !== "review" && phase !== "saving" && (
          <div className="record-modal__devices">
            {showVideoPicker && devices && (
              <label className="record-modal__device">
                <span className="record-modal__name-label">{t("record.camera")}</span>
                <select
                  className="text-input"
                  value={videoDevice ?? ""}
                  disabled={pickersLocked}
                  onChange={(ev) => void changeDevice("video", ev.target.value)}
                >
                  {devices.video.map((device) => (
                    <option key={device.id} value={device.id}>
                      {deviceLabel(device)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {showAudioPicker && devices && (
              <label className="record-modal__device">
                <span className="record-modal__name-label">{t("record.microphone")}</span>
                <select
                  className="text-input"
                  value={audioDevice ?? ""}
                  disabled={pickersLocked}
                  onChange={(ev) => void changeDevice("audio", ev.target.value)}
                >
                  {devices.audio.map((device) => (
                    <option key={device.id} value={device.id}>
                      {deviceLabel(device)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="record-modal__stage">
          {renderStage()}

          {isRecording && !error && (
            <div className="record-modal__status">
              <span className={"record-modal__dot" + (phase === "paused" ? " record-modal__dot--paused" : "")} />
              <span>{phase === "paused" ? t("record.paused") : t("record.inProgress")}</span>
              <span className="record-modal__elapsed">{formatElapsed(elapsed)}</span>
            </div>
          )}
        </div>

        {(phase === "review" || phase === "saving") && (
          <div className="record-modal__name">
            <label className="record-modal__name-label" htmlFor="record-name">
              {t("record.nameLabel")}
            </label>
            <input
              id="record-name"
              className="text-input"
              value={name}
              autoFocus
              placeholder={t("record.namePlaceholder")}
              onChange={(ev) => setName(ev.target.value)}
              disabled={busy}
            />
          </div>
        )}

        <div className="record-modal__footer">
          {phase === "review" || phase === "saving" ? (
            <>
              <button className="btn--text" onClick={() => void discard()} disabled={busy}>
                {t("record.discard")}
              </button>
              <button className="btn btn--primary" onClick={() => void save()} disabled={busy || name.trim() === ""}>
                {busy ? t("record.adding") : t("record.add")}
              </button>
            </>
          ) : (
            <>
              {isRecording && (
                <button className="btn" onClick={() => void togglePause()} disabled={pending || !!error}>
                  {phase === "paused" ? t("record.resume") : t("record.pause")}
                </button>
              )}
              {isRecording ? (
                <button className="btn btn--primary" onClick={() => void stop()} disabled={pending}>
                  {t("record.stop")}
                </button>
              ) : (
                <button className="btn btn--primary" onClick={() => void start()} disabled={pending || phase !== "ready" || error !== null}>
                  {t("record.start")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
