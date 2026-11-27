import type { ItemInfo } from "../../types";
import { formatDateTime } from "../datetime";
import { formatDecimal } from "../../i18n";
import { formatBytes } from "../../components/DeleteStreamDialog";

// How the timeline and its detail view name and describe a file: display
// name, sizes, dates, mail sender and the mail body's frame. Moved out of
// Timeline.tsx unchanged.

// Legacy `.doc` has no real content preview (see backend doc_card) — the
// viewer shows whatever filesystem metadata is available instead, same
// formatting as the file browser's preview panel.
export function formatMetaDate(iso: string | null): string | null {
  return formatDateTime(iso);
}
export function formatMetaSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  return formatBytes(bytes);
}

export function effectiveName(item: ItemInfo): string {
  return item.display_name ?? item.original_filename;
}

// Spreadsheets are `file_type: "document"` on the backend (see
// `fsbrowse::classify`) but have neither a thumbnail nor extracted text —
// the viewer needs its own icon+open-button card for them instead of
// trying (and failing) to show document text.
export const SPREADSHEET_EXTS = new Set(["csv", "xls", "xlsx"]);
export function isSpreadsheetFile(item: ItemInfo): boolean {
  const ext = item.original_filename.split(".").pop()?.toLowerCase();
  return !!ext && SPREADSHEET_EXTS.has(ext);
}

// Wraps the sanitised mail body (see `email::extract_html`) in a baseline
// stylesheet in the theme's colours before handing it to the iframe,
// forced with `!important` on every element rather than left as a
// default: a mail's own inline/compose-UI styling varies wildly (some
// mails set their own light background and dark text, others set
// nothing), and letting any of that through meant mails flipped between
// light and dark cards depending on what the original mail happened to
// carry. Forcing one consistent background + text keeps every mail,
// regardless of its own styling, matching the plain-text/icon fallback
// views. Literal values, because CSS variables don't reach into srcdoc;
// they mirror --cs-surface, --cs-text and --cs-border in App.css.
export function buildEmailSrcDoc(html: string): string {
  const light = document.documentElement.dataset.theme === "light";
  const bg = light ? "#faf6ef" : "#1e1e26";
  const fg = light ? "#2a241e" : "#f7f7f2";
  const border = light ? "rgba(60, 45, 30, 0.55)" : "rgba(255, 255, 255, 0.34)";
  const link = light ? "#1d5fa8" : "#8ab4f8";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: ${bg} !important; color: ${fg} !important; }
body { padding: 1.25rem 1.5rem; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.55; }
* { background-color: transparent !important; color: ${fg} !important; border-color: ${border} !important; }
img { max-width: 100%; height: auto; }
a { color: ${link} !important; }
</style></head><body>${html}</body></html>`;
}

// `email_sender` is stored as "Name <address>" (or just the bare address
// when the mail had no display name, see `email::format_addr`) — shown
// without the address, which is noise once a human-readable name exists.
export function emailSenderName(sender: string | null): string | null {
  if (!sender) return null;
  const match = sender.match(/^(.*)\s<[^<>]+>$/);
  return match ? match[1] : sender;
}

export function emailSenderAddress(sender: string | null): string | null {
  if (!sender) return null;
  const match = sender.match(/<([^<>]+)>$/);
  return match ? match[1] : null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${formatDecimal(bytes / (1024 * 1024), 1)} MB`;
}
