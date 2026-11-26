import type { ItemInfo, ViewerNavType } from "../../types";
import { DEFAULT_LANE_STACK } from "../fileKindLane";
import { MAX_LANE_TILE_SCALE } from "./geometry";

// The lanes of the timeline (one band per file type) and the type filter of
// the cluster view. Moved out of Timeline.tsx unchanged.

// Items are split into vertical bands by file type instead of all sharing
// one horizontal center line.
//
// Which bands exist is a property of the stream, not of the app: a lane
// is drawn only where there are files of that type, the drawn lanes share
// the height equally, and their tiles grow with the room that leaves (see
// `buildLaneLayout`). Their top-to-bottom order is the user's — the
// `lane_order` setting, see `normalizeLaneOrder`.
//
// This replaced a fixed four-lane stack with fixed weights (documents and
// audios at 75% of a photo/video lane). The weights are gone with it, at
// the user's decision: a lane's height now says only how many lanes there
// are, so weighting one type over another would make the equal split
// unreadable.
export type LaneType = "document" | "image" | "video" | "audio";
// The order a stream that has never been configured gets, and the
// order `normalizeLaneOrder` completes a partial stored value with. Shared
// with the settings dialog — see DEFAULT_LANE_STACK.
export const LANE_TYPES: LaneType[] = DEFAULT_LANE_STACK;
// Display order for the cluster view's type-filter checkboxes — distinct
// from the lane order, which is top-to-bottom stacking and unrelated to how
// these should read left-to-right.
export const CLUSTER_FILTER_ORDER: LaneType[] = ["image", "video", "audio", "document"];
export const LANE_LABEL_KEY: Record<LaneType, string> = {
  document: "timeline.laneDocuments",
  image: "timeline.laneImages",
  video: "timeline.laneVideos",
  audio: "timeline.laneAudios",
};

// "other" and "email" have no dedicated lane — both fold back into the
// document lane, the closest match to "non-media file".
export function laneForFileType(fileType: ItemInfo["file_type"]): LaneType {
  return fileType === "other" || fileType === "email" || fileType === "diary" ? "document" : fileType;
}

// Whether a tile's label sticks to the filename instead of ever showing the
// timestamp. True for audio and documents: a photo or a video identifies
// itself through its own thumbnail, so the date is the useful extra a label
// can carry — an audio file or a document has no telling preview, its NAME
// is the identifying information, and trading that for a date leaves
// nothing to recognise the file by. Keyed on the lane so "other"/"email"
// files follow the documents they are grouped with everywhere else.
export function labelKeepsName(fileType: ItemInfo["file_type"]): boolean {
  const lane = laneForFileType(fileType);
  return lane === "audio" || lane === "document";
}

// Which of the four type checkboxes the year-cluster view shows is on.
// Keyed by LaneType (not ItemInfo["file_type"]) since "other" files fold
// into the document checkbox exactly like they fold into the document lane.
export type FileTypeFilter = Record<LaneType, boolean>;
export const ALL_NAV_TYPES: ViewerNavType[] = ["image", "video", "audio", "document"];
export const ALL_TYPES_VISIBLE: FileTypeFilter = { document: true, image: true, video: true, audio: true };
// Deliberately a browser-local preference, not a project setting: unlike
// tileDragEnabled (moved to the project DB on 2026-10-10, see
// ProjectSettings in types.ts) this is a view preference with no reason to
// travel with a restored/duplicated project — it just saves re-ticking the
// same boxes next time this machine opens a cluster.
export const CLUSTER_FILTER_STORAGE_KEY = "cronostream.clusterTypeFilter";
export function loadClusterTypeFilter(): FileTypeFilter {
  try {
    const raw = localStorage.getItem(CLUSTER_FILTER_STORAGE_KEY);
    if (!raw) return { ...ALL_TYPES_VISIBLE };
    const parsed = JSON.parse(raw) as Partial<FileTypeFilter>;
    return {
      document: parsed.document ?? true,
      image: parsed.image ?? true,
      video: parsed.video ?? true,
      audio: parsed.audio ?? true,
    };
  } catch {
    return { ...ALL_TYPES_VISIBLE };
  }
}

