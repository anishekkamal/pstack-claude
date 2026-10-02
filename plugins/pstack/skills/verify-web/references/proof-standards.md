# Proof standards and the verdict

Verification is not a recap. It proves or disproves one specific claim with repeatable evidence. These rules apply to every surface; the browser harness is just the capture tool for web UIs.

## Restate the claim so it can fail

Before touching the app, write the claim as condition, observable, threshold:

- Weak: "search works".
- Falsifiable: "typing `quarterly` in the Search dialog lists `Quarterly plan` and not `Grocery list` within 2 s, and `volcano` shows the `No matching notes` status."
- Perf: "opening the Accounts tab produces no main-thread task over 50 ms after warmup, measured by trace on this machine, baseline vs treatment."

If the user's claim cannot be made falsifiable ("the code is cleaner"), ask for a measurable one before verifying anything.

## What counts as evidence

1. **The real user path.** Click the button, press the key, open the route. Internal setters, test-only endpoints, `eval` that writes state, and injected DOM do not count, because they skip the code the user runs. Arranging a precondition through fixtures is fine; injecting the symptom is not.
2. **Action and resulting state, not only the final screen.** `--shot` on the action, then a `snapshot` of the region that changed. A final screenshot alone cannot show that the action caused the state.
3. **Side effects from a second, read-only view.** A "Saved" status is a claim the UI makes about itself. Reopen the record from the list, read the row, read the storage key, read the outgoing request in `network`. Mutation proof always has a second view.
4. **Identity visible.** The saved snapshot carries the page title and URL; screenshots should show enough chrome to prove the right app and build is under test. Doctor output in the evidence directory records the run.
5. **Every mapped entry point, or an explicit skip.** If the feature map lists a toolbar button and a keyboard shortcut, proving one does not prove the other. Report `skipped: keyboard entry, reason: …` rather than letting it ride.
6. **Same conditions for baseline and treatment.** Same machine, same command, same data, same warmup, same throttling. A comparison across machines or across cold and warm runs is `INCONCLUSIVE`.
7. **Mocks only at an existing production boundary.** Mocking an external payment API behind the adapter the product already uses is fine; mocking the component you are testing is not evidence.
8. **Dry-run modes are verified by observation.** Check what the dry run actually skipped (files, network, git refs); some dry runs still touch the network.

## Surfaces and their capture tools

| Surface | Capture | Evidence artifact |
|---|---|---|
| Web UI, Electron | `scripts/control` (this skill) | ARIA snapshot, screenshot, console, network, trace |
| CLI or TUI | tmux session or a PTY script; the repo's own harness first | Terminal transcript with command, stdout, stderr, exit code |
| HTTP API | `curl` or the repo's client against a local instance | Request, response status and body, before and after |
| Library or parser | A focused test or a minimal repro script | Test output, replayed input and output |
| Performance | `trace`, `profile`, `metrics` on this harness; same-machine baseline | Trace JSON, cpuprofile, numbers in the verdict |
| Memory | `heap --gc` before and after N repetitions | Two heapsnapshots, node and size delta |
| Storage | Read the written value back through a second path | Row, file or key contents |

Say which surface the proof ran on. A unit test passing is evidence about the unit, not about the user path.

## Artifact layout

`evidence/<run-id>/` holds `timeline.jsonl` (every command, args, outcome), `console.jsonl`, `network.jsonl`, `app.log`, `shots/`, `snapshots/`, `perf/`, and `verdict.md`. For a baseline-versus-treatment comparison, run two sessions and name them in the verdict. If artifacts may contain sensitive data (real user records, tokens in network bodies, screenshots of private workspaces), keep only the minimal inline evidence and say why the directory was pruned.

## The verdict

Exactly one of:

- `VERIFIED`: baseline and treatment differ in the predicted direction by at least the threshold, or the claimed behavior was observed on the real path, with no obvious confound.
- `NOT VERIFIED`: the behavior is absent, unchanged, moves the wrong way, or misses the threshold.
- `INCONCLUSIVE`: no valid baseline, noisy signal, a failed measurement, a missing precondition, or an environment difference that invalidates the comparison.

Shape of the reply, after `scripts/control verdict` has written the file:

```
VERIFIED | NOT VERIFIED | INCONCLUSIVE
Claim: <falsifiable claim>

Evidence:
<artifact or metric>: baseline=<…>, treatment=<…>, delta=<…>, threshold=<…>
<path to snapshot / screenshot / transcript>

Skipped: <entry points not driven, with reason> (or none)

Reasoning:
<one tight paragraph naming the evidence and any confound>

Confidence: high | medium | low, and why
```

Quote the decisive output trimmed to the assertion, not the whole transcript. Do not soften a negative result, and do not upgrade `INCONCLUSIVE` to `VERIFIED` because the code looks right.
