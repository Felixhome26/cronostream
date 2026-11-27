import { useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "../busy";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t, tn } from "../i18n";
import { SETTING_KEYS, type AddItemsResult, type DatedPath, type ProjectInfo, type ProjectSettings, type SettingScope } from "../types";
import { setEarliestDateYear } from "../utils/datetime";
import { DEFAULT_LANE_STACK } from "../utils/fileKindLane";
import CopyProgress from "./CopyProgress";
import DiaryDialog, { type DiaryRequest, type FileViewRequest } from "./DiaryDialog";
import { formatBytes } from "./DeleteStreamDialog";
import FileBrowser, { CATEGORY_DEFAULT_TAB, type BrowserCategory, type BrowserTab } from "./FileBrowser";
import HelpCenter from "./HelpCenter";
import SupportLink from "./SupportLink";
import { MiniViewer, ReturnPill, captureTimelineSnapshot, type TimelineSnapshot } from "./PeekViewer";
import PendingDrops from "./PendingDrops";
import RecordMedia, { type RecordMode } from "./RecordMedia";
import Timeline, { type CategoryCounts } from "./Timeline";
import { useToast } from "../ToastContext";
import { useConfirm } from "../ConfirmContext";
import { usePhaseGroups } from "../hooks/usePhaseGroups";
import { PrivacyContext, usePrivacyMode } from "../hooks/usePrivacyMode";
import PrivacyPrompt, { PrivacyIndicator } from "./PrivacyPrompt";
import phasesIcon from "../assets/icon_phasen.png";
import LifePhasesDialog from "./LifePhasesDialog";
import { ErrorBoundary } from "../ErrorBoundary";

const DEFAULT_SETTINGS: ProjectSettings = {
  tileDragEnabled: false,
  defaultVideoFramePercent: 10,
  deleteFilesOnRemove: false,
  showTimestampOverlay: true,
  viewerNavMode: "all",
  viewerNavTypes: ["image", "video", "audio", "document"],
  // A stack opens only on a click, and fans out in place. Must match the
  // backend's defaults in project_settings.rs. See `PileAction` in types.ts.
  pileAction: "fan",
  pileTrigger: "click",
  hoverZoomBrake: "click_only",
  fanCursorFollow: false,
  // Both grids on: the five zoom levels the timeline has always had.
  showWeekGrid: true,
  showHourGrid: true,
  wheelViewer: true,
  quickHashOnIngest: true,
  quickHashUsePrefilter: true,
  earliestDateYear: 1900,
  // Same top-to-bottom order the timeline's lanes have always had, so an
  // unconfigured stream looks exactly as before.
  laneOrder: DEFAULT_LANE_STACK,
  peekTabs: ["file_ops"],
  scopes: {},
};

/// Turns a settings patch into the backend writes it implies: each field's
/// stored key and the string encoding the Rust side expects.
///
/// A table rather than a chain of ifs, so adding a setting is one line and
/// none can be silently left out of the save path. Note the `undefined`
/// test: `false`, `0` and `""` are all real values here — an empty
/// `viewerNavTypes` means "no category steps through", which the backend
/// stores deliberately rather than treating as unset.
function settingWrites(patch: Partial<ProjectSettings>): { key: string; value: string }[] {
  const writes: { key: string; value: string }[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value !== undefined) writes.push({ key, value });
  };
  add(SETTING_KEYS.tileDrag, patch.tileDragEnabled?.toString());
  add(SETTING_KEYS.timestampOverlay, patch.showTimestampOverlay?.toString());
  add(SETTING_KEYS.viewerNavMode, patch.viewerNavMode);
  add(SETTING_KEYS.viewerNavTypes, patch.viewerNavTypes?.join(","));
  add(SETTING_KEYS.pileAction, patch.pileAction);
  add(SETTING_KEYS.pileTrigger, patch.pileTrigger);
  add(SETTING_KEYS.hoverZoomBrake, patch.hoverZoomBrake);
  add(SETTING_KEYS.fanCursorFollow, patch.fanCursorFollow?.toString());
  add(SETTING_KEYS.showWeekGrid, patch.showWeekGrid?.toString());
  add(SETTING_KEYS.showHourGrid, patch.showHourGrid?.toString());
  add(SETTING_KEYS.wheelViewer, patch.wheelViewer?.toString());
  add(SETTING_KEYS.quickHashOnIngest, patch.quickHashOnIngest?.toString());
  add(SETTING_KEYS.quickHashUsePrefilter, patch.quickHashUsePrefilter?.toString());
  add(SETTING_KEYS.earliestDateYear, patch.earliestDateYear?.toString());
  add(SETTING_KEYS.deleteOnRemove, patch.deleteFilesOnRemove?.toString());
  add(SETTING_KEYS.videoFramePercent, patch.defaultVideoFramePercent?.toString());
  add(SETTING_KEYS.laneOrder, patch.laneOrder?.join(","));
  add(SETTING_KEYS.peekTabs, patch.peekTabs?.join(","));
  return writes;
}

