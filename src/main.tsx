import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import DropZone from "./components/DropZone";
import { ErrorBoundary } from "./ErrorBoundary";
import { useLanguage } from "./i18n";
// Side effects only: applies the theme and follows a switch made in the
// other window.
import "./theme";
import { installMenuClamp } from "./menuClamp";

installMenuClamp();

// Both windows load the same index.html (no second Vite entry to keep in
// sync) — the window label decides what gets mounted. "dropzone" is the
// small always-on-top drag & drop window created in src-tauri/src/lib.rs.
const isDropZone = getCurrentWindow().label === "dropzone";

// Temporary diagnostic aid: persist uncaught errors to a file (see
// src-tauri/src/debug_log.rs) so they can be inspected without needing to
// watch the webview's devtools console live.
window.addEventListener("error", (ev) => {
  invoke("debug_log", {
    message: `window.onerror: ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}\n${ev.error?.stack ?? ""}`,
  }).catch(() => {});
});
window.addEventListener("unhandledrejection", (ev) => {
  const reason = ev.reason;
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  invoke("debug_log", { message: `unhandledrejection: ${detail}` }).catch(() => {});
});
// Anything the Content-Security-Policy (tauri.conf.json) blocks — a missing
// source there shows up as a blank thumbnail or a silent player otherwise.
// scripts/e2e/csp-check.mjs reads these lines back.
document.addEventListener("securitypolicyviolation", (ev) => {
  invoke("debug_log", {
    message: `csp-violation: ${ev.effectiveDirective} blocked ${ev.blockedURI || "(inline)"} at ${ev.sourceFile}:${ev.lineNumber}`,
  }).catch(() => {});
});

// The webview would otherwise let the user drag any <img>/<video>/link out
// of the window as a URL to the internal media server — useless to other
// apps. Real file drags go through useFileDragOut instead.
document.addEventListener("dragstart", (ev) => {
  if ((ev.target as Element | null)?.closest?.("img, video, audio, a")) ev.preventDefault();
});

// The drop box has little state worth keeping across a language switch (made
// in the main window, picked up here via the `storage` event), so it is
// simply rebuilt under the new language. Only the circle view survives. It
// starts as set by `build_dropzone_window` in src-tauri/src/lib.rs.
function DropZoneRoot() {
  const language = useLanguage();
  const [mini, setMini] = React.useState(
    () => (window as { __CS_DROPZONE_START_MINI__?: boolean }).__CS_DROPZONE_START_MINI__ === true,
  );
  return <DropZone key={language} mini={mini} onMiniChange={setMini} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary releaseProjectOnReload={!isDropZone}>{isDropZone ? <DropZoneRoot /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
