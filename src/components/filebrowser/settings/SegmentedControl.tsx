import type { KeyboardEvent } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /// Language tag for a label written in a language other than the UI's.
  lang?: string;
}

/// A short list of mutually exclusive choices as one joined bar. Behaves as a
/// radio group: one tab stop, arrow keys move the choice.
export default function SegmentedControl<T extends string>({
  options,
  value,
  onPick,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onPick: (value: T) => void;
  label: string;
}) {
  function onKeyDown(ev: KeyboardEvent<HTMLDivElement>) {
    const step = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    onPick(next.value);
    const buttons = ev.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[options.indexOf(next)]?.focus();
  }

  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            lang={option.lang}
            className={"segmented__btn" + (on ? " segmented__btn--on" : "")}
            onClick={() => onPick(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
