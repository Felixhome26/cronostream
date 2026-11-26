import { useRef } from "react";
import { useMediaControls } from "../hooks/useMediaControls";
import MediaControlsBar from "./MediaControlsBar";

interface Props {
  src: string;
  autoPlay?: boolean;
  className?: string;
  onEnded?: () => void;
}

// Custom-styled replacement for the native <audio controls> element — the
// native chrome looks out of place against the app's dark design and (on
// WebKitGTK at least) doesn't expose a speed control at all. Built on a
// plain hidden <audio> element driven entirely through its event/API
// surface (see useMediaControls), not a UI library, so it stays consistent
// with the rest of the app's hand-rolled components.
export default function AudioPlayer({ src, autoPlay, className, onEnded }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controls = useMediaControls(audioRef, src, "AudioPlayer", onEnded);

  return (
    <div className={"audio-player" + (className ? ` ${className}` : "")} onClick={(ev) => ev.stopPropagation()}>
      <audio ref={audioRef} src={controls.src} autoPlay={autoPlay} preload="metadata" />
      <MediaControlsBar {...controls} />
    </div>
  );
}
