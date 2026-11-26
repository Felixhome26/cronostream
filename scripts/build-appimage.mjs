// Builds the Linux AppImage without the GObject typelibs, with only the
// GStreamer plugins that playback needs and with CronoStream's own ffmpeg.
//
// `bundleMediaFramework` copies every plugin of the build machine, and with
// them the codec libraries behind them (x264, x265, Xvid, DVD and camera
// libraries ... some GPL). The plugin script takes its plugins from
// GSTREAMER_PLUGINS_DIR, so that points at a folder holding just PLUGINS below.
//
// The libav plugin is not among them, because the plugin script would fetch
// Ubuntu's libav* for it, and those alone hang on 119 more libraries. It goes
// into the AppDir afterwards, with the LGPL ffmpeg of tools/ffmpeg-build/
// behind it. That build also provides `ffmpeg`/`ffprobe` for thumbnails and
// recording (found next to the executable, see ffmpeg_tool.rs).
//
// linuxdeploy's GTK plugin copies every typelib of the build machine into the
// AppImage, whatever the app uses: on a desktop system that means Rhythmbox's,
// Xreader's and so on, some under the GPL (see docs/lizenzpruefung.md). They
// only serve languages that call GTK through GObject introspection, and nothing
// in the AppImage links libgirepository, so they can't be loaded at all.
//
// Tauri has no hook between filling the AppDir and packing it, so the AppImage
// gets packed a second time here, with the tool Tauri itself has just fetched.
//
//   npm run build:appimage                  full build
//   npm run build:appimage -- --repack-only re-pack the AppDir of the last build
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// linuxdeploy calls dpkg-query once per library for its copyright file, at almost half a second
// each, and runs four times over the AppDir (Tauri's run, its GTK and GStreamer plugins, again in
// bundleFfmpeg), asking again for every library already copied. deployCopyrights does the same
// for the finished AppDir in one call.
const deployEnv = { DISABLE_COPYRIGHT_FILES_DEPLOYMENT: "1" };

