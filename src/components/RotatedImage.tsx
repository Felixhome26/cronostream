import { useEffect, useRef, useState, type SyntheticEvent } from "react";

interface Props {
  src: string;
  alt: string;
  rotation: number;
  className?: string;
  /// Fires once the image's own pixel dimensions are known (onLoad) — for
  /// callers that need to size something else (e.g. the timeline viewer's
  /// freed zoom layer) to match this image's aspect ratio.
  onNaturalSize?: (size: { w: number; h: number }) => void;
  /// Identifies the underlying item. While `src` changes but this stays the
  /// same (thumbnail stand-in -> full-resolution file), the previous
  /// measurement keeps sizing the image, so the swap doesn't flash.
  itemKey?: string;
}

/// An <img> that applies a manual 90/180/270° rotation on top of whatever
/// the browser already does for EXIF orientation, sized to fully fit (and
/// fill as much as possible of) whatever box its caller gives it — unlike a
/// square thumbnail tile, rotating by 90/270° swaps the image's visual
/// footprint, so the space it needs swaps too, or it either overflows the
/// box or renders smaller than it could.
///
/// The fit is computed explicitly in JS from two measurements — the host
/// element's own box (via ResizeObserver) and the image's natural pixel
/// size (onLoad) — rather than via CSS `aspect-ratio` on a dynamically
/// resized element. An earlier version tried the CSS route (forcing the
/// swapped ratio onto the <img> itself, or onto a wrapper sized by
/// `width/height: auto` + `aspect-ratio`), but that leaves the box's size
/// circular until the ratio is known, and changing `rotation` on an
/// already-mounted instance (swapped <-> unswapped switches the element
/// between <img> and <div><img/></div>) re-triggers exactly that
/// indeterminate state — which rendered as a blank/undersized image until
/// the whole viewer was closed and reopened. Explicit pixel values sidestep
/// the ambiguity entirely.
export default function RotatedImage({ src, alt, rotation, className, onNaturalSize, itemKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Tagged with the src it was measured for, instead of being reset by an
  // effect when src changes: a cached image can fire onLoad *before* such an
  // effect runs, and the late reset would then wipe the fresh measurement and
  // leave the image on the unrotated fallback sizing for good.
  const [measured, setMeasured] = useState<{ src: string; key?: string; w: number; h: number } | null>(null);
  const natural =
    measured && (measured.src === src || (itemKey !== undefined && measured.key === itemKey)) ? measured : null;
  const loaded = measured != null && measured.src === src;
  const [container, setContainer] = useState<{ w: number; h: number } | null>(null);
  const swapped = rotation === 90 || rotation === 270;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainer({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function handleLoad(ev: SyntheticEvent<HTMLImageElement>) {
    const img = ev.currentTarget;
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    setMeasured({ src, key: itemKey, ...size });
    onNaturalSize?.(size);
  }

  // The image's post-rotation visual footprint, then the largest size at
  // that aspect ratio that still fits inside the measured container.
  const visualW = natural ? (swapped ? natural.h : natural.w) : null;
  const visualH = natural ? (swapped ? natural.w : natural.h) : null;
  let displayW: number | null = null;
  let displayH: number | null = null;
  if (visualW && visualH && container && container.w > 0 && container.h > 0) {
    const scale = Math.min(container.w / visualW, container.h / visualH);
    displayW = visualW * scale;
    displayH = visualH * scale;
  }
  // The <img> itself is laid out *before* rotation, so a 90/270 swap needs
  // its pre-rotation box to be the display size with width/height swapped
  // back — rotating that box is what produces the (already fitted)
  // post-rotation footprint.
  const imgWidth = displayW != null ? (swapped ? displayH : displayW) : null;
  const imgHeight = displayH != null ? (swapped ? displayW : displayH) : null;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}
    >
      <img
        key={src}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={handleLoad}
        style={{
          // Not yet sized for this image: stay invisible rather than flash
          // at raw size for the frame(s) before onLoad reports the dimensions.
          visibility: natural || loaded ? undefined : "hidden",
          // Before the first measurement (container/natural size not known
          // yet), fall back to a plain shrink-to-fit so nothing overflows
          // the container in the meantime.
          width: imgWidth != null ? `${imgWidth}px` : undefined,
          height: imgHeight != null ? `${imgHeight}px` : undefined,
          // Once explicit pixel sizes are set, the stylesheet's
          // `max-width/max-height: 100%` on viewer images (App.css) must be
          // switched off explicitly: `undefined` here would let it win. For a
          // 90/270 rotation the pre-rotation box is the fitted size with
          // width/height swapped, so its width can legitimately exceed the
          // container's width — the CSS cap would squash it, and after the
          // rotation the image ends up too small (and the freed zoom frame,
          // sized from the same footprint, shrinks with it).
          maxWidth: imgWidth == null ? "100%" : "none",
          maxHeight: imgHeight == null ? "100%" : "none",
          objectFit: imgWidth == null ? "contain" : undefined,
          transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
        }}
      />
    </div>
  );
}
