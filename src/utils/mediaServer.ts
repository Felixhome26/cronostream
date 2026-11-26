import { invoke } from "../busy";

interface MediaServerInfo {
  port: number;
  token: string;
}

let infoPromise: Promise<MediaServerInfo> | null = null;

function getInfo(): Promise<MediaServerInfo> {
  if (!infoPromise) infoPromise = invoke<MediaServerInfo>("get_media_server_info");
  return infoPromise;
}

// Builds a playable http://127.0.0.1 URL for a local file path, served by
// CronoStream's own loopback media server (src-tauri/src/media_server.rs) —
// needed because WebKitGTK's GStreamer-based <audio>/<video> playback
// doesn't reliably accept Tauri's `asset://` custom protocol as a media
// source, even though the same protocol works fine for images.
export async function mediaUrl(path: string): Promise<string> {
  const { port, token } = await getInfo();
  return `http://127.0.0.1:${port}/file?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
}

/// Loads the server's connection details once, so callers that need to
/// build many URLs at once (the timeline's thumbnails) can do it
/// synchronously instead of awaiting per file.
export function loadMediaServerInfo(): Promise<MediaServerInfo> {
  return getInfo();
}

/// Same URL as `mediaUrl`, built from already-loaded server info.
///
/// This is what makes a project with hundreds of files open quickly: the
/// thumbnails become ordinary `<img src>` URLs that WebKit fetches itself,
/// in parallel and on its own schedule, instead of each one being read,
/// base64-encoded and shipped across the IPC bridge as a data: URL. Measured
/// on a 447-item project: 438 thumbnails took ~8.5s the old way.
export function fileUrl(info: MediaServerInfo, path: string): string {
  return `http://127.0.0.1:${info.port}/file?token=${encodeURIComponent(info.token)}&path=${encodeURIComponent(path)}`;
}

/// Image formats WebKit decodes itself, and which can therefore be shown
/// straight from the original file. TIFF is deliberately absent even though
/// CronoStream counts it as an image everywhere else: WebKitGTK ships no TIFF
/// decoder, so those files still need a rendition generated in Rust.
const WEBVIEW_DECODABLE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);

export function canWebviewDecode(path: string): boolean {
  return WEBVIEW_DECODABLE_EXTS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

/// The original file's URL, resolved only once WebKit has actually decoded
/// it — so a caller can swap it in exactly like the Rust-generated rendition
/// it replaces, without a blank frame in between.
///
/// Letting WebKit decode and scale the original (libjpeg-turbo, GPU scaling)
/// is what makes this near-instant where decoding, resizing, JPEG-encoding
/// and base64-ing a 24 MP photo in Rust took seconds — the same reason
/// `fileUrl` above exists for the timeline's thumbnails. It is also *not*
/// the experiment warned about in `preview.rs`: that one handed the webview
/// dozens of multi-MB originals at once, as base64 data URLs, one per grid
/// tile. This is one image, over HTTP, for the view in front of the user.
export function decodedOriginalUrl(path: string): Promise<string> {
  return mediaUrl(path).then(
    (url) =>
      new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => reject(new Error(`Konnte ${path} nicht laden`));
        img.src = url;
      }),
  );
}

export type { MediaServerInfo };
