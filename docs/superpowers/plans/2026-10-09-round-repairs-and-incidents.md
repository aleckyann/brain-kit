# Round repairs and incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `brain-kit curate` repairs an orphaned index lock and an npm launcher stub on its own, names a lost network, a usage limit and an unknown cause, records every incident in `incidents.jsonl`, and the morning briefing shows what is still open.

**Architecture:** Two new guard modules (`src/guards/index-lock.mjs`, `src/guards/cli-repair.mjs`) called from fixed steps of `src/commands/curate.mjs`; one new state module (`src/incidents.mjs`) written from `finishRound` and the `machine_invalid` path; the briefing reads it through `src/briefing/facts.mjs` and renders it in `renderLastRun` (`src/commands/preflight.mjs`), which the `sources` block shares.

**Tech Stack:** Node >= 22, ES modules, `node:test`, zero runtime dependencies, real git in throwaway repositories, `test/helpers/fake-claude.mjs` for the CLI.

**Spec:** `docs/superpowers/specs/2026-10-09-round-repairs-and-incidents-design.md` (read it first; this plan argues from it).

## Global Constraints

- Node >= 22; no new dependency; every child process is an argument vector, never a shell (CONTRIBUTING.md).
- `src/`, `bin/` and `lang/en` are ASCII English (`test/no-portuguese.test.mjs`); measured non-ASCII text lives only in `test/fixtures/`.
- Every message key exists in `lang/pt-BR/messages.json` (reference) and `lang/en/messages.json` with the same `{placeholders}` (`test/lang.test.mjs`); call-site params match (`test/message-keys.test.mjs`). pt-BR copy: no em dash, no emoji.
- Every new guard gets `test/incidents/YYYY-MM-DD-<slug>.test.mjs`, dated by the incident, and each refusal is paired with its nearest positive case.
- Tests never reach the network, a real `claude`, or the real home directory: temp dirs from `test/helpers/tmp.mjs`, the curate world from `test/helpers/curate-world.mjs`.
- Fixtures and docs name no real person, company or path: people are "Ana", hosts are `example.invalid` / `example.com`. The pre-push leak gate scans blobs, file names, commit messages and branch names.
- Dates a person reads (docs, messages) are DD/MM/YYYY; ISO stays in JSON and file names.
- Conventional commits, one per task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After each task: `npm test` passes in full (the suite is the contract; a red unrelated test is a finding, not noise).

## Review Focus

1. Two processes appending to `incidents.jsonl` at once (a round and a `machine_invalid` start): both lines survive intact. Test in Task 5.
2. A corrupt or half-written line in `incidents.jsonl`: the reader skips it and counts it, the briefing still renders, nothing throws. Tests in Tasks 5 and 6.
3. Windows: the index lock rename failing with EPERM/EBUSY leaves the round going to sync, and the stub repair never runs on `win32`. Tests in Tasks 2 and 3 through injected `platform` / `rename`.
4. The vault time zone: "repairs of the last 24 hours" and the incident's day and time render in the vault's zone, not UTC. Test in Task 6.
5. An unreadable `incidents.jsonl` or `watermark.json` (permissions, not JSON): one "unreadable" line in the briefing, never a crash. Test in Task 6.

---

### Task 1: Sync failures keep git's words; a lost network is `sync_offline`; unknown causes say so (spec R1, R5)

**Files:**
- Modify: `src/commands/curate.mjs` (step 5, ~1157-1180; the `internal_error` catch ~1103; the `model_failed` branch ~1826-1828)
- Modify: `lang/pt-BR/messages.json`, `lang/en/messages.json`
- Test: `test/incidents/2026-10-07-sync-offline-after-resume.test.mjs` (create)

**Interfaces:**
- Produces: reason code `sync_offline` (exit 69); `sync_failed`, `sync_postponed`, `sync_diverged` reasons carry `{detail}`; exported `UNKNOWN_REASON_CODES = Object.freeze(['model_failed', 'sync_failed', 'internal_error'])` from `src/commands/curate.mjs` (Task 5 imports it); exported `OFFLINE_PATTERNS` (array of RegExp) from the same file.

