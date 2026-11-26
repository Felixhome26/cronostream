import { useEffect, useMemo, useRef, useState } from "react";
import { t, timestampSourceLabel } from "../../i18n";
import { listItems } from "../../types";
import type { ItemInfo } from "../../types";
import { mediaUrl } from "../../utils/mediaServer";
import { toDateOnlyValue } from "../../utils/datetime";
import { isInRange, isRangeInvalid, rangeForPreset, type RangePreset } from "../../utils/printRange";
import { formatDateTime } from "../../utils/datetime";
import { runBusy } from "../../busy";
import WarningHint from "./WarningHint";
import HelpHint from "./HelpHint";

type SortKey = "date" | "name" | "source";
type DateField = "resolved_timestamp" | "fs_created_at" | "fs_modified_at";

// `fs_created`/`fs_modified` mean the automatic priority chain had no
// embedded metadata to go on — exactly the files where an AI looking at
// filename/folder patterns can actually add value. `exif`/`manual`/`ai`
// already have a trustworthy or human-confirmed date.
export const UNCERTAIN_SOURCES = new Set(["fs_created", "fs_modified"]);

function displayName(item: ItemInfo): string {
  return item.display_name ?? item.original_filename;
}

function fieldValue(item: ItemInfo, field: DateField): string | null {
  return item[field];
}

function formatDate(iso: string | null): string {
  return formatDateTime(iso) ?? "–";
}

interface Props {
  /// When set, this step only ever shows (and preselects) these item ids —
  /// set by `FileBrowser` when it was opened straight into this tab from the
  /// drop box's "Daten direkt mit KI checken" button, so the list is exactly
  /// the batch just dropped in, not the whole project with some items ticked
  /// for the user to find among the rest.
  restrictToIds?: string[];
  /// Called with the selected item ids once the user presses "Weiter".
  onNext: (ids: string[]) => void;
}

