import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../i18n";

/// Frozen copy of the timeline taken the moment the file-browser overlay
/// opens (or the user returns to it), so the mini viewer can show the date
/// context the user just left without keeping a second live timeline
/// running. A cloned DOM subtree rather than a screenshot: the tiles'
/// thumbnails are plain image URLs that are already cached, and the inline
/// transforms the timeline writes per frame travel with the clone.
export interface TimelineSnapshot {
  node: HTMLElement;
  width: number;
  height: number;
}

export function captureTimelineSnapshot(): TimelineSnapshot | null {
  const source = document.querySelector<HTMLElement>(".project-shell > .timeline");
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const clone = source.cloneNode(true) as HTMLElement;
  // A duplicated id or a second playing <video> in the document would
  // confuse every `getElementById`/`querySelector` the app does elsewhere.
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.querySelectorAll("video, audio").forEach((el) => el.remove());
  clone.setAttribute("inert", "");
  clone.setAttribute("aria-hidden", "true");
  clone.style.cssText += `;flex:none;width:${rect.width}px;height:${rect.height}px;pointer-events:none;`;
  return { node: clone, width: rect.width, height: rect.height };
}

const POS_KEY = "ls.peek.pos";
const DRAG_THRESHOLD_PX = 4;
const EDGE_PX = 8;

interface Pos {
  left: number;
  bottom: number;
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Pos;
      if (Number.isFinite(p.left) && Number.isFinite(p.bottom)) return p;
    }
  } catch {
    // storage unavailable — fall back to the default corner
  }
  return { left: 20, bottom: 20 };
}

/// Both floating elements (the oval preview and the way back) share one
/// stored position: they are two faces of the same slot, never on screen
/// together, so moving one moves where the other appears too.
function useDraggableSlot() {
  const [pos, setPos] = useState<Pos>(loadPos);
  const posRef = useRef(pos);
  posRef.current = pos;
  const drag = useRef<{ x: number; y: number; left: number; bottom: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  function clamp(p: Pos, el: HTMLElement): Pos {
    const maxLeft = Math.max(EDGE_PX, window.innerWidth - el.offsetWidth - EDGE_PX);
    const maxBottom = Math.max(EDGE_PX, window.innerHeight - el.offsetHeight - EDGE_PX);
    return {
      left: Math.min(Math.max(EDGE_PX, p.left), maxLeft),
      bottom: Math.min(Math.max(EDGE_PX, p.bottom), maxBottom),
    };
  }

  const handlers = {
    onPointerDown(ev: ReactPointerEvent<HTMLElement>) {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest(".peek__ctl")) return;
      drag.current = { x: ev.clientX, y: ev.clientY, left: posRef.current.left, bottom: posRef.current.bottom, moved: false };
    },
    onPointerMove(ev: ReactPointerEvent<HTMLElement>) {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!d.moved) ev.currentTarget.setPointerCapture(ev.pointerId);
      d.moved = true;
      setPos(clamp({ left: d.left + dx, bottom: d.bottom - dy }, ev.currentTarget));
    },
    onPointerUp(ev: ReactPointerEvent<HTMLElement>) {
      const d = drag.current;
      drag.current = null;
      if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
      if (d?.moved) {
        justDragged.current = true;
        // The click event that follows a drag must not count as a click.
        window.setTimeout(() => (justDragged.current = false), 0);
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(posRef.current));
        } catch {
          // not fatal — position just isn't remembered
        }
      }
    },
  };

  return {
    style: { left: pos.left, bottom: pos.bottom },
    handlers,
    wasDragged: () => justDragged.current,
  };
}

// Keeps the slot on screen when the window shrinks.
function useKeepOnScreen(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    function onResize() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth) el.style.left = `${Math.max(EDGE_PX, window.innerWidth - r.width - EDGE_PX)}px`;
      if (r.top < 0) el.style.bottom = `${Math.max(EDGE_PX, window.innerHeight - r.height - EDGE_PX)}px`;
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ref]);
}

