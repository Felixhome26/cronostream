import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import { listen } from "@tauri-apps/api/event";
import { t, tn } from "../../i18n";
import { useToast } from "../../ToastContext";
import type {
  DiskSearchDonePayload,
  DiskSearchDateField,
  DiskSearchHit,
  DiskSearchIndexMode,
  DiskSearchParamsInput,
  DiskSearchProgressPayload,
  DirEntryInfo,
  FileKind,
} from "../../types";
import HelpHint from "./HelpHint";
import ToggleSwitch from "./ToggleSwitch";
import FileTileGrid from "./FileTileGrid";
import type { PathCollection } from "../../hooks/useCollection";
import { SearchHistoryField, useSearchHistory } from "../SearchHistory";
import { formatDay } from "../../utils/phases";

const ALL_KINDS: FileKind[] = ["image", "video", "audio", "document", "email", "other"];

const KIND_ICON: Record<FileKind, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎧",
  document: "📄",
  email: "✉️",
  other: "❓",
};

function formatEta(seconds: number | null): string | null {
  if (seconds == null) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}min ${total % 60}s`;
}

type SizeUnit = "kb" | "mb" | "gb";

const SIZE_UNIT_BYTES: Record<SizeUnit, number> = {
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

function sizeToBytes(value: string, unit: SizeUnit): number | null {
  const parsed = parseFloat(value);
  if (!value.trim() || Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * SIZE_UNIT_BYTES[unit]);
}

/// One disk search as the app-wide history keeps it: the folder and every
/// filter, so taking an entry repeats exactly that search. Key order is
/// fixed and `kinds` follows `ALL_KINDS`' order (see `useSearchHistory`'s
/// `record`). "Aus dem Index laden" is left out on purpose — whether an
/// index exists is a fact about the folder now, not about the old search.
interface DiskSearch {
  q: string;
  root: string;
  sub: boolean;
  kinds: FileKind[];
  dateField: DiskSearchDateField;
  from: string;
  to: string;
  sizeMin: string;
  sizeMax: string;
  sizeUnit: SizeUnit;
  dedupe: boolean;
  hideInProject: boolean;
  verify: boolean;
}

function parseDiskSearch(raw: unknown): DiskSearch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string";
  const bool = (v: unknown) => typeof v === "boolean";
  if (
    !str(r.q) || !str(r.root) || !bool(r.sub) || !Array.isArray(r.kinds) ||
    (r.dateField !== "modified" && r.dateField !== "created") ||
    !str(r.from) || !str(r.to) || !str(r.sizeMin) || !str(r.sizeMax) ||
    (r.sizeUnit !== "kb" && r.sizeUnit !== "mb" && r.sizeUnit !== "gb") ||
    !bool(r.dedupe) || !bool(r.hideInProject) || !bool(r.verify)
  ) {
    return null;
  }
  const kinds = ALL_KINDS.filter((k) => (r.kinds as unknown[]).includes(k));
  return {
    q: r.q as string,
    root: r.root as string,
    sub: r.sub as boolean,
    kinds,
    dateField: r.dateField as DiskSearchDateField,
    from: r.from as string,
    to: r.to as string,
    sizeMin: r.sizeMin as string,
    sizeMax: r.sizeMax as string,
    sizeUnit: r.sizeUnit as SizeUnit,
    dedupe: r.dedupe as boolean,
    hideInProject: r.hideInProject as boolean,
    verify: r.verify as boolean,
  };
}

/// The dimmed line after the search text: the folder's name, then only the
/// filters that differ from a fresh tab.
function diskSearchDetail(s: DiskSearch): string {
  const sep = Math.max(s.root.lastIndexOf("/"), s.root.lastIndexOf("\\"));
  const folder = sep >= 0 && sep < s.root.length - 1 ? s.root.slice(sep + 1) : s.root;
  const parts = [`📁 ${folder}`];
  if (s.kinds.length !== ALL_KINDS.length) parts.push(s.kinds.map((k) => KIND_ICON[k]).join(""));
  if (s.from !== "" || s.to !== "") {
    const range: string[] = [];
    if (s.from !== "") range.push(`${t("diskSearch.dateFrom")} ${formatDay(s.from)}`);
    if (s.to !== "") range.push(`${t("diskSearch.dateTo")} ${formatDay(s.to)}`);
    parts.push(range.join(" "));
  }
  if (s.sizeMin.trim() !== "" || s.sizeMax.trim() !== "") {
    parts.push(`${s.sizeMin.trim() || "0"}–${s.sizeMax.trim() || "∞"} ${s.sizeUnit.toUpperCase()}`);
  }
  return parts.join(" · ");
}

interface Props {
  collection: PathCollection;
  /// Opens a folder in the shared folder tree — used when a history entry
  /// from another folder is taken, so the search runs where it ran before.
  onNavigate?: (path: string) => void;
  onRevealInFolder?: (path: string) => void;
  /// The folder currently selected in the shared folder tree/path field —
  /// becomes the search root automatically (no separate picker): the tree
  /// is already right there in the sidebar for every "Hinzufügen" tab.
  currentPath: string | null;
  addedPaths: Set<string>;
  onRemoved: (removedPaths: string[], message: string) => void;
  deleteFilesOnRemove?: boolean;
}

/// Festplattenweite Dateisuche: sucht rekursiv ab `currentPath` (nicht nur
/// im Projekt), mit Filtern (Zeitraum/Typ/Größe/Unterordnern) und
/// Dubletten-Abgleich gegen das Projekt. Läuft komplett über `search_disk`
/// im Hintergrund (s. `disk_search.rs`) — diese Komponente spiegelt nur
/// Fortschritt/Ergebnis und zeigt Treffer in derselben Kachelansicht wie
/// die Übersicht (`FileTileGrid`).
export default function DiskSearchTab({
  collection,
  currentPath,
  addedPaths,
  onRemoved,
  onRevealInFolder,
  deleteFilesOnRemove,
  onNavigate,
}: Props) {
  const showToast = useToast();
  const history = useSearchHistory<DiskSearch>("disk", parseDiskSearch);
  /// Set when a history entry was taken: the folder the search has to run
  /// in. The effect further down starts it once that folder is the current
  /// one and the restored filters have rendered.
  const [pendingRunRoot, setPendingRunRoot] = useState<string | null>(null);

  // Collapsed automatically once a search starts — with the filter panel's
  // own height, there'd otherwise be no room left to actually see the
  // results/preview without scrolling past it every time. Still manually
  // re-expandable via the toggle next to the path.
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  // All checked by default — matches the backend's own "empty = every
  // kind" default, so the search finds files of every type until the user
  // actively narrows it down by unchecking some.
  const [kinds, setKinds] = useState<Set<FileKind>>(new Set(ALL_KINDS));
  const [searchTerm, setSearchTerm] = useState("");
  const [dateField, setDateField] = useState<DiskSearchDateField>("modified");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Separate from whether `dateFrom`/`dateTo` are actually filled in — an
  // empty native date input renders as today's date in this webview, which
  // made it look (and, worse, actually act) like an active filter even
  // when nothing was picked. Same fix as the timeline's own search bar:
  // disable the fields and force them blank whenever this is off, and only
  // ever send dates to the backend while it's on.
  const [dateRangeActive, setDateRangeActive] = useState(false);
  const [sizeMin, setSizeMin] = useState("");
  const [sizeMax, setSizeMax] = useState("");
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>("mb");
  // Both drive their whole comparison, not just whether matches are hidden
  // afterward — off skips the size/hash comparison entirely (see
  // `disk_search.rs`'s `dedupe_within_results`/`hide_already_in_project`).
  // Unrelated to each other: one compares hits against each other, the
  // other against the project.
  const [dedupeWithinResults, setDedupeWithinResults] = useState(false);
  const [hideAlreadyInProject, setHideAlreadyInProject] = useState(false);
  const [verifyDuplicateContent, setVerifyDuplicateContent] = useState(false);

  // Whether `currentPath` has ever been indexed before — drives whether
  // "Aus dem Index laden" can be switched on at all. Re-checked whenever
  // the folder changes, and set to true immediately after a search that
  // actually completes (it leaves an index behind either way, see
  // `get_or_build_index`), so the toggle becomes available right after the
  // very first search without waiting on a fresh folder-change check.
  const [indexExists, setIndexExists] = useState(false);
  const [useCache, setUseCache] = useState(false);

  const [taskId, setTaskId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<DiskSearchProgressPayload | null>(null);
  const [hits, setHits] = useState<DiskSearchHit[] | null>(null);
  const [withinResultsDuplicatesRemoved, setWithinResultsDuplicatesRemoved] = useState(0);
  const [alreadyInProjectHidden, setAlreadyInProjectHidden] = useState(0);

  useEffect(() => {
    if (!currentPath) {
      setIndexExists(false);
      setUseCache(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("has_disk_search_index", { rootPath: currentPath })
      .then((exists) => {
        if (cancelled) return;
        setIndexExists(exists);
        if (!exists) setUseCache(false);
      })
      .catch(() => {
        if (!cancelled) {
          setIndexExists(false);
          setUseCache(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Holds the active search's unlisten functions so they can be torn down
  // either when its done-event arrives or when the component unmounts
  // mid-search — kept in refs rather than effect-local closures because
  // they must survive across the `runSearch`/listener lifetime, which is
  // not tied to a single render.
  const unlistenProgressRef = useRef<(() => void) | null>(null);
  const unlistenDoneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      unlistenProgressRef.current?.();
      unlistenDoneRef.current?.();
    };
  }, []);

  function toggleKind(kind: FileKind) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleDateRangeActive(active: boolean) {
    setDateRangeActive(active);
    if (!active) {
      setDateFrom("");
      setDateTo("");
    }
  }

  function applyHistory(entry: DiskSearch) {
    setSearchTerm(entry.q);
    setIncludeSubfolders(entry.sub);
    setKinds(new Set(entry.kinds));
    setDateField(entry.dateField);
    setDateFrom(entry.from);
    setDateTo(entry.to);
    setDateRangeActive(entry.from !== "" || entry.to !== "");
    setSizeMin(entry.sizeMin);
    setSizeMax(entry.sizeMax);
    setSizeUnit(entry.sizeUnit);
    setDedupeWithinResults(entry.dedupe);
    setHideAlreadyInProject(entry.hideInProject);
    setVerifyDuplicateContent(entry.verify);
    setPendingRunRoot(entry.root);
    if (entry.root !== currentPath) onNavigate?.(entry.root);
  }

  useEffect(() => {
    if (pendingRunRoot === null || searching) return;
    if (currentPath !== pendingRunRoot) return;
    setPendingRunRoot(null);
    void runSearch();
    // runSearch is a plain function of this render; it is meant to run with
    // exactly the state the restored entry just put in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRunRoot, currentPath, searching]);

  // A different folder than the one an entry asked for (the folder no longer
  // opens, or the user went elsewhere first) drops the pending run, so it
  // can never start later by surprise.
  const lastPathRef = useRef(currentPath);
  useEffect(() => {
    if (lastPathRef.current === currentPath) return;
    lastPathRef.current = currentPath;
    if (pendingRunRoot !== null && currentPath !== pendingRunRoot) setPendingRunRoot(null);
  }, [currentPath, pendingRunRoot]);

  async function runSearch() {
    if (!currentPath || searching) return;
    setFiltersCollapsed(true);
    history.record({
      q: searchTerm.trim(),
      root: currentPath,
      sub: includeSubfolders,
      kinds: ALL_KINDS.filter((k) => kinds.has(k)),
      dateField,
      from: dateRangeActive ? dateFrom : "",
      to: dateRangeActive ? dateTo : "",
      sizeMin: sizeMin.trim(),
      sizeMax: sizeMax.trim(),
      sizeUnit,
      dedupe: dedupeWithinResults,
      hideInProject: hideAlreadyInProject,
      verify: verifyDuplicateContent,
    });
    const indexMode: DiskSearchIndexMode = useCache && indexExists ? "use_cache" : "reindex";
    const params: DiskSearchParamsInput = {
      rootPath: currentPath,
      includeSubfolders,
      kinds: Array.from(kinds),
      nameContains: searchTerm.trim() || null,
      dateField,
      dateFrom: dateRangeActive ? dateFrom || null : null,
      dateTo: dateRangeActive ? dateTo || null : null,
      sizeMin: sizeToBytes(sizeMin, sizeUnit),
      sizeMax: sizeToBytes(sizeMax, sizeUnit),
      dedupeWithinResults,
      hideAlreadyInProject,
      verifyDuplicateContent,
      indexMode,
    };

    // Generated here, not read back from the command's return value: a
    // small folder can finish (and emit disk-search-done) within
    // milliseconds, and subscribing only *after* learning the id from an
    // awaited invoke() would risk missing that event entirely, leaving the
    // UI stuck in "searching" forever — confirmed 2026-10-13 with a
    // 117-file folder. Subscribing first guarantees nothing can be missed.
    const newTaskId = crypto.randomUUID();
    setSearching(true);
    setProgress(null);
    setHits(null);
    setWithinResultsDuplicatesRemoved(0);
    setAlreadyInProjectHidden(0);
    setTaskId(newTaskId);

    unlistenProgressRef.current = await listen<DiskSearchProgressPayload>("disk-search-progress", (event) => {
      if (event.payload.task_id !== newTaskId) return;
      setProgress(event.payload);
    });
    unlistenDoneRef.current = await listen<DiskSearchDonePayload>("disk-search-done", (event) => {
      if (event.payload.task_id !== newTaskId) return;
      unlistenProgressRef.current?.();
      unlistenDoneRef.current?.();
      unlistenProgressRef.current = null;
      unlistenDoneRef.current = null;
      setSearching(false);
      setTaskId(null);
      setProgress(null);
      setHits(event.payload.hits);
      setWithinResultsDuplicatesRemoved(event.payload.within_results_duplicates_removed);
      setAlreadyInProjectHidden(event.payload.already_in_project_hidden);
      if (event.payload.error) {
        showToast(`${t("diskSearch.errorToastPrefix")} ${event.payload.error}`);
      } else if (event.payload.cancelled) {
        showToast(t("diskSearch.cancelledToast"));
      } else {
        showToast(tn(event.payload.hits.length, "diskSearch.doneToastSuffix"));
        // A completed, non-cancelled search always leaves an index behind
        // for this root — either it already existed (cache hit) or the
        // walk just built and saved one — so the toggle becomes available
        // immediately, without waiting on the folder-change check.
        setIndexExists(true);
      }
    });

    try {
      await invoke("search_disk", { taskId: newTaskId, params });
    } catch (e) {
      unlistenProgressRef.current?.();
      unlistenDoneRef.current?.();
      unlistenProgressRef.current = null;
      unlistenDoneRef.current = null;
      setSearching(false);
      setTaskId(null);
      showToast(`${t("diskSearch.errorToastPrefix")} ${String(e)}`);
    }
  }

  async function cancelSearch() {
    if (!taskId) return;
    try {
      await invoke("cancel_disk_search", { taskId });
    } catch {
      // ignore — the running task reports its own outcome via disk-search-done
    }
  }

  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const etaText = formatEta(progress?.estimated_seconds_remaining ?? null);
  const phaseLabel =
    progress?.phase === "counting"
      ? t("diskSearch.phaseCounting")
      : progress?.phase === "deduping_results"
        ? t("diskSearch.phaseDedupingResults")
        : progress?.phase === "checking_against_project"
          ? t("diskSearch.phaseCheckingAgainstProject")
          : t("diskSearch.phaseScanning");
  // During "counting" there's no total yet (that's what it's finding out —
  // see `disk_search::count_entries`), so it's shown as a running count
  // instead of "done/total"; the ETA is always empty here too, since
  // `estimated_seconds_remaining` needs a total to project from.
  const progressText = searching
    ? `${phaseLabel}${
        progress
          ? progress.phase === "counting"
            ? `: ${tn(progress.done, "diskSearch.countingFoundSuffix")}`
            : `: ${progress.current_action} (${progress.done}/${progress.total})`
          : "…"
      }${etaText ? ` — ${t("diskSearch.etaSuffix")} ${etaText}` : ""}`
    : null;
  const hiddenParts = [
    withinResultsDuplicatesRemoved > 0 ? tn(withinResultsDuplicatesRemoved, "diskSearch.duplicatesRemovedSuffix") : null,
    alreadyInProjectHidden > 0 ? tn(alreadyInProjectHidden, "diskSearch.alreadyInProjectHiddenSuffix") : null,
  ].filter((part): part is string => part !== null);
  const resultsText = hits
    ? `${tn(hits.length, "diskSearch.resultsCount")}${hiddenParts.length > 0 ? ` (${hiddenParts.join(", ")})` : ""}`
    : null;

  // `FileTileGrid` expects the same shape the folder browser already
  // speaks (`DirEntryInfo`) — search hits are always files, and "can this
  // be added" is left to `add_items` itself to decide (it already reports
  // a skip reason per file), so every hit is offered as addable here.
  // Duplicates never arrive here in the first place when `hideDuplicates`
  // was on — the backend removes them before this event is even sent.
  const gridEntries: DirEntryInfo[] = useMemo(
    () =>
      (hits ?? []).map((hit) => ({
        name: hit.name,
        path: hit.path,
        is_dir: false,
        kind: hit.kind,
        can_add: true,
        size: hit.size,
        fs_created_at: hit.fs_created_at,
        fs_modified_at: hit.fs_modified_at,
        rotation: 0,
      })),
    [hits],
  );

  // One `FileTileGrid` instance for the whole component, outside the
  // collapsed/expanded split below — remounting it every time the filter
  // panel toggles would throw away its selection and already-fetched
  // thumbnails for no reason (same reasoning as the folder-browsing grid
  // tab staying permanently mounted across tab switches).
  return (
    <>
      {filtersCollapsed ? (
        <div className="disk-search__collapsed-bar">
          <span className="disk-search__collapsed-text">{progressText ?? resultsText ?? ""}</span>
          <div className="disk-search__collapsed-actions">
            {searching && (
              <button className="btn btn--danger" onClick={cancelSearch}>
                {t("diskSearch.cancelButton")}
              </button>
            )}
            <button type="button" className="btn--text" onClick={() => setFiltersCollapsed(false)}>
              {`▾ ${t("diskSearch.expandFilters")}`}
            </button>
          </div>
        </div>
      ) : (
      <div className="disk-search">
        <div className="disk-search__root">
          <div className="disk-search__root-path" title={currentPath ?? undefined}>
            {currentPath ?? t("diskSearch.noFolderChosen")}
          </div>
          <button type="button" className="btn--text" onClick={() => setFiltersCollapsed(true)}>
            {`▴ ${t("diskSearch.collapseFilters")}`}
          </button>
        </div>

        <form
          className="disk-search__filters"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <div className="disk-search__row">
            <label>{t("diskSearch.searchTermLabel")}</label>
            <SearchHistoryField
              entries={history.entries}
              query={searchTerm}
              textOf={(e) => e.q}
              detailOf={diskSearchDetail}
              onPick={applyHistory}
              onRemove={history.remove}
              onClear={history.clear}
              renderInput={(h) => (
                <input
                  type="text"
                  className="text-input disk-search__search-term-input"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onClick={h.onClick}
                  onBlur={h.onBlur}
                  // A key the list used (Enter on a highlighted entry) must
                  // not also submit the form.
                  onKeyDown={(e) => {
                    h.onKeyDown(e);
                  }}
                  placeholder={t("diskSearch.searchTermPlaceholder")}
                />
              )}
            />
            <HelpHint text={t("diskSearch.searchTermHint")} />
          </div>

          <div className="disk-search__row disk-search__duplicate-row">
            <ToggleSwitch checked={includeSubfolders} onChange={setIncludeSubfolders} label={t("diskSearch.includeSubfolders")} />
            <HelpHint text={t("diskSearch.includeSubfoldersHint")} />
          </div>

          <fieldset className="disk-search__fieldset">
            <legend>
              {t("diskSearch.kindsLabel")} <HelpHint text={t("diskSearch.kindsHint")} />
            </legend>
            <div className="disk-search__kinds">
              {ALL_KINDS.map((kind) => (
                <label key={kind} className="disk-search__checkbox-label">
                  <input type="checkbox" checked={kinds.has(kind)} onChange={() => toggleKind(kind)} />
                  {KIND_ICON[kind]} {t(`diskSearch.kind.${kind}`)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="disk-search__row">
            <ToggleSwitch checked={dateRangeActive} onChange={toggleDateRangeActive} label={t("diskSearch.dateRangeActiveLabel")} />
            <label>
              {t("diskSearch.dateFieldLabel")} <HelpHint text={t("diskSearch.dateFieldHint")} />
            </label>
            <select
              value={dateField}
              onChange={(e) => setDateField(e.target.value as DiskSearchDateField)}
              disabled={!dateRangeActive}
            >
              <option value="modified">{t("diskSearch.dateFieldModified")}</option>
              <option value="created">{t("diskSearch.dateFieldCreated")}</option>
            </select>
            <label>{t("diskSearch.dateFrom")}</label>
            <input type="date" value={dateFrom} disabled={!dateRangeActive} onChange={(e) => setDateFrom(e.target.value)} />
            <label>{t("diskSearch.dateTo")}</label>
            <input type="date" value={dateTo} disabled={!dateRangeActive} onChange={(e) => setDateTo(e.target.value)} />
          </div>

          <div className="disk-search__row">
            <label>
              {t("diskSearch.sizeLabel")} <HelpHint text={t("diskSearch.sizeHint")} />
            </label>
            <label>{t("diskSearch.sizeMin")}</label>
            <input
              type="number"
              min={0}
              value={sizeMin}
              onChange={(e) => setSizeMin(e.target.value)}
              className="disk-search__size-input"
            />
            <label>{t("diskSearch.sizeMax")}</label>
            <input
              type="number"
              min={0}
              value={sizeMax}
              onChange={(e) => setSizeMax(e.target.value)}
              className="disk-search__size-input"
            />
            <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as SizeUnit)}>
              <option value="kb">KB</option>
              <option value="mb">MB</option>
              <option value="gb">GB</option>
            </select>
          </div>

          <div className="disk-search__row disk-search__duplicate-row">
            <ToggleSwitch checked={dedupeWithinResults} onChange={setDedupeWithinResults} label={t("diskSearch.hideDuplicates")} />
            <HelpHint text={t("diskSearch.hideDuplicatesHint")} />
          </div>

          <div className="disk-search__row disk-search__duplicate-row">
            <ToggleSwitch
              checked={hideAlreadyInProject}
              onChange={setHideAlreadyInProject}
              label={t("browser.hideAlreadyInProjectLabel")}
            />
            <HelpHint text={t("browser.hideAlreadyInProjectHint")} />
          </div>

          <div className="disk-search__row disk-search__duplicate-row">
            <span className="disk-search__content-check-label">
              {t("diskSearch.contentCheckLabel")}
              <HelpHint text={t("diskSearch.contentCheckHint")} />
            </span>
            <ToggleSwitch
              checked={verifyDuplicateContent}
              onChange={setVerifyDuplicateContent}
              disabled={!dedupeWithinResults && !hideAlreadyInProject}
              label={verifyDuplicateContent ? t("diskSearch.contentCheckThorough") : t("diskSearch.contentCheckFast")}
            />
          </div>

          <div className="disk-search__actions">
            <button type="submit" className="btn btn--primary" disabled={!currentPath || searching}>
              {t("diskSearch.searchButton")}
            </button>
            <ToggleSwitch
              checked={useCache}
              onChange={setUseCache}
              disabled={!indexExists}
              label={t("diskSearch.useCacheToggleLabel")}
            />
            <HelpHint text={t("diskSearch.useCacheHint")} />
            {searching && (
              <button type="button" className="btn btn--danger" onClick={cancelSearch}>
                {t("diskSearch.cancelButton")}
              </button>
            )}
          </div>
        </form>

        {searching && (
          <div className="disk-search__progress">
            <div className="progress-bar">
              <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="progress-bar__status">{progressText}</p>
          </div>
        )}

        {resultsText && (
          <div className="disk-search__results-header">
            <span>{resultsText}</span>
          </div>
        )}
      </div>
      )}

      {hits && (
        <FileTileGrid
          collection={collection}
          onRevealInFolder={onRevealInFolder}
          entries={gridEntries}
          addedPaths={addedPaths}
          onRemoved={onRemoved}
          deleteFilesOnRemove={deleteFilesOnRemove}
          emptyMessage={t("diskSearch.noResults")}
        />
      )}
    </>
  );
}