function bundleDir() {
  // The config file is machine-local and not checked in (see README): without it, cargo builds into
  // its default folder, and so must this lookup.
  const configPath = join(root, "src-tauri", ".cargo", "config.toml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const targetDir = config.match(/^target-dir\s*=\s*"([^"]+)"/m)?.[1] ?? join(root, "src-tauri", "target");
  return join(targetDir, "release", "bundle", "appimage");
}

// What WebKit's playbin needs: demuxers, parsers, decoders (H.264/HEVC/AAC and most others come
// from libav, see bundleFfmpeg), audio/video conversion, the GL video path and audio output.
const PLUGINS = [
  "coreelements", "playback", "typefindfunctions", "app", "autodetect", "autoconvert", "debugutilsbad", "gio", "pbtypes",
  "isomp4", "matroska", "ogg", "avi", "asf", "flv", "mpegtsdemux", "mpegpsdemux", "mxf", "realmedia",
  "wavparse", "id3demux", "apetag", "icydemux", "audioparsers", "videoparsersbad",
  "vpx", "aom", "theora", "vorbis", "opus", "opusparse", "mpg123", "flac", "wavpack", "speex", "jpeg",
  "audioconvert", "audioresample", "audiorate", "audiofx", "volume",
  "videoconvertscale", "videorate", "videofilter", "deinterlace",
  "opengl", "pulseaudio", "alsa", "pipewire",
];
const SYSTEM_PLUGINS = "/usr/lib/x86_64-linux-gnu/gstreamer-1.0";

function stagePlugins() {
  const dir = mkdtempSync(join(tmpdir(), "cronostream-gst-"));
  for (const name of PLUGINS) {
    const file = join(SYSTEM_PLUGINS, `libgst${name}.so`);
    if (existsSync(file)) copyFileSync(file, join(dir, `libgst${name}.so`));
    else console.warn(`GStreamer plugin not installed, skipped: ${name}`);
  }
  return dir;
}

// GTK's image loaders for TIFF and WMF: CronoStream decodes images itself (Rust `image` crate) and
// GTK only loads icons and drag previews. These two are what brings in libjbig (GPL-2+) and libwmf.
function removeUnusedImageLoaders(appDir) {
  const usrLib = join(appDir, "usr", "lib");
  const pixbuf = join(usrLib, "gdk-pixbuf-2.0", "2.10.0");
  const unused = ["io-wmf.so", "libpixbufloader-tiff.so"];
  for (const loader of unused) rmSync(join(pixbuf, "loaders", loader), { force: true });
  const cache = join(pixbuf, "loaders.cache");
  const stanzas = readFileSync(cache, "utf8").split("\n\n").filter((stanza) => !unused.some((loader) => stanza.includes(`"${loader}"`)));
  writeFileSync(cache, stanzas.join("\n\n"));
  // The bundler also leaves a flat copy of each loader in usr/lib.
  for (const library of [...unused, "libtiff.so.6", "libjbig.so.0", "libLerc.so.4", "libdeflate.so.0", "libwmf-0.2.so.7", "libwmflite-0.2.so.7"]) {
    rmSync(join(usrLib, library), { force: true });
  }
  const docs = join(appDir, "usr", "share", "doc");
  if (!existsSync(docs)) return;
  for (const name of readdirSync(docs)) {
    if (/^(libtiff6|libjbig0|liblerc4|libdeflate0|libwmf)/.test(name)) rmSync(join(docs, name), { recursive: true, force: true });
  }
}

function ffmpegDir() {
  const versions = readFileSync(join(root, "tools", "ffmpeg-build", "versions.env"), "utf8");
  const version = versions.match(/^FFMPEG_LINUX_VERSION=(\S+)/m)[1];
  return join(homedir(), ".cache", "cronostream-ffmpeg", version);
}

// Puts the ffmpeg build and the libav plugin into the AppDir. linuxdeploy then fetches what they
// still need (Opus, VPx, AOM, PulseAudio), most of which the other plugins have brought along.
function bundleFfmpeg(appDir) {
  const ffmpeg = ffmpegDir();
  const setRpath = (rpath, file) => execFileSync("patchelf", ["--set-rpath", rpath, file]);
  for (const name of readdirSync(join(ffmpeg, "lib"))) {
    if (!/^lib\w+\.so\.\d+$/.test(name)) continue;
    const target = join(appDir, "usr", "lib", name);
    rmSync(target, { force: true });
    copyFileSync(join(ffmpeg, "lib", name), target);
    setRpath("$ORIGIN", target);
  }
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const target = join(appDir, "usr", "bin", tool);
    rmSync(target, { force: true });
    copyFileSync(join(ffmpeg, "bin", tool), target);
    setRpath("$ORIGIN/../lib", target);
  }
  const plugin = join(appDir, "usr", "lib", "gstreamer-1.0", "libgstlibav.so");
  rmSync(plugin, { force: true });
  copyFileSync(join(SYSTEM_PLUGINS, "libgstlibav.so"), plugin);
  setRpath("$ORIGIN/..:$ORIGIN", plugin);

  const linuxdeploy = readdirSync(join(homedir(), ".cache", "tauri")).find((name) => /^linuxdeploy-[0-9a-f]+-x86_64\.AppImage$/.test(name));
  if (!linuxdeploy) throw new Error("linuxdeploy not found in ~/.cache/tauri: run a full build first.");
  execFileSync(join(homedir(), ".cache", "tauri", linuxdeploy), ["--appdir", appDir], {
    stdio: "inherit",
    env: { ...process.env, ...deployEnv, APPIMAGE_EXTRACT_AND_RUN: "1", NO_STRIP: "1" },
  });
}

// The copyright file of each Debian package a library in the AppDir comes from, where linuxdeploy
// would put it: usr/share/doc/<package>/copyright. Each file is looked up at its own place on the
// system, flat libraries after resolving symlinks (or an unversioned name would hit the -dev
// package). A flat copy found nowhere under its name is looked up by name, if exactly one
// package has it. The ffmpeg libraries are CronoStream's own build, not Ubuntu's of the same name.
function deployCopyrights(appDir) {
  const usrLib = join(appDir, "usr", "lib");
  const systemLib = "/usr/lib/x86_64-linux-gnu";
  const ownLibraries = new Set(readdirSync(join(ffmpegDir(), "lib")));
  const paths = [];
  const unplaced = [];
  for (const name of readdirSync(usrLib)) {
    const file = join(usrLib, name);
    if (statSync(file).isDirectory()) {
      if (name === "CronoStream") continue;
      const prefix = name === "x86_64-linux-gnu" ? systemLib : join(systemLib, name);
      const walk = (dir, relative) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(dir, entry.name), join(relative, entry.name));
          else paths.push(join(prefix, relative, entry.name));
        }
      };
      walk(file, "");
    } else if (/\.so(\.|$)/.test(name) && !ownLibraries.has(name)) {
      const system = [join(systemLib, name), join("/lib/x86_64-linux-gnu", name)].find((path) => existsSync(path));
      if (system) paths.push(realpathSync(system));
      else unplaced.push(name);
    }
  }
  // dpkg-query exits with 1 when one pattern has no owner, so its status says nothing.
  const owners = (patterns) =>
    spawnSync("dpkg-query", ["-S", ...patterns], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .stdout.split("\n")
      .map((line) => line.match(/^([^/]+): (\/.+)$/))
      .filter((match) => match && !match[0].startsWith("diversion "))
      .map((match) => ({ path: match[2], packages: match[1].split(", ").map((name) => name.replace(/:.*$/, "")) }));
  const packages = new Set(owners(paths).flatMap((owner) => owner.packages));
  if (unplaced.length > 0) {
    const byName = new Map();
    for (const owner of owners(unplaced.map((name) => `*/${name}`))) {
      const name = basename(owner.path);
      byName.set(name, new Set([...(byName.get(name) ?? []), ...owner.packages]));
    }
    for (const found of byName.values()) if (found.size === 1) packages.add([...found][0]);
  }
  for (const name of packages) {
    const source = join("/usr/share/doc", name, "copyright");
    if (!existsSync(source)) continue;
    mkdirSync(join(appDir, "usr", "share", "doc", name), { recursive: true });
    copyFileSync(source, join(appDir, "usr", "share", "doc", name, "copyright"));
  }
}

