# Round repairs and incidents: design

Status: approved in conversation by the owner on 09/10/2026, written up for review.

## Goal

A scheduled `curate` round should stop dying of causes the kit already knows,
repair the ones a machine can repair without a person, stop early and say what
to do on the ones only a person can fix, and leave a durable record that the
morning briefing shows the next day. Today the record is a desktop notification
nobody sees: between 03/10/2026 and 06/10/2026 seven rounds postponed on a dirty
tree, each one notified, and three working days went uncurated.

## What the history shows (original vault, dated)

| Cause | Last seen | What the kit does today |
|---|---|---|
| Name resolution not back when the round fires on resume | 07/10/2026 (twice), 09/10/2026 | the configured network check answers in 13 to 28 ms, `git fetch` cannot resolve the remote host, exit 1 `sync_failed`, and the reason says only "see the message above" |
| CLI left as a launcher stub of about 500 bytes | 16/09/2026 (round died); stub seen again after updates up to 07/10/2026 | detected (`cli_stub`, exit 1), never repaired |
| Orphaned `.git/index.lock` | 06/10/2026 | sync dies, exit 1, removed by hand |
| Expired login | 02/10/2026 | detected only after the model was launched (exit 69 `auth_expired`) |
| Usage limit ("You've hit your weekly limit · resets 11am") | 30/09/2026 | read as a generic `model_failed`, exit 1 |
| Dirty tree | 03/10 to 06/10/2026 | exit 75 naming the files; correct, but the notification was not seen |
| Connector tools absent from the session | 02/10/2026 | relaunch without the source, its mark kept; correct |
| CLI not on the scheduler's PATH | 28/08/2026 | absolute `claude_bin`; closed |

The scheduling docs also claim that `Persistent=false` keeps a systemd user
timer from firing on resume. The journal disagrees: on 07/10/2026 at 06:24:15
and 09/10/2026 at 07:58:26 the unit started in the same second as the resume.
A realtime timer whose time passed during suspend fires on resume; `Persistent=`
only covers time the timer was inactive.

## Non-goals

- No per-day pull requests for past days. The watermark already keeps a failed
  day open and the next round catches up, up to seven days per round. Three
  historical days of the original vault are recovered by hand, outside the kit.
- No automatic cleaning of a dirty tree. The kit cannot tell the owner's work
  from debris; it keeps postponing and naming the files.
- No check before the briefing. The briefing runs in the desktop application
  with its own login and binary; its one repeated failure (usage limit) is only
  visible after the fact, and a missing connector is already handled inside its
  own block.
- No automatic re-login. A login needs a person in a browser.
- No new dependency, no change to `checkCli`'s callers other than `curate`, no
  side effect added to `doctor`.

## Changes

Each change lands with a test written first under
`test/incidents/<incident date>-<slug>.test.mjs`, an entry in
`docs/incidents.md`, and messages in both language packs (pt-BR is the
reference). Reason codes below are new unless marked.

### R1. Wait for the remote's name, not only for "the network" (step 4)

After the configured network check passes, resolve the host name of the remote
`sync` will fetch from (same remote resolution as `src/commands/sync.mjs`
216-227; host parsed with `hostOfUrl`, `src/gh.mjs:36`). Retry every
`intervalMs` until the same `timeoutMs` the network wait uses
(`src/guards/network.mjs:35`, 120 s). A remote that is a local path or
`file://` URL has no host and is skipped, which keeps every spawned test off
the network.

- Not resolved in time: exit 69, reason code `no_network` (existing), reason
  naming the host and the seconds waited.
- Resolved after one or more failed attempts: a `repairs` entry
  `{ kind: "waited_for_dns", host, waitedMs }`.
- Seam: `waitForNetwork`'s `deps` gains `lookup(host)` (production:
  `dns.promises.lookup`).

Only the remote host is resolved. The model's API host is not: no round on the
kit has failed on it, and a custom network check in tests would turn that
lookup into a real network call.

### R2. Classify sync failures and keep git's words (step 5)

`syncUnderLock` fills `outcome.detail` with git's first stderr line (the one it
already prints, `sync.mjs:241-243` and 372) and `outcome.offline = true` when
that line matches `Could not resolve hostname`, `Temporary failure in name
resolution`, `Name or service not known` or `Network is unreachable`.

- `outcome.offline`: exit 69, reason code `sync_offline`, reason with the
  detail. The next window retries.
- Any other sync failure: exit 1 `sync_failed` (existing), and the reason now
  carries the detail instead of "see the message above".

### R3. Move an orphaned index lock aside (new step before sync)

Under the round's own vault lock, before step 5: when `<gitDir>/index.lock`
exists, its mtime is more than 10 minutes old, and `git status --porcelain`
reports nothing (a clean tree, so no commit with staged changes can be waiting
in an editor), rename it to `index.lock.stale-<YYYYMMDDTHHMMSS>` in the same
directory. Never delete it.

- Moved: `repairs` entry `{ kind: "index_lock_moved", to, ageMinutes }`, log
  line, and the round continues.
