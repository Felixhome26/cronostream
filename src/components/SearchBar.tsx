import { useEffect, useRef, useState } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";
import { isRangeInvalid } from "../utils/printRange";
import { formatDay } from "../utils/phases";
import { SearchHistoryField, useSearchHistory } from "./SearchHistory";

/// One in-app search as the stream's history keeps it. Key order is fixed
/// (see `useSearchHistory`'s `record`). An empty `from` and `to` means the
/// date range was off.
interface StreamSearch {
  q: string;
  from: string;
  to: string;
}

function parseStreamSearch(raw: unknown): StreamSearch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.q !== "string" || typeof r.from !== "string" || typeof r.to !== "string") return null;
  return { q: r.q, from: r.from, to: r.to };
}

function streamSearchDetail(s: StreamSearch): string {
  const parts: string[] = [];
  if (s.from !== "") parts.push(`${t("search.fromDate")} ${formatDay(s.from)}`);
  if (s.to !== "") parts.push(`${t("search.toDate")} ${formatDay(s.to)}`);
  return parts.join(" ");
}

/// Long enough that typing a word doesn't fire a query per keystroke,
/// short enough that it still feels like it's searching as you type. The
/// backend scans `extracted_text` for every document on each call (see
/// `search_items`), which is exactly the cost this avoids paying 20 times
/// for one word.
const DEBOUNCE_MS = 250;

interface SearchBarProps {
  /// The matching item ids, newest search wins. `null` means "nothing is
  /// being searched for" (all three fields empty, or an impossible date
  /// range) — distinct from `[]`, which means "searched, found nothing":
  /// the first shows the timeline untouched, the second dims everything.
  onResults: (ids: string[] | null) => void;
  total: number;
  /// 0-based position within the results, for the "3/12" counter.
  activeIndex: number;
  onPrev: () => void;
  onNext: () => void;
  /// Gathers the current hits into a cluster card of their own — shown
  /// beside the jump arrows rather than in the result list, since this is
  /// where the eye already is once a search has returned something.
  onViewResults: () => void;
  onClose: () => void;
  /// Bumped by the timeline whenever a hit is picked from the result list,
  /// which counts as "this search was used" for the history, the same as
  /// Enter or the jump arrows here.
  historySignal?: number;
}

