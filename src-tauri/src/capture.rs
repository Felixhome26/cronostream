//! Native audio/video recording through ffmpeg.
//!
//! Replaces recording inside the webview (`getUserMedia` + `MediaRecorder`),
//! which WebKitGTK on Linux can't be relied on for: the microphone opened
//! fine, but the recorder handed back no data. ffmpeg talks to each
//! system's capture API directly — V4L2 + PulseAudio/PipeWire on Linux (the
//! same layers Cheese uses through GStreamer), DirectShow on Windows,
//! AVFoundation on macOS — so the webview only ever shows what this module
//! sends it.
//!
//! **One process owns the device.** A USB webcam can usually be opened by
//! one program at a time, so the live preview and the recording can't be
//! two separate readers. Every phase is therefore one ffmpeg process with
//! the right set of outputs:
//!
//! - *preview*: camera → small MJPEG frames on stdout (video), or the
//!   microphone → 16 kHz mono PCM on stdout for the level meter (audio);
//! - *recording*: the same, plus a segment file (Matroska — robust if the
//!   process dies, since nothing has to be written at the end).
//!
//! Pause ends the current segment and goes back to preview; resume starts
//! the next segment. Stop joins all segments losslessly into the final file
//! in the staging area, from where `record_commands`/`add_items_with_dates`
//! take over as before.
//!
//! **Formats are chosen for licensing, not just compatibility** (CronoStream
//! is meant to be sold — see `profiles`):
//!
//! - Windows/macOS: H.264 + AAC in MP4/M4A, but only through the encoders
//!   the operating system ships (Media Foundation, VideoToolbox/
//!   AudioToolbox), whose patent licensing Microsoft and Apple cover.
//!   ffmpeg's own AAC encoder and libx264 (GPL) are deliberately not used.
//! - Linux has no such system encoder, so it records royalty-free VP9 +
//!   Opus in WebM (`.webm`, audio-only as `.weba`). Windows/macOS fall
//!   back to the same when their system encoder isn't usable.

use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use uuid::Uuid;

use crate::ffmpeg_tool;
use crate::media_server::MediaServerHandle;
use crate::record_commands::staging_root;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Video,
    Audio,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Device {
    /// What ffmpeg is given: `/dev/video0` / a PulseAudio source name
    /// (Linux), the device's friendly name (Windows), its index (macOS).
    id: String,
    /// Empty for the "system default" entry — the frontend words that one.
    label: String,
}

#[derive(Serialize, Default, Debug)]
pub struct DeviceList {
    video: Vec<Device>,
    audio: Vec<Device>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureEvent {
    /// Audio mode: the microphone level, 0..1 (−60 dBFS..0 dBFS), ~30×/s.
    Level { level: f32 },
    /// The running process died on its own (device unplugged, …).
    Error { message: String },
}

/// Runs blocking work (process start-up waits for the device, finalizing
/// copies the whole take) off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_capture_devices() -> Result<DeviceList, String> {
    blocking(|| Ok(list_devices())).await
}

#[cfg(target_os = "linux")]
fn list_devices() -> DeviceList {
    let mut video: Vec<(u32, Device)> = std::fs::read_dir("/sys/class/video4linux")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let node = entry.file_name().to_string_lossy().to_string();
            let number: u32 = node.strip_prefix("video")?.parse().ok()?;
            let sys = entry.path();
            // A UVC webcam shows up as two nodes: the picture (index 0) and a
            // metadata stream that can't be recorded from.
            let index = std::fs::read_to_string(sys.join("index")).unwrap_or_default();
            if !index.trim().is_empty() && index.trim() != "0" {
                return None;
            }
            let label = std::fs::read_to_string(sys.join("name"))
                .map(|name| name.trim().to_string())
                .unwrap_or_else(|_| node.clone());
            Some((number, Device { id: format!("/dev/{node}"), label }))
        })
        .collect();
    video.sort_by_key(|(number, _)| *number);

    let mut audio = vec![Device { id: "default".to_string(), label: String::new() }];
    // `LC_ALL=C`: pactl translates its field names ("Beschreibung:").
    let mut pactl = std::process::Command::new("pactl");
    pactl.env("LC_ALL", "C").args(["list", "sources"]);
    if let Ok(output) = ffmpeg_tool::output_with_timeout(&mut pactl, std::time::Duration::from_secs(5)) {
        audio.extend(parse_pactl_sources(&String::from_utf8_lossy(&output.stdout)));
    }

    DeviceList { video: video.into_iter().map(|(_, device)| device).collect(), audio }
}

#[cfg(windows)]
fn list_devices() -> DeviceList {
    ffmpeg_tool::command("ffmpeg")
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdin(Stdio::null())
        .output()
        .map(|output| parse_dshow(&String::from_utf8_lossy(&output.stderr)))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn list_devices() -> DeviceList {
    ffmpeg_tool::command("ffmpeg")
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .stdin(Stdio::null())
        .output()
        .map(|output| parse_avfoundation(&String::from_utf8_lossy(&output.stderr)))
        .unwrap_or_default()
}

/// Microphones from `pactl list sources`. The `.monitor` sources are the
/// "what the speakers play" taps, not inputs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_pactl_sources(text: &str) -> Vec<Device> {
    let mut devices = Vec::new();
    let mut name: Option<String> = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with("Source #") {
            name = None;
        } else if let Some(value) = line.strip_prefix("Name: ") {
            name = Some(value.to_string());
        } else if let Some(description) = line.strip_prefix("Description: ") {
            if let Some(id) = name.take().filter(|id| !id.ends_with(".monitor")) {
                devices.push(Device { id, label: description.to_string() });
            }
        }
    }
    devices
}

