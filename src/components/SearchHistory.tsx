import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

/// Where a history lives: `stream` is the in-app search's, kept in the open
/// stream's database; `disk` is the disk search's, one for the whole app.
/// See `search_history.rs`.
export type SearchHistoryScope = "stream" | "disk";

export interface SearchHistoryEntry<T> {
  /// The exact string stored in the backend, which is also the entry's
  /// identity (removing an entry sends it back verbatim).
  payload: string;
  data: T;
}

/// Loads one history and keeps it in sync with the backend. `parse` turns a
/// stored payload back into the caller's search shape and returns `null` for
/// anything it doesn't recognise (an entry written by an older version), so
/// a stray row can never break the dropdown.
///
/// Deliberately the plain Tauri `invoke`, not the one from `busy.tsx`: a
/// history read or write is a few milliseconds and must never flash the
/// global "working" spinner.
export function useSearchHistory<T>(scope: SearchHistoryScope, parse: (raw: unknown) => T | null) {
  const [entries, setEntries] = useState<SearchHistoryEntry<T>[]>([]);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const reload = useCallback(() => {
    invoke<string[]>("list_search_history", { scopeName: scope })
      .then((payloads) => {
        const parsed: SearchHistoryEntry<T>[] = [];
        for (const payload of payloads) {
          try {
            const data = parseRef.current(JSON.parse(payload));
            if (data !== null) parsed.push({ payload, data });
          } catch {
            // Not JSON at all — skip it, same as an unrecognised shape.
          }
        }
        setEntries(parsed);
      })
      .catch(() => setEntries([]));
  }, [scope]);

  useEffect(() => {
    reload();
  }, [reload]);

  /// `data` must be built with a fixed key order (an object literal, sets
  /// as sorted arrays): the JSON string is the dedupe key, so the same
  /// search has to serialize identically every time.
  const record = useCallback(
    (data: T) => {
      const payload = JSON.stringify(data);
      // Shown at once, newest first, without waiting for the round trip.
      setEntries((prev) => [{ payload, data }, ...prev.filter((e) => e.payload !== payload)].slice(0, 50));
      invoke("add_search_history", { scopeName: scope, payload }).catch(() => reload());
    },
    [scope, reload],
  );

  const remove = useCallback(
    (payload: string) => {
      setEntries((prev) => prev.filter((e) => e.payload !== payload));
      invoke("remove_search_history", { scopeName: scope, payload }).catch(() => reload());
    },
    [scope, reload],
  );

  const clear = useCallback(() => {
    setEntries([]);
    invoke("clear_search_history", { scopeName: scope }).catch(() => reload());
  }, [scope, reload]);

  return { entries, record, remove, clear };
}

interface SearchHistoryFieldProps<T> {
  entries: SearchHistoryEntry<T>[];
  /// The text currently in the search field: the list shows only entries
  /// whose text contains it, and opens on a click only while it is empty.
  query: string;
  /// The entry's search text, used both as the row's main label and for
  /// the filter above.
  textOf: (data: T) => string;
  /// A short summary of the entry's filters, shown dimmed after the text
  /// (empty string for none).
  detailOf: (data: T) => string;
  onPick: (data: T) => void;
  onRemove: (payload: string) => void;
  onClear: () => void;
  /// The search input itself, rendered inside the wrapper so the list can
  /// sit right under it. It receives the handlers it must spread on.
  renderInput: (handlers: SearchHistoryInputHandlers) => React.ReactNode;
}

export interface SearchHistoryInputHandlers {
  onClick: () => void;
  onBlur: () => void;
  /// Returns true when the key was used by the history list — the input's
  /// own handler must then do nothing more with it.
  onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => boolean;
}

/// How many rows the list shows before it scrolls.
const VISIBLE_ROWS = 8;

