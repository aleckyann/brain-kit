# Round repairs and incidents: design

Status: approved in conversation by the owner on 09/10/2026; revised the same
day after an adversarial review (two changes cut, three reworked, see the end).

## Goal

A scheduled `curate` round should repair the causes a machine can repair
without a person, name every cause it knows and say so when it does not, and
leave a durable record that the morning briefing shows the next day. Today the
only record a person sees is a desktop notification: between 03/10/2026 and
06/10/2026 seven rounds postponed on a dirty tree, each one notified, and three
working days went uncurated. The constraint is visibility, not detection.

## What the history shows (original vault, dated)

| Cause | Last seen | What the kit does today |
|---|---|---|
| Name resolution not back when the round fires on resume | 07/10/2026 (twice), 09/10/2026 | the configured network check answers in 13 to 28 ms (`network_did_not_wait`, shown nowhere a person reads), `git fetch` cannot resolve the remote host, exit 1 `sync_failed`, reason "see the message above" |
| CLI left as a launcher stub of about 500 bytes | 16/09/2026 (round died); stub seen again after updates up to 07/10/2026 | detected (`cli_stub`, exit 1), never repaired |
| Orphaned `.git/index.lock` (0 bytes, a day old) | 06/10/2026 | sync dies, exit 1, removed by hand |
| Usage limit ("You've hit your weekly limit" plus a reset time) | 30/09/2026 | read as a generic `model_failed`, exit 1 |
| Expired login | 02/10/2026 | exit 69 `auth_expired` with the `/login` instruction; correct |
| Dirty tree | 03/10 to 06/10/2026 | exit 75 naming the files; correct, but not seen |
| Connector tools absent from the session | 02/10/2026 | relaunch without the source, its mark kept; correct |
| CLI not on the scheduler's PATH | 28/08/2026 | absolute `claude_bin`; closed |

The scheduling docs claim that `Persistent=false` keeps a systemd user timer
from firing on resume. The journal disagrees: on 07/10/2026 at 06:24:15 and
09/10/2026 at 07:58:26 the unit started in the same second as the resume. A
realtime timer whose time passed during suspend fires on resume; `Persistent=`
only covers time the timer was inactive.

## Non-goals

- No per-day pull requests for past days. The watermark keeps a failed day open
  and the next round catches up, up to seven days per round. The days the
  original vault never covered are recovered by hand, outside the kit.
- No automatic cleaning of a dirty tree. The kit cannot tell a person's work
  from debris; it keeps postponing and naming the files.
- No check before the briefing. It runs in the desktop application with its own
  login and binary; its one repeated failure (usage limit) is only visible after
  the fact, and a missing connector is handled inside its own block.
- No re-login, and no login probe before the launch (cut, see the end).
- No new dependency, no side effect added to `checkCli` or to `doctor`.

## Changes

Each change lands with its test written first under
`test/incidents/<incident date>-<slug>.test.mjs`, pairing every refusal with its
nearest positive case, an entry in `docs/incidents.md`, and messages in both
language packs (pt-BR is the reference; src/ and lang/en stay ASCII English).
Reason codes are new unless marked.

### R1. Sync failures keep their words and name a lost network (step 5)

`curate` passes `syncUnderLock` an `io` whose stderr also remembers the last
line written. Every sync outcome that today says "see the message above"
(`sync_failed`, `sync_postponed`, `sync_diverged`, and a throw caught at
`curate.mjs:1163`) puts that line in its reason instead.

When that line matches one of `Could not resolve hostname`, `Could not resolve
host`, `Temporary failure in name resolution`, `Name or service not known`,
`nodename nor servname provided` or `Network is unreachable`, the round exits
69 with reason code `sync_offline` instead of 1 `sync_failed`: a known cause,
retried by the next window, no mark moves.

### R2. Move an orphaned index lock aside (new step `index_lock`, before sync)

Before step 5, move `<gitDir>/index.lock` (gitDir from
`locateRepository(root, env).gitDir`, `src/guards/location.mjs`, per worktree,
never the common dir) to `index.lock.stale-<YYYYMMDDTHHMMSS>` in the same
directory, only when ALL hold:

