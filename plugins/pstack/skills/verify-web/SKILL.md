---
name: verify-web
description: "Drive the running web app the way a user does and capture evidence that a change works: launch or attach over Chrome DevTools Protocol, click and type by accessible role, take ARIA snapshots and screenshots, read console and network, record traces, CPU profiles and heap snapshots, then return a VERIFIED / NOT VERIFIED / INCONCLUSIVE verdict. Use this whenever you have changed UI, routing, forms, state, rendering or performance in a web app and are about to say it works, whenever a bug report or screenshot needs reproducing, whenever a perf or memory claim needs numbers, whenever a task says verify, prove, show evidence, repro, or does it still work, and whenever a repo needs its project verify skill set up (/verify-web, \"set up verification for this repo\", \"make a control skill\"). Passing tests and a clean build are not evidence that the feature works for a user; this skill is."
---

# verify-web

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

A maintained harness so every agent drives the app the same way instead of improvising a script each session. Two halves: `scripts/control`, a CLI over Playwright and the Chrome DevTools Protocol that ships with this plugin, and a per-repo feature map that says how a user reaches each feature and what observable state proves it works. Read the map before driving. Append to it when you learn something it lacks.

Correctness is "does the checkout button check out the cart". That is what this skill proves. Code quality and performance budgets are separate questions; the perf commands here give you the numbers, the judgment lives in [perf-evidence.md](references/perf-evidence.md).

## Where things live

The harness (`scripts/control.mjs`, this file, `references/`, `templates/`) lives in the plugin and is shared by every repo. Each repo keeps its own state at `.claude/skills/verify/`: a short project `verify` skill, `verify.config.json`, `features/`, run state and `evidence/`. That is the path pstack's playbooks look for, so once a repo is initialized, every playbook that says "verify on the same surface" routes here. The CLI finds the repo's state by walking up from the working directory; run it from anywhere inside the repo.

Run the CLI through the repo's shim once initialized: `.claude/skills/verify/scripts/control <cmd>` from the repo root (`scripts/control <cmd>` from inside that directory). Before initialization, run this plugin's copy by its full path: it is `scripts/control` beside this SKILL.md; if you do not know the plugin's install path, `find ~/.claude/plugins -path '*/skills/verify-web/scripts/control.mjs' | head -1` prints it.

## Setup, once per repo

1. From the repo root: `<plugin>/scripts/control init --url http://127.0.0.1:3000 --app "npm run dev" --marker "#app"`. It writes `.claude/skills/verify/` with the project skill, the config, the feature-map templates and the shim. Fill in what you could not pass as flags by reading the repo: the real dev command, the port, a selector only this app renders, disposable data settings in `env`. Leave `app` null when the user prefers to start the app themselves.
2. If the repo has no Playwright: `control setup` installs it under `~/.claude/verify-web/` with Chromium, once per machine. `control setup --channel chrome` skips the download and uses the installed Chrome; then set `"channel": "chrome"` in the config. The harness also finds a Playwright already in the repo or installed globally.
3. Seed `features/` from `TEMPLATE.md`: the top 3 to 5 user-facing features, from routes, menus, commands or docs, each with every entry point a user has. Delete `example-create-note.md` once there is a real entry. The map is written for an agent that will read it cold, mid-task, having never seen the app.
4. Prove it once: launch, doctor, drive one mapped feature, cleanup, confirm `evidence/<run-id>/` survived. A harness that has never been run is a draft, not a deliverable.

Commit `.claude/skills/verify/` except `.run/` and `evidence/` (the generated `.gitignore` already excludes them).

## The loop

**Launch.** `control launch` starts the app from config and a disposable Chromium with a live CDP endpoint, then opens the URL. To drive an instance you already started: `launch --no-app`. To attach to an Electron app or a Chrome started with `--remote-debugging-port=9222`: `launch --cdp http://127.0.0.1:9222 --marker "#app-root"`. Launch refuses to start the app when something already answers at the URL, because driving a shared instance corrupts whoever else is using it. `--headed` shows the browser.

**Doctor.** `control doctor` answers "is this instance worth driving": browser connected, active page, marker present, app URL answering, app process alive, CDP endpoint live, error counts so far. Run it first, again after anything surprising, and after any failed drive. A failing doctor means stop and fix the instance, not retry the drive.

**Read the map.** Open `features/README.md` in the repo's verify directory, then the feature file that matches the request. It names the user entry points, the exact control commands, the expected end state, and the gotchas that waste runs. When a request does not match any feature file, you are about to guess; say so, drive from the UI you can see, and add the feature file afterwards.

**Drive.** One action per command, by accessible role and name wherever possible:

