import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../busy";
import { Channel } from "@tauri-apps/api/core";
import { t } from "../i18n";
import {
  loadEntrySort,
  mergeSorted,
  saveEntrySort,
  SORT_FIELDS,
  sortEntries,
  type EntrySort,
  type SortField,
} from "../utils/sortEntries";
import type { DirEntryInfo, DirListing, ProjectSettings, SettingScope } from "../types";
import FolderTree from "./filebrowser/FolderTree";
import PathInput from "./filebrowser/PathInput";
import SingleImageView from "./filebrowser/SingleImageView";
import ManifestImportTab from "./filebrowser/ManifestImportTab";
import AiMetadataTab from "./filebrowser/AiMetadataTab";
import ProtocolTab from "./filebrowser/ProtocolTab";
import FileOpsTab from "./filebrowser/FileOpsTab";
import DuplicatesTab from "./filebrowser/DuplicatesTab";
import TrashTab from "./filebrowser/TrashTab";
import BackupTab from "./filebrowser/BackupTab";
import SettingsTab from "./filebrowser/SettingsTab";
import DiskSearchTab from "./filebrowser/DiskSearchTab";
import FileTileGrid from "./filebrowser/FileTileGrid";
import ToggleSwitch from "./filebrowser/ToggleSwitch";
import { usePickedList } from "../hooks/usePickedList";
import { useToast } from "../ToastContext";
import { useCollection } from "../hooks/useCollection";
import CollectionAddButton from "./filebrowser/CollectionAddButton";
import ArchiveTab from "./filebrowser/ArchiveTab";

export type BrowserTab =
  | "grid"
  | "single"
  | "manifest"
  | "search"
  | "ai_metadata"
  | "protocol"
  | "file_ops"
  | "duplicates"
  | "archive"
  | "trash"
  | "backup"
  | "settings";

/// The workflow phases the views fall into. They used to sit in one flat
/// row of equal tabs, which gave a view's purpose no weight at all —
/// picking a source folder, reviewing AI date guesses and undoing an import
/// are not peers. The rail carries the phase; the tab row inside it only
/// ever distinguishes alternative ways to do the *same* thing (three ways
/// to pick files).
///
/// There used to be a fourth phase, "export" (Druckexport + "in anderen
/// stream kopieren"). It's gone: copying to another stream was a
/// second, UI-duplicating way to do exactly what "Kopieren nach…" in
/// Datei-Operationen already does (same `transfer_items` call), and
/// Druckexport's own folder-copy is now that dropdown's "In Ordner
/// kopieren…" entry — see `FileOpsTab`. Shrinking to one reachable path
/// per action, not two.
export type BrowserCategory = "add" | "review" | "manage" | "settings";

// Onboarding, hint 2 of 3 (see the in-app-help guide) — same one-shot
// toast pattern as Timeline's zoom hint and SingleImageView's keys hint.
const COPY_PROTECTION_HINT_DISMISSED_KEY = "cronostream.onboarding.copyProtectionHintShown";
const COPY_PROTECTION_HINT_VERSION = "1";
let copyProtectionHintShownThisSession = false;

const CATEGORY_ORDER: BrowserCategory[] = ["add", "review", "manage", "settings"];

const CATEGORY_TABS: Record<BrowserCategory, BrowserTab[]> = {
  add: ["grid", "single", "search", "manifest"],
  review: ["ai_metadata"],
  manage: ["file_ops", "protocol", "duplicates", "archive", "trash", "backup"],
  settings: ["settings"],
};

/// Opened directly from the project topbar (review/manage) or the "+"
/// button (add) — each entry point lands on one named view of its
/// category.
///
/// "add" opens on the overview grid (`grid`), the leftmost tab. (It used to
/// open on `single` to avoid starting thumbnail work for a folder the user
/// may only be passing through; the overview is the preferred landing view.)
export const CATEGORY_DEFAULT_TAB: Record<BrowserCategory, BrowserTab> = {
  add: "grid",
  review: "ai_metadata",
  manage: "file_ops",
  settings: "settings",
};

