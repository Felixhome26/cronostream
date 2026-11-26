import { currentLanguage, t, type Language } from "../../i18n";

// Calendar arithmetic of the timeline: the zoom levels, where their periods
// begin, and how a period is named. Moved out of Timeline.tsx unchanged.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// Discrete hierarchical zoom levels (Gesamtansicht -> Jahr -> Monat -> Woche
// -> Tag). The level controls two things only: which calendar granularity
// clusterByItemId buckets items into, and which marker tier is shown — it
// does NOT control pixelsPerDay itself, which stays the single continuous
// zoom variable exactly as before (handleWheel is untouched). A transition
// is a pure duration-vs-viewport-width threshold, not tied to any specific
// calendar instance being centered — e.g. "a 365-day span now equals the
// viewport width", not "the year Jan-Dec is centered and full-width".
export type ZoomLevel = "overview" | "year" | "month" | "week" | "day";
export const LEVEL_ORDER: ZoomLevel[] = ["overview", "year", "month", "week", "day"];
export const LEVEL_UNIT_DAYS: Record<Exclude<ZoomLevel, "overview">, number> = {
  year: 365.25,
  month: 30.44,
  week: 7,
  day: 1,
};
// Hysteresis for the reverse (zoom-out) transition: entering a finer level
// happens at exactly 100% of its unit's width, so checking the exact same
// 100% for the reverse would flicker on the slightest zoom-out jitter right
// at that boundary. Only climb back up once comfortably below it.
export const LEVEL_UP_RATIO = 0.8;

// How long one marker period is at each level — the stretch between two
// gridlines, which is what the markers draw and what a tile must stay
// inside. Each level is subdivided one step finer than its own name: the
// overview draws years, the year level months, and so on down to hours.
/// Which marker period a moment falls in — the same boundaries the gridlines
/// are drawn at, as a key that can be compared. Used to cut groups so none
/// of them spans a gridline (see `splitGroupsBy`), never to form them.
export function periodKeyForLevel(ms: number, level: ZoomLevel): string {
  const date = new Date(ms);
  switch (level) {
    case "overview":
      return `${date.getFullYear()}`;
    case "year":
      return `${date.getFullYear()}-${date.getMonth()}`;
    case "month":
      return `w${startOfWeek(date).getTime()}`;
    case "week":
      return `d${startOfDay(date).getTime()}`;
    case "day":
      return `h${startOfHour(date).getTime()}`;
  }
}

/// The calendar period a header label stands for at the drawn grid's level, as
/// [startMs, endMs): what a click on the label gathers into a cluster. None at
/// day level, whose labels are times of day.
export function labelPeriod(startMs: number, level: ZoomLevel): { startMs: number; endMs: number } | null {
  const d = new Date(startMs);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const span = (start: Date, end: Date) => ({ startMs: start.getTime(), endMs: end.getTime() });
  switch (level) {
    case "overview":
      return span(new Date(y, 0, 1), new Date(y + 1, 0, 1));
    case "year":
      return span(new Date(y, m, 1), new Date(y, m + 1, 1));
    case "month":
      return span(new Date(y, m, day), new Date(y, m, day + 7));
    case "week":
      return span(new Date(y, m, day), new Date(y, m, day + 1));
    case "day":
      return null;
  }
}

/// Whether any of the ascending timestamps falls inside [startMs, endMs).
export function hasTimeIn(sortedMs: readonly number[], startMs: number, endMs: number): boolean {
  let lo = 0;
  let hi = sortedMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedMs[mid] < startMs) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedMs.length && sortedMs[lo] < endMs;
}

export const MARKER_PERIOD_DAYS: Record<ZoomLevel, number> = {
  overview: 365.25,
  year: 30.44,
  month: 7,
  week: 1,
  day: 1 / 24,
};

export function startOfYear(d: Date) {
  return new Date(d.getFullYear(), 0, 1);
}
export function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function startOfWeek(d: Date) {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day + 6) % 7; // Monday as start
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
export function startOfHour(d: Date) {
  const copy = new Date(d);
  copy.setMinutes(0, 0, 0);
  return copy;
}
export function startOfDay(d: Date) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/// The level whose grid is actually drawn, given the two optional grids of
/// the settings ("Wochenraster anzeigen", "Stundenraster anzeigen").
///
/// Everything a level decides — the gridlines, the period a tile has to stay
/// inside, where a stack is cut — is keyed on the result, so switching a
/// grid off changes all three together. `nextLevel` deliberately knows
/// nothing about this: the zoom thresholds and their hysteresis stay the
/// same five steps, and two of them simply map onto the day grid.
///
/// - Without the week grid the day grid starts as soon as a month spans the
///   viewport. A day is then about a thirtieth of the viewport wide — too
///   narrow to be a column, which is `columnLevel`'s business, not this
///   function's.
/// - Without the hour grid the day grid simply stays, however far in.
export function gridLevel(level: ZoomLevel, showWeekGrid: boolean, showHourGrid: boolean): ZoomLevel {
  if (level === "month" && !showWeekGrid) return "week";
  if (level === "day" && !showHourGrid) return "week";
  return level;
}

