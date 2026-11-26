use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection, ToSql};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::action_log;
use crate::state::AppStateHandle;

/// Everything about an item that might help an external AI guess a better
/// timestamp than the automatic priority chain did — in particular the
/// source folder path and original filename, which often carry a date
/// (`IMG_20230615`, `/2015/Urlaub-Italien/`, …) that is deliberately never
/// parsed automatically (see the project's date-handling decisions).
#[derive(Serialize, Clone, Debug)]
pub struct AiExportCandidate {
    pub id: String,
    pub original_filename: String,
    pub source_folder_path: Option<String>,
    pub resolved_timestamp: String,
    pub timestamp_source: String,
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    pub embedded_metadata_at: Option<String>,
    /// Every date EXIF holds for this file, read fresh from the project's
    /// own copy (which always exists, unlike the source file) and passed on
    /// unconverted. `embedded_metadata_at` above is this app's reading of
    /// `captured`; handing over the raw fields as well lets the reader see
    /// the disagreements that reading has to resolve — a scan whose
    /// digitized date is decades after the capture, or a GPS stamp that
    /// contradicts a mis-set camera clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exif_dates: Option<crate::exif_date::ExifDateFields>,
    /// The creation date a video, recording or document carries inside
    /// itself (see `media_date`), read fresh from the project's copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_created: Option<String>,
}

/// One row of the base SQL select, before the EXIF read — kept separate so
/// that read (real per-file I/O, see below) can be parallelized instead of
/// happening inline inside `query_map`'s row closure.
struct CandidateRow {
    id: String,
    original_filename: String,
    source_folder_path: Option<String>,
    resolved_timestamp: String,
    timestamp_source: String,
    fs_created_at: Option<String>,
    fs_modified_at: Option<String>,
    embedded_metadata_at: Option<String>,
    stored_path: Option<String>,
    file_type: String,
}

