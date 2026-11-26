/// Type-only import: `fileKindLane` imports `FileKind` from here in turn,
/// but both directions are erased at compile time, so no module cycle
/// exists at runtime. The lane union lives there because that is where the
/// mapping from a file kind to its group is decided.
import type { KindLane } from "./utils/fileKindLane";
import { invoke } from "./busy";

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  last_opened: string;
  is_default: boolean;
}

export type OpenProjectResult =
  | { status: "opened"; project: ProjectInfo }
  | { status: "not_a_project" }
  | { status: "lock_stale"; pid: number }
  | { status: "lock_active"; pid: number };

export type OpenPrecheckResult =
  | { status: "ready" }
  | { status: "not_a_project" }
  | { status: "lock_stale"; pid: number }
  | { status: "lock_active"; pid: number };

export type CopyTaskKind = "duplicate" | "backup";
export type CopyTaskStatus = "running" | "done" | "cancelled" | "error";

export interface CopyProgressPayload {
  task_id: string;
  kind: CopyTaskKind;
  copied_files: number;
  total_files: number;
  copied_bytes: number;
  total_bytes: number;
  status: CopyTaskStatus;
  error: string | null;
  result_path: string | null;
}

export type FileKind = "image" | "video" | "audio" | "document" | "email" | "other";

/// Header fields of a mail file, see `get_email_headers`.
export interface EmailHeader {
  subject: string | null;
  sender: string | null;
  date: string | null;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  kind: FileKind | null;
  can_add: boolean;
  size: number | null;
  fs_created_at: string | null;
  fs_modified_at: string | null;
  rotation: number;
  /// Only set for a project item (`ProjectFilesView`'s own mapping onto
  /// this shape, see `ProjectFileEntry.resolvedTimestamp`) — absent for a
  /// plain disk entry, which has no stream timestamp to show. Where
  /// present, the preview panel leads with this instead of the filename.
  resolved_timestamp?: string | null;
}

export interface QuickAccessEntry {
  kind: "home" | "desktop" | "pictures" | "documents" | "downloads" | "drive";
  label: string | null;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntryInfo[];
}

