# brain-kit

> Under construction. Phase 1 is in progress: `init`, `init --adopt`, `update`, `doctor`, the
> validator, the linter and the push gates work today, from a clone of this repository. Nothing here curates a vault yet, and the package on npm is still the
> Phase 0 skeleton. Follow the repository for the first usable release.

A second brain in plain markdown, in the Open Knowledge Format (OKF) v0.2, kept by an
AI agent that reads it through an index, feeds it every day from your own work (session
transcripts, calendar, meeting notes) and only ever changes it through pull requests.
Your merge is the approval and the verification.

brain-kit is one repository that is meant to be, at the same time:

- an npm package, `second-brain-kit`, with a single executable, `brain-kit`. Today it
  creates a vault or adopts an existing one, installs its push gate, keeps the kit's own
  files current, checks the machine with `doctor`, and validates and lints a vault; the PR
  loop, curator, briefing pre-flight and scheduler templates are still to come;
- a Claude Code plugin (skills, a Stop hook, a read-only subagent) that calls the same
  engine. Today the repository carries only the plugin manifest and the hook wiring, and
  the hook does nothing yet;
- a plugin marketplace of one, so that `claude plugin marketplace add aleckyann/brain-kit`
  installs it once the plugin surface lands.

The npm registry refused the name `brain-kit`: an unrelated package named `brainkit`
already exists there, and the two were judged too similar. So the package is published
as `second-brain-kit`, while the repository, the plugin, the marketplace and the command
you type afterwards are all `brain-kit`.

The engine is Node.js 24 with zero dependencies, runtime and development. The vault it
generates is yours: markdown, YAML frontmatter and a declarative config file, nothing else.

## What works today

Every command runs from a clone. A vault is a directory holding a `brain-kit.config.json`
and a root `index.md`; the commands take its path, or find it by walking up from the
current directory.

```bash
git clone https://github.com/aleckyann/brain-kit.git
node brain-kit/bin/brain-kit.mjs init path/to/new-vault
node brain-kit/bin/brain-kit.mjs init --adopt path/to/existing-vault
node brain-kit/bin/brain-kit.mjs update path/to/vault
node brain-kit/bin/brain-kit.mjs doctor path/to/vault
node brain-kit/bin/brain-kit.mjs validate path/to/vault
node brain-kit/bin/brain-kit.mjs lint path/to/vault
```

`init` makes a new vault in an empty or new directory, in English or Portuguese: the
skeleton, the configuration, a `.gitignore`, the push gate (`.githooks/pre-push`, with
`core.hooksPath` pointed at it), a manifest of what the kit wrote, a git repository, and
`machine.json` in a state directory outside the vault. It asks one question at a time,
takes `--yes` or `--from-answers <file>` instead, and never makes the first commit unless
told to.

`init --adopt` brings an existing vault under the kit. The vault must already be a git
repository (write its `.gitignore`, then `git init`); a folder that is not one is refused
with nothing written. It infers the configuration from the notes git would publish (a
folder or a note git ignores contributes nothing) and prints every inference, writes the configuration and a manifest that records the files git would
publish as yours, by path only (a file git ignores is never recorded, and no hash of your
content is stored), and installs the push gate. A hook of your own, or a `core.hooksPath` pointing elsewhere, is left
exactly as it is, and adopt prints the one line that adds the gate to it. `--no-hook` skips
the gate. It never changes a note and never commits.

`update` refreshes the files the kit manages (the root contract files, `.gitignore` and the
hook) by checksum: one you have not edited is replaced, one you edited is never
overwritten, and a newer version is written beside it as `<name>.brain-kit-new`.
`update --install-hook` installs the push gate into a vault that does not have it, with
the same care for a hook of your own.

`doctor` reports, check by check, whether this machine and this vault are ready: Node and
git, the gate and `core.hooksPath`, `brain-kit` on PATH, the configuration, the manifest,
`machine.json` and its state directory, the kit version, `gh`, `claude`, and
`node_modules/` in `.gitignore`. Each failure names the command that fixes it.

`validate` checks the vault against OKF v0.2 and reports two rulers apart: the format's
own conformance, and the vault's house rules, which are stricter on purpose. A vault can
conform to the format and still depart from its own rules, and the report says which is
which. `--json` gives machine-readable output and `--only-problems` leaves out the groups
that found nothing.

`lint` checks the vault's health with eight rules:

| Rule | What it checks |
|---|---|
| `index-completeness` | every directory holding notes has an index, and the root index links every first-level directory |
| `orphans` | every note can be reached by following links from the root index |
| `columns` | tables use the column headings the configuration declares |
| `tables` | table shape: the blank line before a table, duplicate rows, overlong cells |
| `style` | characters the configuration forbids, on the lines a change added |
| `secrets` | credential shapes and configured patterns, in every file a push could publish, dot-files such as `.env` included |
| `privacy` | confidential notes stay in confidential directories and are not linked from shared ones |
| `attribution` | a note's sources and its footnotes anchor each other |

`--rule` restricts the run to named rules, `--base` chooses what counts as the change
(`auto`, `worktree`, `merge-base` or `all`), and `--json` gives machine-readable output.
The `secrets` rule ignores `--base` and always reads everything a push could publish,
because a credential that is already there is the finding a new vault most needs.

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | done, 0.0.1 on npm |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | in progress |
| 2 | Scheduled curator over local transcripts, scheduler templates | planned |
| 3 | Calendar and meeting-notes sources (best effort by design) | planned |
| 4 | Morning briefing | planned |
| 5 | Migration of the original vault onto the kit | planned |
| 6 | 0.1.0 release | planned |
| 7 | Other forges, other harnesses, more sources, each only when a second real case needs it | planned |

Phase 1 is built in five slices:

| Slice | Content | State |
|---|---|---|
| 1A | Vault reader, frontmatter, markdown, `validate` | done |
| 1B | `lint` and its eight rules, the leak scanner, the two push gates | done |
| 1C | `propose` (the PR loop) and `sync` | planned |
| 1D | `init`, `init --adopt`, `update`, `doctor` | done |
| 1E | Plugin surface: skills, Stop and SessionStart hooks, read-only subagent, evals | planned |

## Security

There are two push gates, with different reach. This repository's own gate scans every
object a push carries against a personal pattern list kept outside the repository. The
template hook meant for a vault, in `templates/githooks/`, runs `validate` and `lint` over
the working tree, then the same object scan over what the push carries, against the
vault's own configured patterns, those of its working tree, of every pushed tip and of its
default branch together. `init` installs it into every new vault, `init --adopt` into an
existing one unless a hook of the person's own is already there, and `brain-kit update
--install-hook` later. A refusal for a match ends with what to do: rotate the credential,
remove it from history, and follow the vault's `SECURITY.md`. [SECURITY.md](SECURITY.md)
lists what the gates do not cover.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Every clone must run
`.githooks/install-gate` once, or that clone has no leak gate at all.

## Why

Read [docs/rationale.md](docs/rationale.md) for the reasoning and
[docs/incidents.md](docs/incidents.md) for the dated failures that produced every guard.

## Requirements (target)

Node.js >= 24, git, the GitHub CLI (`gh`) logged in, and Claude Code. Linux is the
reference platform for scheduling (systemd user timers); macOS (launchd) and cron are
planned; Windows is out of scope for scheduling.

## License

MIT. Portuguese README: [README.pt-BR.md](README.pt-BR.md).