/// ffmpeg's DirectShow listing. Newer builds tag each line with
/// `(video)`/`(audio)`, older ones group them under section headers —
/// both are understood.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_dshow(text: &str) -> DeviceList {
    let mut list = DeviceList::default();
    let mut section_is_video: Option<bool> = None;
    for line in text.lines() {
        if line.contains("DirectShow video devices") {
            section_is_video = Some(true);
            continue;
        }
        if line.contains("DirectShow audio devices") {
            section_is_video = Some(false);
            continue;
        }
        if line.contains("Alternative name") {
            continue;
        }
        let (Some(open), Some(close)) = (line.find('"'), line.rfind('"')) else {
            continue;
        };
        if close <= open + 1 {
            continue;
        }
        let name = line[open + 1..close].to_string();
        let tag = line[close + 1..].trim();
        let (video, audio) = if tag.is_empty() {
            (section_is_video == Some(true), section_is_video == Some(false))
        } else {
            (tag.contains("video"), tag.contains("audio"))
        };
        let device = Device { id: name.clone(), label: name };
        if video && !list.video.contains(&device) {
            list.video.push(device.clone());
        }
        if audio && !list.audio.contains(&device) {
            list.audio.push(device);
        }
    }
    list
}

/// ffmpeg's AVFoundation listing: `[index] name` lines under a video and
/// an audio header. Screen capture "cameras" are left out.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_avfoundation(text: &str) -> DeviceList {
    let mut list = DeviceList::default();
    let mut in_video: Option<bool> = None;
    for line in text.lines() {
        if line.contains("AVFoundation video devices") {
            in_video = Some(true);
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            in_video = Some(false);
            continue;
        }
        let Some(is_video) = in_video else { continue };
        // Drop the "[AVFoundation indev @ 0x…] " prefix.
        let Some((_, rest)) = line.split_once("] ") else { continue };
        let Some(rest) = rest.strip_prefix('[') else { continue };
        let Some((index, name)) = rest.split_once("] ") else { continue };
        if index.parse::<u32>().is_err() || name.starts_with("Capture screen") {
            continue;
        }
        let device = Device { id: index.to_string(), label: name.trim().to_string() };
        if is_video {
            list.video.push(device);
        } else {
            list.audio.push(device);
        }
    }
    list
}

// ---------------------------------------------------------------------------
// ffmpeg arguments
// ---------------------------------------------------------------------------

