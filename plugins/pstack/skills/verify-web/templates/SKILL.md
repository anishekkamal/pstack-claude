---
name: verify
description: "This repo's verification skill: drive the running app the way a user does, capture evidence, return a VERIFIED / NOT VERIFIED / INCONCLUSIVE verdict. Use it before saying any UI, routing, form, state, rendering or performance change works, to reproduce a bug report, or whenever a task says verify, prove, show evidence or repro. The harness is the pstack plugin's verify-web skill; the feature map in features/ is this repo's own."
---

# verify (this repo)

Scaffolded by `control init` from the pstack plugin's `verify-web` skill. That skill carries the full instructions, proof standards and perf recipes; read it when you need more than this page. Everything here is relative to this directory (`.claude/skills/verify/` from the repo root).

## Before driving

1. `scripts/control doctor` must pass. If there is no session, `scripts/control launch` (config in `verify.config.json`; `--no-app` to drive an instance you started yourself; `--cdp URL` to attach to Electron or a Chrome started with a remote debugging port).
2. Read `features/README.md`, then the feature file that matches the request. If none matches, say so, drive from what you can see, and add the feature file afterwards.

## Driving

One action per command, by accessible role and name. Add `--shot` to screenshot the resulting state.

```
scripts/control click --role button --name "Save" --shot
scripts/control fill --role textbox --name "Title" --value "Release checklist"
scripts/control press --key Enter
scripts/control wait --role status
scripts/control snapshot --role list --name "Items"
scripts/control eval --js "localStorage.getItem('items')"       # read-only cross-check
scripts/control console --level error ; scripts/control network --failed
```

Scope an ambiguous target with `--within-role list --within-name "Search results"`. Perf: `trace start|stop`, `profile start|stop`, `heap --gc`, `metrics`, `throttle --cpu 4`.

## Finishing

Restate the claim so it can fail, then `scripts/control verdict --claim "…" --result VERIFIED|"NOT VERIFIED"|INCONCLUSIVE --evidence "…" --reasoning "…"`, then `scripts/control cleanup`. Evidence survives in `evidence/<run-id>/`. Quote the decisive artifact in the reply, not the whole transcript. A clean `NOT VERIFIED` is a useful result.

## Rules that do not bend

Drive the real user path, never set state through internals to reach it. Capture the action and the resulting state, and confirm side effects from a second read-only view. Never report a skipped entry point as verified through another path. Keep this map honest: when a recipe fails for a reason that is not a product bug, fix the map in the same change.
