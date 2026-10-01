# brain-kit

brain-kit keeps a second brain in plain markdown, in the Open Knowledge Format (OKF) v0.2:
an AI agent reads it through an index, feeds it every day from your own work (session
transcripts, calendar, meeting notes) and only ever changes it through pull requests.
Your merge is the approval and the verification. Install one command, `brain-kit`, and a
Claude Code plugin, and [Your first vault](#your-first-vault) takes you from a clean
machine to the first pull request.

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

## Requirements

Node.js 24 or newer (with its npm), git, the GitHub CLI (`gh`) logged in (`gh auth login`),
and Claude Code; for the calendar and meeting-notes sources, the claude.ai Google Calendar
and Google Drive connectors, connected in claude.ai and enabled for Claude Code; for the
briefing on a schedule, the Claude desktop application. Linux is the reference platform for
scheduling (systemd user timers, which need `loginctl enable-linger` to run while you are
logged out); macOS (launchd) and cron entries are rendered and tested without being
installed by the test suite; Windows is out of scope for scheduling.

## Installing a fixed version

A vault you depend on should run a fixed version of the kit, not whatever the default
branch holds today. Every version from 0.0.2 on is a git tag, and the latest tag is the
one to install. The list of versions, and what each one did, is in the
[CHANGELOG](CHANGELOG.md) and on the Releases page of the repository.
`npm i -g github:aleckyann/brain-kit#<tag>` installs a tag where npm may fetch git
packages; where it may not (npm refuses with `EALLOWGIT`), pack the tag yourself, install
the tarball, and keep the unpacked copy for the plugin. `npm i -g` needs an npm prefix you
can write to: if it fails with `EACCES`, run `npm config set prefix ~/.local` once and put
`~/.local/bin` on your PATH. The second line of the snippet finds the latest tag, so
nothing below names a version:

```bash
git clone https://github.com/aleckyann/brain-kit.git
TAG=$(git -C brain-kit describe --tags --abbrev=0)
mkdir -p ~/.local/share/brain-kit/$TAG
git -C brain-kit archive $TAG | tar -x -C ~/.local/share/brain-kit/$TAG
cd ~/.local/share/brain-kit/$TAG && npm pack --silent && npm i -g ./second-brain-kit-${TAG#v}.tgz
claude plugin marketplace add ~/.local/share/brain-kit/$TAG
claude plugin install brain-kit@brain-kit --scope user
```

`brain-kit --version` prints the version you installed.
`claude plugin marketplace add aleckyann/brain-kit` follows the repository's default
branch instead. A vault's CI can pin the kit the same way, checking it out at the tag's
commit next to the vault.

## Your first vault

From a machine with the requirements above to your first pull request, in order. Three of
the commands, marked "(`init` prints this at its end)", are the ones `init` itself prints
when it finishes.

1. Log in to GitHub, in your own terminal (`init` prints this at its end). `propose`
   opens its pull requests with `gh`, and `doctor` fails for a `gh` that is not logged in:

   ```bash
   gh auth login
   ```

2. Install the kit with the snippet in
   [Installing a fixed version](#installing-a-fixed-version), up to the `npm i -g` line. It
   puts `brain-kit` on your PATH, where the vault's push gate also looks for it.
3. Install the plugin with the last two lines of the same snippet
   (`claude plugin marketplace add` and `claude plugin install`).
4. Create the vault in a new or empty directory:

   ```bash
   brain-kit init ~/my-brain
   ```

   It asks seven questions, one at a time, and needs a terminal to ask them (a pipe is
   refused with nothing written). Where there is no terminal, `--from-answers <file>` reads
   the answers from a JSON file and `--yes` takes every default. `init` writes the skeleton
   and the push gate, runs `validate` and `lint` over it, and makes no commit. The
   repository question only records a name: `init` creates no repository and no remote.
5. Make the first commit. If git says it does not know who you are, set
   `git config --global user.name` and `user.email` first:

   ```bash
   cd ~/my-brain
   git add -A
   git commit -m "Start the vault"
   ```

6. Create the repository on GitHub and push, in one command (`init` prints this at its
   end):

   ```bash
   gh repo create my-brain --private --source . --push
   ```

   The repository is private because the vault holds notes about people, and a public
   repository shows them to anyone. The command pushes (`--push`) because without it the
   remote is empty, there is no default branch on it, and `propose` cannot work. The push
   runs the vault's push gate (`validate`, `lint` and a scan for credentials), so a vault
   that fails them is not published.
7. Check the machine and the vault:

   ```bash
   brain-kit doctor
   ```

   A healthy result has no `fail` line and exits 0. At this point `warn` lines about the
   scheduled curator (the watermark, the last round, the schedule, the notify command and
   the briefing) are fine: you have not set one up, and
   [docs/scheduling.md](docs/scheduling.md) covers it when you want a round on a timer.
   A `fail` says what to run to fix it; one for `gh` says `gh auth login`.
8. Open Claude Code in the vault (`init` prints this at its end):

   ```bash
   claude
   ```

   With the plugin installed, its nine skills and its `Stop` and `SessionStart` hooks work
   in this folder; [The Claude Code plugin](#the-claude-code-plugin) says what each does.
9. Write one fact in the vault's log, `memory/log.md` (`memoria/log.md` in a Portuguese
   vault). Either tell Claude something new, such as "Capture in the log that I started
   this vault today" (the `capture` skill writes the dated entry), or add it yourself: a
   `## YYYY-MM-DD` heading with today's date, and under it a line that starts with
   `**Capture**`.
10. Open the pull request. The `Stop` hook runs when Claude finishes a reply: it sees the
    changed file and asks Claude to validate, lint and propose it, which the
    `curate-session` skill does too when asked. To do it yourself:

    ```bash
    brain-kit propose "First capture" --only memory/log.md
    ```

    `--only` names exactly the files to propose, and `propose` never moves your branch or
    your working tree. Add `--dry` first to see the plan: it refuses what the real run
    would refuse (no `gh`, not logged in, no `origin`, the default branch not published).
11. Merge the pull request on GitHub: your merge is the approval, and the only way the
    vault changes. Then `brain-kit sync` brings your local branch level with the remote,
    and `brain-kit verify --pr <number>` stamps `verified` on the notes that pull request
    changed (the `approve` skill does the same).

From here on, [The scheduled curator](#the-scheduled-curator) feeds the vault from your
Claude Code sessions without you asking, and [The morning briefing](#the-morning-briefing)
tells you each morning where it stands.

## What works today

A vault is a directory holding a `brain-kit.config.json` and a root `index.md`; the
commands take its path, or find it by walking up from the current directory. The commands
below assume `brain-kit` is on your PATH (see
[Installing a fixed version](#installing-a-fixed-version)); to run one from a clone without
installing, replace `brain-kit` with `node <clone>/bin/brain-kit.mjs`.

```bash
brain-kit init path/to/new-vault
brain-kit init --adopt path/to/existing-vault
brain-kit update path/to/vault
brain-kit doctor path/to/vault
brain-kit validate path/to/vault
brain-kit lint path/to/vault
brain-kit sync path/to/vault
brain-kit propose "summary" --only notes/changed.md
brain-kit verify --pr 12
brain-kit curate path/to/vault
brain-kit watermark show path/to/vault
brain-kit schedule install path/to/vault
brain-kit preflight path/to/vault
brain-kit questions list path/to/vault
brain-kit schedule install --job briefing path/to/vault
```

`init` makes a new vault in an empty or new directory, in English or Portuguese: the
skeleton, the configuration, a `.gitignore`, the push gate (`.githooks/pre-push`, with
`core.hooksPath` pointed at it), a manifest of what the kit wrote, a git repository, and
`machine.json` in a state directory outside the vault. It asks one question at a time,
which needs a terminal; `--yes` (every default, listed) or `--from-answers <file>` (a JSON
object) answer for you where there is none, and it never makes the first commit unless
told to.

A vault speaks the language chosen for it at `init`, with its first question or with
`init --lang en|pt-BR`: `validate`, `lint`, `doctor`, the skills and the hooks use it. Everything else the
kit prints, and every command outside a vault, takes its language from `BRAIN_KIT_LANG`
(`en` or `pt-BR`) when that is set, else from the first of `LC_ALL`, `LC_MESSAGES` and `LANG`
that is: a value starting with `pt` is Portuguese, anything else English.

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
no skill and no built-in tool beyond the seven it needs; it reads only the vault and a
digest of each transcript the round lists, and everything its own rules do not allow is denied. The
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
unread. `watermark import --from <file>` carries over the mark of a legacy setup that kept
one date in a file of its own, as the last day swept of every enabled source (or of the
ones `--sources` names). A vault still run by a legacy job that holds a `flock` on a file
can point `machine.json` `paths.legacy_lock` at that file, so the kit's writers and that
job are never in the tree at once. `schedule install|uninstall|status`
installs the round in daytime windows (09:30, 14:00 and 20:00 by default), named by what it
does, with no dependency on a network target: systemd user timers are the reference, and
launchd and cron are rendered too.

[docs/scheduling.md](docs/scheduling.md) explains the round step by step, the windows, the
watermark and its import, moving from a legacy lock, the exit codes and what to do for each. [docs/security.md](docs/security.md)
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
its item. The judgement is the model's. The kit never puts the content of a path in
`briefing.never_read` in the prompt: a path it must mention, such as a stale note, is
marked "(never read)", and its own checks, like `validate`, read each note and use only
its frontmatter. The model is told never to open, list or search those paths; that is
an instruction to the model, not a sandbox. No limit applies unless you set one
(`max_words`, `max_questions` and `write_caps` are `null` by default), and
`briefing.enabled: false` turns the briefing off in the vault.

`questions` keeps the queue of open questions across mornings: deduplicated by their
normalised text, escalated once asked on three days and archived after 45 days (both by
default) by `questions sweep`, which prints each one it archives. What you answer, and what the
briefing captures, becomes one pull request through `propose --only`; with nothing to
record there is none. `schedule install --job briefing` prints the task to create in the
Claude desktop application, which the `setup` skill registers for you; it runs while the
application is open, and on its next launch when it was closed. A session that starts
with the task's prompt never reaches the curator; a briefing you ask for in your own
session is yours, and the curator reads it. [docs/briefing.md](docs/briefing.md) explains
the blocks, the facts and where each comes from, the queue, the desktop task and what
never changes.

The desktop application does not hand the task's prompt to the session as it is. Measured
on the first real run, the session's first message is the prompt wrapped in an envelope: an
opening `<scheduled-task ...>` tag, a paragraph in the application's own wording, the prompt
and a closing tag. The curator looks through it, by the task's name or by the prompt inside,
so the signature must stay the prompt's first line. If the application ever changes the
envelope into a shape the curator does not recognize, the session is read like one of your
own: the cost is the one of a briefing you ask for yourself (a capture the next round may
propose again, visible in its diff, nothing lost), and only when the task's working
directory is a project listed in `sources.transcripts.include_projects`. The round's log
line `plan` counts the sessions it left out as the kit's own, under `selfTrace`;
[docs/briefing.md](docs/briefing.md), "Which sessions the curator skips", has the details.

## The Claude Code plugin

Load it from a clone with `claude --plugin-dir path/to/brain-kit`, or install it from the
marketplace. Inside a vault:

- the `SessionStart` hook records which files were already dirty when the session
  began, and keeps that record across compaction;
- the `Stop` hook asks the session to curate only what it changed itself. It never
  blocks outside a vault, in a copy away from the registered vault path, while another
  writer holds the lock, or twice in a row, and it leaves out a file whose bytes are
  still exactly what an earlier `propose` pushed (a proposal never moves the working
  tree, so its files stay changed until the next `sync` brings them back to the default
  branch's content; one byte edited after the push makes the file the session's work
  again);
- nine skills drive the engine in the vault's own language: `setup`, `curate-session`,
  `capture`, `ask`, `lint`, `review-stale`, `approve`, `seed-rituals` and `briefing`;
- the `vault-reader` subagent reads notes with Read, Grep and Glob only.

`evals/` holds one `claude plugin eval` case per skill and language; see
[docs/testing.md](docs/testing.md).

## Status

<!-- status-reviewed: 0.0.7 -->

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | done, 0.0.1 on npm |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | done |
| 2 | Scheduled curator over local transcripts, scheduler templates | done |
| 3 | Calendar and meeting-notes sources (best effort by design) | done |
| 4 | Morning briefing | done |
| 5 | Migration of the original vault onto the kit | in progress. Done: 5a (what a migrating vault needs, since 0.0.2); the vault's scheduled curator moved from its legacy scripts to the kit on 01/10/2026 (a systemd user timer at 09:30 with retries at 14:00 and 20:00, the legacy timer disabled) and its first real rounds were supervised; the model reads a text digest of each transcript (0.0.5); the morning briefing runs as a desktop application task and ran for the first time on 01/10/2026, and since 0.0.6 the curator recognizes its session through the envelope the application wraps around the task's prompt. Open for the exit of the phase: five curator rounds and three briefings without an unexplained failure, the cleanup of the legacy scripts after seven stable days, and the first `verify` on the vault |
| 6 | 0.1.0 release on npm | planned, not started; it needs `docs/incident-response.md`, `examples/minimal-vault` and a run by an external adopter, none of which exists yet |
| 7 | Other forges, other harnesses, more sources, each only when a second real case needs it | planned |

The latest tag is `v0.0.7`. Every version from 0.0.2 on is a git tag only: the package
`second-brain-kit` on npm still has only 0.0.1, the Phase 0 skeleton.

The kit is under construction. Phase 1 is complete: the validator, the linter, the push
gates, `init`, `init --adopt`, `update`, `doctor`, the pull request loop (`sync`, `propose`,
`verify`) and the Claude Code plugin (hooks, skills, a read-only subagent) work today, from
a clone of this repository or from the install above. Phase 2 is complete too: the
scheduled curator (`curate`, `watermark`, `schedule`) reads your recent Claude Code
sessions and opens a pull request from an unattended round. Phase 3 is complete as well:
the round also reads your calendar and meeting notes through the claude.ai connectors,
once you turn them on. Phase 4 is complete: the morning briefing (`preflight`,
`questions`, the `briefing` skill and its desktop task). Phase 5a added what a vault
moving from scripts of its own needs: `watermark import`, a bridge to a legacy `flock`
lock, and rounds with no cost, turn or time limit when the configuration asks for none.
Phase 5 is in progress: the reference vault this kit was extracted from now runs its
configuration, CI, push gate and Stop hook from the kit, and since 01/10/2026 its
scheduled curator runs on the kit too (its legacy timer is disabled) and its morning
briefing runs as a desktop task; what is still open before the phase ends is in the table
above. The 0.1.0 release on npm is Phase 6, which has not started.

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

## License

MIT. Portuguese README: [README.pt-BR.md](README.pt-BR.md).
