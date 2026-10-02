# Performance evidence with the harness

The harness captures over the Chrome DevTools Protocol: traces (Tracing domain), CPU profiles (Profiler), heap snapshots (HeapProfiler), runtime metrics (Performance), and emulated CPU and network conditions (Emulation, Network). This file is how to turn those into a claim that holds.

## Budgets to measure against

- A main-thread task over 50 ms is a long task; it blocks input.
- A smooth UI needs each frame under 16 ms at 60 fps, under 8 ms at 120 fps. Work on the rendering thread has to be chunked to fit.
- Core Web Vitals thresholds (good): LCP 2.5 s, CLS 0.1, INP 200 ms. The harness reports LCP and CLS; INP needs field data or an interaction-specific trace.
- Memory: a leak is growth that survives garbage collection across repetitions of the same operation, not a single large number.

Pick the budget before measuring, write it in the claim.

## Recipe 1: before and after on the same machine

1. Check out the baseline (merge base or parent commit). `launch`, `doctor`, drive the interaction once as warmup.
2. `trace start`, drive the interaction, `trace stop --path evidence/baseline-trace.json`. Note `longTasks`, `longestTaskMs`, `totalLongTaskMs`, `lcpMs`, `clsEstimate`.
3. Repeat the capture three times; keep the median.
4. `cleanup`. Check out the treatment. Repeat steps 1 to 3 with identical commands.
5. Verdict on the delta against the threshold. One run each way is `INCONCLUSIVE` by default; say so if that is all you had time for.

Throttle to make regressions visible on a fast machine: `throttle --cpu 4 --network fast3g` before the capture, identically on both sides, and reset with `throttle --cpu 1 --network none`.

## Recipe 2: find the long task

1. `trace start`, drive the slow interaction, `trace stop`. If `longTasks` is 0 after warmup, the claim is probably `NOT VERIFIED` for "it is slow on the main thread"; look at network (`network --since 0`) or layout (`metrics` → `layoutCount`) instead.
2. `profile start`, drive the same interaction, `profile stop`. The summary lists the top self-time functions with file and line. `(program)` and `(idle)` are not your code; `(garbage collector)` points at allocation churn.
3. Map the hot frame to source. A frame with no source mapping is not a diagnosis yet; resolve the symbol or say the profile does not carry it.
4. Prove the mechanism cheaply before fixing: `eval --js` to read the size of the collection being iterated, the number of listeners, the count of rows being re-rendered. Read-only, but it turns a hypothesis into a fact.
5. Open the files in DevTools (Performance panel → Load profile for the trace; Performance → Load for the cpuprofile) when the summary is not enough.

## Recipe 3: find the leak

1. `gc`, then `heap --gc --path evidence/heap-a.heapsnapshot`. Record `nodeCount` and `jsHeapUsedMB`.
2. Perform the suspect operation N times (open and close the dialog ten times, navigate back and forth ten times).
3. `heap --gc --path evidence/heap-b.heapsnapshot`.
4. Growth in node count and heap that scales with N is the signal. Load both files in DevTools → Memory → Comparison to see which constructors grew and follow a retainer chain to a GC root. Detached DOM trees and listeners on long-lived objects are the usual suspects.
5. The verdict quotes nodes and MB for A and B, the N, and the constructor that grew.

## Recipe 4: startup and navigation

`metrics` right after `goto` gives TTFB, DOMContentLoaded, load, FCP, LCP (with the element), CLS, and the long tasks seen since document start (observers are installed by the harness before any page script runs). Compare baseline and treatment with the same throttling. For attach mode, the observers only exist after a navigation the harness saw; run `goto` once.

## Reading the summaries honestly

- `trace stop` counts `RunTask` events over 50 ms. It is a quick signal, not a replacement for the flame chart. Idle-time noise from extensions and devtools is excluded in the disposable profile the harness launches, but not in attach mode.
- `profile stop` self time is sampled at 0.5 ms by default (`--interval` µs to change). Short functions under the interval can be missed; a 180 ms task will not be.
- Headless Chromium has no GPU compositing. Paint and raster numbers differ from a user's machine; main-thread JS time is comparable.
- First-run numbers include JIT warmup and cold caches. Warm up once, then measure.
- A sandbox or CI runner is noisier than a laptop. Three runs, median, say the spread.

## What to put in the verdict

Numbers with units, the threshold, the machine, headed or headless, throttling, warmup, the number of runs, and the artifact paths. Example:

```
VERIFIED
Claim: opening the Accounts tab produces no task over 50 ms after warmup.
Evidence: trace longTasks baseline=2 (182 ms, 61 ms), treatment=0; median of 3 runs each; headless, cpu x4; perf/trace-*.json
Reasoning: the 182 ms task was totals recomputation on the main thread (profile: recomputeTotals, accounts.ts:142, 115 ms self); moved to a worker in the treatment.
Confidence: high; same machine and commands, delta well past threshold on every run.
```
