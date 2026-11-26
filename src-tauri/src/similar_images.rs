//! "Ähnliche Bilder": photos that look the same without being the same file —
//! a copy scaled down, recompressed by a messenger, saved again by an editor.
//! The duplicate check compares bytes and misses all of those.
//!
//! Each photo gets a perceptual fingerprint (dHash, 64 bits: for a 9×8
//! greyscale version, whether each pixel is clearly brighter than its
//! right-hand neighbour), computed from its existing thumbnail rather than
//! the full file, and cached in `item_hashes.dhash`. Two photos whose
//! fingerprints differ in at most `MAX_DISTANCE` bits are offered as
//! similar — only ever as a suggestion handed to Datei-Operationen; which
//! one to keep is the user's call.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

use crate::duplicate_hash::DuplicateGroup;
use crate::state::AppStateHandle;

/// Bits two fingerprints may differ in and still count as the same picture.
/// Low on purpose: a rescaled or recompressed copy lands at 0–4, while
/// different shots of one scene are usually well above.
const MAX_DISTANCE: u32 = 6;
/// How much brighter (of 255) a pixel of the 9×8 version has to be than its
/// right-hand neighbour for its bit to be set. Below that the difference is
/// recompression noise: in a flat area (sky, a wall, a dark frame) it used
/// to set bits at random, so copies of one picture drifted apart and flat
/// pictures of different scenes came out alike.
const EDGE_STEP: u8 = 3;
/// A picture with fewer clear edges than this (or as few unset ones) says
/// too little to be compared — a flat colour, a dark frame, a plain
/// gradient — and is left out.
const MIN_DETAIL_BITS: u32 = 8;

/// The dHash of the image at `path`.
fn dhash(path: &Path) -> Option<u64> {
    let image = crate::preview::open_image(path).ok()?;
    let small = image::imageops::resize(&image.to_luma8(), 9, 8, image::imageops::FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            hash = (hash << 1) | u64::from(left > right.saturating_add(EDGE_STEP));
        }
    }
    Some(hash)
}

fn has_detail(hash: u64) -> bool {
    let ones = hash.count_ones();
    ones >= MIN_DETAIL_BITS && ones <= 64 - MIN_DETAIL_BITS
}

/// Groups of ids, each gathered around its first picture: a picture joins
/// the group whose first picture is nearest, if that is within
/// `MAX_DISTANCE`, and starts a group of its own otherwise. Not linked
/// transitively on purpose — a burst of shots, each a little different from
/// the one before, would otherwise chain into one group of pictures that
/// end up not alike at all. Only groups of two or more are returned.
fn group_similar(hashes: &[(String, u64)]) -> Vec<Vec<String>> {
    let mut groups: Vec<(u64, Vec<String>)> = Vec::new();
    for (id, hash) in hashes {
        let nearest = groups
            .iter_mut()
            .map(|group| ((group.0 ^ hash).count_ones(), group))
            .filter(|(distance, _)| *distance <= MAX_DISTANCE)
            .min_by_key(|(distance, _)| *distance);
        match nearest {
            Some((_, group)) => group.1.push(id.clone()),
            None => groups.push((*hash, vec![id.clone()])),
        }
    }
    let mut out: Vec<Vec<String>> = groups.into_iter().map(|(_, ids)| ids).filter(|ids| ids.len() > 1).collect();
    out.sort();
    out
}

