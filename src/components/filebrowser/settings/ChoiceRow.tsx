import type { ReactNode } from "react";
import { t } from "../../../i18n";
import PreferencesRow from "./PreferencesRow";
import SegmentedControl from "./SegmentedControl";

/// A setting with a few named options: segmented control under the label,
/// and the explanation of the option currently chosen beneath it, so the
/// per-option texts of the old radio lists stay readable without taking
/// space for all of them at once.
export default function ChoiceRow<T extends string>({
  label,
  hint,
  detail,
  options,
  optionKeyPrefix,
  value,
  onPick,
  scopeKeys,
  note,
  children,
}: {
  label: string;
  hint?: string;
  detail?: string;
  options: readonly T[];
  /// `<prefix>.<option>` is the label, `<prefix>.<option>Hint` the explanation.
  optionKeyPrefix: string;
  value: T;
  onPick: (value: T) => void;
  scopeKeys?: string[];
  note?: string;
  children?: ReactNode;
}) {
  return (
    <PreferencesRow
      label={label}
      hint={hint}
      detail={detail}
      scopeKeys={scopeKeys}
      note={note}
      stacked
      control={
        <>
          <SegmentedControl
            label={label}
            value={value}
            onPick={onPick}
            options={options.map((option) => ({ value: option, label: t(`${optionKeyPrefix}.${option}`) }))}
          />
          <p className="prefs-row__explain">{t(`${optionKeyPrefix}.${value}Hint`)}</p>
          {children}
        </>
      }
    />
  );
}
