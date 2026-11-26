// Loopback-only HTTP server used to stream audio (and, later, video) into
// the webview.
//
// Why this exists instead of Tauri's built-in `asset://` custom protocol:
// WebKitGTK's `<audio>`/`<video>` elements are backed by a GStreamer
// `playbin` pipeline, which doesn't reliably accept an app-registered
// custom URI scheme as a playable media source — even though the exact
// same `asset://` protocol works fine for images and other generic
// resource loads (those go through WebKit's normal resource loader, not
// through GStreamer). Serving over real HTTP, even on loopback, sidesteps
// this entirely: GStreamer's `souphttpsrc` understands plain http(s)
// natively, which is exactly how this was confirmed — `gst-launch-1.0`
// decodes the same file perfectly via `filesrc`, but playback inside the
// webview only started working once it was served this way.
//
// Bound to 127.0.0.1 only (never 0.0.0.0) and gated by a random token
// generated fresh per app launch, so another local process/browser tab
// can't guess the port and read arbitrary files even though the HTTP
// server itself has no other authentication.
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tiny_http::{Header, Response, Server};

use crate::timeline_commands::mime_for;

/// How many browsed folders stay playable at once. Not 1: the browse-time
/// audio preview keeps requesting byte ranges while it plays, and the user
/// is free to navigate on in the file dialog meanwhile — replacing the
/// grant on every `list_directory` would cut playback off mid-track. A
/// handful covers that without the list growing for the whole session.
const MAX_BROWSE_DIRS: usize = 8;

/// Larger WAVs are served untouched rather than decoded into memory.
const MAX_ADPCM_BYTES: u64 = 256 * 1024 * 1024;

trait MediaSource: Read + Seek + Send {}
impl<T: Read + Seek + Send> MediaSource for T {}

/// How much of a WAV is read to find its format tag. The `fmt ` chunk sits
/// right after the RIFF header in practice; only a file with a very long
/// chunk in front of it needs the whole read.
const WAV_HEAD_BYTES: usize = 64 * 1024;

/// Converted PCM up to this size is kept for the requests that follow — a
/// player asks for many ranges of one file. Larger results are converted
/// per request, as before, rather than pinned in memory.
const MAX_CACHED_PCM_BYTES: usize = 128 * 1024 * 1024;

/// The last converted ADPCM file, keyed by path, size and modification
/// time, so an edited or replaced file is converted afresh.
struct CachedPcm {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    pcm: Arc<Vec<u8>>,
}

static PCM_CACHE: Mutex<Option<CachedPcm>> = Mutex::new(None);

/// Shared converted bytes as a `Cursor` source.
struct SharedBytes(Arc<Vec<u8>>);

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// The PCM version of an IMA-ADPCM WAV, or `None` when the file is
/// anything else and should be served as it is. Only the start of the file
/// is read for that decision.
fn adpcm_as_pcm(path: &Path, file: &mut File, metadata: &std::fs::Metadata) -> std::io::Result<Option<Arc<Vec<u8>>>> {
    let len = metadata.len();
    let modified = metadata.modified().ok();
    if let Ok(cache) = PCM_CACHE.lock() {
        if let Some(cached) = cache.as_ref().filter(|c| c.path == path && c.len == len && c.modified == modified) {
            return Ok(Some(cached.pcm.clone()));
        }
    }

    let mut head = Vec::with_capacity(WAV_HEAD_BYTES);
    file.by_ref().take(WAV_HEAD_BYTES as u64).read_to_end(&mut head)?;
    let decided = crate::adpcm_wav::is_ima_adpcm(&head);
    if decided == Some(false) {
        file.seek(SeekFrom::Start(0))?;
        return Ok(None);
    }

    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes)?;
    file.seek(SeekFrom::Start(0))?;
    let Some(pcm) = crate::adpcm_wav::to_pcm_wav(&bytes) else { return Ok(None) };
    let pcm = Arc::new(pcm);
    if pcm.len() <= MAX_CACHED_PCM_BYTES {
        if let Ok(mut cache) = PCM_CACHE.lock() {
            *cache = Some(CachedPcm { path: path.to_path_buf(), len, modified, pcm: pcm.clone() });
        }
    }
    Ok(Some(pcm))
}

