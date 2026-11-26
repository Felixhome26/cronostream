// End-to-end check of the relocation prompt (src-tauri/src/relocation.rs):
// a stream folder copied by hand still points at the original's files.
// Opening the copy must offer to adjust the paths, and afterwards the copy
// must stand on its own. Same build and setup as csp-check.mjs, then:
//   node scripts/e2e/relocation-check.mjs [--binary <path>] [--keep]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTimelineFixtures } from "./fixtures.mjs";
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
  console.error(`relocation-check: no build at ${binary} (see the comment at the top of csp-check.mjs)`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cronostream-e2e-relocation-"));
const env = {};
for (const [name, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"]]) {
  env[name] = join(work, dir);
  mkdirSync(env[name], { recursive: true });
}

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
  await s.waitFor(`return document.body.innerText.includes("Stream")`, 15000);

  // The original, with a few files, closed again.
  const files = makeTimelineFixtures(join(work, "files"));
  mkdirSync(join(work, "projects"));
  const original = await s.invoke("create_project", { name: "Original", parentPath: join(work, "projects") });
  await s.invoke("add_items", { paths: files });
  await s.invoke("close_current_project");

  // Copied by hand, the way a file manager would.
  const copyPath = join(work, "projects", "Kopie von Hand");
  cpSync(original.path, copyPath, { recursive: true });
  rmSync(join(copyPath, ".cronostream.lock"), { force: true });

  // Opened the way a user would come back to it: as the default on start.
  await s.invoke("open_project", { path: copyPath, force: true });
  await s.invoke("set_default_project", { path: copyPath, enabled: true });
  await s.invoke("close_current_project");
  await s.exec(`localStorage.setItem("cronostream.welcome.hidden", "1");
                localStorage.setItem("cronostream.desktopSetup.offered", "1");
                localStorage.setItem("cronostream.language", "de");
                localStorage.setItem("cronostream.onboarding.zoomHintShown", "1");
                location.reload();`);
  const prompt = await s.waitFor(`const d = document.querySelector(".confirm-dialog"); return d ? d.innerText : null;`, 20000);
  await shot("01-rueckfrage");
  check("Kopie: Rückfrage erscheint", prompt?.includes("verschoben") && prompt.includes(original.path), prompt?.slice(0, 160));

  await s.exec(`document.querySelector(".confirm-dialog .btn--danger").click();`);
  const loaded = await s.waitFor(
    `const tiles = document.querySelectorAll(".timeline-tile");
     return tiles.length > 0 && [...document.images].every((i) => i.complete) ? tiles.length : 0;`,
    // Generous: right after a build the first thumbnails took over 20 s once.
    45000,
  );
  await sleep(1000);
  await shot("02-zeitleiste");
  const broken = await s.exec(`return [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length;`);
  // A picture that never finished, asked for again from here rather than from
  // the page (whose CSP blocks fetch() to the media server): an answer means
  // the server is fine and the webview never sent or never read the request.
  const openImages = await s.exec(`return [...document.images].filter((i) => !i.complete).map((i) => [i.src, i.className]);`);
  const pending = await Promise.all(
    openImages.map(async ([src, className]) => {
      const name = decodeURIComponent(src.split("path=")[1] || "").split("/").slice(-3).join("/");
      const started = Date.now();
      const status = await fetch(src, { signal: AbortSignal.timeout(5000) }).then(
        (r) => `${r.status} ${r.headers.get("content-length")} B in ${Date.now() - started} ms`,
        (e) => `keine Antwort (${e.name})`,
      );
      return `${name} → Server: ${status} (${className})`;
    }),
  );
  check("Zeitleiste der Kopie vollständig", loaded > 0 && broken === 0, `${loaded} Kacheln, ${broken} kaputt, offen: ${pending.join(" | ")}`);
  check("Danach zeigt nichts mehr aufs Original", (await s.invoke("check_project_relocation")) === null);
  const snapshots = readdirSync(copyPath).filter((name) => name.startsWith("cronostream.db.vor-pfadanpassung-"));
  check("Sicherung der Datenbank angelegt", snapshots.length === 1, snapshots.join(", "));

  // The original itself is never asked about.
  await s.invoke("close_current_project");
  await s.invoke("open_project", { path: original.path, force: true });
  check("Original: keine Rückfrage nötig", (await s.invoke("check_project_relocation")) === null);

  // ---- updating an existing backup (Verwalten → Sicherung) ---------------------

  const backups = join(work, "backups");
  mkdirSync(backups);
  const waitFor = async (test, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = test();
      if (value) return value;
      await sleep(300);
    }
    return null;
  };
  await s.invoke("start_backup", { destinationParent: backups });
  const backupName = await waitFor(() => readdirSync(backups).find((n) => n.includes("-Backup-") && !n.endsWith(".partial")));
  const backupPath = join(backups, backupName ?? "fehlt");
  const before = (await s.invoke("search_items", { query: null, from: null, to: null })).length;

  const extra = join(work, "nachtrag.jpg");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=teal:size=160x120", "-frames:v", "1", extra]);
  await s.invoke("add_items", { paths: [extra] });

  const refusedSelf = await s.invoke("start_backup_update", { backupPath: original.path }).then(() => null, (e) => String(e));
  check("Sicherung aktualisieren: der Stream selbst wird abgelehnt", refusedSelf?.includes("selbst"), refusedSelf);

  const plainCheck = await s.invoke("check_backup_update", { backupPath });
  check(
    "Sicherung aktualisieren: eine echte Sicherung braucht keine Rückfrage",
    plainCheck && !plainCheck.otherName && !plainCheck.ownChanges,
    JSON.stringify(plainCheck),
  );

  await s.invoke("start_backup_update", { backupPath });
  const updated = await waitFor(() => {
    const found = execFileSync("find", [join(backupPath, "originals"), "-name", "*nachtrag.jpg"]).toString().trim();
    return found && !existsSync(join(backupPath, ".cronostream-update.partial")) ? found : null;
  });
  await sleep(1500);
  await s.invoke("close_current_project");
  await s.invoke("open_project", { path: backupPath, force: true });
  const backupItems = await s.invoke("search_items", { query: null, from: null, to: null });
  const inBackup = backupItems.length;
  const keptPrevious = existsSync(join(backupPath, "cronostream.db.vor-aktualisierung"));
  check(
    "Sicherung aktualisieren: neue Datei und Datenbank kommen dazu, die alte Datenbank bleibt liegen",
    Boolean(updated) && inBackup === before + 1 && keptPrevious && (await s.invoke("check_project_relocation")) === null,
    `vorher ${before}, in der Sicherung jetzt ${inBackup}, alte Datenbank aufbewahrt: ${keptPrevious}`,
  );

  // Worked on in the backup itself, the way a duplicate continued on its own
  // is: updating it again is asked about first.
  await s.invoke("update_display_name", { id: backupItems[0], displayName: "In der Sicherung umbenannt" });
  await s.invoke("close_current_project");
  await s.invoke("open_project", { path: original.path, force: true });
  const ownCheck = await s.invoke("check_backup_update", { backupPath });
  check(
    "Sicherung aktualisieren: in der Sicherung weitergearbeitet, also Rückfrage",
    ownCheck?.ownChanges === true && ownCheck.otherName === false,
    JSON.stringify(ownCheck),
  );
} catch (e) {
  check("Ablauf", false, e.message);
  try {
    writeFileSync(join(work, "fehler.png"), await s.screenshot());
  } catch {
    // no session left to take one
  }
} finally {
  await s?.close().catch(() => {});
  stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} bestanden. Screenshots: ${work}`);
if (failed.length === 0 && !keep) rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