export interface AddedItem {
  id: string;
  original_filename: string;
  kind: FileKind;
  resolved_timestamp: string;
  timestamp_source: string;
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface AddItemsResult {
  added: AddedItem[];
  skipped: SkippedItem[];
  /// Groups among `added` that collide with each other or with an existing
  /// item by `quick_hash` — empty unless "Beim Einfügen auf Duplikate
  /// prüfen" is on.
  duplicates: DuplicateGroup[];
}

/// Emitted on the `add-items-progress` event while `add_items` works
/// through a batch — see `browse_commands::add_items` on the Rust side.
export interface AddItemsProgress {
  done: number;
  total: number;
  current: string;
}

/// Which date a file should land on the timeline with. `auto_source` /
/// `auto_value` are what the backend's priority chain picked — the review
/// screen preselects that and lets the user switch to another candidate.
/// "meta": the creation date inside a video, recording or document (see
/// `media_date.rs`) — offered as a choice, never picked automatically.
export type DateSource = "exif" | "meta" | "filename" | "fs_created" | "fs_modified" | "manual" | "recording";

export interface FileDateInfo {
  path: string;
  name: string;
  kind: FileKind;
  exif: string | null;
  fs_created: string | null;
  fs_modified: string | null;
  /// The timestamp the filename itself carries, where it has one.
  filename: string | null;
  /// The creation date inside a video, recording or document, if it has one.
  /// Not part of `get_date_candidates`: read separately and only where the
  /// choice is shown (`get_media_dates`), so absent until then.
  media?: string | null;
  auto_source: DateSource;
  auto_value: string;
  can_add: boolean;
}

export interface ManifestImportResult {
  valid: FileDateInfo[];
  total_lines: number;
  invalid_count: number;
}

export interface DatedPath {
  path: string;
  timestamp: string;
  timestamp_source: DateSource;
}

export interface AiSuggestion {
  id: string;
  original_filename: string | null;
  current_timestamp: string | null;
  current_timestamp_source: string | null;
  suggested_timestamp: string;
  confidence: string | null;
  reason: string | null;
  valid: boolean;
  error: string | null;
  source_folder_path: string | null;
  fs_created_at: string | null;
  fs_modified_at: string | null;
  embedded_metadata_at: string | null;
}

export interface AiApplyEntry {
  id: string;
  timestamp: string;
}

/// One file's new date for `update_timestamps_batch` — the same shape as
/// `AiApplyEntry`, kept as its own type since the two calls are unrelated
/// (manual batch edit vs. accepted AI suggestions).
export interface TimestampEntry {
  id: string;
  timestamp: string;
}

/// What `apply_ai_metadata_suggestions` returns — `actionId` (when present)
/// identifies the action-log entry the writes were grouped into, so the
/// review screen can fetch its per-file before/after list via
/// `list_action_entries` for the "Änderungen anzeigen" confirmation.
/// Undoing a change stays the Protokoll tab's job.
export interface AiApplyResult {
  applied: number;
  actionId: number | null;
}

/// What a timeline item can be: any file kind, or a hand-written diary entry
/// (`diary.rs`), which has no file kind of its own.
export type ItemKind = FileKind | "diary";

export interface DiaryAttachment {
  id: string;
  original_filename: string;
  stored_path: string;
  file_type: FileKind;
}

export interface ItemInfo {
  id: string;
  original_filename: string;
  display_name: string | null;
  stored_path: string;
  thumbnail_path: string | null;
  file_type: ItemKind;
  resolved_timestamp: string;
  timestamp_source: string;
  import_batch_id: string | null;
  fs_created_at: string | null;
  fs_modified_at: string | null;
  file_size_bytes: number | null;
  rotation: number;
  /// Free-text note shown under the detail view, `null` when none was
  /// written (see `update_note` in `timeline_commands.rs`).
  note: string | null;
  /// `file_type === "email"` only — `null` for every other kind.
  email_subject: string | null;
  email_sender: string | null;
  email_date: string | null;
  /// `file_type === "diary"` only: the entry's text and how many files hang
  /// on it. `null` / 0 for every other kind.
  diary_text: string | null;
  attachment_count: number;
}

/// Fetches the open project's items.
///
/// Goes through this helper rather than a bare `invoke` because the backend
/// hands back raw JSON bytes, not a serialised `Vec<ItemInfo>`. Parsing them
/// here costs a few milliseconds. See the doc comment on `list_items` in
/// `timeline_commands.rs` — including what that change did NOT fix.
export async function listItems(): Promise<ItemInfo[]> {
  const bytes = await invoke<ArrayBuffer>("list_items");
  return JSON.parse(new TextDecoder().decode(bytes)) as ItemInfo[];
}

/// One file waiting in the mini window's drop box (see
/// `src-tauri/src/pending_drops.rs`). `kind`/`can_add` are derived live
/// from the path on the Rust side, not stored.
export interface PendingDropInfo {
  path: string;
  file_name: string;
  kind: FileKind;
  can_add: boolean;
  exists: boolean;
}

/// A dropped file that looks like something already in the project (see
/// `check_pending_duplicates` in `browse_commands.rs`) — keyed by the
/// dropped path in the map the command returns.
export interface DuplicateMatch {
  existing_item_id: string;
  existing_thumbnail_path: string | null;
  existing_display_name: string;
  existing_resolved_timestamp: string;
}

/// A set of live items `scan_project_for_duplicates` found indistinguishable
/// by `quick_hash` — the Einstellungen "Alle Dateien jetzt prüfen" button's
/// result, handed straight to Datei-Operationen (`restrictToIds`) for the
/// user to look through.
export interface DuplicateGroup {
  item_ids: string[];
}

/// Action log ("Protokoll"). Unlike the older types above these are
/// camelCase: the Rust structs declare `rename_all = "camelCase"` (see
/// `action_log_commands.rs`), because this payload is new and had no
/// existing snake_case consumers to stay compatible with.
export type ActionLogType =
  | "import"
  | "remove"
  | "purge"
  | "rename"
  | "date_change"
  | "ai_date_change"
  | "setting_change"
  | "replace"
  | "phase_group_create"
  | "phase_group_update"
  | "phase_group_reorder"
  | "phase_group_remove"
  | "phase_create"
  | "phase_update"
  | "phase_remove";

/// One file's share of a logged action.
export interface ActionLogEntry {
  id: number;
  itemId: string | null;
  label: string;
  beforeValue: string | null;
  afterValue: string | null;
  reverted: boolean;
  /** False when nothing is left to restore (permanent delete, or the file
   *  has since been permanently deleted). */
  canUndo: boolean;
  /** True for a file that is off the timeline but still occupying space in
   *  the project folder — the entry offers "endgültig löschen". */
  canPurge: boolean;
  /** The item's thumbnail, for the hover preview. Null once the item has
   *  been permanently deleted (the thumbnail file is gone along with it). */
  thumbnailPath: string | null;
}

export interface ActionLogAction {
  id: number;
  actionType: ActionLogType;
  /** Unix milliseconds. */
  performedAt: number;
  entryCount: number;
  revertedCount: number;
  /** Inline for a single-file action, or the search matches; a bulk
   *  action's full tree is fetched on expand via `list_action_entries`. */
  entries: ActionLogEntry[];
}

/// A later change standing in the way of an undo.
export interface ActionLogConflict {
  entryId: number;
  actionId: number;
  actionType: ActionLogType;
  performedAt: number;
  label: string;
}

export type UndoOutcome =
  | { status: "done"; undone: number }
  | { status: "blocked"; reason: string }
  | { status: "conflicts"; conflicts: ActionLogConflict[] }
  | { status: "needsCopyDecision"; labels: string[] };

/// Emitted on the `action-log-progress` event while `list_action_log` /
/// `list_action_entries` stat the files behind a page of the log — see
/// `action_log_commands.rs`.
export interface ActionLogProgress {
  done: number;
  total: number;
}

/// Copying items into another stream (see
/// `src-tauri/src/transfer_commands.rs`). camelCase, like the action-log
/// types above.
export interface TransferTarget {
  path: string;
  name: string;
  itemCount: number;
  /** Another running instance has it open, so a transfer would be refused. */
  busy: boolean;
}

export interface TransferSkipped {
  /** The item's id in the source project. */
  itemId: string;
  label: string;
  reason: string;
}

/** A source item the target already has — answer of `preview_transfer_duplicates`. */
export interface TransferDuplicate {
  itemId: string;
  label: string;
  existingName: string;
  /** False: same original source path; true: same file content. */
  byContent: boolean;
}

export interface TransferResult {
  transferred: number;
  skipped: TransferSkipped[];
  targetName: string;
  /** How many source items were taken off this project's timeline after the
   *  copy — always 0 unless the transfer ran in move mode. Differs from
   *  `transferred` when a file was skipped as already present in the
   *  target: nothing is removed here for those. */
  removedFromSource: number;
}

/// One file of the *open project* as the "Datei-Operationen" and
/// "Papierkorb" tabs list it (see `src-tauri/src/file_ops_commands.rs`).
/// `path` is the in-project copy, which is also what the tile grid keys its
/// marks by.
export interface ProjectFileEntry {
  id: string;
  path: string;
  name: string;
  kind: FileKind;
  thumbnailPath: string | null;
  resolvedTimestamp: string;
  fileSizeBytes: number | null;
  rotation: number;
  fsCreatedAt: string | null;
  fsModifiedAt: string | null;
  /** When the file was inserted into the stream (RFC3339). */
  addedAt: string | null;
  /** Set for a file in the Papierkorb, null for a live one. */
  removedAt: string | null;
  /** False once the in-project copy is gone — a Papierkorb row whose file
   *  was deleted by "Nur Datei löschen". There is no preview to show and
   *  only the final database removal left to offer. */
  filePresent: boolean;
}

export interface TransferProgress {
  done: number;
  total: number;
  current: string;
}

/// Deleting a whole stream and restoring one (see
/// `src-tauri/src/delete_commands.rs`).
export interface DeletionPreview {
  path: string;
  name: string;
  itemCount: number;
  sizeBytes: number;
  /** Entries in the folder that are NOT part of the stream — they get
   *  deleted too, so the dialog has to show them. */
  foreignEntries: string[];
  /** How many items could be restored later from their original sources. */
  restorableCount: number;
}

export interface DeletionOutcome {
  name: string;
  freedBytes: number;
  /** Set when the database was kept, so the deletion stays reversible. */
  keptId: string | null;
}

export interface DeletedStream {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: string;
  itemCount: number;
  restorableCount: number;
}

export interface RestoreReport {
  projectPath: string;
  name: string;
  restored: number;
  /** Restored, but the source file changed since it was imported. */
  changed: string[];
  /** Source file gone; the item keeps its history but stays off the timeline. */
  missing: string[];
}

export interface RestoreProgress {
  done: number;
  total: number;
  current: string;
}

/// Project-scoped settings exposed in the Settings dialog (see
/// `src-tauri/src/action_log_commands.rs::get_project_settings`). Both
/// fields live in the project's own database now, not in `localStorage` —
/// `tileDragEnabled` moved there 2026-10-10 by deliberate decision, so a
/// restored/duplicated stream carries the same choice along.
export interface ProjectSettings {
  tileDragEnabled: boolean;
  defaultVideoFramePercent: number;
  /// When on, taking a file off the timeline immediately deletes its
  /// in-project copy too — see `timeline_commands::remove_item` — instead
  /// of leaving that as a separate "endgültig löschen" step in Protokoll.
  deleteFilesOnRemove: boolean;
  /// When on, the detail viewer shows the item's timeline timestamp as a
  /// subtle overlay along the bottom edge of the media. Defaults to on
  /// (true) — see get_project_settings — since the setting exists to let
  /// someone turn the overlay off, not to opt into it.
  showTimestampOverlay: boolean;
  /// Which files the detail viewer's prev/next steps through: everything
  /// chronologically, only the opened file's own type, or the types ticked
  /// in `viewerNavTypes`.
  viewerNavMode: ViewerNavMode;
  viewerNavTypes: ViewerNavType[];
  /// What opening a stack does, and what opens it — see `PileAction` /
  /// `PileTrigger`. The defaults are "fan" + "click": a stack opens only
  /// when clicked, in place.
  pileAction: PileAction;
  pileTrigger: PileTrigger;
  hoverZoomBrake: HoverZoomBrake;
  /// Moves the real mouse pointer onto the focused tile when a stack fans
  /// out. Only possible where the window system permits it (X11, Windows,
  /// macOS — not a pure Wayland session), hence app-scoped by default.
  fanCursorFollow: boolean;
  /// Whether the timeline draws its week grid and its hour grid. Both on by
  /// default. Without the week grid the day grid starts as soon as a month
  /// spans the viewport; without the hour grid the day grid stays however
  /// far in — see `gridLevel` in utils/timeline/calendar.ts.
  showWeekGrid: boolean;
  showHourGrid: boolean;
  /// Mouse wheel opens the detail viewer from the stack preview and leaves it
  /// again after a few ticks back. On by default.
  wheelViewer: boolean;
  /// "Beim Einfügen auf Duplikate prüfen" — on by default. See
  /// `settings.quickHashOnIngestHint`.
  quickHashOnIngest: boolean;
  /// Sub-setting of `quickHashOnIngest`: only hash a newly inserted file
  /// once an existing item already shares its exact size and filename
  /// (true, the default — free, since that's already-known metadata), or
  /// hash and compare every file unconditionally (false — also catches a
  /// duplicate that was renamed, at the cost of always reading the file).
  quickHashUsePrefilter: boolean;
  /// Lower bound for hand-set dates (default 1900) — guards against typos
  /// like 0020; see `timeline_commands::ensure_date_allowed`.
  earliestDateYear: number;
  /// The four type groups in the order their lanes stack on the timeline,
  /// top to bottom. Always holds all four, normalised by the backend —
  /// which lanes are actually *drawn* follows from what the stream
  /// holds, not from this list.
  laneOrder: KindLane[];
  /// File browser views (`BrowserTab` names) that show the floating timeline
  /// preview and its return pill. Empty = nowhere; the default is only
  /// "file_ops". Unknown names are dropped by the backend.
  peekTabs: string[];
  /// Per setting key (the Rust-side key, e.g. `tile_drag_enabled`), where
  /// its value currently comes from. Written by `set_setting_scope`, never
  /// edited directly.
  scopes: Record<string, SettingScope>;
}

export type ViewerNavMode = "all" | "category" | "custom";
export type ViewerNavType = "image" | "video" | "audio" | "document";

/// `fan` opens the stack in place at the current zoom (big preview, members
/// in a row beneath it); `zoom` zooms the timeline in until the stack comes
/// apart by itself, and only fans out when the zoom that would need is past
/// the limit.
export type PileAction = "fan" | "zoom";
/// What opens a stack. A click always acts immediately either way; this
/// only decides whether hovering does too.
export type PileTrigger = "click" | "hover";
/// Only relevant for hover + zoom, where each zoom slides new content under
/// a pointer that never moved: `step` waits for real pointer travel before
/// zooming again, `cascade` keeps going until the stack dissolves, and
/// `click_only` leaves zooming to the click while hover fans out instead.
export type HoverZoomBrake = "step" | "cascade" | "click_only";
/// Where a setting is remembered: in this one stream, or on this
/// machine for all of them.
export type SettingScope = "project" | "app";

/// The Rust-side keys of every setting the dialog exposes a scope control
/// for. Mirrors `SETTINGS` in `action_log_commands.rs` — the single place
/// the frontend names these, so a typo can't silently produce a row whose
/// scope control writes nothing.
export const SETTING_KEYS = {
  tileDrag: "tile_drag_enabled",
  timestampOverlay: "show_timestamp_overlay",
  viewerNavMode: "viewer_nav_mode",
  viewerNavTypes: "viewer_nav_types",
  pileAction: "pile_action",
  pileTrigger: "pile_trigger",
  hoverZoomBrake: "hover_zoom_brake",
  fanCursorFollow: "fan_cursor_follow",
  showWeekGrid: "show_week_grid",
  showHourGrid: "show_hour_grid",
  wheelViewer: "wheel_viewer",
  quickHashOnIngest: "quick_hash_on_ingest",
  quickHashUsePrefilter: "quick_hash_use_prefilter",
  earliestDateYear: "earliest_date_year",
  deleteOnRemove: "delete_files_on_remove",
  videoFramePercent: "default_video_frame_percent",
  laneOrder: "lane_order",
  peekTabs: "peek_tabs",
} as const;

export interface VideoRegenProgress {
  done: number;
  total: number;
  current: string;
}

// --- Disk search (Dateibrowser-Suche) ---------------------------------

export type DiskSearchDateField = "created" | "modified";
/// "use_cache" ("Schnell aus Cache laden") vs "reindex" ("Neu indizieren") —
/// see `disk_search::IndexMode` on the backend.
export type DiskSearchIndexMode = "use_cache" | "reindex";

/// Shape passed as `search_disk`'s `params` argument — field names are
/// camelCase here (unlike most other invoke payloads in this file) because
/// `disk_search::DiskSearchParams` is the one Rust struct in this feature
/// with `#[serde(rename_all = "camelCase")]`.
export interface DiskSearchParamsInput {
  rootPath: string;
  includeSubfolders: boolean;
  /// Empty = every kind matches.
  kinds: FileKind[];
  /// Optional, case-insensitive substring match against the file name
  /// (not the full path). Empty/null = every name matches.
  nameContains: string | null;
  dateField: DiskSearchDateField;
  dateFrom: string | null;
  dateTo: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  /// "Duplikate ausblenden" — collapses hits that are the same *content*
  /// found at more than one path within this search itself (e.g. the same
  /// photo in two subfolders). Nothing to do with the project — that's
  /// `hideAlreadyInProject` below.
  dedupeWithinResults: boolean;
  /// "Bereits im Projekt enthaltene Dateien ausblenden" — removes hits
  /// whose content already exists in the open project (even under a
  /// different path/name there).
  hideAlreadyInProject: boolean;
  /// Shared by both toggles above, only consulted when at least one is on:
  /// false = "schnell", true = "gründlich" (also confirms with a full
  /// content hash).
  verifyDuplicateContent: boolean;
  indexMode: DiskSearchIndexMode;
}

export type DiskSearchPhase = "counting" | "scanning" | "deduping_results" | "checking_against_project";

export interface DiskSearchProgressPayload {
  task_id: string;
  phase: DiskSearchPhase;
  done: number;
  total: number;
  current_action: string;
  estimated_seconds_remaining: number | null;
}

export interface DiskSearchDuplicateMatch {
  existing_item_id: string;
  existing_display_name: string;
  existing_thumbnail_path: string | null;
  existing_resolved_timestamp: string;
  content_verified: boolean;
}

export interface DiskSearchHit {
  path: string;
  name: string;
  kind: FileKind;
  size: number;
  fs_created_at: string | null;
  fs_modified_at: string | null;
  duplicate: DiskSearchDuplicateMatch | null;
}

export interface DiskSearchDonePayload {
  task_id: string;
  hits: DiskSearchHit[];
  cancelled: boolean;
  error: string | null;
  /// Hits removed as duplicates of another hit in this same search — not
  /// part of `hits` any more, so this is the only way to still show how
  /// many were collapsed away.
  within_results_duplicates_removed: number;
  /// (Already-deduped) hits removed because their content already exists
  /// in the project — same reasoning.
  already_in_project_hidden: number;
}

/// Result of looking through a folder for replacement files
/// ("Datei im Stream ersetzen", see `find_replacement_matches`).
export interface ReplacementCandidate {
  path: string;
  name: string;
  sizeBytes: number | null;
}

export interface ReplacementMatch {
  itemId: string;
  name: string;
  kind: string;
  currentSizeBytes: number | null;
  sourceAvailable: boolean;
  candidates: ReplacementCandidate[];
}

export interface ReplacementScan {
  matches: ReplacementMatch[];
  checkedItems: number;
  folderFiles: number;
}

export interface ReplacedFile {
  name: string;
  newName: string;
  oldSizeBytes: number;
  newSizeBytes: number;
}

export interface ReplaceOutcome {
  replaced: number;
  files: ReplacedFile[];
  failed: string[];
  savedBytes: number;
}

export interface PrintExportSummary {
  exported: number;
  failed: { id: string; name: string; reason: string }[];
  target_folder: string;
}

/// Life phases (see `src-tauri/src/phases.rs`). camelCase, like the
/// action-log types above. Dates are plain days, "YYYY-MM-DD", end inclusive.
export interface PhaseView {
  id: string;
  groupId: string;
  title: string;
  startDate: string;
  endDate: string;
  /** "#rrggbb", lower case. */
  color: string;
  visible: boolean;
  /** "läuft noch": the backend keeps `endDate` at today while this is on. */
  ongoing: boolean;
}

/// A group's eye is derived from its phases: all shown, none shown, or some.
export type PhaseVisibility = "visible" | "hidden" | "partial";

export interface PhaseGroupView {
  id: string;
  name: string;
  sortIndex: number;
  visibility: PhaseVisibility;
  overlapAllowed: boolean;
  /** ms of the last edit of the group or one of its phases; 0 if never logged. */
  lastEditedAt: number;
  /** Sorted by start date. */
  phases: PhaseView[];
}

export interface PhaseOverlapPair {
  first: PhaseView;
  second: PhaseView;
}

/// A write the rules refused comes back as `overlap` with the clashing pairs
/// and nothing saved.
export type PhaseSaveOutcome<T> =
  | { status: "saved"; value: T }
  | { status: "overlap"; pairs: PhaseOverlapPair[] };

export interface PhaseGroupPatch {
  name?: string;
  overlapAllowed?: boolean;
}

export interface PhaseInput {
  title: string;
  startDate: string;
  endDate: string;
  color?: string;
  ongoing: boolean;
}

export interface PhasePatch {
  title?: string;
  startDate?: string;
  endDate?: string;
  color?: string;
  ongoing?: boolean;
}

/** Start menu and autostart entries of the Linux AppImage; on Windows only
    the autostart. */
export interface DesktopEntries {
  app: boolean;
  dropzone: boolean;
  autostart: boolean;
  /** The program on the desktop. */
  desktop: boolean;
}

export interface WatchFolderStatus {
  path: string | null;
  recursive: boolean;
  exists: boolean;
}

export interface DesktopIntegrationStatus {
  available: boolean;
  /** Which entries this system offers at all. */
  supported: DesktopEntries;
  entries: DesktopEntries;
}

// --- Uninstall (see src-tauri/src/uninstall.rs) ---------------------------

export type UninstallTargetKind =
  | "settings"
  | "webview"
  | "cache"
  | "recordings"
  | "legacy"
  | "menu"
  | "startMenu"
  | "autostart"
  | "program";

export interface UninstallTarget {
  kind: UninstallTargetKind;
  path: string;
  sizeBytes: number;
}

export interface UninstallStream {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface UninstallPlan {
  available: boolean;
  unavailableReason: string | null;
  platform: "linux" | "windows" | "other";
  targets: UninstallTarget[];
  streams: UninstallStream[];
  /** The AppImage file, offered for deletion on its own (Linux). */
  appimage: string | null;
  /** Deleted streams whose database is kept for a restore. */
  keptDeletedStreams: number;
}

// --- Private mode (see src-tauri/src/privacy.rs) -------------------------

export type PrivacyScope = "timeline" | "views" | "everywhere";

export interface PrivacyStatus {
  configured: boolean;
  /// Whether private files are showing right now. Starts false on every open.
  revealed: boolean;
  shortcut: string | null;
  /// 0 means they stay until hidden by hand.
  autoHideMinutes: number;
  /// Whether the eye in the bottom-left corner is drawn at all.
  showIndicator: boolean;
}

export interface PrivacyDetails {
  shortcut: string;
  marker: string;
  scope: PrivacyScope;
  autoHideMinutes: number;
  showIndicator: boolean;
}
