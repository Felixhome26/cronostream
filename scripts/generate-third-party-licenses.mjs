// Generates `public/third-party-licenses.json`: every third-party component
// that ships with CronoStream, with its license and the full license text —
// shown in Settings → About (`AboutPanel.tsx`) and required by most of the
// licenses involved (MIT, BSD, Apache-2.0, MPL-2.0, LGPL).
//
// Run after changing dependencies and commit the result:
//   node scripts/fetch-pdfium.mjs            (PDFium's license files)
//   node scripts/generate-third-party-licenses.mjs
//
// Sources: `cargo metadata` (Rust crates compiled into the app, including
// the ones only used on other platforms), the production npm packages,
// native code those crates compile or link in under its own license
// (SQLite, Microsoft's WebView2 loader — texts in scripts/licenses/),
// PDFium and the libraries inside it, the bundled DejaVu fonts, and ffmpeg
// with libvpx/Opus (CronoStream's own build in all installers,
// tools/ffmpeg-build/), and the distribution
// packages bundled into the Linux AppImage (recorded by
// scripts/collect-appimage-licenses.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const texts = new Map();
const spdxCache = new Map();
/// Source directory of every shipped crate, by name — for the native code
/// some of them carry (`nativeEntries`).
const crateDirs = new Map();

/// Licenses we pick from an "A OR B" choice, most preferred first.
const PREFERRED = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "BSL-1.0",
  "0BSD",
  "MIT-0",
  "CC0-1.0",
  "Unlicense",
  "MPL-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "LGPL-2.1-or-later",
];

/// Turns an SPDX expression into the licenses that apply after choosing:
/// "MIT OR Apache-2.0" → ["MIT"], "(MIT OR Apache-2.0) AND Unicode-3.0" →
/// ["MIT", "Unicode-3.0"]. Old-style "MIT/Apache-2.0" counts as OR.
function chooseLicenses(expression) {
  const normalized = expression.replace(/\s*\/\s*/g, " OR ").replace(/[()]/g, "");
  return normalized.split(/\s+AND\s+/).map((part) => {
    const options = part.split(/\s+OR\s+/).map((option) => option.trim());
    return PREFERRED.find((license) => options.includes(license)) ?? options[0];
  });
}

async function spdxText(id) {
  const base = id.replace(/ WITH .*/, "");
  if (!spdxCache.has(base)) {
    const response = await fetch(`https://raw.githubusercontent.com/spdx/license-list-data/main/text/${base}.txt`);
    if (!response.ok) throw new Error(`SPDX text for ${base}: HTTP ${response.status}`);
    spdxCache.set(base, (await response.text()).trim());
  }
  return spdxCache.get(base);
}

/// Stores a text once and returns its id — most crates share a handful of
/// identical license texts.
function addText(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  texts.set(id, normalized);
  return id;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;
const FILE_HINTS = {
  MIT: /mit/i,
  "Apache-2.0": /apache/i,
  "BSD-3-Clause": /bsd/i,
  "BSD-2-Clause": /bsd/i,
  Zlib: /zlib/i,
  "Unicode-3.0": /unicode/i,
  "BSL-1.0": /bsl|boost/i,
  Unlicense: /unlicense/i,
  "MPL-2.0": /mpl/i,
  "CC0-1.0": /cc0/i,
};

function licenseFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile());
  } catch {
    return [];
  }
}

/// The license texts for one package: the package's own file for each
/// chosen license where it has one (that's where its copyright line is),
/// otherwise the standard SPDX text with the authors as copyright holders.
async function textsFor(dir, licenses, authors) {
  const files = licenseFiles(dir);
  const ids = [];
  for (const license of licenses) {
    const hint = FILE_HINTS[license.replace(/ WITH .*/, "")];
    let file = hint ? files.find((name) => hint.test(name)) : undefined;
    if (!file && files.length === 1 && licenses.length === 1) file = files[0];
    if (!file) {
      const generic = files.find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name));
      // A single generic file usually holds the one license the package
      // is under, or all of its options — either way the right text.
      if (generic && licenses.length === 1) file = generic;
    }
    if (file) {
      ids.push(addText(readFileSync(join(dir, file), "utf8")));
    } else {
      const holder = authors?.length ? `Copyright (c) ${authors.join(", ")}\n\n` : "";
      ids.push(addText(holder + (await spdxText(license))));
    }
  }
  // NOTICE files have to travel with Apache-2.0 code.
  for (const notice of files.filter((name) => /^notice/i.test(name))) {
    ids.push(addText(readFileSync(join(dir, notice), "utf8")));
  }
  return [...new Set(ids)];
}

