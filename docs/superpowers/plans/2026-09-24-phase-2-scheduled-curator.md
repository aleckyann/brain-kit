# Phase 2: the scheduled curator

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `brain-kit curate` runs unattended on a schedule, reads the person's recent Claude Code sessions, and turns what they learned into a pull request against their vault, through a model that can act only through the kit's own commands; every way it can fail is loud, and no day is marked read that was not read.

**Architecture:** four layers, each testable without a real model. (1) `src/harness/claude-code.mjs` builds the isolated `claude -p` argument vector and consumes its stream-json output into a round record (tool uses, tool results, denials, cost, the init event). (2) `src/sources/transcripts-claude-code.mjs` picks which session files belong to the window, by the timestamps of their messages, filters the curator's own runs, caps by recency and says what it cut. (3) Guards, one per file, each carrying its dated incident: network, empty window, dirty tree, CLI stub and flags, isolation, read evidence, watermark. (4) `brain-kit curate` runs them in one fixed, tested order around a generic, domain-neutral prompt from the language packs, which a vault may override. `brain-kit schedule` installs the timer; `brain-kit watermark` inspects and moves the high water mark.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`. Claude Code 2.1.281 on the maintainer's machine. Every test uses a fake `claude` (a Node script that validates its argument vector and replays a recorded stream); one opt-in test (`BRAIN_KIT_E2E=1`, never in CI) runs the real binary.

**Spec:** the approved design, private to the maintainer: its `curate`, `watermark`, `schedule`, `doctor` and `prompt` command rows, its guard list, its "Fontes plugáveis" and "Agendamento" sections, and its phase 2 row. Four decisions taken with the maintainer on 24/09/2026 override the design where they differ:

