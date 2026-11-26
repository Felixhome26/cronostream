import type { KeyboardEvent } from "react";
import { t } from "../../../i18n";

export interface SettingsCategory {
  id: string;
  label: string;
}

/// Category navigation. A vertical tab list; in a narrow window the list
/// gives way to a plain select (the CSS swaps them).
export default function SettingsSidebar({
  categories,
  active,
  onSelect,
}: {
  categories: SettingsCategory[];
  active: string;
  onSelect: (id: string) => void;
}) {
  function onKeyDown(ev: KeyboardEvent<HTMLDivElement>) {
    const index = categories.findIndex((c) => c.id === active);
    let next = -1;
    if (ev.key === "ArrowDown") next = (index + 1) % categories.length;
    else if (ev.key === "ArrowUp") next = (index - 1 + categories.length) % categories.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = categories.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    onSelect(categories[next].id);
    ev.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  return (
    <nav className="settings-nav" aria-label={t("settings.nav")}>
      <div className="settings-nav__list" role="tablist" aria-orientation="vertical" onKeyDown={onKeyDown}>
        {categories.map((category) => {
          const on = category.id === active;
          return (
            <button
              key={category.id}
              id={`settings-tab-${category.id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`settings-panel-${category.id}`}
              tabIndex={on ? 0 : -1}
              className={"settings-nav__item" + (on ? " settings-nav__item--active" : "")}
              onClick={() => onSelect(category.id)}
            >
              {category.label}
            </button>
          );
        })}
      </div>
      <select
        className="settings-nav__select text-input"
        aria-label={t("settings.nav")}
        value={active}
        onChange={(ev) => onSelect(ev.target.value)}
      >
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
      </select>
    </nav>
  );
}
