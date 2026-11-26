import { t, timestampSourceLabel } from "../i18n";
import { formatDate, formatDateTime } from "../utils/datetime";
import { ensureMediaDates, optionsFor, selectedSource, setDateChoice, useDateInfo } from "../utils/dateChoices";

/// Dropdown listing every date the app could file this file under, each
/// followed by the method that produced it. Renders nothing until the
/// candidates are read. The date inside the file is read only once the
/// pointer or the focus reaches the dropdown (see `ensureMediaDates`).
export default function DateChoiceSelect({ path, disabled }: { path: string; disabled?: boolean }) {
  const info = useDateInfo(path);
  if (!info) return null;
  const options = optionsFor(info);
  if (options.length === 0) return null;
  return (
    <select
      className="date-choice-select"
      value={selectedSource(info)}
      // The whole entry, in case the tile is still too narrow for it.
      title={options.find((o) => o.source === selectedSource(info))?.label}
      disabled={disabled}
      onMouseEnter={() => ensureMediaDates([path])}
      onFocus={() => ensureMediaDates([path])}
      onClick={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
      onChange={(ev) => setDateChoice(path, ev.target.value as typeof info.auto_source)}
    >
      {options.map((o) => (
        <option key={o.source} value={o.source}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/// The date a not-yet-added file would be filed under with the current
/// settings (auto-picked, or the user's own pick), shown beside its name.
/// Renders nothing until the candidates are read, nor if the date and time
/// equal `hideIfShownAs`, which the caller already shows.
export function DateStamp({ path, hideIfShownAs }: { path: string; hideIfShownAs?: string | null }) {
  const info = useDateInfo(path);
  if (!info) return null;
  const source = selectedSource(info);
  const value = optionsFor(info).find((o) => o.source === source)?.value ?? info.auto_value;
  if (hideIfShownAs && formatDateTime(value) === formatDateTime(hideIfShownAs)) return null;
  return (
    <span className="file-tile__stamp" title={t("browser.dateStampHelp")}>
      {formatDate(value)} ({timestampSourceLabel(source)})
      <span className="file-tile__stamp-help" aria-hidden="true">?</span>
    </span>
  );
}
