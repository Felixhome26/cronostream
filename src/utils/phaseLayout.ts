import type { PhaseGroupView, PhaseView } from "../types";
import { readableTextColor } from "./contrast";

// Vertical layout of the phase area above the timeline's media lanes: one
// row per shown Themenbereich, split into sub-rows where its phases overlap.
// Kept free of any zoom/scroll state — the rows only change when the phases
// do, so the timeline derives them once and only the horizontal positions
// follow the zoom.

/// A bar is this share of the largest tile the lane layout can draw (one
/// lane, see MAX_LANE_TILE_SCALE in Timeline.tsx): 300 px / 15 = 20 px.
/// A fifth (60 px) proved too heavy; the bars are meant to stay discreet.
export const PHASE_BAR_TILE_RATIO = 1 / 15;
/// Floor under the bar height, so the title stays legible.
export const PHASE_BAR_MIN_HEIGHT = 16;
/// Gap between the sub-rows of one Themenbereich (4pt grid).
export const PHASE_SUBROW_GAP = 4;
/// Space above and below the bars inside a Themenbereich row.
export const PHASE_GROUP_PADDING = 4;
/// Rows shown before the phase area scrolls on its own.
export const PHASE_MAX_VISIBLE_GROUPS = 3;
/// A one-day phase seen from decades away is a fraction of a pixel wide;
/// it is still drawn this wide so it doesn't vanish.
export const PHASE_BAR_MIN_WIDTH = 4;
/// Most of the timeline's height (phase area + lanes, without the period
/// header) the phase area may take; past it, it scrolls on its own.
export const PHASE_AREA_MAX_SHARE = 0.4;
/// Floor under the height of a resting tile at its nominal size (TILE_SIZE
/// × the lane factor). The lanes give up height to the phase area and the
/// tiles shrink with them, so the phase area stops growing where the tiles
/// would drop below this — with four lanes that is a bit before 40 %.
export const LANE_TILE_MIN_HEIGHT = 96;

export function phaseBarHeight(maxTilePx: number): number {
  return Math.max(PHASE_BAR_MIN_HEIGHT, Math.round(maxTilePx * PHASE_BAR_TILE_RATIO));
}

export function phaseGroupRowHeight(subRows: number, barHeight: number): number {
  const rows = Math.max(1, subRows);
  return PHASE_GROUP_PADDING * 2 + rows * barHeight + (rows - 1) * PHASE_SUBROW_GAP;
}

export interface PhaseRowPhase {
  phase: PhaseView;
  groupId: string;
  groupName: string;
  subRow: number;
  /** Local midnight of the first day. */
  startMs: number;
  /** Local midnight AFTER the last day — the end date is inclusive. */
  endMs: number;
  textColor: string;
}

export interface PhaseGroupRow {
  group: PhaseGroupView;
  phases: PhaseRowPhase[];
  subRows: number;
  /** Offset from the top of the phase area's content. */
  top: number;
  height: number;
}

/// Local midnight of "YYYY-MM-DD" (plus `addDays`), NaN when it isn't one.
/// Local, not UTC, because the timeline's epoch and period markers are
/// local too — a UTC midnight would sit hours off the day's gridline.
export function dayToMs(day: string, addDays = 0): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return NaN;
  // setFullYear, not the constructor's year argument, which maps 0-99 to 19xx.
  const date = new Date(2000, 0, 1);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return date.getTime();
}

/// First-fit interval packing: each phase goes to the first sub-row whose
/// last phase has ended. Applied to every Themenbereich, not only those
/// allowing overlap — without overlaps it yields a single sub-row anyway,
/// and should the data ever disagree with the rule, nothing gets hidden
/// under another bar.
function packSubRows(phases: PhaseRowPhase[]): number {
  const rowEnds: number[] = [];
  for (const entry of phases) {
    let row = rowEnds.findIndex((end) => end <= entry.startMs);
    if (row < 0) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    rowEnds[row] = entry.endMs;
    entry.subRow = row;
  }
  return Math.max(1, rowEnds.length);
}

/// The rows to draw, top to bottom by `sortIndex`. A Themenbereich gets a
/// row while at least one of its phases is shown — the backend reports
/// "partial" when only some are, so the phase's own `visible` decides.
export function buildPhaseRows(groups: PhaseGroupView[], barHeight: number): PhaseGroupRow[] {
  const rows: PhaseGroupRow[] = [];
  let top = 0;
  const ordered = [...groups].sort((a, b) => a.sortIndex - b.sortIndex);
  for (const group of ordered) {
    if (group.visibility === "hidden") continue;
    const phases: PhaseRowPhase[] = [];
    for (const phase of group.phases) {
      if (!phase.visible) continue;
      const startMs = dayToMs(phase.startDate);
      const endMs = dayToMs(phase.endDate, 1);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      phases.push({
        phase,
        groupId: group.id,
        groupName: group.name,
        subRow: 0,
        startMs,
        endMs,
        textColor: readableTextColor(phase.color),
      });
    }
    if (phases.length === 0) continue;
    phases.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const subRows = packSubRows(phases);
    const height = phaseGroupRowHeight(subRows, barHeight);
    rows.push({ group, phases, subRows, top, height });
    top += height;
  }
  return rows;
}

/// Height of everything in the phase area, scrolled or not.
export function phaseContentHeight(rows: PhaseGroupRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.top + last.height : 0;
}

/// Height the phase area takes on screen: the first
/// PHASE_MAX_VISIBLE_GROUPS rows; the rest scrolls inside it.
export function phaseAreaHeight(rows: PhaseGroupRow[]): number {
  const last = rows[Math.min(rows.length, PHASE_MAX_VISIBLE_GROUPS) - 1];
  return last ? last.top + last.height : 0;
}

/// Height the phase area actually gets out of `stackHeight` (phase area +
/// lanes): its natural height (phaseAreaHeight), unless that would leave
/// the lanes too little — then capped at PHASE_AREA_MAX_SHARE, or lower
/// where the tiles would otherwise fall below LANE_TILE_MIN_HEIGHT. The
/// tiles shrink in proportion to the lanes, so a share `s` leaves them at
/// (1 − s) of their height. Never less than the first row, or there would
/// be nothing to scroll. `stackHeight` 0 means "not measured yet".
export function phaseAreaShownHeight(rows: PhaseGroupRow[], stackHeight: number, nominalTilePx: number): number {
  const natural = phaseAreaHeight(rows);
  if (natural === 0 || stackHeight <= 0) return natural;
  const tileFloor = Math.min(1, LANE_TILE_MIN_HEIGHT / Math.max(nominalTilePx, 1));
  const share = Math.max(0, Math.min(PHASE_AREA_MAX_SHARE, 1 - tileFloor));
  const cap = Math.max(rows[0].height, Math.floor(stackHeight * share));
  return Math.min(natural, cap);
}

/// Top of a phase's bar inside the phase area's content.
export function phaseBarTop(row: PhaseGroupRow, subRow: number, barHeight: number): number {
  return row.top + PHASE_GROUP_PADDING + subRow * (barHeight + PHASE_SUBROW_GAP);
}
