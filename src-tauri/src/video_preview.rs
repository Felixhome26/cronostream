use std::path::Path;
use std::time::Duration;

/// Generous for a single frame or a duration probe even on a slow drive;
/// anything longer means the tool is stuck, not working.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const FRAME_TIMEOUT: Duration = Duration::from_secs(60);

/// Video previews shell out to ffmpeg/ffprobe rather than a Rust crate —
/// they're the de facto standard for this, already handle the huge range
/// of legacy/exotic codecs the project wants to support, and are already
/// installed on this machine. Found via `ffmpeg_tool` (the app's own
/// downloaded copy or the system's); if they're missing, this just fails
/// with a clear error instead of crashing (video then behaves as "can't
/// add," same as any other unsupported format).
fn get_duration_seconds(path: &Path) -> Result<f64, String> {
    let mut command = crate::ffmpeg_tool::command("ffprobe");
    command.args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(path);
    let output = crate::ffmpeg_tool::output_with_timeout(&mut command, PROBE_TIMEOUT)
        .map_err(|e| crate::trf!("ffprobe ist fehlgeschlagen: {e}", e = e))?;

    if !output.status.success() {
        return Err(crate::i18n::tr("Konnte Videolänge nicht ermitteln.").into());
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| crate::i18n::tr("Videolänge konnte nicht gelesen werden.").to_string())
}

/// Extracts a single frame at `frame_percent` (0-100) of the video's
/// duration and writes it as a JPEG to `dest`.
///
/// On Windows/macOS the operating system decodes first (`native_thumb` —
/// its codec licensing covers H.264/HEVC, which CronoStream's bundled ffmpeg
/// deliberately can't decode). ffmpeg is the fallback there, for formats
/// the system doesn't read but the remaining patent-free decoders do; on
/// Linux it is the only path, with the distribution's full ffmpeg.
pub fn extract_frame(source: &Path, frame_percent: f64, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::trf!("Konnte Vorschau-Ordner nicht anlegen: {e}", e = e))?;
    }

    #[cfg(any(windows, target_os = "macos"))]
    {
        if crate::native_thumb::extract_frame(source, frame_percent, dest).is_ok() {
            return Ok(());
        }
    }

    let duration = get_duration_seconds(source)?;
    let timestamp = (duration * frame_percent.clamp(0.0, 100.0) / 100.0).max(0.0);

    // Written beside the target and renamed over it only once complete: a
    // regeneration overwrites the existing thumbnail, and an ffmpeg that
    // fails half way must not leave a broken one in its place. The `.jpg`
    // ending stays last so ffmpeg still picks the image format from it.
    let mut part_name = dest.file_stem().map(|s| s.to_os_string()).unwrap_or_default();
    part_name.push(".part.jpg");
    let part = dest.with_file_name(part_name);

    let mut command = crate::ffmpeg_tool::command("ffmpeg");
    command
        .arg("-y")
        .arg("-ss")
        .arg(format!("{timestamp:.3}"))
        .arg("-i")
        .arg(source)
        .args(["-frames:v", "1", "-q:v", "3", "-vf", "scale=640:-1"])
        .arg(&part);
    let output = crate::ffmpeg_tool::output_with_timeout(&mut command, FRAME_TIMEOUT);

    let finished = matches!(&output, Ok(o) if o.status.success()) && part.exists() && std::fs::rename(&part, dest).is_ok();
    if !finished {
        let _ = std::fs::remove_file(&part);
        return Err(match output {
            Err(e) => crate::trf!("ffmpeg ist fehlgeschlagen: {e}", e = e),
            Ok(_) => crate::i18n::tr("Konnte keinen Videoframe extrahieren.").into(),
        });
    }
    Ok(())
}
