import { currentLanguage, type Language } from "./i18n";
import { HELP_DE } from "./help/de";
import { HELP_EN } from "./help/en";
import { HELP_ES } from "./help/es";

/// Content model for the Hilfe-Center panel (`HelpCenter.tsx`).
///
/// Split in two on purpose. This file holds the *structure* — which topics
/// exist, which category each belongs to, which ones greet the user in the
/// "Schnelleinstieg" view, and which other topics each one points to under
/// "Siehe auch". The *wording* lives in one module per language under
/// `src/help/`, each typed as `HelpTexts`, so the compiler refuses a
/// language file that is missing a topic or a category. That replaced
/// ~360 single `help.topic.*` keys in `i18n.ts`: a help text is several
/// paragraphs, lists and key tables, and keeping each piece as its own
/// flat key made the topics impossible to read or review as a whole.
///
/// The categories follow the app itself — start screen, header, timeline,
/// detail view, the four FileBrowser areas, plus keyboard and FAQ, which
/// have no single screen of their own — so a user can find a topic by
/// where they are rather than by what it is called.
///
/// `quickStart` marks the subset shown by default (the panel's
/// "Schnelleinstieg" view) — everything else only shows up once the user
/// explicitly switches to "Alle Themen", per Hick's Law (don't dump 90
/// choices on someone who just wants the dozen that matter most). Search
/// ignores this flag entirely: it always searches every topic, because a
/// topic set aside for discoverability still has to stay findable.

export const HELP_CATEGORY_ORDER = [
  "erste",
  "start",
  "kopfleiste",
  "zeitleiste",
  "auswahl",
  "detail",
  "suche",
  "hinzufuegen",
  "datum",
  "verwalten",
  "protokoll",
  "tagebuch",
  "phasen",
  "einstellungen",
  "tastatur",
  "faq",
] as const;

export type HelpCategory = (typeof HELP_CATEGORY_ORDER)[number];

/// One piece of a topic's body. A topic mixes these freely: a paragraph
/// that explains, numbered steps for a workflow, a bullet list for a set
/// of options, a key table for shortcuts, and a highlighted note for the
/// one thing that must not be missed. Text may mark UI labels as
/// `**bold**` — the only inline formatting `HelpCenter` renders.
export type HelpBlock =
  | { p: string }
  | { steps: string[] }
  | { list: string[] }
  | { keys: [string, string][] }
  | { note: string };

export interface HelpTopicText {
  title: string;
  blocks: HelpBlock[];
}

interface HelpTopicDef {
  id: string;
  category: HelpCategory;
  quickStart?: boolean;
  /// Other topic ids, shown as clickable "Siehe auch" links.
  related?: readonly string[];
}

