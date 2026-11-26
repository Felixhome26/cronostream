import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { invoke } from "@tauri-apps/api/core";

/// How often a failed thumbnail is fetched again before the tile gives up.
const MAX_RETRIES = 2;
/// Wait before each retry, multiplied by the attempt number.
const RETRY_DELAY_MS = 400;

/// Per thumbnail URL, the retry that finally got used. Module-wide on
/// purpose: once WebKit has a failed load for a URL it keeps showing it for
/// every new <img> with that URL — the tile, the year cluster, the tile
/// again after reopening the stream — so every later element has to ask
/// for the retried URL straight away instead of starting from the broken one.
const attemptByUrl = new Map<string, number>();

function withAttempt(url: string, attempt: number): string {
  return attempt === 0 ? url : `${url}&retry=${attempt}`;
}

function describe(url: string): string {
  try {
    return new URL(url).searchParams.get("path") ?? url;
  } catch {
    return url;
  }
}

/// A timeline thumbnail that heals a failed load by itself.
///
/// In 2 of 6 runs of the automated walk-through (15.11.) single tiles stayed
/// blank after an import — in the timeline, in the year cluster and after
/// reopening the stream — although their thumbnails were complete on disk.
/// The cause could not be pinned down; what the screenshots show is a failed
/// <img> load (an empty frame instead of the 🎬/placeholder icon) that WebKit
/// then kept for that URL. This retries with a fresh URL, which forces a new
/// request and decode, and writes each failure to debug.log so a next
/// occurrence leaves a trace.
export default function ThumbImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [state, setState] = useState(() => ({ src, attempt: attemptByUrl.get(src) ?? 0 }));
  const attempt = state.src === src ? state.attempt : (attemptByUrl.get(src) ?? 0);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  function handleError() {
    invoke("debug_log", {
      message: `thumb-load-failed (attempt ${attempt}/${MAX_RETRIES}): ${describe(src)}`,
    }).catch(() => {});
    if (attempt >= MAX_RETRIES || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const next = Math.max(attempt + 1, attemptByUrl.get(src) ?? 0);
      attemptByUrl.set(src, next);
      setState({ src, attempt: next });
    }, RETRY_DELAY_MS * (attempt + 1));
  }

  return <img {...rest} src={withAttempt(src, attempt)} onError={handleError} />;
}
