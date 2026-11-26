import { currentLanguage, t } from "../i18n";
import type { ActionLogType } from "../types";

const pad2 = (n: number) => String(n).padStart(2, "0");

/// A stored day ("YYYY-MM-DD") the way the rest of the app writes dates.
/// Split by hand rather than through `Date`: a bare ISO date parses as UTC
/// midnight, which reads as the previous day west of Greenwich.
export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  const [, year, month, date] = match;
  const language = currentLanguage();
  return language === "de" ? `${date}.${month}.${year}` : language === "en" ? `${month}/${date}/${year}` : `${date}/${month}/${year}`;
}

export function todayDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  // setUTCFullYear, not Date.UTC(year, ...): that maps years 0-99 to 19xx.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, date + 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/// "#rrggbb" for what the colour popup's hex field holds, or null while it
/// isn't a colour yet. The leading "#" is optional, like in the backend.
export function normalizeHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

export function isPhaseAction(type: ActionLogType): boolean {
  return type.startsWith("phase_");
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  name: "phases.field.name",
  overlapAllowed: "phases.field.overlapAllowed",
  title: "phases.field.title",
  startDate: "phases.field.startDate",
  endDate: "phases.field.endDate",
  color: "phases.field.color",
  ongoing: "phases.field.ongoing",
};

function readFields(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatPhaseValue(key: string, value: unknown): string {
  if (key === "startDate" || key === "endDate") return formatDay(String(value));
  if (typeof value === "boolean") return value ? t("phases.value.yes") : t("phases.value.no");
  return value == null || value === "" ? t("log.value.none") : String(value);
}

/// The readable form of a phase entry's before/after JSON, e.g.
/// "Titel: A → B, Beginn: 01.01.2020 → 01.02.2020". Reordering shows the
/// names in their old and new order (stored beside the ids), removing a
/// Themenbereich how many phases went with it. Null where the entry has
/// nothing to add to its label (creating, or entries from before the names
/// were stored).
export function describePhaseChange(type: ActionLogType, beforeJson: string | null, afterJson: string | null): string | null {
  const before = readFields(beforeJson);
  const after = readFields(afterJson);
  if (type === "phase_group_reorder") {
    const was = before?.orderNames;
    const now = after?.orderNames;
    if (!Array.isArray(was) || !Array.isArray(now)) return null;
    return `${t("phases.field.order")}: ${was.join(", ")} → ${now.join(", ")}`;
  }
  if (type === "phase_group_remove") {
    const ids = before?.phaseIds;
    return Array.isArray(ids) && ids.length > 0 ? `${t("phases.field.phases")}: ${ids.length}` : null;
  }
  if (type !== "phase_update" && type !== "phase_group_update") return null;
  if (!before || !after) return null;
  const parts = Object.keys(after).map((key) => {
    const label = FIELD_LABEL_KEYS[key] ? t(FIELD_LABEL_KEYS[key]) : key;
    return `${label}: ${formatPhaseValue(key, before[key])} → ${formatPhaseValue(key, after[key])}`;
  });
  return parts.length > 0 ? parts.join(", ") : null;
}