- its size is 0 (a commit waiting in an editor has already written the new
  index into the lock, so it is never empty);
- its mtime is more than 10 minutes old;
- `operationInProgress(root)` (`src/git.mjs:905`) is null;
- `dirtyPaths(root)` (`src/git.mjs:866`) is empty.

The vault lock does not protect against a person's git command; these four
conditions do. The rename is never a delete and sits in a try: a failure
(EBUSY or EPERM on Windows) is logged and the round goes on to sync, which fails
as today, now with git's words (R1).

- Moved: `run.repairs` gets `{ kind: "index_lock_moved", to, ageMinutes }`, a
  log line, and the round continues.
- New module `src/guards/index-lock.mjs`; `onStep('index_lock')` between
  `network` and `sync`, added to the order assertion in `test/curate.test.mjs`
  (line 670).

### R3. Repair a launcher stub left by an npm install (step 10)

`checkCli` stays free of side effects (doctor uses it) and adds the resolved
real path to its result (`realpath`: the configured binary is usually a
symlink). In `curate`, when `problem === 'stub'`, repair only when ALL hold:

- not Windows (npm's shim there is a batch file, already `cli_batch`);
- the real path is `<pkg>/bin/<file>`, `<pkg>/package.json` names
  `@anthropic-ai/claude-code`, and `<pkg>/install.cjs` is a regular file
  (`lstat`, not a symlink);
- the stub's mtime is more than 10 minutes old (an install in progress, the
  CLI's own auto-update included, is never raced).

Then run `process.execPath <pkg>/install.cjs` with the person's `env` (never the
round's environment, which carries the round token), no shell, a 120 s timeout,
and run `checkCli` again. The installer needs no network and writes only
`<pkg>/bin/<file>`.

- Fixed: `run.repairs` gets `{ kind: "cli_reinstalled", version }`, log line,
  round continues.
- Not fixed or not eligible: exit 1 `cli_stub` (existing); the reason says
  whether a repair was tried, and quotes the installer's FIRST stderr line (its
  last line is a fallback command with an absolute home path).

### R4. Recognize the usage limit (step 16)

Inside the `!modelOk` branch, after `auth_expired` and before the API-error
match: a result text or stderr tail matching `/hit your [a-z ]*limit/i` or
`/usage limit/i` exits 75 with reason code `usage_limited`, the reason carrying
the text from `resets` to the end of that line when present. No mark moves.
The measured text (with its middle dot) lives only in `test/fixtures/stream/`;
the regex in src stays ASCII.

### R5. Unknown causes say so

The reason codes the kit cannot explain are `model_failed`, `sync_failed` and
`internal_error`. Their reason ends with one sentence (new key
`curate.unknown_cause`): the cause is not one the kit knows, nothing was
repaired, and the text before it is what the program said. `known` in R6 is
exactly "the reason code is not one of these three".

### R6. `incidents.jsonl` (state directory, append-only)

New entry `INCIDENTS: 'incidents.jsonl'` in `STATE_FILES` (`src/state.mjs:41-47`).
One JSON object per line, written with `appendFileSync` (one write per line,
mode 0600 on creation), never rewritten outside the lock:

```json
{"at":"<ISO>","exit":69,"reasonCode":"sync_offline","known":true,"reason":"...","repairs":[],"closes":false}
```

A line is appended, before the lock is released, for:

- a round that exits non-zero, except `lock_held` (a sibling is running; it
  repeats every window and says nothing new);
- a round that made a repair, whatever its exit;
- a round that ran the model and exited `proposed` or `nothing_proposed`, with
  `"closes": true`. No other exit 0 closes anything: `up_to_date`, `disabled`,
  `nothing_to_curate` and `nothing_available` never reach the model, so they
  prove nothing about the causes before them;
- the `machine_invalid` path (`curate.mjs:1026-1033`), which writes its own
  last-run outside `finishRound` and holds no lock; appending is safe there.