/// One way of opening the devices. Cameras differ in what they accept, so
/// there are several, tried in order until one delivers data — the same
/// thing Cheese does by negotiating caps with the camera.
struct Inputs {
    args: Vec<String>,
    /// Stream specifiers for `-map`.
    video: Option<&'static str>,
    audio: Option<&'static str>,
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

#[cfg(target_os = "linux")]
fn input_variants(mode: Mode, video: Option<&str>, audio: Option<&str>) -> Vec<Inputs> {
    // Without an explicit fragment size PulseAudio hands audio over in
    // chunks of up to two seconds: late timestamps, a sluggish level meter.
    // 4 KiB is a few tens of milliseconds.
    let audio_input = |args: &mut Vec<String>| {
        if let Some(audio) = audio {
            args.extend(strings(&["-thread_queue_size", "512", "-fragment_size", "4096", "-f", "pulse", "-i", audio]));
        }
    };
    match (mode, video) {
        (Mode::Video, Some(device)) => {
            // MJPEG at 720p first: what nearly every USB webcam delivers at
            // full frame rate (raw YUYV at 720p is often only 5–10 fps).
            let tunings: [&[&str]; 3] = [
                &["-input_format", "mjpeg", "-framerate", "30", "-video_size", "1280x720"],
                &["-video_size", "1280x720"],
                &[],
            ];
            tunings
                .iter()
                .map(|tuning| {
                    // Camera and microphone are two separate inputs here, each
                    // with its own clock, and by default ffmpeg starts each at
                    // zero — so whatever delay the microphone has at start-up
                    // ends up as a lip-sync offset. Instead both get wall-clock
                    // timestamps (PulseAudio's already are), kept as they are
                    // (`-copyts`) and only shifted to zero as a whole in the
                    // recording (`-avoid_negative_ts make_zero` in
                    // `output_args`).
                    let mut args = strings(&["-copyts", "-thread_queue_size", "512", "-use_wallclock_as_timestamps", "1", "-f", "v4l2"]);
                    args.extend(strings(tuning));
                    args.extend(strings(&["-i", device]));
                    audio_input(&mut args);
                    Inputs { args, video: Some("0:v"), audio: audio.map(|_| "1:a") }
                })
                .collect()
        }
        (Mode::Audio, _) => {
            let mut args = Vec::new();
            audio_input(&mut args);
            vec![Inputs { args, video: None, audio: Some("0:a") }]
        }
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn input_variants(mode: Mode, video: Option<&str>, audio: Option<&str>) -> Vec<Inputs> {
    // Without this DirectShow buffers half a second of audio, which makes
    // the level meter visibly lag behind the voice.
    let low_latency = ["-audio_buffer_size", "50"];
    match (mode, video) {
        (Mode::Video, Some(device)) => {
            let target = match audio {
                Some(audio) => format!("video={device}:audio={audio}"),
                None => format!("video={device}"),
            };
            // MJPEG asked for explicitly first: some webcams would otherwise
            // hand over H.264, which the bundled ffmpeg can't decode (it has
            // no patent-pool decoders, see tools/ffmpeg-build/).
            let tunings: [&[&str]; 3] = [
                &["-vcodec", "mjpeg", "-video_size", "1280x720", "-framerate", "30"],
                &["-video_size", "1280x720", "-framerate", "30"],
                &[],
            ];
            tunings
                .iter()
                .map(|tuning| {
                    let mut args = strings(&["-thread_queue_size", "1024", "-f", "dshow", "-rtbufsize", "256M"]);
                    args.extend(strings(&low_latency));
                    args.extend(strings(tuning));
                    args.extend(["-i".to_string(), target.clone()]);
                    Inputs { args, video: Some("0:v"), audio: audio.map(|_| "0:a") }
                })
                .collect()
        }
        (Mode::Audio, _) => match audio {
            Some(audio) => {
                let mut args = strings(&["-thread_queue_size", "1024", "-f", "dshow"]);
                args.extend(strings(&low_latency));
                args.extend(["-i".to_string(), format!("audio={audio}")]);
                vec![Inputs { args, video: None, audio: Some("0:a") }]
            }
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn input_variants(mode: Mode, video: Option<&str>, audio: Option<&str>) -> Vec<Inputs> {
    match (mode, video) {
        (Mode::Video, Some(device)) => {
            let target = format!("{device}:{}", audio.unwrap_or("none"));
            // AVFoundation insists on a frame rate the camera supports, and
            // ffmpeg's default (29.97) is one many Mac cameras refuse.
            let tunings: [&[&str]; 3] = [
                &["-framerate", "30", "-video_size", "1280x720"],
                &["-framerate", "30"],
                &["-framerate", "15"],
            ];
            tunings
                .iter()
                .map(|tuning| {
                    let mut args = strings(&["-thread_queue_size", "1024", "-f", "avfoundation"]);
                    args.extend(strings(tuning));
                    args.extend(["-i".to_string(), target.clone()]);
                    Inputs { args, video: Some("0:v"), audio: audio.map(|_| "0:a") }
                })
                .collect()
        }
        (Mode::Audio, _) => match audio {
            Some(audio) => {
                let mut args = strings(&["-thread_queue_size", "1024", "-f", "avfoundation"]);
                args.extend(["-i".to_string(), format!(":{audio}")]);
                vec![Inputs { args, video: None, audio: Some("0:a") }]
            }
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// What a take is encoded as: encoder arguments plus the final file's
/// extension. Segments are always Matroska, which holds all of these.
#[derive(Clone, Debug, PartialEq)]
struct Profile {
    /// Empty in audio mode.
    video: Vec<String>,
    audio: Vec<String>,
    extension: &'static str,
}

/// The encoders this ffmpeg has (names from `ffmpeg -encoders`). Cached once
/// read — but a failure is not, since ffmpeg may be installed while the
/// app runs.
fn available_encoders() -> Result<HashSet<String>, String> {
    static FOUND: OnceLock<HashSet<String>> = OnceLock::new();
    if let Some(found) = FOUND.get() {
        return Ok(found.clone());
    }
    let output = ffmpeg_tool::command("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| crate::trf!("ffmpeg konnte nicht gestartet werden: {e}", e = e))?;
    let names = parse_encoders(&String::from_utf8_lossy(&output.stdout));
    Ok(FOUND.get_or_init(|| names).clone())
}

/// Encoder lines look like ` V....D libvpx-vp9   libvpx VP9 (codec vp9)`.
/// They follow a `------` line; above it is a legend in the same shape
/// (` V..... = Video`), which must not be read as encoders.
fn parse_encoders(listing: &str) -> HashSet<String> {
    listing
        .lines()
        .skip_while(|line| !line.trim_start().starts_with("------"))
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let flags = fields.next()?;
            let name = fields.next()?;
            (flags.len() == 6 && flags.chars().next().is_some_and(|c| "VAS".contains(c))).then(|| name.to_string())
        })
        .collect()
}

/// The candidate profiles for this system, best first, limited to what
/// `has` says this ffmpeg can do. The order is the licensing policy from
/// the module docs: the operating system's own H.264/AAC encoders where
/// they exist, otherwise royalty-free VP9 (or VP8) with Opus. ffmpeg's
/// built-in `aac` and libx264 never appear here on purpose.
fn profiles(mode: Mode, has: impl Fn(&str) -> bool) -> Vec<Profile> {
    let audio_bitrate = if mode == Mode::Video { "128k" } else { "160k" };
    let system_h264: Option<Vec<String>> = if cfg!(target_os = "macos") {
        // `allow_sw`: Macs without a hardware encoder fall back to Apple's
        // software one — still Apple's, still covered.
        Some(strings(&["-c:v", "h264_videotoolbox", "-b:v", "5M", "-allow_sw", "1", "-realtime", "1"]))
    } else if cfg!(windows) {
        Some(strings(&["-c:v", "h264_mf", "-b:v", "5M"]))
    } else {
        None
    };
    let system_aac: Option<Vec<String>> = if cfg!(target_os = "macos") {
        Some(strings(&["-c:a", "aac_at", "-b:a", audio_bitrate]))
    } else if cfg!(windows) {
        Some(strings(&["-c:a", "aac_mf", "-b:a", audio_bitrate]))
    } else {
        None
    };
    // `lag-in-frames 0`: libvpx otherwise holds back ~25 frames (close to a
    // second) for look-ahead, which on ffmpeg builds that encode on the main
    // thread (6.x, as in Linux Mint) delays the live preview by as much.
    // Tiles + threads keep 720p real-time on ordinary CPUs.
    let vp9 = strings(&[
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-tile-columns", "2",
        "-threads", "4", "-lag-in-frames", "0", "-b:v", "2500k", "-g", "60",
    ]);
    let vp8 = strings(&[
        "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-threads", "4", "-lag-in-frames", "0", "-b:v",
        "2500k", "-g", "60",
    ]);
    let opus = strings(&["-c:a", "libopus", "-b:a", audio_bitrate]);

    let mut candidates = Vec::new();
    match mode {
        Mode::Video => {
            if let (Some(video), Some(audio)) = (system_h264, system_aac) {
                candidates.push(Profile { video, audio, extension: "mp4" });
            }
            candidates.push(Profile { video: vp9, audio: opus.clone(), extension: "webm" });
            candidates.push(Profile { video: vp8, audio: opus, extension: "webm" });
        }
        Mode::Audio => {
            if let Some(audio) = system_aac {
                candidates.push(Profile { video: Vec::new(), audio, extension: "m4a" });
            }
            candidates.push(Profile { video: Vec::new(), audio: opus, extension: "weba" });
        }
    }
    // `-c:v <name>` / `-c:a <name>`: the encoder name follows the flag.
    let encoder_of = |args: &[String]| args.get(1).cloned();
    candidates
        .into_iter()
        .filter(|profile| {
            [encoder_of(&profile.video), encoder_of(&profile.audio)].into_iter().flatten().all(|name| has(&name))
        })
        .collect()
}

/// Everything after the inputs: optionally the recording, always the
/// preview stream on stdout.
fn output_args(mode: Mode, inputs: &Inputs, record_to: Option<(&Path, &Profile)>) -> Vec<String> {
    let mut args = Vec::new();
    match mode {
        Mode::Video => {
            let video = inputs.video.unwrap_or("0:v");
            if let Some((path, profile)) = record_to {
                // yuv420p needs even dimensions; the preview branch
                // is thinned out to 12 fps at 640 px — plenty for checking
                // the picture, and light on the IPC bridge.
                args.extend([
                    "-filter_complex".to_string(),
                    format!(
                        "[{video}]split=2[rec0][pv0];[rec0]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[rec];[pv0]fps=12,scale=640:-2[pv]"
                    ),
                ]);
                args.extend(strings(&["-map", "[rec]"]));
                if let Some(audio) = inputs.audio {
                    args.extend(strings(&["-map", audio]));
                    args.extend(profile.audio.iter().cloned());
                }
                args.extend(profile.video.iter().cloned());
                args.extend(strings(&["-avoid_negative_ts", "make_zero", "-f", "matroska"]));
                args.push(path.to_string_lossy().to_string());
                args.extend(strings(&["-map", "[pv]"]));
            } else {
                args.extend(strings(&["-map", video, "-vf", "fps=12,scale=640:-2"]));
            }
            args.extend(strings(&["-c:v", "mjpeg", "-q:v", "6", "-flush_packets", "1", "-f", "mjpeg", "pipe:1"]));
        }
        Mode::Audio => {
            let audio = inputs.audio.unwrap_or("0:a");
            if let Some((path, profile)) = record_to {
                args.extend(strings(&["-map", audio]));
                args.extend(profile.audio.iter().cloned());
                args.extend(strings(&["-f", "matroska"]));
                args.push(path.to_string_lossy().to_string());
            }
            args.extend(strings(&[
                "-map", audio, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-flush_packets", "1", "-f", "s16le", "pipe:1",
            ]));
        }
    }
    args
}

// ---------------------------------------------------------------------------
// Process handling
// ---------------------------------------------------------------------------

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Set before an intentional stop, so the reader doesn't report it.
    stopping: Arc<AtomicBool>,
    /// Set by the reader on the first data from the device.
    delivering: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    /// The segment this process is writing, if it records.
    segment: Option<PathBuf>,
}

impl Running {
    fn tail(&self) -> Vec<String> {
        self.stderr_tail.lock().map(|tail| tail.iter().cloned().collect()).unwrap_or_default()
    }

    /// `graceful`: ask ffmpeg to finish (`q` on stdin) so the segment is
    /// closed properly; otherwise just kill it (preview only).
    fn stop(mut self, graceful: bool) -> Option<PathBuf> {
        self.stopping.store(true, Ordering::SeqCst);
        if graceful {
            if let Some(mut stdin) = self.stdin.take() {
                let _ = stdin.write_all(b"q");
                let _ = stdin.flush();
            }
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.segment.filter(|segment| std::fs::metadata(segment).map(|m| m.len() > 0).unwrap_or(false))
    }
}

/// Turns ffmpeg's last words into something worth showing the user.
fn friendly_error(tail: &[String]) -> String {
    let all = tail.join("\n").to_lowercase();
    if all.contains("permission denied") || all.contains("not permitted") || all.contains("not authorized") || all.contains("access is denied") {
        return crate::i18n::tr(NO_ACCESS).to_string();
    }
    if all.contains("device or resource busy") || all.contains("already in use") {
        return crate::i18n::tr(DEVICE_BUSY).to_string();
    }
    if all.contains("no such file or directory") || all.contains("could not find") || all.contains("no such device") {
        return crate::i18n::tr("Das gewählte Gerät wurde nicht gefunden.").to_string();
    }
    match tail.iter().rev().find(|line| !line.trim().is_empty()) {
        Some(last) => crate::trf!("Die Aufnahme konnte nicht gestartet werden ({detail}).", detail = last.trim()),
        None => crate::i18n::tr("Die Aufnahme konnte nicht gestartet werden.").to_string(),
    }
}

/// Finds complete JPEGs in the MJPEG byte stream (SOI … EOI). Inside a
/// JPEG's entropy-coded data 0xFF is always stuffed, so an EOI marker can't
/// appear by accident.
fn take_jpeg(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let start = buffer.windows(2).position(|pair| pair == [0xFF, 0xD8])?;
    let end = buffer[start + 2..].windows(2).position(|pair| pair == [0xFF, 0xD9])? + start + 2;
    let frame = buffer[start..end + 2].to_vec();
    buffer.drain(..end + 2);
    Some(frame)
}

/// RMS of a block of s16 samples, mapped from −60..0 dBFS onto 0..1.
fn level_of(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if rms <= 0.0 {
        return 0.0;
    }
    (((20.0 * rms.log10()) + 60.0) / 60.0).clamp(0.0, 1.0) as f32
}

fn spawn(
    mode: Mode,
    args: Vec<String>,
    segment: Option<PathBuf>,
    frames: &Channel,
    events: &Channel<CaptureEvent>,
) -> Result<Running, String> {
    let mut child = ffmpeg_tool::command("ffmpeg")
        .args(["-hide_banner", "-nostats", "-loglevel", "warning", "-y"])
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| crate::trf!("ffmpeg konnte nicht gestartet werden: {e}", e = e))?;

    let stopping = Arc::new(AtomicBool::new(false));
    let delivering = Arc::new(AtomicBool::new(false));
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));

    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut tail) = tail.lock() {
                    if tail.len() >= 20 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        });
    }

    if let Some(mut stdout) = child.stdout.take() {
        let (stopping, delivering, tail) = (Arc::clone(&stopping), Arc::clone(&delivering), Arc::clone(&stderr_tail));
        let (frames, events) = (frames.clone(), events.clone());
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; 64 * 1024];
            let mut buffer: Vec<u8> = Vec::new();
            loop {
                let read = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                delivering.store(true, Ordering::SeqCst);
                buffer.extend_from_slice(&chunk[..read]);
                match mode {
                    Mode::Video => {
                        while let Some(frame) = take_jpeg(&mut buffer) {
                            let _ = frames.send(InvokeResponseBody::Raw(frame));
                        }
                        // A stream that never closes a frame must not grow forever.
                        if buffer.len() > 16 * 1024 * 1024 {
                            buffer.clear();
                        }
                    }
                    Mode::Audio => {
                        // 512 samples at 16 kHz ≈ 32 ms per level value.
                        const BLOCK: usize = 512 * 2;
                        while buffer.len() >= BLOCK {
                            let samples: Vec<i16> =
                                buffer[..BLOCK].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                            buffer.drain(..BLOCK);
                            let _ = events.send(CaptureEvent::Level { level: level_of(&samples) });
                        }
                    }
                }
            }
            // Only a process that was running fine and then died is news;
            // one that never delivered is handled by `launch`.
            if delivering.load(Ordering::SeqCst) && !stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
                let tail: Vec<String> = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
                let _ = events.send(CaptureEvent::Error { message: friendly_error(&tail) });
            }
        });
    }

    Ok(Running { stdin: child.stdin.take(), child, stopping, delivering, stderr_tail, segment })
}