- [ ] **Step 1: Write the failing test.** Simulate the remote over SSH with no network access at all: `git -C <vault> remote set-url origin ssh://example.invalid/vault.git`, and pass `w.curate([], { GIT_SSH_COMMAND: <script> })` where the script (written to a temp dir, mode 0755) prints to stderr and exits 255. Tests, for `en` and `pt-BR`:
  - `ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution` -> `r.status === 69`, `lastRun().reasonCode === 'sync_offline'`, reason includes `Could not resolve hostname example.invalid`, watermark unchanged, one notification equal to the reason, `w.launches().length === 0`.
  - one test per remaining pattern (`Could not resolve host`, `Name or service not known`, `nodename nor servname provided`, `Network is unreachable`) -> `sync_offline`.
  - nearest positive case: `fatal: protocol error: bad line length` -> exit 1, `sync_failed`, reason includes that line AND the unknown-cause sentence (`/not one brain-kit knows/` en, `/não é uma que o brain-kit conhece/` pt-BR), and does not include "see the message above" / "veja a mensagem acima".
- [ ] **Step 2: Run** `node --test test/incidents/2026-10-07-sync-offline-after-resume.test.mjs` and see it fail on the reason code.
- [ ] **Step 3: Implement.** In step 5, wrap `io` for `syncUnderLock` so its `stderr.write` also keeps the last non-empty line written (`lastSyncLine`); the throw caught at ~1163 sets it from `error.message`. `OFFLINE_PATTERNS = [/Could not resolve hostname/, /Could not resolve host/, /Temporary failure in name resolution/, /Name or service not known/, /nodename nor servname provided/, /Network is unreachable/]`. A failed sync whose `lastSyncLine` matches one -> `fail(EXIT.UNAVAILABLE, 'sync_offline', t('curate.sync_offline', { detail }))`; otherwise `sync_failed` with `{ detail }`. `sync_postponed` and `sync_diverged` get `{ detail }` too. Add a helper `withUnknownCause(reason)` that appends `t('curate.unknown_cause', {})` and use it for `sync_failed`, `model_failed` and `internal_error`.
  Copy (pt-BR / en):
  - `curate.sync_offline`: "brain-kit curate: sem rede para o remoto ({detail}). Nada foi curado e nenhuma marca d'água andou; a próxima janela tenta de novo." / "brain-kit curate: no network to the remote ({detail}). Nothing was curated and no watermark moved; the next window tries again."
  - `curate.sync_failed`: "brain-kit curate: o sync falhou ({detail}); nada foi curado." / "brain-kit curate: sync failed ({detail}); nothing was curated." (`{detail}` is the last line sync itself wrote, which already quotes git; `-` when it wrote none)
  - `curate.unknown_cause`: " A causa não é uma que o brain-kit conhece: nada foi corrigido, e o texto acima é o que o programa disse." / " The cause is not one brain-kit knows: nothing was repaired, and the text above is what the program said."
- [ ] **Step 4: Run** the new test, then `npm test`; fix every existing assertion on the old "see the message above" copy by asserting the detail instead.
- [ ] **Step 5: Commit** `fix(curate): name a lost network and keep git's words when sync fails`.

### Task 2: Move an orphaned index lock aside (spec R2)

**Files:**
- Create: `src/guards/index-lock.mjs`
- Modify: `src/commands/curate.mjs` (run object ~1049-1053 gains `repairs: []`; new step between `network` and `sync`)
- Modify: `test/curate.test.mjs:670` (step list gains `'index_lock'` after `'network'`)
- Modify: `lang/*/messages.json`
- Test: `test/incidents/2026-10-06-orphan-index-lock.test.mjs` (create)

**Interfaces:**
- Produces: `moveOrphanIndexLock(root, { env, now = new Date(), platform = process.platform, rename = renameSync, minAgeMs = 600000 }) -> { moved: boolean, to: string | null, ageMinutes: number | null, skipped: 'absent' | 'not_empty' | 'young' | 'operation' | 'dirty' | 'rename_failed' | null, error: string | null }`. `run.repairs` is an array of `{ kind: string, ...details }` that Tasks 3 and 5 rely on.

