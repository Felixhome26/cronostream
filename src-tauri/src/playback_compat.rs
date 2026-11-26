//! Playback fallback for audio/video the webview's player refuses.
//!
//! Old recordings come in formats WebKit won't play even where GStreamer
//! itself could (WebKit vets codecs on its own): WMA, MS-MPEG4/DivX AVIs,
//! Cinepak/Indeo, GSM or ADPCM WAVs, AMR memos. When the player reports
//! "unsupported", the frontend asks for a converted copy — VP9/Opus in
//! WebM, which every platform's webview plays and which CronoStream's own
//! ffmpeg can encode (libvpx/libopus are in every build) — and the media
//! server then serves that copy instead (`compat=` in its URL).
//!
//! The copies live in the user's cache folder, never next to the original,
//! keyed by path, size and modification time so an edited file is converted
//! again. The folder is capped; the least recently written copies go first.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use crate::media_server::MediaServerHandle;

/// Long enough for an hour-long home video on a slow machine; a conversion
/// nobody waits for anymore still ends eventually.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|dir| dir.join("cronostream").join("playback"))
}

/// Where the converted copy of `source` lives (whether or not it exists
/// yet). `.weba`/`.webm` so `mime_for` gives the player the right type.
pub fn cached_path(source: &Path, video: bool) -> Option<PathBuf> {
    let meta = std::fs::metadata(source).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let mut hasher = DefaultHasher::new();
    (source, meta.len(), modified).hash(&mut hasher);
    let ext = if video { "webm" } else { "weba" };
    Some(cache_dir()?.join(format!("{:016x}.{ext}", hasher.finish())))
}

/// One lock per copy, so two requests for the same file (the viewer and a
/// preview, or a quick re-open) wait for one ffmpeg instead of both writing
/// the same file, while different files still convert side by side.
fn lock_for(dest: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(locks.entry(dest.to_path_buf()).or_default())
}

fn convert(source: &Path, dest: &Path, video: bool) -> Result<(), String> {
    let part = dest.with_extension("part");
    let mut command = crate::ffmpeg_tool::command("ffmpeg");
    command.arg("-y").arg("-i").arg(source);
    if video {
        command.args([
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
            "-b:v", "0", "-crf", "32", "-pix_fmt", "yuv420p",
            // Old clips are small; this only reins in the odd HD one.
            "-vf", "scale='min(1920,iw)':-2",
        ]);
    } else {
        command.arg("-vn");
    }
    command.args(["-c:a", "libopus", "-b:a", "96k", "-f", "webm"]).arg(&part);

    let output = crate::ffmpeg_tool::output_with_timeout(&mut command, CONVERT_TIMEOUT);
    let finished = matches!(&output, Ok(o) if o.status.success()) && std::fs::rename(&part, dest).is_ok();
    if finished {
        return Ok(());
    }
    let _ = std::fs::remove_file(&part);
    Err(match output {
        Err(e) => crate::trf!("ffmpeg ist fehlgeschlagen: {e}", e = e),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
            crate::trf!("Umwandeln für die Wiedergabe fehlgeschlagen: {e}", e = last)
        }
    })
}

/// Drops the oldest copies once the folder is over its cap, never `keep`.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().unwrap_or(UNIX_EPOCH), meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    files.sort();
    for (_, len, path) in files {
        if total <= CACHE_LIMIT_BYTES {
            break;
        }
        if path != keep && std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// Makes sure a playable copy of `path` exists. Only for files the media
/// server would serve anyway, so this can't be used to read anything else.
#[tauri::command(async)]
pub fn prepare_playback_copy(handle: tauri::State<MediaServerHandle>, path: String, video: bool) -> Result<(), String> {
    let source = handle
        .resolve(&path)
        .ok_or_else(|| crate::i18n::tr("Datei ist für die Wiedergabe nicht freigegeben.").to_string())?;
    let dest = cached_path(&source, video)
        .ok_or_else(|| crate::i18n::tr("Datei ist für die Wiedergabe nicht freigegeben.").to_string())?;

    let lock = lock_for(&dest);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if dest.is_file() {
        return Ok(());
    }
    let dir = dest.parent().expect("Cache-Datei liegt in einem Ordner");
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    convert(&source, &dest, video)?;
    prune(dir, &dest);
    Ok(())
}