struct Session {
    /// The frontend's name for this session — see `capture_close`.
    token: String,
    mode: Mode,
    video: Option<String>,
    audio: Option<String>,
    /// Segments of the take in progress; deleted when the take is joined or
    /// the session closes.
    parts_dir: PathBuf,
    segments: Vec<PathBuf>,
    running: Option<Running>,
    /// The input variant that worked last, tried first next time.
    variant: Option<usize>,
    /// The encoding of the take in progress — fixed at its first segment,
    /// because segments can only be joined losslessly if they all match.
    profile: Option<Profile>,
    frames: Channel,
    events: Channel<CaptureEvent>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Held for the whole of `capture_open`, which waits for the device without
/// holding `SESSION`: two opens racing (a quick device switch) would
/// otherwise both reach for the same camera, and one would find it busy.
static OPENING: Mutex<()> = Mutex::new(());

const NO_ACCESS: &str = "Kein Zugriff auf das Gerät – bitte den Zugriff in den Datenschutz-Einstellungen des Systems erlauben.";
const DEVICE_BUSY: &str = "Das Gerät ist belegt – vermutlich benutzt es gerade ein anderes Programm.";

fn is_device_problem(error: &str) -> bool {
    // Compared against the translated text: `describe_open_failure` hands
    // these two out through `tr`, so the language they arrive in is the
    // one currently set.
    error == crate::i18n::tr(NO_ACCESS) || error == crate::i18n::tr(DEVICE_BUSY)
}

impl Session {
    /// Starts ffmpeg — preview only, or recording into a new segment. The
    /// first segment of a take picks the encoding: the best profile that
    /// actually starts (a system encoder can be listed and still refuse,
    /// e.g. a Media Foundation encoder whose driver is broken).
    fn launch(&mut self, record: bool) -> Result<(), String> {
        if !record {
            return self.launch_with(None);
        }
        if let Some(profile) = self.profile.clone() {
            return self.launch_with(Some(&profile));
        }
        let encoders = available_encoders()?;
        let candidates = profiles(self.mode, |name| encoders.contains(name));
        if candidates.is_empty() {
            return Err(crate::i18n::tr("Dieses ffmpeg hat keinen geeigneten Encoder – bitte ffmpeg über CronoStream neu installieren.").to_string());
        }
        let mut last_error = String::new();
        for profile in candidates {
            match self.launch_with(Some(&profile)) {
                Ok(()) => {
                    self.profile = Some(profile);
                    return Ok(());
                }
                Err(error) => {
                    let device_problem = is_device_problem(&error);
                    last_error = error;
                    if device_problem {
                        break;
                    }
                }
            }
        }
        Err(last_error)
    }