/// `app`/`operation_id` report progress for the EXIF read (see
/// `progress::emit_progress`) — the only part of this slow enough to
/// matter for more than a handful of ids.
fn fetch_candidates(conn: &Connection, ids: &[String], app: &AppHandle, operation_id: &str) -> Result<Vec<AiExportCandidate>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, original_filename, source_folder_path, resolved_timestamp, timestamp_source,
                fs_created_at, fs_modified_at, embedded_metadata_at, stored_path, file_type
         FROM items WHERE id IN ({placeholders}) AND removed_at IS NULL
         -- Not text order: mixed UTC offsets sort wrong that way, see
         -- `timeline_commands::list_items`.
         ORDER BY datetime(resolved_timestamp) ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
    let rows: Vec<CandidateRow> = stmt
        .query_map(params.as_slice(), |row| {
            Ok(CandidateRow {
                id: row.get(0)?,
                original_filename: row.get(1)?,
                source_folder_path: row.get(2)?,
                resolved_timestamp: row.get(3)?,
                timestamp_source: row.get(4)?,
                fs_created_at: row.get(5)?,
                fs_modified_at: row.get(6)?,
                embedded_metadata_at: row.get(7)?,
                stored_path: row.get(8)?,
                file_type: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // The SQL above already sorted by date; chunking rows round-robin for
    // the parallel EXIF read and reassembling by original index afterwards
    // keeps that order rather than scrambling it per-chunk.
    let total = rows.len();
    let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(total.max(1));
    let mut chunks: Vec<Vec<(usize, CandidateRow)>> = (0..worker_count.max(1)).map(|_| Vec::new()).collect();
    for (i, row) in rows.into_iter().enumerate() {
        chunks[i % worker_count.max(1)].push((i, row));
    }

    let progress_done = AtomicUsize::new(0);
    let mut indexed: Vec<(usize, AiExportCandidate)> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                let progress_done = &progress_done;
                scope.spawn(move || {
                    chunk
                        .into_iter()
                        .map(|(i, row)| {
                            let exif_dates = row
                                .stored_path
                                .as_deref()
                                .and_then(|stored| crate::exif_date::read_date_fields(std::path::Path::new(stored)));
                            let kind = match row.file_type.as_str() {
                                "video" => Some(crate::fsbrowse::FileKind::Video),
                                "audio" => Some(crate::fsbrowse::FileKind::Audio),
                                "document" => Some(crate::fsbrowse::FileKind::Document),
                                _ => None,
                            };
                            let file_created = kind.zip(row.stored_path.as_deref()).and_then(|(kind, stored)| {
                                crate::media_date::read(std::path::Path::new(stored), kind)
                            });
                            let done = progress_done.fetch_add(1, Ordering::SeqCst) + 1;
                            crate::progress::emit_progress(app, operation_id, done, total, &row.original_filename);
                            (
                                i,
                                AiExportCandidate {
                                    id: row.id,
                                    original_filename: row.original_filename,
                                    source_folder_path: row.source_folder_path,
                                    resolved_timestamp: row.resolved_timestamp,
                                    timestamp_source: row.timestamp_source,
                                    fs_created_at: row.fs_created_at,
                                    fs_modified_at: row.fs_modified_at,
                                    embedded_metadata_at: row.embedded_metadata_at,
                                    exif_dates,
                                    file_created,
                                },
                            )
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });

    indexed.sort_by_key(|(i, _)| *i);
    Ok(indexed.into_iter().map(|(_, candidate)| candidate).collect())
}

/// Instruction preamble written into every export file, in German (the
/// app's default language) since the target AI chat is just as capable of
/// following German instructions, and the user reads the exported file too.
/// Split into an intro and an output-format spec so the user's own free-text
/// hints (see `export_ai_metadata`'s `extra_instructions`) can be spliced in
/// between them — additional context the AI should weigh belongs with the
/// task description, not mixed into the strict output-format block below it.
const EXPORT_PROMPT_INTRO: &str = r#"Du bekommst unten eine JSON-Liste von Dateien aus einem persönlichen Foto-/Dokumentenarchiv (CronoStream). Für jede Datei ist das bisher ermittelte Datum unsicher (nur aus Dateisystem-Metadaten abgeleitet, nicht aus eingebetteten Metadaten wie EXIF).

Deine Aufgabe: Schätze für jede Datei das wahrscheinlichste tatsächliche Datum/Uhrzeit. Nutze dafür vor allem:
- im Dateinamen enthaltene Datumshinweise (z. B. "IMG_20230615_143022.jpg", "2019-04-01 Urlaub.pdf")
- im Ordnerpfad enthaltene Datumshinweise (z. B. "/Fotos/2015/Italien-Urlaub/", "/Backup/2020-11/")
- die vorhandenen Datumskandidaten (fs_created_at, fs_modified_at, embedded_metadata_at) als zusätzliche Indizien, falls kein besserer Hinweis existiert
- das Feld "exif_dates", falls vorhanden: die Datumsangaben aus den eingebetteten Metadaten, unverändert so wie die Kamera sie geschrieben hat. Beachte dabei:
  - "captured" ist der Aufnahmezeitpunkt und hat Vorrang vor allen anderen Hinweisen
  - "digitized" weicht bei eingescannten Papierfotos vom Aufnahmezeitpunkt ab (es ist dann das Scandatum); liegen beide weit auseinander, ist das abgebildete Ereignis vermutlich deutlich älter als die Datei
  - "utc_offset" nennt die Zeitzone, sofern die Kamera sie aufgezeichnet hat; fehlt sie, sind die übrigen Angaben reine Ortszeit ohne Zonenangabe
  - "gps_utc" stammt vom Satelliten und ist damit unabhängig von der Kamerauhr: widerspricht es "captured", ging die Kamerauhr falsch und "gps_utc" ist die verlässlichere Angabe
- das Feld "file_created", falls vorhanden: das Erstelldatum, das in einem Video, einer Tonaufnahme oder einem Dokument selbst steht. Bei Handy-Videos ist es meist der Aufnahmezeitpunkt; bei umgewandelten, neu gespeicherten oder eingescannten Dateien oft nur der Zeitpunkt dieser Bearbeitung"#;

const EXPORT_PROMPT_OUTPUT_SPEC: &str = r#"Antworte AUSSCHLIESSLICH mit einer Datei vom Typ .json mit genau folgendem Inhalt (kein zusätzlicher Text davor oder danach). Falls dein Chat-Tool keine Datei zum Download erzeugen kann: gib den Inhalt stattdessen direkt im Chat als einzelnen Code-Block mit der Kennzeichnung ```json aus, ohne Text davor oder danach — nicht als Fließtext oder Liste.

{
  "suggestions": [
    {
      "id": "<id unverändert aus der Eingabe übernehmen>",
      "suggested_timestamp": "<ISO-8601, z. B. 2023-06-15T14:30:00+00:00>",
      "confidence": "high" | "medium" | "low",
      "reason": "<nachvollziehbare Begründung, 1 Satz, wird dem Nutzer angezeigt>"
    }
  ]
}

Gib für jede Eingabe-Datei genau einen Eintrag zurück, auch wenn du dir unsicher bist (dann confidence "low" und das bisherige resolved_timestamp als suggested_timestamp). Erfinde keine IDs, verwende nur die IDs aus der Eingabe."#;

/// Shorter intro used when re-sending only the items a previous round left
/// unanswered — the full task description (filename/folder heuristics,
/// EXIF field semantics) was already given once, so repeating it here would
/// just bury the one thing that changed (which files these are) under text
/// the AI already has in its context.
const FOLLOWUP_PROMPT_INTRO: &str = r#"Von der vorherigen Liste hast du nicht zu allen Dateien ein Ergebnis geliefert. Hier sind nur die fehlenden Dateien — bitte verarbeite sie nach demselben Schema wie zuvor und liefere für jede einen Eintrag."#;

fn build_export_content(items: &[AiExportCandidate], extra_instructions: Option<&str>, followup: bool) -> Result<String, String> {
    let data = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let intro = if followup { FOLLOWUP_PROMPT_INTRO } else { EXPORT_PROMPT_INTRO };
    let extra_block = match extra_instructions.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => format!("\n\nZusätzliche Hinweise vom Nutzer (unbedingt berücksichtigen):\n{text}"),
        None => String::new(),
    };
    Ok(format!("{intro}{extra_block}\n\n{EXPORT_PROMPT_OUTPUT_SPEC}\n\n```json\n{data}\n```\n"))
}

/// `async` + `spawn_blocking`: `fetch_candidates` reads EXIF per file,
/// real I/O that must not sit on the IPC thread for a large batch.
#[tauri::command]
pub async fn export_ai_metadata(
    app: AppHandle,
    ids: Vec<String>,
    dest_path: String,
    extra_instructions: Option<String>,
    operation_id: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let ids = crate::privacy::without_hidden(&state, ids, crate::privacy::Surface::Everywhere)?;
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        let items = fetch_candidates(&current.conn, &ids, &app, &operation_id)?;
        let content = build_export_content(&items, extra_instructions.as_deref(), false)?;
        std::fs::write(&dest_path, content).map_err(|e| crate::trf!("Konnte Export-Datei nicht schreiben: {e}", e = e))?;
        Ok(items.len())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// Builds the same export text `export_ai_metadata` would write to a file,
/// but returns it instead of writing anything — used when the user chooses
/// to copy the prompt into the clipboard rather than create a file, and for
/// the "fehlende Einträge erneut einfügen" follow-up round. Same `async`/
/// `spawn_blocking` reasoning as `export_ai_metadata`.
#[tauri::command]
pub async fn build_ai_metadata_export_text(
    app: AppHandle,
    ids: Vec<String>,
    extra_instructions: Option<String>,
    followup: bool,
    operation_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let ids = crate::privacy::without_hidden(&state, ids, crate::privacy::Surface::Everywhere)?;
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        let items = fetch_candidates(&current.conn, &ids, &app, &operation_id)?;
        build_export_content(&items, extra_instructions.as_deref(), followup)
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

/// One suggestion from the AI's reply, merged with what the project
/// currently has on file for that item so the review screen can show a
/// diff — never applied until the user explicitly accepts it (see
/// `apply_ai_metadata_suggestions`).
#[derive(Serialize, Clone, Debug)]
pub struct ParsedSuggestion {
    pub id: String,
    pub original_filename: Option<String>,
    pub current_timestamp: Option<String>,
    pub current_timestamp_source: Option<String>,
    pub suggested_timestamp: String,
    pub confidence: Option<String>,
    pub reason: Option<String>,
    /// False when the id doesn't match any item in this project, or the
    /// suggested timestamp isn't parseable — the review screen shows these
    /// but can't let the user accept them.
    pub valid: bool,
    pub error: Option<String>,
    /// Everything else the export already sent the AI — carried back here
    /// too so the review screen's per-row detail popup can show the full
    /// picture (all date candidates, not just the one the AI picked) and
    /// let the user judge the suggestion themselves rather than trusting it
    /// blind.
    pub source_folder_path: Option<String>,
    pub fs_created_at: Option<String>,
    pub fs_modified_at: Option<String>,
    pub embedded_metadata_at: Option<String>,
}

#[derive(Deserialize, Debug)]
struct RawSuggestion {
    id: String,
    suggested_timestamp: String,
    #[serde(default)]
    confidence: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize, Debug)]
struct RawImportFile {
    suggestions: Vec<RawSuggestion>,
}

/// Models tend to wrap their reply in a ```json fenced block even when told
/// not to — strip that instead of failing the whole import over it. Falls
/// back to the trimmed content as-is if no fence is found.
fn extract_json(content: &str) -> &str {
    let trimmed = content.trim();
    if let Some(start) = trimmed.find("```") {
        let after_fence = &trimmed[start + 3..];
        let after_fence = after_fence.strip_prefix("json").unwrap_or(after_fence);
        if let Some(end) = after_fence.find("```") {
            return after_fence[..end].trim();
        }
    }
    trimmed
}

struct KnownItem {
    original_filename: String,
    resolved_timestamp: String,
    timestamp_source: String,
    source_folder_path: Option<String>,
    fs_created_at: Option<String>,
    fs_modified_at: Option<String>,
    embedded_metadata_at: Option<String>,
}

fn fetch_known_items(conn: &Connection, ids: &[String]) -> Result<HashMap<String, KnownItem>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, original_filename, resolved_timestamp, timestamp_source,
                source_folder_path, fs_created_at, fs_modified_at, embedded_metadata_at
         FROM items WHERE id IN ({placeholders}) AND removed_at IS NULL"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
    let rows = stmt
        .query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                KnownItem {
                    original_filename: row.get(1)?,
                    resolved_timestamp: row.get(2)?,
                    timestamp_source: row.get(3)?,
                    source_folder_path: row.get(4)?,
                    fs_created_at: row.get(5)?,
                    fs_modified_at: row.get(6)?,
                    embedded_metadata_at: row.get(7)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>().map_err(|e| e.to_string())
}

/// Shared by both import paths (a picked file and pasted chat text) — the
/// AI's reply looks the same either way, only how it reached this process
/// differs. Content-sniffs for a fenced ```json block regardless of what
/// file extension (or no extension / raw paste) it arrived in, since chat
/// tools are inconsistent about producing a real downloadable file at all.
fn parse_suggestions(conn: &Connection, content: &str) -> Result<Vec<ParsedSuggestion>, String> {
    let json_text = extract_json(content);
    let parsed: RawImportFile = serde_json::from_str(json_text)
        .map_err(|_| crate::i18n::tr("Das enthält keine gültige KI-Antwort im erwarteten Format.").to_string())?;

    let ids: Vec<String> = parsed.suggestions.iter().map(|s| s.id.clone()).collect();
    let known = fetch_known_items(conn, &ids)?;

    Ok(parsed
        .suggestions
        .into_iter()
        .map(|raw| {
            let known_item = known.get(&raw.id);
            let timestamp_valid = chrono::DateTime::parse_from_rfc3339(&raw.suggested_timestamp).is_ok();
            let (valid, error) = match (known_item, timestamp_valid) {
                (None, _) => (false, Some(crate::i18n::tr("Unbekannte ID — Datei nicht im Stream gefunden.").to_string())),
                (Some(_), false) => (false, Some(crate::i18n::tr("Ungültiges Datum.").to_string())),
                (Some(_), true) => (true, None),
            };
            ParsedSuggestion {
                id: raw.id,
                original_filename: known_item.map(|k| k.original_filename.clone()),
                current_timestamp: known_item.map(|k| k.resolved_timestamp.clone()),
                current_timestamp_source: known_item.map(|k| k.timestamp_source.clone()),
                suggested_timestamp: raw.suggested_timestamp,
                confidence: raw.confidence,
                reason: raw.reason,
                valid,
                error,
                source_folder_path: known_item.and_then(|k| k.source_folder_path.clone()),
                fs_created_at: known_item.and_then(|k| k.fs_created_at.clone()),
                fs_modified_at: known_item.and_then(|k| k.fs_modified_at.clone()),
                embedded_metadata_at: known_item.and_then(|k| k.embedded_metadata_at.clone()),
            }
        })
        .collect())
}

/// Common file-based path: the AI chat produced (or the user saved its
/// reply as) an actual file — .json is recommended, but since the content
/// is sniffed rather than trusted-by-extension, .txt/.md round-trip fine
/// too, as do files with no extension at all.
#[tauri::command(async)]
pub fn parse_ai_metadata_import(
    state: State<AppStateHandle>,
    file_path: String,
) -> Result<Vec<ParsedSuggestion>, String> {
    let content = std::fs::read_to_string(&file_path).map_err(|e| crate::trf!("Konnte Datei nicht lesen: {e}", e = e))?;
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    parse_suggestions(&current.conn, &content)
}

/// Fallback for chat tools that only ever write the reply into the
/// conversation rather than producing a downloadable file (confirmed to
/// happen in practice, e.g. Gemini) — the user copies the chat text and
/// pastes it directly instead of saving it as a file first.
#[tauri::command(async)]
pub fn parse_ai_metadata_text(state: State<AppStateHandle>, content: String) -> Result<Vec<ParsedSuggestion>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
    parse_suggestions(&current.conn, &content)
}

#[derive(Deserialize, Debug)]
pub struct AiApplyEntry {
    pub id: String,
    pub timestamp: String,
}

/// What `apply_ai_metadata_suggestions` hands back: how many writes actually
/// happened, and the log action they were grouped into — the review screen
/// uses `action_id` to fetch the per-file before/after list (via
/// `list_action_entries`) for its "Änderungen anzeigen" confirmation.
/// Undoing a change stays the Protokoll tab's job, not this view's.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplySuggestionsResult {
    pub applied: usize,
    pub action_id: Option<i64>,
}

/// Applies only the suggestions the user explicitly accepted (and possibly
/// edited) on the review screen — mirrors `update_timestamp`'s UPDATE, just
/// looped, and tagging the source as "ai" rather than "manual" so a later
/// export can tell the two apart.
///
/// `async` + `spawn_blocking` + one transaction around the loop, same
/// reasoning as `timeline_commands::remove_items_by_ids` — a large accepted
/// batch is otherwise one disk fsync per row.
#[tauri::command]
pub async fn apply_ai_metadata_suggestions(
    app: AppHandle,
    entries: Vec<AiApplyEntry>,
    operation_id: String,
) -> Result<ApplySuggestionsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let guard = state.lock().map_err(|e| e.to_string())?;
        let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;

        // The same bounds as a manual date change: a suggestion of "2100"
        // or "0020" would otherwise stretch the timeline out to that year.
        for entry in &entries {
            crate::timeline_commands::ensure_date_allowed(&current.conn, &entry.timestamp)
                .map_err(|reason| format!("{}: {reason}", entry.id))?;
        }

        let total = entries.len();
        let tx = current.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut applied = 0usize;
        let mut log_entries = Vec::new();

        for (done, entry) in entries.iter().enumerate() {
            let previous: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT resolved_timestamp, timestamp_source,
                            COALESCE(display_name, original_filename)
                     FROM items WHERE id = ?1",
                    params![entry.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();

            let changed = tx
                .execute(
                    "UPDATE items SET resolved_timestamp = ?1, timestamp_source = 'ai' WHERE id = ?2",
                    params![entry.timestamp, entry.id],
                )
                .map_err(|e| crate::trf!("Konnte Datum nicht übernehmen: {e}", e = e))?;
            applied += changed;

            if changed > 0 {
                if let Some((before, before_source, label)) = previous {
                    log_entries.push(action_log::LogEntry {
                        item_id: Some(entry.id.clone()),
                        label,
                        before_value: Some(before),
                        after_value: Some(entry.timestamp.clone()),
                        before_source: Some(before_source),
                    });
                }
            }
            crate::progress::emit_progress(&app, &operation_id, done + 1, total, &entry.id);
        }

        // One action for the whole batch the user confirmed on the review
        // screen — that is the operation they performed, not each individual
        // suggestion inside it.
        let action_id = if !log_entries.is_empty() {
            action_log::record(&tx, action_log::ActionType::AiDateChange, &log_entries).ok()
        } else {
            None
        };

        tx.commit().map_err(|e| e.to_string())?;
        Ok(ApplySuggestionsResult { applied, action_id })
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}
