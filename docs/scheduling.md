# Scheduling the curator

`brain-kit curate` runs one curator round: it reads the Claude Code sessions you had
since the last round, gives them to a model that can act only through the kit's own
commands, and ends with a pull request against your vault that you review and merge.
`brain-kit schedule install` makes that happen on its own a few times a day. This page
explains what a round does, when it runs, how it knows which days it has already read,
and what to look at when it seems to do nothing.

Every date on this page is written DD/MM/YYYY. What isolates the model from your own
Claude Code settings, and why, is in [security.md](security.md). The failures that shaped
each step are in [incidents.md](incidents.md).

## Before the first round

```bash
brain-kit machine set transcripts_dir ~/.claude/projects    # the default; set it only if yours differs
brain-kit machine set notify_command '["notify-send", "brain-kit"]'
brain-kit curate --dry                                      # what a round would do, nothing written
brain-kit curate --check                                    # every step up to the model, no model call
brain-kit curate                                            # one real round
brain-kit schedule install
brain-kit doctor
```

`sources.transcripts.include_projects` in `brain-kit.config.json` lists the Claude Code
project directories (the names under `~/.claude/projects`) whose sessions feed the vault.
Nothing outside that list is ever offered to the model. An empty list makes every round
refuse to run, and `doctor` says so.

## What a round does, step by step

The order is fixed and tested; each step exists because doing it later, or not at all,
once broke a real routine.

1. **The vault and its machine file.** No `machine.json`, or an invalid one: exit 2.
2. **`--dry` stops here.** It prints the window, the sources, the files each source would
   offer and the full command line of the model, reading the configuration as it is in
   the working tree now, unsynced. It takes no lock and writes nothing.
3. **The vault lock.** Another writer holds it (a `propose` of yours, another round): exit
   75 naming the holder.
4. **The network.** The round waits for a connection, up to two minutes, by running
   `machine.network_check` or, when that is unset, by opening a connection to the model's
   endpoint. None: exit 69. A check that answers in under 100 milliseconds on its first try
   is accepted but noted as "did not wait" in the log and in `last-run.json`: it may be
   answering about something other than the connection. The note is never a failure.
5. **Sync.** The default branch is brought level with its remote. Behind: fast-forward.
   Diverged: exit 1, because retrying cannot fix it and a person has to reconcile the two
   histories. An operation in progress or a dirty tree in the way: exit 75.
6. **The configuration and the prompt, as synced.** Only now, so a change you merged
   upstream is what runs. A `curate.prompt` that points outside the vault: exit 2.
7. **The window**, from the watermark (below). Nothing open: exit 0, "up to date".
8. **A clean tree.** Any uncommitted file postpones the round: exit 75, naming every file
   with its modification time.
9. **The round's own snapshot**, so the `propose` the model runs can tell what the round
   wrote from what was already there.
10. **The CLI.** `claude_bin` must be a real program: not missing, not a launcher of a few
    hundred bytes left by an interrupted install, and `--version` must print a version.
    Otherwise exit 1.
11. **The sources.** Each source lists the files of its window. A required source that is
    misconfigured (no projects, a missing transcripts directory, every listed project
    missing): exit 1, and no mark moves. A window with nothing in it at all advances the
    mark and exits 0 without calling the model.
12. **`--check` stops here.** It prints the plan, the command line and the prompt's size.
13. **The model, isolated.** The prompt goes on standard input. The first event the CLI
    prints says which permission mode, hooks and MCP servers are in effect; if it is not
    exactly the isolation the round asked for, the model is stopped at once: exit 1. The
    model runs in a process group of its own, and the whole group is killed on timeout
    (60 minutes) or when the round is interrupted (SIGINT, SIGTERM, SIGHUP or SIGQUIT),
    so no command it started outlives the round. A SIGKILL of `curate` itself cannot be
    handled: the model then keeps running until it ends, and the lock is taken back as
    stale only after that.
14. **What the model read.** For every file the plan offered, the round looks for a
    successful Read of exactly that path. It also reads the model's last line,
    `BRAIN_KIT_SOURCES: transcripts=ok`, and the record of every pull request the model's
    `propose` opened.
15. **Cleanup.** Every file the round proposed that is still byte for byte what was pushed
    is brought back to the default branch's content, so the next round does not stop on a
    dirty tree made by this one.
