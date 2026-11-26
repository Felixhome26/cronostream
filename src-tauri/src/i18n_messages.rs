//! English and Spanish for every backend message, keyed by the German
//! original exactly as written at the call site (see `i18n.rs`). A message
//! changed there must be changed here too, or it silently stays German.

pub const MESSAGES: &[(&str, &str, &str)] = &[
    (
        "„{path}“ ist kein Ordner.",
        "“{path}” is not a folder.",
        "«{path}» no es una carpeta.",
    ),
    (
        "„{path}“ enthält mit allen Unterordnern zu viele Einträge, um überwacht zu werden.",
        "“{path}” contains too many entries including its subfolders to be watched.",
        "«{path}» contiene demasiadas entradas con todas sus subcarpetas para vigilarla.",
    ),
    ("CronoStream – Ablage", "CronoStream – Drop box", "CronoStream – Bandeja"),
    ("Ablage öffnen", "Open drop box", "Abrir bandeja"),
    ("Beenden", "Quit", "Salir"),
    (
        "AVFoundation: Bildpuffer konnte nicht angelegt werden",
        "AVFoundation: could not create image buffer",
        "AVFoundation: no se pudo crear el búfer de imagen",
    ),
    (
        "AVFoundation: kein Farbraum",
        "AVFoundation: no color space",
        "AVFoundation: sin espacio de color",
    ),
    (
        "Anlage nicht gefunden.",
        "Attachment not found.",
        "No se encontró el adjunto.",
    ),
    (
        "Anlage {number}",
        "Attachment {number}",
        "Adjunto {number}",
    ),
    (
        "Aufnahme-Zustand ist beschädigt.",
        "Recording state is corrupted.",
        "El estado de la grabación está dañado.",
    ),
    (
        "Bitte einen gültigen Namen eingeben.",
        "Please enter a valid name.",
        "Introducir un nombre válido.",
    ),
    (
        "Das Datum darf nicht in der Zukunft liegen.",
        "The date must not be in the future.",
        "La fecha no puede estar en el futuro.",
    ),
    (
        "Das Datum darf nicht vor dem Jahr {min_year} liegen.",
        "The date must not be before the year {min_year}.",
        "La fecha no puede ser anterior al año {min_year}.",
    ),
    (
        "Das Dokument ist zu groß für die Textansicht.",
        "The document is too large for the text view.",
        "El documento es demasiado grande para la vista de texto.",
    ),
    (
        "Das Gerät ist belegt – vermutlich benutzt es gerade ein anderes Programm.",
        "The device is busy – another program is probably using it.",
        "El dispositivo está ocupado; probablemente otro programa lo está usando.",
    ),
    (
        "Das Gerät liefert keine Daten.",
        "The device delivers no data.",
        "El dispositivo no entrega datos.",
    ),
    (
        "Der Stream wurde während des Vorgangs geschlossen.",
        "The stream was closed during the operation.",
        "El stream se cerró durante la operación.",
    ),
    (
        "Das Protokoll konnte nicht gesichert werden, es wurde nichts gelöscht.",
        "The history could not be backed up; nothing was deleted.",
        "No se pudo guardar una copia del historial; no se eliminó nada.",
    ),
    (
        "Das Rückgängigmachen würde Phasen überschneiden lassen: {pairs}. Überlappung ist in „{group}“ nicht erlaubt.",
        "Undoing this would make phases overlap: {pairs}. Overlap is not allowed in \"{group}\".",
        "Deshacer esto haría que las fases se solaparan: {pairs}. En «{group}» no se permite el solapamiento.",
    ),
    (
        "Das Ziel hat keinen Namen.",
        "The destination has no name.",
        "El destino no tiene nombre.",
    ),
    (
        "Das Ziel hat keinen übergeordneten Ordner.",
        "The destination has no parent folder.",
        "El destino no tiene carpeta superior.",
    ),
    (
        "Das Ziel liegt im Quellordner selbst — die Kopie würde sich dort endlos selbst kopieren. Bitte einen Ort außerhalb wählen.",
        "The destination is inside the source folder itself — the copy would keep copying itself endlessly. Please choose a location outside it.",
        "El destino está dentro de la propia carpeta de origen: la copia se copiaría a sí misma sin fin. Elegir una ubicación fuera de ella.",
    ),
    (
        "Das enthält keine gültige KI-Antwort im erwarteten Format.",
        "This does not contain a valid AI response in the expected format.",
        "Esto no contiene una respuesta de IA válida en el formato esperado.",
    ),
    (
        "Das gewählte Gerät wurde nicht gefunden.",
        "The selected device was not found.",
        "No se encontró el dispositivo seleccionado.",
    ),
    (
        "Das ist der Benutzerordner und wird nicht gelöscht.",
        "This is the user's home folder and will not be deleted.",
        "Esta es la carpeta de usuario y no se eliminará.",
    ),
    (
        "Das ist der gerade geöffnete Stream. Bitte einen anderen wählen.",
        "This is the stream that is currently open. Please choose another one.",
        "Este es el stream abierto actualmente. Elegir otro.",
    ),
    (
        "Das ist ein Ordner, keine Datei",
        "This is a folder, not a file",
        "Esto es una carpeta, no un archivo",
    ),
    (
        "Das ist kein Ordner.",
        "This is not a folder.",
        "Esto no es una carpeta.",
    ),
    (
        "Datei nicht gefunden",
        "File not found",
        "Archivo no encontrado",
    ),
    (
        "Der Eintrag ist leer.",
        "The entry is empty.",
        "La entrada está vacía.",
    ),
    (
        "Der Name",
        "The name",
        "El nombre",
    ),
    (
        "Der Quellordner ist nicht lesbar.",
        "The source folder cannot be read.",
        "No se puede leer la carpeta de origen.",
    ),
    (
        "Der Themenbereich „{name}“ ist entfernt. Zuerst muss das Entfernen rückgängig gemacht werden.",
        "The topic area \"{name}\" has been removed. Its removal has to be undone first.",
        "El área temática «{name}» se ha quitado. Primero hay que deshacer su eliminación.",
    ),
    (
        "Der Titel",
        "The title",
        "El título",
    ),
    (
        "Der Zielordner existiert nicht.",
        "The target folder does not exist.",
        "La carpeta de destino no existe.",
    ),
    (
        "Die Aufnahme hat keinen Ordner.",
        "The recording has no folder.",
        "La grabación no tiene carpeta.",
    ),
    (
        "Die Aufnahme konnte nicht fertiggestellt werden: {detail}",
        "The recording could not be finished: {detail}",
        "No se pudo finalizar la grabación: {detail}",
    ),
    (
        "Die Aufnahme konnte nicht gestartet werden ({detail}).",
        "The recording could not be started ({detail}).",
        "No se pudo iniciar la grabación ({detail}).",
    ),
    (
        "Die Aufnahme konnte nicht gestartet werden.",
        "The recording could not be started.",
        "No se pudo iniciar la grabación.",
    ),
    (
        "Ist dort schon vorhanden.",
        "Already there.",
        "Ya está allí.",
    ),
    (
        "Gleicher Inhalt ist dort schon vorhanden: {name}",
        "The same content is already there: {name}",
        "El mismo contenido ya está allí: {name}",
    ),
    (
        "Die Datei fehlt im Quellordner.",
        "The file is missing from the source folder.",
        "El archivo falta en la carpeta de origen.",
    ),
    (
        "Die Installation wurde abgebrochen (keine Berechtigung erteilt).",
        "The installation was cancelled (no permission granted).",
        "La instalación se canceló (no se concedió permiso).",
    ),
    (
        "Die Notiz darf nicht leer sein.",
        "The note must not be empty.",
        "La nota no puede estar vacía.",
    ),
    (
        "Die Originaldatei von „{label}“ liegt nicht mehr im Quellordner. Das Ersetzen kann nicht rückgängig gemacht werden.",
        "The original file of \"{label}\" is no longer in the source folder. The replacement cannot be undone.",
        "El archivo original de «{label}» ya no está en la carpeta de origen. La sustitución no se puede deshacer.",
    ),
    (
        "Die PDF-Bibliothek (PDFium) wurde nicht gefunden.",
        "The PDF library (PDFium) was not found.",
        "No se encontró la biblioteca PDF (PDFium).",
    ),
    (
        "Die Paketverwaltung meldet einen Fehler: {last}",
        "The package manager reports an error: {last}",
        "El gestor de paquetes informa de un error: {last}",
    ),
    (
        "Die Phase „{label}“ ist entfernt. Zuerst muss das Entfernen rückgängig gemacht werden.",
        "The phase \"{label}\" has been removed. Its removal has to be undone first.",
        "La fase «{label}» se ha quitado. Primero hay que deshacer su eliminación.",
    ),
    (
        "Die Phasen von „{group}“ würden sich überschneiden: {pairs}.",
        "The phases of \"{group}\" would overlap: {pairs}.",
        "Las fases de «{group}» se solaparían: {pairs}.",
    ),
    (
        "Die RTF-Datei ist zu groß für die Textansicht.",
        "The RTF file is too large for the text view.",
        "El archivo RTF es demasiado grande para la vista de texto.",
    ),
    (
        "Diese Aktion wurde bereits rückgängig gemacht.",
        "This action has already been undone.",
        "Esta acción ya se ha deshecho.",
    ),
    (
        "Diese Aktion wurde bereits vollständig rückgängig gemacht.",
        "This action has already been fully undone.",
        "Esta acción ya se ha deshecho por completo.",
    ),
    (
        "Diese Datei ist bereits im Stream vorhanden.",
        "This file is already in the stream.",
        "Este archivo ya está en el stream.",
    ),
    (
        "Diese Phase existiert nicht mehr.",
        "This phase no longer exists.",
        "Esta fase ya no existe.",
    ),
    (
        "Diese Suche läuft nicht (mehr).",
        "This search is not running (anymore).",
        "Esta búsqueda no está en curso (ya).",
    ),
    (
        "Diese Textdatei konnte nicht gelesen werden.",
        "This text file could not be read.",
        "No se pudo leer este archivo de texto.",
    ),
    (
        "Dieser Stream ist gerade geöffnet und muss zuerst geschlossen werden.",
        "This stream is currently open and must be closed first.",
        "Este stream está abierto y primero hay que cerrarlo.",
    ),
    (
        "Dieser Stream ist gerade in einem anderen Fenster geöffnet und muss dort zuerst geschlossen werden.",
        "This stream is currently open in another window and must be closed there first.",
        "Este stream está abierto en otra ventana y primero hay que cerrarlo allí.",
    ),
    (
        "Dieser Ordner enthält bereits einen Stream.",
        "This folder already contains a stream.",
        "Esta carpeta ya contiene un stream.",
    ),
    (
        "Dieser Ordner enthält keinen Stream.",
        "This folder does not contain a stream.",
        "Esta carpeta no contiene ningún stream.",
    ),
    (
        "Dieser Ordner enthält mehr als {MAX_INDEX_ENTRIES} Dateien — das ist zu groß, um ihn auf einmal zu durchsuchen. Bitte einen spezifischeren Unterordner wählen.",
        "This folder contains more than {MAX_INDEX_ENTRIES} files — too many to search at once. Please choose a more specific subfolder.",
        "Esta carpeta contiene más de {MAX_INDEX_ENTRIES} archivos: demasiados para buscar de una vez. Elegir una subcarpeta más concreta.",
    ),
    (
        "Dieser Ordner enthält mit allen Unterordnern mehr als {MAX_WALK_ENTRIES} Dateien — das ist zu groß, um alles auf einmal anzuzeigen. Bitte den Toggle ausschalten oder einen spezifischeren Unterordner wählen.",
        "Including all subfolders, this folder contains more than {MAX_WALK_ENTRIES} files — too many to show at once. Please turn the switch off or choose a more specific subfolder.",
        "Con todas sus subcarpetas, esta carpeta contiene más de {MAX_WALK_ENTRIES} archivos: demasiados para mostrarlos de una vez. Desactivar el interruptor o elegir una subcarpeta más concreta.",
    ),
    (
        "Dieser Ordner existiert nicht (mehr).",
        "This folder does not exist (anymore).",
        "Esta carpeta no existe (ya).",
    ),
    (
        "Dieser Ordner gehört zu CronoStream selbst und wird nicht gelöscht.",
        "This folder belongs to CronoStream itself and will not be deleted.",
        "Esta carpeta pertenece al propio CronoStream y no se eliminará.",
    ),
    (
        "Dieser Ordner liegt zu weit oben im Dateisystem, um gelöscht zu werden.",
        "This folder is too high up in the file system to be deleted.",
        "Esta carpeta está demasiado arriba en el sistema de archivos para eliminarla.",
    ),
    (
        "Dieser Pfad gehört nicht zum Aufnahme-Zwischenspeicher.",
        "This path does not belong to the recording cache.",
        "Esta ruta no pertenece a la memoria temporal de grabación.",
    ),
    (
        "Dieser Protokolleintrag existiert nicht mehr.",
        "This history entry no longer exists.",
        "Esta entrada del historial ya no existe.",
    ),
    (
        "Dieser Themenbereich existiert nicht mehr.",
        "This topic area no longer exists.",
        "Esta área temática ya no existe.",
    ),
    (
        "Dieser Vorgang läuft nicht (mehr).",
        "This operation is not running (anymore).",
        "Esta operación no está en curso (ya).",
    ),
    (
        "Dieser Zielordner existiert nicht.",
        "This target folder does not exist.",
        "Esta carpeta de destino no existe.",
    ),
    (
        "Dieser gelöschte Stream ist nicht mehr vorhanden.",
        "This deleted stream is no longer available.",
        "Este stream eliminado ya no está disponible.",
    ),
    (
        "Dieses Backup-Ziel existiert bereits. Bitte erneut versuchen.",
        "This backup destination already exists. Please try again.",
        "Este destino de copia de seguridad ya existe. Volver a intentarlo.",
    ),
    (
        "Dieses ffmpeg hat keinen geeigneten Encoder – bitte ffmpeg über CronoStream neu installieren.",
        "This ffmpeg has no suitable encoder – please reinstall ffmpeg via CronoStream.",
        "Este ffmpeg no tiene un codificador adecuado: reinstalar ffmpeg desde CronoStream.",
    ),
    (
        "Ein Ordner mit diesem Namen existiert bereits an diesem Ort. Bitte einen anderen Namen wählen.",
        "A folder with this name already exists at this location. Please choose a different name.",
        "Ya existe una carpeta con este nombre en esta ubicación. Elegir otro nombre.",
    ),
    (
        "Ein unvollständiger früherer Versuch liegt noch unter „{path}“. Bitte diesen Ordner prüfen und löschen, dann erneut starten.",
        "An incomplete earlier attempt is still at \"{path}\". Please check and delete this folder, then start again.",
        "Todavía hay un intento anterior incompleto en «{path}». Revisar y eliminar esa carpeta y volver a empezar.",
    ),
    (
        "Eintrag nicht gefunden.",
        "Entry not found.",
        "Entrada no encontrada.",
    ),
    (
        "Eintrag nicht gefunden: {e}",
        "Entry not found: {e}",
        "Entrada no encontrada: {e}",
    ),
    (
        "Endgültig gelöschte Dateien können nicht wiederhergestellt werden.",
        "Permanently deleted files cannot be restored.",
        "Los archivos eliminados definitivamente no se pueden restaurar.",
    ),
    (
        "Es ist keine Aufnahme geöffnet.",
        "No recording is open.",
        "No hay ninguna grabación abierta.",
    ),
    (
        "Es ist nichts ausgewählt.",
        "Nothing is selected.",
        "No hay nada seleccionado.",
    ),
    (
        "Es wurde kein Mikrofon gefunden.",
        "No microphone was found.",
        "No se encontró ningún micrófono.",
    ),
    (
        "Es wurde keine Kamera gefunden.",
        "No camera was found.",
        "No se encontró ninguna cámara.",
    ),
    (
        "Es wurden keine Daten aufgezeichnet – bitte noch einmal versuchen.",
        "No data was recorded – please try again.",
        "No se grabó ningún dato; volver a intentarlo.",
    ),
    (
        "Export fehlgeschlagen: {e}",
        "Export failed: {e}",
        "Error al exportar: {e}",
    ),
    (
        "Für diesen Dateityp kann aktuell noch keine Vorschau erzeugt werden, daher kann die Datei noch nicht hinzugefügt werden.",
        "No preview can be created for this file type yet, so the file cannot be added yet.",
        "Todavía no se puede crear una vista previa para este tipo de archivo, por lo que aún no se puede añadir.",
    ),
    (
        "Hintergrund-Aufgabe fehlgeschlagen: {e}",
        "Background task failed: {e}",
        "Error en la tarea en segundo plano: {e}",
    ),
    (
        "In diesem Ordner liegt kein Stream.",
        "There is no stream in this folder.",
        "En esta carpeta no hay ningún stream.",
    ),
    (
        "In „{title}“ läge das Enddatum danach vor dem Startdatum.",
        "In \"{title}\" the end date would then be before the start date.",
        "En «{title}» la fecha de fin quedaría antes de la fecha de inicio.",
    ),
    (
        "Installation abgebrochen: {e}",
        "Installation cancelled: {e}",
        "Instalación cancelada: {e}",
    ),
    (
        "Interner Fehler beim Verarbeiten der Datei. {detail}",
        "Internal error while processing the file. {detail}",
        "Error interno al procesar el archivo. {detail}",
    ),
    (
        "Kein Stream geöffnet",
        "No stream open",
        "No hay ningún stream abierto",
    ),
    (
        "Kein Zugriff auf das Gerät – bitte den Zugriff in den Datenschutz-Einstellungen des Systems erlauben.",
        "No access to the device – please allow access in the system's privacy settings.",
        "Sin acceso al dispositivo: permitir el acceso en los ajustes de privacidad del sistema.",
    ),
    (
        "Keine Vorschau für diesen Dateityp.",
        "No preview for this file type.",
        "No hay vista previa para este tipo de archivo.",
    ),
    (
        "Keine bekannte Paketverwaltung gefunden.",
        "No known package manager found.",
        "No se encontró ningún gestor de paquetes conocido.",
    ),
    (
        "Konnte '{original_filename}' nicht kopieren: {e}",
        "Could not copy '{original_filename}': {e}",
        "No se pudo copiar '{original_filename}': {e}",
    ),
    (
        "Konnte Anhang nicht speichern: {e}",
        "Could not save attachment: {e}",
        "No se pudo guardar el adjunto: {e}",
    ),
    (
        "Konnte Anhang-Ordner nicht anlegen: {e}",
        "Could not create attachment folder: {e}",
        "No se pudo crear la carpeta de adjuntos: {e}",
    ),
    (
        "Konnte Anlage nicht schreiben: {e}",
        "Could not write attachment: {e}",
        "No se pudo escribir el adjunto: {e}",
    ),
    (
        "Konnte Anzeigename nicht speichern: {e}",
        "Could not save display name: {e}",
        "No se pudo guardar el nombre visible: {e}",
    ),
    (
        "Konnte Anzeigename nicht wiederherstellen: {e}",
        "Could not restore display name: {e}",
        "No se pudo restaurar el nombre visible: {e}",
    ),
    (
        "Konnte App-Einstellungen nicht speichern: {e}",
        "Could not save app settings: {e}",
        "No se pudieron guardar los ajustes de la aplicación: {e}",
    ),
    (
        "Konnte Auswahl nicht speichern: {e}",
        "Could not save selection: {e}",
        "No se pudo guardar la selección: {e}",
    ),
    (
        "Konnte Bild nicht lesen: {err}",
        "Could not read image: {err}",
        "No se pudo leer la imagen: {err}",
    ),
    (
        "Konnte Bild nicht lesen: {e}",
        "Could not read image: {e}",
        "No se pudo leer la imagen: {e}",
    ),
    (
        "Konnte Bild nicht schreiben: {e}",
        "Could not write image: {e}",
        "No se pudo escribir la imagen: {e}",
    ),
    (
        "Konnte Bild nicht skalieren: {e}",
        "Could not scale image: {e}",
        "No se pudo escalar la imagen: {e}",
    ),
    (
        "Konnte Bild nicht speichern: {e}",
        "Could not save image: {e}",
        "No se pudo guardar la imagen: {e}",
    ),
    (
        "Konnte Datei nicht kopieren: {e}",
        "Could not copy file: {e}",
        "No se pudo copiar el archivo: {e}",
    ),
    (
        "Konnte Datei nicht lesen: {e}",
        "Could not read file: {e}",
        "No se pudo leer el archivo: {e}",
    ),
    (
        "Konnte Datei nicht wiederherstellen: {e}",
        "Could not restore file: {e}",
        "No se pudo restaurar el archivo: {e}",
    ),
    (
        "Konnte Datenbank nicht aktualisieren: {e}",
        "Could not update database: {e}",
        "No se pudo actualizar la base de datos: {e}",
    ),
    (
        "Konnte Datenbankschema nicht anlegen: {e}",
        "Could not create database schema: {e}",
        "No se pudo crear el esquema de la base de datos: {e}",
    ),
    (
        "Konnte Datenbankschema nicht prüfen: {e}",
        "Could not check database schema: {e}",
        "No se pudo comprobar el esquema de la base de datos: {e}",
    ),
    (
        "Konnte Datum nicht speichern: {e}",
        "Could not save date: {e}",
        "No se pudo guardar la fecha: {e}",
    ),
    (
        "Konnte Datum nicht wiederherstellen: {e}",
        "Could not restore date: {e}",
        "No se pudo restaurar la fecha: {e}",
    ),
    (
        "Konnte Datum nicht übernehmen: {e}",
        "Could not apply date: {e}",
        "No se pudo aplicar la fecha: {e}",
    ),
    (
        "Konnte Dokumentinhalt nicht lesen: {e}",
        "Could not read document content: {e}",
        "No se pudo leer el contenido del documento: {e}",
    ),
    (
        "Konnte Drehung nicht speichern: {e}",
        "Could not save rotation: {e}",
        "No se pudo guardar el giro: {e}",
    ),
    (
        "Konnte Einstellung nicht lesen: {e}",
        "Could not read setting: {e}",
        "No se pudo leer el ajuste: {e}",
    ),
    (
        "Konnte Einstellung nicht speichern: {e}",
        "Could not save setting: {e}",
        "No se pudo guardar el ajuste: {e}",
    ),
    (
        "Konnte Einstellung nicht zurücksetzen: {e}",
        "Could not reset setting: {e}",
        "No se pudo restablecer el ajuste: {e}",
    ),
    (
        "Anhang „{name}“ fehlt im Quellordner.",
        "Attachment \"{name}\" is missing from the source folder.",
        "Falta el adjunto «{name}» en la carpeta de origen.",
    ),
    (
        "Anhang",
        "Attachment",
        "Adjunto",
    ),
    (
        "Tagebucheintrag",
        "Diary entry",
        "Entrada de diario",
    ),
    (
        "Unbekannte Einstellung: {key}",
        "Unknown setting: {key}",
        "Ajuste desconocido: {key}",
    ),
    (
        "Konnte Eintrag nicht aktualisieren: {e}",
        "Could not update entry: {e}",
        "No se pudo actualizar la entrada: {e}",
    ),
    (
        "Konnte Eintrag nicht anlegen: {e}",
        "Could not create entry: {e}",
        "No se pudo crear la entrada: {e}",
    ),
    (
        "Konnte Eintrag nicht entfernen: {e}",
        "Could not remove entry: {e}",
        "No se pudo quitar la entrada: {e}",
    ),
    (
        "Konnte Eintrag nicht speichern: {e}",
        "Could not save entry: {e}",
        "No se pudo guardar la entrada: {e}",
    ),
    (
        "Konnte Eintrag nicht wiederherstellen: {e}",
        "Could not restore entry: {e}",
        "No se pudo restaurar la entrada: {e}",
    ),
    (
        "Konnte Export-Datei nicht schreiben: {e}",
        "Could not write export file: {e}",
        "No se pudo escribir el archivo de exportación: {e}",
    ),
    (
        "Konnte Export-Historie nicht löschen: {e}",
        "Could not delete export history: {e}",
        "No se pudo eliminar el historial de exportación: {e}",
    ),
    (
        "Konnte Import nicht speichern: {e}",
        "Could not save import: {e}",
        "No se pudo guardar la importación: {e}",
    ),
    (
        "Konnte Konfigurationsordner nicht anlegen: {e}",
        "Could not create configuration folder: {e}",
        "No se pudo crear la carpeta de configuración: {e}",
    ),
    (
        "Konnte Konfigurationsordner nicht ermitteln: {e}",
        "Could not determine configuration folder: {e}",
        "No se pudo determinar la carpeta de configuración: {e}",
    ),
    (
        "Konnte Notiz nicht löschen: {e}",
        "Could not delete note: {e}",
        "No se pudo eliminar la nota: {e}",
    ),
    (
        "Konnte Notiz nicht speichern: {e}",
        "Could not save note: {e}",
        "No se pudo guardar la nota: {e}",
    ),
    (
        "Konnte Ordner nicht anlegen: {e}",
        "Could not create folder: {e}",
        "No se pudo crear la carpeta: {e}",
    ),
    (
        "Konnte Ordner nicht lesen: {e}",
        "Could not read folder: {e}",
        "No se pudo leer la carpeta: {e}",
    ),
    (
        "Konnte Ordnerstruktur nicht anlegen: {e}",
        "Could not create folder structure: {e}",
        "No se pudo crear la estructura de carpetas: {e}",
    ),
    (
        "Konnte PDF-Vorschau nicht speichern: {e}",
        "Could not save PDF preview: {e}",
        "No se pudo guardar la vista previa del PDF: {e}",
    ),
    (
        "Konnte Phase nicht aktualisieren: {e}",
        "Could not update phase: {e}",
        "No se pudo actualizar la fase: {e}",
    ),
    (
        "Konnte Phase nicht anlegen: {e}",
        "Could not create phase: {e}",
        "No se pudo crear la fase: {e}",
    ),
    (
        "Konnte Phase nicht entfernen: {e}",
        "Could not remove phase: {e}",
        "No se pudo quitar la fase: {e}",
    ),
    (
        "Konnte Phase nicht lesen: {e}",
        "Could not read phase: {e}",
        "No se pudo leer la fase: {e}",
    ),
    (
        "Konnte Phase nicht speichern: {e}",
        "Could not save phase: {e}",
        "No se pudo guardar la fase: {e}",
    ),
    (
        "Konnte Phasen nicht entfernen: {e}",
        "Could not remove phases: {e}",
        "No se pudieron quitar las fases: {e}",
    ),
    (
        "Konnte Phasen nicht lesen: {e}",
        "Could not read phases: {e}",
        "No se pudieron leer las fases: {e}",
    ),
    (
        "Konnte Sperrdatei des Streams nicht anlegen: {e}",
        "Could not create the stream lock file: {e}",
        "No se pudo crear el archivo de bloqueo del stream: {e}",
    ),
    (
        "Konnte Datenbank des Streams nicht anlegen: {e}",
        "Could not create the stream database: {e}",
        "No se pudo crear la base de datos del stream: {e}",
    ),
    (
        "Konnte Datenbank des Streams nicht öffnen: {e}",
        "Could not open the stream database: {e}",
        "No se pudo abrir la base de datos del stream: {e}",
    ),
    (
        "Konnte Protokoll nicht aktualisieren: {e}",
        "Could not update history: {e}",
        "No se pudo actualizar el historial: {e}",
    ),
    (
        "Konnte Protokoll nicht lesen: {e}",
        "Could not read history: {e}",
        "No se pudo leer el historial: {e}",
    ),
    (
        "Konnte Protokoll nicht schreiben: {e}",
        "Could not write history: {e}",
        "No se pudo escribir el historial: {e}",
    ),
    (
        "Konnte Protokolleinträge nicht löschen: {e}",
        "Could not delete history entries: {e}",
        "No se pudieron eliminar las entradas del historial: {e}",
    ),
    (
        "Konnte Quelle nicht lesen: {e}",
        "Could not read source: {e}",
        "No se pudo leer el origen: {e}",
    ),
    (
        "Konnte RTF nicht lesen: {e}",
        "Could not read RTF: {e}",
        "No se pudo leer el RTF: {e}",
    ),
    (
        "Konnte Reihenfolge nicht speichern: {e}",
        "Could not save order: {e}",
        "No se pudo guardar el orden: {e}",
    ),
    (
        "Konnte Schriftart nicht laden.",
        "Could not load font.",
        "No se pudo cargar la fuente.",
    ),
    (
        "Konnte Such-Index nicht speichern: {e}",
        "Could not save search index: {e}",
        "No se pudo guardar el índice de búsqueda: {e}",
    ),
    (
        "Konnte Themenbereich nicht anlegen: {e}",
        "Could not create topic area: {e}",
        "No se pudo crear el área temática: {e}",
    ),
    (
        "Konnte Themenbereich nicht entfernen: {e}",
        "Could not remove topic area: {e}",
        "No se pudo quitar el área temática: {e}",
    ),
    (
        "Konnte Themenbereich nicht lesen: {e}",
        "Could not read topic area: {e}",
        "No se pudo leer el área temática: {e}",
    ),
    (
        "Konnte Themenbereich nicht speichern: {e}",
        "Could not save topic area: {e}",
        "No se pudo guardar el área temática: {e}",
    ),
    (
        "Konnte Videolänge nicht ermitteln.",
        "Could not determine video length.",
        "No se pudo determinar la duración del vídeo.",
    ),
    (
        "Konnte Vorschau nicht erzeugen: {e}",
        "Could not create preview: {e}",
        "No se pudo crear la vista previa: {e}",
    ),
    (
        "Konnte Vorschau nicht lesen: {e}",
        "Could not read preview: {e}",
        "No se pudo leer la vista previa: {e}",
    ),
    (
        "Konnte Vorschau-Ordner nicht anlegen: {e}",
        "Could not create preview folder: {e}",
        "No se pudo crear la carpeta de vistas previas: {e}",
    ),
    (
        "Konnte Vorschaubild nicht schreiben: {e}",
        "Could not write thumbnail: {e}",
        "No se pudo escribir la miniatura: {e}",
    ),
    (
        "Konnte Vorschaubild nicht speichern: {e}",
        "Could not save thumbnail: {e}",
        "No se pudo guardar la miniatura: {e}",
    ),
    (
        "Konnte Zielordner nicht anlegen: {e}",
        "Could not create target folder: {e}",
        "No se pudo crear la carpeta de destino: {e}",
    ),
    (
        "Konnte Zwischenspeicher nicht anlegen: {e}",
        "Could not create cache: {e}",
        "No se pudo crear la memoria temporal: {e}",
    ),
    (
        "Konnte das Protokoll nicht einlesen: {e}",
        "Could not load the history: {e}",
        "No se pudo cargar el historial: {e}",
    ),
    (
        "Konnte das Protokoll nicht sichern: {e}",
        "Could not back up the history: {e}",
        "No se pudo guardar una copia del historial: {e}",
    ),
    (
        "Konnte den Ordner nicht löschen: {e}",
        "Could not delete the folder: {e}",
        "No se pudo eliminar la carpeta: {e}",
    ),
    (
        "Konnte den Pfad nicht auflösen: {e}",
        "Could not resolve the path: {e}",
        "No se pudo resolver la ruta: {e}",
    ),
    (
        "Konnte den Zielordner nicht anlegen: {e}",
        "Could not create the target folder: {e}",
        "No se pudo crear la carpeta de destino: {e}",
    ),
    (
        "Konnte den Zwischenspeicher nicht anlegen: {e}",
        "Could not create the cache: {e}",
        "No se pudo crear la memoria temporal: {e}",
    ),
    (
        "Konnte den Zwischenspeicher nicht auflösen: {e}",
        "Could not resolve the cache: {e}",
        "No se pudo resolver la memoria temporal: {e}",
    ),
    (
        "Konnte die Aufnahme nicht umbenennen: {e}",
        "Could not rename the recording: {e}",
        "No se pudo renombrar la grabación: {e}",
    ),
    (
        "Konnte die Aufnahme nicht zusammenfügen: {e}",
        "Could not join the recording: {e}",
        "No se pudo unir la grabación: {e}",
    ),
    (
        "Konnte die Datenbank nicht lesen: {e}",
        "Could not read the database: {e}",
        "No se pudo leer la base de datos: {e}",
    ),
    (
        "Konnte die Datenbank nicht sichern: {e}",
        "Could not back up the database: {e}",
        "No se pudo guardar una copia de la base de datos: {e}",
    ),
    (
        "Konnte die fertige Kopie nicht umbenennen: {e}",
        "Could not rename the finished copy: {e}",
        "No se pudo renombrar la copia terminada: {e}",
    ),
    (
        "Konnte keine PDF-Vorschau erzeugen: {e}",
        "Could not create a PDF preview: {e}",
        "No se pudo crear una vista previa del PDF: {e}",
    ),
    (
        "Umwandeln für die Wiedergabe fehlgeschlagen: {e}",
        "Converting for playback failed: {e}",
        "No se pudo convertir para la reproducción: {e}",
    ),
    (
        "Datei ist für die Wiedergabe nicht freigegeben.",
        "The file is not available for playback.",
        "El archivo no está disponible para la reproducción.",
    ),
    (
        "Konnte keinen Videoframe extrahieren.",
        "Could not extract a video frame.",
        "No se pudo extraer un fotograma del vídeo.",
    ),
    (
        "Konnte leere Protokollaktionen nicht aufräumen: {e}",
        "Could not clean up empty history actions: {e}",
        "No se pudieron limpiar las acciones vacías del historial: {e}",
    ),
    (
        "Konnte nicht löschen: {e}",
        "Could not delete: {e}",
        "No se pudo eliminar: {e}",
    ),
    (
        "Konnte skaliertes Bild nicht zusammensetzen",
        "Could not assemble the scaled image",
        "No se pudo componer la imagen escalada",
    ),
    (
        "Konnte zuletzt genutzte Streams nicht speichern: {e}",
        "Could not save recently used streams: {e}",
        "No se pudieron guardar los streams usados recientemente: {e}",
    ),
    (
        "Konnte „{name}“ nicht kopieren: {e}",
        "Could not copy \"{name}\": {e}",
        "No se pudo copiar «{name}»: {e}",
    ),
    (
        "Konnte „{name}“ nicht speichern: {e}",
        "Could not save \"{name}\": {e}",
        "No se pudo guardar «{name}»: {e}",
    ),
    (
        "Kopieren fehlgeschlagen: {e}",
        "Copying failed: {e}",
        "Error al copiar: {e}",
    ),
    (
        "Media Foundation: Video hat keine Bildgröße.",
        "Media Foundation: video has no frame size.",
        "Media Foundation: el vídeo no tiene tamaño de imagen.",
    ),
    (
        "Media Foundation: kein Videobild gefunden.",
        "Media Foundation: no video frame found.",
        "Media Foundation: no se encontró ningún fotograma.",
    ),
    (
        "Media Foundation: keine Attribute",
        "Media Foundation: no attributes",
        "Media Foundation: sin atributos",
    ),
    (
        "Ordner nicht gefunden.",
        "Folder not found.",
        "Carpeta no encontrada.",
    ),
    (
        "PDF hat keine Seite: {e}",
        "PDF has no page: {e}",
        "El PDF no tiene páginas: {e}",
    ),
    (
        "PDF konnte nicht geöffnet werden: {e}",
        "PDF could not be opened: {e}",
        "No se pudo abrir el PDF: {e}",
    ),
    (
        "PDF-Bibliothek ist in einem ungültigen Zustand.",
        "The PDF library is in an invalid state.",
        "La biblioteca PDF está en un estado no válido.",
    ),
    (
        "Protokolleintrag nicht gefunden: {e}",
        "History entry not found: {e}",
        "Entrada del historial no encontrada: {e}",
    ),
    (
        "Textextraktion für diesen Dateityp nicht unterstützt.",
        "Text extraction is not supported for this file type.",
        "La extracción de texto no es compatible con este tipo de archivo.",
    ),
    (
        "Themenbereich nicht gefunden",
        "Topic area not found",
        "Área temática no encontrada",
    ),
    (
        "Unbekannte ID — Datei nicht im Stream gefunden.",
        "Unknown ID — file not found in the stream.",
        "ID desconocido: el archivo no se encontró en el stream.",
    ),
    (
        "Ungültige Bilddaten: {e}",
        "Invalid image data: {e}",
        "Datos de imagen no válidos: {e}",
    ),
    (
        "Ungültige Farbe: „{value}“",
        "Invalid color: \"{value}\"",
        "Color no válido: «{value}»",
    ),
    (
        "Ungültige Kennung.",
        "Invalid identifier.",
        "Identificador no válido.",
    ),
    (
        "Ungültiger Dateiname",
        "Invalid file name",
        "Nombre de archivo no válido",
    ),
    (
        "Ungültiges .msg-Format: {e}",
        "Invalid .msg format: {e}",
        "Formato .msg no válido: {e}",
    ),
    (
        "Ungültiges Datum.",
        "Invalid date.",
        "Fecha no válida.",
    ),
    (
        "Ungültiges Datum: „{value}“",
        "Invalid date: \"{value}\"",
        "Fecha no válida: «{value}»",
    ),
    (
        "Ungültiges Dokumentformat.",
        "Invalid document format.",
        "Formato de documento no válido.",
    ),
    (
        "Ungültiges E-Mail-Format.",
        "Invalid email format.",
        "Formato de correo no válido.",
    ),
    (
        "Videolänge konnte nicht gelesen werden.",
        "Video length could not be read.",
        "No se pudo leer la duración del vídeo.",
    ),
    (
        "Zielordner nicht gefunden.",
        "Target folder not found.",
        "Carpeta de destino no encontrada.",
    ),
    (
        "Zu viele Dateien mit diesem Namen im Zielordner.",
        "Too many files with this name in the target folder.",
        "Demasiados archivos con este nombre en la carpeta de destino.",
    ),
    (
        "ffmpeg gehört zur Installation von CronoStream – bitte CronoStream neu installieren.",
        "ffmpeg is part of the stream installation – please reinstall CronoStream.",
        "ffmpeg forma parte de la instalación de CronoStream: reinstalar CronoStream.",
    ),
    (
        "ffmpeg ist fehlgeschlagen: {e}",
        "ffmpeg failed: {e}",
        "ffmpeg falló: {e}",
    ),
    (
        "ffmpeg konnte nicht gestartet werden: {e}",
        "ffmpeg could not be started: {e}",
        "No se pudo iniciar ffmpeg: {e}",
    ),
    (
        "ffmpeg wurde installiert, ist aber nicht auffindbar.",
        "ffmpeg was installed but cannot be found.",
        "ffmpeg se instaló, pero no se encuentra.",
    ),
    (
        "ffprobe ist fehlgeschlagen: {e}",
        "ffprobe failed: {e}",
        "ffprobe falló: {e}",
    ),
    (
        "nach {seconds} Sekunden ohne Ergebnis abgebrochen",
        "cancelled after {seconds} seconds without a result",
        "cancelado tras {seconds} segundos sin resultado",
    ),
    (
        "pkexec konnte nicht gestartet werden: {e}",
        "pkexec could not be started: {e}",
        "No se pudo iniciar pkexec: {e}",
    ),
    (
        "{filename}: neue Datei nicht gefunden",
        "{filename}: new file not found",
        "{filename}: no se encontró el archivo nuevo",
    ),
    (
        "{id}: nicht mehr im Stream",
        "{id}: no longer in the stream",
        "{id}: ya no está en el stream",
    ),
    (
        "{what} darf nicht leer sein.",
        "{what} must not be empty.",
        "{what} no puede estar vacío.",
    ),
    (
        "„{a}“ ({a_start} – {a_end}) und „{b}“ ({b_start} – {b_end})",
        "\"{a}\" ({a_start} – {a_end}) and \"{b}\" ({b_start} – {b_end})",
        "«{a}» ({a_start} – {a_end}) y «{b}» ({b_start} – {b_end})",
    ),
    (
        "„{label}“ ist inzwischen erneut im Stream. Zuerst muss dieser Import rückgängig gemacht werden.",
        "\"{label}\" is in the stream again by now. This import has to be undone first.",
        "«{label}» vuelve a estar en el stream. Primero hay que deshacer esta importación.",
    ),
    (
        "„{label}“ wurde endgültig gelöscht und kann nicht wiederhergestellt werden.",
        "\"{label}\" was permanently deleted and cannot be restored.",
        "«{label}» se eliminó definitivamente y no se puede restaurar.",
    ),
    (
        "„{name}“ ist keine Datei.",
        "\"{name}\" is not a file.",
        "«{name}» no es un archivo.",
    ),
    (
        "„{path}“ enthält mit allen Unterordnern mehr als {MAX_WALK_ENTRIES} Einträge — das ist zu viel für die Ablage. Bitte einen kleineren Ordner ablegen.",
        "Including all subfolders, \"{path}\" contains more than {MAX_WALK_ENTRIES} entries — too many for the drop box. Please drop a smaller folder.",
        "Con todas sus subcarpetas, «{path}» contiene más de {MAX_WALK_ENTRIES} elementos: demasiados para la bandeja. Soltar una carpeta más pequeña.",
    ),
    (
        "„{path}“ existiert inzwischen bereits.",
        "\"{path}\" already exists by now.",
        "«{path}» ya existe.",
    ),
    (
        "„Überlappung erlaubt“ kann nicht zurückgenommen werden, solange sich Phasen überschneiden: {pairs}.",
        "\"Allow overlap\" cannot be turned off while phases overlap: {pairs}.",
        "«Permitir solapamiento» no se puede desactivar mientras haya fases que se solapen: {pairs}.",
    ),
    (
        "Das Passwort muss mindestens 4 Zeichen lang sein.",
        "The password must be at least 4 characters long.",
        "La contraseña debe tener al menos 4 caracteres.",
    ),
    (
        "Das Passwort ist falsch.",
        "The password is wrong.",
        "La contraseña es incorrecta.",
    ),
    (
        "Der Wiederherstellungscode ist falsch.",
        "The recovery code is wrong.",
        "El código de recuperación es incorrecto.",
    ),
    (
        "Der Privatmodus ist nicht eingerichtet.",
        "Private mode is not set up.",
        "El modo privado no está configurado.",
    ),
    (
        "Der Privatmodus ist bereits eingerichtet.",
        "Private mode is already set up.",
        "El modo privado ya está configurado.",
    ),
    (
        "Die Tastenkombination braucht Strg oder Alt und eine weitere Taste.",
        "The key combination needs Ctrl or Alt and one more key.",
        "La combinación de teclas necesita Ctrl o Alt y otra tecla.",
    ),
    (
        "Der Notizinhalt darf nicht leer sein.",
        "The note text must not be empty.",
        "El texto de la nota no puede estar vacío.",
    ),
    (
        "Unbekannter Geltungsbereich.",
        "Unknown scope.",
        "Ámbito desconocido.",
    ),
    (
        "Die Wartezeit darf höchstens 1440 Minuten betragen.",
        "The waiting time can be at most 1440 minutes.",
        "El tiempo de espera puede ser de 1440 minutos como máximo.",
    ),
    (
        "Konnte das Passwort nicht verarbeiten: {e}",
        "Could not process the password: {e}",
        "No se pudo procesar la contraseña: {e}",
    ),
    (
        "„{name}“ ist ein Programm oder Skript und wird beim Öffnen ausgeführt. Trotzdem öffnen?",
        "“{name}” is a program or script and runs when opened. Open anyway?",
        "«{name}» es un programa o script y se ejecuta al abrirlo. ¿Abrir de todos modos?",
    ),
    (
        "Programm öffnen?",
        "Open program?",
        "¿Abrir programa?",
    ),
    ("Öffnen", "Open", "Abrir"),
    ("Abbrechen", "Cancel", "Cancelar"),
    (
        "Das ist der geöffnete Stream selbst, keine Sicherung.",
        "That is the open stream itself, not a backup.",
        "Es el propio stream abierto, no una copia de seguridad.",
    ),
    (
        "Diese Sicherung ist gerade in CronoStream geöffnet.",
        "This backup is open in CronoStream right now.",
        "Esta copia de seguridad está abierta ahora mismo en CronoStream.",
    ),
    (
        "Dieser Ordner ist keine Sicherung dieses Streams.",
        "This folder is not a backup of this stream.",
        "Esta carpeta no es una copia de seguridad de este stream.",
    ),
    (
        "Konnte die bisherige Datenbank der Sicherung nicht aufbewahren: {e}",
        "Could not keep the backup's previous database: {e}",
        "No se pudo conservar la base de datos anterior de la copia de seguridad: {e}",
    ),
    (
        "Die bisherige Datenbank der Sicherung hat noch nicht abgeschlossene Änderungen und lässt sich nicht ersetzen. Die Dateien sind aktualisiert, die Datenbank der Sicherung ist unverändert.",
        "The backup's previous database still has unfinished changes and cannot be replaced. The files are up to date; the backup's database is unchanged.",
        "La base de datos anterior de la copia de seguridad aún tiene cambios sin completar y no se puede reemplazar. Los archivos están actualizados; la base de datos de la copia no ha cambiado.",
    ),
    (
        "Das Entfernen ist nur in der installierten App möglich.",
        "Removing is only possible in the installed app.",
        "Solo se puede quitar desde la aplicación instalada.",
    ),
    (
        "Das Deinstallationsprogramm von CronoStream wurde nicht gefunden.",
        "The CronoStream uninstaller was not found.",
        "No se encontró el desinstalador de CronoStream.",
    ),
    (
        "Diese Streams konnten nicht gelöscht werden, sonst wurde noch nichts entfernt:\n{list}",
        "These streams could not be deleted, nothing else has been removed yet:\n{list}",
        "No se pudieron eliminar estos streams; todavía no se ha quitado nada más:\n{list}",
    ),
    (
        "Konnte das Aufräumen nicht starten: {e}",
        "Could not start the cleanup: {e}",
        "No se pudo iniciar la limpieza: {e}",
    ),
    (
        "Konnte das Deinstallationsprogramm nicht starten: {e}",
        "Could not start the uninstaller: {e}",
        "No se pudo iniciar el desinstalador: {e}",
    ),
];
