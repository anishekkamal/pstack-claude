# verify-web: evidence before "it works"

This guide covers installing the plugin, setting up a repo, the daily loop with poteto-mode, the performance workflow, and the process for turning agent corrections into a more trustworthy environment. The skill itself is at [`plugins/pstack/skills/verify-web/`](../plugins/pstack/skills/verify-web/SKILL.md); its `references/` directory holds the proof standards, the perf recipes and the trust ladder in full.

## Why this exists

Lauren Tan (poteto) shipped two thousand pull requests in a month and attributes it to trust: an environment set up so that agents produce verifiable work by default. Her first building block was a control skill with two halves. A maintained CLI inside the skill directory drives the running app over the Chrome DevTools Protocol and collects empirical evidence, so agents never improvise a harness script that differs from one session to the next. A feature map records, from the user's point of view, how every feature is reached and what observable state proves it works, so a vague bug report with a cropped screenshot becomes a reproducible drive.

The port's `/create-verification-skill` describes that shape but leaves the CLI to each agent. `verify-web` ships the CLI, keeps the feature map in the repo at the path poteto-mode already looks for, and adds the perf captures she used for the Cursor performance work.

## Install everything together

Claude Code:

```text
/plugin marketplace add anishekkamal/pstack-claude
/plugin install pstack@pstack-anishek
```

Codex:

```shell
codex plugin marketplace add anishekkamal/pstack-claude
codex plugin add pstack@pstack-anishek
```

The marketplace is named `pstack-anishek` so it can sit beside the upstream port if you also have that one. The plugin name stays `pstack`, so every skill is `/pstack:<name>` as before and nothing in your existing prompts changes. Run `/pstack:setup-pstack` once if you want model or effort overrides; it is not required for verification.

Requirements on the machine: Node 18 or newer, and a Chromium. `control setup` installs Playwright and Chromium under `~/.claude/verify-web/` once; `control setup --channel chrome` skips the download and uses the installed Chrome. The harness also finds a Playwright already present in the repo or installed globally, so a project that has Playwright needs nothing.

## Set up a repo (ten minutes)

From the repo root, ask the agent:

```text
/pstack:verify-web set up verification for this repo
```

Or run the scaffold yourself. The plugin's copy of the CLI is at `skills/verify-web/scripts/control` inside the installed plugin directory; `find ~/.claude/plugins -path '*/skills/verify-web/scripts/control.mjs'` prints it.

```shell
<plugin>/scripts/control init --url http://127.0.0.1:3000 --app "npm run dev" --marker "#app"
```

That writes `.claude/skills/verify/`:

| File | What it is |
| --- | --- |
| `SKILL.md` | The project `verify` skill. Short, and it replaces Claude Code's bundled `/verify` so poteto-mode can call it. |
| `verify.config.json` | URL, how the app starts, a marker selector only this app renders, viewport, timeouts, env for disposable data. |
| `features/README.md` | The feature map index and the proof conventions. |
| `features/TEMPLATE.md` | The shape of a feature file: sub-features, user entry points, exact drive commands, gotchas. |
| `features/example-create-note.md` | A worked example from the sample app the harness was proven against. Delete it once you have a real entry. |
| `scripts/control` | A shim to the plugin's CLI, so the project skill can say `scripts/control` regardless of where the plugin is installed. |
| `.gitignore` | Excludes `.run/` and `evidence/`. Commit the rest. |

Then do three things, in this order:

1. Fill the config honestly. The marker matters: doctor refuses to drive a page that lacks it, which is what keeps an agent from driving the wrong tab or a production instance. Point `env` at disposable data (a scratch database, a temp data directory, a test account) so no run touches real user data.
2. Write the first three feature files from the template, one per user-facing feature, with every entry point a user has (button, keyboard shortcut, route). Write them for an agent that will read them cold, mid-task, having never seen the app. Implementation details stay out; user paths, stable handles, exact commands and observable proof stay in.
3. Prove it once: `scripts/control launch`, `doctor`, drive one feature, `cleanup`, and confirm `evidence/<run-id>/` is still there. A harness that has never been run is a draft.

## The daily loop

State the finish condition in the prompt, then ask for evidence. The agent has checks to run instead of a mood to satisfy:

```text
/pstack:poteto-mode add a "Export CSV" button to the transactions page. Clicking it downloads a file
with the visible rows; the page has no new console errors; verify-web proves it and shows me the verdict.
```

What happens underneath, from the agent's side:

```text
scripts/control launch                     # starts the app and a disposable Chromium with a live CDP endpoint
scripts/control doctor                     # browser, page, marker, URL, app process, CDP all healthy
# reads features/README.md and features/transactions.md
scripts/control click --role button --name "Export CSV" --shot
scripts/control wait --role status
scripts/control network --url-includes export   # the download request and its status
scripts/control console --level error            # nothing new
scripts/control snapshot --role table --name "Transactions"
scripts/control verdict --claim "Export CSV downloads the visible rows with no console errors" \
  --result VERIFIED --evidence "network: GET /export 200 text/csv; console: 0 errors; shots/001-click.png" \
  --reasoning "Real path, response observed, snapshot shows the same rows."
scripts/control cleanup
```

