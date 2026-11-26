import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { t } from "../i18n";
import { invoke } from "../busy";

export const SKIP_SECONDS = 10;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// MediaError.code numeric values aren't exposed as named constants on the
// type, so this is the only way to turn one into something readable.
const MEDIA_ERROR_KEYS: Record<number, string> = {
  1: "player.errorAborted",
  2: "player.errorNetwork",
  3: "player.errorDecode",
  4: "player.errorUnsupported",
};

function describeMediaError(error: MediaError | null): string | null {
  if (!error) return null;
  const key = MEDIA_ERROR_KEYS[error.code];
  return key ? t(key) : t("player.errorUnknown").replace("{code}", String(error.code));
}

// MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED: the file is there, the
// webview just can't play its format — worth one try with a converted copy.
const CONVERTIBLE_ERRORS = new Set([3, 4]);

// Shared play/pause/seek/volume/speed state machine behind both AudioPlayer
// and VideoPlayer's custom control bar — driven entirely through the
// <audio>/<video> element's own event/API surface (not a UI library), kept
// in one hook since the two players are otherwise identical except for the
// media tag itself and a couple of video-only extras (frame, fullscreen).
export function useMediaControls(mediaRef: RefObject<HTMLMediaElement | null>, src: string, logLabel: string, onEnded?: () => void) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A converted copy (see playback_compat.rs) standing in for `src` once
  // the player refused the original, and whether it is being made.
  const [compatSrc, setCompatSrc] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  // The error handler below is bound once per element, so it reads the
  // current source through a ref; `compatTried` keeps a failing copy from
  // being converted again.
  const srcRef = useRef(src);
  srcRef.current = src;
  const compatTriedRef = useRef(false);
  const speedRef = useRef<HTMLDivElement>(null);
  // Whether the user is actively dragging/committing the seek input, so the
  // timeupdate handler below doesn't fight the drag by resetting
  // currentTime back to the (stale) playback position. Kept as a ref rather
  // than state: the handler is bound inside an effect that doesn't re-run on
  // every change, so a state closure would go stale between the drag
  // starting and the effect resubscribing — on a playing video (timeupdate
  // fires several times a second) that race would overwrite a just-started
  // drag with the old position.
  const seekingRef = useRef(false);

  useEffect(() => {
    if (!speedMenuOpen) return;
    const onClickOutside = (ev: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(ev.target as Node)) setSpeedMenuOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [speedMenuOpen]);

  // Loading a new source should never carry over the previous track's
  // playback position/duration into the display while metadata loads.
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setSpeedMenuOpen(false);
    setError(null);
    setCompatSrc(null);
    setConverting(false);
    compatTriedRef.current = false;
    seekingRef.current = false;
  }, [src]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const onTimeUpdate = () => {
      if (!seekingRef.current) setCurrentTime(el.currentTime);
    };
    const onLoadedMetadata = () => setDuration(el.duration);
    const onDurationChange = () => setDuration(el.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEndedInternal = () => {
      setPlaying(false);
      onEnded?.();
    };
    const onVolumeChange = () => {
      setVolume(el.volume);
      setMuted(el.muted);
    };
    const onRateChange = () => setRate(el.playbackRate);
    const onProgress = () => {
      if (el.buffered.length > 0) setBuffered(el.buffered.end(el.buffered.length - 1));
    };
    const onError = () => {
      const original = srcRef.current;
      const path = mediaServerPath(original);
      if (el.error && CONVERTIBLE_ERRORS.has(el.error.code) && path && !compatTriedRef.current) {
        compatTriedRef.current = true;
        const video = el instanceof HTMLVideoElement;
        setError(null);
        setConverting(true);
        invoke("prepare_playback_copy", { path, video })
          .then(() => {
            if (srcRef.current === original) setCompatSrc(`${original}&compat=${video ? "video" : "audio"}`);
          })
          .catch((err) => {
            if (srcRef.current !== original) return;
            console.error(`${logLabel}: Umwandeln fehlgeschlagen`, { path, err });
            setError(String(err));
          })
          .finally(() => {
            if (srcRef.current === original) setConverting(false);
          });
        return;
      }
      const message = describeMediaError(el.error);
      setError(message);
      if (message) console.error(`${logLabel}: Wiedergabefehler`, { src: el.currentSrc, code: el.error?.code, message });
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEndedInternal);
    el.addEventListener("volumechange", onVolumeChange);
    el.addEventListener("ratechange", onRateChange);
    el.addEventListener("progress", onProgress);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEndedInternal);
      el.removeEventListener("volumechange", onVolumeChange);
      el.removeEventListener("ratechange", onRateChange);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("error", onError);
    };
  }, [mediaRef, onEnded, logLabel]);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch((err) => {
        console.error(`${logLabel}: play() abgelehnt`, { src: el.currentSrc, err });
        setError((prev) => prev ?? describeMediaError(el.error) ?? String(err?.message ?? err));
      });
    } else {
      el.pause();
    }
  }, [mediaRef, logLabel]);

  const skip = useCallback(
    (delta: number) => {
      const el = mediaRef.current;
      if (!el) return;
      el.currentTime = Math.min(Math.max(el.currentTime + delta, 0), el.duration || Infinity);
    },
    [mediaRef],
  );

  const handleSeekInput = useCallback((value: number) => {
    seekingRef.current = true;
    setCurrentTime(value);
  }, []);

  const commitSeek = useCallback(
    (value: number) => {
      const el = mediaRef.current;
      if (el) el.currentTime = value;
      seekingRef.current = false;
    },
    [mediaRef],
  );

  const toggleMute = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.muted = !el.muted;
  }, [mediaRef]);

  const handleVolumeChange = useCallback(
    (value: number) => {
      const el = mediaRef.current;
      if (!el) return;
      el.volume = value;
      el.muted = value === 0;
    },
    [mediaRef],
  );

  const applyRate = useCallback(
    (value: number) => {
      const el = mediaRef.current;
      if (el) el.playbackRate = value;
      setSpeedMenuOpen(false);
    },
    [mediaRef],
  );

  return {
    src: compatSrc ?? src,
    converting,
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
    speedRef,
    togglePlay,
    skip,
    handleSeekInput,
    commitSeek,
    toggleMute,
    handleVolumeChange,
    applyRate,
  };
}

export type MediaControls = ReturnType<typeof useMediaControls>;

/// The original file path inside a media-server URL (see mediaServer.ts),
/// or null for any other source (blob: recordings and the like).
function mediaServerPath(src: string): string | null {
  try {
    const url = new URL(src);
    return url.pathname === "/file" && !url.searchParams.has("compat") ? url.searchParams.get("path") : null;
  } catch {
    return null;
  }
}