#[derive(Default)]
struct Scope {
    dirs: Vec<(PathBuf, bool)>,
}

impl Scope {
    /// `dir` must already be canonical — see `MediaServerHandle::allow_dir`.
    fn allow_dir(&mut self, dir: PathBuf, recursive: bool) {
        // Re-granting the same folder moves it to the back rather than
        // adding a second copy: `list_directory` grants on every single
        // navigation, so without this the list grew without bound (and
        // `is_allowed` scanned all of it per request).
        self.dirs.retain(|(existing, existing_recursive)| !(*existing == dir && *existing_recursive == recursive));
        self.dirs.push((dir, recursive));

        let mut excess = self.dirs.iter().filter(|(_, recursive)| !*recursive).count().saturating_sub(MAX_BROWSE_DIRS);
        if excess > 0 {
            // `retain` walks front to back, i.e. oldest first.
            self.dirs.retain(|(_, recursive)| {
                if *recursive || excess == 0 {
                    return true;
                }
                excess -= 1;
                false
            });
        }
    }

    /// Takes a folder's grant back — used when a project is closed or
    /// switched away from. Without it a project's recursive grant outlived
    /// the project being open, for the whole run of the app.
    fn revoke_dir(&mut self, dir: &Path) {
        self.dirs.retain(|(existing, _)| existing != dir);
    }

    /// `path` must already be canonical — see `resolve_allowed`.
    fn is_allowed(&self, path: &Path) -> bool {
        self.dirs.iter().any(|(dir, recursive)| {
            if *recursive {
                path.starts_with(dir)
            } else {
                path.parent() == Some(dir.as_path())
            }
        })
    }
}

/// Turns a requested path into one that is safe to serve, or `None`.
///
/// Canonicalizing FIRST is the whole point. `Path::starts_with` compares
/// path components, so `/projekt/../../etc/shadow` "starts with"
/// `/projekt` and passed the recursive check — while the OS then happily
/// opened `/etc/shadow`, because it resolves `..` itself. Resolving the
/// path up front means the check and the open see the same file.
fn resolve_allowed(scope: &Mutex<Scope>, raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw).canonicalize().ok()?;
    let allowed = scope.lock().map(|scope| scope.is_allowed(&path)).unwrap_or(false);
    if allowed {
        Some(path)
    } else {
        None
    }
}

pub struct MediaServerHandle {
    port: u16,
    token: String,
    scope: Arc<Mutex<Scope>>,
}

impl MediaServerHandle {
    /// Grants the media server read access to `dir` (and, if `recursive`,
    /// everything under it) — same two call sites as the rest of the app's
    /// file-access scoping: the currently open project (recursive) and
    /// whatever folder the file-insert dialog is currently browsing
    /// (non-recursive, for the browse-time audio preview).
    ///
    /// Stored canonicalized, so a grant still matches when the requested
    /// path arrives spelled differently (a symlinked project folder, a
    /// `..` in the middle) — `resolve_allowed` canonicalizes the request
    /// for the same reason, and both sides have to agree.
    pub fn allow_dir(&self, dir: &Path, recursive: bool) {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if let Ok(mut scope) = self.scope.lock() {
            scope.allow_dir(dir, recursive);
        }
    }

    /// `raw` canonicalized, if the server would serve it — for commands
    /// that act on a file on the player's behalf (`playback_compat`).
    pub fn resolve(&self, raw: &str) -> Option<PathBuf> {
        resolve_allowed(&self.scope, raw)
    }

    /// Revokes a grant made by `allow_dir` — called when a project is
    /// closed or switched away from, so its files stop being servable the
    /// moment it is no longer the open project.
    pub fn revoke_dir(&self, dir: &Path) {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if let Ok(mut scope) = self.scope.lock() {
            scope.revoke_dir(&dir);
        }
    }
}

