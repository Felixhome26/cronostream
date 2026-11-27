import type { HelpTexts } from "../helpContent";

// Neutral formuliert: Die App spricht den Nutzer nie direkt an (kein du,
// kein Sie) – Anleitungen stehen im Infinitiv, Erklärungen im Passiv oder
// mit „lässt sich“.
export const HELP_DE: HelpTexts = {
  categories: {
    erste: "Erste Schritte",
    start: "Startbildschirm",
    kopfleiste: "Kopfleiste & Werkzeugkasten",
    zeitleiste: "Zeitleiste",
    auswahl: "Auswahl & Sammelbearbeitung",
    detail: "Detailansicht",
    suche: "Suche",
    hinzufuegen: "Hinzufügen",
    datum: "Datum & KI-Datierung",
    verwalten: "Verwalten",
    protokoll: "Protokoll & Rückgängig",
    tagebuch: "Tagebuch & Aufnahmen",
    phasen: "Themenbereiche & Phasen",
    einstellungen: "Einstellungen",
    tastatur: "Tastatur & Maus",
    faq: "Häufige Fragen",
  },
  topics: {
    // ---------- Erste Schritte ----------
    "intro-was": {
      title: "Was ist CronoStream?",
      blocks: [
        {
          p: "CronoStream ordnet Fotos, Videos, Tonaufnahmen, Dokumente, E-Mails und eigene Tagebucheinträge auf einer einzigen waagerechten Zeitleiste – links das Frühere, rechts das Spätere. Ein „Stream“ ist ein Projekt in einem eigenen Ordner. Es lassen sich beliebig viele anlegen, zum Beispiel einer für die Familie und einer nur für Dokumente.",
        },
        {
          list: [
            "**Kopien statt Originale:** Beim Hinzufügen legt CronoStream eine Kopie im Stream-Ordner an. Die Originaldateien werden nie verändert.",
            "**Alles umkehrbar:** Jede Änderung steht im Protokoll und lässt sich zurücknehmen. Entfernte Dateien liegen zuerst im Papierkorb.",
            "**Alles lokal:** Es gibt kein Konto, keine Cloud und keinen Upload. Selbst die KI-Datierung läuft nur über die Zwischenablage. Die einzige Verbindung ins Internet ist die abschaltbare Update-Prüfung (siehe „Über CronoStream“); Dateien und Inhalte verlassen den Rechner nie.",
          ],
        },
      ],
    },
    "intro-erster": {
      title: "Der erste Stream in fünf Schritten",
      blocks: [
        {
          steps: [
            "Auf dem Startbildschirm **Stream erstellen** klicken, einen Namen eingeben und **Speicherort wählen**. CronoStream legt dort einen neuen Ordner an und öffnet ihn.",
            "Dateien hinzufügen: einen Ordner aus dem Dateimanager auf das Fenster ziehen oder auf das goldene **+** klicken und im Dateibrowser Dateien markieren.",
            "Im Prüffenster das erkannte Datum jeder Datei kontrollieren und **Hinzufügen** klicken.",
            "Auf der Zeitleiste mit dem Mausrad zoomen und mit gedrückter Maustaste verschieben. Ein Klick auf eine Kachel öffnet die Detailansicht.",
            "Falsche Daten korrigieren: in der Detailansicht auf den Zeitstempel klicken oder mehrere Dateien gemeinsam über **Bearbeiten** ändern.",
          ],
        },
      ],
    },
    "intro-originale": {
      title: "Was passiert mit den Originaldateien?",
      blocks: [
        {
          p: "Nichts. Beim Hinzufügen wird jede Datei in den Stream-Ordner kopiert, das Original bleibt an seinem Ort unverändert. Datum, Name, Notiz und Drehung ändern nur den Eintrag in CronoStream, nie die Datei auf der Festplatte.",
        },
        {
          p: "Entfernen oder endgültiges Löschen betrifft höchstens die Arbeitskopie im Stream-Ordner. Das Original ist zugleich die Rettungsleine: Fehlt eine Arbeitskopie, holt CronoStream die Datei beim Wiederherstellen von dort zurück.",
        },
      ],
    },
    "intro-hilfe": {
      title: "Wo gibt es Hilfe in der App?",
      blocks: [
        {
          list: [
            "**Hilfe-Center (?) oben rechts:** Der **Schnelleinstieg** zeigt die wichtigsten Themen, **Alle Themen anzeigen** alle Kategorien. Die Suche durchsucht immer alle Themen. Unter einem Thema führen die Links **Siehe auch** zu verwandten Themen.",
            "**Kleine ?-Symbole** neben Bedienelementen zeigen beim Darüberfahren eine Erklärung. Auch die meisten Knöpfe haben einen Tooltip.",
            "**Einmalige Hinweise** erscheinen beim ersten Kontakt mit einer Funktion. **Nicht mehr anzeigen** blendet sie dauerhaft aus.",
          ],
        },
        { p: "Unter dem Suchfeld öffnet **▶ Anleitungsvideos ↗** den Video-Abschnitt der Hilfe-Seite auf felixheck.de im Browser, in der Sprache der Oberfläche." },
        { p: "Das Hilfe-Center schließt sich mit Esc, mit dem × oder durch einen Klick daneben. Die Zeitleiste bleibt dabei sichtbar." },
      ],
    },

    // ---------- Startbildschirm ----------
    "start-anlegen": {
      title: "Neuen Stream anlegen",
      blocks: [
        {
          steps: [
            "Auf **Stream erstellen** klicken.",
            "Einen Namen eingeben, zum Beispiel „Mein Leben“.",
            "**Speicherort wählen** und einen Ordner auswählen. CronoStream legt darin einen neuen Unterordner mit diesem Namen an. Darin liegen die Datenbank, die Vorschaubilder und alle Kopien der Dateien.",
          ],
        },
        { p: "Der neue Stream öffnet sich sofort und ist zunächst leer." },
      ],
    },
    "start-oeffnen": {
      title: "Stream öffnen",
      blocks: [
        {
          list: [
            "**Kachel anklicken:** Unter **Vorhandene Streams** steht für jeden bekannten Stream eine Kachel, der zuletzt geöffnete ganz vorn.",
            "**Stream-Ordner öffnen** (auf dem Startbildschirm neben **Stream erstellen**): öffnet einen Stream-Ordner, der noch nicht in der Liste steht, zum Beispiel von einem USB-Stick oder aus einer Sicherung.",
          ],
        },
        { p: "Während des Öffnens zeigt ein Schleier „Stream wird geöffnet“, bei großen Beständen mit Fortschritt. Der Pfeil ← oben links führt später zurück zum Startbildschirm." },
      ],
    },
    "start-warnungen": {
      title: "Meldungen beim Öffnen",
      blocks: [
        {
          list: [
            "**Stream nicht gefunden:** Der Ordner wurde verschoben oder gelöscht. **Aus Liste entfernen** nimmt den Eintrag aus der Liste. Liegt der Ordner jetzt woanders, lässt er sich über **Stream-Ordner öffnen** neu öffnen.",
            "**Stream wurde verschoben:** Der Ordner wurde von Hand verschoben oder kopiert, oder er liegt auf einem Laufwerk unter einem anderen Pfad (anderer Laufwerksbuchstabe, Stick an einem anderen Rechner). **Pfade anpassen** richtet ihn auf den neuen Ort aus; vorher legt die App eine Kopie der Datenbank im Stream-Ordner ab („cronostream.db.vor-pfadanpassung-…“). **Abbrechen** öffnet ihn wie bisher.",
            "**Unsauber beendet:** CronoStream wurde beim letzten Mal nicht richtig geschlossen, etwa durch einen Absturz. **Trotzdem öffnen** ist in der Regel unbedenklich.",
            "**Bereits geöffnet:** Der Stream ist in einem anderen Fenster offen und muss dort zuerst geschlossen werden. Nur wenn sicher ist, dass er nirgends mehr wirklich offen ist (z. B. nach einem Absturz), hilft **Alle Instanzen schließen und weiter**.",
          ],
        },
      ],
    },
    "start-kachel": {
      title: "Das Menü auf einer Stream-Kachel",
      blocks: [
        { p: "Ein Klick auf die Kachel öffnet den Stream. Die Zahl auf der Kachel nennt die Dateien darin. Ein Standard-Abzeichen markiert den Standard-Stream. Das Menü **⋯** (Weitere Aktionen) bietet:" },
        {
          list: [
            "**Öffnen:** wie ein Klick auf die Kachel.",
            "**Umbenennen:** ändert nur den angezeigten Namen, der Ordner auf der Festplatte behält seinen Namen.",
            "**Als Standard-Stream festlegen** bzw. **Standard-Stream aufheben:** Der Standard-Stream wird beim nächsten Start der App automatisch geöffnet, und zwar nur beim App-Start, nicht nach dem Zurück-Pfeil oder einem Sprachwechsel. Es kann nur einen geben. Lässt er sich nicht öffnen (Ordner fehlt, Laufwerk nicht eingehängt, in einem anderen Fenster offen), bleibt der Startbildschirm mit einem Hinweis stehen.",
            "**Aus Liste entfernen:** Der Ordner bleibt unberührt und lässt sich jederzeit über **Stream-Ordner öffnen** wieder hinzufügen.",
            "**Endgültig löschen…:** löscht den ganzen Stream von der Festplatte, mit zwei Rückfragen.",
          ],
        },
        { p: "Das Suchfeld über den Kacheln erscheint erst ab 11 Streams. Bei vielen Streams scrollt nur die Kachelliste, nicht die ganze Seite." },
      ],
    },
    "start-duplizieren": {
      title: "Kopie eines Streams anlegen",
      blocks: [
        { p: "Eine eigene Duplizieren-Funktion gibt es nicht mehr. Eine Kopie entsteht über die Datei-Operationen:" },
        {
          steps: [
            "Den Stream öffnen und 🛠 **Verwalten** › **Datei-Operationen** wählen.",
            "Mit Strg+A alle Dateien markieren.",
            "**In anderen Stream einfügen** (bzw. kopieren) wählen und im Zieldialog **＋ Neuen Stream anlegen**: Name und Speicherort eingeben, der neue Stream dient gleich als Ziel.",
          ],
        },
        { p: "Als vollständige Sicherung mit Zeitstempel dient **Sicherung erstellen** unter 🛠 **Verwalten** › **Sicherung**. Das Original bleibt in beiden Fällen unverändert." },
      ],
    },
    "start-loeschen": {
      title: "Stream löschen",
      blocks: [
        {
          steps: [
            "Im Menü **⋯** der Kachel **Endgültig löschen…** wählen. CronoStream prüft den Ordner und zeigt Name, Dateizahl und Größe. Liegen fremde Dateien im Ordner, die nicht zum Stream gehören, werden sie namentlich aufgeführt, denn sie würden mitgelöscht.",
            "Über **Protokoll behalten** entscheiden (ab Werk an): Dann wird die Datenbank gesichert, bevor der Ordner gelöscht wird, und der Stream lässt sich später wiederherstellen. Ohne Haken ist das Löschen endgültig.",
            "**Weiter** und im zweiten Dialog **Endgültig löschen** bestätigen. Der Knopf ist einige Sekunden gesperrt, damit ihn kein versehentlicher Doppelklick auslöst.",
          ],
        },
        { note: "Der Stream-Ordner wird wirklich von der Festplatte gelöscht, um Platz freizugeben. Originaldateien außerhalb des Ordners bleiben unberührt." },
      ],
    },
    "start-wiederherstellen": {
      title: "Gelöschten Stream oder Sicherung wiederherstellen",
      blocks: [
        { p: "Beides liegt unter dem unauffälligen Link **Wiederherstellen & Papierkorb…** unten auf dem Startbildschirm." },
        { p: "**Gelöschter Stream**" },
        {
          steps: [
            "Link öffnen und **Gelöschte Streams** wählen. Dort steht jeder Stream, der mit **Protokoll behalten** gelöscht wurde, mit Löschdatum und der Zahl der noch verfügbaren Dateien.",
            "**Wiederherstellen** klicken, einen Namen eingeben und **Speicherort wählen und wiederherstellen**.",
          ],
        },
        { p: "CronoStream liest die Dateien erneut aus ihren ursprünglichen Quellordnern ein. Namen, Daten, Notizen, Drehungen und der ganze Verlauf kehren zurück. Ein Bericht nennt Quellen, die sich seitdem geändert haben oder fehlen. Dateien ohne Quelle behalten ihren Verlauf, erscheinen aber nicht auf der Zeitleiste." },
        { p: "**Verwerfen** löscht das gesicherte Protokoll endgültig. Danach ist keine Wiederherstellung mehr möglich." },
        { p: "**Sicherung**" },
        {
          steps: [
            "Link öffnen und **Aus Sicherung wiederherstellen** wählen.",
            "Den Sicherungsordner wählen, einen Namen eingeben und einen Speicherort wählen.",
          ],
        },
        { p: "CronoStream legt eine vollständige, unabhängige Kopie der Sicherung an und öffnet sie anschließend. Die Sicherung bleibt unverändert." },
      ],
    },

    // ---------- Kopfleiste & Werkzeugkasten ----------
    "kopf-symbole": {
      title: "Was bedeuten die Symbole in der Kopfleiste?",
      blocks: [
        {
          keys: [
            ["←", "Zurück zum Startbildschirm"],
            ["+", "Dateien hinzufügen: öffnet den Dateibrowser im Bereich **Hinzufügen** (wie der große goldene Knopf unten rechts)"],
            ["📥", "Öffnet das kleine **Ablage**-Fenster zum Sammeln von Dateien"],
            ["✨", "**Prüfen**: KI-Datierung"],
            ["🛠", "**Verwalten**: Datei-Operationen, Protokoll, Duplikate, Papierkorb, Sicherung"],
            ["🔍", "Suche ein- und ausblenden (Strg+F)"],
            ["🎬 / 🎙️", "Video bzw. Audio aufnehmen"],
            ["Tagebuch", "Neuer Tagebucheintrag mit der aktuellen Uhrzeit"],
            ["Themenbereiche", "Themenbereiche und Phasen verwalten"],
            ["⚙", "Einstellungen"],
            ["?", "Dieses Hilfe-Center"],
            ["☕", "Kaffee spendieren: öffnet die Spendenseite im Browser"],
            ["⤢ / ⤡", "Vollbild ein / aus"],
          ],
        },
        { p: "Liegen Dateien in der Warteliste, erscheint unten rechts neben dem großen + ein runder Knopf **Abgelegte Dateien** mit Zähler." },
        { p: "Ganz links unten steht das Augensymbol des **Privatmodus**, sobald dieser eingerichtet ist: Auge = alle Dateien sichtbar, durchgestrichenes Auge = private Dateien ausgeblendet. In ⚙ › Privatsphäre lässt es sich abschalten." },
      ],
    },
    "kopf-statistik": {
      title: "Statistikzeile und Name",
      blocks: [
        { p: "Neben dem Zurück-Pfeil steht der Name des geöffneten Streams. Umbenennen lässt er sich auf dem Startbildschirm (Stift auf der Kachel). In der Mitte zeigt die Statistikzeile, wie viele Bilder, Videos, Audios, Dokumente und sonstige Dateien der Stream enthält und wie viel Speicher er belegt." },
      ],
    },
    "kopf-vollbild": {
      title: "Vollbild",
      blocks: [
        { p: "⤢ ganz rechts schaltet in den Vollbildmodus, ⤡ zurück. Esc verlässt den Vollbildmodus jederzeit, auf jedem Bildschirm." },
        { note: "Esc schließt zugleich die oberste offene Ebene (z. B. Detailansicht oder Suche). Im Vollbild beendet ein Esc deshalb oft beides auf einmal." },
      ],
    },
    "kopf-werkzeugkasten": {
      title: "Der Werkzeugkasten (Dateibrowser)",
      blocks: [
        { p: "+, ✨, 🛠 und ⚙ öffnen dieselbe Vollbild-Ebene über der Zeitleiste, jeweils in einem anderen Bereich. Links steht die Auswahl der Bereiche, oben die der Reiter. Die linke Leiste lässt sich ein- und ausklappen." },
        {
          list: [
            "**Hinzufügen:** Übersicht, Einzelbild, Festplatte durchsuchen, Liste importieren",
            "**Prüfen:** Datum per KI korrigieren",
            "**Verwalten:** Datei-Operationen, Protokoll, Duplikate, Papierkorb, Sicherung",
            "**Einstellungen:** alle Einstellungen und „Über CronoStream“",
          ],
        },
        { p: "**✓ Fertig** oben rechts schließt den Werkzeugkasten. Zoom und Position der Zeitleiste bleiben dabei erhalten." },
      ],
    },
    "kopf-peek": {
      title: "Mini-Vorschau der Zeitleiste (Peek)",
      blocks: [
        { p: "In den Datei-Operationen schwebt unten links eine kleine Vorschau der Zeitleiste. In welchen weiteren Ansichten sie erscheint, lässt sich unter ⚙ › **Zeitleiste & Spuren** › **Mini-Vorschau der Zeitleiste** je Ansicht festlegen. Ein Klick darauf blendet den Werkzeugkasten aus und gibt den Blick auf die echte Zeitleiste frei. Die Pille **Zurück zu…** führt mit allem Zustand in den zuletzt aktiven Reiter zurück." },
        { p: "Vorschau und Pille lassen sich mit der Maus verschieben. Die Vorschau lässt sich außerdem verkleinern oder ausblenden." },
      ],
    },

    // ---------- Zeitleiste ----------
    "zl-bewegen": {
      title: "Zoomen und bewegen",
      blocks: [
        {
          list: [
            "**Zoomen:** Mausrad, ohne Zusatztaste. Das Datum unter dem Mauszeiger bleibt dabei an seiner Stelle.",
            "**Bewegen:** mit gedrückter linker Maustaste ziehen. Eine Scrollleiste gibt es bewusst nicht.",
            "**Bereich:** von der Gesamtansicht (der ganze Stream passt ins Fenster, so startet er auch) bis zur einzelnen Stunde.",
          ],
        },
        { p: "Zu einem bestimmten Datum führen die Suche (Zeitraum) oder ein Klick auf einen Phasenbalken. Zoom und Position bleiben erhalten, solange im Werkzeugkasten gearbeitet wird." },
      ],
    },
    "zl-beschriftung": {
      title: "Die Beschriftung über den Spuren",
      blocks: [
        { p: "Die Zeile oben wechselt mit dem Zoom: in der Gesamtansicht Jahreszahlen, dann Monate, Wochen, Tage und schließlich Stunden. Auf Tagesebene ist Mitternacht mit Datum und einer kräftigeren Linie markiert. Am linken Rand bleibt die aktuelle Periode angeheftet (z. B. „Mai 2012“). Schmale Tagesspalten (unter 110 px) tragen nur die Tageszahl." },
        { p: "In der Gesamtansicht öffnet ein Klick auf eine Jahreszahl alle Dateien dieses Jahres als Cluster. Ebenso öffnen Monate, Wochen und Tage in der Zeile darüber einen Cluster mit allen Dateien des Zeitraums (nicht die Beschriftungen der Tagesansicht mit Stundenraster). Zeiträume ohne Datei sind nicht klickbar, anklickbare werden beim Überfahren unterstrichen; Ziehen an einer Beschriftung verschiebt nur die Zeitleiste." },
      ],
    },
    "zl-spuren": {
      title: "Spuren: Dokumente, Bilder, Videos, Audios",
      blocks: [
        { p: "Jede Dateiart hat eine eigene waagerechte Spur. E-Mails, Tagebucheinträge und sonstige Dateien laufen in der Dokumente-Spur mit. Eine Spur erscheint nur, wenn der Stream Dateien dieser Art enthält. Mit dem ersten Video wächst die Videospur dazu." },
        { p: "Die vorhandenen Spuren teilen sich die Höhe. Je weniger Spuren es gibt, desto größer werden die Kacheln. Die Reihenfolge wird in den Einstellungen festgelegt (**Spuren-Reihenfolge & Sichtbarkeit**)." },
      ],
    },
    "zl-kacheln": {
      title: "Was die Kacheln zeigen",
      blocks: [
        {
          list: [
            "**Bilder und Videos:** Vorschaubild, beim Darüberfahren das Datum.",
            "**Dokumente und PDFs:** zunächst ein Symbol, beim Darüberfahren die Seitenvorschau.",
            "**Audio:** Audio-Bild mit Dateinamen.",
            "**E-Mails:** Brief-Symbol mit Absender und Datum, beim Darüberfahren Absender und Empfänger.",
            "**Tagebucheinträge:** Tagebuch-Bild mit der ersten Textzeile, dem Datum und ggf. einer Büroklammer mit der Zahl der Anhänge. Der Stift auf der Kachel öffnet den Eintrag direkt zum Bearbeiten.",
          ],
        },
        { p: "Die Kacheln sind in der Fenstermitte am größten und werden zum Rand hin kleiner (Lupen-Effekt). Die Kachel unter dem Mauszeiger wird vergrößert. Ein Klick öffnet die Detailansicht, bei einem Stapel siehe „Stapel“." },
      ],
    },
    "zl-stapel": {
      title: "Stapel: viele Dateien auf engem Raum",
      blocks: [
        { p: "Liegen Dateien einer Spur so dicht beieinander, dass sich ihre Kacheln überlappen würden, fasst CronoStream sie zu einem Stapel zusammen: bis zu drei versetzte Kacheln mit einem goldenen Zählkreis. Beim Hineinzoomen teilen sich Stapel auf, beim Herauszoomen verschmelzen sie wieder. Die Kacheln behalten dabei ihre Größe: Sie bleiben so lange in den gröberen Spalten, bis eine Spalte des feineren Rasters (Monate, Tage, Stunden) so breit ist wie eine Kachel; erst dann werden Stapel an den feinen Linien getrennt. Das neue Raster erscheint zunächst zart und wird beim Hineinzoomen kräftiger." },
        {
          list: [
            "**Zeigen (nur mit Auslöser Hover):** Ruht der Mauszeiger kurz auf einem Stapel, klappt er auf: oben die große Vorschau, darunter alle Dateien des Stapels als Raster. Beim Überfahren einer kleinen Kachel wechselt die Vorschau.",
            "**Klick (ab Werk):** klappt den Stapel auf: oben die große Vorschau, darunter alle Dateien als Raster. Ist in den Einstellungen „In Zeitleiste hineinzoomen“ gewählt, zoomt der Klick stattdessen so weit hinein, bis sich der Stapel in Einzelkacheln auflöst; geht das nicht, weil die Dateien zu dicht liegen, klappt der Stapel auf.",
            "**Im aufgeklappten Stapel:** Klick auf eine Kachel öffnet die Detailansicht, Strg-Klick markiert sie. Esc oder ein Klick auf den freien Hintergrund schließt den Stapel.",
          ],
        },
        { p: "Auslöser, Aktion und Zoom-Bremse werden in den Einstellungen unter **Stapel & Zoom** festgelegt." },
      ],
    },
    "zl-cluster": {
      title: "Temporäre Cluster",
      blocks: [
        { p: "Ein Cluster ist eine Ansicht auf eine Auswahl von Dateien: abgedunkelter Hintergrund, Überschrift mit Anzahl, große Vorschau und darunter das Kachelraster. Die Kästchen Dokumente, Bilder, Videos, Audios filtern nach Typ. Die Bedienung ist dieselbe wie im aufgeklappten Stapel. Esc, das ✕ oder ein Klick auf den freien Hintergrund schließt ihn." },
        {
          list: [
            "**Zeitraum:** Klick auf eine Jahreszahl, einen Monat, eine Woche oder einen Tag in der Beschriftung über den Spuren",
            "**Suchergebnisse:** **Ergebnisse ansehen** in der Suche",
            "**Gleiche Notiz:** **Alle mit dieser Notiz** in der Detailansicht",
            "**Tagebuch-Anhänge:** **Dateien anzeigen** in einem Tagebucheintrag",
          ],
        },
        { p: "Wird aus einem Cluster die Detailansicht geöffnet, blättern die Pfeiltasten nur durch die Dateien dieses Clusters. Nach Esc erscheint wieder der Cluster." },
      ],
    },
    "zl-rechtsklick": {
      title: "Rechtsklick auf eine Kachel",
      blocks: [
        {
          list: [
            "**N Bearbeiten** (nur bei bestehender Auswahl): übergibt die markierten Dateien an die Datei-Operationen",
            "**In Standard-App öffnen**",
            "**Datei im Stream-Ordner anzeigen** / **Datei im Quellordner anzeigen** (ausgegraut, wenn das Original nicht mehr existiert)",
            "Bei Bildern: **90° nach links/rechts drehen**, **180° drehen**. Das dreht nur die Anzeige, die Datei bleibt unverändert.",
            "**In anderen Stream einfügen**: legt die Datei auf die Warteliste eines anderen Streams",
            "**Entfernen**: nimmt die Datei aus dem Stream (in den Papierkorb)",
          ],
        },
        { p: "Bei Tagebucheinträgen enthält das Menü nur **Bearbeiten** und **Entfernen**." },
      ],
    },
    "zl-rechtsklick-frei": {
      title: "Rechtsklick auf eine freie Stelle",
      blocks: [
        {
          list: [
            "**Tagebucheintrag hier hinzufügen:** neuer Eintrag mit dem Datum der Klickstelle, also auch rückwirkend",
            "**Aus Zwischenablage einfügen** (nur wenn ein Bild in der Zwischenablage liegt): fragt, ob das Bild als normale Bilddatei oder als Tagebucheintrag hinzugefügt werden soll, jeweils mit dem Datum der Klickstelle",
          ],
        },
      ],
    },
    "zl-datum-ziehen": {
      title: "Datum durch Verschieben einer Kachel ändern",
      blocks: [
        { p: "Ist in den Einstellungen **Datum durch Verschieben von Kacheln ändern** eingeschaltet, lässt sich eine Kachel waagerecht an ihre richtige Stelle ziehen. Beim Loslassen berechnet CronoStream das Datum aus der Position. Wie genau das wird, hängt vom Zoom ab; für eine genaue Uhrzeit weit hineinzoomen." },
        { p: "Ab Werk ist das aus, damit nichts versehentlich verschoben wird. Dann verschiebt Ziehen auf einer Kachel die ganze Zeitleiste. Jede Änderung steht im Protokoll." },
      ],
    },
    "zl-ohne-datum": {
      title: "Warnung „Dateien ohne lesbares Datum“",
      blocks: [
        { p: "Dateien, deren Datum nicht gelesen werden kann, erscheinen nicht auf der Zeitleiste. Stattdessen steht oben links ein Warnhinweis mit ihrer Anzahl. In den Datei-Operationen (Verwalten) sind sie zu finden und bekommen dort ein Datum." },
        { p: "Beim Öffnen eines großen Streams zeigt „Stream wird geladen…“ den Fortschritt. Danach erscheinen die Vorschaubilder nach und nach, sobald ihr Bereich der Zeitleiste sichtbar wird." },
      ],
    },
    "zl-leer": {
      title: "Was ist zu sehen, solange ein Stream leer ist?",
      blocks: [
        { p: "Ein Bild mit dem Text „Noch ist hier nichts.“ Weiter geht es, indem Dateien auf das Fenster gezogen werden, mit einem Klick auf das goldene **+** im Text oder mit einer Aufnahme über 🎬 / 🎙️." },
      ],
    },

    // ---------- Auswahl ----------
    "auswahl-markieren": {
      title: "Mehrere Dateien auf der Zeitleiste markieren",
      blocks: [
        {
          list: [
            "**Strg-Klick** (Mac: Cmd-Klick) auf eine Kachel markiert sie, ohne sie zu öffnen. Markierte Kacheln tragen einen goldenen Ring. Auf der Zeitleiste markiert Strg-Klick auf einen Stapel den ganzen Stapel; im aufgeklappten Stapel oder Cluster lassen sich einzelne Kacheln markieren.",
            "**Strg+A** markiert alle sichtbaren Kacheln der Zeitleiste. In einem Cluster oder aufgeklappten Stapel markiert es dessen Inhalt (nach Typfilter), ein zweites Strg+A hebt das wieder auf.",
            "**Esc** oder das ✕ in der Auswahlleiste hebt die Auswahl auf.",
          ],
        },
        { p: "Unten in der Mitte erscheint dann eine Leiste „N ausgewählt“ mit dem Knopf **Bearbeiten**." },
      ],
    },
    "auswahl-bearbeiten": {
      title: "„Bearbeiten“: Auswahl an die Datei-Operationen übergeben",
      blocks: [
        { p: "**Bearbeiten** in der Auswahlleiste (oder **N Bearbeiten** im Rechtsklick-Menü) öffnet die Datei-Operationen im Bereich Verwalten, beschränkt auf genau diese Dateien, alle bereits markiert. Dort stehen alle Sammelaktionen bereit: Datum ändern, an die KI übergeben, Notiz hinzufügen, in einen anderen Stream kopieren oder verschieben, Druckexport, Pfadliste, Entfernen." },
      ],
    },
    "auswahl-beispiel": {
      title: "Beispiel: eine gemeinsame Notiz für ein Ereignis",
      blocks: [
        {
          steps: [
            "Zu den Dateien zoomen, die zusammengehören, z. B. ein Geburtstag, der über mehrere Stapel verteilt ist.",
            "Alle Dateien mit Strg-Klick markieren.",
            "**Bearbeiten** klicken. Die Datei-Operationen öffnen sich mit genau diesen Dateien.",
            "**Aktionen** › **Notiz hinzufügen…** wählen, z. B. „Omas 80. Geburtstag“ eingeben und **Hinzufügen** klicken.",
          ],
        },
        { p: "Ab jetzt findet die Suche alle diese Dateien. Ist eine davon in der Detailansicht geöffnet, zeigt **Alle mit dieser Notiz (N)** alle zusammen als Cluster, egal wie weit sie auf der Zeitleiste verstreut sind." },
      ],
    },

    // ---------- Detailansicht ----------
    "detail-oeffnen": {
      title: "Detailansicht öffnen, blättern und schließen",
      blocks: [
        { p: "Ein Klick auf eine Einzelkachel, auf eine Kachel im Stapel oder Cluster oder ein Doppelklick auf einen Suchtreffer öffnet die Detailansicht." },
        {
          list: [
            "**Blättern:** Pfeiltasten ←/→ oder die runden Pfeilknöpfe, in zeitlicher Reihenfolge über die ganze Zeitleiste. Welche Dateiarten dabei durchlaufen werden, legt die Einstellung **Navigation in der Detailansicht** fest. Aus einem Cluster heraus bleibt das Blättern in dessen Dateien.",
            "**Filter-Symbol oben links:** öffnet ein kleines Fenster, in dem sich die Dateitypen (Bilder, Videos, Audio, Dokumente, Alle) für das Blättern live umschalten lassen. Der Typ der aktuellen Datei bleibt dabei eingeschaltet. Die Auswahl gilt nur bis zum Schließen der Detailansicht; die Einstellung **Navigation in der Detailansicht** bleibt der Startwert. Im Such-Cluster gibt es das Symbol nicht.",
            "**Schließen:** Esc, das ✕ oben rechts oder ein Klick neben die Karte. Die Zeitleiste springt dann zur zuletzt angesehenen Datei, die Kachel leuchtet kurz auf; sie liegt dabei oben auf ihrem Stapel. Liegt der Startpunkt außer Sicht, erscheint links neben der Kachel ein Chip „↩ Zurück zu <Monat Jahr>“ (oder Esc), der zur alten Ansicht samt Cluster-Raster zurückführt. Wurde innerhalb eines Cluster-Rasters geblättert, führt das Schließen wie bisher ins Raster zurück.",
            "**Rechtsklick auf das Medium:** dasselbe Menü wie auf der Zeitleiste.",
          ],
        },
        { p: "Unter dem Medium stehen Name, Zeitstempel, Entfernen-Knopf, Notizfeld und eine Infozeile mit Größe sowie Erstellt-/Geändert-Datum." },
      ],
    },
    "detail-bild": {
      title: "Bilder vergrößern und verschieben",
      blocks: [
        { p: "Mausrad nach oben (oder +) lässt das Bild aus der Karte „ausbrechen“: Es füllt die Fensterhöhe, alles andere verschwindet. Weiteres Drehen am Rad oder jedes weitere + zoomt bis zum Sechsfachen, Ziehen verschiebt das Bild." },
        { p: "Zurück geht es mit Mausrad nach unten, −, Esc oder einem Klick neben das Bild." },
      ],
    },
    "detail-player": {
      title: "Video und Audio abspielen",
      blocks: [
        { p: "Videos und Audios starten von selbst im eingebauten Player. Er hat Wiedergabe/Pause, eine Zeitleiste zum Springen, ±10 Sekunden, Lautstärke und Stummschalten, Wiedergabegeschwindigkeit von 0,5× bis 2× und bei Videos einen Vollbild-Knopf." },
        { p: "Spielt der Player ein Format nicht ab (alte WMA, WMV, DivX-AVI, Cinepak/Indeo, GSM- oder ADPCM-WAV, AMR u. a.), meldet er „Format wird für die Wiedergabe umgewandelt…“. Die Datei wird einmalig mit ffmpeg nach WebM (VP9/Opus) umgewandelt und die Kopie abgespielt. Die Kopien liegen im Cache-Ordner des Rechners (höchstens 2 GB), das Original im Stream bleibt unverändert." },
      ],
    },
    "detail-dokumente": {
      title: "Dokumente, PDFs und E-Mails",
      blocks: [
        {
          list: [
            "**PDFs und Dokumente:** Vorschau bzw. der ausgelesene Text, dazu **In Standard-App öffnen**. Ließ sich kein Text lesen, steht das dort.",
            "**E-Mails (.eml, Outlook-.msg):** Kopf mit Betreff, Von, An, Cc und Datum, darunter der Text. Rechts stehen unter **Anhänge** alle Anhänge mit Größe. Ein Klick öffnet einen Anhang im Standardprogramm. In die Mail eingebettete Bilder (im HTML oder als Anhang, auf den der Text verweist) werden angezeigt, höchstens 25 MB je Mail. Bilder aus dem Internet bleiben gesperrt. Links im Text (Webadressen, E-Mail-Adressen, Telefonnummern) öffnen sich beim Klick im Standardprogramm, Webseiten also im Browser.",
            "**Sonstige Dateien:** Name und **In Standard-App öffnen**. Ist die Datei ein Programm oder Skript (.exe, .bat, .sh, .desktop, .lnk …), fragt vorher ein Dialog, ob sie wirklich geöffnet werden soll. Das gilt für alle Stellen, an denen Dateien extern geöffnet werden (Zeitleiste, E-Mail- und Tagebuch-Anhänge, Dateibrowser).",
            "**Tagebucheinträge** öffnen ihren eigenen Dialog.",
          ],
        },
      ],
    },
    "detail-zeitstempel": {
      title: "Datum und Uhrzeit einer Datei ändern",
      blocks: [
        { p: "Die Pille mit Datum und Uhrzeit in der Detailansicht anklicken. Sie wird zur Datumseingabe; Enter übernimmt, Esc bricht ab. Daneben zeigt ein Abzeichen, woher das Datum stammt: Metadaten, Dateiname, Erstellt, Geändert, Eigenes Datum, Von KI übernommen oder Aufgenommen." },
        { p: "Geändert wird nur der Zeitstempel in CronoStream, die Datei auf der Festplatte bleibt unverändert. Die Änderung steht im Protokoll." },
        { p: "Ob Datum und Uhrzeit zusätzlich dezent über dem Bild stehen, regelt die Einstellung **Zeitstempel im Bild einblenden**." },
      ],
    },
    "detail-name-notiz": {
      title: "Name und Notiz",
      blocks: [
        { p: "**Name:** In das Namensfeld klicken, ändern und mit Enter oder **Bestätigen** speichern (Esc bricht ab). Das ändert nur den Anzeigenamen in CronoStream, nicht den Dateinamen auf der Festplatte." },
        { p: "**Notiz:** Text ins Feld „Notiz zu dieser Datei…“ schreiben. Die Notiz speichert sich automatisch, kurz nach dem letzten Tastendruck, beim Weiterblättern und beim Schließen. Die Suche findet Notizen." },
        { p: "**Alle mit dieser Notiz (N):** Haben mindestens zwei Dateien exakt denselben Notiztext, erscheint dieser Knopf. Er öffnet alle diese Dateien als Cluster." },
      ],
    },
    "detail-entfernen": {
      title: "Dateien in der Detailansicht aussortieren",
      blocks: [
        { p: "Der rote Knopf **Entfernen** oder die Entf-Taste nimmt die Datei aus dem Stream und zeigt sofort die nächste. So lässt sich ein Bestand in Minuten aussortieren. Die entfernten Dateien liegen im Papierkorb und lassen sich dort oder im Protokoll zurückholen." },
        { note: "Ist **Arbeitskopie beim Entfernen löschen** eingeschaltet, fragt CronoStream vorher nach: Arbeitskopie und Eintrag werden dann sofort endgültig gelöscht." },
      ],
    },
    "detail-herausziehen": {
      title: "Dateien in andere Programme ziehen",
      blocks: [
        { p: "Das Medium in der Detailansicht mit gedrückter Maustaste in ein anderes Programm ziehen, etwa in eine E-Mail oder einen Dateimanager. Dort entsteht eine Kopie. Im vergrößerten Bild verschiebt Ziehen das Bild; zum Herausziehen dort zusätzlich Alt gedrückt halten." },
      ],
    },

    // ---------- Suche ----------
    "suche-bedienen": {
      title: "Suchen",
      blocks: [
        { p: "🔍 in der Kopfleiste oder Strg+F öffnet die Suchleiste über der Zeitleiste. Die Suche startet kurz nach dem letzten Tastendruck, Groß- und Kleinschreibung spielen keine Rolle." },
        {
          list: [
            "**Durchsucht werden:** Anzeige- und Originalname, der Text von PDFs, Dokumenten, E-Mails und Tagebucheinträgen, alle Notizen und die Dateinamen von Tagebuch-Anhängen.",
            "**Zeitraum:** Der Schalter **Zeitraum** blendet die Felder von/bis ein. Text und Zeitraum lassen sich kombinieren oder einzeln nutzen.",
            "**Letzte Suchen:** Ein Klick ins leere Suchfeld, auf ▾ oder die Taste ↓ klappt die Liste der letzten 50 Suchen dieses Streams auf (8 sichtbar, mit Mausrad oder Pfeiltasten scrollbar). Klick oder Enter übernimmt Suchtext und Filter, × entfernt einen Eintrag, **Verlauf leeren** alle. Strg+F allein öffnet die Liste nicht.",
            "**Schließen:** das ✕ der Suchleiste, 🔍 oder Esc.",
          ],
        },
      ],
    },
    "suche-ergebnisse": {
      title: "Treffer ansehen und durchgehen",
      blocks: [
        { p: "Treffer-Kacheln bekommen einen goldenen Ring, der aktuelle einen leuchtenden. Alles andere wird abgedunkelt. Der Zähler zeigt z. B. „3/12“." },
        {
          list: [
            "**Enter / Umschalt+Enter** oder die Pfeilknöpfe springen zum nächsten bzw. vorherigen Treffer. Die Zeitleiste fährt hin und zoomt so weit hinein, dass der Treffer nicht in einem Stapel versteckt bleibt.",
            "**Trefferliste** unter der Leiste: Klick zeigt den Treffer auf der Zeitleiste, Doppelklick öffnet ihn. Bei offenem Cluster ist die Liste ausgeblendet.",
            "**Ergebnisse ansehen** öffnet alle Treffer als Cluster. Ändert sich die Suche, folgt der Cluster. In der Detailansicht bleiben die Pfeiltasten dann in den Suchergebnissen.",
          ],
        },
      ],
    },

    // ---------- Hinzufügen ----------
    "add-wege": {
      title: "Alle Wege, Dateien hinzuzufügen",
      blocks: [
        {
          list: [
            "**Auf das Fenster ziehen:** Dateien oder Ordner aus dem Dateimanager auf das Hauptfenster ziehen.",
            "**Ablage-Fenster (📥):** ein kleines Fenster zum Sammeln, das immer im Vordergrund bleibt.",
            "**Dateibrowser (+):** Ordner durchsehen und markieren (Übersicht, Einzelbild), die Festplatte durchsuchen oder eine Pfadliste importieren.",
            "**Zwischenablage:** Strg+V auf der Zeitleiste oder Rechtsklick › **Aus Zwischenablage einfügen**.",
            "**Neu erzeugen:** Tagebucheinträge und Video-/Audioaufnahmen.",
            "**Aus einem anderen Stream:** **In anderen Stream einfügen** oder Kopieren/Verschieben in den Datei-Operationen.",
          ],
        },
        { p: "Immer wird eine Kopie im Stream-Ordner angelegt, das Original bleibt unberührt." },
      ],
    },
    "add-drop": {
      title: "Dateien auf das Hauptfenster ziehen",
      blocks: [
        { p: "Sobald Dateien über das Fenster gezogen werden, erscheint ein Schleier mit „Loslassen, um die Dateien einzufügen“. Ordner werden in ihre Dateien aufgelöst, versteckte Dateien übersprungen. Danach öffnet sich das Prüffenster **Abgelegte Dateien**. **E-Mails** lassen sich auch direkt aus dem Mailprogramm ziehen, ebenso ins Ablage-Fenster und in einen Tagebucheintrag: unter Windows Mails und Anhänge aus Outlook (klassisch), mehrere zusammen aus Evolution gezogene Mails werden in einzelne E-Mails aufgeteilt. Solche Dateien liegen vorübergehend in den lokalen App-Daten (Ordner „dropped_files“) und werden nach dem Hinzufügen oder Entfernen aus der Ablage gelöscht. Lässt sich aus dem Gezogenen nichts übernehmen, erscheint eine Meldung." },
      ],
    },
    "add-pruefen": {
      title: "Das Prüffenster „Abgelegte Dateien“",
      blocks: [
        { p: "Hier landen alle Dateien der Warteliste, egal ob sie auf das Hauptfenster gezogen, im Ablage-Fenster gesammelt oder aus einem anderen Stream geschickt wurden. Jede Kachel zeigt ein Vorschaubild." },
        {
          list: [
            "**Datum-Auswahl unter jeder Kachel:** alle gefundenen Datumskandidaten, z. B. „(Metadaten)“, „(Dateiname)“, „(Erstellt)“, „(Geändert)“. Die beste Quelle ist vorausgewählt.",
            "**E-Mail-Kacheln** zeigen Betreff, Absender und Maildatum.",
            "**Kreuz an der Kachel:** nimmt die Datei von der Warteliste. Auf der Festplatte passiert nichts.",
            "**Liste leeren:** nimmt alle Dateien auf einmal von der Warteliste. Auch hier bleiben die Dateien auf der Festplatte unberührt.",
            "**Mögliches Duplikat:** eine Vergleichskarte mit „Bereits im Stream“ und „Neu abgelegt“ nebeneinander. Einzeln verwerfen oder **Alle Duplikate verwerfen**.",
            "**Datei nicht gefunden:** Die Datei wurde inzwischen verschoben oder gelöscht und kann nicht hinzugefügt werden.",
          ],
        },
        { p: "Unten lassen sich optional **Datumsangaben von Hand prüfen / korrigieren** und/oder **Nach dem Import Datumsangaben mit KI prüfen** anhaken; **Hinzufügen (N)** übernimmt die Dateien. Beim Schließen meldet CronoStream, wie viele Dateien hinzugekommen sind." },
      ],
    },
    "add-ablage": {
      title: "Das Ablage-Fenster (📥)",
      blocks: [
        { p: "📥 öffnet ein kleines Fenster, das immer im Vordergrund bleibt. Beim Stöbern im Dateimanager lassen sich Fundstücke hineinziehen, ohne sich um Datum oder Prüfung zu kümmern. Sie stehen dort mit Symbol und Namen, ein Zähler zeigt „N wartend“. Fehlt eine Datei inzwischen, wird ihre Zeile durchgestrichen. Das × an einer Zeile entfernt sie aus der Ablage, **Liste leeren** (unten) entfernt alle Einträge auf einmal. Die Dateien auf der Festplatte bleiben dabei unberührt." },
        { p: "Das **−** neben dem Schließen-Kreuz verkleinert die Ablage zu einem kleinen Kreis mit dem Stream-Symbol und der Zahl der wartenden Dateien. Dateien lassen sich auch auf den Kreis ziehen. Ein Doppelklick stellt die normale Ansicht wieder her." },
        { p: "Das Fenster hat keine Systemleiste. Verschoben wird es an der oberen Leiste mit Logo und Titel, der Kreis lässt sich überall ziehen." },
        { p: "Die Ablage läuft auch ohne Hauptfenster. Im Linux-AppImage und in der installierten Windows-Version gibt es auf Wunsch einen Startmenü-Eintrag nur für die Ablage, und sie öffnet sich beim Systemstart (⚙ › **System & Sprache** › **Start**, siehe „Start: Willkommen, Startmenü und Autostart“). Mit dem Parameter --ablage startet das Programm nur mit der Ablage. Ein zweiter Start landet in dem schon laufenden Programm, statt ein zweites zu öffnen: mit --ablage zeigt er den Kreis, sonst das Hauptfenster." },
        { p: "Ohne Hauptfenster liegt die Ablage als Symbol im Systemtray und braucht kaum Arbeitsspeicher. Ein Linksklick auf das Symbol öffnet den Kreis, das Menü bietet **Ablage öffnen** und **Beenden**. Ein Rechtsklick auf den Kreis oder sein ✕ legt ihn zurück ins Tray, auch wenn die Ablage aus dem Hauptfenster geöffnet wurde (das Tray-Symbol entsteht dann beim ersten Rechtsklick), **Beenden** im Tray-Menü beendet das Programm. Ohne Tray (etwa wegen einer fehlenden Bibliothek) bleibt der Kreis sichtbar, sein ✕ beendet dann das Programm. Unter GNOME zeigt sich das Tray-Symbol nur mit der Erweiterung „AppIndicator“. Wird das Hauptfenster geschlossen, während die Ablage offen ist, läuft sie weiter und das Tray-Symbol bleibt; beendet wird sie dann nur noch über **Beenden** im Rechtsklickmenü des Tray-Symbols." },
        { p: "Unter Wayland startet die App über XWayland, weil Wayland einem Fenster weder eine eigene Position noch „immer im Vordergrund“ erlaubt, die Ablage aber beides braucht. Das Hauptfenster kann dadurch bei Bruchteil-Skalierung etwas weicher wirken." },
        { p: "Die Liste überlebt das Schließen der App. Im Hauptfenster zeigt der runde Knopf **Abgelegte Dateien** unten rechts, was wartet. Ein Klick öffnet das Prüffenster." },
      ],
    },
    "add-uebersicht": {
      title: "Reiter „Übersicht“ im Dateibrowser",
      blocks: [
        { p: "Links wird ein Ordner gewählt: über das Pfadfeld (**Los**), die Schnellzugriffe (Persönlicher Ordner, Desktop, Bilder, Dokumente, Downloads) oder die Laufwerke. Rechts erscheinen seine Dateien als Kacheln." },
        {
          list: [
            "**Klick:** zeigt die Datei in der Vorschau rechts. Bilder lassen sich dort zoomen und drehen, Video und Audio abspielen. Der Rand der Vorschau lässt sich ziehen.",
            "**E-Mail in der Vorschau:** Betreff, Absender und Maildatum, das Einordnungsdatum nur, wenn es abweicht. Gilt auch bei der Festplattensuche und in den Datei-Operationen.",
            "**Hineinscrollen ins Vorschaubild** (Mausrad nach vorn) öffnet wie die Lupe den freien Zoom. Nur die Bildfläche reagiert; außerhalb davon und beim Rad nach hinten scrollt die Vorschau wie bisher. Gilt auch beim Durchsuchen der Festplatte.",
            "**Doppelklick oder Leertaste:** markiert die Datei zum Hinzufügen (goldener Rahmen mit Häkchen).",
            "**Ordner:** Klick bietet an, den ganzen Ordner zu markieren (auf Wunsch mit Unterordnern), Doppelklick öffnet ihn.",
            "**Pfeiltasten** bewegen sich durchs Raster, **Strg+A** markiert alle hinzufügbaren Dateien.",
            "**↑ Übergeordneter Ordner**, **Dateien in Unterordnern anzeigen**, Typ-Chips (Fotos, Videos, Audio, Dokumente), **Bereits im Stream enthaltene Dateien ausblenden** und **Sortieren** (Name, Größe, Erstellt, Geändert, mit Richtungspfeil).",
            "**Rechtsklick:** In Standardprogramm öffnen, Ordner anzeigen, In anderen Stream einfügen.",
          ],
        },
        { p: "Bereits vorhandene Dateien tragen das Band „Bereits im Stream“. Unter jeder Kachel steht das Datum, das beim Hinzufügen verwendet würde, mit seiner Quelle in Klammern. Markierte, bereits vorhandene Dateien lassen sich mit **Entfernen (N)** wieder aus dem Stream nehmen. Ist **Arbeitskopie beim Entfernen löschen** eingeschaltet, fragt vorher ein Dialog nach, denn dann wird endgültig gelöscht." },
      ],
    },
    "add-sammlung": {
      title: "Die Sammlung und „Zu CronoStream hinzufügen“",
      blocks: [
        { p: "Alle Markierungen aus allen besuchten Ordnern und Reitern wandern in eine gemeinsame Sammlung. Sie bleibt bei Ordnerwechseln und sogar über das Beenden der App hinweg erhalten." },
        { p: "Sobald etwas gesammelt ist, erscheint unten rechts der goldene Knopf **Zu CronoStream hinzufügen** mit Zähler. Er öffnet die Liste aller gesammelten Dateien. Einzelne lassen sich mit **Von der Liste entfernen** herausnehmen. Mit denselben beiden Prüf-Kästchen wie im Prüffenster und **Hinzufügen** werden sie übernommen." },
      ],
    },
    "add-einzelbild": {
      title: "Reiter „Einzelbild“",
      blocks: [
        { p: "Zum Durchsehen von Fotoordnern wie in einem Album: ein Bild groß, die Nachbarn werden vorausgeladen. Der Ordner ist der links gewählte." },
        {
          keys: [
            ["→", "Nächstes Bild"],
            ["← / Rücktaste", "Vorheriges Bild"],
            ["Leertaste", "Markieren bzw. Markierung aufheben"],
          ],
        },
        { p: "Unten stehen Name, Position („3 / 120“), Drehknöpfe und **Markieren**. **Einfügen** öffnet **Vor dem Einfügen prüfen**: Dort wird je Datei die Datumsquelle oder ein eigenes Datum gewählt; **Dateien in CronoStream einfügen** übernimmt sie." },
      ],
    },
    "add-festplatte": {
      title: "Reiter „Festplatte durchsuchen“",
      blocks: [
        { p: "Sucht ab dem links gewählten Ordner nach passenden Dateien. Die Suche läuft im Hintergrund, die App bleibt bedienbar." },
        {
          list: [
            "**Suchbegriff:** Teil des Dateinamens (leer = alle Dateien der gewählten Typen).",
            "**Unterordner einbeziehen**, **Dateitypen** (Bilder, Videos, Audio, Dokumente, E-Mails, Sonstige; keine Auswahl = alle).",
            "**Zeitraum einschränken** nach **Aufnahmedatum** oder **Auf den Computer kopiert**.",
            "**Dateigröße** mindestens/höchstens.",
            "**Duplikate ausblenden:** zeigt von mehrfach gefundenen Exemplaren derselben Datei nur eines.",
            "**Bereits im Stream enthaltene Dateien ausblenden:** erkennt auch umbenannte Kopien.",
            "**Inhaltsprüfung:** „Schnell“ vergleicht Größe und einen kurzen Ausschnitt, „Gründlich“ die komplette Datei Byte für Byte (sicherer, aber langsamer).",
            "**Letzte Suchen:** Das Suchfeld merkt sich die letzten 50 Festplattensuchen samt Filtern, für alle Streams gemeinsam. Die Auswahl wechselt in den damaligen Ordner und sucht sofort.",
            "**Aus dem Index laden:** verwendet die letzte Suche in diesem Ordner, ohne die Festplatte neu zu lesen. Zeitraum, Typ und Größe lassen sich dann frei ändern.",
          ],
        },
        { p: "Ein Fortschrittsband zeigt Phase und Restzeit, **Abbrechen** beendet die Suche. Die Treffer erscheinen im selben Raster wie in der Übersicht und wandern beim Markieren in die Sammlung. Ordner mit mehr als etwa 200.000 Dateien werden abgelehnt; dann einen engeren Ordner wählen." },
      ],
    },
    "add-liste": {
      title: "Reiter „Liste importieren“",
      blocks: [
        { p: "**Datei öffnen** wählt eine Textdatei (.txt), die in jeder Zeile einen vollständigen Pfad samt Dateinamen enthält, z. B. /home/user/222.jpg. Gültige Dateien werden markiert und landen in der Sammlung, nicht gefundene werden gezählt. Hinzugefügt wird wie gewohnt über **Zu CronoStream hinzufügen**." },
      ],
    },
    "add-zwischenablage": {
      title: "Bild aus der Zwischenablage einfügen",
      blocks: [
        {
          list: [
            "**Strg+V auf der Zeitleiste:** öffnet sofort einen neuen Tagebucheintrag mit dem Bild als Anhang, Datum „jetzt“. Ohne Bild in der Zwischenablage passiert nichts.",
            "**Rechtsklick auf eine freie Stelle › Zwischenablage einfügen:** fragt „Was soll mit dem Bild geschehen?“. **Bild hinzufügen** legt eine normale Bilddatei mit dem Datum der Klickstelle an und öffnet sie in der Detailansicht. **Tagebucheintrag hinzufügen** öffnet den Tagebuch-Editor mit dem Bild als Anhang.",
          ],
        },
        { p: "Das Bild wird als JPEG gespeichert, bei Transparenz als PNG, und heißt „Zwischenablage“ (in der Sprache der Oberfläche) mit Zeitstempel." },
      ],
    },
    "add-anderer-ls": {
      title: "Dateien an einen anderen Stream schicken",
      blocks: [
        { p: "**In anderen Stream einfügen** (Rechtsklick auf eine Kachel in der Zeitleiste oder im Dateibrowser) legt die Datei auf die Warteliste des gewählten Streams. Sie erscheint dort im Prüffenster, sobald er das nächste Mal geöffnet wird." },
        { p: "Sofort übertragen lassen sich Dateien in den Datei-Operationen mit **In anderen Stream kopieren…** oder **verschieben…**." },
      ],
    },

    // ---------- Datum & KI ----------
    "datum-quellen": {
      title: "Woher CronoStream das Datum nimmt",
      blocks: [
        { p: "In dieser Reihenfolge, die erste Quelle, die etwas liefert, gewinnt:" },
        {
          steps: [
            "WhatsApp-Dateiname (z. B. „IMG-20190612-WA0001“)",
            "Eingebettete Metadaten: Aufnahmezeit (EXIF) bei Fotos, Sendedatum bei E-Mails",
            "Datum im Dateinamen (z. B. „20150207_150541“)",
            "Dateisystem: das Erstelldatum, außer es liegt nach dem Änderungsdatum. Dann gilt das Änderungsdatum, denn die Datei wurde offenbar später kopiert.",
          ],
        },
        { p: "Zusätzlich, aber nie automatisch: **Datum in der Datei**. Videos und Tonaufnahmen tragen oft ihr Aufnahmedatum in sich (bei iPhone-Videos samt Zeitzone), PDFs und Word-, Excel-, PowerPoint- oder LibreOffice-Dateien ihr Erstelldatum. Im Prüffenster erscheint es als weitere Wahl, sobald es im Hintergrund gelesen ist; in der Datumsauswahl unter einer Kachel, sobald der Mauszeiger darauf zeigt. Markieren und Einfügen warten nie darauf. Es geht auch in den KI-Auftrag ein. Bei umgewandelten oder neu gespeicherten Dateien ist es oft nur der Zeitpunkt dieser Bearbeitung, deshalb wählt die App es nicht selbst." },
        { p: "Die Quelle steht im Prüffenster, unter den Kacheln im Dateibrowser und als Abzeichen in der Detailansicht. Eigene Daten, KI-Daten und Aufnahmen tragen „Eigenes Datum“, „Von KI übernommen“ bzw. „Aufgenommen“." },
      ],
    },
    "datum-eingabe": {
      title: "Die Datumseingabe bedienen",
      blocks: [
        { p: "Überall in der App gibt es dieselbe Eingabe mit getrennten Feldern für Tag, Monat, Jahr, Stunde und Minute." },
        {
          keys: [
            ["0–9", "Zahl tippen, die Eingabe springt von selbst ins nächste Feld"],
            ["↑ / ↓", "Wert im Feld erhöhen bzw. verringern"],
            ["← / →", "zwischen den Feldern wechseln (auch . / :)"],
            ["Rücktaste", "letzte Ziffer löschen, im leeren Feld zurück ins vorherige"],
            ["Enter", "übernehmen"],
            ["Esc", "abbrechen (in der Detailansicht)"],
          ],
        },
        { p: "Der Tag wird auf gültige Werte des Monats begrenzt. Daten in der Zukunft und vor dem **Frühesten Jahr für Datumsangaben** (Einstellung, ab Werk 1900) werden abgelehnt." },
      ],
    },
    "datum-batch": {
      title: "Datum für mehrere Dateien gleichzeitig ändern",
      blocks: [
        {
          steps: [
            "In den Datei-Operationen die Dateien markieren (oder auf der Zeitleiste auswählen und **Bearbeiten** klicken).",
            "**Aktionen** › **Datum ändern…** wählen (auch per Rechtsklick).",
            "Je Datei erscheint eine Karte mit Vorschau, „Bisher: …“ und eigener Datumseingabe.",
            "Bei mehreren Dateien oben ein Datum und den **Zeitversatz** (Min. pro Datei, Vorgabe 5) eingeben und **Für alle übernehmen** klicken. Die erste Datei bekommt das Datum, die zweite 5 Minuten später usw., ideal für Fotoserien.",
            "Einzelne Karten bei Bedarf nachbessern und **Speichern** klicken. Erst dann wird geschrieben, alles in einem Schritt.",
          ],
        },
        { p: "Ein ungültiges Datum verhindert das Speichern, bis es korrigiert ist. Die Änderung lässt sich im Protokoll zurücknehmen." },
      ],
    },
    "datum-nach-import": {
      title: "Daten direkt nach dem Import prüfen",
      blocks: [
        { p: "Im Prüffenster und in der Liste **Zu CronoStream hinzufügen** gibt es zwei Kästchen. CronoStream merkt sich die Wahl." },
        {
          list: [
            "**Daten manuell überprüfen / korrigieren:** Nach dem Import öffnen sich die Datei-Operationen mit genau den eben hinzugefügten Dateien.",
            "**Nach dem Import Daten mit KI überprüfen:** Nach dem Import öffnet sich die KI-Datierung, beschränkt auf diese Dateien.",
          ],
        },
        { p: "Sind beide angehakt, geht es zuerst in die Datei-Operationen; **Weiter zur KI-Prüfung** führt dann weiter." },
      ],
    },
    "datum-ki": {
      title: "Datum per KI korrigieren",
      blocks: [
        { p: "Für Dateien mit unsicherem Datum, etwa eingescannte Fotos, kann eine KI aus Dateiname, Ordnerpfad und Metadaten oft das echte Datum schätzen. CronoStream selbst enthält keine KI und spricht mit keiner. Alles läuft über die Zwischenablage. Der Reiter liegt unter ✨ **Prüfen** › **Datum per KI korrigieren**." },
        {
          steps: [
            "**Dateien auswählen:** Filter für Zeitraum (ab Werk alle Dateien), Datumsfeld, Dateiname, **Nur unsichere Datumsangaben** und **Bereits per KI datierte ausblenden**. Dann **Weiter**.",
            "Optional **Zusätzliche Anweisungen an die KI** eingeben, z. B. „Alle Bilder mit IMG_ im Namen stammen aus dem Osterurlaub 2012“.",
            "**In die Zwischenablage kopieren** (oder **Als Datei speichern**) und den Text in ein beliebiges KI-Chatprogramm einfügen.",
            "Die Antwort der KI kopieren und **Jetzt aus der Zwischenablage lesen und importieren** klicken.",
            "Die Liste prüfen: bisheriges Datum, Vorschlag (änderbar), Sicherheit und Begründung. Unerwünschte Zeilen abwählen und **Übernehmen** klicken.",
          ],
        },
        { p: "Ein Bericht zeigt „X geändert, Y unverändert“, auf Wunsch mit **Änderungen anzeigen**. Alles landet als eine Aktion „Datum per KI übernommen“ im Protokoll und lässt sich ganz oder pro Datei zurücknehmen." },
      ],
    },
    "datum-ki-details": {
      title: "KI-Datierung: was weitergegeben wird und was bei Lücken hilft",
      blocks: [
        { p: "**Weitergegeben** werden nur Dateiname, Ordnerpfad, bisheriges Datum und dessen Quelle, Dateisystem-Zeiten und eingebettete Metadaten (z. B. EXIF-Aufnahmedatum, Zeitzone, GPS-Zeitstempel). Bilder, Videos und Dokumentinhalte werden nie übertragen. Ob und bei welcher KI der Text eingefügt wird, bleibt eine eigene Entscheidung." },
        { p: "**Fehlende Antworten:** Hat die KI nicht alle Einträge beantwortet, bietet CronoStream **Fehlende in die Zwischenablage kopieren** an. Diesen kurzen Nachtrag im selben Chat einfügen und die Antwort erneut importieren; die neuen Vorschläge kommen zu den vorhandenen dazu. Bei sehr vielen Dateien ist **Als Datei speichern** oft zuverlässiger." },
        { p: "**Prüfen:** Ein Klick auf die Begründung zeigt alle Rohdaten der Datei. **Unveränderte ausblenden** verbirgt Zeilen, deren Tag gleich bleibt. Die Sicherheit ist farbig markiert: hoch (grün), mittel (gelb), niedrig (orange)." },
      ],
    },

    // ---------- Verwalten ----------
    "verw-dateiops": {
      title: "Datei-Operationen: Dateien finden und markieren",
      blocks: [
        { p: "🛠 **Verwalten** › **Datei-Operationen** zeigt die Dateien des Streams als Kachelraster. Hier wird alles erledigt, was viele Dateien auf einmal betrifft." },
        {
          list: [
            "**Jahre (links):** **Alle Jahre** oder ein einzelnes Jahr mit Anzahl. Beim ersten Öffnen ist das neueste Jahr gewählt.",
            "**Filter oben:** Textfeld (sucht in Dateiname und Inhalt), Schalter **Zeitraum** mit **Zeitstempel im Stream** oder **Eingefügt am** und Von/Bis, Typ-Chips.",
            "**Klick:** zeigt die Datei in der Vorschau rechts (warmweißer Ring).",
            "**Doppelklick oder Leertaste:** markiert sie für die Sammelaktion (roter Ring). Pfeiltasten bewegen sich durchs Raster.",
            "**Sammelkästchen** links oben bzw. **Strg+A:** alle sichtbaren Dateien markieren oder alles aufheben. Daneben stehen Anzahl und Gesamtgröße.",
          ],
        },
        { p: "Was mit den markierten Dateien geschehen soll, steht im Menü **Aktionen (N)** oder im Rechtsklick-Menü." },
      ],
    },
    "verw-aktionen": {
      title: "Das Aktionen-Menü",
      blocks: [
        { p: "Erst aktiv, wenn etwas markiert ist. Dieselben Einträge stehen im Rechtsklick-Menü, dort zusätzlich das Drehen von Bildern." },
        {
          list: [
            "**Datum ändern…:** einzeln oder gestaffelt mit Zeitversatz",
            "**An KI zur Datierung übergeben:** öffnet die KI-Datierung mit genau diesen Dateien",
            "**Notiz hinzufügen…:** hängt einen Begriff an die Notiz aller markierten Dateien (mit Komma an eine bestehende Notiz, ohne Doppelungen)",
            "**Links drehen (90°)** / **Rechts drehen (90°):** dreht alle markierten Fotos; nur der Drehwert wird gespeichert, die Datei bleibt unverändert. Ausgegraut, sobald eine markierte Datei kein Foto ist",
            "**In anderen Stream kopieren…** / **verschieben…**",
            "**Druckexport…:** Fotos mit Datum und Uhrzeit als Dateinamen in einen Ordner kopieren",
            "**Pfadliste in Zwischenablage** / **Pfadliste als Textdatei…**",
            "**Aus dem Stream entfernen:** in den Papierkorb",
          ],
        },
        { p: "Daneben steht der Knopf **Datei im Stream ersetzen…**. Er arbeitet unabhängig von der Markierung." },
      ],
    },
    "verw-uebertragen": {
      title: "In einen anderen Stream kopieren oder verschieben",
      blocks: [
        { p: "Nach **In anderen Stream kopieren…** bzw. **verschieben…** wird das Ziel aus der Liste der Streams gewählt. Ein gerade woanders geöffneter Stream ist gesperrt. Über **＋ Neuen Stream anlegen** im Zieldialog lässt sich ein neuer anlegen (Name und Speicherort), der gleich als Ziel dient." },
        {
          list: [
            "**Kopieren:** Die Dateien kommen zusätzlich ins Ziel, hier bleibt alles unverändert.",
            "**Verschieben:** kopiert ins Ziel und entfernt die Dateien hier erst danach (in den Papierkorb). Nichts wird sofort gelöscht.",
            "**Duplikatprüfung:** Vorhanden heißt gleicher Quellpfad oder gleicher Inhalt (Größe, Schnellhash, BLAKE3; fehlende Hashes im Ziel werden nachberechnet). Zuerst erscheint der Dialog „Dateien schon vorhanden“ mit **Vorhandene überspringen** oder **Trotzdem kopieren** bzw. **Trotzdem verschieben**.",
            "Danach zeigt ein Ergebnisdialog alle übersprungenen Dateien mit Grund. Nach der Bestätigung sind sie in den Datei-Operationen markiert; beim Verschieben lassen sie sich dort entfernen.",
            "**Notizen** kommen mit, damit auch die Markierung des Privatmodus. Privat bleibt eine Datei im Ziel allerdings nur, wenn dort derselbe Markierungstext eingerichtet ist.",
            "**Tagebucheinträge** kommen vollständig an: Text, alle Anhänge in ihrer Reihenfolge und Notiz. Ein Eintrag mit gleichem Text und Zeitpunkt im Ziel gilt als schon vorhanden. Fehlt ein Anhang im Quellordner, wird der Eintrag mit der Meldung „Anhang ‚…‘ fehlt im Quellordner.“ übersprungen und beim Verschieben hier nicht entfernt.",
            "Beide Seiten bekommen einen Protokolleintrag.",
          ],
        },
      ],
    },
    "verw-druckexport": {
      title: "Druckexport für Fotobuch- und Fotodruck-Dienste",
      blocks: [
        { p: "Viele Druckdienste sortieren Fotos nach Datum und Uhrzeit im Dateinamen oder drucken sie auf die Rückseite. **Druckexport…** kopiert die markierten Fotos in einen frei wählbaren Ordner und benennt jede Kopie nach Datum und Uhrzeit aus der Zeitleiste, z. B. „09.10.2026 - 14.30 Uhr.jpg“." },
        {
          list: [
            "Zwei Fotos in derselben Minute bekommen „- 2“, „- 3“ … angehängt.",
            "In CronoStream gedrehte Fotos werden gedreht gespeichert.",
            "Videos und Dokumente werden übersprungen, das wird vorher angezeigt.",
            "Ein erneuter Export in denselben Ordner ersetzt die Dateien, statt sie zu verdoppeln.",
          ],
        },
      ],
    },
    "verw-pfadliste": {
      title: "Pfadliste: für externe Programme",
      blocks: [
        { p: "**Pfadliste in Zwischenablage** bzw. **Pfadliste als Textdatei…** erzeugt einen Text mit einem vollständigen Pfad pro Zeile, und zwar zu den Kopien im Stream-Ordner." },
        { p: "Damit lassen sich z. B. viele große Videos in einem externen Konvertierungsprogramm stapelweise verkleinern. Die Ergebnisse kommen anschließend mit **Datei im Stream ersetzen…** zurück, ohne Datum, Notizen oder Namen zu verlieren." },
      ],
    },
    "verw-ersetzen": {
      title: "Datei im Stream ersetzen",
      blocks: [
        { p: "Tauscht Dateien im Stream gegen eine andere Version derselben Datei, z. B. gegen nachträglich komprimierte Videos." },
        {
          steps: [
            "**Datei im Stream ersetzen…** klicken, die Erklärung lesen und **Ordner wählen…**. Unterordner werden mit durchsucht.",
            "Die Trefferliste prüfen. Eine Datei passt, wenn ihr Name den Namen der Stream-Datei (ohne Endung) als ganzes Wort enthält, evtl. mit Zusatz und anderer Endung: „Urlaub.mov“ passt zu „Urlaub_komprimiert.mp4“, nicht zu „Urlaub2.mp4“. Der Dateityp muss gleich sein. Bei mehreren Kandidaten ist eine Auswahl nötig.",
            "**Dateien ersetzen** klicken. Ein Bericht zeigt Vorher, Nachher und den gesparten Speicher.",
          ],
        },
        { p: "Datum, Notizen, Anzeigename, Drehung und Position auf der Zeitleiste bleiben erhalten." },
        { note: "Die alte Datei im Stream-Ordner wird beim Ersetzen gelöscht. Rückgängig machen (im Protokoll) geht nur, solange das Original noch im Quellordner liegt. Fehlt es, warnt die Liste." },
      ],
    },
    "verw-papierkorb": {
      title: "Der Papierkorb",
      blocks: [
        { p: "🛠 **Verwalten** › **Papierkorb** zeigt alle entfernten Dateien, mit denselben Jahren, Filtern und Markierungen wie die Datei-Operationen. Das Menü **Aktionen** bietet drei Stufen:" },
        {
          list: [
            "**Wiederherstellen:** Die Dateien kehren auf die Zeitleiste zurück. Fehlt die Arbeitskopie, holt CronoStream sie aus der Originalquelle.",
            "**Nur Datei löschen:** löscht Arbeitskopie und Vorschaubild und gibt Speicher frei. Der Eintrag mit Datum, Name und Verlauf bleibt, die Datei lässt sich später aus der Quelle zurückholen.",
            "**Löschen + aus Datenbank entfernen:** löscht Datei, Eintrag und alle Protokolleinträge dazu. Das ist endgültig und nur für Dateien im Papierkorb möglich.",
          ],
        },
        { p: "Die beiden Löschstufen fragen vorher nach." },
      ],
    },
    "verw-duplikate": {
      title: "Reiter „Duplikate“: den ganzen Stream prüfen",
      blocks: [
        { p: "**Jetzt Duplikat-Prüfung durchführen** durchsucht den gesamten Stream nach Dateien mit gleichem Fingerabdruck. Das ist nützlich für Dateien, die vor dem Einschalten der Duplikat-Erkennung hinzugekommen sind. Die Prüfung läuft auch beim Wechsel in einen anderen Reiter weiter." },
        { p: "Das Ergebnis („12 mögliche Duplikate in 5 Gruppen gefunden“) bleibt unter dem Knopf stehen, zusammen mit dem Knopf **An Datei-Operationen übergeben**. Dort sind alle Beteiligten zu sehen; die überflüssigen werden markiert und entfernt. Welche Fassung bleibt, entscheidet nie die App." },
        { p: "**Ähnliche Bilder suchen** findet zusätzlich Fotos, die gleich aussehen, ohne dieselbe Datei zu sein: verkleinerte, von WhatsApp neu komprimierte oder neu gespeicherte Kopien. Dafür bekommt jedes Foto einen Bild-Fingerabdruck aus seinem Vorschaubild. Fast einfarbige Bilder wie Himmel, Wände oder dunkle Aufnahmen bleiben außen vor, ebenso Bilder mit sehr wenig Struktur. Eine Gruppe sammelt die Bilder, die ihrem ersten Bild ähneln; eine lange Serie ähnlicher Aufnahmen ergibt deshalb mehrere kleine Gruppen. Die erste Suche dauert länger, weil dabei jedes Foto seinen Fingerabdruck bekommt. Auch hier kommt das Ergebnis als Meldung mit **An Datei-Operationen übergeben**, und es bleibt ein Vorschlag." },
      ],
    },
    "verw-sicherung": {
      title: "Sicherung erstellen",
      blocks: [
        { p: "🛠 **Verwalten** › **Sicherung** › **Sicherung erstellen**, dann einen Zielordner wählen. Ein Fortschrittsfenster zeigt „n von m Dateien kopiert“, **Abbrechen** räumt Halbfertiges auf." },
        { p: "Es entsteht ein Ordner mit dem Namen des Streams und einem Zeitstempel: Dateien, Vorschaubilder, Datenbank und Protokoll. Die Sicherung ist selbst ein vollständiger Stream. Zum Zurückkehren wird sie auf dem Startbildschirm über **Wiederherstellen & Papierkorb…** › **Aus Sicherung wiederherstellen** als neue Kopie angelegt und geöffnet (alternativ direkt über **Stream-Ordner öffnen**)." },
        { p: "Das Ziel darf nicht im Stream-Ordner selbst liegen." },
        { p: "**Vorhandene Sicherung aktualisieren…** bringt eine früher angelegte Sicherung auf den neuesten Stand, statt jedes Mal alles neu zu kopieren: den Ordner der Sicherung wählen, kopiert werden nur neue und geänderte Dateien, dazu der aktuelle Stand der Datenbank. Dateien, die es im Stream nicht mehr gibt, bleiben in der Sicherung erhalten. Ein versehentlich gelöschtes Foto ist dort also noch da. Ein Ordner, der keine Sicherung dieses Streams ist, wird abgelehnt. Enthält der Ordner Änderungen, die es hier nicht gibt (etwa ein eigenständig weitergeführtes Duplikat), oder gehört er zu einem Stream mit anderem Namen, fragt die App vorher nach. Die bisherige Datenbank des Ordners bleibt als „cronostream.db.vor-aktualisierung“ darin liegen." },
      ],
    },
    "verw-archiv": {
      title: "Archiv prüfen: sind alle Dateien noch heil?",
      blocks: [
        { p: "🛠 **Verwalten** › **Archiv prüfen** › **Archiv prüfen** sieht nach, ob alles noch vollständig ist. Die Prüfung liest nur und ändert nichts an den Dateien." },
        {
          list: [
            "**Fehlende Dateien:** stehen auf der Zeitleiste oder hängen an einem Tagebucheintrag, fehlen aber im Stream-Ordner. Dateien der Zeitleiste lassen sich über das Protokoll oder den Papierkorb erneut aus der Originalquelle holen, sofern diese noch da ist.",
            "**Fehlende Vorschaubilder:** lassen sich mit **Vorschaubilder neu erzeugen** wiederherstellen, alle auf einmal. Danach zeigt eine schnelle Prüfung den neuen Stand, ohne die Dateien erneut ganz zu lesen.",
            "**Dateien ohne Eintrag:** liegen im Stream-Ordner, gehören aber zu keinem Eintrag, etwa Reste eines abgebrochenen Kopiervorgangs. Die App löscht sie nicht.",
            "**Veränderte Inhalte:** nur mit **Inhalte vollständig lesen**. Beim ersten Mal bekommt jede Datei einen Fingerabdruck, bei späteren Prüfungen fällt auf, wenn sich eine Datei verändert hat, ohne dass die App sie geändert hat, etwa durch einen Plattenschaden. Eine Sicherung oder die Originalquelle hat dann vermutlich noch die richtige Fassung.",
          ],
        },
        { p: "Das vollständige Lesen dauert bei großen Archiven lange. Es empfiehlt sich gelegentlich, zum Beispiel vor dem Aktualisieren einer Sicherung." },
      ],
    },

    // ---------- Protokoll ----------
    "log-ueberblick": {
      title: "Was das Protokoll festhält",
      blocks: [
        { p: "🛠 **Verwalten** › **Protokoll** listet jede Aktion, die neueste zuerst: Einfügen, Entfernen, endgültig Löschen, Umbenennen, Datumsänderungen (von Hand und per KI), Ersetzen, Einstellungsänderungen dieses Streams und alle Änderungen an Themenbereichen und Phasen." },
        {
          list: [
            "**Protokoll durchsuchen:** findet Einträge nach dem Dateinamen zum Zeitpunkt der Aktion.",
            "**Aufklappen:** Eine Sammelaktion wie „147 Dateien eingefügt“ zeigt jede einzelne Datei mit Vorher → Nachher.",
            "**Vorschau:** Beim Verweilen über einem Dateinamen erscheint das Bild.",
            "**Weitere Einträge laden** am Ende holt ältere Einträge.",
          ],
        },
      ],
    },
    "log-rueckgaengig": {
      title: "Eine Änderung rückgängig machen",
      blocks: [
        {
          steps: [
            "Im Protokoll den Eintrag suchen und **Rückgängig** klicken, bei Sammelaktionen **Alles rückgängig**. Im aufgeklappten Eintrag gibt es den Knopf auch pro Datei.",
            "Wurde dieselbe Datei seitdem erneut geändert, erscheint „Diese Datei wurde seitdem erneut geändert“ mit den neueren Änderungen. **Neuere Änderungen zuerst rückgängig machen** nimmt sie in der richtigen Reihenfolge mit zurück. Nichts wird stillschweigend überschrieben.",
            "Beim Rückgängigmachen eines Imports fragt CronoStream, ob die Kopie im Stream-Ordner behalten oder gelöscht werden soll. Die Originale sind in jedem Fall sicher.",
          ],
        },
        { p: "Rückgängig gemachte Einträge sind als solche markiert. Fehlt die Arbeitskopie, holt CronoStream die Datei aus der Originalquelle zurück, solange diese noch existiert." },
      ],
    },
    "log-endgueltig": {
      title: "Endgültig löschen im Protokoll",
      blocks: [
        { p: "Für entfernte Dateien, deren Arbeitskopie noch im Stream-Ordner liegt, gibt es im Protokoll Kästchen (**Alle auswählen** / **Alle abwählen**) und den roten Knopf **Endgültig löschen**. Das löscht Arbeitskopie und Vorschaubild und gibt Speicher frei, nach einer Rückfrage." },
        { note: "Das ist nicht umkehrbar. Der Verlauf bleibt als „Endgültig gelöscht“ sichtbar." },
      ],
    },

    // ---------- Tagebuch & Aufnahmen ----------
    "tb-anlegen": {
      title: "Tagebucheintrag schreiben",
      blocks: [
        { p: "Das Tagebuch-Symbol in der Kopfleiste startet einen Eintrag mit der aktuellen Uhrzeit, Rechtsklick auf eine freie Stelle › **Tagebucheintrag hier hinzufügen** einen mit dem Datum der Klickstelle. Datum und Uhrzeit sind im Dialog änderbar." },
        {
          list: [
            "Text ins Textfeld schreiben.",
            "Anhänge: **Dateien hinzufügen**, Dateien ins Fenster ziehen, **Bild aus Zwischenablage** oder Strg+V. Das × an einer Anhang-Karte entfernt sie.",
            "**Speichern** oder Strg+Enter sichert den Eintrag. Ohne Text und ohne Anhang lässt er sich nicht speichern.",
            "Bei ungespeicherten Änderungen fragt Esc bzw. Schließen nach (**Weiter bearbeiten** / **Verwerfen**).",
          ],
        },
      ],
    },
    "tb-lesen": {
      title: "Tagebucheinträge lesen und bearbeiten",
      blocks: [
        { p: "Einträge erscheinen in der Dokumente-Spur mit der ersten Zeile, dem Datum und der Zahl der Anhänge. Ein Klick öffnet den Eintrag zum Lesen, **Bearbeiten** (oder der Stift auf der Kachel) zum Ändern. Ein Klick auf einen Anhang öffnet ihn im Standardprogramm." },
        { p: "Hat ein Eintrag mehrere ansehbare Anhänge, zeigt **Dateien anzeigen** sie als Cluster. Danach öffnet sich der Eintrag wieder. Ein neuer Eintrag steht im Protokoll wie ein Import und lässt sich zurücknehmen. Die Suche findet auch den Text von Tagebucheinträgen." },
      ],
    },
    "aufn-aufnehmen": {
      title: "Video oder Audio aufnehmen",
      blocks: [
        {
          steps: [
            "🎬 (Video) oder 🎙️ (Audio) in der Kopfleiste klicken. Sind mehrere Geräte angeschlossen, oben **Kamera** und **Mikrofon** wählen; die letzte Wahl wird gemerkt.",
            "**Aufnahme starten**. Ein roter Punkt pulsiert, die Zeit läuft. **Pause** / **Fortsetzen** nach Bedarf.",
            "**Aufnahme stoppen** und das Ergebnis im Player prüfen.",
            "Einen **Namen der Aufnahme** eingeben und **In den Stream übernehmen**, oder **Verwerfen und neu aufnehmen**.",
          ],
        },
        { p: "Die Aufnahme erscheint mit dem aktuellen Zeitpunkt auf der Zeitleiste, ihre Datumsquelle ist „Aufgenommen“." },
      ],
    },
    "aufn-ffmpeg": {
      title: "Was tun, wenn ffmpeg fehlt?",
      blocks: [
        { p: "Für Aufnahmen braucht CronoStream das freie Programm ffmpeg. Unter Windows und macOS liegt es der Installation bei; wird es dort nicht gefunden, hilft eine Neuinstallation von CronoStream." },
        { p: "Im Linux-AppImage liegt ffmpeg bei, mit allen Video- und Audio-Decodern. Eine eigene Installation ist dort nicht nötig. Bei anderen Linux-Installationen wird das ffmpeg des Systems verwendet. Fehlt es, bietet der Aufnahme-Dialog **ffmpeg installieren** über die Paketverwaltung an (das Systempasswort wird abgefragt) oder zeigt einen Terminal-Befehl. Danach **Erneut prüfen**." },
      ],
    },

    // ---------- Themenbereiche ----------
    "ph-verwalten": {
      title: "Themenbereiche und Phasen anlegen",
      blocks: [
        { p: "Das Symbol **Themenbereiche** in der Kopfleiste öffnet den Dialog. Ein Themenbereich (z. B. „Beruf“ oder „Wohnorte“) bündelt Phasen, etwa „Studium“ oder „Wohnort Berlin“." },
        {
          list: [
            "**Themenbereich anlegen**, Namen eintragen. **Phase hinzufügen** legt darin eine Entwurfszeile mit leeren Datumsfeldern an; gespeichert wird die Phase erst, wenn **Beginn** und **Ende** eingetragen sind.",
            "Jede Phase hat Titel, **Beginn** und **Ende** (Datumseingabe), das Kästchen **läuft noch** (das Ende ist dann immer heute) und eine **Farbe** (Palette oder Hex-Wert, **Übernehmen**). Eine neue Phase bekommt automatisch eine Farbe, die noch in keinem Themenbereich vorkommt.",
            "**Auge:** blendet eine Phase oder einen ganzen Themenbereich ein und aus. Halb gefüllt heißt: nur einige Phasen sind sichtbar.",
            "**Überlappung erlaubt** gilt je Themenbereich und ist bei neuen Themenbereichen ab Werk an. Ist es aus, wird eine überlappende Phase nicht gespeichert und die betroffenen Phasen werden genannt.",
            "**Einklappen:** der Pfeil links an einem Themenbereich blendet seine Phasen aus der Liste aus, nur Name und Phasenzahl bleiben sichtbar. Der Zustand wird gemerkt; **Phase hinzufügen** klappt den Bereich wieder auf.",
            "**Sortierung** (Umschalter oben): **Zuletzt bearbeitet** (ab Werk) setzt den zuletzt bearbeiteten Themenbereich nach oben, **Manuell** zeigt die gespeicherte Reihenfolge wie auf der Zeitleiste. Als Bearbeitung zählen Anlegen, Umbenennen, Überlappung und alle Änderungen an Phasen, nicht das Auge.",
            "**Umsortieren** (nur bei Sortierung **Manuell**): am Griff links ziehen oder Alt+↑/↓. Die Zeitleiste behält immer die manuelle Reihenfolge.",
            "**Phase entfernen** bzw. **Themenbereich entfernen** über den Knopf am Ende der jeweiligen Zeile.",
          ],
        },
        { p: "Alle Änderungen gelten sofort und lassen sich im Protokoll zurücknehmen. Das Ein- und Ausblenden wird gespeichert, aber nicht protokolliert." },
      ],
    },
    "ph-zeitleiste": {
      title: "Phasen auf der Zeitleiste",
      blocks: [
        { p: "Die Phasen liegen als farbige Balken in einem Band über den Spuren, je Themenbereich eine Zeile. Überlappende Phasen stapeln sich. Beim Verweilen zeigt ein Infofenster den Zeitraum." },
        {
          list: [
            "**Klick auf einen Balken:** zoomt so, dass die ganze Phase das Fenster füllt. **↩ Zurück** unten links oder Esc kehrt zur Ansicht davor zurück, solange zwischendurch nicht von Hand gezoomt oder verschoben wurde.",
            "**Rechtsklick auf einen Balken:** **Namen ändern**, **Farbe ändern**, **Phase ausblenden**, **Phase entfernen**.",
            "**Pfeil-Menü links neben dem Band:** Themenbereiche schnell ein- und ausblenden.",
          ],
        },
      ],
    },

    // ---------- Einstellungen ----------
    "set-aufbau": {
      title: "Die Einstellungen: Aufbau und Kategorien",
      blocks: [
        { p: "⚙ öffnet die Einstellungen. Links steht eine Leiste mit **Kategorien**, rechts die Einstellungen der gewählten Kategorie. Die zuletzt gewählte Kategorie bleibt in dieser Sitzung erhalten, auch nach einem Sprachwechsel." },
        {
          list: [
            "**System & Sprache:** Sprache der Oberfläche, Erscheinungsbild (Farbschema **Hell** oder **Dunkel**, ab Werk Dunkel; gilt für den ganzen Rechner, Ablage und Programmsymbol folgen mit; auch oben rechts auf dem Startbildschirm umstellbar), Start (Willkommensbildschirm, Startmenü, Desktop, Ablage, Autostart) und Deinstallieren.",
            "**Dateien & Duplikate:** Arbeitskopie beim Entfernen, Duplikat-Erkennung, frühestes Jahr, Sprung zur Duplikat-Verwaltung.",
            "**Zeitleiste & Spuren:** Reihenfolge der Spuren, Datum durch Verschieben von Kacheln, Mini-Vorschau der Zeitleiste.",
            "**Stapel & Zoom:** Auslöser, Aktion und Zoom-Bremse der Stapel, Mauszeiger folgt dem aufgeklappten Stapel.",
            "**Medien & Detailansicht:** Navigation in der Detailansicht, Zeitstempel im Bild, Video-Vorschaubild.",
            "**Privatsphäre:** der Privatmodus.",
            "**Über CronoStream:** Version, Urheberrecht und Lizenzen.",
          ],
        },
        { p: "Schalter und Auswahlfelder (nebeneinanderliegende Schaltflächen, von denen eine gewählt ist) wirken sofort. Beim frühesten Jahr bestätigt Enter oder das Verlassen des Feldes („✓ Gespeichert“), beim Video-Vorschaubild **Übernehmen**. Wo die Wahl gilt, zeigt ein Symbol rechts neben der Einstellung (siehe „Wo eine Einstellung gilt“)." },
      ],
    },
    "set-sprache": {
      title: "Sprache der Oberfläche ändern",
      blocks: [
        {
          steps: [
            "**⚙ Einstellungen** öffnen.",
            "In der Kategorie **System & Sprache** in der Zeile **Sprache** die gewünschte Sprache wählen: **Deutsch**, **English** oder **Español**.",
          ],
        },
        { p: "Schon vor dem ersten Stream geht es auch auf dem Startbildschirm: Oben rechts neben der Kaffeetasse stehen die Schaltflächen **Deutsch**, **English** und **Español** sowie **Hell** und **Dunkel** für das Farbschema. Die Wahl ist dieselbe wie in den Einstellungen." },
        { p: "Die Oberfläche wechselt sofort, ein Neustart ist nicht nötig. Die Einstellungen bleiben dabei geöffnet. Jede Sprache steht in ihrer eigenen Schreibweise in der Liste und ist so auch dann auffindbar, wenn die aktuelle Sprache nicht verstanden wird." },
        { p: "Beim allerersten Start folgt die Oberfläche der Sprache des Betriebssystems (Deutsch, English oder Español), sonst gilt Englisch. Eine gespeicherte Wahl hat immer Vorrang." },
        {
          list: [
            "Die Wahl gilt für alle Streams auf diesem Rechner, auch für Startbildschirm und **Ablage**. Deshalb gibt es hier kein „Gilt für“.",
            "Mit der Sprache wechseln auch Datums- und Zeitformate, die Hilfe, die Meldungen des Programms, das Startbild der leeren Zeitleiste und die Dateinamen beim **Druckexport**.",
            "Inhalte bleiben, wie sie sind: Namen, Notizen, Tagebucheinträge, Lebensphasen und die Dateien selbst werden nicht übersetzt.",
          ],
        },
      ],
    },
    "set-geltung": {
      title: "Wo eine Einstellung gilt (Pin und Globus)",
      blocks: [
        { p: "Rechts neben vielen Einstellungen steht ein kleines Symbol, das zeigt, wo sie gilt: **Pin** = nur dieser Stream, **Globus** = alle Streams auf diesem Rechner. Ein Klick darauf öffnet ein Auswahlfenster mit zwei Möglichkeiten (Esc schließt nur dieses Fenster):" },
        {
          list: [
            "**Dieser Stream:** nur im geöffneten Stream. Andere behalten ihre eigene Wahl. Änderungen stehen im Protokoll dieses Streams und lassen sich zurücknehmen.",
            "**Alle:** für alle Streams auf diesem Rechner. Beim Umschalten wird der aktuelle Wert übernommen, er ändert sich dadurch nicht.",
          ],
        },
        { p: "Kein Symbol haben die Kategorien **System & Sprache** und **Über CronoStream**, weil dort alles für den ganzen Rechner gilt, sowie **Privatsphäre**, die immer nur für den jeweiligen Stream gilt." },
        { p: "Ab Werk gilt jede Einstellung nur für den jeweiligen Stream. So kann ein Foto-Stream anders arbeiten als ein Dokumenten-Stream. Die meisten Einstellungen wirken sofort." },
      ],
    },
    "set-allgemein": {
      title: "Einstellungen: Dateien & Duplikate",
      blocks: [
        {
          list: [
            "**Arbeitskopie beim Entfernen löschen** (ab Werk aus): Beim Entfernen wird auch die Kopie im Stream-Ordner gelöscht. Achtung: Dann ist Entfernen endgültig und landet nicht im Papierkorb. Detailansicht und Datei-Operationen fragen deshalb vorher nach. Originale bleiben unberührt.",
            "**Duplikate beim Import automatisch erkennen** (an): prüft neue Dateien gegen den Bestand und meldet Verdachtsfälle zur Prüfung.",
            "**Schnellprüfung per Dateiname und Größe** (an, Unterpunkt): prüft nur, wenn schon eine Datei mit gleichem Namen und gleicher Größe existiert. Ausschalten, um auch umbenannte Duplikate zu finden; das dauert länger.",
            "**Frühestes Jahr für Datumsangaben** (1900): frühere Jahre werden bei jeder Datumseingabe abgelehnt, Daten in der Zukunft immer.",
            "**Zur Duplikat-Verwaltung wechseln →:** öffnet den Reiter Duplikate.",
          ],
        },
      ],
    },
    "set-zeitleiste": {
      title: "Einstellungen: Zeitleiste & Spuren",
      blocks: [
        {
          list: [
            "**Spuren-Reihenfolge & Sichtbarkeit:** die Spuren am Griff ⋮⋮ ziehen oder mit den Pfeilknöpfen umsortieren. **Standardreihenfolge wiederherstellen** setzt zurück. Spuren ohne Inhalt werden automatisch ausgeblendet.",
            "**Datum durch Verschieben von Kacheln ändern** (aus): Kacheln lassen sich waagerecht an ein neues Datum ziehen. Aus heißt: Ziehen verschiebt die Zeitleiste.",
            "**Mini-Vorschau der Zeitleiste** (ab Werk nur Datei-Operationen): je Ansicht des Werkzeugkastens ein Schalter, ob die schwebende Vorschau samt Zurück-Schaltfläche erscheint.",
          ],
        },
      ],
    },
    "set-stapel": {
      title: "Einstellungen: Stapel & Zoom",
      blocks: [
        {
          list: [
            "**Stapel-Auslöser:** **Mauszeiger (Hover)** öffnet beim Verweilen, **Klick** (ab Werk) nur bei einem Mausklick. Ein Klick löst einen Stapel immer auf, unabhängig von dieser Einstellung.",
            "**Stapel-Aktion:** **In Zeitleiste hineinzoomen** zoomt, bis sich der Stapel in Einzelkacheln auflöst. **Stapel aufklappen (Fächer)** (ab Werk) zeigt das Raster an Ort und Stelle, ohne den Zoom zu ändern.",
            "**Zoom-Bremse beim Verweilen:** wirkt nur bei Hover + Hineinzoomen. **Schrittweise** hält nach jeder Stufe an, bis sich die Maus bewegt. **Kontinuierlich** zoomt weiter, solange der Zeiger ruht. **Nur per Klick** (ab Werk) klappt beim Verweilen auf und zoomt nur per Klick. Wirkt die Bremse gerade nicht, steht sie ausgegraut mit einem Hinweis da und lässt sich trotzdem schon einstellen.",
            "**Mauszeiger folgt dem aufgeklappten Stapel** (Schalter, ab Werk aus): Beim Aufklappen springt der Zeiger auf die mittlere Kachel, deren Datei oben groß angezeigt wird. Das hilft bei Stapeln am Rand. Wirkt nur, wenn ein Stapel aufklappt (bei „In Zeitleiste hineinzoomen“ nur, wenn der Zoom zum Auflösen nicht mehr reicht) und nur, wo das Fenstersystem es erlaubt: X11, Windows und macOS, nicht in einer reinen Wayland-Sitzung.",
            "**Zoomstufen:** Die Schalter **Wochenraster anzeigen** und **Stundenraster anzeigen** (beide ab Werk an) legen fest, welche Rasterstufen die Zeitleiste zeigt. Ohne Wochenraster beginnt das Tagesraster, sobald ein Monat das Fenster füllt; ohne Stundenraster bleibt es beim Tagesraster, egal wie weit hineingezoomt wird.",
            "**Mausrad öffnet und schließt die Detailansicht** (Schalter, ab Werk an): Ein Schritt des Mausrads nach vorn über der großen Vorschau eines aufgeklappten Stapels öffnet die Datei, wie ein Klick. In der Detailansicht schließen erst etwa drei Schritte nach hinten am Stück; eine Pause von über 0,6 Sekunden oder ein Schritt nach vorn setzt das Zählen zurück. Kehrt ein vergrößertes Bild beim Herauszoomen in den Rahmen zurück, schließt dieselbe Scroll-Bewegung die Detailansicht nicht mit; die Rückwärtsschritte zählen erst nach 0,7 Sekunden Pause neu. Bei vergrößertem Bild und über Inhalten, die selbst scrollen (Dokumente, Texte), zählt das Scrollen nicht. Danach wirkt das Mausrad kurz nicht auf Zeitleiste und Bildzoom.",
          ],
        },
      ],
    },
    "set-medien": {
      title: "Einstellungen: Medien & Detailansicht",
      blocks: [
        {
          list: [
            "**Navigation in der Detailansicht:** **Nur gleiche Kategorie** (von Foto zu Foto), **Alle Medien** (ab Werk, chronologisch über alle Spuren) oder **Benutzerdefiniert** mit Schaltern für Bilder, Videos, Audios und Dokumente.",
            "**Zeitstempel im Bild einblenden** (an): Datum und Uhrzeit dezent am unteren Rand in der Detailansicht.",
            "**Video-Vorschaubild (Thumbnail):** Position in Prozent der Videolänge (ab Werk 10). Mit **Übernehmen** gilt sie für neue Videos. **Vorhandene Video-Vorschaubilder jetzt neu erzeugen** erneuert zusätzlich alle vorhandenen.",
          ],
        },
      ],
    },
    "set-start": {
      title: "Start: Willkommen, Startmenü und Autostart",
      blocks: [
        { p: "⚙ › **System & Sprache** › **Start** enthält Einstellungen für die App selbst. Sie gelten für den ganzen Rechner, deshalb gibt es hier kein „Gilt für“." },
        {
          list: [
            "**Willkommensbildschirm anzeigen:** zeigt die kurze Einführung bei jedem Öffnen des Hauptfensters. Im Willkommensfenster schaltet **Nicht mehr anzeigen** sie ab; hier lässt sie sich wieder einschalten.",
            "**Startmenü-Eintrag für CronoStream:** startet das Hauptprogramm über das Startmenü.",
            "**Startmenü-Eintrag für die Ablage:** öffnet nur die Ablage als kleinen Kreis, ohne Hauptfenster.",
            "**Ablage beim Systemstart öffnen:** öffnet die Ablage nach der Anmeldung automatisch als kleinen Kreis.",
            "**Verknüpfung auf dem Desktop** (ab Werk aus): legt CronoStream als Symbol auf den Desktop. Unter Linux ist der Starter gleich ausführbar und als vertrauenswürdig markiert.",
          ],
        },
        { p: "Die vier Schalter für Startmenü, Autostart und Desktop erscheinen nur im Linux-AppImage und in der installierten Windows-Version, dort verhalten sie sich gleich. Beim ersten Start bietet das Willkommensfenster außerdem das **Erscheinungsbild** (Hell oder Dunkel) zur Wahl an, solange noch keines gespeichert ist; **Loslegen** speichert die Vorauswahl. Die vier Schalter bietet es einmalig an (**Einrichtung auf diesem Rechner**); schon vorhandene Einträge, etwa vom Windows-Installer, werden dabei übernommen. Später lassen sie sich hier ändern." },
        { p: "Unter Linux liegen die Startmenü-Einträge im Menüordner **CronoStream**, zusammen mit **CronoStream deinstallieren**. Unter Windows legt der Installer einen Startmenü-Ordner an (Name auf einer eigenen Seite des Installers wählbar, ab Werk **CronoStream**) mit Programm, **CronoStream Ablage** und **CronoStream deinstallieren**. Installer und Deinstaller sprechen Deutsch, Englisch oder Spanisch, je nach Sprache von Windows, sonst Englisch; die Einträge heißen dann entsprechend. Ein ausgeschalteter Eintrag wird unter Windows nur beiseitegelegt und beim Einschalten zurückgeholt; fehlt er ganz, wird er neu angelegt." },
        { p: "**Überwachter Ordner** (⚙ › **System & Sprache**): Ein gewählter Ordner wird überwacht. Neue Dateien darin kommen automatisch in die Ablage, auch bei geschlossenem Hauptfenster, solange die Ablage läuft. Bereits vorhandene Dateien werden nicht übernommen. **Unterordner einbeziehen** nimmt auch Dateien aus Unterordnern auf. Unfertige Dateien (etwa .part oder .tmp) werden erst nach dem Ende des Schreibens aufgenommen. Ist der Ordner nicht erreichbar (Laufwerk getrennt), wird die Überwachung fortgesetzt, sobald er wieder da ist. **Nicht mehr überwachen** beendet sie." },
      ],
    },

    "set-deinstallieren": {
      title: "CronoStream vollständig entfernen",
      blocks: [
        { p: "⚙ › **System & Sprache** › **Deinstallieren** › **Entfernen…** oder der Startmenü-Eintrag **CronoStream deinstallieren** öffnet einen Dialog. Er listet alles auf, was CronoStream auf diesem Computer außerhalb der Streams angelegt hat: Einstellungen, Stream-Liste, Ablage-Warteliste, Suchindex und Protokolldatei, gespeicherte Daten der Oberfläche, Zwischenspeicher, noch nicht übernommene Aufnahmen, Startmenü-, Menüordner- und Autostart-Einträge sowie Reste unter dem früheren Namen LifeStream. Nach **Jetzt entfernen** und einer letzten Rückfrage wird all das gelöscht, danach beendet sich die App." },
        {
          list: [
            "**Streams** bleiben erhalten. Nur einzeln angehakte Streams werden samt Ordner endgültig gelöscht, ab Werk ist keiner angehakt. Streams, die nicht in der Stream-Liste stehen, bleiben unberührt.",
            "**Auch die Programmdatei löschen** (nur Linux, ab Werk aus): löscht zusätzlich die AppImage-Datei. Ohne Haken bleibt sie liegen und lässt sich später erneut starten oder von Hand löschen.",
            "**Windows:** Danach startet das Windows-Deinstallationsprogramm ohne weitere Rückfrage und entfernt das Programm selbst.",
          ],
        },
        { p: "Unter Windows lässt sich CronoStream auch wie gewohnt über die Windows-Einstellungen (Apps) deinstallieren. Der Deinstaller entfernt dann Programm, Startmenü-Ordner, Desktop-Verknüpfung und Autostart, mit der Option zum Löschen der App-Daten auch Einstellungen und Zwischenspeicher. Streams bleiben dabei immer erhalten." },
        { note: "In den App-Daten liegen auch die gesicherten Protokolle gelöschter Streams. Nach dem Entfernen lassen sich diese Streams nicht mehr wiederherstellen." },
      ],
    },

    "set-privat": {
      title: "Privatmodus: Dateien ausblenden",
      blocks: [
        { p: "Der Privatmodus blendet Dateien aus, deren Notiz einen bestimmten Text enthält. Eingeblendet werden sie erst wieder nach Eingabe eines Passworts. Er gilt je Stream und wird unter ⚙ › **Privatsphäre** eingerichtet." },
        { note: "Das ist ein Sichtschutz innerhalb der App, keine Verschlüsselung: Die Dateien bleiben unverändert im Stream-Ordner. Sicherungen enthalten immer alle Dateien, auch die ausgeblendeten." },
        { p: "**Einrichten**" },
        {
          steps: [
            "⚙ › **Privatsphäre** öffnen.",
            "**Passwort** eingeben und wiederholen (mindestens 4 Zeichen).",
            "**Kombination aufnehmen** wählen und die gewünschte Tastenkombination drücken: Strg und ein Buchstabe, außer den üblichen wie C, V oder X. Auch zwei Sondertasten sind möglich, etwa Strg+Umschalt und ein Buchstabe. Sie braucht Strg oder Alt und eine weitere Taste; schon belegte Kombinationen wie Strg+F werden abgelehnt, Esc bricht ab. Zur Kontrolle ist sie einmal im Klartext zu sehen, nach **Übernehmen** ist sie unkenntlich. **Anzeigen** und **Verbergen** schalten die Klartextanzeige in den Einstellungen um.",
            "**Notizinhalt** festlegen: Eine Datei gilt als privat, wenn ihre Notiz diesen Text enthält. Groß- und Kleinschreibung zählen nicht.",
            "Unter **Wo ausgeblendet wird** den Umfang wählen (siehe unten). Bei **Automatisch wieder ausblenden** lässt sich eine Zahl von Minuten ohne Bedienung eintragen; 0 heißt aus (ab Werk). Das Kästchen **Symbol links unten anzeigen** (ab Werk an) blendet das Auge ein oder aus.",
            "**Privatmodus einrichten** wählen. Danach erscheint einmalig der **Wiederherstellungscode**. Er gehört an einen sicheren Ort; **Code notiert** schließt die Einrichtung ab.",
          ],
        },
        { p: "**Umfang**" },
        {
          list: [
            "**Nur in der Zeitleiste:** Zeitleiste und ihre Suche zeigen private Dateien nicht. In den Dateilisten bleiben sie auffindbar.",
            "**Nur in den Ansichten** (ab Werk): Zeitleiste, Suche und Dateilisten zeigen sie nicht. Das Protokoll führt sie weiterhin auf.",
            "**Überall:** zusätzlich auch nicht im Protokoll und in Exporten. Sicherungen bleiben vollständig.",
          ],
        },
        { p: "**Im Alltag**" },
        {
          list: [
            "**Ausblenden:** die Tastenkombination drücken. Das wirkt sofort.",
            "**Einblenden:** dieselbe Kombination drücken, das **Passwort** eingeben und **Einblenden** wählen.",
            "Nach jedem Öffnen des Streams ist ausgeblendet. Mit **Automatisch wieder ausblenden** blendet er sich nach der eingestellten Zeit ohne Bedienung wieder aus.",
            "Die Kombination gilt in jeder Ansicht und jedem Dialog des geöffneten Streams.",
            "Das **Symbol ganz links unten** zeigt den Zustand: Auge = alle Dateien sichtbar, durchgestrichenes Auge = private Dateien ausgeblendet. Abschalten lässt es sich in den Einstellungen mit **Symbol links unten anzeigen**; dann ist im Fenster nicht zu erkennen, ob gerade ausgeblendet ist.",
          ],
        },
        { p: "**Einstellungen ändern, Passwort vergessen, ausschalten**" },
        {
          list: [
            "Die Sparte ist nur mit Passwort einseh- und änderbar: **Entsperren**. **Sperren** schließt sie wieder.",
            "Entsperrt lassen sich Notizinhalt, Umfang, Auto-Ausblenden und das Symbol ändern (**Änderungen speichern**), außerdem **Passwort ändern** und die Kombination **Neu aufnehmen**.",
            "**Passwort vergessen?** führt zu **Passwort neu setzen**: Dafür wird der Wiederherstellungscode gebraucht. Er ist danach verbraucht, ein neuer wird angezeigt.",
            "**Privatmodus ausschalten** entfernt Passwort, Kombination und Notizinhalt. Alle Dateien sind wieder sichtbar, die Notizen selbst bleiben erhalten.",
          ],
        },
      ],
    },
    "set-ueber": {
      title: "Über CronoStream und Lizenzen",
      blocks: [
        { p: "Ganz unten in den Einstellungen stehen Version, Urheberrecht und der Hinweis, dass CronoStream freie Software unter der Lizenz EUPL-1.2 ist (kostenlos und ohne Gewährleistung, mit Link zum Quellcode). **Open-Source-Lizenzen anzeigen** öffnet unter „Lizenzen“ eine durchsuchbare Liste, die mit CronoStream selbst beginnt und alle verwendeten Komponenten enthält. Ein Klick zeigt den vollständigen Lizenztext." },
        { p: "Die **Kaffeetasse** (Tooltip „Kaffee spendieren“) in der Kopfleiste zwischen ? und Vollbild, auf dem Startbildschirm oben rechts, öffnet die Spendenseite im Browser." },
        { p: "**Updates:** Ab Werk fragt CronoStream höchstens einmal täglich bei felixheck.de nach, ob es eine neuere Version gibt (eine kleine Datei über HTTPS; übertragen wird nur die IP-Adresse, nichts über Rechner, Dateien oder Streams). Gibt es eine, erscheint einmal je Version ein Hinweis mit **Herunterladen**; installiert wird nichts von selbst. Ohne Verbindung bleibt die Prüfung still. Der Schalter **Automatisch nach Updates suchen** schaltet das ab (gilt je Rechner), **Jetzt prüfen** fragt sofort nach und meldet auch, wenn keine Verbindung besteht." },
      ],
    },

    // ---------- Tastatur & Maus ----------
    "keys-allgemein": {
      title: "Tastenkürzel auf der Zeitleiste",
      blocks: [
        {
          keys: [
            ["Mausrad", "Zoomen (am Mauszeiger verankert)"],
            ["Ziehen", "Zeitleiste verschieben"],
            ["Klick", "Datei öffnen bzw. Stapel auflösen"],
            ["Strg+Klick", "Kachel markieren"],
            ["Strg+A", "alle sichtbaren Kacheln markieren (im Cluster: dessen Inhalt)"],
            ["Strg+F", "Suche öffnen"],
            ["Enter / Umschalt+Enter", "nächster / vorheriger Suchtreffer"],
            ["Strg+V", "Bild aus der Zwischenablage als Tagebucheintrag"],
            ["Rechtsklick", "Menü für Kachel, freie Fläche oder Phasenbalken"],
            ["Eigene Kombination", "private Dateien aus- und einblenden (⚙ › Privatsphäre)"],
            ["Esc", "oberste Ebene schließen: Bild-Zoom › Detailansicht › Cluster › Stapel › Suche › Auswahl › Phasen-Zoom. Verlässt außerdem den Vollbildmodus."],
          ],
        },
      ],
    },
    "keys-detail": {
      title: "Tastenkürzel in der Detailansicht",
      blocks: [
        {
          keys: [
            ["← / →", "vorherige / nächste Datei"],
            ["Entf", "Datei entfernen und zur nächsten springen"],
            ["+ / −, Mausrad", "Bild vergrößern / verkleinern"],
            ["Ziehen", "vergrößertes Bild verschieben"],
            ["Alt+Ziehen", "vergrößertes Bild in ein anderes Programm ziehen"],
            ["Enter / Esc", "Namens- oder Datumsfeld übernehmen / abbrechen"],
            ["Esc", "Zoom verlassen bzw. Detailansicht schließen"],
          ],
        },
      ],
    },
    "keys-browser": {
      title: "Tastenkürzel im Dateibrowser und in Dialogen",
      blocks: [
        {
          keys: [
            ["Pfeiltasten", "Übersicht/Datei-Operationen: durchs Raster bewegen"],
            ["Leertaste / Doppelklick", "Datei markieren"],
            ["Strg+A", "alle Dateien markieren (in Datei-Operationen und Papierkorb: erneut = aufheben)"],
            ["→ / ← / Rücktaste", "Einzelbild: blättern"],
            ["Strg+Enter", "Tagebucheintrag speichern"],
            ["Strg+V", "Tagebuch-Editor: Bild als Anhang einfügen"],
            ["Alt+↑ / ↓", "Themenbereiche: Bereich umsortieren"],
            ["Enter", "Dialoge mit Namensfeld: bestätigen"],
            ["Esc", "Dialog, Menü, Hilfe-Center schließen"],
          ],
        },
        { p: "Die Tasten der Datumseingabe stehen im Thema „Die Datumseingabe bedienen“." },
      ],
    },

    // ---------- Häufige Fragen ----------
    "faq-mehrere": {
      title: "Können mehrere Streams gleichzeitig offen sein?",
      blocks: [
        { p: "In einem Fenster ist immer genau ein Stream geöffnet. Mit ← oben links geht es zurück zum Startbildschirm, wo sich ein anderer öffnen lässt. Derselbe Stream kann nie in zwei Fenstern zugleich offen sein, das schützt die Datenbank; in dem Fall erscheint die Meldung „Bereits geöffnet“." },
      ],
    },
    "faq-datum-name": {
      title: "Was ist der Unterschied zwischen Datum ändern und Umbenennen?",
      blocks: [
        { p: "Datum ändern verschiebt die Datei auf der Zeitleiste. Umbenennen ändert nur den in CronoStream angezeigten Namen. Beides lässt die Datei auf der Festplatte unverändert. Für Dateinamen mit Datum und Uhrzeit gibt es den **Druckexport**." },
      ],
    },
    "faq-entfernen": {
      title: "Entfernen, „Nur Datei löschen“, endgültig löschen: was ist was?",
      blocks: [
        {
          list: [
            "**Entfernen:** nimmt die Datei von der Zeitleiste in den Papierkorb. Komplett umkehrbar (Papierkorb oder Protokoll).",
            "**Nur Datei löschen** (Papierkorb): gibt den Speicher der Arbeitskopie frei, behält aber den Eintrag. Die Datei lässt sich aus der Originalquelle zurückholen.",
            "**Endgültig löschen** (Protokoll) bzw. **Löschen + aus Datenbank entfernen** (Papierkorb): nicht umkehrbar.",
          ],
        },
        { p: "Das Original außerhalb des Stream-Ordners bleibt in allen Fällen unberührt. Mit **Arbeitskopie beim Entfernen löschen** ist schon Entfernen endgültig." },
      ],
    },
    "faq-sicherung": {
      title: "Sicherung, Kopie oder Druckexport: was wofür?",
      blocks: [
        {
          list: [
            "**Sicherung** (Verwalten): eine vollständige Kopie mit Zeitstempel zum Aufbewahren oder Mitnehmen.",
            "**Alles in neuen Stream kopieren** (Datei-Operationen): eine unabhängige Kopie unter neuem Namen, z. B. um getrennt damit weiterzuarbeiten.",
            "**Druckexport** (Datei-Operationen): nur ausgewählte Fotos, nach Datum benannt, für Druckdienste.",
            "**Kopieren in einen anderen Stream** (Datei-Operationen): ausgewählte Dateien samt Daten in einen anderen Stream.",
          ],
        },
      ],
    },
    "faq-mitnehmen": {
      title: "Wie lässt sich ein Stream auf einen anderen Rechner mitnehmen?",
      blocks: [
        { p: "Ein Stream ist ein normaler Ordner. Eine **Sicherung** auf eine externe Platte oder einen Stick anlegen oder den geschlossenen Stream-Ordner kopieren. Auf dem anderen Rechner wird er auf dem Startbildschirm über **Stream-Ordner öffnen** geöffnet. Liegt er dort unter einem anderen Pfad, fragt die App beim Öffnen „Stream wurde verschoben“ und passt die Pfade nach Zustimmung an. Daten, Notizen und Protokoll sind vollständig dabei. „Im Quellordner anzeigen“ und das Zurückholen aus der Quelle funktionieren dort nur, wenn die Originale auch dort erreichbar sind." },
      ],
    },
    "faq-formate": {
      title: "Welche Dateiarten unterstützt CronoStream?",
      blocks: [
        {
          list: [
            "**Bilder:** JPG, PNG, GIF, BMP, WebP, TIFF",
            "**Videos:** MP4, MOV, MKV, WebM, AVI, WMV, FLV, 3GP, MPG",
            "**Audio:** MP3, WAV, M4A, FLAC, OGG, AAC, WMA, AIFF",
            "**Dokumente:** PDF, DOCX, DOC, ODT, RTF, TXT (auch in ANSI und UTF-16), CSV, XLS, XLSX, mit Textsuche",
            "**E-Mails:** EML und Outlook-MSG, mit Anhängen und Textsuche",
          ],
        },
        { p: "Andere Dateien lassen sich ebenfalls hinzufügen. Sie erscheinen ohne Vorschau in der Dokumente-Spur und öffnen sich im Standardprogramm." },
      ],
    },
    "faq-duplikate": {
      title: "Wie erkennt CronoStream Duplikate?",
      blocks: [
        { p: "CronoStream bildet für jede Datei einen kurzen Fingerabdruck aus Größe sowie Anfang und Ende des Inhalts. Gleicher Fingerabdruck heißt: mögliches Duplikat, auch unter anderem Namen. Das geht auch bei großen Videos schnell." },
        {
          list: [
            "**Beim Hinzufügen:** als Vergleichskarte im Prüffenster. Fällt später beim Import noch ein Verdacht auf, kommt eine Meldung mit **An Datei-Operationen übergeben**.",
            "**Für den ganzen Bestand:** Reiter **Duplikate** unter Verwalten.",
            "**Bei der Festplattensuche:** **Duplikate ausblenden** und **Bereits im Stream enthaltene Dateien ausblenden**, wahlweise mit gründlicher Inhaltsprüfung.",
          ],
        },
        { p: "Steuern lässt sich das mit den Einstellungen **Duplikate beim Import automatisch erkennen** und **Schnellprüfung per Dateiname und Größe**." },
      ],
    },
    "faq-lokal": {
      title: "Verlassen Daten den Rechner?",
      blocks: [
        { p: "Nein. CronoStream arbeitet komplett lokal, ohne Konto, Cloud oder Upload. Ein kleiner interner Medienserver liefert Vorschaubilder nur an die eigene Oberfläche und ist von außen nicht erreichbar." },
        { p: "Die einzige Ausnahme ist eine bewusste eigene Handlung: Bei der KI-Datierung werden Dateinamen, Pfade und Metadaten von Hand in ein frei gewähltes KI-Programm kopiert, niemals Dateiinhalte. Außerhalb des AppImage kann der Aufnahme-Dialog unter Linux außerdem ffmpeg über die Paketverwaltung installieren." },
        { p: "Auch innerhalb der App lassen sich Dateien verbergen: der **Privatmodus** (⚙ › Privatsphäre) blendet Dateien mit einem bestimmten Notiztext per Tastenkombination aus. Das ist ein Sichtschutz, keine Verschlüsselung." },
      ],
    },
    "faq-arbeitet": {
      title: "Die App arbeitet: Fortschritt und Abbrechen",
      blocks: [
        { p: "Längere Vorgänge zeigen oben rechts eine Fortschrittskarte mit Balken und aktuellem Dateinamen, kurze Wartezeiten unten rechts die Pille „Arbeitet…“. Kopieren, Sicherung und Festplattensuche lassen sich abbrechen, Halbfertiges räumt CronoStream selbst auf." },
        { p: "Rückmeldungen erscheinen als kleine Karten unten in der Mitte, manche mit einem Aktionsknopf (z. B. **An Datei-Operationen übergeben**)." },
      ],
    },
  },
};
