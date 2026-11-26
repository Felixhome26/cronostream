import type { FileKind, ItemKind } from "../types";

/// The four type groups the whole app thinks in — the timeline's lanes, and
/// the file managers' type filter.
export type KindLane = "image" | "video" | "audio" | "document";

export const KIND_LANE_ORDER: KindLane[] = ["image", "video", "audio", "document"];

/// The timeline's lanes top to bottom in a stream that has never had
/// the order configured — the stack the timeline had when it was fixed, so
/// nothing moves for anyone who doesn't open the setting. Distinct from
/// `KIND_LANE_ORDER`, which is a left-to-right reading order for chips and
/// has no say over the stack.
///
/// The one frontend definition of that default: the timeline, the settings
/// dialog and the pre-fetch default in `ProjectShell` all read it from
/// here, so a reordering cannot end up meaning two different things in two
/// places. The Rust side keeps its own copy (`LANE_ORDER_DEFAULT`) — it
/// normalises stored values before they ever reach the frontend and cannot
/// import this.
export const DEFAULT_LANE_STACK: KindLane[] = ["document", "image", "video", "audio"];

export const KIND_LANE_LABEL_KEY: Record<KindLane, string> = {
  image: "timeline.laneImages",
  video: "timeline.laneVideos",
  audio: "timeline.laneAudios",
  document: "timeline.laneDocuments",
};

/// One glyph per group — the same four the file manager's tiles use, so a
/// category is recognisable by the same symbol wherever it is named.
export const KIND_LANE_ICON: Record<KindLane, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎧",
  document: "📄",
};

/// Which group a file kind belongs to.
///
/// `email` and `other` fold into "document" — the same answer
/// `Timeline.tsx`'s `laneForFileType` has always given, deliberately reused
/// rather than re-decided: from the user's side an e-mail *is* a document,
/// and a filter offering "Dokumente" that silently excluded mail would hide
/// files with no way to get at them. Keeping the two in step means a file
/// never sits in one group on the timeline and another in the file manager.
/// Diary entries fold into "document" too, as on the timeline — without
/// that they matched no chip and vanished from the file managers.
export function laneForKind(kind: ItemKind): KindLane {
  return kind === "email" || kind === "other" || kind === "diary" ? "document" : kind;
}

/// Every group enabled — "no filter", which is what both file managers
/// start on.
export function allKindLanes(): Set<KindLane> {
  return new Set(KIND_LANE_ORDER);
}

/// Whether an entry survives the current chip selection.
///
/// A folder always passes: the chips filter file *types*, and hiding the
/// folders would break navigation rather than narrow the view. An entry
/// whose kind the backend couldn't determine (`null`) passes too — being
/// unclassifiable is not a reason to become unreachable.
export function passesKindFilter(entry: { is_dir: boolean; kind: FileKind | null }, lanes: Set<KindLane>): boolean {
  if (entry.is_dir || entry.kind === null) return true;
  return lanes.has(laneForKind(entry.kind));
}