/// Step 1 of the AI date-correction wizard: picks which project items go
/// into the next step's export — same filter/sort/select mechanics as the
/// print-export tab (date range incl. custom, text filter, sort, select-all
/// with a count of ticks hidden by the current filter), plus two things
/// print export doesn't need: a choice of *which* date field the range
/// filters on (the timeline date, or either filesystem date — useful here
/// since this workflow exists specifically for items whose filesystem dates
/// are suspect), and the "unsichere Daten" scope filter.
export default function AiFileSelectStep({ restrictToIds, onNext }: Props) {
  const [items, setItems] = useState<ItemInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const preselectApplied = useRef(false);
  // A restricted scope is already exactly the batch the user wants checked —
  // filtering it down further by "uncertain" would just be a surprising
  // extra reason for rows to silently not show up in a list the user was
  // told contains the files they just dropped in.
  const [onlyUncertain, setOnlyUncertain] = useState(false);
  // Files whose date already came from a previous AI round (`timestamp_source`
  // = 'ai'). Applies to every way into this step, including the restricted
  // hand-over from other areas — hence off by default, but always available.
  const [hideAiDated, setHideAiDated] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [dateField, setDateField] = useState<DateField>("resolved_timestamp");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [ascending, setAscending] = useState(true);
  // "Alle" from the start: the files that need an AI's help are mostly old
  // ones, and "Letzter Monat" of their date in CronoStream hid exactly the
  // freshly imported photos from years ago.
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customActive, setCustomActive] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    runBusy(() => listItems())
      .then((all) => {
        // Restricting at fetch time, rather than filtering `items` on every
        // render, keeps every other piece of this step (sorting, year list,
        // the uncertain-count badge, …) unaware it's ever scoped — they just
        // see a smaller `items` array, as if that's all there was.
        setItems(restrictToIds ? all.filter((i) => restrictToIds.includes(i.id)) : all);
      })
      .finally(() => setLoading(false));
  }, [restrictToIds]);

  // Runs once, the first time the list has something to select from — not
  // tied to `restrictToIds` itself, so a later unrelated re-render of this
  // step never fights back against the user's own selection changes.
  // A restricted scope preselects everything in it (the user asked to check
  // this exact batch, so it should be ready to proceed immediately);
  // otherwise selection starts empty as before.
  useEffect(() => {
    if (preselectApplied.current || !restrictToIds || restrictToIds.length === 0 || items.length === 0) return;
    preselectApplied.current = true;
    setSelected(new Set(items.map((i) => i.id)));
  }, [items, restrictToIds]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sorted = useMemo(() => {
    const direction = ascending ? 1 : -1;
    const compare = (a: ItemInfo, b: ItemInfo): number => {
      switch (sortKey) {
        case "name":
          return displayName(a).localeCompare(displayName(b));
        case "source":
          return a.timestamp_source.localeCompare(b.timestamp_source);
        case "date":
        default:
          return a.resolved_timestamp.localeCompare(b.resolved_timestamp);
      }
    };
    return [...items].sort((a, b) => {
      const primary = compare(a, b) * direction;
      return primary !== 0 ? primary : a.resolved_timestamp.localeCompare(b.resolved_timestamp);
    });
  }, [items, sortKey, ascending]);

  // Every year the chosen date field actually holds, newest first.
  const years = useMemo(() => {
    const found = new Set<string>();
    for (const item of items) {
      const value = fieldValue(item, dateField);
      if (value) found.add(toDateOnlyValue(value).slice(0, 4));
    }
    return [...found].sort().reverse();
  }, [items, dateField]);

  const range = useMemo(
    () => (customActive ? { from: rangeFrom, to: rangeTo } : rangeForPreset(preset)),
    [customActive, rangeFrom, rangeTo, preset],
  );
  const rangeInvalid = isRangeInvalid(range);
  const rangeActive = range.from !== "" || range.to !== "";

  // The badge counts follow the chosen period, not the whole project.
  const inRange = useMemo(() => {
    if (rangeInvalid) return [];
    if (!rangeActive) return items;
    return items.filter((item) => {
      const value = fieldValue(item, dateField);
      return value !== null && isInRange(value, range);
    });
  }, [items, dateField, range, rangeActive, rangeInvalid]);

  const uncertainCount = useMemo(() => inRange.filter((i) => UNCERTAIN_SOURCES.has(i.timestamp_source)).length, [inRange]);

  const aiDatedCount = useMemo(() => inRange.filter((i) => i.timestamp_source === "ai").length, [inRange]);

  function toggleCustom(active: boolean) {
    if (active && rangeFrom === "" && rangeTo === "") {
      const { from, to } = rangeForPreset(preset);
      setRangeFrom(from);
      setRangeTo(to);
    }
    setCustomActive(active);
  }

  const filtered = useMemo(() => {
    if (rangeInvalid) return [];
    const needle = filterText.trim().toLowerCase();
    return sorted.filter((item) => {
      if (hideAiDated && item.timestamp_source === "ai") return false;
      if (onlyUncertain && !UNCERTAIN_SOURCES.has(item.timestamp_source)) return false;
      if (needle && !displayName(item).toLowerCase().includes(needle) && !item.original_filename.toLowerCase().includes(needle)) {
        return false;
      }
      if (rangeActive) {
        const value = fieldValue(item, dateField);
        if (!value) return false;
        if (!isInRange(value, range)) return false;
      }
      return true;
    });
  }, [sorted, hideAiDated, onlyUncertain, filterText, dateField, range, rangeActive, rangeInvalid]);

  // Only rows currently listed need a thumbnail URL — resolving them for
  // the whole project would stall a large one.
  useEffect(() => {
    let cancelled = false;
    const missing = filtered.filter((i) => i.thumbnail_path && !thumbUrls[i.id]);
    if (missing.length === 0) return;
    runBusy(() => Promise.all(missing.map(async (item) => [item.id, await mediaUrl(item.thumbnail_path as string)] as const))).then(
      (pairs) => {
        if (cancelled) return;
        setThumbUrls((prev) => {
          const next = { ...prev };
          for (const [id, url] of pairs) next[id] = url;
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [filtered, thumbUrls]);

  const visibleSelectedCount = filtered.filter((i) => selected.has(i.id)).length;
  const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
  const hiddenSelectedCount = selected.size - visibleSelectedCount;

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((i) => next.delete(i.id));
      else filtered.forEach((i) => next.add(i.id));
      return next;
    });
  }

  function handleNext() {
    const ids = filtered.filter((i) => selected.has(i.id)).map((i) => i.id);
    if (ids.length === 0) return;
    onNext(ids);
  }

  if (loading) {
    return <div className="ai-metadata">{t("browser.singleView.loading")}</div>;
  }

  return (
    <div className="ai-metadata__panel">
      <h2>{t("browser.aiMetadata.selectFilesTitle")}</h2>
      <p className="ai-metadata__instructions">
        {t("browser.aiMetadata.exportInstructions")}
        <WarningHint text={t("browser.aiMetadata.exportPrivacyWarning")} />
      </p>

      <div className="print-export__range">
        <div className="print-export__range-row">
          <label className="print-export__range-field">
            {t("browser.printExport.rangeLabel")}
            <select value={preset} onChange={(e) => setPreset(e.target.value as RangePreset)} disabled={customActive}>
              <option value="all">{t("browser.printExport.rangeAll")}</option>
              <option value="last1">{t("browser.printExport.rangeLast1")}</option>
              <option value="last3">{t("browser.printExport.rangeLast3")}</option>
              <option value="last6">{t("browser.printExport.rangeLast6")}</option>
              <option value="last12">{t("browser.printExport.rangeLast12")}</option>
              {years.length > 0 && (
                <optgroup label={t("browser.printExport.rangeYearsHeading")}>
                  {years.map((year) => (
                    <option key={year} value={`year:${year}`}>
                      {year}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <label className="print-export__range-field">
            {t("browser.aiMetadata.dateFieldLabel")}
            <select value={dateField} onChange={(e) => setDateField(e.target.value as DateField)}>
              <option value="resolved_timestamp">{t("browser.aiMetadata.dateFieldResolved")}</option>
              <option value="fs_created_at">{t("browser.aiMetadata.dateFieldCreated")}</option>
              <option value="fs_modified_at">{t("browser.aiMetadata.dateFieldModified")}</option>
            </select>
          </label>

          {!rangeInvalid && rangeActive && (
            <span className="print-export__range-info">
              {filtered.length} {t("browser.printExport.rangeInSuffix")}
            </span>
          )}
        </div>

        <div className={"print-export__range-row" + (customActive ? "" : " print-export__range-row--inactive")}>
          <label className="print-export__range-toggle">
            <input type="checkbox" checked={customActive} onChange={(e) => toggleCustom(e.target.checked)} />
            {t("browser.printExport.rangeCustom")}
          </label>

          <label className="print-export__range-field">
            {t("browser.printExport.rangeFrom")}
            <input
              type="date"
              value={rangeFrom}
              max={rangeTo || undefined}
              onChange={(e) => setRangeFrom(e.target.value)}
              disabled={!customActive}
            />
          </label>

          <label className="print-export__range-field">
            {t("browser.printExport.rangeTo")}
            <input
              type="date"
              value={rangeTo}
              min={rangeFrom || undefined}
              onChange={(e) => setRangeTo(e.target.value)}
              disabled={!customActive}
            />
          </label>

          {rangeInvalid && <span className="print-export__range-error">{t("browser.printExport.rangeInvalid")}</span>}
        </div>
      </div>

      <div className="print-export__toolbar">
        <label className="print-export__filter">
          <input type="checkbox" checked={onlyUncertain} onChange={(e) => setOnlyUncertain(e.target.checked)} />
          {t("browser.aiMetadata.scopeUncertain")} ({uncertainCount})
        </label>
        <HelpHint text={t("browser.aiMetadata.scopeUncertainHint")} />

        <label className="print-export__filter">
          <input type="checkbox" checked={hideAiDated} onChange={(e) => setHideAiDated(e.target.checked)} />
          {t("browser.aiMetadata.hideAiDated")} ({aiDatedCount})
        </label>

        <input
          type="text"
          className="ai-metadata__name-filter"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder={t("browser.aiMetadata.nameFilterPlaceholder")}
        />
      </div>

      <div className="print-export__toolbar">
        <label className="print-export__select-all">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => {
              if (el) el.indeterminate = visibleSelectedCount > 0 && !allVisibleSelected;
            }}
            onChange={toggleAllVisible}
            disabled={filtered.length === 0}
          />
          {t("browser.printExport.selectAll")}
        </label>

        <span className="print-export__count">
          {visibleSelectedCount} {t("browser.printExport.selectedSuffix")}
          {hiddenSelectedCount > 0 && (
            <span className="print-export__count-hidden" title={t("browser.printExport.outsideFilterHint")}>
              {" "}
              (+{hiddenSelectedCount} {t("browser.printExport.outsideFilterSuffix")})
            </span>
          )}
        </span>

        <label className="print-export__sort">
          {t("browser.printExport.sortLabel")}
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="date">{t("browser.printExport.sortDate")}</option>
            <option value="name">{t("browser.printExport.sortName")}</option>
            <option value="source">{t("browser.aiMetadata.sortSource")}</option>
          </select>
        </label>

        <button
          className="btn--text"
          onClick={() => setAscending((prev) => !prev)}
          title={t(ascending ? "browser.printExport.sortAscending" : "browser.printExport.sortDescending")}
        >
          {ascending ? "↑" : "↓"}
        </button>
      </div>

      <div className="print-export__list">
        {items.length === 0 && <div className="print-export__empty">{t("browser.aiMetadata.noItems")}</div>}
        {items.length > 0 && filtered.length === 0 && (
          <div className="print-export__empty">{t("browser.aiMetadata.noMatches")}</div>
        )}

        {filtered.length > 0 && (
          <div className="print-export__row print-export__row--header print-export__row--ai">
            <span />
            <span />
            <span>{t("browser.printExport.colName")}</span>
            <span>{t("browser.printExport.colDate")}</span>
            <span>{t("browser.aiMetadata.colSource")}</span>
          </div>
        )}

        {filtered.map((item) => (
          <label
            key={item.id}
            className={
              "print-export__row print-export__row--ai" + (selected.has(item.id) ? " print-export__row--selected" : "")
            }
          >
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} />
            <span className="print-export__thumb">
              {thumbUrls[item.id] ? (
                <img src={thumbUrls[item.id]} alt="" loading="lazy" />
              ) : (
                <span className="print-export__thumb-placeholder">🖼</span>
              )}
            </span>
            <span className="print-export__name" title={item.original_filename}>
              {displayName(item)}
            </span>
            <span className="print-export__date">{formatDate(item.resolved_timestamp)}</span>
            <span className="print-export__date">{timestampSourceLabel(item.timestamp_source)}</span>
          </label>
        ))}
      </div>

      <button className="btn btn--primary" onClick={handleNext} disabled={visibleSelectedCount === 0}>
        {t("browser.aiMetadata.nextButton")} ({visibleSelectedCount})
      </button>
    </div>
  );
}