async function rustEntries() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", join(root, "src-tauri", "Cargo.toml")], {
      maxBuffer: 256 * 1024 * 1024,
    }).toString(),
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  // Everything reachable through normal (non-dev, non-build) dependencies
  // is compiled into the app.
  const shipped = new Set();
  const stack = [metadata.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (shipped.has(id)) continue;
    shipped.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
    }
  }
  shipped.delete(metadata.resolve.root);

  const entries = [];
  for (const id of shipped) {
    const pkg = packages.get(id);
    crateDirs.set(pkg.name, dirname(pkg.manifest_path));
    const expression = pkg.license ?? "UNKNOWN";
    const licenses = chooseLicenses(expression);
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: expression,
      url: pkg.repository ?? `https://crates.io/crates/${pkg.name}`,
      texts: await textsFor(dirname(pkg.manifest_path), licenses, pkg.authors),
    });
  }
  return entries;
}

/// npm packages without a license field, with what their project states.
const NPM_LICENSE_OVERRIDES = {
  // The npm package has no license field; the same project's Rust crate
  // (tauri-plugin-drag) is "Apache-2.0 OR MIT".
  "@crabnebula/tauri-plugin-drag": "Apache-2.0 OR MIT",
};

async function npmEntries() {
  const tree = JSON.parse(
    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString(),
  );
  const seen = new Map();
  const walk = (deps) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (dep.path && !seen.has(`${name}@${dep.version}`)) seen.set(`${name}@${dep.version}`, { name, ...dep });
      walk(dep.dependencies);
    }
  };
  walk(tree.dependencies);

  const entries = [];
  for (const dep of seen.values()) {
    const pkg = JSON.parse(readFileSync(join(dep.path, "package.json"), "utf8"));
    const declared = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
    const expression = declared ?? NPM_LICENSE_OVERRIDES[dep.name] ?? "UNKNOWN";
    const authors = pkg.author ? [typeof pkg.author === "string" ? pkg.author : pkg.author.name] : [];
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    entries.push({
      name: dep.name,
      version: dep.version,
      license: expression,
      url: repository?.replace(/^git\+/, "").replace(/\.git$/, "") ?? `https://www.npmjs.com/package/${dep.name}`,
      texts: await textsFor(dep.path, chooseLicenses(expression), authors),
    });
  }
  return entries;
}

function pdfiumEntries() {
  const dir = join(root, "src-tauri", "pdfium");
  if (!existsSync(join(dir, "licenses"))) {
    throw new Error("src-tauri/pdfium/licenses is missing — run `node scripts/fetch-pdfium.mjs` first");
  }
  const version = readFileSync(join(dir, "VERSION"), "utf8").split(" ")[0];
  const files = readdirSync(join(dir, "licenses")).sort();
  const text = (file) => addText(readFileSync(join(dir, "licenses", file), "utf8"));
  // PDFium itself, then the libraries compiled into it.
  const main = files.filter((file) => /^pdfium/.test(file));
  // One entry per library — libjpeg-turbo comes with two files (.md, .ijg).
  const bundled = new Map();
  for (const file of files.filter((file) => !/^pdfium/.test(file))) {
    const name = file.replace(/\.(txt|md|ijg)$/, "").replace(/_/g, "-");
    bundled.set(name, [...(bundled.get(name) ?? []), text(file)]);
  }
  return [
    {
      name: "PDFium",
      version,
      license: "BSD-3-Clause AND Apache-2.0",
      url: "https://pdfium.googlesource.com/pdfium/",
      texts: main.map(text),
    },
    ...[...bundled].map(([name, ids]) => ({
      name,
      version: "",
      license: "(in PDFium)",
      url: "https://github.com/bblanchon/pdfium-binaries",
      texts: ids,
    })),
  ];
}

