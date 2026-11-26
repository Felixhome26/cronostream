// Records the distribution packages bundled into the Linux AppImage, with
// their copyright files, in `scripts/licenses/appimage-packages.json`.
// `generate-third-party-licenses.mjs` turns that into a group of the
// Settings → About list.
//
// The AppImage is only known after it has been built, and the list has to be
// inside it, so this is a snapshot: run it after building an AppImage on a
// build machine with other packages (a different distribution, an `apt`
// upgrade of WebKitGTK/GTK/GStreamer), regenerate the list and build again.
//
//   npm run build:appimage
//   node scripts/collect-appimage-licenses.mjs [path to CronoStream.AppDir] [--packages-tsv]
//   node scripts/generate-third-party-licenses.mjs
//
// Needs a Debian-family build machine: everything comes from dpkg's database.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DPKG_INFO = "/var/lib/dpkg/info";
const COMMON_LICENSES = "/usr/share/common-licenses";
const OWN_FFMPEG = /^(ffmpeg|ffprobe|lib(avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)\.so\.\d+)$/;

function defaultAppDir() {
  const config = readFileSync(join(root, "src-tauri", ".cargo", "config.toml"), "utf8");
  const targetDir = config.match(/^target-dir\s*=\s*"([^"]+)"/m)?.[1] ?? join(root, "src-tauri", "target");
  return join(targetDir, "release", "bundle", "appimage", "CronoStream.AppDir");
}

function regularFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) regularFiles(path, found);
    else if (stat.isFile()) found.push(path);
  }
  return found;
}

/// Installed path → owning package, from dpkg's file lists. Reading them all
/// is far quicker than one `dpkg -S` per bundled file. `/lib` and `/usr/lib`
/// are the same place on merged systems, but not in the lists. Libraries and typelibs also
/// go in by bare file name: the bundler flattens /usr/lib/<triplet>/ away.
function packageByPath() {
  const owners = new Map();
  for (const file of readdirSync(DPKG_INFO)) {
    if (!file.endsWith(".list")) continue;
    const pkg = file.slice(0, -".list".length);
    for (const line of readFileSync(join(DPKG_INFO, file), "utf8").split("\n")) {
      if (!line) continue;
      // Some files keep /usr/lib/<triplet>/ in the AppDir, others are flattened: both spellings are keys.
      const path = line.replace(/^\/lib/, "/usr/lib");
      owners.set(path, pkg);
      owners.set(path.replace("/x86_64-linux-gnu/", "/"), pkg);
      // Bare names only for files directly in a system library directory: other packages
      // ship their own copies of common libraries (TeraBox, Thunderbird) in their own folders
      // and would take the name over.
      if (/^\/(usr\/)?lib\/(x86_64-linux-gnu\/)?[^/]+$/.test(line) && (line.includes(".so") || line.endsWith(".typelib"))) {
        owners.set(basename(line), pkg);
      }
      // Private libraries in a subfolder (gvfs/libgvfscommon.so) get flattened too.
      if (/^\/usr\/lib\/x86_64-linux-gnu\/[^/]+\/lib[^/]*\.so/.test(line) && !owners.has(basename(line))) {
        owners.set(basename(line), pkg);
      }
    }
  }
  return owners;
}

/// DEP-5 copyright files name their licenses in `License:` fields. Older ones
/// are free text, for which the entry just points at the text itself.
function licenseSummary(copyright) {
  const names = [...new Set([...copyright.matchAll(/^License:[ \t]*(\S.*)$/gm)].map((match) => match[1].trim()))];
  if (names.length === 0) return "see license text";
  return names.length > 4 ? `${names.slice(0, 4).join(", ")}, …` : names.join(", ");
}

function main() {
  // `--packages-tsv`: only print package, version, source, source version (for
  // build-appimage-sources.sh) instead of writing the license list.
  const tsvOnly = process.argv.includes("--packages-tsv");
  const appDir = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? defaultAppDir();
  if (!existsSync(appDir)) throw new Error(`No AppDir at ${appDir}: build an AppImage first.`);

  const owners = packageByPath();
  const packages = new Set();
  const unknown = [];
  for (const top of ["usr/lib", "usr/bin"]) {
    for (const file of regularFiles(join(appDir, top))) {
      const installed = file.slice(appDir.length);
      // The app's own files; PDFium is covered by its own group of the list.
      if (installed === "/usr/bin/cronostream" || installed.startsWith("/usr/lib/CronoStream/")) continue;
      // CronoStream's own ffmpeg, which has its own entry: by name these would pass for Ubuntu's GPL build.
      if (OWN_FFMPEG.test(basename(installed))) continue;
      const owner = owners.get(installed) ?? owners.get(basename(installed));
      if (owner) packages.add(owner);
      else unknown.push(installed);
    }
  }

  const fields = "${Package}\\t${Version}\\t${source:Package}\\t${source:Version}\\n";
  const rows = execFileSync("dpkg-query", ["-W", "-f", fields, ...packages], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (tsvOnly) {
    for (const row of rows) console.log(row.join("\t"));
    if (unknown.length) console.warn(`Not from any package (check by hand):\n  ${unknown.join("\n  ")}`);
    return;
  }

  const commonLicenses = {};
  const entries = rows
    .map(([name, version, source, sourceVersion]) => {
      const copyright = readFileSync(join("/usr/share/doc", name.split(":")[0], "copyright"), "utf8");
      // Debian files refer to the long texts by path instead of quoting them,
      // and that path doesn't exist on a recipient's machine (or any non-Debian one).
      const refs = [...copyright.matchAll(/\/usr\/share\/common-licenses\/([A-Za-z0-9._+-]+)/g)].map((m) => m[1]);
      const licenses = [...new Set(refs.map((ref) => ref.replace(/[.,]+$/, "")))].filter((ref) =>
        existsSync(join(COMMON_LICENSES, ref)),
      );
      for (const license of licenses) {
        commonLicenses[license] ??= readFileSync(join(COMMON_LICENSES, license), "utf8");
      }
      return { name, version, source, sourceVersion, license: licenseSummary(copyright), copyright, licenses };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const target = join(root, "scripts", "licenses", "appimage-packages.json");
  writeFileSync(target, JSON.stringify({ packages: entries, commonLicenses }, null, 1) + "\n");
  console.log(`appimage-packages.json: ${entries.length} packages, ${Object.keys(commonLicenses).length} common licenses`);
  if (unknown.length) {
    console.warn(`Not from any package (check by hand):\n  ${unknown.join("\n  ")}`);
  }
}

main();