    /// Starts ffmpeg with `profile` (recording) or without (preview) and
    /// waits until the device actually delivers.
    fn launch_with(&mut self, profile: Option<&Profile>) -> Result<(), String> {
        let record = profile.is_some();
        let variants = input_variants(self.mode, self.video.as_deref(), self.audio.as_deref());
        if variants.is_empty() {
            return Err(match self.mode {
                Mode::Video => crate::i18n::tr("Es wurde keine Kamera gefunden.").to_string(),
                Mode::Audio => crate::i18n::tr("Es wurde kein Mikrofon gefunden.").to_string(),
            });
        }

        let mut order: Vec<usize> = (0..variants.len()).collect();
        if let Some(known) = self.variant.filter(|&known| known < variants.len()) {
            order.retain(|&index| index != known);
            order.insert(0, known);
        }

        let mut last_error = String::new();
        for index in order {
            let segment = record.then(|| {
                let extension = if self.mode == Mode::Video { "mkv" } else { "mka" };
                self.parts_dir.join(format!("part-{}-{index}.{extension}", self.segments.len()))
            });
            let inputs = &variants[index];
            let mut args = inputs.args.clone();
            args.extend(output_args(self.mode, inputs, segment.as_deref().zip(profile)));

            let mut running = spawn(self.mode, args, segment, &self.frames, &self.events)?;
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if running.delivering.load(Ordering::SeqCst) {
                    self.variant = Some(index);
                    self.running = Some(running);
                    return Ok(());
                }
                let exited = matches!(running.child.try_wait(), Ok(Some(_)));
                if exited || Instant::now() > deadline {
                    // Let the stderr reader catch the last lines.
                    std::thread::sleep(Duration::from_millis(150));
                    last_error = if exited {
                        friendly_error(&running.tail())
                    } else {
                        crate::i18n::tr("Das Gerät liefert keine Daten.").to_string()
                    };
                    if let Some(partial) = running.stop(false) {
                        let _ = std::fs::remove_file(partial);
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // A missing permission or a busy device won't change with a
            // different resolution — no point trying the other variants.
            if is_device_problem(&last_error) {
                break;
            }
        }
        Err(last_error)
    }

    /// Ends the running process; a finished segment joins the take. Only
    /// a recording process is asked to finish properly — a preview has
    /// nothing to write and is simply ended.
    fn halt(&mut self) {
        if let Some(running) = self.running.take() {
            let graceful = running.segment.is_some();
            if let Some(segment) = running.stop(graceful) {
                self.segments.push(segment);
            }
        }
    }

    /// Joins the segments losslessly into the final file and returns it.
    fn finish(&mut self) -> Result<PathBuf, String> {
        // The next take picks its encoding afresh.
        let profile = self.profile.take();
        let (Some(profile), false) = (profile, self.segments.is_empty()) else {
            return Err(crate::i18n::tr("Es wurden keine Daten aufgezeichnet – bitte noch einmal versuchen.").to_string());
        };
        let dir = staging_root().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).map_err(|e| crate::trf!("Konnte den Zwischenspeicher nicht anlegen: {e}", e = e))?;
        let output = dir.join(format!("aufnahme.{}", profile.extension));

        // The concat demuxer's list: single quotes keep backslashes in
        // Windows paths literal; a quote inside is closed, escaped, reopened.
        let list: String = self
            .segments
            .iter()
            .map(|segment| format!("file '{}'\n", segment.to_string_lossy().replace('\'', "'\\''")))
            .collect();
        let list_path = self.parts_dir.join("list.txt");
        std::fs::write(&list_path, list).map_err(|e| crate::trf!("Konnte die Aufnahme nicht zusammenfügen: {e}", e = e))?;

        let mut concat = ffmpeg_tool::command("ffmpeg");
        concat
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path)
            .args(["-c", "copy"])
            // Named explicitly: ffmpeg doesn't recognise `.weba` by itself.
            .args(["-f", match profile.extension {
                "mp4" => "mp4",
                "m4a" => "ipod",
                _ => "webm",
            }])
            // Index up front so playback can start before the whole file is
            // read. An MP4 muxer option — WebM's muxer would reject it.
            .args(if matches!(profile.extension, "mp4" | "m4a") { &["-movflags", "+faststart"][..] } else { &[] })
            .arg(&output);
        // Only remuxes (`-c copy`), so even an hour of video is done in
        // seconds; the limit only catches an ffmpeg that hangs.
        let result = ffmpeg_tool::output_with_timeout(&mut concat, std::time::Duration::from_secs(600))
            .map_err(|e| crate::trf!("ffmpeg ist fehlgeschlagen: {e}", e = e))?;

        for segment in self.segments.drain(..) {
            let _ = std::fs::remove_file(segment);
        }
        let _ = std::fs::remove_file(&list_path);

        if !result.status.success() || !output.is_file() {
            let _ = std::fs::remove_dir_all(&dir);
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(crate::trf!("Die Aufnahme konnte nicht fertiggestellt werden: {detail}", detail = stderr.trim()));
        }
        Ok(output)
    }

