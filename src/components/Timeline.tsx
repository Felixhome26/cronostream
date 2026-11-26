import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { invoke } from "../busy";
import { listItems } from "../types";
import type {
  HoverZoomBrake,
  ItemInfo,
  PhaseGroupView,
  PhaseSaveOutcome,
  PhaseView,
  PileAction,
  PileTrigger,
  ViewerNavMode,
  ViewerNavType,
} from "../types";
import { currentLanguage, t, type Language } from "../i18n";
import { canWebviewDecode, decodedOriginalUrl, fileUrl, loadMediaServerInfo, mediaUrl, type MediaServerInfo } from "../utils/mediaServer";
import WildcardIcon from "./WildcardIcon";
import { useFileDragOut } from "../hooks/useFileDragOut";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import { useToast } from "../ToastContext";
import { useConfirm } from "../ConfirmContext";

/// The empty-state picture, one per UI language (the category labels are
/// part of the image). All three share the same 1024² canvas with the panel
/// at the same spot, so switching languages doesn't shift the layout.
const EMPTY_TEASER_SRC: Record<Language, string> = {
  de: "/startteaser_DE_final.png",
  en: "/startteaser_EN.png",
  es: "/startteaser_ES.png",
};

const DRAG_ICON_EMOJI: Record<string, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎧",
  document: "📄",
  email: "✉️",
  other: "*",
};
import type { DiaryRequest, FileViewRequest } from "./DiaryDialog";
import { readClipboardImage } from "../utils/clipboardImage";
import { toDatetimeLocalValue } from "../utils/datetime";
import SearchBar from "./SearchBar";
import { buildClusterTree, cutClusterTree, splitGroupsBy, type ClusterNode } from "../utils/clusterTree";
import { useTheme } from "../theme";
import { warpPointerTo } from "../utils/fanCursor";
import type { KindLane } from "../utils/fileKindLane";
import { formatDay } from "../utils/phases";
import { useWelcomeOpen } from "../utils/welcome";
import {
  PHASE_BAR_MIN_WIDTH,
  buildPhaseRows,
  phaseAreaShownHeight,
  phaseBarHeight,
  phaseBarTop,
  phaseContentHeight,
  type PhaseRowPhase,
} from "../utils/phaseLayout";
import {
  DAY_LABEL_FULL_MIN_PX,
  DAY_MS,
  HOUR_MS,
  MARKER_PERIOD_DAYS,
  columnLevel,
  formatWeekLabel,
  gridLevel,
  hasTimeIn,
  labelPeriod,
  nextLevel,
  previewGridOpacity,
  periodKeyForLevel,
  startOfDay,
  startOfHour,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type ZoomLevel,
} from "../utils/timeline/calendar";
import {
  BADGE_MIN_MEMBERS,
  EDGE_PADDING,
  GROUP_MAX_SPAN_PX,
  MAX_LANE_TILE_SCALE,
  STACK_DEPTH,
  STACK_STEP_X,
  STACK_STEP_Y,
  TILE_SIZE,
  computeFitPxPerDay,
  groupDissolvePxPerDay,
  isolatePxPerDay,
  maxPxPerDayFor,
  stackIndexIn,
  type GroupInfo,
} from "../utils/timeline/geometry";
import {
  ALL_NAV_TYPES,
  CLUSTER_FILTER_STORAGE_KEY,
  LANE_LABEL_KEY,
  buildLaneLayout,
  labelKeepsName,
  laneCenterPercent,
  laneForFileType,
  loadClusterTypeFilter,
  normalizeLaneOrder,
  presentLanesOf,
  type FileTypeFilter,
  type LaneType,
} from "../utils/timeline/lanes";
import { effectiveName, emailSenderAddress, formatMetaDate, isSpreadsheetFile } from "../utils/timeline/itemText";
import SearchResultsList from "./timeline/SearchResultsList";
import SelectionBar from "./timeline/SelectionBar";
import TileContextMenu, { type ContextMenuState } from "./timeline/TileContextMenu";
import TrackContextMenu, { type TrackMenuState } from "./timeline/TrackContextMenu";
import {
  PhaseBarMenu,
  PhaseGroupMenu,
  PhasePopover,
  PhaseReturnChip,
  type PhaseMenuState,
  type PhasePopoverState,
} from "./timeline/PhaseMenus";
import ClusterOverlay, { type ClusterSource } from "./timeline/ClusterOverlay";
import ThumbImg from "./timeline/ThumbImg";
import TimelineViewer from "./timeline/TimelineViewer";
import { ErrorBoundary } from "../ErrorBoundary";
import { useViewerEdits } from "./timeline/useViewerEdits";

// Multiplicative step per wheel notch / keypress once the image viewer has
// broken out of its frame, and the cap on how far that can go (600% of the
// viewport height — comfortably past any plausible "inspect a detail" zoom
// without letting it run away unbounded).
const FREED_ZOOM_STEP = 1.15;
const FREED_MAX_SCALE = 6;

