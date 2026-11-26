// Hierarchical grouping of one lane's items by time, built once and then
// only *cut* per zoom level.
//
// Why a tree rather than the single pass this replaced
// ----------------------------------------------------
// The previous rule walked a lane chronologically and started a new group
// whenever the gap to the previous item exceeded a threshold — plus a second
// condition that closed a group once it had grown wider than a fixed number
// of pixels, there to stop a drawn-out chain from linking into one group
// spanning the whole view.
//
// The gap half of that was sound: the threshold is converted from pixels
// into a time gap, so membership never depended on where the track happened
// to be scrolled to. The width cap was not. It cut a chain at whatever point
// the sequential walk had reached, so the cut position moved with the zoom:
// measured on a chain of 80 items ten days apart, a 2 % zoom step slid the
// boundary by one item and changed the group membership of *all 80* — while
// the number of groups stayed at two. Nothing split and nothing merged, the
// boundary just slid, and an open pile dissolved and re-formed under the
// pointer for the whole gesture.
//
// Splitting a group at its own largest gap instead makes the family of
// partitions a dendrogram: every zoom level cuts the same fixed tree at a
// different height, so the only possible changes are a group splitting into
// its own children or children merging back into their parent. Membership is
// a pure function of the timestamps and one scalar threshold — no dependency
// on scroll position, and none on the order the items were visited in.
//
// The same structure answers "how far would one have to zoom in for this
// group to come apart" directly, off the node — which is what a click on a
// stack needs (see `dissolvePxPerDay` at the bottom).

/// One node of the tree: a contiguous, chronological run of a lane's items,
/// addressed by index into that lane's own array.
export interface ClusterNode {
  /// Inclusive index range into the lane's chronological array.
  lo: number;
  hi: number;
  /// Time from the first to the last item of this run.
  spanMs: number;
  /// The largest gap between two consecutive items inside this run. Zero for
  /// a single item, and zero for any run whose items share one timestamp —
  /// such a run can never be split by zooming, which is a case callers have
  /// to handle rather than zoom at (see `dissolvePxPerDay`).
  maxGapMs: number;
  /// Both null for a leaf (a single item).
  left: ClusterNode | null;
  right: ClusterNode | null;
}

export interface ClusterGroup<T> {
  items: T[];
  spanMs: number;
  maxGapMs: number;
}

/// Builds the tree for one lane from its chronologically sorted timestamps.
/// Returns null for an empty lane.
///
/// Each node is split at its largest internal gap. Ties go to the gap
/// nearest the middle of the run: without that, a run of evenly spaced items
/// (a burst of frames, a batch of scans with regular timestamps — not an
/// exotic shape) has no single largest gap, and taking the first one peels
/// items off the front one at a time instead of halving the run. Measured on
/// 80 evenly spaced items that produced 34 lone tiles followed by a group of
/// 46; with the tie-break it produces two groups of 40.
///
/// Cost is O(n · depth) — O(n log n) for the balanced splits that evenly
/// spread data produces, and O(n²) in the worst case of strictly decreasing
/// gaps. Built once per item set rather than per zoom step, with each lane
/// kept separate, so n stays small enough for that ceiling not to matter.
export function buildClusterTree(timesMs: number[]): ClusterNode | null {
  if (timesMs.length === 0) return null;

  const node = (lo: number, hi: number): ClusterNode => {
    if (lo === hi) {
      return { lo, hi, spanMs: 0, maxGapMs: 0, left: null, right: null };
    }
    const middle = (lo + hi) / 2;
    let splitAt = lo;
    let largestGap = -1;
    for (let i = lo; i < hi; i++) {
      const gap = timesMs[i + 1] - timesMs[i];
      if (gap > largestGap || (gap === largestGap && Math.abs(i - middle) < Math.abs(splitAt - middle))) {
        largestGap = gap;
        splitAt = i;
      }
    }
    return {
      lo,
      hi,
      spanMs: timesMs[hi] - timesMs[lo],
      maxGapMs: largestGap,
      left: node(lo, splitAt),
      right: node(splitAt + 1, hi),
    };
  };

  return node(0, timesMs.length - 1);
}

