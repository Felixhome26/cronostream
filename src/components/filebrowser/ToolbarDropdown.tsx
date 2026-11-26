import { useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}

/// A single pull-down button for the file-browser toolbars ("Aktionen ▾"):
/// bundles several batch actions that would otherwise each need their own
/// toolbar slot, so the row no longer wraps once the selection count makes
/// the labels longer.
///
/// Closes on an outside click, on Escape, and after any item inside is
/// clicked — callers don't need to manage that themselves.
export default function ToolbarDropdown({ label, disabled, danger, children }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="toolbar-dropdown" ref={rootRef}>
      <button
        type="button"
        className={"btn toolbar-dropdown__trigger" + (danger ? " btn--danger" : "")}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span className="toolbar-dropdown__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="toolbar-dropdown__menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
