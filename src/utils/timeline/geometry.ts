import type { ItemInfo } from "../../types";
import { dissolvePxPerDay, type ClusterGroup } from "../clusterTree";

// Sizes and thresholds of the timeline's track: tile size, the zoom range,
// and the pixel distances that decide what forms a stack. Moved out of
// Timeline.tsx unchanged.

export const TILE_SIZE = 150;
// Ceiling on the lane-count tile magnification — see `buildLaneLayout`. A
// named constant because `EDGE_PADDING` has to reserve room for the widest
// tile the layout can ever produce, and that reservation is part of the
// track's coordinate system (every `trackX`), so it must not move when the
// lane count does.
export const MAX_LANE_TILE_SCALE = 2;

// Fixed-pixel margin reserved at both ends of the track so the first/last
// tile's overhang (it's centered on its date, so half its width extends
// to each side) never gets clipped by the scroll container's edge. Day-
// based padding alone isn't enough: at a wide auto-fit zoom (years per
// screen), even two weeks of padding can collapse to just a few pixels.
// Sized for the largest tile the lane layout can hand out (see
// MAX_LANE_TILE_SCALE), not for the base tile: a stream with a single
// lane draws tiles twice as wide, and half of that overhangs the first and
// last date. Deliberately a constant rather than following the live lane
// count — EDGE_PADDING is the origin of track space (see `trackX`,
// `timeAt`, and the zoom-anchor maths), so letting it move when an import
// adds a lane would shift every date's pixel position at once.
export const EDGE_PADDING = (TILE_SIZE * MAX_LANE_TILE_SCALE) / 2 + 24;

export const MIN_PX_PER_DAY = 0.04;

// The deepest zoom, derived from the viewport instead of being a fixed
// number of pixels: one HOUR spans the screen.
//
// That is the floor of the level model as it stands — the finest named
// level is the day, and its own markers are hours, so an hour filling the
// screen is the point past which a minute level would have to exist.
//
// A fixed ceiling made the deepest *reachable* level depend on the window
// size, which is how "zooming in stops at week view" came about: entering
// a level needs its unit to span the viewport, so the day level needs
// 1600 px/day in a 1600 px window — against the old ceiling of 200 the day
// level was unreachable in every window, and the week level only in windows
// up to 1400 px wide. The same ceiling also capped the click-to-resolve
// gesture: 42 % of groups in the test archive lay closer together than it
// allowed.
export const HOURS_PER_DAY = 24;
export function maxPxPerDayFor(viewportWidth: number): number {
  // The fallback covers the first frame, before the container is measured.
  return (viewportWidth > 0 ? viewportWidth : 1280) * HOURS_PER_DAY;
}

// The zoom-out floor: pixelsPerDay at which the entire item range exactly
// fills the viewport (same formula the initial auto-fit uses). Used both
// for that auto-fit and as handleWheel's lower clamp, so zooming out can
// never go past "everything visible" — there's nothing useful past that
// point anyway, just empty space on both sides.
export function computeFitPxPerDay(viewportWidth: number, rangeDays: number): number {
  const available = Math.max(viewportWidth - EDGE_PADDING * 2, 100);
  return Math.min(maxPxPerDayFor(viewportWidth), Math.max(MIN_PX_PER_DAY, available / Math.max(rangeDays, 1)));
}