/// Native code inside shipped crates that isn't under the crate's own
/// license: the SQLite amalgamation libsqlite3-sys compiles in (`bundled`
/// feature, public domain), and the WebView2 loader webview2-com-sys links
/// statically into the Windows build (Microsoft's BSD-3-Clause license plus
/// the NOTICE that ships with it).
function nativeEntries() {
  const sqliteDir = crateDirs.get("libsqlite3-sys");
  const sqliteHeader = readFileSync(join(sqliteDir, "sqlite3", "sqlite3.h"), "utf8");
  const sqliteVersion = sqliteHeader.match(/#define SQLITE_VERSION\s+"([^"]+)"/)[1];
  // The header's opening comment is SQLite's whole "license": the blessing.
  const blessing = sqliteHeader
    .slice(0, sqliteHeader.indexOf("*****"))
    .split("\n")
    .map((line) => line.replace(/^(\/\*|\*\*) ?/, ""))
    .join("\n");

  // Keep in step with WEBVIEW2_VERSION in webview2-rs's update-bindings
  // when webview2-com-sys is updated (and refresh scripts/licenses/ from
  // that Microsoft.Web.WebView2 NuGet package).
  const webview2Version = "1.0.3800.47";
  const licenseFile = (file) => addText(readFileSync(join(root, "scripts", "licenses", file), "utf8"));

  return [
    {
      name: "SQLite",
      version: sqliteVersion,
      license: "blessing (public domain)",
      url: "https://sqlite.org/copyright.html",
      texts: [addText(blessing)],
    },
    {
      name: "Microsoft WebView2 Loader",
      version: webview2Version,
      license: "BSD-3-Clause",
      url: "https://www.nuget.org/packages/Microsoft.Web.WebView2",
      texts: [licenseFile("WebView2-LICENSE.txt"), licenseFile("WebView2-NOTICE.txt")],
    },
  ];
}

/// ffmpeg as built by tools/ffmpeg-build/ — versions from its
/// versions.env, license files straight from the exact upstream tags.
async function ffmpegEntries() {
  const versions = Object.fromEntries(
    readFileSync(join(root, "tools", "ffmpeg-build", "versions.env"), "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")),
  );
  const upstream = async (repo, tag, file) => {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/${file}`);
    if (!response.ok) throw new Error(`${repo}/${file}@${tag}: HTTP ${response.status}`);
    return addText(await response.text());
  };
  return [
    {
      name: "FFmpeg",
      version: versions.FFMPEG_VERSION,
      license: "LGPL-2.1-or-later",
      url: "https://ffmpeg.org/",
      texts: [
        await upstream("FFmpeg/FFmpeg", versions.FFMPEG_VERSION, "LICENSE.md"),
        await upstream("FFmpeg/FFmpeg", versions.FFMPEG_VERSION, "COPYING.LGPLv2.1"),
      ],
    },
    {
      name: "FFmpeg (Linux AppImage)",
      version: versions.FFMPEG_LINUX_VERSION,
      license: "LGPL-2.1-or-later",
      url: "https://ffmpeg.org/",
      texts: [
        await upstream("FFmpeg/FFmpeg", versions.FFMPEG_LINUX_VERSION, "LICENSE.md"),
        await upstream("FFmpeg/FFmpeg", versions.FFMPEG_LINUX_VERSION, "COPYING.LGPLv2.1"),
      ],
    },
    {
      name: "libvpx",
      version: versions.LIBVPX_VERSION,
      license: "BSD-3-Clause",
      url: "https://chromium.googlesource.com/webm/libvpx",
      texts: [
        await upstream("webmproject/libvpx", versions.LIBVPX_VERSION, "LICENSE"),
        await upstream("webmproject/libvpx", versions.LIBVPX_VERSION, "PATENTS"),
      ],
    },
    {
      name: "Opus",
      version: versions.OPUS_VERSION,
      license: "BSD-3-Clause",
      url: "https://opus-codec.org/",
      texts: [await upstream("xiph/opus", versions.OPUS_VERSION, "COPYING")],
    },
  ];
}

/// WebKitGTK, GTK, GStreamer and what they pull in. The URL is where the
/// exact source of that package version can be had, which the LGPL asks for.
function appimageEntries() {
  const { packages, commonLicenses } = JSON.parse(
    readFileSync(join(root, "scripts", "licenses", "appimage-packages.json"), "utf8"),
  );
  return packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    url: `https://launchpad.net/ubuntu/+source/${pkg.source}/${pkg.sourceVersion}`,
    texts: [addText(pkg.copyright), ...pkg.licenses.map((license) => addText(commonLicenses[license]))],
  }));
}

async function main() {
  const rust = (await rustEntries()).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const npm = (await npmEntries()).sort((a, b) => a.name.localeCompare(b.name));
  const native = nativeEntries();
  const pdfium = pdfiumEntries();
  const fonts = [
    {
      name: "DejaVu Sans",
      version: "",
      license: "Bitstream-Vera AND Arev",
      url: "https://dejavu-fonts.github.io/",
      texts: [addText(readFileSync(join(root, "src-tauri", "assets", "fonts", "DejaVu-LICENSE.txt"), "utf8"))],
    },
  ];
  const programs = await ffmpegEntries();
  const appimage = appimageEntries();
  // CronoStream itself, first in the list. EUPL Art. 5 asks for the licence
  // text with every copy; the URL is the source repository Art. 3 asks for
  // (keep in sync with SOURCE_URL in AboutPanel.tsx).
  const own = [
    {
      name: "CronoStream",
      version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
      license: "EUPL-1.2",
      url: "https://github.com/Felixhome26/cronostream",
      texts: [addText(readFileSync(join(root, "LICENSE"), "utf8"))],
    },
  ];

  const unknown = [...rust, ...npm].filter((entry) => entry.license === "UNKNOWN");
  if (unknown.length) {
    throw new Error(`No license known for: ${unknown.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
  }

  const output = {
    groups: [
      { id: "own", entries: own },
      { id: "rust", entries: rust },
      { id: "npm", entries: npm },
      { id: "native", entries: native },
      { id: "pdfium", entries: pdfium },
      { id: "fonts", entries: fonts },
      { id: "programs", entries: programs },
      { id: "appimage", entries: appimage },
    ],
    texts: Object.fromEntries([...texts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  const target = join(root, "public", "third-party-licenses.json");
  writeFileSync(target, JSON.stringify(output) + "\n");
  console.log(
    `third-party-licenses.json: ${rust.length} Rust crates, ${npm.length} npm packages, ${native.length} native libraries, ` +
      `${pdfium.length} PDFium parts, ${appimage.length} AppImage packages, ` +
      `${texts.size} distinct license texts, ${(statSync(target).size / 1024).toFixed(0)} KB`,
  );
}

await main();