/// The vertical band layout for one set of items: which lanes are drawn,
/// where each one sits, and how big their tiles are.
///
/// Computed once per change of (lane order, which types are present) and
/// then only read — every consumer of a lane position takes this as an
/// argument rather than recomputing it, so the labels, the tiles' resting
/// Y, the clustering thresholds and the drag preview can never disagree
/// about the stack.
export interface LaneLayout {
  /// The lanes actually drawn, top to bottom.
  lanes: LaneType[];
  /// Band for every lane type, so a lookup never has to handle a miss. A
  /// type that isn't drawn maps to the full area, which is what a lone
  /// centered lane gets — it can only be read if an item of that type
  /// appeared without the layout being recomputed, and then the whole area
  /// is the safe answer rather than a band that doesn't exist.
  bounds: Record<LaneType, { topPct: number; heightPct: number }>;
  /// Factor on every tile's drawn size (and on the pixel thresholds that
  /// decide grouping, which have to be measured against what is drawn).
  tileScale: number;
}

/// A stored lane order, completed to all four types.
///
/// Mirrors `parse_lane_order` on the Rust side, which normalises the same
/// way before the value ever reaches here. Repeated rather than trusted
/// because this also covers the prop being absent (a fresh project, before
/// the settings fetch resolves) and keeps the invariant the rest of the
/// file relies on in one readable place: the result always names every
/// lane exactly once.
export function normalizeLaneOrder(order: LaneType[] | undefined): LaneType[] {
  if (!order || order.length === 0) return LANE_TYPES;
  const seen: LaneType[] = [];
  for (const lane of order) {
    if (LANE_TYPES.includes(lane) && !seen.includes(lane)) seen.push(lane);
  }
  for (const lane of LANE_TYPES) if (!seen.includes(lane)) seen.push(lane);
  return seen;
}

/// The layout for `order` given the types the stream actually holds.
///
/// Empty lanes are left out entirely and the rest share the height in equal
/// parts, so one category fills the whole area (vertically centered, since
/// its band *is* the area), two take half each, three a third. Four is the
/// familiar full stack.
///
/// `tileScale` is the square root of the extra room, not the room itself. A
/// single lane is four times as tall as one of four, but drawing its tiles
/// four times as wide would also quadruple the grouping threshold — which
/// is measured in drawn tile widths (see GROUP_LINK_PX) — and collapse the
/// whole view into one stack per period. The square root spends part of the
/// gained height on bigger tiles and leaves the rest as air: ×2 for one
/// lane, ×1.41 for two, ×1.15 for three, and exactly ×1 for four, so a
/// stream with all four categories keeps the tile size it always had.
/// It also lands where the hover magnification still fits inside a lane
/// plus its overrun allowance (see LANE_OVERRUN_RATIO) at two and three
/// lanes, which full proportionality would not.
export function buildLaneLayout(order: LaneType[], present: ReadonlySet<LaneType>): LaneLayout {
  // Nothing imported yet: keep all four bands, which is what the empty
  // timeline has always shown behind its teaser. Hiding them all would
  // leave an unlabeled void instead.
  const lanes = order.filter((lane) => present.has(lane));
  const drawn = lanes.length > 0 ? lanes : order;
  const heightPct = 100 / drawn.length;
  const bounds = {} as Record<LaneType, { topPct: number; heightPct: number }>;
  for (const lane of LANE_TYPES) bounds[lane] = { topPct: 0, heightPct: 100 };
  drawn.forEach((lane, index) => {
    bounds[lane] = { topPct: index * heightPct, heightPct };
  });
  return {
    lanes: drawn,
    bounds,
    tileScale: Math.min(MAX_LANE_TILE_SCALE, Math.sqrt(LANE_TYPES.length / drawn.length)),
  };
}

/// Which lane types `items` actually puts on the timeline — the question
/// `buildLaneLayout` needs answered.
///
/// Derived from `laneForFileType`, not from the header's category counts:
/// those keep "other" as its own bucket, while a lane folds it into
/// documents, so a stream holding nothing but unclassifiable files
/// would otherwise report no lanes at all and still draw tiles.
export function presentLanesOf(items: ItemInfo[]): Set<LaneType> {
  const present = new Set<LaneType>();
  for (const item of items) {
    present.add(laneForFileType(item.file_type));
    if (present.size === LANE_TYPES.length) break;
  }
  return present;
}

export function laneCenterPercent(layout: LaneLayout, fileType: ItemInfo["file_type"]): number {
  const { topPct, heightPct } = layout.bounds[laneForFileType(fileType)];
  return topPct + heightPct / 2;
}
