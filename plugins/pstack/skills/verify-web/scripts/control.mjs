#!/usr/bin/env node
// control.mjs: the verify-web harness.
//
// One long-lived daemon owns the browser (launched by us, or attached over CDP),
// keeps console/network buffers, and runs traces/profiles that must outlive a
// single command. Every other invocation is a thin client that posts one
// command to the daemon over localhost and prints a JSON result.
//
//   control launch [--url U] [--app "npm run dev"] [--cdp http://127.0.0.1:9222]
//   control doctor | pages | use | goto | click | fill | press | wait | snapshot
//   control screenshot | text | eval | console | network | errors | metrics
//   control trace start|stop | profile start|stop | heap | gc | throttle
//   control note | verdict | cleanup | help
//   control init | setup                (scaffold a repo; install Playwright)
//
// Two layouts, one code path:
//   plugin mode     this file lives in the pstack plugin; each repo keeps its own
//                   config, feature map and evidence in <repo>/.claude/skills/verify/
//                   (written by `control init`, found by walking up from cwd).
//   standalone mode this skill folder was copied into a repo and carries
//                   verify.config.json itself; state stays beside it.
//
// Everything a command does is appended to <evidence>/timeline.jsonl.

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, ".."); // where this harness lives (plugin install or standalone copy)
const TEMPLATES_DIR = path.join(SKILL_DIR, "templates");
const USER_DEPS_DIR = path.join(os.homedir(), ".claude", "verify-web"); // `control setup` installs Playwright here
const PROJECT_DIR = findProjectDir(); // the repo's verification state; null until `control init`
const RUN_DIR = PROJECT_DIR && path.join(PROJECT_DIR, ".run");
const SESSION_FILE = RUN_DIR && path.join(RUN_DIR, "session.json");
const DAEMON_LOG = RUN_DIR && path.join(RUN_DIR, "daemon.log");
const CONFIG_FILE = PROJECT_DIR && path.join(PROJECT_DIR, "verify.config.json");
const DEFAULT_TIMEOUT = 10_000;
const MAX_INLINE_CHARS = 30_000;

// <repo>/.claude/skills/verify/ wins (plugin mode, the path pstack's playbooks look for);
// otherwise this skill folder when it carries its own config (standalone mode).
function findProjectDir() {
  if (process.env.VERIFY_PROJECT_DIR) return path.resolve(process.env.VERIFY_PROJECT_DIR);
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".claude", "skills", "verify");
    if (fs.existsSync(path.join(candidate, "verify.config.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync(path.join(SKILL_DIR, "verify.config.json"))) return SKILL_DIR;
  return null;
}

function repoRoot() {
  return PROJECT_DIR ? path.resolve(PROJECT_DIR, "../../..") : process.cwd();
}

function requireProject() {
  if (PROJECT_DIR) return PROJECT_DIR;
  print({ ok: false, error: "No verification state for this repo. From the repo root run: control init --url http://127.0.0.1:3000 [--app \"npm run dev\"] [--marker \"#app\"]" }, 1);
}

// Playwright can come from the project, the user-level install made by `control setup`,
// this skill's own scripts/node_modules, or a global install. First hit wins.
function resolvePlaywright() {
  const tried = [];
  const roots = [process.env.VERIFY_WEB_NODE_MODULES && path.dirname(process.env.VERIFY_WEB_NODE_MODULES), repoRoot(), USER_DEPS_DIR, __dirname].filter(Boolean);
  for (const root of roots) {
    try {
      return { file: createRequire(path.join(root, "package.json")).resolve("playwright"), from: root };
    } catch {
      tried.push(root);
    }
  }
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { file: createRequire(path.join(globalRoot, "package.json")).resolve("playwright"), from: globalRoot };
  } catch {
    tried.push("npm root -g");
  }
  return { file: null, tried };
}

// ---------- shared helpers ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  const app = cfg.app && cfg.app.command ? { ...cfg.app, cwd: cfg.app.cwd ? path.resolve(PROJECT_DIR, cfg.app.cwd) : repoRoot() } : null;
  return {
    url: cfg.url ?? null,
    app, // { command, cwd (resolved), readyTimeoutMs }
    cdp: cfg.cdp ?? null,
    marker: cfg.marker ?? null,
    headed: cfg.headed ?? false,
    channel: cfg.channel ?? null,
    viewport: cfg.viewport ?? { width: 1280, height: 800 },
    evidenceDir: cfg.evidenceDir ? path.resolve(PROJECT_DIR, cfg.evidenceDir) : path.join(PROJECT_DIR, "evidence"),
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT,
    env: cfg.env ?? {},
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid, signal = "SIGTERM") {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // The app was spawned detached as its own process group; kill the group.
      try {
        process.kill(-pid, signal);
      } catch {
        process.kill(pid, signal);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function print(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  if (exitCode !== undefined) process.exit(exitCode);
}

async function fetchStatus(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e?.cause?.code || e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------- client ----------

async function send(cmd, args) {
  const session = readJson(SESSION_FILE);
  if (!session) return { ok: false, error: "No session. Run: control launch" };
  if (session.status !== "ready") return { ok: false, error: `Session status is ${session.status}`, session };
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, args });
    const req = http.request(
      { host: "127.0.0.1", port: session.controlPort, path: "/cmd", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: "Bad response from daemon", raw: data });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: `Daemon unreachable (${e.code || e.message}). Run: control doctor, then control cleanup --force if it is dead.`, session }));
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end(body);
  });
}