fn store_dhashes(conn: &Connection, hashes: &[(String, u64)]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, hash) in hashes {
        tx.execute(
            "INSERT INTO item_hashes (item_id, dhash) VALUES (?1, ?2)
             ON CONFLICT(item_id) DO UPDATE SET dhash = excluded.dhash",
            params![id, *hash as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Looks for similar photos across the open stream. The app lock is held
/// only for reading the entries and storing new fingerprints.
#[tauri::command]
pub async fn scan_similar_images(app: AppHandle, operation_id: String) -> Result<Vec<DuplicateGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppStateHandle>();
        let (project_path, rows) = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            let hidden = crate::privacy::hidden_ids(current, crate::privacy::Surface::Views)?;
            let mut stmt = current
                .conn
                .prepare(
                    "SELECT i.id, i.thumbnail_path, h.dhash
                     FROM items i LEFT JOIN item_hashes h ON h.item_id = i.id
                     WHERE i.removed_at IS NULL AND i.file_type = 'image' AND i.thumbnail_path IS NOT NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows: Vec<(String, String, Option<i64>)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| e.to_string())?
                .flatten()
                .filter(|row: &(String, String, Option<i64>)| !hidden.as_ref().is_some_and(|h| h.contains(&row.0)))
                .collect();
            (current.path.clone(), rows)
        };

        let mut known: Vec<(String, u64)> = Vec::new();
        let mut missing: Vec<(String, String)> = Vec::new();
        for (id, thumb, cached) in rows {
            match cached {
                Some(hash) => known.push((id, hash as u64)),
                None => missing.push((id, thumb)),
            }
        }

        let total = missing.len();
        let done = AtomicUsize::new(0);
        let worker_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(total.max(1));
        let computed: Vec<(String, u64)> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..worker_count)
                .map(|worker| {
                    let missing = &missing;
                    let done = &done;
                    let app = &app;
                    let operation_id = &operation_id;
                    scope.spawn(move || {
                        let mut out = Vec::new();
                        for (id, thumb) in missing.iter().skip(worker).step_by(worker_count) {
                            if let Ok(Some(hash)) = crate::safe_io::catch_panic(|| Ok(dhash(Path::new(thumb)))) {
                                out.push((id.clone(), hash));
                            }
                            crate::progress::emit_progress(app, operation_id, done.fetch_add(1, Ordering::Relaxed) + 1, total, thumb);
                        }
                        out
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        if !computed.is_empty() {
            let guard = crate::state::lock_project(&state, &project_path)?;
            let current = guard.current_project.as_ref().ok_or(crate::i18n::no_stream_open())?;
            store_dhashes(&current.conn, &computed)?;
        }

        let mut all: Vec<(String, u64)> = known.into_iter().chain(computed).filter(|(_, h)| has_detail(*h)).collect();
        all.sort();
        Ok(group_similar(&all).into_iter().map(|item_ids| DuplicateGroup { item_ids }).collect())
    })
    .await
    .map_err(|e| crate::trf!("Hintergrund-Aufgabe fehlgeschlagen: {e}", e = e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(path: &Path, image: &image::RgbImage) {
        image.save(path).unwrap();
    }

    /// A picture with structure: light and dark stripes, shaded from top to
    /// bottom, and a dark block.
    fn photo(width: u32, height: u32, block_at: u32) -> image::RgbImage {
        image::RgbImage::from_fn(width, height, |x, y| {
            let in_block = x * 10 / width == block_at && y * 10 / height < 6;
            let shade = (y * 120 / height) as u8;
            if in_block {
                image::Rgb([20, 20, 20])
            } else if (x * 7 / width) % 2 == 0 {
                image::Rgb([200 - shade / 2, 180, 160])
            } else {
                image::Rgb([60 + shade / 3, 70, 90])
            }
        })
    }

    #[test]
    fn a_scaled_copy_is_similar_and_another_picture_is_not() {
        let dir = std::env::temp_dir().join(format!("cronostream-similar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("a.png");
        let scaled = dir.join("b.jpg");
        let other = dir.join("c.png");
        save(&original, &photo(640, 480, 2));
        image::imageops::resize(&photo(640, 480, 2), 200, 150, image::imageops::FilterType::Triangle).save(&scaled).unwrap();
        save(&other, &photo(640, 480, 7));

        let a = dhash(&original).unwrap();
        let b = dhash(&scaled).unwrap();
        let c = dhash(&other).unwrap();
        assert!((a ^ b).count_ones() <= MAX_DISTANCE, "scaled copy: {}", (a ^ b).count_ones());
        assert!((a ^ c).count_ones() > MAX_DISTANCE, "other picture: {}", (a ^ c).count_ones());
        assert!(has_detail(a));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn flat_pictures_are_left_out() {
        assert!(!has_detail(0));
        assert!(!has_detail(u64::MAX));
        assert!(!has_detail(0b111_1111));
    }

    /// A sky, a wall, a dark frame: near-equal neighbours with a little
    /// noise. The noise must not set bits, or flat pictures of different
    /// scenes come out alike.
    #[test]
    fn noise_in_a_flat_picture_sets_no_bits() {
        let dir = std::env::temp_dir().join(format!("cronostream-similar-flat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let noisy = dir.join("himmel.png");
        // Neighbouring areas one or two shades apart: the old rule (any
        // difference counts) set 40 bits here.
        save(&noisy, &image::RgbImage::from_fn(640, 480, |x, y| {
            let v = 120 + ((x * 9 / 640 * 5 + y * 8 / 480 * 3) % 3) as u8;
            image::Rgb([v, v, v + 40])
        }));
        let hash = dhash(&noisy).unwrap();
        assert!(!has_detail(hash), "{} bits set", hash.count_ones());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn groups_gather_around_their_first_picture_and_drop_singles() {
        let hashes = vec![
            ("a".to_string(), 0xF0F0u64),
            ("b".to_string(), 0xF0F1),
            ("c".to_string(), 0xF0F3),
            ("d".to_string(), 0xFFFF_0000_0000),
        ];
        assert_eq!(group_similar(&hashes), vec![vec!["a".to_string(), "b".to_string(), "c".to_string()]]);

        // A burst: each shot 4 bits from the one before, 8 from the first.
        // Linked transitively these chained into one group; now the third
        // is too far from the first to belong with it.
        let burst = vec![("x".to_string(), 0xFF00u64), ("y".to_string(), 0xFF00 ^ 0xF), ("z".to_string(), 0xFF00 ^ 0xF ^ 0xF0)];
        assert_eq!(group_similar(&burst), vec![vec!["x".to_string(), "y".to_string()]]);
    }
}
