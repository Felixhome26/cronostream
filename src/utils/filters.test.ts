import { describe, expect, it } from "vitest";
import type { DirEntryInfo } from "../types";
import { contrastRatio, readableTextColor, relativeLuminance } from "./contrast";
import { allKindLanes, laneForKind, passesKindFilter } from "./fileKindLane";
import { isInRange, isRangeInvalid, rangeForPreset } from "./printRange";
import { mergeSorted, sortEntries } from "./sortEntries";

function entry(name: string, extra: Partial<DirEntryInfo> = {}): DirEntryInfo {
  return {
    name,
    path: `/x/${name}`,
    is_dir: false,
    kind: "image",
    can_add: true,
    size: null,
    fs_created_at: null,
    fs_modified_at: null,
    rotation: 0,
    ...extra,
  };
}

describe("sortEntries", () => {
  it("puts folders first and sorts names naturally", () => {
    const sorted = sortEntries([entry("IMG_10"), entry("Ordner", { is_dir: true }), entry("IMG_9"), entry("img_2")], {
      field: "name",
      direction: "asc",
    });
    expect(sorted.map((e) => e.name)).toEqual(["Ordner", "img_2", "IMG_9", "IMG_10"]);
  });

  it("keeps entries without the value last in both directions", () => {
    const entries = [entry("a", { size: 5 }), entry("b"), entry("c", { size: 9 })];
    expect(sortEntries(entries, { field: "size", direction: "asc" }).map((e) => e.name)).toEqual(["a", "c", "b"]);
    expect(sortEntries(entries, { field: "size", direction: "desc" }).map((e) => e.name)).toEqual(["c", "a", "b"]);
  });

  it("sorts dates as their RFC 3339 text", () => {
    const entries = [entry("new", { fs_modified_at: "2024-01-01T00:00:00Z" }), entry("old", { fs_modified_at: "2001-01-01T00:00:00Z" })];
    expect(sortEntries(entries, { field: "modified", direction: "asc" }).map((e) => e.name)).toEqual(["old", "new"]);
  });

  it("merges a streamed batch into the same order a full sort gives", () => {
    const sort = { field: "size", direction: "desc" } as const;
    const first = sortEntries([entry("a", { size: 3 }), entry("b", { size: 1 }), entry("d", { is_dir: true })], sort);
    const batch = [entry("c", { size: 2 }), entry("e"), entry("f", { size: 3 })];
    expect(mergeSorted(first, batch, sort).map((e) => e.name)).toEqual(sortEntries([...first, ...batch], sort).map((e) => e.name));
  });
});

describe("kind filter", () => {
  it("counts mail and other files as documents", () => {
    expect(laneForKind("email")).toBe("document");
    expect(laneForKind("other")).toBe("document");
    expect(laneForKind("diary")).toBe("document");
    expect(laneForKind("video")).toBe("video");
  });

  it("never hides folders or unclassified files", () => {
    const none = new Set<never>();
    expect(passesKindFilter({ is_dir: true, kind: "image" }, none)).toBe(true);
    expect(passesKindFilter({ is_dir: false, kind: null }, none)).toBe(true);
    expect(passesKindFilter({ is_dir: false, kind: "image" }, none)).toBe(false);
    expect(passesKindFilter({ is_dir: false, kind: "email" }, allKindLanes())).toBe(true);
  });
});

describe("date ranges", () => {
  it("knows the presets", () => {
    expect(rangeForPreset("all")).toEqual({ from: "", to: "" });
    expect(rangeForPreset("year:2019")).toEqual({ from: "2019-01-01", to: "2019-12-31" });
    // 31 March minus a month is "31 February", which rolls into March.
    expect(rangeForPreset("last1", new Date(2026, 2, 31, 12))).toEqual({ from: "2026-03-03", to: "2026-03-31" });
  });

  it("rejects only an end before the start", () => {
    expect(isRangeInvalid({ from: "2020-01-02", to: "2020-01-01" })).toBe(true);
    expect(isRangeInvalid({ from: "2020-01-01", to: "2020-01-01" })).toBe(false);
    expect(isRangeInvalid({ from: "", to: "2020-01-01" })).toBe(false);
  });

  it("includes both ends as whole local days", () => {
    const range = { from: "2026-03-01", to: "2026-03-31" };
    expect(isInRange(new Date(2026, 2, 1, 0, 0).toISOString(), range)).toBe(true);
    expect(isInRange(new Date(2026, 2, 31, 23, 59).toISOString(), range)).toBe(true);
    expect(isInRange(new Date(2026, 3, 1, 0, 30).toISOString(), range)).toBe(false);
    expect(isInRange("2000-01-01T00:00:00Z", { from: "", to: "" })).toBe(true);
  });
});

describe("contrast", () => {
  it("measures luminance of six-digit colours only", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("000000")).toBe(0);
    expect(relativeLuminance("#fff")).toBeNull();
    expect(contrastRatio(1, 0)).toBe(21);
  });

  it("picks black on light and white on dark colours", () => {
    expect(readableTextColor("#ffffff")).toBe("#000000");
    expect(readableTextColor("#000000")).toBe("#ffffff");
    expect(readableTextColor("#ffd700")).toBe("#000000");
    expect(readableTextColor("kaputt")).toBe("#ffffff");
  });
});
