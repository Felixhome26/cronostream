// End-to-end check of the timeline's interactions: the safety net for
// restructuring Timeline.tsx (see docs/verbesserungsvorschlaege-2026-11-05.md,
// C0/C1). Drives the real app in WebKitGTK through tauri-driver on a fresh
// project of generated stand-in files and goes through what a user does:
// opening a stack, the detail view and its arrows, editing date, note and
// name, search, selection, context menus, year cluster, phase zoom, wheel
// zoom and the order in which Escape closes things. Linux only.
//
// Same build and setup as csp-check.mjs (see the comment at its top), then:
//   node scripts/e2e/timeline-check.mjs [--binary <path>] [--keep]
//
// Own config/data/cache folders and D-Bus session: the real stream setup
// is never touched. Screenshots stay in the work folder on failure or --keep.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  console.error(`timeline-check: no build at ${binary} (see the comment at the top of csp-check.mjs)`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cronostream-e2e-timeline-"));
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

const KEY = {
  control: "",
  enter: "",
  escape: "",
  left: "",
  right: "",
};

const { stop, base } = await startDriver({ env, log: join(work, "driver.log") });
let s;
try {
  s = await Session.create(base, binary);
  await s.setTimeouts(30000);
  let shotNo = 0;
  const shot = async (name) => writeFileSync(join(work, `${String(++shotNo).padStart(2, "0")}-${name}.png`), await s.screenshot());
  const exists = (css) => s.exec(`return !!document.querySelector(arguments[0]);`, css);
  const count = (css) => s.exec(`return document.querySelectorAll(arguments[0]).length;`, css);
  const text = (css) => s.exec(`const el = document.querySelector(arguments[0]); return el ? el.innerText : null;`, css);
  const waitGone = (css, ms = 3000) => s.waitFor(`return !document.querySelector(arguments[0]);`, ms, css);
  const waitThere = (css, ms = 5000) => s.waitFor(`return !!document.querySelector(arguments[0]);`, ms, css);

  // ---- input ---------------------------------------------------------------

  // WebKitWebDriver scales pointer coordinates down by the display's scale
  // factor once more than it should; scaling up here evens it out (same
  // workaround as csp-check.mjs).
  const dpr = await s.exec(`return window.devicePixelRatio;`);
  const at = ({ x, y }) => ({ x: Math.round(x * dpr), y: Math.round(y * dpr) });
  async function pointer(actions) {
    await s.cmd("POST", "/actions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
    });
  }
  async function keys(...values) {
    const actions = values.flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }]);
    await s.cmd("POST", "/actions", { actions: [{ type: "key", id: "kb", actions }] });
  }
  async function chord(modifier, key) {
    await s.cmd("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "kb",
          actions: [{ type: "keyDown", value: modifier }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: modifier }],
        },
      ],
    });
  }
  const typeText = (value) => keys(...[...value]);
  const escape = async () => {
    await keys(KEY.escape);
    await sleep(400);
  };
  // Hovering grows a tile; the click waits until it has settled.
  async function click(point, { hover = true, button = 0 } = {}) {
    if (hover) {
      await pointer([{ type: "pointerMove", ...at(point), duration: 0 }]);
      await sleep(500);
    }
    await pointer([
      { type: "pointerMove", ...at(point), duration: 0 },
      { type: "pointerDown", button },
      { type: "pause", duration: 80 },
      { type: "pointerUp", button },
    ]);
  }
  async function ctrlClick(point) {
    await pointer([{ type: "pointerMove", ...at(point), duration: 0 }]);
    await sleep(500);
    await s.cmd("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "kb",
          actions: [{ type: "keyDown", value: KEY.control }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: KEY.control }],
        },
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pause" },
            { type: "pointerMove", ...at(point), duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pause" },
          ],
        },
      ],
    });
  }
  const centerOf = (css, index = 0) =>
    s.exec(
      `const el = document.querySelectorAll(arguments[0])[arguments[1]];
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
      css,
      index,
    );

  // ---- the timeline's tiles --------------------------------------------------

  /// The stack's front tile (the one with the count badge) and the single
  /// tiles left to right. Tiles carry no id, so they are told apart by
  /// position: everything near the stack belongs to it.
  async function layout() {
    return s.exec(`
      const tiles = [...document.querySelectorAll(".timeline-tile")].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, badge: el.querySelector(".timeline-tile__count")?.innerText ?? null };
      });
      const stack = tiles.find((t) => t.badge) ?? null;
      const singles = tiles
        .filter((t) => !t.badge && (!stack || Math.hypot(t.x - stack.x, t.y - stack.y) > 60))
        .sort((a, b) => a.x - b.x);
      return { total: tiles.length, stack, singles };`);
  }
  const viewerName = () =>
    s.exec(`const input = document.querySelector(".viewer-card__name-input"); return input ? input.value || input.placeholder : null;`);
  async function openViewerAt(point) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await click(point);
      if (await s.waitFor(`return !!document.querySelector(".viewer-overlay");`, 3000)) return true;
    }
    return false;
  }
  async function closeAll() {
    for (let i = 0; i < 6; i++) {
      const open = await s.exec(
        `return !!document.querySelector(".viewer-overlay, .cluster-overlay, .pile-overlay, .timeline-search, .context-menu, .timeline-selection-bar, .timeline__phase-return");`,
      );
      if (!open) return;
      await s.exec(`document.activeElement && document.activeElement.blur && document.activeElement.blur();`);
      await escape();
    }
  }
  const searchIds = (query, from = null, to = null) => s.invoke("search_items", { query, from, to });

  // ---- project ---------------------------------------------------------------

  await s.waitFor(`return document.body.innerText.includes("Stream")`, 15000);
  const files = makeTimelineFixtures(join(work, "files"));
  mkdirSync(join(work, "projects"));
  const project = await s.invoke("create_project", { name: "Zeitleisten-Test", parentPath: join(work, "projects") });
  const added = await s.invoke("add_items", { paths: files });
  check("Testdateien importiert", added.added.length === files.length, `${added.added.length}/${files.length}`);
  const group = await s.invoke("create_phase_group", { name: "Testbereich" });
  await s.invoke("create_phase", {
    groupId: group.id,
    input: { title: "Testphase", startDate: "2019-01-01", endDate: "2021-12-31", color: null, ongoing: false },
  });
  await s.invoke("set_default_project", { path: project.path, enabled: true });

  await s.invoke("close_current_project");
  await s.exec(`localStorage.setItem("cronostream.welcome.hidden", "1");
                localStorage.setItem("cronostream.desktopSetup.offered", "1");
                localStorage.setItem("cronostream.language", "de");
                localStorage.setItem("cronostream.onboarding.zoomHintShown", "1");
                location.reload();`);
  await sleep(1000);
  await s.waitFor(
    `return document.querySelector(".timeline-tile__count") && [...document.images].every((i) => i.complete);`,
    20000,
  );
  await sleep(1000);
  await shot("zeitleiste");

  let view = await layout();
  check("Zeitleiste: Stapel mit 6 Dateien", view.stack?.badge === "6", `Zähler ${view.stack?.badge}`);
  check("Zeitleiste: 4 Einzelkacheln", view.singles.length === 4, `${view.singles.length}`);
  // Labels without text (a period too narrow to name) are left out.
  const labels = () =>
    s.exec(`return [...document.querySelectorAll(".timeline__marker-label")].map((l) => l.innerText.trim()).filter((l) => l);`);
  const yearLabels = await labels();
  check("Gesamtansicht zeigt Jahreszahlen", yearLabels.length > 0 && yearLabels.every((l) => /^\d{4}$/.test(l)), yearLabels.join(" "));
  check("Phasenbalken sichtbar", await exists(".timeline__phase-bar"));

  // ---- stack -> detail view -> back ------------------------------------------

  await click(view.stack);
  const pileOpen = await waitThere(".pile-overlay");
  await sleep(400);
  await shot("stapel");
  check("Klick auf Stapel öffnet das Raster", pileOpen && (await count(".pile-overlay .pile-tile")) === 6, `${await count(".pile-overlay .pile-tile")} Kacheln`);

  await click(await centerOf(".pile-overlay .pile-tile", 0));
  const viewerFromPile = await waitThere(".viewer-overlay");
  const firstInPile = await viewerName();
  check("Kachel im Stapel öffnet die Detailansicht", viewerFromPile && firstInPile?.startsWith("serie-"), firstInPile);

  await escape();
  await waitGone(".viewer-overlay");
  check("Esc schließt erst die Detailansicht, Stapel bleibt", !(await exists(".viewer-overlay")) && (await exists(".pile-overlay")));

  await click(await centerOf(".pile-overlay .pile-tile", 0));
  await waitThere(".viewer-overlay");
  await keys(KEY.right);
  await sleep(500);
  const secondInPile = await viewerName();
  check("Pfeil rechts blättert innerhalb des Stapels", secondInPile?.startsWith("serie-") && secondInPile !== firstInPile, `${firstInPile} → ${secondInPile}`);
  // Leaving on another file than the one opened takes the timeline there
  // (`leaveViewer`), so what stays open differs from the case above.
  await escape();
  await waitGone(".viewer-overlay");
  await sleep(600);
  const afterStep = {
    viewer: await exists(".viewer-overlay"),
    pile: await exists(".pile-overlay"),
    returnChip: await exists(".timeline__phase-return"),
  };
  await shot("stapel-verlassen");
  check(
    "Esc nach dem Blättern springt zur Datei, mit „Zurück“-Chip",
    !afterStep.viewer && !afterStep.pile && afterStep.returnChip,
    JSON.stringify(afterStep),
  );
  await closeAll();
  check("Danach schließt Esc alles Übrige", !(await exists(".pile-overlay, .viewer-overlay, .timeline__phase-return")));

  // ---- detail view on single tiles -------------------------------------------

  view = await layout();
  const opened = await openViewerAt(view.singles[0]);
  check("Einzelkachel öffnet die Detailansicht", opened && (await viewerName()) === "einzel-2015.jpg", await viewerName());
  await keys(KEY.right);
  await sleep(500);
  const next = await viewerName();
  check("Pfeil rechts geht zur zeitlich nächsten Datei", next === "zebra-2018.jpg", next);
  await keys(KEY.left);
  await sleep(500);
  check("Pfeil links geht zurück", (await viewerName()) === "einzel-2015.jpg", await viewerName());

  // Date: click the timestamp, type the segments (DD MM YYYY HH MM in German), Enter.
  await s.exec(`document.querySelector(".viewer-card__timestamp").click();`);
  const editing = await waitThere(".viewer-card__timestamp--editing .dt-input__field", 3000);
  await typeText("010220161230");
  await keys(KEY.enter);
  await sleep(800);
  const chip = await text(".viewer-card__timestamp");
  const movedTo = await searchIds(null, "2016-02-01", "2016-02-01");
  await shot("datum");
  check("Datum ändern in der Detailansicht", editing && chip?.includes("01.02.2016") && movedTo.length === 1, `${chip} · ${movedTo.length} Treffer`);

  // Note: typed, then closed at once — the debounce must not swallow it.
  await click(await centerOf(".viewer-card__note-input"), { hover: false });
  await typeText("Testnotiz Kranich");
  await s.exec(`document.querySelector(".viewer-card__close").click();`);
  await waitGone(".viewer-overlay");
  await sleep(800);
  check("Notiz wird beim sofortigen Schließen gespeichert", (await searchIds("kranich")).length === 1);

  // Name: opened from the timeline again, typed, Enter.
  view = await layout();
  await openViewerAt(view.singles[1]);
  const zebra = await viewerName();
  await click(await centerOf(".viewer-card__name-input"), { hover: false });
  await s.exec(`const i = document.querySelector(".viewer-card__name-input"); i.setSelectionRange(i.value.length, i.value.length);`);
  await typeText(" umbenannt");
  await keys(KEY.enter);
  await sleep(800);
  check("Name ändern in der Detailansicht", zebra === "zebra-2018.jpg" && (await searchIds("umbenannt")).length === 1, `${zebra} → ${await viewerName()}`);
  await s.exec(`document.querySelector(".viewer-card__close").click();`);
  await waitGone(".viewer-overlay");

  // ---- search ----------------------------------------------------------------

  await chord(KEY.control, "f");
  const searchOpen = await waitThere(".timeline-search__query", 3000);
  check("Strg+F öffnet die Suche", searchOpen);
  await typeText("zebra");
  const hits = await s.waitFor(`return document.querySelectorAll(".timeline-search-results__list > *").length;`, 5000);
  await shot("suche");
  check("Suche findet die umbenannte Datei", hits === 1, `${hits} Treffer`);
  await s.exec(`document.querySelector(".timeline-search__cluster-btn").click();`);
  const searchCluster = await waitThere(".cluster-overlay", 3000);
  check("„Ergebnisse ansehen“ öffnet den Cluster", searchCluster);
  await s.exec(`document.activeElement && document.activeElement.blur && document.activeElement.blur();`);
  await escape();
  check("Esc schließt den Cluster, Suche bleibt", !(await exists(".cluster-overlay")) && (await exists(".timeline-search")));
  await escape();
  check("Zweites Esc schließt die Suche", await waitGone(".timeline-search"));

  // ---- year cluster ----------------------------------------------------------

  await click(
    await s.exec(`const label = [...document.querySelectorAll(".timeline__marker-label--clickable")].find((l) => l.innerText.trim() === "2020");
                  if (!label) return null;
                  const r = label.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`),
    { hover: false },
  );
  const yearCluster = await waitThere(".cluster-overlay", 3000);
  await sleep(400);
  await shot("jahrescluster");
  check(
    "Klick auf Jahreszahl öffnet den Jahres-Cluster",
    yearCluster && (await text(".cluster-card__year"))?.trim() === "2020" && (await count(".cluster-overlay .pile-tile")) === 6,
    `${await text(".cluster-card__year")} · ${await count(".cluster-overlay .pile-tile")} Kacheln`,
  );
  await escape();
  check("Esc schließt den Jahres-Cluster", await waitGone(".cluster-overlay"));

  // ---- selection -------------------------------------------------------------

  view = await layout();
  await ctrlClick(view.singles[0]);
  await ctrlClick(view.singles[2]);
  await sleep(300);
  const selected = await text(".timeline-selection-bar__count");
  check("Strg-Klick wählt Kacheln aus", selected?.trim().startsWith("2"), selected);
  await escape();
  check("Esc hebt die Auswahl auf", await waitGone(".timeline-selection-bar"));

  await chord(KEY.control, "a");
  await sleep(300);
  const all = await text(".timeline-selection-bar__count");
  check("Strg+A wählt alles Sichtbare (Stapel ganz)", all?.trim().startsWith(String(files.length)), all);
  await s.exec(`document.querySelector(".timeline-selection-bar .btn--text").click();`);
  check("✕ in der Auswahlleiste hebt sie auf", await waitGone(".timeline-selection-bar"));

  // ---- context menus ---------------------------------------------------------

  view = await layout();
  await click(view.singles[3], { button: 2 });
  const tileMenu = await waitThere(".context-menu", 3000);
  await shot("kontextmenue");
  check("Rechtsklick auf Kachel öffnet das Menü", tileMenu && (await text(".context-menu"))?.length > 0);
  const blank = await s.exec(`
    const area = document.querySelector(".timeline__lanes").getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".timeline-tile")].map((t) => t.getBoundingClientRect());
    for (let fx = 0.15; fx < 0.95; fx += 0.05) {
      for (const fy of [0.5, 0.25, 0.75]) {
        const x = area.x + area.width * fx, y = area.y + area.height * fy;
        if (!tiles.some((r) => x > r.x - 20 && x < r.right + 20 && y > r.y - 20 && y < r.bottom + 20)) return { x, y };
      }
    }
    return null;`);
  await click(blank, { hover: false });
  check("Klick daneben schließt das Kachelmenü", await waitGone(".context-menu"));

  await click(blank, { hover: false, button: 2 });
  const trackMenu = await waitThere(".context-menu", 3000);
  check("Rechtsklick auf freie Fläche bietet Tagebucheintrag", trackMenu && (await text(".context-menu"))?.includes("Tagebuch"), await text(".context-menu"));
  await escape();
  check("Esc schließt das Flächenmenü", await waitGone(".context-menu"));

  // ---- phase zoom ------------------------------------------------------------

  await click(await centerOf(".timeline__phase-bar"), { hover: false });
  const phaseZoom = await waitThere(".timeline__phase-return", 3000);
  await sleep(800);
  await shot("phasenzoom");
  const phaseLabels = await labels();
  check("Klick auf Phase zoomt hinein", phaseZoom, phaseLabels.slice(0, 6).join(" "));
  await escape();
  await sleep(800);
  check("Esc kehrt aus dem Phasenzoom zurück", await waitGone(".timeline__phase-return"));

  // ---- wheel zoom ------------------------------------------------------------

  async function wheel(deltaY, times) {
    for (let i = 0; i < times; i++) {
      await s.exec(`const el = document.querySelector(".timeline__scroll");
                    const r = el.getBoundingClientRect();
                    el.dispatchEvent(new WheelEvent("wheel", { deltaY: arguments[0], clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));`, deltaY);
      await sleep(60);
    }
    await sleep(800);
  }
  await wheel(-120, 25);
  const zoomedIn = await labels();
  await shot("zoom-hinein");
  check("Mausrad zoomt hinein (keine reinen Jahreszahlen mehr)", zoomedIn.length > 0 && !zoomedIn.every((l) => /^\d{4}$/.test(l)), zoomedIn.slice(0, 4).join(" "));
  await wheel(120, 60);
  const zoomedOut = await labels();
  check("Mausrad zoomt zurück in die Gesamtansicht", zoomedOut.length > 0 && zoomedOut.every((l) => /^\d{4}$/.test(l)), zoomedOut.join(" "));
  view = await layout();
  check("Nach dem Zoom wieder Stapel und Einzelkacheln", view.stack?.badge === "6" && view.singles.length === 4);

  // ---- image zoom by keyboard -------------------------------------------------

  // "+" breaks the photo out of its frame and every further "+" zooms on;
  // Escape first collapses the zoom, then closes the viewer.
  await openViewerAt(view.singles[3]);
  await keys("+");
  await waitThere(".viewer-freed__frame", 3000);
  await sleep(300);
  const frameHeight = () => s.exec(`const f = document.querySelector(".viewer-freed__frame"); return f ? f.getBoundingClientRect().height : 0;`);
  const firstStep = await frameHeight();
  await keys("+", "+", "+");
  await sleep(500);
  const fourthStep = await frameHeight();
  await shot("bildzoom");
  check("„+“ zoomt das Bild schrittweise weiter", firstStep > 0 && fourthStep > firstStep * 1.4, `${Math.round(firstStep)} → ${Math.round(fourthStep)} px`);
  await escape();
  check("Esc beendet zuerst den Bildzoom", !(await exists(".viewer-freed__frame")) && (await exists(".viewer-overlay")));
  await escape();
  check("Zweites Esc schließt die Detailansicht", await waitGone(".viewer-overlay"));

  // ---- Escape order with several layers --------------------------------------

  await chord(KEY.control, "f");
  await waitThere(".timeline-search__query", 3000);
  await s.exec(`document.activeElement && document.activeElement.blur && document.activeElement.blur();`);
  await openViewerAt(view.singles[3]);
  await escape();
  const afterFirst = { viewer: await exists(".viewer-overlay"), search: await exists(".timeline-search") };
  await escape();
  const afterSecond = { search: await exists(".timeline-search") };
  check("Esc-Reihenfolge: Detailansicht vor Suche", !afterFirst.viewer && afterFirst.search && !afterSecond.search, JSON.stringify({ afterFirst, afterSecond }));

  await closeAll();

  // ---- marking in the file grid (Datei-Operationen) ---------------------------

  // The selection handed over from the timeline arrives there all marked.
  // Space toggles the active file and Ctrl+A toggles all of them — a second
  // press has to undo the first (docs/hook-bericht-2026-11-05.md).
  await chord(KEY.control, "a");
  await s.exec(`document.querySelector(".timeline-selection-bar .btn--primary").click();`);
  const marked = () => count(".file-tile--selected-remove");
  const arrived = await s.waitFor(`return document.querySelectorAll(".file-tile--selected-remove").length;`, 10000);
  await sleep(800);
  await s.exec(`document.activeElement && document.activeElement.blur && document.activeElement.blur();`);
  const steps = [arrived];
  for (const press of [() => keys(" "), () => keys(" "), () => chord(KEY.control, "a"), () => chord(KEY.control, "a")]) {
    await press();
    await sleep(500);
    steps.push(await marked());
  }
  await shot("datei-operationen");
  const want = [files.length, files.length - 1, files.length, 0, files.length];
  check("Datei-Operationen: Leertaste und Strg+A schalten hin und zurück", steps.join() === want.join(), `${steps.join(" → ")} (erwartet ${want.join(" → ")})`);

  // ---- archive check (Verwalten → Archiv prüfen) -------------------------------

  // The toolbox is still open on Datei-Operationen from above.
  const runArchiveCheck = async () => {
    await s.exec(`document.querySelector(".archive-tab__deep input").checked || document.querySelector(".archive-tab__deep input").click();`);
    await s.exec(`[...document.querySelectorAll(".archive-tab .btn--primary")].pop().click();`);
    await sleep(500);
    return s.waitFor(`const r = document.querySelector(".archive-tab__report");
                      return r && !document.querySelector(".archive-tab .btn--primary:disabled") ? r.innerText : null;`, 30000);
  };
  await s.exec(`[...document.querySelectorAll(".file-browser__tab")].find((b) => b.innerText.includes("Archiv prüfen")).click();`);
  await waitThere(".archive-tab", 5000);
  const firstRun = await runArchiveCheck();
  await shot("archiv-1");
  check(
    "Archiv-Check: alles in Ordnung, Fingerabdrücke angelegt",
    firstRun?.includes(`${files.length} Dateien geprüft`) && firstRun.includes(`${files.length} Fingerabdrücke`) && !firstRun.includes("⚠"),
    firstRun?.split("\n").slice(0, 3).join(" | "),
  );

  // Damaged on purpose: a thumbnail gone, a stray file, one byte changed.
  const thumbsDir = join(project.path, "thumbnails");
  const thumbFile = execFileSync("find", [thumbsDir, "-type", "f", "-name", "*.jpg"]).toString().trim().split("\n")[0];
  rmSync(thumbFile);
  writeFileSync(join(project.path, "originals", "liegengeblieben.part"), "x");
  const original = execFileSync("find", [join(project.path, "originals"), "-type", "f", "-name", "*.jpg"]).toString().trim().split("\n")[0];
  writeFileSync(original, Buffer.concat([readFileSync(original), Buffer.from([0])]));
  const secondRun = await runArchiveCheck();
  await shot("archiv-2");
  const findings = ["Fehlende Vorschaubilder: 1", "Dateien ohne Eintrag (1 B): 1", "Veränderte Inhalte: 1", "Fehlende Dateien: 0"];
  check("Archiv-Check findet Vorschaubild, fremde Datei und Veränderung", findings.every((f) => secondRun?.includes(f)), secondRun?.replace(/\n/g, " | ").slice(0, 300));

  await s.exec(`[...document.querySelectorAll(".archive-tab__section .btn")].find((b) => b.innerText.includes("neu erzeugen")).click();`);
  await sleep(1500);
  const thirdRun = await s.waitFor(`const r = document.querySelector(".archive-tab__report");
                      return r && !document.querySelector(".archive-tab .btn--primary:disabled") ? r.innerText : null;`, 30000);
  // Afterwards only a quick check runs; what the full one found stays listed.
  check(
    "Vorschaubild neu erzeugt, Ergebnis der Vollprüfung bleibt",
    existsSync(thumbFile) && thirdRun?.includes("Fehlende Vorschaubilder: 0") && thirdRun.includes("Veränderte Inhalte: 1"),
    thirdRun?.replace(/\n/g, " | ").slice(0, 200),
  );

  // ---- similar pictures (Verwalten → Duplikate) --------------------------------

  // The three single photos are the same test picture; the six of the burst
  // are flat colours, which must not count as alike.
  const similar = await s.invoke("scan_similar_images", { operationId: "e2e" });
  check(
    "Ähnliche Bilder: eine Gruppe aus den drei gleichen Testbildern, keine einfarbigen",
    similar.length === 1 && similar[0].item_ids.length === 3,
    JSON.stringify(similar.map((g) => g.item_ids.length)),
  );

  // ---- date inside the file (review screen candidates) ------------------------

  // A phone video carries its recording time inside; the review screen
  // offers it as an extra choice, the automatic one stays as it was.
  const phoneVideo = join(work, "iphone.mov");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "use_metadata_tags",
    "-metadata", "creation_time=2019-06-12T12:30:00Z", "-metadata", "com.apple.quicktime.creationdate=2019-06-12T14:23:01+0200",
    phoneVideo,
  ]);
  // The fast candidates (marking, drop box, adding) carry no ffprobe run; the
  // date is read on its own, only where the choice is shown.
  const [info] = await s.invoke("get_date_candidates", { paths: [phoneVideo], operationId: "e2e" });
  const [media] = await s.invoke("get_media_dates", { paths: [phoneVideo] });
  check(
    "Prüffenster: Aufnahmedatum aus dem Video als zusätzliche Wahl, getrennt gelesen",
    info && !("media" in info) && info.auto_source !== "meta" && media?.value?.startsWith("2019-06-12T14:23:01+02:00"),
    `media=${media?.value}, auto=${info?.auto_source}, im schnellen Teil: ${info && "media" in info}`,
  );

  await shot("ende");
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
