import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import { useSettings } from "./SettingsContext";

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 1.8l4.7 4.7-1.7.6-2.3 2.7.3 2.4-1 1-2.4-2.4-3.6 3.6-.7-.7 3.6-3.6L3.9 7.7l1-1 2.4.3 2.7-2.3z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c2 1.8 2.8 3.9 2.8 6.2S10 12.4 8 14.2C6 12.4 5.2 10.3 5.2 8S6 3.6 8 1.8z" />
    </svg>
  );
}

/// Where this one setting is remembered: a quiet symbol at the end of the
/// row (pin = this stream, globe = every stream on this computer)
/// that opens a two-option popover. The popover repeats the explanation so
/// the symbol itself can stay small. Switching never changes the value in
/// force, only where it is stored (see `set_setting_scope`).
export default function ScopeButton({ keys }: { keys: string[] }) {
  const { settings, onScopeChange } = useSettings();
  const current = settings.scopes[keys[0]] ?? "project";
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      if (root.current && !root.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      // Closes just the popover, not the file browser behind it.
      ev.stopPropagation();
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const currentLabel = t(`settings.scope.${current}`);
  return (
    <span className="scope-btn" ref={root}>
      <button
        type="button"
        className={"scope-btn__trigger" + (current === "app" ? " scope-btn__trigger--app" : "")}
        aria-haspopup="true"
        aria-expanded={open}
        title={t("settings.scopeButton").replace("{scope}", currentLabel)}
        aria-label={t("settings.scopeButton").replace("{scope}", currentLabel)}
        onClick={() => setOpen((v) => !v)}
      >
        {current === "app" ? <GlobeIcon /> : <PinIcon />}
      </button>
      {open && (
        <div className="scope-btn__pop" role="group" aria-label={t("settings.scopeCaption")}>
          {(["project", "app"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={"scope-btn__opt" + (current === scope ? " scope-btn__opt--on" : "")}
              aria-pressed={current === scope}
              onClick={() => {
                if (current !== scope) onScopeChange(keys, scope);
                setOpen(false);
              }}
            >
              <span className="scope-btn__opt-icon">{scope === "app" ? <GlobeIcon /> : <PinIcon />}</span>
              <span className="scope-btn__opt-text">
                <span className="prefs-row__label">{t(`settings.scope.${scope}`)}</span>
                <span className="prefs-row__hint">{t(`settings.scope.${scope}Hint`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