async function clientLaunch(opts) {
  const existing = readJson(SESSION_FILE);
  if (existing && existing.status === "ready" && pidAlive(existing.pid) && !opts.force) {
    return print({ ok: false, error: "A session is already running. Run: control cleanup (or launch --force).", session: existing }, 1);
  }
  const cfg = readConfig();
  if (opts.url) cfg.url = opts.url;
  if (opts.cdp) cfg.cdp = opts.cdp;
  if (opts.app) cfg.app = { ...(cfg.app || {}), command: opts.app };
  if (opts["no-app"]) cfg.app = null; // drive an instance that is already running
  if (opts.cwd) cfg.app = { ...(cfg.app || {}), cwd: path.resolve(String(opts.cwd)) }; // flag: relative to where you invoke; config: relative to the skill dir
  if (opts.marker) cfg.marker = opts.marker;
  if (opts.headed) cfg.headed = true;
  if (opts.channel) cfg.channel = opts.channel;
  if (opts.viewport) {
    const [w, h] = String(opts.viewport).split("x").map(Number);
    cfg.viewport = { width: w, height: h };
  }
  if (opts.evidence) cfg.evidenceDir = path.resolve(opts.evidence);
  if (!cfg.url && !cfg.cdp) return print({ ok: false, error: "Need --url (or url in verify.config.json), or --cdp to attach to a running browser." }, 1);

  const id = runId();
  const evidenceDir = path.join(cfg.evidenceDir, id);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  writeJson(SESSION_FILE, { status: "starting", runId: id, evidenceDir, startedAt: new Date().toISOString() });

  const logFd = fs.openSync(DAEMON_LOG, "a");
  const child = spawn(process.execPath, [__filename, "__daemon", "--run-id", id, "--config-json", JSON.stringify(cfg)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...cfg.env, VERIFY_PROJECT_DIR: PROJECT_DIR },
  });
  child.unref();

  const deadline = Date.now() + ((cfg.app?.readyTimeoutMs ?? 90_000) + 30_000);
  while (Date.now() < deadline) {
    await sleep(300);
    const s = readJson(SESSION_FILE);
    if (s?.status === "ready") {
      const doctor = await send("doctor", {});
      return print({ ok: doctor.ok, launched: true, runId: id, evidenceDir, cdpEndpoint: s.cdpEndpoint, doctor }, doctor.ok ? 0 : 1);
    }
    if (s?.status === "error") return print({ ok: false, error: s.error, daemonLog: DAEMON_LOG }, 1);
    if (!pidAlive(child.pid) && s?.status !== "ready") {
      return print({ ok: false, error: "Daemon exited during startup", daemonLog: DAEMON_LOG, tail: tailFile(DAEMON_LOG) }, 1);
    }
  }
  return print({ ok: false, error: "Timed out waiting for the harness to become ready", daemonLog: DAEMON_LOG, tail: tailFile(DAEMON_LOG) }, 1);
}

function tailFile(file, lines = 30) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function clientCleanup(opts) {
  const session = readJson(SESSION_FILE);
  if (!session) return print({ ok: true, note: "No session to clean up." }, 0);
  let result = null;
  if (session.status === "ready") {
    result = await send("cleanup", { reason: opts.reason || "client" });
    if (result?.ok) {
      // Wait for the daemon to actually exit so the report below is true, not hopeful.
      const deadline = Date.now() + 15_000;
      while (pidAlive(session.pid) && Date.now() < deadline) await sleep(200);
      result.daemonExited = !pidAlive(session.pid);
      if (!result.daemonExited) result.ok = false;
    }
  }
  if (!result?.ok || opts.force) {
    // Daemon did not answer. Kill only the PIDs we recorded, never by name.
    const killed = [];
    for (const key of ["appPid", "browserPid", "pid"]) {
      if (session[key] && pidAlive(session[key])) {
        killTree(session[key]);
        killed.push(`${key}=${session[key]}`);
      }
    }
    result = { ok: true, forced: true, killed, note: result?.error || "forced cleanup" };
  }
  if (session.profileDir) fs.rmSync(session.profileDir, { recursive: true, force: true });
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {}
  const evidenceKept = session.evidenceDir && fs.existsSync(session.evidenceDir);
  return print({ ...result, evidenceDir: session.evidenceDir, evidenceKept }, 0);
}

// ---------- init: scaffold a repo's verification state ----------

function gitTopLevel(dir) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function clientInit(opts) {
  if (!fs.existsSync(TEMPLATES_DIR)) return print({ ok: false, error: `No templates at ${TEMPLATES_DIR}; this copy of the harness is standalone and already carries its own config.` }, 1);
  const root = opts.root ? path.resolve(String(opts.root)) : gitTopLevel(process.cwd()) || process.cwd();
  const dest = path.join(root, ".claude", "skills", "verify");
  const configFile = path.join(dest, "verify.config.json");
  if (fs.existsSync(configFile) && !opts.force) return print({ ok: false, error: `${dest} is already initialized. Pass --force to overwrite SKILL.md, the config and the templates (features you wrote are kept).` }, 1);

  copyTree(TEMPLATES_DIR, dest);
  fs.renameSync(path.join(dest, "gitignore"), path.join(dest, ".gitignore"));

  const cfg = readJson(configFile, {});
  if (opts.url) cfg.url = String(opts.url);
  if (opts.app) cfg.app = { command: String(opts.app), cwd: opts.cwd ? path.relative(dest, path.resolve(String(opts.cwd))) : "../../..", readyTimeoutMs: 90_000 };
  if (opts.marker) cfg.marker = String(opts.marker);
  if (opts.cdp) cfg.cdp = String(opts.cdp);
  writeJson(configFile, cfg);

  // Shims so the project skill says `scripts/control` whichever harness copy is installed.
  const scripts = path.join(dest, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const sh = `#!/usr/bin/env bash
# Written by \`control init\`. Runs the verify-web harness that ships with the pstack plugin.
HARNESS="${__filename}"
if [ ! -f "$HARNESS" ]; then
  HARNESS="$(find "$HOME/.claude/plugins" -path '*/skills/verify-web/scripts/control.mjs' 2>/dev/null | head -1)"
fi
if [ ! -f "$HARNESS" ]; then
  echo '{"ok":false,"error":"verify-web harness not found. Reinstall the pstack plugin, then rerun: control init --force"}'
  exit 1
fi
exec node "$HARNESS" "$@"
`;
  fs.writeFileSync(path.join(scripts, "control"), sh, { mode: 0o755 });
  fs.writeFileSync(path.join(scripts, "control.cmd"), `@echo off\r\nnode "${__filename}" %*\r\n`);

  const next = [
    `Edit ${path.relative(root, configFile)}: url, app.command (or leave null and start the app yourself), marker.`,
    `Write the first feature files in ${path.relative(root, path.join(dest, "features"))}/ from TEMPLATE.md; delete the example.`,
    "Install Playwright once if the repo has none: control setup",
    "Prove it: scripts/control launch, doctor, drive one feature, cleanup; confirm evidence/<run-id>/ survived.",
  ];
  return print({ ok: true, dir: dest, harness: __filename, config: cfg, next }, 0);
}

// ---------- setup: install Playwright where the harness will find it ----------

function clientSetup(opts) {
  const target = opts.here ? __dirname : USER_DEPS_DIR;
  fs.mkdirSync(target, { recursive: true });
  const pkg = path.join(target, "package.json");
  if (!fs.existsSync(pkg)) writeJson(pkg, { name: "verify-web-deps", private: true, description: "Playwright for the verify-web harness (pstack plugin)." });
  const steps = [];
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: target, stdio: "inherit", shell: process.platform === "win32" });
    steps.push({ cmd: [cmd, ...args].join(" "), status: r.status });
    return r.status === 0;
  };
  if (!run("npm", ["install", "--no-fund", "--no-audit", "playwright@^1.56"])) return print({ ok: false, steps, error: "npm install failed" }, 1);
  if (!opts.channel) {
    const cli = path.join(target, "node_modules", "playwright", "cli.js");
    if (!run(process.execPath, [cli, "install", "chromium"])) return print({ ok: false, steps, error: "Chromium download failed; retry, or use --channel chrome and set channel in verify.config.json" }, 1);
  }
  const resolved = resolvePlaywright();
  return print({ ok: !!resolved.file, installedTo: target, playwright: resolved.file, channel: opts.channel || "chromium (downloaded)", steps, note: opts.channel ? `Set "channel": "${opts.channel}" in verify.config.json.` : undefined }, resolved.file ? 0 : 1);
}