export const HELP_TOPICS = [
  // Erste Schritte
  { id: "intro-was", category: "erste", related: ["intro-erster", "intro-originale"] },
  { id: "intro-erster", category: "erste", quickStart: true, related: ["start-anlegen", "add-wege", "zl-bewegen"] },
  { id: "intro-originale", category: "erste", quickStart: true, related: ["faq-lokal", "log-rueckgaengig"] },
  { id: "intro-hilfe", category: "erste", related: ["keys-allgemein"] },

  // Startbildschirm
  { id: "start-anlegen", category: "start", related: ["intro-erster"] },
  { id: "start-oeffnen", category: "start", related: ["start-warnungen"] },
  { id: "start-warnungen", category: "start", related: ["faq-mehrere"] },
  { id: "start-kachel", category: "start", related: ["start-loeschen"] },
  { id: "start-duplizieren", category: "start", related: ["verw-sicherung", "faq-sicherung"] },
  { id: "start-loeschen", category: "start", related: ["start-wiederherstellen"] },
  { id: "start-wiederherstellen", category: "start", related: ["start-loeschen"] },

  // Kopfleiste & Werkzeugkasten
  { id: "kopf-symbole", category: "kopfleiste", quickStart: true, related: ["kopf-werkzeugkasten", "kopf-statistik"] },
  { id: "kopf-statistik", category: "kopfleiste", related: ["kopf-vollbild"] },
  { id: "kopf-vollbild", category: "kopfleiste", related: ["keys-allgemein"] },
  { id: "kopf-werkzeugkasten", category: "kopfleiste", related: ["kopf-peek", "add-uebersicht", "verw-dateiops"] },
  { id: "kopf-peek", category: "kopfleiste", related: ["kopf-werkzeugkasten"] },

  // Zeitleiste
  { id: "zl-bewegen", category: "zeitleiste", quickStart: true, related: ["zl-beschriftung", "keys-allgemein"] },
  { id: "zl-beschriftung", category: "zeitleiste", related: ["zl-cluster"] },
  { id: "zl-spuren", category: "zeitleiste", related: ["set-zeitleiste"] },
  { id: "zl-kacheln", category: "zeitleiste", related: ["zl-stapel", "detail-oeffnen"] },
  { id: "zl-stapel", category: "zeitleiste", quickStart: true, related: ["set-stapel", "zl-cluster"] },
  { id: "zl-cluster", category: "zeitleiste", related: ["suche-ergebnisse", "detail-name-notiz", "tb-lesen"] },
  { id: "zl-rechtsklick", category: "zeitleiste", related: ["zl-rechtsklick-frei", "add-anderer-ls"] },
  { id: "zl-rechtsklick-frei", category: "zeitleiste", related: ["tb-anlegen", "add-zwischenablage"] },
  { id: "zl-datum-ziehen", category: "zeitleiste", related: ["set-zeitleiste", "datum-quellen"] },
  { id: "zl-ohne-datum", category: "zeitleiste", related: ["datum-quellen"] },
  { id: "zl-leer", category: "zeitleiste", related: ["add-wege"] },

  // Auswahl & Sammelbearbeitung
  { id: "auswahl-markieren", category: "auswahl", quickStart: true, related: ["auswahl-bearbeiten"] },
  { id: "auswahl-bearbeiten", category: "auswahl", related: ["verw-aktionen", "auswahl-beispiel"] },
  { id: "auswahl-beispiel", category: "auswahl", related: ["detail-name-notiz", "suche-bedienen"] },

  // Detailansicht
  { id: "detail-oeffnen", category: "detail", quickStart: true, related: ["set-medien", "keys-detail"] },
  { id: "detail-bild", category: "detail", related: ["keys-detail"] },
  { id: "detail-player", category: "detail", related: ["set-medien"] },
  { id: "detail-dokumente", category: "detail", related: ["faq-formate"] },
  { id: "detail-zeitstempel", category: "detail", related: ["datum-eingabe", "datum-quellen"] },
  { id: "detail-name-notiz", category: "detail", related: ["faq-datum-name", "auswahl-beispiel"] },
  { id: "detail-entfernen", category: "detail", related: ["verw-papierkorb", "set-allgemein"] },
  { id: "detail-herausziehen", category: "detail", related: ["detail-bild"] },

  // Suche
  { id: "suche-bedienen", category: "suche", quickStart: true, related: ["suche-ergebnisse"] },
  { id: "suche-ergebnisse", category: "suche", related: ["zl-cluster", "auswahl-markieren"] },

  // Hinzufügen
  { id: "add-wege", category: "hinzufuegen", quickStart: true, related: ["add-pruefen", "add-uebersicht"] },
  { id: "add-drop", category: "hinzufuegen", related: ["add-pruefen"] },
  { id: "add-pruefen", category: "hinzufuegen", related: ["datum-nach-import", "add-ablage"] },
  { id: "add-ablage", category: "hinzufuegen", related: ["add-pruefen", "set-start"] },
  { id: "add-uebersicht", category: "hinzufuegen", related: ["add-sammlung", "keys-browser"] },
  { id: "add-sammlung", category: "hinzufuegen", related: ["datum-nach-import"] },
  { id: "add-einzelbild", category: "hinzufuegen", related: ["keys-browser"] },
  { id: "add-festplatte", category: "hinzufuegen", related: ["add-sammlung", "faq-duplikate"] },
  { id: "add-liste", category: "hinzufuegen", related: ["verw-pfadliste"] },
  { id: "add-zwischenablage", category: "hinzufuegen", related: ["tb-anlegen"] },
  { id: "add-anderer-ls", category: "hinzufuegen", related: ["verw-uebertragen"] },

  // Datum & KI
  { id: "datum-quellen", category: "datum", related: ["detail-zeitstempel", "add-pruefen"] },
  { id: "datum-eingabe", category: "datum", related: ["set-allgemein"] },
  { id: "datum-batch", category: "datum", related: ["verw-aktionen", "datum-eingabe"] },
  { id: "datum-nach-import", category: "datum", related: ["datum-batch", "datum-ki"] },
  { id: "datum-ki", category: "datum", quickStart: true, related: ["datum-ki-details", "faq-lokal"] },
  { id: "datum-ki-details", category: "datum", related: ["datum-ki"] },

  // Verwalten
  { id: "verw-dateiops", category: "verwalten", quickStart: true, related: ["verw-aktionen", "auswahl-bearbeiten"] },
  { id: "verw-aktionen", category: "verwalten", related: ["datum-batch", "verw-uebertragen", "verw-druckexport"] },
  { id: "verw-uebertragen", category: "verwalten", related: ["add-anderer-ls"] },
  { id: "verw-druckexport", category: "verwalten", related: ["faq-sicherung"] },
  { id: "verw-pfadliste", category: "verwalten", related: ["verw-ersetzen", "add-liste"] },
  { id: "verw-ersetzen", category: "verwalten", related: ["verw-pfadliste", "log-rueckgaengig"] },
  { id: "verw-papierkorb", category: "verwalten", quickStart: true, related: ["faq-entfernen", "log-endgueltig"] },
  { id: "verw-duplikate", category: "verwalten", related: ["faq-duplikate", "set-allgemein"] },
  { id: "verw-sicherung", category: "verwalten", related: ["faq-sicherung", "faq-mitnehmen", "verw-archiv"] },
  { id: "verw-archiv", category: "verwalten", related: ["verw-sicherung", "verw-duplikate"] },

  // Protokoll
  { id: "log-ueberblick", category: "protokoll", related: ["log-rueckgaengig"] },
  { id: "log-rueckgaengig", category: "protokoll", quickStart: true, related: ["log-ueberblick", "log-endgueltig"] },
  { id: "log-endgueltig", category: "protokoll", related: ["faq-entfernen"] },

  // Tagebuch & Aufnahmen
  { id: "tb-anlegen", category: "tagebuch", related: ["tb-lesen", "add-zwischenablage"] },
  { id: "tb-lesen", category: "tagebuch", related: ["zl-cluster"] },
  { id: "aufn-aufnehmen", category: "tagebuch", related: ["aufn-ffmpeg"] },
  { id: "aufn-ffmpeg", category: "tagebuch", related: ["set-ueber"] },

  // Themenbereiche
  { id: "ph-verwalten", category: "phasen", related: ["ph-zeitleiste"] },
  { id: "ph-zeitleiste", category: "phasen", related: ["ph-verwalten", "zl-bewegen"] },

  // Einstellungen
  { id: "set-aufbau", category: "einstellungen", related: ["set-geltung", "set-sprache"] },
  { id: "set-sprache", category: "einstellungen", quickStart: true, related: ["set-geltung", "verw-druckexport"] },
  { id: "set-geltung", category: "einstellungen", quickStart: true, related: ["set-allgemein", "set-stapel"] },
  { id: "set-allgemein", category: "einstellungen", related: ["verw-duplikate", "detail-entfernen"] },
  { id: "set-zeitleiste", category: "einstellungen", related: ["zl-spuren", "zl-datum-ziehen"] },
  { id: "set-stapel", category: "einstellungen", related: ["zl-stapel"] },
  { id: "set-medien", category: "einstellungen", related: ["detail-oeffnen"] },
  { id: "set-start", category: "einstellungen", related: ["add-ablage", "set-deinstallieren"] },
  { id: "set-deinstallieren", category: "einstellungen", related: ["set-start", "start-loeschen"] },
  { id: "set-privat", category: "einstellungen", related: ["set-geltung", "faq-lokal"] },
  { id: "set-ueber", category: "einstellungen", related: ["aufn-ffmpeg"] },

  // Tastatur & Maus
  { id: "keys-allgemein", category: "tastatur", quickStart: true, related: ["keys-detail", "keys-browser"] },
  { id: "keys-detail", category: "tastatur", related: ["detail-bild"] },
  { id: "keys-browser", category: "tastatur", related: ["datum-eingabe"] },

  // Häufige Fragen
  { id: "faq-mehrere", category: "faq", related: ["start-warnungen"] },
  { id: "faq-datum-name", category: "faq", related: ["detail-name-notiz"] },
  { id: "faq-entfernen", category: "faq", related: ["verw-papierkorb", "log-endgueltig"] },
  { id: "faq-sicherung", category: "faq", related: ["verw-sicherung", "start-duplizieren", "verw-druckexport"] },
  { id: "faq-mitnehmen", category: "faq", related: ["verw-sicherung"] },
  { id: "faq-formate", category: "faq", related: ["detail-dokumente"] },
  { id: "faq-duplikate", category: "faq", related: ["verw-duplikate", "add-pruefen"] },
  { id: "faq-lokal", category: "faq", related: ["datum-ki-details"] },
  { id: "faq-arbeitet", category: "faq", related: ["kopf-statistik"] },
] as const satisfies readonly HelpTopicDef[];

export type HelpTopicId = (typeof HELP_TOPICS)[number]["id"];
export type HelpTopic = HelpTopicDef & { id: HelpTopicId };

/// What every language module under `src/help/` has to provide — every
/// category label and every topic, nothing optional.
export interface HelpTexts {
  categories: Record<HelpCategory, string>;
  topics: Record<HelpTopicId, HelpTopicText>;
}

const TEXTS: Record<Language, HelpTexts> = { de: HELP_DE, en: HELP_EN, es: HELP_ES };

export function helpTexts(): HelpTexts {
  return TEXTS[currentLanguage()];
}
