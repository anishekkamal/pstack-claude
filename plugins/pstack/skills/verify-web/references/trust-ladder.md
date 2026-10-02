# The trust ladder: where every agent correction belongs

Source: Lauren Tan (Potato) talk "Agent trust and verification skills for scaling productivity" (Cursor / SpaceX AI, 2026), plus the pstack guide. Sections marked *synthesis* are extensions written for this skill, not claims from the talk.

## The thesis

You cannot go from babysitting 1 to 5 agents to running 100 by spawning more agents. The gap is trust, and trust is earned by the environment, not by the model. If you spawn 100 agents into an environment you do not trust, you get 100 sloppy pull requests and regressions. If you set the environment up so that the easy path is the right path, agents with little context and little reasoning still do good work by default. Her framing: a Michelin kitchen, not a software factory. You still own the final dish; you set up the line so the cooks cannot plate the wrong thing.

Two kinds of trust, and they need different tools:

1. **Correctness**: does the feature do what the user wanted. Proven by verification skills (this harness) that run the real app and collect empirical evidence.
2. **Quality**: is the code the way an experienced engineer would write it, and does it meet the performance bar. Shaped by code-quality skills and playbooks, and by the codebase itself.

Formal verification (Lean, TLA+) sits at the far end of the correctness spectrum and is still an open question for most teams. Verification skills get you most of the way without it.

## The ladder, ordered by enforceability

When you find yourself correcting an agent, the fix goes on the lowest rung where it is feasible. Lower rungs are enforced by the machine; higher rungs depend on someone remembering.

| Rung | Mechanism | Enforced by | Example |
|---|---|---|---|
| 1 | **Codebase and architecture** | Impossible to get wrong | A dependency rule that makes importing main-process code into the renderer a build failure; one blessed data access layer so there is one way to query |
| 2 | **Static analysis** | Lint, types, compiler diagnostics, CI | A lint rule against the exact anti-pattern you just corrected; a type that cannot represent the invalid state |
| 3 | **Rules, skills, review bots** | Guidance the agent usually reads | A playbook that says how to add a feature; BugBot comments; this skill |
| 4 | **Style guide and human review** | A human remembering to comment | The only enforcement for anything not encoded below |

Rung 4 is the big hole: at agent pull-request volume, a human cannot look at every line and remember every convention. Use human review findings as the signal of what is missing from rungs 1 to 3, then move it down.

Verification runs across the ladder: it is the evidence that the thing works, whichever rung shaped how it was built.

## Why the codebase is memory

Agents extend the patterns they see in their context window, and the files they open are their context window. So the codebase is the materialized snapshot of how you want the next agent to work. This cuts both ways: one workaround with an explanatory comment gets copied until it is the de facto pattern in weeks. Her Dune framework banned code comments for exactly this reason: agents used nearby comments as justification for papering over a problem instead of fixing it.

Three principles from Dune:

1. Delete the tech debt you already have, because it will be copied.
2. Keep one paved path for every blessed pattern, with enough guidance in CI and lint that agents are guided onto it.
3. When you see a bad pattern, your first instinct is a lint rule. It stops the bleeding even before the cleanup.

## The correction loop

Run this every time you correct, intervene, or redo an agent's work. Thirty seconds of classification beats correcting the same mistake again next week.

1. **Name the mistake precisely.** Not "sloppy" but "mutated shared state from a component", "skipped the loading state", "claimed it worked without running it".
2. **Pick the rung.** Can the architecture make it impossible (1)? Can a lint rule, a type, or a CI check catch it (2)? If neither is feasible today, write it into a rule, a playbook, or this skill's feature map (3). Only leave it to review (4) when nothing else is possible, and say so.
3. **Stop the bleeding first, clean up second.** A lint rule or CI check this week; the refactor that makes it impossible when you have time.
4. **If the mistake was a false "it works", it is a verification gap.** Add the missing feature file or recipe so the next run proves that path.
5. **If an existing bad pattern was copied, that pattern is the bug.** Remove or fence it, not just the copy.

## The gardener role

Someone owns the garden. Weekly, not when it hurts:

- Scan recent PRs for new workarounds, explanatory comments, duplicated helpers, and `any`-style escapes. Each one becomes a lint rule or a cleanup task.
- Run the feature map audit: every feature file read against source, one live pass driving every feature, one PR of proven corrections. Never edit product code in that pass; report a regression instead of rewriting the map around it.
- Check `scripts/control doctor` still passes on a clean checkout. A verification skill that no longer launches is the first thing agents will route around.
- Keep the codebase in a state you would be happy for an agent to copy.

## Earning handoff, level by level (*synthesis*)

The talk gives the direction (1 to 5 agents, then 100) and the mechanism (the ladder). The levels below are a practical way to decide how much to hand off on any repo, with the evidence required to move up. Confidence: this is a reasoned extension, not something the talk prescribes.

| Level | What the agent does unattended | What you still do | Move up when |
|---|---|---|---|
| L0 | Nothing; you course-correct every step | Everything | The harness launches and one feature file exists |
| L1 | Runs the task, runs verify-web, attaches evidence and a verdict | Read the evidence, not just the diff | 10 consecutive tasks where your reading of the evidence agreed with the verdict |
| L2 | Same, plus opens the PR with evidence in the description | Read the verdict and spot-check one artifact | No regression reached a human reviewer in a month that the harness could have caught; every escape became a feature file or a lint rule |
| L3 | Triggered by events (bug report, alert, failing check), reproduces, fixes, re-proves, opens the PR | Approve merges | The feature map covers every surface those events touch; `NOT VERIFIED` runs have never been merged |
| L4 | Also lands the PR when verification is green | Audit weekly as the gardener | Rungs 1 and 2 make the known failure classes impossible, not just unlikely |

Drop a level when an agent's "VERIFIED" turns out wrong. Do not argue with the agent; classify the miss with the correction loop and fix the rung.

## State the finish condition up front

Every task prompt should carry what done means, in checkable terms, so the agent has checks to run rather than a mood to satisfy:

```
Add JSON output to the export command. Text output stays byte-identical, the JSON parses,
both run against the sample project, and verify-web proves the download link still works.
Show me the evidence.
```

Match the check to the change: a UI change walks the flow in the running app; a CLI change runs the real command; a parser replays a saved input; a perf change compares before and after captures on the same machine; a storage change reads the written value back. A confident reply without evidence is a red flag, and `INCONCLUSIVE` is an honest answer when a check could not run.

## Sources

- Talk transcript: "Agent trust and verification skills for scaling productivity", Lauren Tan, recorded 2026-10-01 (Granola).
- pstack guide, "Verify the result and open a PR": https://github.com/cursor/plugins/blob/main/pstack/docs/guide/06-verify-and-ship.md
- cursor-team-kit skills (`verify-this` and the UI and CLI harness recipes): https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills
- pstack-claude port: https://github.com/michael-denyer/pstack-claude
