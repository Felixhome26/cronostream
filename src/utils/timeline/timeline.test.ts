import { describe, expect, it } from "vitest";
import type { ItemInfo } from "../../types";
import {
  DAY_MS,
  PREVIEW_GRID_MIN_OPACITY,
  columnLevel,
  formatWeekLabel,
  gridLevel,
  hasTimeIn,
  labelPeriod,
  nextLevel,
  periodKeyForLevel,
  previewGridOpacity,
  startOfDay,
  startOfHour,
  startOfWeek,
} from "./calendar";
import { EDGE_PADDING, GROUP_LINK_PX, MIN_PX_PER_DAY, computeFitPxPerDay, groupDissolvePxPerDay, isolatePxPerDay, maxPxPerDayFor, stackIndexIn } from "./geometry";
import {
  LANE_TYPES,
  buildLaneLayout,
  labelKeepsName,
  laneCenterPercent,
  laneForFileType,
  loadClusterTypeFilter,
  normalizeLaneOrder,
  presentLanesOf,
} from "./lanes";

const item = (id: string, file_type: ItemInfo["file_type"] = "image") => ({ id, file_type }) as ItemInfo;

describe("calendar", () => {
  it("starts weeks on Monday at local midnight", () => {
    // Sunday 13 June 2010 belongs to the week of Monday 7 June.
    expect(startOfWeek(new Date(2010, 5, 13, 18, 30))).toEqual(new Date(2010, 5, 7));
    expect(startOfWeek(new Date(2010, 5, 7, 0, 0))).toEqual(new Date(2010, 5, 7));
    expect(startOfDay(new Date(2010, 5, 13, 18, 30))).toEqual(new Date(2010, 5, 13));
    expect(startOfHour(new Date(2010, 5, 13, 18, 30, 12))).toEqual(new Date(2010, 5, 13, 18));
  });

  it("gives a header label its calendar period, none for times of day", () => {
    const period = (level: Parameters<typeof labelPeriod>[1], start: Date) => {
      const p = labelPeriod(start.getTime(), level);
      return p && [new Date(p.startMs), new Date(p.endMs)];
    };
    expect(period("overview", new Date(2010, 0, 1))).toEqual([new Date(2010, 0, 1), new Date(2011, 0, 1)]);
    expect(period("year", new Date(2010, 11, 1))).toEqual([new Date(2010, 11, 1), new Date(2011, 0, 1)]);
    // The week with the October clock change is 169 hours long where there is one.
    expect(period("month", new Date(2010, 9, 25))).toEqual([new Date(2010, 9, 25), new Date(2010, 10, 1)]);
    expect(period("week", new Date(2010, 9, 31))).toEqual([new Date(2010, 9, 31), new Date(2010, 10, 1)]);
    expect(period("day", new Date(2010, 5, 13))).toBeNull();
  });

  it("tells whether a period holds a file, its end excluded", () => {
    const times = [10, 20, 30];
    expect(hasTimeIn(times, 20, 21)).toBe(true);
    expect(hasTimeIn(times, 11, 20)).toBe(false);
    expect(hasTimeIn(times, 31, 99)).toBe(false);
    expect(hasTimeIn([], 0, 99)).toBe(false);
  });

  it("names the period a moment falls in, per level", () => {
    const ms = new Date(2010, 5, 13, 18, 30).getTime();
    expect(periodKeyForLevel(ms, "overview")).toBe("2010");
    expect(periodKeyForLevel(ms, "year")).toBe("2010-5");
    expect(periodKeyForLevel(ms, "month")).toBe(`w${new Date(2010, 5, 7).getTime()}`);
    expect(periodKeyForLevel(ms, "week")).toBe(`d${new Date(2010, 5, 13).getTime()}`);
    expect(periodKeyForLevel(ms, "day")).toBe(`h${new Date(2010, 5, 13, 18).getTime()}`);
  });

  it("enters a finer level once its unit spans the viewport", () => {
    const width = 1000;
    expect(nextLevel("overview", 1, width)).toBe("overview");
    expect(nextLevel("overview", width / 365.25, width)).toBe("year");
    // One big jump crosses several levels at once.
    expect(nextLevel("overview", width, width)).toBe("day");
  });

  it("only climbs back below 80 % of the unit (hysteresis)", () => {
    const width = 1000;
    const yearPx = width / 365.25;
    expect(nextLevel("year", yearPx * 0.9, width)).toBe("year");
    expect(nextLevel("year", yearPx * 0.79, width)).toBe("overview");
  });

  it("maps a level onto the day grid when its own grid is switched off", () => {
    // Both grids on: every level keeps its own grid.
    for (const level of ["overview", "year", "month", "week", "day"] as const) {
      expect(gridLevel(level, true, true)).toBe(level);
    }
    // No week grid: the day grid starts where the week grid used to.
    expect(gridLevel("month", false, true)).toBe("week");
    expect(gridLevel("day", false, true)).toBe("day");
    // No hour grid: the day grid stays however far in.
    expect(gridLevel("day", true, false)).toBe("week");
    expect(gridLevel("month", true, false)).toBe("month");
    // Neither: overview and year are untouched, the rest is the day grid.
    expect(["overview", "year", "month", "week", "day"].map((l) => gridLevel(l as never, false, false))).toEqual([
      "overview",
      "year",
      "week",
      "week",
      "week",
    ]);
  });

  it("keeps the columns one grid coarser until a fine column holds a tile", () => {
    const width = 1600;
    const minColumnPx = 160;
    // Hours appear once a day spans the viewport, 67px apart: the columns
    // stay days until an hour is as wide as a tile.
    expect(columnLevel("day", width, minColumnPx, true)).toBe("week");
    expect(columnLevel("day", minColumnPx * 24 - 1, minColumnPx, true)).toBe("week");
    expect(columnLevel("day", minColumnPx * 24, minColumnPx, true)).toBe("day");
    // Without the week grid, days appear with a month across the viewport:
    // the columns stay months, skipping the grid that is switched off.
    const monthFills = width / 30.44;
    expect(columnLevel("week", monthFills, minColumnPx, false)).toBe("year");
    expect(columnLevel("week", minColumnPx, minColumnPx, false)).toBe("week");
    // With it, the step back from too-narrow days is the week grid.
    expect(columnLevel("week", 100, minColumnPx, true)).toBe("month");
    // Wide enough from the start: grid and columns are the same level.
    expect(columnLevel("month", monthFills, minColumnPx, true)).toBe("month");
    // Nothing is coarser than the overview, however narrow a year gets.
    expect(columnLevel("overview", 0.04, minColumnPx, true)).toBe("overview");
    expect(columnLevel("year", 0.04, minColumnPx, true)).toBe("overview");
  });

  it("draws a preview grid faintly and at full strength at the hand-over", () => {
    expect(previewGridOpacity(0, 160)).toBe(PREVIEW_GRID_MIN_OPACITY);
    expect(previewGridOpacity(40, 160)).toBe(PREVIEW_GRID_MIN_OPACITY);
    expect(previewGridOpacity(160, 160)).toBe(1);
    expect(previewGridOpacity(500, 160)).toBe(1);
    const mid = previewGridOpacity(100, 160);
    expect(mid).toBeGreaterThan(PREVIEW_GRID_MIN_OPACITY);
    expect(mid).toBeLessThan(1);
  });

  it("spells out month and year only where the week crosses them", () => {
    expect(formatWeekLabel(new Date(2010, 5, 7), new Date(2010, 5, 13), "de")).toMatch(/ 7-13\.06\.2010$/);
    expect(formatWeekLabel(new Date(2010, 5, 28), new Date(2010, 6, 4), "de")).toMatch(/ 28\.06\.-4\.07\.2010$/);
    expect(formatWeekLabel(new Date(2010, 11, 27), new Date(2011, 0, 2), "de")).toMatch(/ 27\.12\.2010-2\.01\.2011$/);
    expect(formatWeekLabel(new Date(2010, 5, 7), new Date(2010, 5, 13), "en")).toMatch(/ 06\/7-13\/2010$/);
    expect(formatWeekLabel(new Date(2010, 5, 28), new Date(2010, 6, 4), "en")).toMatch(/ 06\/28-07\/4\/2010$/);
    expect(formatWeekLabel(new Date(2010, 11, 27), new Date(2011, 0, 2), "en")).toMatch(/ 12\/27\/2010-01\/2\/2011$/);
    expect(formatWeekLabel(new Date(2010, 5, 7), new Date(2010, 5, 13), "es")).toMatch(/ 7-13\/06\/2010$/);
    expect(formatWeekLabel(new Date(2010, 5, 28), new Date(2010, 6, 4), "es")).toMatch(/ 28\/06-4\/07\/2010$/);
  });
});

