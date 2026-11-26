import { toDateOnlyValue } from "./datetime";

/// The ready-made periods the print-export list offers in its dropdown.
/// A hand-picked start/end date is deliberately *not* one of these: it is
/// its own mode, switched on by a checkbox, so it is always visible which
/// of the two is deciding what the list shows.
export type RangePreset = "all" | "last1" | "last3" | "last6" | "last12" | `year:${number}`;

export interface DateRange {
  /// Inclusive bounds as "YYYY-MM-DD" local dates; "" means open-ended.
  from: string;
  to: string;
}

const MONTH_PRESETS: Record<string, number> = { last1: 1, last3: 3, last6: 6, last12: 12 };

/// The `from`/`to` pair a preset stands for. `all` is open on both sides.
export function rangeForPreset(preset: RangePreset, now: Date = new Date()): DateRange {
  if (preset === "all") return { from: "", to: "" };
  if (preset.startsWith("year:")) {
    const year = preset.slice(5);
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const months = MONTH_PRESETS[preset] ?? 1;
  const start = new Date(now);
  // setMonth clamps an overlong day into the next month (Mar 31 minus one
  // month would be "Feb 31"), which for a "last n months" window only ever
  // means a couple of extra days at the start — acceptable, and far less
  // surprising than skipping a month entirely.
  start.setMonth(start.getMonth() - months);
  return { from: toDateOnlyValue(start.toISOString()), to: toDateOnlyValue(now.toISOString()) };
}

/// True when the end is before the start — the one range the UI has to
/// reject rather than quietly return nothing for.
export function isRangeInvalid({ from, to }: DateRange): boolean {
  return from !== "" && to !== "" && to < from;
}

/// Whether an item's timeline timestamp falls inside `range`.
///
/// Compared as "YYYY-MM-DD" local-date strings rather than as Date objects:
/// both ends are inclusive whole days, and lexical comparison of that
/// format gets there without any midnight / timezone arithmetic to get
/// wrong.
export function isInRange(iso: string, { from, to }: DateRange): boolean {
  if (from === "" && to === "") return true;
  const day = toDateOnlyValue(iso);
  if (from !== "" && day < from) return false;
  if (to !== "" && day > to) return false;
  return true;
}
