import { useEffect, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import RotatedImage from "./RotatedImage";

// Same steps/caps as the timeline viewer's freed zoom layer (Timeline.tsx).
const ZOOM_STEP = 1.15;
const MAX_SCALE = 6;

interface Props {
  src: string;
  rotation: number;
  /// Called when the zoom runs back out past the baseline, or on Escape /
  /// a click beside the image.
  onClose: () => void;
}

function clampPan(scale: number, aspect: number | null, x: number, y: number) {
  if (!aspect) return { x: 0, y: 0 };
  const heightPx = scale * window.innerHeight;
  const widthPx = heightPx * aspect;
  const maxX = Math.max(0, (widthPx - window.innerWidth) / 2);
  const maxY = Math.max(0, (heightPx - window.innerHeight) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
}

/// Free zoom for a single image over a dark backdrop — the file browser's
/// counterpart to the timeline viewer's "freed" layer. Baseline (scale 1)
/// is 100% of the viewport height; wheel / +/- zoom, drag pans, zooming out
/// past the baseline (or Escape) hands control back to the caller.
export default function ImageZoomOverlay({ src, rotation, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const swapped = rotation === 90 || rotation === 270;
  const aspect = natural ? (swapped ? natural.h / natural.w : natural.w / natural.h) : null;

  function zoom(direction: 1 | -1) {
    const next = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
    if (next < 1) {
      onClose();
      return;
    }
    const nativeH = natural ? (swapped ? natural.w : natural.h) : 0;
    const max = Math.max(MAX_SCALE, (nativeH * 4) / window.innerHeight);
    const clamped = Math.min(next, max);
    setScale(clamped);
    setPan((p) => clampPan(clamped, aspect, p.x, p.y));
  }

  function onWheel(ev: ReactWheelEvent<HTMLDivElement>) {
    ev.preventDefault();
    zoom(ev.deltaY < 0 ? 1 : -1);
  }

  function startDrag(ev: ReactMouseEvent<HTMLDivElement>) {
    ev.preventDefault();
    ev.stopPropagation();
    setDrag({ x: ev.clientX, y: ev.clientY, panX: pan.x, panY: pan.y });
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(ev: MouseEvent) {
      if (!drag) return;
      setPan(clampPan(scale, aspect, drag.panX + ev.clientX - drag.x, drag.panY + ev.clientY - drag.y));
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, scale, aspect]);

  // Capture phase + stopPropagation: Escape must close only the zoom, not
  // whatever the file browser underneath would do with it.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      } else if (ev.key === "+" || ev.key === "=") {
        ev.preventDefault();
        zoom(1);
      } else if (ev.key === "-" || ev.key === "_") {
        ev.preventDefault();
        zoom(-1);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, natural, rotation]);

  const heightPx = scale * window.innerHeight;
  // Portaled to <body>: React events bubble through the portal's parent
  // tree, but the DOM position escapes the preview panel's clipping.
  return createPortal(
    <div className="viewer-overlay image-zoom-overlay" onClick={(ev) => { ev.stopPropagation(); onClose(); }} onWheel={onWheel} onDoubleClick={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.stopPropagation()}>
      <div
        className={"viewer-freed__frame" + (drag ? " viewer-freed__frame--dragging" : "")}
        style={{
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
          ...(aspect ? { height: `${heightPx}px`, width: `${heightPx * aspect}px` } : {}),
        }}
        onClick={(ev) => ev.stopPropagation()}
        onMouseDown={startDrag}
      >
        <RotatedImage src={src} alt="" rotation={rotation} onNaturalSize={setNatural} />
      </div>
    </div>,
    document.body,
  );
}
