import { describe, expect, it } from "vitest";
import { LANGUAGES, formatDecimal, quoted, setLanguage, t, tf, tn } from "./i18n";
import source from "./i18n.ts?raw";

describe("quoted", () => {
  it("uses the quotation marks of the UI language", () => {
    setLanguage("de");
    expect(quoted("Urlaub")).toBe("\u201EUrlaub\u201C");
    setLanguage("en");
    expect(quoted("Urlaub")).toBe("\u201CUrlaub\u201D");
    setLanguage("es");
    expect(quoted("Urlaub")).toBe("\u00ABUrlaub\u00BB");
    setLanguage("de");
  });
});

describe("tf", () => {
  it("fills placeholders in the middle of a text", () => {
    setLanguage("de");
    expect(tf("browser.sendToProjectDone", { name: "X" })).toBe("Zur Warteliste von X hinzugefügt");
    setLanguage("en");
    expect(tf("browser.sendToProjectDone", { name: "X" })).toBe("Added to the waiting list of X");
    setLanguage("de");
  });
});

describe("formatDecimal", () => {
  it("writes the decimal separator of the UI language", () => {
    setLanguage("de");
    expect(formatDecimal(1.5, 1)).toBe("1,5");
    setLanguage("es");
    expect(formatDecimal(1.5, 1)).toBe("1,5");
    setLanguage("en");
    expect(formatDecimal(1.5, 1)).toBe("1.5");
    setLanguage("de");
  });
});

describe("tn", () => {
  it("uses the singular for one and the plural otherwise", () => {
    setLanguage("de");
    expect(tn(1, "project.statsVideos")).toBe("1 Video");
    expect(tn(2, "project.statsVideos")).toBe("2 Videos");
    expect(tn(0, "project.statsVideos")).toBe("0 Videos");
    setLanguage("en");
    expect(tn(1, "project.statsImages")).toBe("1 image");
    expect(tn(3, "project.statsImages")).toBe("3 images");
    setLanguage("es");
    expect(tn(1, "project.statsVideos")).toBe("1 vídeo");
    setLanguage("de");
  });

  it("puts the number in front of a suffix text", () => {
    setLanguage("de");
    expect(tn(1, "restore.restoredSuffix")).toBe("1 Datei wiederhergestellt");
    expect(tn(4, "restore.restoredSuffix")).toBe("4 Dateien wiederhergestellt");
  });

  it("fills further placeholders", () => {
    setLanguage("de");
    const groups = tn(1, "browser.duplicates.groupCount");
    expect(tn(2, "browser.duplicates.found", { groups })).toBe("2 mögliche Duplikate in 1 Gruppe gefunden.");
  });

  it("falls back to the plural when a text has no singular", () => {
    setLanguage("de");
    expect(tn(1, "timeline.noteClusterHeading")).toBe(`1 ${t("timeline.noteClusterHeading")}`);
  });
});

describe("counted texts", () => {
  const keys = [...source.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);

  it("has no '(en)' / '(s)' stand-ins for a real plural", () => {
    for (const language of LANGUAGES) {
      setLanguage(language);
      for (const key of keys) {
        expect(t(key), `${language} ${key}`).not.toMatch(/\w\((?:en|s|es|n)\)/);
      }
    }
    setLanguage("de");
  });
});