// Keeps the freed image's pan offset within whatever range still leaves the
// viewport fully covered at the given scale — called both while dragging
// and after every zoom step, since zooming out shrinks the image and what
// used to be a valid pan can suddenly overshoot the (now smaller) bounds.
// Without re-clamping here, panning out from a dragged-away detail just
// keeps the same raw pixel offset as the image shrinks underneath it,
// sliding it off toward whichever corner it was last dragged to instead of
// settling back toward center.
function clampFreedPan(scale: number, aspect: number | null, x: number, y: number): { x: number; y: number } {
  if (!aspect) return { x: 0, y: 0 };
  const heightPx = scale * window.innerHeight;
  const widthPx = heightPx * aspect;
  const maxX = Math.max(0, (widthPx - window.innerWidth) / 2);
  const maxY = Math.max(0, (heightPx - window.innerHeight) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}
// Phase bars above the lanes (see utils/phaseLayout): a fixed share of the
// largest tile the lane layout can draw (about 20 px), so the bars keep
// their proportion to the tiles of a single-lane stream.
const PHASE_BAR_HEIGHT = phaseBarHeight(TILE_SIZE * MAX_LANE_TILE_SCALE);
// Gap between a Themenbereich label and a bar title slid in next to it.
const PHASE_TITLE_LABEL_GAP = 8;
// The fixed label column at the timeline's left edge: space around the
// longest label on each side, and the most it may grow to.
const LABEL_COL_INSET = 8;
// Width of the quick-toggle arrow in front of the first Themenbereich; every
// topic label is indented by the same amount (keep in step with App.css).
const LABEL_INDENT = 20;
const LABEL_COL_MAX = 240;
// Hover popover timing: a short wait before the first one opens (so sweeping
// across the area doesn't flash popovers), none when moving from one bar to
// the next, and a grace period on leaving so the gap between two bars
// doesn't close and reopen it.
const PHASE_POPOVER_OPEN_MS = 250;
const PHASE_POPOVER_CLOSE_MS = 120;
// Keeps the popover off the window edges.
const PHASE_POPOVER_MARGIN = 8;
// Zoom-to-phase (a click on a bar): the phase fills the window less this
// share on either side, and the move there takes this long.
const PHASE_ZOOM_MARGIN = 0.05;
const PHASE_ZOOM_MS = 450;
// Pointer travel between press and release below which a press on a bar is
// a click (zoom to it) rather than the start of a pan.
const PHASE_CLICK_SLOP_PX = 4;
// How much of the track is kept mounted, measured in viewport widths on
// each side of the visible region, and how close the visible region may
// get to that window's edge before it is recomputed. Mounting the whole
// track is what made a multi-decade archive unusable: at Day level the
// period markers alone are one gridline plus one label per day of the
// entire range, and `items.map` never cared how far off-screen a tile
// was. The margin also covers tiles whose resting layout pushes them
// INWARD from just outside the window — a tile's displacement from its
// own date is bounded by its period, which the level thresholds keep at
// or below one viewport width (see nextLevel). With 1.5 of margin and a
// 1.0 refresh trigger there is half a viewport of slack, so panning
// re-renders about once per half screen instead of once per frame.
const RENDER_MARGIN_VIEWPORTS = 1.5;
// Hard ceiling on how many period markers one pass may produce. The window
// the loops run over is a few viewports wide, so a healthy pass draws well
// under a hundred; this only catches the case where the window and the zoom
// have come out of step for a render (see ensureRenderWindow). Without it
// that disagreement reaches the DOM as hundreds of thousands of nodes.
const MAX_MARKERS = 1000;
const RENDER_REFRESH_VIEWPORTS = 1;
const BASE_MIN_SCALE = 0.72;
const BASE_MAX_SCALE = 1.35;
const HOVER_SCALE = 2;
/* Fish-eye dimming: tiles away from the viewport centre fade towards this
   floor. It used to be 0.55, which over the backdrop photo left the outer
   third of the timeline barely distinguishable from the background — the
   depth cue was reading as "broken thumbnail". The spread below it is what
   carries the effect; the floor only decides how far it is allowed to go. */
const FISHEYE_MIN_OPACITY = 0.74;
const FISHEYE_OPACITY_SPREAD = 1 - FISHEYE_MIN_OPACITY;
// Margin kept clear inside the viewport. Vertical containment is absolute:
// no tile may leave the viewport's top or bottom, since there's no vertical
// scrolling to recover whatever gets cut off. Horizontal overflow is
// tolerated by contrast for resting tiles — the track scrolls, so a tile
// hanging off an edge stays reachable — but not for an open pile, which is
// an overlay with nothing to scroll to.
const EDGE_MARGIN = 16;

// Pointer tolerance around the open pile card, and around the corridor from
// where it was opened to where it rendered. Just enough slack to cross a
// gap without the pile collapsing, and no more — see checkClusterStillHovered.
const PILE_HOVER_MARGIN = 16;
// Hover intent before a cluster fans out. Opening on the bare mouseenter
// meant a single sweep across the timeline opened and collapsed every
// cluster it crossed, which reads as the whole surface twitching. Closing
// stays fast (see scheduleClusterClose) — only opening waits.
//
// Raised from 150ms when a click on a stack became "zoom into this group":
// both gestures start from the same pointer position, so at 150ms the pile
// had always opened before a deliberate click could land and the stack
// itself was never clickable. A dwell this long reads as "I am looking at
// this", which is what the preview is for, while a press-and-release still
// gets through to the stack first.
const FAN_OPEN_DELAY_MS = 400;
// How far the pointer must travel before the "step" hover-zoom brake lets
// another zoom through. Comfortably more than the jitter of a hand resting
// on the mouse, and well under the width of a tile, so one deliberate nudge
// toward the stack is enough to take the next step.
const STEP_REARM_PX = 24;
// A hair past the zoom at which a group comes apart — exactly at the
// threshold it still holds together. Used by both ways of resolving a
// group: a click on the stack, and a jump to a search hit buried in one.
const STACK_ZOOM_OVERSHOOT = 1.08;
// How long after the last wheel/pan event tile transitions stay disabled.
// Just above one 60Hz frame interval times a few, so a continuous gesture
// never re-enables them mid-stream.
const INTERACTION_IDLE_MS = 140;
// Hover-driven magnify/fan-out is suppressed for this long after the last
// wheel-zoom or pan tick — long enough that a tile sliding under a
// momentarily-still cursor mid-gesture can't register as a fresh hover.
const HOVER_SUPPRESS_MS = 500;

// Frame-time profiling of scroll/zoom gestures — a diagnostic, compiled out
// of release builds entirely (see startFrameProfile). At 120Hz this caps one
// gesture's recording at ~10s, far longer than any real one.
const FRAME_PROFILE_ENABLED = import.meta.env.DEV;
const FRAME_SAMPLE_CAP = 1200;

/// Where a tile (or a whole group, sharing one) comes to rest in track
/// space. Resolved per lane in applyFishEye, which needs every box in a lane
/// at once to keep them inside their periods and off each other.
interface RestingBox {
  left: number;
  /// Width of the tile itself; the cascade of a group adds to the box but
  /// not to this.
  tileWidth: number;
  /// Total extent including the cascade — what must not overlap.
  extent: number;
  laneScale: number;
}

/// One resolved box plus what the collision pass needs to re-clamp it. The
/// period is held as two numbers and a flag rather than a nested object so a
/// pooled entry can be refilled without allocating — see entryPoolRef.
interface RestingEntry {
  key: string;
  anchorX: number;
  box: RestingBox;
  hasBounds: boolean;
  boundsStart: number;
  boundsEnd: number;
}

/// Sink for the profiler's output: the debug.log file. Not console.* — this
/// webview does not forward its console to the dev terminal (measured), so a
/// console report would be invisible.
function frameProfileLog(message: string) {
  invoke("debug_log", { message }).catch(() => {});
}

interface TimelineProps {
  refreshToken: number;
  /** Bumped when private files get hidden, see `ProjectShell`. What is open
   *  and points at one of them closes once the reload has shown which. */
  privacyHideToken?: number;
  /** Whether the search bar is showing. Toggled from the project topbar
   *  (see `ProjectShell`), but the search itself lives here: this is where
   *  the items, their thumbnails and the scroll/zoom internals a
   *  "jump to the hit" needs already are. */
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  /** Optional feature (Settings dialog, off by default): when false, tiles
   *  can't be dragged to a new date and a drag over a tile pans the
   *  timeline instead. */
  tileDragEnabled?: boolean;
  /// True while a full-screen overlay (the file browser) covers the
  /// timeline: global shortcuts like Ctrl+A must not act on hidden tiles.
  keyboardSuspended?: boolean;
  /** Asks the shell to open the diary dialog (right-click on empty timeline,
   *  a diary tile's pencil, Ctrl+V with an image). */
  onDiaryRequest?: (request: DiaryRequest) => void;
  /** An item to open in the detail view as soon as it has loaded (a pasted image). */
  openItemId?: string | null;
  onOpenItemHandled?: () => void;
  /** Diary attachments to show in the viewer or as a temporary cluster. */
  fileViewRequest?: FileViewRequest | null;
  onFileViewHandled?: () => void;
  /** The diary attachment view (cluster and viewer) has been closed. */
  onFileViewClosed?: () => void;
  /** Settings dialog, on by default: shows the item's timeline timestamp
   *  as a subtle overlay along the bottom of the detail viewer's media. */
  timestampOverlayEnabled?: boolean;
  /** Settings, "Navigation in der Detailansicht": which files prev/next
   *  steps through. Defaults to everything, the viewer's original behaviour. */
  viewerNavMode?: ViewerNavMode;
  viewerNavTypes?: ViewerNavType[];
  /** Settings, "Stapel": what opening a stack does, what opens it, and the
   *  brake for hover + zoom. See the types for each one's meaning; the
   *  defaults reproduce the timeline's long-standing behaviour (hover fans
   *  a stack out, a click zooms into it). */
  pileAction?: PileAction;
  pileTrigger?: PileTrigger;
  hoverZoomBrake?: HoverZoomBrake;
  /** Settings: place the real pointer on the focused tile when a stack fans
   *  out. Does nothing where the window system refuses it. */
  fanCursorFollow?: boolean;
  /** Settings, "Stapel & Zoom": whether the week grid and the hour grid are
   *  drawn at all. Both on reproduces the five levels the timeline has
   *  always had; see `gridLevel` for what switching one off does. */
  showWeekGrid?: boolean;
  showHourGrid?: boolean;
  /** Settings, "Stapel & Zoom": the wheel opens the detail viewer from a
   *  stack's preview (one step forward) and closes it again (several steps
   *  back in a row). On by default. */
  wheelViewer?: boolean;
  /** Settings, "Spuren": the four type groups top to bottom. Holds all
   *  four; which lanes actually get drawn follows from what the stream
   *  holds. Defaults to the order the timeline has always used. */
  laneOrder?: KindLane[];
  /** Settings, "Arbeitskopie beim Entfernen löschen": a removal then deletes
   *  the copy for good, so it asks first and says so afterwards. */
  deleteFilesOnRemove?: boolean;
  /** Shows a short message in the project shell's toast. Used to point at
   *  the Protokoll tab after a removal, which no longer asks first. */
  onToast?: (message: string) => void;
  /** Fires whenever the live per-category item counts change (add/remove/
   *  undo), so the project shell's header can show a running breakdown
   *  without needing its own separate fetch that could drift out of sync
   *  with what's actually on the timeline. */
  onCategoryCountsChange?: (counts: CategoryCounts) => void;
  /** Same action as the project shell's "+" FAB — opens the file browser
   *  on the add tab. Wired to the "+" in the empty-state teaser so it's
   *  not just decorative there. */
  onAddFiles?: () => void;
  /** Hands the given item ids off to "Datei-Operationen" — fired by the
   *  floating "Ändern"-button/context-menu entry that appears once a
   *  Ctrl-click selection (see selectedIds) isn't empty. The project shell
   *  opens the browser there and pre-marks exactly these ids. */
  onSendSelectionToFileOps?: (ids: string[]) => void;
  /** The stream's Themenbereiche (see usePhaseGroups). Drawn as bars
   *  above the lanes — only the phases whose own `visible` is on. */
  phaseGroups?: PhaseGroupView[];
  /** Refetches the phase list after the bar's context menu changed one,
   *  the same reload the management dialog does. */
  onPhaseGroupsChanged?: () => Promise<void>;
}

/// One phase bar as mounted for the current zoom and render window. `left`
/// is in track space (like `trackX`), already clipped to the window, so it
/// is never wider than a few viewports however long the phase is.
interface PhaseBar {
  entry: PhaseRowPhase;
  left: number;
  width: number;
  top: number;
  /** The phase begins before the axis' first day / ends after its last. */
  cutStart: boolean;
  cutEnd: boolean;
}

/// A view to come back to: the zoom and the date at the window's centre —
/// a date rather than a pixel offset, so it survives the axis changing.
interface SavedView {
  pxPerDay: number;
  centerMs: number;
}

const NO_PHASE_GROUPS: PhaseGroupView[] = [];

/** Live file-count breakdown by category, for the header's status line.
 *  "email" items fold into `document` (there's no separate lane or UI
 *  category for them), and items with an unparseable date — filtered out
 *  of `items` but still present in the project — fold into `other`. */
export interface CategoryCounts {
  image: number;
  video: number;
  audio: number;
  document: number;
  other: number;
}

interface Marker {
  key: string;
  x: number; // separator line position (period start)
  labelX: number; // label position (period center) — independent of x
  label: string;
  /// What the pinned label at the left edge says while this period is the
  /// one being looked at. Separate from `label` because that one is left
  /// empty where a gridline must not carry text — at day level only every
  /// third hour is labelled, and the pinned one has to name every period.
  full: string;
  major: boolean;
}

// Which pile is open, how many of its members the grid shows (always the
// group's first `count` members, in chronological order, as
// clusterByItemId holds them — currently all of them), which one is focused
// at open time, and where the pointer was when it opened.
//
// anchorX/anchorY are viewport (clientX/clientY) coordinates, like the pile
// card's own getBoundingClientRect() — checkClusterStillHovered compares
// them directly, with no coordinate conversion in between.
interface OpenFan {
  key: string;
  count: number;
  focusId: string;
  anchorX: number;
  anchorY: number;
}

const ZOOM_HINT_DISMISSED_KEY = "cronostream.onboarding.zoomHintShown";
// Same versioning idea as the other one-shot hints (see
// SingleImageView's KEYS_HINT_VERSION) — bump to re-show after a wording
// change.
const ZOOM_HINT_VERSION = "1";
// Guards against React's dev-mode double-invoke firing the toast twice for
// the same mount (see SingleImageView's identical `keysHintShownThisSession`).
let zoomHintShownThisSession = false;

export default function Timeline({
  refreshToken,
  privacyHideToken = 0,
  tileDragEnabled = false,
  keyboardSuspended = false,
  onDiaryRequest,
  openItemId,
  fileViewRequest,
  onFileViewHandled,
  onFileViewClosed,
  onOpenItemHandled,
  timestampOverlayEnabled = true,
  viewerNavMode = "all",
  viewerNavTypes = ALL_NAV_TYPES,
  pileAction = "fan",
  pileTrigger = "click",
  hoverZoomBrake = "click_only",
  fanCursorFollow = false,
  showWeekGrid = true,
  showHourGrid = true,
  wheelViewer = true,
  laneOrder: laneOrderProp,
  deleteFilesOnRemove = false,
  searchOpen = false,
  onCloseSearch,
  onToast,
  onCategoryCountsChange,
  onAddFiles,
  onSendSelectionToFileOps,
  phaseGroups = NO_PHASE_GROUPS,
  onPhaseGroupsChanged,
}: TimelineProps) {
  // The document placeholder has its own backdrop baked in: black for the
  // dark theme, sand for the light one.
  const scrollIcon = useTheme() === "light" ? "/scroll_light.jpeg" : "/scroll.jpeg";
  const [items, setItems] = useState<ItemInfo[]>([]);
  // Connection details for the app's own loopback file server. Loaded once;
  // every thumbnail URL is then built from it synchronously.
  const [mediaServer, setMediaServer] = useState<MediaServerInfo | null>(null);
  // Whether the very first `list_items` call for this mounted Timeline has
  // resolved yet.
  const [itemsFetched, setItemsFetched] = useState(false);
  const [pixelsPerDay, setPixelsPerDay] = useState(6);
  // The zoom's own five steps, as `nextLevel` derives them from
  // pixelsPerDay — and `level`, the one everything below reads: the same
  // step with the two optional grids of the settings applied (see
  // `gridLevel`). Kept apart so the thresholds and their hysteresis never
  // depend on the settings, and flipping a switch re-derives the grid at the
  // current zoom without a zoom step.
  const [zoomLevel, setLevel] = useState<ZoomLevel>("overview");
  const level = gridLevel(zoomLevel, showWeekGrid, showHourGrid);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Mirrors the scroll container's width as React state. applyFishEye can
  // read clientWidth directly whenever it runs, but the render pass needs
  // the width too (layout mode, mounting window) and must re-run when it
  // changes — which a ref can't trigger.
  const [viewportWidth, setViewportWidth] = useState(0);
  // Height of the phase area and the lanes together (the scroll container
  // minus the period header) — what the phase area's cap is a share of.
  // Measured alongside viewportWidth; it doesn't move when the phase area
  // grows or shrinks, since the lanes take up exactly the difference.
  const [stackHeight, setStackHeight] = useState(0);
  // Items whose resolved_timestamp doesn't parse are dropped from `items`
  // outright (see reloadItems); counted here so the UI can still admit they
  // exist instead of losing them silently.
  const [invalidDateCount, setInvalidDateCount] = useState(0);
  // Track-space px range that is currently mounted — see
  // ensureRenderWindow. null means "not measured yet", which mounts
  // everything (correct, just slow, and only for the first frame).
  const [renderWindow, setRenderWindow] = useState<{ min: number; max: number } | null>(null);
  // The open fan: which cluster, and how many of its members the grid shows.
  const [openFan, setOpenFanState] = useState<OpenFan | null>(null);
  // Which member the hero currently shows — set from the grid tile's own
  // onMouseEnter.
  const [fanFocusId, setFanFocusId] = useState<string | null>(null);
  // Whether the pile grid has content below the fold right now — drives the
  // bottom fade hint. Recomputed on scroll and whenever the grid's own size
  // changes (open, resize, filter-driven count change).
  const [pileGridHasMore, setPileGridHasMore] = useState(false);
  const [viewerItem, setViewerItem] = useState<ItemInfo | null>(null);
  const [viewerDataUrl, setViewerDataUrl] = useState<string | null>(null);
  // Dragging the shown file out of the viewer into other applications.
  const showToast = useToast();
  const confirm = useConfirm();
  // Set while a removal is running: a held or repeated Entf would otherwise
  // remove the same item again instead of the one the viewer moved on to.
  const removeInFlightRef = useRef(false);
  const viewerDragOut = useFileDragOut(viewerItem?.stored_path, {
    emoji: viewerItem ? DRAG_ICON_EMOJI[viewerItem.file_type] ?? "📄" : undefined,
    onError: (err) => {
      invoke("debug_log", { message: `file drag-out failed for ${viewerItem?.stored_path}: ${String(err)}` }).catch(() => {});
      showToast(t("timeline.dragFailed"));
    },
  });
  const [viewerText, setViewerText] = useState<string | null>(null);
  // Sanitised HTML body of an e-mail item, fetched fresh from the stored
  // original on open (see `get_item_email_html`) — `null` while loading or
  // when the mail has no genuine HTML part, in which case `viewerText`
  // (loaded the same way as for any other document) is shown instead.
  const [viewerEmailHtml, setViewerEmailHtml] = useState<string | null>(null);
  const [viewerEmailRecipients, setViewerEmailRecipients] = useState<{ to: string[]; cc: string[] } | null>(null);
  const [viewerEmailAttachments, setViewerEmailAttachments] = useState<{ index: number; name: string; size: number }[]>([]);
  // Set only when the open viewer was reached through the year-cluster
  // grid: the type filter active there at the time, carried along so
  // goToAdjacent keeps skipping the same disabled types while stepping
  // through — see openViewer/goToAdjacent. Null means "no filter", the
  // viewer's normal behaviour when opened any other way. The search
  // cluster passes viewerNavScope below instead, which supersedes this.
  const [viewerNavFilter, setViewerNavFilter] = useState<FileTypeFilter | null>(null);
  // Set only when the open viewer was reached through the search cluster:
  // the ids that cluster was showing at the time. While it is set the
  // viewer's arrows stay inside that set — see navPoolFor. Null means
  // "unscoped", the viewer's normal behaviour when opened any other way.
  const [viewerNavScope, setViewerNavScope] = useState<Set<string> | null>(null);
  // The types picked with the viewer's own filter popover; null until the
  // first toggle, i.e. the setting-based default is in force. Unlike the
  // two above it survives stepping and is dropped when the viewer closes.
  const [viewerNavOverride, setViewerNavOverride] = useState<ViewerNavType[] | null>(null);
  // The cluster overlay (see the "Cluster" block in the render): which set
  // of items is open (null = closed), the persisted type-filter
  // checkboxes, and which small tile's preview the enlarged hero tile is
  // currently showing (null = none hovered yet, falls back to the first
  // filtered item of the cluster).
  const [clusterSource, setClusterSource] = useState<ClusterSource | null>(null);
  const [clusterTypeFilter, setClusterTypeFilter] = useState<FileTypeFilter>(() => loadClusterTypeFilter());
  const [clusterHoverId, setClusterHoverId] = useState<string | null>(null);
  const [virtualItems, setVirtualItems] = useState<ItemInfo[]>([]);
  // Recipient addresses for an e-mail item, fetched on demand — unlike
  // email_sender/email_subject (shipped with every item, see ItemInfo),
  // the "to" list isn't stored in the database at all; get_item_email_
  // recipients re-parses the file itself. Keyed by item id, `null` once
  // fetched with no "to" address, `undefined` (absent) before the fetch
  // lands at all. See the effect below for what triggers a fetch.
  const [emailRecipients, setEmailRecipients] = useState<Record<string, string | null>>({});
  const emailRecipientsRequested = useRef<Set<string>>(new Set());
  // Image zoom: scrolling into the image breaks it out of the framed detail
  // card into a borderless layer sized relative to the viewport (`freed`),
  // which can be dragged around and zoomed further. Scrolling back out below
  // the baseline (freedScale 1 == 100% viewport height) collapses it back
  // into the frame, same as Escape or a click beside the image.
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [freed, setFreed] = useState(false);
  const [freedScale, setFreedScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  // Derived from imgNatural/rotation — needed early (effect deps, zoom/pan
  // clamping) rather than down by the JSX, which is why it isn't computed
  // inline there like freedHeightPx/freedFrameStyle are.
  const freedSwapped = viewerItem?.rotation === 90 || viewerItem?.rotation === 270;
  const freedAspect = imgNatural ? (freedSwapped ? imgNatural.h / imgNatural.w : imgNatural.w / imgNatural.h) : null;
  // The detail view's name, date and note drafts (see useViewerEdits). The
  // parts the timeline itself needs — resetting them when another file is
  // shown, and the keyboard guards — are taken out under their old names.
  const viewerEdits = useViewerEdits({ viewerItem, setItems, setViewerItem, showToast });
  const {
    setNameDraft,
    nameEditing,
    setNameEditing,
    setNameError,
    dateEditing,
    setDateDraft,
    setDateEditing,
    setNoteDraft,
    flushNote,
  } = viewerEdits;
  // Every other item whose note is the exact same (trimmed) text as the one
  // currently open in the viewer — whether that came from "Notiz
  // hinzufügen" in Datei-Operationen or just from typing the same note
  // twice by hand. `[]` whenever the note is empty or unique, which is what
  // makes the note read-only/non-clickable below: sharing it with at least
  // one other file is the whole point of a cluster.
  const noteClusterIds = useMemo(() => {
    const trimmed = viewerItem?.note?.trim();
    if (!viewerItem || !trimmed) return [];
    return items.filter((i) => i.note?.trim() === trimmed).map((i) => i.id);
  }, [items, viewerItem]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Ctrl-click multi-selection (Mehrfachauswahl) — ids of items marked for
  // a batch action, independent of the viewer/pile/context-menu state
  // above. See toggleTileSelection and the Ctrl+A/Escape handlers below.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // The ids the current search matches, in chronological order, straight
  // from `search_items`. `null` means no search is active at all — as
  // opposed to `[]`, which means a real search matched nothing; the
  // timeline dims every tile for the latter and none for the former.
  const [matchIds, setMatchIds] = useState<string[] | null>(null);
  // Which hit the next/previous arrows are currently on.
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  /// Bumped when a hit is picked from the result list; tells the search bar
  /// that its current search was used and belongs in the history.
  const [searchHistorySignal, setSearchHistorySignal] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The period-label strip above the lanes scrolls horizontally in lockstep
  // with the track (see applyScrollOffset) but lives in its own clipped row
  // so tall tiles in the thin top lane can never visually cover the labels.
  const headerTrackRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const stickyLabelRef = useRef<HTMLSpanElement | null>(null);
  // applyFishEye is defined above the markers memo, so it reads them through
  // a ref rather than taking them as a dependency — the same reason
  // applyFishEyeRef and pixelsPerDayRef exist.
  const markersRef = useRef<Marker[]>([]);
  // The periods tiles are confined to — the drawn grid's own markers, or
  // those of the next coarser grid while the drawn one is only a preview
  // (see `columns`).
  const columnMarkersRef = useRef<Marker[]>([]);
  // Lane percentages (laneLayout.bounds/laneCenterPercent) are relative to this
  // element's height, not scrollRef's — scrollRef now also contains the
  // fixed-height header row above it, so its clientHeight overshoots the
  // actual lane area by that amount.
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  // The phase area between the period header and the lanes. Its track
  // scrolls horizontally in lockstep with the lane track (applyScrollOffset);
  // vertically it scrolls on its own once there are more Themenbereiche than
  // PHASE_MAX_VISIBLE_GROUPS.
  const phaseAreaRef = useRef<HTMLDivElement | null>(null);
  const phaseTrackRef = useRef<HTMLDivElement | null>(null);
  // Rows only change with the phases themselves, never with zoom or scroll.
  const phaseRows = useMemo(() => buildPhaseRows(phaseGroups, PHASE_BAR_HEIGHT), [phaseGroups]);
  // The mounted bars, for applyFishEye's per-frame title pass — it is
  // defined above the bars memo, like markersRef.
  const phaseBarsRef = useRef<PhaseBar[]>([]);
  // Title elements by phase id, and what that pass last wrote to each, so
  // a frame in which nothing moved writes nothing.
  const phaseTitleEls = useRef(new Map<string, HTMLSpanElement>());
  const phaseTitleWritten = useRef(new Map<string, string>());
  // Where each Themenbereich's label column ends (px from the area's left
  // edge) — the same for every row since the column is one width — so the
  // per-frame pass reads no layout.
  const phaseLabelEnds = useRef(new Map<string, number>());
  // Width of the fixed label column (see .timeline__gutter): the longest
  // label plus its insets, measured after render. 0 until measured.
  const [labelColW, setLabelColW] = useState(0);
  // For the per-frame pass, which must not depend on this state.
  const labelColWRef = useRef(0);
  labelColWRef.current = labelColW;
  const [phasePopover, setPhasePopover] = useState<PhasePopoverState | null>(null);
  const phasePopoverOpenRef = useRef(false);
  phasePopoverOpenRef.current = phasePopover !== null;
  const phasePopoverTimer = useRef<number | null>(null);
  const phasePopoverElRef = useRef<HTMLDivElement | null>(null);
  // Where the last press on the timeline began: a header label that was used
  // to pan the view must not open its cluster on release.
  const pressXRef = useRef(0);
  // A left press that began on a phase bar — a click if it is released
  // within PHASE_CLICK_SLOP_PX (see handleContainerMouseUp).
  const phasePressRef = useRef<{ entry: PhaseRowPhase; x: number; y: number } | null>(null);
  // The running view animation of zoom-to-phase and its way back.
  const viewAnimRaf = useRef<number | null>(null);
  // The view before the first zoom-to-phase, for Escape and the "Zurück"
  // chip. Dropped as soon as the user zooms or pans on their own: going
  // back would then undo their own move, not the phase zoom. State for the
  // chip, ref for the handlers that must not wait for a render.
  const [phaseReturnView, setPhaseReturnView] = useState<SavedView | null>(null);
  const phaseReturnViewRef = useRef<SavedView | null>(null);
  // The same chip, reused after leaving the viewer far from where it was
  // opened (see leaveViewer): it then names the date it leads back to, and
  // reopens the cluster grid the viewer had been opened from.
  const [returnLabel, setReturnLabel] = useState<string | null>(null);
  // Screen point (viewport px) the viewer-return chip sits at: just left of
  // the tile the view jumped to, where the eye already is. Null = the
  // chip's usual corner.
  const [returnChipAt, setReturnChipAt] = useState<{ x: number; y: number } | null>(null);
  const returnChipRaf = useRef<number | null>(null);
  const returnClusterRef = useRef<ClusterSource | null>(null);
  // Where the viewer session began: the file it was opened on and the view
  // behind it, so closing can tell whether the user browsed away.
  const viewerStartRef = useRef<{ itemId: string; itemMs: number; view: SavedView; spanMs: number; cluster: ClusterSource | null } | null>(null);
  // The tile the view just jumped to on leaving the viewer, pulsing briefly
  // so the eye finds it.
  const [pulseId, setPulseId] = useState<string | null>(null);
  // That same file lies on top of its stack from then on, if the jump could
  // not zoom far enough to take the stack apart — otherwise it would be
  // pulsing underneath the others.
  const [stackFrontId, setStackFrontId] = useState<string | null>(null);
  const pulseTimeout = useRef<number | null>(null);
  const [phaseMenu, setPhaseMenu] = useState<PhaseMenuState | null>(null);
  const phaseMenuRef = useRef<HTMLDivElement | null>(null);
  // The arrow dropdown at the top of the label column: every Themenbereich
  // with its eye, so one can be shown or hidden without the dialog.
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number } | null>(null);
  const groupMenuRef = useRef<HTMLDivElement | null>(null);
  const [phasePalette, setPhasePalette] = useState<string[]>([]);
  const [phaseRenameDraft, setPhaseRenameDraft] = useState("");
  // Our own authoritative "scroll" position, applied to the track via a
  // CSS transform instead of the container's native scrollLeft. WebKitGTK
  // applies its own kinetic/momentum scrolling to a plain `overflow-x:
  // auto` element after a fast wheel gesture, continuing to move
  // scrollLeft on its own for a while with NO further wheel events firing
  // at all — ev.preventDefault() doesn't stop it, since it isn't driven by
  // discrete wheel events once started. That silently desyncs our
  // cursor-anchored zoom math from the real scroll position, which is
  // exactly what caused fast zooms to "land" years away from the cursor.
  // Owning the offset ourselves (never using container.scrollLeft at all)
  // sidesteps the engine's native scroll physics entirely.
  const scrollOffsetRef = useRef(0);
  // The semantic "what date is the user zooming toward" for the current
  // wheel gesture, held fixed across every tick as long as the cursor
  // itself doesn't move — see handleWheel. During a fast zoom burst, tile
  // positions shift drastically from one tick to the next, so even a
  // sub-pixel tremor of the real mouse can land it over a COMPLETELY
  // different tile than the one the user is actually looking at, firing a
  // fresh mouseenter and silently hijacking hoveredId (and therefore the
  // zoom anchor) to some unrelated date. Recomputing the anchor from
  // scratch on every tick trusted that noise; this instead captures it
  // once, the first tick the cursor is at a given screen position, and
  // reuses it until the cursor actually moves.
  const wheelAnchorRef = useRef<{ clientX: number; clientY: number; date: number } | null>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragState = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const tileDragState = useRef<{ itemId: string; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const hoverClearTimeout = useRef<number | null>(null);
  // True from the first wheel/pan tick of a gesture until HOVER_SUPPRESS_MS
  // after the last one — read by applyFishEye and handleTileMouseEnter to
  // block hover-magnify and fan-out while the timeline is moving under the
  // (possibly stationary) cursor. A ref, not state: it has to take effect on
  // the very same tick that starts the gesture, with no render round-trip.
  const hoverSuppressedRef = useRef(false);
  const hoverSuppressTimeout = useRef<number | null>(null);
  // Frame-time samples for the gesture being measured, if any — see
  // startFrameProfile. Allocated once and refilled from index 0 per gesture.
  const frameSamples = useRef(new Float64Array(FRAME_SAMPLE_CAP));
  const frameSampleCount = useRef(0);
  const frameProfileRaf = useRef<number | null>(null);
  const frameProfileLast = useRef(0);
  const frameProfileLabel = useRef("");
  // How many samples had been recorded as of the last real gesture event.
  // The recorder keeps running through the INTERACTION_IDLE_MS settling
  // window, and those trailing idle frames are not part of the gesture — at
  // ~16.7ms each they would both dilute the percentiles and inflate the
  // "over budget" count with frames that were never under load.
  const frameProfileActiveCount = useRef(0);

  // Object pool for applyFishEye's resting-layout pass. That pass runs once
  // per frame for the whole duration of every zoom and pan, and used to
  // allocate two Maps, a Set, four arrays, and three objects per mounted
  // tile each time — exactly the "temporary objects per scroll frame" that
  // makes a collector pause mid-gesture. These are allocated once and
  // refilled in place instead; nothing in them is read across frames (the
  // pass clears them before it writes), so reuse is safe.
  const restingBoxesRef = useRef<Map<string, RestingBox>>(new Map());
  const byLaneRef = useRef<Map<LaneType, RestingEntry[]>>(new Map());
  const seenKeysRef = useRef<Set<string>>(new Set());
  const entryPoolRef = useRef<RestingEntry[]>([]);
  // Full-resolution image/audio data URLs, keyed by item id, so revisiting
  // or stepping back to an item already looked at this session is instant.
  const fullMediaCache = useRef<Record<string, string>>({});
  // Bumped on every openViewer call so a slow in-flight load for an item
  // the user has since navigated away from can't clobber what's shown now.
  const viewerRequestId = useRef(0);
  // Mirrors whether the viewer is open, for scheduleClusterClose's timeout
  // callback — that callback reads this synchronously 80ms after being
  // scheduled, so it needs the viewer state *at fire time*, not whatever it
  // closed over when the timer was started; a plain state closure would be
  // stale there the way pixelsPerDayRef's comment describes for that case.
  const viewerOpenRef = useRef(false);

  const autoFitDone = useRef(false);
  // The range the current zoom was fitted to; a reload only re-fits when the
  // oldest/newest item moved, so returning from the file browser keeps zoom/scroll.
  const fittedRange = useRef<{ epoch: number; maxTime: number } | null>(null);

  // Mirrors pixelsPerDay for synchronous reads inside the wheel handler.
  // Rapid-fire wheel events can arrive faster than React re-renders, so a
  // handler relying on the `pixelsPerDay` closure value would compute each
  // step from a stale zoom level — the errors compound and the anchored
  // point visibly drifts away from the cursor over a few scroll notches.
  const pixelsPerDayRef = useRef(6);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuWasOpen = useRef(false);

  // Which cluster (keyed by its first member's id) is open as a pile right
  // now, if any.
  const openFanRef = useRef<OpenFan | null>(null);
  const clusterCloseTimeout = useRef<number | null>(null);
  // Pending (delayed) fan opening — see FAN_OPEN_DELAY_MS. Held as data
  // rather than captured in the timeout's closure so that sweeping across
  // several members of the same cluster retargets the pending open instead
  // of restarting its timer, which would mean a slow sweep never opened at
  // all.
  const fanOpenTimeout = useRef<number | null>(null);
  const pendingFanRef = useRef<OpenFan | null>(null);
  // What the pending hover should actually do when its timer fires, and the
  // pointer position it was armed at. Kept beside pendingFanRef (rather
  // than folded into it) because OpenFan describes a pile that is open or
  // about to be, and a hover that is going to zoom instead never opens one.
  const pendingHoverRef = useRef<{ itemId: string; intent: "fan" | "zoom"; x: number; y: number } | null>(null);
  // Where the pointer was when the last hover-driven zoom fired, for the
  // "step" brake. A zoom slides fresh content under a pointer that never
  // moved, and the browser hands that new tile a mouseenter carrying the
  // unchanged coordinates — so comparing against this is exactly what tells
  // a real move apart from the timeline moving underneath.
  const hoverZoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // The open pile's card — a real, fixed-position DOM element (see the
  // render), so checkClusterStillHovered can hit-test it with a plain
  // getBoundingClientRect() instead of hand-rolled geometry.
  const pileCardRef = useRef<HTMLDivElement | null>(null);
  // Grid tile elements of the currently open pile, keyed by item id — only
  // used to warp the pointer onto the focused one (see fanCursorFollow)
  // once it has actually been laid out.
  const pileTileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pileGridWrapRef = useRef<HTMLDivElement | null>(null);
  const pileGridResizeObserverRef = useRef<ResizeObserver | null>(null);
  // Whether the pointer has reached the open pile yet. Before it has, the
  // pile is kept alive anywhere along the corridor from where it was opened
  // to where it rendered — the card is centred in the viewport, so the
  // pointer has to travel to it, and a strict "off the card means close"
  // test would shut the pile before it could ever be used. Once the pointer
  // HAS been on it, that strict test is exactly what's wanted.
  const fanEnteredRef = useRef(false);
  // Whether the pointer was already moved onto the focused strip tile for
  // the pile that is open right now (optional, see utils/fanCursor). Reset
  // when the pile closes so the next one warps again.
  const fanPointerPlacedRef = useRef(false);
  const fanFocusIdRef = useRef<string | null>(null);
  const interactionIdleTimeout = useRef<number | null>(null);
  // Synchronous twin of the renderWindow state, so ensureRenderWindow can
  // decide whether a refresh is needed without waiting for a re-render
  // (it's called from the scroll path, which runs several times per frame).
  const renderWindowRef = useRef<{ min: number; max: number } | null>(null);

  // The single writer for the open fan: keeps openFanRef (read by the
  // pointer handlers) and the render-visible state in lockstep.
  const setOpenFan = useCallback((fan: OpenFan | null, focusId: string | null = null) => {
    openFanRef.current = fan;
    fanFocusIdRef.current = focusId;
    setOpenFanState(fan);
    setFanFocusId(focusId);
    if (!fan) setPileGridHasMore(false);
  }, []);

  // Items with an unparseable resolved_timestamp are filtered out here
  // rather than anywhere downstream: a single NaN reaches epoch/maxTime,
  // and from there xPos — i.e. ONE bad row put `left: NaN` on every tile in
  // the timeline, not just its own. They're counted so the UI can say they
  // exist (see .timeline__notice) instead of making them vanish.
  const privacyHidePending = useRef(false);
  const [itemsAfterPrivacyHide, setItemsAfterPrivacyHide] = useState<Set<string> | null>(null);

  const reloadItems = useCallback(() => {
    const startedAt = performance.now();
    listItems()
      .then((loaded) => {
        const valid: ItemInfo[] = [];
        let dropped = 0;
        for (const item of loaded) {
          if (Number.isFinite(new Date(item.resolved_timestamp).getTime())) valid.push(item);
          else dropped++;
        }
        setItems(valid);
        setInvalidDateCount(dropped);
        setItemsFetched(true);
        if (privacyHidePending.current) {
          privacyHidePending.current = false;
          setItemsAfterPrivacyHide(new Set(valid.map((item) => item.id)));
        }
        frameProfileLog(`reloadItems: ${(performance.now() - startedAt).toFixed(0)}ms for ${loaded.length} items`);
      })
      .catch((err) => {
        frameProfileLog(`reloadItems: list_items FAILED: ${String(err)}`);
        setItems([]);
        setInvalidDateCount(0);
        setItemsFetched(true);
      });
  }, []);

  // Set before the reload the same bump triggers: effects run in this order,
  // and the reload can only answer after both have.
  useEffect(() => {
    if (privacyHideToken > 0) privacyHidePending.current = true;
  }, [privacyHideToken]);

  useEffect(() => {
    reloadItems();
  }, [refreshToken, reloadItems]);

  // `items` already reflects every local add/remove/undo immediately (not
  // just a full reloadItems), so this stays accurate without the header
  // needing its own separate count fetch. invalidDateCount folds into
  // `other` since those items are still in the project, just filtered out
  // of `items` for having an unparseable date — see reloadItems above.
  const categoryCounts = useMemo<CategoryCounts>(() => {
    const counts: CategoryCounts = { image: 0, video: 0, audio: 0, document: 0, other: 0 };
    for (const item of items) {
      if (item.file_type === "email" || item.file_type === "diary") counts.document += 1;
      else counts[item.file_type] += 1;
    }
    counts.other += invalidDateCount;
    return counts;
  }, [items, invalidDateCount]);

  useEffect(() => {
    onCategoryCountsChange?.(categoryCounts);
  }, [categoryCounts, onCategoryCountsChange]);

  // The live lane layout: the user's order, narrowed to the types this
  // stream actually holds. Memoised on `items` so the bands, the tile
  // scale and the grouping thresholds derived from it change only when a
  // category appears or disappears (an import, a removal, an undo) — never
  // per frame, which is what the whole imperative layout pass below
  // depends on.
  const laneLayout = useMemo(
    () => buildLaneLayout(normalizeLaneOrder(laneOrderProp), presentLanesOf(items)),
    [laneOrderProp, items],
  );
  // Two levels, not one. `level` is the grid that is DRAWN; `columns` is the
  // grid whose periods are the columns — what a tile stays inside and where
  // a stack is cut. They are the same level except while the drawn grid is
  // still too fine to hold a tile (right after it appears: hours at a
  // twenty-fourth of the viewport, days at a thirtieth). Binding tiles to it
  // then shrank every tile at each level change; now the fine grid is drawn
  // faintly as a preview and the tiles keep their coarser columns and their
  // size until a fine column is wide enough. See `columnLevel`.
  //
  // The width that counts is a drawn tile plus the cascade of a full stack,
  // so the hand-over changes no tile's size, a stack's included.
  const minColumnPx = TILE_SIZE * laneLayout.tileScale + (STACK_DEPTH - 1) * STACK_STEP_X;
  const columns = columnLevel(level, pixelsPerDay, minColumnPx, showWeekGrid);
  const gridIsPreview = columns !== level;
  const gridOpacity = gridIsPreview ? previewGridOpacity(MARKER_PERIOD_DAYS[level] * pixelsPerDay, minColumnPx) : 1;
  // The phase area's height on screen (see phaseAreaShownHeight): it takes
  // what its rows need, the lanes share the rest. 0 without phases, which
  // is what keeps the timeline exactly as it was before the phase area.
  const phaseAreaPx = phaseAreaShownHeight(phaseRows, stackHeight, TILE_SIZE * laneLayout.tileScale);
  // What applyFishEye last wrote to --lane-tile-hf, so a frame in which the
  // heights didn't change writes nothing.
  const laneTileHfRef = useRef(1);

  useEffect(() => {
    if (!contextMenu) return;
    // Left-button only — a stray/legacy 'click' synthesized from the same
    // right-click that just opened this menu would otherwise close it
    // again immediately in some WebKitGTK versions. Also ignore mousedowns
    // inside the menu itself: this fires before the menu item's own click,
    // so closing unconditionally here would remove the button from the DOM
    // before React ever gets to handle the click — the menu item's action
    // would silently never run.
    const close = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (contextMenuRef.current && contextMenuRef.current.contains(ev.target as Node)) return;
      setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [contextMenu]);

  useEffect(() => {
    if (!fileViewRequest) return;
    const { items: viewItems, mode, openId } = fileViewRequest;
    setVirtualItems(viewItems);
    if (mode === "cluster") {
      setClusterSource({ kind: "virtual", items: viewItems });
      setClusterHoverId(null);
    } else {
      const target = viewItems.find((i) => i.id === openId) ?? viewItems[0];
      if (target) void openViewer(target, null, new Set(viewItems.map((i) => i.id)));
    }
    onFileViewHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileViewRequest]);

  // Ends the attachment view once neither its cluster nor a viewer on one of
  // its files is open any more (Escape steps viewer -> cluster -> closed).
  const virtualViewActive =
    clusterSource?.kind === "virtual" || (viewerItem !== null && virtualItems.some((i) => i.id === viewerItem.id));
  const wasVirtualViewActive = useRef(false);
  useEffect(() => {
    if (virtualViewActive) {
      wasVirtualViewActive.current = true;
      return;
    }
    if (!wasVirtualViewActive.current) return;
    wasVirtualViewActive.current = false;
    setVirtualItems([]);
    onFileViewClosed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualViewActive]);

  useEffect(() => {
    if (!openItemId) return;
    const item = items.find((i) => i.id === openItemId);
    if (!item) return;
    void openViewer(item);
    onOpenItemHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItemId, items]);

  // Right-click on empty timeline: add a diary entry at the clicked moment,
  // plus pasting a clipboard image when there is one. The clipboard is read
  // when the menu opens so the entry only shows up if it would work.
  const [trackMenu, setTrackMenu] = useState<TrackMenuState | null>(null);
  const trackMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!trackMenu) return;
    const close = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (trackMenuRef.current?.contains(ev.target as Node)) return;
      setTrackMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setTrackMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [trackMenu]);

  // The phase bar's menu closes like the one above. In colour mode the
  // popup handles its own Escape (and stops it there).
  useEffect(() => {
    if (!phaseMenu) return;
    const close = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (phaseMenuRef.current?.contains(ev.target as Node)) return;
      setPhaseMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPhaseMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [phaseMenu]);

  useEffect(() => {
    if (!groupMenu) return;
    const close = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (groupMenuRef.current?.contains(ev.target as Node)) return;
      setGroupMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setGroupMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [groupMenu]);

  // The fan-out must not collapse while the user is moving the mouse from
  // a hovered tile toward its own context menu (mousing off the tile would
  // otherwise clear hoveredId mid-interaction). Once the menu actually
  // closes again, drop the pinned hover so the fan collapses normally.
  useEffect(() => {
    const isOpenNow = contextMenu != null;
    if (contextMenuWasOpen.current && !isOpenNow) {
      setHoveredId(null);
    }
    contextMenuWasOpen.current = isOpenNow;
  }, [contextMenu]);

  useEffect(() => {
    loadMediaServerInfo().then(setMediaServer).catch(() => setMediaServer(null));
  }, []);

  // Thumbnail URLs, not thumbnail *contents*. Building them is pure string
  // work, so there is nothing to wait for here — WebKit fetches each image
  // itself, in parallel and only when it decides to.
  //
  // This replaced reading every thumbnail over IPC as a base64 data: URL,
  // which was the entire cost of opening a large project: measured at
  // ~8.5s for 438 thumbnails, against ~0.3s for the database query that
  // produced the items in the first place.
  //
  // Only mounted tiles request theirs, on purpose. Preloading every thumbnail
  // of a project up front kept the disk and the main thread busy for minutes
  // on a 5000-file archive, and a video opened meanwhile stayed frozen until
  // the last thumbnail was in.
  const thumbs = useMemo(() => {
    if (!mediaServer) return {} as Record<string, string>;
    const map: Record<string, string> = {};
    for (const item of items) {
      if (item.thumbnail_path) map[item.id] = fileUrl(mediaServer, item.thumbnail_path);
    }
    for (const item of virtualItems) {
      if (item.file_type === "image") map[item.id] = fileUrl(mediaServer, item.stored_path);
    }
    return map;
  }, [items, virtualItems, mediaServer]);

  // Onboarding, hint 1 of 3 (see the in-app-help guide): once real tiles are
  // on screen for the first time, nudge toward zooming — the one gesture a
  // new user has no other way to discover. Gated on `itemsFetched` so this
  // can never fire during the project-opening lock overlay or the loading
  // spinner above, only once there is something real to point at.
  const zoomHintShown = useRef(false);
  const dismissZoomHint = useRef<(() => void) | null>(null);
  // The hint is about this timeline: leaving it ("Zurück zum Start") takes
  // the hint along instead of leaving it over the start screen.
  useEffect(() => () => dismissZoomHint.current?.(), []);
  const welcomeOpen = useWelcomeOpen();
  useEffect(() => {
    if (!itemsFetched || items.length === 0 || welcomeOpen) return;
    if (zoomHintShown.current || zoomHintShownThisSession) return;
    zoomHintShown.current = true;
    zoomHintShownThisSession = true;
    if (localStorage.getItem(ZOOM_HINT_DISMISSED_KEY) === ZOOM_HINT_VERSION) return;
    dismissZoomHint.current = showToast(t("timeline.onboardingZoomHint"), {
      durationMs: 8000,
      action: {
        label: t("browser.dontShowAgain"),
        onClick: () => localStorage.setItem(ZOOM_HINT_DISMISSED_KEY, ZOOM_HINT_VERSION),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsFetched, items.length, welcomeOpen]);

  const { epoch, maxTime } = useMemo(() => {
    if (items.length === 0) {
      const now = Date.now();
      return { epoch: now - 30 * DAY_MS, maxTime: now + 30 * DAY_MS };
    }
    // Folded rather than Math.min(...times): the spread form passes one
    // argument per item and blows the call-argument limit on a large
    // enough archive. Every timestamp here parses (reloadItems filters).
    let firstMs = Infinity;
    let lastMs = -Infinity;
    for (const i of items) {
      const ms = new Date(i.resolved_timestamp).getTime();
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
    // Snap the track's range out to whole calendar YEARS rather than just
    // padding the first/last item by a few days. A year is the coarsest
    // bucket any level groups by (see periodBoundsForLevel), and every
    // finer period nests inside one, so year-aligned ends guarantee that
    // EVERY period at EVERY level lies fully inside the track. With plain
    // day-padding, the first item's own year began before the track did
    // (e.g. item in June → year starts 5 months earlier), putting that
    // slice at a negative track x — off-screen to the left and
    // unreachable, since the scroll offset clamps at 0.
    const first = new Date(firstMs);
    const last = new Date(lastMs);
    return {
      epoch: startOfYear(first).getTime(),
      maxTime: new Date(last.getFullYear() + 1, 0, 1).getTime(),
    };
  }, [items]);

  const xPos = useCallback(
    (iso: string) => ((new Date(iso).getTime() - epoch) / DAY_MS) * pixelsPerDay,
    [epoch, pixelsPerDay],
  );

  // Track-space x (what CSS `left` actually uses for a centered tile, and
  // what marker lines align to) — xPos shifted right by EDGE_PADDING so
  // nothing at either end of the range gets clipped. See EDGE_PADDING.
  const trackX = useCallback((iso: string) => xPos(iso) + EDGE_PADDING, [xPos]);

  const dateForX = useCallback(
    (trackXPx: number) => new Date(epoch + ((trackXPx - EDGE_PADDING) / pixelsPerDay) * DAY_MS).toISOString(),
    [epoch, pixelsPerDay],
  );

  // The track's LOGICAL width — how far the scroll offset may run. It is a
  // number, never an element width: at deep zoom it grows past what a
  // browser can lay out (49 years at one day per screen is 28.6 million px,
  // and Blink silently clamps element widths at about 27.9 million — the
  // engine the app actually runs on, WebKitGTK, has its own ceiling that
  // cannot be measured from here). The element only ever spans the mounted
  // window, see `trackOrigin`.
  const logicalWidthFor = useCallback(
    (ppd: number) => Math.max(((maxTime - epoch) / DAY_MS) * ppd + EDGE_PADDING * 2, 800),
    [maxTime, epoch],
  );
  const totalWidth = logicalWidthFor(pixelsPerDay);
  // Mirrors it for synchronous reads: a zoom gesture writes pixelsPerDayRef
  // and needs the new scroll range in the same tick, before React has
  // re-rendered. This is what `track.offsetWidth` used to be read for.
  const totalWidthRef = useRef(totalWidth);
  totalWidthRef.current = totalWidth;

  // Where the mounted stretch of track begins, in track space. Every
  // position written into the DOM is relative to it, and the track's
  // transform counters it, so the two cancel exactly:
  //
  //   screen x = (trackX - origin) - (scrollOffset - origin) = trackX - scrollOffset
  //
  // which is the same screen position as before, with no number larger than
  // the mounted window ever reaching the DOM. The window is a few viewports
  // wide (see RENDER_MARGIN_VIEWPORTS), so the track element stays a few
  // thousand pixels wide at every zoom level.
  const trackOrigin = renderWindow ? renderWindow.min : 0;
  const trackDomWidth = renderWindow ? Math.max(renderWindow.max - renderWindow.min, 800) : totalWidth;

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // The hits, resolved to the items actually on the timeline and still in
  // the backend's chronological order. Both sides skip items whose
  // timestamp doesn't parse (see `search_items` and `reloadItems`), so this
  // normally has exactly one entry per returned id — it's a lookup, not a
  // second filter.
  const matchIdSet = useMemo(() => (matchIds ? new Set(matchIds) : null), [matchIds]);
  const matchedItems = useMemo(
    () =>
      matchIds
        ? matchIds.flatMap((id) => {
            const item = itemById.get(id);
            return item ? [item] : [];
          })
        : [],
    [matchIds, itemById],
  );
  // Clamped rather than assumed valid: the result list can shrink under the
  // arrows (an item removed while a search is open).
  const activeMatchId =
    matchedItems.length > 0 ? matchedItems[Math.min(activeMatchIndex, matchedItems.length - 1)].id : null;

  // `items` keeps its original load order even after a manual timestamp
  // edit (saveDate / drag) splices a new date into an existing array slot
  // without re-sorting. Viewer prev/next must walk chronological order, not
  // array order, so it uses this separately-sorted copy instead of `items`.
  const chronologicalItems = useMemo(
    () => [...items].sort((a, b) => new Date(a.resolved_timestamp).getTime() - new Date(b.resolved_timestamp).getTime()),
    [items],
  );
  // The same order as bare timestamps: tells the header which periods hold a file.
  const itemTimes = useMemo(() => chronologicalItems.map((i) => new Date(i.resolved_timestamp).getTime()), [chronologicalItems]);

  // The viewer's step-through order: global chronological order narrowed by
  // the "Navigation in der Detailansicht" setting and, when the viewer was
  // opened from the cluster grid, by that grid's type checkboxes too. The
  // open file itself always stays in the pool so its position is findable
  // even if its own type is switched off. Stepping past a year boundary is
  // intentional.
  // `scopeIds` (set when the viewer was opened from the search cluster)
  // replaces both the nav-mode setting and the lane filter rather than
  // stacking with them: it is itself the narrowing the user chose, and a
  // second one on top would make the arrows skip hits that are visibly
  // sitting in the cluster they just came from.
  const navPoolFor = useCallback(
    (
      current: ItemInfo,
      clusterFilter: FileTypeFilter | null,
      scopeIds: Set<string> | null = null,
      override: ViewerNavType[] | null = null,
    ) => {
      if (scopeIds) {
        const virtual = virtualItems.filter((i) => scopeIds.has(i.id));
        if (virtual.length > 0) return virtual;
        return chronologicalItems.filter((i) => i.id === current.id || (scopeIds.has(i.id) && i.file_type !== "diary"));
      }
      const currentLane = laneForFileType(current.file_type);
      return chronologicalItems.filter((i) => {
        if (i.id === current.id) return true;
        if (i.file_type === "diary") return false;
        const lane = laneForFileType(i.file_type);
        if (override) return override.includes(lane);
        if (clusterFilter && !clusterFilter[lane]) return false;
        if (viewerNavMode === "category") return lane === currentLane;
        if (viewerNavMode === "custom") return viewerNavTypes.includes(lane);
        return true;
      });
    },
    [chronologicalItems, viewerNavMode, viewerNavTypes, virtualItems],
  );
  const viewerNavPool = useMemo(
    () => (viewerItem ? navPoolFor(viewerItem, viewerNavFilter, viewerNavScope, viewerNavOverride) : chronologicalItems),
    [navPoolFor, viewerItem, viewerNavFilter, viewerNavScope, viewerNavOverride, chronologicalItems],
  );
  // Which types the viewer's filter popover shows as on: the user's own
  // pick, else what the setting (and a cluster's type filter) lets through.
  const viewerNavActiveTypes = useMemo<ViewerNavType[]>(() => {
    if (!viewerItem) return ALL_NAV_TYPES;
    if (viewerNavOverride) return viewerNavOverride;
    const currentLane = laneForFileType(viewerItem.file_type);
    return ALL_NAV_TYPES.filter((lane) => {
      if (lane === currentLane) return true;
      if (viewerNavFilter && !viewerNavFilter[lane]) return false;
      if (viewerNavMode === "category") return false;
      if (viewerNavMode === "custom") return viewerNavTypes.includes(lane);
      return true;
    });
  }, [viewerItem, viewerNavOverride, viewerNavFilter, viewerNavMode, viewerNavTypes]);
  function toggleViewerNavType(type: ViewerNavType) {
    if (!viewerItem || type === laneForFileType(viewerItem.file_type)) return;
    setViewerNavOverride(
      viewerNavActiveTypes.includes(type) ? viewerNavActiveTypes.filter((x) => x !== type) : [...viewerNavActiveTypes, type],
    );
  }

  // The cluster grid's own contents: every item of the open year, or the
  // current search hits (already chronological, see matchedItems), then
  // narrowed by the type-filter checkboxes.
  const clusterItems = useMemo(() => {
    if (!clusterSource) return [];
    if (clusterSource.kind === "search") return matchedItems;
    if (clusterSource.kind === "virtual") return clusterSource.items;
    if (clusterSource.kind === "note") {
      const ids = new Set(clusterSource.ids);
      return chronologicalItems.filter((i) => ids.has(i.id));
    }
    const { startMs, endMs } = clusterSource;
    return chronologicalItems.filter((i) => {
      const ms = new Date(i.resolved_timestamp).getTime();
      return ms >= startMs && ms < endMs;
    });
  }, [chronologicalItems, clusterSource, matchedItems]);
  const clusterFilteredItems = useMemo(
    () => clusterItems.filter((i) => clusterTypeFilter[laneForFileType(i.file_type)]),
    [clusterItems, clusterTypeFilter],
  );
  // The id-scope a viewer opened from this cluster navigates inside. Only
  // the search cluster hands one over: a period cluster keeps the viewer's
  // normal cross-year stepping, narrowed by its type filter alone.
  const clusterNavScope = useMemo(
    () => (clusterSource && clusterSource.kind !== "period" ? new Set(clusterFilteredItems.map((i) => i.id)) : null),
    [clusterSource, clusterFilteredItems],
  );

  // The enlarged hero tile: whichever small tile is currently hovered, or
  // the first (filtered) item of the year before anything has been.
  const clusterHeroItem = useMemo(() => {
    if (clusterHoverId) {
      const hovered = clusterFilteredItems.find((i) => i.id === clusterHoverId);
      if (hovered) return hovered;
    }
    return clusterFilteredItems[0] ?? null;
  }, [clusterHoverId, clusterFilteredItems]);

  // Lane-partitioned chronological order, the input to the proximity
  // clustering below. Split once per item change so the per-zoom pass stays
  // linear.
  const laneSortedItems = useMemo(() => {
    const byLane = new Map<LaneType, ItemInfo[]>();
    for (const item of chronologicalItems) {
      const lane = laneForFileType(item.file_type);
      const list = byLane.get(lane);
      if (list) list.push(item);
      else byLane.set(lane, [item]);
    }
    return byLane;
  }, [chronologicalItems]);

  // Fan clustering by SCREEN PROXIMITY rather than by calendar bucket.
  //
  // Calendar bucketing is what put a whole month's items — spread across
  // the full width of that month at Year zoom, with clear gaps between
  // them — into a single cluster. Hovering any one of them fanned the
  // entire month, so one cluster's fan sprawled over every neighbouring
  // cluster and single file in the year, which read as "hovering one
  // cluster activates all of them". It cut the other way too: two items
  // either side of midnight on the 1st sit pixels apart on screen but land
  // in different months, so they were never fanned at all.
  //
  // Proximity is the property that actually matters here — items need
  // fanning exactly when they occlude each other — and it follows the zoom
  // for free. Single-linkage along the lane, so a continuous overlapping
  // ribbon stays one pile.
  //
  // Positions are linear in pixelsPerDay, so the threshold is applied to
  // timestamps and no x needs computing: a pixel gap is a time gap.
  // One tree per lane, rebuilt only when the items themselves change —
  // never on a zoom step. See `clusterTree.ts` for why the grouping moved
  // from a single chronological pass to a tree that is cut per zoom: the
  // pass had a width cap whose cut position slid with the zoom, which
  // reshuffled group membership without anything actually splitting or
  // merging.
  // Computed inline, on the main thread, after two detours that both chased
  // a cost that was never here.
  //
  // `buildClusterTree` has a documented O(n²) worst case, and a JS-side
  // measurement of ~3.8s for this project made it look like the opening
  // freeze. It was moved into a Web Worker first (measured NOT to give this
  // WebKitGTK webview real concurrency), then ported to Rust behind a
  // `spawn_blocking` command. Timing the Rust side from inside Rust finally
  // settled it: **1ms of actual compute** for all 1779 items across 4
  // lanes, against 1971ms measured in the frontend for the same call. Both
  // multi-second figures were measured in JS and therefore counted time the
  // main thread spent blocked on something else — the IPC reply path, see
  // `list_items`. So the round trip cost roughly two thousand times the
  // computation it was there to offload.
  //
  // `cluster_tree.rs` is left in the tree but is no longer reachable.
  //
  // A `useMemo`, not an effect writing state: the effect version ran one
  // commit AFTER the items arrived, and its `clusterTreesReady` flag was
  // still `true` from the empty-list shortcut on mount. So the render in
  // which ~5000 items first showed up already hid the spinner and had no
  // trees yet — no groups, no render window — and mounted every item as its
  // own tile with its own eager thumbnail request, only to unmount nearly
  // all of them a commit later. That burst is what froze the spinner. Built
  // in render (a few ms), the very first render with items is grouped.
  const laneClusterTrees = useMemo(() => {
    const trees = new Map<LaneType, { tree: ClusterNode | null; items: ItemInfo[] }>();
    if (laneSortedItems.size === 0) return trees;
    const startedAt = performance.now();
    for (const [lane, laneItems] of laneSortedItems) {
      const timesMs = laneItems.map((item) => new Date(item.resolved_timestamp).getTime());
      trees.set(lane, { tree: buildClusterTree(timesMs), items: laneItems });
    }
    frameProfileLog(
      `cluster trees: ${(performance.now() - startedAt).toFixed(0)}ms inline for ${laneSortedItems.size} lanes`,
    );
    return trees;
  }, [laneSortedItems]);

  // The trees are ready in the same render as the items, so the only wait
  // left to cover is `reloadItems` itself.
  const showLoadingSpinner = !itemsFetched;

  // The partition at the current zoom. Both thresholds are pixel distances
  // converted into time spans, so the cut depends on the zoom but never on
  // the scroll position — the same property the gap rule always had, now
  // without the width cap's instability.
  const { clusterByItemId, groupInfoByItemId } = useMemo(() => {
    const members = new Map<string, ItemInfo[]>();
    const info = new Map<string, GroupInfo>();
    // The threshold is the width a tile is actually DRAWN at, which is the
    // tile size or the period it has to fit inside, whichever is smaller
    // (see the cap in applyFishEye). Keeping it at the full tile size while
    // tiles shrink would group files that no longer overlap at all and then
    // draw the stack at their midpoint — far from either of their dates.
    //
    // It also lands somewhere pleasing on its own: in the overview a period
    // is a year, so the threshold is a year, so what forms is one stack per
    // year and lane — the grouping the calendar buckets used to impose,
    // arrived at by geometry instead, and only where the geometry calls
    // for it.
    const drawnTilePx = Math.min(TILE_SIZE, MARKER_PERIOD_DAYS[columns] * pixelsPerDay);
    for (const [, { tree, items: laneItems }] of laneClusterTrees) {
      // The same factor the tiles are drawn with, so a group forms exactly
      // when the drawn tiles would overlap — in a stream with fewer
      // lanes the tiles are bigger, and so is the distance at which they
      // cover each other.
      const laneScale = laneLayout.tileScale;
      const maxGapMs = ((drawnTilePx * laneScale) / pixelsPerDay) * DAY_MS;
      const maxSpanMs = (((GROUP_MAX_SPAN_PX / TILE_SIZE) * drawnTilePx * laneScale) / pixelsPerDay) * DAY_MS;
      // Geometrisch gruppieren, dann an den Gitterlinien auftrennen — so
      // enthält ein Stapel nur, was auch in seiner Spalte steht.
      const geometric = cutClusterTree(tree, laneItems, maxGapMs, maxSpanMs);
      const confined = splitGroupsBy(
        geometric,
        (item) => new Date(item.resolved_timestamp).getTime(),
        (item) => periodKeyForLevel(new Date(item.resolved_timestamp).getTime(), columns),
      );
      for (const group of confined) {
        const entry: GroupInfo = { ...group, laneScale };
        for (const member of group.items) {
          members.set(member.id, group.items);
          info.set(member.id, entry);
        }
      }
    }
    return { clusterByItemId: members, groupInfoByItemId: info };
  }, [laneClusterTrees, pixelsPerDay, columns, laneLayout]);

  // On first showing a (new) set of items, zoom out just enough that the
  // entire range from oldest to newest fits in the viewport, instead of
  // starting at a fixed zoom level that can leave everything squeezed into
  // an unnoticeable sliver when the files span years. Runs in a layout
  // effect (before paint) so there's no visible flash at the old zoom.
  useLayoutEffect(() => {
    const fitted = fittedRange.current;
    if (autoFitDone.current && fitted && (fitted.epoch !== epoch || fitted.maxTime !== maxTime) && items.length > 0) {
      autoFitDone.current = false;
    }
    if (autoFitDone.current) return;
    if (items.length === 0) return;
    // The scroll container this measures only exists once the loading
    // spinner (see `showLoadingSpinner`) has given way to the full view —
    // while `items` becomes non-empty earlier than that (the spinner also
    // covers the cluster-tree computation), so without this dependency the
    // effect fires too early, finds no container, and gives up silently
    // until some unrelated `items`/`epoch`/`maxTime` change happens to
    // retrigger it. Re-running when the spinner clears closes that gap —
    // confirmed as the cause of tiles briefly showing at the un-fitted
    // (close-zoom, large-tile) default before snapping to the fitted size.
    if (showLoadingSpinner) return;
    const container = scrollRef.current;
    if (!container) return;

    const totalDays = (maxTime - epoch) / DAY_MS;
    const tryFit = () => {
      if (autoFitDone.current) return;
      const width = container.clientWidth;
      if (width === 0) return;
      autoFitDone.current = true;
      fittedRange.current = { epoch, maxTime };
      const fitted = computeFitPxPerDay(width, totalDays);
      // Both, never just the state — see the note where the old syncing
      // effect used to be. This was the one path relying on that effect to
      // carry the value into the ref, and keeping it alive for this single
      // case is what cost the zoom its scale mid-gesture.
      pixelsPerDayRef.current = fitted;
      setPixelsPerDay(fitted);
    };

    tryFit();
    if (autoFitDone.current) return;

    // Right as the browser overlay closes, the container can still report
    // zero width for a moment — a layout/reflow timing gap, not unlike the
    // height:100% WebKitGTK quirk noted elsewhere in this file. Previously
    // this just gave up silently, leaving the timeline blank until some
    // unrelated interaction (e.g. scrolling) happened to force a reflow.
    // Watch for the container to actually gain a size instead.
    const observer = new ResizeObserver(tryFit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [items, epoch, maxTime, showLoadingSpinner]);

  const applyFishEye = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const viewportCenter = scrollOffsetRef.current + container.clientWidth / 2;
    const halfWidth = container.clientWidth / 2;
    const containerHeight = lanesAreaRef.current?.clientHeight ?? container.clientHeight;
    // Tile height factor: the lanes' share of the height they would have
    // without the phase area. Tiles keep their width (grouping, clusters
    // and the lane factor are all measured in widths) and lose height in
    // the same proportion as their lanes, so whatever fitted a lane before
    // still fits it — the overrun allowance is a share of the lane, too.
    // Exactly 1 without phases. offsetHeight includes the area's border,
    // which also came out of the lanes. The thumbnail's aspect ratio reads
    // it from the CSS variable (see .timeline-tile .timeline-tile__thumb).
    const phaseAreaHeightPx = phaseAreaRef.current?.offsetHeight ?? 0;
    const tileHf =
      containerHeight > 0 && phaseAreaHeightPx > 0
        ? Math.round((containerHeight / (containerHeight + phaseAreaHeightPx)) * 1000) / 1000
        : 1;
    if (tileHf !== laneTileHfRef.current && lanesAreaRef.current) {
      laneTileHfRef.current = tileHf;
      lanesAreaRef.current.style.setProperty("--lane-tile-hf", String(tileHf));
    }
    // There is one resting layout now, for every zoom: a lone tile at its
    // own date, a group as a cascade centered on the group's own span. The
    // three modes this replaced (one representative per calendar bucket /
    // a cascade sized from a fixed threshold / every tile at its exact date
    // with free overlap) are gone, along with the second set of zoom
    // thresholds that decided between them.

    // Vertical containment is absolute — see EDGE_MARGIN.
    // Correction to add to a tile's offset along one axis so its scaled box
    // lands fully inside [min, max]. Returns 0 when it already fits, so
    // it's a no-op wherever there's room. If the box is wider than the
    // range itself the two bounds conflict — centering it then crops it
    // symmetrically instead of pinning it hard against one edge.
    const rangeClamp = (center: number, min: number, max: number) => {
      if (min > max) return (min + max) / 2 - center;
      if (center < min) return min - center;
      if (center > max) return max - center;
      return 0;
    };
    // The left bound starts right of the fixed label column (.timeline__gutter,
    // 8rem until measured): a hovered tile near the left edge used to slide
    // under it, and its caption was cut off there.
    const leftInset = labelColWRef.current || 8 * parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
    const clampCorrection = (screenCenter: number, half: number, viewportSize: number) =>
      rangeClamp(screenCenter, leftInset + EDGE_MARGIN + half, viewportSize - EDGE_MARGIN - half);

    // A magnified tile (hover or cluster fan) may spill past its own lane
    // into a neighbor, but only by a bounded amount — enough that hover
    // still reads as a strong, consistent zoom in every lane (a lane of
    // four is too thin to contain HOVER_SCALE without this), while
    // neighboring lanes stay visually intact rather than getting fully
    // overrun. Agreed with the user as a compromise between "never leave
    // the lane" (too cramped) and "no lane limit at all" (just the absolute
    // viewport clamp, which let a hovered document tile sit on top of
    // unrelated photos).
    //
    // It holds up under the lane-count tile scaling too: hover grows a tile
    // to HOVER_SCALE × the lane factor, and the factor's square-root
    // damping (see buildLaneLayout) keeps that inside lane + overrun at two
    // and three lanes. At one lane there is no neighbour left to protect,
    // and at four nothing changed.
    const LANE_OVERRUN_RATIO = 0.3;
    // Combines the lane-soft clamp with the Phase-2 hard viewport clamp:
    // the lane bound is applied first, then the viewport bound is applied
    // on top of whatever that left — so if the lane's own overrun allowance
    // would still push a tile off-screen (e.g. the document lane sits right
    // at the very top), the viewport wins, honoring Phase 2's "never leave
    // the viewport" rule exactly as before.
    const verticalClamp = (rawCenterY: number, half: number, fileType: ItemInfo["file_type"]) => {
      const { topPct, heightPct } = laneLayout.bounds[laneForFileType(fileType)];
      const laneTop = (containerHeight * topPct) / 100;
      const laneHeight = (containerHeight * heightPct) / 100;
      const overrun = laneHeight * LANE_OVERRUN_RATIO;
      const laneCorrection = rangeClamp(rawCenterY, laneTop - overrun + half, laneTop + laneHeight + overrun - half);
      const afterLane = rawCenterY + laneCorrection;
      const viewportCorrection = rangeClamp(afterLane, EDGE_MARGIN + half, containerHeight - EDGE_MARGIN - half);
      return laneCorrection + viewportCorrection;
    };

    // The pinned period label at the left edge: the last period that starts
    // at or before the edge is the one being looked at. Written here because
    // this runs on every scroll and zoom frame and already holds the live
    // offset — deriving it in React state would mean a render per frame.
    const stickyEl = stickyLabelRef.current;
    if (stickyEl) {
      const edge = scrollOffsetRef.current;
      const all = markersRef.current;
      let active: Marker | null = null;
      let next: Marker | null = null;
      // Markers come out of the loop in chronological order, so a plain
      // walk forward finds the last one that has started. There are a few
      // dozen of them (the window is a few viewports wide), not thousands.
      for (const marker of all) {
        if (marker.x <= edge) active = marker;
        else {
          next = marker;
          break;
        }
      }
      // Before the first period of the mounted window — which happens at
      // the very left end of the track — the first one is the right answer.
      const label = (active ?? all[0])?.full ?? "";
      if (stickyEl.textContent !== label) {
        stickyEl.textContent = label;
        // Measured only when the text changes, not per frame: reading
        // layout here every frame would force a reflow after the writes.
        stickyEl.dataset.width = String(stickyEl.offsetWidth);
      }
      stickyEl.style.visibility = label ? "visible" : "hidden";
      // The next period's label pushes this one out to the left instead of
      // sliding underneath it — under it, "Februar 2023" read as "…ebruar
      // 2023" behind the pinned "Januar 2023".
      const width = Number(stickyEl.dataset.width) || 0;
      const room = active && next ? next.x - edge : Infinity;
      const push = room < width ? Math.round(room - width) : 0;
      const transform = push < 0 ? `translateX(${push}px)` : "";
      if (stickyEl.style.transform !== transform) stickyEl.style.transform = transform;
    }

    // Phase bar titles, kept readable while a bar's start is scrolled past
    // the left edge: the title slides along to sit just right of its
    // Themenbereich's label, until it runs out of bar. Same reason as the
    // sticky label above for doing it here — it moves with every frame.
    // Only writes; the label ends were measured when the rows last changed.
    const titleEls = phaseTitleEls.current;
    if (titleEls.size > 0) {
      const edge = scrollOffsetRef.current;
      const written = phaseTitleWritten.current;
      for (const bar of phaseBarsRef.current) {
        const el = titleEls.get(bar.entry.phase.id);
        if (!el) continue;
        const inset = (phaseLabelEnds.current.get(bar.entry.groupId) ?? 0) + PHASE_TITLE_LABEL_GAP;
        // Not capped to leave a minimum of room: when only a sliver of the
        // bar still shows right of the label column, the title starts at
        // the column's edge and ellipsizes there — a cap that kept 48px of
        // title would park its start under the column and show a cut-off
        // word ending ("…straße").
        const slide = Math.round(Math.max(0, Math.min(edge + inset - bar.left, bar.width)));
        const room = Math.round(bar.width - slide);
        const key = slide + "|" + room;
        if (written.get(bar.entry.phase.id) === key) continue;
        written.set(bar.entry.phase.id, key);
        el.style.transform = slide > 0 ? `translateX(${slide}px)` : "";
        el.style.maxWidth = `${room}px`;
      }
    }

    // --- Resting layout, resolved per lane --------------------------------
    //
    // Two things a tile has to satisfy cannot be decided while writing one
    // tile at a time, because both are properties of the lane as a whole:
    // it must stay inside the period it belongs to (a tile centered on a
    // date near a gridline would otherwise hang across it and claim the
    // neighbouring period), and it must not overlap the tile next to it.
    //
    // So the boxes are built first, resolved against those two constraints
    // in that order, and only then written out by the loop below. One box
    // per group — its three cascade tiles share it — or one per lone item.
    const periods = columnMarkersRef.current;
    // Writes the period containing `x` into `out` and reports whether there
    // was one, rather than returning a fresh {start, end}: this runs once
    // per tile per frame, and the object it used to allocate was one of the
    // per-frame garbage sources this pass exists to remove (see the pool
    // below).
    const periodAt = (x: number, out: { boundsStart: number; boundsEnd: number }): boolean => {
      if (periods.length < 2) return false;
      const typical = periods[1].x - periods[0].x;
      if (typical <= 0) return false;
      // Beyond either end of the mounted window the periods simply continue;
      // stepping on by the typical length keeps a tile out there clamped too,
      // rather than leaving it the one that may hang across a gridline.
      if (x < periods[0].x) {
        const steps = Math.ceil((periods[0].x - x) / typical);
        out.boundsStart = periods[0].x - steps * typical;
        out.boundsEnd = periods[0].x - (steps - 1) * typical;
        return true;
      }
      // Periods come out of the marker loop in order, and a lane holds a few
      // dozen boxes against a few dozen periods, so a walk is enough.
      for (let i = periods.length - 1; i >= 0; i--) {
        if (periods[i].x <= x) {
          const end = i + 1 < periods.length ? periods[i + 1].x : periods[i].x + typical;
          if (end <= periods[i].x) return false;
          out.boundsStart = periods[i].x;
          out.boundsEnd = end;
          return true;
        }
      }
      return false;
    };

    // Reused across frames, never reallocated — see the pool refs. Cleared
    // here rather than at the end so a bailout above can't leave the next
    // frame reading last frame's boxes.
    const restingBoxes = restingBoxesRef.current;
    restingBoxes.clear();
    {
      const byLane = byLaneRef.current;
      const seen = seenKeysRef.current;
      seen.clear();
      // The lanes' arrays are kept and truncated, not dropped: discarding
      // them would hand four arrays per frame back to the collector, which
      // is the thing this is removing.
      for (const list of byLane.values()) list.length = 0;
      // Hand out pooled entries by cursor. Each one owns its `box` object for
      // the lifetime of the component, so a frame allocates nothing per tile
      // — previously it was one Entry, one RestingBox and one bounds object
      // each, every frame, for every mounted tile.
      const pool = entryPoolRef.current;
      let poolCursor = 0;
      tileRefs.current.forEach((el, id) => {
        const item = itemById.get(id);
        if (!item) return;
        const group = clusterByItemId.get(id);
        const key = group ? group[0].id : id;
        if (seen.has(key)) return;
        seen.add(key);

        // The pool grows to the high-water mark of mounted tiles and stays
        // there; after the first few frames of a session this never runs.
        if (poolCursor === pool.length) {
          pool.push({ key: "", anchorX: 0, box: { left: 0, tileWidth: 0, extent: 0, laneScale: 1 }, hasBounds: false, boundsStart: 0, boundsEnd: 0 });
        }
        const entry = pool[poolCursor++];

        const anchorX = group
          ? (trackX(group[0].resolved_timestamp) + trackX(group[group.length - 1].resolved_timestamp)) / 2
          : parseFloat(el.dataset.x ?? "0");
        const falloff = Math.pow(1 - Math.min(1, Math.abs(anchorX - viewportCenter) / Math.max(halfWidth, 1)), 1.6);
        const laneScale = laneLayout.tileScale;
        const cascadePx = Math.max(0, Math.min(group?.length ?? 1, STACK_DEPTH) - 1) * STACK_STEP_X;
        entry.hasBounds = periodAt(anchorX, entry);
        const periodPx = entry.hasBounds ? entry.boundsEnd - entry.boundsStart : MARKER_PERIOD_DAYS[columns] * pixelsPerDay;
        // Never wider than the period it sits in, and never wider than the
        // distance that decided the grouping — a tile drawn larger than the
        // threshold that formed its group could reach its neighbour, which
        // is exactly the overlap this has to rule out. That caps the
        // fish-eye's magnification at the threshold instead of 1.35x.
        // Everything here is in drawn pixels, lane factor included, so the
        // collision test below compares what is actually on screen.
        const natural = (BASE_MIN_SCALE + (BASE_MAX_SCALE - BASE_MIN_SCALE) * falloff) * TILE_SIZE * laneScale;
        const cap = Math.min(
          // Fits inside its own period, cascade and all.
          periodPx - cascadePx,
          // And no wider than the distance that decided the grouping: a tile
          // drawn larger than the threshold that formed its group could
          // reach its neighbour, which is the overlap this has to rule out.
          // That caps the fish-eye's magnification at the threshold rather
          // than at 1.35x.
          Math.min(TILE_SIZE, MARKER_PERIOD_DAYS[columns] * pixelsPerDay) * laneScale - cascadePx,
        );
        const tileWidth = Math.max(4, Math.min(natural, cap));
        // Fields written in place on the pooled entry and its own box.
        entry.key = key;
        entry.anchorX = anchorX;
        const box = entry.box;
        box.left = anchorX - (tileWidth + cascadePx) / 2;
        box.tileWidth = tileWidth;
        box.extent = tileWidth + cascadePx;
        box.laneScale = laneScale;

        // Inside its own period, by shifting rather than by shrinking:
        // shrinking an off-centre date would make it a fraction of its
        // neighbours' size for no reason the viewer can see.
        if (entry.hasBounds) {
          const room = entry.boundsEnd - entry.boundsStart;
          if (box.extent > room) {
            box.tileWidth = Math.max(4, box.tileWidth - (box.extent - room));
            box.extent = room;
          }
          box.left = Math.min(Math.max(box.left, entry.boundsStart), entry.boundsEnd - box.extent);
        }

        const lane = laneForFileType(item.file_type);
        const list = byLane.get(lane);
        if (list) list.push(entry);
        else byLane.set(lane, [entry]);
      });

      // Left to right, push anything that still runs into its neighbour.
      // The grouping rule already keeps boxes apart on its own; what can
      // still collide is two boxes that were both shifted inward from
      // opposite edges of the same period.
      for (const list of byLane.values()) {
        list.sort((a, b) => a.box.left - b.box.left);
        let prevRight = -Infinity;
        for (const entry of list) {
          if (entry.box.left < prevRight) entry.box.left = prevRight;
          // A push must not become the thing that puts a box across a
          // gridline, so the period is applied again after it — narrowing
          // the box if the room that is left demands it.
          if (entry.hasBounds) {
            const room = entry.boundsEnd - entry.boundsStart;
            if (entry.box.extent > room) {
              entry.box.tileWidth = Math.max(4, entry.box.tileWidth - (entry.box.extent - room));
              entry.box.extent = room;
            }
            entry.box.left = Math.min(Math.max(entry.box.left, entry.boundsStart), entry.boundsEnd - entry.box.extent);
          }
          prevRight = entry.box.left + entry.box.extent;
          restingBoxes.set(entry.key, entry.box);
        }
      }
    }

    tileRefs.current.forEach((el, id) => {
      if (tileDragState.current?.itemId === id) return; // being dragged — leave its manual position alone
      const trackLeft = parseFloat(el.dataset.x ?? "0");
      // Reset every frame — the coarse-mode branches below are the only
      // place that hide a tile, so anything else renders normally and
      // interactively again the instant it no longer applies (zoomed past
      // a threshold, level changed, etc.), with no stale "none" left over.
      el.style.pointerEvents = "auto";
      // Search highlighting rides along with the layout pass: this function
      // owns these elements' class list, and React would wipe an
      // imperatively toggled class the moment a *dynamic* className prop
      // changed — taking --dragging with it. Dimming a non-hit is
      // deliberately a `filter` in CSS rather than an opacity, since opacity
      // is written inline here, per frame, and the two would fight.
      el.classList.toggle("timeline-tile--match", matchIdSet?.has(id) === true);
      el.classList.toggle("timeline-tile--nomatch", matchIdSet != null && !matchIdSet.has(id));
      el.classList.toggle("timeline-tile--match-active", activeMatchId === id);
      el.classList.toggle("timeline-tile--return-pulse", pulseId === id);

      const item = itemById.get(id);
      const itemLaneScale = laneLayout.tileScale;
      // Screen Y of this tile's resting anchor — its lane's center, since
      // the track is laid out to the container's own height (no vertical
      // scrolling), so track-space Y and screen Y are the same thing. Every
      // branch below clamps against it so no tile can leave the viewport
      // vertically, whatever mode or magnification it's rendering at.
      const anchorY = (containerHeight * (item ? laneCenterPercent(laneLayout, item.file_type) : 50)) / 100;
      // Where this tile rests: a lone tile on its own date, a group member
      // at the center of the group's own span, which is what makes a group
      // read as one object rather than as a row of overlapping ones. The
      // anchor is computed once here and reused by the hover branch below,
      // so a hover always grows out of and returns to exactly the point the
      // tile was resting at instead of snapping to a different reference.
      //
      // No period cap and no inward nudge any more: both only existed
      // because a tile used to be as wide as its calendar bucket (at
      // one-year zoom, 133px of tile inside a 133px month), which is the
      // same arithmetic that made everything within a month overlap. A tile
      // is now the size the fish-eye gives it, nothing else.
      const group = item ? clusterByItemId.get(id) : undefined;
      const stackIndex = group ? stackIndexIn(group, id, stackFrontId) : -1;
      const resolvedBox = restingBoxes.get(group ? group[0].id : id);
      const restAnchorX = resolvedBox
        ? resolvedBox.left + resolvedBox.tileWidth / 2
        : group && group.length > 0
          ? (trackX(group[0].resolved_timestamp) + trackX(group[group.length - 1].resolved_timestamp)) / 2
          : trackLeft;
      // Measured from where the tile actually sits, not from its own date —
      // for a group member the two differ, and the fish-eye has to follow
      // what is on screen.
      const restFalloff = Math.pow(
        1 - Math.min(1, Math.abs(restAnchorX - viewportCenter) / Math.max(halfWidth, 1)),
        1.6,
      );
      // Size and resting position both come from the per-lane pass above,
      // which is the only place that can see a tile's neighbours and its
      // period. Everything here just reads the answer.
      // Already in drawn pixels with the lane factor in it, so this is the
      // final scale — the branch below must not apply the lane factor again.
      const effRestScale = resolvedBox ? resolvedBox.tileWidth / TILE_SIZE : BASE_MIN_SCALE * itemLaneScale;
      const restScale = effRestScale / Math.max(itemLaneScale, 0.01);

      if (id === hoveredId && !hoverSuppressedRef.current) {
        const effScale = HOVER_SCALE * itemLaneScale;
        const half = (TILE_SIZE * effScale) / 2;
        const dx =
          restAnchorX - trackLeft + clampCorrection(restAnchorX - scrollOffsetRef.current, half, container.clientWidth);
        const dy = verticalClamp(anchorY, half * tileHf, item!.file_type);
        el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${effScale})`;
        el.style.zIndex = "30";
        el.style.opacity = "1";
        return;
      }

      // The one resting layout. A member past the cascade's depth is not
      // drawn at all — it is normally not even mounted (see visibleItems),
      // this covers the single frame after a zoom step where it still is.
      if (stackIndex >= STACK_DEPTH) {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        return;
      }

      // Depth offsets: back tiles peek out above and to the right of the
      // front one. Fixed step in screen pixels, so a cascade looks the same
      // at every zoom — it says "several files", which is not a quantity
      // that should appear to change with the zoom.
      const depth = Math.max(0, stackIndex);
      const offsetX = depth * STACK_STEP_X;
      const offsetY = -depth * STACK_STEP_Y;
      const dx = restAnchorX - trackLeft + offsetX;
      const dy =
        offsetY + verticalClamp(anchorY + offsetY, (TILE_SIZE * effRestScale * tileHf) / 2, item ? item.file_type : "image");
      el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${effRestScale})`;
      // Three things at once, in priority order: a cluster (2+ members) must
      // never sit under a lone tile, however close that lone tile is to the
      // viewport centre — a single frame from 01.01. must never cover a
      // cluster in June of the same year just because it happens to be
      // nearer the fish-eye's focus. Within that, tiles nearer the centre
      // lie above tiles further out (the fish-eye's depth cue), and within
      // one group the front tile lies above its own back tiles.
      //
      // CLUSTER_Z_BAND separates the two tiers (a lone tile can reach at
      // most 14, a cluster starts at 21 — see the range below), low enough
      // that a cluster still stays below the hovered tile's fixed 30: hover
      // deliberately keeps winning over a resting cluster, just not a
      // resting lone tile over a resting cluster.
      //
      // Doubling the centre term leaves room for the depth subtraction
      // underneath it: restScale rounds to {4..7} at this coarseness, so
      // *2 spaces adjacent levels 2 apart — enough for depth (0..2, see
      // STACK_DEPTH) to never push a nearer tile's back member below a
      // farther tile's front member.
      const isCluster = group != null && group.length > 1;
      const CLUSTER_Z_BAND = 15;
      el.style.zIndex = String((isCluster ? CLUSTER_Z_BAND : 0) + Math.round(restScale * 5) * 2 - depth);
      el.style.opacity = String(FISHEYE_MIN_OPACITY + FISHEYE_OPACITY_SPREAD * restFalloff);
    });
  }, [hoveredId, clusterByItemId, trackX, level, columns, itemById, pixelsPerDay, matchIdSet, activeMatchId, pulseId, stackFrontId, laneLayout]);

  // Always points at the newest applyFishEye. scheduleFishEye's rAF callback
  // reads through this ref instead of closing over applyFishEye directly —
  // see scheduleFishEye for why that distinction matters.
  const applyFishEyeRef = useRef(applyFishEye);
  applyFishEyeRef.current = applyFishEye;

  // Coalesces bursts of triggers (rapid wheel ticks, mousemoves) into one
  // tile-layout pass per frame. The dedup gate below (if a rAF is already
  // pending, skip scheduling another) is correct, but the callback it
  // schedules must NOT close over `applyFishEye` directly: during a fast
  // zoom burst, several renders (each producing a new applyFishEye closure
  // with the latest level/pixelsPerDay/clusterByItemId) can happen before a
  // single rAF fires, since the gate makes every scheduleFishEye() call
  // after the first a no-op for that frame — including the ones holding the
  // up-to-date closure. Whichever applyFishEye happened to be in scope when
  // the FIRST scheduleFishEye() of the frame ran would otherwise be the one
  // that executes, applying stale period/scale math against DOM positions
  // that already reflect the newer state. Reading applyFishEyeRef.current()
  // at fire time instead always applies the latest state, regardless of
  // which call won the scheduling race.
  const scheduleFishEye = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyFishEyeRef.current();
    });
  }, []);

  // There is deliberately NO effect syncing pixelsPerDayRef back from the
  // `pixelsPerDay` state. One used to live here, and it was the cause of the
  // timeline jumping years away mid-zoom.
  //
  // The ref leads the state during a wheel burst — that is its whole purpose
  // (see its own comment): handleWheel writes it every tick, while React
  // commits the matching state later and at continuous priority. An effect
  // keyed on the state therefore fires with a value several ticks old and
  // wrote it back over the current one, dropping the scale backwards
  // mid-gesture. Measured, not inferred: the ref stood at 11.5984 px/day
  // when a commit carrying 8.3298 reset it, and the next tick zoomed from
  // the older number.
  //
  // The damage went beyond a stutter, because scrollOffsetRef still held the
  // offset belonging to the newer scale. With the pair mismatched, the
  // cursor-position-to-date branch in handleWheel back-computed the anchor
  // through the wrong divisor and moved it by exactly the ratio between the
  // two scales — a 1.39x mismatch turned a 2008 anchor into 2020.
  //
  // It is not needed either: every path that changes the zoom sets both the
  // ref and the state itself (handleWheel, focusOnItem, zoomIntoGroup, and
  // the initial auto-fit). Keep it that way — a path that sets only the
  // state would silently reintroduce this.

  // Re-derive the discrete zoom level whenever pixelsPerDay changes (wheel
  // zoom, auto-fit, or a resize affecting viewport width) — see nextLevel
  // for the duration-vs-viewport-width threshold model. handleWheel itself
  // needs no awareness of levels; pixelsPerDay keeps driving continuously
  // exactly as before, this just derives which cluster/marker granularity
  // is currently active from it.
  useEffect(() => {
    const viewportWidth = scrollRef.current?.clientWidth;
    if (!viewportWidth) return;
    setLevel((current) => nextLevel(current, pixelsPerDay, viewportWidth));
  }, [pixelsPerDay]);

  useEffect(() => {
    return () => {
      if (hoverClearTimeout.current != null) window.clearTimeout(hoverClearTimeout.current);
      if (clusterCloseTimeout.current != null) window.clearTimeout(clusterCloseTimeout.current);
      if (fanOpenTimeout.current != null) window.clearTimeout(fanOpenTimeout.current);
      if (interactionIdleTimeout.current != null) window.clearTimeout(interactionIdleTimeout.current);
      if (hoverSuppressTimeout.current != null) window.clearTimeout(hoverSuppressTimeout.current);
      if (frameProfileRaf.current != null) cancelAnimationFrame(frameProfileRaf.current);
      pileGridResizeObserverRef.current?.disconnect();
    };
  }, []);

  // Hover and fan state are dropped when the zoom level changes.
  //
  // The original reason was that crossing a resting-mode boundary could
  // turn the hovered tile into a culled one — whose own mouseleave then
  // never fires, because the element moves out from under a stationary
  // cursor rather than the cursor moving off it, leaving a tile stuck at
  // HOVER_SCALE. The modes are gone and a hovered tile is now always
  // mounted (see visibleItems), so that exact trap is closed. What remains
  // is the general case: a level change is a large zoom change, after which
  // the group under the pointer is usually a different one, and dropping
  // both is the one state guaranteed consistent afterwards.
  useEffect(() => {
    if (hoverClearTimeout.current != null) {
      window.clearTimeout(hoverClearTimeout.current);
      hoverClearTimeout.current = null;
    }
    if (clusterCloseTimeout.current != null) {
      window.clearTimeout(clusterCloseTimeout.current);
      clusterCloseTimeout.current = null;
    }
    if (fanOpenTimeout.current != null) {
      window.clearTimeout(fanOpenTimeout.current);
      fanOpenTimeout.current = null;
    }
    pendingFanRef.current = null;
    fanEnteredRef.current = false;
    setHoveredId(null);
    setOpenFan(null);
    scheduleFishEye();
  }, [level, columns, setOpenFan, scheduleFishEye]);

  // The same state can also be outlived by its own items: a removal drops
  // the hovered tile, a timestamp edit re-buckets its cluster. A stale
  // open fan was worse than it looked — checkClusterStillHovered
  // bails out at `if (!group) return`, so it never scheduled a close and
  // the ref stayed set for the rest of the session, with every later
  // scheduleClusterClose short-circuiting against a cluster that no longer
  // existed.
  useEffect(() => {
    if (hoveredId != null && !itemById.has(hoveredId)) setHoveredId(null);
    const openKey = openFanRef.current?.key;
    if (openKey != null && !clusterByItemId.has(openKey)) {
      setOpenFan(null);
      scheduleFishEye();
    }
  }, [itemById, clusterByItemId, hoveredId, setOpenFan, scheduleFishEye]);

  // Optional: once per opened pile, move the real pointer onto the grid
  // tile whose member the hero shows, so it doesn't stay behind over empty
  // space where the pile used to be (see utils/fanCursor). Waits a frame for
  // the grid to actually be laid out — `openFan` only changes at open/close,
  // never while the user is choosing a different member inside an already
  // open pile, so this can't fight a manual hover.
  useEffect(() => {
    if (!openFan) {
      fanPointerPlacedRef.current = false;
      return;
    }
    if (fanPointerPlacedRef.current || !fanCursorFollow) return;
    fanPointerPlacedRef.current = true;
    const raf = requestAnimationFrame(() => {
      const el = pileTileRefs.current.get(openFan.focusId);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      warpPointerTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [openFan, fanCursorFollow]);

  useEffect(() => {
    scheduleFishEye();
    // `level` must be listed explicitly: scheduleFishEye's identity is now
    // stable (see its own comment), so it can no longer double as an
    // implicit signal for applyFishEye's other reactive inputs the way it
    // used to. clusterByItemId/itemById/trackX are themselves pure
    // derivations of items/pixelsPerDay (plus epoch, which only depends on
    // items), so items+level+pixelsPerDay here covers applyFishEye's full
    // dependency set.
  }, [items, pixelsPerDay, level, columns, thumbs, hoveredId, scheduleFishEye]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // No native "scroll" listener anymore — scrollOffsetRef is applied via
    // transform, not container.scrollLeft, so nothing ever fires a native
    // scroll event here (see scrollOffsetRef's comment). Every place that
    // changes the offset calls scheduleFishEye() itself instead.
    //
    // A ResizeObserver rather than a window "resize" listener: the lane area
    // can change size without the window doing so (fullscreen toggle, a
    // reflowing header), and every one of those cases left all tiles at a
    // stale vertical position until some unrelated interaction forced a
    // repass. It also fires once on observe, which is what seeds
    // viewportWidth.
    const handleResize = () => {
      setViewportWidth(container.clientWidth);
      setStackHeight(container.clientHeight - (headerRef.current?.offsetHeight ?? 0));
      scheduleFishEye();
      // A resize can change the viewport-width side of the level threshold
      // without pixelsPerDay itself changing, so it needs its own check —
      // see the pixelsPerDay-driven effect above for the normal path.
      setLevel((current) => nextLevel(current, pixelsPerDayRef.current, container.clientWidth));
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    return () => observer.disconnect();
    // items.length is a dependency, not noise: .timeline__scroll isn't
    // rendered at all while the project is empty, so on the very first run
    // scrollRef is null and there is nothing to observe yet.
  }, [scheduleFishEye, items.length]);

  // Keeps the cluster type-filter checkboxes remembered across openings —
  // different years, different sessions — rather than resetting every time.
  useEffect(() => {
    try {
      localStorage.setItem(CLUSTER_FILTER_STORAGE_KEY, JSON.stringify(clusterTypeFilter));
    } catch {
      // Not fatal — worst case the choice just doesn't persist this time.
    }
  }, [clusterTypeFilter]);

  // Writes scrollOffsetRef and reflects it onto the track via transform —
  // the single place that moves the "scroll" position. Clamped to the
  // valid [0, maxScroll] range ourselves, since there's no native overflow
  // scrolling left to do that for us (see scrollOffsetRef's comment).
  function applyScrollOffset(offset: number) {
    const container = scrollRef.current;
    const track = trackRef.current;
    if (!container || !track) return;
    const clamped = storeScrollOffset(offset, container);
    // Written BEFORE ensureRenderWindow, and reading the window it was
    // written against: the DOM still holds `left` values measured from the
    // old origin until React re-renders, so the transform has to counter
    // that same old origin. Widening the window below may move the origin;
    // the layout effect re-applies this in the commit that also rewrites
    // every `left`, which is what keeps the two from disagreeing.
    const shift = clamped - (renderWindowRef.current?.min ?? 0);
    track.style.transform = `translateX(${-shift}px)`;
    if (headerTrackRef.current) headerTrackRef.current.style.transform = `translateX(${-shift}px)`;
    if (phaseTrackRef.current) phaseTrackRef.current.style.transform = `translateX(${-shift}px)`;
    ensureRenderWindow(clamped, container.clientWidth);
  }

  /// Clamps and publishes the offset without touching the DOM, and returns
  /// what it settled on.
  function storeScrollOffset(offset: number, container: HTMLDivElement) {
    // The scroll range comes from the logical width, not from the element:
    // the element only spans the mounted window now (see `trackOrigin`), and
    // during a zoom gesture the ref is ahead of the React-state width anyway.
    const maxScroll = Math.max(0, totalWidthRef.current - container.clientWidth);
    const clamped = Math.min(maxScroll, Math.max(0, offset));
    scrollOffsetRef.current = clamped;
    return clamped;
  }

  /// The zoom's counterpart to applyScrollOffset: publishes the new offset
  /// but deliberately does NOT write the transform.
  ///
  /// A zoom changes two things that must land together — where every tile
  /// and gridline sits (React writes those as `left`, from the pixelsPerDay
  /// *state*) and how far the track is shifted (a transform, written from
  /// the *ref*, synchronously). Writing the shift here, in the wheel
  /// handler, put the new offset on screen against positions still measured
  /// at the old scale. A wheel event carries continuous priority in React,
  /// so that mismatch can actually be painted: for one frame the whole track
  /// sat off by (trackX_old − trackX_new), which is proportional to the
  /// distance from the epoch — visible as the view jumping a tile to one
  /// side and snapping back. Zooming in showed the tile to the right of the
  /// cursor, zooming out the one to the left, which is exactly the sign of
  /// that term in each direction.
  ///
  /// Leaving the transform alone means the pre-commit frame shows the old
  /// scale AND the old offset: stale by one frame, but internally
  /// consistent, so nothing moves that shouldn't. The layout effect on
  /// `totalWidth` then applies offset, positions and scale in a single
  /// commit before paint.
  function deferScrollOffset(offset: number) {
    const container = scrollRef.current;
    if (!container) return;
    const clamped = storeScrollOffset(offset, container);
    ensureRenderWindow(clamped, container.clientWidth);
  }

  // Widens the mounted track-space window when the visible region gets too
  // close to its edge, and otherwise does nothing — this is called from the
  // scroll/zoom path, several times per frame, so it must not set state on
  // every call. See RENDER_MARGIN_VIEWPORTS for the sizing.
  function ensureRenderWindow(offset: number, width: number) {
    if (width <= 0) return;
    const current = renderWindowRef.current;
    const next = {
      min: offset - RENDER_MARGIN_VIEWPORTS * width,
      max: offset + width + RENDER_MARGIN_VIEWPORTS * width,
    };

    const coversView =
      current != null &&
      current.min <= offset - RENDER_REFRESH_VIEWPORTS * width &&
      current.max >= offset + width + RENDER_REFRESH_VIEWPORTS * width;
    // Covering the view is not enough on its own — the window also has to
    // stop being far WIDER than it needs to be. It is measured in track
    // pixels, and zooming out shrinks the whole track underneath it, so a
    // window set while zoomed in still "covers the view" afterwards while
    // spanning orders of magnitude more track than it should. Nothing
    // narrowed it, and two things then came off their leash: the mounting
    // decision stopped limiting anything, and the marker loop converted
    // that window back into time at the new zoom and tried to draw years
    // of periods. With hourly periods at the day level that was hundreds of
    // thousands of markers and a frozen renderer.
    const wastefullyWide = current != null && current.max - current.min > (next.max - next.min) * 2;
    if (coversView && !wastefullyWide) return;

    renderWindowRef.current = next;
    setRenderWindow(next);
  }

  // The offset is only ever clamped where it's written (applyScrollOffset),
  // and neither the initial auto-fit nor a resize goes through there — they
  // just change pixelsPerDay (and with it the track's width) or the
  // viewport. Whenever the track got NARROWER as a result, the stale
  // transform was left pointing past its new end and the user was looking
  // at blank space until something else happened to scroll — e.g. coming
  // back to the timeline after an import, which re-fits the whole range.
  // Re-applying the current offset re-runs the clamp; it's a no-op whenever
  // the offset still fits, which is the common case.
  // `renderWindow` is in here for a second reason beyond the clamp: it is
  // the track origin, so when it moves every `left` in the DOM changes with
  // it. Re-applying the offset in the same commit (a layout effect, before
  // paint) moves the transform by the same amount, which is what keeps the
  // two from disagreeing for a frame and jumping the whole track sideways.
  useLayoutEffect(() => {
    applyScrollOffset(scrollOffsetRef.current);
    // Synchronously, not through the rAF queue: this effect fires exactly on
    // the renders that move the React-written `left` of every tile (a zoom
    // changes totalWidth, a pan far enough changes the window origin). The
    // transform and scale that go with them are written imperatively, so if
    // that happens a frame later the two disagree for exactly one frame —
    // measured as tiles crossing their gridlines and overlapping each other
    // in that frame, then settling. Running it here puts both in the same
    // commit, before paint. The rAF path stays for everything else, where
    // coalescing a burst of triggers into one pass per frame is the point.
    //
    // `level` is in the dependencies for the same reason, and it is the less
    // obvious one: the level changes in its own render, one after the zoom
    // that caused it, and it changes what the markers divide by. Without it
    // there was a frame showing hourly gridlines while the tiles were still
    // sized against the day the level had just left — a tile at full size
    // across several hour lines. The markers themselves need no dependency
    // of their own: they are derived from level, pixelsPerDay (through
    // totalWidth) and renderWindow, all of which are here.
    //
    // `phaseAreaPx` joins them for the phase area: when it appears, its
    // track needs the current transform before its first paint, and when it
    // changes height the lane area below shrinks or grows, which moves every
    // lane's band, the tile height factor (--lane-tile-hf) and with them the
    // vertical clamp of every tile. Showing or hiding a phase therefore
    // costs exactly one pass here, before paint, and no tile remounts.
    applyFishEyeRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalWidth, viewportWidth, renderWindow, level, columns, phaseAreaPx]);

  // The label column is as wide as its longest label plus the insets, so
  // everything stays readable without the column taking more room than it
  // needs. Capped so one very long Themenbereich name cannot eat the
  // timeline — its label then ellipsizes and carries the full name as a
  // tooltip.
  const labelTexts = phaseRows.map((r) => r.group.name).join("\u0001") + "\u0002" + laneLayout.lanes.join(",");
  // `labelsMounted` is a dependency of its own: the labels only exist once
  // the spinner is gone, and the texts don't have to change at that moment.
  // An empty timeline already keeps all four lanes, so with all four in use
  // and the Themenbereiche loaded before the items, this effect had its only
  // run with nothing to measure. The column then stayed unmeasured at its
  // CSS default, and the titles slid to a label end of 0 — under the column.
  const labelsMounted = !showLoadingSpinner && items.length > 0;
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let widest = 0;
    root.querySelectorAll<HTMLElement>(".timeline__lane-label").forEach((el) => {
      // At its natural width, padding and border included, for the length of
      // this read (before paint). scrollWidth cannot be used: the labels fill
      // the column, so it never drops below it. Nor can a range over the
      // text, which isn't safe to trust once the label is ellipsized. The
      // label is a flex item with overflow hidden, so it would shrink to the
      // column's current width and the column could never grow: no
      // shrinking while it is measured.
      el.style.width = "max-content";
      el.style.flexShrink = "0";
      widest = Math.max(widest, el.getBoundingClientRect().width);
      el.style.width = "";
      el.style.flexShrink = "";
    });
    const next = Math.min(Math.ceil(widest) + LABEL_COL_INSET * 2 + LABEL_INDENT, LABEL_COL_MAX);
    setLabelColW((cur) => (cur === next ? cur : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelTexts, labelsMounted, currentLanguage()]);

  // New or renamed Themenbereiche, or a new column width: where the label
  // column ends (the per-frame title pass must not read layout itself) and
  // the titles of whatever bars came with them.
  useLayoutEffect(() => {
    const ends = new Map<string, number>();
    for (const row of phaseRows) ends.set(row.group.id, labelColW);
    phaseLabelEnds.current = ends;
    phaseTitleWritten.current.clear();
    applyFishEyeRef.current();
  }, [phaseRows, labelColW]);

  // Arms (or re-arms) the hover-suppression window and, the first time it
  // opens during this gesture, drops whatever was hovered/pending so an
  // already-magnified tile or an about-to-open pile doesn't keep sitting
  // there while the view scrolls out from under it.
  // --- Phase bar hover popover -------------------------------------------
  //
  // Pinned below the bar's visible part when it opens and left there: it
  // neither follows the pointer nor reacts to it (pointer-events: none), so
  // it can't cover the bar and cause a leave/enter loop. Rendered into
  // <body>, so the timeline's overflow can't clip it.
  function clearPhasePopoverTimer() {
    if (phasePopoverTimer.current != null) {
      window.clearTimeout(phasePopoverTimer.current);
      phasePopoverTimer.current = null;
    }
  }

  function schedulePhasePopover(bar: PhaseBar, el: HTMLElement) {
    clearPhasePopoverTimer();
    // Not while dragging the view or right after a wheel step: the bar is
    // only passing under the pointer.
    if (dragState.current || hoverSuppressedRef.current || phaseMenu) return;
    const open = () => {
      phasePopoverTimer.current = null;
      // The bar may have left the render window during the wait.
      if (!el.isConnected) return;
      const rect = el.getBoundingClientRect();
      const view = scrollRef.current?.getBoundingClientRect();
      const area = phaseAreaRef.current?.getBoundingClientRect();
      setPhasePopover({
        entry: bar.entry,
        clipped: bar.cutStart || bar.cutEnd,
        anchor: {
          left: view ? Math.max(rect.left, view.left) : rect.left,
          right: view ? Math.min(rect.right, view.right) : rect.right,
          top: area ? Math.max(rect.top, area.top) : rect.top,
          bottom: area ? Math.min(rect.bottom, area.bottom) : rect.bottom,
        },
      });
    };
    // Already showing one: switch straight over to this bar.
    if (phasePopoverOpenRef.current) open();
    else phasePopoverTimer.current = window.setTimeout(open, PHASE_POPOVER_OPEN_MS);
  }

  function hidePhasePopoverSoon() {
    clearPhasePopoverTimer();
    if (!phasePopoverOpenRef.current) return;
    phasePopoverTimer.current = window.setTimeout(() => {
      phasePopoverTimer.current = null;
      setPhasePopover(null);
    }, PHASE_POPOVER_CLOSE_MS);
  }

  // Called on every wheel tick and pan move (via markInteracting), so it
  // only touches state when there is a popover to close.
  function hidePhasePopoverNow() {
    clearPhasePopoverTimer();
    if (phasePopoverOpenRef.current) {
      phasePopoverOpenRef.current = false;
      setPhasePopover(null);
    }
  }

  useEffect(() => () => clearPhasePopoverTimer(), []);

  // Places the popover before it is painted: centred under the bar's
  // visible part, kept inside the window, flipped above the bar when there
  // is no room below. Measured here because its width depends on the text.
  useLayoutEffect(() => {
    const el = phasePopoverElRef.current;
    if (!el || !phasePopover) return;
    const { anchor } = phasePopover;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const maxLeft = window.innerWidth - PHASE_POPOVER_MARGIN - width;
    const left = Math.max(PHASE_POPOVER_MARGIN, Math.min((anchor.left + anchor.right) / 2 - width / 2, maxLeft));
    const below = anchor.bottom + PHASE_POPOVER_MARGIN;
    const top = below + height <= window.innerHeight - PHASE_POPOVER_MARGIN ? below : anchor.top - PHASE_POPOVER_MARGIN - height;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(PHASE_POPOVER_MARGIN, top)}px`;
    el.style.visibility = "visible";
  }, [phasePopover]);

  function suppressHoverDuringScroll() {
    if (!hoverSuppressedRef.current) {
      hoverSuppressedRef.current = true;
      cancelPendingFan();
      setHoveredId(null);
    }
    if (hoverSuppressTimeout.current != null) window.clearTimeout(hoverSuppressTimeout.current);
    hoverSuppressTimeout.current = window.setTimeout(() => {
      hoverSuppressTimeout.current = null;
      hoverSuppressedRef.current = false;
    }, HOVER_SUPPRESS_MS);
  }

  // --- Gesture frame-time profiler (development diagnostics) -------------
  //
  // "Ruckelt beim Zoomen" is a feeling, not a number, and average FPS hides
  // exactly the thing being complained about: a run of good frames with a
  // few 50ms stalls in it averages out fine while looking broken. So this
  // records the interval between consecutive frames for the duration of one
  // gesture and reports the distribution (P50/P95/P99/max) when the gesture
  // settles — the tail is the signal, the mean is noise.
  //
  // Devtools are not usable in this WebKitGTK build, so this is how frame
  // timing gets measured at all here. The report goes through `debug_log`
  // into <app_config_dir>/debug.log rather than to console.*: this webview
  // does not forward its console to the Tauri process's stdout at all, so a
  // console-only report is invisible on the dev terminal — measured, not
  // assumed (a first attempt logged nothing whatsoever).
  //
  // Deliberately cheap enough not to measure itself: the sample buffer is
  // allocated once (a plain Float64Array — no per-frame objects, the GC
  // pause it would cause is the very thing being hunted), and sorting and
  // percentile math happen once at report time, never inside a frame.
  function startFrameProfile(label: string) {
    if (!FRAME_PROFILE_ENABLED) return;
    // A gesture already being measured just continues — markInteracting is
    // called on every wheel tick, and restarting per tick would reduce every
    // sample set to a single frame.
    if (frameProfileRaf.current != null) return;
    frameProfileLabel.current = label;
    frameSampleCount.current = 0;
    frameProfileLast.current = performance.now();
    const tick = () => {
      const now = performance.now();
      if (frameSampleCount.current < FRAME_SAMPLE_CAP) {
        frameSamples.current[frameSampleCount.current++] = now - frameProfileLast.current;
      }
      frameProfileLast.current = now;
      frameProfileRaf.current = requestAnimationFrame(tick);
    };
    frameProfileRaf.current = requestAnimationFrame(tick);
  }

  function reportFrameProfile() {
    if (frameProfileRaf.current == null) return;
    cancelAnimationFrame(frameProfileRaf.current);
    frameProfileRaf.current = null;

    // Up to the last gesture event only, dropping the settling window's idle
    // frames — see frameProfileActiveCount.
    const n = Math.min(frameSampleCount.current, frameProfileActiveCount.current);
    // The first sample spans from startFrameProfile to the first frame, which
    // is a partial interval rather than a frame time; two samples are the
    // minimum for one real one.
    if (n < 2) return;
    const sorted = Array.from(frameSamples.current.subarray(1, n)).sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const over = (ms: number) => sorted.filter((d) => d > ms).length;
    const fmt = (v: number) => v.toFixed(1);
    // 16.67ms is the 60Hz budget from the architecture notes; frames past it
    // are dropped ones, and their share is the honest "how bad is it".
    frameProfileLog(
      `[timeline-frames] ${frameProfileLabel.current}: ${sorted.length} frames | ` +
        `P50 ${fmt(at(50))}ms P95 ${fmt(at(95))}ms P99 ${fmt(at(99))}ms max ${fmt(sorted[sorted.length - 1])}ms | ` +
        `>16.7ms: ${over(16.67)} (${((over(16.67) / sorted.length) * 100).toFixed(0)}%) >50ms: ${over(50)}`,
    );
  }

  // Tile transitions are for hover and fan-out, not for zooming or panning.
  // During a gesture they actively hurt: marker lines are positioned with
  // `left` and jump to their new place the instant the track is rewidened,
  // while the tiles ease toward theirs over 150ms — so the whole tile layer
  // visibly lags behind its own gridlines for the length of every wheel
  // tick. It also means one transition per mounted tile per tick, all
  // competing on the compositor. Snap during the gesture, ease again once
  // it stops.
  function markInteracting(label = "interaction") {
    // The popover is pinned to where the bar was; once the view moves it
    // would point at nothing.
    hidePhasePopoverNow();
    const track = trackRef.current;
    if (track) track.classList.add("timeline__track--instant");
    startFrameProfile(label);
    // This call IS a gesture event, so every sample up to now was under load.
    frameProfileActiveCount.current = frameSampleCount.current;
    if (interactionIdleTimeout.current != null) window.clearTimeout(interactionIdleTimeout.current);
    interactionIdleTimeout.current = window.setTimeout(() => {
      interactionIdleTimeout.current = null;
      trackRef.current?.classList.remove("timeline__track--instant");
      // The idle timeout firing IS the gesture having settled — the same
      // signal that re-enables the transitions ends the measurement.
      reportFrameProfile();
    }, INTERACTION_IDLE_MS);
  }

  // Wheel steps that were meant for opening or closing the detail viewer
  // keep arriving for a moment after it has done so (a flick sends a dozen
  // events). Until this moment passes they must reach neither the freed
  // image zoom nor the timeline's zoom, or the gesture that opened the
  // viewer would zoom the picture, and the one that closed it would zoom
  // the timeline out and collapse the stack.
  const wheelNavLockUntilRef = useRef(0);
  // Backward steps collected towards closing the viewer, in pixels.
  const wheelBackRef = useRef({ sum: 0, last: 0 });
  const WHEEL_NAV_LOCK_MS = 700;
  // Two mouse notches (100 px each) or three of the finer 53 px kind.
  const WHEEL_CLOSE_PX = 150;
  const WHEEL_CLOSE_GAP_MS = 600;

  function lockWheelNav() {
    wheelNavLockUntilRef.current = performance.now() + WHEEL_NAV_LOCK_MS;
    wheelBackRef.current = { sum: 0, last: 0 };
  }

  /// One step forward over a stack's preview opens that file, like a click.
  function handlePreviewWheel(item: ItemInfo, ev: ReactWheelEvent<HTMLElement>) {
    if (!wheelViewer || ev.deltaY >= 0) return;
    ev.stopPropagation();
    if (performance.now() < wheelNavLockUntilRef.current) return;
    lockWheelNav();
    void openViewer(item);
  }

  /// Backward steps inside the detail viewer: only a run of them closes it.
  /// Not counted while the picture is zoomed (the wheel zooms it), nor over
  /// something that scrolls by itself (a document, a text field).
  function handleViewerWheel(ev: ReactWheelEvent<HTMLElement>) {
    if (!wheelViewer || freed) return;
    const now = performance.now();
    if (now < wheelNavLockUntilRef.current) return;
    const acc = wheelBackRef.current;
    if (ev.deltaY <= 0) {
      acc.sum = 0;
      return;
    }
    for (let el = ev.target as HTMLElement | null; el && el !== ev.currentTarget; el = el.parentElement) {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT") {
        acc.sum = 0;
        return;
      }
      if (el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          acc.sum = 0;
          return;
        }
      }
    }
    if (now - acc.last > WHEEL_CLOSE_GAP_MS) acc.sum = 0;
    acc.last = now;
    const px = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaMode === 2 ? ev.deltaY * window.innerHeight : ev.deltaY;
    acc.sum += px;
    if (acc.sum >= WHEEL_CLOSE_PX) {
      lockWheelNav();
      leaveViewer();
    }
  }

  function handleWheel(ev: React.WheelEvent) {
    const container = scrollRef.current;
    const track = trackRef.current;
    if (!container || !track) return;
    if (performance.now() < wheelNavLockUntilRef.current) {
      ev.preventDefault();
      return;
    }
    // Over a phase area holding more Themenbereiche than fit, the wheel
    // scrolls through them (natively, hence no preventDefault) instead of
    // zooming. With all rows in view it zooms like anywhere else.
    const phaseArea = phaseAreaRef.current;
    if (phaseArea && phaseArea.scrollHeight > phaseArea.clientHeight && phaseArea.contains(ev.target as Node)) {
      hidePhasePopoverNow();
      return;
    }
    ev.preventDefault();
    dropPhaseReturn();
    // Zooming beats the overlay rather than being swallowed by it. The pile
    // locks the timeline beneath for pointer hit-testing, but refusing to
    // zoom would strand the user on whatever the pointer happens to rest
    // on; collapsing first and letting the zoom through is the way out that
    // doesn't need them to find their way off the overlay by hand.
    closePileNow();
    markInteracting("wheel-zoom");
    suppressHoverDuringScroll();

    // Always read/write the ref, never the `pixelsPerDay` closure value —
    // see the comment on pixelsPerDayRef for why.
    const currentPxPerDay = pixelsPerDayRef.current;
    const rect = container.getBoundingClientRect();
    const cursorOffset = ev.clientX - rect.left;

    // Reuse the previous tick's anchor date as long as the cursor hasn't
    // actually moved — see wheelAnchorRef for why recomputing fresh every
    // tick is unsafe during a fast burst.
    const prevAnchor = wheelAnchorRef.current;
    const cursorMoved = !prevAnchor || Math.abs(ev.clientX - prevAnchor.clientX) > 3 || Math.abs(ev.clientY - prevAnchor.clientY) > 3;

    let dateUnderCursor: number;
    if (cursorMoved) {
      // If a tile is currently hovered, it may be visually displaced away
      // from its own baseline track position by the cluster fan-out (see
      // applyFishEye's restX/finalDx) — e.g. the user hovers a month's
      // cluster to look at it, one member tile ends up lifted and shifted
      // under their cursor. Reading the raw cursor pixel back into a
      // baseline date at that point would silently read off whatever date
      // the UNDISPLACED track happens to have at that screen position —
      // nowhere near the tile actually under the cursor. Anchor to the
      // hovered tile's real date instead whenever one is set.
      const hoveredItem = hoveredId ? items.find((i) => i.id === hoveredId) : undefined;
      const cursorX = cursorOffset + scrollOffsetRef.current;
      dateUnderCursor = hoveredItem
        ? new Date(hoveredItem.resolved_timestamp).getTime()
        : epoch + ((cursorX - EDGE_PADDING) / currentPxPerDay) * DAY_MS;
    } else {
      dateUnderCursor = prevAnchor.date;
    }
    wheelAnchorRef.current = { clientX: ev.clientX, clientY: ev.clientY, date: dateUnderCursor };

    const factor = ev.deltaY < 0 ? 1.18 : 1 / 1.18;
    // Floor at "the whole range fits the viewport" — not the fixed
    // MIN_PX_PER_DAY — so zooming out can't go further than that (nothing
    // useful past it, just empty space padding both sides).
    const fitPxPerDay = computeFitPxPerDay(container.clientWidth, (maxTime - epoch) / DAY_MS);
    const nextPxPerDay = Math.min(maxPxPerDayFor(container.clientWidth), Math.max(fitPxPerDay, currentPxPerDay * factor));
    pixelsPerDayRef.current = nextPxPerDay;

    // Publish the new scroll range and move the (transform-based) offset in
    // the same synchronous tick, before React re-renders — see
    // applyScrollOffset and scrollOffsetRef for why this never touches
    // scrollLeft. The track ELEMENT is not resized: its width follows the
    // mounted window, not the zoom (see `trackOrigin`).
    const prevTotalWidth = totalWidthRef.current;
    totalWidthRef.current = logicalWidthFor(nextPxPerDay);
    const newCursorX = ((dateUnderCursor - epoch) / DAY_MS) * nextPxPerDay + EDGE_PADDING;
    const targetOffset = newCursorX - cursorOffset;

    // Hand the offset to the commit that also moves the tiles, rather than
    // putting it on screen against the old positions — see deferScrollOffset
    // for what that mismatch looked like.
    //
    // Only safe while that commit is actually coming: the layout effect is
    // keyed on `totalWidth`, so an unchanged width (both ends of the zoom
    // range clamp to the same pixelsPerDay, and the zoomed-out floor pins
    // the width outright) means it would never fire and the deferred offset
    // would never reach the DOM. That case changes no scale either, so
    // there is nothing to desync and the direct path is correct.
    if (totalWidthRef.current !== prevTotalWidth) {
      deferScrollOffset(targetOffset);
    } else {
      applyScrollOffset(targetOffset);
      scheduleFishEye();
    }

    setPixelsPerDay(nextPxPerDay);
  }

  function handleContainerMouseDown(ev: React.MouseEvent) {
    const container = scrollRef.current;
    if (!container) return;
    // Tiles handle their own drag only while repositioning is enabled —
    // otherwise a mousedown on a tile pans the track like any other spot.
    if (tileDragEnabled && (ev.target as HTMLElement).closest(".timeline-tile")) return;
    // A press on the phase area's own scrollbar drags the scrollbar, not
    // the view. The scrollbar belongs to the scrolling element itself and
    // lies right of its client area.
    const phaseArea = phaseAreaRef.current;
    if (phaseArea && ev.target === phaseArea && ev.nativeEvent.offsetX >= phaseArea.clientWidth) return;
    // A press stops a running zoom-to-phase where it is, so the pan starts
    // from what is on screen. Whether it was a click on a bar is decided on
    // release; until then it pans like any other press.
    cancelViewAnimation();
    const barEl = ev.button === 0 ? (ev.target as HTMLElement).closest<HTMLElement>(".timeline__phase-bar") : null;
    const bar = barEl ? phaseBarsRef.current.find((b) => b.entry.phase.id === barEl.dataset.phaseId) : undefined;
    phasePressRef.current = bar ? { entry: bar.entry, x: ev.clientX, y: ev.clientY } : null;
    pressXRef.current = ev.clientX;
    dragState.current = { startX: ev.clientX, startScrollLeft: scrollOffsetRef.current, moved: false };
  }
  function handleContainerMouseMove(ev: React.MouseEvent) {
    checkClusterStillHovered(ev);
    if (!dragState.current || !scrollRef.current) return;
    const dx = ev.clientX - dragState.current.startX;
    if (Math.abs(dx) > 3) dragState.current.moved = true;
    if (dragState.current.moved) dropPhaseReturn();
    markInteracting("pan");
    suppressHoverDuringScroll();
    applyScrollOffset(dragState.current.startScrollLeft - dx);
    scheduleFishEye();
  }
  function handleContainerMouseUp(ev: React.MouseEvent) {
    dragState.current = null;
    const press = phasePressRef.current;
    phasePressRef.current = null;
    if (press && Math.abs(ev.clientX - press.x) < PHASE_CLICK_SLOP_PX && Math.abs(ev.clientY - press.y) < PHASE_CLICK_SLOP_PX) {
      zoomToPhase(press.entry);
    }
  }
  function handleContainerLeave() {
    dragState.current = null;
    phasePressRef.current = null;
    cancelPendingFan();
    scheduleClusterClose();
  }

  // Relying only on a tile's own native mouseleave to detect "the user left
  // the cluster" is fragile: the pile card fades in while opening, so its
  // bounding box can appear out from under a cursor that never actually
  // moved — no mouse event fires at all in that case (browsers only fire
  // mouse events on cursor movement, not on the element moving under a
  // stationary cursor), leaving the pile stuck open forever. This re-checks
  // on every mousemove over the container instead: is the cursor still
  // within the open pile's card right now? If not, schedule a close.
  function checkClusterStillHovered(ev: React.MouseEvent) {
    const fan = openFanRef.current;
    if (!fan) return;
    const card = pileCardRef.current;
    // Not mounted yet this frame — the pile was opened less than a render
    // ago. Leaving it open is right: scheduling a close here would fire 80ms
    // later whether or not the cursor ever moved again. (The stale-fan case
    // this used to fall into is handled by the open-fan reset effects
    // instead.)
    if (!card) return;

    // PILE_HOVER_MARGIN is just enough slack to cross the gap around the
    // card without the pile collapsing on the way, and no more — anything
    // looser is a sticky dead zone where the pile hangs around over content
    // it no longer belongs to.
    const m = PILE_HOVER_MARGIN;
    const rect = card.getBoundingClientRect();
    const onCard =
      ev.clientX >= rect.left - m &&
      ev.clientX <= rect.right + m &&
      ev.clientY >= rect.top - m &&
      ev.clientY <= rect.bottom + m;
    if (onCard) fanEnteredRef.current = true;

    // Until the pointer has actually reached the pile, keep it alive
    // anywhere in the box spanned by where it was opened and where it
    // rendered. The card is centred in the viewport now, so the pointer has
    // to travel; a strict "off the card means close" test from the start
    // would shut it before it could be used. That box only covers the route
    // toward the card, so moving the other way still closes it promptly.
    let keepOpen = onCard;
    if (!keepOpen && !fanEnteredRef.current) {
      const blockLeft = Math.min(rect.left, fan.anchorX);
      const blockRight = Math.max(rect.right, fan.anchorX);
      const blockTop = Math.min(rect.top, fan.anchorY);
      const blockBottom = Math.max(rect.bottom, fan.anchorY);
      keepOpen =
        ev.clientX >= blockLeft - m &&
        ev.clientX <= blockRight + m &&
        ev.clientY >= blockTop - m &&
        ev.clientY <= blockBottom + m;
    }

    if (keepOpen) {
      if (clusterCloseTimeout.current != null) {
        window.clearTimeout(clusterCloseTimeout.current);
        clusterCloseTimeout.current = null;
      }
      return;
    }
    scheduleClusterClose();
  }

  function scheduleClusterClose() {
    const keyToClose = openFanRef.current?.key;
    if (!keyToClose) return;
    if (clusterCloseTimeout.current != null) window.clearTimeout(clusterCloseTimeout.current);
    clusterCloseTimeout.current = window.setTimeout(() => {
      clusterCloseTimeout.current = null;
      if (contextMenu) return; // keep the fan open while its context menu is up
      // Also keep it open under a detail viewer — opening one from the pile
      // (handlePileClick/handleTileMouseDown) never explicitly closes
      // the pile, and this guard is what keeps it that way even if some
      // mouse event still reaches here while the viewer covers it. That's
      // what lets Escape/closing the viewer step back onto the same pile
      // instead of landing on the plain timeline underneath it.
      if (viewerOpenRef.current) return;
      if (openFanRef.current?.key === keyToClose) {
        setOpenFan(null);
        fanEnteredRef.current = false;
        // Nothing can have been hovered while the overlay was up — it locks
        // everything under it — so collapsing restores exactly the state
        // from before the pile opened: no hover, every tile back at rest.
        setHoveredId(null);
        scheduleFishEye();
      }
    }, 80);
  }

  function handleTileMouseEnter(id: string, ev: React.MouseEvent) {
    if (hoverSuppressedRef.current) return;
    if (hoverClearTimeout.current != null) {
      window.clearTimeout(hoverClearTimeout.current);
      hoverClearTimeout.current = null;
    }

    setHoveredId(id);

    // Cluster fan-out is driven by real hit-testing on the tiles' own DOM
    // boxes (this event), not a synthetic distance estimate — the fan opens
    // exactly when the mouse is over an actual point of the cluster,
    // nothing earlier. Once it IS open, each grid tile's own onMouseEnter
    // takes over focus tracking; this only seeds it.
    const group = clusterByItemId.get(id);
    if (!group || group.length <= 1) {
      // Landed on a tile that is nobody's cluster — give up on whatever
      // open was still pending.
      cancelPendingFan();
      return;
    }

    const intent = hoverIntent();
    if (intent === null) {
      // Hover isn't the trigger: resting the pointer here only highlights
      // the tile (done above). Resolving the stack is the click's job.
      cancelPendingFan();
      return;
    }

    // The "step" brake: a hover-zoom may only fire again once the pointer
    // has genuinely travelled. Without this the zoom puts a new stack under
    // a stationary pointer, that stack's mouseenter arms another zoom, and
    // the timeline runs away on its own with the mouse sitting still.
    if (intent === "zoom" && hoverZoomBrake === "step") {
      const anchor = hoverZoomAnchorRef.current;
      if (anchor && Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y) < STEP_REARM_PX) {
        cancelPendingFan();
        return;
      }
    }

    if (clusterCloseTimeout.current != null) {
      window.clearTimeout(clusterCloseTimeout.current);
      clusterCloseTimeout.current = null;
    }
    // Where the pointer is right now. The pile renders centred in the
    // viewport, so this no longer places anything — it is the start of the
    // corridor checkClusterStillHovered keeps the pile alive along while the
    // pointer travels from here to there. Read now rather than when the
    // timer fires: by then the pointer may have drifted off the member this
    // corridor is supposed to lead away from.
    const anchor = { x: ev.clientX, y: ev.clientY };

    // Hover intent: retarget a timer that is already running rather than
    // restarting it, so that crossing several members of the same cluster
    // on the way in doesn't keep pushing the opening further away.
    pendingFanRef.current = pileWindowFor(group, id, anchor);
    pendingHoverRef.current = { itemId: id, intent, x: ev.clientX, y: ev.clientY };
    if (fanOpenTimeout.current == null) {
      fanOpenTimeout.current = window.setTimeout(() => {
        fanOpenTimeout.current = null;
        const pending = pendingFanRef.current;
        const hover = pendingHoverRef.current;
        pendingFanRef.current = null;
        pendingHoverRef.current = null;
        if (!pending || !hover) return;
        if (hover.intent === "zoom") {
          hoverZoomAnchorRef.current = { x: hover.x, y: hover.y };
          if (zoomIntoGroup(hover.itemId)) return;
          // The zoom this stack would need is past the limit, so zooming
          // can never take it apart — fan it out instead. Falling through
          // rather than giving up is what keeps a handful of files minutes
          // apart reachable by hover in "zoom" mode at all.
        }
        openPileNow(pending);
      }, FAN_OPEN_DELAY_MS);
    }
  }

  /// What resting the pointer on a stack should do, or `null` for "nothing,
  /// that's the click's job".
  ///
  /// The single place the three settings are turned into one action, so the
  /// hover timer stays a plain "do the thing" and the click path can't drift
  /// out of step with it. Note that "nur per Klick zoomen" is not the same
  /// as the fan behaviour: it fans out on hover while leaving the click to
  /// zoom, which no other combination produces — and which is exactly what
  /// the timeline did before any of this was configurable.
  function hoverIntent(): "fan" | "zoom" | null {
    if (pileTrigger !== "hover") return null;
    if (pileAction === "fan") return "fan";
    return hoverZoomBrake === "click_only" ? "fan" : "zoom";
  }

  /// Which members of a group a pile opened at `id` would show (all of
  /// them, chronologically — the grid scrolls), which one gets
  /// initial focus, and where the pointer was when it was asked for. Shared
  /// by the hover-intent timer above and by a click that cannot resolve a
  /// group by zooming (see `handleTileActivate`).
  function pileWindowFor(group: ItemInfo[], id: string, anchor: { x: number; y: number }): OpenFan {
    const count = group.length;
    const idx = group.findIndex((i) => i.id === id);
    const focusId = idx !== -1 ? id : group[0].id;
    return { key: group[0].id, count, focusId, anchorX: anchor.x, anchorY: anchor.y };
  }

  /// Opens a pile right now, without waiting for hover intent.
  function openPileNow(pending: OpenFan) {
    if (!clusterByItemId.has(pending.key)) return;
    fanEnteredRef.current = false;
    // Drop any single-tile hover as the pile takes over. Everything under
    // the overlay is locked and blurred, so a tile left sitting at
    // HOVER_SCALE behind it would be both unreachable and wrong — and
    // collapsing the pile has to restore exactly the state from before it
    // opened, which is "nothing hovered".
    setHoveredId(null);
    setOpenFan({ ...pending }, pending.focusId);
    scheduleFishEye();
  }

  // Collapses an open pile immediately, restoring exactly the state from
  // before it opened. Used wherever something has to win over the overlay
  // rather than wait for the pointer to wander off it.
  function closePileNow() {
    if (clusterCloseTimeout.current != null) {
      window.clearTimeout(clusterCloseTimeout.current);
      clusterCloseTimeout.current = null;
    }
    cancelPendingFan();
    if (openFanRef.current == null) return;
    fanEnteredRef.current = false;
    setOpenFan(null);
    setHoveredId(null);
    scheduleFishEye();
  }

  // Brings one item's tile into the middle of the viewport, zooming in
  // first if the current zoom is too coarse to show it as itself.
  //
  // Deliberately mirrors handleWheel's mechanics instead of inventing its
  // own: the track's width and the scroll offset are written synchronously
  // in this tick, before React re-renders, and the offset goes through
  // applyScrollOffset — never `container.scrollLeft`, which this component
  // does not use at all (see scrollOffsetRef for the WebKitGTK momentum
  // scrolling that made owning the offset necessary).
  /// How many files the stack holds, shown on whichever of its tiles is in
  /// front: normally its earliest member, or the file lifted on top of it
  /// (`stackFrontId`), which would otherwise cover the count.
  function stackBadgeFor(id: string): number | null {
    const group = clusterByItemId.get(id);
    if (!group || group.length < BADGE_MIN_MEMBERS) return null;
    return stackIndexIn(group, id, stackFrontId) === 0 ? group.length : null;
  }

  function focusOnItem(id: string) {
    const container = scrollRef.current;
    const track = trackRef.current;
    const item = itemById.get(id);
    if (!container || !track || !item) return;
    const time = new Date(item.resolved_timestamp).getTime();
    if (!Number.isFinite(time)) return;

    // An open pile would otherwise keep its blur-and-lock overlay sitting
    // over the place we are jumping to.
    closePileNow();
    dropPhaseReturn();
    markInteracting("focus-jump");

    // Zoom in far enough that the target stands on its own, if it is
    // currently inside a group — landing on the stack it is buried in is
    // not landing on it. How far that is follows from its nearest
    // neighbours in the lane (see `isolatePxPerDay`). It used to be the
    // zoom at which its GROUP first splits, which happens at the group's
    // largest gap and so could leave the target stacked with a closer
    // neighbour: a search for a PDF landed on the stack it shared with a
    // mail a week older. Neighbours with the very same timestamp never come
    // apart, so there the view stays where it is; beyond the zoom ceiling
    // it goes as far as it can. Either way the caller can lift the target
    // to the top of what is left of its stack (`stackFrontId`).
    let px = pixelsPerDayRef.current;
    const lane = laneSortedItems.get(laneForFileType(item.file_type)) ?? [];
    const at = lane.findIndex((i) => i.id === id);
    const gapTo = (other: ItemInfo | undefined) =>
      other ? Math.abs(time - new Date(other.resolved_timestamp).getTime()) : null;
    const needed = groupInfoByItemId.has(id)
      ? isolatePxPerDay(gapTo(lane[at - 1]), gapTo(lane[at + 1]), laneLayout.tileScale) * STACK_ZOOM_OVERSHOOT
      : 0;
    if (Number.isFinite(needed) && needed > px) {
      const fitPxPerDay = computeFitPxPerDay(container.clientWidth, (maxTime - epoch) / DAY_MS);
      px = Math.min(maxPxPerDayFor(container.clientWidth), Math.max(fitPxPerDay, needed));
      pixelsPerDayRef.current = px;
      totalWidthRef.current = logicalWidthFor(px);
      setPixelsPerDay(px);
    }

    applyScrollOffset(((time - epoch) / DAY_MS) * px + EDGE_PADDING - container.clientWidth / 2);
    scheduleFishEye();
  }

  // Walks the hits, wrapping around at both ends like a find bar does.
  function goToMatch(delta: number) {
    const count = matchedItems.length;
    if (count === 0) return;
    setActiveMatchIndex((current) => (((current + delta) % count) + count) % count);
  }

  const handleSearchResults = useCallback((ids: string[] | null) => {
    setMatchIds(ids);
    setActiveMatchIndex(0);
  }, []);

  // Closing the bar ends the search — leaving a stale highlight behind
  // would be a state the user has no visible control over any more. The
  // search cluster goes with it: it has no contents of its own once the
  // hits are gone, so leaving it up would show an empty card.
  useEffect(() => {
    if (searchOpen) return;
    setMatchIds(null);
    setActiveMatchIndex(0);
    setClusterSource((prev) => (prev?.kind === "search" ? null : prev));
  }, [searchOpen]);

  // Take the view to whichever hit is active. Keyed on the id, not the
  // index, so a re-run of the same search doesn't yank the view back to
  // where it already is.
  // Where even the deepest zoom leaves the hit in a stack, it goes on top
  // of it, so the ring of the current hit is around the hit itself.
  useEffect(() => {
    if (!activeMatchId) return;
    focusOnItem(activeMatchId);
    setStackFrontId(activeMatchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatchId]);

  // The highlight classes are written by applyFishEye, so a changed result
  // set needs a layout pass to become visible — nothing else triggers one
  // here, since no pointer or scroll event is involved in typing a query.
  //
  // `renderWindow` is listed as well: a jump can scroll far enough to mount
  // tiles that weren't in the DOM before (see ensureRenderWindow), and
  // those arrive with no transform or opacity on them at all until a pass
  // runs. During a scroll or zoom gesture every event schedules one anyway,
  // so it only actually matters for a one-shot jump like this one.
  useEffect(() => {
    scheduleFishEye();
  }, [matchIdSet, activeMatchId, pulseId, renderWindow, scheduleFishEye]);

  function cancelPendingFan() {
    if (fanOpenTimeout.current != null) {
      window.clearTimeout(fanOpenTimeout.current);
      fanOpenTimeout.current = null;
    }
    pendingFanRef.current = null;
    pendingHoverRef.current = null;
  }

  function handleTileMouseLeave(id: string) {
    // Cluster open/close is handled separately and robustly by
    // checkClusterStillHovered on every container mousemove (see there for
    // why a single native leave event isn't reliable enough on its own).
    // This only needs to manage the plain single-tile hoveredId state.
    //
    // Small delay before un-hovering: when a cluster is fanned out, moving
    // the mouse from one spread tile to the next briefly crosses a gap
    // with no tile under the cursor, which would otherwise collapse and
    // immediately re-expand the fan (visible flicker). Cancelled by the
    // next tile's own mouseenter if it fires within this window.
    if (hoverClearTimeout.current != null) window.clearTimeout(hoverClearTimeout.current);
    hoverClearTimeout.current = window.setTimeout(() => {
      if (contextMenu) return; // keep the fan pinned while its context menu is open
      // The cursor really has left the tiles (no sibling's mouseenter
      // cancelled this), so a fan that hasn't opened yet never should.
      cancelPendingFan();
      setHoveredId((h) => (h === id ? null : h));
    }, 80);
  }

  /// Zooms in until the group `item` belongs to comes apart, keeping that
  /// group where it is on screen: the stack opens in place and everything
  /// else spreads around it, rather than the view jumping to centre it.
  ///
  /// Returns false when zooming cannot resolve the group at all — either
  /// every member carries the same timestamp (no amount of zoom separates
  /// them) or it would take more than the zoom ceiling allows. The caller
  /// opens the pile instead, which is the tool for exactly that case.
  /// Takes an id rather than the item, because that is all it needs and
  /// because the hover timer only has the id to hand.
  function zoomIntoGroup(itemId: string): boolean {
    const container = scrollRef.current;
    const track = trackRef.current;
    const info = groupInfoByItemId.get(itemId);
    const group = clusterByItemId.get(itemId);
    if (!container || !track || !info || !group || group.length === 0) return false;

    const needed = groupDissolvePxPerDay(info) * STACK_ZOOM_OVERSHOOT;
    if (!Number.isFinite(needed) || needed > maxPxPerDayFor(container.clientWidth)) return false;

    const current = pixelsPerDayRef.current;
    if (needed <= current) return false;

    const firstMs = new Date(group[0].resolved_timestamp).getTime();
    const lastMs = new Date(group[group.length - 1].resolved_timestamp).getTime();
    const centerDays = (firstMs + (lastMs - firstMs) / 2 - epoch) / DAY_MS;
    // Screen x of the group's centre before the zoom, to put it back there
    // after — the same focal-point invariance the wheel zoom keeps, applied
    // to the thing that was clicked.
    const screenXBefore = centerDays * current + EDGE_PADDING - scrollOffsetRef.current;

    // A pile that was about to open from the hover underneath this click
    // must not then open on top of the fresh zoom.
    cancelPendingFan();
    dropPhaseReturn();
    markInteracting("group-zoom");

    pixelsPerDayRef.current = needed;
    totalWidthRef.current = logicalWidthFor(needed);
    setPixelsPerDay(needed);
    applyScrollOffset(centerDays * needed + EDGE_PADDING - screenXBefore);
    setHoveredId(null);
    scheduleFishEye();
    return true;
  }

  // --- Zoom-to-phase ---------------------------------------------------------

  /// One frame of a view animation, put on screen the way the wheel zoom
  /// does it: the ref first, the offset handed to the commit that moves the
  /// tiles (see deferScrollOffset), and written directly only when the
  /// width stays the same and no such commit is coming.
  function applyViewStep(px: number, offset: number) {
    markInteracting("phase-zoom");
    suppressHoverDuringScroll();
    pixelsPerDayRef.current = px;
    const prevTotalWidth = totalWidthRef.current;
    totalWidthRef.current = logicalWidthFor(px);
    if (totalWidthRef.current !== prevTotalWidth) {
      deferScrollOffset(offset);
    } else {
      applyScrollOffset(offset);
      scheduleFishEye();
    }
    setPixelsPerDay(px);
  }

  function cancelViewAnimation() {
    if (viewAnimRaf.current != null) {
      cancelAnimationFrame(viewAnimRaf.current);
      viewAnimRaf.current = null;
    }
  }

  /// Animates to `target`. The zoom changes by the same factor every frame,
  /// so a jump from decades to weeks doesn't happen all at the end, and the
  /// view turns around the one date that sits at the same screen spot
  /// before and after — the focal point a wheel zoom would have had. When
  /// that point lies off screen (mostly a sideways move), the centre date
  /// slides instead. Timed by the clock, not by frames: a slow frame skips
  /// ahead rather than stretching the move. A press, a wheel tick or any
  /// other jump cancels it (cancelViewAnimation).
  function animateViewTo(target: SavedView) {
    const container = scrollRef.current;
    if (!container || container.clientWidth <= 0) return;
    cancelViewAnimation();
    closePileNow();
    const width = container.clientWidth;
    const fromPx = pixelsPerDayRef.current;
    const fromOffset = scrollOffsetRef.current;
    const toPx = target.pxPerDay;
    // Clamped up front, as storeScrollOffset would at the end, so the move
    // heads for where it really stops — at the axis' edge for a phase that
    // reaches past it.
    const maxScroll = Math.max(0, logicalWidthFor(toPx) - width);
    const toOffset = Math.min(maxScroll, Math.max(0, ((target.centerMs - epoch) / DAY_MS) * toPx + EDGE_PADDING - width / 2));
    const logRatio = Math.log(toPx / fromPx);
    let focal: { days: number; screenX: number } | null = null;
    if (Math.abs(toPx - fromPx) > 1e-9) {
      const days = (toOffset - fromOffset) / (toPx - fromPx);
      const screenX = days * fromPx + EDGE_PADDING - fromOffset;
      if (screenX >= 0 && screenX <= width) focal = { days, screenX };
    }
    const fromCenterDays = (fromOffset + width / 2 - EDGE_PADDING) / fromPx;
    const toCenterDays = (toOffset + width / 2 - EDGE_PADDING) / toPx;
    const startedAt = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - startedAt) / PHASE_ZOOM_MS);
      if (p >= 1) {
        viewAnimRaf.current = null;
        applyViewStep(toPx, toOffset);
        return;
      }
      // Ease in and out (cubic).
      const k = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const px = fromPx * Math.exp(logRatio * k);
      const offset = focal
        ? focal.days * px + EDGE_PADDING - focal.screenX
        : (fromCenterDays + (toCenterDays - fromCenterDays) * k) * px + EDGE_PADDING - width / 2;
      applyViewStep(px, offset);
      viewAnimRaf.current = requestAnimationFrame(step);
    };
    viewAnimRaf.current = requestAnimationFrame(step);
  }

  useEffect(
    () => () => {
      cancelViewAnimation();
      if (pulseTimeout.current != null) window.clearTimeout(pulseTimeout.current);
      if (returnChipRaf.current != null) cancelAnimationFrame(returnChipRaf.current);
    },
    [],
  );

  /// Click on a bar: the whole phase fills the window, less
  /// PHASE_ZOOM_MARGIN on either side. Measured on the phase's real span,
  /// not on the bar as cut at the axis' ends — a phase reaching past them
  /// is fitted as far as the zoom floor allows, and the offset clamp then
  /// holds the view at the axis' edge. Too short a phase stops at the
  /// deepest zoom, centred.
  function zoomToPhase(entry: PhaseRowPhase) {
    const container = scrollRef.current;
    if (!container || container.clientWidth <= 0) return;
    const width = container.clientWidth;
    const spanDays = Math.max((entry.endMs - entry.startMs) / DAY_MS, 1e-6);
    const fitPxPerDay = computeFitPxPerDay(width, (maxTime - epoch) / DAY_MS);
    const px = Math.min(maxPxPerDayFor(width), Math.max(fitPxPerDay, (width * (1 - 2 * PHASE_ZOOM_MARGIN)) / spanDays));
    // From one phase straight on to the next, the way back still leads to
    // where the user was before the first one.
    if (!phaseReturnViewRef.current) {
      const current = pixelsPerDayRef.current;
      setPhaseReturn({
        pxPerDay: current,
        centerMs: epoch + ((scrollOffsetRef.current + width / 2 - EDGE_PADDING) / current) * DAY_MS,
      });
    }
    animateViewTo({ pxPerDay: px, centerMs: entry.startMs + (entry.endMs - entry.startMs) / 2 });
  }

  function setPhaseReturn(view: SavedView | null, from: { label: string; cluster: ClusterSource | null } | null = null) {
    phaseReturnViewRef.current = view;
    returnClusterRef.current = from?.cluster ?? null;
    setReturnLabel(from?.label ?? null);
    setPhaseReturnView(view);
    if (returnChipRaf.current != null) cancelAnimationFrame(returnChipRaf.current);
    returnChipRaf.current = null;
    setReturnChipAt(null);
  }

  // The jumped-to tile is mounted and placed a few frames after the jump
  // (zoom render, render window, fish-eye pass), so it is waited for and
  // measured once it has held still for two frames.
  function placeReturnChipBeside(id: string) {
    let frames = 0;
    let settled = 0;
    let lastKey = "";
    const step = () => {
      returnChipRaf.current = null;
      const el = tileRefs.current.get(id);
      const rect = el?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}`;
        settled = key === lastKey ? settled + 1 : 0;
        lastKey = key;
        if (settled >= 2) {
          setReturnChipAt({ x: rect.left - 12, y: rect.top + rect.height / 2 });
          return;
        }
      }
      if (++frames < 60) returnChipRaf.current = requestAnimationFrame(step);
    };
    returnChipRaf.current = requestAnimationFrame(step);
  }

  /// The user zooms or pans on their own: a running phase zoom stops, and
  /// the way back is gone.
  function dropPhaseReturn() {
    cancelViewAnimation();
    if (phaseReturnViewRef.current) setPhaseReturn(null);
  }

  /// Escape or the "Zurück" chip: back to the view before the phase zoom.
  function returnFromPhaseZoom() {
    const view = phaseReturnViewRef.current;
    if (!view) return;
    const cluster = returnClusterRef.current;
    setPhaseReturn(null);
    animateViewTo(view);
    if (cluster) {
      setClusterSource(cluster);
      setClusterHoverId(null);
    }
  }

  // --- Phase bar context menu --------------------------------------------------

  function handlePhaseContextMenu(bar: PhaseBar, ev: React.MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    hidePhasePopoverNow();
    setContextMenu(null);
    setTrackMenu(null);
    setPhaseMenu({ entry: bar.entry, x: ev.clientX, y: ev.clientY, mode: "menu" });
    if (phasePalette.length === 0) {
      invoke<string[]>("get_phase_palette")
        .then(setPhasePalette)
        .catch(() => setPhasePalette([]));
    }
  }

  /// The same commands as the management dialog, followed by the same
  /// reload, so bars and dialog agree. A refusal is the backend's own
  /// sentence, shown as a toast.
  async function runPhaseCommand(command: string, args: Record<string, unknown>, doneToast: string | null) {
    setPhaseMenu(null);
    try {
      const result = await invoke<PhaseSaveOutcome<PhaseView> | PhaseGroupView | null>(command, args);
      if (result && "status" in result && result.status === "overlap") {
        showToast(t("phases.overlapRefused"));
        return;
      }
      await onPhaseGroupsChanged?.();
      if (doneToast) showToast(doneToast);
    } catch (e) {
      showToast(typeof e === "string" ? e : t("phases.saveError"));
    }
  }

  /// The eye of a Themenbereich in the arrow dropdown: the dialog's command,
  /// followed by the same reload. The menu stays open for further toggles.
  async function toggleGroupEye(group: PhaseGroupView) {
    try {
      await invoke("set_phase_group_visibility", { id: group.id, visible: group.visibility !== "visible" });
      await onPhaseGroupsChanged?.();
    } catch (e) {
      showToast(typeof e === "string" ? e : t("phases.saveError"));
    }
  }

  function renamePhase(phase: PhaseView, title: string) {
    const trimmed = title.trim();
    if (!trimmed || trimmed === phase.title) {
      setPhaseMenu(null);
      return;
    }
    void runPhaseCommand("update_phase", { id: phase.id, patch: { title: trimmed } }, t("phases.toast.saved"));
  }

  function recolorPhase(phase: PhaseView, color: string) {
    if (color === phase.color) {
      setPhaseMenu(null);
      return;
    }
    void runPhaseCommand("update_phase", { id: phase.id, patch: { color } }, t("phases.toast.saved"));
  }

  /// Ctrl/Cmd-click toggles a tile into/out of the batch selection instead
  /// of opening it. A tile that stands for a whole stack toggles every one
  /// of its members together — there is no separate gesture to reach into
  /// an unopened stack and pick out single members, so the stack's front
  /// tile is the only thing to click there is.
  function toggleTileSelection(item: ItemInfo) {
    const group = clusterByItemId.get(item.id);
    const ids = group && group.length > 1 ? group.map((g) => g.id) : [item.id];
    toggleSelectionIds(ids);
  }

  /// The pile grid's own Ctrl-click (see handlePileClick): unlike the main
  /// timeline's front tile, a grid tile already stands for exactly one
  /// member — clusterByItemId would still resolve it back to the whole
  /// stack, which is the wrong granularity once the stack is open and its
  /// members are each their own tile on screen.
  function toggleSelectionIds(ids: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  /// The floating "Ändern"-button and the context-menu's equivalent entry
  /// both land here: hands the current selection off to Datei-Operationen
  /// (see `onSendSelectionToFileOps`/`ProjectShell.sendSelectionToFileOps`)
  /// and clears it, the same way any other batch action consumes a
  /// selection once it's been acted on.
  function sendSelectionToFileOps() {
    if (selectedIds.size === 0) return;
    // Any open grid has to go first: Datei-Operationen opens as its own
    // overlay (.browser-overlay) and sits *below* the pile and cluster
    // overlays, so leaving one up would bury the view we just sent the
    // selection to behind the card it was selected in.
    closeCluster();
    closePileNow();
    onSendSelectionToFileOps?.(Array.from(selectedIds));
    setSelectedIds(new Set());
  }

  /// What a plain click on a tile does.
  ///
  /// A tile that stands for a group is a stack, and clicking it resolves
  /// that group: zoom in until it comes apart, or — when it cannot come
  /// apart — open it as a pile. Only a tile that stands for itself opens
  /// the viewer. A click can't land on a tile that's part of an already-open
  /// pile: the pile's own backdrop covers the whole viewport and intercepts
  /// every pointer event, and the pile's members render as the grid's own
  /// tiles (see the pile-card render), not these.
  function handleTileActivate(item: ItemInfo, ev: MouseEvent) {
    if (ev.ctrlKey || ev.metaKey) {
      toggleTileSelection(item);
      return;
    }

    const group = clusterByItemId.get(item.id);
    if (!group || group.length <= 1) {
      openViewer(item);
      return;
    }

    // A click always resolves the stack straight away — the trigger setting
    // only decides whether hovering does so too, never whether clicking
    // works. Which way it resolves follows the behaviour setting; the
    // hover-zoom brake deliberately has no say here, since it exists purely
    // to tame zooms the pointer caused without moving.
    if (pileAction === "zoom" && zoomIntoGroup(item.id)) {
      // Arms the "step" brake from here too. A click-zoom leaves a fresh
      // stack under a pointer that hasn't moved exactly as a hover-zoom
      // does, so without this the brake would let one unasked-for hover
      // zoom through straight after every click.
      hoverZoomAnchorRef.current = { x: ev.clientX, y: ev.clientY };
      return;
    }

    cancelPendingFan();
    openPileNow(pileWindowFor(group, item.id, { x: ev.clientX, y: ev.clientY }));
  }

  function handleTileMouseDown(item: ItemInfo, ev: React.MouseEvent) {
    if (ev.button !== 0) return;

    if (!tileDragEnabled) {
      // Repositioning is off: let the mousedown bubble to the container so
      // it pans the timeline, and only open the viewer if this turns out to
      // be a plain click rather than the start of a pan.
      const downX = ev.clientX;
      const downY = ev.clientY;
      const onUpStatic = (e: MouseEvent) => {
        document.removeEventListener("mouseup", onUpStatic);
        if (Math.abs(e.clientX - downX) <= 4 && Math.abs(e.clientY - downY) <= 4) handleTileActivate(item, e);
      };
      document.addEventListener("mouseup", onUpStatic);
      return;
    }

    ev.stopPropagation();
    const el = tileRefs.current.get(item.id);
    if (!el) return;

    const startClientX = ev.clientX;
    const baseLeft = trackX(item.resolved_timestamp);
    tileDragState.current = { itemId: item.id, moved: false };
    el.style.zIndex = "40";
    el.classList.add("timeline-tile--dragging");

    function onMove(e: MouseEvent) {
      const deltaX = e.clientX - startClientX;
      if (Math.abs(deltaX) > 4) tileDragState.current!.moved = true;
      // Keep the lane factor while dragging — without it a tile in a
      // stream with fewer (and therefore larger) lanes would visibly
      // jump back to base size the moment it's picked up.
      el!.style.transform = `translate(calc(-50% + ${deltaX}px), -50%) scale(${1.15 * laneLayout.tileScale})`;
    }
    function onUp(e: MouseEvent) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el!.classList.remove("timeline-tile--dragging");
      const deltaX = e.clientX - startClientX;
      const wasMoved = tileDragState.current?.moved ?? false;
      tileDragState.current = null;

      if (wasMoved) {
        const newIso = dateForX(baseLeft + deltaX);
        invoke("update_timestamp", { id: item.id, timestamp: newIso })
          .then(() => {
            setItems((prev) =>
              prev.map((i) => (i.id === item.id ? { ...i, resolved_timestamp: newIso, timestamp_source: "manual" } : i)),
            );
          })
          .catch(() => scheduleFishEye());
      } else {
        handleTileActivate(item, e);
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Shared by the pile's hero and its grid tiles: none of them are
  // draggable (unlike the main timeline tiles, see handleTileMouseDown), so
  // this is just click-to-open — still distinguishing a click from the
  // start of a pan the same way.
  function handlePileClick(item: ItemInfo, ev: React.MouseEvent) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    if (ev.ctrlKey || ev.metaKey) {
      toggleSelectionIds([item.id]);
      return;
    }
    const downX = ev.clientX;
    const downY = ev.clientY;
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mouseup", onUp);
      if (Math.abs(e.clientX - downX) <= 4 && Math.abs(e.clientY - downY) <= 4) openViewer(item);
    };
    document.addEventListener("mouseup", onUp);
  }

  function handleTrackContextMenu(ev: React.MouseEvent) {
    const track = trackRef.current;
    if (!track || !onDiaryRequest) return;
    ev.preventDefault();
    const trackLeft = track.getBoundingClientRect().left;
    const iso = dateForX(ev.clientX - trackLeft + trackOrigin);
    const { clientX: x, clientY: y } = ev;
    setContextMenu(null);
    setPhaseMenu(null);
    setTrackMenu({ x, y, iso, image: null });
    void readClipboardImage().then((image) => {
      setTrackMenu((prev) => (prev && prev.x === x && prev.y === y ? { ...prev, image } : prev));
    });
  }

  function handleTileContextMenu(item: ItemInfo, ev: React.MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    setTrackMenu(null);
    setPhaseMenu(null);
    setContextMenu({ item, x: ev.clientX, y: ev.clientY });
  }

  // No confirmation prompt: the file keeps existing (both its row and its
  // copy in the project folder — see `remove_item` in Rust) and the
  // Protokoll tab puts it back in one click, so asking "are you sure?"
  // would be asking about something that isn't a risk. The toast is what
  // replaces it: it says where to undo.
  async function removeItem(item: ItemInfo) {
    if (removeInFlightRef.current) return;
    removeInFlightRef.current = true;
    try {
      await removeItemNow(item);
    } finally {
      removeInFlightRef.current = false;
    }
  }

  async function removeItemNow(item: ItemInfo) {
    // Normally reversible from the log, so no question asked — but with
    // "Arbeitskopie beim Entfernen löschen" on, the backend purges the copy
    // and the row right away, and that does need one.
    if (deleteFilesOnRemove) {
      setContextMenu(null);
      const confirmed = await confirm({
        title: t("viewer.confirmRemoveDeleteTitle"),
        body: t("viewer.confirmRemoveDeleteBody"),
        confirmLabel: t("log.purgeSelected"),
        countdownSeconds: 1,
      });
      if (!confirmed) return;
    }

    // Where the viewer goes afterwards, worked out BEFORE the removal:
    // `viewerNavPool` is derived from `items`, so once the item is gone it
    // is gone from the pool too and there is no "the one after it" left to
    // ask for. Sorting out a file means removing several in a row, and
    // dropping back to the timeline after each one made that unworkable —
    // the next file is where the user already is. Falls back to the
    // previous file at the end of the pool, and only closes when the pool
    // runs out entirely.
    const successor = (() => {
      if (viewerItem?.id !== item.id) return null;
      const index = viewerNavPool.findIndex((i) => i.id === item.id);
      if (index === -1) return null;
      return viewerNavPool[index + 1] ?? viewerNavPool[index - 1] ?? null;
    })();

    try {
      await invoke("remove_item", { id: item.id });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      if (viewerItem?.id === item.id) {
        if (successor) openViewer(successor, viewerNavFilter, viewerNavScope);
        else closeViewer();
      }
      onToast?.(t(deleteFilesOnRemove ? "viewer.removedDeletedToast" : "timeline.removedUndoHint"));
    } catch {
      // not fatal — item just stays visible
    }
    setContextMenu(null);
  }

  // Purely a display-time transform — the stored original and thumbnail
  // files are never touched, only the item's `rotation` column, which
  // `list_items` (and therefore `items`/`viewerItem`) picks up from here.
  async function rotateItem(item: ItemInfo, delta: number) {
    try {
      const newRotation = await invoke<number>("rotate_item", { id: item.id, delta });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, rotation: newRotation } : i)));
      setViewerItem((v) => (v && v.id === item.id ? { ...v, rotation: newRotation } : v));
    } catch {
      // not fatal — rotation just stays as it was
    }
    setContextMenu(null);
  }

  // Served over the loopback file server rather than read across IPC: a
  // full-resolution photo as a base64 data: URL is roughly a third larger
  // again than the file itself, and all of it has to cross the bridge
  // before anything appears.
  async function loadFullMedia(item: ItemInfo): Promise<string | null> {
    const cached = fullMediaCache.current[item.id];
    if (cached) return cached;
    try {
      // Same split as the file browser's single-image view: formats WebKit
      // decodes are resolved only once decoded (so the swap from the thumbnail
      // stand-in has no undersized frame while a big BMP/PNG is still being
      // decoded); TIFF, which WebKitGTK cannot decode, gets a Rust rendition.
      const url = canWebviewDecode(item.stored_path)
        ? await decodedOriginalUrl(item.stored_path)
        : await invoke<string>("get_full_image_preview", { path: item.stored_path });
      fullMediaCache.current[item.id] = url;
      return url;
    } catch {
      return null;
    }
  }

  // The name a given item currently goes by — what the tiles and the hero
  // label show, and what the viewer's name field is pre-filled with. Items
  // with no display_name of their own go by their original filename, so
  // that is the string to offer for editing rather than an empty box with
  // the filename greyed out behind it.

  // What a tile's caption shows, by file type and by whether this is one of
  // the three "overlay" spots (a hovered single tile, or the pile/year-
  // cluster hero) or one of the two plain ones (a resting single tile, or a
  // small grid tile in the pile/year-cluster grid — never an overlay, no
  // matter which one is currently focused):
  //
  //   - image/video: nothing at rest (a bare thumbnail); the timestamp only
  //     once it's the overlay — the caption is itself part of what hovering
  //     reveals, not a permanent fixture.
  //   - audio/document: the filename always, overlay or not — there's no
  //     second piece of information worth swapping to for these.
  //   - email: never the filename. At rest, sender address + date (both
  //     ship with every item, see ItemInfo); as the overlay, sender address
  //     + recipients — the one piece that needs a fetch (see emailRecipients
  //     and the effect that fills it in).
  //
  // Returns `null` for "render no caption at all", which is itself new: a
  // resting image/video tile used to always show its filename.
  function tileLabelContent(item: ItemInfo, overlay: boolean): React.ReactNode | null {
    if (item.file_type === "diary") {
      return (
        <>
          <div>{effectiveName(item)}</div>
          <div>
            {formatMetaDate(item.resolved_timestamp)}
            {item.attachment_count > 0 ? ` · 📎 ${item.attachment_count}` : ""}
          </div>
        </>
      );
    }
    if (item.file_type === "email") {
      const address = emailSenderAddress(item.email_sender) ?? item.email_sender ?? "";
      const second = overlay ? (emailRecipients[item.id] ?? "…") : formatMetaDate(item.resolved_timestamp);
      return (
        <>
          <div>{address}</div>
          <div>{second}</div>
        </>
      );
    }
    if (labelKeepsName(item.file_type)) return effectiveName(item);
    if (!overlay) return null;
    return formatMetaDate(item.resolved_timestamp);
  }

  // Wraps tileLabelContent in the caption element itself, or renders
  // nothing at all when there's no caption to show (see tileLabelContent) —
  // callers don't have to separately guard against the null case.
  function renderTileLabel(item: ItemInfo, overlay: boolean, className: string) {
    const content = tileLabelContent(item, overlay);
    if (content == null) return null;
    return <div className={className}>{content}</div>;
  }

  // Shared by the cluster grid's small tiles, its enlarged hero, and the
  // main timeline tile's own thumb (see visibleItems.map below) so all
  // three render a given item identically. `isHovered` governs the
  // document reveal-on-hover behaviour.
  function renderClusterThumb(item: ItemInfo, isHovered: boolean) {
    if (item.file_type === "document") {
      return thumbs[item.id] && isHovered ? (
        <ThumbImg src={thumbs[item.id]} alt="" />
      ) : (
        <img src={scrollIcon} alt="" className="timeline-tile__doc-icon" />
      );
    }
    if (item.file_type === "email") {
      return <span className="timeline-tile__icon timeline-tile__icon--email">✉️</span>;
    }
    if (item.file_type === "diary") {
      return <img src="/diary_entry.png" alt="" />;
    }
    if (thumbs[item.id]) {
      return (
        <ThumbImg
          src={thumbs[item.id]}
          alt=""
          style={item.file_type === "image" && item.rotation ? { transform: `rotate(${item.rotation}deg)` } : undefined}
        />
      );
    }
    if (item.file_type === "audio") return <img src="/audio2.jpeg" alt="" />;
    if (item.file_type === "video") return <span className="timeline-tile__icon">🎬</span>;
    if (item.file_type === "other") return <WildcardIcon />;
    return <span className="timeline-tile__icon">📄</span>;
  }

  // Collapses the freed zoom layer back into the framed detail card —
  // shared by the zoom-out-below-baseline case, Escape, and clicking beside
  // the image.
  function collapseFreed() {
    setFreed(false);
    setFreedScale(1);
    setPan({ x: 0, y: 0 });
  }

  // `navFilter` is set only when opening from a cluster grid — see its tile
  // onClick — and carries that filter along so goToAdjacent keeps skipping
  // the same disabled types for the rest of this viewer session.
  // `navScope` does the same for the search cluster, pinning the arrows to
  // that cluster's hits; it is a snapshot, so re-running the query behind
  // an open viewer leaves this session's stepping order alone.
  async function openViewer(
    item: ItemInfo,
    navFilter: FileTypeFilter | null = null,
    navScope: Set<string> | null = null,
  ) {
    // A diary entry has no file to show in the viewer — it opens its own
    // dialog, read-only until the pencil is pressed.
    if (item.file_type === "diary") {
      onDiaryRequest?.({ entry: item });
      return;
    }
    const requestId = ++viewerRequestId.current;
    if (!viewerOpenRef.current) {
      const container = scrollRef.current;
      const px = pixelsPerDayRef.current;
      viewerStartRef.current = container
        ? {
            itemId: item.id,
            itemMs: new Date(item.resolved_timestamp).getTime(),
            view: { pxPerDay: px, centerMs: epoch + ((scrollOffsetRef.current + container.clientWidth / 2 - EDGE_PADDING) / px) * DAY_MS },
            spanMs: (container.clientWidth / px) * DAY_MS,
            cluster: clusterSource,
          }
        : null;
    }
    viewerOpenRef.current = true;
    setViewerItem(item);
    setViewerNavFilter(navFilter);
    setViewerNavScope(navScope);
    setNameDraft(effectiveName(item));
    setNameEditing(false);
    setNameError(false);
    // Before the drafts switch over: whatever was typed for the previous
    // file still has to reach the database.
    flushNote();
    setNoteDraft(item.note ?? "");
    setDateDraft(toDatetimeLocalValue(item.resolved_timestamp));
    setDateEditing(false);
    setImgNatural(null);
    collapseFreed();

    if (item.file_type === "audio" || item.file_type === "video") {
      // Streamed via the local media server rather than base64-over-IPC
      // (see loadFullMedia) — containers like m4a/mp4 need real seeking to
      // play at all, which a data: URL can't give them, and WebKitGTK's
      // GStreamer-based playback doesn't reliably accept Tauri's asset://
      // protocol as a media source (see mediaServer.ts).
      const url = await mediaUrl(item.stored_path);
      if (viewerRequestId.current !== requestId) return; // navigated again already
      setViewerDataUrl(url);
    } else if (item.file_type === "image") {
      const cached = fullMediaCache.current[item.id];
      if (cached) {
        setViewerDataUrl(cached);
      } else {
        // Show the already-loaded small thumbnail instantly as a stand-in
        // (if there is one) instead of flashing the generic icon while the
        // full-resolution file loads over IPC.
        setViewerDataUrl(thumbs[item.id] ?? null);
        const dataUrl = await loadFullMedia(item);
        if (viewerRequestId.current !== requestId) return; // navigated again already
        if (dataUrl) setViewerDataUrl(dataUrl);
      }
    } else {
      setViewerDataUrl(null);
    }

    // Word/ODT/RTF/txt items have no thumbnail — their full extracted text
    // is fetched on demand instead (not shipped with list_items, which
    // would otherwise ship every document's whole text on every load).
    // E-mails reuse the exact same `get_item_text` call for their plain-text
    // fallback (their `extracted_text` is populated the same way, see
    // `email::extract_plain_text`), plus a second fetch for the sanitised
    // HTML body, which is never shipped with `list_items` either.
    if ((item.file_type === "document" && !item.thumbnail_path && !isSpreadsheetFile(item)) || item.file_type === "email") {
      setViewerText(null);
      const text = await invoke<string | null>("get_item_text", { id: item.id }).catch(() => null);
      if (viewerRequestId.current !== requestId) return;
      setViewerText(text);
    } else {
      setViewerText(null);
    }

    if (item.file_type === "email") {
      setViewerEmailHtml(null);
      const html = await invoke<string | null>("get_item_email_html", { id: item.id }).catch((err) => {
        invoke("debug_log", { message: `get_item_email_html failed for ${item.id}: ${String(err)}` }).catch(() => {});
        return null;
      });
      if (viewerRequestId.current !== requestId) return;
      setViewerEmailHtml(html);
      const recipients = await invoke<{ to: string[]; cc: string[] }>("get_item_email_recipients", { id: item.id }).catch(() => null);
      if (viewerRequestId.current !== requestId) return;
      setViewerEmailRecipients(recipients);
      setViewerEmailAttachments([]);
      const attachments = await invoke<{ index: number; name: string; size: number }[]>("get_item_email_attachments", { id: item.id }).catch(() => []);
      if (viewerRequestId.current !== requestId) return;
      setViewerEmailAttachments(attachments);
    } else {
      setViewerEmailHtml(null);
      setViewerEmailRecipients(null);
      setViewerEmailAttachments([]);
    }

    // Prefetch the previous/next item's full media in the background so
    // stepping through with the nav arrows feels instant after the first.
    // Uses the `navFilter` argument directly rather than the viewerNavPool
    // memo — that memo reads viewerNavFilter *state*, which this same call
    // just scheduled an update for but hasn't necessarily taken effect in
    // yet (state updates aren't synchronous), so it could still reflect
    // the previous viewer session's filter for this one frame.
    const pool = navPoolFor(item, navFilter, navScope, viewerNavOverride);
    const index = pool.findIndex((i) => i.id === item.id);
    for (const neighbor of [pool[index - 1], pool[index + 1]]) {
      if (neighbor && neighbor.file_type === "image" && !fullMediaCache.current[neighbor.id]) {
        loadFullMedia(neighbor);
      }
    }
  }

  function closeViewer() {
    flushNote();
    setDateEditing(false);
    viewerOpenRef.current = false;
    viewerStartRef.current = null;
    setViewerItem(null);
    setViewerNavFilter(null);
    setViewerNavScope(null);
    setViewerNavOverride(null);
    setNameEditing(false);
    setNameError(false);
    collapseFreed();
    setViewerDataUrl(null);
    setViewerText(null);
    setViewerEmailHtml(null);
    setViewerEmailRecipients(null);
  }

  // Closing by the user's own hand (Escape, the cross, a click beside the
  // file). Browsing in the viewer easily wanders years away from where it
  // was opened, so the timeline follows: it lands on the file last shown,
  // which pulses briefly, and the "Zurück" chip leads back to the starting
  // view when that is out of sight. Opened from a cluster grid and still
  // inside it, the grid simply comes back as before.
  function leaveViewer() {
    const start = viewerStartRef.current;
    const last = viewerItem;
    closeViewer();
    if (!start || !last || last.id === start.itemId || !itemById.has(last.id)) return;
    if (clusterSource) {
      if (clusterFilteredItems.some((i) => i.id === last.id)) return;
      closeCluster();
    }
    focusOnItem(last.id);
    setStackFrontId(last.id);
    setPulseId(last.id);
    if (pulseTimeout.current != null) window.clearTimeout(pulseTimeout.current);
    pulseTimeout.current = window.setTimeout(() => setPulseId(null), 1800);
    // Judged on the view after the jump: from the overview the start may
    // have been in sight before, yet the jump's zoom-in has left it behind.
    const container = scrollRef.current;
    const px = pixelsPerDayRef.current;
    const lastMs = new Date(last.resolved_timestamp).getTime();
    const spanMs = container ? (container.clientWidth / px) * DAY_MS : start.spanMs;
    if (px !== start.view.pxPerDay || Math.abs(lastMs - start.view.centerMs) > spanMs / 2) {
      // Named after the file the viewer was opened on, not the view's centre:
      // that is the place the user remembers starting from.
      const date = new Date(start.itemMs).toLocaleDateString(currentLanguage(), { month: "long", year: "numeric" });
      setPhaseReturn(start.view, { label: t("timeline.viewerReturn").replace("{date}", date), cluster: start.cluster });
      placeReturnChipBeside(last.id);
    }
  }

  // Where the open file sits in what the arrows step through (-1: not in it).
  const viewerNavIndex = viewerItem ? viewerNavPool.findIndex((i) => i.id === viewerItem.id) : -1;

  function goToAdjacent(direction: -1 | 1) {
    if (!viewerItem) return;
    const index = viewerNavPool.findIndex((i) => i.id === viewerItem.id);
    if (index === -1) return;
    const target = viewerNavPool[index + direction];
    if (target) openViewer(target, viewerNavFilter, viewerNavScope);
  }

  // Opens the cluster overlay for a year, month, week or day, used by clicking
  // its label above the timeline — see the marker labels' onClick. Replaces jumping straight into the detail viewer: the cluster
  // grid is the new intermediate stop, and its own tiles are what open the
  // viewer now (see clusterTile onClick).
  function openPeriodCluster(startMs: number, endMs: number, title: string) {
    setClusterSource({ kind: "period", startMs, endMs, title });
    setClusterHoverId(null);
  }

  // "Ergebnisse ansehen" in the search panel: gathers the current hits into
  // a cluster card of their own. Temporary by design — it holds no ids, and
  // closing it or ending the search is all that's left of it.
  function openSearchCluster() {
    setClusterSource({ kind: "search" });
    setClusterHoverId(null);
  }

  // Clicking a shared note in the viewer: the files with that exact note
  // become a temporary cluster of their own, same card as the search one.
  function openNoteCluster(ids: string[]) {
    closeViewer();
    setClusterSource({ kind: "note", ids });
    setClusterHoverId(null);
  }

  function closeCluster() {
    setClusterSource(null);
    setClusterHoverId(null);
    setPileGridHasMore(false);
  }

  // Stacks and lists are derived from `items` and thin out by themselves;
  // these hold their own copy of a file. A diary's attachments are not in
  // `items` at all, so that view always goes: it may belong to a private entry.
  useEffect(() => {
    if (!itemsAfterPrivacyHide) return;
    if (viewerItem && !itemsAfterPrivacyHide.has(viewerItem.id)) closeViewer();
    if (clusterSource?.kind === "virtual") closeCluster();
    setOpenFan(null);
    setSelectedIds((prev) => new Set([...prev].filter((id) => itemsAfterPrivacyHide.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsAfterPrivacyHide]);

  async function openEmailAttachment(item: ItemInfo, index: number) {
    try {
      const path = await invoke<string>("extract_item_email_attachment", { id: item.id, index });
      await invoke<boolean>("open_path_checked", { path });
    } catch (err) {
      invoke("debug_log", { message: `openEmailAttachment failed for ${item.id}#${index}: ${String(err)}` }).catch(() => {});
    }
  }

  async function openExternally(item: ItemInfo) {
    try {
      await invoke<boolean>("open_path_checked", { path: item.stored_path });
    } catch (err) {
      // Not silently swallowed — log it so a real failure (bad path,
      // missing default app, permission issue) is actually diagnosable
      // instead of just looking like "nothing happened".
      invoke("debug_log", { message: `openExternally failed for ${item.stored_path}: ${String(err)}` }).catch(() => {});
    }
  }

  // Which items actually get mounted. Every item used to be in the DOM at
  // all times, with applyFishEye hiding the irrelevant ones via
  // `opacity: 0` — full layout, paint, compositing-layer and per-frame
  // inline-style-write cost for tiles that are either far off-screen or
  // deliberately invisible. Two filters, cheapest first:
  //
  //   1. the mounted track-space window (see ensureRenderWindow),
  //   2. of a group, only the tiles its cascade actually draws — the front
  //      STACK_DEPTH members; the rest exist in the data, never in the
  //      resting DOM. An open pile's members don't need pinning here: they
  //      render as the pile card's own grid tiles, not these.
  //
  // The hiding branch in applyFishEye deliberately stays — it is now rarely
  // reached, but it still covers the single frame after a zoom step in
  // which a member that has just dropped out of its cascade is still
  // mounted.
  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (hoveredId === item.id) return true;
      if (renderWindow) {
        const x = trackX(item.resolved_timestamp);
        if (x < renderWindow.min || x > renderWindow.max) return false;
      }
      const group = clusterByItemId.get(item.id);
      if (!group) return true;
      return stackIndexIn(group, item.id, stackFrontId) < STACK_DEPTH;
    });
  }, [items, renderWindow, clusterByItemId, trackX, hoveredId, stackFrontId]);

  // The member the open pile's hero shows. Only resolved when the pile is
  // actually open, so a stale fanFocusId can't keep an orphaned hero alive.
  const heroItem = openFan && fanFocusId ? itemById.get(fanFocusId) ?? null : null;

  // Whichever item the three "overlay" spots (pile hero, year-cluster hero,
  // a hovered single tile) currently show, if any — the three never show
  // at once (the pile and the year-cluster both lock/blur everything else,
  // so a hovered single tile isn't reachable while either is open), so one
  // priority chain covers all three.
  const overlayItem = heroItem ?? clusterHeroItem ?? (hoveredId ? itemById.get(hoveredId) ?? null : null);

  // Fetches an e-mail's recipients the moment it becomes the overlay item —
  // see emailRecipients. Fired from here rather than inline in the label
  // (which runs once per tile per frame) so it happens exactly once per
  // item, not once per render of every tile that happens to re-render.
  useEffect(() => {
    if (!overlayItem || overlayItem.file_type !== "email") return;
    const id = overlayItem.id;
    if (emailRecipientsRequested.current.has(id)) return;
    emailRecipientsRequested.current.add(id);
    invoke<{ to: string[]; cc: string[] }>("get_item_email_recipients", { id })
      .then((r) => setEmailRecipients((prev) => ({ ...prev, [id]: r.to.length > 0 ? r.to.join(", ") : null })))
      .catch(() => setEmailRecipients((prev) => ({ ...prev, [id]: null })));
  }, [overlayItem]);

  // The open pile's own grid tiles — its first `count` members,
  // chronologically.
  const pileMembers = useMemo(() => {
    if (!openFan) return [];
    const group = clusterByItemId.get(openFan.key);
    return group ? group.slice(0, openFan.count) : [];
  }, [openFan, clusterByItemId]);

  // Recomputed whenever the grid wrapper's own size changes (open, window
  // resize) via the ResizeObserver pileGridWrapCallback sets up, and on
  // every scroll — drives the bottom fade hint (.pile-grid-fade). Shared by
  // both full-screen grids this file ever shows at once — an open pile and
  // the year-cluster card are mutually exclusive (each locks and blurs
  // everything else, so hovering open the other is never reachable while
  // one is up) — so one wrap ref, one observer and one piece of state cover
  // whichever of the two is actually mounted.
  function checkPileGridOverflow() {
    const wrap = pileGridWrapRef.current;
    setPileGridHasMore(wrap ? wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 1 : false);
  }

  // Ref callback for whichever grid-scroll wrapper is mounted right now
  // (.pile-grid-wrap or .cluster-grid-wrap) — attaches a ResizeObserver so
  // checkPileGridOverflow re-runs whenever the wrapper's own size changes,
  // not just on scroll.
  function pileGridWrapCallback(el: HTMLDivElement | null) {
    pileGridWrapRef.current = el;
    pileGridResizeObserverRef.current?.disconnect();
    pileGridResizeObserverRef.current = null;
    if (el) {
      const ro = new ResizeObserver(checkPileGridOverflow);
      ro.observe(el);
      pileGridResizeObserverRef.current = ro;
      checkPileGridOverflow();
    }
  }

  const { markers, columnMarkers } = useMemo<{ markers: Marker[]; columnMarkers: Marker[] }>(() => {
    // One list per grid: the drawn one, and — only while that is a preview —
    // the coarser one whose periods are the columns (see `columns`).
    const build = (forLevel: ZoomLevel, pastEnd: boolean): Marker[] => {
      const result: Marker[] = [];
      // Only the periods inside the mounted window, not the whole range: at
      // Day level a multi-decade archive is ~15k periods, each rendered twice
      // (a gridline in the track, a label in the header) and rebuilt from
      // scratch on every zoom tick. The window is in track-space px, so it
      // converts back to time the same way dateForX does.
      const windowStart = renderWindow
        ? Math.max(epoch, epoch + ((renderWindow.min - EDGE_PADDING) / pixelsPerDay) * DAY_MS)
        : epoch;
      const windowEnd = renderWindow
        ? Math.min(maxTime, epoch + ((renderWindow.max - EDGE_PADDING) / pixelsPerDay) * DAY_MS)
        : maxTime;
      if (windowEnd <= windowStart) return result;
      // Each loop below starts at the period CONTAINING windowStart, so the
      // partially-visible leading period still gets its line and label.
      const startDate = new Date(windowStart);
      // `pastEnd` carries the list one period beyond the window, so that
      // it always closes its last period. Only asked for where the periods
      // are columns to clamp tiles into: a coarse column grid (a month three
      // viewports wide) can start just once inside the window, and a single
      // start is not a period.
      const endDate = new Date(windowEnd + (pastEnd ? MARKER_PERIOD_DAYS[forLevel] * DAY_MS * 1.05 : 0));

      const xFor = (d: Date) => ((d.getTime() - epoch) / DAY_MS) * pixelsPerDay + EDGE_PADDING;
      // Label sits at the center of the period, not at its start line —
      // clamped to the visible range so the first/last (possibly partial)
      // period's label doesn't get pulled off outside the actual data range.
      const labelXFor = (periodStart: Date, periodEnd: Date) => {
        const clampedStart = Math.max(periodStart.getTime(), epoch);
        const clampedEnd = Math.min(periodEnd.getTime(), maxTime);
        return xFor(new Date((clampedStart + clampedEnd) / 2));
      };

      if (forLevel === "overview") {
        let cursor = startOfYear(startDate);
        while (cursor.getTime() < endDate.getTime() && result.length < MAX_MARKERS) {
          const periodEnd = new Date(cursor.getFullYear() + 1, 0, 1);
          result.push({
            key: cursor.toISOString(),
            x: xFor(cursor),
            labelX: labelXFor(cursor, periodEnd),
            label: String(cursor.getFullYear()),
            full: String(cursor.getFullYear()),
            major: true,
          });
          cursor = periodEnd;
        }
        // The loop's `<` guard against endDate never emits the closing line at
        // maxTime itself (the end of the last year), since that's exactly
        // where it stops — add it separately so the last year is bounded on
        // both sides, same as every other year.
        if (cursor.getTime() === maxTime && result.length < MAX_MARKERS) {
          result.push({ key: cursor.toISOString(), x: xFor(cursor), labelX: xFor(cursor), label: "", full: "", major: true });
        }
      } else if (forLevel === "year") {
        let cursor = startOfMonth(startDate);
        while (cursor.getTime() < endDate.getTime() && result.length < MAX_MARKERS) {
          const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
          result.push({
            key: cursor.toISOString(),
            x: xFor(cursor),
            labelX: labelXFor(cursor, periodEnd),
            label: cursor.toLocaleDateString(currentLanguage(), { month: "long", year: "numeric" }),
            full: cursor.toLocaleDateString(currentLanguage(), { month: "long", year: "numeric" }),
            major: cursor.getMonth() === 0,
          });
          cursor = periodEnd;
        }
      } else if (forLevel === "month") {
        let cursor = startOfWeek(startDate);
        while (cursor.getTime() < endDate.getTime() && result.length < MAX_MARKERS) {
          // Calendar days, not multiples of 24h: across a clock change those
          // drift off midnight and label the week or day before.
          const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
          const lastDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 6);
          result.push({
            key: cursor.toISOString(),
            x: xFor(cursor),
            labelX: labelXFor(cursor, periodEnd),
            label: formatWeekLabel(cursor, lastDay),
            full: formatWeekLabel(cursor, lastDay),
            major: cursor.getDate() <= 7,
          });
          cursor = periodEnd;
        }
      } else if (forLevel === "week") {
        // Narrow day columns carry the day of the month alone — reached when
        // the week grid is switched off and the day grid starts with a whole
        // month across the viewport (see `gridLevel`), or in a narrow window.
        // The pinned label (`full`) names the complete date regardless.
        const compact = pixelsPerDay < DAY_LABEL_FULL_MIN_PX;
        let cursor = startOfDay(startDate);
        while (cursor.getTime() < endDate.getTime() && result.length < MAX_MARKERS) {
          const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
          const full = cursor.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short", year: "numeric" });
          result.push({
            key: cursor.toISOString(),
            x: xFor(cursor),
            labelX: labelXFor(cursor, periodEnd),
            label: compact ? cursor.toLocaleDateString(currentLanguage(), { day: "numeric" }) : full,
            full,
            major: cursor.getDay() === 1,
          });
          cursor = periodEnd;
        }
      } else {
        // Day level: one day spans the viewport, so the subdivision that is
        // left to draw is the hour. This used to fall into the day-marker
        // branch above, which at this zoom meant a single gridline somewhere
        // off screen and no sense of where in the day one was — the level was
        // unreachable anyway (see maxPxPerDayFor), so it never showed.
        //
        // Labelled every third hour, not every one: at one day across the
        // screen 24 labels sit about 60px apart, which is narrower than the
        // label itself. The gridlines stay hourly, and midnight is the major
        // one, so the day boundary keeps reading as the strongest line.
        let cursor = startOfHour(startDate);
        while (cursor.getTime() < endDate.getTime() && result.length < MAX_MARKERS) {
          const periodEnd = new Date(cursor.getTime() + HOUR_MS);
          const hour = cursor.getHours();
          result.push({
            key: cursor.toISOString(),
            x: xFor(cursor),
            labelX: labelXFor(cursor, periodEnd),
            label:
              hour % 3 === 0
                ? hour === 0
                  ? cursor.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short", year: "numeric" })
                  : cursor.toLocaleTimeString(currentLanguage(), { hour: "numeric", minute: "2-digit" })
                : "",
            // Date and hour together: at this zoom the day is off screen as
            // often as not, and "5:00" without a date says very little.
            full: `${cursor.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short", year: "numeric" })}, ${cursor.toLocaleTimeString(
              currentLanguage(),
              { hour: "numeric", minute: "2-digit" },
            )}`,
            major: hour === 0,
          });
          cursor = periodEnd;
        }
      }
      return result;
    };
    const grid = build(level, false);
    return { markers: grid, columnMarkers: columns === level ? grid : build(columns, true) };
  }, [epoch, maxTime, pixelsPerDay, level, columns, renderWindow]);
  markersRef.current = markers;
  columnMarkersRef.current = columnMarkers;

  // The phase bars inside the mounted window, positioned like the markers
  // above: `left` from the same zoom state, so bars, gridlines and tiles
  // always move in the same commit (see deferScrollOffset). Recomputed per
  // zoom step, but keyed by phase id, so a bar is updated, never remounted.
  // The axis is not widened for them: what lies before `epoch` or after
  // `maxTime` is cut off there, and a phase entirely outside is skipped.
  const phaseBars = useMemo<PhaseBar[]>(() => {
    const bars: PhaseBar[] = [];
    const xAt = (ms: number) => ((ms - epoch) / DAY_MS) * pixelsPerDay + EDGE_PADDING;
    for (const row of phaseRows) {
      for (const entry of row.phases) {
        if (entry.endMs <= epoch || entry.startMs >= maxTime) continue;
        let left = xAt(Math.max(entry.startMs, epoch));
        let right = xAt(Math.min(entry.endMs, maxTime));
        if (renderWindow) {
          if (right < renderWindow.min || left > renderWindow.max) continue;
          left = Math.max(left, renderWindow.min);
          right = Math.min(right, renderWindow.max);
        }
        bars.push({
          entry,
          left,
          width: Math.max(PHASE_BAR_MIN_WIDTH, right - left),
          top: phaseBarTop(row, entry.subRow, PHASE_BAR_HEIGHT),
          cutStart: entry.startMs < epoch,
          cutEnd: entry.endMs > maxTime,
        });
      }
    }
    return bars;
  }, [phaseRows, epoch, maxTime, pixelsPerDay, renderWindow]);
  phaseBarsRef.current = phaseBars;

  // At Gesamtansicht (overview), zooming far out shrinks each year's period
  // to fewer pixels than the "2018"-style label needs, so neighboring year
  // labels start overlapping. Rather than hiding labels, shrink the font to
  // whatever the period width actually allows — down to a floor where the
  // year is still legible, not vanishing entirely.
  const DEFAULT_LABEL_FONT_PX = 11.84; // 0.74rem at a 16px root
  const MIN_LABEL_FONT_PX = 7;
  const overviewLabelFontPx = useMemo(() => {
    if (level !== "overview") return DEFAULT_LABEL_FONT_PX;
    const yearPeriodPx = pixelsPerDay * 365.25;
    const gapPx = 4; // breathing room between two adjacent year labels
    const charWidthEm = 0.62; // typical digit advance width in this font
    const maxFitPx = (yearPeriodPx - gapPx) / (4 * charWidthEm); // "YYYY"
    return Math.max(MIN_LABEL_FONT_PX, Math.min(DEFAULT_LABEL_FONT_PX, maxFitPx));
  }, [level, pixelsPerDay]);

  // Zoom step per wheel notch / keypress. direction > 0 zooms in: from the
  // framed state that means breaking straight out to the baseline (100% of
  // the viewport height); while already freed it multiplies the scale.
  // direction < 0 zooms out: a no-op while framed (there's nothing smaller
  // to go to), and collapses back to framed once the scale would drop
  // below the 1.0 baseline.
  function zoomImage(direction: 1 | -1) {
    if (!freed) {
      if (direction > 0) {
        setFreed(true);
        setFreedScale(1);
        setPan({ x: 0, y: 0 });
      }
      return;
    }
    const next = direction > 0 ? freedScale * FREED_ZOOM_STEP : freedScale / FREED_ZOOM_STEP;
    if (next < 1) {
      collapseFreed();
      // The flick that zoomed the picture back into the frame goes on for a
      // few more events; counted towards closing the viewer they would shut
      // it straight after the collapse. The lock makes the run start anew.
      lockWheelNav();
    } else {
      // Cap at 6x viewport height, or 4x the photo's own pixels if that is
      // more, so a high-resolution picture can be inspected pixel by pixel.
      const nativeVisualH = imgNatural ? (freedSwapped ? imgNatural.w : imgNatural.h) : 0;
      const maxScale = Math.max(FREED_MAX_SCALE, (nativeVisualH * 4) / window.innerHeight);
      const clamped = Math.min(next, maxScale);
      setFreedScale(clamped);
      setPan((p) => clampFreedPan(clamped, freedAspect, p.x, p.y));
    }
  }

  function handleImageWheel(ev: ReactWheelEvent<HTMLDivElement>) {
    if (!viewerItem || viewerItem.file_type !== "image") return;
    ev.preventDefault();
    if (performance.now() < wheelNavLockUntilRef.current) return;
    zoomImage(ev.deltaY < 0 ? 1 : -1);
  }

  function startFreedDrag(ev: ReactMouseEvent<HTMLDivElement>) {
    ev.preventDefault();
    ev.stopPropagation();
    dragStart.current = { x: ev.clientX, y: ev.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  }

  // Window-level while dragging: the cursor regularly leaves the (small,
  // zoomed) image while panning, and the drag must keep tracking it anyway.
  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      const start = dragStart.current;
      if (!start) return;
      const next = { x: start.panX + (ev.clientX - start.x), y: start.panY + (ev.clientY - start.y) };
      setPan(clampFreedPan(freedScale, freedAspect, next.x, next.y));
    }
    function onUp() {
      dragStart.current = null;
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, freedScale, freedAspect]);

  // Every keyboard shortcut of the timeline, in one window listener that
  // always sees the current state (see useWindowKeydown). Each block below
  // is one shortcut with its own guard, and they don't depend on each other:
  // all of them see the same state for one key press, and what one of them
  // changes only shows from the next press on. The three menus close on
  // Escape through their own listeners further up.
  //
  // Until 2026-11-05 these were nine listeners re-subscribed by their own
  // effect dependencies; "+" in the freed image zoom then kept multiplying
  // the scale it had when the zoom started, so the keyboard never got past
  // the first step.
  useWindowKeydown((ev) => {
    const target = ev.target as HTMLElement | null;
    const inTextField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    // Ctrl+V on the timeline with an image on the clipboard: a new diary entry
    // dated now (changeable in the dialog). Outside text fields only, and only
    // while nothing else owns the keyboard.
    if (!keyboardSuspended && !viewerItem && !clusterSource && !openFan && !searchOpen && onDiaryRequest) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "v" && !inTextField) {
        const requestDiary = onDiaryRequest;
        void readClipboardImage().then((image) => {
          if (image) requestDiary({ entry: null, timestamp: new Date().toISOString(), image });
        });
      }
    }

    // "+"/"-" mirror the wheel zoom; Escape collapses the freed layer, same
    // as crossing the baseline by zooming out or clicking beside the image.
    if (viewerItem && viewerItem.file_type === "image" && !inTextField) {
      if (ev.key === "+" || ev.key === "=") {
        ev.preventDefault();
        zoomImage(1);
      } else if (ev.key === "-" || ev.key === "_") {
        ev.preventDefault();
        zoomImage(-1);
      } else if (ev.key === "Escape" && freed) {
        ev.preventDefault();
        collapseFreed();
      }
    }

    // Escape collapses whichever overlay is topmost, one layer per press —
    // same order a click already dismisses them in: freed zoom (handled
    // above) first, then the detail viewer, then the cluster grid, then
    // a hover-opened pile, and finally the search bar (which also closes
    // itself when Escape comes from one of its own inputs, see SearchBar). The pile is last because it's the one case that
    // can underlie the viewer without a cluster grid in between (opened by
    // hovering tiles directly on the main timeline) — scheduleClusterClose's
    // viewerOpenRef guard is what keeps it alive for this to find. The
    // `!freed` defers to the block above instead of also closing the viewer
    // in the same keypress.
    if ((viewerItem || clusterSource || openFan || searchOpen) && ev.key === "Escape" && !freed) {
      if (dateEditing) {
        // Escape inside the open date editor abandons the edit (its segments
        // are real <input>s, so the guard below would otherwise swallow the
        // press entirely and leave the editor open).
        ev.preventDefault();
        setDateEditing(false);
      } else if (!inTextField) {
        ev.preventDefault();
        if (viewerItem) leaveViewer();
        else if (clusterSource) closeCluster();
        else if (openFan) closePileNow();
        else onCloseSearch?.();
      }
    }

    // Arrow-key prev/next and Delete-to-remove inside the open detail viewer,
    // mirroring the existing click targets (viewer-nav-arrow buttons and the
    // trash button) so keyboard users get the same two actions. Guarded like
    // the Escape handler above: skipped during the freed zoom, the date
    // editor, and while a real text field (name input, note textarea) has
    // focus, so arrow/backspace keystrokes there keep their normal meaning.
    if (viewerItem && !freed && !dateEditing && !nameEditing && !inTextField) {
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        goToAdjacent(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        goToAdjacent(1);
      } else if (ev.key === "Delete") {
        ev.preventDefault();
        removeItem(viewerItem);
      }
    }

    const selectAll = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a" && !inTextField;

    // Ctrl/Cmd+A selects every tile currently rendered on the main timeline
    // ("im aktuellen Bereich") — a stack's front tile explodes into its full
    // membership, same as a single Ctrl-click on it (see toggleTileSelection).
    // Suppressed while any overlay with its own meaning for the shortcut (or
    // for typing generally) is open.
    if (selectAll && !keyboardSuspended && !viewerItem && !clusterSource && !openFan && !searchOpen) {
      ev.preventDefault();
      const ids: string[] = [];
      for (const item of visibleItems) {
        const group = clusterByItemId.get(item.id);
        if (group && group.length > 1) ids.push(...group.map((g) => g.id));
        else ids.push(item.id);
      }
      setSelectedIds(new Set(ids));
    }

    // Ctrl/Cmd+A inside an open grid — a cluster card or a hovered-open pile
    // — covers that grid's own tiles instead of the timeline's. It toggles
    // rather than only selecting: toggleSelectionIds clears the lot when they
    // are already all selected, so the same shortcut marks and unmarks a
    // cluster. The grid's type filter is deliberately respected, since a
    // filtered-out tile isn't on screen to be selected.
    if (selectAll && !keyboardSuspended && !viewerItem && (clusterSource || openFan)) {
      ev.preventDefault();
      const ids = (clusterSource ? clusterFilteredItems : pileMembers).map((i) => i.id);
      if (ids.length > 0) toggleSelectionIds(ids);
    }

    // Escape clears an active tile selection — lowest priority, after every
    // other overlay's own Escape handling above, so Escape with e.g. the
    // viewer open still closes that first and leaves the selection alone.
    if (selectedIds.size > 0 && ev.key === "Escape" && !viewerItem && !clusterSource && !openFan && !searchOpen) {
      setSelectedIds(new Set());
    }

    // Escape after a zoom-to-phase goes back to the view before it — last in
    // line: not taken while anything above would take the same press (an
    // overlay, a menu, a selection, a dialog over the timeline).
    if (
      phaseReturnView &&
      !keyboardSuspended &&
      !viewerItem &&
      !clusterSource &&
      !openFan &&
      !searchOpen &&
      !phaseMenu &&
      !trackMenu &&
      !contextMenu &&
      selectedIds.size === 0 &&
      ev.key === "Escape" &&
      !inTextField
    ) {
      ev.preventDefault();
      returnFromPhaseZoom();
    }
  });

  // The freed frame's box is sized to the image's *post-rotation* visual
  // footprint (swapping natural width/height for a 90/270 rotation, same as
  // RotatedImage's own aspect-ratio trick) so that centering it via -50%
  // lines up with what's actually on screen, not the unrotated pixels.
  const freedHeightPx = freedScale * window.innerHeight;
  const freedFrameStyle = {
    transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
    ...(freedAspect ? { height: `${freedHeightPx}px`, width: `${freedHeightPx * freedAspect}px` } : {}),
  };

  return (
    // `timeline--video-open`: see the rule in App.css — the tiles behind a
    // playing video are taken out of painting, not just covered.
    <div className={"timeline" + (viewerItem?.file_type === "video" ? " timeline--video-open" : "")}>
      {searchOpen && (
        <SearchBar
          onResults={handleSearchResults}
          total={matchedItems.length}
          activeIndex={Math.min(activeMatchIndex, Math.max(matchedItems.length - 1, 0))}
          onPrev={() => goToMatch(-1)}
          onNext={() => goToMatch(1)}
          onViewResults={openSearchCluster}
          onClose={() => onCloseSearch?.()}
          historySignal={searchHistorySignal}
        />
      )}
      {invalidDateCount > 0 && (
        // Moves out from under the search bar, which claims the same corner.
        <div className={"timeline__notice" + (searchOpen ? " timeline__notice--shifted" : "")}>
          ⚠ {invalidDateCount} {t("timeline.invalidDates")}
        </div>
      )}
      {showLoadingSpinner ? (
        // Shown while `reloadItems` hasn't resolved yet (`!itemsFetched`; the cluster
        // trees are built in the same render, see `laneClusterTrees`).
        // Without this there is otherwise nothing on screen at all: no grid,
        // no empty-state teaser (that's gated on `itemsFetched` on purpose,
        // see below), nothing.
        <div className="timeline__loading" role="status" aria-live="polite">
          <div className="timeline__loading-spinner" />
          <span className="timeline__loading-label">{t("timeline.loadingItems")}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="timeline__empty">
          <figure className="timeline__empty-teaser">
            {/* Text unter dem Bild, nicht darauf: die untere Bildhaelfte ist
                voll mit Kacheln und deren Beschriftungen, da gibt es keine
                ruhige Flaeche, auf der eine Zeile zuverlaessig lesbar
                bleibt. Der Verlauf am unteren Bildrand blendet das Bild in
                den Hintergrund aus, damit Bild und Text trotzdem als ein
                Block gelesen werden. */}
            <div className="timeline__empty-art">
              <img src={EMPTY_TEASER_SRC[currentLanguage()]} alt="" aria-hidden="true" />
            </div>
            <figcaption className="timeline__empty-caption">
              <p className="timeline__empty-title">{t("timeline.emptyTitle")}</p>
              <p className="timeline__empty-hint">
                {t("timeline.emptyHint")}{" "}
                {/* Gleiches Zeichen wie FAB und Workflow-Rail: gefuellter
                    Akzentkreis, damit das "+" hier als dieselbe Aktion
                    gelesen wird — und tut es auch: gleicher Klick wie die
                    FAB, oeffnet den Dateibrowser auf dem Add-Tab. */}
                <button
                  type="button"
                  className="timeline__empty-plus"
                  onClick={onAddFiles}
                  title={t("project.addFiles")}
                  aria-label={t("project.addFiles")}
                >
                  +
                </button>{" "}
                {t("timeline.emptyHintSuffix")}
              </p>
            </figcaption>
          </figure>
        </div>
      ) : (
        <div
          className="timeline__scroll"
          ref={scrollRef}
          onWheel={handleWheel}
          onMouseDown={handleContainerMouseDown}
          onMouseMove={handleContainerMouseMove}
          onMouseUp={handleContainerMouseUp}
          onMouseLeave={handleContainerLeave}
        >
          {/* Period labels live in their own clipped row above the lane
              area's top edge — that edge is the "line" tiles can never be
              drawn above, so a tall tile in the thin top lane can no longer
              visually cover the label text (see .timeline__lanes-area). */}
          <div className="timeline__header" ref={headerRef}>
            {/* The period you are standing in, pinned to the left edge.
                This is the answer to "January should be on the left when the
                zoom flips to month view" that does NOT move the view: the
                content stays exactly where it was zoomed to, and the label
                comes to the edge instead. Snapping the viewport itself was
                the other option and was dropped on purpose — zooming is
                cursor-anchored, and a jump at the moment of the flip pulls
                the view off whatever the pointer was resting on.

                Lives outside the header track so the scroll transform does
                not carry it along; its text is written per frame by
                applyFishEye, which already knows the scroll offset. */}
            <span className="timeline__header-sticky" ref={stickyLabelRef} />
            <div className="timeline__header-track" ref={headerTrackRef} style={{ width: trackDomWidth }}>
              {markers.map((m) => {
                // A label opens the cluster of its period — unless the period
                // holds no file, which would only open an empty card.
                const period = m.label ? labelPeriod(Date.parse(m.key), level) : null;
                const clickable = period !== null && hasTimeIn(itemTimes, period.startMs, period.endMs) ? period : null;
                return (
                  <span
                    key={m.key + "-label"}
                    // At month level every marker is its own week range (e.g.
                    // "Woche 2-8.07.2018") — all of them get the bold
                    // treatment, not just the first week of the month (which
                    // is all `m.major` would otherwise select, since that flag
                    // also drives the gridline emphasis below).
                    className={
                      "timeline__marker-label" +
                      (m.major || level === "month" ? " timeline__marker-label--major" : "") +
                      (clickable ? " timeline__marker-label--clickable" : "")
                    }
                    style={
                      level === "overview"
                        ? { left: m.labelX - trackOrigin, fontSize: `${overviewLabelFontPx}px` }
                        : gridIsPreview
                          ? // Follows the preview grid's lines, but never as
                            // far down: a label has to stay readable.
                            { left: m.labelX - trackOrigin, opacity: 0.45 + 0.55 * gridOpacity }
                          : { left: m.labelX - trackOrigin }
                    }
                    onClick={
                      clickable
                        ? (ev) => {
                            if (Math.abs(ev.clientX - pressXRef.current) >= PHASE_CLICK_SLOP_PX) return;
                            openPeriodCluster(clickable.startMs, clickable.endMs, m.full);
                          }
                        : undefined
                    }
                  >
                    {m.label}
                  </span>
                );
              })}
            </div>
          </div>
          {phaseRows.length > 0 && (
            <div
              className="timeline__phases"
              ref={phaseAreaRef}
              style={{ height: phaseAreaPx }}
              onScroll={hidePhasePopoverNow}
              role="group"
              aria-label={t("phases.title")}
            >
              <div className="timeline__phases-content" style={{ height: phaseContentHeight(phaseRows) }}>
                {/* Row bands: the same tint as the lanes below. The labels are in
                    the fixed column further down. */}
                {phaseRows.map((row) => (
                  <div key={row.group.id} className="timeline__phase-row" style={{ top: row.top, height: row.height }} />
                ))}
                <div className="timeline__phase-track" ref={phaseTrackRef} style={{ width: trackDomWidth }}>
                  {phaseBars.map((bar) => {
                    const { phase } = bar.entry;
                    return (
                      <div
                        key={phase.id}
                        className={
                          "timeline__phase-bar" +
                          (bar.cutStart ? " timeline__phase-bar--cut-start" : "") +
                          (bar.cutEnd ? " timeline__phase-bar--cut-end" : "")
                        }
                        style={{
                          left: bar.left - trackOrigin,
                          width: bar.width,
                          top: bar.top,
                          height: PHASE_BAR_HEIGHT,
                          backgroundColor: phase.color,
                          color: bar.entry.textColor,
                        }}
                        data-phase-id={phase.id}
                        role="img"
                        aria-label={`${phase.title}, ${formatDay(phase.startDate)} – ${formatDay(phase.endDate)}`}
                        onMouseEnter={(ev) => schedulePhasePopover(bar, ev.currentTarget)}
                        onMouseLeave={hidePhasePopoverSoon}
                        onContextMenu={(ev) => handlePhaseContextMenu(bar, ev)}
                      >
                        <span
                          className="timeline__phase-title"
                          ref={(el) => {
                            if (el) phaseTitleEls.current.set(phase.id, el);
                            else {
                              phaseTitleEls.current.delete(phase.id);
                              phaseTitleWritten.current.delete(phase.id);
                            }
                          }}
                        >
                          {phase.title}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {/* The label column: fixed, opaque, above the bars, so bars
                    pass under its edge instead of under the text. */}
                <div className="timeline__gutter" style={{ width: labelColW || undefined }}>
                  {phaseRows.map((row, rowIndex) => (
                    <div key={row.group.id} className="timeline__gutter-row" style={{ top: row.top, height: row.height }}>
                      {rowIndex === 0 && (
                        <button
                          type="button"
                          className="timeline__gutter-arrow"
                          title={t("phases.quickToggle")}
                          aria-label={t("phases.quickToggle")}
                          aria-expanded={groupMenu != null}
                          onMouseDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            const r = ev.currentTarget.getBoundingClientRect();
                            setGroupMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }));
                          }}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                      <span className="timeline__lane-label timeline__lane-label--topic" title={row.group.name}>
                        {row.group.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="timeline__lanes-area" ref={lanesAreaRef} onContextMenu={handleTrackContextMenu}>
            <div className="timeline__lanes">
              {laneLayout.lanes.map((lane) => {
                const { topPct, heightPct } = laneLayout.bounds[lane];
                return (
                  <div key={lane} className="timeline__lane" style={{ top: `${topPct}%`, height: `${heightPct}%` }} />
                );
              })}
            </div>
            <div className="timeline__track" ref={trackRef} style={{ width: trackDomWidth }}>
              <div className="timeline__markers">
                {markers.map((m) => (
                  <span
                    key={m.key + "-line"}
                    className={"timeline__marker-line" + (m.major ? " timeline__marker-line--major" : "")}
                    // A grid that is not the column grid yet is drawn
                    // faintly and grows in with the zoom — see `columns`.
                    style={gridIsPreview ? { left: m.x - trackOrigin, opacity: gridOpacity } : { left: m.x - trackOrigin }}
                  />
                ))}
                {/* While the fine grid is only a preview, the columns the
                    tiles actually sit in keep their own lines at full
                    strength — otherwise the boundary a tile stops at would
                    be one faint line among thirty. */}
                {gridIsPreview &&
                  columnMarkers.map((m) => (
                    <span
                      key={m.key + "-column"}
                      className={"timeline__marker-line" + (m.major ? " timeline__marker-line--major" : "")}
                      style={{ left: m.x - trackOrigin }}
                    />
                  ))}
              </div>

              {visibleItems.map((item) => (
                <div
                  key={item.id}
                  className={"timeline-tile" + (selectedIds.has(item.id) ? " timeline-tile--selected" : "")}
                  data-x={trackX(item.resolved_timestamp)}
                  ref={(el) => {
                    if (el) tileRefs.current.set(item.id, el);
                    else tileRefs.current.delete(item.id);
                  }}
                  style={{ left: trackX(item.resolved_timestamp) - trackOrigin, top: `${laneCenterPercent(laneLayout, item.file_type)}%` }}
                  onMouseEnter={(ev) => handleTileMouseEnter(item.id, ev)}
                  onMouseLeave={() => handleTileMouseLeave(item.id)}
                  onMouseDown={(ev) => handleTileMouseDown(item, ev)}
                  onContextMenu={(ev) => handleTileContextMenu(item, ev)}
                >
                  <div className="timeline-tile__thumb">
                    {item.file_type === "document" ? (
                      // Documents always show the scroll icon at rest —
                      // revealing the actual rendered content (PDF first page,
                      // the generated .doc card) only on hover, so the strip
                      // reads as a consistent row of "documents" rather than a
                      // mix of unrelated-looking thumbnails. Types with no
                      // generated preview at all (docx/odt/rtf/txt) simply
                      // keep showing the icon — there's nothing to reveal.
                      thumbs[item.id] && hoveredId === item.id ? (
                        <ThumbImg src={thumbs[item.id]} alt="" />
                      ) : (
                        <img src={scrollIcon} alt="" className="timeline-tile__doc-icon" />
                      )
                    ) : thumbs[item.id] ? (
                      <ThumbImg
                        src={thumbs[item.id]}
                        alt=""
                        style={
                          item.file_type === "image" && item.rotation
                            ? { transform: `rotate(${item.rotation}deg)` }
                            : undefined
                        }
                      />
                    ) : item.file_type === "audio" ? (
                      <img src="/audio2.jpeg" alt="" />
                    ) : item.file_type === "video" ? (
                      <span className="timeline-tile__icon">🎬</span>
                    ) : item.file_type === "email" ? (
                      <span className="timeline-tile__icon timeline-tile__icon--email">✉️</span>
                    ) : item.file_type === "diary" ? (
                      <img src="/diary_entry.png" alt="" />
                    ) : item.file_type === "other" ? (
                      <WildcardIcon />
                    ) : (
                      <span className="timeline-tile__icon">📄</span>
                    )}
                  </div>
                  {/* See tileLabelContent for what shows here and why: a
                      bare image/video thumbnail gets no caption at rest and
                      only the timestamp once hovered, audio/document always
                      keep their filename, and e-mail never shows the
                      filename at all. */}
                  {renderTileLabel(
                    item,
                    hoveredId === item.id,
                    hoveredId === item.id ? "timeline-tile__label timeline-tile__label--hover" : "timeline-tile__label",
                  )}
                  {item.file_type === "diary" && onDiaryRequest && (
                    <button
                      className="timeline-tile__pencil"
                      title={t("diary.tileEdit")}
                      aria-label={t("diary.tileEdit")}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onDiaryRequest({ entry: item, edit: true });
                      }}
                    >
                      ✏️
                    </button>
                  )}
                  {/* How many files the stack holds, on its front tile —
                      shown for every cluster, down to two (see
                      BADGE_MIN_MEMBERS). */}
                  {stackBadgeFor(item.id) != null && (
                    <span className="timeline-tile__count">{stackBadgeFor(item.id)}</span>
                  )}
                </div>
              ))}
            </div>
            {/* The label column of the lanes: fixed, opaque, above the track,
                so tiles pass under its edge instead of under the text. Same
                width as the one in the phase area. */}
            <div className="timeline__gutter" style={{ width: labelColW || undefined }}>
              {laneLayout.lanes.map((lane) => {
                const { topPct, heightPct } = laneLayout.bounds[lane];
                return (
                  <div key={lane} className="timeline__gutter-row" style={{ top: `${topPct}%`, height: `${heightPct}%` }}>
                    <span className="timeline__lane-label">{t(LANE_LABEL_KEY[lane])}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* An open pile: a fixed, centred overlay over a blurred, locked
              timeline — the same pattern as the year-cluster card below.
              Deliberately a sibling of .timeline__lanes-area rather than
              living inside .timeline__track (that track carries a scroll
              transform, and a transformed ancestor becomes the containing
              block for its `fixed` descendants, which would turn "fixed"
              into "stuck to the track" instead of to the viewport) — but
              still inside .timeline__scroll, not outside it: that element
              owns the mousemove/mouseleave handlers the corridor-keep-alive
              logic depends on (see checkClusterStillHovered), and native
              mouseleave fires the moment the pointer lands on a sibling
              instead of a descendant. A pile overlay rendered outside
              .timeline__scroll would make moving the pointer toward the
              centred card itself look like "the pointer left the timeline",
              closing the pile before it could ever be reached.

              The backdrop blocks every pointer event from reaching whatever
              is underneath — the same fix as before for the fan-out
              activating the wrong tile — and closes the pile on click. The
              card itself has no background of its own (see .pile-card) and
              no click handler either, so a click anywhere on it that isn't
              on the hero or a grid tile (both of which stop it from
              bubbling, see handlePileClick) reaches this same handler and
              closes the pile — exactly like clicking the bare backdrop. */}
          {openFan && (
            <div
              className="pile-overlay"
              onMouseDown={(ev) => {
                ev.stopPropagation();
                scheduleClusterClose();
              }}
            >
              <div className="pile-card" ref={pileCardRef}>
                {/* Display-only: shows whichever grid tile below was last
                    entered (see fanFocusId). Clicking it opens that member. */}
                {heroItem && (
                  <div
                    className="pile-hero"
                    onWheel={(ev) => handlePreviewWheel(heroItem, ev)}
                    onMouseDown={(ev) => handlePileClick(heroItem, ev)}
                    onContextMenu={(ev) => handleTileContextMenu(heroItem, ev)}
                  >
                    {renderClusterThumb(heroItem, true)}
                    {renderTileLabel(heroItem, true, "pile-hero__label")}
                  </div>
                )}

                <div className="pile-grid-area">
                  <div
                    className="pile-grid-wrap"
                    ref={pileGridWrapCallback}
                    onScroll={checkPileGridOverflow}
                    // handleWheel (on .timeline__scroll) always zooms and
                    // closes the open pile on every wheel tick — right, back
                    // when a pile had nothing of its own to scroll, so any
                    // wheel over it could only mean "zoom the timeline
                    // instead". Now the grid does have something to scroll,
                    // so a wheel tick meant for it must not reach that
                    // handler at all.
                    onWheel={(ev) => ev.stopPropagation()}
                  >
                    <div className="pile-grid">
                      {pileMembers.map((item) => (
                        <div
                          key={item.id}
                          className={
                            "pile-tile" +
                            (fanFocusId === item.id ? " pile-tile--focus" : "") +
                            (selectedIds.has(item.id) ? " timeline-tile--selected" : "")
                          }
                          ref={(el) => {
                            if (el) pileTileRefs.current.set(item.id, el);
                            else pileTileRefs.current.delete(item.id);
                          }}
                          onMouseEnter={() => {
                            if (fanFocusIdRef.current !== item.id) {
                              fanFocusIdRef.current = item.id;
                              setFanFocusId(item.id);
                            }
                          }}
                          onMouseDown={(ev) => handlePileClick(item, ev)}
                          onContextMenu={(ev) => handleTileContextMenu(item, ev)}
                        >
                          <div className="timeline-tile__thumb">{renderClusterThumb(item, fanFocusId === item.id)}</div>
                          {renderTileLabel(item, false, "timeline-tile__label")}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Bottom fade: the only hint that there's more below once the
                      grid needs to scroll — see checkPileGridOverflow. */}
                  {pileGridHasMore && <div className="pile-grid-fade" />}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The hit list. Overlays the timeline rather than taking width
          away from it on purpose: narrowing the scroll container would
          change its clientWidth, and with it the layout mode, the auto-fit
          zoom and every clamp derived from it — a whole relayout as a side
          effect of opening a list. */}
      {/* Not while a cluster is open: the search cluster shows the same hits
          itself, and the list would sit under its card, the card's ✕ right
          on top of a row. */}
      {searchOpen && matchedItems.length > 0 && !clusterSource && (
        <SearchResultsList
          items={matchedItems}
          activeId={activeMatchId}
          thumbs={thumbs}
          onPick={(index, item) => {
            // Focuses explicitly as well as setting the index, so
            // clicking the row that is already active re-centres it
            // instead of appearing to do nothing.
            setActiveMatchIndex(index);
            focusOnItem(item.id);
            setSearchHistorySignal((n) => n + 1);
          }}
          onOpen={(item) => {
            setSearchHistorySignal((n) => n + 1);
            void openViewer(item);
          }}
        />
      )}

      {/* Floating "Ändern"-button: the other way to hand a Ctrl-click
          selection off to Datei-Operationen, next to the context-menu entry
          below. Bottom-centre, clear of the search-results panel (top
          right), and layered above the pile and cluster overlays (see its
          z-index) so selecting tiles inside an open grid shows the same
          running count and hand-off button as selecting them on the
          timeline. The detail viewer still covers it, which is right —
          nothing is being selected in there. */}
      {selectedIds.size > 0 && (
        <SelectionBar count={selectedIds.size} onEdit={sendSelectionToFileOps} onClear={() => setSelectedIds(new Set())} />
      )}

      {contextMenu && (
        <TileContextMenu
          menuRef={contextMenuRef}
          menu={contextMenu}
          selectedCount={selectedIds.size}
          onDiaryRequest={onDiaryRequest}
          onSendSelection={sendSelectionToFileOps}
          onOpenExternally={openExternally}
          onRotate={rotateItem}
          onRemove={removeItem}
          onClose={() => setContextMenu(null)}
        />
      )}

      {trackMenu && onDiaryRequest && (
        <TrackContextMenu menuRef={trackMenuRef} menu={trackMenu} onDiaryRequest={onDiaryRequest} onClose={() => setTrackMenu(null)} />
      )}

      {groupMenu && (
        <PhaseGroupMenu menuRef={groupMenuRef} at={groupMenu} groups={phaseGroups} onToggle={(group) => void toggleGroupEye(group)} />
      )}

      {phaseMenu && (
        <PhaseBarMenu
          menuRef={phaseMenuRef}
          menu={phaseMenu}
          setMenu={setPhaseMenu}
          renameDraft={phaseRenameDraft}
          setRenameDraft={setPhaseRenameDraft}
          palette={phasePalette}
          onCommand={(command, args, doneToast) => void runPhaseCommand(command, args, doneToast)}
          onRename={renamePhase}
          onRecolor={recolorPhase}
        />
      )}

      {phaseReturnView && <PhaseReturnChip at={returnChipAt} label={returnLabel} onClick={returnFromPhaseZoom} />}

      {/* The year-cluster grid, opened from clicking a year label at
          Gesamtansicht (see openYearCluster). Sits below the detail viewer
          in z-index on purpose: clicking one of its tiles opens the viewer
          on top of it rather than closing it, so dismissing the viewer
          again reveals the same grid, filter state intact.

          Deliberately shares .pile-card/.pile-hero/.pile-grid-* with the
          open-pile overlay above — same tile size, same 20-column cap,
          same scroll/fade behaviour, same "click anywhere that isn't a tile
          or the hero closes it" — the two are meant to look and behave
          identically, just with this one's own close button, heading (the
          year, or the hit count for a search cluster) and type filters
          added on top. */}
      {clusterSource && (
        <ClusterOverlay
          source={clusterSource}
          items={clusterFilteredItems}
          heroItem={clusterHeroItem}
          hoverId={clusterHoverId}
          onHover={setClusterHoverId}
          typeFilter={clusterTypeFilter}
          setTypeFilter={setClusterTypeFilter}
          selectedIds={selectedIds}
          onToggleSelected={toggleSelectionIds}
          onOpen={(item) => openViewer(item, clusterNavScope ? null : clusterTypeFilter, clusterNavScope)}
          onClose={closeCluster}
          gridWrapRef={pileGridWrapCallback}
          onGridScroll={checkPileGridOverflow}
          gridHasMore={pileGridHasMore}
          renderThumb={renderClusterThumb}
          renderLabel={renderTileLabel}
        />
      )}

      {viewerItem && (
        <ErrorBoundary local onClose={closeViewer}>
        <TimelineViewer
          item={viewerItem}
          media={{
            dataUrl: viewerDataUrl,
            text: viewerText,
            emailHtml: viewerEmailHtml,
            emailRecipients: viewerEmailRecipients,
            emailAttachments: viewerEmailAttachments,
            thumbUrl: thumbs[viewerItem.id],
          }}
          freed={{
            active: freed,
            frameStyle: freedFrameStyle,
            dragging,
            onCollapse: collapseFreed,
            onWheel: handleImageWheel,
            onStartDrag: startFreedDrag,
            onNaturalSize: setImgNatural,
          }}
          edits={viewerEdits}
          dragOut={viewerDragOut}
          timestampOverlayEnabled={timestampOverlayEnabled}
          hasPrev={viewerNavIndex > 0}
          hasNext={viewerNavIndex !== -1 && viewerNavIndex < viewerNavPool.length - 1}
          onStep={goToAdjacent}
          navFilter={
            viewerNavScope
              ? null
              : {
                  active: viewerNavActiveTypes,
                  currentType: laneForFileType(viewerItem.file_type),
                  onToggle: toggleViewerNavType,
                  onAll: () => setViewerNavOverride(ALL_NAV_TYPES),
                }
          }
          onLeave={leaveViewer}
          onBackWheel={handleViewerWheel}
          onContextMenu={handleTileContextMenu}
          onOpenExternally={openExternally}
          onOpenAttachment={openEmailAttachment}
          onRemove={removeItem}
          noteClusterIds={noteClusterIds}
          onOpenNoteCluster={openNoteCluster}
        />
        </ErrorBoundary>
      )}
      {phasePopover && <PhasePopover popover={phasePopover} elRef={phasePopoverElRef} />}
    </div>
  );
}
