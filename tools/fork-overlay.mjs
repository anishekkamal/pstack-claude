#!/usr/bin/env node
// fork-overlay.mjs: re-apply this fork's identity and its verify-web wiring after a merge from
// michael-denyer/pstack-claude. Every step is idempotent, so it is safe to run on any tree.
//
// What the fork changes beyond adding plugins/pstack/skills/verify-web and docs/verify-web.md:
//   manifests      owner, author, homepage, repository, keywords, a description suffix
//   poteto-mode    the driver line names the verify-web harness behind the project verify skill
//   docs/reference the verify-web row in the slash table and the skill counts
//   create-verification-skill, codex-tools  one paragraph / one row pointing at the harness
//   .gitignore     the harness's optional local Playwright install
// CHANGES.md and VERSION follow upstream; fork notes live in CHANGES-fork.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FORK = { name: "Anishek Kamal", url: "https://github.com/anishekkamal" };
const REPO = "https://github.com/anishekkamal/pstack-claude";
const SUFFIX = " This fork adds the verify-web harness. Port by Michael Denyer.";
const KEYWORDS = ["verification", "chrome-devtools-protocol", "playwright"];
const changed = [];

function readJson(p) {
  return JSON.parse(readFileSync(join(ROOT, p), "utf8"));
}
function writeIfChanged(p, text) {
  const abs = join(ROOT, p);
  if (readFileSync(abs, "utf8") !== text) {
    writeFileSync(abs, text);
    changed.push(p);
  }
}
function edit(p, fn) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) return;
  const before = readFileSync(abs, "utf8");
  const after = fn(before);
  if (after !== before) {
    writeFileSync(abs, after);
    changed.push(p);
  }
}
function identity(d, { marketplace = false, pi = false } = {}) {
  if (marketplace) {
    d.name = "pstack-anishek";
    d.owner = { ...FORK };
    d.description = "Anishek's fork of the Claude Code port of poteto's pstack: rigorous agent workflows plus the verify-web harness (Chrome DevTools Protocol verification with a per-repo feature map).";
    return d;
  }
  d.author = { ...FORK };
  d.homepage = REPO;
  d.repository = REPO;
  if (d.description && !d.description.includes("verify-web")) d.description = d.description.trimEnd() + SUFFIX;
  const base = (d.keywords || []).filter((k) => !KEYWORDS.includes(k));
  d.keywords = pi ? ["pi-package", ...base.filter((k) => k !== "pi-package"), ...KEYWORDS] : [...base, ...KEYWORDS];
  return d;
}

// 1. manifests
for (const [p, opts] of [
  ["plugins/pstack/.claude-plugin/plugin.json", {}],
  ["plugins/pstack/.codex-plugin/plugin.json", {}],
  ["package.json", { pi: true }],
  [".claude-plugin/marketplace.json", { marketplace: true }],
]) {
  if (!existsSync(join(ROOT, p))) continue;
  writeIfChanged(p, JSON.stringify(identity(readJson(p), opts), null, 2) + "\n");
}
edit(".agents/plugins/marketplace.json", (t) => {
  const d = JSON.parse(t);
  d.name = "pstack-anishek";
  return JSON.stringify(d, null, 2) + "\n";
});
// the Claude plugin manifest carries the fork's documentation links too
edit("plugins/pstack/.claude-plugin/plugin.json", (t) => {
  const d = JSON.parse(t);
  d.documentationUrl = `${REPO}/blob/main/docs/reference.md`;
  d.supportUrl = `${REPO}/issues`;
  return JSON.stringify(d, null, 2) + "\n";
});

// 2. poteto-mode driver line
edit("plugins/pstack/skills/poteto-mode/SKILL.md", (t) =>
  t.replace(
    "(generate it with `/create-verification-skill`) and fall back to `run` when the repo has none.",
    "(generate it with `/create-verification-skill`; for a web or Electron app that step runs the plugin's `verify-web` harness, whose `control init` writes the project skill) and fall back to `run` when the repo has none.",
  ),
);

// 3. docs/reference.md: the slash-table row and the counts
edit("docs/reference.md", (t) => {
  const row = "| `/verify-web` | drive the running web app over Chrome DevTools Protocol, capture evidence and perf captures, return a verdict; `control init` sets a repo up |";
  if (!t.includes("| `/verify-web` |")) {
    const anchor = t.split("\n").findIndex((l) => l.startsWith("| `/create-verification-skill` |"));
    if (anchor >= 0) {
      const lines = t.split("\n");
      lines.splice(anchor + 1, 0, row);
      t = lines.join("\n");
    }
  }
  const dirs = readdirSync(join(ROOT, "plugins/pstack/skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const principles = dirs.filter((n) => n.startsWith("principle-")).length;
  return t.replace(/\d+ skill directories: \d+ public skills and \d+ `principle-\*` references/, `${dirs.length} skill directories: ${dirs.length - principles} public skills and ${principles} \`principle-*\` references`);
});

// 4. create-verification-skill: point web and Electron surfaces at the harness
edit("plugins/pstack/skills/create-verification-skill/SKILL.md", (t) => {
  if (t.includes("`verify-web` skill ships one")) return t;
  return (
    t.trimEnd() +
    "\n\nWhen the surface is a web UI or an Electron app, do not hand-write the harness: the plugin's `verify-web` skill ships one. Run its `scripts/control init --url <url> --app \"<dev command>\" --marker \"<selector>\"` from the repo root; it writes `.claude/skills/verify/` (the project `verify` skill, `verify.config.json`, the feature-map templates and `scripts/control` shims). Then fill in the feature files and run `scripts/control doctor`. Keep the rest of this skill for every other surface.\n"
  );
});

// 5. codex-tools.md: the verify-web row
edit("plugins/pstack/skills/poteto-mode/references/codex-tools.md", (t) => {
  if (t.includes("| `verify-web` |")) return t;
  const lines = t.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (l.startsWith("| `")) last = i;
  });
  if (last < 0) return t;
  lines.splice(last + 1, 0, "| `verify-web` | The harness is a Node CLI; invoke `scripts/control` through `shell`. `control init` writes the project skill under `.claude/skills/verify/` for Claude Code; pass `--root` and copy the result to Codex's project-skill location, and set `VERIFY_WEB_PLAYWRIGHT` if Playwright lives somewhere other than `~/.claude/verify-web`. |");
  return lines.join("\n");
});

// 6. .gitignore
edit(".gitignore", (t) => {
  if (t.includes("plugins/pstack/skills/verify-web/scripts/node_modules/")) return t;
  return t.trimEnd() + "\n\n# npm deps if someone installs Playwright beside the verify-web harness (control setup prefers ~/.claude/verify-web)\nplugins/pstack/skills/verify-web/scripts/node_modules/\nplugins/pstack/skills/verify-web/scripts/package-lock.json\n";
});

console.log(changed.length ? `fork overlay: updated ${changed.join(", ")}` : "fork overlay: nothing to change");
