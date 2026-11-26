// Minimal W3C WebDriver client for the end-to-end checks in this folder —
// plain fetch against tauri-driver, so the checks need no npm packages.
// tauri-driver (`cargo install tauri-driver`) forwards to WebKitWebDriver
// (Debian/Ubuntu: `webkit2gtk-driver`), i.e. the real WebKitGTK webview.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/// Runs under its own D-Bus session: the single-instance plugin claims a bus
/// name, so with CronoStream already running (the drop box, say) the app
/// under test would hand its start over to that one and quit.
/// Its output (and the app's, plenty of GTK/portal noise) goes to `log`.
export async function startDriver({ port = 4444, env = {}, log }) {
  const tauriDriver = join(homedir(), ".cargo", "bin", "tauri-driver");
  const driver = spawn("dbus-run-session", ["--", tauriDriver, "--port", String(port)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
    // Own process group, so `stop` takes down tauri-driver, WebKitWebDriver
    // and the app with it.
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-driver.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.ok) return { stop, base };
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  stop();
  throw new Error(`tauri-driver did not start (see ${log})`);
}

export class Session {
  static async create(base, application) {
    const res = await call(base, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    return new Session(base, res.sessionId);
  }

  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }

  /** Runs `script` (a function body) in the page; `arguments[i]` are `args`. */
  exec(script, ...args) {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  /** Like `exec`, but the script calls `arguments[arguments.length - 1](result)`. */
  execAsync(script, ...args) {
    return this.cmd("POST", "/execute/async", { script, args });
  }

  /** A backend command through the app's own IPC bridge. */
  invoke(command, args = {}) {
    return this.execAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
         .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error) }));`,
      command,
      args,
    ).then((r) => {
      if (!r.ok) throw new Error(`${command}: ${r.error}`);
      return r.value;
    });
  }

  async find(css) {
    const all = await this.cmd("POST", "/elements", { using: "css selector", value: css });
    return all.map((e) => e[ELEMENT]);
  }

  click(element) {
    return this.cmd("POST", `/element/${element}/click`, {});
  }

  async screenshot() {
    return Buffer.from(await this.cmd("GET", "/screenshot"), "base64");
  }

  setTimeouts(script) {
    return this.cmd("POST", "/timeouts", { script });
  }

  close() {
    return this.cmd("DELETE", "");
  }

  /** Polls `script` (returns truthy when done) until it holds or `ms` pass. */
  async waitFor(script, ms = 10000, ...args) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await this.exec(script, ...args);
      if (last) return last;
      await sleep(200);
    }
    return last;
  }
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`);
  }
  return json.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
