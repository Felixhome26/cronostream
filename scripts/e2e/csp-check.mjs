// End-to-end check that the Content-Security-Policy (tauri.conf.json) lets
// everything the app shows through: runs the real app in WebKitGTK through
// tauri-driver, fills a fresh project with generated stand-in files and
// opens each kind in the viewer. Linux only.
//
// Needs once: `sudo apt install webkit2gtk-driver`, `cargo install tauri-driver`.
// Needs a build with the frontend embedded (the CSP only applies there, not
// under `tauri dev`) — its own target triple so it doesn't disturb the dev
// build's cache:
//   npm run build
//   cd src-tauri && cargo build --features tauri/custom-protocol --target x86_64-unknown-linux-gnu
// Then: node scripts/e2e/csp-check.mjs [--binary <path>] [--keep]
//
// The app runs with its own config/data/cache folders and D-Bus session, so
// the real stream setup (recent list, settings, a running drop box) is
// left alone. Screenshots of every step stay in the work folder on failure
// or with --keep.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtures } from "./fixtures.mjs";
import { Session, sleep, startDriver } from "./webdriver.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const binary = args.includes("--binary") ? args[args.indexOf("--binary") + 1] : defaultBinary();

function defaultBinary() {
  let targetDir = process.env.CARGO_TARGET_DIR;
  if (!targetDir) {
    const config = join(repo, "src-tauri", ".cargo", "config.toml");
    const match = existsSync(config) && readFileSync(config, "utf8").match(/^target-dir\s*=\s*"(.+)"/m);
    targetDir = match ? match[1] : join(repo, "src-tauri", "target");
  }
  return join(targetDir, "x86_64-unknown-linux-gnu", "debug", "cronostream");
}

