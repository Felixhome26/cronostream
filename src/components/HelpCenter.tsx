import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { currentLanguage, t, type Language } from "../i18n";
import { useToast } from "../ToastContext";
import { HELP_CATEGORY_ORDER, HELP_TOPICS, helpTexts, type HelpBlock, type HelpCategory, type HelpTopic } from "../helpContent";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TOPIC_BY_ID = new Map<string, HelpTopic>(HELP_TOPICS.map((topic) => [topic.id, topic]));

/// The video section of the website's help page. Shipped app versions keep
/// these addresses, so the website must not move them.
const VIDEOS_URL: Record<Language, string> = {
  de: "https://felixheck.de/cronostream/de/hilfe/#videos",
  en: "https://felixheck.de/cronostream/en/help/#videos",
  es: "https://felixheck.de/cronostream/es/ayuda/#videos",
};

/// `**bold**` is the only inline markup the help texts use (to make UI
/// labels stand out); everything else is plain text.
function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>));
}

function blockText(block: HelpBlock): string {
  if ("p" in block) return block.p;
  if ("note" in block) return block.note;
  if ("steps" in block) return block.steps.join(" ");
  if ("list" in block) return block.list.join(" ");
  return block.keys.map(([key, desc]) => `${key} ${desc}`).join(" ");
}

