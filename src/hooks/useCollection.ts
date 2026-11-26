import { useCallback, useEffect, useState } from "react";

/// The file manager's collection list: every file marked for adding while
/// browsing, across folders, views (overview, single image, disk search) and
/// even app restarts. Stored per stream in localStorage — a pure
/// convenience list of source paths, so losing it (cleared site data) only
/// costs the user their marks.
export interface PathCollection {
  paths: Set<string>;
  has: (path: string) => boolean;
  add: (paths: string[]) => void;
  remove: (paths: string[]) => void;
  clear: () => void;
}

function storageKey(projectPath: string): string {
  return `cronostream.collection.${projectPath}`;
}

function load(projectPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectPath));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

export function useCollection(projectPath: string): PathCollection {
  const [paths, setPaths] = useState<Set<string>>(() => load(projectPath));

  useEffect(() => {
    try {
      if (paths.size === 0) localStorage.removeItem(storageKey(projectPath));
      else localStorage.setItem(storageKey(projectPath), JSON.stringify([...paths]));
    } catch {
      // not critical — the list just won't survive a restart
    }
  }, [paths, projectPath]);

  const add = useCallback((toAdd: string[]) => {
    setPaths((prev) => {
      const next = new Set(prev);
      toAdd.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const remove = useCallback((toRemove: string[]) => {
    setPaths((prev) => {
      const next = new Set(prev);
      toRemove.forEach((p) => next.delete(p));
      return next;
    });
  }, []);

  const clear = useCallback(() => setPaths(new Set()), []);
  const has = useCallback((path: string) => paths.has(path), [paths]);

  return { paths, has, add, remove, clear };
}

/// The same shape, held only in memory — for marks that must *not* outlive
/// the session.
///
/// Used by "Datei-Operationen" and "Papierkorb", whose marks select files
/// for removal and permanent deletion. The persisted list above is a
/// curated collection the user builds up over several sittings, and that is
/// exactly the wrong behaviour here: finding a pile of files still
/// pre-marked for deletion days later, with no memory of marking them, is
/// how a batch action gets confirmed by accident. Forgetting them on close
/// costs a few double-clicks and nothing else.
export function useTransientCollection(): PathCollection {
  const [paths, setPaths] = useState<Set<string>>(() => new Set());

  const add = useCallback((toAdd: string[]) => {
    setPaths((prev) => {
      const next = new Set(prev);
      toAdd.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const remove = useCallback((toRemove: string[]) => {
    setPaths((prev) => {
      const next = new Set(prev);
      toRemove.forEach((p) => next.delete(p));
      return next;
    });
  }, []);

  const clear = useCallback(() => setPaths(new Set()), []);
  const has = useCallback((path: string) => paths.has(path), [paths]);

  return { paths, has, add, remove, clear };
}
