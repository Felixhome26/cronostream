interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /// Rendered right after the switch, e.g. a leading control label
  /// ("Duplikate ausblenden") or a state word that changes with `checked`
  /// ("schnell"/"gründlich" — pass that text in from the caller, this
  /// component only draws the switch itself).
  label?: string;
}

/// Small on/off slider switch — used where a plain checkbox would read as
/// "a setting" rather than "a mode you're flipping" (e.g. schnell/gründlich,
/// not just a yes/no option).
export default function ToggleSwitch({ checked, onChange, disabled, label }: Props) {
  return (
    <label className={"toggle-switch" + (disabled ? " toggle-switch--disabled" : "")}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-switch__track">
        <span className="toggle-switch__thumb" />
      </span>
      {label && <span className="toggle-switch__label">{label}</span>}
    </label>
  );
}