The reply quotes the verdict and the decisive artifact. `evidence/<run-id>/` holds `timeline.jsonl` (every command and outcome), `console.jsonl`, `network.jsonl`, `app.log`, `shots/`, `snapshots/`, `perf/` and `verdict.md`. Read the evidence, not just the diff, until you have reason to trust the verdicts; the trust ladder below says how to decide when that is.

poteto-mode's playbooks route here without being told: bug fix reproduces first on the same surface through the project `verify` skill, feature and refactor playbooks verify there before declaring done, and shipping independently re-proves each PR. `/pstack:maintain-verification-skill` audits the feature map when the app has drifted: one read-only source reader per feature, one live pass, at most one PR of proven corrections, never a product edit.

## Reproducing a bug report

A report says "search shows nothing, see screenshot". With a feature map the agent opens `features/search.md`, sees three entry points (toolbar button, `/` shortcut, URL query), and drives each with the query from the screenshot. It either reproduces on one of them and hands the bug-fix playbook a failing drive, or reports `verified-unreachable` with the entry point attempted and the precondition it could not arrange. Without the map, it guesses.

## Performance evidence

The same daemon captures over the Chrome DevTools Protocol, so a trace can span several commands:

```text
scripts/control throttle --cpu 4            # same on baseline and treatment, or the numbers mean nothing
scripts/control trace start
scripts/control click --role tab --name "Accounts"
scripts/control wait --role table --name "Accounts"
scripts/control trace stop                  # long tasks, longest task, FCP/LCP, CLS estimate, file path
scripts/control profile start ; ... ; scripts/control profile stop    # top self-time functions with file and line
scripts/control heap --gc                   # before and after N repetitions for a leak
scripts/control metrics                     # LCP, CLS, long tasks since document start, JS heap, DOM nodes
```

Three rules keep these honest: compare baseline and treatment on the same machine with the same commands and throttling; warm up once before measuring, because a cold run includes JIT and cache misses; and take the median of three runs, stating the spread. The perf reference in the skill has the recipes for a before-and-after check, finding the long task, and finding the leak, plus the budgets to measure against (50 ms long tasks, 16 ms frames at 60 fps, Core Web Vitals thresholds).

## Attach mode: Electron and a browser you started

Start the app with `--remote-debugging-port=9222`, then:

```text
scripts/control launch --cdp http://127.0.0.1:9222 --marker "#app-root"
```

The marker picks the right page among several windows. Cleanup disconnects and leaves the app running. Everything else works the same, including traces and heap snapshots.

## When the browser harness is the wrong tool

A CLI needs a terminal transcript (tmux or a PTY script), an API needs the request and response, a parser needs a replayed input, storage needs the written value read back. The proof standards and the verdict format apply unchanged; only the capture tool differs. The agent says which surface it proved on. A unit test passing is evidence about the unit, not the user path.

## The trust ladder: where each correction goes

The harness proves correctness. The rest of her talk is about making the environment produce good work by default, and the practical tool is a question you ask every time you correct an agent: which rung can enforce this?

| Rung | Mechanism | Enforced by |
| --- | --- | --- |
| 1 | Codebase and architecture | Impossible to get wrong: one paved path, boundaries the build checks |
| 2 | Static analysis | Lint, types, compiler diagnostics, CI |
| 3 | Rules, skills, review bots | Guidance the agent usually reads |
| 4 | Style guide and human review | A human remembering to comment; does not scale at agent PR volume |

Lower is better. Name the mistake precisely, push the fix to the lowest feasible rung, write the lint rule this week and the refactor when you can, and if the miss was a false "it works", add the missing feature file. Agents extend the patterns they see, so one tolerated workaround becomes the house style within weeks; someone owns a weekly gardener pass that turns new workarounds into lint rules, audits the feature map, and checks the harness still launches on a clean checkout.

The skill's `references/trust-ladder.md` adds a level-by-level handoff table (what the agent does unattended at each level and the evidence required to move up), which is a synthesis for this fork rather than something the talk prescribes. Tune its thresholds after a few weeks of use.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No verification state for this repo` | Run `control init` from the repo root, or set `VERIFY_PROJECT_DIR`. |
| `Playwright not found` | `control setup`, or `control setup --channel chrome` and set `channel` in the config. |
| `already answers before the app was started` | Something is running on that URL. Drive it with `launch --no-app`, or stop it. |
| `doctor` says `markerFound: false` | Wrong page or wrong selector. `control pages`, then `use --match`, or fix `marker`. |
| `strict mode violation` on a click | Two elements share the name. Scope with `--within-role` and `--within-name`. |
| A click reports another element intercepting | A modal is open. Close it through its own control; do not force-click. |
| `metrics` says observers missing | The page loaded before the harness attached (attach mode). Run `goto` once. |
| Daemon stopped answering | `control cleanup --force` kills by the PIDs it recorded; evidence stays. |

## Sources

- Lauren Tan, "Agent trust and verification skills for scaling productivity" (talk, 2026).
- pstack upstream, including the guide chapter on verification: [cursor/plugins](https://github.com/cursor/plugins).
- The Claude Code port this fork tracks: [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude).
