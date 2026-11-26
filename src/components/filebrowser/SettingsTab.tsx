import { useState } from "react";
import { t } from "../../i18n";
import type { ProjectSettings, SettingScope } from "../../types";
import { usePrivacy } from "../../hooks/usePrivacyMode";
import CategoryAbout from "./settings/CategoryAbout";
import CategoryFiles from "./settings/CategoryFiles";
import CategoryPiles from "./settings/CategoryPiles";
import CategoryPrivacy from "./settings/CategoryPrivacy";
import CategorySystem from "./settings/CategorySystem";
import CategoryTimeline from "./settings/CategoryTimeline";
import CategoryViewer from "./settings/CategoryViewer";
import { SettingsContext } from "./settings/SettingsContext";
import SettingsSidebar from "./settings/SettingsSidebar";

interface SettingsTabProps {
  settings: ProjectSettings;
  onChange: (patch: Partial<ProjectSettings>) => void;
  onScopeChange: (keys: string[], scope: SettingScope) => void;
  /// Switches the file browser to the Duplicates tab — the full-stream
  /// duplicate scan lives there (its own tab, deliberately moved out of
  /// Settings), this is just a signpost to it.
  onGoToDuplicates: () => void;
}

const CATEGORY_STORAGE_KEY = "cronostream.settingsCategory";
const CATEGORY_IDS = ["system", "files", "timeline", "piles", "media", "privacy", "about"] as const;
type CategoryId = (typeof CATEGORY_IDS)[number];

/// Categories whose rows carry the scope symbol, and so get the one-line
/// explanation of it at the top.
const SCOPED: CategoryId[] = ["files", "timeline", "piles", "media"];

/// The chosen category is kept for the session: switching the language
/// rebuilds the whole app, and the person should land back where they were.
function initialCategory(): CategoryId {
  try {
    const stored = sessionStorage.getItem(CATEGORY_STORAGE_KEY);
    if (stored && (CATEGORY_IDS as readonly string[]).includes(stored)) return stored as CategoryId;
  } catch {
    // Starts on the first category.
  }
  return "system";
}

export default function SettingsTab({ settings, onChange, onScopeChange, onGoToDuplicates }: SettingsTabProps) {
  const [active, setActive] = useState<CategoryId>(initialCategory);
  const privacy = usePrivacy();

  function select(id: string) {
    setActive(id as CategoryId);
    try {
      sessionStorage.setItem(CATEGORY_STORAGE_KEY, id);
    } catch {
      // Not remembered across a language switch, nothing worse.
    }
  }

  // Without a readable privacy status the section would be an empty page.
  const categories = CATEGORY_IDS.filter((id) => id !== "privacy" || privacy?.status).map((id) => ({
    id,
    label: t(`settings.cat.${id}`),
  }));
  const shown: CategoryId = categories.some((c) => c.id === active) ? active : "system";

  // Every category stays mounted and the inactive ones are only hidden: the
  // privacy section keeps its unlocked state and a running thumbnail
  // regeneration keeps its progress while another category is open.
  const panels: Record<CategoryId, React.ReactNode> = {
    system: <CategorySystem />,
    files: <CategoryFiles onGoToDuplicates={onGoToDuplicates} />,
    timeline: <CategoryTimeline />,
    piles: <CategoryPiles />,
    media: <CategoryViewer />,
    privacy: <CategoryPrivacy />,
    about: <CategoryAbout />,
  };

  return (
    <SettingsContext.Provider value={{ settings, onChange, onScopeChange }}>
      <div className="settings-tab">
        <SettingsSidebar categories={categories} active={shown} onSelect={select} />
        <div className="settings-tab__content">
          {categories.map(({ id, label }) => (
            <div
              key={id}
              id={`settings-panel-${id}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${id}`}
              hidden={id !== shown}
              className="settings-tab__inner"
            >
              <h3 className="settings-tab__heading">{label}</h3>
              {SCOPED.includes(id) && <p className="settings-tab__scope-intro">{t("settings.scopeIntro")}</p>}
              {panels[id]}
            </div>
          ))}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
