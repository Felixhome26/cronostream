import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import type { DirEntryInfo, DirListing, FileKind } from "../../types";
import type { PickedList } from "../../hooks/usePickedList";
import type { PathCollection } from "../../hooks/useCollection";
import { t, tCount } from "../../i18n";
import { useFileDragOut } from "../../hooks/useFileDragOut";
import { useEmailHeaders } from "../../hooks/useEmailHeaders";
import { useToast } from "../../ToastContext";
import { useConfirm } from "../../ConfirmContext";
import { useProgress } from "../../ProgressContext";
import { formatDateTime } from "../../utils/datetime";
import { ensureDateInfos } from "../../utils/dateChoices";
import DateChoiceSelect, { DateStamp } from "../DateChoiceSelect";
import { canWebviewDecode, decodedOriginalUrl, mediaUrl } from "../../utils/mediaServer";
import AudioPlayer from "../AudioPlayer";
import VideoPlayer from "../VideoPlayer";
import ImageZoomOverlay from "../ImageZoomOverlay";
import HelpHint from "./HelpHint";
import ToggleSwitch from "./ToggleSwitch";
import RevealInFolderItems from "./RevealInFolderItems";
import SendToProjectItems from "./SendToProjectItems";
import {
  allKindLanes,
  KIND_LANE_LABEL_KEY,
  KIND_LANE_ORDER,
  passesKindFilter,
  type KindLane,
} from "../../utils/fileKindLane";
import { isBrowserPeeking } from "../../utils/browserPeek";

// Kept low on purpose: image decode is CPU-heavy (often multi-threaded
// internally), and background thumbnail generation competing for CPU with
// an interactive "add to project" click was making the add noticeably
// slow to confirm. Lower concurrency trades a bit of thumbnail throughput
// for the UI staying snappy for actions the user is actively waiting on.
const THUMBNAIL_CONCURRENCY = 2;

// Above this many cached thumbnails, a new folder or search result keeps
// only the ones it lists itself. Each one is a data URL of tens of KB, and
// browsing many folders (or large search results) used to pile them all up
// in memory. What is dropped comes back from the backend's disk cache.
const PREVIEW_CACHE_KEEP = 2000;

// Kinds with a real, pre-renderable thumbnail (image resize / ffmpeg frame /
// PDFium page). Audio intentionally has no thumbnail — it always shows a
// static icon, by design.
const PREVIEWABLE_KINDS = new Set(["image", "video", "document"]);

const TILE_FULL_PX = 140;
const TILE_DEFAULT_PX = Math.round(TILE_FULL_PX * 0.7);
const TILE_MIN_PX = Math.round(TILE_FULL_PX * 0.6);
const PREVIEW_DEFAULT_PX = 560;
// The sharp rendition asked of the backend for the preview panel. The panel
// is PREVIEW_DEFAULT_PX wide and stays under ~1000 even dragged right out,
// so the single-image view's 2048px rendition was roughly four times the
// pixels this panel can show — paid for in resize, JPEG encode, IPC payload
// and webview decode. The backend snaps this onto its own matching tier.
const PANEL_PREVIEW_MAX_DIM = 1280;

const PREVIEW_MIN_PX = 280;
const TILE_SHRINK_SPAN_PX = 200;
const GRID_MIN_PX = 260;
const FOLDER_OVERLAY_WIDTH = 280;

// Rows rendered beyond the visible ones, above and below — enough that a
// normal scroll step or an arrow key never lands on a not-yet-rendered tile.
const OVERSCAN_ROWS = 3;

// Upper bound on how long the preview may hold back the thumbnail queue.
const PREVIEW_PAUSE_MAX_MS = 4000;

function tileSizeForPreview(previewPx: number): number {
  const extra = Math.max(0, previewPx - PREVIEW_DEFAULT_PX);
  const shrink = ((TILE_DEFAULT_PX - TILE_MIN_PX) * extra) / TILE_SHRINK_SPAN_PX;
  return Math.max(TILE_MIN_PX, TILE_DEFAULT_PX - shrink);
}

const KIND_ICON: Record<string, string> = {
  audio: "🎧",
  video: "🎬",
  document: "📄",
  email: "✉️",
  // Diary entries reach the project tabs with this kind too (the backend
  // sends `file_type` as is); without a glyph their tile stayed empty.
  diary: "📔",
  other: "❓",
};

const SPREADSHEET_EXTS = new Set(["csv", "xls", "xlsx"]);

const SELECTION_HINT_DISMISSED_KEY = "cronostream.fileTileGrid.selectionHintDismissed";
// Stored *as* the version, not as a plain "1": bumping this brings the hint
// back once for everyone who had dismissed it. Worth doing whenever its
// wording or its controls change — an earlier "don't show again" was then a
// decision about something the user never actually saw. Bumped to 2 when the
// hint gained a separate close button next to that action.
const SELECTION_HINT_VERSION = "2";

function iconForEntry(entry: { kind: FileKind | null; name: string }): string {
  if (entry.kind === "image") return "🖼️";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (entry.kind === "document" && ext && SPREADSHEET_EXTS.has(ext)) return "📊";
  return KIND_ICON[entry.kind ?? "other"];
}

