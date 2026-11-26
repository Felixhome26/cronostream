import { describe, expect, it } from "vitest";
import {
  combineDateWithTimeOfDay,
  formatDate,
  formatDateTime,
  formatTime,
  fromDatetimeLocalValue,
  toDateOnlyValue,
  toDatetimeLocalValue,
} from "./datetime";
import { printExportBaseName } from "./printFilename";
import { formatDay, nextDay, normalizeHex } from "./phases";

// Local time (Europe/Berlin, see vitest.config.ts).
const afternoon = new Date(2004, 10, 2, 14, 39).toISOString();
const morning = new Date(2004, 10, 2, 0, 5).toISOString();

describe("formatDate / formatTime / formatDateTime", () => {
  it("writes each language's own way", () => {
    expect(formatDateTime(afternoon, "de")).toBe("02.11.2004 - 14:39 Uhr");
    expect(formatDateTime(afternoon, "en")).toBe("11/02/2004 - 2:39 PM");
    expect(formatDateTime(afternoon, "es")).toBe("02/11/2004 - 14:39 h");
  });

  it("uses 12 for midnight and noon on the 12-hour clock", () => {
    expect(formatTime(new Date(morning), "en")).toBe("12:05 AM");
    expect(formatTime(new Date(2004, 10, 2, 12, 0), "en")).toBe("12:00 PM");
  });

  it("is null for a missing value and the raw input for an unparseable one", () => {
    expect(formatDateTime(null, "de")).toBeNull();
    expect(formatDateTime("", "de")).toBeNull();
    expect(formatDateTime("kaputt", "de")).toBe("kaputt");
    expect(formatDate(undefined, "de")).toBeNull();
  });
});

describe("date field values", () => {
  it("round-trips through the local datetime field", () => {
    expect(toDatetimeLocalValue(afternoon)).toBe("2004-11-02T14:39");
    expect(fromDatetimeLocalValue("2004-11-02T14:39")).toBe(afternoon);
    expect(fromDatetimeLocalValue("nonsense")).toBeNull();
  });

  it("takes the local calendar day, not the UTC one", () => {
    // 00:30 local on 1 April is still 31 March in UTC.
    expect(toDateOnlyValue("2026-03-31T22:30:00Z")).toBe("2026-04-01");
  });

  it("changes the day and keeps the time of day", () => {
    expect(combineDateWithTimeOfDay("2010-07-15", afternoon)).toBe(new Date(2010, 6, 15, 14, 39).toISOString());
    expect(combineDateWithTimeOfDay("2010-07", afternoon)).toBeNull();
    expect(combineDateWithTimeOfDay("2010-07-15", "nonsense")).toBeNull();
  });
});

describe("print export names", () => {
  const iso = new Date(2026, 9, 9, 14, 30).toISOString();

  it("has no characters that are illegal in file names", () => {
    expect(printExportBaseName(iso, "de")).toBe("09.10.2026 - 14.30 Uhr");
    expect(printExportBaseName(iso, "en")).toBe("10-09-2026 - 2.30 PM");
    expect(printExportBaseName(iso, "es")).toBe("09-10-2026 - 14.30");
  });

  it("falls back to a sanitised raw value", () => {
    expect(printExportBaseName("a:b/c", "de")).toBe("a-b-c");
  });
});

describe("phase days", () => {
  it("steps over month and year ends", () => {
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2023-12-31")).toBe("2024-01-01");
    // Not covered: years below 1000 come back without leading zeros
    // ("100-01-01"), out of reach behind the earliest-year setting.
  });

  it("writes a stored day without going through UTC", () => {
    // formatDay follows the active UI language, English under Node.
    expect(formatDay("2024-01-05")).toMatch(/^(05\.01\.2024|01\/05\/2024|05\/01\/2024)$/);
    expect(formatDay("garbage")).toBe("garbage");
  });

  it("normalises colour input", () => {
    expect(normalizeHex(" #AbCdEf ")).toBe("#abcdef");
    expect(normalizeHex("abcdef")).toBe("#abcdef");
    expect(normalizeHex("#abc")).toBeNull();
  });
});
