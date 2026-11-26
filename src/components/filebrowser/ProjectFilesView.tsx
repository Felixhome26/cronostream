import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import { t, tCount } from "../../i18n";
import { formatBytes } from "../DeleteStreamDialog";
import { useToast } from "../../ToastContext";
import { useProgress } from "../../ProgressContext";
import type { DirEntryInfo, ProjectFileEntry } from "../../types";
import { formatDate } from "../../utils/datetime";
import { fileUrl, loadMediaServerInfo, type MediaServerInfo } from "../../utils/mediaServer";
import { useTransientCollection } from "../../hooks/useCollection";
import ChangeDateDialog from "./ChangeDateDialog";
import FileTileGrid from "./FileTileGrid";
import ProjectYearNav, { ALL_YEARS, type DateRange, type YearSelection } from "./ProjectYearNav";
import ToggleSwitch from "./ToggleSwitch";
import SegmentedDateTimeInput from "../SegmentedDateTimeInput";

/// Handed to the owning tab so it can draw its own batch actions over the
/// current marks, without re-implementing any of the loading, filtering or
/// mark handling.
export interface ProjectFilesActionContext {
  /// The marked files, as full entries — the tabs need `id` for every
  /// backend call and `filePresent` to decide what is still offerable.
  marked: ProjectFileEntry[];
  /// Everything currently on screen after the year/range narrowing.
  visible: ProjectFileEntry[];
  /// Re-reads the list and the year rail — call after any action that
  /// changed which side of `removed_at` a file is on.
  reload: () => Promise<void>;
  busy: boolean;
  /// Wraps a batch action: sets `busy`, reports the outcome as a toast,
  /// then clears the marks and reloads. The tabs supply only the call and
  /// the message, so every batch behaves the same way afterwards. An empty
  /// message shows no toast (for actions that report in their own dialog).
  ///
  /// `progress`, when given, registers the operation with the app-wide
  /// progress indicator before calling `action` and clears it again once
  /// settled — `action` receives the same operation id so it can pass it
  /// through to whichever backend command reports progress under it (see
  /// `progress::emit_progress` on the Rust side). Omit it for actions that
  /// don't report progress (nothing changes for them beyond `action` now
  /// also receiving — and being free to ignore — that id).
  run: (
    action: (operationId: string) => Promise<number>,
    message: (count: number) => string,
    progress?: { label: string; total: number },
  ) => Promise<void>;
  /// Opens `ChangeDateDialog` for the given files — the same dialog the
  /// grid's own "Datum ändern" context-menu entry opens, just reachable
  /// from the tab's own toolbar dropdown too.
  changeDate: (paths: string[]) => void;
  /// Marks the files with these ids (those currently loaded), e.g. to hand
  /// a set of files back to the user after an action left them behind.
  markIds: (ids: string[]) => void;
}

interface Props {
  /// Which side of `items.removed_at` this view lists — false for
  /// "Datei-Operationen", true for "Papierkorb".
  trashed: boolean;
  emptyMessage: string;
  renderActions: (ctx: ProjectFilesActionContext) => React.ReactNode;
  /// Items for the tile context menu; `ctx.marked` is the right-clicked
  /// file, or the whole marked selection if it belongs to one.
  renderContextActions?: (ctx: ProjectFilesActionContext, close: () => void) => React.ReactNode;
  /// When set, this view only ever shows these item ids — same purpose as
  /// `AiFileSelectStep`'s prop of the same name: set by `FileBrowser` when
  /// it was opened straight into this tab from the "Daten manuell
  /// überprüfen" checkbox after an insert, so the list is exactly the
  /// batch just added, not the whole project with the new files somewhere
  /// among the rest.
  restrictToIds?: string[];
  /// Ids to mark the moment they've loaded — set when a timeline Ctrl-click
  /// selection was handed off via the floating "Ändern"-button/context-menu
  /// entry, alongside the caller also passing the same ids as
  /// `restrictToIds` (see `FileBrowser`'s `file_ops` render). Marked once
  /// per mount (see the effect below); also switches the grid's mark badge
  /// to the wrench glyph for the rest of this visit, since the whole point
  /// of being here is editing them, not a generic removal.
  autoMarkIds?: string[];
  /// Called after any action here actually changed project data (a batch
  /// action via `run`, or a date change saved through `ChangeDateDialog`) —
  /// separate from `reload`, which only refreshes this view's own list.
  /// The Timeline behind this overlay keeps its own `items` state and only
  /// re-fetches when told to (see `ProjectShell`'s `refreshToken`); without
  /// this, a date changed here stayed invisible on the Zeitstrahl until the
  /// whole browser was closed and reopened.
  onDataChanged?: () => void;
}