/// A search field with its history dropdown: opens on a click in the empty
/// field, on the ▾ button or on ↓ — never just because the field got the
/// focus (Ctrl+F focuses the timeline's field, and the list must not pop
/// up over the timeline every time the bar opens); ↑/↓ choose, Enter or a click
/// takes the entry, Escape closes only the list. Each row has a × of its
/// own, and the last row clears the whole history.
export function SearchHistoryField<T>({
  entries,
  query,
  textOf,
  detailOf,
  onPick,
  onRemove,
  onClear,
  renderInput,
}: SearchHistoryFieldProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  /// Set by the ▾ button: shows the whole list even with text in the field
  /// (whose filter could otherwise hide every entry). Typing ends it.
  const [unfiltered, setUnfiltered] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const needle = query.trim().toLowerCase();
  const visible = needle === "" || unfiltered ? entries : entries.filter((e) => textOf(e.data).toLowerCase().includes(needle));
  const shown = open && visible.length > 0;

  // A changed filter or list invalidates the highlighted row's position.
  useEffect(() => {
    setHighlight(-1);
  }, [needle, entries.length]);
  useEffect(() => {
    setUnfiltered(false);
  }, [needle]);

  // Keeps the row chosen with the arrow keys inside the scrolled area.
  useEffect(() => {
    if (!shown || highlight < 0) return;
    const row = listRef.current?.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [highlight, shown]);

  function pick(entry: SearchHistoryEntry<T>) {
    setOpen(false);
    setHighlight(-1);
    onPick(entry.data);
  }

  const handlers: SearchHistoryInputHandlers = {
    onClick: () => {
      if (query.trim() === "") setOpen(true);
    },
    onBlur: () => setOpen(false),
    onKeyDown: (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!shown) {
          setOpen(true);
          setHighlight(0);
        } else {
          setHighlight((h) => Math.min(h + 1, visible.length - 1));
        }
        return true;
      }
      if (!shown) return false;
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setHighlight((h) => Math.max(h - 1, -1));
        return true;
      }
      if (ev.key === "Enter" && highlight >= 0 && highlight < visible.length) {
        ev.preventDefault();
        pick(visible[highlight]);
        return true;
      }
      if (ev.key === "Escape") {
        // Only the list closes; the search bar around it stays open.
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        return true;
      }
      if (ev.key === "Enter" || ev.key === "Tab") setOpen(false);
      return false;
    },
  };

  return (
    <div className="search-history" ref={wrapperRef}>
      {renderInput(handlers)}
      <button
        type="button"
        className="search-history__toggle"
        tabIndex={-1}
        disabled={entries.length === 0}
        title={t("searchHistory.toggle")}
        aria-label={t("searchHistory.toggle")}
        aria-expanded={shown}
        // mousedown, not click: keeps the focus in the search field, whose
        // blur would otherwise close the list before the click arrives.
        onMouseDown={(ev) => {
          ev.preventDefault();
          if (shown) {
            setOpen(false);
          } else {
            // The list closes on the field's blur, so the field has to hold
            // the focus while it is open — otherwise a click elsewhere
            // would leave it hanging open.
            wrapperRef.current?.querySelector("input")?.focus();
            setOpen(true);
            setUnfiltered(true);
          }
        }}
      >
        ▾
      </button>
      {shown && (
        <div
          className="search-history__panel"
          style={{ ["--search-history-rows" as string]: VISIBLE_ROWS }}
          // Every click inside the panel keeps the field focused, so the
          // blur-closes-the-list rule above never fires on our own rows.
          onMouseDown={(ev) => ev.preventDefault()}
          // The list scrolls on its own; nothing behind it (timeline zoom,
          // the page) should move with it.
          onWheel={(ev) => ev.stopPropagation()}
        >
          <ul ref={listRef} className="search-history__list" role="listbox" aria-label={t("searchHistory.title")}>
            {visible.map((entry, index) => {
              const text = textOf(entry.data);
              const detail = detailOf(entry.data);
              return (
                <li
                  key={entry.payload}
                  role="option"
                  aria-selected={index === highlight}
                  className={"search-history__row" + (index === highlight ? " search-history__row--active" : "")}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(entry)}
                >
                  <span className="search-history__text">
                    {text === "" ? <em className="search-history__empty-text">{t("searchHistory.noText")}</em> : text}
                    {detail !== "" && <span className="search-history__detail">{detail}</span>}
                  </span>
                  <button
                    type="button"
                    className="search-history__remove"
                    tabIndex={-1}
                    title={t("searchHistory.remove")}
                    aria-label={t("searchHistory.remove")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onRemove(entry.payload);
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="search-history__clear"
            tabIndex={-1}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            {t("searchHistory.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