16. **The exit code**, first match wins: isolation broken 1; interrupted or timed out 1;
    the model failed 69 (an API or login error) or 1; a required source whose mark would
    not advance 4 (a file not read, or no `BRAIN_KIT_SOURCES` line reporting it); a round
    record that cannot be read 1; anything still dirty 1; a pull request not opened 3;
    otherwise 0.
17. **The watermark** advances, only on exit 0 or 3 (below).
18. **Always:** `last-run.json` is written, the log gets its last line, the lock is released
    (the model's process group is already dead), and `machine.notify_command` runs on any
    non-zero exit, with the reason as its last argument.

## The windows, and why daytime

The default windows are 09:30, 14:00 and 20:00, set in `curate.schedule`. Every window
must fall between 07:00 and 22:59; `schedule install` refuses anything else. A round
scheduled overnight does not run at night: the laptop is asleep, the scheduler fires at
resume instead, and the round starts before the network is up (incident of 14/09/2026).
Three windows are retries of one another: a round that was postponed at 09:30 runs again at
14:00. That is safe only because of the watermark, which makes a second round of the same
day a no-op.

The windows fire on the machine's clock. The round itself counts days in
`vault.timezone`, and `schedule install` warns when the two clocks differ.

What each platform does with a window missed while the machine was off or asleep:

- **systemd** (the reference on Linux): user units with `Persistent=false`, so a missed
  window is skipped, not run late. A user timer runs only while you are logged in, unless
  lingering is enabled for your user: `loginctl enable-linger $USER`.
- **launchd** (macOS): launchd has no switch to skip a missed window. It fires once at wake
  for a window missed during sleep. The round's own network wait is what covers that.
- **cron**: a missed window is not caught up.

`brain-kit schedule status` compares what is installed with what `install` would write
now, asks the scheduler whether the entry is enabled, and prints the next three fire times
and the last round's summary, both as DD/MM/YYYY HH:MM on the machine's clock.

## The watermark

The watermark holds, per source, the last day a round swept. It lives in
`watermark.json` in the state directory. A mark at yesterday is the normal state: today
is read tomorrow, once it has ended.

- **Which days a round reads.** From the day after the mark up to yesterday, in
  `vault.timezone`. With no mark yet, only yesterday. A round reads at most the seven
  oldest open days; when more are open it reads the oldest seven, moves the mark through
  the last one it read, says how many remain, and the next round continues from there.
  Days are caught up oldest first, and none is skipped.
- **When it moves.** Only on exit 0 or 3, and for each source only when the model exited
  0, every file the plan offered for that source was read, and the model's last line
  reports the source `ok` (or `empty`, when the plan indeed offered nothing). A round that
  dies halfway leaves the day open, and the next round reads it again.
- **It never closes a day unread.** A required source whose mark would not advance makes
  the round exit 4: a file the model did not read, a transcript or a listed project
  directory that cannot be read, or a last line that is missing or does not report the
  source. The mark stays, and the next round reads the day again.

The commands:

```bash
brain-kit watermark show                              # each source's mark and how far behind yesterday it is
brain-kit watermark reopen transcripts 2026-09-20     # read 20/09/2026 and every later day again
brain-kit watermark set transcripts 2026-09-22        # record 22/09/2026 as the last day swept
brain-kit watermark assume-covered transcripts        # mark yesterday as swept, listing every day it skips
```

Days on the command line are written YYYY-MM-DD; everything the kit prints for you is
DD/MM/YYYY. A mark can never name today or a later day. If one does (a clock that was
wrong, a hand edit), every round refuses with exit 1 and names the `reopen` command that
fixes it.

What counts as read has limits, by design:

- One successful Read of a transcript counts as reading it, even of a single line. The
  prompt tells the model to sample a long transcript from its end and then in slices,
  never whole; the evidence proves the model opened the file, not how much of it it read.
- The Read tool truncates very long lines. A session line holding a huge tool result is
  read cut short.
- The model may write only inside the vault, and never into the kit's own files there
  ([security.md](security.md)). The leftovers check sees the files git tracks or would
  track: a file the model wrote into a path the vault's `.gitignore` ignores is not
  reported.

## Exit codes, and what to do for each

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Done, nothing to do, or up to date | Nothing. Review the pull request if one was opened. |
| 1 | The round failed | Read `reason` in `last-run.json`. It names the setting or the command that fixes it: a diverged branch to reconcile, a watermark to reopen, a CLI to reinstall, a file the round left behind. |
| 2 | Not a vault, or a bad setting | Fix `machine.json` or `brain-kit.config.json` as the message says, then `brain-kit doctor`. |
| 3 | Proposed, but the pull request is not open | The commit and branch are pushed; open the pull request the message names (check `gh auth status`). The mark advanced. |
| 4 | A required source was not read | `last-run.json` says how many files of how many were read. Fix what kept them from being read (permissions, a missing project); when every file was read, the model's last line did not report the source. The day stays open and the next round reads it. |
| 69 | No network, or the model unavailable | Usually passes on its own at the next window. An authentication error means your Claude Code login expired: log in again. |
| 75 | Postponed | Another writer holds the lock, or the tree is dirty (the files are listed). Commit, propose or discard them; the next window retries. A tree that stays dirty stops every round, so do not let it sit. |

## Reading last-run.json and the logs

Both live in the state directory, outside the vault: `BRAIN_KIT_STATE_DIR` when set,
otherwise `~/.local/state/brain-kit/<vault name>-<hash>/` (or under `$XDG_STATE_HOME`).
`brain-kit machine show` prints `machine.json`, whose `state_dir` names it.

`last-run.json` is the last round, rewritten at its end (never by `--dry` or `--check`):

| Field | What it holds |
|---|---|
| `at`, `durationMs` | when the round started (ISO, UTC) and how long it took |
| `exit`, `reasonCode`, `reason` | the exit code, a stable code for it, and the sentence printed |
| `window` | the days read (`days`), the instants the window spans, and `remaining` days left for the next round |
| `network` | whether the network answered, after how long, and the `did_not_wait` note |
| `sources` | per source: files kept by the plan, files read, and whether its mark advanced |
| `warnings`, `remainingDays` | everything said on the way, and the days still open |
| `costUsd`, `numTurns` | what the model cost and how many turns it took |
| `denials` | the names of the tools the model was denied, never their input |
| `isolation` | whether the init event proved the isolation, and what was wrong if not |
| `proposed` | every pull request the round opened: branch, paths, and whether it opened |
| `leftovers` | files still dirty after the cleanup |

The log is `logs/curate-YYYY-MM-DD.log`, one file per day, one line per event:
`<instant> <event> <json>`. The events are `start`, `network_did_not_wait`,
`days_remaining`, `source_skipped`, `source_warning`, `plan`, `model_start`, `model_end`,
`cleanup`, `watermark`, `exit` and `notify_failed`. The log never holds what a tool
returned, the model's final text, anything read from a transcript, or the round's token.
`brain-kit curate --keep-stream` (or `keep_stream: true` in `machine.json`) also keeps the
model's raw output next to the log; that file does contain what the model read, so keep it
only while you debug. Logs older than `log_retention_days` (in `machine.json`, default 30)
are removed at the end of each round.

`brain-kit doctor` reads all of this for you: the last round (with a warning for a round
that exited 0 in seconds without a model turn, which is a dead round reported as a
success), each source's mark and how far behind it is, whether the timer is installed and
when it fires next, and whether failures reach you or only the log.

## When rounds seem to do nothing

Compare the sizes of the recent logs first. A healthy round writes a dozen lines or more,
with a `model_end` and a `watermark` line. A run of logs that are all the same small size
means every round dies at the same early step, and the `exit` line of any of them names
it. In the original vault four days of rounds died on a dirty tree while the scheduler
reported success, and every log file was 95 bytes long (incident of 13/09/2026).

Then, in order:

1. `brain-kit doctor`: it runs every check in one pass, and failures stack; fixing the top
   one often reveals the next.
2. `brain-kit schedule status`: installed, current and enabled, and when it fires next.
   On Linux, if rounds only run while you are logged in, enable lingering.
3. `brain-kit watermark show`: a mark days behind yesterday means rounds are not closing
   days; `last-run.json` says why.
4. `brain-kit curate --check`, then one `brain-kit curate` by hand, reading its output to
   the last line.