describe("geometry", () => {
  it("lets one hour fill the viewport at the deepest zoom", () => {
    expect(maxPxPerDayFor(1600)).toBe(1600 * 24);
    expect(maxPxPerDayFor(0)).toBe(1280 * 24);
  });

  it("fits the whole range between the edge paddings, within the zoom limits", () => {
    expect(computeFitPxPerDay(1000 + EDGE_PADDING * 2, 100)).toBe(10);
    expect(computeFitPxPerDay(1000, 1e9)).toBe(MIN_PX_PER_DAY);
    // A range under a day counts as one day filling the room between the paddings.
    expect(computeFitPxPerDay(1000, 0)).toBe(1000 - EDGE_PADDING * 2);
    expect(computeFitPxPerDay(1000, 1e-6)).toBe(1000 - EDGE_PADDING * 2);
  });

  it("moves the front member to the head of the cascade only", () => {
    const group = [item("a"), item("b"), item("c"), item("d")];
    expect(group.map((g) => stackIndexIn(group, g.id, null))).toEqual([0, 1, 2, 3]);
    expect(group.map((g) => stackIndexIn(group, g.id, "c"))).toEqual([1, 2, 0, 3]);
    expect(stackIndexIn(group, "x", "c")).toBe(-1);
    expect(stackIndexIn(group, "b", "x")).toBe(1);
  });

  it("scales the dissolve zoom with the lane", () => {
    const info = { items: [], spanMs: 0, maxGapMs: DAY_MS, laneScale: 2 };
    expect(groupDissolvePxPerDay(info)).toBe(GROUP_LINK_PX * 2);
  });

  it("isolates a file by its nearest neighbour, not by the group's largest gap", () => {
    // A week before, four weeks after: the week decides.
    expect(isolatePxPerDay(7 * DAY_MS, 28 * DAY_MS, 1)).toBeCloseTo(GROUP_LINK_PX / 7);
    expect(isolatePxPerDay(null, DAY_MS, 2)).toBe(GROUP_LINK_PX * 2);
    expect(isolatePxPerDay(null, null, 1)).toBe(0);
    expect(isolatePxPerDay(0, DAY_MS, 1)).toBe(Infinity);
  });
});

