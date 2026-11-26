import { useCallback, useEffect, useRef, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "../busy";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

// The plugin's GTK path breaks on spaces/umlauts in file names, so Linux goes
// through src-tauri/src/linux_drag.rs instead.
const IS_LINUX = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

// While one of our own drags is under way, the main window's drop handler
// (PendingDrops) must not treat a release over CronoStream itself as an
// import of the very file being dragged. The flag outlives the drag by a
// grace period because the drop event and the end signal arrive over
// separate channels in no guaranteed order.
const DROP_GRACE_MS = 1000;
let outgoingDrag = false;
let outgoingDragTimer: ReturnType<typeof setTimeout> | undefined;

export function isOutgoingFileDrag(): boolean {
  return outgoingDrag;
}

function beginOutgoingDrag() {
  clearTimeout(outgoingDragTimer);
  outgoingDrag = true;
}

function endOutgoingDrag() {
  clearTimeout(outgoingDragTimer);
  outgoingDragTimer = setTimeout(() => (outgoingDrag = false), DROP_GRACE_MS);
}

if (IS_LINUX) {
  // linux_drag.rs reports the end of the GTK drag session as an event, since
  // its command returns as soon as the drag has started.
  void listen("file-drag-out-end", endOutgoingDrag).catch(() => {});
}

function startFileDrag(path: string, icon: string): Promise<void> {
  beginOutgoingDrag();
  const started = IS_LINUX
    ? invoke<void>("start_file_drag", { path, icon })
    : startDrag({ item: [path], icon, mode: "copy" }, endOutgoingDrag);
  return started.catch((err) => {
    endOutgoingDrag();
    throw err;
  });
}

// Pixels the pointer has to travel with the button held before a press turns
// into a file drag. Below that it stays a plain click (close viewer, toggle
// play, ...), which is why click handlers elsewhere keep working unchanged.
const DRAG_THRESHOLD_PX = 5;
const ICON_SIZE = 128;

// Controls that need their own mouse handling (seek bar, buttons, ...).
const INTERACTIVE_SELECTOR =
  "button, input, select, textarea, a, [role='slider'], .video-player__controls";

// Areas whose text the user selects by dragging (document text, mail header):
// there a file drag needs Alt held, like in the zoomed image view.
const TEXT_SELECTOR = "[data-text-selectable]";

// Smallest valid PNG, used when no usable drag preview can be rendered.
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Renders the media element under the pointer's wrapper into a small PNG for
// the OS drag cursor. A canvas tainted by a cross-origin source throws on
// export; that and "nothing to draw" both fall back to the 1x1 icon.
function renderEmojiIcon(emoji: string): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return FALLBACK_ICON;
    ctx.font = "48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, 32, 36);
    return canvas.toDataURL("image/png");
  } catch {
    return FALLBACK_ICON;
  }
}

function renderDragIcon(root: HTMLElement, emoji?: string): string {
  const fallback = emoji ? renderEmojiIcon(emoji) : FALLBACK_ICON;
  const media = root.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
  if (!media) return fallback;
  try {
    const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!w || !h) return fallback;
    const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return fallback;
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return fallback;
  }
}

interface Options {
  onError?: (err: unknown) => void;
  // Drawn as the drag preview when the file has no picture of its own.
  emoji?: string;
}

// Lets the user grab the file shown in a viewer and drop it into other
// applications. Spread the returned props onto the element wrapping the
// media. Always a copy drag, so the stored original can never be moved away
// from under the timeline.
export function useFileDragOut(path: string | null | undefined, options: Options = {}) {
  const pathRef = useRef(path);
  pathRef.current = path;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const emojiRef = useRef(options.emoji);
  emojiRef.current = options.emoji;
  // True once this press became a drag; swallows the click that may follow.
  const draggedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onMouseDown = useCallback((ev: ReactMouseEvent<HTMLElement>) => {
    draggedRef.current = false;
    const filePath = pathRef.current;
    if (!filePath || ev.button !== 0) return;
    const target = ev.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    if (!ev.altKey && target.closest(TEXT_SELECTOR)) return;

    const root = ev.currentTarget;
    const startX = ev.clientX;
    const startY = ev.clientY;

    const stop = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stop);
      cleanupRef.current = null;
    };
    const onMove = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= DRAG_THRESHOLD_PX) return;
      stop();
      draggedRef.current = true;
      startFileDrag(filePath, renderDragIcon(root, emojiRef.current)).catch((err) =>
        onErrorRef.current?.(err),
      );
    };
    cleanupRef.current?.();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
    cleanupRef.current = stop;
  }, []);

  // Capture phase: runs before the children's own click handlers.
  const onClickCapture = useCallback((ev: ReactMouseEvent<HTMLElement>) => {
    if (!draggedRef.current) return;
    draggedRef.current = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, []);

  // The webview's own drag of an <img>/<video> would hand the target a link
  // to the local media server instead of the file; cancel it.
  const onDragStart = useCallback((ev: ReactDragEvent<HTMLElement>) => ev.preventDefault(), []);

  return { onMouseDown, onClickCapture, onDragStart };
}