const CATEGORY_ICON: Record<BrowserCategory, string> = {
  add: "+",
  review: "✨",
  // Maintenance, not undo: this category grew from "Protokoll" alone to
  // Protokoll + Datei-Operationen + Papierkorb + Sicherung. Mirrored by the
  // topbar button in `ProjectShell`.
  manage: "🛠",
  settings: "⚙",
};

const TAB_LABEL_KEY: Record<BrowserTab, string> = {
  single: "browser.tabs.single",
  grid: "browser.tabs.grid",
  manifest: "browser.tabs.manifest",
  search: "browser.tabs.search",
  ai_metadata: "browser.tabs.aiMetadata",
  protocol: "browser.tabs.protocol",
  file_ops: "browser.tabs.fileOps",
  duplicates: "browser.tabs.duplicates",
  archive: "browser.tabs.archive",
  trash: "browser.tabs.trash",
  backup: "browser.tabs.backup",
  settings: "browser.tabs.settings",
};

/// Shown next to the tab row (or, for a single-view category, next to the
/// view title) — one short sentence on what that tab is for, so a reiter's
/// purpose doesn't have to be guessed from its name alone.
const TAB_HINT_KEY: Record<BrowserTab, string> = {
  single: "browser.tabs.singleHint",
  grid: "browser.tabs.gridHint",
  manifest: "browser.tabs.manifestHint",
  search: "browser.tabs.searchHint",
  ai_metadata: "browser.tabs.aiMetadataHint",
  protocol: "browser.tabs.protocolHint",
  file_ops: "browser.tabs.fileOpsHint",
  duplicates: "browser.tabs.duplicatesHint",
  archive: "browser.tabs.archiveHint",
  trash: "browser.tabs.trashHint",
  backup: "browser.tabs.backupHint",
  settings: "browser.tabs.settingsHint",
};

const TAB_CATEGORY: Record<BrowserTab, BrowserCategory> = Object.fromEntries(
  CATEGORY_ORDER.flatMap((category) => CATEGORY_TABS[category].map((tab) => [tab, category])),
) as Record<BrowserTab, BrowserCategory>;

/// Only the "add" views browse the file system — the folder tree and path
/// field were previously rendered for every tab, including Protokoll, where
/// they navigate nothing.
///
/// Still a per-category decision, even though "Datei-Operationen" and
/// "Papierkorb" (both under `manage`) do have a sidebar: theirs is a year
/// rail over the project database, not this folder tree, and they render it
/// themselves so its state stays with the tab that owns it (see
/// `ProjectFilesView`). Making this a per-tab flag would therefore switch
/// on the *wrong* sidebar for them.
const CATEGORY_USES_SIDEBAR: Record<BrowserCategory, boolean> = {
  add: true,
  review: false,
  manage: false,
  settings: false,
};