/// The shared body of "Datei-Operationen" and "Papierkorb": the year
/// navigation on the left, the project's files as the same tile grid the
/// rest of the file manager uses on the right, and whatever batch actions
/// the owning tab puts in the toolbar.
///
/// Both tabs are the same view over the same table, differing only in which
/// side of `items.removed_at` they read and in what their batch buttons do
/// — so they share everything except that, rather than being two
/// near-identical components that drift apart.
///
/// Thumbnails are the ones the project generated at import time, handed to
/// the grid as ready-made media-server URLs (`thumbnailUrls`). Nothing is
/// re-decoded: asking `get_file_preview` to regenerate previews for files
/// the project already has thumbnails for is precisely the cost that used
/// to make opening a stream slow.
export default function ProjectFilesView({
  trashed,
  emptyMessage,
  renderActions,
  renderContextActions,
  restrictToIds,
  autoMarkIds,
  onDataChanged,
}: Props) {
  const showToast = useToast();
  const { startOperation, finishOperation } = useProgress();
  const [allEntries, setAllEntries] = useState<ProjectFileEntry[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [selection, setSelection] = useState<YearSelection>(ALL_YEARS);
  const [range, setRange] = useState<DateRange>({ active: false, mode: "timeline", from: "", to: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [mediaServer, setMediaServer] = useState<MediaServerInfo | null>(null);
  // Bound to the input directly, so typing never stutters; `textQuery` only
  // catches up 300ms after the last keystroke and is what actually triggers
  // a reload — the content match happens in the backend (it needs
  // `extracted_text`, which never reaches the frontend) so every keystroke
  // would otherwise be its own round trip.
  const [textInput, setTextInput] = useState("");
  const [textQuery, setTextQuery] = useState("");

  // Marks are deliberately not persisted — see `useTransientCollection`.
  const marks = useTransientCollection();
  const selectionCheckboxRef = useRef<HTMLInputElement>(null);

  // One-shot: marks `autoMarkIds` the moment their entries have actually
  // loaded (allEntries starts empty while `reload` is still in flight). The
  // ref stops a second pass from re-adding paths the user has since
  // unmarked by hand — this view remounts fresh every time Datei-Operationen
  // is opened (see FileBrowser's `{activeTab === "file_ops" && …}`), so
  // there's no stale ref to reset between visits.
  const autoMarkedRef = useRef(false);
  useEffect(() => {
    if (autoMarkedRef.current || !autoMarkIds || autoMarkIds.length === 0 || allEntries.length === 0) return;
    const paths = allEntries.filter((entry) => autoMarkIds.includes(entry.id)).map((entry) => entry.path);
    if (paths.length === 0) return;
    marks.add(paths);
    autoMarkedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMarkIds, allEntries]);

  useEffect(() => {
    void loadMediaServerInfo().then(setMediaServer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setTextQuery(textInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [textInput]);

  /// The item's own local calendar year — parsed, not sliced off the
  /// string: `resolvedTimestamp` is RFC3339 carrying the item's own UTC
  /// offset, so text slicing would misfile a New Year's Eve photo. Mirrors
  /// what `list_project_years` does on the Rust side.
  const yearOf = (entry: ProjectFileEntry): number => new Date(entry.resolvedTimestamp).getFullYear();

  // The whole list is fetched once and narrowed in the frontend rather than
  // re-queried per year: a stream's item count is the scale the
  // timeline already holds in memory in full, and keeping it here makes the
  // year counts in the rail free instead of a query each.
  const initialYearApplied = useRef(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const text = textQuery || undefined;
      const [entries, yearList] = await Promise.all([
        invoke<ProjectFileEntry[]>("list_project_files", { trashed, text }),
        invoke<number[]>("list_project_years", { trashed, text }),
      ]);
      // Narrowed here, once, so every downstream derivation (year counts,
      // the year rail, "visible") already only ever sees the restricted
      // batch — same approach `AiFileSelectStep` takes for its own
      // `restrictToIds`. The year rail itself is derived from that
      // restricted set rather than trusting the unrestricted `yearList`.
      const restricted = restrictToIds ? entries.filter((entry) => restrictToIds.includes(entry.id)) : entries;
      setAllEntries(restricted);
      // Newest year first. The first load also starts on that year instead of
      // "Alle Jahre", so the grid doesn't have to lay out the whole project
      // up front. A restricted batch keeps "Alle Jahre" — it is exactly what
      // the user just handed over.
      const sortedYears = (restrictToIds ? Array.from(new Set(restricted.map(yearOf))) : [...yearList]).sort(
        (a, b) => b - a,
      );
      setYears(sortedYears);
      if (!initialYearApplied.current) {
        initialYearApplied.current = true;
        if (!restrictToIds && sortedYears.length > 0) setSelection(sortedYears[0]);
      }
    } catch (err) {
      showToast(String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashed, textQuery, restrictToIds]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The timeline mode takes whole days ("YYYY-MM-DD"), the insert mode
  // day plus time ("YYYY-MM-DDTHH:mm"). Switching converts the bounds, and
  // an empty bound starts as today (whole day), so the fields open filled
  // and the day block is the one ready to type into.
  function normalizeRange(next: DateRange): DateRange {
    if (!next.active) return { ...next, from: "", to: "" };
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (next.mode === "timeline") {
      return { ...next, from: next.from.slice(0, 10) || today, to: next.to.slice(0, 10) || today };
    }
    const bound = (value: string, fallbackTime: string) =>
      value.length === 10 ? `${value}T${fallbackTime}` : value || `${today}T${fallbackTime}`;
    return { ...next, from: bound(next.from, "00:00"), to: bound(next.to, "23:59") };
  }

  // An active range always shows real values: a bound that is empty (or in
  // the other mode's format) is seeded, never handed to the field as "".
  useEffect(() => {
    if (!range.active) return;
    const fixed = normalizeRange(range);
    if (fixed.from !== range.from || fixed.to !== range.to) setRange(fixed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  function setRangeActive(active: boolean) {
    setRange(normalizeRange({ ...range, active }));
  }

  const countByYear = useMemo(() => {
    const counts = new Map<number, number>();
    for (const entry of allEntries) {
      const year = yearOf(entry);
      counts.set(year, (counts.get(year) ?? 0) + 1);
    }
    return counts;
  }, [allEntries]);

  // The range and the year rail are alternatives, not layers: an active
  // range replaces the year selection rather than narrowing within it,
  // which is why the rail's buttons disable themselves while it is on.
  const visible = useMemo(() => {
    if (range.active) {
      if (range.mode === "added") {
        // An insert time is an instant, so the bounds carry the time of day
        // (local, "YYYY-MM-DDTHH:mm"); `to` is inclusive of its whole minute.
        const from = range.from ? new Date(range.from).getTime() : -Infinity;
        const to = range.to ? new Date(range.to).getTime() + 59_999 : Infinity;
        return allEntries.filter((entry) => {
          const at = entry.addedAt ? new Date(entry.addedAt).getTime() : NaN;
          return !Number.isNaN(at) && at >= from && at <= to;
        });
      }
      return allEntries.filter((entry) => {
        const day = entry.resolvedTimestamp.slice(0, 10);
        if (range.from && day < range.from) return false;
        if (range.to && day > range.to) return false;
        return true;
      });
    }
    if (selection === ALL_YEARS) return allEntries;
    return allEntries.filter((entry) => yearOf(entry) === selection);
  }, [allEntries, selection, range]);

  /// The grid speaks `DirEntryInfo` (the shape the folder browser uses), so
  /// project items are mapped onto it — the same approach the disk search
  /// tab takes with its hits. `can_add` is true because the grid's
  /// "addable?" checks are inert in remove mode anyway (see its
  /// `markMode`), and a false here would only grey tiles out for no reason.
  const gridEntries: DirEntryInfo[] = useMemo(
    () =>
      visible.map((entry) => ({
        name: entry.name,
        path: entry.path,
        is_dir: false,
        kind: entry.kind,
        can_add: true,
        size: entry.fileSizeBytes,
        fs_created_at: entry.fsCreatedAt,
        fs_modified_at: entry.fsModifiedAt,
        rotation: entry.rotation,
        resolved_timestamp: entry.resolvedTimestamp,
      })),
    [visible],
  );

  const thumbnailUrls = useMemo(() => {
    const map = new Map<string, string>();
    if (!mediaServer) return map;
    for (const entry of visible) {
      // A Papierkorb row whose file was deleted keeps no thumbnail either,
      // so it correctly falls back to its type icon.
      if (entry.thumbnailPath && entry.filePresent) {
        map.set(entry.path, fileUrl(mediaServer, entry.thumbnailPath));
      }
    }
    return map;
  }, [visible, mediaServer]);

  // The timeline date in the tile corner: the one piece of information that
  // makes a project file identifiable at a glance, and the reason to look
  // at this list at all.
  const badges = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of visible) {
      const label = formatDate(entry.resolvedTimestamp);
      if (label) map.set(entry.path, label);
    }
    return map;
  }, [visible]);

  // What the grid really shows after its own type chips: select-all, the
  // checkbox and every batch action stay within that, so a file hidden by
  // the "nur Bilder" filter can never be purged along with the shown ones.
  const [gridVisiblePaths, setGridVisiblePaths] = useState<Set<string> | null>(null);
  const onGridVisiblePathsChange = useCallback((paths: string[]) => setGridVisiblePaths(new Set(paths)), []);
  const shown = useMemo(
    () => (gridVisiblePaths ? visible.filter((entry) => gridVisiblePaths.has(entry.path)) : visible),
    [visible, gridVisiblePaths],
  );
  const marked = useMemo(() => shown.filter((entry) => marks.has(entry.path)), [shown, marks]);
  const markedBytes = useMemo(() => marked.reduce((sum, entry) => sum + (entry.fileSizeBytes ?? 0), 0), [marked]);

  // Paths the "Datum im Stream ändern" context-menu entry was just
  // invoked for — resolved against `visible` (which still has the `id`
  // every path needs) rather than carried as entries directly, since
  // `FileTileGrid` only ever hands back paths.
  const [changeDatePaths, setChangeDatePaths] = useState<string[] | null>(null);
  const changeDateEntries = useMemo(
    () => (changeDatePaths ? visible.filter((entry) => changeDatePaths.includes(entry.path)) : []),
    [changeDatePaths, visible],
  );

  // Replaces the former pair of "alle markieren" / "markierung aufheben"
  // text links with the usual select-all checkbox: unchecked → checked
  // marks everything visible, checked → unchecked clears, and a partial
  // selection shows as indeterminate (a native `checked` prop can't express
  // that, so it's set imperatively on the DOM node).
  useEffect(() => {
    if (selectionCheckboxRef.current) {
      selectionCheckboxRef.current.indeterminate = marked.length > 0 && marked.length < shown.length;
    }
  }, [marked.length, shown.length]);

  // Ctrl+A is the grid's own (see `FileTileGrid`): it knows which tiles its
  // type chips hide. A second handler here used to mark those hidden files
  // too, and both fired on the same keypress.

  const run = useCallback(
    async (
      action: (operationId: string) => Promise<number>,
      message: (count: number) => string,
      progress?: { label: string; total: number },
    ) => {
      // The toolbar dropdown is disabled while busy, the tile context menu
      // is not — so the guard lives here, where every batch passes through:
      // a second remove/move on the same files while a long move runs
      // would otherwise start alongside it.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const operationId = crypto.randomUUID();
      if (progress) startOperation({ id: operationId, label: progress.label, total: progress.total });
      try {
        const count = await action(operationId);
        const text = message(count);
        if (text) showToast(text);
        marks.clear();
        await reload();
        onDataChanged?.();
      } catch (err) {
        showToast(String(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (progress) finishOperation(operationId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reload, marks.clear, startOperation, finishOperation, onDataChanged],
  );

  const actionContext: ProjectFilesActionContext = {
    marked,
    visible,
    reload,
    busy,
    run,
    changeDate: (paths) => setChangeDatePaths(paths),
    markIds: (ids) => marks.add(allEntries.filter((entry) => ids.includes(entry.id)).map((entry) => entry.path)),
  };

  return (
    // Nested inside the browser's own `__main` column, which is exactly
    // what makes these tabs carry their own sidebar without the category
    // having to: `__main` is a flex column, so a `__body` row inside it
    // lays out this year rail and the grid the same way the outer one lays
    // out the folder tree and the grid. No CSS of its own needed.
    <div className="file-browser__body">
      <div className="file-browser__sidebar">
        <ProjectYearNav
          years={years}
          selected={selection}
          onSelect={setSelection}
          range={range}
          countByYear={countByYear}
          totalCount={allEntries.length}
        />
      </div>

      <div className="file-browser__main">
        <div className="file-browser__toolbar file-browser__filterbar">
          <input
            type="search"
            className="file-browser__text-filter"
            placeholder={t("fileOps.textFilterPlaceholder")}
            title={t("fileOps.textFilterHint")}
            value={textInput}
            onChange={(ev) => setTextInput(ev.target.value)}
          />
          {/* Explicit on/off switch: an empty native date input renders as
              today in this WebKitGTK version, so an untouched field would
              otherwise look like an active filter. */}
          <label className="file-browser__range-switch">
            <ToggleSwitch checked={range.active} onChange={setRangeActive} label={t("fileOps.rangeFilterLabel")} />
          </label>
          <div className="file-browser__kind-filter" role="group" aria-label={t("fileOps.rangeModeLabel")}>
            {(["timeline", "added"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!range.active}
                className={"file-browser__kind-chip" + (range.mode === mode ? " file-browser__kind-chip--on" : "")}
                style={{ textDecoration: "none" }}
                aria-pressed={range.mode === mode}
                onClick={() => setRange(normalizeRange({ ...range, mode }))}
              >
                {t(mode === "timeline" ? "fileOps.rangeModeTimeline" : "fileOps.rangeModeAdded")}
              </button>
            ))}
          </div>
          {(["from", "to"] as const).map((bound) => (
            <label key={bound} className="file-browser__range-field">
              <span>{t(bound === "from" ? "fileOps.rangeFrom" : "fileOps.rangeTo")}</span>
              {range.active ? (
                <SegmentedDateTimeInput
                  key={range.mode}
                  className="file-browser__range-input"
                  dateOnly={range.mode === "timeline"}
                  value={range[bound]}
                  autoFocus={bound === "from"}
                  onChange={(value) => setRange((prev) => ({ ...prev, [bound]: value }))}
                />
              ) : (
                <input
                  type="date"
                  value={range[bound]}
                  disabled={!range.active}
                  onChange={(ev) => setRange({ ...range, [bound]: ev.target.value })}
                />
              )}
            </label>
          ))}
        </div>
        <FileTileGrid
          markMode="remove"
          editIntent={Boolean(autoMarkIds && autoMarkIds.length > 0)}
          collection={marks}
          entries={gridEntries}
          addedPaths={EMPTY_PATHS}
          onRemoved={() => undefined}
          thumbnailUrls={thumbnailUrls}
          badges={badges}
          showKindFilter
          emptyMessage={loading ? t("fileOps.loading") : emptyMessage}
          toolbarLeft={
            <>
              <label className="file-browser__selection-summary" title={t("fileOps.selectionCheckboxHint")}>
                <input
                  ref={selectionCheckboxRef}
                  type="checkbox"
                  checked={shown.length > 0 && marked.length === shown.length}
                  disabled={busy || shown.length === 0}
                  onChange={() =>
                    marked.length > 0 ? marks.clear() : marks.add(shown.map((entry) => entry.path))
                  }
                />
                <span>{`${tCount(marked.length, "fileOps.fileSelected", "fileOps.filesSelected")}${marked.length > 0 ? ` · ${formatBytes(markedBytes)}` : ""}`}</span>
              </label>
            </>
          }
          toolbarRight={renderActions(actionContext)}
          onVisiblePathsChange={onGridVisiblePathsChange}
          onChangeDate={setChangeDatePaths}
          renderContextActions={
            renderContextActions
              ? (paths, close) =>
                  renderContextActions(
                    { ...actionContext, marked: shown.filter((entry) => paths.includes(entry.path)) },
                    close,
                  )
              : undefined
          }
        />
      </div>

      {changeDatePaths && (
        <ChangeDateDialog
          entries={changeDateEntries}
          thumbnailUrls={thumbnailUrls}
          onCancel={() => setChangeDatePaths(null)}
          onSaved={() => {
            setChangeDatePaths(null);
            void reload();
            onDataChanged?.();
          }}
        />
      )}
    </div>
  );
}

/// The grid's `addedPaths` is about the import flow, which these tabs have
/// no part in — a stable empty set, so it never looks like changing state.
const EMPTY_PATHS: Set<string> = new Set();