/// The partition at one zoom level: the largest subtrees that keep every
/// internal gap within `maxGapMs` and their own width within `maxSpanMs`.
///
/// Single items are left out — they are not groups, and every caller treats
/// a lone tile differently from a pile.
export function cutClusterTree<T>(
  root: ClusterNode | null,
  items: T[],
  maxGapMs: number,
  maxSpanMs: number,
): ClusterGroup<T>[] {
  if (!root) return [];
  const groups: ClusterGroup<T>[] = [];

  const walk = (node: ClusterNode) => {
    if (node.maxGapMs <= maxGapMs && node.spanMs <= maxSpanMs) {
      if (node.hi > node.lo) {
        groups.push({
          items: items.slice(node.lo, node.hi + 1),
          spanMs: node.spanMs,
          maxGapMs: node.maxGapMs,
        });
      }
      return;
    }
    // A leaf that fails the test is a single item, i.e. not a group.
    if (!node.left || !node.right) return;
    walk(node.left);
    walk(node.right);
  };

  walk(root);
  return groups;
}

/// The zoom (in pixels per day) above which `group` comes apart.
///
/// Reads straight off the thresholds that formed it: a group holds while
/// its largest internal gap and its own width both still fit, and both
/// limits are a pixel distance divided by the zoom, so they shrink as it
/// grows. Both limits must already carry the lane's scale factor, the same
/// way `cutClusterTree` was given them.
///
/// `Infinity` when the group has neither width nor an internal gap — every
/// member carries the same timestamp, so no amount of zooming will ever
/// separate them, and a caller that zooms to resolve a group has to offer
/// something else for that case.
export function dissolvePxPerDay(
  group: { spanMs: number; maxGapMs: number },
  linkPx: number,
  maxSpanPx: number,
): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const byGap = group.maxGapMs > 0 ? (linkPx * DAY_MS) / group.maxGapMs : Infinity;
  const bySpan = group.spanMs > 0 ? (maxSpanPx * DAY_MS) / group.spanMs : Infinity;
  return Math.min(byGap, bySpan);
}

/// Cuts each group wherever `keyFor` changes from one member to the next,
/// recomputing span and largest gap for every piece.
///
/// The grouping above is geometric: what overlaps on screen belongs
/// together, whatever the calendar says. That is deliberate — it is what
/// keeps two photos either side of midnight on New Year's Eve in one pile
/// instead of in two piles a year apart on screen. But it also lets a dense
/// run link straight across a gridline, and a group that spans two periods
/// has to be drawn in one of them: measured on the test archive, 14 of 19
/// groups at the widest zoom straddled a year boundary, the largest holding
/// 323 files, and the tile shown on top of it was from the year next door.
///
/// So the calendar comes back as a CONSTRAINT on the groups, never as the
/// rule that forms them: a group may not cross a gridline. The pieces are
/// still whatever geometry made them, only cut at the boundaries the viewer
/// can see. Pieces of a single item are dropped — one file is a tile, not a
/// stack — which is why this returns fewer pieces than keys in that case.
export function splitGroupsBy<T>(
  groups: ClusterGroup<T>[],
  timeOf: (item: T) => number,
  keyFor: (item: T) => string,
): ClusterGroup<T>[] {
  const out: ClusterGroup<T>[] = [];

  const push = (items: T[]) => {
    if (items.length < 2) return;
    // Both have to be re-derived rather than inherited: they are what
    // decides when this piece comes apart on further zoom (see
    // `dissolvePxPerDay`), and a piece is never wider than the group it
    // came from.
    let maxGapMs = 0;
    for (let i = 1; i < items.length; i++) {
      const gap = timeOf(items[i]) - timeOf(items[i - 1]);
      if (gap > maxGapMs) maxGapMs = gap;
    }
    out.push({ items, spanMs: timeOf(items[items.length - 1]) - timeOf(items[0]), maxGapMs });
  };

  for (const group of groups) {
    let piece: T[] = [];
    let key: string | null = null;
    for (const item of group.items) {
      const itemKey = keyFor(item);
      if (key !== null && itemKey !== key) {
        push(piece);
        piece = [];
      }
      key = itemKey;
      piece.push(item);
    }
    push(piece);
  }

  return out;
}
