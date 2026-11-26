import { invoke } from "@tauri-apps/api/core";

/// Update notice (backend: src-tauri/src/update_check.rs). Notification only:
/// the app learns whether a newer version exists and points to the download
/// page; nothing is fetched or installed.
///
/// Kept off `busy.tsx`'s invoke on purpose: a background check must never
/// light up the app-wide spinner.

/// Where the hint leads. Fixed in the app: the server's answer only ever
/// supplies a version number, never an address to open.
export const DOWNLOAD_URL = "https://felixheck.de/cronostream/#download";

const AUTO_KEY = "cronostream.updates.auto";
const LAST_CHECK_KEY = "cronostream.updates.lastCheck";
const ANNOUNCED_KEY = "cronostream.updates.announced";
const DAY_MS = 24 * 60 * 60 * 1000;

/// On unless switched off: only an explicit "0" turns the automatic check off.
export function isAutoUpdateCheckOn(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoUpdateCheck(on: boolean) {
  try {
    if (on) localStorage.removeItem(AUTO_KEY);
    else localStorage.setItem(AUTO_KEY, "0");
  } catch {
    // Only means the choice is not remembered.
  }
}

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Worst case the next start asks again.
  }
}

/// A version the hint has already been shown for, so it comes once per
/// version and not on every day's check.
export function wasAnnounced(version: string): boolean {
  try {
    return localStorage.getItem(ANNOUNCED_KEY) === version;
  } catch {
    return false;
  }
}

export function markAnnounced(version: string) {
  remember(ANNOUNCED_KEY, version);
}

/// Once per session however often the app's tree is mounted (a language
/// switch remounts it).
let autoCheckStarted = false;

/// The check at app start. Resolves to the newer version's number, or `null`
/// for everything else: switched off, checked less than a day ago, already
/// up to date, and every failure (offline, server unreachable, bad answer).
/// It never throws and never shows anything.
export async function runAutoUpdateCheck(): Promise<string | null> {
  if (autoCheckStarted || !isAutoUpdateCheckOn()) return null;
  autoCheckStarted = true;
  if (Date.now() - readNumber(LAST_CHECK_KEY) < DAY_MS) return null;
  // Noted before asking, so an offline machine tries once a day and not at
  // every start.
  remember(LAST_CHECK_KEY, String(Date.now()));
  try {
    return (await invoke<string | null>("check_for_update")) ?? null;
  } catch {
    return null;
  }
}

export type ManualCheckResult = { status: "newer"; version: string } | { status: "current" } | { status: "unreachable" };

/// The check button in settings: the one place that reports a failure.
export async function runManualUpdateCheck(): Promise<ManualCheckResult> {
  try {
    const version = await invoke<string | null>("check_for_update");
    remember(LAST_CHECK_KEY, String(Date.now()));
    return version ? { status: "newer", version } : { status: "current" };
  } catch {
    return { status: "unreachable" };
  }
}
