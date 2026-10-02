# pstack

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated Cursor skill stack that improves agent outcomes. This is a port for Claude Code, Codex and other agent harnesses. It tracks upstream and also carries named policy forks, each declared in [`tools/forks.json`](tools/forks.json).

This is [Anishek Kamal's fork](https://github.com/anishekkamal/pstack-claude) of [Michael Denyer's port](https://github.com/michael-denyer/pstack-claude). It adds `verify-web`, a shipped verification harness (Playwright over the Chrome DevTools Protocol, per-repo feature map, evidence and verdicts) built from Lauren Tan's talk on agent trust, so agents stop improvising a harness each session. Everything else tracks the port.

Tell `poteto-mode` your goal and it will invoke the correct workflow for the task. It keeps your code concise, simple and verified.

## Install

### Claude Code

Run in Claude Code:

```text
/plugin marketplace add anishekkamal/pstack-claude
/plugin install pstack@pstack-anishek
```

### Codex

Run in your terminal:

```shell
codex plugin marketplace add anishekkamal/pstack-claude
codex plugin add pstack@pstack-anishek
```

Run `setup-pstack` to change model defaults, set a reasoning effort per role (for example `arena runners: opus @xhigh, fable @max`, which Claude Code dispatches through the plugin's `pstack:effort-<level>` or `pstack:poteto-agent-<level>` agents; roles without a level keep the session's effort unless the sheet's `default effort` line names one), or turn automatic routing off. The plugin installs the routing hook on Claude Code and Codex; Codex asks you to trust it through `/hooks` before it runs. In Claude Code, use `/pstack:setup-pstack`.

For Prime Agent, OpenCode, Gemini CLI, or skills-only installs for any harness, see [shared installation](docs/reference.md#shared-skills-installation).

## Getting started

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

For a bug, it reproduces the failure, uses `how` and `why` to investigate, delegates the fix, then reruns the failing case. If the fix crosses a function boundary, it brings in `architect` before implementation. You receive the fix and the failing and passing evidence.

[Other playbooks](plugins/pstack/skills/poteto-mode/SKILL.md#playbooks) cover planning, features, refactoring, performance issues, investigations, prototypes, PR maintenance, shipping, and longer projects.

![A request enters poteto-mode. Playbook options include Plan, Bugs, Features, and Refactor. Planning can use architect, arena, or swarm; review and verification can use interrogate, tests, and measurements. Supporting skills include how, why, and unslop. The output is Finished work validated.](assets/pstack-overview.png)

## Verify with evidence

```text
/pstack:verify-web set up verification for this repo
```

`verify-web` writes `.claude/skills/verify/` into the repo: a project `verify` skill, a config, a feature map, and shims for the plugin's `control` CLI. From then on, "verify it in the app" means launch, doctor, drive the mapped feature by accessible role, capture ARIA snapshots, screenshots, console, network, traces or heap snapshots, and write a `VERIFIED` / `NOT VERIFIED` / `INCONCLUSIVE` verdict with the artifacts beside it. poteto-mode's playbooks route to that project skill automatically. [docs/verify-web.md](docs/verify-web.md) walks through installation, the first repo, the daily loop, and the trust ladder for deciding where each agent correction belongs.

## Details

- [Skills and slash commands](docs/reference.md#slash-commands)
- [Runtime setup](docs/reference.md#runtime-support)
- [Models and dependencies](docs/reference.md#configuration-and-dependencies)
- [Maintenance and port scope](docs/reference.md#maintenance)
- [Verification harness guide](docs/verify-web.md)

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Contributing

Thanks for helping make this port better. Bug reports, documentation fixes, and runtime improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

This port, including its modifications and additions, is also [MIT-licensed](LICENSE), © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit skills © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) and [NOTICE.md](NOTICE.md).