if (!existsSync(binary)) {
  console.error(`csp-check: no build at ${binary} (see the comment at the top of this file)`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cronostream-e2e-"));
const env = {};
for (const [name, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"]]) {
  env[name] = join(work, dir);
  mkdirSync(env[name], { recursive: true });
}
const debugLog = join(env.XDG_CONFIG_HOME, "com.felixheck.cronostream", "debug.log");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const { stop, base } = await startDriver({ env, log: join(work, "driver.log") });
let s;
try {
  s = await Session.create(base, binary);
  await s.setTimeouts(30000);
  const shot = async (name) => writeFileSync(join(work, `${name}.png`), await s.screenshot());

  // WebKitWebDriver scales pointer coordinates down by the display's scale
  // factor (Xft.dpi) once more than it should; scaling up here evens it out.
  async function pointer(actions) {
    await s.cmd("POST", "/actions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
    });
  }
  async function tileCenter(index) {
    const [x, y, dpr] = await s.exec(
      `const r = document.querySelectorAll(".timeline-tile")[arguments[0]].getBoundingClientRect();
       return [r.x + r.width / 2, r.y + r.height / 2, window.devicePixelRatio];`,
      index,
    );
    return { x: Math.round(x * dpr), y: Math.round(y * dpr) };
  }
  // Hovering grows a tile; the click waits until it has settled.
  async function clickTile(index) {
    await pointer([{ type: "pointerMove", ...(await tileCenter(index)), duration: 0 }]);
    await sleep(500);
    await pointer([
      { type: "pointerMove", ...(await tileCenter(index)), duration: 0 },
      { type: "pointerDown", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerUp", button: 0 },
    ]);
  }
  const ESCAPE_KEY = "\uE00C";
  const escape = () =>
    s.cmd("POST", "/actions", { actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: ESCAPE_KEY }, { type: "keyUp", value: ESCAPE_KEY }] }] });
  // Escape steps back one level at a time (viewer -> stack -> timeline).
  async function closeViewer() {
    for (let i = 0; i < 4 && (await s.exec(`return !!document.querySelector(".viewer-overlay");`)); i++) {
      await escape();
      await sleep(400);
    }
  }
  const brokenImages = () =>
    s.exec(`return [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(0, 80));`);

  // Start screen
  await s.waitFor(`return document.body.innerText.includes("Stream")`, 15000);
  await shot("01-start");
  const start = await s.exec(`return { theme: document.documentElement.dataset.theme, broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length }`);
  check("Startbildschirm: Theme gesetzt, Bilder geladen", start.theme && start.broken === 0, `theme=${start.theme}`);

  // The policy itself, and that the inline theme script in index.html is hashed into it
  const policy = await s.execAsync(`const done = arguments[0]; (async () => {
    const res = await fetch("/");
    const csp = res.headers.get("content-security-policy") || "";
    const inline = (await res.text()).match(/<script>([\\s\\S]*?)<\\/script>/)[1];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const external = await fetch("https://example.com/").then(() => "erlaubt", () => "gesperrt");
    const licenses = await fetch("/third-party-licenses.json").then((r) => r.ok, () => false);
    return { csp, hashed: csp.includes(hash), external, licenses };
  })().then(done, (e) => done({ error: String(e) }));`);
  check("CSP-Header aktiv", policy.csp.includes("default-src"), policy.error);
  check("Inline-Theme-Skript per Hash erlaubt", policy.hashed);
  check("Externe Verbindung gesperrt", policy.external === "gesperrt", policy.external);
  check("Lizenzliste ladbar", policy.licenses);

  // Fresh project with one file of each kind; reopened as the default
  // project, the way a user would come back to it.
  const files = makeFixtures(join(work, "files"));
  mkdirSync(join(work, "projects"));
  const project = await s.invoke("create_project", { name: "CSP-Test", parentPath: join(work, "projects") });
  const added = await s.invoke("add_items", { paths: Object.values(files) });
  check("Testdateien importiert", added.added.length === Object.keys(files).length, `${added.added.length}/${Object.keys(files).length}`);
  await s.invoke("set_default_project", { path: project.path, enabled: true });

  async function reopen() {
    await s.invoke("close_current_project");
    await s.exec(`localStorage.setItem("cronostream.welcome.hidden", "1");
                  localStorage.setItem("cronostream.desktopSetup.offered", "1");
                  location.reload();`);
    await sleep(1000);
    return s.waitFor(
      `const tiles = document.querySelectorAll(".timeline-tile");
       return tiles.length >= arguments[0] && [...document.images].every((i) => i.complete) ? tiles.length : 0;`,
      20000,
      Object.keys(files).length,
    );
  }

  const tileCount = await reopen();
  await sleep(1000);
  await shot("02-timeline");
  check("Zeitleiste: alle Kacheln da", tileCount >= Object.keys(files).length, `${tileCount} Kacheln`);
  const timelineBroken = await brokenImages();
  check("Zeitleiste: keine kaputten Vorschaubilder", timelineBroken.length === 0, timelineBroken.join(", "));

  // Each tile in the viewer, found by what its kind shows there.
  const kinds = await s.exec(`return [...document.querySelectorAll(".timeline-tile")].map((t) => t.innerText + " " + [...t.querySelectorAll("img")].map((i) => i.src).join(" "));`);
  const tileOf = (text) => kinds.findIndex((k) => k.includes(text));
  // A click that lands while the previous viewer is still fading out does
  // nothing now and then; another one does.
  async function open(index) {
    await closeViewer();
    for (let attempt = 0; attempt < 3; attempt++) {
      await clickTile(index);
      if (await s.waitFor(`return !!document.querySelector(".viewer-overlay");`, 3000)) return;
    }
  }
  async function plays(tag) {
    const played = await s.execAsync(`const done = arguments[arguments.length - 1];
      const el = document.querySelector(arguments[0]);
      if (!el) return done({ error: "kein <" + arguments[0] + ">" });
      el.muted = true;
      el.play().then(() => setTimeout(() => done({ time: el.currentTime, error: el.error && el.error.code }), 1500),
                     (e) => done({ error: String(e) }));`, tag);
    return [played.time > 0.5 && !played.error, played.error ?? `${played.time?.toFixed(1)} s`];
  }
  const viewerImage = `const img = document.querySelector("[class*=viewer] img[src*='127.0.0.1']");
                       return img && img.complete && img.naturalWidth > 0;`;

  // Photo and video tiles both show a thumbnail from the media server; the
  // viewer tells them apart.
  for (const [index] of kinds.map((k, i) => [i, k]).filter(([, k]) => k.includes("127.0.0.1"))) {
    await open(index);
    const shown = await s.waitFor(`return document.querySelector("video") ? "video" : (${`(() => { ${viewerImage} })()`}) ? "image" : null;`, 10000);
    if (shown === "video") {
      const [ok, detail] = await plays("video");
      await shot("03-Video");
      check("Video spielt ab", ok, detail);
    } else {
      await shot("03-Foto");
      check("Ansicht Foto", shown === "image");
    }
  }

  await open(tileOf("ton.mp3"));
  await s.waitFor(`return !!document.querySelector("audio");`, 10000);
  const [audioOk, audioDetail] = await plays("audio");
  await shot("04-Audio");
  check("Audio spielt ab", audioOk, audioDetail);

  for (const [name, text, ready] of [
    ["PDF", "dokument.pdf", viewerImage],
    ["DOCX-Text", "brief.docx", `return document.body.innerText.includes("CSP-Test Dokument & Text");`],
    // Both pictures (the inline one and the cid: one) arrive as data: URLs;
    // inside the sandboxed frame they can only be checked on the screenshot.
    ["E-Mail mit 2 Bildern", "absender@example.com", `const frame = document.querySelector("iframe[srcdoc*='CSP-Test HTML']");
      return !!frame && frame.getAttribute("srcdoc").split("src=\\"data:image/png").length - 1 === 2;`],
  ]) {
    await open(tileOf(text));
    const ok = await s.waitFor(ready, 10000);
    await sleep(500);
    await shot(`05-${name}`);
    const broken = await brokenImages();
    check(`Ansicht ${name}`, ok && broken.length === 0, broken.join(", "));
  }

  // Light theme: the inline script picks it before the app script loads.
  await closeViewer();
  await s.exec(`localStorage.setItem("cronostream.theme", "light");`);
  await reopen();
  await sleep(1000);
  await shot("06-hell");
  const light = await s.exec(`return { theme: document.documentElement.dataset.theme, broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length }`);
  check("Helles Theme: Zeitleiste vollständig", light.theme === "light" && light.broken === 0, `theme=${light.theme}`);

  // The page reports every blocked load to the debug log (src/main.tsx);
  // the two above were provoked on purpose.
  const violations = (existsSync(debugLog) ? readFileSync(debugLog, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("csp-violation") && !line.includes("https://example.com/"));
  check("Keine CSP-Verstöße im Betrieb", violations.length === 0, violations.join(" | "));
} catch (e) {
  check("Ablauf", false, e.message);
} finally {
  await s?.close().catch(() => {});
  stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden. Screenshots: ${work}`);
if (failed.length === 0 && !keep) rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
