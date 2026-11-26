// One-off maintenance tool: gives items the capture time embedded in their
// source file, for everything that was dated before `exif_date` could
// actually read it. Until that fix, every single item fell back to a
// filesystem date — and for camera files that date is frequently the
// capture time misread as UTC, i.e. off by the local offset, sometimes
// landing on the wrong day.
//
// Deliberately a separate binary rather than a command in the app: this is
// a one-time repair over the whole library, it must run with the app closed
// so nothing writes underneath it, and it should be inspectable before it
// changes anything. Without `--apply` it only reports.
//
// Usage: cargo run --example redate_from_exif -- "/path/to/Project" [--apply]

use std::path::{Path, PathBuf};

use chrono::DateTime;
use cronostream_lib::{email, exif_date, filename_date, lock};
use rusqlite::Connection;

/// Below this, the stored timestamp and the embedded one are the same
/// moment. The row is still worth writing: the *source* was wrong, and an
/// entry that says "filesystem date" when the capture time was there all
/// along looks less certain than it is — it would be handed to the AI check
/// as unresolved, and a reader cannot tell the two cases apart.
const SAME_MOMENT_SECONDS: i64 = 60;
/// For AI-derived dates only: a shift this large is not the timezone bug
/// this tool exists to repair, it is a genuinely different opinion about
/// when the picture was taken. Those are left alone.
const AI_MAX_SHIFT_SECONDS: i64 = 24 * 3600;

struct Change {
    id: String,
    name: String,
    kind: String,
    new_source: &'static str,
    old_value: String,
    new_value: String,
    source: String,
    shift_seconds: i64,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let project_dir = args.next().unwrap_or_else(|| {
        eprintln!("Aufruf: redate_from_exif <Projektordner> [--apply]");
        std::process::exit(1);
    });
    let apply = args.any(|a| a == "--apply");

    let project_path = PathBuf::from(&project_dir);
    let db_path = project_path.join("cronostream.db");

    // The app holds this while a project is open. Writing underneath a
    // running app would mean its in-memory view and the database disagree,
    // and its own writes could land on top of ours.
    if apply && project_path.join(lock::LOCK_FILENAME).exists() {
        eprintln!("Das Projekt ist gerade in CronoStream geöffnet ({}).", lock::LOCK_FILENAME);
        eprintln!("Bitte die App schließen und erneut versuchen — ohne --apply geht der Bericht auch bei offener App.");
        std::process::exit(1);
    }

    let conn = Connection::open(&db_path).unwrap_or_else(|e| {
        eprintln!("Konnte Datenbank nicht öffnen ({}): {e}", db_path.display());
        std::process::exit(1);
    });