interface FileBrowserProps {
  /// Identifies the stream the collection list belongs to, so each one
  /// keeps its own list.
  projectPath: string;
  /// Which tab to start on — defaults to "single" (see the comment on the
  /// `activeTab` state below). Set by `ProjectShell` when it opens the
  /// browser straight into "KI-Metadaten" from the drop box's review banner.
  initialTab?: BrowserTab;
  /// Forwarded to `AiMetadataTab` — see its own doc comment.
  restrictAiIds?: string[];
  /// Forwarded to `FileOpsTab`/`ProjectFilesView` — set by `ProjectShell`
  /// when it opens the browser straight into Datei-Operationen from the
  /// "Daten manuell überprüfen" checkbox after an insert.
  restrictManualReviewIds?: string[];
  /// Forwarded to `FileOpsTab`/`ProjectFilesView` — set by `ProjectShell`
  /// when a timeline Ctrl-click selection was handed off via the floating
  /// "Ändern"-button/context-menu entry. Narrows the view the same way
  /// `restrictManualReviewIds` does (see the `file_ops` render below, which
  /// feeds both into the same `restrictToIds`) and additionally pre-marks
  /// the ids once loaded.
  fileOpsAutoMarkIds?: string[];
  /// Whether the "mit KI überprüfen" box was *also* ticked for the same
  /// batch — if so, the manual-review view offers "Weiter zur KI-Prüfung"
  /// next to "Fertig" once the user is done, using the same ids.
  manualReviewAlsoWantsAi?: boolean;
  /// Closes the whole browser overlay. Lives here rather than in a bar of
  /// its own above the browser so the confirm action sits on the same row
  /// as the view it confirms, instead of costing a full-width strip that
  /// holds one button.
  onDone: () => void;
  /// Reports the active tab, so the shell can name the view the "back to
  /// browser" pill returns to.
  onTabChange?: (tab: BrowserTab) => void;
  /// Forwarded to `FileOpsTab`/`TrashTab` — called whenever a batch action
  /// or the date-change dialog actually changed project data, so the
  /// Timeline behind this overlay can re-fetch without waiting for the
  /// whole browser to close (see `ProjectFilesView`'s own doc comment).
  onDataChanged?: () => void;
  /// Forwarded to `BackupTab` — triggers the same manual full-project
  /// backup that used to live as a button in Settings. Owned by
  /// `ProjectShell` (not here) since the progress overlay it starts is
  /// rendered there, outside this component's own full-screen overlay.
  onBackup: (update: boolean) => void;
  backupBusy: boolean;
  settings: ProjectSettings;
  onSettingsChange: (patch: Partial<ProjectSettings>) => void;
  /// Moves one setting between project and app scope. Takes a list because
  /// a single dialog row can own several stored keys — see
  /// `updateSettingScope` in `ProjectShell`.
  onSettingScopeChange: (keys: string[], scope: SettingScope) => void;
}

