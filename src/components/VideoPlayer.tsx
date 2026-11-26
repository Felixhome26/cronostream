import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { t } from "../i18n";
import { useMediaControls } from "../hooks/useMediaControls";
import MediaControlsBar from "./MediaControlsBar";

interface Props {
  src: string;
  autoPlay?: boolean;
  className?: string;
  onEnded?: () => void;
  // Rendered inside a box positioned over just the picture (not the always-
  // visible control bar below it) — e.g. the viewer's date chip, which
  // needs to sit on the frame the same way it sits on a photo, not float in
  // the control bar's own space.
  frameOverlay?: ReactNode;
}

// Custom-styled replacement for the native <video controls> element — same
// control bar as AudioPlayer (see useMediaControls/MediaControlsBar), plus
// the video frame itself, click-to-toggle-play, and a fullscreen button.
export default function VideoPlayer({ src, autoPlay, className, onEnded, frameOverlay }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controls = useMediaControls(videoRef, src, "VideoPlayer", onEnded);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current?.requestFullscreen().catch(() => {});
    }
  }, []);

  // object-fit: contain can letterbox the video inside its box, but the
  // <video> element's hit area always covers the full box. Only treat a
  // click as play/pause when it lands on the actual picture; a click on the
  // surrounding black bars is left to bubble up so the enclosing viewer can
  // treat it like a click outside the media (e.g. closing a detail view).
  const handleVideoClick = useCallback((ev: MouseEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const { videoWidth, videoHeight } = video;
    const rect = video.getBoundingClientRect();
    if (videoWidth > 0 && videoHeight > 0 && rect.width > 0 && rect.height > 0) {
      const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
      const renderedWidth = videoWidth * scale;
      const renderedHeight = videoHeight * scale;
      const offsetX = (rect.width - renderedWidth) / 2;
      const offsetY = (rect.height - renderedHeight) / 2;
      const localX = ev.clientX - rect.left;
      const localY = ev.clientY - rect.top;
      const onPicture =
        localX >= offsetX && localX <= offsetX + renderedWidth && localY >= offsetY && localY <= offsetY + renderedHeight;
      if (!onPicture) return;
    }
    ev.stopPropagation();
    controls.togglePlay();
  }, [controls]);

  return (
    <div
      ref={containerRef}
      className={"video-player" + (fullscreen ? " video-player--fullscreen" : "") + (className ? ` ${className}` : "")}
    >
      <div className="video-player__frame-wrap">
        <video
          ref={videoRef}
          src={controls.src}
          autoPlay={autoPlay}
          preload="metadata"
          className="video-player__frame"
          onClick={handleVideoClick}
        />
        {frameOverlay}
      </div>
      <div className="video-player__controls" onClick={(ev) => ev.stopPropagation()}>
        <MediaControlsBar
          {...controls}
          rightExtra={
            <button
              type="button"
              className="audio-player__skip video-player__fullscreen"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? t("player.exitFullscreen") : t("player.fullscreen")}
            >
              {fullscreen ? "⤡" : "⤢"}
            </button>
          }
        />
      </div>
    </div>
  );
}
