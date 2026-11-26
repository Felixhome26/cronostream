import { describe, expect, it } from "vitest";
import type { PhaseGroupView, PhaseView } from "../types";
import {
  buildPhaseRows,
  dayToMs,
  phaseAreaHeight,
  phaseAreaShownHeight,
  phaseBarHeight,
  phaseBarTop,
  phaseContentHeight,
  phaseGroupRowHeight,
} from "./phaseLayout";

function phase(id: string, startDate: string, endDate: string, extra: Partial<PhaseView> = {}): PhaseView {
  return { id, groupId: "g", title: id, startDate, endDate, color: "#336699", visible: true, ongoing: false, ...extra };
}

function group(id: string, sortIndex: number, phases: PhaseView[], extra: Partial<PhaseGroupView> = {}): PhaseGroupView {
  return { id, name: id, sortIndex, visibility: "visible", overlapAllowed: true, lastEditedAt: 0, phases, ...extra };
}

describe("dayToMs", () => {
  it("is local midnight of the day", () => {
    expect(dayToMs("2024-03-31")).toBe(new Date(2024, 2, 31).getTime());
  });

  it("adds days across month ends", () => {
    expect(dayToMs("2024-02-28", 2)).toBe(new Date(2024, 2, 1).getTime());
  });

  it("keeps years below 100 as they are", () => {
    expect(new Date(dayToMs("0050-06-01")).getFullYear()).toBe(50);
  });

  it("is NaN for anything but YYYY-MM-DD", () => {
    expect(dayToMs("2024-3-1")).toBeNaN();
    expect(dayToMs("")).toBeNaN();
  });
});

describe("heights", () => {
  it("bar height is a fifteenth of the tile, never below 16", () => {
    expect(phaseBarHeight(300)).toBe(20);
    expect(phaseBarHeight(100)).toBe(16);
  });

  it("row height grows by bar plus gap per sub-row", () => {
    expect(phaseGroupRowHeight(1, 20)).toBe(28);
    expect(phaseGroupRowHeight(2, 20)).toBe(52);
    expect(phaseGroupRowHeight(0, 20)).toBe(28);
  });
});

describe("buildPhaseRows", () => {
  it("packs overlapping phases into sub-rows", () => {
    const rows = buildPhaseRows(
      [group("g", 0, [phase("a", "2020-01-01", "2020-06-30"), phase("b", "2020-03-01", "2020-12-31"), phase("c", "2020-07-01", "2020-08-01")])],
      20,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subRows).toBe(2);
    expect(rows[0].phases.map((p) => [p.phase.id, p.subRow])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
    // The end date is inclusive: the bar ends at midnight after it.
    expect(rows[0].phases[0].endMs).toBe(new Date(2020, 6, 1).getTime());
  });

  it("orders rows by sortIndex and stacks them", () => {
    const rows = buildPhaseRows(
      [group("second", 2, [phase("x", "2020-01-01", "2020-01-02")]), group("first", 1, [phase("y", "2020-01-01", "2020-01-02")])],
      20,
    );
    expect(rows.map((r) => [r.group.id, r.top, r.height])).toEqual([
      ["first", 0, 28],
      ["second", 28, 28],
    ]);
    expect(phaseContentHeight(rows)).toBe(56);
  });

  it("leaves out hidden groups, hidden phases, broken dates and empty groups", () => {
    const rows = buildPhaseRows(
      [
        group("hidden", 0, [phase("a", "2020-01-01", "2020-01-02")], { visibility: "hidden" }),
        group("partial", 1, [phase("shown", "2020-01-01", "2020-01-02"), phase("off", "2020-01-01", "2020-01-02", { visible: false })], {
          visibility: "partial",
        }),
        group("broken", 2, [phase("bad", "2020-01-05", "2020-01-01"), phase("worse", "nonsense", "2020-01-01")]),
        group("empty", 3, []),
      ],
      20,
    );
    expect(rows.map((r) => r.group.id)).toEqual(["partial"]);
    expect(rows[0].phases.map((p) => p.phase.id)).toEqual(["shown"]);
  });

  it("picks a readable text colour per bar", () => {
    const rows = buildPhaseRows([group("g", 0, [phase("light", "2020-01-01", "2020-01-02", { color: "#ffee99" }), phase("dark", "2021-01-01", "2021-01-02", { color: "#112233" })])], 20);
    expect(rows[0].phases.map((p) => p.textColor)).toEqual(["#000000", "#ffffff"]);
  });
});

describe("phase area", () => {
  const rows = buildPhaseRows(
    [0, 1, 2, 3, 4].map((i) => group(`g${i}`, i, [phase(`p${i}`, "2020-01-01", "2020-01-02")])),
    20,
  );

  it("shows at most three rows before it scrolls", () => {
    expect(phaseContentHeight(rows)).toBe(5 * 28);
    expect(phaseAreaHeight(rows)).toBe(3 * 28);
    expect(phaseAreaHeight([])).toBe(0);
  });

  it("gives up height so the tiles keep their minimum size", () => {
    // Not measured yet: the natural height.
    expect(phaseAreaShownHeight(rows, 0, 150)).toBe(84);
    // Plenty of room: the natural height.
    expect(phaseAreaShownHeight(rows, 1000, 150)).toBe(84);
    // 150 px tiles may shrink to 96 px, a share of 0.36 of 200 px = 72.
    expect(phaseAreaShownHeight(rows, 200, 150)).toBe(72);
    // Never less than the first row.
    expect(phaseAreaShownHeight(rows, 50, 150)).toBe(28);
  });

  it("places sub-rows below the row's padding", () => {
    expect(phaseBarTop(rows[1], 0, 20)).toBe(28 + 4);
    expect(phaseBarTop(rows[1], 1, 20)).toBe(28 + 4 + 24);
  });
});
