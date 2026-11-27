import type { ItemInfo } from "../../types";
import { t, tn } from "../../i18n";
import { effectiveName, formatMetaDate } from "../../utils/timeline/itemText";

// Stand-ins for the search result rows of files that have no thumbnail —
// audio has nothing to preview, and docx/odt/rtf/txt produce no rendered
// page (see the tile render for the same fallbacks).
const SEARCH_RESULT_ICON: Record<string, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎧",
  document: "📄",
  email: "✉️",
  other: "*",
};

interface Props {
  items: ItemInfo[];
  activeId: string | null;
  thumbs: Record<string, string>;
  /// A click on a row: the row's index in `items` and its item.
  onPick: (index: number, item: ItemInfo) => void;
  onOpen: (item: ItemInfo) => void;
}

/// The search's hit list beside the timeline.
export default function SearchResultsList({ items, activeId, thumbs, onPick, onOpen }: Props) {
  return (
    <div className="timeline-search-results">
      <div className="timeline-search-results__header">
        {tn(items.length, "search.resultsHeading")}
      </div>
      <div className="timeline-search-results__list">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={"timeline-search-result" + (item.id === activeId ? " timeline-search-result--active" : "")}
            title={t("search.resultHint")}
            onClick={() => onPick(index, item)}
            onDoubleClick={() => onOpen(item)}
          >
            <span className="timeline-search-result__thumb">
              {thumbs[item.id] ? (
                <img
                  src={thumbs[item.id]}
                  alt=""
                  style={item.file_type === "image" && item.rotation ? { transform: `rotate(${item.rotation}deg)` } : undefined}
                />
              ) : (
                <span className="timeline-search-result__icon">{SEARCH_RESULT_ICON[item.file_type] ?? "📄"}</span>
              )}
            </span>
            <span className="timeline-search-result__text">
              <span className="timeline-search-result__name">{effectiveName(item)}</span>
              <span className="timeline-search-result__date">{formatMetaDate(item.resolved_timestamp)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