Open incidents are computed on read: non-zero lines newer than the newest
`closes` line. Pruning (lines older than `log_retention_days`, default 30) is a
rewrite with `writePrivate`, done only in `finishRound` and only while the
round holds the lock. `--dry` and `--check` write nothing.

### R7. The briefing shows it

`briefingFacts` gains `incidents` (open incidents grouped by reason code: count,
first and last time, known or not, the newest reason cut to one line; plus the
repairs of the last 24 hours) and `marks` (each source's watermark and days
behind yesterday, from `readWatermark` and `daysBetween` in
`src/guards/watermark.mjs`, a `WatermarkError` rendered as unreadable).
`lastRunFacts` also carries `run.network.warning`.

The lines go in `renderLastRun` (`src/commands/preflight.mjs:77`), which the
briefing's `sources` block and the preflight text share:

- each open incident group: reason code, how many times since when, known or
  unknown, the newest reason;
- each repair of the last 24 hours;
- `did_not_wait`: the network check answered in N ms on its first try and may
  not wait for a connection (the signal that was missed before 07/10/2026);
- each source more than one day behind: N days not curated, read by the next
  round.

Nothing open, repaired, warned or behind: no extra line. The exact key lists in
`test/preflight.test.mjs` (lines 27 and 186) grow by `incidents` and `marks`.

### R8. Docs

- `docs/scheduling.md` around 286, `src/commands/schedule.mjs:21-23` and the
  test title in `test/incidents/2026-09-14-nightly-never-ran.test.mjs:14`:
  correct the `Persistent=false` claim (a timer fires on resume) and say the
  network check is what absorbs it.
- `docs/incidents.md`: new entries 30/09/2026 (usage limit read as a generic
  failure), 06/10/2026 (orphaned index lock), 07/10/2026 (name resolution on
  resume, sync failed with no reason) and 09/10/2026 (timer fires on resume);
  extend 14/09/2026 (stub) with the repair. The count assertions in
  `test/privacy-policy-docs.test.mjs` (82 entries, "Ten entries were added
  since", "Eighty two entries follow") move to 86, with one clause per new
  entry.
- `CHANGELOG.md`: an `## Unreleased` section.

## How it is proven

Tests first, each simulating its failure without the network or the real home
directory: a fake git stderr for each name-resolution text, a 0-byte aged
`index.lock` in a real test repository (and its refusals: non-empty, young,
operation in progress, dirty tree), a 500-byte stub inside a fake package whose
`install.cjs` writes a working fake CLI (and its refusals: young stub, symlinked
installer, wrong package name, installer that fails), a stream fixture with the
limit text, incident lines from concurrent writers, and the briefing rendering
from a seeded state directory. `npm test` passes in full before the work is
called done, and an adversarial review reads the diff.

## Rollout on the owner's machine (outside the repository)

1. Merge, then install the merged kit globally the way 0.1.1 was installed, and
   check the installed version.
2. `machine.json`: remove `network_check`, so the default check (a TCP
   connection to the API host, which needs name resolution, retried for 120 s)
   replaces one that answers in milliseconds; `notify_command` becomes
   `["notify-send", "-u", "critical", "brain-kit"]` (stays on screen until
   dismissed). Prove the file with `brain-kit curate --check` before the next
   window.
3. Watch the next three rounds and the next briefing.
4. Recover by hand, one vault pull request per day, the days no round ever
   covered: 12/08/2026, 19/08/2026 and 07/09/2026 (a public holiday; checked
   before any pull request is opened).

## Cut after the adversarial review (09/10/2026)

- **Waiting for the remote's name before sync.** The remote host as written can
  be an SSH alias or sit behind a proxy and never resolve locally while git
  reaches it, so the wait would refuse rounds that work today. Rollout step 2
  covers the measured incidents, and R1 names the rest.
- **`claude auth status` before the launch.** An expired login spends no tokens,
  and the round already stops with exit 69 and the `/login` instruction. The
  probe's field name was measured, but not its side effects, its answer for
  API-key or cloud-provider logins, or what an older CLI without the
  subcommand does with it (possibly an unsandboxed session). The gap on
  2026-09 was that nobody saw the 69; R6 and R7 close that gap.