function help() {
  const text = `
control: drive the app like a user and capture evidence (Playwright over Chrome DevTools Protocol).

Once per repo
  init [--url U] [--app "cmd"] [--cwd DIR] [--marker SEL] [--cdp ENDPOINT] [--root DIR] [--force]
                                 Scaffold <repo>/.claude/skills/verify/ (project skill, config, feature map, shims)
  setup [--channel chrome] [--here]
                                 Install Playwright under ~/.claude/verify-web (and Chromium unless --channel)

Session
  launch [--url U] [--app "cmd"] [--no-app] [--cwd DIR] [--cdp ENDPOINT] [--marker SEL] [--headed] [--channel chrome] [--viewport 1280x800] [--evidence DIR] [--force]
  doctor                         Is this instance worth driving? (browser, page, marker, app URL, app process)
  cleanup [--force]              Stop what launch started. Keeps evidence.
  pages | use --index N | use --match REGEX

Targets (for click/fill/press/wait/snapshot/text/screenshot)
  --role ROLE [--name NAME] [--exact] | --text T | --label L | --placeholder P | --testid ID | --selector CSS   [--nth N]
  scope: --within-role ROLE [--within-name NAME] | --within CSS      (e.g. the link inside the "Search results" list)

Drive                            (add --shot to screenshot the resulting state; --timeout MS)
  goto URL [--wait load|domcontentloaded|networkidle]
  click | dblclick | hover | focus | check | uncheck | scroll [--by DY]
  fill --value V | type --value V | press --key K | select --value V
  wait [target] [--state visible|hidden|attached|detached] | wait --url PATTERN | wait --load networkidle

Evidence
  snapshot [target] [--path FILE]           ARIA snapshot (accessibility tree, the agent-readable screen)
  screenshot [--path FILE] [--full] [target]
  text [target] | html [target] | eval --js EXPR   (read-only inspection)
  console [--level error|warning|log] [--since N] [--clear]
  network [--url-includes S] [--failed] [--since N]
  errors                                     page errors + console errors + failed requests
  metrics                                    navigation timing, LCP, CLS, long tasks, JS heap, DOM nodes
  note --text "..."                          marker line in timeline.jsonl
  verdict --claim "..." --result VERIFIED|"NOT VERIFIED"|INCONCLUSIVE --evidence "..." --reasoning "..."

Performance (Chrome DevTools Protocol)
  trace start [--screenshots] | trace stop [--path FILE]     Chrome trace JSON (open in DevTools > Performance)
  profile start | profile stop [--path FILE]                  CPU profile (.cpuprofile) + top self-time frames
  heap [--path FILE] [--gc]                                   heap snapshot (.heapsnapshot) + node count
  gc                                                          force garbage collection
  throttle [--cpu RATE] [--network none|fast3g|slow3g|offline]

All commands print JSON. Exit code 0 = ok. Every action is appended to <evidence>/timeline.jsonl.
Project state: ${PROJECT_DIR || "(none found; run init from the repo root)"}
`;
  process.stdout.write(text.trimStart());
}

// ---------- daemon ----------

