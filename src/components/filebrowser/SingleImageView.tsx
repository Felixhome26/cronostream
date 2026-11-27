import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../busy";
import { t, tn } from "../../i18n";
import { useFileDragOut } from "../../hooks/useFileDragOut";
import { useToast } from "../../ToastContext";
import RevealInFolderItems from "./RevealInFolderItems";
import SendToProjectItems from "./SendToProjectItems";
import type { DirEntryInfo, DirListing, FileDateInfo } from "../../types";
import type { PickedList } from "../../hooks/usePickedList";
import FinalReviewModal from "./FinalReviewModal";
import RotatedImage from "../RotatedImage";
import { canWebviewDecode, decodedOriginalUrl } from "../../utils/mediaServer";
import { isBrowserPeeking } from "../../utils/browserPeek";

// How many images ahead of and behind the current one to fetch in the
// background. Two in each direction covers normal paging speed without
// decoding a whole folder the user may never look at.
const PREFETCH_RADIUS = 2;
// Bookkeeping of which images are ready to show, capped and evicted
// least-recently-used. For the formats WebKit decodes itself the entries are
// just short URLs (the real memory is WebKit's own image cache, which it
// manages); only the Rust-rendition fallback still parks a base64 payload
// here, which is what the cap is sized for.
const IMAGE_CACHE_LIMIT = 16;
const LOW_RES_CACHE_LIMIT = 24;
// Background prefetches for neighbouring images never run more than one at
// a time. This mattered most when every prefetch was a full decode + SIMD
// resize + JPEG encode in Rust, directly stealing CPU from the image the
// user was waiting on; it still holds for the Rust fallback, and even for
// WebKit-decoded originals it keeps a fast scroll from having several
// multi-megabyte reads and decodes in flight at once. The image on screen is
// always fetched immediately, outside this queue, so it is never stuck
// behind prefetch work.
const PREFETCH_CONCURRENCY = 1;

const KEYS_HINT_DISMISSED_KEY = "cronostream.singleImageView.keysHintDismissed";
// Same versioning as the grid's hint (see `SELECTION_HINT_VERSION` there):
// the stored value is this version, so bumping it shows the hint once more.
// Bumped to 2 when it gained a close button alongside "don't show again".
const KEYS_HINT_VERSION = "2";

interface Props {
  onRevealInFolder?: (path: string) => void;
  listing: DirListing | null;
  picks: PickedList;
  addedPaths: Set<string>;
  onRotate: (path: string, delta: number) => void;
  onInserted: (insertedPaths: string[], message: string) => void;
  /// Forwarded straight to `FinalReviewModal` — see its own doc comment.
  onDuplicatesFound: (ids: string[]) => void;
  /// Which image to open on, if any — the one selected in the overview
  /// grid, so switching tabs continues with the picture already being
  /// looked at instead of jumping back to the start of the folder. Only
  /// read when this view mounts (it is unmounted on every tab switch);
  /// paging afterwards is this component's own business.
  initialPath?: string | null;
  /// Reports which image is on screen, so the overview grid can select and
  /// scroll to it when the user switches back — the mirror of
  /// `initialPath`. A plain path, not the entry: the caller already holds
  /// the listing.
  onCurrentChange?: (path: string | null) => void;
}

/// Full-window image browsing with keyboard control: arrow keys (or space /
/// backspace) page through the current folder's images, Enter marks the one
/// on screen for the review list. Images only — video, audio and documents
/// stay in the grid tab.
let keysHintShownThisSession = false;