#[derive(Serialize)]
pub struct MediaServerInfo {
    port: u16,
    token: String,
}

#[tauri::command(async)]
pub fn get_media_server_info(handle: tauri::State<MediaServerHandle>) -> MediaServerInfo {
    MediaServerInfo {
        port: handle.port,
        token: handle.token.clone(),
    }
}

/// Starts the server on a random free port and spawns its accept loop onto
/// a dedicated OS thread (plain blocking I/O — no tokio dependency needed
/// for a handful of concurrent local range requests).
pub fn start() -> MediaServerHandle {
    let server = Server::http((Ipv4Addr::LOCALHOST, 0)).expect("Konnte lokalen Medien-Server nicht starten");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => panic!("erwartete eine IP-Adresse für den lokalen Medien-Server"),
    };
    let token = uuid::Uuid::new_v4().to_string();
    let scope = Arc::new(Mutex::new(Scope::default()));

    let handle = MediaServerHandle { port, token, scope };
    let token_for_loop = handle.token.clone();
    let scope_for_loop = Arc::clone(&handle.scope);

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let token = token_for_loop.clone();
            let scope = Arc::clone(&scope_for_loop);
            std::thread::spawn(move || {
                let _ = handle_request(request, &token, &scope);
            });
        }
    });

    handle
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.to_string(), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses a single-range `Range: bytes=<start>-<end>` header (the only form
/// media playback actually sends in practice) into an inclusive byte range
/// clamped to the file length. Returns `None` for anything unsatisfiable.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;

    if start_str.is_empty() {
        // Suffix range: "-500" means "last 500 bytes".
        let suffix_len: u64 = end_str.parse().ok()?;
        if suffix_len == 0 || len == 0 {
            return None;
        }
        let start = len.saturating_sub(suffix_len);
        return Some((start, len - 1));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= len {
        return None;
    }
    let end: u64 = if end_str.is_empty() {
        len - 1
    } else {
        end_str.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn http_date(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time)
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

fn handle_request(
    request: tiny_http::Request,
    token: &str,
    scope: &Arc<Mutex<Scope>>,
) -> std::io::Result<()> {
    let url = request.url().to_string();
    let (route, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    if route != "/file" {
        return request.respond(Response::empty(404));
    }

    let params = parse_query(query);

    if params.get("token").map(String::as_str) != Some(token) {
        return request.respond(Response::empty(403));
    }

    let Some(raw_path) = params.get("path") else {
        return request.respond(Response::empty(400));
    };
    let Some(path) = resolve_allowed(scope, raw_path) else {
        // One answer for "outside the scope" and "no such file": the
        // difference is of no use to a caller that is allowed neither.
        return request.respond(Response::empty(403));
    };
    // The converted copy made by `prepare_playback_copy`, looked up from the
    // original so it is served under the original's scope check.
    let path = match params.get("compat").map(String::as_str) {
        Some(kind) => match crate::playback_compat::cached_path(&path, kind == "video") {
            Some(copy) => copy,
            None => return request.respond(Response::empty(404)),
        },
        None => path,
    };

    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return request.respond(Response::empty(404)),
    };
    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return request.respond(Response::empty(500)),
    };
    let mut len = metadata.len();
    let mime = mime_for(&path);

    // Old IMA-ADPCM WAVs (dictation recorders) aren't decodable by the
    // webview's GStreamer; serve them as plain PCM, converted in memory.
    let is_wav = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("wav"));
    let mut source: Box<dyn MediaSource> = if is_wav && len <= MAX_ADPCM_BYTES {
        match adpcm_as_pcm(&path, &mut file, &metadata) {
            Ok(Some(pcm)) => {
                len = pcm.len() as u64;
                Box::new(std::io::Cursor::new(SharedBytes(pcm)))
            }
            Ok(None) => Box::new(file),
            Err(_) => return request.respond(Response::empty(500)),
        }
    } else {
        Box::new(file)
    };

    let content_type_header =
        Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).expect("gültiger Header-Wert");
    let accept_ranges_header =
        Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).expect("gültiger Header-Wert");

    // Without any freshness information WebKit has to go back to the network
    // for every new element pointing at a URL it has already fetched. For the
    // timeline that is not a rare event: a wheel-zoom tick re-decides which
    // tiles are mounted (their track positions all move), so tiles are torn
    // down and rebuilt constantly, and each rebuilt <img> re-requested its
    // thumbnail from this server and decoded it again — measured as the
    // tiles visibly blanking and reappearing on every single tick.
    //
    // Deliberately a moderate max-age rather than `immutable`: a thumbnail
    // CAN be rewritten at the same path (regenerate_video_thumbnails, and
    // restoring an item regenerates a missing one), so an indefinite cache
    // would pin a stale image. Ten minutes outlives any zoom session while
    // still healing itself shortly after a regeneration. Last-Modified rides
    // along so that the revalidation after it expires is a cheap 304 instead
    // of another full transfer.
    let cache_control_header =
        Header::from_bytes(&b"Cache-Control"[..], &b"private, max-age=600"[..]).expect("gültiger Header-Wert");
    // RFC 7231 IMF-fixdate, spelled out through chrono (already a direct
    // dependency) rather than pulling in httpdate, which is only present
    // transitively. Always GMT, always English day/month abbreviations — the
    // format is fixed by the spec, so `Utc` and the literal pattern are the
    // point, not a locale choice.
    let last_modified = metadata.modified().ok().map(http_date);
    let last_modified_header = last_modified
        .as_deref()
        .and_then(|s| Header::from_bytes(&b"Last-Modified"[..], s.as_bytes()).ok());

    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    if let Some(range) = range_header {
        match parse_range(&range, len) {
            Some((start, end)) => {
                let n = end - start + 1;
                source.seek(SeekFrom::Start(start))?;

                let content_range = Header::from_bytes(
                    &b"Content-Range"[..],
                    format!("bytes {start}-{end}/{len}").into_bytes(),
                )
                .expect("gültiger Header-Wert");

                // Streamed from the file, not read into a buffer first. A
                // player asks for "from here to the end" (`bytes=N-`) all
                // the time, and for an MP4 whose index sits at the end of
                // the file it does so repeatedly while it jumps between
                // the end and the start: buffering each of those meant
                // allocating and reading up to the whole video (100+ MB)
                // before the first byte went out — stalls, and memory
                // pressure that made playback stutter. A reader with a
                // known length costs the same few KB however big the
                // range is.
                //
                // The Content-Length matters: WebKitGTK's media pipeline
                // requires it to treat a ranged, byte-addressable source as
                // seekable video (without it every file over ~32KB was
                // rejected as an unsupported source).
                let mut headers = vec![content_type_header, accept_ranges_header, content_range, cache_control_header];
                if let Some(h) = last_modified_header {
                    headers.push(h);
                }
                let response = Response::new(
                    tiny_http::StatusCode(206),
                    headers,
                    std::io::BufReader::with_capacity(256 * 1024, source.take(n)),
                    Some(n as usize),
                    None,
                )
                // tiny_http switches to chunked encoding (no Content-Length)
                // for bodies >= 32KB unless told otherwise — see above.
                .with_chunked_threshold(usize::MAX);
                return request.respond(response);
            }
            None => {
                let content_range = Header::from_bytes(
                    &b"Content-Range"[..],
                    format!("bytes */{len}").into_bytes(),
                )
                .expect("gültiger Header-Wert");
                let response = Response::empty(416).with_header(content_range);
                return request.respond(response);
            }
        }
    }

    // The other half of the Last-Modified above: WebKit echoes the date back
    // once max-age has run out, and an unchanged file then costs a header
    // instead of reading and decoding the whole image again. Compared for
    // equality, not "not newer": a thumbnail restored from a backup can carry
    // an older date and still be different from the cached one. Requests with
    // a Range never get here — playback is left out of this on purpose.
    let revalidated_date = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("If-Modified-Since"))
        .map(|h| h.value.as_str());
    let unchanged = revalidated_date.is_some() && revalidated_date == last_modified.as_deref();
    if unchanged {
        let mut response = Response::empty(304).with_header(cache_control_header);
        if let Some(h) = last_modified_header {
            response.add_header(h);
        }
        return request.respond(response);
    }

    let mut response = Response::new(tiny_http::StatusCode(200), Vec::new(), source, Some(len as usize), None)
        .with_header(content_type_header)
        .with_header(accept_ranges_header)
        .with_header(cache_control_header)
        .with_chunked_threshold(usize::MAX);
    if let Some(h) = last_modified_header {
        response.add_header(h);
    }
    request.respond(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real folder with a real file in it — `resolve_allowed`
    /// canonicalizes, which only works against paths that exist.
    fn scratch() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("cronostream-media-{}", uuid::Uuid::new_v4()))
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir().join(format!("cronostream-media-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ton.mp3");
        std::fs::write(&file, b"nicht wirklich audio").unwrap();
        (dir.canonicalize().unwrap(), file)
    }

    fn scope_with(dir: &Path, recursive: bool) -> Mutex<Scope> {
        let mut scope = Scope::default();
        scope.allow_dir(dir.canonicalize().unwrap(), recursive);
        Mutex::new(scope)
    }

    #[test]
    fn a_file_in_a_granted_folder_is_served() {
        let (dir, file) = scratch();
        let scope = scope_with(&dir, true);
        assert!(resolve_allowed(&scope, &file.to_string_lossy()).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The hole this check closes: `Path::starts_with` compares components,
    /// so a path that walks back out of the granted folder with `..` still
    /// "starts with" it — while the OS resolves the `..` and opens whatever
    /// is really at the end of it.
    #[test]
    fn a_traversal_out_of_the_granted_folder_is_refused() {
        let (dir, _) = scratch();
        let scope = scope_with(&dir, true);

        let escaped = dir.join("..").join("..").join("..").join("etc").join("hostname");
        assert!(
            escaped.starts_with(&dir),
            "precondition: the unresolved path does pass a plain starts_with test"
        );
        assert!(
            resolve_allowed(&scope, &escaped.to_string_lossy()).is_none(),
            "resolving it first is what refuses it"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `..` that stays inside the granted folder is fine — the point is
    /// where the path lands, not how it is spelled.
    #[test]
    fn a_roundabout_spelling_inside_the_folder_still_works() {
        let (dir, file) = scratch();
        std::fs::create_dir_all(dir.join("unterordner")).unwrap();
        let scope = scope_with(&dir, true);

        let roundabout = dir.join("unterordner").join("..").join("ton.mp3");
        let resolved = resolve_allowed(&scope, &roundabout.to_string_lossy());
        assert_eq!(resolved.as_deref(), Some(file.as_path()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_revoked_folder_stops_being_served() {
        let (dir, file) = scratch();
        let scope = scope_with(&dir, true);
        assert!(resolve_allowed(&scope, &file.to_string_lossy()).is_some());

        scope.lock().unwrap().revoke_dir(&dir);
        assert!(resolve_allowed(&scope, &file.to_string_lossy()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn re_granting_the_same_folder_does_not_grow_the_list() {
        let mut scope = Scope::default();
        for _ in 0..50 {
            scope.allow_dir(PathBuf::from("/tmp/immer-derselbe"), false);
        }
        assert_eq!(scope.dirs.len(), 1);
    }

    /// Browse grants are capped, but the project's own recursive grant is
    /// never one of the ones pushed out.
    #[test]
    fn browse_grants_are_capped_and_never_evict_the_project() {
        let mut scope = Scope::default();
        scope.allow_dir(PathBuf::from("/projekt"), true);
        for n in 0..(MAX_BROWSE_DIRS + 5) {
            scope.allow_dir(PathBuf::from(format!("/durchsucht/{n}")), false);
        }

        assert_eq!(scope.dirs.iter().filter(|(_, recursive)| !*recursive).count(), MAX_BROWSE_DIRS);
        assert!(scope.is_allowed(Path::new("/projekt/originals/2024/06/foto.jpg")));
        // The newest browse folders survived, the oldest dropped off.
        assert!(scope.is_allowed(Path::new(&format!("/durchsucht/{}/ton.mp3", MAX_BROWSE_DIRS + 4))));
        assert!(!scope.is_allowed(Path::new("/durchsucht/0/ton.mp3")));
    }

    /// Sends one raw HTTP request to the running server and returns the
    /// status line, the lower-cased headers and the body.
    fn http_get(port: u16, token: &str, path: &Path, range: Option<&str>) -> (String, String, Vec<u8>) {
        let range = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        http_get_with_headers(port, token, path, &range)
    }

    fn http_get_with_headers(port: u16, token: &str, path: &Path, headers: &str) -> (String, String, Vec<u8>) {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(
            stream,
            "GET /file?token={token}&path={} HTTP/1.1\r\nHost: localhost\r\n{headers}Connection: close\r\n\r\n",
            path.to_string_lossy().replace(' ', "%20")
        )
        .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let (status, headers) = head.split_once("\r\n").unwrap_or((head.as_str(), ""));
        (status.to_string(), headers.to_lowercase(), raw[split + 4..].to_vec())
    }

    /// An unchanged file answers a revalidation with an empty 304; any other
    /// date gets the whole file, and a Range is served as usual either way.
    #[test]
    fn revalidating_an_unchanged_file_gets_a_304() {
        let (dir, file) = scratch();
        let handle = start();
        handle.allow_dir(&dir, true);
        let date = http_date(std::fs::metadata(&file).unwrap().modified().unwrap());

        let unchanged = format!("If-Modified-Since: {date}\r\n");
        let (status, _, body) = http_get_with_headers(handle.port, &handle.token, &file, &unchanged);
        assert!(status.contains("304"), "{status}");
        assert!(body.is_empty());

        let other = "If-Modified-Since: Mon, 01 Jan 2001 00:00:00 GMT\r\n";
        let (status, _, body) = http_get_with_headers(handle.port, &handle.token, &file, other);
        assert!(status.contains("200"), "{status}");
        assert!(!body.is_empty());

        let ranged = format!("{unchanged}Range: bytes=0-3\r\n");
        let (status, _, body) = http_get_with_headers(handle.port, &handle.token, &file, &ranged);
        assert!(status.contains("206"), "{status}");
        assert_eq!(body.len(), 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Ranged requests — including the open-ended `bytes=N-` a player sends
    /// when it jumps around an MP4 whose index is at the end — must come back
    /// as 206 with the right bytes and a Content-Length (not chunked).
    #[test]
    fn ranged_requests_are_streamed_with_the_right_bytes() {
        let (dir, _) = scratch();
        let file = dir.join("video.mp4");
        let data: Vec<u8> = (0..20_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();

        let handle = start();
        handle.allow_dir(&dir, true);

        for (range, from, to) in [
            ("bytes=0-", 0usize, data.len() - 1),
            ("bytes=19999000-", 19_999_000, data.len() - 1),
            ("bytes=1000-1999", 1000, 1999),
            ("bytes=-500", data.len() - 500, data.len() - 1),
        ] {
            let (status, headers, body) = http_get(handle.port, &handle.token, &file, Some(range));
            assert!(status.contains("206"), "{range}: {status}");
            assert!(headers.contains(&format!("content-length: {}", to - from + 1)), "{range}: {headers}");
            assert!(headers.contains(&format!("content-range: bytes {from}-{to}/{}", data.len())), "{range}: {headers}");
            assert!(!headers.contains("chunked"), "{range}: {headers}");
            assert_eq!(body.len(), to - from + 1, "{range}");
            assert_eq!(body[..], data[from..=to], "{range}");
        }

        let (status, _, body) = http_get(handle.port, &handle.token, &file, None);
        assert!(status.contains("200"), "{status}");
        assert_eq!(body.len(), data.len());

        let (status, _, _) = http_get(handle.port, &handle.token, &file, Some("bytes=30000000-"));
        assert!(status.contains("416"), "{status}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
