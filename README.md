# brain-kit

> Under construction. Phase 1 is complete: the validator, the linter, the push gates,
> `init`, `init --adopt`, `update`, `doctor`, the pull request loop (`sync`, `propose`,
> `verify`) and the Claude Code plugin (hooks, skills, a read-only subagent) work today,
> from a clone of this repository. Phase 2 is complete too: the scheduled curator (`curate`,
> `watermark`, `schedule`) reads your recent Claude Code sessions and opens a pull request
> from an unattended round. Phase 3 is complete as well: the round also reads your calendar and
> meeting notes through the claude.ai connectors, once you turn them on. Phase 4 is in
> review: the morning briefing (`preflight`, `questions`, the `briefing` skill and its
> desktop task). The package on npm is still the Phase 0 skeleton. Follow the repository
> for the first usable release.

A second brain in plain markdown, in the Open Knowledge Format (OKF) v0.2, kept by an
AI agent that reads it through an index, feeds it every day from your own work (session
transcripts, calendar, meeting notes) and only ever changes it through pull requests.
Your merge is the approval and the verification.

brain-kit is one repository that is meant to be, at the same time:

- an npm package, `second-brain-kit`, with a single executable, `brain-kit`. Today it
  creates a vault or adopts an existing one, installs its push gate, keeps the kit's own
  files current, checks the machine with `doctor`, validates and lints a vault, runs the
  pull request loop (`sync`, `propose`, `verify`), and runs the scheduled curator
  (`curate`, `watermark`, `schedule`) and the morning briefing's facts and question queue
  (`preflight`, `questions`);
- a Claude Code plugin (nine skills, the Stop and SessionStart hooks, a read-only
  subagent) that calls the same engine;
- a plugin marketplace of one, so that `claude plugin marketplace add aleckyann/brain-kit`
  followed by `claude plugin install brain-kit@brain-kit` installs it.

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
node brain-kit/bin/brain-kit.mjs sync path/to/vault
node brain-kit/bin/brain-kit.mjs propose "summary" --only notes/changed.md
node brain-kit/bin/brain-kit.mjs verify --pr 12
node brain-kit/bin/brain-kit.mjs curate path/to/vault
node brain-kit/bin/brain-kit.mjs watermark show path/to/vault
node brain-kit/bin/brain-kit.mjs schedule install path/to/vault
node brain-kit/bin/brain-kit.mjs preflight path/to/vault
node brain-kit/bin/brain-kit.mjs questions list path/to/vault
node brain-kit/bin/brain-kit.mjs schedule install --job briefing path/to/vault
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
`node_modules/` in `.gitignore`; and for the scheduled curator, whether `claude` is the
real CLI and knows every flag that isolates a round, the projects its transcripts come
from, how far behind each source's watermark is, the last round (a round that exits 0 in
seconds without a model turn is reported as dead), the timer and its next fire times, and
whether a failed round reaches you or only the log; and, since phase 3, whether lint has
privacy keywords to refuse on added lines, anything a round may reach beyond the vault,
and each connector source: off or on, the state the last round saw with its date, a tool
prefix that does not match, other people's calendars without recorded consent, and a
user rule that refuses connector mode. `doctor --probe` asks the CLI for each connector's
state now, without a round. Since phase 4 it also checks the morning briefing: its
signatures, its blocks, its question queue and its desktop task. Each failure names the
command that fixes it.

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
| `privacy` | confidential notes stay in confidential directories and are not linked from shared ones, and a line a change adds holds none of the terms in `privacy.third_party_keywords` (someone else's health or private life) |
| `attribution` | a note's sources and its footnotes anchor each other |

`--rule` restricts the run to named rules, `--base` chooses what counts as the change
(`auto`, `worktree`, `merge-base` or `all`), and `--json` gives machine-readable output.
The `secrets` rule ignores `--base` and always reads everything a push could publish,
because a credential that is already there is the finding a new vault most needs.

`sync` brings the default branch level with its remote before anything is written:
it fast-forwards a branch that is behind and refuses one that diverged. `propose` turns
the paths you list into a pull request against the default branch without moving HEAD,
the index or the working tree, so another session's files are never swept in; without
`gh`, or when the pull request cannot be opened against the right base, it exits 3 with
the commit in place and says what to run. `verify` is the owner's command after a merge:
it stamps `verified` on the notes the merged pull request changed and commits with the
owner's own identity. `machine` shows and edits the machine-local `machine.json`.

## The scheduled curator

`curate` runs one round: it reads the Claude Code sessions of the projects your
configuration lists, selected by the time of their messages, and gives them to a model
that can act only through the kit's own `validate`, `lint` and `propose`. The round ends
with a pull request against your vault. The model runs isolated from your own Claude Code
settings: no settings file of yours or of the project is loaded, no hook, no MCP server,
no skill and no built-in tool beyond the seven it needs; it reads only the vault and the
transcripts the round lists, and everything its own rules do not allow is denied. The
round checks the isolation from the CLI's first event and stops the model if it does not
hold. The steps run in one
fixed, tested order (lock, network, sync, then the configuration as synced), and every way
a round can fail ends with a non-zero exit, a reason in `last-run.json` and the log, and
your notify command. `--dry` shows what a round would do and `--check` runs every step up
to the model.

`watermark` shows and moves the last day each source was swept. Each source reads the
days after its own mark, oldest first and whole (as many as fit in
`curate.caps.transcripts`; the rest wait for the next round), and its mark moves only when
the round's record shows the source read and the model reported it; no day is ever closed
unread. `schedule install|uninstall|status`
installs the round in daytime windows (09:30, 14:00 and 20:00 by default), named by what it
does, with no dependency on a network target: systemd user timers are the reference, and
launchd and cron are rendered too.

[docs/scheduling.md](docs/scheduling.md) explains the round step by step, the windows, the
watermark, the exit codes and what to do for each. [docs/security.md](docs/security.md)
explains what isolates the model and the measurements behind it.

## Calendar and meeting notes

A round can also read your calendar, through the claude.ai Google Calendar connector, and
your meeting notes, through the claude.ai Google Drive connector. Both are off until you
turn them on: the calendar by naming the calendars to read, the meeting notes by copying
the literal title of your automatic notes, accents included, from one of your own
documents. Both are best effort: a round that cannot read one keeps that source's day open
and still curates and proposes the rest, and neither can write anything through its
connector.

To reach the connectors a round loads your Claude Code user settings, and switches off
everything they bring besides the connectors: your hooks, your skills, every built-in tool
beyond the pinned set, and every allow rule of yours, mirrored as a deny (a rule that
cannot be mirrored refuses that mode, and the round runs on the transcripts alone). Each
connector's state comes from the round's own first event: one that needs authentication,
failed, is absent (never connected, or disabled for Claude Code) or lacks its tools makes
the round stop the model before its first turn and launch once more without it. What a
source counts as read is the record of the calls the model made, never its word: every
calendar listed over its whole window, with the private-event filter and every page, and
the literal title search with its bound. A state that changes is announced once through
your notify command, and the session's status line names a connector that was not
connected in the last round.

The `seed-rituals` skill fills the vault's weekly rhythm table from your calendar, in your
own session, with your confirmation for every row. [docs/connectors.md](docs/connectors.md)
explains what each source reads, how to turn it on, the states and what to do for each,
and the privacy policy.

## The morning briefing

Each working morning, or whenever you ask, the briefing gives you, in a session of your
own, where the vault stands: the curator's last round and each source's state, what is
overdue, due today and coming up, pending items with no date, the pull requests waiting
for your merge, the notes due for review, blind spots, the vault against its strategy, and
the questions it needs you to answer. Its content is the vault's own `briefing.blocks`,
chosen from the kit's catalog or written by you (a title, the notes to read, your
instruction), and a prompt overlay can replace the whole prompt.

