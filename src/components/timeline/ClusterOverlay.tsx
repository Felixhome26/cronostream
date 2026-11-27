import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { ItemInfo } from "../../types";
import { t, tn } from "../../i18n";
import { CLUSTER_FILTER_ORDER, LANE_LABEL_KEY, type FileTypeFilter } from "../../utils/timeline/lanes";

/// Which set of items the open cluster card is showing. A period cluster is
/// reached from a year, month, week or day label above the timeline and spans
/// everything in [startMs, endMs); a search cluster is reached from "Ergebnisse ansehen" in the
/// search panel and spans the current hits. The search variant carries no
/// ids of its own — it reads `matchedItems`, so re-running the query while
/// it is open refreshes it instead of stranding it on a stale result set.
export type ClusterSource = { kind: "period"; startMs: number; endMs: number; title: string } | { kind: "search" } | { kind: "note"; ids: string[] }
  // A diary entry's attachments, as stand-in items that are no rows of `items`.
  | { kind: "virtual"; items: ItemInfo[] };

interface Props {
  source: ClusterSource;
  /// The cluster's items after the type filter.
  items: ItemInfo[];
  heroItem: ItemInfo | null;
  hoverId: string | null;
  onHover: (id: string) => void;
  typeFilter: FileTypeFilter;
  setTypeFilter: Dispatch<SetStateAction<FileTypeFilter>>;
  selectedIds: ReadonlySet<string>;
  onToggleSelected: (ids: string[]) => void;
  onOpen: (item: ItemInfo) => void;
  onClose: () => void;
  gridWrapRef: (el: HTMLDivElement | null) => void;
  onGridScroll: () => void;
  gridHasMore: boolean;
  /// The timeline's own tile rendering, so a file looks the same here as on
  /// the timeline and in a stack.
  renderThumb: (item: ItemInfo, hovered: boolean) => ReactNode;
  renderLabel: (item: ItemInfo, overlay: boolean, className: string) => ReactNode;
}

/// A temporary cluster: a period, the search hits, the files sharing a note,
/// or a diary entry's attachments, as one card over the dimmed timeline.
/// Moved out of Timeline.tsx unchanged; its state stays with the timeline.
export default function ClusterOverlay({
  source,
  items,
  heroItem,
  hoverId,
  onHover,
  typeFilter,
  setTypeFilter,
  selectedIds,
  onToggleSelected,
  onOpen,
  onClose,
  gridWrapRef,
  onGridScroll,
  gridHasMore,
  renderThumb,
  renderLabel,
}: Props) {
  return (
    <div className="cluster-overlay" onClick={onClose}>
      <div className="pile-card">
        <button className="icon-btn cluster-card__close" onClick={onClose} aria-label={t("start.cancel")}>
          ✕
        </button>
        <div className="cluster-card__year">
          {source.kind === "period"
            ? source.title
            : source.kind === "virtual"
              ? `📔 ${tn(items.length, "diary.filesHeading")}`
              : source.kind === "note"
                ? `🔗 ${items.length} ${t("timeline.noteClusterHeading")}`
                : tn(items.length, "search.resultsHeading")}
        </div>

        {heroItem && (
          <div
            className="pile-hero"
            onClick={(ev) => {
              ev.stopPropagation();
              onOpen(heroItem);
            }}
          >
            {renderThumb(heroItem, true)}
            {renderLabel(heroItem, true, "pile-hero__label")}
          </div>
        )}

        {/* The filter row is a control, not "empty card": without this the
            click on a type box bubbled to the overlay and closed the cluster. */}
        <div className="cluster-filters" onClick={(ev) => ev.stopPropagation()}>
          {CLUSTER_FILTER_ORDER.map((lane) => (
            <label key={lane} className="cluster-filter">
              <input
                type="checkbox"
                checked={typeFilter[lane]}
                onChange={() => setTypeFilter((prev) => ({ ...prev, [lane]: !prev[lane] }))}
              />
              {t(LANE_LABEL_KEY[lane])}
            </label>
          ))}
        </div>

        <div className="pile-grid-area">
          <div className="pile-grid-wrap" ref={gridWrapRef} onScroll={onGridScroll} onWheel={(ev) => ev.stopPropagation()}>
            <div className="pile-grid">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={
                    "pile-tile" + (hoverId === item.id ? " pile-tile--focus" : "") + (selectedIds.has(item.id) ? " timeline-tile--selected" : "")
                  }
                  onMouseEnter={() => onHover(item.id)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (ev.ctrlKey || ev.metaKey) {
                      onToggleSelected([item.id]);
                      return;
                    }
                    onOpen(item);
                  }}
                >
                  <div className="timeline-tile__thumb">{renderThumb(item, hoverId === item.id)}</div>
                  {renderLabel(item, false, "timeline-tile__label")}
                </div>
              ))}
            </div>
          </div>
          {gridHasMore && <div className="pile-grid-fade" />}
        </div>
      </div>
    </div>
  );
}
