import { useSyncExternalStore } from "react";
import { invoke } from "../busy";
import type { DatedPath, DateSource, FileDateInfo, FileKind } from "../types";
import { formatDate } from "./datetime";
import { timestampSourceLabel } from "../i18n";

// The date a not-yet-added file will be filed under, shared by every place
// that offers the choice (drop box, file manager tiles) and by the add
// flows that finally use it. Module-level on purpose: a tile in the grid
// and the add button elsewhere must agree without threading props through.

const infos = new Map<string, FileDateInfo>();
const chosen = new Map<string, DateSource>();
const requested = new Set<string>();
/// The request each still-unanswered path is waiting on, so a caller that
/// needs the answer (an add flow) can wait for a request someone else
/// started (a tile that just appeared) instead of skipping the path.
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/// Reads the date candidates of every path not asked for yet, and waits for
/// the ones already being read. Safe to call repeatedly with overlapping
/// lists; once it resolves, every readable path in `paths` has its info.
export async function ensureDateInfos(paths: string[]): Promise<void> {
  const pending = new Set<Promise<void>>();
  for (const p of paths) {
    const running = inFlight.get(p);
    if (running) pending.add(running);
  }
  const fresh = paths.filter((p) => !requested.has(p));
  if (fresh.length > 0) {
    fresh.forEach((p) => requested.add(p));
    const request = (async () => {
      try {
        const result = await invoke<FileDateInfo[]>("get_date_candidates", { paths: fresh, operationId: crypto.randomUUID() });
        result.forEach((info) => infos.set(info.path, info));
        // Whatever came back empty is unreadable; allow a later retry.
        fresh.filter((p) => !infos.has(p)).forEach((p) => requested.delete(p));
        emit();
      } catch {
        fresh.forEach((p) => requested.delete(p));
      } finally {
        fresh.forEach((p) => {
          if (inFlight.get(p) === request) inFlight.delete(p);
        });
      }
    })();
    fresh.forEach((p) => inFlight.set(p, request));
    pending.add(request);
  }
  await Promise.all(pending);
}

export function setDateChoice(path: string, source: DateSource) {
  chosen.set(path, source);
  emit();
}

/// Kinds that can carry a creation date inside the file (see `media_date.rs`).
const MEDIA_DATE_KINDS = new Set<FileKind>(["video", "audio", "document"]);
/// How many paths one `get_media_dates` call reads. Small, so a caller that
/// stops asking (a closed review screen) leaves at most this much running.
export const MEDIA_DATE_CHUNK = 8;

export function canCarryMediaDate(info: FileDateInfo): boolean {
  return MEDIA_DATE_KINDS.has(info.kind);
}

/// The creation dates inside `paths` (one ffprobe run or document read
/// each), keyed by path; `null` where a file has none.
export async function readMediaDates(paths: string[]): Promise<Map<string, string | null>> {
  const result = await invoke<{ path: string; value: string | null }[]>("get_media_dates", { paths });
  return new Map(result.map((r) => [r.path, r.value]));
}

const mediaRequested = new Set<string>();

/// Reads the date inside the file for the dropdowns of `paths`, in the
/// background. Called only when a dropdown is about to be used (hover,
/// focus): marking, the drop box and adding never wait for it, since that
/// date is never the automatic choice anyway.
export function ensureMediaDates(paths: string[]) {
  const fresh = paths.filter((p) => {
    const info = infos.get(p);
    return info !== undefined && info.media === undefined && canCarryMediaDate(info) && !mediaRequested.has(p);
  });
  if (fresh.length === 0) return;
  fresh.forEach((p) => mediaRequested.add(p));
  void (async () => {
    for (let i = 0; i < fresh.length; i += MEDIA_DATE_CHUNK) {
      const chunk = fresh.slice(i, i + MEDIA_DATE_CHUNK);
      try {
        const found = await readMediaDates(chunk);
        for (const p of chunk) {
          const info = infos.get(p);
          if (info) infos.set(p, { ...info, media: found.get(p) ?? null });
        }
        emit();
      } catch {
        chunk.forEach((p) => mediaRequested.delete(p));
      }
    }
  })();
}

export interface DateOption {
  source: DateSource;
  label: string;
  value: string;
}

export function optionsFor(info: FileDateInfo): DateOption[] {
  const all: [DateSource, string | null | undefined][] = [
    ["filename", info.filename],
    ["exif", info.exif],
    ["meta", info.media],
    ["fs_created", info.fs_created],
    ["fs_modified", info.fs_modified],
  ];
  return all
    // `!= null`: the date inside the file is `undefined` until it is read.
    .filter((entry): entry is [DateSource, string] => entry[1] != null)
    .map(([source, value]) => ({ source, value, label: `${formatDate(value)} (${timestampSourceLabel(source)})` }));
}

export function selectedSource(info: FileDateInfo): DateSource {
  return chosen.get(info.path) ?? info.auto_source;
}

/// The date entry the add flow should hand to `add_items_with_dates`, or
/// `null` for a path whose dates could not be read.
export function datedPathFor(path: string): DatedPath | null {
  const info = infos.get(path);
  if (!info) return null;
  const source = selectedSource(info);
  const option = optionsFor(info).find((o) => o.source === source);
  // A pick whose date is no longer known files under the automatic choice,
  // labelled as such rather than with the pick's name.
  if (!option && source !== info.auto_source) return { path, timestamp: info.auto_value, timestamp_source: info.auto_source };
  return { path, timestamp: option?.value ?? info.auto_value, timestamp_source: source };
}

export function forgetDateChoices(paths: string[]) {
  paths.forEach((p) => {
    infos.delete(p);
    chosen.delete(p);
    requested.delete(p);
    mediaRequested.delete(p);
  });
  emit();
}

/// Re-renders when anything in the store changes; returns the info for one path.
export function useDateInfo(path: string): FileDateInfo | undefined {
  useSyncExternalStore(subscribe, () => version);
  return infos.get(path);
}