1. **The prompt is written from scratch, domain neutral.** The kit serves people with other jobs, routines and vocabulary than the original vault's owner. The design's "literal copy of the original prompt with two declared edits" is dropped; nothing is read from the private reference vault. The rules that prompt paid for in incidents are kept as a contract (Task 4), taken from `docs/incidents.md` and `docs/rationale.md`. A vault may override the prompt with `.brain-kit/prompts/curate.md`; `update` never overwrites it.
2. **The acceptance criterion changes.** Not "differs from the original prompt only in the parameters block", but: every tool the prompt names is in the round's allowlist; every contract rule is present in the rendered prompt in both languages; and one real round against a throwaway vault opens a pull request from inside the round and records its cost.
3. **The model runs isolated from the person's own Claude Code settings.** Measured in the spike of 24/09/2026 (Task 1 turns its findings into tests): a default `claude -p` inherits the user's permission mode (`auto` on the maintainer's machine), user hooks, user allow rules and every MCP server; under that, a command in `--disallowedTools` and a command outside the allowlist both ran, with exit 0 and no denial reported. With `--permission-mode dontAsk`, a user hook that rewrites commands (`curl` into `rtk curl`) plus a user allow rule for the rewritten form still let a disallowed command run. What held: `--setting-sources '' --strict-mcp-config --permission-mode dontAsk --permission-prompts none`, the argument after `--setting-sources` being the empty string (no user, project or local settings file is loaded): no hooks, no user rules, no MCP servers, the disallowed command denied and listed in `permission_denials`, OAuth login still working. `--setting-sources project` is NOT enough: a `SessionStart` hook in the project's `.claude/settings.json` ran even in a workspace never trusted (only the project's allow rules were ignored), and the `.claude/settings.json` that `init` seeds in every vault enables the brain-kit plugin, whose hooks would then run inside the round. Also measured: the round's environment reaches the commands the model runs through Bash (a variable set for `claude` was seen by the kit run by the model), and in one of two runs the model put `node` in front of the kit command on its own. `--bare` is not an option: it reads only `ANTHROPIC_API_KEY`, which leaves out subscription users.
4. **Transcripts are selected by the timestamps of their messages, not by file modification time.** Lesson of 24/09/2026 from the original vault's curation: selecting by mtime made a session from weeks before read as new twice, and the round wrote it up as new fact. Modification time is only a cheap pre-filter.

Phase 1 is on `main` at `3ee7910`.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync`/`spawn` with an argument array. The prompt reaches `claude` on stdin, never as an argument.
- Every git call removes the caller's git environment through `src/git-env.mjs`.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key. Prompts live in `lang/<code>/prompts/`, one per language, same set of files and placeholders in both packs.
- Files under `src/`, `bin/`, `hooks/`, `skills/`, `agents/` and `templates/` are pure ASCII. The em dash is banned everywhere. Never type a unicode escape into file content.
- No household data anywhere: no company, colleague or customer name, no real e-mail beyond the author's public metadata, no absolute path naming someone's machine. Fixtures derived from real streams are anonymized (paths replaced by `/home/ana/...` and `/tmp/brain-kit-fixture/...`, session ids by fixed fake ids) before they are committed. Example data uses "Ana", `example.com` / `example.invalid`, `human:ana`, `brain-kit-curator/claude-opus-5-5`.
- Exit codes are fixed in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not a vault, `3` degraded, `4` required source not read, `69` network or model unavailable, `75` postponed (lock held, dirty tree). A guard that postpones exits 75 and says why; it never exits 0.
- **Never read, run against or write to the private reference vault this kit is extracted from, and never run a command from the session's default working directory: always `cd` into the kit repository or a scratch directory first.** Never read `~/.claude/projects` of the maintainer in tests: every test builds its own fake transcripts directory.
- Point `BRAIN_KIT_STATE_DIR` or `XDG_STATE_HOME` at a scratch directory in every test and every manual run. A test that could call the real `claude` asserts first that its fake is the one on the argument vector, and aborts otherwise (incident "a test suite that would have burned a real round").
- Nothing installs a real timer on the maintainer's machine in tests: `schedule` is tested with `--dry` and with `XDG_CONFIG_HOME` / `HOME` pointed at scratch, and `systemctl` / `launchctl` / `crontab` replaced by fakes on `PATH`.
- The maintainer's pre-push gate is active; never bypass it. Commit with the configured identity and never supply one; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

Clause-by-clause mutation is mandatory where a deleted clause could: let the model run with the person's own settings, hooks or MCP servers; let a command outside the allowlist or inside the denylist reach the model's reach; advance a watermark over a day that was not read; turn a failed round into exit 0; run the steps of `curate` in another order; or install a timer that fires overnight or depends on a network target. Everywhere else, ordinary tests plus the two questions. Control at zero failures before any mutation, more than once; verify each mutation changes behaviour; derive the clause list from the code as it stands at the end.

**The two questions:** what single edit makes a round exit 0 when it failed, advance the watermark over an unread day, or run with the person's settings, while the suite stays green? And what already does so with no edit at all? Prove each with a real run of `brain-kit curate` against a throwaway vault and a fake `claude`.

**The recurring shape:** a command that succeeds while saying nothing, read as nothing to do (four days of rounds dying on the dirty tree guard with the scheduler green; a 401 in six seconds reported as success); and a command that succeeds answering about something other than what we act on (a network guard that waited for the manager, not the connection; a watermark advanced by the agent's exit code alone; a denylist that matched the rewritten command, not the one the model asked for).

## Review Focus

1. **Isolation.** The argument vector always carries the four isolation flags; the round aborts before the model does any work when the init event reports a permission mode other than `dontAsk`, any hook event, or any MCP server the round did not ask for. Owner: Task 1.
2. **Selection by message time.** A file touched today whose messages are all from weeks ago stays out; a file whose last message is inside the window comes in even if its mtime is older; the curator's own runs are dropped only by the first user message. Owner: Task 2.
3. **The watermark.** It advances only with exit 0 from the model, read evidence for every required source, and a `BRAIN_KIT_SOURCES` line; a partial round, a denial on a required read, or a missing final line leaves the day open. Owner: Task 3 and Task 6.
4. **The order of `curate`.** sentinel and machine file, `--dry` exit, lock, network, sync, then config and prompt, window, dirty tree, CLI, model. A test asserts the order by the side effects each step leaves. Owner: Task 6.
5. **Loud failure.** Every non-zero exit writes the reason in the log and in `last-run.json`, and calls the notify command when one is configured; a green round lasting seconds with no model turns is reported as dead by `doctor`. Owner: Task 6 and Task 8.
6. **The round's own lock and its leftovers.** The `propose` the model runs joins the lock the round holds instead of being refused; after the model, the files it proposed that are byte-identical to what was pushed are brought back to the default branch's content, so the next round does not stop on a dirty tree; anything else the round left is reported, exits 1 and keeps the day open. Owner: Task 5 and Task 6.

## What earlier phases established, which this phase reuses

- `src/guards/lock.mjs`: `acquireLock(root, { command })`, `describeLock`; `src/guards/snapshot.mjs`: `takeSnapshot`, `readSnapshot`, `splitDirty` (a round takes its own snapshot at start with `session: "curate-<ISO>"`).
- `src/commands/sync.mjs` (the base update), `src/commands/propose.mjs` (the only path to a pull request, `--only` normal, the round's own snapshot lets it propose what appeared since round start), `src/commands/validate.mjs`, `src/commands/lint.mjs`.
- `src/state.mjs`: `stateDirFor`, `ensureStateDir`, `STATE_FILES` (`watermark.json`, `last-run.json`, `logs`); `src/config.mjs`: `loadConfig`, `loadMachine`; machine.json already has `claude_bin`, `model`, `network_check`, `notify_command`, `path_extra`, `transcripts_dir`, `paths`, `log_retention_days`, `keep_stream`.
- The configuration already has `curate { enabled, schedule, prompt, signature, max_turns, budget_usd, network_min_wait_ms, caps, sources { required, best_effort }, extra_signatures, allowed_tools_extra, disallowed_tools_extra }` and `sources.transcripts { adapter, include_projects, exclude_path_patterns, sample_strategy }`.
- `src/commands/prompt.mjs` renders language-pack bodies with `{{placeholders}}`; `{{kit}}` is the command that runs the kit.
- `src/doctor/checks.mjs`: the check registry `doctor` runs.
- The spike's raw streams and notes are in the maintainer's scratch directory; Task 1's brief gives the facts. The anonymized fixtures this phase commits are created from them in Task 1.

## Out of scope

- Calendar and meeting-notes sources, the MCP probe, `lint privacy` on added lines, `seed-rituals`: phase 3. This phase keeps the source interface ready for them (`kind`, `readEvidence`, `probe`) and implements only `transcripts`.
- The briefing and `preflight`: phase 4.
- Migrating the original vault: phase 5. `watermark import` is not built here.
- macOS launchd and cron are rendered and tested with `--dry` only; systemd user units are the reference, installed for real only in the opt-in E2E.
- `--restricted`: measured to work too, but it removes Bash unless `--tools` names it; `--setting-sources ''` is the chosen isolation. Recorded in `docs/security.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/harness/claude-code.mjs` | argv builder, stream consumer, round record |
| `src/harness/stream.mjs` | line-by-line stream-json parser, tolerant of unknown types |
| `src/guards/isolation.mjs` | check the init event: permission mode, hooks, MCP |
| `src/guards/cli.mjs` | stub fingerprint, `--version` numeric, flags accepted |
| `src/guards/network.mjs` | timed wait for connectivity, "did not wait" warning |
| `src/guards/dirty-tree.mjs` | exit 75 with the file list and mtimes |
| `src/guards/empty-window.mjs` | a window with nothing to read is a pass |
| `src/guards/watermark.mjs` | per-source marks, advance rule |
| `src/guards/read-evidence.mjs` | per-source evidence from the round record |
| `src/sources/index.mjs` | the source interface |
| `src/sources/transcripts-claude-code.mjs` | discovery, time window, self-trace, cap, sampling plan |
| `lang/<code>/prompts/curate.md` | the generic prompt |
| `src/curate/tools.mjs` | the round's allowlist and denylist, the kit command |
| `src/guards/lock.mjs`, `src/commands/propose.mjs`, `src/commands/sync.mjs` (modify) | round token, joining the round's lock, the round record, `syncUnderLock` exported |
| `src/commands/curate.mjs` | the fixed order, cleanup, exit codes, last-run, notify |
| `src/commands/watermark.mjs` | `show|set|reopen|assume-covered` |
| `src/commands/schedule.mjs`, `templates/schedule/{systemd,launchd,cron}/*` | install, uninstall, status, `--dry` |
| `src/doctor/checks.mjs` (modify) | curate-related checks |
| `docs/scheduling.md`, `docs/security.md` | how to run it, and what isolates the model |
| `test/fixtures/stream/*.jsonl` | anonymized real streams |
| `test/helpers/fake-claude.mjs` | argv-validating stream replayer |
| `test/incidents/<date>-<name>.test.mjs` | one per incident this phase owns |

---

### Task 1: the harness, the stream and the isolation guard

**Files:**
- Create: `src/harness/stream.mjs`, `src/harness/claude-code.mjs`, `src/guards/isolation.mjs`, `src/guards/cli.mjs`, `test/helpers/fake-claude.mjs`, `test/fixtures/stream/{isolated-run,default-run,denied-run}.jsonl`, `test/harness.test.mjs`, `test/incidents/2026-09-24-inherited-settings.test.mjs`, `test/incidents/2026-09-14-cli-stub.test.mjs`
- Modify: both `messages.json`

**Interfaces:**
- Produces: `buildArgv({ model, maxTurns, budgetUsd, allowed, disallowed }) -> string[]`. Always, in this order: `-p --verbose --output-format stream-json --permission-mode dontAsk --permission-prompts none --setting-sources '' --strict-mcp-config --no-session-persistence` (the argument after `--setting-sources` is the empty string, its own element of the vector), then `--model <m>` when set, `--max-turns <n>`, `--max-budget-usd <x>`, `--allowedTools` followed by each allowed rule as its own argument, `--disallowedTools` followed by each denied rule, then `--` and nothing after it (the prompt goes on stdin).
- Produces: `parseStream(lines) -> { init, events, toolUses: [{ id, name, input }], toolResults: [{ toolUseId, isError }], denials: [{ toolName, toolUseId, input }], result: { subtype, isError, costUsd, numTurns, terminalReason } | null, hookEvents: number, unknownTypes: string[], invalidLines: number }`. Unknown `type` or `subtype` values are counted, never fatal. A line that is not JSON is counted in `invalidLines`.
- Produces: `runModel({ claudeBin, argv, prompt, cwd, env, timeoutMs, onLine }) -> { exitCode, signal, record, stderrTail, durationMs }` using `spawn`, prompt written to stdin then closed, stdout consumed line by line; the exit code is taken from the child's own `close` event and nowhere else (incident 29/07/2026 and 21/08/2026).
- Produces: `checkIsolation(record, { allowMcp = [] }) -> { ok, problems: [code] }` with codes `permission_mode` (init `permissionMode` is not `dontAsk`), `hooks` (any `hook_started` / `hook_response` system event), `mcp` (any MCP server in init not in `allowMcp`), `no_init`.
- Produces: `checkCli(claudeBin) -> { ok, problem: 'missing'|'stub'|'version'|null, version }`: a file under 2 KB, or `--version` whose output does not start with `\d+\.\d+\.\d+`, is not a usable CLI (incident 14/09/2026).

Facts to encode, measured on 24/09/2026 with Claude Code 2.1.281:
- `claude -p --output-format stream-json` without `--verbose` exits 1 with `Error: When using --print, --output-format=stream-json requires --verbose`. The fake reproduces it.
- Event shapes: `system/init { permissionMode, tools[], mcp_servers[{ name, status }], model, cwd, ... }`; `assistant` message content `tool_use { id, name, input }`; `user` message content `tool_result { tool_use_id, is_error, content }`; `result { subtype, is_error, total_cost_usd, num_turns, permission_denials[{ tool_name, tool_use_id, tool_input }], terminal_reason }`. Also seen, to be ignored: `system` subtypes `hook_started`, `hook_response`, `thinking_tokens`, `commands_changed`, `task_summary`, `post_turn_summary`, and a top-level `rate_limit_event`.
- A denied command comes back as a `tool_result` with `is_error: true` and content `Permission to use Bash with command <cmd> has been denied.`, and appears in `result.permission_denials`.
- A result with `subtype: "error_max_turns"` carries `is_error: true`.
- Read-only commands (`git status`, `cat`) run in `dontAsk` without an allow rule: the allowlist limits what the model can do, not what it can read. `docs/security.md` (Task 7) says so.

**Fixtures:** the controller copies the spike's raw streams into the task's scratch directory; the implementer anonymizes them (every absolute path, cwd, session id and uuid replaced; user text replaced by neutral text) into the three fixture files, and a test asserts no fixture contains `/home/` other than `/home/ana/`, no `/tmp/claude-`, and no string matching the maintainer's leak patterns (the gate checks the latter on push).

**Fake claude:** `test/helpers/fake-claude.mjs` reads a scenario from `FAKE_CLAUDE_SCENARIO` (a JSON file path): it validates its argv (refuses stream-json without `--verbose` with the real message; records argv and stdin to files named in the scenario), then performs the scenario's `actions` in its working directory, in order, with its own environment (so a variable the caller set, such as the round token, reaches them): `{ "write": { "path": "<relative>", "content": "..." } }` writes a file, `{ "run": ["<argv>", ...] }` runs a command and records its exit code and output to the scenario's record file; then prints a fixture stream, optionally rewritten (for example, a permission mode, an added hook event, a final text with a `BRAIN_KIT_SOURCES` line, tool uses naming given file paths), and exits with the scenario's code after an optional delay. This is what lets `curate` be tested end to end without a model: the fake writes a log entry and runs the real `propose` the way the model would. `--version` prints the scenario's version text.

- [ ] **Step 1:** tests for `buildArgv` (exact order; every isolation flag present; each rule its own argument; nothing after `--`), `parseStream` against the three fixtures (counts, cost, denials, unknown types tolerated, invalid lines counted), `runModel` with the fake (stdin carries the prompt; exit code of the child; a delay then kill on timeout reports the signal), `checkIsolation` (each problem alone, from rewritten fixtures), `checkCli` (a 500 byte file, a `--version` printing error text, a good fake).
- [ ] **Step 2:** incident test `2026-09-24-inherited-settings`: the default-run fixture (permission mode `auto`, a hook event, MCP servers) fails isolation with all three problems; the isolated-run fixture passes.
- [ ] **Step 3:** run, see them fail; implement; run the whole suite.
- [ ] **Step 4:** mutation over `buildArgv`'s isolation flags and every clause of `checkIsolation`.
- [ ] **Step 5:** commit `feat: harness runs claude isolated from the person's own settings and reads its stream`.

### Task 2: the transcripts source

**Files:**
- Create: `src/sources/index.mjs`, `src/sources/transcripts-claude-code.mjs`, `test/sources-transcripts.test.mjs`, `test/incidents/2026-08-11-self-trace-filter.test.mjs`, `test/incidents/2026-08-11-recency-cap.test.mjs`, `test/incidents/2026-09-24-mtime-selection.test.mjs`
- Modify: `docs/incidents.md` (new entry, see below), both `messages.json`

**Interfaces:**
- Produces: the source interface `{ id, kind: 'local'|'connector', required: boolean, readEvidence(record, plan) -> { read: number, expected: number, ok: boolean }, collect({ window, config, machine, now }) -> plan }`, exported as a JSDoc typedef plus `validateSource(obj)`.
- Produces: `transcriptsSource.collect(...)` returning `{ files: [{ path, project, firstAt, lastAt, bytes, sampleFrom }], dropped: { byCap: n, selfTrace: n, outOfWindow: n, excludedPath: n, unreadable: n }, promptBlock: string }`.

Rules:
- Root: `machine.transcripts_dir`, default `~/.claude/projects`. Projects: only directories named in `sources.transcripts.include_projects` (slugs, exact match). An empty list reads nothing and says so; there is no "all" default.
- Window: `[from, to)` in the vault's time zone, given by the caller (Task 3 computes it from the watermark).
- Candidate pre-filter: files whose mtime is before `from` are skipped without opening (they cannot hold a message inside the window). Every other `.jsonl` is opened and scanned line by line for `timestamp` fields; `firstAt` and `lastAt` are the earliest and latest message timestamps inside the window. A file with no message inside the window is `outOfWindow`, whatever its mtime. A line that does not parse is skipped; a file with no parseable timestamp is `unreadable` and listed as such (in doubt the file is reported, never silently dropped).
- Self-trace: a file whose FIRST user message (the first line with `type: "user"` whose message content is text) starts with the curator's signature (`curate.signature`) or any of `curate.extra_signatures` is the curator's own run and is dropped (`selfTrace`). A signature anywhere else in the file does not drop it (incident 11/08/2026).
- `exclude_path_patterns`: substring match on the file path; counted as `excludedPath`.
- Cap: `curate.caps.transcripts`; sort by `lastAt` newest first; the oldest fall off; `byCap` counts them.
- Sampling plan: for each kept file, `sampleFrom` is the byte offset where the last 64 KB begin (0 when smaller); the prompt tells the model to read from there and then earlier slices only if needed, never the whole file (incident "reading a transcript whole blew the context").
- `promptBlock`: a plain list, one file per line with project, `firstAt`..`lastAt` (ISO), size and `sampleFrom`, then one line per non-zero `dropped` counter ("N transcripts left out by the cap of M"). Every ceiling announces itself.
- `readEvidence`: a transcript counts as read when the round record has a successful `Read` tool result whose input `file_path` equals the file's path. `ok` when at least one kept file was read, or when there were no kept files.

New `docs/incidents.md` entry under "Headless runs, network and scheduling", dated `24/09/2026`, title "selection by modification time turned an old session into a new fact": what happened (a session file touched again weeks later was selected by its mtime and written up as new, twice), rule (select by the timestamps of the messages inside the window; mtime is only a pre-filter), where it lives (`src/sources/transcripts-claude-code.mjs`, the incident test). No names, no vault specifics.

- [ ] **Step 1:** tests with a fake transcripts tree in scratch (projects in and out of the list, files touched recently with only old messages, files with old mtime but a message in the window, a curator run by first message, a human session that merely quotes the signature later, a malformed line, an unreadable file, 25 candidates with a cap of 20, an excluded path pattern). The three incident tests.
- [ ] **Step 2:** run, see them fail; implement; run the whole suite.
- [ ] **Step 3:** mutation over the self-trace clause, the window clause and the cap order.
- [ ] **Step 4:** commit `feat: transcripts source selects sessions by message time and says what it left out`.

### Task 3: watermark, read evidence and the small guards

**Files:**
- Create: `src/guards/watermark.mjs`, `src/guards/read-evidence.mjs`, `src/guards/network.mjs`, `src/guards/dirty-tree.mjs`, `src/guards/empty-window.mjs`, `src/commands/watermark.mjs`, tests `test/watermark.test.mjs`, `test/guards-small.test.mjs`, incident tests `2026-08-20-watermark-without-sources`, `2026-08-29-network-wait`, `2026-09-13-dirty-tree-silent`
- Modify: `src/cli.mjs` (register `watermark`), both `messages.json`

**Interfaces:**
- `readWatermark(stateDir) -> { sources: { [id]: 'YYYY-MM-DD' } }` (missing file: every source unset); `windowFor(mark, today, tz, { maxDays = 7 }) -> { from, to, days: ['YYYY-MM-DD'], clipped }`: from the day after the mark (or yesterday when unset) to yesterday inclusive, `to` exclusive at today 00:00 in `tz`; more than `maxDays` days is clipped to the most recent `maxDays` and `clipped` says so. An empty `days` means the mark is already at yesterday.
- `advanceWatermark(stateDir, sourceId, day, { modelExit, evidence, sourcesLine, vacuous = false })` writes only when `modelExit === 0 && evidence.ok` and the sources line says `ok` for this source, or says `empty` with `evidence.expected === 0`; with `vacuous: true` (the empty window path, where no model ran) it writes only when `evidence.expected === 0`; otherwise it returns `{ advanced: false, reason }` and writes nothing. Written atomically (temp file plus rename), mode 0600.
- `parseSourcesLine(text) -> { [id]: 'ok'|'empty'|'failed'|string } | null`: the LAST line of the model's final text that starts with `BRAIN_KIT_SOURCES:` followed by `id=state` pairs separated by spaces. `empty` counts as ok for advancing only when the source's evidence also shows it looked (read >= 0 with no kept files).
- `waitForNetwork(check, { timeoutMs, minWaitMs = 100 }) -> { ok, waitedMs, warning: 'did_not_wait'|null }`: `check` is `machine.network_check` (an argv) or, when unset, a TCP connect to `api.anthropic.com:443` retried every second; a check that returns success in under `minWaitMs` on its FIRST try is accepted but reported `did_not_wait` (incident 29/08/2026). No network within `timeoutMs`: `ok: false` (curate exits 69).
- `checkDirtyTree(root, snapshot?) -> { ok, files: [{ path, mtime }] }`: any dirty path not ignored makes it not ok; files listed with mtimes; the caller exits 75 (incident 13/09/2026).
- `emptyWindow(plan) -> boolean`: no kept files in any source; the round then exits 0 with "nothing to curate for <days>" and the watermark advances for sources whose evidence is vacuously ok (incident "the acceptance criterion demanded facts no round could produce").
- `brain-kit watermark show [dir]`, `set <source> <YYYY-MM-DD> [dir]`, `reopen <source> <YYYY-MM-DD> [dir]` (moves back), `assume-covered <source> [dir]` (sets to yesterday, printing what it skips). Owner commands; they take the vault lock.

- [ ] **Step 1:** tests; incident tests; run, see them fail; implement; whole suite.
- [ ] **Step 2:** mutation over each condition of `advanceWatermark` and the `did_not_wait` clause.
- [ ] **Step 3:** commit `feat: watermark advances only on read evidence; network, dirty tree and empty window guards`.

### Task 4: the generic curate prompt

**Files:**
- Create: `lang/pt-BR/prompts/curate.md`, `lang/en/prompts/curate.md`, `test/prompt-curate.test.mjs`
- Create also: `src/curate/tools.mjs`: `KIT_SUBCOMMANDS = ['validate', 'lint', 'propose']`, `kitCommand()` (the kit's own `bin/brain-kit.mjs` as a double-quoted absolute path, the same string `{{kit}}` renders to in this prompt), `allowedTools(extra = [])` and `disallowedTools(extra = [])` exactly as Task 6 lists them. Task 6 consumes it; this task's contract test uses it.
- Also export `renderCuratePrompt({ vaultRoot, config, lang, parameters })` for Task 6; `brain-kit prompt curate` standalone renders `{{parameters}}` as one translated line saying the block is filled in by `brain-kit curate` at run time.
- Modify: `src/commands/prompt.mjs` (`brain-kit prompt curate [--vault <dir>]`, and `--check` covers prompts), `test/parity.test.mjs`, both `messages.json`

**Content:** written from scratch, second person, domain neutral: it must read right for a teacher, a lawyer, a developer or a researcher; no company, team, calendar or meeting vocabulary; examples use Ana and neutral topics. It is the policy; the mechanics are the kit's. It has these sections, in both languages, and the placeholders `{{parameters}}` (the block the round computes: days, window, sources with their plan blocks, caps, the kit command, the signature line to print last), `{{kit}}`, `{{log}}`, `{{capture_marker}}`, `{{agent}}`, `{{today_iso}}`:

1. Who you are and what this round is: an unattended round with no person present; nothing you write is final until the owner merges.
2. The parameters block (`{{parameters}}`), verbatim.
3. Read: the vault's `index.md` first; the transcripts listed, each from its `sampleFrom` offset backwards, never whole; only what the round lists.
4. Capture: new facts, changed minds and conflicts go to `{{log}}` under `## {{today_iso}}` first, most recent first, each starting with `{{capture_marker}}`, each saying which session it came from.
5. Compile: turn captures into new or changed notes, with `generated: { by: {{agent}}, at }`, `sources` pointing at the log; never write `verified`; a fact seen in only one session and not confirmed stays a capture.
6. What you never do: invent; state that a document or session is empty without having opened it in this round; copy a transcript into the vault; record anything about a third party's private life; run any command other than the kit's.
7. Uncertainty, closed vocabulary: not verified (a source you could not read), not found (you looked and it is not there), don't know (not in the vault).
8. Finish (every kit command exactly as written here, never with `node` or anything else in front of it): `{{kit}} validate`, `{{kit}} lint --base worktree`, fix until both pass, then `{{kit}} propose "<summary>" --only <paths>` with only the files this round changed; if there is nothing worth proposing, say so and propose nothing.
9. The last line of your final message, exactly: `BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>`, with `failed` when any listed transcript could not be read.

**Contract test** (the acceptance criterion of decision 2): for each language, the rendered prompt contains each of these, by a stable marker the test checks (an HTML comment `<!-- rule:<id> -->` before each rule, kept in both packs): `read-index-first`, `sample-from-end`, `log-before-note`, `never-verified`, `never-empty-unopened`, `closed-uncertainty`, `only-kit-commands`, `propose-only`, `sources-line`. And: every command the prompt tells the model to run is built from `{{kit}}` and one of `KIT_SUBCOMMANDS`, and `allowedTools()` grants it; no rendered prompt contains a placeholder left unresolved.

Overlay: when `.brain-kit/prompts/curate.md` exists in the vault, `prompt curate` renders it instead, and `--check` warns (does not fail) when the overlay lacks a contract marker.

- [ ] **Step 1:** tests; run, see them fail; write both prompts; implement; whole suite.
- [ ] **Step 2:** read both rendered prompts end to end once as a person from another field would; fix anything that assumes a job or a routine.
- [ ] **Step 3:** commit `feat: a domain-neutral curate prompt with its contract rules tested`.

### Task 5: the round's plumbing in the lock, propose and sync

**Files:**
- Modify: `src/guards/lock.mjs`, `src/commands/propose.mjs`, `src/commands/sync.mjs`, `test/lock.test.mjs`, `test/propose.test.mjs`, `test/sync.test.mjs`, both `messages.json` if a message is added
- Create: `test/incidents/2026-09-24-round-lock-and-leftovers.test.mjs`

**Why:** found while planning, 24/09/2026. `propose` and `sync` each take the vault lock, so the `propose` the model runs inside a round, which holds the lock, would be refused with 75. And a successful `propose` leaves the proposed files in the working tree by design (slice C), so the next scheduled round would stop on its dirty tree guard with 75, day after day: the shape of the four silent days of 13/09/2026. This task gives the round a way in; Task 6 cleans up after it.

**Interfaces:**
- `acquireLock` records a `token` in the holder, 32 lowercase hex characters from `randomBytes(16)`, and returns it: `{ holder, lockPath, release, token }`. A lock file written before this change (no `token`) still reads, and is never joinable. The token is never printed, logged or put in a message: `describeHolder` and every caller that prints a holder leave it out.
- `joinOrAcquire(root, { command, env, now })`: when `env.BRAIN_KIT_ROUND_TOKEN` is 32 lowercase hex characters, the lock file exists, its holder's `token` equals it, and the holder is not stale by the existing rule, it returns `{ joined: true, holder, lockPath, token, release: () => false }`: a joined command never releases the round's lock. In every other case it behaves exactly as `acquireLock`; a token in the environment that matches nothing is ignored, never trusted.
- `propose` takes the lock with `joinOrAcquire`. When joined, and only after it pushed a commit (pull request opened, or degraded with the commit pushed), it writes `<git dir>/brain-kit-round-<token>.json` atomically, mode 0600: `{ "format": 1, "opened": true|false, "remote": "<name>", "branch": "<pushed branch>", "commit": "<sha>", "paths": ["<vault-relative posix path>", ...] }`, `paths` being exactly the paths the commit changed. Not joined, nothing is written and nothing else changes.
- `sync.mjs` exports `syncUnderLock(root, io, t, env)` (the existing function) so `curate`, which already holds the lock, runs the same code in process. `runSync` is unchanged.

- [ ] **Step 1:** tests: join with the right token (no second lock, the lock byte-identical after `propose` returns); a wrong token, a malformed token, the right token on a stale holder, and an old-format lock each fall back to acquiring (refused with 75 while a live holder holds it); the record written only when joined and only after a push, with exactly the commit's paths; the token absent from stdout and stderr of a joined and of a refused `propose`; `syncUnderLock` exported and unchanged in behaviour. Incident test: a throwaway vault, a bare remote, a fake `gh`; hold the lock as a round would, run `propose --only` with the token in the environment: the pull request is opened, the record names the paths, the lock is still the round's.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over every clause of `joinOrAcquire` (each deleted clause must either let a foreign command in or keep the round's own command out) and the "only when joined and pushed" condition of the record.
- [ ] **Step 4:** commit `feat: a round's propose joins the lock the round holds and records what it pushed`.

### Task 6: `brain-kit curate`

**Files:**
- Create: `src/commands/curate.mjs`, `test/curate.test.mjs`, incident tests `2026-09-14-order-network-sync`, `2026-07-29-exit-code`, `2026-08-21-expired-token`
- Modify: `src/cli.mjs`, both `messages.json`

**Interfaces:**
- `brain-kit curate [dir] [--dry] [--check] [--keep-stream]`.
- The allowlist the round passes, from `src/curate/tools.mjs` (Task 4), and the only things the model can do besides reading: `Read`, `Glob`, `Grep`, `Edit`, `Write`, and for each of `validate`, `lint`, `propose` both `Bash(<kit> <sub>:*)` and `Bash(node <kit> <sub>:*)`, where `<kit>` is the kit's own `bin/brain-kit.mjs` as a double-quoted absolute path (measured on 24/09/2026: a quoted path with a space matches per subcommand, another subcommand of the same executable is denied, and the model once put `node` in front on its own), plus `curate.allowed_tools_extra`. The denylist: `Bash(git push:*)`, `Bash(git commit:*)`, `Bash(gh:*)`, `Bash(curl:*)`, `Bash(wget:*)`, `Bash(rm:*)`, `WebFetch`, `WebSearch`, plus `curate.disallowed_tools_extra`. There is no `Bash(node:*)` in it: a deny rule wins over an allow rule, so it would also block the allowed `node <kit>` form, and `dontAsk` already denies every `node` command no rule allows. `{{kit}}` in the prompt renders as the same quoted path.

The fixed order (each step's side effect is what the order test observes):

1. Find the vault (sentinel) and load `machine.json`; missing: exit 2.
2. `--dry`: print what the round would do (window, sources, plan counts, argv without the prompt) and exit 0, taking no lock and writing no state.
3. Take the vault lock (`acquireLock(root, { command: 'curate' })`); held by a live holder: exit 75 naming it. The model's environment gets `BRAIN_KIT_ROUND_TOKEN=<token>` (Task 5) and nothing in the log or `last-run.json` carries the token.
4. Network wait; no network: exit 69.
5. `syncUnderLock` in process (Task 5; the round already holds the lock); a diverged base: exit 75 with sync's message; a sync failure: exit 1.
6. Only now load the configuration and render the prompt (so a synced config is what runs; incident 14/09/2026).
7. Compute the window from the watermark; empty `days`: exit 0, "already up to date".
8. Dirty tree: exit 75 listing files.
9. Take the round's own snapshot (`session: "curate-<ISO>"`).
10. `checkCli`; not usable: exit 1 with the problem.
11. Collect sources. A required source that is misconfigured (`include_projects` empty, the transcripts root missing, or every listed project missing): exit 1 naming the setting, and no watermark moves; a listed project that is missing while others exist is a warning in the log and in `last-run.json`. Then `emptyWindow`: advance vacuously (Task 3) and exit 0.
12. `--check`: stop here, print the full plan and the rendered prompt's size, exit 0.
13. Run the model with the harness; abort (kill the child) as soon as the init event fails `checkIsolation`, exit 1 naming the problems.
14. After the model: compute each source's evidence, parse the sources line, and read the round record `<git dir>/brain-kit-round-<token>.json` if `propose` wrote one (Task 5).
15. Clean up what the round proposed: for each path in the record whose working-tree bytes equal the file in the record's `commit` (or that is absent from both), bring it back to its content at `HEAD`, the default branch the round synced to: a path `HEAD` has is restored from it, one `HEAD` does not have is deleted (git called without the caller's git environment, paths passed as NUL-separated bytes, never as arguments). A path whose content differs is left alone and reported. Then list what is still dirty and not ignored.
16. Exit, first match wins: isolation failed: 1; model exit non-zero or `result.isError`: 69 when the stderr tail or the result shows an API or authentication error (`API Error`, `401`, `authentication`), else 1, the reason naming `result.subtype` (`error_max_turns` included); a required source without evidence: 4; anything still dirty after the cleanup: 1, the reason listing the paths (the round's unproposed work stays in the tree for a person to see, and the next round postpones on it, loudly); a record with `opened: false`: 3; otherwise 0.
17. Advance each source's watermark by Task 3's rule, and only when the exit is 0 or 3 (3 means the work is on a pushed branch, and `propose` already said what to run).
18. Always, whatever the exit: remove the round record, write `last-run.json` (`{ at, durationMs, exit, reason, window, sources: { id: { kept, read, advanced } }, costUsd, numTurns, denials, isolation, proposed: { opened, branch, paths } | null, leftovers: [paths] }`), append the log (`logs/curate-<date>.log`, never containing tool result content or transcript text; `--keep-stream` also keeps the raw stream in the state dir), release the lock, and on any non-zero exit run `machine.notify_command` with the reason as its last argument when configured.

- [ ] **Step 1:** tests with the fake claude and a throwaway vault with a bare remote and a fake `gh`: a full round where the fake, as the model would, writes a log entry and runs the real `propose --only` with the environment it was given: the fake `gh` sees the pull request against the default branch, the record is read and removed, the tree is clean afterwards, the watermark advanced and `last-run.json` names the branch and paths; a round whose fake writes a file and does not propose: exit 1, the file still there, the watermark not advanced; a proposed path edited again after the push is left and reported; each exit code from its cause; the order test (make step N fail and assert steps after it left no trace); `--dry` leaves no lock and no state; `--check` does not call the model; a round whose stream shows `permissionMode: auto` is killed and exits 1; the log never contains a sentinel string planted in a fixture tool result; notify called on non-zero with the reason.
- [ ] **Step 2:** incident tests; run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory: every step of the order, every exit mapping, the isolation abort, the cleanup's byte comparison, the watermark call.
- [ ] **Step 4:** the two questions, answered with real runs of `curate` against the fake.
- [ ] **Step 5:** commit `feat: brain-kit curate runs the round in a fixed order and fails loudly`.

### Task 7: `brain-kit schedule`

**Files:**
- Create: `src/commands/schedule.mjs`, `templates/schedule/systemd/brain-kit-curate.service`, `templates/schedule/systemd/brain-kit-curate.timer`, `templates/schedule/launchd/brain-kit-curate.plist`, `templates/schedule/cron/brain-kit-curate.cron`, `test/schedule.test.mjs`, incident tests `2026-08-28-user-scope-target`, `2026-09-14-nightly-never-ran`, `2026-08-27-binary-moved`
- Modify: `src/cli.mjs`, both `messages.json`, `package.json` `files` already includes `templates/`

**Interfaces:**
- `brain-kit schedule install|uninstall|status [dir] [--platform systemd|launchd|cron] [--dry]`. Platform detected (systemd when `systemctl --user` answers, launchd on darwin, else cron); Windows: exit 2 with the manual instruction.
- Units are named by function (`brain-kit-curate`, one per vault: the vault id is a suffix, `brain-kit-curate-<vault_id>`), never by time of day.
- Windows from `curate.schedule`, daytime. The config packs' default changes from `06:00, 12:00, 18:00` to `09:30, 14:00, 20:00` (the first when a machine is on and connected, two retries that the watermark makes safe), and `init` writes those. `Persistent=false` (no catch-up at resume), no `After=`/`Wants=` on any network target (the wait lives in the engine), `Environment=PATH=` listing `path_extra` plus the directory of `claude_bin`, `LC_ALL=C.UTF-8`, `TZ=<vault.timezone>`, and `ExecStart` running `<node> <kit>/bin/brain-kit.mjs curate <vault>` with absolute paths quoted per the platform's rules (systemd `ExecStart` quoting; a path with a space and an accent must survive, tested).
- `--dry` prints the rendered files and the commands it would run; `install` writes under `$XDG_CONFIG_HOME/systemd/user` (or `~/Library/LaunchAgents`, or the user's crontab through `crontab -l` / `crontab -`, keeping every other line), then enables; `status` prints the next fire times and the last run's `last-run.json` summary; `uninstall` removes only its own files or lines.

- [ ] **Step 1:** tests with fake `systemctl`, `launchctl` and `crontab` on `PATH`, `HOME` and `XDG_CONFIG_HOME` in scratch: rendering for each platform; no network target line (incident 28/08/2026); `Persistent=false` and daytime windows (incident 14/09/2026); PATH carries both directories (incident 27/08/2026); quoting with a space and accents; crontab keeps foreign lines; uninstall removes only its own.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation over the network-target absence, `Persistent=false` and the PATH composition.
- [ ] **Step 4:** commit `feat: brain-kit schedule installs the curator by function, in daytime windows, with no network target`.

### Task 8: doctor, docs and the opt-in end-to-end run

**Files:**
- Modify: `src/doctor/checks.mjs`, `test/doctor.test.mjs`, both `messages.json`, `README.md`, `README.pt-BR.md`, `CHANGELOG.md`
- Create: `docs/scheduling.md`, `docs/security.md`, `test/e2e-curate.test.mjs`

**Doctor checks** (each named, each with the command that fixes it): `claude-real` (checkCli), `claude-isolation-flags` (the installed `claude --help` lists every flag `buildArgv` uses), `include-projects` (non-empty, each slug exists under `transcripts_dir`), `watermark` (per source: date, days behind; more than 3 days behind is a warning), `last-run` (exit, duration; a run under 20 seconds with zero turns is reported as a dead round, incident 21/08/2026), `schedule` (installed, next fire time), `notify` (configured, or warn that failures are only in the log).

**Docs:** `docs/scheduling.md`: what `curate` does step by step, windows and why daytime, the watermark and its commands, reading `last-run.json` and the logs, and "compare the sizes of the recent logs first" when rounds seem to do nothing. `docs/security.md`: the isolation flags and the spike's measurements (what inherited settings did, what `dontAsk` alone did, what held), the allowlist and denylist, the read-only allowance and what limits reading instead (`include_projects`, the plan), cost ceiling, logs without content, `--restricted` measured and not chosen, and why `--bare` is not usable.

**E2E** (`BRAIN_KIT_E2E=1` only, skipped otherwise, never in CI): in scratch, `init --yes` a vault with a bare remote and a fake `gh` that records the pull request; a fake transcripts tree with one session inside the window mentioning "Ana decided to move the reading group to Thursdays"; `machine set` for `transcripts_dir`; run the real `curate` with the real `claude`, `--max-budget-usd 1`, model sonnet. Asserts: exit 0; the log entry exists on a branch; the fake `gh` saw `pr create` against the default branch; `last-run.json` has a cost; the watermark advanced for transcripts; the stream's init event passed isolation. The controller runs it once and records the result in the ledger.

- [ ] **Step 1:** doctor tests with fixtures for each check; implement; whole suite.
- [ ] **Step 2:** write both docs; README and CHANGELOG: phase 2 section.
- [ ] **Step 3:** write the E2E test (skipped by default); commit `feat: doctor checks the curator; scheduling and security docs; opt-in end-to-end round`.

## After the last task (controller)

- Final whole-phase review on the most capable model; one fix dispatch; adjudicate residuals.
- Run the E2E once (`BRAIN_KIT_E2E=1 node --test test/e2e-curate.test.mjs`), cost recorded, result in the ledger, never assumed.
- Push; report phase 2 complete with what the E2E showed.
