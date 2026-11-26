import { afterEach, describe, expect, it } from "vitest";
import type { ItemInfo } from "../../types";
import {
  buildEmailSrcDoc,
  effectiveName,
  emailSenderAddress,
  emailSenderName,
  formatAttachmentSize,
  formatMetaDate,
  formatMetaSize,
  isSpreadsheetFile,
} from "./itemText";

const item = (original_filename: string, display_name: string | null = null) => ({ original_filename, display_name }) as ItemInfo;

describe("names", () => {
  it("prefers the display name", () => {
    expect(effectiveName(item("a.jpg"))).toBe("a.jpg");
    expect(effectiveName(item("a.jpg", "Urlaub"))).toBe("Urlaub");
  });

  it("recognises spreadsheets by extension, in any case", () => {
    expect(isSpreadsheetFile(item("Liste.XLSX"))).toBe(true);
    expect(isSpreadsheetFile(item("daten.csv"))).toBe(true);
    expect(isSpreadsheetFile(item("brief.docx"))).toBe(false);
    expect(isSpreadsheetFile(item("ohne-endung"))).toBe(false);
  });

  it("splits a sender into name and address", () => {
    expect(emailSenderName("Erika Muster <erika@example.com>")).toBe("Erika Muster");
    expect(emailSenderAddress("Erika Muster <erika@example.com>")).toBe("erika@example.com");
    expect(emailSenderName("erika@example.com")).toBe("erika@example.com");
    expect(emailSenderAddress("erika@example.com")).toBeNull();
    expect(emailSenderName(null)).toBeNull();
  });
});

describe("sizes and dates", () => {
  it("writes file sizes with one decimal below ten", () => {
    expect(formatMetaSize(null)).toBeNull();
    expect(formatMetaSize(512)).toBe("512 B");
    expect(formatMetaSize(1536)).toBe("1.5 KB");
    expect(formatMetaSize(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatMetaSize(5 * 1024 ** 4)).toBe("5120 GB");
  });

  it("writes attachment sizes", () => {
    expect(formatAttachmentSize(999)).toBe("999 B");
    expect(formatAttachmentSize(1536)).toBe("2 KB");
    expect(formatAttachmentSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
  });

  it("keeps missing dates missing", () => {
    expect(formatMetaDate(null)).toBeNull();
  });
});

describe("mail frame", () => {
  const root = (globalThis as unknown as { document: { documentElement: { dataset?: Record<string, string> } } }).document
    .documentElement;
  afterEach(() => {
    delete root.dataset;
  });

  it("forces the theme's colours around the sanitised body", () => {
    root.dataset = { theme: "light" };
    const light = buildEmailSrcDoc("<p>Hallo</p>");
    expect(light).toContain("background: #faf6ef !important");
    expect(light).toContain("<body><p>Hallo</p></body>");
    root.dataset = { theme: "dark" };
    expect(buildEmailSrcDoc("x")).toContain("background: #1e1e26 !important");
  });
});