/// Builds the header's subtle status line: file counts by category,
/// skipping any category that's empty, followed by the project's total
/// disk usage in parentheses. Returns "" while nothing has loaded yet.
function formatStatsLine(counts: CategoryCounts, diskUsage: number | null): string {
  const parts: string[] = [];
  if (counts.image > 0) parts.push(tn(counts.image, "project.statsImages"));
  if (counts.video > 0) parts.push(tn(counts.video, "project.statsVideos"));
  if (counts.audio > 0) parts.push(tn(counts.audio, "project.statsAudios"));
  if (counts.document > 0) parts.push(tn(counts.document, "project.statsDocuments"));
  if (counts.other > 0) parts.push(tn(counts.other, "project.statsOther"));
  let line = parts.join(" · ");
  // An empty stream showed nothing but "(152 KB)" — the size of its own
  // database, with nothing saying what it belongs to.
  if (diskUsage != null) line = `${line || t("project.statsEmpty")} (${formatBytes(diskUsage)})`;
  return line;
}

interface ProjectShellProps {
  project: ProjectInfo;
  onBackToStart: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /// Mounts with the browser overlay already open on this view — App uses
  /// it after a language switch remounts the shell, so the person stays in
  /// the settings they switched from instead of landing on the timeline.
  initialBrowserTab?: BrowserTab;
}

const PEEK_TAB_LABEL_KEY: Record<BrowserTab, string> = {
  grid: "browser.tabs.grid",
  single: "browser.tabs.single",
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

/// Hides the centred status line wherever it would run into the name or the
/// icons, measured rather than tied to a window width: how wide those are
/// depends on the system's font and scaling, and the old fixed breakpoint
/// let the line slide under the buttons on Windows. `visibility` rather than
/// `display`, so the line keeps a box to measure once there is room again.
function useStatsLineFit(topbarRef: RefObject<HTMLDivElement | null>, hasStats: boolean) {
  useEffect(() => {
    const bar = topbarRef.current;
    const stats = bar?.querySelector<HTMLElement>(".project-shell__stats");
    if (!bar || !stats) return;
    const neighbours = Array.from(
      bar.querySelectorAll<HTMLElement>(".project-shell__topbar-leading > *, .project-shell__topbar-trailing > *"),
    );
    const MIN_GAP = 16;
    const check = () => {
      const box = stats.getBoundingClientRect();
      const collides = neighbours.some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left < box.right + MIN_GAP && r.right > box.left - MIN_GAP;
      });
      stats.classList.toggle("project-shell__stats--hidden", collides);
    };
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    observer.observe(stats);
    neighbours.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [topbarRef, hasStats]);
}

