# brain-kit

brain-kit keeps a second brain in plain markdown (text files), in the Open Knowledge Format
(OKF) v0.2: an AI agent reads it through an index and feeds it every day from your own work
(your Claude Code sessions, your calendar, your meeting notes). The agent only changes the
brain through a pull request, a change request that you read on GitHub, and your merge, the
click that approves the request, is the approval and the verification.

> **Start here.** Once you have Node.js 22 or newer (24 LTS is recommended), git, `gh` (the GitHub
> app for the terminal), Claude Code and a GitHub account ready, the path to your first pull request
> takes about 35 minutes the first time: about 10 of reading, 21 for the steps below and a few more
> to approve it on GitHub. The times are estimates, not a promise. See [Your first vault](#your-first-vault).
>
> 1. Install the kit and the plugin by pasting the [install snippet](#installing-a-fixed-version) into the terminal (2 min).
> 2. Log in to GitHub with `gh auth login` ([step 2](#step-2), 3 min).
> 3. Check the machine with `brain-kit doctor`, outside any vault ([step 3](#step-3), 1 min).
> 4. Create the vault with `brain-kit init ~/my-brain` ([step 4](#step-4), 3 min).
> 5. Make the first commit with `git add -A` and `git commit` ([step 5](#step-5), 3 min).
> 6. Push to GitHub with `gh repo create my-brain --private --source . --push` ([step 6](#step-6), 1 min).
> 7. Open the first pull request with `brain-kit propose` ([steps 7 to 10](#step-7), 8 min) and approve it on GitHub ([step 11](#step-11)).

**Words you will see**

| Word | What it means |
|---|---|
| terminal | the window where you type commands |
| PATH | the list of folders where the terminal looks for the commands you type |
| repository | a folder whose history git keeps; GitHub keeps a copy of it on the internet |
| branch | a line of work in the repository; the main one is usually called `main` or `master` |
| commit | a saved point in the history, with a message saying what changed |
| pull request | a request to merge changes into the main branch, which you read and approve on GitHub |
| merge | approving a pull request: its changes go into the main branch |
| vault | the folder of your notes (your second brain), which is a repository |
| push gate | the check that runs before you send (push) the vault to GitHub and stops forgotten passwords and keys |
| hook | a program that runs by itself when something happens, such as before a push to GitHub |
| skill | a ready-made instruction Claude Code follows when you ask for it, such as `capture` |
| plugin, marketplace | a plugin adds skills and hooks to Claude Code; the marketplace is the list it installs them from |

## Requirements

To reach the first pull request you need Node.js 22 or newer (24 LTS is recommended) with
its npm (`node --version` shows which one you have), git, `gh` (the GitHub app for the
terminal) logged in (`gh auth login`), Claude Code and a GitHub account. The scheduled
curator rounds, the calendar and meeting-notes sources and the briefing on a schedule are
optional and can wait: [The scheduled curator](#the-scheduled-curator) and
[docs/scheduling.md](scheduling.md) introduce them, with what each one needs.

## Installing a fixed version

A vault you depend on should run a fixed version of the kit, not whatever the default
branch holds today. Every version from 0.0.2 on is a git tag (a version marker), and the
latest tag is the one to install. The list of versions, and what each one did, is in the
[CHANGELOG](../CHANGELOG.md) and on the Releases page of the repository. The snippet below does
it all at once: it clones the repository, finds the latest tag (the second line, so nothing
below names a version), packs that tag into a `.tgz` file, installs `brain-kit` from it and
installs the plugin. Paste it whole into the terminal:

```bash
git clone https://github.com/aleckyann/brain-kit.git
TAG=$(git -C brain-kit describe --tags --abbrev=0)
mkdir -p ~/.local/share/brain-kit/$TAG
git -C brain-kit archive $TAG | tar -x -C ~/.local/share/brain-kit/$TAG
cd ~/.local/share/brain-kit/$TAG && npm pack --silent && npm i -g ./second-brain-kit-${TAG#v}.tgz
rm -f ~/.local/share/brain-kit/$TAG/second-brain-kit-${TAG#v}.tgz
claude plugin marketplace add ~/.local/share/brain-kit/$TAG
claude plugin install brain-kit@brain-kit --scope user
```

`brain-kit --version` prints the version you installed. The snippet already deletes the `.tgz`
file it made, so that no copy of it stays inside the plugin's folder. The `brain-kit` folder
that the first line cloned (it sits in the folder where you pasted the snippet) is no longer
used and can be deleted. The `~/.local/share/brain-kit/` folder that the snippet creates, on
the other hand, **must not be deleted**: Claude Code loads the plugin from it.

To move to a newer version later, delete the `brain-kit` folder that the first line cloned, if
it is still there (otherwise the snippet reuses that old copy and installs the old version),
paste the snippet again, and then record the new version in Claude Code:

```bash
claude plugin update brain-kit@brain-kit
```

Open Claude Code again afterwards. The folders of older versions under
`~/.local/share/brain-kit/` are no longer used and can be deleted; the newest must stay.

Where npm may fetch git packages, `npm i -g github:aleckyann/brain-kit#<tag>` installs the kit
from a tag by itself; where it may not (npm refuses with `EALLOWGIT`), the snippet packs the
tag for you, installs the `.tgz` and keeps the unpacked copy for the plugin.
`claude plugin marketplace add aleckyann/brain-kit` follows the repository's default branch
instead. A vault's CI can pin the kit the same way, checking it out at the tag's commit next
to the vault.

### If you see `EACCES`

`EACCES` means "permission denied": npm tried to install into a system folder you cannot
write to. This usually happens when Node came from the system installer; if you installed
Node with nvm you do not get this error and can skip this block. Avoid `sudo` (running as
administrator), which tends to leave administrator-owned files in your folder and cause more
permission errors later: tell npm to install into a folder of your own instead. Run once:

```bash
npm config set prefix ~/.local
```

Now put that folder (`~/.local/bin`) on the PATH, the list of folders where the terminal looks
for the commands you type. Use the line for your terminal (Linux usually uses bash and macOS
uses zsh; if in doubt, run both):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Close the terminal and open a new one (that is how the new PATH takes effect), then paste the
install snippet again: the first line may complain that the `brain-kit` folder already exists,
and the plugin lines will say it is already installed; that is fine. Check:

```bash
brain-kit --version
```

## Your first vault

From a machine with the requirements above to your first pull request, in order (the "Start
here" box at the top of the page sums up the same steps, with the time of each). Three of the
commands, marked "(`init` prints this at its end)", are the ones `init` itself prints when it
finishes.

1. Install the kit and the plugin: paste the whole snippet of
   [Installing a fixed version](#installing-a-fixed-version) into the terminal. The first six
   lines install the kit and put `brain-kit` on your PATH, where the vault's push gate also
   looks for it; the last two install the Claude Code plugin. If `EACCES` appears, the block
   [If you see `EACCES`](#if-you-see-eacces), just below the snippet, fixes it.
2. <a id="step-2"></a>Log in to GitHub, in your own terminal (`init` prints this at its end).
   `propose` opens its pull requests with `gh`, and `doctor` fails for a `gh` that is not
   logged in. `gh` asks a few questions and opens the browser for you to confirm a code:

   ```bash
   gh auth login
   ```

3. <a id="step-3"></a>Check the machine:

   ```bash
   brain-kit doctor
   ```

   Outside a vault (you do not have one yet), `doctor` checks only the machine: Node, git, `gh`
   and its login, and Claude Code. All is well when the line that starts with `doctor:` ends
   with `0 fail`. The message "no brain-kit vault found", which comes right after it, is
   expected: you do not have a vault yet. A `fail` line says what to run to fix it. As there is
   no vault yet, it uses your system's language: on a Portuguese system the words come out as
   `falha` and `aviso`, and the line ends with `0 falha(s)`.
4. <a id="step-4"></a>Create the vault in a new or empty folder:

   ```bash
   brain-kit init ~/my-brain
   ```

   It asks seven questions, one at a time, and needs a terminal to ask them (if you try to feed
   it the answers from another command, it refuses and writes nothing). At the "Short id"
   question (the one that signs your approvals), accept the suggestion: just press Enter.
   Where there is no terminal, `--from-answers <file>` reads the answers from a JSON
   file and `--yes` takes every default. `init` writes the skeleton and the push gate, runs
   `validate` and `lint` over it (they check that the vault follows the format and is healthy),
   says in a single line that it found nothing, and makes no commit. The repository question
   only records a name: `init` creates no repository and no remote.
5. <a id="step-5"></a>Make the first commit:

   ```bash
   cd ~/my-brain
   git add -A
   git commit -m "Start the vault"
   ```

   git records who made each commit, so it needs to know who you are. If it refuses, saying
   `Author identity unknown` or `Please tell me who you are`, run these two commands, with your
   own name and e-mail instead of the examples (`example.com` is only an example), and repeat
   the `git commit`:

   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

6. <a id="step-6"></a>Create the repository on GitHub and push the vault, in one command (`init`
   prints this at its end):

   ```bash
   gh repo create my-brain --private --source . --push
   ```

   The repository is private because the vault holds notes about people, and a public
   repository shows them to anyone. The command pushes (`--push`) because without it the
   remote (the copy on GitHub) is empty, there is no default branch on it, and `propose`
   cannot work. The push runs the vault's push gate (`validate`, `lint` and a scan for
   credentials), so a vault that fails them is not published.
7. <a id="step-7"></a>Check the machine and the vault:

   ```bash
   brain-kit doctor
   ```

   The output shows only the warnings and the failures, with a count of the `ok` lines
   (`brain-kit doctor --verbose` lists them all). A healthy result has no `fail` line: its last
   line ends with `0 fail`. At this point `warn` lines about the scheduled curator
   (`watermark`, the last day read; `last-run`, the last round; `schedule`, the schedule;
   `notify`, the notify command; and `briefing`) are fine: you have not set one up, and
   [docs/scheduling.md](scheduling.md) covers it when you want a round to run by itself,
   on a timer. A `fail` says what to run to fix it; one for `gh` says `gh auth login`.
8. Open Claude Code inside the vault folder (`cd ~/my-brain`, if you opened another terminal;
   `init` prints this at its end):

   ```bash
   claude
   ```

   If Claude Code asks whether you trust this folder, answer yes. With the plugin installed,
   its nine skills and its `Stop` and `SessionStart` hooks work in this folder;
   [The Claude Code plugin](#the-claude-code-plugin) says what each does.
9. Write one fact in the vault's log, `memory/log.md` (`memoria/log.md` in a Portuguese
   vault). Either tell Claude something new, such as "Capture in the log that I started
   this vault today" (the `capture` skill writes the dated entry), or add it yourself: a
   `## YYYY-MM-DD` heading with today's date, and under it a line that starts with
   `**Capture**` (`**Captura**` in a Portuguese vault).
10. Open the pull request. The `Stop` hook runs when Claude finishes a reply: it sees the
    changed file and asks Claude to validate, lint and propose it, which the
    `curate-session` skill does too when asked. To do it yourself:

    ```bash
    brain-kit propose "First capture" --only memory/log.md
    ```

    `--only` names exactly the files to propose, and `propose` never moves your branch or
    your files. Add `--dry` first to see the plan: it refuses what the real run would refuse
    (no `gh`, not logged in, no `origin`, the address of the repository on GitHub, or the
    default branch not yet pushed). Leave the changed file uncommitted until the pull request
    is merged (step 11): `propose` builds its commit on the side, and committing the same file
    on your default branch makes `sync` refuse later, saying the branches have diverged.
11. <a id="step-11"></a>Merge the pull request on GitHub: your merge is the approval, and the
    only way the vault changes. Then `brain-kit sync` replaces the file you left uncommitted
    with the merged one and brings your local branch level with the remote, and
    `brain-kit verify --pr <number>` stamps `verified` on the notes that pull request
    changed (the `approve` skill does the same). The log is not a note, so for this first
    pull request, which changed only the log, `verify` ends by saying "nothing to stamp, and
    nothing was written", with no error; that is expected.

From here on, [The scheduled curator](#the-scheduled-curator) feeds the vault from your
Claude Code sessions without you asking, and [The morning briefing](#the-morning-briefing)
tells you each morning where it stands.

**If you get stuck**

- `EACCES` when installing (npm cannot write where it wanted): use the commands in [If you see `EACCES`](#if-you-see-eacces).
- `gh` asks you to log in: run `gh auth login` ([step 2](#step-2)) and try again.
- `propose` asks for the first commit ([step 5](#step-5)) or for `origin`, the GitHub address ([step 6](#step-6)); if it says "Push the default branch first", the repository already exists: run `git push -u origin HEAD` (repeating `gh repo create` fails).
- `command not found` for `brain-kit` after installing: npm may have refused in the middle of the output, which ends in "Successfully installed" anyway; go through the whole [If you see `EACCES`](#if-you-see-eacces) block, from the start.
- `doctor` says `fail` on `gh-auth`: the `gh` login expired or was never done; run the command the line shows, `gh auth login --hostname github.com`.
- A password or key showed up in the vault: stop and follow [docs/incident-response.md](incident-response.md).

## The same vault on a second machine

A vault you have already set up opens on another machine with a clone. What the clone does not
bring is that machine's own state (`machine.json`, the read marks and the logs), which lives
outside the vault and never goes into git. On the second machine, install the kit and the
plugin and log in to GitHub as in steps 1 and 2 of [Your first vault](#your-first-vault);
then, in this order:

1. Clone the vault (replace `my-brain` with the name you gave the repository):

   ```bash
   gh repo clone my-brain ~/my-brain
   cd ~/my-brain
   ```

2. Register the machine. `machine register --new` writes its `machine.json`, outside the
   vault, and touches no file of the vault:

   ```bash
   brain-kit machine register --new
   ```

3. Give the clone the vault's push gate (git does not version its own configuration, so a
   clone is born without it):

   ```bash
   git config core.hooksPath .githooks
   ```

4. Check. A healthy result has no `fail` line:

   ```bash
   brain-kit doctor
   ```

5. Only on the machine that will run the curator's rounds, install the schedule:

   ```bash
   brain-kit schedule install
   ```

Let only one machine run the curator's rounds: state is per machine, so two scheduled machines
would each propose the same day. On the other, use the vault by hand.

`brain-kit machine register --new` prints the same three steps after it finishes, in the same
order (it leaves out the clone and the register line, which you have just run).

A vault created by this version of `init` needs no edit on the second machine, even with the
clone in another folder: it lists its own project as `{vault}` in `include_projects`, which
stands for the vault's folder on each machine.

A vault created before 0.0.9 lists its project by the name it had on the first machine, and the
second machine's `doctor` gives `fail include-projects`. Do not put this machine's project name
in `brain-kit.config.json` to silence the `doctor`: the file is the same on both machines, and
the first one would stop reading its own sessions. The way out has an order. First install this
version of the kit on every machine that opens the vault: a kit older than 0.0.9 reads
`"{vault}"` as the name of a project, and fails the same check. Second, run `brain-kit update`
in the vault once, on the machine where you will edit the file; the other machines only install
the kit, and receive the change with `brain-kit sync` after the merge. Third, replace the name
in `sources.transcripts.include_projects` with `"{vault}"`, propose the change with
`brain-kit propose "Use {vault}" --only brain-kit.config.json` (after `--only`, add any other
file that `update` said it changed), merge it on GitHub and run `brain-kit sync` on both
machines; the `doctor` then ends with `0 fail`. Do not commit that file yourself before the
pull request is merged.
[docs/scheduling.md](scheduling.md#before-the-first-round) explains this in "Before the
first round", and has the
[details of the second machine](scheduling.md#the-same-vault-on-a-second-machine),
including how to move the rounds from one machine to the other.

## What is in the repository

brain-kit is one repository that is meant to be, at the same time:

- an npm package (the format Node uses to ship programs), `second-brain-kit`, with a single
  executable, `brain-kit`. Today it creates a vault or adopts an existing one, installs its
  push gate, keeps the kit's own files current, checks the machine with `doctor`, validates a
  vault and checks its health (`lint`), runs the pull request loop (`sync`, `propose`,
  `verify`), and runs the scheduled curator (`curate`, `watermark`, `schedule`) and the
  morning briefing's facts and question queue (`preflight`, `questions`);
- a Claude Code plugin (nine skills, the Stop and SessionStart hooks, a read-only
  subagent) that calls the same engine;
- a plugin marketplace of one, so that `claude plugin marketplace add aleckyann/brain-kit`
  followed by `claude plugin install brain-kit@brain-kit` installs it.

The npm registry refused the name `brain-kit`: an unrelated package named `brainkit`
already exists there, and the two were judged too similar. So the package is published
as `second-brain-kit`, while the repository, the plugin, the marketplace and the command
you type afterwards are all `brain-kit`.

The engine is Node.js with zero dependencies, runtime and development, and it runs on
Node.js 22 and 24 (both are tested on every change). The vault it generates is yours:
markdown files, each note with a header (the frontmatter, in YAML), and a configuration file
that holds only data, nothing else.

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
whether a failed round reaches you or only the log; what the curator records about personal
and sensitive subjects, in one line (`privacy-policy`); and, since phase 3, whether lint has
privacy keywords to refuse on added lines (none by default), anything a round may reach beyond the vault,
and each connector source: off or on, the state the last round saw with its date, a tool
prefix that does not match, other people's calendars without recorded consent, and a
user rule that refuses connector mode. `doctor --only connectors --probe` asks the CLI for
each connector's state now, without a round. Since phase 4 it also checks the morning
briefing: its signatures, its blocks, its question queue and its desktop task. Each failure
names the command that fixes it. By default the output shows only the warnings and the
failures, with a count of the `ok` lines; `--verbose` lists them all, and so does
`--only <id,...>` for the checks it names.

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
| `privacy` | confidential notes stay in confidential directories and are not linked from shared ones, and a line a change adds holds none of the terms in `privacy.third_party_keywords` (a list you set; empty by default) |
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

Scheduled rounds are optional: your first pull request does not need them. Linux is the
reference platform for scheduling (systemd user timers, which need `loginctl enable-linger` to
run while you are logged out); macOS (launchd) and cron entries are rendered and tested without
being installed by the test suite; Windows is out of scope for scheduling.

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

[docs/scheduling.md](scheduling.md) explains the round step by step, the windows, the
watermark and its import, moving from a legacy lock, the exit codes and what to do for each. [docs/security.md](security.md)
explains what isolates the model and the measurements behind it.

## Calendar and meeting notes

A round can also read your calendar, through the claude.ai Google Calendar connector, and
your meeting notes, through the claude.ai Google Drive connector; both connectors must be
connected in claude.ai and enabled for Claude Code. Both are off until you turn them on: the calendar by naming the calendars to read, the meeting notes by copying
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
own session, with your confirmation for every row. [docs/connectors.md](connectors.md)
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
record there is none. The briefing on a schedule needs the Claude desktop application:
`schedule install --job briefing` prints the task to create in it, which the `setup` skill
registers for you; it runs while the application is open, and on its next launch when it was
closed. A session that starts with the task's prompt never reaches the curator; a briefing
you ask for in your own session is yours, and the curator reads it. [docs/briefing.md](briefing.md) explains
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
[docs/briefing.md](briefing.md), "Which sessions the curator skips", has the details.

## Privacy: what the curator saves

By default the curator saves everything your sessions, calendar and meeting notes teach the
vault, personal and sensitive information included (health, family, relationships,
finances, anything intimate), yours and other people's: nothing is left out or shortened
because it seems sensitive. That is why the vault's repository must stay private, and
`init` refuses a vault whose repository would not be. Under privacy laws such as the LGPD
and the GDPR, what the vault holds about other people is personal data, and data about their
health, sex life, religious beliefs or political opinions, among other categories these laws
list, are sensitive personal data; as the
vault's owner you answer for keeping them, so record about others what you have a reason
to keep.

To save less, set `privacy.sensitive` in `brain-kit.config.json`. It gives a level to each of
three audiences: `owner` (you), `people` (anyone who already has a note in the vault: team,
family, mentors) and `outsiders` (everyone else: clients, prospects, strangers). The levels
are `save` (record normally), `summary` (record that the subject came up and what was
decided or agreed, without the intimate details) and `skip` (leave it out, without saying
so). `privacy.never_topics` lists subjects never recorded about anyone, whatever the levels
say. For example, beside the keys the `privacy` section already holds:

```json
"privacy": {
  "sensitive": { "owner": "save", "people": "summary", "outsiders": "skip" },
  "never_topics": ["health", "legal cases"]
}
```

A configuration without these keys saves everything. Every round prints the policy it
applied in one line, and so do `brain-kit curate --dry` and `brain-kit doctor --verbose`
(check `privacy-policy`). The scheduled round, the `curate-session` and `capture` skills and
the morning briefing all follow it.

Two limits, said plainly. The policy is an instruction to a model, not a guarantee: no code
checks what a round wrote against the levels, and you see what it wrote in the pull request
before you merge it. For a phrase that must never get in, list it in
`privacy.third_party_keywords`, empty by default: `lint`, and so `propose`, refuses a line a
change adds that holds one. And the policy controls what is written into the vault, not
what the model reads: a round still reads every session, event and document its sources
offer. [docs/security.md](security.md), "What the curator records", has the rest.

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
[docs/testing.md](testing.md).

## Status

<!-- status-reviewed: 0.1.0 -->

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | done, 0.0.1 on npm |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | done |
| 2 | Scheduled curator over local transcripts, scheduler templates | done |
| 3 | Calendar and meeting-notes sources (best effort by design) | done |
| 4 | Morning briefing | done |
| 5 | Migration of the original vault onto the kit | in progress. Done: 5a (what a migrating vault needs, since 0.0.2); the vault's scheduled curator moved from its legacy scripts to the kit on 01/10/2026 (a systemd user timer at 09:30 with retries at 14:00 and 20:00, the legacy timer disabled) and its first real rounds were supervised; the model reads a text digest of each transcript (0.0.5); the morning briefing runs as a desktop application task and ran for the first time on 01/10/2026, and since 0.0.6 the curator recognizes its session through the envelope the application wraps around the task's prompt. Since 0.0.10 what the curator records is a setting of the kit, and by default it records everything, personal and sensitive information included. Open for the exit of the phase: five curator rounds and three briefings without an unexplained failure, the cleanup of the legacy scripts after seven stable days, and the first `verify` on the vault |
| 6 | 0.1.0 release on npm | 0.1.0 published on npm on 02/10/2026, by the owner's decision, before an external adopter's run; what that run and the exit of Phase 5 find ships as 0.1.x. Done before it: `docs/incident-response.md`, `examples/minimal-vault`, two walkthroughs on a clean machine by an agent playing a first-time user, not a person (the first found the gaps between `init` and the first pull request, which 0.0.8 closed; the second followed only the Portuguese README, reached the first pull request, and found what 0.0.9 closed: a README for someone who is not a developer, a Node older than the minimum, a `doctor` that checked nothing before the first vault, and a vault's project that only worked on the machine that made it), the supported Node set at 22 (0.0.9), and a GitHub Release with the CHANGELOG text for every tag. Open: a run by an external adopter, a person who is not the maintainer (the 0.1.0 criterion: from a clean machine to a validated vault, the plugin installed, the hook active and a first pull request in under 30 minutes by the adopter's own clock; the README's estimate, with the reading, is about 35, and no person has timed the path yet), and the exit of Phase 5 |
| 7 | Other forges, other harnesses, more sources, each only when a second real case needs it | planned |

The latest tag is `v0.1.0`. Every version from 0.0.2 on is a git tag, and 0.1.0 is also the
first on npm (`second-brain-kit`) since the Phase 0 skeleton 0.0.1.

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
above. The 0.1.0 release on npm is Phase 6, which is in progress (see its row).

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
remove it from history, and follow the vault's `SECURITY.md`. [SECURITY.md](../SECURITY.md)
lists what the gates do not cover.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first. Every clone must run
`.githooks/install-gate` once, or that clone has no leak gate at all.

## Why

Read [docs/rationale.md](rationale.md) for the reasoning and
[docs/incidents.md](incidents.md) for the dated failures that produced every guard.

## License

MIT ([LICENSE](../LICENSE)). The front door of the repository, in Portuguese: [README.md](../README.md).
The complete guide in Portuguese: [guia.md](guia.md).
