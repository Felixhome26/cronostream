import { currentLanguage, type Language } from "../i18n";

// How a stored timestamp is written wherever the app shows one — the
// timestamp over the detail view, timeline tile labels, search hits, the
// Protokoll, the file browser's metadata. Deliberately hand-assembled per
// UI language instead of `toLocaleString()`, which follows the *system*
// locale: the app's language is a setting of its own, so a German UI on an
// English system was writing "6/15/2023, 2:23:01 PM" into German sentences.
//
// The scheme:
//   de  02.11.2004 - 11:39 Uhr
//   en  11/02/2004 - 11:39 AM   (month-first, 12-hour clock)
//   es  02/11/2004 - 11:39 h    (day-first, 24-hour clock, "h" as the
//                                standard Spanish time marker)
// Seconds are left off everywhere: nothing in the app is accurate to the
// second, and the minute is what tells two files of the same day apart.

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDate(iso: string | number | null | undefined, language: Language = currentLanguage()): string | null {
  if (iso == null || iso === "") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : String(iso);
  const day = pad2(d.getDate());
  const month = pad2(d.getMonth() + 1);
  const year = d.getFullYear();
  return language === "de"
    ? `${day}.${month}.${year}`
    : language === "en"
      ? `${month}/${day}/${year}`
      : `${day}/${month}/${year}`;
}

export function formatTime(d: Date, language: Language = currentLanguage()): string {
  const minutes = pad2(d.getMinutes());
  if (language === "en") {
    const hours24 = d.getHours();
    const suffix = hours24 < 12 ? "AM" : "PM";
    return `${hours24 % 12 === 0 ? 12 : hours24 % 12}:${minutes} ${suffix}`;
  }
  const time = `${pad2(d.getHours())}:${minutes}`;
  return language === "de" ? `${time} Uhr` : `${time} h`;
}

/// Date *and* time, the app's default way of showing a timestamp. Returns
/// `null` for a missing value (so callers can skip the whole row) and the
/// raw input for an unparseable one, rather than "Invalid Date".
export function formatDateTime(
  iso: string | number | null | undefined,
  language: Language = currentLanguage(),
): string | null {
  if (iso == null || iso === "") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : String(iso);
  return `${formatDate(iso, language)} - ${formatTime(d, language)}`;
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time, with
// no timezone suffix — build/parse it by hand rather than slicing the ISO
// string (which is UTC and would silently shift the displayed time).
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Same idea as `toDatetimeLocalValue` but for a plain <input type="date">
// (no time component at all) — "YYYY-MM-DD" in local time.
export function toDateOnlyValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Combines a "YYYY-MM-DD" date with the time-of-day of `referenceIso` —
// used where only the date is ever shown/edited (the AI metadata review),
// but the stored timestamp still needs a time component, and silently
// zeroing it to midnight would be a bigger, unrequested change than just
// not showing it. Keeps whatever time the item already had.
export function combineDateWithTimeOfDay(dateOnlyValue: string, referenceIso: string): string | null {
  const ref = new Date(referenceIso);
  if (Number.isNaN(ref.getTime())) return null;
  const parts = dateOnlyValue.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [year, month, day] = parts;
  const combined = new Date(ref);
  combined.setFullYear(year, month - 1, day);
  return Number.isNaN(combined.getTime()) ? null : combined.toISOString();
}

// Lower bound for hand-set dates (Einstellungen → "Frühestes Jahr"). A
// module-level value because the segmented date input is used in many
// places that have no access to the project settings.
let earliestDateYear = 1900;
export function setEarliestDateYear(year: number) {
  earliestDateYear = year;
}
export function getEarliestDateYear(): number {
  return earliestDateYear;
}