- [ ] **Step 1: Write the failing tests** (real git via `test/helpers/git-repo.mjs`, a clean repo with one commit):
  - 0-byte `index.lock`, mtime 20 min ago -> `moved: true`, `to` matches `/index\.lock\.stale-\d{8}T\d{6}$/`, the file exists at `to` and not at the old path.
  - refusals, each leaving the lock in place: 1 byte content -> `not_empty`; mtime 5 min ago -> `young`; a `MERGE_HEAD` (whatever `operationInProgress` in `src/git.mjs:905` detects) -> `operation`; an untracked file -> `dirty`; injected `rename` throwing `EPERM` -> `moved: false`, `skipped: 'rename_failed'`, `error: 'EPERM'`.
  - absent lock -> `skipped: 'absent'`.
  - round level (curate world): a 0-byte, 20-minute-old `index.lock` in the vault -> exit 0 (`proposed` or `nothing_proposed`), `lastRun().repairs` has one entry with `kind: 'index_lock_moved'`, `to` ending in the stale name and `ageMinutes >= 19`, the log has `index_lock_moved`.
- [ ] **Step 2: Run** the new test file; it fails on the missing module.
- [ ] **Step 3: Implement** `moveOrphanIndexLock`. `gitDir` from `locateRepository(root, env).gitDir` (`src/guards/location.mjs:98-118`), never the common dir; check order: absent, size, age, `operationInProgress`, `dirtyPaths` (`src/git.mjs:866`), then rename inside try. In curate, `onStep('index_lock')` after the network wait, push the repair to `run.repairs` when moved, `log('index_lock_moved' | 'index_lock_kept', result)`; never fail the round from this step.
- [ ] **Step 4: Run** the test file and `npm test` (the order assertion now includes `index_lock`; any exact last-run key list gains `repairs`).
- [ ] **Step 5: Commit** `feat(curate): move an orphaned index lock aside before sync`.

### Task 3: Repair an npm launcher stub (spec R3)

