import { useCallback, useEffect, useState } from "react";
import type { FileDateInfo } from "../types";

/// A set of files staged for review before they're added to the project.
///
/// Each source of picks gets its own independent instance (the single-image
/// view and the text-manifest import keep separate lists on purpose), which
/// is why this is a hook rather than one shared context — and why instances
/// live in the file browser itself, so a list survives switching tabs.
export interface PickedList {
  picked: Map<string, FileDateInfo>;
  has: (path: string) => boolean;
  toggle: (info: FileDateInfo) => void;
  addMany: (infos: FileDateInfo[]) => void;
  remove: (path: string) => void;
  clear: () => void;
  count: number;
}

/// With `storageKey`, the list is kept in localStorage and restored on the
/// next mount, so it survives closing the file manager and restarting the app.
export function usePickedList(storageKey?: string): PickedList {
  const [picked, setPicked] = useState<Map<string, FileDateInfo>>(() => {
    if (!storageKey) return new Map();
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(parsed)) return new Map();
      return new Map((parsed as FileDateInfo[]).filter((i) => i && typeof i.path === "string").map((i) => [i.path, i]));
    } catch {
      return new Map();
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      if (picked.size === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify([...picked.values()]));
    } catch {
      // not critical
    }
  }, [picked, storageKey]);

  const toggle = useCallback((info: FileDateInfo) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(info.path)) next.delete(info.path);
      else next.set(info.path, info);
      return next;
    });
  }, []);

  const addMany = useCallback((infos: FileDateInfo[]) => {
    setPicked((prev) => {
      const next = new Map(prev);
      infos.forEach((info) => next.set(info.path, info));
      return next;
    });
  }, []);

  const remove = useCallback((path: string) => {
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const clear = useCallback(() => setPicked(new Map()), []);

  const has = useCallback((path: string) => picked.has(path), [picked]);

  return { picked, has, toggle, addMany, remove, clear, count: picked.size };
}
