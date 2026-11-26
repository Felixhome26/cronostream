import { t } from "../i18n";

/// The private mode's key combination, as the string that is stored and
/// compared: `Ctrl+Shift+P`. Modifiers always come in the same order, so two
/// presses of the same keys always produce the same string.

const LONE_MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock", "Fn", "Dead", "Unidentified"]);

/// Taken by the app itself (select all, paste, search, Alt+arrows in the
/// phases dialog, Ctrl+Enter in the diary) or everywhere else by convention.
/// Meta counts like Ctrl, since the app treats the two the same.
const RESERVED = new Set(
  [
    "Ctrl+A",
    "Ctrl+C",
    "Ctrl+V",
    "Ctrl+X",
    "Ctrl+Z",
    "Ctrl+Y",
    "Ctrl+F",
    "Ctrl+Q",
    "Ctrl+W",
    "Ctrl+Enter",
    "Alt+ArrowUp",
    "Alt+ArrowDown",
    "Alt+F4",
    "Alt+Tab",
  ],
);

function keyName(ev: KeyboardEvent): string {
  // A letter goes by what it says on the keycap, so Z stays Z on a German
  // layout, with the physical key as the fallback where a modifier changed
  // the character (Alt on macOS).
  if (/^Key[A-Z]$/.test(ev.code)) return /^[a-zA-Z]$/.test(ev.key) ? ev.key.toUpperCase() : ev.code.slice(3);
  if (/^Digit\d$/.test(ev.code)) return ev.code.slice(5);
  // Everything else by position: Shift turns "," into ";" and would otherwise
  // make the same key two different names.
  return ev.code || ev.key;
}

/// `null` while only modifiers are down, and for AltGr, which is how many
/// layouts type characters like @ and must never count as a command.
export function comboFromEvent(ev: KeyboardEvent): string | null {
  if (LONE_MODIFIER_KEYS.has(ev.key) || ev.getModifierState("AltGraph")) return null;
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  parts.push(keyName(ev));
  return parts.join("+");
}

/// The i18n key saying why a captured combination can't be used, if so.
export function shortcutProblem(combo: string): string | null {
  const parts = combo.split("+");
  if (!parts.slice(0, -1).some((part) => part === "Ctrl" || part === "Alt" || part === "Meta")) {
    return "privacy.shortcutNeedsModifier";
  }
  if (RESERVED.has(combo.replace("Meta", "Ctrl"))) return "privacy.shortcutReserved";
  return null;
}

export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "Ctrl") return t("privacy.keyCtrl");
      if (part === "Shift") return t("privacy.keyShift");
      return part;
    })
    .join("+");
}

/// While the settings capture a new combination, the running one must not
/// fire. Its listener and the capture's are on the same event, in no order
/// that could be relied on, hence a flag rather than stopping propagation.
let capturing = false;

export function setPrivacyCapturing(value: boolean) {
  capturing = value;
}

export function isPrivacyCapturing(): boolean {
  return capturing;
}
