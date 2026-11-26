# CronoStream

Desktop-App (Tauri + React + TypeScript), die Fotos, Videos, Audios, Dokumente, E-Mails und
Tagebucheinträge eines Lebens auf einer gemeinsamen Zeitleiste ordnet. Jeder „Stream“ ist ein eigener Ordner
mit Datenbank und Kopien der Dateien; die Originale bleiben unangetastet.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Fenster-Verhalten

Neben dem Hauptfenster gibt es ein kleines, immer im Vordergrund schwebendes
Mini-Fenster („Ablage") als systemweites Drag-&-Drop-Ziel. Es wird aus der App
heraus geöffnet — über „Ablage-Fenster" auf dem Startbildschirm oder das
📥-Symbol in der Stream-Topbar — und mit seinem ✕ wieder weggelegt; der
Inhalt der Warteliste bleibt dabei erhalten (persistiert in
`pending_drops.sqlite` im App-Konfigurationsverzeichnis).

Das ✕ des **Hauptfensters** beendet die App wie gewohnt vollständig und gibt
dabei die Lock-Datei des geöffneten Streams frei.

Die Ablage (`--ablage`) läuft als **System-Tray-Icon** ohne Fenster; der Kreis
öffnet sich per Linksklick, Rechtsklick auf den Kreis legt ihn zurück und gibt
die WebView frei. Unter Linux ist das ein eigenes StatusNotifierItem (`ksni`,
reines DBus, keine Bibliothek nötig), weil AppIndicator keine Klicks meldet;
GNOME zeigt es nur mit der AppIndicator-Erweiterung. Scheitert der Tray, bleibt der Kreis wie früher sichtbar.

## Build-Ausgabeort (nur lokale Entwicklung)

Auf der Hauptentwicklungsmaschine ist die Home-Partition knapp bemessen,
daher leitet dort eine lokale, **nicht eingecheckte**
`src-tauri/.cargo/config.toml` (`.gitignore`t, siehe Kommentar dort) den
Cargo-Build auf ein größeres Laufwerk um. Dieser Pfad ist maschinenspezifisch
und absichtlich nicht Teil des Repos — ein fest codierter Pfad würde Builds
auf anderen Rechnern oder in Cloud-Sandboxes riskieren (Verzeichnis existiert
dort nicht). Wer auf dieser Maschine baut und seine eigene `target`/`.cargo`-
Konfiguration braucht, legt sie lokal selbst an; alle anderen Umgebungen
nutzen einfach den Cargo-Standardpfad (`src-tauri/target`).

## Bekannte Einschränkung: Video-/Audioaufnahme unter Linux (X11 + Portal)

Die Aufnahmefunktion (🎥/🎙️-Icons, `RecordMedia.tsx`) nutzt `navigator.mediaDevices.getUserMedia`
+ `MediaRecorder`. Unter Linux geht WebKitGTK dafür zwingend über das
`xdg-desktop-portal`-Kamera-Portal (PipeWire-basiert) — unabhängig davon, ob
die App sandboxed ist.

Auf mindestens einem getesteten System (Linux Mint/Cinnamon, X11,
webkit2gtk 2.52.6, wry 0.57.0) scheitert dieser Portal-Handshake:

```
xdg-desktop-portal: Failed to associate portal window with parent window
wireplumber: Failed to call Lookup: ... No entry for camera
```

Das Portal kann der App kein gültiges Fenster-Handle zuordnen, zeigt deshalb
nie den Berechtigungsdialog, speichert nie eine Erlaubnis, und `getUserMedia`
läuft in einen Timeout ("0 Geräte gefunden") — obwohl die Kamera selbst
einwandfrei funktioniert (z. B. mit Cheese, das die Kamera direkt per V4L2
anspricht statt über das Portal).

Das Handling in `src-tauri/src/lib.rs` (`enable_media_stream`,
`on_permission_request`) ist korrekt und greift — der Fehler sitzt im
internen Portal-Client von WebKitGTK selbst, außerhalb der Kontrolle von
`wry`/Tauri. Windows (WebView2) und macOS (WKWebView) sind davon nicht
betroffen, da beide Engines `getUserMedia` ohne Portal-Zwischenschritt
anbieten.

**Noch nicht verfolgte Lösungswege**, falls das später angegangen wird:
manuelles Eintragen der Portal-Berechtigung, Versionsupdate von
`xdg-desktop-portal-gtk`, oder ein Linux-spezifischer Aufnahme-Fallback im
Rust-Backend direkt per GStreamer (wie Cheese), der das Portal umgeht.

## Lizenz

CronoStream ist freie Software unter der **European Union Public Licence 1.2** (EUPL-1.2), siehe [`LICENSE`](LICENSE).
Die EUPL gilt gleichwertig in allen Amtssprachen der EU; die spanische und die deutsche Fassung
stehen unter <https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12>.

Copyright © 2026 Felix Heck. Licensed under the EUPL.

Die Software wird ohne Gewährleistung bereitgestellt (EUPL Artikel 7 und 8).
Die Lizenzen aller mitgelieferten Fremdkomponenten zeigt die App unter Einstellungen → Über CronoStream;
erzeugt werden sie mit `scripts/generate-third-party-licenses.mjs`.

**Name und Logo:** Die EUPL erlaubt keine Nutzung von Namen und Marken des Lizenzgebers (Artikel 5,
„Legal Protection“). Abgewandelte Fassungen bitte unter einem anderen Namen und ohne das CronoStream-Logo
veröffentlichen. Logo und Programmbilder wurden mit KI (Google Flow) erstellt.
