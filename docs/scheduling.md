# Scheduling the curator

`brain-kit curate` runs one curator round: it reads the Claude Code sessions you had
since the last round, and your calendar and meeting notes when you have turned them on,
gives them to a model that can act only through the kit's own commands, and ends with a
pull request against your vault that you review and merge.
`brain-kit schedule install` makes that happen on its own a few times a day. This page
explains what a round does, when it runs, how it knows which days it has already read,
and what to look at when it seems to do nothing.

Every date on this page is written DD/MM/YYYY. What isolates the model from your own
Claude Code settings, and why, is in [security.md](security.md); how a round reaches your
calendar and meeting notes is in [connectors.md](connectors.md). The failures that shaped
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

The calendar and the meeting notes are off until you turn them on:
[connectors.md](connectors.md) says how, and `brain-kit doctor --only connectors --probe`
checks, without a round, that their connectors are there.

## What a round does, step by step

The order is fixed and tested; each step exists because doing it later, or not at all,
once broke a real routine.

1. **The vault and its machine file.** No `machine.json`, or an invalid one: exit 2.
2. **`--dry` stops here.** It prints the window, the sources and each one's days, the
   files each source would offer, the launch mode with every user rule that refuses
   connector mode, the full command line of the model and the cost cap, reading the
   configuration as it is in the working tree now, unsynced. It takes no lock and writes
   nothing.
