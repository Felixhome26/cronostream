import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { normalizeHex } from "../utils/phases";

interface Props {
  palette: string[];
  value: string;
  onPick: (color: string) => void;
  onClose: () => void;
}

/// The colour popup of a phase: the palette colours plus a hex
/// field. Hand-built because the native colour input is unusable in
/// WebKitGTK.
export default function PhaseColorPopup({ palette, value, onPick, onClose }: Props) {
  const [hex, setHex] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const valid = normalizeHex(hex) !== null;

  // Placed against the viewport so no scrolling or clipping ancestor (the
  // dialog list) cuts it off; flips above the swatch when there is no room
  // below. Skipped where the stylesheet embeds it statically (context menu).
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor || getComputedStyle(el).position === "static") return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const margin = 8;
    const below = a.bottom + 4;
    const top = below + h + margin > window.innerHeight ? Math.max(margin, a.top - h - 4) : below;
    const left = Math.max(margin, Math.min(a.left, window.innerWidth - w - margin));
    el.style.position = "fixed";
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, []);

  useEffect(() => {
    function handlePointerDown(ev: PointerEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    }
    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        // The dialog behind closes on Escape too; this one only closes itself.
        ev.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  function applyHex() {
    const color = normalizeHex(hex);
    if (color) onPick(color);
  }

  return (
    <div className="phases-color-popup" ref={ref} role="dialog" aria-label={t("phases.color")}>
      <div className="phases-color-popup__grid">
        {palette.map((color) => (
          <button
            key={color}
            className={"phases-swatch phases-swatch--large" + (color === value ? " phases-swatch--selected" : "")}
            style={{ backgroundColor: color }}
            onClick={() => onPick(color)}
            title={color}
            aria-label={color}
            aria-pressed={color === value}
          />
        ))}
      </div>
      <div className="phases-color-popup__hex">
        <input
          className={"phases-input" + (valid ? "" : " phases-input--invalid")}
          value={hex}
          maxLength={7}
          spellCheck={false}
          placeholder="#3584e4"
          aria-label={t("phases.hex")}
          onChange={(ev) => setHex(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") applyHex();
          }}
        />
        <button className="btn btn--primary" onClick={applyHex} disabled={!valid}>
          {t("phases.apply")}
        </button>
      </div>
    </div>
  );
}
