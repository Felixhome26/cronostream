// One-off maintenance tool: extracts text for every PDF item that was
// added before PDF text extraction existed (see pdf_preview::extract_text).
// Those items have extracted_text = NULL and are therefore invisible to
// search until backfilled once here.
//
// Usage: cargo run --example regen_pdf_text -- "/path/to/Project"
// (the directory containing that project's cronostream.db)

use cronostream_lib::pdf_preview;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

fn main() {
    let project_dir = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Usage: regen_pdf_text <project_dir>");
        std::process::exit(1);
    });

    let db_path = PathBuf::from(&project_dir).join("cronostream.db");
    let conn = Connection::open(&db_path).unwrap_or_else(|e| {
        eprintln!("Konnte Datenbank nicht öffnen ({}): {e}", db_path.display());
        std::process::exit(1);
    });

    let mut stmt = conn
        .prepare(
            "SELECT id, stored_path FROM items \
             WHERE file_type = 'document' AND lower(original_filename) LIKE '%.pdf' \
             AND extracted_text IS NULL",
        )
        .expect("prepare");
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .filter_map(Result::ok)
        .collect();

    println!("{} PDFs ohne extrahierten Text gefunden...", rows.len());
    let mut extracted = 0;
    let mut empty = 0;
    let mut err = 0;
    for (id, stored_path) in rows {
        match pdf_preview::extract_text(Path::new(&stored_path)) {
            Ok(text) if !text.is_empty() => {
                conn.execute(
                    "UPDATE items SET extracted_text = ?1 WHERE id = ?2",
                    rusqlite::params![text, id],
                )
                .expect("update");
                extracted += 1;
            }
            Ok(_) => empty += 1,
            Err(e) => {
                err += 1;
                eprintln!("Fehler bei {id} ({stored_path}): {e}");
            }
        }
    }
    println!("Fertig: {extracted} mit Text befüllt, {empty} ohne Text (z. B. gescannt), {err} Fehler.");
}