// Survives the oval being unmounted while the user peeks at the timeline.
let minimizedMemo = false;

const OVAL_W = 260;
const OVAL_H = 104;

interface MiniViewerProps {
  snapshot: TimelineSnapshot;
  onSwitch: () => void;
  onHide: () => void;
}

/// Oval, drag-able preview of the timeline shown over the file browser.
/// Click switches to the live timeline; the browser keeps its state.
export function MiniViewer({ snapshot, onSwitch, onHide }: MiniViewerProps) {
  const slot = useDraggableSlot();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [minimized, setMinimizedState] = useState(minimizedMemo);
  const setMinimized = (v: boolean) => {
    minimizedMemo = v;
    setMinimizedState(v);
  };
  useKeepOnScreen(rootRef);

  // The oval crops, so scale to *cover* it rather than fit.
  const scale = Math.max(OVAL_W / snapshot.width, OVAL_H / snapshot.height);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || minimized) return;
    stage.replaceChildren(snapshot.node);
    return () => {
      // The node is reused if the oval is re-expanded; just detach it.
      if (snapshot.node.parentNode === stage) stage.removeChild(snapshot.node);
    };
  }, [snapshot, minimized]);

  if (minimized) {
    return (
      <div
        ref={rootRef}
        className="peek peek--chip"
        style={slot.style}
        {...slot.handlers}
        onClick={(ev) => {
          if ((ev.target as HTMLElement).closest(".peek__ctl")) return;
          if (!slot.wasDragged()) onSwitch();
        }}
        title={t("peek.switchHint")}
      >
        <span className="peek__chip-main">⏱ {t("peek.livestream")}</span>
        <button type="button" className="peek__ctl" onClick={() => setMinimized(false)} title={t("peek.expand")} aria-label={t("peek.expand")}>
          ▢
        </button>
        <button type="button" className="peek__ctl" onClick={onHide} title={t("peek.hide")} aria-label={t("peek.hide")}>
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="peek peek--oval"
      style={{ ...slot.style, width: OVAL_W, height: OVAL_H }}
      {...slot.handlers}
      onClick={(ev) => {
        if ((ev.target as HTMLElement).closest(".peek__ctl")) return;
        if (!slot.wasDragged()) onSwitch();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onSwitch();
        }
      }}
      title={t("peek.switchHint")}
      aria-label={t("peek.switchHint")}
    >
      <div
        className="peek__stage"
        ref={stageRef}
        style={{
          width: snapshot.width,
          height: snapshot.height,
          transform: `translate(${(OVAL_W - snapshot.width * scale) / 2}px, ${(OVAL_H - snapshot.height * scale) / 2}px) scale(${scale})`,
        }}
      />
      <div className="peek__label">{t("peek.livestream")}</div>
      <div className="peek__ctls">
        <button type="button" className="peek__ctl" onClick={() => setMinimized(true)} title={t("peek.minimize")} aria-label={t("peek.minimize")}>
          –
        </button>
        <button type="button" className="peek__ctl" onClick={onHide} title={t("peek.hide")} aria-label={t("peek.hide")}>
          ×
        </button>
      </div>
    </div>
  );
}

interface ReturnPillProps {
  label: string;
  onReturn: () => void;
}

/// Counterpart inside the live timeline: one click back to the sub-view
/// that was left, with its state intact.
export function ReturnPill({ label, onReturn }: ReturnPillProps) {
  const slot = useDraggableSlot();
  const rootRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(rootRef);
  return (
    <div
      ref={rootRef}
      className="peek peek--pill"
      style={slot.style}
      {...slot.handlers}
      onClick={() => {
        if (!slot.wasDragged()) onReturn();
      }}
      title={t("peek.returnHint")}
    >
      ← {t("peek.returnTo")}: {label}
    </div>
  );
}