function renderBlock(block: HelpBlock, index: number): ReactNode {
  if ("p" in block) return <p key={index}>{renderInline(block.p)}</p>;
  if ("note" in block) {
    return (
      <p key={index} className="help-center__note">
        {renderInline(block.note)}
      </p>
    );
  }
  if ("steps" in block) {
    return (
      <ol key={index} className="help-center__steps">
        {block.steps.map((step, i) => (
          <li key={i}>{renderInline(step)}</li>
        ))}
      </ol>
    );
  }
  if ("list" in block) {
    return (
      <ul key={index} className="help-center__list">
        {block.list.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  return (
    <table key={index} className="help-center__keys">
      <tbody>
        {block.keys.map(([key, desc], i) => (
          <tr key={i}>
            <th scope="row">
              <kbd>{key}</kbd>
            </th>
            <td>{renderInline(desc)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/// "?" Hilfe-Center: a right-side panel, not a full-screen overlay like
/// `FileBrowser` — deliberately no backdrop, so the timeline stays visible
/// and glanceable while a hint is open next to it. Everything it shows is
/// bundled with the app (per the in-app-help guide's hard constraint: no
/// network calls, no AI, nothing that needs to be online). The one way out
/// is the link to the tutorial videos, which opens in the browser on click.
///
/// Two views over the same `HELP_TOPICS`, never two separate content sets:
/// "quickstart" (default) shows only the flagged `quickStart` topics;
/// "all" adds a category grid (the Boxed-List-pattern answer to having
/// ~90 entries — never show them all flat, see the UX guide) so switching
/// categories narrows the list back down to a handful. A non-empty search
/// query overrides both and searches every topic regardless of view, so
/// nothing set aside for "Alle Themen" is ever actually unreachable.
///
/// A "Siehe auch" link jumps to its topic the same way in every view: it
/// switches to "Alle Themen", selects that topic's category and opens it,
/// so the user lands where browsing would have taken them and can carry on
/// from there.
///
/// Search is a plain client-side substring match over each topic's title,
/// body and category label — the topic count is far too small to justify
/// a fuzzy-search dependency.
export default function HelpCenter({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const [view, setView] = useState<"quickstart" | "all">("quickstart");
  const [selectedCategory, setSelectedCategory] = useState<HelpCategory>(HELP_CATEGORY_ORDER[0]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollToTopicRef = useRef<string | null>(null);
  const texts = helpTexts();
  const showToast = useToast();

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;

  const textOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const topic of HELP_TOPICS) {
      const text = texts.topics[topic.id];
      const parts = [text.title, texts.categories[topic.category], ...text.blocks.map(blockText)];
      map.set(topic.id, parts.join(" ").replace(/\*\*/g, "").toLowerCase());
    }
    return map;
  }, [texts]);

  // Closes on an outside click (same `mousedown` + `.contains()` shape as
  // `ToolbarDropdown`) and on Escape — Escape is registered on the capture
  // phase and stops propagation, same as `AboutPanel`/`PendingDrops`/
  // `RecordMedia`/`CollectionAddButton`, because `useFullscreen` has an
  // always-on, ungated Escape listener of its own (Escape exits fullscreen
  // app-wide); without stopping it here, closing the panel would also kick
  // the app out of fullscreen in the same keystroke.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) onClose();
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  // Resets to the default landing view each time the panel is reopened —
  // picking up in "Alle Themen" > some category from last time would be a
  // surprise, not a convenience.
  useEffect(() => {
    if (open) {
      setQuery("");
      setView("quickstart");
      setOpenTopicId(null);
    }
  }, [open]);

  // Every newly opened topic is scrolled to the top edge once the render
  // that opened it has been committed. Opening one collapses whichever
  // topic was open before; if that one sat above, everything below moves
  // up by its height while the scroll position stays put, which used to
  // leave the clicked heading above the visible area. A "Siehe auch" jump
  // needs the same, since its target is rendered in a different list.
  useEffect(() => {
    const id = scrollToTopicRef.current;
    if (!id || !rootRef.current) return;
    scrollToTopicRef.current = null;
    rootRef.current.querySelector(`[data-topic-id="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [openTopicId, selectedCategory, view]);

  const searchMatches = useMemo(
    () => (searching ? HELP_TOPICS.filter((topic) => (textOf.get(topic.id) ?? "").includes(normalizedQuery)) : []),
    [searching, normalizedQuery, textOf],
  );

  const quickStartTopics = useMemo(() => HELP_TOPICS.filter((topic: HelpTopic) => topic.quickStart), []);
  const categoryTopics = useMemo(() => HELP_TOPICS.filter((topic) => topic.category === selectedCategory), [selectedCategory]);
  const countByCategory = useMemo(() => {
    const counts = new Map<HelpCategory, number>();
    for (const topic of HELP_TOPICS) counts.set(topic.category, (counts.get(topic.category) ?? 0) + 1);
    return counts;
  }, []);

  function jumpToTopic(id: string) {
    const topic = TOPIC_BY_ID.get(id);
    if (!topic) return;
    setQuery("");
    setView("all");
    setSelectedCategory(topic.category);
    setOpenTopicId(id);
    scrollToTopicRef.current = id;
  }

  function renderTopic(topic: HelpTopic, showCategory = false) {
    const isOpen = openTopicId === topic.id;
    const text = texts.topics[topic.id];
    const related = (topic.related ?? []).filter((id) => TOPIC_BY_ID.has(id)) as HelpTopic["id"][];
    return (
      <li key={topic.id} className="help-center__topic" data-topic-id={topic.id}>
        <button
          type="button"
          className="help-center__topic-trigger"
          aria-expanded={isOpen}
          onClick={() => {
            if (!isOpen) scrollToTopicRef.current = topic.id;
            setOpenTopicId(isOpen ? null : topic.id);
          }}
        >
          <span className="help-center__topic-caret" aria-hidden="true">
            {isOpen ? "▾" : "▸"}
          </span>
          <span className="help-center__topic-title">
            {text.title}
            {showCategory && <span className="help-center__topic-category">{texts.categories[topic.category]}</span>}
          </span>
        </button>
        {isOpen && (
          <div className="help-center__topic-body">
            {text.blocks.map(renderBlock)}
            {related.length > 0 && (
              <div className="help-center__related">
                <span className="help-center__related-label">{t("help.seeAlso")}</span>
                {related.map((id) => (
                  <button key={id} type="button" className="help-center__related-link" onClick={() => jumpToTopic(id)}>
                    {texts.topics[id].title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </li>
    );
  }

  if (!open) return null;

  return (
    <div ref={rootRef} className="help-center" role="complementary" aria-label={t("help.title")}>
      <div className="help-center__header">
        <h2 className="help-center__title">{t("help.title")}</h2>
        <button className="icon-btn" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
          ×
        </button>
      </div>

      <input
        type="search"
        className="help-center__search"
        value={query}
        onChange={(ev) => setQuery(ev.target.value)}
        placeholder={t("help.searchPlaceholder")}
        aria-label={t("help.searchPlaceholder")}
      />

      <button
        type="button"
        className="btn--text help-center__videos"
        title={t("help.videosTitle")}
        onClick={() => {
          openUrl(VIDEOS_URL[currentLanguage()]).catch(() => showToast(t("help.videosOpenError")));
        }}
      >
        <span aria-hidden="true">▶ </span>
        {t("help.videos")}
        <span aria-hidden="true"> ↗</span>
      </button>

      {!searching && (
        <div className="help-center__view-switch">
          {view === "quickstart" ? (
            <>
              <span className="help-center__category-title">{t("help.quickstartHeading")}</span>
              <button type="button" className="btn--text" onClick={() => setView("all")}>
                {t("help.viewAllTopics")}
              </button>
            </>
          ) : (
            <button type="button" className="btn--text" onClick={() => setView("quickstart")}>
              {t("help.backToQuickstart")}
            </button>
          )}
        </div>
      )}

      <div className="help-center__body">
        {searching ? (
          searchMatches.length === 0 ? (
            <p className="help-center__empty">{t("help.noResults")}</p>
          ) : (
            <ul className="help-center__topics">{searchMatches.map((topic) => renderTopic(topic, true))}</ul>
          )
        ) : view === "quickstart" ? (
          <ul className="help-center__topics">{quickStartTopics.map((topic) => renderTopic(topic, true))}</ul>
        ) : (
          <div className="help-center__all">
            <nav className="help-center__category-nav" aria-label={t("help.allTopicsHeading")}>
              {HELP_CATEGORY_ORDER.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={"help-center__category-nav-item" + (selectedCategory === category ? " help-center__category-nav-item--active" : "")}
                  onClick={() => {
                    setSelectedCategory(category);
                    setOpenTopicId(null);
                  }}
                  aria-current={selectedCategory === category ? "true" : undefined}
                >
                  <span>{texts.categories[category]}</span>
                  <span className="help-center__category-nav-count">{countByCategory.get(category) ?? 0}</span>
                </button>
              ))}
            </nav>
            <h3 className="help-center__category-title">{texts.categories[selectedCategory]}</h3>
            <ul className="help-center__topics help-center__topics--category">{categoryTopics.map((topic) => renderTopic(topic))}</ul>
          </div>
        )}
      </div>
    </div>
  );
}