Every date, count and deadline in it is computed by the kit: `preflight` prints the same
facts, reading the pending tables by column name and bucketing each item by the first real
date in its cell, with "no date" a bucket of its own and anything ambiguous named next to
its item. The judgement is the model's. Nothing in `briefing.never_read` is ever opened,
and no limit applies unless you set one (`max_words`, `max_questions` and `write_caps` are
`null` by default).

`questions` keeps the queue of open questions across mornings: deduplicated by their
normalised text, escalated once asked on three days and archived after 45 days (both by
default) by `questions sweep`, which prints each one it archives. What you answer, and what the
briefing captures, becomes one pull request through `propose --only`; with nothing to
record there is none. `schedule install --job briefing` prints the task to create in the
Claude desktop application, which the `setup` skill registers for you; it runs while the
application is open, and on its next launch when it was closed. The desktop task's
sessions never reach the curator; a briefing you ask for in your own session is yours, and
the curator reads it. [docs/briefing.md](docs/briefing.md) explains the blocks, the
facts and where each comes from, the queue, the desktop task and what never changes.

## The Claude Code plugin

Load it from a clone with `claude --plugin-dir path/to/brain-kit`, or install it from the
marketplace. Inside a vault:

- the `SessionStart` hook records which files were already dirty when the session
  began, and keeps that record across compaction;
- the `Stop` hook asks the session to curate only what it changed itself. It never
  blocks outside a vault, in a copy away from the registered vault path, while another
  writer holds the lock, or twice in a row;
- nine skills drive the engine in the vault's own language: `setup`, `curate-session`,
  `capture`, `ask`, `lint`, `review-stale`, `approve`, `seed-rituals` and `briefing`;
- the `vault-reader` subagent reads notes with Read, Grep and Glob only.

`evals/` holds one `claude plugin eval` case per skill and language; see
[docs/testing.md](docs/testing.md).

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | done, 0.0.1 on npm |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | done |
| 2 | Scheduled curator over local transcripts, scheduler templates | done |
| 3 | Calendar and meeting-notes sources (best effort by design) | done |
| 4 | Morning briefing | in review |
| 5 | Migration of the original vault onto the kit | planned |
| 6 | 0.1.0 release | planned |
| 7 | Other forges, other harnesses, more sources, each only when a second real case needs it | planned |

Phase 1 is built in five slices:

| Slice | Content | State |
|---|---|---|
| 1A | Vault reader, frontmatter, markdown, `validate` | done |
| 1B | `lint` and its eight rules, the leak scanner, the two push gates | done |
| 1C | `propose` (the PR loop) and `sync` | done |
| 1D | `init`, `init --adopt`, `update`, `doctor` | done |
| 1E | Plugin surface: skills, Stop and SessionStart hooks, read-only subagent, evals | done |

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

Node.js >= 24, git, the GitHub CLI (`gh`) logged in, and Claude Code; for the calendar and
meeting-notes sources, the claude.ai Google Calendar and Google Drive connectors, connected
in claude.ai and enabled for Claude Code; for the briefing on a schedule, the Claude
desktop application. Linux is the
reference platform for scheduling (systemd user timers, which need
`loginctl enable-linger` to run while you are logged out); macOS (launchd) and cron entries
are rendered and tested without being installed by the test suite; Windows is out of scope
for scheduling.

## License

MIT. Portuguese README: [README.pt-BR.md](README.pt-BR.md).
