import { currentLanguage, type Language } from "../i18n";

// Builds the filename a photo gets in the print-export target folder: its
// timeline date, written the way the selected UI language writes dates.
//
// Deliberately assembled from the Date's parts instead of
// `toLocaleDateString()`: the English and Spanish conventions separate with
// "/" and every locale separates the time with ":", and both characters are
// illegal in filenames on Windows (and awkward everywhere else). The
// substitutions below are chosen per language so the result still reads
// natively:
//   de  09.10.2026 - 14.30 Uhr  (dots are the native German separator for
//                                both date and time — "14.30 Uhr" is a
//                                standard German spelling, so nothing here
//                                looks substituted at all)
//   en  10-09-2026 - 2.30 PM    (month-first, "/" → "-", 12-hour clock)
//   es  09-10-2026 - 14.30      (day-first, "/" → "-", 24-hour clock)
//
// Date and time are joined with " - " rather than the comma every one of
// these languages would normally write there: a comma is legal in a
// filename but travels badly — CSV manifests, shell one-liners and upload
// forms at print services all treat it as a separator.
//
// Minute granularity on purpose: the date is what the user is naming the
// photo after, and the time is only there to keep photos from the same day
// apart. Two photos from the same minute are still possible — the backend
// resolves that by appending " - 2", " - 3", … (see `unique_path`).

const pad = (n: number) => String(n).padStart(2, "0");

function datePart(d: Date, language: Language): string {
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  switch (language) {
    case "de":
      return `${day}.${month}.${year}`;
    case "en":
      return `${month}-${day}-${year}`;
    case "es":
      return `${day}-${month}-${year}`;
  }
}

function timePart(d: Date, language: Language): string {
  const minutes = pad(d.getMinutes());
  if (language === "en") {
    const hours24 = d.getHours();
    const suffix = hours24 < 12 ? "AM" : "PM";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${hours12}.${minutes} ${suffix}`;
  }
  const time = `${pad(d.getHours())}.${minutes}`;
  return language === "de" ? `${time} Uhr` : time;
}

/// The export filename for `iso`, without extension. Falls back to the raw
/// ISO string for an unparseable timestamp so such a file still exports
/// (under an obviously odd name) rather than being silently dropped.
export function printExportBaseName(iso: string, language: Language = currentLanguage()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace(/[^0-9A-Za-z-]/g, "-");
  return `${datePart(d, language)} - ${timePart(d, language)}`;
}

/// A fixed-date example of the scheme above, shown in the tab so the user
/// can see what the files will be called before picking a folder.
export function printExportNameExample(language: Language = currentLanguage()): string {
  return `${printExportBaseName(new Date(2026, 9, 9, 14, 30).toISOString(), language)}.jpg`;
}
