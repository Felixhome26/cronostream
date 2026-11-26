use rusqlite::{params, Connection, OptionalExtension};

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| crate::trf!("Konnte Einstellung nicht lesen: {e}", e = e))
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| crate::trf!("Konnte Einstellung nicht speichern: {e}", e = e))?;
    Ok(())
}
