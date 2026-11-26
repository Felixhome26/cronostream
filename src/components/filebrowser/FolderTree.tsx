import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import type { DirEntryInfo, DirListing, QuickAccessEntry } from "../../types";

interface TreeNodeState {
  children: DirEntryInfo[] | null; // null = not loaded yet
  expanded: boolean;
  loading: boolean;
}

interface Props {
  currentPath: string | null;
  onNavigate: (path: string) => void;
}

const PLACE_ICON: Record<string, string> = {
  home: "🏠",
  desktop: "🖥️",
  pictures: "🖼️",
  documents: "📄",
  downloads: "📥",
  drive: "💾",
};

const PLACE_LABEL_KEY: Record<string, string> = {
  home: "browser.tree.home",
  desktop: "browser.tree.desktop",
  pictures: "browser.tree.pictures",
  documents: "browser.tree.documents",
  downloads: "browser.tree.downloads",
};

/// Builds the chain of ancestor folder paths from the filesystem root down
/// to (and including) `path`, purely by splitting the string — no backend
/// call needed, since every ancestor is just a textual prefix of `path`.
/// Handles both "/a/b/c" (Unix) and "C:\a\b\c" (Windows) styles.
function pathAncestors(path: string): string[] {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const isUnixAbsolute = sep === "/" && path.startsWith("/");
  const segments = path.split(sep).filter(Boolean);
  const chain: string[] = [];
  let acc = "";
  for (const segment of segments) {
    if (acc === "") {
      acc = isUnixAbsolute ? "/" + segment : segment + sep;
    } else {
      const withSep = acc.endsWith(sep) ? acc : acc + sep;
      acc = withSep + segment;
    }
    chain.push(acc);
  }
  if (isUnixAbsolute) chain.unshift("/");
  return chain;
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function normalize(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

export default function FolderTree({ currentPath, onNavigate }: Props) {
  const [nodes, setNodes] = useState<Map<string, TreeNodeState>>(new Map());
  const [quickAccess, setQuickAccess] = useState<QuickAccessEntry[]>([]);
  // Only set when `currentPath` isn't under any quick-access entry (e.g.
  // the user typed an arbitrary path directly into the path input) — a
  // fallback so navigation never leaves the tree without anywhere to show
  // where you currently are.
  const [extraRootPath, setExtraRootPath] = useState<string | null>(null);
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    invoke<QuickAccessEntry[]>("list_quick_access")
      .then(setQuickAccess)
      .catch(() => setQuickAccess([]));
  }, []);

  const loadChildren = useCallback((path: string) => {
    if (requested.current.has(path)) return;
    requested.current.add(path);
    setNodes((prev) => {
      const next = new Map(prev);
      next.set(path, { children: prev.get(path)?.children ?? null, expanded: true, loading: true });
      return next;
    });
    invoke<DirListing>("list_directory", { path })
      .then((listing) => {
        setNodes((prev) => {
          const next = new Map(prev);
          next.set(path, { children: listing.entries.filter((e) => e.is_dir), expanded: true, loading: false });
          return next;
        });
      })
      .catch(() => {
        requested.current.delete(path);
        setNodes((prev) => {
          const next = new Map(prev);
          const existing = prev.get(path);
          next.set(path, { children: existing?.children ?? [], expanded: true, loading: false });
          return next;
        });
      });
  }, []);

  const handleToggle = useCallback(
    (path: string) => {
      const node = nodes.get(path);
      if (node?.children) {
        setNodes((prev) => {
          const next = new Map(prev);
          next.set(path, { ...node, expanded: !node.expanded });
          return next;
        });
      } else {
        loadChildren(path);
      }
    },
    [nodes, loadChildren],
  );

  // Whenever the active folder changes (from the grid, the path input, or
  // this tree itself), make sure its whole ancestor chain is loaded and
  // expanded so the active folder is always visible — starting from
  // whichever quick-access entry it's actually under, not the filesystem
  // root, so the tree never needs to show OS-internal top-level folders.
  useEffect(() => {
    if (!currentPath || quickAccess.length === 0) return;
    const normalizedCurrent = normalize(currentPath);
    const matchingRoot = quickAccess
      .map((q) => normalize(q.path))
      .filter((root) => normalizedCurrent === root || normalizedCurrent.startsWith(root + "/") || normalizedCurrent.startsWith(root + "\\"))
      .sort((a, b) => b.length - a.length)[0];

    const ancestors = pathAncestors(currentPath);
    if (matchingRoot) {
      setExtraRootPath(null);
      ancestors.filter((a) => normalize(a).length >= matchingRoot.length).forEach(loadChildren);
    } else if (ancestors.length > 0) {
      setExtraRootPath(ancestors[0]);
      ancestors.forEach(loadChildren);
    }
  }, [currentPath, quickAccess, loadChildren]);

  function renderNode(path: string, name: string, depth: number, icon?: string) {
    const node = nodes.get(path);
    const isActive = path === currentPath;
    const expanded = node?.expanded ?? false;
    return (
      <div key={path} className="folder-tree__node">
        <div className={"folder-tree__row" + (isActive ? " folder-tree__row--active" : "")}>
          <button
            type="button"
            className="folder-tree__toggle"
            style={{ marginLeft: `${depth * 0.9}rem` }}
            onClick={() => handleToggle(path)}
            aria-label={expanded ? t("browser.tree.collapse") : t("browser.tree.expand")}
          >
            {node?.loading ? "…" : expanded ? "▾" : "▸"}
          </button>
          <span className="folder-tree__label" onClick={() => onNavigate(path)} title={path}>
            {icon && <span className="folder-tree__icon">{icon}</span>}
            {name}
          </span>
        </div>
        {expanded && node?.children && (
          <div className="folder-tree__children">
            {node.children.length === 0 ? (
              <div className="folder-tree__empty" style={{ marginLeft: `${(depth + 1) * 0.9}rem` }}>
                —
              </div>
            ) : (
              node.children.map((child) => renderNode(child.path, child.name, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  }

  const places = quickAccess.filter((q) => q.kind !== "drive");
  const drives = quickAccess.filter((q) => q.kind === "drive");
  const quickAccessPaths = new Set(quickAccess.map((q) => normalize(q.path)));
  const showExtraRoot = extraRootPath && !quickAccessPaths.has(normalize(extraRootPath));

  return (
    <div className="folder-tree">
      {places.length > 0 && (
        <div className="folder-tree__section">
          <div className="folder-tree__heading">{t("browser.tree.placesHeading")}</div>
          {places.map((q) => renderNode(q.path, q.label ?? t(PLACE_LABEL_KEY[q.kind] ?? q.kind), 0, PLACE_ICON[q.kind]))}
        </div>
      )}
      {drives.length > 0 && (
        <div className="folder-tree__section">
          <div className="folder-tree__heading">{t("browser.tree.drivesHeading")}</div>
          {drives.map((q) => renderNode(q.path, q.label ?? baseName(q.path), 0, PLACE_ICON.drive))}
        </div>
      )}
      {showExtraRoot && (
        <div className="folder-tree__section">{renderNode(extraRootPath, baseName(extraRootPath) || extraRootPath, 0)}</div>
      )}
    </div>
  );
}