- Younger than 10 minutes, or the tree is not clean: leave it; sync fails as
  today (now with git's words, R2).
- New module `src/guards/index-lock.mjs`; new `onStep('index_lock')` between
  `network` and `sync`, added to the order assertion in `test/curate.test.mjs`.

### R4. Repair a launcher stub left by an npm install (step 10)

`checkCli` stays free of side effects (doctor uses it). It adds the resolved
real path to its result (`realpath`, because the configured binary is usually a
symlink). In `curate`, when `problem === 'stub'` and the real path is
`<pkg>/bin/<file>` where `<pkg>/package.json` names `@anthropic-ai/claude-code`
and `<pkg>/install.cjs` exists:

1. run `process.execPath <pkg>/install.cjs` with a 120 s timeout and no shell;
2. run `checkCli` again.

- Fixed: `repairs` entry `{ kind: "cli_reinstalled", version }`, log line,
  round continues.
- Not fixed, or the layout does not match: exit 1 `cli_stub` (existing), the
  reason saying whether a repair was tried and what the installer said (last
  stderr line).

### R5. Check the login before spending a launch (before step 13)

Right before the model launch, never under `--dry` or `--check`, run
`<claude_bin> auth status` with the round's environment and a 15 s timeout, and
parse stdout as JSON.

- `loggedIn === false`: exit 69 `auth_expired` (existing code), reason telling
  the owner to log in again (`/login`), no launch, no mark moves.
- Anything else (true, non-zero exit, timeout, not JSON, older CLI without the
  command): continue, and log `auth_probe` with what was seen. A probe that
  cannot answer never blocks a round.
- `test/helpers/fake-claude.mjs` answers `auth status` from the scenario
  (default `{"loggedIn": true}`) without counting a launch.

Open hypothesis: whether `auth status` reports `false` once the refresh token is
dead. If it reports `true`, the round fails at step 16 exactly as today.

### R6. Recognize the usage limit (step 16)

Inside the `!modelOk` branch, after `auth_expired` and before the API-error
match: a result text or stderr tail matching `/hit your .*limit/i` or
`/usage limit/i` is exit 75 `usage_limited`, the reason carrying the
`resets ...` fragment when present. No mark moves. Fixture from the measured
text of 30/09/2026.

### R7. Unknown causes say so

`model_failed`, `sync_failed`, `internal_error` and a failed R4 repair are the
causes the kit cannot name. Their reason ends with one sentence (new key
`curate.unknown_cause`): the cause is not one the kit knows, nothing was
repaired, and the text before it is what the program said. Every other
non-zero reason code is a known cause.

### R8. `incidents.jsonl` (state directory)

New entry `INCIDENTS: 'incidents.jsonl'` in `STATE_FILES` (`src/state.mjs:41-47`).
In `finishRound`, when the round wrote `last-run.json` and either its exit is
not 0 or it made a repair, append one line:

```json
{"at":"<ISO>","exit":69,"reasonCode":"sync_offline","known":true,"reason":"...","repairs":[{"kind":"waited_for_dns","host":"...","waitedMs":41000}],"closedAt":null}
```

- An exit-0 round sets `closedAt` to its own `at` on every open line, its own
  line included (a repair in a round that then succeeded is closed at once).
- Lines older than `log_retention_days` (default 30) are dropped on each write.
  The file is rewritten whole with `writePrivate` (mode 0600, atomic).
- Never written by `--dry`, `--check`, or a round that wrote no `last-run.json`.

### R9. The briefing shows it (`sources` fact block)

`briefingFacts` gains `incidents` (read beside `lastRunFacts`,
`src/briefing/facts.mjs:295`) and `marks` (each source's watermark and the days
it is behind yesterday, from `watermark.json`). `sourcesBlock`
(`src/briefing/blocks.mjs:338-355`) renders, after the last-run lines:

- each open incident: day and time, reason code, known or unknown, the reason
  cut to one line;
- each repair from the last 24 hours: what was repaired;
- each source more than one day behind: "N days not curated; the next round
  reads them".

Nothing open, nothing repaired, nothing behind: no extra line. The preflight
text output gets the same lines (it shares `renderLastRun`).

### R10. Docs

- `docs/scheduling.md` around 286 and `src/commands/schedule.mjs:21-23`: correct
  the `Persistent=false` claim (fires on resume) and point to R1.
- `docs/incidents.md`: entries for 07/10/2026 (name resolution on resume),
  06/10/2026 (orphaned index lock), 30/09/2026 (usage limit read as a generic
  failure) and 09/10/2026 (timer fires on resume); extend 14/09/2026 (stub) and
  30/09/2026 (expired login) with the repair and the pre-check. Update the
  count sentences `test/privacy-policy-docs.test.mjs` asserts.
- `CHANGELOG.md`: an `## Unreleased` section.
- Doctor: an exit 75 `usage_limited` reads as a warning (already true for 75).

## How it is proven

Tests first, each simulating its failure without the network: a fake `lookup`
that fails N times, a fake git stderr, an aged `index.lock` in a test repo, a
500-byte stub inside a fake package whose `install.cjs` writes the real fake
CLI, a fake `auth status`, a stream fixture with the limit text. Each test pairs
the refusal with its nearest positive case. The full suite (`npm test`) passes
before the work is called done, and an adversarial review reads the diff.

## Rollout on the owner's machine (outside the repository)

1. Merge, then install the merged kit globally the way 0.1.1 was installed.
2. `machine.json`: `notify_command` becomes
   `["notify-send", "-u", "critical", "brain-kit"]` (stays on screen until
   dismissed); `network_check` is removed so the default check (TCP to the API,
   retried for 120 s) replaces one that answers in milliseconds.
3. Watch the next three rounds and the next briefing.
4. Recover by hand, one vault pull request per day, the days no round ever
   covered: 12/08/2026, 19/08/2026 and 07/09/2026 (a public holiday; checked
   before any PR is opened).
