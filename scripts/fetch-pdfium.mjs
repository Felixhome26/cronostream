// Puts the PDFium library for the machine this runs on into
// `src-tauri/pdfium/`, from where Tauri bundles it with the app
// (`bundle.resources`) and `pdf_preview.rs` loads it. PDFium (Chrome's PDF
// engine, BSD/Apache) replaced Poppler, whose GPL doesn't fit a commercial
// app. Prebuilt binaries: https://github.com/bblanchon/pdfium-binaries
//
// Runs before `tauri dev`/`tauri build` and does nothing when the right
// version is already there. The version must match the `pdfium_*` API
// level of the `pdfium-render` crate (its `pdfium_latest` feature).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PDFIUM_RELEASE = "chromium/7881";

// SHA-256 of each archive, as GitHub lists it for the release. A release's
// assets can be replaced after the fact, so a mismatch aborts the build
// instead of bundling whatever the download returned. Update these together
// with PDFIUM_RELEASE (`gh api repos/bblanchon/pdfium-binaries/releases/tags/<tag>`
// shows each asset's `digest`).
const ASSETS = {
  "linux-x64": ["pdfium-linux-x64.tgz", "lib/libpdfium.so", "1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d"],
  "linux-arm64": ["pdfium-linux-arm64.tgz", "lib/libpdfium.so", "ee7f7b7d5468958336a818c1cd580bdd20972846b7377b13f9a923d92d1d4674"],
  "darwin-x64": ["pdfium-mac-x64.tgz", "lib/libpdfium.dylib", "6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b"],
  "darwin-arm64": ["pdfium-mac-arm64.tgz", "lib/libpdfium.dylib", "52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40"],
  "win32-x64": ["pdfium-win-x64.tgz", "bin/pdfium.dll", "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08"],
  "win32-arm64": ["pdfium-win-arm64.tgz", "bin/pdfium.dll", "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84"],
};

const platform = `${process.platform}-${process.arch}`;
const entry = ASSETS[platform];
if (!entry) {
  console.error(`fetch-pdfium: no PDFium build for ${platform}`);
  process.exit(1);
}
const [asset, libraryPath, sha256] = entry;
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "pdfium");
const stamp = `${PDFIUM_RELEASE} ${asset}`;
const libraryName = libraryPath.split("/").pop();

const stampFile = join(target, "VERSION");
if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stamp && existsSync(join(target, libraryName))) {
  process.exit(0);
}

const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(PDFIUM_RELEASE)}/${asset}`;
console.log(`fetch-pdfium: downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`fetch-pdfium: download failed (${response.status})`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cronostream-pdfium-"));
try {
  const archive = join(work, asset);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== sha256) {
    console.error(`fetch-pdfium: checksum mismatch for ${asset} (expected ${sha256}, got ${actual})`);
    process.exit(1);
  }
  writeFileSync(archive, data);
  // `tar` ships with Linux, macOS and Windows 10+.
  execFileSync("tar", ["-xzf", archive, "-C", work], { stdio: "inherit" });

  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "licenses"), { recursive: true });
  cpSync(join(work, libraryPath), join(target, libraryName));
  cpSync(join(work, "LICENSE"), join(target, "licenses", "pdfium-LICENSE.txt"));
  cpSync(join(work, "licenses"), join(target, "licenses"), { recursive: true });
  writeFileSync(stampFile, `${stamp}\n`);
  console.log(`fetch-pdfium: ${libraryName} ready in src-tauri/pdfium/`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
