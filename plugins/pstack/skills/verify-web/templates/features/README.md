# Feature map

This directory is the maintained source for verifying the user-facing behavior of this app. It is materialized memory: how the app works from the user's point of view, how a user reaches each feature, what to run to drive it, and what observable end state proves it works. Read this index before driving the app, then open the matching feature file and follow it literally.

The map exists because a vague request ("search is broken, see screenshot") is unanswerable without it. With it, any agent, cold, can reproduce the path a user took.

## Baseline preconditions

Replace these with the real ones for this app.

- The harness is configured in `../verify.config.json` and `scripts/control doctor` passes.
- The app runs against disposable data (a scratch database, a temp data directory, a test account). Name the mechanism here so no run touches real user data.
- Seed state that recipes assume (fixture users, sample records) is listed here with the command that creates it.
- Never drive an instance this verification run did not start, unless the request says to attach to a specific running one.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer accessible roles and names over CSS selectors or DOM position. Add a `data-testid` to the product only when no accessible handle exists, and record it here.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Capture after the action, not only at the end: `--shot` on the action, then `snapshot` of the region that changed.
- Restore seeded data after a mutation. Never remove proof artifacts during cleanup.

## Proof and skip reporting

- A proof pairs the user action with the resulting state and a read-only cross-check of any side effect (storage, network call, file, row).
- UI proof includes an ARIA snapshot and a screenshot with the app identity visible.
- Record the feature ID and entry point used with every artifact (the `note` command does this).
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every user entry point: buttons, routes, keyboard shortcuts, deep links.
3. `Driving it with control` starts with `Preconditions:` and pairs each user action with the exact command and the observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

Keep implementation details out. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Create a note (example, delete me)](./example-create-note.md) is a worked entry from the sample app this harness was proven against. Replace it with this app's features.
- Add one line per feature file, a markdown link to `./feature-slug.md` followed by what it covers.