/// The compact search bar: free text over names and extracted document
/// text, plus an optional from/to day range, plus the hit counter and the
/// jump-to-next/previous arrows.
///
/// Owns the query itself and the debounced backend call; the result list
/// and which hit is currently active live in `Timeline`, which is where
/// the items, their thumbnails and the scroll/zoom internals needed to
/// actually jump to a hit already are. The search itself is session state;
/// only a search that was actually used (Enter, a jump arrow, a picked hit,
/// "Ergebnisse ansehen", or closing the bar with hits) goes into the
/// stream's search history — never the half-typed states in between.
export default function SearchBar({
  onResults,
  total,
  activeIndex,
  onPrev,
  onNext,
  onViewResults,
  onClose,
  historySignal = 0,
}: SearchBarProps) {
  const history = useSearchHistory<StreamSearch>("stream", parseStreamSearch);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Separate from whether `from`/`to` are actually filled in — an empty
  // native date input renders as today's date in this webview, which made
  // it look exactly like an active filter even when nothing was picked.
  // This toggle is the one unambiguous signal of "is the date range
  // actually on", same pattern as the print export tab's custom-range
  // checkbox.
  const [dateRangeActive, setDateRangeActive] = useState(false);
  /// Whether the last completed search was a real one — the difference
  /// between "no results" and "you haven't typed anything yet", which
  /// otherwise look identical (both have zero hits).
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /// Debounced calls can still overlap (a slow scan over a big project
  /// followed by a fast one over a narrower query), and a late answer to
  /// an abandoned query would quietly replace the current results. Only
  /// the newest request id is allowed to report back.
  const requestId = useRef(0);
  /// `onResults` is called from inside the debounce effect, which must not
  /// re-run (and so re-fire the query) just because the parent handed down
  /// a new callback identity.
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // An end date before the start date is the one input combination that
  // can't mean anything — say so instead of reporting zero hits, which
  // would look like "nothing in your stream matches".
  const rangeInvalid = isRangeInvalid({ from, to });

  useEffect(() => {
    const trimmed = query.trim();
    if ((trimmed === "" && from === "" && to === "") || rangeInvalid) {
      setSearched(false);
      onResultsRef.current(null);
      return;
    }

    const timer = window.setTimeout(() => {
      const id = ++requestId.current;
      invoke<string[]>("search_items", {
        query: trimmed === "" ? null : trimmed,
        from: from === "" ? null : from,
        to: to === "" ? null : to,
      })
        .then((ids) => {
          if (id !== requestId.current) return;
          setSearched(true);
          onResultsRef.current(ids);
        })
        .catch(() => {
          // A failed search is reported as "no hits" rather than as a
          // technical error: there is nothing the user could do about it,
          // and the bar already tells them plainly that nothing matched.
          if (id !== requestId.current) return;
          setSearched(true);
          onResultsRef.current([]);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, from, to, rangeInvalid]);

  /// Adds the current search to the history if it is one: some text or an
  /// active, valid date range. Kept in a ref so the signal effect below
  /// always sees the latest fields.
  const recordCurrent = useRef<() => void>(() => {});
  recordCurrent.current = () => {
    const q = query.trim();
    const f = dateRangeActive ? from : "";
    const tt = dateRangeActive ? to : "";
    if ((q === "" && f === "" && tt === "") || rangeInvalid) return;
    history.record({ q, from: f, to: tt });
  };

  useEffect(() => {
    if (historySignal > 0) recordCurrent.current();
  }, [historySignal]);

  function applyHistory(entry: StreamSearch) {
    setQuery(entry.q);
    setFrom(entry.from);
    setTo(entry.to);
    setDateRangeActive(entry.from !== "" || entry.to !== "");
    // Taking an entry is using it — it moves back to the top.
    history.record(entry);
    inputRef.current?.focus();
  }

  function toggleDateRange(active: boolean) {
    setDateRangeActive(active);
    if (!active) {
      setFrom("");
      setTo("");
    }
  }

  /// Closing with hits on screen means the search was looked at, so it
  /// counts as used.
  function closeBar() {
    if (total > 0) recordCurrent.current();
    onClose();
  }

  const status = rangeInvalid
    ? t("search.rangeInvalid")
    : total > 0
      ? `${activeIndex + 1}/${total}`
      : searched
        ? t(dateRangeActive ? "search.noResults" : "search.noResultsNoRange")
        : "";

  return (
    // Escape anywhere inside the bar closes it — the query field, the two
    // date inputs and the buttons all bubble through here, and the
    // timeline's own window-level Escape handler deliberately ignores
    // keypresses that come from a focused input.
    <div
      className="timeline-search"
      onKeyDown={(ev) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        closeBar();
      }}
    >
      <SearchHistoryField
        entries={history.entries}
        query={query}
        textOf={(e) => e.q}
        detailOf={streamSearchDetail}
        onPick={applyHistory}
        onRemove={history.remove}
        onClear={history.clear}
        renderInput={(h) => (
          <input
            ref={inputRef}
            className="text-input timeline-search__query"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            onClick={h.onClick}
            onBlur={h.onBlur}
            onKeyDown={(ev) => {
              if (h.onKeyDown(ev)) return;
              // Enter / Shift+Enter walk the hits without leaving the field,
              // the same way the browser's own find bar does.
              if (ev.key !== "Enter") return;
              ev.preventDefault();
              recordCurrent.current();
              if (ev.shiftKey) onPrev();
              else onNext();
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
          />
        )}
      />
      <div className="timeline-search__date-toggle">
        <span>{t("search.dateRangeToggle")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={dateRangeActive}
          aria-label={t("search.dateRangeToggle")}
          className={"switch switch--compact" + (dateRangeActive ? " switch--on" : "")}
          onClick={() => toggleDateRange(!dateRangeActive)}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <div className={"timeline-search__date-group" + (dateRangeActive ? "" : " timeline-search__date-group--inactive")}>
        <label className="timeline-search__date">
          <span>{t("search.fromDate")}</span>
          <input
            type="date"
            className="text-input"
            value={from}
            max={to || undefined}
            disabled={!dateRangeActive}
            onChange={(ev) => setFrom(ev.target.value)}
          />
        </label>
        <label className="timeline-search__date">
          <span>{t("search.toDate")}</span>
          <input
            type="date"
            className="text-input"
            value={to}
            min={from || undefined}
            disabled={!dateRangeActive}
            onChange={(ev) => setTo(ev.target.value)}
          />
        </label>
      </div>
      <span
        className={"timeline-search__status" + (rangeInvalid ? " timeline-search__status--warn" : "")}
      >
        {status}
      </span>
      <button
        className="icon-btn"
        onClick={() => {
          recordCurrent.current();
          onPrev();
        }}
        disabled={total === 0}
        title={t("search.previous")}
        aria-label={t("search.previous")}
      >
        ‹
      </button>
      <button
        className="icon-btn"
        onClick={() => {
          recordCurrent.current();
          onNext();
        }}
        disabled={total === 0}
        title={t("search.next")}
        aria-label={t("search.next")}
      >
        ›
      </button>
      {total > 0 && (
        <button
          type="button"
          className="btn btn--primary timeline-search__cluster-btn"
          onClick={() => {
            recordCurrent.current();
            onViewResults();
          }}
          title={t("search.viewResultsHint")}
        >
          {t("search.viewResults")}
        </button>
      )}
      <button className="icon-btn" onClick={closeBar} title={t("search.close")} aria-label={t("search.close")}>
        ✕
      </button>
    </div>
  );
}