export default function FileBrowser({
  projectPath,
  initialTab,
  restrictAiIds,
  restrictManualReviewIds,
  manualReviewAlsoWantsAi,
  fileOpsAutoMarkIds,
  onDone,
  onTabChange,
  onDataChanged,
  onBackup,
  backupBusy,
  settings,
  onSettingsChange,
  onSettingScopeChange,
}: FileBrowserProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [addedPaths, setAddedPaths] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // "Dateien in Unterordnern anzeigen" — flattens every file below the
  // current folder into the grid instead of just its direct children.
  // Lives here (not inside FileTileGrid) since it changes what gets
  // fetched from the backend, not just how an already-fetched list is
  // displayed — see `list_directory`'s `recursive` param.
  const [showSubfolders, setShowSubfolders] = useState(false);
  const [subfolderError, setSubfolderError] = useState<string | null>(null);
  const showToast = useToast();
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Which image the single-image view is on. A ref, not state, on purpose:
  // it updates on every page through the folder, and turning that into a
  // state change would fire effects on each one. It's only read once, on
  // the way back to the grid (see `gridFocusPath` below).
  const singleViewPath = useRef<string | null>(null);
  const [gridFocusPath, setGridFocusPath] = useState<string | null>(null);
  // Mirrors the grid's currently previewed entry, purely so switching to
  // the single-image view can start on the same image — see `FileTileGrid`'s
  // `onPreviewChange`.
  const [gridPreviewEntry, setGridPreviewEntry] = useState<DirEntryInfo | null>(null);

  // Opens into the overview grid by default.
  const [activeTab, setActiveTab] = useState<BrowserTab>(initialTab ?? "grid");
  const activeCategory = TAB_CATEGORY[activeTab];
  useEffect(() => {
    onTabChange?.(activeTab);
  }, [activeTab, onTabChange]);
  // Tab the user came from when handleManualReview jumped to file_ops, so
  // "Zurück" can return there (the grid stays mounted, keeping its scroll).
  // Stays null when file_ops was opened from elsewhere in the app.
  const [returnTab, setReturnTab] = useState<BrowserTab | null>(null);

  // Onboarding, hint 2 of 3: the first time this overlay is looked at from
  // the "Hinzufügen" side, reassure that importing copies rather than moves
  // — the single most common fear for anyone coming from a plain file
  // manager. Fires once per app session, same guard shape as Timeline's
  // zoom hint.
  const copyProtectionHintShown = useRef(false);
  useEffect(() => {
    if (activeCategory !== "add") return;
    if (copyProtectionHintShown.current || copyProtectionHintShownThisSession) return;
    copyProtectionHintShown.current = true;
    copyProtectionHintShownThisSession = true;
    if (localStorage.getItem(COPY_PROTECTION_HINT_DISMISSED_KEY) === COPY_PROTECTION_HINT_VERSION) return;
    showToast(t("browser.onboardingCopyProtectionHint"), {
      durationMs: 8000,
      action: {
        label: t("browser.dontShowAgain"),
        onClick: () => localStorage.setItem(COPY_PROTECTION_HINT_DISMISSED_KEY, COPY_PROTECTION_HINT_VERSION),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory]);
  // Collapsed by default: the topbar icons already jump straight to each
  // category, so the rail's job is just showing which one is active —
  // worth the width only when the user asks for the labels back.
  const [railCollapsed, setRailCollapsed] = useState(true);

  // Coming back from the single-image view: show and scroll to whichever
  // picture was on screen there, rather than dropping the user at the top
  // of the folder grid again.
  useEffect(() => {
    if (activeTab !== "grid") return;
    const path = singleViewPath.current;
    if (!path) return;
    singleViewPath.current = null;
    setGridFocusPath(path);
  }, [activeTab]);

  const tabsInCategory = CATEGORY_TABS[activeCategory];
  // Returning to a category lands on whichever of its views was last open,
  // not always its first — switching to Exportieren to check something and
  // back shouldn't silently drop you out of Transfer into Druckexport.
  const lastTabByCategory = useRef<Record<BrowserCategory, BrowserTab>>({ ...CATEGORY_DEFAULT_TAB });
  lastTabByCategory.current[activeCategory] = activeTab;
  const loadGeneration = useRef(0);
  // Task id of the streamed subfolder walk still running, if any — cancelled
  // whenever a newer load replaces it or the file manager closes.
  const runningListing = useRef<string | null>(null);
  // Identifies "this listing" for the grid: files streaming into the same
  // listing keep the grid's selection, a new listing resets it.
  const [listingKey, setListingKey] = useState("initial");
  // The listing is kept sorted in this order at all times (grid and
  // single-image view both read it), so streamed batches can be merged in
  // rather than re-sorting everything per batch. The ref lets `loadDir`'s
  // callbacks see the current choice without being recreated.
  const [entrySort, setEntrySort] = useState<EntrySort>(loadEntrySort);
  const entrySortRef = useRef(entrySort);
  entrySortRef.current = entrySort;

  function changeEntrySort(next: EntrySort) {
    setEntrySort(next);
    saveEntrySort(next);
    setListing((prev) => (prev ? { ...prev, entries: sortEntries(prev.entries, next) } : prev));
    // Keeps the selected tile in view — it is somewhere else now.
    if (gridPreviewEntry) setGridFocusPath(gridPreviewEntry.path);
  }

  // Kept here rather than inside the tab components so each list survives
  // switching tabs. Each pick source gets its own independent list — they're
  // reviewed and inserted separately, by design.
  const singleViewPicks = usePickedList(`cronostream.singleViewPicks.${projectPath}`);
  const collection = useCollection(projectPath);
  // Ids for the KI-Metadaten tab: those handed in by the shell, or the ones
  // just added from the collection when "check with AI" was ticked.
  const [aiIds, setAiIds] = useState<string[] | undefined>(restrictAiIds);
  // Same idea for Datei-Operationen ("Daten manuell überprüfen"). When both
  // checkboxes were ticked for the same batch, `pendingAiIds` holds the ids
  // the "Weiter zur KI-Prüfung" button (next to "Fertig") should hand off
  // to `aiIds` once the manual pass is done — `undefined` means that button
  // isn't offered at all, not just that it has nothing to do yet.
  const [manualReviewIds, setManualReviewIds] = useState<string[] | undefined>(restrictManualReviewIds);
  const [pendingAiIds, setPendingAiIds] = useState<string[] | undefined>(
    restrictManualReviewIds && manualReviewAlsoWantsAi ? restrictManualReviewIds : undefined,
  );
  const manifestPicks = usePickedList();

  /// Shared by `CollectionAddButton` (already-mounted case) and
  /// `ProjectShell`'s `checkManually` (not-yet-mounted case, via
  /// `restrictManualReviewIds`): manual review always takes priority over
  /// jumping straight to AI, per the "beide Checkboxen aktiviert" rule —
  /// the AI ids are only remembered for the follow-up button, not acted on
  /// yet.
  function handleManualReview(ids: string[], alsoCheckWithAi: boolean) {
    setManualReviewIds(ids);
    setPendingAiIds(alsoCheckWithAi ? ids : undefined);
    setReturnTab(activeTab === "file_ops" ? null : activeTab);
    setActiveTab("file_ops");
  }

  // Shared across every tab that can add/remove files (grid, the disk
  // search results, single-image, manifest import) — the same file shows
  // as "already in project" no matter which of them it was found through.
  function handleInserted(insertedPaths: string[], message: string) {
    setAddedPaths((prev) => {
      const next = new Set(prev);
      insertedPaths.forEach((p) => next.add(p));
      return next;
    });
    showToast(message);
  }
  function handleRemoved(removedPaths: string[], message: string) {
    setAddedPaths((prev) => {
      const next = new Set(prev);
      removedPaths.forEach((p) => next.delete(p));
      return next;
    });
    showToast(message);
  }

  // Used only by `SingleImageView`'s rotate buttons — it reads rotation
  // straight off `listing.entries`, unlike `FileTileGrid`'s own grid/search
  // usages, which apply their own display overrides instead of needing
  // `listing` updated underneath them.
  async function rotateListingEntry(path: string, delta: number) {
    try {
      const newRotation = await invoke<number>("rotate_path", { path, delta });
      setListing((prev) =>
        prev ? { ...prev, entries: prev.entries.map((e) => (e.path === path ? { ...e, rotation: newRotation } : e)) } : prev,
      );
    } catch {
      // not fatal — rotation just stays as it was
    }
  }

  const cancelRunningListing = useCallback(() => {
    const taskId = runningListing.current;
    if (!taskId) return;
    runningListing.current = null;
    void invoke("cancel_list_directory", { taskId }).catch(() => {});
  }, []);

  const loadDir = useCallback(async (path?: string, recursive?: boolean) => {
    const generation = ++loadGeneration.current;
    const isStale = () => loadGeneration.current !== generation;
    cancelRunningListing();
    setSubfolderError(null);
    const key = crypto.randomUUID();

    // "Dateien in Unterordnern anzeigen" on a known folder: streamed, so
    // the first files show up while the walk is still running and leaving
    // (or switching the toggle off) can stop it. Deliberately not `busy`,
    // which would disable exactly the toggle and "up" button that cancel it.
    if (recursive && path) {
      runningListing.current = key;
      const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      // Placeholder until the final listing brings the real one.
      const parent = sep > 0 ? path.slice(0, sep) : sep === 0 && path.length > 1 ? path.slice(0, 1) : null;
      setListingKey(key);
      setListing({ path, parent, entries: [] });
      invoke<string[]>("list_added_source_paths")
        .then((added) => {
          if (!isStale()) setAddedPaths(new Set(added));
        })
        .catch(() => {});
      const onBatch = new Channel<DirEntryInfo[]>();
      onBatch.onmessage = (batch) => {
        if (isStale()) return;
        setListing((prev) =>
          prev ? { ...prev, entries: mergeSorted(prev.entries, batch, entrySortRef.current) } : prev,
        );
      };
      try {
        const result = await invoke<DirListing>("list_directory_streamed", { taskId: key, path, onBatch });
        if (isStale()) return;
        // Complete; same key, so the grid keeps its selection.
        setListing({ ...result, entries: sortEntries(result.entries, entrySortRef.current) });
      } catch (err) {
        if (isStale()) return;
        // The walk's own safety cap (see `fsbrowse::list_dir_recursive`)
        // rejects a too-large subtree with a friendly message instead of a
        // hang — surface that instead of leaving the toggle silently stuck.
        setSubfolderError(String(err));
        setShowSubfolders(false);
      } finally {
        if (runningListing.current === key) runningListing.current = null;
      }
      return;
    }

    setBusy(true);
    try {
      const result = await invoke<DirListing>("list_directory", { path: path ?? null, recursive: recursive ?? false });
      if (isStale()) return;
      // Show the folder immediately — filenames are visible right away,
      // thumbnails fill in behind them (see `FileTileGrid`).
      setListingKey(key);
      setListing({ ...result, entries: sortEntries(result.entries, entrySortRef.current) });
      const added = await invoke<string[]>("list_added_source_paths");
      if (isStale()) return;
      setAddedPaths(new Set(added));
    } catch (err) {
      if (isStale()) return;
      if (recursive) {
        setSubfolderError(String(err));
        setShowSubfolders(false);
      }
    } finally {
      if (!isStale()) setBusy(false);
    }
  }, [cancelRunningListing]);

  // Closing the file manager stops a subfolder walk still in progress.
  useEffect(
    () => () => {
      ++loadGeneration.current;
      cancelRunningListing();
    },
    [cancelRunningListing],
  );

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  // "Enthaltenden Ordner öffnen": always the system's default file manager,
  // with the file selected there where the platform supports it.
  async function revealInFolder(path: string) {
    try {
      await invoke("reveal_in_folder", { path });
    } catch {
      showToast(t("browser.openExternallyFailed"));
    }
  }

  function toggleShowSubfolders(next: boolean) {
    setShowSubfolders(next);
    loadDir(listing?.path, next);
  }

  return (
    <div className="file-browser">
      <nav
        className={"file-browser__rail" + (railCollapsed ? " file-browser__rail--collapsed" : "")}
        aria-label={t("browser.categories.add")}
      >
        <button
          className="file-browser__rail-toggle"
          onClick={() => setRailCollapsed((v) => !v)}
          title={t(railCollapsed ? "browser.rail.expand" : "browser.rail.collapse")}
          aria-label={t(railCollapsed ? "browser.rail.expand" : "browser.rail.collapse")}
        >
          {railCollapsed ? "»" : "«"}
        </button>
        {CATEGORY_ORDER.map((category) => (
          <button
            key={category}
            className={
              "file-browser__rail-item" + (activeCategory === category ? " file-browser__rail-item--active" : "")
            }
            onClick={() => {
              setReturnTab(null);
              setActiveTab(lastTabByCategory.current[category]);
            }}
            title={t(`browser.categories.${category}Hint`)}
            aria-current={activeCategory === category ? "page" : undefined}
          >
            <span
              className={"file-browser__rail-icon" + (category === "add" ? " file-browser__rail-icon--add" : "")}
              aria-hidden="true"
            >
              {CATEGORY_ICON[category]}
            </span>
            {!railCollapsed && (
              <span className="file-browser__rail-label">{t(`browser.categories.${category}`)}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="file-browser__workspace">
        <div className="file-browser__view-header">
          <div className="file-browser__view-header-left">
            {tabsInCategory.length > 1 ? (
              <div className="file-browser__tabs">
                {tabsInCategory.map((tab) => (
                  <button
                    key={tab}
                    className={"file-browser__tab" + (activeTab === tab ? " file-browser__tab--active" : "")}
                    onClick={() => {
                      setReturnTab(null);
                      setActiveTab(tab);
                    }}
                  >
                    {t(TAB_LABEL_KEY[tab])}
                  </button>
                ))}
              </div>
            ) : (
              // A category with a single view has nothing to switch between —
              // a one-item tab row would be a control that does nothing, so it
              // states where you are instead.
              <h2 className="file-browser__view-title">{t(TAB_LABEL_KEY[activeTab])}</h2>
            )}
            {(activeTab === "grid" || activeTab === "single") && (
              <div className="file-browser__sort">
                <select
                  className="file-browser__sort-select"
                  value={entrySort.field}
                  onChange={(ev) => changeEntrySort({ ...entrySort, field: ev.target.value as SortField })}
                  aria-label={t("browser.sort.label")}
                  title={t("browser.sort.hint")}
                >
                  {SORT_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {t("browser.sort.label")}: {t(`browser.sort.${field}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn file-browser__sort-direction"
                  onClick={() =>
                    changeEntrySort({ ...entrySort, direction: entrySort.direction === "asc" ? "desc" : "asc" })
                  }
                  title={t(entrySort.direction === "asc" ? "browser.sort.ascending" : "browser.sort.descending")}
                  aria-label={t(entrySort.direction === "asc" ? "browser.sort.ascending" : "browser.sort.descending")}
                >
                  {entrySort.direction === "asc" ? "↑" : "↓"}
                </button>
              </div>
            )}
            <span className="file-browser__tab-hint">{t(TAB_HINT_KEY[activeTab])}</span>
          </div>
          {activeTab === "file_ops" && pendingAiIds && (
            <button
              className="btn"
              onClick={() => {
                setAiIds(pendingAiIds);
                setPendingAiIds(undefined);
                setReturnTab(null);
                setActiveTab("ai_metadata");
              }}
            >
              {t("fileOps.continueToAi")}
            </button>
          )}
          {activeTab === "file_ops" && returnTab && (
            <button
              className="btn"
              onClick={() => {
                setActiveTab(returnTab);
                setReturnTab(null);
              }}
            >
              {t("project.back")}
            </button>
          )}
          <button className="btn btn--primary" onClick={onDone}>
            ✓ {t("project.done")}
          </button>
        </div>

        <div className="file-browser__body">
          {CATEGORY_USES_SIDEBAR[activeCategory] && (
            <div className="file-browser__sidebar">
              <PathInput onNavigate={(path) => loadDir(path, showSubfolders)} />
              <FolderTree currentPath={listing?.path ?? null} onNavigate={(path) => loadDir(path, showSubfolders)} />
            </div>
          )}

          <div className="file-browser__main">
            {activeTab === "single" && (
              <SingleImageView
                onRevealInFolder={revealInFolder}
                listing={listing}
                picks={singleViewPicks}
                addedPaths={addedPaths}
                initialPath={gridPreviewEntry?.kind === "image" ? gridPreviewEntry.path : null}
                onCurrentChange={(path) => {
                  singleViewPath.current = path;
                }}
                onRotate={rotateListingEntry}
                onInserted={handleInserted}
                onDuplicatesFound={(ids) => handleManualReview(ids, false)}
              />
            )}
            {activeTab === "manifest" && (
              <ManifestImportTab
                picks={manifestPicks}
                onInserted={handleInserted}
                onDuplicatesFound={(ids) => handleManualReview(ids, false)}
              />
            )}
            {activeTab === "search" && (
              <DiskSearchTab
                collection={collection}
                onRevealInFolder={revealInFolder}
                onNavigate={(path) => loadDir(path, showSubfolders)}
                currentPath={listing?.path ?? null}
                addedPaths={addedPaths}
                onRemoved={handleRemoved}
                deleteFilesOnRemove={settings.deleteFilesOnRemove}
              />
            )}
            {activeTab === "ai_metadata" && (
              <AiMetadataTab
                restrictToIds={aiIds}
                onClose={() => {
                  setAiIds(undefined);
                  // Closes the whole browser overlay back to the timeline —
                  // finishing a KI-Korrektur round is a natural exit point
                  // from the file manager altogether, not just a reason to
                  // switch tabs within it.
                  onDone();
                }}
              />
            )}
            {activeTab === "protocol" && <ProtocolTab onUndone={onDataChanged} />}
            {activeTab === "file_ops" && (
              // The timeline handoff (fileOpsAutoMarkIds) narrows the list
              // to exactly the handed-over files, same as the "Daten
              // manuell überprüfen" ids already do — the two never both
              // apply at once, each comes from its own entry point.
              <FileOpsTab
                restrictToIds={manualReviewIds ?? fileOpsAutoMarkIds}
                autoMarkIds={fileOpsAutoMarkIds}
                onSendToAi={(ids) => {
                  setAiIds(ids);
                  setActiveTab("ai_metadata");
                }}
                onDataChanged={onDataChanged}
                deleteFilesOnRemove={settings.deleteFilesOnRemove}
              />
            )}
            {activeTab === "duplicates" && <DuplicatesTab onDuplicatesFound={(ids) => handleManualReview(ids, false)} />}
            {activeTab === "archive" && <ArchiveTab onDataChanged={onDataChanged} />}
            {activeTab === "trash" && <TrashTab onDataChanged={onDataChanged} />}
            {activeTab === "backup" && <BackupTab onBackup={onBackup} backupBusy={backupBusy} />}
            {activeTab === "settings" && (
              <SettingsTab
                settings={settings}
                onChange={onSettingsChange}
                onScopeChange={onSettingScopeChange}
                onGoToDuplicates={() => setActiveTab("duplicates")}
              />
            )}

            {/* The grid stays mounted (just hidden) across tab switches,
                not conditionally rendered like the tabs above — its
                selection, scroll position and thumbnail cache are meant to
                survive flipping to another tab and back. See
                `FileTileGrid`'s `active` prop. */}
            <div
              className="file-browser__grid-wrapper"
              style={{ display: activeTab === "grid" ? "contents" : "none" }}
              ref={contentRef}
            >
              <FileTileGrid
                collection={collection}
                onRevealInFolder={revealInFolder}
                entries={listing?.entries ?? []}
                entriesKey={listingKey}
                addedPaths={addedPaths}
                picks={singleViewPicks}
                onRemoved={handleRemoved}
                deleteFilesOnRemove={settings.deleteFilesOnRemove}
                emptyMessage={t("browser.empty")}
                active={activeTab === "grid"}
                focusPath={gridFocusPath}
                onFocusConsumed={() => setGridFocusPath(null)}
                onPreviewChange={setGridPreviewEntry}
                onNavigateFolder={(path) => loadDir(path, showSubfolders)}
                showAlreadyInProjectToggle
                showKindFilter
                toolbarLeft={
                  <>
                    <button
                      className="btn--text"
                      onClick={() => listing?.parent && loadDir(listing.parent, showSubfolders)}
                      disabled={!listing?.parent || busy}
                    >
                      {t("browser.up")}
                    </button>
                    <div className="file-browser__path" title={listing?.path}>
                      {listing?.path}
                    </div>
                    <label className="file-browser__subfolders-toggle" title={t("browser.showSubfoldersHint")}>
                      <ToggleSwitch checked={showSubfolders} onChange={toggleShowSubfolders} disabled={busy} />
                      {t("browser.showSubfoldersLabel")}
                    </label>
                    {subfolderError && <span className="file-browser__subfolders-error">{subfolderError}</span>}
                  </>
                }
              />
            </div>
          </div>
        </div>
      </div>

      {activeCategory === "add" && (
        <CollectionAddButton
          collection={collection}
          picks={singleViewPicks}
          addedPaths={addedPaths}
          onInserted={handleInserted}
          onCheckWithAi={(ids) => {
            setAiIds(ids);
            setActiveTab("ai_metadata");
          }}
          onManualReview={handleManualReview}
        />
      )}
    </div>
  );
}
