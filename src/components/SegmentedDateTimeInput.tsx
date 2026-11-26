import { useEffect, useRef, useState } from "react";
import { currentLanguage, t, type Language } from "../i18n";
import { getEarliestDateYear } from "../utils/datetime";

// "YYYY-MM-DDTHH:mm" in local time — same format `toDatetimeLocalValue` /
// `fromDatetimeLocalValue` (src/utils/datetime.ts) produce and parse, so
// this is a drop-in replacement for a native <input type="datetime-local">
// wherever the caller already speaks that format.
interface Fields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23, always 24h internally regardless of display locale
  minute: number;
}

function parseValue(value: string): Fields {
  // "" is an empty field (dateOnly callers with nothing entered yet): it
  // shows as 00.00.0000 and reports "" until day, month and year are set.
  if (!value) return { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = (timePart ?? "00:00").split(":").map(Number);
  return { year, month, day, hour, minute };
}

function formatValue(f: Fields): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // The year pads to four digits like every other field pads to two: a
  // half-typed "2" would otherwise produce "2-10-09T14:30", which `new
  // Date()` rejects outright — and the caller's save would then abort
  // without a word (see `fromDatetimeLocalValue`).
  return `${String(f.year).padStart(4, "0")}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

// JS's own day-0-of-next-month trick: with `month` already 1-based, passing
// it straight as the (0-based) month argument lands one month ahead, so day
// 0 of that is the last day of the month actually meant.
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function isIncomplete(f: Fields): boolean {
  return f.year === 0 || f.month === 0 || f.day === 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function hour12FromHour24(h: number): number {
  const h12 = h % 12;
  return h12 === 0 ? 12 : h12;
}

function hour24FromHour12(h12: number, isPM: boolean): number {
  const base = h12 % 12;
  return isPM ? base + 12 : base;
}

type FieldKind = "day" | "month" | "year" | "hour24" | "hour12" | "minute" | "ampm";

type Token = { type: "field"; kind: FieldKind } | { type: "sep"; text: string };

const FIELD_LEN: Record<FieldKind, number> = {
  day: 2,
  month: 2,
  year: 4,
  hour24: 2,
  hour12: 2,
  minute: 2,
  ampm: 2,
};

// Segment order and separators follow the same per-language convention the
// rest of the app uses for dates (day-first with dots for German,
// month-first with slashes for English, day-first with slashes for
// Spanish) — a user typing into this field should see the order they'd
// write it by hand, not a fixed ISO-ish layout. English additionally gets
// a 12h clock + AM/PM segment, matching how the rest of the app already
// renders English times; German/Spanish stay on the 24h clock.
function tokensForLanguage(lang: Language, includeTime: boolean): Token[] {
  const field = (kind: FieldKind): Token => ({ type: "field", kind });
  const sep = (text: string): Token => ({ type: "sep", text });

  const dateTokens: Token[] =
    lang === "en"
      ? [field("month"), sep("/"), field("day"), sep("/"), field("year")]
      : [field("day"), sep(lang === "de" ? "." : "/"), field("month"), sep(lang === "de" ? "." : "/"), field("year")];

  if (!includeTime) return dateTokens;

  const timeTokens: Token[] =
    lang === "en"
      ? [sep(" "), field("hour12"), sep(":"), field("minute"), sep(" "), field("ampm")]
      : [sep(" "), field("hour24"), sep(":"), field("minute")];

  return [...dateTokens, ...timeTokens];
}

interface Props {
  /// "YYYY-MM-DDTHH:mm", local time — see `toDatetimeLocalValue`.
  value: string;
  onChange: (value: string) => void;
  /// Fires when focus leaves the whole control (every segment, not just
  /// one) — mirrors a native input's onBlur, since the caller only wants to
  /// persist once the user is actually done editing, not after every
  /// keystroke that happens to move between segments.
  ///
  /// Carries the final value rather than leaving the caller to read back
  /// the state it was handed via `onChange`: the two can be a render apart
  /// — the last `onChange` of an edit is a plain state update in the
  /// caller, which need not have been applied by the time this fires — and
  /// a save reading the lagging copy would write the value from before the
  /// final keystroke.
  onCommit?: (value: string) => void;
  className?: string;
  /// Already-translated label for where this timestamp came from (e.g.
  /// "Metadaten", "Eigenes Datum" — see `timestampSourceLabel` in i18n.ts).
  /// Left unset, nothing is shown: most callers (e.g. `ChangeDateDialog`)
  /// have no source to report for a `ProjectFileEntry`, which carries no
  /// `timestamp_source`. Where it IS given, a permanent badge plus a short
  /// explanatory line render next to the field — per the in-app-help
  /// guideline, this can't be a placeholder *inside* the field (it would
  /// vanish the moment someone starts typing).
  sourceLabel?: string;
  /// Focuses the first segment on mount. Off for the second of two fields
  /// mounted together, so the first one keeps the focus.
  autoFocus?: boolean;
  /// Day, month and year only: no time segments, and `onChange`/`onCommit`
  /// carry "YYYY-MM-DD". `value` may still be either format.
  dateOnly?: boolean;
}

/// Segmented date/time field: fixed separators, each day/month/year(/hour/
/// minute/AM-PM) block individually overwritable by typing digits — the
/// behavior of a native OS date control, built by hand because the actual
/// native `<input type="datetime-local">` renders very differently (and in
/// some webviews, barely lets you type at all) across the platforms Tauri's
/// system webview runs on.
export default function SegmentedDateTimeInput({ value, onChange: onChangeRaw, onCommit: onCommitRaw, className, sourceLabel, autoFocus = true, dateOnly = false }: Props) {
  const out = (v: string) => (dateOnly ? v.slice(0, 10) : v);
  const onChange = (v: string) => onChangeRaw(out(v));
  // What goes up to the caller for `next`: "" while an empty field is only
  // partly filled in, instead of a bogus "0000-00-00".
  const valueOf = (f: Fields) => (isIncomplete(f) ? "" : formatValue(f));
  const onCommit = onCommitRaw && ((v: string) => onCommitRaw(out(v)));
  const language = currentLanguage();
  const tokens = tokensForLanguage(language, !dateOnly);

  const [fields, setFields] = useState<Fields>(() => parseValue(value));
  // Which field (by index into `tokens`) is mid-edit, and what's been typed
  // into it so far — e.g. typing "1" then "5" for day 15 shows "1" then
  // "15" before the value is clamped/committed, rather than jumping straight
  // to a padded "01".
  const [bufferIndex, setBufferIndex] = useState<number | null>(null);
  const [buffer, setBuffer] = useState("");
  const [isPM, setIsPM] = useState(() => parseValue(value).hour >= 12);

  const containerRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef<Record<number, HTMLInputElement | null>>({});

  // Resyncs from the outside (e.g. the viewer switching to a different
  // item) without clobbering `buffer`/`bufferIndex`, which are purely this
  // component's own mid-edit state and never reflected back up until a
  // field is actually committed.
  useEffect(() => {
    const next = parseValue(value);
    setFields(next);
    setIsPM(next.hour >= 12);
  }, [value]);

  // Focuses the first date segment on mount, so the control is ready to
  // type into without first requiring a click.
  useEffect(() => {
    if (autoFocus) focusField(fieldIndexes()[0]);
  }, []);

  // No timestamp in the future: a typo like 2100 would make the timeline
  // build every year up to it. Anything later than "now" snaps back to now.
  // Applied only once editing is over (blur / Enter), never per keystroke:
  // the first digit of a segment is committed on its own, and on a date
  // near today ("3" of "31" typed over the 2nd of this month) that
  // intermediate value is already "in the future" and would snap the whole
  // field back to now, swallowing the edit.
  function clampFuture(next: Fields): Fields {
    const now = new Date();
    if (new Date(formatValue(next)).getTime() <= now.getTime()) return next;
    setIsPM(now.getHours() >= 12);
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }

  function finalizeFields(): string {
    const clamped = clampFuture(fields);
    if (clamped !== fields) {
      setFields(clamped);
      onChange(valueOf(clamped));
    }
    return valueOf(clamped);
  }

  function commitFields(next: Fields) {
    // Same for the lower bound (Einstellungen): a year below it snaps up.
    if (next.year !== 0 && next.year < getEarliestDateYear()) {
      next = { ...next, year: getEarliestDateYear(), month: 1, day: 1, hour: 0, minute: 0 };
      setIsPM(false);
    }
    setFields(next);
    onChange(valueOf(next));
  }

  function fieldIndexes(): number[] {
    return tokens.reduce<number[]>((acc, token, i) => (token.type === "field" ? [...acc, i] : acc), []);
  }

  function focusField(index: number, selectAll = true) {
    const el = fieldRefs.current[index];
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
  }

  function moveToAdjacent(fromIndex: number, direction: -1 | 1) {
    const indexes = fieldIndexes();
    const pos = indexes.indexOf(fromIndex);
    const target = indexes[pos + direction];
    if (target !== undefined) focusField(target);
  }

  function displayFor(index: number, kind: FieldKind): string {
    if (bufferIndex === index && buffer.length > 0) return buffer;
    switch (kind) {
      case "day":
        return String(fields.day).padStart(2, "0");
      case "month":
        return String(fields.month).padStart(2, "0");
      case "year":
        return String(fields.year).padStart(4, "0");
      case "hour24":
        return String(fields.hour).padStart(2, "0");
      case "hour12":
        return String(hour12FromHour24(fields.hour)).padStart(2, "0");
      case "minute":
        return String(fields.minute).padStart(2, "0");
      case "ampm":
        return isPM ? "PM" : "AM";
    }
  }

  function maxFor(kind: FieldKind): number {
    switch (kind) {
      case "day":
        return daysInMonth(fields.year, fields.month);
      case "month":
        return 12;
      case "year":
        return 9999;
      case "hour24":
        return 23;
      case "hour12":
        return 12;
      case "minute":
        return 59;
      case "ampm":
        return 0;
    }
  }

  function minFor(kind: FieldKind): number {
    return kind === "year" || kind === "hour24" || kind === "minute" ? 0 : 1;
  }

  function applyNumeric(kind: FieldKind, numeric: number) {
    const clamped = clamp(numeric, minFor(kind), maxFor(kind));
    if (kind === "year") {
      commitFields({ ...fields, year: clamped });
    } else if (kind === "month") {
      const day = Math.min(fields.day, daysInMonth(fields.year, clamped));
      commitFields({ ...fields, month: clamped, day });
    } else if (kind === "day") {
      commitFields({ ...fields, day: clamped });
    } else if (kind === "hour24") {
      commitFields({ ...fields, hour: clamped });
    } else if (kind === "hour12") {
      commitFields({ ...fields, hour: hour24FromHour12(clamped, isPM) });
    } else if (kind === "minute") {
      commitFields({ ...fields, minute: clamped });
    }
  }

  function handleDigit(index: number, kind: FieldKind, digit: string) {
    const len = FIELD_LEN[kind];
    const startingFresh = bufferIndex !== index;
    const newBuffer = (startingFresh ? "" : buffer) + digit;
    const numeric = parseInt(newBuffer, 10);
    const max = maxFor(kind);

    // The year is the one field whose partial readings are values in their
    // own right: "2" and "20" on the way to "2004" are the years 2 and 20,
    // and committing each keystroke the way the two-digit fields do is what
    // let a year field left mid-edit save one of them. So nothing leaves
    // this component until all four digits are in — and a field abandoned
    // before that needs no restoring, because `fields` was never touched.
    //
    // Every other field is two digits wide, where each partial reading IS a
    // legal value for it (day "1" is the 1st), and committing as you type is
    // what makes overtyping a segment feel like the native control.
    if (kind === "year") {
      if (newBuffer.length < len) {
        setBuffer(newBuffer);
        setBufferIndex(index);
        return;
      }
      setBuffer("");
      setBufferIndex(null);
      applyNumeric(kind, numeric);
      moveToAdjacent(index, 1);
      return;
    }

    applyNumeric(kind, numeric);

    // A second digit could still change the value (e.g. day "1" might
    // become "15") unless the field is already at its max length, or no
    // second digit could possibly keep it within range (day "4" → only
    // "04"..."04", since 40+ is never valid) — in either case, commit and
    // jump to the next segment instead of waiting for input that can't
    // come.
    if (newBuffer.length >= len || numeric * 10 > max) {
      setBuffer("");
      setBufferIndex(null);
      moveToAdjacent(index, 1);
    } else {
      setBuffer(newBuffer);
      setBufferIndex(index);
    }
  }

  function handleKeyDown(ev: React.KeyboardEvent<HTMLInputElement>, index: number, kind: FieldKind) {
    if (/^[0-9]$/.test(ev.key) && kind !== "ampm") {
      ev.preventDefault();
      handleDigit(index, kind, ev.key);
      return;
    }
    if (kind === "ampm" && (ev.key === "a" || ev.key === "A" || ev.key === "p" || ev.key === "P")) {
      ev.preventDefault();
      const nextIsPM = ev.key === "p" || ev.key === "P";
      setIsPM(nextIsPM);
      commitFields({ ...fields, hour: hour24FromHour12(hour12FromHour24(fields.hour), nextIsPM) });
      return;
    }
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      const delta = ev.key === "ArrowUp" ? 1 : -1;
      if (kind === "ampm") {
        const nextIsPM = !isPM;
        setIsPM(nextIsPM);
        commitFields({ ...fields, hour: hour24FromHour12(hour12FromHour24(fields.hour), nextIsPM) });
        return;
      }
      const current =
        kind === "day"
          ? fields.day
          : kind === "month"
            ? fields.month
            : kind === "year"
              ? fields.year
              : kind === "hour24"
                ? fields.hour
                : kind === "hour12"
                  ? hour12FromHour24(fields.hour)
                  : fields.minute;
      setBuffer("");
      setBufferIndex(null);
      applyNumeric(kind, current + delta);
      return;
    }
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      setBuffer("");
      setBufferIndex(null);
      moveToAdjacent(index, -1);
      return;
    }
    if (ev.key === "ArrowRight" || ev.key === "." || ev.key === "/" || ev.key === ":") {
      ev.preventDefault();
      setBuffer("");
      setBufferIndex(null);
      moveToAdjacent(index, 1);
      return;
    }
    if (ev.key === "Backspace") {
      ev.preventDefault();
      if (bufferIndex === index && buffer.length > 0) {
        setBuffer(buffer.slice(0, -1));
      } else {
        setBuffer("");
        setBufferIndex(null);
        moveToAdjacent(index, -1);
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      onCommit?.(finalizeFields());
      return;
    }
    // Anything else (Tab, Escape, …) is left to the browser/parent — Tab
    // still needs to move focus out of the whole control, and Escape is
    // handled by the surrounding viewer like before.
  }

  function handleContainerBlur(ev: React.FocusEvent<HTMLDivElement>) {
    if (containerRef.current && ev.relatedTarget instanceof Node && containerRef.current.contains(ev.relatedTarget)) {
      return;
    }

    // Dropping the buffer is all an unfinished year needs: it never reached
    // `fields`, so there is nothing to put back (see `handleDigit`). Every
    // other field committed each digit as it was typed, which is why
    // `fields` is already the value to hand on.
    setBuffer("");
    setBufferIndex(null);
    onCommit?.(finalizeFields());
  }

  const input = (
    <div
      ref={containerRef}
      className={`dt-input text-input${className ? ` ${className}` : ""}`}
      onBlur={handleContainerBlur}
    >
      {tokens.map((token, index) =>
        token.type === "sep" ? (
          <span className="dt-input__sep" key={index}>
            {token.text}
          </span>
        ) : (
          <input
            key={index}
            ref={(el) => {
              fieldRefs.current[index] = el;
            }}
            className="dt-input__field"
            style={{ width: `${FIELD_LEN[token.kind]}ch` }}
            inputMode={token.kind === "ampm" ? undefined : "numeric"}
            value={displayFor(index, token.kind)}
            onChange={() => {
              // Actual edits happen in onKeyDown (so digit-by-digit overflow
              // logic runs); this only exists so React doesn't warn about a
              // controlled input with no onChange.
            }}
            onFocus={(ev) => {
              ev.target.select();
              // Switching fields (by click or Tab) while a digit was
              // mid-buffer on a *different* field abandons that buffer. For
              // a two-digit field that loses nothing — its value was
              // committed on the first keystroke — and for the year it is
              // the intended outcome: an incomplete year is no year at all
              // (see `handleDigit`). Either way the old field stops
              // rendering stale unpadded digits.
              if (bufferIndex !== null && bufferIndex !== index) {
                setBuffer("");
                setBufferIndex(null);
              }
            }}
            onKeyDown={(ev) => handleKeyDown(ev, index, token.kind)}
            aria-label={token.kind}
          />
        ),
      )}
    </div>
  );

  if (!sourceLabel) return input;

  return (
    <div className="dt-input-wrapper">
      <div className="dt-input-wrapper__row">
        {input}
        <span className="dt-input__source-badge">{sourceLabel}</span>
      </div>
      <p className="dt-input__source-hint">{t("timeline.dateSourceHint")}</p>
    </div>
  );
}