async function runDaemon(opts) {
  const id = opts["run-id"];
  const cfg = JSON.parse(opts["config-json"]);
  const evidenceDir = path.join(cfg.evidenceDir, id);
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  let appProc = null;
  let profileDir = null;
  const fail = (error) => {
    log("FATAL", error);
    // Never strand what we started: the app process and the disposable profile go with us.
    if (appProc && appProc.exitCode === null) killTree(appProc.pid, "SIGTERM");
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    writeJson(SESSION_FILE, { status: "error", runId: id, evidenceDir, error: String(error?.message || error).replace(/\u001b\[[0-9;]*m/g, "") });
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);

  let pw;
  const resolved = resolvePlaywright();
  if (!resolved.file) return fail(`Playwright not found (looked in: ${resolved.tried.join(", ")}). Run: control setup   (installs it under ${USER_DEPS_DIR}; add --channel chrome to use your installed Chrome instead of downloading Chromium)`);
  try {
    const mod = await import(pathToFileURL(resolved.file).href);
    pw = mod.default?.chromium ? mod.default : mod;
    log("playwright from", resolved.from);
  } catch (e) {
    return fail(`Playwright at ${resolved.file} failed to load: ${e.message}`);
  }

  // --- app process ---
  const appLog = path.join(evidenceDir, "app.log");
  if (cfg.app?.command) {
    if (cfg.url && (await fetchStatus(cfg.url, 2000)).reachable) {
      return fail(`${cfg.url} already answers before the app was started, so another instance is running. Drive it with --no-app, or stop it first. Refusing to double-drive a shared instance.`);
    }
    const appFd = fs.openSync(appLog, "a");
    appProc = spawn(cfg.app.command, {
      shell: true,
      cwd: cfg.app.cwd || process.cwd(),
      detached: process.platform !== "win32",
      stdio: ["ignore", appFd, appFd],
      env: { ...process.env, ...(cfg.env || {}) },
    });
    log("app started", cfg.app.command, "pid", appProc.pid);
    if (cfg.url) {
      const deadline = Date.now() + (cfg.app.readyTimeoutMs ?? 90_000);
      let ready = false;
      while (Date.now() < deadline) {
        const s = await fetchStatus(cfg.url, 2000);
        if (s.reachable) {
          ready = true;
          break;
        }
        if (appProc.exitCode !== null) return fail(`App process exited with code ${appProc.exitCode} before ${cfg.url} answered. See ${appLog}`);
        await sleep(500);
      }
      if (!ready) return fail(`App did not answer at ${cfg.url} within ${cfg.app.readyTimeoutMs ?? 90_000}ms. See ${appLog}`);
      log("app ready at", cfg.url);
    }
  } else if (cfg.url && !cfg.cdp && !(await fetchStatus(cfg.url, 3000)).reachable) {
    return fail(`Nothing answers at ${cfg.url}. Start the app first, or set app.command in verify.config.json (or pass --app "cmd") so launch starts it.`);
  }

  // --- browser ---
  let browser, context, launched = false, cdpEndpoint = cfg.cdp || null, browserPid = null;
  if (cfg.cdp) {
    browser = await pw.chromium.connectOverCDP(cfg.cdp, { timeout: 15_000 });
    context = browser.contexts()[0] || (await browser.newContext({ viewport: cfg.viewport }));
    log("attached over CDP", cfg.cdp);
  } else {
    const cdpPort = await freePort();
    profileDir = path.join(RUN_DIR, `profile-${id}`);
    fs.mkdirSync(profileDir, { recursive: true });
    context = await pw.chromium.launchPersistentContext(profileDir, {
      headless: !cfg.headed,
      channel: cfg.channel || undefined,
      viewport: cfg.viewport,
      args: [`--remote-debugging-port=${cdpPort}`],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    browser = context.browser();
    launched = true;
    cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    try {
      browserPid = browser?.process?.()?.pid ?? null;
    } catch {}
    log("launched chromium, cdp at", cdpEndpoint);
  }

  // --- evidence buffers ---
  const consoleBuf = [];
  const networkBuf = [];
  const pageErrors = [];
  const consoleFile = path.join(evidenceDir, "console.jsonl");
  const networkFile = path.join(evidenceDir, "network.jsonl");
  const timelineFile = path.join(evidenceDir, "timeline.jsonl");
  const append = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + "\n");
  for (const f of [consoleFile, networkFile, timelineFile]) fs.closeSync(fs.openSync(f, "a")); // same layout in every run, even a quiet one
  let shotCounter = 0;
  const wired = new WeakSet();

  function wire(page) {
    if (wired.has(page)) return;
    wired.add(page);
    page.on("console", (msg) => {
      const loc = msg.location();
      const entry = { i: consoleBuf.length, ts: Date.now(), level: msg.type(), text: msg.text(), url: loc?.url, line: loc?.lineNumber };
      consoleBuf.push(entry);
      append(consoleFile, entry);
    });
    page.on("pageerror", (err) => {
      const entry = { i: pageErrors.length, ts: Date.now(), message: err.message, stack: err.stack };
      pageErrors.push(entry);
      append(consoleFile, { ...entry, level: "pageerror" });
    });
    page.on("response", async (res) => {
      const req = res.request();
      let durationMs = null;
      try {
        const t = req.timing();
        if (t && t.responseEnd >= 0) durationMs = Math.round(t.responseEnd);
      } catch {}
      const entry = { i: networkBuf.length, ts: Date.now(), method: req.method(), url: res.url(), status: res.status(), type: req.resourceType(), durationMs };
      networkBuf.push(entry);
      append(networkFile, entry);
    });
    page.on("requestfailed", (req) => {
      const entry = { i: networkBuf.length, ts: Date.now(), method: req.method(), url: req.url(), status: null, failed: req.failure()?.errorText || "failed", type: req.resourceType() };
      networkBuf.push(entry);
      append(networkFile, entry);
    });
  }
  context.on("page", wire);
  for (const p of context.pages()) wire(p);
  // Long tasks, layout shifts and LCP are only delivered to observers, never to getEntriesByType,
  // so install observers before any page script runs. `metrics` reads window.__verifyWeb.
  await context.addInitScript(() => {
    const s = (window.__verifyWeb = { longTasks: [], shifts: [], lcp: null, installedAt: performance.now() });
    const obs = (type, fn) => {
      try {
        new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true });
      } catch {}
    };
    obs("longtask", (e) => s.longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) }));
    obs("layout-shift", (e) => !e.hadRecentInput && s.shifts.push({ start: Math.round(e.startTime), value: e.value }));
    obs("largest-contentful-paint", (e) => (s.lcp = { start: Math.round(e.startTime), size: e.size, element: e.element?.tagName || null }));
  });

  let activePage = null;
  async function pickPage() {
    const pages = context.pages();
    if (cfg.marker) {
      for (const p of pages) {
        try {
          if ((await p.locator(cfg.marker).count()) > 0) return p;
        } catch {}
      }
    }
    return pages[0] || null;
  }
  if (launched) {
    activePage = context.pages()[0] || (await context.newPage());
    if (cfg.url) await activePage.goto(cfg.url, { waitUntil: "load", timeout: 60_000 });
  } else {
    activePage = await pickPage();
    if (!activePage) activePage = await context.newPage();
    if (cfg.url && activePage.url() === "about:blank") await activePage.goto(cfg.url, { waitUntil: "load", timeout: 60_000 });
  }

  const page = () => {
    if (!activePage || activePage.isClosed()) throw new Error("Active page is closed. Run: control pages, then control use --index N");
    return activePage;
  };

  function locatorFrom(a, { optional = false } = {}) {
    let p = page();
    const exact = !!a.exact;
    let loc = null, desc = null, scope = "";
    // Scope to a container first, so "the link inside the Search results list" is one command.
    if (a["within-role"]) {
      p = p.getByRole(a["within-role"], { name: a["within-name"], exact });
      scope = `within role=${a["within-role"]}${a["within-name"] ? ` name="${a["within-name"]}"` : ""} `;
    } else if (a.within) {
      p = p.locator(String(a.within));
      scope = `within ${a.within} `;
    }
    if (a.role) {
      loc = p.getByRole(a.role, { name: a.name, exact });
      desc = `role=${a.role}${a.name ? ` name="${a.name}"` : ""}`;
    } else if (a.text) {
      loc = p.getByText(String(a.text), { exact });
      desc = `text="${a.text}"`;
    } else if (a.label) {
      loc = p.getByLabel(String(a.label), { exact });
      desc = `label="${a.label}"`;
    } else if (a.placeholder) {
      loc = p.getByPlaceholder(String(a.placeholder), { exact });
      desc = `placeholder="${a.placeholder}"`;
    } else if (a.testid) {
      loc = p.getByTestId(String(a.testid));
      desc = `testid=${a.testid}`;
    } else if (a.selector) {
      loc = p.locator(String(a.selector));
      desc = `selector=${a.selector}`;
    }
    if (!loc) {
      if (optional) return scope ? { loc: p, desc: scope.trim() } : { loc: p.locator("body"), desc: "body" };
      throw new Error("target required: --role R [--name N] | --text T | --label L | --placeholder P | --testid ID | --selector CSS   (scope with --within-role R --within-name N, or --within CSS)");
    }
    if (a.nth !== undefined) {
      loc = loc.nth(Number(a.nth));
      desc += ` nth=${a.nth}`;
    }
    return { loc, desc: scope + desc };
  }

  const timeoutOf = (a) => Number(a.timeout ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT);

  async function pageState() {
    const p = page();
    return { url: p.url(), title: await p.title().catch(() => null) };
  }

  function evidencePath(sub, name) {
    const dir = path.join(evidenceDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  async function shot(label, a = {}) {
    shotCounter++;
    const file = a.path ? path.resolve(a.path) : evidencePath("shots", `${String(shotCounter).padStart(3, "0")}-${label.replace(/[^a-z0-9-]+/gi, "_").slice(0, 40)}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (a.role || a.text || a.label || a.placeholder || a.testid || a.selector) {
      const { loc } = locatorFrom(a);
      await loc.screenshot({ path: file, timeout: timeoutOf(a) });
    } else {
      await page().screenshot({ path: file, fullPage: !!a.full });
    }
    return file;
  }

  async function afterAction(a, label) {
    const state = await pageState();
    const out = { after: state };
    if (a.shot) out.screenshot = await shot(label, { full: a.full });
    return out;
  }

  // --- CDP helpers (perf) ---
  let cdpSession = null;
  async function cdp() {
    if (!cdpSession || cdpSession._page !== activePage) {
      cdpSession = await context.newCDPSession(page());
      cdpSession._page = activePage;
    }
    return cdpSession;
  }
  let tracing = null; // { startedAt }
  let profiling = null;

  function summarizeTrace(buf) {
    let events;
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      events = Array.isArray(parsed) ? parsed : parsed.traceEvents || [];
    } catch {
      return { note: "trace could not be parsed for a summary; open the file in DevTools > Performance" };
    }
    const tasks = events.filter((e) => (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && typeof e.dur === "number");
    const longTasks = tasks.filter((e) => e.dur > 50_000).sort((x, y) => y.dur - x.dur);
    const nav = events.find((e) => e.name === "navigationStart");
    const lcp = events.filter((e) => e.name === "largestContentfulPaint::Candidate").pop();
    const fcp = events.find((e) => e.name === "firstContentfulPaint");
    const shifts = events.filter((e) => e.name === "LayoutShift" && e.args?.data?.is_main_frame !== false);
    const cls = shifts.reduce((s, e) => s + (e.args?.data?.score || 0), 0);
    const toMs = (ts) => (nav && typeof ts === "number" ? Math.round((ts - nav.ts) / 1000) : null);
    return {
      events: events.length,
      tasks: tasks.length,
      longTasks: longTasks.length,
      longestTaskMs: longTasks[0] ? Math.round(longTasks[0].dur / 1000) : 0,
      totalLongTaskMs: Math.round(longTasks.reduce((s, e) => s + e.dur, 0) / 1000),
      fcpMs: fcp ? toMs(fcp.ts) : null,
      lcpMs: lcp ? toMs(lcp.ts) : null,
      layoutShifts: shifts.length,
      clsEstimate: Number(cls.toFixed(4)),
      note: "Counts come from the trace's RunTask events; open the file in DevTools > Performance for the flame chart.",
    };
  }

  function summarizeProfile(profile) {
    const self = new Map();
    const { samples = [], timeDeltas = [], nodes = [] } = profile;
    for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) || 0) + (timeDeltas[i] || 0));
    const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const top = [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id, us]) => {
        const n = byId.get(id);
        const cf = n?.callFrame || {};
        return { fn: cf.functionName || "(anonymous)", url: cf.url || "", line: cf.lineNumber, selfMs: Math.round(us / 1000), pct: Number(((us / total) * 100).toFixed(1)) };
      });
    return { totalMs: Math.round(total / 1000), samples: samples.length, topSelfTime: top };
  }

  // --- command handlers ---
  const handlers = {
    async doctor() {
      const p = activePage && !activePage.isClosed() ? activePage : null;
      const checks = {};
      checks.browserConnected = browser ? browser.isConnected() : !!context;
      checks.pages = context.pages().length;
      checks.activePage = p ? { url: p.url(), title: await p.title().catch(() => null) } : null;
      if (cfg.marker) checks.markerFound = p ? (await p.locator(cfg.marker).count().catch(() => 0)) > 0 : false;
      if (cfg.url) checks.appUrl = { url: cfg.url, ...(await fetchStatus(cfg.url)) };
      if (appProc) checks.appProcess = { pid: appProc.pid, alive: appProc.exitCode === null, log: appLog };
      if (cdpEndpoint) checks.cdp = { endpoint: cdpEndpoint, ...(await fetchStatus(cdpEndpoint + "/json/version")) };
      checks.consoleErrors = consoleBuf.filter((c) => c.level === "error").length;
      checks.pageErrors = pageErrors.length;
      checks.tracing = !!tracing;
      checks.profiling = !!profiling;
      const ok =
        checks.browserConnected &&
        !!p &&
        (cfg.marker ? checks.markerFound : true) &&
        (cfg.url ? checks.appUrl.reachable : true) &&
        (appProc ? checks.appProcess.alive : true);
      return { ok, runId: id, evidenceDir, mode: launched ? "launched" : "attached", ...checks };
    },
    async pages() {
      const out = [];
      for (const [i, p] of context.pages().entries()) out.push({ index: i, url: p.url(), title: await p.title().catch(() => null), active: p === activePage });
      return { pages: out };
    },
    async use(a) {
      const pages = context.pages();
      let p = null;
      if (a.index !== undefined) p = pages[Number(a.index)];
      else if (a.match) {
        const re = new RegExp(String(a.match), "i");
        for (const c of pages) if (re.test(c.url()) || re.test(await c.title().catch(() => ""))) p = c;
      } else if (cfg.marker) p = await pickPage();
      if (!p) throw new Error("No page matched. Run: control pages");
      activePage = p;
      cdpSession = null;
      return { active: await pageState() };
    },
    async goto(a) {
      const url = a._?.[0] || a.url;
      if (!url) throw new Error("goto needs a URL");
      const res = await page().goto(url, { waitUntil: a.wait || "load", timeout: Number(a.timeout ?? 60_000) });
      return { status: res?.status() ?? null, ...(await afterAction(a, "goto")) };
    },
    async click(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.click({ timeout: timeoutOf(a), button: a.button || "left" });
      return { target: desc, ...(await afterAction(a, "click")) };
    },
    async dblclick(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.dblclick({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "dblclick")) };
    },
    async hover(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.hover({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "hover")) };
    },
    async focus(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.focus({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "focus")) };
    },
    async check(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.check({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "check")) };
    },
    async uncheck(a) {
      const { loc, desc } = locatorFrom(a);
      await loc.uncheck({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "uncheck")) };
    },
    async fill(a) {
      if (a.value === undefined) throw new Error("fill needs --value");
      const { loc, desc } = locatorFrom(a);
      await loc.fill(String(a.value), { timeout: timeoutOf(a) });
      return { target: desc, value: String(a.value), ...(await afterAction(a, "fill")) };
    },
    async type(a) {
      if (a.value === undefined) throw new Error("type needs --value");
      const { loc, desc } = locatorFrom(a, { optional: true });
      if (desc === "body") await page().keyboard.type(String(a.value));
      else await loc.pressSequentially(String(a.value), { timeout: timeoutOf(a) });
      return { target: desc, value: String(a.value), ...(await afterAction(a, "type")) };
    },
    async press(a) {
      if (!a.key) throw new Error("press needs --key (e.g. Enter, Escape, Control+k, /)");
      const { loc, desc } = locatorFrom(a, { optional: true });
      if (desc === "body") await page().keyboard.press(String(a.key));
      else await loc.press(String(a.key), { timeout: timeoutOf(a) });
      return { target: desc, key: a.key, ...(await afterAction(a, "press")) };
    },
    async select(a) {
      if (a.value === undefined) throw new Error("select needs --value");
      const { loc, desc } = locatorFrom(a);
      const chosen = await loc.selectOption(String(a.value), { timeout: timeoutOf(a) });
      return { target: desc, selected: chosen, ...(await afterAction(a, "select")) };
    },
    async scroll(a) {
      if (a.by !== undefined) {
        await page().mouse.wheel(0, Number(a.by));
        return { by: Number(a.by), ...(await afterAction(a, "scroll")) };
      }
      const { loc, desc } = locatorFrom(a);
      await loc.scrollIntoViewIfNeeded({ timeout: timeoutOf(a) });
      return { target: desc, ...(await afterAction(a, "scroll")) };
    },
    async wait(a) {
      const t = Number(a.timeout ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT);
      if (a.url) {
        await page().waitForURL(new RegExp(String(a.url)), { timeout: t });
        return { waited: `url ~ ${a.url}`, ...(await afterAction(a, "wait")) };
      }
      if (a.load) {
        await page().waitForLoadState(String(a.load), { timeout: t });
        return { waited: `load=${a.load}`, ...(await afterAction(a, "wait")) };
      }
      if (a.ms) {
        await sleep(Number(a.ms));
        return { waited: `${a.ms}ms (fixed sleep; prefer a state or url wait)`, ...(await afterAction(a, "wait")) };
      }
      const { loc, desc } = locatorFrom(a);
      await loc.waitFor({ state: a.state || "visible", timeout: t });
      return { waited: `${desc} ${a.state || "visible"}`, ...(await afterAction(a, "wait")) };
    },
    async snapshot(a) {
      const { loc, desc } = locatorFrom(a, { optional: true });
      const aria = await loc.ariaSnapshot({ timeout: timeoutOf(a) });
      const file = a.path ? path.resolve(a.path) : evidencePath("snapshots", `${String(++shotCounter).padStart(3, "0")}-aria.txt`);
      const state = await pageState();
      fs.writeFileSync(file, `# ${state.title}\n# ${state.url}\n# target: ${desc}\n\n${aria}\n`);
      const truncated = aria.length > MAX_INLINE_CHARS;
      return { target: desc, path: file, page: state, truncated, aria: truncated ? aria.slice(0, MAX_INLINE_CHARS) + "\n…[truncated; full snapshot in file]" : aria };
    },
    async screenshot(a) {
      const file = await shot(a.label || "screenshot", a);
      return { path: file, page: await pageState() };
    },
    async text(a) {
      const { loc, desc } = locatorFrom(a, { optional: true });
      const text = await loc.innerText({ timeout: timeoutOf(a) });
      const truncated = text.length > MAX_INLINE_CHARS;
      return { target: desc, truncated, text: truncated ? text.slice(0, MAX_INLINE_CHARS) : text };
    },
    async html(a) {
      const { loc, desc } = locatorFrom(a, { optional: true });
      const html = await loc.evaluate((el) => el.outerHTML);
      const truncated = html.length > MAX_INLINE_CHARS;
      return { target: desc, truncated, html: truncated ? html.slice(0, MAX_INLINE_CHARS) : html };
    },
    async eval(a) {
      const js = a.js || a._?.[0];
      if (!js) throw new Error("eval needs --js EXPR (read-only inspection, not state injection)");
      const value = await page().evaluate(js);
      return { js, value };
    },
    async console(a) {
      let items = consoleBuf;
      if (a.since !== undefined) items = items.filter((c) => c.i >= Number(a.since));
      if (a.level) items = items.filter((c) => c.level === a.level);
      const out = { count: items.length, next: consoleBuf.length, file: consoleFile, entries: items.slice(-200), pageErrors: pageErrors.slice(-50) };
      if (a.clear) {
        consoleBuf.length = 0;
        pageErrors.length = 0;
      }
      return out;
    },
    async network(a) {
      let items = networkBuf;
      if (a.since !== undefined) items = items.filter((c) => c.i >= Number(a.since));
      if (a["url-includes"]) items = items.filter((c) => c.url.includes(String(a["url-includes"])));
      if (a.failed) items = items.filter((c) => c.failed || (c.status && c.status >= 400));
      return { count: items.length, next: networkBuf.length, file: networkFile, entries: items.slice(-200) };
    },
    async errors() {
      return {
        pageErrors,
        consoleErrors: consoleBuf.filter((c) => c.level === "error"),
        failedRequests: networkBuf.filter((c) => c.failed || (c.status && c.status >= 400)),
      };
    },
    async metrics() {
      const s = await cdp();
      await s.send("Performance.enable");
      const { metrics } = await s.send("Performance.getMetrics");
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      const vitals = await page().evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
        const s = window.__verifyWeb;
        return {
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
          ttfbMs: nav ? Math.round(nav.responseStart) : null,
          fcpMs: paints["first-contentful-paint"] ?? null,
          lcpMs: s?.lcp?.start ?? null,
          lcpElement: s?.lcp?.element ?? null,
          cls: s ? Number(s.shifts.reduce((a, e) => a + e.value, 0).toFixed(4)) : null,
          longTasks: s ? s.longTasks.length : null,
          longestTaskMs: s ? Math.max(0, ...s.longTasks.map((l) => l.duration)) : null,
          longTaskList: s ? s.longTasks.slice(-10) : null,
          note: s ? "observers installed by the harness at document start" : "observers missing (page loaded before the harness attached); run goto to reload, or use trace",
        };
      });
      return {
        page: await pageState(),
        vitals,
        runtime: { jsHeapUsedMB: Number((m.JSHeapUsedSize / 1048576).toFixed(1)), jsHeapTotalMB: Number((m.JSHeapTotalSize / 1048576).toFixed(1)), domNodes: m.Nodes, jsEventListeners: m.JSEventListeners, layoutCount: m.LayoutCount, recalcStyleCount: m.RecalcStyleCount, documents: m.Documents, frames: m.Frames },
      };
    },
    async note(a) {
      return { note: a.text || a._?.join(" ") };
    },
    async verdict(a) {
      const result = String(a.result || "").toUpperCase();
      if (!["VERIFIED", "NOT VERIFIED", "INCONCLUSIVE"].includes(result)) throw new Error('verdict needs --result VERIFIED | "NOT VERIFIED" | INCONCLUSIVE');
      if (!a.claim) throw new Error("verdict needs --claim");
      const artifacts = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else artifacts.push(path.relative(evidenceDir, f));
        }
      };
      walk(evidenceDir);
      const body = `${result}\nClaim: ${a.claim}\n\nEvidence:\n${a.evidence || "(none given)"}\n\nReasoning:\n${a.reasoning || "(none given)"}\n\nRun: ${id}\nArtifacts:\n${artifacts.map((f) => `- ${f}`).join("\n")}\n`;
      const file = path.join(evidenceDir, "verdict.md");
      fs.writeFileSync(file, body);
      return { result, path: file, artifacts: artifacts.length };
    },
    async trace(a) {
      const sub = a._?.[0];
      if (sub === "start") {
        if (tracing) throw new Error("trace already running");
        await browser.startTracing(page(), { screenshots: !!a.screenshots, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "loading", "blink.user_timing", "v8.execute", "toplevel", "disabled-by-default-v8.cpu_profiler"] });
        tracing = { startedAt: Date.now() };
        return { tracing: true };
      }
      if (sub === "stop") {
        if (!tracing) throw new Error("no trace running");
        const buf = await browser.stopTracing();
        const file = a.path ? path.resolve(a.path) : evidencePath("perf", `trace-${Date.now()}.json`);
        fs.writeFileSync(file, buf);
        const durationMs = Date.now() - tracing.startedAt;
        tracing = null;
        return { path: file, bytes: buf.length, durationMs, summary: summarizeTrace(buf) };
      }
      throw new Error("trace start | trace stop [--path FILE]");
    },
    async profile(a) {
      const sub = a._?.[0];
      const s = await cdp();
      if (sub === "start") {
        if (profiling) throw new Error("profile already running");
        await s.send("Profiler.enable");
        await s.send("Profiler.setSamplingInterval", { interval: Number(a.interval ?? 500) });
        await s.send("Profiler.start");
        profiling = { startedAt: Date.now() };
        return { profiling: true };
      }
      if (sub === "stop") {
        if (!profiling) throw new Error("no profile running");
        const { profile } = await s.send("Profiler.stop");
        const file = a.path ? path.resolve(a.path) : evidencePath("perf", `cpu-${Date.now()}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile));
        profiling = null;
        return { path: file, summary: summarizeProfile(profile) };
      }
      throw new Error("profile start | profile stop [--path FILE]");
    },
    async heap(a) {
      const s = await cdp();
      await s.send("HeapProfiler.enable");
      if (a.gc) await s.send("HeapProfiler.collectGarbage");
      const chunks = [];
      const onChunk = (e) => chunks.push(e.chunk);
      s.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
      await s.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      s.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      const data = chunks.join("");
      const file = a.path ? path.resolve(a.path) : evidencePath("perf", `heap-${Date.now()}.heapsnapshot`);
      fs.writeFileSync(file, data);
      let nodeCount = null, edgeCount = null;
      try {
        const meta = JSON.parse(data).snapshot;
        nodeCount = meta.node_count;
        edgeCount = meta.edge_count;
      } catch {}
      const { metrics } = await (async () => {
        await s.send("Performance.enable");
        return s.send("Performance.getMetrics");
      })();
      const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
      return { path: file, bytes: data.length, nodeCount, edgeCount, jsHeapUsedMB: used ? Number((used / 1048576).toFixed(1)) : null, note: "Compare two snapshots in DevTools > Memory to follow retainer chains." };
    },
    async gc() {
      const s = await cdp();
      await s.send("HeapProfiler.enable");
      await s.send("HeapProfiler.collectGarbage");
      return { gc: true };
    },
    async throttle(a) {
      const s = await cdp();
      const out = {};
      if (a.cpu !== undefined) {
        await s.send("Emulation.setCPUThrottlingRate", { rate: Number(a.cpu) });
        out.cpu = Number(a.cpu);
      }
      if (a.network) {
        const presets = {
          none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
          fast3g: { offline: false, latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
          slow3g: { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
          offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
        };
        const p = presets[a.network];
        if (!p) throw new Error("--network none|fast3g|slow3g|offline");
        await s.send("Network.enable");
        await s.send("Network.emulateNetworkConditions", p);
        out.network = a.network;
      }
      return out;
    },
    async cleanup(a) {
      const out = { stopped: [] };
      if (tracing) {
        try {
          const buf = await browser.stopTracing();
          fs.writeFileSync(evidencePath("perf", `trace-${Date.now()}-at-cleanup.json`), buf);
          out.stopped.push("trace (saved)");
        } catch {}
      }
      if (profiling) {
        try {
          const s = await cdp();
          const { profile } = await s.send("Profiler.stop");
          fs.writeFileSync(evidencePath("perf", `cpu-${Date.now()}-at-cleanup.cpuprofile`), JSON.stringify(profile));
          out.stopped.push("profile (saved)");
        } catch {}
      }
      setTimeout(() => shutdown(a?.reason || "cleanup").catch(() => process.exit(0)), 50);
      return { ...out, evidenceDir, evidenceKept: true };
    },
  };

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown:", reason);
    try {
      // A wedged renderer must not keep the app process alive: hard deadline, then SIGKILL what we launched.
      const close = launched ? context.close() : browser.close(); // close() on an attached browser only disconnects
      const timedOut = await Promise.race([close.then(() => false), sleep(8000).then(() => true)]);
      if (timedOut && launched && browserPid) killTree(browserPid, "SIGKILL");
    } catch (e) {
      log("browser close error", e.message);
    }
    if (appProc && appProc.exitCode === null) {
      killTree(appProc.pid, "SIGTERM");
      await sleep(1500);
      if (appProc.exitCode === null) killTree(appProc.pid, "SIGKILL");
    }
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    writeJson(SESSION_FILE, { status: "stopped", runId: id, evidenceDir, stoppedAt: new Date().toISOString(), reason });
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  if (browser) browser.on("disconnected", () => shutdown("browser disconnected"));

  // --- control server ---
  let busy = Promise.resolve();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/cmd") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      busy = busy.then(async () => {
        let payload = {};
        let result;
        const t0 = Date.now();
        try {
          payload = JSON.parse(body || "{}");
          const h = handlers[payload.cmd];
          if (!h) throw new Error(`Unknown command: ${payload.cmd}. Run: control help`);
          result = { ok: true, ...(await h(payload.args || {})) };
        } catch (e) {
          result = { ok: false, error: String(e?.message || e).replace(/\u001b\[[0-9;]*m/g, "") };
        }
        const { js, value, aria, html, text, entries, ...slim } = result;
        append(timelineFile, { ts: new Date().toISOString(), ms: Date.now() - t0, cmd: payload.cmd, args: payload.args, ...slim });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    writeJson(SESSION_FILE, {
      status: "ready",
      runId: id,
      pid: process.pid,
      browserPid,
      appPid: appProc?.pid ?? null,
      controlPort: port,
      cdpEndpoint,
      mode: launched ? "launched" : "attached",
      url: cfg.url,
      evidenceDir,
      profileDir,
      startedAt: new Date().toISOString(),
    });
    append(timelineFile, { ts: new Date().toISOString(), cmd: "launch", mode: launched ? "launched" : "attached", url: cfg.url, cdpEndpoint, app: cfg.app?.command || null });
    log("ready on control port", port);
  });
}

// ---------- entry ----------

const argv = parseArgs(process.argv.slice(2));
const cmd = argv._.shift();
if (!cmd || cmd === "help" || cmd === "--help") help();
else if (cmd === "init") clientInit(argv);
else if (cmd === "setup") clientSetup(argv);
else if (cmd === "__daemon") runDaemon(argv);
else if (!requireProject()) process.exit(1);
else if (cmd === "launch") clientLaunch(argv);
else if (cmd === "cleanup") clientCleanup(argv);
else {
  const { _, ...rest } = argv;
  send(cmd, { _, ...rest }).then((r) => print(r, r.ok ? 0 : 1));
}