export default function SingleImageView({
  listing,
  picks,
  addedPaths,
  onRotate,
  onInserted,
  onDuplicatesFound,
  initialPath,
  onCurrentChange,
  onRevealInFolder,
}: Props) {
  // Sorted chronologically (oldest first) rather than by filename, so
  // paging through this view matches the app's whole premise — a life
  // timeline — and so the neighbour-based prefetch below (which just walks
  // array positions) naturally warms images in date order too. Sorted by
  // filesystem date rather than EXIF: that data already comes for free with
  // the directory listing, whereas reading EXIF from every file up front
  // would slow down opening a large folder just to decide an order.
  const images: DirEntryInfo[] = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => !e.is_dir && e.kind === "image");
    return [...list].sort((a, b) => {
      const dateA = a.fs_created_at ?? a.fs_modified_at ?? "";
      const dateB = b.fs_created_at ?? b.fs_modified_at ?? "";
      return dateA.localeCompare(dateB);
    });
  }, [listing]);

  // Opens on the grid's selected image when there is one. Resolved lazily
  // on first render rather than in an effect, so the very first fetch is
  // already for the right picture instead of loading image 0 and then
  // immediately throwing it away.
  const [index, setIndex] = useState(() => {
    if (!initialPath) return 0;
    const found = images.findIndex((e) => e.path === initialPath);
    return found === -1 ? 0 : found;
  });
  const [src, setSrc] = useState<string | null>(null);
  const [lowResSrc, setLowResSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useToast();
  const [stageMenu, setStageMenu] = useState<{ x: number; y: number } | null>(null);
  const dragOut = useFileDragOut(images[index]?.path, {
    emoji: "🖼️",
    onError: () => showToast(t("timeline.dragFailed")),
  });

  // Caches live in refs: they're read inside event handlers and must not
  // trigger re-renders when a *background* prefetch lands — only the image
  // actually on screen updates state.
  const imageCache = useRef<Map<string, string>>(new Map());
  const lowResCache = useRef<Map<string, string>>(new Map());
  const dateInfoCache = useRef<Map<string, FileDateInfo>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // Throttles *background* full-resolution fetches to one at a time (see
  // PREFETCH_CONCURRENCY) — the image actually on screen is always fetched
  // directly, bypassing this queue entirely, so it's never waiting behind
  // prefetch work for images the user hasn't navigated to yet.
  const prefetchQueue = useRef<string[]>([]);
  const prefetchActive = useRef(0);
  // Guards against a slow fetch for an image the user has already paged
  // past overwriting what's currently displayed.
  const currentPath = useRef<string | null>(null);

  const folderPath = listing?.path ?? null;
  // This effect also runs on mount, where resetting to image 0 would undo
  // the `initialPath` the grid handed over. Only an actual *change* of
  // folder should send us back to the start.
  const seenFolder = useRef<string | null>(folderPath);

  useEffect(() => {
    if (seenFolder.current === folderPath) return;
    seenFolder.current = folderPath;
    setIndex(0);
    setSrc(null);
    setLowResSrc(null);
    imageCache.current.clear();
    lowResCache.current.clear();
    dateInfoCache.current.clear();
    inFlight.current.clear();
    prefetchQueue.current = [];
  }, [folderPath]);

  const readCache = useCallback((path: string): string | undefined => {
    const hit = imageCache.current.get(path);
    if (hit === undefined) return undefined;
    // Re-insert to mark as most recently used (Map keeps insertion order).
    imageCache.current.delete(path);
    imageCache.current.set(path, hit);
    return hit;
  }, []);

  const writeCache = useCallback((path: string, dataUrl: string) => {
    imageCache.current.set(path, dataUrl);
    while (imageCache.current.size > IMAGE_CACHE_LIMIT) {
      const oldest = imageCache.current.keys().next().value;
      if (oldest === undefined) break;
      imageCache.current.delete(oldest);
    }
  }, []);

  // The actual full-resolution fetch — used both for the image on screen
  // (called directly) and, via the queue below, for background neighbours.
  //
  // Normal photos are shown as the original file, decoded by WebKit itself
  // (see `decodedOriginalUrl`); only what WebKitGTK cannot decode — TIFF —
  // still has a rendition generated in Rust. Both resolve to a URL that is
  // ready to display, so everything downstream (cache, prefetch queue,
  // low-res placeholder) is unchanged either way.
  const fetchImage = useCallback(
    (path: string): Promise<string | null> => {
      const cached = readCache(path);
      if (cached) return Promise.resolve(cached);
      if (inFlight.current.has(path)) return Promise.resolve(null);
      inFlight.current.add(path);
      const pending = canWebviewDecode(path)
        ? decodedOriginalUrl(path)
        : invoke<string>("get_full_image_preview", { path });
      return pending
        .then((dataUrl) => {
          writeCache(path, dataUrl);
          return dataUrl;
        })
        .catch(() => null)
        .finally(() => {
          inFlight.current.delete(path);
        });
    },
    [readCache, writeCache],
  );

  const drainPrefetchQueue = useCallback(() => {
    while (prefetchActive.current < PREFETCH_CONCURRENCY && prefetchQueue.current.length > 0) {
      const path = prefetchQueue.current.shift()!;
      if (imageCache.current.has(path) || inFlight.current.has(path)) continue;
      prefetchActive.current++;
      fetchImage(path).finally(() => {
        prefetchActive.current--;
        drainPrefetchQueue();
      });
    }
  }, [fetchImage]);

  const queuePrefetch = useCallback(
    (path: string) => {
      if (imageCache.current.has(path) || inFlight.current.has(path) || prefetchQueue.current.includes(path)) return;
      prefetchQueue.current.push(path);
      drainPrefetchQueue();
    },
    [drainPrefetchQueue],
  );

  // A fast, often near-instant low-resolution rendition (reuses the browse
  // grid's preview pipeline, including its embedded-EXIF-thumbnail fast
  // path) shown immediately while the full-resolution version decodes, so
  // paging never just sits on a blank placeholder icon.
  const fetchLowRes = useCallback((path: string): Promise<string | null> => {
    const cached = lowResCache.current.get(path);
    if (cached) return Promise.resolve(cached);
    return invoke<string>("get_file_preview", { path })
      .then((dataUrl) => {
        lowResCache.current.set(path, dataUrl);
        while (lowResCache.current.size > LOW_RES_CACHE_LIMIT) {
          const oldest = lowResCache.current.keys().next().value;
          if (oldest === undefined) break;
          lowResCache.current.delete(oldest);
        }
        return dataUrl;
      })
      .catch(() => null);
  }, []);

  // Date candidates are prefetched alongside the images so pressing Enter
  // marks the picture instantly instead of waiting on an EXIF read.
  const fetchDateInfo = useCallback((path: string): Promise<FileDateInfo | null> => {
    const cached = dateInfoCache.current.get(path);
    if (cached) return Promise.resolve(cached);
    // Single path, prefetched silently — not worth registering with the
    // progress indicator, so the id is passed but never started.
    return invoke<FileDateInfo[]>("get_date_candidates", { paths: [path], operationId: crypto.randomUUID() })
      .then((result) => {
        const info = result[0] ?? null;
        if (info) dateInfoCache.current.set(path, info);
        return info;
      })
      .catch(() => null);
  }, []);

  // Load the image on screen (with priority, bypassing the prefetch queue),
  // then warm the neighbours in the background.
  useEffect(() => {
    const entry = images[index];
    if (!entry) {
      setSrc(null);
      setLowResSrc(null);
      return;
    }
    currentPath.current = entry.path;

    const cached = readCache(entry.path);
    if (cached) {
      setSrc(cached);
      setLowResSrc(null);
      setLoading(false);
    } else {
      setSrc(null);
      setLoading(true);
      // Low-res placeholder — not queued, so it's never delayed by prefetch.
      fetchLowRes(entry.path).then((dataUrl) => {
        if (currentPath.current !== entry.path || imageCache.current.has(entry.path)) return;
        if (dataUrl) setLowResSrc(dataUrl);
      });
      fetchImage(entry.path).then((dataUrl) => {
        if (currentPath.current !== entry.path) return; // user already paged on
        if (dataUrl) setSrc(dataUrl);
        setLoading(false);
      });
    }

    fetchDateInfo(entry.path);

    for (let offset = 1; offset <= PREFETCH_RADIUS; offset++) {
      const ahead = images[index + offset];
      const behind = images[index - offset];
      if (ahead) {
        queuePrefetch(ahead.path);
        fetchDateInfo(ahead.path);
      }
      if (behind) queuePrefetch(behind.path);
    }
    // `images` is derived fresh each render; folderPath/index identify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, folderPath, fetchImage, fetchLowRes, fetchDateInfo, queuePrefetch, readCache]);

  const keysHintShown = useRef(false);

  // One-time explainer for the keyboard layout, dismissible for good — the
  // same pattern (and the same wording of the dismiss action) the grid uses
  // for its click/mark split. Uses the global toast rather than this view's
  // own local one because only that one can carry an action button.
  useEffect(() => {
    // React's StrictMode runs every effect twice in development, which
    // showed this hint as two identical stacked toasts. A ref survives that
    // double-invoke (it is the same component instance), so the hint appears
    // once per mount either way.
    // Module-level, not per mount: this view remounts on every switch from
    // the overview, and the hint should appear once per app session.
    if (keysHintShown.current || keysHintShownThisSession) return;
    keysHintShown.current = true;
    keysHintShownThisSession = true;
    if (localStorage.getItem(KEYS_HINT_DISMISSED_KEY) === KEYS_HINT_VERSION) return;
    showToast(t("browser.singleView.keysHint"), {
      durationMs: 8000,
      action: {
        label: t("browser.dontShowAgain"),
        onClick: () => localStorage.setItem(KEYS_HINT_DISMISSED_KEY, KEYS_HINT_VERSION),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const toggleCurrent = useCallback(async () => {
    const entry = images[index];
    if (!entry) return;
    if (picks.has(entry.path)) {
      picks.remove(entry.path);
      return;
    }
    if (addedPaths.has(entry.path)) {
      setToast(t("browser.alreadyAddedToast"));
      return;
    }
    const info = await fetchDateInfo(entry.path);
    if (info) picks.toggle(info);
    else setToast(t("browser.singleView.markFailed"));
  }, [images, index, picks, addedPaths, fetchDateInfo]);

  // Window-level rather than element-focused: this view fills the browser
  // whenever it's mounted, and a window listener can't be defeated by focus
  // landing on the counter button. preventDefault stops space/backspace
  // from also scrolling or activating a focused button.
  //
  // The folder tree's path field lives in the same screen (the sidebar is
  // shared across tabs), so typing a path must not be hijacked by this
  // handler — anything originating from a text input/textarea is ignored.
  useEffect(() => {
    if (reviewOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (isBrowserPeeking()) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          setIndex((i) => Math.min(i + 1, Math.max(images.length - 1, 0)));
          break;
        case "ArrowLeft":
        case "Backspace":
          event.preventDefault();
          setIndex((i) => Math.max(i - 1, 0));
          break;
        // Space marks, matching the grid, where it has always been the
        // marking key. It used to page forward here, which is why the
        // preventDefault above and below matters: without it the key would
        // also scroll the view or re-trigger a focused button.
        case " ":
          event.preventDefault();
          toggleCurrent();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [images.length, toggleCurrent, reviewOpen]);

  const current = images[index];
  const isPicked = current ? picks.has(current.path) : false;
  const isAlreadyAdded = current ? addedPaths.has(current.path) : false;

  // Held in a ref so a caller that passes a fresh arrow function on every
  // render can't turn this into a report-on-every-render loop.
  const onCurrentChangeRef = useRef(onCurrentChange);
  onCurrentChangeRef.current = onCurrentChange;
  useEffect(() => {
    onCurrentChangeRef.current?.(current?.path ?? null);
  }, [current?.path]);

  return (
    <div className="single-view">
      {images.length === 0 ? (
        <div className="single-view__empty">{t("browser.singleView.noImages")}</div>
      ) : (
        <>
          <div
            className="single-view__stage"
            {...dragOut}
            onContextMenu={(ev) => {
              if (!current) return;
              ev.preventDefault();
              setStageMenu({ x: ev.clientX, y: ev.clientY });
            }}
          >
            {src ? (
              <RotatedImage
                src={src}
                alt={current?.name ?? ""}
                rotation={current?.rotation ?? 0}
                className="single-view__image"
              />
            ) : lowResSrc ? (
              // Shown while the full-resolution fetch is still in flight —
              // soft but recognizable, and far better than a blank icon.
              <img src={lowResSrc} alt={current?.name ?? ""} className="single-view__image single-view__image--loading" />
            ) : (
              <div className="single-view__placeholder">{loading ? t("browser.singleView.loading") : "🖼️"}</div>
            )}
            {isPicked && (
              <span className="single-view__marked" title={t("browser.singleView.marked")}>
                ✓
              </span>
            )}
            {/* Same information the grid tile carries as a badge: this file
                is already part of the stream, so marking it again does
                nothing (pressing Space on it only raises a toast). Worth
                stating up front here, where there is no row of neighbouring
                tiles to compare against. */}
            {isAlreadyAdded && <span className="single-view__added">{t("browser.added")}</span>}
          </div>

          {stageMenu && current && (
            <>
              <div className="file-browser__menu-scrim" onMouseDown={() => setStageMenu(null)} />
              <div className="context-menu" style={{ left: stageMenu.x, top: stageMenu.y }}>
                {onRevealInFolder && (
                  <RevealInFolderItems path={current.path} onDone={() => setStageMenu(null)} />
                )}
                <SendToProjectItems paths={[current.path]} onDone={() => setStageMenu(null)} />
              </div>
            </>
          )}

          <div className="single-view__bar">
            <button
              className="btn--text"
              onClick={() => setIndex((i) => Math.max(i - 1, 0))}
              disabled={index === 0}
            >
              ←
            </button>
            <div className="single-view__caption" title={current?.path}>
              <span className="single-view__filename">{current?.name}</span>
              <span className="single-view__counter">
                {index + 1} / {images.length}
              </span>
            </div>
            <button
              className="btn--text"
              onClick={() => setIndex((i) => Math.min(i + 1, images.length - 1))}
              disabled={index >= images.length - 1}
            >
              →
            </button>
            {current && (
              <div className="single-view__rotate">
                <button className="icon-btn" title={t("browser.rotateLeft")} onClick={() => onRotate(current.path, -90)}>
                  ↺
                </button>
                <button className="icon-btn" title={t("browser.rotateRight")} onClick={() => onRotate(current.path, 90)}>
                  ↻
                </button>
                <button className="icon-btn" title={t("browser.rotate180")} onClick={() => onRotate(current.path, 180)}>
                  ⟲
                </button>
              </div>
            )}
            <button className="btn" onClick={toggleCurrent}>
              {isPicked ? t("browser.singleView.unmark") : t("browser.singleView.mark")}
            </button>
            {picks.count > 0 && (
              <>
                <span className="single-view__count">
                  {tn(picks.count, "browser.singleView.pickedBadge")}
                </span>
                <button className="btn btn--primary" onClick={() => setReviewOpen(true)}>
                  {t("browser.insertButton")}
                </button>
              </>
            )}
          </div>

          <div className="single-view__help">{t("browser.singleView.help")}</div>
        </>
      )}

      {reviewOpen && (
        <FinalReviewModal
          items={[...picks.picked.values()]}
          onClose={() => setReviewOpen(false)}
          onInserted={(insertedPaths, message) => {
            insertedPaths.forEach((p) => picks.remove(p));
            onInserted(insertedPaths, message);
            if (picks.count - insertedPaths.length <= 0) setReviewOpen(false);
          }}
          onDuplicatesFound={onDuplicatesFound}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
