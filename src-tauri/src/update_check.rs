//! The update notice: asks felixheck.de whether a newer version exists.
//!
//! Notification only. Nothing is downloaded or installed; the frontend shows
//! a hint that opens the download page. What goes over the wire is a plain
//! GET for one static file — no parameters, no version, no identifier, and
//! the user agent is just "CronoStream". The comparison happens here, so the
//! server learns nothing beyond "someone fetched latest.json" (and the IP
//! address that comes with any request). The website's privacy policy says
//! exactly that; keep both in step.
//!
//! The command fails for any reason (offline, DNS, timeout, bad answer) and
//! the caller treats every failure as "no news" without showing anything;
//! only the manual check in settings reports it.

use std::time::Duration;

use serde::Deserialize;

/// The one file the check reads: `{ "version": "0.1.0" }`. HTTPS only, no
/// redirects. Lives on the own server, so no third party sees it.
const LATEST_URL: &str = "https://felixheck.de/cronostream/latest.json";

/// Short enough that a dead connection never keeps a background thread
/// around for long, long enough for a slow one.
const TIMEOUT: Duration = Duration::from_secs(8);

/// The answer is a few bytes; anything bigger is not ours.
const MAX_BODY: u64 = 4096;

#[derive(Deserialize)]
struct Latest {
    version: String,
}

/// "1.2.3", "v1.2.3" or "1.2.3-beta.1" as numbers; a missing part counts as 0.
/// A pre-release suffix is ignored, so "0.2.0-beta" is taken as 0.2.0.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    let patch = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_newer(remote: &str, current: &str) -> bool {
    match (parse_version(remote), parse_version(current)) {
        (Some(remote), Some(current)) => remote > current,
        _ => false,
    }
}

fn fetch_latest() -> Result<String, String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .user_agent("CronoStream")
        .https_only(true)
        .max_redirects(0)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent.get(LATEST_URL).call().map_err(|e| e.to_string())?;
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let latest: Latest = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(latest.version)
}

/// The newer version's number, or `None` when this one is current. An error
/// means "could not find out", never "there is a problem".
#[tauri::command(async)]
pub fn check_for_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let remote = fetch_latest()?;
    let current = app.package_info().version.to_string();
    Ok(is_newer(&remote, &current).then_some(remote))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("v0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("0.2"), Some((0, 2, 0)));
        assert_eq!(parse_version("0.2.0-beta.1"), Some((0, 2, 0)));
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn compares_numerically_not_as_text() {
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        // An unreadable answer is never a reason to announce anything.
        assert!(!is_newer("kaputt", "0.1.0"));
        assert!(!is_newer("0.2.0", "kaputt"));
    }
}
