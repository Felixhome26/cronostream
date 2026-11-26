import { describe, expect, it } from "vitest";
import { buildClusterTree, cutClusterTree, dissolvePxPerDay, splitGroupsBy } from "./clusterTree";

const DAY_MS = 24 * 60 * 60 * 1000;

/// The groups of a cut, as the item values they hold.
function cut(times: number[], maxGapMs: number, maxSpanMs: number): number[][] {
  return cutClusterTree(buildClusterTree(times), times, maxGapMs, maxSpanMs).map((g) => g.items);
}

describe("buildClusterTree", () => {
  it("has no tree for an empty lane", () => {
    expect(buildClusterTree([])).toBeNull();
  });

  it("is a single leaf for one item", () => {
    expect(buildClusterTree([5])).toEqual({ lo: 0, hi: 0, spanMs: 0, maxGapMs: 0, left: null, right: null });
  });

  it("splits at the largest gap", () => {
    const root = buildClusterTree([0, 1, 2, 50, 51])!;
    expect(root.maxGapMs).toBe(48);
    expect(root.spanMs).toBe(51);
    expect([root.left!.lo, root.left!.hi]).toEqual([0, 2]);
    expect([root.right!.lo, root.right!.hi]).toEqual([3, 4]);
  });

  it("halves an evenly spaced run instead of peeling items off its front", () => {
    const root = buildClusterTree([0, 10, 20, 30, 40, 50, 60, 70])!;
    expect([root.left!.lo, root.left!.hi]).toEqual([0, 3]);
    expect([root.right!.lo, root.right!.hi]).toEqual([4, 7]);
  });
});

describe("cutClusterTree", () => {
  it("groups what lies within the gap and leaves single items out", () => {
    expect(cut([0, 1, 2, 100, 101, 1000], 5, 10_000)).toEqual([
      [0, 1, 2],
      [100, 101],
    ]);
  });

  it("splits a run that is wider than the span limit", () => {
    expect(cut([0, 1, 2, 3], 5, 2)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("returns nothing for an empty lane", () => {
    expect(cutClusterTree(null, [], 10, 10)).toEqual([]);
  });

  it("keeps items with one shared timestamp together at any zoom", () => {
    expect(cut([7, 7, 7], 0, 0)).toEqual([[7, 7, 7]]);
  });

  // The property the tree exists for (see the file's header comment):
  // loosening the threshold only ever merges groups, it never moves an
  // item from one group into another.
  it("only merges groups as the threshold grows", () => {
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += ((i * 7919) % 97) + 1;
      times.push(t);
    }
    let previous = cut(times, 1, Infinity);
    for (let gap = 2; gap <= 100; gap++) {
      const next = cut(times, gap, Infinity);
      for (const group of previous) {
        const container = next.find((g) => g.includes(group[0]));
        expect(container).toBeDefined();
        for (const value of group) expect(container).toContain(value);
      }
      previous = next;
    }
  });
});

describe("dissolvePxPerDay", () => {
  it("is infinite when nothing can be pulled apart", () => {
    expect(dissolvePxPerDay({ spanMs: 0, maxGapMs: 0 }, 150, 450)).toBe(Infinity);
  });

  it("takes whichever limit gives way first", () => {
    // Gap of one day against 150 px → 150 px/day; span of two days
    // against 450 px → 225 px/day. The gap gives way first.
    expect(dissolvePxPerDay({ spanMs: 2 * DAY_MS, maxGapMs: DAY_MS }, 150, 450)).toBe(150);
    expect(dissolvePxPerDay({ spanMs: 10 * DAY_MS, maxGapMs: DAY_MS }, 150, 450)).toBe(45);
  });
});

describe("splitGroupsBy", () => {
  it("cuts groups where the key changes and recomputes span and gap", () => {
    const items = [
      { t: 0, k: "a" },
      { t: 1, k: "a" },
      { t: 2, k: "b" },
      { t: 5, k: "b" },
      { t: 6, k: "c" },
    ];
    const pieces = splitGroupsBy(
      [{ items, spanMs: 6, maxGapMs: 3 }],
      (i) => i.t,
      (i) => i.k,
    );
    expect(pieces.map((p) => ({ keys: p.items.map((i) => i.k).join(""), spanMs: p.spanMs, maxGapMs: p.maxGapMs }))).toEqual([
      { keys: "aa", spanMs: 1, maxGapMs: 1 },
      { keys: "bb", spanMs: 3, maxGapMs: 3 },
    ]);
  });
});
