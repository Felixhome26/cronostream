// One-off maintenance tool: regenerates every image item's stored
// thumbnail using the current (EXIF-orientation-aware) logic. Needed
// because the orientation fix in preview.rs only affects thumbnails
// generated from here on — items added before it keep whatever
// (possibly rotated) thumbnail was already written to disk.
//
// Usage: cargo run --example regen_thumbnails -- "/path/to/Project"
// (the directory containing that project's cronostream.db)

use cronostream_lib::preview;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

fn main() {
    let project_dir = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Usage: regen_thumbnails <project_dir>");
        std::process::exit(1);
    });

    let db_path = PathBuf::from(&project_dir).join("cronostream.db");
    let conn = Connection::open(&db_path).unwrap_or_else(|e| {
        eprintln!("Konnte Datenbank nicht öffnen ({}): {e}", db_path.display());
        std::process::exit(1);
    });

    let mut stmt = conn
        .prepare("SELECT id, stored_path, thumbnail_path FROM items WHERE file_type = 'image' AND thumbnail_path IS NOT NULL")
        .expect("prepare");
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .filter_map(Result::ok)
        .collect();

    println!("{} Bild-Thumbnails werden neu erzeugt...", rows.len());
    let mut ok = 0;
    let mut err = 0;
    for (id, stored_path, thumbnail_path) in rows {
        match preview::store_image_thumbnail(Path::new(&stored_path), Path::new(&thumbnail_path)) {
            Ok(()) => ok += 1,
            Err(e) => {
                err += 1;
                eprintln!("Fehler bei {id} ({stored_path}): {e}");
            }
        }
    }
    println!("Fertig: {ok} neu erzeugt, {err} Fehler.");
}
