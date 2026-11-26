//! Finding ffmpeg/ffprobe — and, on Linux, installing them at the click of
//! a button when they aren't there.
//!
//! Everything in the app that touches audio/video goes through these two
//! tools: thumbnails (`video_preview.rs`) and recording (`capture.rs`).
//!
//! - **Windows/macOS**: they ship inside the installer — CronoStream's own
//!   LGPL build (see `tools/ffmpeg-build/`: no libx264, no ffmpeg AAC
//!   encoder; H.264/AAC come from the system's licensed encoders), placed
//!   next to the app's executable as Tauri sidecars.
//! - **Linux**: the distribution's ffmpeg, installed through its package
//!   manager behind `pkexec` (the graphical password prompt). It is built
//!   against the system's PulseAudio/PipeWire and V4L2, which is exactly
//!   what recording needs, and CronoStream doesn't distribute it.
//!
//! Lookup order: next to the executable first (the bundled copy, known to
//! be complete), then the usual system locations. The latter are searched
//! explicitly rather than left to `PATH`, because an app started from the
//! macOS Finder gets a minimal `PATH` without Homebrew's `/opt/homebrew/bin`.

use std::path::PathBuf;
use std::io::Read;
use std::process::Command;
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;

fn exe_name(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

fn search_dirs() -> Vec<PathBuf> {
    // Tauri puts sidecars next to the main executable — in the installed
    // app and in `tauri dev` (target/debug) alike.
    let mut dirs: Vec<PathBuf> = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .into_iter()
        .collect();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// Full path of `tool` ("ffmpeg"/"ffprobe"), if it can be found anywhere.
pub fn locate(tool: &str) -> Option<PathBuf> {
    let name = exe_name(tool);
    search_dirs().into_iter().map(|dir| dir.join(&name)).find(|path| path.is_file())
}

/// A `Command` for `tool`, ready to have arguments added. Falls back to the
/// bare name when the tool is nowhere to be found, so the caller still gets
/// the ordinary "could not be started" error rather than a special case.
///
/// On Windows the child gets no console window — without this, every
/// thumbnail and every recording would flash a black window open.
pub fn command(tool: &str) -> Command {
    let program = locate(tool).unwrap_or_else(|| PathBuf::from(exe_name(tool)));
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs `cmd` like `Command::output`, but gives up after `timeout`: the
/// child is killed and reaped, and the call fails with `TimedOut`. A file
/// on a hung network drive, a FIFO named `.mp4` or a pathological container
/// would otherwise hold a worker thread — and whatever lock its caller
/// holds — forever. Both pipes are drained on their own threads, so a
/// chatty child can never block on a full pipe meanwhile.
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                crate::trf!("nach {seconds} Sekunden ohne Ergebnis abgebrochen", seconds = timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    available: bool,
    /// "package" (Linux with a known package manager and pkexec),
    /// "manual" (other Linux setups) or "bundled" (Windows/macOS, where a
    /// missing ffmpeg means a damaged installation).
    install_method: &'static str,
    /// Linux only: the command the user can run themselves — shown for
    /// "manual", and as a fallback should the prompt be declined.
    manual_command: Option<String>,
}

/// The package manager command that installs ffmpeg, as program + args.
#[cfg(target_os = "linux")]
fn package_install_command() -> Option<Vec<&'static str>> {
    let has = |program: &str| search_dirs().iter().any(|dir| dir.join(program).is_file());
    if has("apt-get") {
        Some(vec!["apt-get", "install", "-y", "ffmpeg"])
    } else if has("dnf") {
        Some(vec!["dnf", "install", "-y", "ffmpeg"])
    } else if has("pacman") {
        Some(vec!["pacman", "-S", "--noconfirm", "ffmpeg"])
    } else if has("zypper") {
        Some(vec!["zypper", "--non-interactive", "install", "ffmpeg"])
    } else {
        None
    }
}

#[tauri::command(async)]
pub fn ffmpeg_status() -> FfmpegStatus {
    let available = locate("ffmpeg").is_some();

    #[cfg(target_os = "linux")]
    {
        let package = package_install_command();
        let has_pkexec = search_dirs().iter().any(|dir| dir.join("pkexec").is_file());
        FfmpegStatus {
            available,
            install_method: if package.is_some() && has_pkexec { "package" } else { "manual" },
            manual_command: Some(match package {
                Some(args) => format!("sudo {}", args.join(" ")),
                None => "sudo apt install ffmpeg".to_string(),
            }),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        FfmpegStatus { available, install_method: "bundled", manual_command: None }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum InstallProgress {
    /// The package manager is running (after the password prompt).
    Package,
}

/// Installs the distribution's ffmpeg (Linux only — elsewhere it ships
/// with the app). Async + `spawn_blocking`, since the package manager can
/// take a while and must not sit on the main thread.
#[tauri::command]
pub async fn install_ffmpeg(progress: Channel<InstallProgress>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(&progress))
        .await
        .map_err(|e| crate::trf!("Installation abgebrochen: {e}", e = e))??;

    if locate("ffmpeg").is_none() {
        return Err(crate::i18n::tr("ffmpeg wurde installiert, ist aber nicht auffindbar.").to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_blocking(progress: &Channel<InstallProgress>) -> Result<(), String> {
    let args = package_install_command().ok_or(crate::i18n::tr("Keine bekannte Paketverwaltung gefunden."))?;
    let _ = progress.send(InstallProgress::Package);
    let output = Command::new("pkexec")
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| crate::trf!("pkexec konnte nicht gestartet werden: {e}", e = e))?;
    match output.status.code() {
        Some(0) => Ok(()),
        // pkexec's own codes: the dialog was dismissed / not authorized.
        Some(126) | Some(127) => Err(crate::i18n::tr("Die Installation wurde abgebrochen (keine Berechtigung erteilt).").to_string()),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let last = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or_default();
            Err(crate::trf!("Die Paketverwaltung meldet einen Fehler: {last}", last = last))
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn install_blocking(_progress: &Channel<InstallProgress>) -> Result<(), String> {
    Err(crate::i18n::tr("ffmpeg gehört zur Installation von CronoStream – bitte CronoStream neu installieren.").to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_hanging_process_is_killed_after_the_timeout() {
        let started = Instant::now();
        let result = output_with_timeout(Command::new("sleep").arg("30"), Duration::from_millis(300));
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_quick_process_returns_its_output() {
        let output = output_with_timeout(Command::new("echo").arg("hallo"), Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hallo");
    }
}