    let mut stmt = conn
        .prepare(
            "SELECT id, original_filename, source_path, resolved_timestamp, timestamp_source, file_type
               FROM items
              WHERE removed_at IS NULL
                AND file_type IN ('image', 'video', 'email')
                AND source_path IS NOT NULL
                AND timestamp_source IN ('fs_modified', 'fs_created', 'ai', 'filename')",
        )
        .expect("prepare");
    let rows: Vec<(String, String, String, String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
        .expect("query")
        .filter_map(Result::ok)
        .collect();

    let mut changes: Vec<Change> = Vec::new();
    let (mut missing_file, mut no_exif, mut already_right, mut ai_too_far) = (0, 0, 0, 0);

    for (id, name, source_path, old_value, source, kind) in &rows {
        let path = Path::new(source_path);
        if !path.exists() {
            missing_file += 1;
            continue;
        }
        // Same ranking the import itself applies: embedded capture time for
        // images, then the timestamp in the filename. Video containers are
        // deliberately not consulted — measured against this library, their
        // timestamp is when the *file* was written, which for converted
        // footage is months away from the capture.
        let embedded = if kind == "image" {
            exif_date::read_datetime_original(path)
        } else if kind == "email" {
            // The mail's own Date header, not the .eml file's age.
            email::parse_meta(path).ok().and_then(|meta| meta.date)
        } else {
            None
        };
        let (new_value, new_source) = match embedded {
            // WhatsApp send dates outrank embedded metadata, as on import.
            Some(_) if filename_date::read_whatsapp_date(path).is_some() => {
                (filename_date::read_whatsapp_date(path).unwrap(), "filename")
            }
            Some(value) => (value, "exif"),
            None => match filename_date::read_from_filename(path) {
                Some(value) => (value, "filename"),
                None => {
                    no_exif += 1;
                    continue;
                }
            },
        };
        let (Ok(new_dt), Ok(old_dt)) = (DateTime::parse_from_rfc3339(&new_value), DateTime::parse_from_rfc3339(old_value))
        else {
            no_exif += 1;
            continue;
        };

        let shift_seconds = new_dt.timestamp() - old_dt.timestamp();
        if shift_seconds.abs() < SAME_MOMENT_SECONDS {
            already_right += 1;
        }
        if source == "ai" && shift_seconds.abs() >= AI_MAX_SHIFT_SECONDS {
            ai_too_far += 1;
            continue;
        }

        changes.push(Change {
            id: id.clone(),
            name: name.clone(),
            kind: kind.clone(),
            new_source,
            old_value: old_value.clone(),
            new_value,
            source: source.clone(),
            shift_seconds,
        });
    }

    println!("Geprüft: {} Bilder und Videos mit Datei- oder KI-Datum", rows.len());
    println!("  Quelldatei nicht mehr auffindbar : {missing_file}");
    println!("  ohne Aufnahmezeit und ohne Datum im Namen : {no_exif}");
    println!("  davon schon auf die Sekunde richtig (nur Quelle wird nachgetragen) : {already_right}");
    println!("  KI-Datum weicht zu stark ab (>24 h, bleibt) : {ai_too_far}");
    println!("  würde geändert                   : {}", changes.len());

    let day_changes = changes
        .iter()
        .filter(|c| {
            let (Ok(a), Ok(b)) = (DateTime::parse_from_rfc3339(&c.old_value), DateTime::parse_from_rfc3339(&c.new_value)) else {
                return false;
            };
            a.date_naive() != b.date_naive()
        })
        .count();
    println!("  davon auf einen anderen Tag      : {day_changes}");

    // How far things move, not just how many: a library-wide correction of
    // one hour is a different thing from a handful of files jumping years,
    // and both are in here.
    let mut buckets: Vec<(&str, usize, usize)> = vec![
        ("unter 5 Minuten", 0, 0),
        ("5 bis 59 Minuten", 0, 0),
        ("rund 1 Stunde", 0, 0),
        ("rund 2 Stunden", 0, 0),
        ("sonstige bis 24 Stunden", 0, 0),
        ("1 bis 30 Tage", 0, 0),
        ("mehr als 30 Tage", 0, 0),
    ];
    for change in &changes {
        let minutes = change.shift_seconds.abs() / 60;
        let index = match minutes {
            0..=4 => 0,
            5..=54 => 1,
            55..=65 => 2,
            115..=125 => 3,
            m if m < 24 * 60 => 4,
            m if m < 30 * 24 * 60 => 5,
            _ => 6,
        };
        buckets[index].1 += 1;
        if change.shift_seconds > 0 {
            buckets[index].2 += 1;
        }
    }
    println!("\nGröße der Verschiebung (in Klammern: davon nach vorn):");
    for (label, total, forward) in buckets.iter().filter(|b| b.1 > 0) {
        println!("  {label:<26} {total:>4}   ({forward} später, {} früher)", total - forward);
    }

    let by_old = |want: &str| changes.iter().filter(|c| c.source == want).count();
    let by_new = |want: &str| changes.iter().filter(|c| c.new_source == want).count();
    let by_kind = |want: &str| changes.iter().filter(|c| c.kind == want).count();
    println!(
        "    bisherige Quelle — Dateizeit: {}, KI: {}",
        by_old("fs_modified") + by_old("fs_created"),
        by_old("ai")
    );
    println!("    neue Quelle — Metadaten: {}, Dateiname: {}", by_new("exif"), by_new("filename"));
    println!("    nach Art — Bilder: {}, Videos: {}", by_kind("image"), by_kind("video"));

    // Rendered in local time, the way the app shows them. Printing the raw
    // RFC3339 (or worse, a truncated prefix of it) hides the whole point:
    // the stored value and the embedded one often carry the same digits and
    // differ only in their UTC offset, which is exactly the bug being
    // repaired.
    let local = |rfc: &str| {
        DateTime::parse_from_rfc3339(rfc)
            .map(|dt| dt.with_timezone(&chrono::Local).format("%d.%m.%Y %H:%M").to_string())
            .unwrap_or_else(|_| rfc.to_string())
    };
    let mut largest: Vec<&Change> = changes.iter().collect();
    largest.sort_by_key(|c| -c.shift_seconds.abs());
    println!("\nDie größten Sprünge (Anzeigezeit, wie in der App):");
    for change in largest.iter().take(12) {
        println!(
            "  {:<30} {} ({})  ->  {} ({})  [{:.1} Tage]",
            change.name.chars().take(30).collect::<String>(),
            local(&change.old_value),
            change.source,
            local(&change.new_value),
            change.new_source,
            change.shift_seconds as f64 / 86400.0
        );
    }

    println!("\nWeitere Beispiele (Anzeigezeit, wie in der App):");
    for change in changes.iter().take(15) {
        println!(
            "  {:<32} {} ({})  ->  {} ({})  [{:+} min]",
            change.name.chars().take(32).collect::<String>(),
            local(&change.old_value),
            change.source,
            local(&change.new_value),
            change.new_source,
            change.shift_seconds / 60
        );
    }

    if !apply {
        println!("\nNur ein Bericht — nichts wurde geändert. Mit --apply ausführen (App vorher schließen).");
        return;
    }

    // A consistent copy via SQLite itself, not a file copy: that would miss
    // whatever still sits in the write-ahead log.
    let backup = project_path.join(format!(
        "cronostream.db.vor-neudatierung-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().to_string()])
        .unwrap_or_else(|e| {
            eprintln!("Konnte keine Sicherung anlegen ({}): {e}", backup.display());
            eprintln!("Abbruch — ohne Sicherung wird nichts geschrieben.");
            std::process::exit(1);
        });
    println!("\nSicherung angelegt: {}", backup.display());

    let mut written = 0;
    for change in &changes {
        match conn.execute(
            "UPDATE items
                SET resolved_timestamp = ?1,
                    timestamp_source = ?2,
                    embedded_metadata_at = CASE WHEN ?2 = 'exif' THEN ?1 ELSE embedded_metadata_at END
              WHERE id = ?3",
            rusqlite::params![change.new_value, change.new_source, change.id],
        ) {
            Ok(_) => written += 1,
            Err(e) => eprintln!("Fehler bei {} ({}): {e}", change.name, change.id),
        }
    }
    println!("{written} Einträge neu datiert.");
}