// Distance below which two items in the same lane are one group — which is
// now one number with one meaning: a full tile width, i.e. **their tiles
// overlap**. Tiles are centered on their date, so centers closer together
// than one tile width cannot both be seen; that is exactly the condition a
// stack exists to resolve, and the scale factor of the lane is applied along
// with it so the threshold is always the *rendered* width.
//
// It used to be 0.3 of a tile, chosen for what the hover fan could add
// rather than for what overlaps: items 45-150px apart then overlapped by up
// to two thirds while being treated as separate lone tiles — the "several
// clusters side by side, partly overlapping" this rewrite is about. Measured
// on the 820-image test archive at one-year zoom, the change halves the
// overlapping lone tiles (29 → 15) without stopping groups from coming
// apart on the way in (120 groups, 142 lone tiles at full zoom).
export const GROUP_LINK_PX = TILE_SIZE;
// How wide a group may get before it is cut into separate groups. Linking by
// distance alone CHAINS: at Year zoom one file a fortnight links into a
// single group spanning the whole view. The cut itself is made at the
// group's own largest gap (see utils/clusterTree.ts), so where it falls is a
// property of the data rather than of the walk.
export const GROUP_MAX_SPAN_PX = TILE_SIZE * 3;
// A group at rest is a cascade of at most this many tiles, whatever its
// size, plus a count once it holds more than it shows. Three is the ceiling
// at which an offset still reads as depth rather than as clutter, and
// nailing it there keeps the footprint a group adds constant (~20px) instead
// of growing with the member count and eating into its neighbours.
export const STACK_DEPTH = 3;

// A member's place in its stack's cascade, 0 being the front tile. Normally
// the group's own order; `frontId` lifts one member to the front without
// changing the order of the others (see stackFrontId in Timeline).
export function stackIndexIn(group: ItemInfo[], id: string, frontId: string | null): number {
  const index = group.findIndex((g) => g.id === id);
  if (frontId == null || index === -1) return index;
  const front = group.findIndex((g) => g.id === frontId);
  if (front === -1) return index;
  if (id === frontId) return 0;
  return index < front ? index + 1 : index;
}
export const STACK_STEP_X = 5;
export const STACK_STEP_Y = 4;
// Every cluster gets its member count badge, down to two — the cascade
// offset alone doesn't reliably read as "this is a stack" rather than a
// stray hover-scale artifact at every zoom level, so the number is what
// actually says "there's more than one file here".
export const BADGE_MIN_MEMBERS = 2;

/// One group at the current zoom, as `cutClusterTree` produced it, plus the
/// scale factor of the lane it belongs to — needed to turn its span and its
/// largest gap back into the pixel thresholds they were measured against.
export type GroupInfo = ClusterGroup<ItemInfo> & { laneScale: number };

/// Where this group comes apart, in pixels per day — see
/// `dissolvePxPerDay`, which holds the arithmetic next to the cut it has to
/// agree with.
///
/// Passed the full tile size even though the cut uses the DRAWN width,
/// which at coarse zooms is the narrower period instead. That stays exact:
/// in the regime where the period is the narrower of the two, the limit
/// works out independent of the zoom (period days × zoom, over zoom), so a
/// group that holds there holds throughout it — and the zoom this returns
/// always lands beyond that regime, where the tile size is the binding
/// threshold again. A group that would NOT hold in the period regime has
/// already come apart and is never asked.
///
/// A group can also come apart EARLIER than this, when a finer zoom level
/// brings finer gridlines and `splitGroupsBy` cuts it at one of them. That
/// only makes the answer conservative in the right direction — zooming to
/// the value returned here never leaves the group standing.
export function groupDissolvePxPerDay(info: GroupInfo): number {
  return dissolvePxPerDay(info, GROUP_LINK_PX * info.laneScale, GROUP_MAX_SPAN_PX * info.laneScale);
}

/// The zoom at which one file stands on its own, in pixels per day: both
/// its neighbours in the lane are then more than a drawn tile width away,
/// so no group can link it to either of them. Not the same question as
/// `groupDissolvePxPerDay`, which says where its group first splits — at
/// its largest gap, which may well lie elsewhere in the group and leave the
/// file still stacked with a closer neighbour.
///
/// The gaps are those to the previous and next file of the same lane, null
/// where there is none. 0 when there is no neighbour at all, `Infinity`
/// when a neighbour carries the very same timestamp.
export function isolatePxPerDay(prevGapMs: number | null, nextGapMs: number | null, laneScale: number): number {
  const gaps = [prevGapMs, nextGapMs].filter((g): g is number => g != null);
  if (gaps.length === 0) return 0;
  const nearest = Math.min(...gaps);
  if (nearest <= 0) return Infinity;
  return (GROUP_LINK_PX * laneScale * 24 * 60 * 60 * 1000) / nearest;
}
