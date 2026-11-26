// Puts CronoStream's LGPL ffmpeg build (tools/ffmpeg-build/, built by the
// "Build LGPL ffmpeg" workflow) into the Windows/macOS installer: the two
// tools become Tauri sidecars (`src-tauri/binaries/<tool>-<target>`, see
// `externalBin` in tauri.windows.conf.json / tauri.macos.conf.json), their
// license texts a bundled resource (`src-tauri/ffmpeg-licenses/`).
//
// Linux needs nothing: there CronoStream uses the distribution's ffmpeg.
//
// The release lives in the public CronoStream repository (built in the
// development repository and copied there). This uses the GitHub CLI, so it
// needs its login (`gh auth login` once on the build machine, GH_TOKEN in
// Actions).
// Does nothing when the right build is already in place.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FFMPEG_RELEASE = "ffmpeg-n8.1.3-1";
const REPOSITORY = "Felixhome26/cronostream";

const ASSETS = {
  "win32-x64": "ffmpeg-windows-x86_64.zip",
  // Windows on ARM runs the x86_64 build emulated.
  "win32-arm64": "ffmpeg-windows-x86_64.zip",
  "darwin-x64": "ffmpeg-macos-x86_64.zip",
  "darwin-arm64": "ffmpeg-macos-aarch64.zip",
};

if (process.platform === "linux") process.exit(0);

const asset = ASSETS[`${process.platform}-${process.arch}`];
if (!asset) {
  console.error(`fetch-ffmpeg: no ffmpeg build for ${process.platform}-${process.arch}`);
  process.exit(1);
}

const tauriDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const binDir = join(tauriDir, "binaries");
const licenseDir = join(tauriDir, "ffmpeg-licenses");
// Tauri names sidecars by the Rust target they are built for.
const triple = execFileSync("rustc", ["-vV"]).toString().match(/^host: (.+)$/m)[1].trim();
const exe = process.platform === "win32" ? ".exe" : "";
const stamp = `${FFMPEG_RELEASE} ${asset}`;
const stampFile = join(binDir, "VERSION");

if (
  existsSync(stampFile) &&
  readFileSync(stampFile, "utf8").trim() === stamp &&
  existsSync(join(binDir, `ffmpeg-${triple}${exe}`)) &&
  existsSync(join(binDir, `ffprobe-${triple}${exe}`))
) {
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "cronostream-ffmpeg-"));
try {
  console.log(`fetch-ffmpeg: downloading ${asset} from ${REPOSITORY} release ${FFMPEG_RELEASE}`);
  try {
    execFileSync("gh", ["release", "download", FFMPEG_RELEASE, "--repo", REPOSITORY, "--pattern", asset, "--dir", work], {
      stdio: "inherit",
    });
  } catch {
    console.error(
      "fetch-ffmpeg: download failed. Is the GitHub CLI installed and logged in (`gh auth login`), " +
        `and has the "Build LGPL ffmpeg" workflow published the release ${FFMPEG_RELEASE}?`,
    );
    process.exit(1);
  }
  // `tar` (bsdtar on Windows 10+ and macOS) unpacks zip archives too.
  execFileSync("tar", ["-xf", join(work, asset), "-C", work], { stdio: "inherit" });
  const unpacked = join(work, asset.replace(/\.zip$/, ""));

  mkdirSync(binDir, { recursive: true });
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const target = join(binDir, `${tool}-${triple}${exe}`);
    cpSync(join(unpacked, `${tool}${exe}`), target);
    if (!exe) chmodSync(target, 0o755);
  }
  rmSync(licenseDir, { recursive: true, force: true });
  mkdirSync(licenseDir, { recursive: true });
  cpSync(join(unpacked, "licenses"), licenseDir, { recursive: true });
  cpSync(join(unpacked, "SOURCES.txt"), join(licenseDir, "SOURCES.txt"));
  writeFileSync(stampFile, `${stamp}\n`);
  console.log(`fetch-ffmpeg: ${readdirSync(binDir).join(", ")} ready in src-tauri/binaries/`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