```
control click --role button --name "New note" --shot
control fill --role textbox --name "Title" --value "Release checklist"
control press --key Enter
control wait --role status --timeout 5000
control snapshot --role list --name "Notes list"
```

Targets: `--role R --name N [--exact]`, `--text T`, `--label L`, `--placeholder P`, `--testid ID`, `--selector CSS`, plus `--nth N`. Scope to a container with `--within-role list --within-name "Search results"` (or `--within CSS`) when the same name exists elsewhere on the page. Use `--selector` only when no accessible handle exists, and never a generated class name. `goto`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `type`, `select`, `scroll` work the same way. `wait` takes a target with `--state visible|hidden|attached|detached`, or `--url REGEX`, or `--load networkidle`; a fixed `--ms` sleep is the last resort and the result says so.

**Observe.** `snapshot` is the agent-readable screen: the accessibility tree, with the page title and URL at the top of the saved file. Prefer it over screenshots for assertions; take `screenshot` for the human reviewer and for anything visual. `text` and `html` read one element. `console`, `network --failed`, `errors` return what the daemon collected since launch. `eval --js` is for read-only inspection (reading `localStorage`, a store value, a count), never for putting the app into the state you were asked to reach.

**Capture evidence** per [proof-standards.md](references/proof-standards.md). The short version: drive the real user path, capture the action and the resulting state, confirm side effects from a second read-only view, keep the app identity visible, and never report a path you skipped as verified through another path.

**Verdict.** Restate the claim falsifiably, then write it down:

```
control verdict --claim "Saving a note adds it to the list and persists across reload" \
  --result VERIFIED --evidence "snapshots/004-aria.txt lists it; eval localStorage read-back; shots/003-click.png" \
  --reasoning "Real path New note > fill > Save; list and storage both show it; reload re-rendered it."
```

`verdict.md` lands in the evidence directory with the full artifact list. Report exactly one of `VERIFIED`, `NOT VERIFIED`, `INCONCLUSIVE`. A clean `NOT VERIFIED` is a useful result; a confident reply without evidence is the failure mode this skill exists to prevent.

**Cleanup.** `control cleanup` stops the browser profile, the app process and the daemon it started, by recorded PID only, and keeps `evidence/<run-id>/`. Run it after every attempt, including failed ones, so nothing strands a port. `cleanup --force` kills by recorded PIDs when the daemon stopped answering. In attach mode it only disconnects.

## Performance evidence

Chrome DevTools Protocol, through the same daemon, so a capture can span several commands:

```
control trace start            # ... drive the slow interaction ...
control trace stop             # Chrome trace JSON + long task count, longest task, FCP/LCP, CLS estimate
control profile start          # ... drive ...
control profile stop           # .cpuprofile + top self-time functions with file and line
control heap --gc              # .heapsnapshot + node count; take one before and one after the suspect operation
control metrics                # LCP, CLS, long tasks (observers installed at document start), JS heap, DOM nodes
control throttle --cpu 4 --network fast3g
```

Compare against a baseline captured the same way on the same machine, or the number means nothing. Recipes, thresholds and how to read the files are in [perf-evidence.md](references/perf-evidence.md).

## Gotchas that waste runs

A target that matches two elements fails with a strict mode violation that lists both, with scoped alternatives; scope with `--within-role` rather than `--nth`, because `--nth` silently picks the wrong one when the order changes. The reverse trap is quieter: a `wait` for `link "Quarterly plan"` can be satisfied by the notes list behind the dialog, not the search result you meant, so wait and snapshot inside the region that should change. Modal dialogs intercept clicks; the error names the intercepting element, so close the dialog through its own control instead of force-clicking. Debounced UIs need `wait` on the result state, not a sleep. Keyboard shortcuts fire differently when an input has focus; the feature map records which. Headless Chromium has no GPU and a different viewport than the user; say so when a visual claim depends on it. Perf numbers from a single cold run include JIT warmup; repeat the interaction once before measuring. A `wait` that times out on a `--text` target usually means the text is split across elements; use the role instead.

## When the browser harness is the wrong tool

A CLI change needs a terminal transcript (tmux or a PTY script), an API change needs the request and response, a parser needs a replayed input, a storage change needs the written value read back. The proof standards and the verdict format in [proof-standards.md](references/proof-standards.md) apply unchanged; only the capture tool differs. Say which surface you proved on.

## Keeping it honest

The feature map rots as the app changes. When a mapped recipe fails for a reason that is not a product bug, fix the map in the same change. Periodically run `/maintain-verification-skill`: every feature file read against source, one live session driving every feature, at most one PR of proven map and harness corrections. Never edit product code during that pass, and report a real regression instead of rewriting the map around it. Where each agent correction belongs in the wider process, and how trust is earned level by level, is in [trust-ladder.md](references/trust-ladder.md).