export default function ProjectShell({
  project,
  onBackToStart,
  isFullscreen,
  onToggleFullscreen,
  initialBrowserTab,
}: ProjectShellProps) {
  const [showBrowser, setShowBrowser] = useState(initialBrowserTab != null);
  // "Peek": the browser overlay stays mounted (keeping its tab, scroll and
  // marks) but is made invisible so the live timeline can be consulted; the
  // mini viewer and the return pill are the two ways across. Dismissing the
  // oval only lasts until the browser is presented again.
  const [browserHidden, setBrowserHidden] = useState(false);
  const [peekDismissed, setPeekDismissed] = useState(false);
  const [peekSnapshot, setPeekSnapshot] = useState<TimelineSnapshot | null>(null);
  // Starts on the requested tab (not "grid") so the first render already
  // knows whether this view shows the preview.
  const [peekTab, setPeekTab] = useState<BrowserTab>(initialBrowserTab ?? "grid");
  // Bumped on every fresh request so an already-mounted (peeking) browser
  // is rebuilt on the requested tab instead of ignoring `initialTab`.
  const [browserKey, setBrowserKey] = useState(0);
  // Set when the drop box's "review with AI" banner is what opened the
  // browser, so it lands straight on the KI-Metadaten tab with the just-
  // imported batch preselected instead of the usual default tab.
  const [browserRequest, setBrowserRequest] = useState<{
    tab: BrowserTab;
    ids?: string[];
    alsoCheckWithAi?: boolean;
    /// Datei-Operationen only: narrows the list to exactly these ids (same
    /// as `ids`/`restrictManualReviewIds`) AND pre-marks them once loaded
    /// — see `sendSelectionToFileOps`.
    markOnlyIds?: string[];
  } | null>(initialBrowserTab ? { tab: initialBrowserTab } : null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupUpdating, setBackupUpdating] = useState(false);
  const [backupTaskId, setBackupTaskId] = useState<string | null>(null);
  const [backupStarting, setBackupStarting] = useState(false);
  const showToast = useToast();
  const confirm = useConfirm();
  // Which recording overlay is open, if any — the mode doubles as the
  // "is it open" flag, since the two buttons are mutually exclusive.
  const [recordMode, setRecordMode] = useState<RecordMode | null>(null);
  const [diaryRequest, setDiaryRequest] = useState<DiaryRequest | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [fileViewRequest, setFileViewRequest] = useState<FileViewRequest | null>(null);
  // The diary entry whose attachments are being shown: hidden while the
  // viewer/cluster is up, reopened once that view is gone again.
  const [suspendedDiary, setSuspendedDiary] = useState<DiaryRequest | null>(null);
  const [imageChoice, setImageChoice] = useState<DiaryRequest | null>(null);
  // Mirrors Timeline's live per-category item counts — see Timeline's
  // onCategoryCountsChange for why this isn't a separate fetch of its own.
  // Feeds the header's status line.
  const [categoryCounts, setCategoryCounts] = useState<CategoryCounts | null>(null);
  const itemCount =
    categoryCounts == null
      ? null
      : categoryCounts.image + categoryCounts.video + categoryCounts.audio + categoryCounts.document + categoryCounts.other;
  // Disk usage has no in-memory equivalent to piggyback on (it includes
  // thumbnails and the database, not just what `items` knows about), so
  // it's its own fetch — re-run whenever the item count changes, which
  // covers every add/remove/undo without needing its own extra trigger.
  const [diskUsage, setDiskUsage] = useState<number | null>(null);
  useEffect(() => {
    if (itemCount == null) return;
    // Walks the whole project folder — debounced so a burst of count
    // changes (an import, a bulk remove) triggers one walk, not one each.
    const timer = window.setTimeout(() => {
      invoke<number>("project_disk_usage")
        .then(setDiskUsage)
        .catch(() => setDiskUsage(null));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [itemCount]);
  // Only whether the search bar is showing lives here, next to the button
  // that toggles it — the search itself (query, hits, jumping to one) is
  // Timeline's, which is where the items and the scroll internals are.
  const [showSearch, setShowSearch] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPhases, setShowPhases] = useState(false);
  // Reloaded with the timeline's own refresh, so an undo from the Protokoll
  // shows up here too. The timeline will read the visible phases from it.
  const { groups: phaseGroups, setGroups: setPhaseGroups, reload: reloadPhaseGroups } = usePhaseGroups(refreshToken);
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [privacyHideToken, setPrivacyHideToken] = useState(0);

  /// What is hidden just changed, so everything that listed files is out of
  /// date. The browser overlay is rebuilt on its current view rather than
  /// asked to refetch, because marks and selections in it may name files that
  /// are gone now. Things open on top of the lists only close if hiding took
  /// their file with it, so an unsaved new diary entry survives the keypress.
  function handlePrivacyVisibilityChanged(hiding: boolean) {
    setRefreshToken((n) => n + 1);
    if (showBrowser) {
      setBrowserRequest({ tab: peekTab });
      setBrowserKey((k) => k + 1);
    }
    if (!hiding) return;
    setPrivacyHideToken((n) => n + 1);
    setShowSearch(false);
    setPeekSnapshot(null);
    setOpenItemId(null);
    setFileViewRequest(null);
    const openEntry = diaryRequest?.entry ?? suspendedDiary?.entry;
    if (openEntry) {
      invoke<boolean>("privacy_is_hidden", { id: openEntry.id })
        .then((hidden) => {
          if (!hidden) return;
          setDiaryRequest(null);
          setSuspendedDiary(null);
        })
        .catch(() => {});
    }
  }

  const privacy = usePrivacyMode(handlePrivacyVisibilityChanged, () => setRefreshToken((n) => n + 1));

  // Loaded once per opened project (ProjectShell is unmounted/remounted
  // when the user goes back to the start screen and opens another one —
  // see App.tsx — so there is no stale-project case to guard against here).
  useEffect(() => {
    invoke<ProjectSettings>("get_project_settings")
      .then(setSettings)
      .catch(() => {
        // Keep the defaults — a brand-new project has no settings rows yet,
        // and the backend's own fallback already matches DEFAULT_SETTINGS.
      });
  }, []);

  // The date inputs live all over the app and take no props for this, so
  // the lower bound is published through a module-level value.
  useEffect(() => {
    setEarliestDateYear(settings.earliestDateYear);
  }, [settings.earliestDateYear]);

  // Writes each changed field through `set_project_setting` (logged,
  // undoable from the Protokoll tab) before reflecting it locally, so a
  // failed write never leaves the UI showing a value that isn't actually
  // saved.
  async function updateSettings(patch: Partial<ProjectSettings>) {
    try {
      for (const { key, value } of settingWrites(patch)) {
        await invoke("set_project_setting", { key, value });
      }
      setSettings((prev) => ({ ...prev, ...patch }));
    } catch (e) {
      showToast(typeof e === "string" ? e : t("settings.saveError"));
    }
  }

  /// Moves one setting between "nur dieser Stream" and "alle auf diesem
  /// Rechner". Takes a list because one row in the dialog can own more than
  /// one stored key — the detail-view navigation is a mode plus a type list,
  /// and splitting their scopes would let the mode come from the machine
  /// while the ticked types came from the project.
  ///
  /// No refetch afterwards: the backend guarantees the value in force does
  /// not change (see `set_setting_scope`), so only the scope map moves.
  async function updateSettingScope(keys: string[], scope: SettingScope) {
    try {
      for (const key of keys) {
        await invoke("set_setting_scope", { key, scope });
      }
      setSettings((prev) => ({
        ...prev,
        scopes: { ...prev.scopes, ...Object.fromEntries(keys.map((k) => [k, scope])) },
      }));
    } catch (e) {
      showToast(typeof e === "string" ? e : t("settings.saveError"));
    }
  }

  // Ctrl+F opens the search, the way it does everywhere else. Deliberately
  // NOT paired with Escape to close: Escape already leaves fullscreen
  // app-wide (see useFullscreen), and one key doing two unrelated things at
  // once is worse than closing the bar with its own ✕.
  useEffect(() => {
    function handleKeyDown(ev: KeyboardEvent) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
        ev.preventDefault();
        setShowSearch(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function handleBack() {
    try {
      await invoke("close_current_project");
    } catch {
      // not fatal — go back to start regardless
    }
    onBackToStart();
  }

  /// Single entry for opening the browser overlay: freezes the timeline for
  /// the mini viewer first, while its DOM is still in the state the user
  /// is leaving.
  function presentBrowser(tab?: BrowserTab) {
    if (tab) setPeekTab(tab);
    setPeekSnapshot(captureTimelineSnapshot());
    setBrowserKey((k) => k + 1);
    setBrowserHidden(false);
    setPeekDismissed(false);
    setShowBrowser(true);
  }

  function peekAtTimeline() {
    document.querySelectorAll<HTMLMediaElement>(".browser-overlay video, .browser-overlay audio").forEach((m) => m.pause());
    setBrowserHidden(true);
  }

  function returnToBrowser() {
    setPeekSnapshot(captureTimelineSnapshot());
    setBrowserHidden(false);
  }

  useEffect(() => {
    document.body.classList.toggle("browser-peek", browserHidden);
    return () => document.body.classList.remove("browser-peek");
  }, [browserHidden]);

  // The oval only appears on the views the person picked in the settings.
  // The return pill needs no check of its own: it exists only after the oval
  // was clicked, and the oval is what leads there.
  const peekEnabledHere = settings.peekTabs.includes(peekTab);

  function closeBrowser() {
    setShowBrowser(false);
    setBrowserHidden(false);
    setPeekSnapshot(null);
    setBrowserRequest(null);
    setRefreshToken((n) => n + 1);
  }

  function checkWithAi(ids: string[]) {
    setBrowserRequest({ tab: "ai_metadata", ids });
    presentBrowser("ai_metadata");
  }

  /// Same idea as `checkWithAi`, for "Daten manuell überprüfen /
  /// korrigieren": opens straight into Datei-Operationen, restricted to
  /// the batch just imported. `alsoCheckWithAi` (both boxes ticked) is
  /// forwarded so `FileBrowser` can offer "Weiter zur KI-Prüfung" once the
  /// manual pass is done.
  function checkManually(ids: string[], alsoCheckWithAi: boolean) {
    setBrowserRequest({ tab: "file_ops", ids, alsoCheckWithAi });
    presentBrowser("file_ops");
  }

  /// The timeline's Ctrl-click selection, handed off via its floating
  /// "Ändern"-button or context-menu entry: opens straight into
  /// Datei-Operationen, narrowed to and pre-marked with exactly these ids
  /// — the same two things `checkManually` does, just both driven by one
  /// id list instead of `ids`/`alsoCheckWithAi`.
  function sendSelectionToFileOps(ids: string[]) {
    setBrowserRequest({ tab: "file_ops", markOnlyIds: ids });
    presentBrowser("file_ops");
  }

  /// Opens the browser overlay directly on one view — used both for the
  /// per-category entry points below and for the dedicated Backup icon,
  /// which needs "manage"'s second view, not its default.
  function openBrowserAtTab(tab: BrowserTab) {
    setBrowserRequest({ tab });
    presentBrowser(tab);
  }

  /// Opens the browser overlay on a given workflow phase. Each phase has
  /// its own entry point rather than all four hiding behind the "+" button
  /// — see `BrowserCategory` in FileBrowser.
  function openBrowserAt(category: BrowserCategory) {
    openBrowserAtTab(CATEGORY_DEFAULT_TAB[category]);
  }

  /// `update`: bring an existing backup up to date (its folder is picked)
  /// instead of writing a new full copy into a picked parent folder.
  async function handleBackup(update = false) {
    const destination = await openDialog({
      directory: true,
      multiple: false,
      title: t(update ? "project.backupUpdateChoose" : "project.backupChooseLocation"),
    });
    if (!destination || Array.isArray(destination)) return;
    if (update) {
      // The folder's database is replaced (kept beside it, no file deleted).
      // A folder that went on by itself or belongs to another stream by
      // name — typically a duplicate — is asked about before that happens.
      let check: { backupName: string; currentName: string; otherName: boolean; ownChanges: boolean };
      try {
        check = await invoke("check_backup_update", { backupPath: destination });
      } catch (e) {
        showToast(typeof e === "string" ? e : t("project.backupError"));
        return;
      }
      if (check.otherName || check.ownChanges) {
        const reasons = [
          check.otherName &&
            t("project.backupUpdateOtherName").replace("{name}", check.backupName).replace("{current}", check.currentName),
          check.ownChanges && t("project.backupUpdateOwnChanges").replace("{name}", check.backupName),
        ].filter(Boolean);
        const confirmed = await confirm({
          title: t("project.backupUpdateConcernTitle"),
          body: `${reasons.join(" ")} ${t("project.backupUpdateConcernBody")}`,
          confirmLabel: t("project.backupUpdateConfirm"),
        });
        if (!confirmed) return;
      }
    }
    setBackupUpdating(update);
    setBackupBusy(true);
    // Show the progress overlay (taskId still null) before the command even
    // resolves — the backend's copy thread can start emitting progress (and
    // can fail) within milliseconds, faster than `invoke` returns a task id.
    // CopyProgress attaches its event listener on mount regardless of
    // taskId, so nothing emitted in that window is lost.
    setBackupStarting(true);
    // Backup is now triggered from inside the "Verwalten" view of the
    // file-browser overlay (z-index 55) — close it so the CopyProgress
    // modal (z-index 50) isn't hidden behind it.
    closeBrowser();
    try {
      const taskId = update
        ? await invoke<string>("start_backup_update", { backupPath: destination })
        : await invoke<string>("start_backup", { destinationParent: destination });
      setBackupTaskId(taskId);
    } catch (e) {
      setBackupStarting(false);
      showToast(typeof e === "string" ? e : t("project.backupError"));
      setBackupBusy(false);
    }
  }

  function handleBackupDone() {
    setBackupStarting(false);
    setBackupTaskId(null);
    setBackupBusy(false);
    showToast(t(backupUpdating ? "project.backupUpdated" : "project.backupSuccess"));
  }

  function handleBackupCancelled() {
    setBackupStarting(false);
    setBackupTaskId(null);
    setBackupBusy(false);
    showToast(t("project.backupCancelledToast"));
  }

  function handleBackupError(message: string) {
    setBackupStarting(false);
    setBackupTaskId(null);
    setBackupBusy(false);
    showToast(message || t("project.backupError"));
  }

  const statsLine = categoryCounts ? formatStatsLine(categoryCounts, diskUsage) : "";
  const topbarRef = useRef<HTMLDivElement>(null);
  useStatsLineFit(topbarRef, statsLine !== "");

  return (
    <PrivacyContext.Provider value={{ status: privacy.status, onSettingsChanged: privacy.onSettingsChanged }}>
    <div className="project-shell">
      <div className="project-shell__topbar" ref={topbarRef}>
        <div className="project-shell__topbar-leading">
          <button
            className="icon-btn"
            onClick={handleBack}
            title={t("project.backToStart")}
            aria-label={t("project.backToStart")}
          >
            <span className="icon-btn__glyph" data-anim="back">←</span>
          </button>
          <div className="project-shell__title" title={project.name}>
            {project.name}
          </div>
        </div>

        {statsLine && (
          <div className="project-shell__stats" title={statsLine}>
            {statsLine}
          </div>
        )}

        <div className="project-shell__topbar-trailing">
          {/* The three workflow phases that are not "add files". They used
              to be reachable only as tabs inside the "+" dialog, where a
              plus icon promised creating something and hid undo, review and
              export behind it. */}
          <div className="project-shell__topbar-group">
            {/* Duplicates the "+" FAB — deliberately: the FAB is easy to
                miss on first launch, and this is the one action every new
                user needs immediately. Styled like the FAB itself so it
                reads as the same button, not a new one. */}
            <button
              className="icon-btn icon-btn--add"
              onClick={() => openBrowserAt("add")}
              title={t("project.addFiles")}
              aria-label={t("project.addFiles")}
            >
              <span className="icon-btn__glyph" data-anim="turn">+</span>
            </button>
            <button
              className="icon-btn"
              onClick={() => void invoke("show_dropzone_window")}
              title={t("dropzone.openHint")}
              aria-label={t("dropzone.open")}
            >
              <span className="icon-btn__glyph" data-anim="drop">📥</span>
            </button>
            <button
              className="icon-btn"
              onClick={() => openBrowserAt("review")}
              title={t("browser.categories.reviewHint")}
              aria-label={t("browser.categories.review")}
            >
              <span className="icon-btn__glyph" data-anim="spark">✨</span>
            </button>
            <button
              className="icon-btn"
              onClick={() => openBrowserAt("manage")}
              title={t("browser.categories.manageHint")}
              aria-label={t("browser.categories.manage")}
            >
              {/* Was ↺ while this category held nothing but the Protokoll —
                  an undo arrow now names one of its four views (Protokoll,
                  Datei-Operationen, Papierkorb, Sicherung) and mislabels
                  the rest. Kept in step with CATEGORY_ICON.manage. */}
              <span className="icon-btn__glyph" data-anim="tilt">🛠</span>
            </button>
          </div>

          <div className="project-shell__topbar-group">
            <button
              className={"icon-btn" + (showSearch ? " icon-btn--active" : "")}
              onClick={() => setShowSearch((v) => !v)}
              title={t("search.open")}
              aria-label={t("search.open")}
            >
              <span className="icon-btn__glyph" data-anim="zoom">🔍</span>
            </button>
            <button
              className="icon-btn icon-btn--record"
              onClick={() => setRecordMode("video")}
              title={t("record.videoButtonHint")}
              aria-label={t("record.videoButton")}
            >
              <span className="icon-btn__glyph" data-anim="pop">🎬</span>
            </button>
            <button
              className="icon-btn icon-btn--record"
              onClick={() => setRecordMode("audio")}
              title={t("record.audioButtonHint")}
              aria-label={t("record.audioButton")}
            >
              <span className="icon-btn__glyph" data-anim="pop">🎙️</span>
            </button>
            <button
              className="icon-btn"
              onClick={() => setDiaryRequest({ entry: null, timestamp: new Date().toISOString() })}
              title={t("diary.buttonHint")}
              aria-label={t("diary.button")}
            >
              <img className="icon-btn__img" data-anim="tilt" src="/diary_entry.png" alt="" />
            </button>
            <button
              className={"icon-btn" + (showPhases ? " icon-btn--active" : "")}
              onClick={() => setShowPhases(true)}
              title={t("phases.open")}
              aria-label={t("phases.open")}
            >
              <img className="icon-btn__img" data-anim="pop" src={phasesIcon} alt="" />
            </button>
            <button
              className="icon-btn"
              onClick={() => openBrowserAt("settings")}
              title={t("settings.open")}
              aria-label={t("settings.open")}
            >
              <span className="icon-btn__glyph" data-anim="cog">⚙</span>
            </button>
            <button
              className={"icon-btn" + (showHelp ? " icon-btn--active" : "")}
              onClick={() => setShowHelp((v) => !v)}
              title={t("help.open")}
              aria-label={t("help.open")}
            >
              <span className="icon-btn__glyph" data-anim="pop">?</span>
            </button>
            <SupportLink />
            <button
              className="icon-btn"
              onClick={onToggleFullscreen}
              title={isFullscreen ? t("project.exitFullscreen") : t("project.enterFullscreen")}
              aria-label={isFullscreen ? t("project.exitFullscreen") : t("project.enterFullscreen")}
            >
              <span className="icon-btn__glyph" data-anim="pop">{isFullscreen ? "⤡" : "⤢"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Left without onClose: closing the card renders the timeline afresh. */}
      <ErrorBoundary local>
        <Timeline
          refreshToken={refreshToken}
          tileDragEnabled={settings.tileDragEnabled}
          keyboardSuspended={(showBrowser && !browserHidden) || diaryRequest !== null || imageChoice !== null || showPhases || privacy.promptOpen}
          privacyHideToken={privacyHideToken}
          openItemId={openItemId}
          onOpenItemHandled={() => setOpenItemId(null)}
          fileViewRequest={fileViewRequest}
          onFileViewHandled={() => setFileViewRequest(null)}
          onFileViewClosed={() => {
            if (suspendedDiary) setDiaryRequest({ ...suspendedDiary, edit: false });
            setSuspendedDiary(null);
          }}
          onDiaryRequest={(req) => (req.chooseImageTarget ? setImageChoice(req) : setDiaryRequest(req))}
          timestampOverlayEnabled={settings.showTimestampOverlay}
          viewerNavMode={settings.viewerNavMode}
          viewerNavTypes={settings.viewerNavTypes}
          pileAction={settings.pileAction}
          pileTrigger={settings.pileTrigger}
          hoverZoomBrake={settings.hoverZoomBrake}
          fanCursorFollow={settings.fanCursorFollow}
          showWeekGrid={settings.showWeekGrid}
          showHourGrid={settings.showHourGrid}
          wheelViewer={settings.wheelViewer}
          laneOrder={settings.laneOrder}
          deleteFilesOnRemove={settings.deleteFilesOnRemove}
          searchOpen={showSearch}
          onCloseSearch={() => setShowSearch(false)}
          onToast={showToast}
          onCategoryCountsChange={setCategoryCounts}
          onAddFiles={() => openBrowserAt("add")}
          onSendSelectionToFileOps={sendSelectionToFileOps}
          phaseGroups={phaseGroups}
          onPhaseGroupsChanged={reloadPhaseGroups}
        />
      </ErrorBoundary>

      <button
        className="fab"
        onClick={() => openBrowserAt("add")}
        title={t("project.addFiles")}
        aria-label={t("project.addFiles")}
      >
        <span className="fab__glyph">+</span>
      </button>

      <ErrorBoundary local>
        <PendingDrops
          onImported={() => setRefreshToken((n) => n + 1)}
          onToast={(message) => showToast(message)}
          onCheckWithAi={checkWithAi}
          onManualReview={checkManually}
        />
      </ErrorBoundary>

      <ErrorBoundary local onClose={() => setShowHelp(false)}>
        <HelpCenter open={showHelp} onClose={() => setShowHelp(false)} />
      </ErrorBoundary>

      {showPhases && (
        <ErrorBoundary local onClose={() => setShowPhases(false)}>
          <LifePhasesDialog
            groups={phaseGroups}
            onGroupsChange={setPhaseGroups}
            onReload={reloadPhaseGroups}
            onClose={() => setShowPhases(false)}
          />
        </ErrorBoundary>
      )}

      {showBrowser && (
        <div className={"browser-overlay" + (browserHidden ? " browser-overlay--peek" : "")} aria-hidden={browserHidden}>
          <ErrorBoundary local onClose={closeBrowser}>
          <FileBrowser
            key={browserKey}
            onTabChange={setPeekTab}
            projectPath={project.path}
            initialTab={browserRequest?.tab}
            restrictAiIds={browserRequest?.tab === "ai_metadata" ? browserRequest.ids : undefined}
            restrictManualReviewIds={browserRequest?.tab === "file_ops" ? browserRequest.ids : undefined}
            manualReviewAlsoWantsAi={browserRequest?.tab === "file_ops" ? browserRequest.alsoCheckWithAi : undefined}
            fileOpsAutoMarkIds={browserRequest?.tab === "file_ops" ? browserRequest.markOnlyIds : undefined}
            onDone={closeBrowser}
            onDataChanged={() => setRefreshToken((n) => n + 1)}
            onBackup={handleBackup}
            backupBusy={backupBusy}
            settings={settings}
            onSettingsChange={updateSettings}
            onSettingScopeChange={updateSettingScope}
          />
          </ErrorBoundary>
        </div>
      )}

      {showBrowser && !browserHidden && !peekDismissed && peekSnapshot && peekEnabledHere && (
        <MiniViewer snapshot={peekSnapshot} onSwitch={peekAtTimeline} onHide={() => setPeekDismissed(true)} />
      )}
      {showBrowser && browserHidden && <ReturnPill label={t(PEEK_TAB_LABEL_KEY[peekTab])} onReturn={returnToBrowser} />}

      {backupStarting && (
        <CopyProgress
          taskId={backupTaskId}
          title={t(backupUpdating ? "project.backupUpdateProgressTitle" : "project.backupProgressTitle")}
          onDone={handleBackupDone}
          onCancelled={handleBackupCancelled}
          onError={handleBackupError}
        />
      )}

      {diaryRequest && (
        <ErrorBoundary local onClose={() => setDiaryRequest(null)}>
        <DiaryDialog
          entry={diaryRequest.entry}
          initialTimestamp={diaryRequest.timestamp}
          initialImage={diaryRequest.image}
          startInEdit={diaryRequest.edit}
          onSaved={() => setRefreshToken((n) => n + 1)}
          onClose={() => setDiaryRequest(null)}
          onShowFiles={(req) => {
            setSuspendedDiary(diaryRequest);
            setDiaryRequest(null);
            setFileViewRequest(req);
          }}
          onToast={showToast}
        />
        </ErrorBoundary>
      )}

      {imageChoice && imageChoice.image && (
        <div className="diary-modal" onMouseDown={(ev) => ev.target === ev.currentTarget && setImageChoice(null)}>
          <div className="diary-modal__panel diary-modal__panel--narrow">
            <div className="diary-modal__header">
              <div className="diary-modal__title">{t("diary.pasteChoiceTitle")}</div>
              <button className="icon-btn" onClick={() => setImageChoice(null)} aria-label={t("record.close")}>
                ✕
              </button>
            </div>
            <div className="diary-modal__body">
              <img className="diary-modal__choice-preview" src={imageChoice.image.previewUrl} alt="" />
              <div className="diary-modal__hint">{t("diary.pasteChoiceExplain")}</div>
            </div>
            <div className="diary-modal__footer">
              <button
                className="btn"
                onClick={async () => {
                  const choice = imageChoice;
                  setImageChoice(null);
                  try {
                    const path = await invoke<string>("stage_clipboard_image", {
                      name: choice.image!.name,
                      dataBase64: choice.image!.dataBase64,
                    });
                    const entry: DatedPath = {
                      path,
                      timestamp: choice.timestamp ?? new Date().toISOString(),
                      timestamp_source: "manual",
                    };
                    const result = await invoke<AddItemsResult>("add_items_with_dates", {
                      entries: [entry],
                      operationId: crypto.randomUUID(),
                    });
                    await invoke("discard_recording", { path }).catch(() => {});
                    if (result.added.length > 0) {
                      setOpenItemId(result.added[0].id);
                      setRefreshToken((n) => n + 1);
                      showToast(t("diary.imageAddedToast"));
                    } else {
                      showToast(result.skipped[0]?.reason ?? t("diary.imageAddError"));
                    }
                  } catch {
                    showToast(t("diary.imageAddError"));
                  }
                }}
              >
                🖼️ {t("diary.pasteAsImage")}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  const choice = imageChoice;
                  setImageChoice(null);
                  setDiaryRequest({ entry: null, timestamp: choice.timestamp, image: choice.image });
                }}
              >
                📔 {t("diary.pasteAsDiary")}
              </button>
            </div>
          </div>
        </div>
      )}

      {recordMode && (
        <ErrorBoundary local onClose={() => setRecordMode(null)}>
        <RecordMedia
          mode={recordMode}
          onAdded={() => setRefreshToken((n) => n + 1)}
          onToast={showToast}
          onClose={() => setRecordMode(null)}
          onDuplicatesFound={(ids) => checkManually(ids, false)}
        />
        </ErrorBoundary>
      )}

      {privacy.status?.configured && privacy.status.showIndicator && <PrivacyIndicator revealed={privacy.status.revealed} />}
      {privacy.promptOpen && <PrivacyPrompt onSubmit={privacy.reveal} onClose={privacy.closePrompt} />}
    </div>
    </PrivacyContext.Provider>
  );
}