function formatDate(iso: string | null): string {
  return formatDateTime(iso) ?? "–";
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

interface Props {
  entries: DirEntryInfo[];
  /// Identifies the listing `entries` belong to. While it stays the same,
  /// a new `entries` array is the same listing grown (files streaming in
  /// from a subfolder walk) and the selection, preview and rotations stay;
  /// a new key is a different listing and resets them. Without it, every
  /// new `entries` array counts as a new listing.
  entriesKey?: string;
  /// Source paths already in the project — shared/global state the caller
  /// owns (the same file shows as "added" regardless of which tab you
  /// found it from), so this component only reads it and reports changes
  /// back via `onRemoved`.
  addedPaths: Set<string>;
  onRemoved: (removedPaths: string[], message: string) => void;
  emptyMessage: string;
  /// Rendered at the start of the add/remove toolbar row — e.g. the folder
  /// browser's "up ↑ / current path" controls. Omitted entirely elsewhere.
  toolbarLeft?: React.ReactNode;
  /// False while this instance is mounted but not the one on screen (the
  /// folder-browsing grid stays mounted across tab switches to keep its
  /// selection/scroll/thumbnail cache alive — see `FileBrowser`). Pauses
  /// background thumbnail generation and re-measures the panel width once
  /// it becomes true again, since a hidden (`display:none`) element can't
  /// reliably be measured and its `ResizeObserver` may not refire on a
  /// pure visibility change.
  active?: boolean;
  /// When set, the grid previews and scrolls to this path once, then calls
  /// `onFocusConsumed` — used to restore the last-viewed tile when
  /// returning from the single-image view.
  focusPath?: string | null;
  onFocusConsumed?: () => void;
  /// Reports the currently previewed entry — used by the folder-browsing
  /// grid so switching to the single-image view can start on the same
  /// image that was selected here.
  onPreviewChange?: (entry: DirEntryInfo | null) => void;
  /// Shows a "Bereits im Projekt enthaltene Dateien ausblenden" toggle in
  /// the toolbar — opt-in since the disk search tab already has its own
  /// version of this (checked *before* running the search, not live while
  /// browsing), and showing both would be redundant there.
  showAlreadyInProjectToggle?: boolean;
  /// Marks staged in the single-image view. Passed in so a file marked
  /// there shows as marked here too after switching back, and can be added
  /// from either side — the two views share one set of marks even though
  /// each keeps its own add flow. Optional: the disk search tab has no
  /// single-image counterpart.
  picks?: PickedList;
  /// The file manager-wide collection of marked files (see `useCollection`) —
  /// shared by every grid instance so marks survive folder changes.
  collection: PathCollection;
  /// Called instead of selecting/previewing when a folder tile is clicked —
  /// the folder-browsing grid passes its `loadDir` so a single click opens
  /// the folder. Omitted (e.g. disk search) where entries are never dirs.
  onNavigateFolder?: (path: string) => void;
  /// Offers "Enthaltenden Ordner öffnen" in the context menu.
  onRevealInFolder?: (path: string) => void;
  /// Offers "Datum im Stream ändern" in the context menu, remove mode
  /// only (see that entry's own comment). Called with every path the
  /// change should apply to — the clicked tile alone, or the whole marked
  /// selection if the clicked tile is part of a multi-mark, same rule
  /// `SendToProjectItems` uses. The caller (`ProjectFilesView`) owns
  /// resolving paths to item ids and opening the actual dialog.
  onChangeDate?: (paths: string[]) => void;
  /// Remove mode only: extra context-menu items for the given paths (the
  /// clicked tile, or the marked selection it belongs to). When set it
  /// replaces the lone "Datum ändern" entry, which it includes itself.
  renderContextActions?: (paths: string[], close: () => void) => React.ReactNode;
  /// What a mark *means* here, which is the one thing that differs between
  /// browsing files to add and operating on files already in the project.
  ///
  /// "add" (the default) is the long-standing behaviour: a mark stages the
  /// file for import, so it is refused for a folder, for a file the backend
  /// says can't be added, and for one already in the project — and it shows
  /// the accent ✓ badge.
  ///
  /// "remove" is the "Datei-Operationen"/"Papierkorb" mode: every listed
  /// file can be marked (they are all already in the project, which is the
  /// *premise* rather than an obstacle), the badge is a red minus, and none
  /// of the add-flow controls are drawn. The two never share a mark set —
  /// see `useTransientCollection` — so there is no state to collide even
  /// though both modes run through this one component.
  markMode?: "add" | "remove";
  /// Remove mode only: swaps the mark badge's glyph from "−" to a wrench
  /// (same red circle) for the whole grid — set by `ProjectFilesView` when
  /// Datei-Operationen was opened via the timeline's "an Dateioperationen
  /// übergeben" handoff, so the pre-marked tiles read as "here to edit",
  /// not "here to remove".
  editIntent?: boolean;
  /// Thumbnails the caller already has, keyed by entry path.
  ///
  /// Project items come with a `thumbnail_path` generated at import time and
  /// served over the loopback media server, so asking `get_file_preview` to
  /// decode them a second time would redo work the project already did —
  /// the exact cost that made opening a stream slow before thumbnails
  /// moved onto that server. A path present here is never queued for
  /// preview generation at all.
  thumbnailUrls?: Map<string, string>;
  /// Shows the Fotos/Video/Audio/Dokumente chips in the toolbar.
  showKindFilter?: boolean;
  /// Per-entry corner label, keyed by path. The project tabs put each
  /// file's timeline date here — the position the browsing grid uses for
  /// its "Im Projekt" badge, which is meaningless once *everything* listed
  /// is in the project.
  badges?: Map<string, string>;
  /// Rendered at the end of the toolbar row — the batch-action buttons of
  /// the two project tabs. Kept as a slot rather than built in, since what
  /// a batch does is exactly what differs between those tabs.
  toolbarRight?: React.ReactNode;
  /// The files the grid actually shows after its own filters (type chips,
  /// "already in project"), so a parent's select-all and batch actions can
  /// stay within what the user can see.
  onVisiblePathsChange?: (paths: string[]) => void;
  /// "Arbeitskopie beim Entfernen löschen": the "remove selected" button
  /// then purges for good, so it asks first, like every other removal does.
  deleteFilesOnRemove?: boolean;
}

// Once per app session, not per mount (the file manager remounts it on every open).
let selectionHintShownThisSession = false;

/// The "Übersicht" grid: thumbnails, multi-select, a preview/player panel,
/// rotate controls and add/remove — shared by the folder-browsing grid tab
/// and the disk search's result list, which both just need "show these
/// files as tiles and let the user add some to the project".
export default function FileTileGrid({
  entries,
  entriesKey,
  addedPaths,
  picks,
  collection,
  onRemoved,
  emptyMessage,
  toolbarLeft,
  active = true,
  focusPath,
  onFocusConsumed,
  onPreviewChange,
  showAlreadyInProjectToggle = false,
  onNavigateFolder,
  onRevealInFolder,
  onChangeDate,
  renderContextActions,
  markMode = "add",
  editIntent = false,
  thumbnailUrls,
  showKindFilter = false,
  badges,
  toolbarRight,
  onVisiblePathsChange,
  deleteFilesOnRemove = false,
}: Props) {
  const showToast = useToast();
  const confirm = useConfirm();
  const { startOperation, finishOperation } = useProgress();
  const removeMode = markMode === "remove";
  // A tile counts as marked whether the mark was made here or in the
  // single-image view. The grid's own selection is deliberately still
  // cleared on folder navigation while `picks` survives it — that is what
  // the single-image view's staging list is for.
  const isMarked = (path: string) => collection.has(path) || picks?.has(path) === true;
  // Tiles marked for adding show their date dropdown, so the dates have to
  // be read as soon as a mark is made.
  useEffect(() => {
    if (!removeMode && collection.paths.size > 0) void ensureDateInfos([...collection.paths]);
  }, [removeMode, collection.paths]);
  const [hideAlreadyInProject, setHideAlreadyInProject] = useState(false);
  // Every group on = no filtering, so the grid starts showing everything.
  const [kindLanes, setKindLanes] = useState<Set<KindLane>>(() => allKindLanes());
  // The opening lines of the previewed mail's body, keyed by path so
  // clicking back and forth between two mails doesn't re-fetch either.
  const [emailTexts, setEmailTexts] = useState<Record<string, string | null>>({});
  // Same idea for .txt/.docx/.odt/.rtf — the extracted text in place of the
  // thumbnail those document kinds don't have. `null` for a document the
  // backend has no text for (.pdf/.doc have their own image preview
  // instead; spreadsheets have no extracted text at all), so the fallback
  // image-or-icon branch below still runs for those.
  const [documentTexts, setDocumentTexts] = useState<Record<string, string | null>>({});
  const [projectDuplicatePaths, setProjectDuplicatePaths] = useState<Set<string>>(new Set());
  const [previewEntry, setPreviewEntry] = useState<DirEntryInfo | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  // A previewed mail is described by its own header fields instead of the
  // file's. `undefined` while they are read, `null` if it can't be parsed —
  // then the panel keeps the file details every other kind shows.
  const previewMailPath = previewEntry?.kind === "email" ? previewEntry.path : null;
  const mailHeaders = useEmailHeaders(previewMailPath ? [previewMailPath] : []);
  const mailHeader = previewMailPath ? mailHeaders[previewMailPath] : null;
  const previewImageBoxRef = useRef<HTMLDivElement>(null);
  // Only a selection the user made themselves may autoplay; the tile that is
  // pre-selected when a folder opens must stay silent.
  const [userPickedPath, setUserPickedPath] = useState<string | null>(null);
  const previewDragOut = useFileDragOut(previewEntry?.path, {
    emoji: previewEntry ? iconForEntry(previewEntry) : undefined,
    onError: () => showToast(t("timeline.dragFailed")),
  });
  const [actionBusy, setActionBusy] = useState(false);
  // Single click on a folder tile only highlights it and offers this popover;
  // opening the folder is reserved for double-click.
  const [folderOverlay, setFolderOverlay] = useState<{ entry: DirEntryInfo; left: number; top: number } | null>(null);
  // Multi-step flow behind the popover's "mark all" button: optional
  // subfolder question, then the final confirmation.
  const [folderPrompt, setFolderPrompt] = useState<
    | { step: "subfolders"; entry: DirEntryInfo; directFiles: DirEntryInfo[] }
    | { step: "confirm"; entry: DirEntryInfo; files: DirEntryInfo[] }
    | null
  >(null);
  const [previewCache, setPreviewCache] = useState<Record<string, string>>({});
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [fullPreview, setFullPreview] = useState<{ path: string; url: string } | null>(null);
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_DEFAULT_PX);
  const [contentWidth, setContentWidth] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DirEntryInfo } | null>(null);
  // Rotations are applied immediately for display, without waiting on the
  // parent to re-fetch `entries` — keyed by path so they survive the
  // underlying entry object being a fresh reference on every render.
  const [rotationOverrides, setRotationOverrides] = useState<Map<string, number>>(new Map());
  // Windowing: only the rows around the scroll position are rendered (a
  // folder with subfolders shown can list tens of thousands of files, and
  // rendering every tile at once froze the app). `gridMetrics` is the
  // grid's own size and CSS spacing, `rowStride` the measured height of
  // one tile row plus the row gap.
  const [gridMetrics, setGridMetrics] = useState({ width: 0, height: 0, padTop: 20, padX: 40, gap: 16 });
  const [scrollTop, setScrollTop] = useState(0);
  const [rowStride, setRowStride] = useState(0);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tileElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const requestedPreviews = useRef<Set<string>>(new Set());
  const previewQueue = useRef<string[]>([]);
  const activeWorkers = useRef(0);
  const pausedForAdd = useRef(false);
  const pausedForInactive = useRef(!active);
  const pausedForPreview = useRef(false);
  const previewFetchesInFlight = useRef(0);
  const pendingPreviews = useRef<Record<string, string>>({});
  const flushScheduled = useRef(false);
  const generation = useRef(0);
  const previewCacheRef = useRef(previewCache);
  previewCacheRef.current = previewCache;
  // A path to bring into view once the window has been laid out (see the
  // `focusPath` effect) — the tile may not be rendered yet when it is set.
  const pendingScrollPath = useRef<string | null>(null);

  function entryRotation(entry: DirEntryInfo): number {
    return rotationOverrides.get(entry.path) ?? entry.rotation;
  }

  // A fresh `entries` fetch always carries the current source of truth
  // (the timeline wins for already-imported files, see `rotate_path` in
  // the backend) — drop any local overrides so a stale one can't keep
  // outvoting a value that changed elsewhere (e.g. undone or rotated from
  // the timeline) after the next reload.
  const listingIdentity = entriesKey ?? entries;
  useEffect(() => {
    setRotationOverrides(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingIdentity]);

  useEffect(() => {
    onPreviewChange?.(previewEntry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewEntry]);

  // Scrolling *into* the preview picture (wheel forward) opens the free zoom,
  // same as the 🔍 button. Only the picture box listens — the rest of the
  // panel keeps scrolling normally, and so does a wheel turned backwards over
  // the picture. Native listener because React's onWheel is passive and
  // couldn't stop the panel from scrolling along with the opening tick.
  const previewIsImage = previewEntry?.kind === "image";
  useEffect(() => {
    const box = previewImageBoxRef.current;
    if (!previewIsImage || !box) return;
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaY >= 0 || ev.ctrlKey) return;
      ev.preventDefault();
      setZoomOpen(true);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [previewIsImage, previewEntry?.path]);

  const selectionHintShown = useRef(false);

  // One-time explainer for the click/preview vs. double-click/Space/mark
  // split, since it differs from a plain "click to select" grid. Gated on
  // `active` so it appears once the grid is actually the visible tab, not
  // the moment this (possibly hidden) instance mounts; dismissal is
  // persisted across browser profile restarts, not just this session.
  useEffect(() => {
    if (!active) return;
    // The hint spells out the click/double-click split in terms of
    // "markiert zum Hinzufügen", which is plainly wrong in the project
    // tabs — and the red minus badge plus its tooltip already say what a
    // mark means there. A hint that misnames the action is worse than none.
    if (removeMode) return;
    // React's StrictMode runs every effect twice in development, which
    // showed this hint as two identical stacked toasts. A ref survives that
    // double-invoke (it is the same component instance), so the hint appears
    // once per mount either way.
    if (selectionHintShown.current || selectionHintShownThisSession) return;
    if (localStorage.getItem(SELECTION_HINT_DISMISSED_KEY) === SELECTION_HINT_VERSION) return;
    // The file manager's copy-protection hint (8 s) shows on the same first
    // visit; wait it out instead of stacking two toasts. The flags are set
    // inside the timer so a StrictMode cleanup that cancels it can re-arm.
    const copyHintPending =
      localStorage.getItem("cronostream.onboarding.copyProtectionHintShown") !== "1";
    const timer = window.setTimeout(() => {
      if (selectionHintShown.current || selectionHintShownThisSession) return;
      selectionHintShown.current = true;
      selectionHintShownThisSession = true;
      showToast(t("browser.selectionHint"), {
        durationMs: 8000,
        action: {
          label: t("browser.dontShowAgain"),
          onClick: () => localStorage.setItem(SELECTION_HINT_DISMISSED_KEY, SELECTION_HINT_VERSION),
        },
      });
    }, copyHintPending ? 8300 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (previewEntry?.kind !== "audio" && previewEntry?.kind !== "video") {
      setMediaPreviewUrl(null);
      return;
    }
    let cancelled = false;
    mediaUrl(previewEntry.path).then((url) => {
      if (!cancelled) setMediaPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [previewEntry]);

  // An e-mail has no renderable thumbnail, and a `.msg` filename is often
  // meaningless ("AW_ Re_ Termin.msg") — so the panel shows the start of
  // the body instead. Fetched only for the mail actually being previewed,
  // never for the grid: the parse is cheap per file but there can be
  // thousands of them, and only one is on screen.
  useEffect(() => {
    if (previewEntry?.kind !== "email") return;
    const path = previewEntry.path;
    if (path in emailTexts) return;
    let cancelled = false;
    invoke<string | null>("get_email_text_preview", { path })
      .then((text) => {
        if (!cancelled) setEmailTexts((prev) => ({ ...prev, [path]: text }));
      })
      .catch(() => {
        // An unparseable mail just keeps its icon.
        if (!cancelled) setEmailTexts((prev) => ({ ...prev, [path]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [previewEntry, emailTexts]);

  // Mirrors the e-mail effect above, for document text. Fired for every
  // "document" preview (including .pdf/.doc and spreadsheets) rather than
  // filtering by extension on the frontend — the backend already returns
  // `null` for anything it has no text for, so there's one place that
  // decides which document kinds get text.
  useEffect(() => {
    if (previewEntry?.kind !== "document") return;
    const path = previewEntry.path;
    if (path in documentTexts) return;
    let cancelled = false;
    invoke<string | null>("get_document_text_preview", { path })
      .then((text) => {
        if (!cancelled) setDocumentTexts((prev) => ({ ...prev, [path]: text }));
      })
      .catch(() => {
        if (!cancelled) setDocumentTexts((prev) => ({ ...prev, [path]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [previewEntry, documentTexts]);

  function toggleKindLane(lane: KindLane) {
    setKindLanes((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  }

  function startResize(ev: React.PointerEvent<HTMLDivElement>) {
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);

    function onMove(moveEv: PointerEvent) {
      const bounds = contentRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const raw = bounds.right - moveEv.clientX;
      const max = Math.max(PREVIEW_MIN_PX, bounds.width - GRID_MIN_PX);
      setPreviewWidth(Math.min(max, Math.max(PREVIEW_MIN_PX, raw)));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  const schedulePreviewFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    setTimeout(() => {
      flushScheduled.current = false;
      const updates = pendingPreviews.current;
      pendingPreviews.current = {};
      if (Object.keys(updates).length === 0) return;
      setPreviewCache((prev) => ({ ...prev, ...updates }));
    }, 150);
  }, []);

  const fetchPreview = useCallback(
    (path: string, gen: number) =>
      invoke<string>("get_file_preview", { path })
        .then((dataUrl) => {
          if (generation.current !== gen) return;
          pendingPreviews.current[path] = dataUrl;
          schedulePreviewFlush();
        })
        .catch(() => {
          // leave uncached — tile just keeps showing its generic icon
        }),
    [schedulePreviewFlush],
  );

  // Deliberately reads `generation.current` itself on every call instead of
  // taking it as a parameter: a `.finally()` callback recursing with a
  // *captured* generation number would keep propagating that same stale
  // number forever once a newer generation starts while fetches are still
  // in flight (confirmed 2026-10-13 — this is exactly what happened under
  // React 18 StrictMode's deliberate double-invoke of a fresh mount's
  // effects: the second invocation's dispatches inherited the *first*
  // invocation's now-stale generation via this recursion, so every single
  // fetch from then on got discarded as "stale" by `fetchPreview`, forever
  // — not just the two really-stale in-flight ones from the first
  // invocation). Reading the ref fresh each time self-heals instead: only
  // the genuinely superseded in-flight fetches get discarded, and every
  // fetch *dispatched* after a generation bump correctly uses the new one.
  const drainPreviewQueue = useCallback(
    () => {
      if (pausedForAdd.current || pausedForInactive.current || pausedForPreview.current) return;
      while (activeWorkers.current < THUMBNAIL_CONCURRENCY && previewQueue.current.length > 0) {
        const path = previewQueue.current.shift()!;
        activeWorkers.current++;
        fetchPreview(path, generation.current).finally(() => {
          activeWorkers.current--;
          drainPreviewQueue();
        });
      }
    },
    [fetchPreview],
  );

  const requestPreviewPriority = useCallback(
    (path: string, gen: number) => {
      const queueIndex = previewQueue.current.indexOf(path);
      const wasQueued = queueIndex !== -1;
      if (wasQueued) previewQueue.current.splice(queueIndex, 1);

      if (requestedPreviews.current.has(path) && !wasQueued) return;
      requestedPreviews.current.add(path);
      fetchPreview(path, gen);
    },
    [fetchPreview],
  );

  // Resets the thumbnail queue whenever the entry set itself changes —
  // folder navigation and a fresh search result both land here the same
  // way, so neither caller needs its own reset code.
  useEffect(() => {
    ++generation.current;
    previewQueue.current = [];
    requestedPreviews.current = new Set();
    pendingPreviews.current = {};
    setPreviewCache((prev) => {
      if (Object.keys(prev).length <= PREVIEW_CACHE_KEEP) return prev;
      const listed = new Set(entries.map((e) => e.path));
      const kept: Record<string, string> = {};
      for (const [path, url] of Object.entries(prev)) if (listed.has(path)) kept[path] = url;
      return kept;
    });
    // Pre-select the first visible tile instead of leaving the preview
    // panel unmounted: with no panel, the grid's flex box has no sibling
    // and spans the full content width; the instant the user's first click
    // mounted the panel, the grid's available width (and so its
    // auto-fill column count) shrank, reflowing every tile out from under
    // the cursor. Starting pre-selected keeps the panel mounted — and the
    // column count stable — from the very first render.
    const afterKindFilter = showKindFilter ? entries.filter((e) => passesKindFilter(e, kindLanes)) : entries;
    const nextVisible = hideAlreadyInProject
      ? afterKindFilter.filter((e) => !addedPaths.has(e.path) && !projectDuplicatePaths.has(e.path))
      : afterKindFilter;
    // Folders are never previewed (see `activateEntry` / `handleEntryClick`
    // above, which only ever route files into `previewEntry`) — a folder
    // leading the list must not become the default selection.
    setPreviewEntry(nextVisible.find((e) => !e.is_dir) ?? null);
    setUserPickedPath(null);
    setFolderOverlay(null);
    setFolderPrompt(null);

    // The queue itself is seeded by the windowing effect below, with only
    // the tiles actually on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingIdentity]);

  /// The image to draw for an entry: the caller's ready-made thumbnail
  /// first, then whatever the background queue has generated.
  const thumbFor = (path: string): string | undefined => thumbnailUrls?.get(path) ?? previewCache[path];

  // Only runs while the toggle is actually on — browsing a folder with it
  // off costs nothing extra. Re-checks whenever the entry set changes
  // (a new folder) while it's on; flipping the toggle off just hides the
  // control's effect again without forgetting what was found.
  useEffect(() => {
    if (!showAlreadyInProjectToggle || !hideAlreadyInProject) return;
    let cancelled = false;
    const paths = entries.filter((e) => !e.is_dir && !addedPaths.has(e.path)).map((e) => e.path);
    invoke<string[]>("check_already_in_project", { paths })
      .then((matches) => {
        if (!cancelled) setProjectDuplicatePaths(new Set(matches));
      })
      .catch(() => {
        if (!cancelled) setProjectDuplicatePaths(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [showAlreadyInProjectToggle, hideAlreadyInProject, entries, addedPaths]);

  const measureGrid = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const style = getComputedStyle(grid);
    const next = {
      width: grid.clientWidth,
      height: grid.clientHeight,
      padTop: parseFloat(style.paddingTop) || 0,
      padX: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
      gap: parseFloat(style.rowGap) || 0,
    };
    setGridMetrics((prev) =>
      prev.width === next.width &&
      prev.height === next.height &&
      prev.padTop === next.padTop &&
      prev.padX === next.padX &&
      prev.gap === next.gap
        ? prev
        : next,
    );
  }, []);

  useEffect(() => {
    pausedForInactive.current = !active;
    if (active) {
      drainPreviewQueue();
      const el = contentRef.current;
      if (el) setContentWidth(el.getBoundingClientRect().width);
      measureGrid();
    }
  }, [active, drainPreviewQueue, measureGrid]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(() => measureGrid());
    observer.observe(grid);
    return () => observer.disconnect();
  }, [measureGrid]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContentWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!focusPath) return;
    const entry = entries.find((e) => e.path === focusPath);
    onFocusConsumed?.();
    if (!entry) return;
    setPreviewEntry(entry);
    pendingScrollPath.current = focusPath;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath]);

  useEffect(() => {
    if (previewEntry?.kind !== "image") {
      setFullPreview(null);
      return;
    }
    const path = previewEntry.path;
    let cancelled = false;

    // The original file, served by our own loopback media server and decoded
    // by WebKit itself — libjpeg-turbo plus GPU scaling, which is exactly
    // why an ordinary image viewer feels instant where decoding, resizing,
    // JPEG-encoding and base64-ing a 24 MP photo in Rust takes seconds. The
    // timeline's thumbnails already work this way (see `fileUrl`). Note this
    // is *not* a repeat of the experiment warned about in `preview.rs`:
    // that one handed the webview dozens of multi-MB originals at once, as
    // base64 data URLs, for every tile in the grid. This is one image, over
    // HTTP, for the panel the user is actually looking at.
    //
    // Nothing is decoded in Rust, so the thumbnail queue needs no pausing
    // here either — and the swap waits for the decode to finish, so the
    // panel keeps showing the already-loaded grid thumbnail instead of
    // blanking out in between.
    if (canWebviewDecode(path)) {
      decodedOriginalUrl(path)
        .then((url) => {
          // Guards against a photo the user has already clicked past still
          // landing in the panel.
          if (!cancelled) setFullPreview({ path, url });
        })
        .catch(() => {
          // Falls back to the grid thumbnail below.
        });
      return () => {
        cancelled = true;
      };
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      previewFetchesInFlight.current--;
      if (previewFetchesInFlight.current === 0) {
        pausedForPreview.current = false;
        drainPreviewQueue();
      }
    };
    previewFetchesInFlight.current++;
    pausedForPreview.current = true;
    const watchdog = window.setTimeout(release, PREVIEW_PAUSE_MAX_MS);
    invoke<string>("get_full_image_preview", { path, maxDim: PANEL_PREVIEW_MAX_DIM })
      .then((url) => {
        if (!cancelled) setFullPreview({ path, url });
      })
      .catch(() => {
        // Falls back to the grid thumbnail below.
      })
      .finally(() => {
        window.clearTimeout(watchdog);
        release();
      });
    return () => {
      cancelled = true;
    };
  }, [previewEntry, drainPreviewQueue]);

  // Sets the preview without touching the mark state — shared by a plain
  // click and by arrow-key navigation.
  function activateEntry(entry: DirEntryInfo) {
    setPreviewEntry(entry);
    setUserPickedPath(entry.path);
    if (entry.kind && PREVIEWABLE_KINDS.has(entry.kind) && !previewCache[entry.path]) {
      requestPreviewPriority(entry.path, generation.current);
    }
  }

  function handleEntryClick(entry: DirEntryInfo, ev: React.MouseEvent<HTMLElement>) {
    if (entry.is_dir) {
      // Click on the already-highlighted folder dismisses the popover.
      if (folderOverlay?.entry.path === entry.path) {
        setFolderOverlay(null);
        return;
      }
      const rect = ev.currentTarget.getBoundingClientRect();
      const fitsRight = rect.right + 10 + FOLDER_OVERLAY_WIDTH <= window.innerWidth;
      setFolderOverlay({
        entry,
        left: fitsRight ? rect.right + 10 : Math.max(8, rect.left - 10 - FOLDER_OVERLAY_WIDTH),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 190)),
      });
      return;
    }
    setFolderOverlay(null);
    activateEntry(entry);
  }

  function addableFiles(list: DirEntryInfo[]): DirEntryInfo[] {
    return list.filter((e) => !e.is_dir && e.can_add && !addedPaths.has(e.path));
  }

  async function startFolderMark(entry: DirEntryInfo) {
    setFolderOverlay(null);
    setActionBusy(true);
    try {
      const listing = await invoke<DirListing>("list_directory", { path: entry.path, recursive: false });
      const directFiles = listing.entries.filter((e) => !e.is_dir);
      if (listing.entries.some((e) => e.is_dir)) {
        setFolderPrompt({ step: "subfolders", entry, directFiles });
      } else {
        setFolderPrompt({ step: "confirm", entry, files: directFiles });
      }
    } catch (err) {
      showToast(String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function answerSubfolders(entry: DirEntryInfo, directFiles: DirEntryInfo[], includeSub: boolean) {
    if (!includeSub) {
      setFolderPrompt({ step: "confirm", entry, files: directFiles });
      return;
    }
    setActionBusy(true);
    try {
      const listing = await invoke<DirListing>("list_directory", { path: entry.path, recursive: true });
      setFolderPrompt({ step: "confirm", entry, files: listing.entries.filter((e) => !e.is_dir) });
    } catch (err) {
      setFolderPrompt(null);
      showToast(String(err));
    } finally {
      setActionBusy(false);
    }
  }

  function confirmFolderMark(files: DirEntryInfo[]) {
    const addable = addableFiles(files);
    setFolderPrompt(null);
    if (addable.length === 0) {
      showToast(t("browser.folderNothingToMark"));
      return;
    }
    collection.add(addable.map((e) => e.path));
    showToast(`${t("browser.folderMarkedToast")} (${addable.length})`);
  }

  // Toggles the "marked for add" state — triggered by double-click (on a
  // tile or on the preview panel) and by Space on the active entry, never
  // by a plain single click, which only changes the preview.
  function markEntryForAdd(entry: DirEntryInfo) {
    if (entry.is_dir) return;
    // In "remove" mode every listed file is already in the project, so the
    // three checks below — addable? not already added? — are all about a
    // staging step that doesn't exist here. A mark is just a mark.
    if (removeMode) {
      if (isMarked(entry.path)) collection.remove([entry.path]);
      else collection.add([entry.path]);
      return;
    }
    if (addedPaths.has(entry.path)) {
      showToast(t("browser.alreadyAddedToast"));
      return;
    }
    if (!entry.can_add) {
      showToast(t("browser.notAddable"));
      return;
    }
    if (isMarked(entry.path)) {
      // Unmarking has to clear both sources, since the mark may have been
      // made in the single-image view rather than here.
      picks?.remove(entry.path);
      collection.remove([entry.path]);
      return;
    }
    collection.add([entry.path]);
  }

  async function removePaths(paths: string[]) {
    if (paths.length === 0) return;
    if (deleteFilesOnRemove) {
      const confirmed = await confirm({
        title: t("viewer.confirmRemoveDeleteTitle"),
        body: `${tCount(paths.length, "fileOps.fileSelected", "fileOps.filesSelected")}. ${t("viewer.confirmRemoveDeleteBody")}`,
        confirmLabel: t("log.purgeSelected"),
      });
      if (!confirmed) return;
    }
    setActionBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.removedToast"), total: paths.length });
    try {
      await invoke("remove_items_by_source_paths", { paths, operationId });
      collection.remove(paths);
      onRemoved(paths, `${t(deleteFilesOnRemove ? "viewer.removedDeletedToast" : "browser.removedToast")} (${paths.length})`);
    } finally {
      setActionBusy(false);
      finishOperation(operationId);
    }
  }

  async function rotateEntry(path: string, delta: number) {
    try {
      const newRotation = await invoke<number>("rotate_path", { path, delta });
      setRotationOverrides((prev) => new Map(prev).set(path, newRotation));
    } catch {
      // not fatal — rotation just stays as it was
    }
  }

  function handleEntryDoubleClick(entry: DirEntryInfo) {
    if (entry.is_dir) {
      setFolderOverlay(null);
      onNavigateFolder?.(entry.path);
      return;
    }
    // The browser already fired a plain click right before this (setting
    // the preview) whether this was a double-click on an already-active
    // tile or a direct double-click on a fresh one — so this only ever
    // needs to toggle the mark.
    markEntryForAdd(entry);
  }

  const effectivePreviewWidth = contentWidth
    ? Math.min(previewWidth, Math.max(PREVIEW_MIN_PX, contentWidth - GRID_MIN_PX))
    : previewWidth;
  const tilePx = tileSizeForPreview(effectivePreviewWidth);

  const fullPreviewUrl =
    previewEntry && fullPreview?.path === previewEntry.path ? fullPreview.url : undefined;

  // "Already in project" covers both: the exact same path already added
  // (`addedPaths`, cheap/always known) and a different path whose content
  // matched something in the project (`projectDuplicatePaths`, the hash
  // check above) — either one means there's nothing left to do with this
  // tile, so both are hidden together.
  const visibleEntries = useMemo(() => {
    const afterKindFilter = showKindFilter ? entries.filter((e) => passesKindFilter(e, kindLanes)) : entries;
    return hideAlreadyInProject
      ? afterKindFilter.filter((e) => !addedPaths.has(e.path) && !projectDuplicatePaths.has(e.path))
      : afterKindFilter;
  }, [entries, showKindFilter, kindLanes, hideAlreadyInProject, addedPaths, projectDuplicatePaths]);

  useEffect(() => {
    onVisiblePathsChange?.(visibleEntries.filter((e) => !e.is_dir).map((e) => e.path));
  }, [visibleEntries, onVisiblePathsChange]);

  // A streamed listing starts empty, so the reset above found nothing to
  // pre-select; the first file that streams in takes that place instead.
  useEffect(() => {
    if (!entriesKey || previewEntry) return;
    const first = visibleEntries.find((e) => !e.is_dir);
    if (first) setPreviewEntry(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEntries]);

  // Same column count CSS's `repeat(auto-fill, minmax(tilePx, 1fr))`
  // produces, computed rather than read back from the DOM, since most
  // tiles are not rendered.
  const innerWidth = gridMetrics.width - gridMetrics.padX;
  const columns = Math.max(1, Math.floor((innerWidth + gridMetrics.gap) / (tilePx + gridMetrics.gap)));
  const columnWidth = innerWidth > 0 ? (innerWidth - (columns - 1) * gridMetrics.gap) / columns : tilePx;
  // Until a row has been measured: square thumbnail + name line + gaps.
  const stride = rowStride > 0 ? rowStride : columnWidth + 34 + gridMetrics.gap;
  const totalRows = Math.ceil(visibleEntries.length / columns);
  const firstRow = Math.max(0, Math.floor((scrollTop - gridMetrics.padTop) / stride) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + gridMetrics.height) / stride) + OVERSCAN_ROWS,
  );
  const windowStart = Math.min(visibleEntries.length, firstRow * columns);
  const windowEnd = Math.min(visibleEntries.length, lastRow * columns);
  const windowEntries = visibleEntries.slice(windowStart, windowEnd);
  // The spacers take the place of the unrendered rows; each is a grid item
  // of its own, so the row gap after it is subtracted from its height.
  const topSpacerPx = firstRow > 0 ? firstRow * stride - gridMetrics.gap : 0;
  const bottomSpacerPx = lastRow < totalRows ? (totalRows - lastRow) * stride - gridMetrics.gap : 0;

  /// Scrolls the grid so the entry at `index` (in `visibleEntries`) is in
  /// view — by arithmetic, since its tile may not be rendered.
  function scrollToIndex(index: number, block: "center" | "nearest") {
    const grid = gridRef.current;
    if (!grid || index < 0) return;
    const top = gridMetrics.padTop + Math.floor(index / columns) * stride;
    const bottom = top + stride - gridMetrics.gap;
    if (block === "center") {
      grid.scrollTop = Math.max(0, top - (grid.clientHeight - (stride - gridMetrics.gap)) / 2);
    } else if (top < grid.scrollTop) {
      grid.scrollTop = Math.max(0, top - gridMetrics.padTop);
    } else if (bottom > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = bottom - grid.clientHeight + gridMetrics.padTop;
    }
  }

  // Row height is measured as thumbnail + name of a rendered tile, not the
  // tile box itself: a grid row stretches every tile to its tallest one,
  // and a marked tile's date dropdown makes its row taller. Such rows just
  // push the rest of the window down a little, which the overscan absorbs.
  useLayoutEffect(() => {
    for (const thumb of tileElRefs.current.values()) {
      const tile = thumb.parentElement;
      const name = tile?.querySelector<HTMLElement>(".file-tile__name");
      if (!tile || !name) continue;
      const innerGap = parseFloat(getComputedStyle(tile).rowGap) || 0;
      const measured =
        thumb.getBoundingClientRect().height + innerGap + name.getBoundingClientRect().height + gridMetrics.gap;
      if (measured > gridMetrics.gap && Math.abs(measured - rowStride) > 0.5) setRowStride(measured);
      break;
    }
  });

  useLayoutEffect(() => {
    const path = pendingScrollPath.current;
    if (!path) return;
    const index = visibleEntries.findIndex((e) => e.path === path);
    if (index === -1) return;
    pendingScrollPath.current = null;
    scrollToIndex(index, "center");
  });

  // Thumbnails are generated only for the tiles in the window, in screen
  // order. Whatever was still queued from the previous window but never
  // started is dropped (and may be requested again once scrolled back).
  useEffect(() => {
    for (const path of previewQueue.current) requestedPreviews.current.delete(path);
    const queued = windowEntries
      .filter(
        (e) =>
          !e.is_dir &&
          e.kind &&
          PREVIEWABLE_KINDS.has(e.kind) &&
          // A path the caller already handed us a thumbnail URL for is
          // skipped entirely — see the `thumbnailUrls` prop.
          !thumbnailUrls?.has(e.path) &&
          !previewCacheRef.current[e.path] &&
          !requestedPreviews.current.has(e.path),
      )
      .map((e) => e.path);
    previewQueue.current = queued;
    for (const path of queued) requestedPreviews.current.add(path);
    drainPreviewQueue();
    // `windowEntries` is a fresh slice every render; its bounds and source
    // list are what actually identify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEntries, windowStart, windowEnd, thumbnailUrls, drainPreviewQueue]);
  // The preview panel shows the date the previewed file would be filed
  // under, so its candidates are read as soon as it is previewed.
  useEffect(() => {
    if (!active || removeMode || !previewEntry || previewEntry.is_dir || !previewEntry.can_add) return;
    void ensureDateInfos([previewEntry.path]);
  }, [active, removeMode, previewEntry]);
  const selectedAddable = visibleEntries.filter((e) => isMarked(e.path) && e.can_add && !addedPaths.has(e.path));
  const selectedAdded = visibleEntries.filter((e) => isMarked(e.path) && addedPaths.has(e.path));
  // Remove-mode's own version of `selectedAddable` — no `can_add`/
  // `addedPaths` filtering, since both are inert there (see the grid's own
  // comment on `can_add` in remove mode). Used by the "Datum ändern"
  // context-menu entry to apply to the whole marked batch, not just the
  // clicked tile.
  const selectedMarked = visibleEntries.filter((e) => isMarked(e.path));

  // Arrow keys move the active (previewed) tile through the grid; Space
  // marks whatever is currently active — so "arrow to pick, Space to mark"
  // works without ever touching the mouse. Column count is measured from
  // the actual rendered layout (how many tiles in a row share the first
  // tile's top offset) rather than assumed from CSS, so it stays correct
  // across panel-resize-driven column reflows.
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (isBrowserPeeking()) return;
      if (!active || visibleEntries.length === 0) return;
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || target?.isContentEditable) return;

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        // "Addable" is an import notion; in remove mode every visible file
        // is a valid target, so Ctrl+A means all of them — and a second
        // Ctrl+A clears them again, as the project tabs' checkbox does.
        const addable = removeMode ? visibleEntries.filter((e) => !e.is_dir) : addableFiles(visibleEntries);
        if (addable.length === 0) {
          showToast(t("browser.folderNothingToMark"));
          return;
        }
        if (removeMode && addable.every((e) => collection.has(e.path))) {
          collection.remove(addable.map((e) => e.path));
          return;
        }
        collection.add(addable.map((e) => e.path));
        showToast(`${t("browser.folderMarkedToast")} (${addable.length})`);
        return;
      }

      if (ev.key === "Escape" && folderOverlay) {
        setFolderOverlay(null);
        return;
      }

      if (ev.key === " " || ev.code === "Space") {
        if (!previewEntry) return;
        ev.preventDefault();
        markEntryForAdd(previewEntry);
        return;
      }

      const deltaByKey: Record<string, number> = {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: columns,
        ArrowUp: -columns,
      };
      const delta = deltaByKey[ev.key];
      if (delta === undefined) return;
      ev.preventDefault();

      const currentIndex = previewEntry ? visibleEntries.findIndex((e) => e.path === previewEntry.path) : -1;
      const nextIndex = Math.min(
        visibleEntries.length - 1,
        Math.max(0, currentIndex === -1 ? 0 : currentIndex + delta),
      );
      const nextEntry = visibleEntries[nextIndex];
      if (nextEntry) {
        activateEntry(nextEntry);
        scrollToIndex(nextIndex, "nearest");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `collection` and `picks` are listed because Space and Ctrl+A ask them
    // whether something is already marked: without them, a second press
    // read the marks from before the first one and couldn't undo it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, previewEntry, visibleEntries, addedPaths, folderOverlay, columns, stride, gridMetrics, collection, picks]);

  return (
    <>
      <div className="file-browser__toolbar">
        {toolbarLeft}
        {showKindFilter && (
          <div className="file-browser__kind-filter" role="group" aria-label={t("browser.kindFilterLabel")}>
            {KIND_LANE_ORDER.map((lane) => (
              <button
                key={lane}
                type="button"
                className={
                  "file-browser__kind-chip" + (kindLanes.has(lane) ? " file-browser__kind-chip--on" : "")
                }
                onClick={() => toggleKindLane(lane)}
                aria-pressed={kindLanes.has(lane)}
                title={t("browser.kindFilterHint")}
              >
                {t(KIND_LANE_LABEL_KEY[lane])}
              </button>
            ))}
          </div>
        )}
        {showAlreadyInProjectToggle && (
          <label className="file-tile-grid__already-in-project-toggle">
            <ToggleSwitch
              checked={hideAlreadyInProject}
              onChange={setHideAlreadyInProject}
              label={t("browser.hideAlreadyInProjectLabel")}
            />
            <HelpHint text={t("browser.hideAlreadyInProjectHint")} />
          </label>
        )}
        {!removeMode && selectedAdded.length > 0 && (
          <button className="btn btn--danger" onClick={() => removePaths(selectedAdded.map((e) => e.path))} disabled={actionBusy}>
            {`${t("browser.removeSelected")} (${selectedAdded.length})`}
          </button>
        )}
        {toolbarRight}
      </div>

      <div className="file-browser__content" ref={contentRef}>
        <div
          className="file-browser__grid"
          ref={gridRef}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tilePx}px, 1fr))` }}
          onScroll={(ev) => {
            // Quantized: the window only needs to move once a row has
            // scrolled by, not re-render on every pixel (the overscan
            // covers the difference).
            const quantized = Math.floor(ev.currentTarget.scrollTop / 32) * 32;
            if (quantized !== scrollTop) setScrollTop(quantized);
            if (folderOverlay) setFolderOverlay(null);
          }}
        >
          {visibleEntries.length === 0 && <div className="file-browser__empty">{emptyMessage}</div>}
          {topSpacerPx > 0 && <div style={{ gridColumn: "1 / -1", height: topSpacerPx }} aria-hidden="true" />}
          {windowEntries.map((entry) => {
            const previewable = Boolean(entry.kind && PREVIEWABLE_KINDS.has(entry.kind));
            // The "Im Projekt" badge is an import-flow signal — in remove
            // mode it would be on literally every tile, saying nothing.
            const badge =
              badges?.get(entry.path) ?? (!removeMode && addedPaths.has(entry.path) ? t("browser.added") : null);
            const thumb = thumbFor(entry.path);
            return (
              <div
                key={entry.path}
                className={
                  "file-tile" +
                  (isMarked(entry.path)
                    ? // Remove-mode marking (Datei-Operationen/Papierkorb) gets
                      // its own red, distinct from the gold "marked to add" —
                      // marking files here is a step toward removing/moving
                      // them, not adding them, and shouldn't look like the
                      // same action.
                      removeMode
                      ? " file-tile--selected-remove"
                      : " file-tile--selected"
                    : "") +
                  (!isMarked(entry.path) && previewEntry?.path === entry.path ? " file-tile--active" : "") +
                  (entry.is_dir ? " file-tile--dir" : "") +
                  (folderOverlay?.entry.path === entry.path ? " file-tile--folder-marked" : "")
                }
                onClick={(ev) => handleEntryClick(entry, ev)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (entry.is_dir) return;
                  setContextMenu({ x: ev.clientX, y: ev.clientY, entry });
                }}
              >
                <div
                  className="file-tile__thumb"
                  data-path={entry.path}
                  ref={(el) => {
                    if (el) tileElRefs.current.set(entry.path, el);
                    else tileElRefs.current.delete(entry.path);
                  }}
                >
                  {entry.is_dir ? (
                    <span className="file-tile__icon">📁</span>
                  ) : (entry.kind as string | null) === "diary" ? (
                    // The same picture the timeline shows for a diary entry.
                    <img src="/diary_entry.png" alt={entry.name} />
                  ) : previewable && thumb ? (
                    <img
                      src={thumb}
                      alt={entry.name}
                      style={
                        entry.kind === "image" && entryRotation(entry)
                          ? { transform: `rotate(${entryRotation(entry)}deg)` }
                          : undefined
                      }
                    />
                  ) : (
                    <span className="file-tile__icon">{iconForEntry(entry)}</span>
                  )}
                  {/* Same corner, same size, same shape as the add mode's ✓ —
                      only the colour and the glyph change, so the pattern
                      stays familiar while the meaning is unmistakable. */}
                  {isMarked(entry.path) && (
                    <span
                      className={
                        "file-tile__check" +
                        (removeMode ? " file-tile__check--remove" + (editIntent ? " file-tile__check--edit" : "") : "")
                      }
                      title={t(
                        removeMode
                          ? editIntent
                            ? "browser.markedForEdit"
                            : "browser.markedForBatch"
                          : "browser.markedForAdd",
                      )}
                    >
                      {removeMode ? (editIntent ? "🔧" : "−") : "✓"}
                    </span>
                  )}
                  {badge && <span className="file-tile__badge">{badge}</span>}
                </div>
                {!removeMode && !entry.is_dir && collection.has(entry.path) && !addedPaths.has(entry.path) && (
                  <DateChoiceSelect path={entry.path} />
                )}
                <div className="file-tile__name" title={entry.name}>
                  {entry.name}
                </div>
              </div>
            );
          })}
          {bottomSpacerPx > 0 && <div style={{ gridColumn: "1 / -1", height: bottomSpacerPx }} aria-hidden="true" />}
        </div>

        {previewEntry && (
          <div
            className="file-browser__splitter"
            onPointerDown={startResize}
            role="separator"
            aria-orientation="vertical"
            title={t("browser.resizePreview")}
          />
        )}

        {previewEntry && (
          <div
            className="file-preview-panel"
            style={{ width: effectivePreviewWidth }}
            {...previewDragOut}
            onDoubleClick={() => markEntryForAdd(previewEntry)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setContextMenu({ x: ev.clientX, y: ev.clientY, entry: previewEntry });
            }}
          >
            {previewEntry.kind === "audio" ? (
              mediaPreviewUrl && (
                <AudioPlayer
                  key={previewEntry.path}
                  src={mediaPreviewUrl}
                  autoPlay={!removeMode && userPickedPath === previewEntry.path}
                  className="file-preview-panel__audio"
                />
              )
            ) : previewEntry.kind === "video" ? (
              mediaPreviewUrl && (
                <VideoPlayer
                  key={previewEntry.path}
                  src={mediaPreviewUrl}
                  autoPlay={!removeMode && userPickedPath === previewEntry.path}
                  className="file-preview-panel__video"
                />
              )
            ) : previewEntry.kind === "email" && emailTexts[previewEntry.path] ? (
              // The mail's own opening lines, in place of the picture an
              // e-mail doesn't have. `pre-wrap` on the CSS side keeps the
              // body's own line breaks, which is most of what makes a
              // quoted reply readable at a glance.
              <div className="file-preview-panel__text">{emailTexts[previewEntry.path]}</div>
            ) : previewEntry.kind === "document" && documentTexts[previewEntry.path] ? (
              // .txt/.docx/.odt/.rtf have no renderable thumbnail — their
              // own extracted text stands in for the picture, same as a
              // mail's body does above. .pdf/.doc never reach here (the
              // backend returns no text for them), so they keep falling
              // through to the image branch below.
              <div className="file-preview-panel__text">{documentTexts[previewEntry.path]}</div>
            ) : (
              <div className="file-preview-panel__image" ref={previewImageBoxRef}>
                {previewEntry.kind === "image" && (fullPreviewUrl ?? thumbFor(previewEntry.path)) && (
                  <button
                    className="icon-btn file-preview-panel__zoom"
                    title={t("browser.zoomImageHint")}
                    aria-label={t("browser.zoomImage")}
                    onClick={() => setZoomOpen(true)}
                  >
                    🔍
                  </button>
                )}
                {previewEntry.kind &&
                PREVIEWABLE_KINDS.has(previewEntry.kind) &&
                (fullPreviewUrl ?? thumbFor(previewEntry.path)) ? (
                  <img
                    src={fullPreviewUrl ?? thumbFor(previewEntry.path)}
                    alt={previewEntry.name}
                    style={
                      previewEntry.kind === "image" && entryRotation(previewEntry)
                        ? { transform: `rotate(${entryRotation(previewEntry)}deg)` }
                        : undefined
                    }
                  />
                ) : (
                  <span className="file-tile__icon file-tile__icon--large">
                    {previewEntry.kind ? iconForEntry(previewEntry) : "📁"}
                  </span>
                )}
              </div>
            )}
            {zoomOpen && previewEntry.kind === "image" && (fullPreviewUrl ?? thumbFor(previewEntry.path)) && (
              <ImageZoomOverlay
                src={(fullPreviewUrl ?? thumbFor(previewEntry.path))!}
                rotation={entryRotation(previewEntry) ?? 0}
                onClose={() => setZoomOpen(false)}
              />
            )}
            {previewEntry.kind === "image" && (
              <div className="file-preview-panel__rotate">
                <button className="icon-btn" title={t("browser.rotateLeft")} onClick={() => rotateEntry(previewEntry.path, -90)}>
                  ↺
                </button>
                <button className="icon-btn" title={t("browser.rotateRight")} onClick={() => rotateEntry(previewEntry.path, 90)}>
                  ↻
                </button>
                <button className="icon-btn" title={t("browser.rotate180")} onClick={() => rotateEntry(previewEntry.path, 180)}>
                  ⟲
                </button>
              </div>
            )}
            <div
              className="file-preview-panel__name"
              title={mailHeader ? previewEntry.name : undefined}
            >
              {mailHeader
                ? mailHeader.subject || previewEntry.name
                : previewEntry.resolved_timestamp && mailHeader === null
                  ? formatDate(previewEntry.resolved_timestamp)
                  : previewEntry.name}
            </div>
            {/* For a mail this only appears when it would be filed under
                another date than the one it was sent on. */}
            {!removeMode &&
              !previewEntry.is_dir &&
              previewEntry.can_add &&
              !addedPaths.has(previewEntry.path) &&
              mailHeader !== undefined && (
                <div className="file-preview-panel__stamp">
                  <DateStamp path={previewEntry.path} hideIfShownAs={mailHeader?.date} />
                </div>
              )}
            {mailHeader ? (
              <dl className="file-preview-panel__meta">
                <dt>{t("email.sender")}</dt>
                <dd>{mailHeader.sender ?? "–"}</dd>
                <dt>{t("email.date")}</dt>
                <dd>{formatDate(mailHeader.date)}</dd>
                {previewEntry.resolved_timestamp != null &&
                  formatDate(previewEntry.resolved_timestamp) !== formatDate(mailHeader.date) && (
                    <>
                      <dt>{t("email.streamDate")}</dt>
                      <dd>{formatDate(previewEntry.resolved_timestamp)}</dd>
                    </>
                  )}
              </dl>
            ) : (
              mailHeader === null && (
                <dl className="file-preview-panel__meta">
                  {previewEntry.resolved_timestamp != null && (
                    <>
                      <dt>{t("browser.filename")}</dt>
                      <dd>{previewEntry.name}</dd>
                    </>
                  )}
                  <dt>{t("browser.created")}</dt>
                  <dd>{formatDate(previewEntry.fs_created_at)}</dd>
                  <dt>{t("browser.modified")}</dt>
                  <dd>{formatDate(previewEntry.fs_modified_at)}</dd>
                  <dt>{t("browser.size")}</dt>
                  <dd>{formatSize(previewEntry.size)}</dd>
                </dl>
              )
            )}
            {!previewEntry.can_add && <p className="file-preview-panel__hint">{t("browser.notAddable")}</p>}
          </div>
        )}
      </div>

      {folderOverlay && (
        <div
          className="folder-overlay"
          style={{ left: folderOverlay.left, top: folderOverlay.top, width: FOLDER_OVERLAY_WIDTH }}
          role="dialog"
          onClick={(ev) => ev.stopPropagation()}
        >
          <div className="folder-overlay__name" title={folderOverlay.entry.name}>
            📁 {folderOverlay.entry.name}
          </div>
          <div className="folder-overlay__text">{t("browser.folderMarkAllText")}</div>
          <div className="folder-overlay__hint">{t("browser.folderOpenHint")}</div>
          <div className="folder-overlay__actions">
            <button className="btn btn--primary" disabled={actionBusy} onClick={() => startFolderMark(folderOverlay.entry)}>
              {t("browser.folderMarkButton")}
            </button>
            <button className="btn" onClick={() => setFolderOverlay(null)}>
              {t("browser.folderCancel")}
            </button>
          </div>
        </div>
      )}

      {folderPrompt && (
        <div className="modal-overlay" onMouseDown={() => setFolderPrompt(null)}>
          <div className="modal-card" onMouseDown={(ev) => ev.stopPropagation()}>
            {folderPrompt.step === "subfolders" ? (
              <>
                <h2 className="modal-card__title">{t("browser.folderSubfoldersTitle")}</h2>
                <p className="modal-card__body">{folderPrompt.entry.name}</p>
                <div className="modal-card__actions">
                  <button
                    className="btn"
                    disabled={actionBusy}
                    onClick={() => answerSubfolders(folderPrompt.entry, folderPrompt.directFiles, false)}
                  >
                    {t("browser.folderNo")}
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={actionBusy}
                    onClick={() => answerSubfolders(folderPrompt.entry, folderPrompt.directFiles, true)}
                  >
                    {t("browser.folderYes")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="modal-card__title">{t("browser.folderConfirmTitle")}</h2>
                <p className="modal-card__body">
                  {`${folderPrompt.entry.name}: ${addableFiles(folderPrompt.files).length} ${t("browser.folderConfirmFiles")}`}
                </p>
                <div className="modal-card__actions">
                  <button className="btn" onClick={() => setFolderPrompt(null)}>
                    {t("browser.folderCancel")}
                  </button>
                  <button className="btn btn--primary" onClick={() => confirmFolderMark(folderPrompt.files)}>
                    {t("browser.folderConfirmAll")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <>
          <div className="file-browser__menu-scrim" onMouseDown={() => setContextMenu(null)} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button
              className="context-menu__item"
              onClick={async () => {
                setContextMenu(null);
                try {
                  await invoke<boolean>("open_path_checked", { path: contextMenu.entry.path });
                } catch {
                  showToast(t("browser.openExternallyFailed"));
                }
              }}
            >
              {t("browser.openExternally")}
            </button>
            {onRevealInFolder && (
              <RevealInFolderItems path={contextMenu.entry.path} onDone={() => setContextMenu(null)} />
            )}
            {/* An import action, so it has no place in the project tabs. */}
            {!removeMode && (
              <SendToProjectItems
                paths={
                  isMarked(contextMenu.entry.path) && selectedAddable.length > 1
                    ? selectedAddable.map((e) => e.path)
                    : [contextMenu.entry.path]
                }
                onDone={() => setContextMenu(null)}
              />
            )}
            {/* The reverse case: only meaningful for files already in the
                project (a `resolved_timestamp` to edit), so only offered
                in remove mode (Datei-Operationen/Papierkorb). */}
            {removeMode && renderContextActions && (
              <>
                {contextMenu.entry.kind === "image" && (
                  <>
                    <button className="context-menu__item" onClick={() => { void rotateEntry(contextMenu.entry.path, -90); setContextMenu(null); }}>
                      ↺ {t("browser.rotateLeft")}
                    </button>
                    <button className="context-menu__item" onClick={() => { void rotateEntry(contextMenu.entry.path, 90); setContextMenu(null); }}>
                      ↻ {t("browser.rotateRight")}
                    </button>
                    <button className="context-menu__item" onClick={() => { void rotateEntry(contextMenu.entry.path, 180); setContextMenu(null); }}>
                      ⟲ {t("browser.rotate180")}
                    </button>
                    <div className="context-menu__divider" />
                  </>
                )}
                {renderContextActions(
                  isMarked(contextMenu.entry.path) && selectedMarked.length > 1
                    ? selectedMarked.map((e) => e.path)
                    : [contextMenu.entry.path],
                  () => setContextMenu(null),
                )}
              </>
            )}
            {removeMode && onChangeDate && !renderContextActions && (
              <button
                className="context-menu__item"
                onClick={() => {
                  const paths =
                    isMarked(contextMenu.entry.path) && selectedMarked.length > 1
                      ? selectedMarked.map((e) => e.path)
                      : [contextMenu.entry.path];
                  setContextMenu(null);
                  onChangeDate(paths);
                }}
              >
                {t("browser.changeDate")}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