3. **The vault lock.** Another writer holds it (a `propose` of yours, another round): exit
   75 naming the holder. With `paths.legacy_lock` set, the legacy lock too
   ([below](#moving-from-a-legacy-lock)): held, exit 75 naming the file; unusable, exit 1.
4. **The network.** The round waits for a connection, up to two minutes, by running
   `machine.network_check` or, when that is unset, by opening a connection to the model's
   endpoint. None: exit 69. A check that answers in under 100 milliseconds
   (`curate.network_min_wait_ms`) on its first try is accepted but noted as "did not wait"
   in the log and in `last-run.json`: it may be answering about something other than the
   connection. The note is never a failure.
5. **Sync.** The default branch is brought level with its remote. Behind: fast-forward.
   Diverged: exit 1, because retrying cannot fix it and a person has to reconcile the two
   histories. An operation in progress or a dirty tree in the way: exit 75.
6. **The configuration and the prompt, as synced.** Only now, so a change you merged
   upstream is what runs. A `curate.prompt` that points outside the vault, or a rule in
   `curate.allowed_tools_extra` that grants a path or command tool with no scope: exit 2.
   From here on the round speaks the vault's language (`lang`), whatever the scheduler's
   environment says: its output, `last-run.json` and the notification.
7. **The window**, from the watermark (below). Nothing open: exit 0, "up to date".
8. **A clean tree.** Any uncommitted file postpones the round: exit 75, naming every file
   with its modification time.
9. **The round's own snapshot**, so the `propose` the model runs can tell what the round
   wrote from what was already there.
10. **The CLI.** `claude_bin` must be a real program: not missing, not a launcher of a few
    hundred bytes left by an interrupted install, and `--version` must print a version.
    Otherwise exit 1.
11. **The sources, each over its own days.** Every source reads only its own open days,
    the days of the window after its own mark (see the watermark, below). A listed source
    that is off is recorded in `last-run.json` (`notConfigured`); when it is off for any
    reason but its own `"enabled": false` (half configured, such as a calendar listed with
    no `enabled`), the round also says so, and a required source that is off stops the
    round: exit 1. A source with no open day of its own is not collected, not offered and
    not advanced. For the transcripts: a required source that is misconfigured (no
    projects, a missing transcripts directory, every listed project missing): exit 1, and
    no mark moves. A required source listing a file it cannot read (an I/O error, a file of
    which no line is JSON, a conversation none of whose messages carries a timestamp this
    version can read, or a path no read rule can name exactly): exit 4 before the model,
    naming the file, since no round could close its day. The transcripts cap
    (`curate.caps.transcripts`) takes whole days, oldest first: the days that do not fit
    wait for the next round and are said on the output, in the log and in
    `last-run.json`, and this round curates, and advances through, only the days it took;
    a first open day that alone passes the cap: exit 4 before the model, naming the day and
    the counts. A window whose offered sources are all local and hold nothing advances the
    marks and exits 0 without calling the model; a connector source never counts as empty
    that way, since an empty day of a calendar is a listing still to prove.
12. **The launch mode.** With a connector source to read, the round reads your Claude Code
    user settings and mirrors every allow rule in them as a deny: connector mode, unless a
    rule refuses it, in which case every connector source gets the state
    `blocked_by_user_rules` and the round runs isolated, on the transcripts alone. Without
    one, the isolated mode ([security.md](security.md), [connectors.md](connectors.md)).
    **`--check` stops here.** It prints the plan, the mode, every rule that refused it,
    the command line, the cost cap and the prompt's size.
13. **The model.** The round says its cost cap: `curate.budget_usd`, the default of 5 USD
    when the key is left out, or none when it is `null`, in which case the command line
    carries no `--max-budget-usd` at all. The prompt goes on standard input. The first
    event the CLI prints says which permission mode, hooks, MCP servers, built-in tools and
    memory folders are in effect; if it is not exactly the isolation of the mode the round
    asked for, the model is stopped at once: exit 1. In connector mode the same event says
    each connector's state: a connector that needs authentication, failed, is absent, lacks
    its tools or reports a status the kit does not know makes the round kill the model
    before its first turn and launch once more without that source, told it is unavailable
    and forbidden to reach it any other way. There is never a second relaunch, and a
    connector still connecting (`pending`) stays in the round. When nothing is left for a
    model to read, no second launch happens at all. The model runs in a process group of
    its own, and the whole group is killed on timeout (60 minutes) or when the round is
    interrupted (SIGINT, SIGTERM, SIGHUP, SIGQUIT, or a rarer signal that would end it:
    SIGUSR2, SIGALRM, SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, SIGPWR where the system has
    it), so no command it started outlives the round. A hook event later in the stream
    kills the model the moment it is seen, and the reason says the model had already
    started. A SIGKILL of `curate` itself cannot be handled: the model then keeps running
    until it ends, and the lock is taken back as stale only after that.
14. **What the model read.** For every file the plan offered, the round looks for a
    successful Read of exactly that path; for the calendar, a listing of each calendar that
    covers its window with the event-type filter and every page; for the meeting notes, the
    literal title search with its bound, to its last page ([connectors.md](connectors.md)).
    It also reads the model's last line, which names every source the round offered, and
    the record of every pull request the model's `propose` opened.
15. **Cleanup.** Every file the round proposed that is still byte for byte what was pushed
    is brought back to the default branch's content, so the next round does not stop on a
    dirty tree made by this one.
16. **The exit code**, first match wins: isolation broken 1; interrupted or timed out 1;
    the model failed 69 (an API or login error) or 1; a required source whose mark would
    not advance 4 (a file not read, or no `BRAIN_KIT_SOURCES` line reporting it); a round
    record that cannot be read 1; anything still dirty 1; a pull request not opened 3
    (the reason names the branch and the `gh pr create --head <branch> --fill` that opens
    it); otherwise 0. A best-effort source (the calendar and the meeting notes, by
    default) never changes it, read or not.
17. **The watermark** advances, only on exit 0 or 3, each source through its own last day
    (below).
18. **Always:** `last-run.json` is written, the log gets its last line, the lock is released
    (the model's process group is already dead), and `machine.notify_command` runs on any
    non-zero exit, with the reason as its last argument, and once more for each
    best-effort connector source whose state changed since the last round.

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

The entry runs the round with a `PATH` of its own, not your shell's: `machine.path_extra`,
the directory of `claude_bin`, node's directory and the system directories. The model's
`propose` needs two commands on it: `brain-kit`, because the vault's pre-push gate runs the
`brain-kit` on `PATH`, and `gh`, which opens the pull request. `schedule install` looks for
both there, adds the directory where your shell finds one that is missing, and refuses
(exit 2) when your shell does not find it either, saying how to install it. Run it again
after moving either one. `doctor` (check `brain-kit-on-path`) reads the installed entry's
`PATH` back and says when it does not reach them.

What each platform does with a window missed while the machine was off or asleep:

- **systemd** (the reference on Linux): user units with `Persistent=false`, so a missed
  window is skipped, not run late. A user timer runs only while you are logged in, unless
  lingering is enabled for your user: `loginctl enable-linger $USER`.
- **launchd** (macOS): launchd has no switch to skip a missed window. It fires once at wake
  for a window missed during sleep. The round's own network wait is what covers that.
- **cron**: a missed window is not caught up.

`brain-kit schedule status` compares what is installed with what `install` would write
now (the directories `install` added for `brain-kit` and `gh` are taken from the installed
entry, not from the shell `status` runs in), asks the scheduler whether the entry is enabled, and prints the next three fire times
and the last round's summary, both as DD/MM/YYYY HH:MM on the machine's clock.

## The watermark

The watermark holds, per source, the last day a round swept. It lives in
`watermark.json` in the state directory. A mark at yesterday is the normal state: today
is read tomorrow, once it has ended.

- **Which days a round reads.** From the day after the mark up to yesterday, in
  `vault.timezone`. With no mark yet, only yesterday. A round reads at most the seven
  oldest open days; when more are open it reads the oldest seven, moves the mark through
  the last one it read, says how many remain, and the next round continues from there.
  Days are caught up oldest first, and none is skipped. A round also takes only whole
  days that fit in `curate.caps.transcripts` together: the rest wait for the next round,
  and a first open day that alone holds more transcripts than the cap stops the round
  (exit 4) until you raise the cap or exclude some projects.
- **One window per source.** Each source reads only its own open days, the days of the
  round's window after its own mark (an unset mark: yesterday only), and advances only
  through the last of them. The round's window is their union, from the earliest mark. A
  calendar two days behind the transcripts reads its own two days while the transcripts
  read only theirs, and no source reads a day it already covered, so nothing is captured
  twice. The one exception is the calendar while the meeting notes are on: it is listed
  over every day the meeting notes have open too, within its own seven, so the notes can
  reach the documents attached to those days' events; a day the calendar already closed is
  listed again for that alone, and the model is told to capture nothing new from it. When
  the two are more than seven days apart, the oldest seven are listed and the later
  meeting-notes days wait ([connectors.md](connectors.md), "The meeting notes").
- **When it moves.** Only on exit 0 or 3, and for each source only when the model exited
  0, the source's evidence shows it read (every file the plan offered, for the
  transcripts; every calendar listed, for the calendar; the literal search, for the
  meeting notes, and, while the calendar is on, the calendar's listing of the same day in
  the same round), and the model's last line reports the source `ok`, or `empty` when that
  means nothing was there: for the transcripts, a plan that offered nothing; for a
  connector source, a listing or search that was made and listed nothing. `partial` (the
  meeting notes past their caps), `unavailable` and `failed` never move a mark. A round
  that dies halfway leaves the day open, and the next round reads it again.
- **The meeting notes wait for the calendar.** While the calendar is on, a round that will
  not read it (its connector missing at the first launch, or a user rule that blocks it)
  does not offer the meeting notes at all: no model work is spent on them, and their days
  stay open (`waiting_for_calendar`) until a round reads the calendar again.
- **Why a mark did not move** is the reason on the `watermark` log line and in the
  `the watermark of <source> did not move (<reason>)` line on stderr: `model_exit` (the
  model did not exit 0), `no_evidence` (the record does not show the read), `no_sources_line`
  and `not_reported` (the last line is missing, or does not name the source),
  `reported_failed` (any state but `ok` or `empty`, `invalid` included), `empty_with_files`
  (the transcripts reported empty with files offered), `empty_nothing_listed` and
  `inconsistent_empty` (a connector source reported empty with no listing made, or with a
  listing that found something), `second_door_unread` (meeting notes whose day the
  calendar did not list in the same round), `waiting_for_calendar` (meeting notes not
  offered, above), `not_vacuous` (no model ran, and the source could not close on
  nothing), `future_day`, and `not_later` (the mark already covers the day; never
  reported as a problem).
- **The last line** names every source the round offered, with the states each may be
  given:

  ```
  BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed> calendar=<ok|empty|failed|unavailable> meeting_notes=<ok|empty|partial|failed|unavailable>
  ```

  A source the round could not read this time (its connector missing at the first launch,
  or blocked by a user rule) is still named, to be written `unavailable`.
- **It never closes a day unread.** A required source whose mark would not advance makes
  the round exit 4: a file the model did not read, a transcript or a listed project
  directory that cannot be read (the model is then not started at all), a first day over
  the cap, or a last line that is missing or does not report the source. The mark stays,
  and the next round reads the day again. A transcript with no conversation at all (no
  user or assistant line: only a title or a summary) belongs to no day: it is counted as
  `noTimestamp` in `last-run.json` and blocks nothing. One whose user or assistant lines
  carry no timestamp this version can read is not empty: it stops the round (exit 4).

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

## Moving from a legacy lock

A vault that already runs scripts of its own often has a scheduled job that holds an
exclusive `flock` on one file for its whole run (`exec 9>>/path/to/file; flock -n 9`), and
a Stop hook that stands down while it does. While that job and the kit's rounds are both
installed, point the kit at the same file:

```bash
brain-kit machine set paths.legacy_lock /absolute/path/to/the/legacy.lock
brain-kit doctor --only legacy-lock
```

From then on every command that takes the vault lock (a round, `propose`, `sync`,
`verify`, and the writing subcommands of `watermark` and `questions`) also holds an
exclusive flock on that file for as long as it holds the vault lock, taken without
waiting. While the legacy job holds it, the command is postponed exactly as for a held
vault lock: exit 75, naming the file. While the command holds it, the legacy job's own
`flock -n` fails, as it does against a run of its own. The kernel lets go of it when the command
ends, however it ends. The kit creates the file when it is not there, as `flock` does,
and never writes or deletes it. The `propose` a round's model runs joins the round and
does not take the lock a second time. The kit's Stop hook stands down while another
process holds it.

The bridge needs Linux and util-linux `flock` on the `PATH` the command runs with. One
that cannot be used (not Linux, no `flock`, the file's directory missing) refuses every
writer with exit 1 until you fix it or turn it off, and `brain-kit doctor` says which.
`machine set` and `machine register` never take the legacy lock, so turning it off always
works; do it once the legacy job is uninstalled:

```bash
brain-kit machine set paths.legacy_lock null
```

## Exit codes, and what to do for each

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Done, nothing to do, or up to date | Nothing. Review the pull request if one was opened. |
| 1 | The round failed | Read `reason` in `last-run.json`. It names the setting or the command that fixes it: a diverged branch to reconcile, a watermark to reopen, a CLI to reinstall, a file the round left behind. |
| 2 | Not a vault, or a bad setting | Fix `machine.json` or `brain-kit.config.json` as the message says, then `brain-kit doctor`. |
| 3 | Proposed, but the pull request is not open | The commit and branch are pushed; from the vault, run the `gh pr create --head <branch> --fill` the reason names (check `gh auth status`). The mark advanced. |
| 4 | A required source was not read | Only a source in `curate.sources.required` sets it; a best-effort one never does. The reason says which. A file that cannot be read (`source_unreadable`): fix its permissions, or add a pattern for it to `sources.transcripts.exclude_path_patterns`; `brain-kit watermark assume-covered` skips its days once you have looked. A first day over the cap (`cap_exceeded`): raise `curate.caps.transcripts` or exclude some projects. Otherwise `last-run.json` says how many files of how many were read, or that the model's last line did not report the source. The day stays open and the next round reads it. |
| 69 | No network, or the model unavailable | Usually passes on its own at the next window. An authentication error means your Claude Code login expired: log in again. |
| 75 | Postponed | Another writer holds the vault lock or the legacy lock, or the tree is dirty (the files are listed). Commit, propose or discard them; the next window retries. A tree that stays dirty stops every round, so do not let it sit. |

## Reading last-run.json and the logs

Both live in the state directory, outside the vault: `BRAIN_KIT_STATE_DIR` when set,
otherwise `~/.local/state/brain-kit/<vault name>-<hash>/` (or under `$XDG_STATE_HOME`).
`brain-kit machine show` prints `machine.json`, whose `state_dir` names it.

`last-run.json` is the last round, rewritten at its end (never by `--dry` or `--check`):

| Field | What it holds |
|---|---|
| `at`, `durationMs` | when the round started (ISO, UTC) and how long it took |
| `exit`, `reasonCode`, `reason` | the exit code, a stable code for it, and the sentence printed |
| `window` | the days read (`days`), the instants the window spans, `remaining` days left for the next round, and `sources`, each source's own days |
| `deferredDays` | the open days left for the next round because they would pass the transcripts cap |
| `network` | whether the network answered, after how long, and the `did_not_wait` note |
| `sources` | per source: for the transcripts, files kept by the plan, files read, whether its mark advanced, and `noTimestamp`, the files left out for holding no conversation; for a connector source, its `state`, the tool prefix its tools were seen under (`observedPrefix`), `read` against `expected` (calendars listed, or the search made), `listed` (how many events or files the pages that read it listed, null when not known), whether its mark advanced, what the model `reported` for it (`invalid` when the last line gave a value that is not a state, never the value itself), the `rules` that blocked it when a user rule did, for the meeting notes `documents` (how many opened, how many failed), and `waitingFor` (the calendar and its state) when they were not offered because the calendar was not read |
| `mode`, `relaunched` | the last launch's mode (`isolated` or `connectors`), and whether the round launched a second time |
| `notConfigured` | each listed source that is off, with its problems |
| `userRules` | in a round with a connector source to read: the user allow rules mirrored as denies (`mirrored`), those recorded as widening reads (`widenedReads`), and those that refused connector mode (`blocking`); null otherwise |
| `connectorStates` | each connector source's last known state and when a round saw it, carried from round to round (what the notification and the session's status line compare against) |
| `warnings`, `remainingDays` | everything said on the way, and the days still open |
| `costUsd`, `numTurns` | what the model cost and how many turns it took |
| `budgetUsd` | the cost cap the model ran under, in USD; `null` when `curate.budget_usd` is `null` and the round passed no cap; absent when no model was launched |
| `denials` | the names of the tools the model was denied, never their input |
| `isolation` | whether the init event proved the isolation, and what was wrong if not |
| `proposed` | every pull request the round opened: branch, paths, and whether it opened |
| `leftovers` | files still dirty after the cleanup |

The log is `logs/curate-YYYY-MM-DD.log`, one file per day, one line per event:
`<instant> <event> <json>`. The events are `start`, `network_did_not_wait`,
`days_remaining`, `days_deferred`, `source_skipped`, `source_off` (a listed source half
configured), `source_warning`, `source_no_day` (a source with no open day of its own),
`source_blocked` (a connector source a user rule blocked, with the rule), `source_waiting`
(the meeting notes left out because the calendar is not read, with its state), `plan`,
`model_start` and `model_end` (one of each per launch, with its number and, on
`model_start`, its mode), `connectors` (each connector's state in a launch's first event),
`relaunch` (the sources the second launch goes without, and why), `model_result` (the
denials and the isolation verdict), `connector_state_changed`, `cleanup`, `watermark` (with
what the model reported, and the reason when the mark did not move), `exit`, `notify_state` (a state-change notification) and
`notify_failed`. The log never holds what a tool returned, the model's final text, anything
read from a transcript, a calendar or a document, or the round's token.
`brain-kit curate --keep-stream` (or `keep_stream: true` in `machine.json`) also keeps the
model's raw output next to the log; that file does contain what the model read, so keep it
only while you debug. Logs older than `log_retention_days` (in `machine.json`, default 30)
are removed at the end of each round.

`brain-kit doctor` reads all of this for you: the last round (with a warning for a round
that exited 0 in seconds without a model turn, which is a dead round reported as a
success), each source's mark and how far behind it is, each connector source's last state
with the round's date, whether the timer is installed and when it fires next, whether
failures reach you or only the log, and the cost cap the next round runs under (`cost-cap`:
the number, the default when `curate.budget_usd` is left out, or no cap when it is
`null`). `brain-kit doctor --probe` asks the CLI for each connector's state now, without a
round.

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
   days; `last-run.json` says why. A calendar or meeting-notes mark that stays behind while
   the transcripts move is a connector that is not there: `brain-kit doctor --only
   connectors --probe` says which state, and [connectors.md](connectors.md) what to do.
4. `brain-kit curate --check`, then one `brain-kit curate` by hand, reading its output to
   the last line.
