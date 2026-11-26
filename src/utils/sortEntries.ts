import type { DirEntryInfo } from "../types";
import { currentLanguage } from "../i18n";

/// Sort order of the file manager's folder listing (grid and single-image
/// view share it). The dates are the filesystem's own, which every listing
/// already carries — no extra disk access, unlike an EXIF date would be.
export type SortField = "name" | "size" | "created" | "modified";
export type SortDirection = "asc" | "desc";
export interface EntrySort {
  field: SortField;
  direction: SortDirection;
}

export const SORT_FIELDS: SortField[] = ["name", "size", "created", "modified"];
export const DEFAULT_ENTRY_SORT: EntrySort = { field: "name", direction: "asc" };

// Natural order ("IMG_9" before "IMG_10"), case- and accent-aware, in the
// UI language — what a person expects from a file list, unlike the
// backend's plain code-point sort.
// Built lazily per language — a module-level instance would keep the
// language that was active when this file first loaded.
let collator: Intl.Collator | null = null;
let collatorLanguage: string | null = null;
function getCollator(): Intl.Collator {
  const language = currentLanguage();
  if (!collator || collatorLanguage !== language) {
    collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
    collatorLanguage = language;
  }
  return collator;
}

function sortValue(entry: DirEntryInfo, field: SortField): string | number | null {
  switch (field) {
    case "name":
      return entry.name;
    case "size":
      return entry.size;
    case "created":
      return entry.fs_created_at;
    case "modified":
      return entry.fs_modified_at;
  }
}

/// Comparator for `sort`. Folders always lead, and an entry without the
/// value (no creation date on this filesystem, say) always trails —
/// in either direction, so flipping it never floods the top with blanks.
/// Ties fall back to the name, then the full path, so the order is total.
export function entryComparator(sort: EntrySort): (a: DirEntryInfo, b: DirEntryInfo) => number {
  const sign = sort.direction === "asc" ? 1 : -1;
  return (a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const va = sortValue(a, sort.field);
    const vb = sortValue(b, sort.field);
    if (va == null || vb == null) {
      if (va != null) return -1;
      if (vb != null) return 1;
    } else if (va !== vb) {
      // Dates are all UTC RFC 3339 strings of the same shape (see
      // `system_time_to_rfc3339`), so they compare correctly as text.
      const order =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : sort.field === "name"
            ? getCollator().compare(String(va), String(vb))
            : String(va) < String(vb)
              ? -1
              : 1;
      if (order !== 0) return sign * order;
    }
    return getCollator().compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  };
}

export function sortEntries(entries: DirEntryInfo[], sort: EntrySort): DirEntryInfo[] {
  return [...entries].sort(entryComparator(sort));
}

/// Inserts a streamed batch into an already sorted list: the batch is
/// sorted on its own and merged in one pass, instead of re-sorting the
/// whole (possibly huge) list for every batch of a subfolder walk.
export function mergeSorted(sorted: DirEntryInfo[], batch: DirEntryInfo[], sort: EntrySort): DirEntryInfo[] {
  const compare = entryComparator(sort);
  const incoming = [...batch].sort(compare);
  const out: DirEntryInfo[] = new Array(sorted.length + incoming.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < sorted.length && j < incoming.length) {
    out[k++] = compare(sorted[i], incoming[j]) <= 0 ? sorted[i++] : incoming[j++];
  }
  while (i < sorted.length) out[k++] = sorted[i++];
  while (j < incoming.length) out[k++] = incoming[j++];
  return out;
}

const STORAGE_KEY = "cronostream.fileBrowser.sort";

export function loadEntrySort(): EntrySort {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<EntrySort> | null;
    if (parsed && SORT_FIELDS.includes(parsed.field as SortField) && (parsed.direction === "asc" || parsed.direction === "desc")) {
      return { field: parsed.field as SortField, direction: parsed.direction };
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_ENTRY_SORT;
}

export function saveEntrySort(sort: EntrySort) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // not fatal — the choice just isn't remembered
  }
}