if (!process.argv.includes("--repack-only")) {
  execFileSync("bash", [join(root, "tools", "ffmpeg-build", "build-linux.sh")], { stdio: "inherit" });
  const pluginsDir = stagePlugins();
  try {
    // --verbose, because otherwise Tauri swallows linuxdeploy's output and only reports
    // "failed to run linuxdeploy".
    execFileSync("npm", ["run", "tauri", "build", "--", "--verbose", "--bundles", "appimage"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...deployEnv, GSTREAMER_PLUGINS_DIR: pluginsDir },
    });
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
}

const dir = bundleDir();
const appDir = join(dir, "CronoStream.AppDir");
if (!existsSync(appDir)) throw new Error(`No AppDir at ${appDir}: build an AppImage first.`);
rmSync(join(appDir, "usr", "lib", "girepository-1.0"), { recursive: true, force: true });
removeUnusedImageLoaders(appDir);
bundleFfmpeg(appDir);
deployCopyrights(appDir);

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const output = join(dir, `CronoStream_${version}_amd64.AppImage`);
execFileSync(join(homedir(), ".cache", "tauri", "linuxdeploy-plugin-appimage.AppImage"), ["--appdir", appDir], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, ARCH: "x86_64", LDAI_OUTPUT: output, OUTPUT: output, APPIMAGE_EXTRACT_AND_RUN: "1" },
});
console.log(`${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MiB)`);