describe("lanes", () => {
  it("completes a stored order to all four lanes, without repeats", () => {
    expect(normalizeLaneOrder(undefined)).toEqual(LANE_TYPES);
    expect(normalizeLaneOrder(["video", "video", "image"])).toEqual(["video", "image", "document", "audio"]);
  });

  it("draws only lanes with files and grows their tiles by the square root", () => {
    const order = normalizeLaneOrder(undefined);
    const one = buildLaneLayout(order, new Set(["image"]));
    expect(one.lanes).toEqual(["image"]);
    expect(one.tileScale).toBe(2);
    expect(one.bounds.image).toEqual({ topPct: 0, heightPct: 100 });

    const two = buildLaneLayout(order, new Set(["audio", "document"]));
    expect(two.lanes).toEqual(["document", "audio"]);
    expect(two.tileScale).toBeCloseTo(Math.SQRT2);
    expect(two.bounds.audio).toEqual({ topPct: 50, heightPct: 50 });
    // A type that isn't drawn gets the whole area.
    expect(two.bounds.video).toEqual({ topPct: 0, heightPct: 100 });

    const all = buildLaneLayout(order, new Set(LANE_TYPES));
    expect(all.tileScale).toBe(1);
    // An empty stream keeps all four bands behind its teaser.
    expect(buildLaneLayout(order, new Set()).lanes).toEqual(order);
  });

  it("folds mail, diary and other files into the document lane", () => {
    expect(laneForFileType("email")).toBe("document");
    expect(laneForFileType("diary")).toBe("document");
    expect(laneForFileType("other")).toBe("document");
    expect(laneForFileType("audio")).toBe("audio");
    expect(labelKeepsName("email")).toBe(true);
    expect(labelKeepsName("image")).toBe(false);
    expect([...presentLanesOf([item("a", "email"), item("b", "video")])].sort()).toEqual(["document", "video"]);
  });

  it("centres a tile in its lane's band", () => {
    const layout = buildLaneLayout(normalizeLaneOrder(undefined), new Set(["document", "image"]));
    expect(laneCenterPercent(layout, "email")).toBe(25);
    expect(laneCenterPercent(layout, "image")).toBe(75);
  });

  it("shows every type when no filter is stored", () => {
    expect(loadClusterTypeFilter()).toEqual({ document: true, image: true, video: true, audio: true });
  });
});
