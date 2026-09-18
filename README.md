# brain-kit

> Under construction. Phase 0 of 6: package skeleton, contracts and safety gates.
> Nothing here curates a vault yet. Follow the repository for the first usable release.

A second brain in plain markdown, in the Open Knowledge Format (OKF) v0.2, kept by an
AI agent that reads it through an index, feeds it every day from your own work (session
transcripts, calendar, meeting notes) and only ever changes it through pull requests.
Your merge is the approval and the verification.

brain-kit is one repository that is at the same time:

- an npm package, `second-brain-kit`, with a single executable, `brain-kit` (validator,
  PR loop, curator, briefing pre-flight, scheduler templates, doctor);
- a Claude Code plugin (skills, Stop hook, read-only subagent) that calls the same engine;
- a plugin marketplace of one, so `claude plugin marketplace add aleckyann/brain-kit` works.

The npm registry refused the name `brain-kit`: an unrelated package named `brainkit`
already exists there, and the two were judged too similar. So the package is published
as `second-brain-kit` (`npm install -g second-brain-kit`), while the repository, the
plugin, the marketplace and the command you type afterwards are all `brain-kit`.

The engine is Node.js 24 with zero runtime dependencies. The vault it generates is yours:
markdown, YAML frontmatter and a declarative config file, nothing else.

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | in progress |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | planned |
| 2 | Scheduled curator over local transcripts, scheduler templates | planned |
| 3 | Calendar and meeting-notes sources (best effort by design) | planned |
| 4 | Morning briefing | planned |
| 5 | Migration of the original vault onto the kit | planned |
| 6 | 0.1.0 release | planned |

## Why

Read [docs/rationale.md](docs/rationale.md) for the reasoning and
[docs/incidents.md](docs/incidents.md) for the dated failures that produced every guard.

## Requirements (target)

Node.js >= 24, git, the GitHub CLI (`gh`) logged in, and Claude Code. Linux is the
reference platform for scheduling (systemd user timers); macOS (launchd) and cron are
planned; Windows is out of scope for scheduling.

## License

MIT. Portuguese README: [README.pt-BR.md](README.pt-BR.md).
