import type { ReactNode } from "react";
import HelpHint from "../HelpHint";
import ScopeButton from "./ScopeButton";

export interface PreferencesRowProps {
  /// Ties the label to its control (`htmlFor`).
  id?: string;
  label: string;
  /// One short line under the label.
  hint?: string;
  /// The long explanation, behind the (?) badge.
  detail?: string;
  /// The one control. At the right of the label, or under it when `stacked`.
  control?: ReactNode;
  /// Stored keys this row governs; omitted = no scope symbol (the setting
  /// always lives in one place).
  scopeKeys?: string[];
  /// Belongs to the row above it: indented, shown only while its parent is on.
  sub?: boolean;
  stacked?: boolean;
  /// "Currently decides nothing, and here is why" — the row is dimmed.
  note?: string;
  /// Extra content under the row (errors, progress, dependent options).
  children?: ReactNode;
}

/// The one row anatomy of the settings: label and short description at the
/// left, a single control at the right, the scope symbol at the far end.
export default function PreferencesRow({
  id,
  label,
  hint,
  detail,
  control,
  scopeKeys,
  sub,
  stacked,
  note,
  children,
}: PreferencesRowProps) {
  const labelNode = <span className="prefs-row__label">{label}</span>;
  return (
    <div
      className={
        "prefs-row" + (sub ? " prefs-row--sub" : "") + (stacked ? " prefs-row--stacked" : "") + (note ? " prefs-row--dormant" : "")
      }
    >
      <div className="prefs-row__main">
        <div className="prefs-row__text">
          <span className="prefs-row__title">
            {id ? <label htmlFor={id}>{labelNode}</label> : labelNode}
            {detail && <HelpHint text={detail} />}
          </span>
          {hint && <span className="prefs-row__hint">{hint}</span>}
        </div>
        {!stacked && control && <div className="prefs-row__control">{control}</div>}
        <div className="prefs-row__scope">{scopeKeys && <ScopeButton keys={scopeKeys} />}</div>
      </div>
      {note && <p className="prefs-row__note">{note}</p>}
      {stacked && control && <div className="prefs-row__body">{control}</div>}
      {children && <div className="prefs-row__body">{children}</div>}
    </div>
  );
}

/// An on/off switch.
export function Switch({
  id,
  on,
  onToggle,
  label,
  compact,
}: {
  id?: string;
  on: boolean;
  onToggle: () => void;
  /// Needed where no visible label is tied to the switch.
  label?: string;
  compact?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={"switch" + (compact ? " switch--compact" : "") + (on ? " switch--on" : "")}
      onClick={onToggle}
    >
      <span className="switch__knob" />
    </button>
  );
}

/// A row whose control is a switch.
export function ToggleRow({
  id,
  on,
  onToggle,
  ...row
}: Omit<PreferencesRowProps, "control"> & { id: string; on: boolean; onToggle: () => void }) {
  // The row's label also as the switch's own name: the <label htmlFor> alone
  // left a bare switch for tooltips and checks that read only the button.
  return <PreferencesRow id={id} {...row} control={<Switch id={id} on={on} onToggle={onToggle} label={row.label} />} />;
}

/// Content that only exists while its parent option is on; fades in.
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return open ? <div className="prefs-reveal">{children}</div> : null;
}