    fn close(mut self) {
        if let Some(running) = self.running.take() {
            running.stop(false);
        }
        let _ = std::fs::remove_dir_all(&self.parts_dir);
    }
}

fn with_session<T>(work: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut guard = SESSION.lock().map_err(|_| crate::i18n::tr("Aufnahme-Zustand ist beschädigt.").to_string())?;
    let session = guard.as_mut().ok_or(crate::i18n::tr("Es ist keine Aufnahme geöffnet."))?;
    work(session)
}

/// Stops everything — on closing the dialog and on app exit, so the camera
/// light never stays on behind the user's back.
pub fn shutdown() {
    let session = SESSION.lock().ok().and_then(|mut guard| guard.take());
    if let Some(session) = session {
        session.close();
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Opens the devices and starts the live preview (video frames on
/// `frames`, levels and errors on `events`).
#[tauri::command]
pub async fn capture_open(
    token: String,
    mode: Mode,
    video_device: Option<String>,
    audio_device: Option<String>,
    frames: Channel,
    events: Channel<CaptureEvent>,
) -> Result<(), String> {
    blocking(move || {
        let _opening = OPENING.lock().map_err(|_| crate::i18n::tr("Aufnahme-Zustand ist beschädigt.").to_string())?;
        shutdown();
        let parts_dir = staging_root().join(format!("parts-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&parts_dir).map_err(|e| crate::trf!("Konnte den Zwischenspeicher nicht anlegen: {e}", e = e))?;
        let mut session = Session {
            token,
            mode,
            video: video_device.filter(|id| !id.is_empty()),
            audio: audio_device.filter(|id| !id.is_empty()),
            parts_dir,
            segments: Vec::new(),
            running: None,
            variant: None,
            profile: None,
            frames,
            events,
        };
        match session.launch(false) {
            Ok(()) => {
                if let Ok(mut guard) = SESSION.lock() {
                    *guard = Some(session);
                }
                Ok(())
            }
            Err(error) => {
                session.close();
                Err(error)
            }
        }
    })
    .await
}

/// Starts (or, after a pause, continues) recording.
#[tauri::command]
pub async fn capture_record() -> Result<(), String> {
    blocking(|| {
        with_session(|session| {
            session.halt();
            session.launch(true).inspect_err(|_| {
                // Back to a live preview so the dialog isn't left dead.
                let _ = session.launch(false);
            })
        })
    })
    .await
}

/// Pauses: closes the current segment, keeps the preview running.
#[tauri::command]
pub async fn capture_pause() -> Result<(), String> {
    blocking(|| {
        with_session(|session| {
            session.halt();
            session.launch(false)
        })
    })
    .await
}

/// Ends the take and returns the finished file (in the staging area). The
/// devices are released — the review phase doesn't need them.
#[tauri::command]
pub async fn capture_stop(media: tauri::State<'_, MediaServerHandle>) -> Result<String, String> {
    let path = blocking(|| {
        with_session(|session| {
            session.halt();
            session.finish()
        })
    })
    .await?;
    // So the review player can stream it from the loopback media server.
    let root = staging_root();
    media.allow_dir(&root, true);
    Ok(path.to_string_lossy().to_string())
}

/// Closes the session `token` names — and only that one: a dialog closing
/// (or React re-mounting it) must not take down a session opened after it.
#[tauri::command]
pub async fn capture_close(token: String) -> Result<(), String> {
    blocking(move || {
        let session = SESSION
            .lock()
            .ok()
            .and_then(|mut guard| if guard.as_ref().is_some_and(|s| s.token == token) { guard.take() } else { None });
        if let Some(session) = session {
            session.close();
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pactl_sources_skip_monitors() {
        let text = "Source #0\n\tState: SUSPENDED\n\tName: alsa_output.pci.analog-stereo.monitor\n\tDescription: Monitor of Built-in Audio\n\
                    Source #1\n\tName: alsa_input.usb-Logitech_C920.analog-stereo\n\tDescription: HD Pro Webcam C920 Analog Stereo\n";
        let devices = parse_pactl_sources(text);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "alsa_input.usb-Logitech_C920.analog-stereo");
        assert_eq!(devices[0].label, "HD Pro Webcam C920 Analog Stereo");
    }

    #[test]
    fn dshow_listing_new_and_old_format() {
        let new = "[dshow @ 000001] \"HD Webcam\" (video)\n[dshow @ 000001]   Alternative name \"@device_pnp_\\\\?\\usb\"\n\
                   [dshow @ 000001] \"Mikrofon (Realtek(R) Audio)\" (audio)\n[dshow @ 000001] \"Capture Card\" (audio, video)\n";
        let list = parse_dshow(new);
        assert_eq!(list.video.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["HD Webcam", "Capture Card"]);
        assert_eq!(list.audio.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["Mikrofon (Realtek(R) Audio)", "Capture Card"]);

        let old = "[dshow @ 01] DirectShow video devices\n[dshow @ 01]  \"Cam\"\n[dshow @ 01] DirectShow audio devices\n[dshow @ 01]  \"Mic\"\n";
        let list = parse_dshow(old);
        assert_eq!(list.video[0].id, "Cam");
        assert_eq!(list.audio[0].id, "Mic");
    }

    #[test]
    fn avfoundation_listing() {
        let text = "[AVFoundation indev @ 0x7f8] AVFoundation video devices:\n[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera\n\
                    [AVFoundation indev @ 0x7f8] [1] Capture screen 0\n[AVFoundation indev @ 0x7f8] AVFoundation audio devices:\n\
                    [AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone\n";
        let list = parse_avfoundation(text);
        assert_eq!(list.video, vec![Device { id: "0".into(), label: "FaceTime HD Camera".into() }]);
        assert_eq!(list.audio, vec![Device { id: "0".into(), label: "MacBook Pro Microphone".into() }]);
    }

    #[test]
    fn jpeg_frames_are_cut_from_the_stream() {
        let mut buffer = vec![0x00, 0xFF, 0xD8, 1, 2, 0xFF, 0xD9, 0xFF, 0xD8, 3];
        assert_eq!(take_jpeg(&mut buffer), Some(vec![0xFF, 0xD8, 1, 2, 0xFF, 0xD9]));
        assert_eq!(take_jpeg(&mut buffer), None);
        assert_eq!(buffer, vec![0xFF, 0xD8, 3]);
    }

    #[test]
    fn encoder_listing_is_parsed() {
        let listing = "Encoders:\n V..... = Video\n ------\n V....D libvpx-vp9           libvpx VP9\n A....D libopus              libopus Opus\n A....D aac                  AAC\n";
        let names = parse_encoders(listing);
        assert!(names.contains("libvpx-vp9") && names.contains("libopus") && names.contains("aac"));
        assert!(!names.contains("="));
    }

    #[test]
    fn profiles_never_use_ffmpegs_own_aac_or_x264() {
        for mode in [Mode::Video, Mode::Audio] {
            for profile in profiles(mode, |_| true) {
                let all = [profile.video.clone(), profile.audio.clone()].concat();
                assert!(!all.iter().any(|arg| arg == "aac" || arg == "libx264"), "{profile:?}");
            }
        }
    }

    #[test]
    fn without_system_encoders_it_records_vp9_and_opus() {
        let only_free = |name: &str| matches!(name, "libvpx-vp9" | "libvpx" | "libopus");
        assert_eq!(profiles(Mode::Video, only_free)[0].extension, "webm");
        assert_eq!(profiles(Mode::Video, only_free)[0].video[1], "libvpx-vp9");
        assert_eq!(profiles(Mode::Audio, only_free)[0].extension, "weba");
        assert!(profiles(Mode::Video, |_| false).is_empty());
    }

    #[test]
    fn level_maps_silence_and_full_scale() {
        assert_eq!(level_of(&[0; 512]), 0.0);
        assert!(level_of(&[i16::MAX; 512]) > 0.99);
        let quiet = level_of(&[33; 512]); // ≈ −60 dBFS
        assert!(quiet < 0.05, "{quiet}");
    }
}
