import { t } from "../../i18n";

/// "Alle Jahre" rather than a year number.
export const ALL_YEARS = "all" as const;
export type YearSelection = number | typeof ALL_YEARS;

/// "timeline" compares the date the file has in the stream, "added" the
/// moment it was inserted. The controls live in the filter bar of
/// `ProjectFilesView`; the rail only needs `active` to grey its years out.
export type RangeMode = "timeline" | "added";

export interface DateRange {
  active: boolean;
  mode: RangeMode;
  from: string;
  to: string;
}

interface Props {
  years: number[];
  selected: YearSelection;
  onSelect: (selection: YearSelection) => void;
  range: DateRange;
  /// Shown next to each year, so the rail says how much is in there.
  countByYear: Map<number, number>;
  totalCount: number;
}

/// The left-hand navigation of "Datei-Operationen" and "Papierkorb".
///
/// It takes the place the folder tree holds in the "Hinzufügen" tabs, and
/// that is the whole structural difference between those tabs and these:
/// nothing here browses the filesystem. The years come from the project
/// database (see `list_project_years`), because `originals/<year>/<month>/`
/// on disk reflects each file's date *at import time* — correct a date
/// afterwards and the file stays in its old folder, so the filesystem would
/// answer a different question than the one being asked.
///
/// The free Von/Bis range is an alternative to picking a year, not a filter
/// layered on top of one: switching it on takes the year selection out of
/// play, and switching it off hands the rail back. It carries its own
/// explicit on/off switch for a reason that has bitten this app twice
/// already — an empty native date input renders as *today* in this
/// WebKitGTK version, so an untouched field looks (and acts) like an active
/// filter. Same `dateRangeActive` treatment as the timeline search bar and
/// the disk search tab.
export default function ProjectYearNav({
  years,
  selected,
  onSelect,
  range,
  countByYear,
  totalCount,
}: Props) {
  const rangeActive = range.active;

  return (
    <div className="year-nav">
      <div className="year-nav__section">
        <div className="year-nav__heading">{t("fileOps.yearsHeading")}</div>
        <button
          type="button"
          className={
            "year-nav__row" + (!rangeActive && selected === ALL_YEARS ? " year-nav__row--active" : "")
          }
          onClick={() => onSelect(ALL_YEARS)}
          disabled={rangeActive}
        >
          <span className="year-nav__label">{t("fileOps.allYears")}</span>
          <span className="year-nav__count">{totalCount}</span>
        </button>
        {years.length === 0 && <div className="year-nav__empty">{t("fileOps.noYears")}</div>}
        {years.map((year) => (
          <button
            key={year}
            type="button"
            className={"year-nav__row" + (!rangeActive && selected === year ? " year-nav__row--active" : "")}
            onClick={() => onSelect(year)}
            disabled={rangeActive}
          >
            <span className="year-nav__label">{year}</span>
            <span className="year-nav__count">{countByYear.get(year) ?? 0}</span>
          </button>
        ))}
      </div>

    </div>
  );
}