/// The level whose periods are the COLUMNS: what a tile has to stay inside
/// and where a stack is cut. Usually the drawn grid itself (`grid`, the
/// result of `gridLevel`) — but a grid is drawn as soon as the unit above it
/// spans the viewport, and at that moment its own periods are a twenty-
/// fourth or a thirtieth of the viewport wide: narrower than a tile. Since
/// a tile is never drawn wider than its column, binding tiles to such a
/// grid shrank them at every level change, only for them to grow back over
/// the next few zoom steps.
///
/// So the two are told apart. The fine grid still appears when it used to,
/// as a faint preview (see `previewGridOpacity`), while the columns stay
/// one step coarser until a period of the fine grid is at least
/// `minColumnPx` wide — a drawn tile plus its cascade. From there on the
/// two are the same level again.
///
/// Walks only over grids that are switched on, so the coarser step is the
/// one that was on screen before. In the overview there is nothing coarser
/// to fall back to: far enough out a year is narrower than a tile, and the
/// tiles shrink to it as they always have.
export function columnLevel(
  grid: ZoomLevel,
  pixelsPerDay: number,
  minColumnPx: number,
  showWeekGrid: boolean,
): ZoomLevel {
  let idx = LEVEL_ORDER.indexOf(grid);
  while (idx > 0 && MARKER_PERIOD_DAYS[LEVEL_ORDER[idx]] * pixelsPerDay < minColumnPx) {
    idx--;
    // The week grid is the only one that can lie BETWEEN two others; the
    // hour grid is the finest and is never stepped back onto.
    if (LEVEL_ORDER[idx] === "month" && !showWeekGrid) idx--;
  }
  return LEVEL_ORDER[idx];
}

// How strongly a grid that is not yet the column grid is drawn: barely
// there when it appears, full strength at the width where it takes over as
// columns. Tied to the column width rather than to time, so the lines grow
// in with the zoom itself and the hand-over to full strength is no step.
export const PREVIEW_GRID_MIN_OPACITY = 0.2;
export function previewGridOpacity(columnPx: number, minColumnPx: number): number {
  if (minColumnPx <= 0) return 1;
  const from = minColumnPx * 0.25;
  const progress = Math.min(1, Math.max(0, (columnPx - from) / (minColumnPx - from)));
  return PREVIEW_GRID_MIN_OPACITY + (1 - PREVIEW_GRID_MIN_OPACITY) * progress;
}

// Below this width of one day, a day gridline is labelled with the day of
// the month alone: the full "14. Sept. 2012" is around 95px wide in the
// bold variant and would run into its neighbours. The pinned label at the
// left edge keeps naming the full date either way.
export const DAY_LABEL_FULL_MIN_PX = 110;

// Recursive so a resize or a large zoom jump (e.g. hitting the zoom floor/ceiling
// in one wheel tick) can cross more than one level boundary in a single
// check instead of getting stuck one level behind.
export function nextLevel(current: ZoomLevel, pixelsPerDay: number, viewportWidth: number): ZoomLevel {
  const idx = LEVEL_ORDER.indexOf(current);
  if (idx < LEVEL_ORDER.length - 1) {
    const finer = LEVEL_ORDER[idx + 1] as Exclude<ZoomLevel, "overview">;
    if (pixelsPerDay * LEVEL_UNIT_DAYS[finer] >= viewportWidth) {
      return nextLevel(finer, pixelsPerDay, viewportWidth);
    }
  }
  if (idx > 0) {
    const ownDays = LEVEL_UNIT_DAYS[current as Exclude<ZoomLevel, "overview">];
    if (pixelsPerDay * ownDays <= LEVEL_UP_RATIO * viewportWidth) {
      return nextLevel(LEVEL_ORDER[idx - 1], pixelsPerDay, viewportWidth);
    }
  }
  return current;
}

// "Woche 7-13.06.2010" style range label for a week marker (Month-level
// view) — falls back to spelling out both months/years when the week
// actually crosses a month or year boundary. Written in the UI language's
// date scheme (see utils/datetime.ts): day-first with "." in German, with
// "/" in Spanish, month-first with "/" in English.
export function formatWeekLabel(start: Date, end: Date, language: Language = currentLanguage()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  const [sd, sm, sy] = [String(start.getDate()), pad(start.getMonth() + 1), start.getFullYear()];
  const [ed, em, ey] = [String(end.getDate()), pad(end.getMonth() + 1), end.getFullYear()];
  let range: string;
  if (language === "en") {
    if (sameMonth) range = `${em}/${sd}-${ed}/${ey}`;
    else if (sameYear) range = `${sm}/${sd}-${em}/${ed}/${ey}`;
    else range = `${sm}/${sd}/${sy}-${em}/${ed}/${ey}`;
  } else {
    const sep = language === "de" ? "." : "/";
    // German closes a day-month pair with a dot ("28.06.-4.07."), Spanish
    // does not ("28/06-4/07").
    const close = language === "de" ? "." : "";
    if (sameMonth) range = `${sd}-${ed}${sep}${em}${sep}${ey}`;
    else if (sameYear) range = `${sd}${sep}${sm}${close}-${ed}${sep}${em}${sep}${ey}`;
    else range = `${sd}${sep}${sm}${sep}${sy}-${ed}${sep}${em}${sep}${ey}`;
  }
  return `${t("timeline.weekPrefix")} ${range}`;
}