**Files:**
- Create: `src/guards/cli-repair.mjs`
- Modify: `src/guards/cli.mjs` (result gains `realPath`), `src/commands/curate.mjs` (step 10, ~1276-1280)
- Modify: `test/helpers/curate-world.mjs:224` (the guard accepts a `claude_bin` inside the world's base dir as well as `FAKE`)
- Modify: `lang/*/messages.json`
- Test: `test/incidents/2026-09-14-cli-stub-repair.test.mjs` (create)

**Interfaces:**
- Consumes: `checkCli` (`src/guards/cli.mjs:37`), `run.repairs` (Task 2).
- Produces: `checkCli(...)` result `{ ok, problem, version, messageKey, params, realPath: string | null }`; `repairStub(cli, { env, now = new Date(), platform = process.platform, minAgeMs = 600000, timeoutMs = 120000, run = spawnSync }) -> { tried: boolean, fixed: boolean, skipped: 'not_stub' | 'windows' | 'layout' | 'young' | null, said: string | null }`.

- [ ] **Step 1: Write the failing tests.** Build a fake package in a temp dir: `pkg/package.json` `{"name":"@anthropic-ai/claude-code"}`, `pkg/bin/claude.exe` a 500-byte stub (mode 0755, mtime 20 min ago), `pkg/install.cjs` a script that overwrites `bin/claude.exe` with `#!/bin/sh\nexec "<process.execPath>" "<FAKE>" "$@"\n` padded past 2 KB; `claude_bin` is a symlink `bin/claude -> pkg/bin/claude.exe`.
  - fixed: `repairStub` -> `{ tried: true, fixed: true }`, then `checkCli(link).ok === true`.
  - refusals, each with `tried: false` and the stub untouched: `platform: 'win32'` -> `windows`; package name `other` -> `layout`; `install.cjs` a symlink -> `layout`; stub mtime 5 min ago -> `young`; `cli.problem === 'version'` -> `not_stub`.
  - failing installer: `install.cjs` writes `boom: no native package\nFallback: node /home/ana/x.cjs` to stderr and exits 1 -> `{ tried: true, fixed: false, said: 'boom: no native package' }` (the FIRST line).
  - the installer runs with the env given, never with `BRAIN_KIT_ROUND_TOKEN` (the fake install.cjs writes `process.env.BRAIN_KIT_ROUND_TOKEN ?? 'absent'` to a marker; assert `absent` at round level).
  - round level: `w.setMachine({ claude_bin: <link> })` with the stub -> the round reaches the model, `lastRun().repairs` contains `{ kind: 'cli_reinstalled', version: '2.1.281' }`. A failing installer -> exit 1 `cli_stub`, reason includes `boom: no native package` and not `/home/ana`.
- [ ] **Step 2: Run** the file; it fails on the missing module.
- [ ] **Step 3: Implement** `repairStub` (real path from `cli.realPath`; layout check with `lstatSync(install).isFile()`; age from the stub's `statSync(...).mtimeMs`; run `[process.execPath, install]` with `{ env, timeout: timeoutMs, encoding: 'utf8' }`; `said` = first non-empty stderr line, cut at 200 chars). In curate step 10: on `problem === 'stub'`, call it with the person's `env` (not `childEnv`), re-run `checkCli` when `tried`, push `{ kind: 'cli_reinstalled', version }` on success; otherwise fail as today with the reason extended by `t('curate.cli_repair_failed', { said })` when tried.
  Copy: `curate.cli_repair_failed`: " O brain-kit tentou reinstalar e o instalador disse: {said}" / " brain-kit tried to reinstall it and the installer said: {said}".
- [ ] **Step 4: Run** the file and `npm test` (the existing `2026-09-14-cli-stub.test.mjs` must stay green: `checkCli` has no side effect).
- [ ] **Step 5: Commit** `feat(curate): reinstall a launcher stub an npm install left behind`.

### Task 4: Recognize the usage limit (spec R4)

**Files:**
- Create: `test/fixtures/stream/usage-limit.jsonl` (copy of `auth-expired.jsonl`'s shape; the result text is `You've hit your weekly limit · resets 11am`)
- Modify: `src/commands/curate.mjs` (the `!modelOk` branch ~1818-1828), `lang/*/messages.json`
- Test: `test/incidents/2026-09-30-usage-limit.test.mjs` (create)

**Interfaces:**
- Produces: reason code `usage_limited` (exit 75); exported `USAGE_LIMIT_PATTERNS = [/hit your [a-z ]*limit/i, /usage limit/i]`.

- [ ] **Step 1: Write the failing test** (en and pt-BR, modelled on `2026-09-30-oauth-expired-round.test.mjs`): scenario with the new fixture and `exitCode: 1` -> `r.status === 75`, `reasonCode === 'usage_limited'`, reason includes `resets 11am`, `notEqual(reasonCode, 'model_failed')`, mark untouched, one notification, `launches().length === 1`. Nearest positive cases: the auth-expired fixture still gives `auth_expired` (a text with both never happens; auth wins by order), and a result text `You have hit a snag` stays `model_failed`.
- [ ] **Step 2: Run** it; it fails with `model_failed`.
- [ ] **Step 3: Implement** the branch after `isLoginFailure`: test `said` and `out.stderrTail` against `USAGE_LIMIT_PATTERNS`; `resets` = the match of `/resets[^\n]*/i` on the same text or `-`.
  Copy: `curate.usage_limited`: "brain-kit curate: o limite de uso do modelo acabou ({resets}). Nada foi curado e nenhuma marca d'água andou; a primeira janela depois da liberação retoma." / "brain-kit curate: the model's usage limit is spent ({resets}). Nothing was curated and no watermark moved; the first window after the reset resumes."
- [ ] **Step 4: Run** it and `npm test`.
- [ ] **Step 5: Commit** `feat(curate): recognize a spent usage limit as a postponed round`.

### Task 5: `incidents.jsonl` (spec R6)

**Files:**
- Create: `src/incidents.mjs`
- Modify: `src/state.mjs:41-47` (`INCIDENTS: 'incidents.jsonl'`), `src/commands/curate.mjs` (`finishRound` ~1955-1976, `machine_invalid` path ~1026-1033)
- Test: `test/incidents-file.test.mjs` (unit and round level)

**Interfaces:**
- Consumes: `run.repairs` (Task 2), `UNKNOWN_REASON_CODES` (Task 1), `writePrivate` (curate.mjs:271; move it to `src/state.mjs` and export if `src/incidents.mjs` cannot import it otherwise).
- Produces:
  - `incidentFor(run) -> object | null`: null for exit 0 without repairs unless `reasonCode` is `proposed` or `nothing_proposed`; null for `lock_held`; otherwise `{ at, exit, reasonCode, known, reason, repairs, closes }` with `known = !UNKNOWN_REASON_CODES.includes(reasonCode)` and `closes = reasonCode === 'proposed' || reasonCode === 'nothing_proposed'`.
  - `appendIncident(stateDir, entry) -> void` (`appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 })`).
  - `readIncidents(stateDir) -> { lines: object[], corrupt: number, problem: string | null }` (ENOENT is `{ lines: [], corrupt: 0, problem: null }`; any other read error is `problem: <code>`).
  - `openIncidents(lines) -> object[]` (non-zero lines newer than the newest `closes: true` line).
  - `pruneIncidents(stateDir, { now, retentionDays }) -> void` (rewrite with `writePrivate`, keeping lines whose `at` is within `retentionDays`; corrupt lines are dropped by the rewrite).

- [ ] **Step 1: Write the failing unit tests** in `test/incidents-file.test.mjs`: each `incidentFor` rule (exit 69 -> line; `lock_held` -> null; `up_to_date` -> null; `nothing_to_curate` with a repair -> line with `closes: false`; `proposed` -> line with `closes: true`; `model_failed` -> `known: false`); `openIncidents` over `[69 at t1, closes at t2, 75 at t3]` -> only t3; a corrupt line in the middle is skipped and counted; pruning drops a 31-day-old line and keeps a 29-day-old one; **two child processes** each appending 200 lines concurrently -> 400 parseable lines (Review Focus 1); a non-ENOENT read error (a directory at the file's path) -> `problem` set, no throw.
- [ ] **Step 2: Run** them; they fail on the missing module.
- [ ] **Step 3: Implement** `src/incidents.mjs`. In `finishRound`, when `writeLastRun` is true: `const entry = incidentFor(run); if (entry) appendIncident(stateDir, entry);` then, if `lock !== null`, `pruneIncidents(stateDir, { now: new Date(), retentionDays: machine?.log_retention_days ?? 30 })`; both before `lock.release()`, each in its own try that logs `incident_not_written` / `incidents_not_pruned` and never changes the exit. In the `machine_invalid` path, append the same shape (`known: true`, `repairs: []`, `closes: false`) when `writesState`.
- [ ] **Step 4: Add and run the round-level tests** in the same file (curate world): a dirty-tree round (exit 75) appends one line with `reasonCode: 'dirty_tree'`; a following clean round that proposes appends a `closes: true` line; `openIncidents(readIncidents(w.state).lines)` is empty after it and had one entry before. `--check` and `--dry` append nothing. Then `npm test`.
- [ ] **Step 5: Commit** `feat(curate): keep every incident in incidents.jsonl`.

### Task 6: The briefing shows incidents, repairs, a network check that did not wait, and days behind (spec R7)

**Files:**
- Modify: `src/briefing/facts.mjs` (`lastRunFacts` ~96-129 keeps `networkWarning` and `networkWaitedMs`; `briefingFacts` ~288-310 gains `incidents` and `marks`)
- Modify: `src/commands/preflight.mjs` (`renderLastRun` ~77-95)
- Modify: `test/preflight.test.mjs:27` and `:186` (`FACT_KEYS` ends `..., 'questions', 'incidents', 'marks'`, the order `briefingFacts` returns)
- Modify: `lang/*/messages.json`
- Test: `test/briefing-incidents.test.mjs` (create)

**Interfaces:**
- Consumes: `readIncidents`, `openIncidents` (Task 5); `readWatermark`, `daysBetween`, `WatermarkError` (`src/guards/watermark.mjs`).
- Produces: `facts.incidents = { open: [{ reasonCode, count, firstHuman, lastHuman, known, reason }], repairs: [{ atHuman, kind, detail }], corrupt, problem }`, grouped by `reasonCode`, newest reason kept and cut to one line of 200 chars; repairs are those whose `at` is within 24 h of `now`; times rendered in the vault zone as `DD/MM HH:MM`. `facts.marks = { sources: { [id]: { day, behind } }, problem }`.

- [ ] **Step 1: Write the failing tests** from a seeded state dir (no curate run): two `dirty_tree` lines and one `sync_offline` line after the last `closes` -> two groups, the `dirty_tree` one with `count: 2`; a repair 3 h ago is listed and one 30 h ago is not; times in `America/Argentina/Buenos_Aires` (Review Focus 4); `last-run.json` with `network: { warning: 'did_not_wait', waitedMs: 16 }` renders the did-not-wait line; a watermark three days behind renders the behind line, one day behind renders nothing; a directory at `incidents.jsonl` and a non-JSON `watermark.json` each render one unreadable line and never throw (Review Focus 5); nothing open, repaired, warned or behind -> `renderLastRun` output identical to today's for the same last-run.
- [ ] **Step 2: Run** them; they fail.
- [ ] **Step 3: Implement** the facts and the lines in `renderLastRun`, after the last-run and connector lines.
  Copy (pt-BR / en):
  - `preflight.incident_group`: "Incidente aberto: {reasonCode}, {count} vez(es) de {first} a {last} ({known}). Último motivo: {reason}" / "Open incident: {reasonCode}, {count} time(s) from {first} to {last} ({known}). Latest reason: {reason}"
  - `preflight.incident_known` / `preflight.incident_unknown`: "causa conhecida" / "causa desconhecida"; "known cause" / "unknown cause"
  - `preflight.repair`: "Corrigido sozinho em {at}: {kind} {detail}" / "Repaired on its own at {at}: {kind} {detail}"
  - `preflight.network_did_not_wait`: "A checagem de rede respondeu em {ms} ms na primeira tentativa: talvez não espere a conexão. Veja brain-kit doctor." / "The network check answered in {ms} ms on its first try: it may not wait for a connection. See brain-kit doctor."
  - `preflight.mark_behind`: "Fonte {source}: {days} dias sem curadoria; a próxima rodada lê esses dias." / "Source {source}: {days} days not curated; the next round reads them."
  - `preflight.incidents_unreadable` / `preflight.marks_unreadable`: "Não foi possível ler {file}: {detail}" / "Could not read {file}: {detail}"
- [ ] **Step 4: Run** the file and `npm test`.
- [ ] **Step 5: Commit** `feat(briefing): show open incidents, repairs, a network check that did not wait and days behind`.

### Task 7: Docs, incidents and changelog (spec R8)

**Files:**
- Modify: `docs/scheduling.md` (~286-288), `src/commands/schedule.mjs:21-23` (comment), `test/incidents/2026-09-14-nightly-never-ran.test.mjs:14` (test title)
- Modify: `docs/incidents.md` (four new entries, one extended), `test/privacy-policy-docs.test.mjs` (~304-307)
- Modify: `CHANGELOG.md` (new `## Unreleased` above `## 0.1.1`)

**Interfaces:** none.

- [ ] **Step 1: Update the failing assertion first:** in `test/privacy-policy-docs.test.mjs` the entry count becomes 86 and the sentences become "Fourteen entries were added since" and "Eighty six entries follow". Run it: it fails.
- [ ] **Step 2: Write the entries** in `docs/incidents.md`, each `### DD/MM/YYYY: <title>` with **What happened / Rule / Where it lives in brain-kit**, no names of people, companies or tools, under the right theme ("Headless runs, network and scheduling" for the three run-time ones):
  - 30/09/2026: a spent usage limit was read as a generic model failure (Task 4).
  - 06/10/2026: a day-old empty index lock stopped every sync (Task 2).
  - 07/10/2026: name resolution was not back when the round fired on resume, and the round said only "see the message above" (Task 1, and the rollout's network check).
  - 09/10/2026: a timer fires on resume whatever `Persistent=` says (this task's doc fix).
  - extend 14/09/2026 (stub) with the repair rule and where it lives (Task 3).
  Add the four clauses to the intro sentence that lists the entries added since.
- [ ] **Step 3: Fix the `Persistent=false` claim** in `docs/scheduling.md`, the comment in `schedule.mjs:21-23` and the test title: a realtime timer whose time passed during suspend fires on resume; the network check inside the round is what absorbs it.
- [ ] **Step 4: Write `## Unreleased`** in `CHANGELOG.md` (prose summary, then themed bullets, as `## 0.1.1` does): the two repairs, the three named causes, `incidents.jsonl`, the briefing lines, the doc fix.
- [ ] **Step 5: Run** `npm test`; it passes in full. **Commit** `docs: incidents, scheduling and changelog for round repairs`.
