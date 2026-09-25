# Phase 3: calendar and meeting-notes sources, fragile by design

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the scheduled round also reads the person's calendar and meeting notes through the claude.ai connectors, when the person has configured them, without giving the model any power beyond the kit's own commands, and every way a connector can be missing, half-connected or misread is named, recorded, and leaves that source's day open instead of closing it unread.

**Architecture:** the round gains a second launch mode. The isolated mode of phase 2 (no settings file of any kind) cannot see claude.ai connectors at all, so when a connector source is configured the round launches in connector mode: the person's user settings are loaded, which is what makes the connectors appear, and everything else that source brings is neutralised (hooks off, skills off, the built-in tool set pinned, every user allow rule mirrored as a deny). Each connector's state comes from the round's own `init` event, not from a separate listing. Two sources, calendar and meeting notes, follow the phase 2 source interface; their read evidence is mechanical (the exact calls the model made, their inputs, their errors, their pagination), never the model's word. The curate round gives every source its own window, relaunches once without a source that turns out unavailable, and treats best-effort sources as best effort: a source not read keeps its own day open and never turns the round red.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`. Claude Code 2.1.281 on the maintainer's machine. Every test uses the fake `claude` of phase 2 (`test/helpers/fake-claude.mjs`, scenario actions and replayed fixtures). One opt-in test (`BRAIN_KIT_E2E_CONNECTORS=1`, never in CI) runs the real binary against the person's real connectors.

**Spec:** the approved design, private to the maintainer: its "Fontes plugáveis e detecção de falha" section, its `calendar` and `meeting_notes` adapter descriptions, its phase 3 row and criterion ("rodada com conector needs_auth ou disabled simulado: log nomeia a fonte, marca dela parada, exit 0, PR nasce; rodada com conectores ok: três marcas avançam; palavra-chave de privacidade em linha nova falha o propose; seed-rituals preenche a tabela num vault de teste"). The dated lessons are in `docs/incidents.md`, sections "Connectors" and "Privacy". Phase 2's four decisions (top of `docs/superpowers/plans/2026-09-24-phase-2-scheduled-curator.md`) still hold. Measurements taken on 24/09/2026 with Claude Code 2.1.281, while writing this plan, override the design where they differ:

1. **The isolated mode cannot see claude.ai connectors.** With `--setting-sources ''`, with or without `--strict-mcp-config`, the round has zero MCP servers, claude.ai connectors included. Neither `ENABLE_CLAUDEAI_MCP_SERVERS=1` (or `true`) nor `--settings '{"disableClaudeAiConnectors": false}'` brings them back. `claude mcp get "claude.ai Google Calendar"` shows only `Scope: claude.ai config` and its status, no URL and no type, so a claude.ai connector cannot be declared in `--mcp-config` either.
2. **The user setting source brings the connectors and much more.** With `--setting-sources user` the maintainer's round had 54 MCP servers, 21 of them claude.ai connectors, Google Calendar and Google Drive `connected` with 20 tools named `mcp__claude_ai_Google_Calendar__<tool>` and `mcp__claude_ai_Google_Drive__<tool>`; it also ran a user hook (one `hook_started` event) and loaded 10 plugins, 109 skills, 6 agents and every user permission rule.
3. **What neutralises it, measured one by one:** `--settings '{"disableAllHooks": true}'` gives zero hook events with the connectors still connected; `--disable-slash-commands` removes the `Skill` tool and every skill; `--tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch` leaves exactly those built-in tools (the default set also exposes `Task`, `Workflow`, `CronCreate`, `RemoteTrigger`, `SendMessage`, `Artifact` and more, in both setting-source modes) while MCP tools stay available; user allow rules stay active (a user rule allowing `Bash(rtk curl *)` let `rtk curl` run), and mirroring that rule into `--disallowedTools` denied it (deny wins over allow).
4. **Reads can be scoped.** `Read(./**)` plus `Read(//<absolute dir>/**)` denied a read of `/etc/hostname` and allowed the vault and the named directory. Phase 2's round allows a bare `Read`, which can read any file on disk; this phase closes that for every round.
5. **The connector tool schemas** (from the desktop connectors, the same remote servers): `list_events(calendarId, startTime, endTime, eventType[] of DEFAULT|OUT_OF_OFFICE|FOCUS_TIME|WORKING_LOCATION|BIRTHDAY|FROM_GMAIL, fullText, orderBy, pageSize <= 250, pageToken, timeZone)`, `get_event(calendarId, eventId)`, `list_calendars(pageSize, pageToken)`; `search_files(query, pageSize, pageToken, excludeContentSnippets, snippetVerbosity)` whose query language has `title contains '...'` and `modifiedTime > '<RFC 3339>'` with single-quoted strings and `\'` escaping, `read_file_content(fileId, includeComments)`, `get_file_metadata(fileId)`. Write tools also exist on both servers (`create_event`, `update_event`, `delete_event`, `respond_to_event`; `create_file`, `update_file`, `copy_file`, `share_file`, `trash_file`, `download_file_content`) and must never be reachable.

Decisions taken from them, binding for this phase:

- **D1, connector mode.** When at least one connector source is configured and the user rules allow it (D3), the round launches with `--setting-sources user --settings {"disableAllHooks":true} --disable-slash-commands --tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch`, without `--strict-mcp-config`; otherwise it launches in the isolated mode of phase 2, which also gains `--disable-slash-commands` and `--tools`. Rejected: pointing `CLAUDE_CONFIG_DIR` at a directory without the person's settings, because the login lives in `~/.claude/.credentials.json` and a token refresh written through a copy or a link could invalidate the person's own login (the original vault's curation was dead from 19 to 22/09/2026 on a dead login).
- **D2, states from the round's own `init` event.** A connector's state is read from the `init` event of the same invocation that will use it: `connected`, `needs_auth`, `failed`, `pending`, `absent`, `tools_missing` (connected, but the configured tools are not in the session: the fifth trap of 05 to 08/09/2026), `unknown`. A connector disabled for Claude Code cannot be told apart from one never connected: both are `absent`, and the docs say so. No parser of `claude mcp list` is built.
- **D3, user rules mirrored, or connector mode refused.** Every user allow rule the round would inherit is mirrored as a deny, except rules the round's own allow list already holds, read-tool rules (they widen reads; recorded, never mirrored, because a mirrored bare `Read` would deny the round's own reads), and rules inside the vault. A rule that cannot be mirrored without denying the round's own tools (a bare `Bash`, `Edit` or `Write`, or one covering the vault or an ancestor of it) refuses connector mode for that round: connector sources get the state `blocked_by_user_rules`, the round runs isolated with transcripts only, and the rule is named in the log, in `last-run.json` and by `doctor`.
- **D4, relaunch once.** The round launches with every configured connector source; on the `init` event, if any of them is not `connected`, it kills the model's process group before the first turn and launches once more without those sources, their parameters marked unavailable with their state. No second relaunch.
- **D5, a window per source.** Each source reads only its own open days (the days after its own mark, oldest first, at most seven, and transcripts' whole-day cap); the round's window is their union; each source advances only through the days it read. Phase 2 reads every source over the window of the earliest mark, which would make a source that is ahead read covered days again and capture them twice.
- **D6, opt in, and domain neutral.** Connector sources are off until the person names what to read: `sources.calendar.calendars` defaults to `[]`, and meeting notes carry `enabled: false` with a language default for `search_title_contains` that the person confirms against one of their own documents before turning the source on. Other people's calendars are read only with `team_calendars_consent_noted: true`. The privacy policy is written for any profession and any life: from other people's calendars only shared events count, and nothing about anyone's private life is ever content.
- **D7, mechanical evidence.** Calendar: for every calendar the plan lists, a successful `list_events` whose `startTime` and `endTime` cover the source's window, with `eventType` exactly `["DEFAULT"]` (the privacy filter made mechanical), and every advertised next page followed. Meeting notes: a successful `search_files` whose query carries the plan's literal title clause and its `modifiedTime` bound, every next page followed. Document reads are counted and reported, never a condition: the kit cannot know how many documents exist.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync`/`spawn` with an argument array. The prompt reaches `claude` on stdin, never as an argument.
- Every git call removes the caller's git environment through `src/git-env.mjs`.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key. Prompts and skill bodies live in the packs, same files and placeholders in both.
- Files under `src/`, `bin/`, `hooks/`, `skills/`, `agents/` and `templates/` are pure ASCII. The em dash is banned everywhere. Never type a unicode escape into file content.
- No household data anywhere: no company, colleague or customer name, no real e-mail beyond the author's public metadata, no calendar title, document title or file id from real data, no absolute path naming someone's machine. Fixtures derived from real streams are anonymized before they are committed: every id, e-mail, title, name, URL and piece of text replaced by neutral values ("Ana", `ana@example.com`, "Reading group", `evt-0001`, `file-0001`). For a UTC-3 example use `America/Argentina/Buenos_Aires` or write "UTC-3"; never write that city's name with a space (the maintainer's gate refuses it).
- Exit codes are fixed in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not a vault, `3` degraded, `4` required source not read, `69` network or model unavailable, `75` postponed. A best-effort source that is not read never changes the round's exit code.
- **Never read, run against or write to the private reference vault this kit is extracted from, and never run a command from the session's default working directory: always `cd` into the kit repository or a scratch directory first.** Never read the maintainer's `~/.claude/projects`, calendar or Drive in tests. The only real connector calls in this phase are the controller's capture before Task 2 and the opt-in end-to-end run at the end, each only after the maintainer says yes in chat; their raw output stays in the scratch directory and is never committed.
- Never modify the maintainer's own Claude Code configuration (`~/.claude/settings.json`, `~/.claude.json`, credentials). Tests that need user settings point `CLAUDE_CONFIG_DIR` at a scratch directory holding a fake `settings.json`, and never run the real `claude` there.
- Point `BRAIN_KIT_STATE_DIR` or `XDG_STATE_HOME` at a scratch directory in every test and every manual run.
- The maintainer's pre-push gate is active; never bypass it. Commit with the configured identity and never supply one; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

Clause-by-clause mutation is mandatory where a deleted clause could: launch the model with the person's hooks, skills, or built-in tools beyond the pinned set; let a user allow rule survive in connector mode; reach a connector write tool; call a source read when the evidence says otherwise (coverage, event-type filter, pagination, literal query, modification bound); advance a source over a day it did not read or over a day another source read; relaunch more than once, or not at all when a connector is unavailable; or let a privacy keyword on an added line pass `lint`. Everywhere else, ordinary tests plus the two questions. Control at zero failures before any mutation, more than once; verify each mutation changes behaviour; derive the clause list from the code as it stands at the end.

**The two questions:** what single edit makes a round read a connector source it did not read, advance a source over a day it did not read, or run with a power the person's settings gave and the kit did not, while the suite stays green? And what already does so with no edit at all? Prove each with a real run of `brain-kit curate` against a throwaway vault and the fake `claude`, with `CLAUDE_CONFIG_DIR` pointing at a fake user settings directory.

**The recurring shape:** a command that succeeds while saying nothing, read as nothing to do (a connector listed as connected whose tools are not in the session; a meeting-notes search without its accent that returns nothing and no error), and a command that succeeds answering about something other than what we act on (a calendar listing for one hour of a day read as the whole day; a first page read as every page; a user rule that was never mirrored because nobody enumerated it).

## Review Focus

1. **A connector that says connected but whose tools are missing, and one that is absent, needs authentication or failed.** Each gets its state, the round relaunches once without it, the transcripts are still curated, exit 0, and that source's mark does not move. Owner: Task 2 (states) and Task 5 (relaunch).
2. **A user allow rule that would widen the round:** a bare `Bash`, an `Edit` on an ancestor of the vault, `Bash(node:*)`, an MCP write tool, a `Read` of the whole disk. Each is mirrored as a deny, dropped from the round's own forms, recorded as widening reads, or refuses connector mode, and never passes unseen. Owner: Task 2.
3. **A calendar listing that covers only part of the window, omits the event-type filter, reads another calendar, or leaves a next page unread.** The calendar is not read. Owner: Task 3.
4. **A meeting-notes search with the accent stripped, the title paraphrased, or no modification bound.** Meeting notes are not read. Owner: Task 4.
5. **A privacy keyword on an added line, the same keyword on an unchanged line, and one in an exempt path.** Only the first fails `lint` and so `propose`. Owner: Task 6.

## What earlier phases established, which this phase reuses

- `src/harness/claude-code.mjs`: `ISOLATION_ARGS`, `buildArgv({ model, maxTurns, budgetUsd, allowed, disallowed })`, `runModel({ claudeBin, argv, prompt, cwd, env, timeoutMs, onLine, ... })` with the process-group kill; `src/harness/stream.mjs`: `createStreamParser`, `parseStream` returning `{ init, toolUses: [{ id, name, input }], toolResults: [{ toolUseId, isError }], denials, result, hookEvents, hookEventsAfterInit, unknownTypes, invalidLines }`; `src/guards/isolation.mjs`: `checkIsolation(record, { allowMcp })`; `src/guards/cli.mjs`: `checkCli`.
- `src/sources/index.mjs`: the `Source` typedef `{ id, kind: 'local'|'connector', required, readEvidence(record, plan) -> { read, expected, ok }, collect({ window, config, machine, now, home }) -> plan }` and `validateSource`; `src/sources/transcripts-claude-code.mjs`: `transcriptsSource`, plans with `files`, `daysCovered`, `daysDeferred`, `problems`, `misconfigured`, `promptBlock`.
- `src/guards/watermark.mjs`: `windowFor`, `advanceWatermark(stateDir, sourceId, day, { modelExit, evidence, sourcesLine, vacuous, timezone, now })`, `parseSourcesLine`; `src/guards/read-evidence.mjs`: `evidenceFor(sources, plans, record)`, `unreadRequired`.
- `src/curate/tools.mjs`: `KIT_SUBCOMMANDS`, `PROTECTED_PATHS`, `kitCommand()`, `allowedTools(extra)`, `disallowedTools(extra)`; `src/commands/prompt.mjs`: `renderCuratePrompt`, the curate prompt's contract markers.
- `src/commands/curate.mjs`: the fixed order, `SOURCES`, `sourcesOf`, `computeWindow`, `collectPlans`, `narrowWindow`, `renderParameters`, the relaunch-free model run, cleanup, exit mapping, `last-run.json`, notify.
- `src/rules/` and `src/commands/lint.mjs`: the `privacy` rule (confidential notes and links); `lint --base worktree` runs inside `propose`.
- `src/doctor/checks.mjs`, `src/hooks/session-start.mjs` (the status line), `skills/` with the `!` line and `allowed-tools`, `evals/`.
- The configuration already has `sources.calendar` (`provider`, `server_display_name`, `tool_prefix`, `tool_suffixes`, `calendars`, `team_calendars`, `team_calendars_consent_noted`, `skip_events_with_owner`, `dedup_by`, `privacy { exclude_event_types, exclude_keywords, team_personal_events }`, `focus_blocks_as_ruler`) and `sources.meeting_notes` (`provider`, `server_display_name`, `tool_prefix`, `tool_suffixes`, `search_title_contains`, `attached_title_prefix`, `window_hours_before_day`, `dedup_by`, `never_download`), and `curate.sources.best_effort: ["calendar", "meeting_notes"]`.

## Out of scope

- Providers other than the claude.ai Google Calendar and Google Drive connectors (Outlook, Notion, Otter, Fireflies): phase 7, each when a second real case needs it.
- A parser of `claude mcp list` (D2 replaces it) and the `CLAUDE_CONFIG_DIR` isolation (D1 rejects it).
- The briefing and `preflight`: phase 4. The briefing will reuse connector mode as built here.
- Migrating the original vault: phase 5.

## File Structure

| File | Responsibility |
|---|---|
| `src/harness/claude-code.mjs` (modify) | `ROUND_TOOLS`, the pinned tools and slash-command flags in both modes, `buildArgv({ mode })` |
| `src/harness/stream.mjs` (modify) | `hasNextPage` on each tool result |
| `src/guards/isolation.mjs` (modify) | per-mode checks, the built-in tool set check |
| `src/guards/connectors.mjs` (create) | connector states from an `init` event |
| `src/curate/user-rules.mjs` (create) | read the user settings the round inherits; mirror, record or refuse each allow rule |
| `src/curate/tools.mjs` (modify) | scoped reads, connector read tools, connector write denies |
| `src/sources/calendar-google.mjs` (create) | the calendar source |
| `src/sources/meeting-notes-google-drive.mjs` (create) | the meeting-notes source |
| `src/commands/curate.mjs` (modify) | per-source windows, mode choice, relaunch, best-effort semantics, notify on state change |
| `lang/<code>/prompts/curate.md` (modify) | sources line for every source, no-workaround rule, notes and privacy rules |
| `src/rules/privacy-keywords.mjs` (create) and the lint wiring (modify) | privacy keywords on added lines |
| `src/doctor/checks.mjs` (modify) | the `connectors` check and `--probe` |
| `src/hooks/session-start.mjs` (modify) | connector states in the status line |
| `lang/<code>/skills/seed-rituals.md`, `skills/seed-rituals/SKILL.md`, `evals/seed-rituals-<lang>/` (create) | the seed-rituals skill |
| `lang/<code>/config.defaults.json`, `schema/config.schema.json` (modify) | opt-in defaults, suffix lists, privacy keys |
| `docs/connectors.md` (create), `docs/security.md`, `docs/scheduling.md`, `docs/incidents.md`, `README*.md`, `CHANGELOG.md` (modify) | documentation |
| `test/fixtures/stream/connectors-*.jsonl` (create) | anonymized real connector streams |
| `test/e2e-connectors.test.mjs` (create) | the opt-in end-to-end round |

**Order of execution.** Part A of the controller's measurements comes before Task 1, Part B before Task 2. Tasks 1, 6 and 7 touch disjoint files and can run in parallel; Task 2 follows Task 1 (same harness files); Tasks 3 and 4 follow Task 2 and can run in parallel with each other (their shared files are the language packs, the config defaults and the schema, merged key by key); Task 5 follows Tasks 2 to 4; Task 8 comes last.

---

### Before Task 1 (controller): measurements and captures

The controller runs these, records the results in the ledger as facts, and rules on the two outcomes they decide before dispatching the tasks that depend on them.

**Part A, no private data** (scratch vault, trivial prompts, model sonnet, `--max-budget-usd 0.3` each):

- A1. In the isolated mode plus `--disable-slash-commands --tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch`, with `--allowedTools "Read(./**)" "Glob(./**)" "Grep(./**)"`, ask the model to Glob `*` in `/etc` and in the vault, and to Grep a word in `/etc/hostname` and in a vault note. Record which calls are allowed. **Ruling R-A1 for Task 1:** if `Glob(./**)` and `Grep(./**)` deny the calls outside the vault and allow the ones inside, the round allows those scoped forms; otherwise `Glob` and `Grep` leave `ROUND_TOOLS` and the allow list, and the round navigates by `Read` alone.
- A2. With `Read(//<scratch>/dir com espaço/á.jsonl)` in the allow list, ask the model to Read that file and a sibling file. Record whether a rule for an exact file path containing a space and an accent works. **Ruling R-A2 for Task 1:** if it works, the round allows reading exactly the transcript files the plan lists (`Read(//<file>)` per file); otherwise it allows each listed file's project directory (`Read(//<dir>/**)`).
- A3. Launch the connector mode with a trivial prompt and kill the process group as soon as the `init` event arrives. Record the time to `init`, and whether any `assistant` or `result` event appeared (none means no model call was made). This is the cost of D4's relaunch and of `doctor --probe`.

**Part B, the maintainer's own data, only after he says yes in chat** (connector mode, model sonnet, `--max-turns 6`, `--max-budget-usd 0.5`, output to the scratch directory only): one prompt asking the model to call `list_events` on `primary` for one past day with explicit `startTime`, `endTime`, `eventType: ["DEFAULT"]` and `pageSize: 2`, follow one `nextPageToken` if there is one, call `get_event` on the first event that has attachments (or on the first event), then `search_files` with `title contains '<the pt-BR default literal>' and modifiedTime > '<that day>T00:00:00Z'`, `pageSize: 1`, `excludeContentSnippets: true`. Record, without copying any content into the ledger: the tool names, the input shapes, whether and how `nextPageToken` appears in a result's text, the field names of an event's attachments, and the connector status strings seen in `init` (for every server, statuses only). The raw file stays in scratch for Task 2 to derive anonymized fixtures from.

### Task 1: every round gets the exact tools, no skills, and scoped reads

**Files:**
- Modify: `src/harness/claude-code.mjs`, `src/guards/isolation.mjs`, `src/curate/tools.mjs`, `src/commands/curate.mjs` (pass the read roots), `src/doctor/checks.mjs` (the isolation-flags check knows the new flags), both `messages.json`
- Test: `test/harness.test.mjs`, `test/curate.test.mjs`, `test/prompt-curate.test.mjs` (the allow list pin), `test/doctor.test.mjs`, `test/incidents/2026-09-24-unscoped-round.test.mjs` (create)

**Interfaces:**
- Produces: `ROUND_TOOLS` exported from `src/harness/claude-code.mjs`: `['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'ToolSearch']`, or without `Glob` and `Grep` under ruling R-A1. `ISOLATION_ARGS` becomes `['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', ROUND_TOOLS.join(','), '--no-session-persistence']`.
- Produces: `checkIsolation(record, { allowMcp })` adds the problem `builtin_tools` when the `init` event's built-in tools (names not starting with `mcp__`) are not exactly `ROUND_TOOLS` as a set (an extra tool or a missing one), with the difference in the detail.
- Produces: `allowedTools(extra = [], { readFiles = [], readDirs = [] } = {})` in `src/curate/tools.mjs`: the base becomes `['Read(./**)', 'Edit(./**)', 'Write(./**)', 'ToolSearch']`, plus `Glob(./**)` and `Grep(./**)` under ruling R-A1, plus `Read(//<path without its leading slash>)` for each absolute path in `readFiles` and `Read(//<dir without its leading slash>/**)` for each in `readDirs`, then the kit rules, then `extra`. A path that is not absolute throws.
- `curate` passes the kept transcript files (ruling R-A2) or their project directories as the read roots.

- [ ] **Step 1:** tests: `buildArgv` carries `--disable-slash-commands` and `--tools` with the exact list; `checkIsolation` flags `builtin_tools` for an `init` with `Task` added and for one with `Read` missing (rewrite the phase 2 fixtures), and passes the pinned set; `allowedTools` renders the scoped reads for a path with a space and an accent and throws on a relative path; the curate round's argv (captured by the fake) allows reading only the plan's transcripts and the vault; doctor's isolation-flags check requires the new flags (`--max-turns` stays exempt). Incident test `2026-09-24-unscoped-round`: the phase 2 allow list (bare `Read`, default tools) is refused by the new checks.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation over the new argv elements, the `builtin_tools` clause and the scoped read rules.
- [ ] **Step 4:** commit `feat: every round gets the exact built-in tools, no skills, and reads scoped to the vault and its transcripts`.

### Task 2: connector mode in the harness

**Files:**
- Modify: `src/harness/claude-code.mjs`, `src/harness/stream.mjs`, `src/guards/isolation.mjs`, both `messages.json`
- Create: `src/guards/connectors.mjs`, `src/curate/user-rules.mjs`, `test/connectors.test.mjs`, `test/user-rules.test.mjs`, `test/fixtures/stream/connectors-connected.jsonl`, `test/fixtures/stream/connectors-states.jsonl`, `test/incidents/2026-09-05-connected-without-tools.test.mjs`, `test/incidents/2026-09-24-user-rules-in-connector-mode.test.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: `CONNECTOR_ARGS`: `['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--tools', ROUND_TOOLS.join(','), '--no-session-persistence']`, and `buildArgv({ mode = 'isolated', model, maxTurns, budgetUsd, allowed, disallowed })` with `mode` `'isolated'` or `'connectors'` (anything else throws).
- Produces: `checkIsolation(record, { mode = 'isolated', allowMcp = [] })`: in both modes `permission_mode`, `hooks` and `builtin_tools`; the `mcp` problem only in `'isolated'`.
- Produces: in `src/harness/stream.mjs`, every entry of `toolResults` gains `hasNextPage: boolean`, true when the result's text content carries a non-empty next-page token in the form Part B recorded (the default pattern, until Part B says otherwise: `/"nextPageToken"\s*:\s*"[^"\s]+"/` or `/nextPageToken:\s*\S+/`). The text itself is never stored.
- Produces: `CONNECTOR_STATES = ['connected', 'needs_auth', 'failed', 'pending', 'absent', 'tools_missing', 'unknown']` and `connectorStates(init, specs)` in `src/guards/connectors.mjs`, `specs` being `[{ id, serverDisplayName, toolPrefix, toolSuffixes }]`, returning `{ [id]: { state, rawStatus, observedPrefix } }`:

```js
export function connectorStates(init, specs) {
  const servers = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  const tools = Array.isArray(init?.tools) ? init.tools : [];
  const out = {};
  for (const spec of specs) {
    const server = servers.find((s) => s && s.name === spec.serverDisplayName);
    if (!server) { out[spec.id] = { state: 'absent', rawStatus: null, observedPrefix: null }; continue; }
    const raw = typeof server.status === 'string' ? server.status : null;
    const mapped = { connected: 'connected', 'needs-auth': 'needs_auth', failed: 'failed', pending: 'pending' }[raw] ?? 'unknown';
    if (mapped !== 'connected') { out[spec.id] = { state: mapped, rawStatus: raw, observedPrefix: null }; continue; }
    const missing = spec.toolSuffixes.filter((suffix) => !tools.includes(spec.toolPrefix + suffix));
    if (missing.length === 0) { out[spec.id] = { state: 'connected', rawStatus: raw, observedPrefix: spec.toolPrefix }; continue; }
    const seen = tools.find((name) => spec.toolSuffixes.some((suffix) => name.endsWith(`__${suffix}`)));
    const observedPrefix = seen ? seen.slice(0, seen.lastIndexOf('__') + 2) : null;
    out[spec.id] = { state: 'tools_missing', rawStatus: raw, observedPrefix };
  }
  return out;
}
```

  (The status strings `connected`, `needs-auth`, `failed` were seen on 24/09/2026; `pending` is mapped in advance; Part B may add others, which stay `unknown` until mapped.)
- Produces: in `src/curate/user-rules.mjs`, `userSettingsFiles(env)` returning the existing files among `<dir>/settings.json` and `<dir>/settings.local.json`, `<dir>` being `env.CLAUDE_CONFIG_DIR` when set, else `~/.claude`; and `mirrorUserRules({ files, ownAllowed, vaultRoot, home, kit })` returning `{ deny: string[], widenedReads: string[], blocking: [{ rule, file, reason }], dropNodeForms: boolean }`. A file that cannot be read or parsed, or whose `permissions.allow` is not an array of strings, is one `blocking` entry with reason `unreadable` (connector mode fails closed). Each rule `R` of `permissions.allow`, parsed as `Tool` or `Tool(spec)`:
  1. `R` is exactly in `ownAllowed`: skipped.
  2. `Tool` is `Read`, `Glob`, `Grep` or `LS`: never mirrored; added to `widenedReads` unless its resolved path is inside the vault.
  3. `Tool` is `Edit`, `Write`, `NotebookEdit` or `MultiEdit`: no spec, or a spec whose literal prefix (up to the first `*`, `?`, `[` or `{`) resolves to a directory that is the vault or an ancestor of it: `blocking`, reason `covers_vault`; resolved inside the vault: skipped (the round's own `Edit(./**)` and protected-path denies already govern it); otherwise mirrored. Path resolution for a rule in user settings: `//x` is `/x`, `~/x` is `<home>/x`, `/x` is `<settings file dir>/x`, `./x` and `x` are `<vaultRoot>/x` (the round's working directory).
  4. `Tool` is `Bash`: no spec, or a spec that is `*` or `:*`, or whose literal prefix (up to the first `*`, `:*` or glob character, trimmed) is a prefix of `kit` (the round's quoted kit command): `blocking`, reason `covers_kit`; a literal prefix of `node`: mirrored, and `dropNodeForms: true` (the round then drops its own `node <kit>` allow forms, keeping the direct ones); otherwise mirrored.
  5. Anything else (`WebFetch`, `WebSearch`, `mcp__...`, `Task`, and the rest): mirrored.
- Fixtures: `connectors-connected.jsonl` and `connectors-states.jsonl` derived from Part B's raw capture by the rules of the Global Constraints: event order, types, subtypes, the `init` event's server list reduced to five neutral servers (one per observed status plus the two Google connectors), tool names kept only for the two Google connectors, tool inputs rewritten to neutral ids and a past day in 2026, tool result texts replaced by neutral JSON of the same shape (keep the `nextPageToken` form exactly as observed), no real e-mail, title, name, id or URL. A test fails if a fixture contains `/home/` other than `/home/ana/`, `/tmp/claude-`, `-home-`, `@` other than `@example.com`, or `https://` other than `https://example.com`.

- [ ] **Step 1:** tests for `buildArgv` in both modes (exact vectors), `checkIsolation` per mode, `hasNextPage` on the fixtures (a result with a token, one without, one with an empty token), `connectorStates` for each of the seven states from rewritten `init` events, and `mirrorUserRules` for every branch above with fake settings files in a scratch `CLAUDE_CONFIG_DIR` (including an unreadable file, a `settings.local.json`, `Bash(rtk curl *)`, `Bash(node:*)`, `Bash`, `Bash(*)`, a rule prefixing the kit, `Edit(~/**)` with the vault under home, `Edit(//tmp/other/**)`, `Edit(./notes/**)`, `Read`, `Read(//etc/**)`, `mcp__claude_ai_Gmail__send_email`, `WebFetch`). Incident tests: `2026-09-05-connected-without-tools` (the connector is `connected` in `init` but its tools are absent: `tools_missing`, with the observed prefix when the tools exist under another prefix); `2026-09-24-user-rules-in-connector-mode` (the measured case: a user allow rule for a rewritten command is mirrored as a deny).
- [ ] **Step 2:** run, see them fail; derive the fixtures; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over every branch of `mirrorUserRules`, every mapping of `connectorStates`, the per-mode isolation clauses and `CONNECTOR_ARGS`.
- [ ] **Step 4:** commit `feat: connector mode loads the claude.ai connectors and neutralises the person's hooks, skills, tools and allow rules`.

### Task 3: the calendar source

**Files:**
- Create: `src/sources/calendar-google.mjs`, `test/sources-calendar.test.mjs`, `test/incidents/2026-08-11-other-calendars-consent.test.mjs`, `test/incidents/2026-08-20-calendar-partial-read.test.mjs`
- Modify: `src/sources/index.mjs` (the optional fields below in the typedef and `validateSource`), `lang/en/config.defaults.json`, `lang/pt-BR/config.defaults.json`, `schema/config.schema.json`, both `messages.json`, the init and config tests that pin the old defaults

**Interfaces:**
- Consumes: Task 2's record fields (`toolUses[].input`, `toolResults[].isError`, `toolResults[].hasNextPage`).
- Produces: the optional source fields, used by Tasks 4 and 5: `emptyMeansNothingListed` (boolean, default `true`: the phase 2 rule for `empty`), `isConfigured(config) -> boolean`, `serverSpec(config) -> { id, serverDisplayName, toolPrefix, toolSuffixes }` (connector sources only), `toolRules(config) -> { allow: string[], deny: string[] }` (connector sources only).
- Produces: `calendarSource = { id: 'calendar', kind: 'connector', required: false, emptyMeansNothingListed: false, isConfigured, serverSpec, toolRules, collect, readEvidence }`.
- Config defaults, both packs: `sources.calendar.calendars: []`, `sources.calendar.tool_suffixes: ["list_events", "get_event", "list_calendars"]`; the rest unchanged. `isConfigured(config)`: `calendars` is a non-empty array of non-empty strings none of which starts with `<`.
- `collect({ window, config, now })` returns `{ configured, calendars, otherCalendars, window: { from, to, timezone }, problems, promptBlock }`: `calendars` are `sources.calendar.calendars`; `otherCalendars` are `team_calendars` only when `team_calendars_consent_noted === true`, otherwise `[]` with the problem `other_calendars_without_consent` naming how many were ignored. The prompt block, in the vault's language, gives for each calendar id the exact inputs to pass: `calendarId` (the id as written; `primary` for the owner's main calendar), `startTime` and `endTime` (the window's instants in ISO 8601 UTC), `eventType: ["DEFAULT"]`, `pageSize: 250`, `timeZone` (the vault's), and says to follow every `nextPageToken` with `pageToken`; to deduplicate by event id; to skip, in other people's calendars, events that already include the owner; and the privacy policy: from other people's calendars only events with at least two attendees count, and nothing about anyone's private life (health, absence, family, personal errands) is ever written, not even as a mention. It also says that attachments of the events are the second door for meeting notes, read in the meeting-notes block.
- `readEvidence(record, plan)`: for each id in `[...plan.calendars, ...plan.otherCalendars]`, the calendar is read when the record has a chain of `list_events` calls (tool name `toolPrefix + 'list_events'`) for it, each with a result that is not an error, where the first call has no `pageToken`, `startTime` at or before `plan.window.from`, `endTime` at or after `plan.window.to`, and `eventType` deep-equal to `["DEFAULT"]`, and every call whose result has `hasNextPage` is followed by a call with the same `calendarId`, `startTime`, `endTime` and a non-empty `pageToken`. `calendarId` `primary` also matches a call with no `calendarId`. `read` is the number of calendars read, `expected` their count, `ok` when every one is read.
- `toolRules(config)`: allow `toolPrefix + s` for each of the configured suffixes; deny `toolPrefix + s` for `create_event`, `update_event`, `delete_event`, `respond_to_event`.

- [ ] **Step 1:** tests: `isConfigured` (empty list, placeholder, real id); `collect` with and without consent; the prompt block in both languages carries the exact instants and filters; `readEvidence` for a full read, a window starting an hour late, an end an hour early, no `eventType`, `eventType` with `OUT_OF_OFFICE` added, a different `calendarId`, an errored result, an unfollowed next page, a followed next page, `primary` with no `calendarId`, two calendars with one read; `toolRules` lists; defaults and schema. Incident tests: `2026-08-11-other-calendars-consent` (other calendars without consent are ignored and said); `2026-08-20-calendar-partial-read` (a listing that covers part of the window does not read the calendar).
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over every clause of `readEvidence` and the consent gate.
- [ ] **Step 4:** commit `feat: the calendar source, read only when every calendar's listing covers the window with the private-event filter and every page`.

### Task 4: the meeting-notes source

**Files:**
- Create: `src/sources/meeting-notes-google-drive.mjs`, `test/sources-meeting-notes.test.mjs`, `test/incidents/2026-08-11-meeting-notes-two-doors.test.mjs`, `test/incidents/undated-accent-sensitive-search.test.mjs`
- Modify: `lang/en/config.defaults.json`, `lang/pt-BR/config.defaults.json`, `schema/config.schema.json`, both `messages.json`

**Interfaces:**
- Consumes: Task 2's record fields; Task 3's optional source fields.
- Produces: `meetingNotesSource = { id: 'meeting_notes', kind: 'connector', required: false, emptyMeansNothingListed: false, isConfigured, serverSpec, toolRules, collect, readEvidence }`.
- Config defaults: `sources.meeting_notes.search_title_contains` is `"Notes by Gemini"` in the `en` pack and `"Anotações do Gemini"` in the `pt-BR` pack (the title the meeting service gives its automatic notes; the docs tell the person to copy it literally from one of their own documents, accents included); `attached_title_prefix: ""` (any document attached to an event); `tool_suffixes: ["search_files", "read_file_content", "get_file_metadata"]`; a new key `enabled`, default `false` in both packs (D6: the pack's literal is only a suggestion, and nothing is read until the person turns the source on). `isConfigured(config)`: `enabled === true` and `search_title_contains` is a non-empty string.
- `collect({ window, config, now })` returns `{ configured, literal, since, query, problems, promptBlock }`: `since` is `window.from` minus `window_hours_before_day` hours, as RFC 3339 UTC; `query` is exactly `title contains '<literal with each ' written as \'>' and modifiedTime > '<since>'`. The prompt block, in the vault's language, gives the exact query to pass to `search_files` (and says to follow every `nextPageToken`), then the second door (documents attached to the window's calendar events, when the calendar source is read, whose titles start with `attached_title_prefix`), and the rules from the incidents: a meeting note is a first-class source, every note in the window is distilled into the log under its literal title in straight quotes, and a title already in the log is not distilled again; read the whole document, not only its summary, and every tab; a document that does not open for permission reasons is written as "no access (document store permission)", never as empty; a speaker-attribution error is a divergence to confirm, never a fact; recordings and full transcriptions are never downloaded.
- `readEvidence(record, plan)`: read when the record has a chain of `search_files` calls whose first call has no `pageToken` and a `query` containing both the exact title clause (`title contains '<escaped literal>'`) and the exact `modifiedTime > '<since>'` clause, each with a result that is not an error, every call whose result has `hasNextPage` followed by one with the same `query` and a non-empty `pageToken`. `expected` is 1, `read` 1 or 0. The plan also reports `documents: { read, failed }`, the counts of `read_file_content` results without and with error, for `last-run.json`.
- `toolRules(config)`: allow `toolPrefix + s` for the configured suffixes; deny `toolPrefix + s` for `create_file`, `update_file`, `copy_file`, `share_file`, `trash_file`, `download_file_content`.

- [ ] **Step 1:** tests: the query escapes a single quote in the literal; the `since` bound; `readEvidence` for the exact query, the literal without its accent, a paraphrased title, a missing `modifiedTime`, a later `since`, an errored result, an unfollowed next page, extra clauses added by the model (still read, since both clauses are present); the documents counts; `toolRules`; defaults in both packs. Incident tests: `2026-08-11-meeting-notes-two-doors` (the prompt block names both doors) and `undated-accent-sensitive-search` (a search without the accent is not a read).
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over every clause of `readEvidence` and the query builder.
- [ ] **Step 4:** commit `feat: the meeting-notes source, read only through its literal search and every page`.

### Task 5: the round reads connectors

**Files:**
- Modify: `src/commands/curate.mjs`, `src/guards/watermark.mjs` (the `empty` rule per source), `src/guards/read-evidence.mjs` (pass the source to the advance rule if needed), `lang/en/prompts/curate.md`, `lang/pt-BR/prompts/curate.md`, `src/hooks/session-start.mjs`, both `messages.json`
- Test: `test/curate.test.mjs`, `test/prompt-curate.test.mjs`, `test/hook-session-start.test.mjs`, `test/incidents/2026-09-14-connector-disabled.test.mjs` (create), `test/incidents/undated-wrong-allowlist-workarounds.test.mjs` (create)

**Interfaces:**
- Consumes: everything above.
- `SOURCES` becomes `{ transcripts, calendar, meeting_notes }`. `sourcesOf(config)` keeps a listed source only when `isConfigured` (absent means configured); a listed source that is not configured is reported in `last-run.json` under `notConfigured`, with no warning and no notification.
- Per-source windows (D5): `computeWindow` returns, besides the union window, `days[source.id]`: the round's days after that source's own mark (an unset mark: yesterday only); `collectPlans` gives each source a window from the start of its first day to the round's end; a source with no day in the round is not collected, not offered and not advanced; `narrowWindow` still bounds the round's end by transcripts' whole-day cap; each source advances only through its own last day in the narrowed window.
- Mode choice (D1, D3): when at least one active source is a connector, the round reads the user settings (`userSettingsFiles`, `mirrorUserRules`); with no `blocking` entry it launches in connector mode with the allow list `allowedTools(...)` plus every available connector source's `toolRules().allow` (and without the `node <kit>` forms when `dropNodeForms`), and the deny list `disallowedTools(...)` plus `mirror.deny` plus every connector source's `toolRules().deny`; with a `blocking` entry, every connector source gets the state `blocked_by_user_rules` and the round launches isolated, transcripts only.
- Relaunch (D4): in connector mode, on the `init` event, `connectorStates(init, specs)` for the active connector sources; if every one is `connected`, the run continues; otherwise the harness kills the model's process group before the first turn, and the round launches once more with those sources removed (their tools out of the allow list, their parameters replaced by one line saying the source is unavailable this round and its state, and to write it `unavailable` in the sources line without trying any other way to reach it), in isolated mode when no connector source remains. The isolation check runs on the `init` of each launch with its own mode.
- The sources line lists every source the round offered: `BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed> calendar=<ok|empty|failed|unavailable> meeting_notes=<ok|empty|failed|unavailable>`. The advance rule: `ok` advances; `empty` advances when the source's `emptyMeansNothingListed` is false, or when it is true and `evidence.expected === 0`; anything else does not. A best-effort source that does not advance does not change the exit code.
- Notify: as in phase 2 for non-zero exits, and once when a best-effort source's state differs from its state in the previous `last-run.json` (for example `connected` to `needs_auth`), naming the source, the state and `docs/connectors.md`; never again while the state stays the same.
- `last-run.json` gains `mode` (`isolated` or `connectors`), `relaunched` (boolean), `notConfigured`, `userRules: { mirrored, widenedReads, blocking }` and, per source, `state`, `observedPrefix` and, for meeting notes, `documents`. `curate --dry` and `--check` print the mode, the mirror's counts and any blocking rule.
- The curate prompt, both languages: the sources line names every source the parameters block offers; a new contract rule `no-workaround` (a source marked unavailable, or a tool that is not there, is written `unavailable` or `failed` in the sources line and never reached another way, not through the shell and not through any other tool); new contract rules `notes-first-class` and `no-access-label` (from the incidents above); the privacy rule for other people's calendars under `third-party-privacy`. The contract test pins the four new markers in both languages.
- SessionStart: the status line adds, from the vault's `last-run.json`, each configured connector source whose last state is not `connected`, with its state and the round's date in DD/MM/YYYY.

- [ ] **Step 1:** tests with the fake claude, a throwaway vault and a fake `CLAUDE_CONFIG_DIR`: a round with the three sources configured and a scenario whose stream satisfies all three evidences: three marks advance (the phase 3 criterion); a scenario whose `init` shows the calendar `needs-auth`: the fake is killed at `init`, the round relaunches once without the calendar, the transcripts are curated and proposed, exit 0, the calendar mark stays, `last-run.json` names the state, notify runs once and not on the next identical round (the phase 3 criterion); the same with the calendar absent (disabled) and with its tools missing; a user settings file with a bare `Bash` allow: connector mode refused, `blocked_by_user_rules`, transcripts only, exit 0; `Bash(rtk curl *)` in the user settings: the argv carries its mirror; per-source windows: a calendar mark two days behind the transcripts mark reads only its own days and neither source re-reads the other's; a source listed but not configured is silent; `empty` for the calendar with the listing made advances, for transcripts with files kept does not. Incident tests: `2026-09-14-connector-disabled` and `undated-wrong-allowlist-workarounds` (the relaunched prompt names the unavailable source and forbids workarounds; its tools are out of the allow list).
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory: the mode choice, the relaunch trigger and its single-relaunch bound, the per-source day sets, the advance rule per source, the state-change notification.
- [ ] **Step 4:** the two questions, answered with real runs of `curate` against the fake.
- [ ] **Step 5:** commit `feat: curate reads calendar and meeting notes in connector mode, one window per source, relaunching once without what is unavailable`.

### Task 6: privacy keywords on added lines

**Files:**
- Create: `src/rules/privacy-keywords.mjs`, `test/rules-privacy-keywords.test.mjs`, `test/incidents/undated-colleague-health-in-calendar.test.mjs`
- Modify: the lint wiring that runs the `privacy` rule (`src/commands/lint.mjs` and the rule registry under `src/rules/`), `lang/en/config.defaults.json`, `lang/pt-BR/config.defaults.json`, `schema/config.schema.json`, both `messages.json`, `test/propose.test.mjs`

**Interfaces:**
- Config: `privacy.third_party_keywords`, default in the `en` pack `["medical appointment", "doctor's appointment", "sick leave", "teleconsultation", "therapy session", "medical exam", "hospital stay", "pregnancy"]` and in the `pt-BR` pack `["consulta médica", "atestado médico", "licença médica", "teleconsulta", "sessão de terapia", "exame médico", "internação", "gravidez"]`; `privacy.keyword_exempt_paths`, default `[]`.
- The `privacy` rule gains a finding for each line added under the run's `--base` (the lines the `style` rule already reads) in a markdown file outside `keyword_exempt_paths`, holding a keyword: matched case-insensitively as a whole phrase (bounded by characters that are not Unicode letters or digits), accents significant. The finding names the file, the line number and the keyword, with the severity `lint.privacy`. Unchanged lines never produce this finding.

- [ ] **Step 1:** tests: a keyword on an added line fails; the same on an unchanged line passes; inside a longer word passes; a different case fails; an accent-stripped form does not match; an exempt path passes; both packs' defaults; `propose --only` with a note whose added line holds a keyword refuses and publishes nothing (the phase 3 criterion). Incident test `undated-colleague-health-in-calendar`.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over the added-line restriction, the phrase boundary and the exempt paths.
- [ ] **Step 4:** commit `feat: lint refuses a privacy keyword on a line a change adds`.

### Task 7: the seed-rituals skill

**Files:**
- Create: `lang/pt-BR/skills/seed-rituals.md`, `lang/en/skills/seed-rituals.md`, `skills/seed-rituals/SKILL.md`, `evals/seed-rituals-pt-BR/`, `evals/seed-rituals-en/`
- Modify: `src/commands/prompt.mjs` (`SKILL_NAMES`), `test/plugin.test.mjs`, `test/prompt.test.mjs`

**SKILL.md**, the same shape as the other skills, with `allowed-tools` granting exactly its own `!` command, and this description, verbatim: `Use when the person wants the brain-kit vault's weekly rhythm table filled from their calendar: read the last four weeks, find recurring events, and propose the rows.`

**Body requirements**, both languages, under 120 lines, placeholders only from the existing list, `{{kit}}` for every engine call:
- This runs in the person's own session, with the calendar connector of that session; if its tools are not there, say so and stop (never work around it).
- Read the last four weeks of the owner's calendars as configured (`sources.calendar.calendars`, `primary` when empty): `list_events` with explicit `startTime`, `endTime`, `eventType: ["DEFAULT"]`, `pageSize: 250`, following every `nextPageToken`.
- A ritual is an event that recurs (a recurring event id, or the same title at least three times in the four weeks); never an event from someone else's calendar without the recorded consent, never a private event.
- For each ritual, one row in the table of `taxonomy.files.rituals`, with the columns the table itself declares in its header row: the calendar title literal, in straight quotes, with any `|` written as `\|` (the deduplication key of the incident on escaped titles); cadence; time; owner (the organiser); fixed attendees (how many, and names only when the person agrees); feeds (ask the person which note each ritual feeds; "none yet" when none).
- Show every row before writing, ask for confirmation, write only the confirmed rows, never duplicate a title already in the table (compare the escaped literal), then `{{kit}} validate`, `{{kit}} lint`, and `{{kit}} propose "<summary>" --only <the rituals file>`.

**Evals:** one case per language, the same frontmatter as the other cases (`allowed_tools` with `"Bash(node:*)"`), a request that does not name the skill (for example, pt-BR: "preenche a tabela de rituais a partir da minha agenda"), graders `skill.md` (`tool_used: Skill`) and `criteria.md` (the response picks the skill and states the steps: four weeks, recurring events, literal escaped titles, confirmation before writing, propose with `--only`).

- [ ] **Step 1:** tests: `SKILL_NAMES` has eight names; the SKILL.md shape and description; `prompt --check` passes; both bodies render with every placeholder resolved; the evals' shape; the body mentions the escaped literal title rule and the confirmation step (a test like the setup body's).
- [ ] **Step 2:** run, see them fail; write the bodies, SKILL.md and evals; whole suite; `claude plugin validate --strict .`.
- [ ] **Step 3:** commit `feat: the seed-rituals skill fills the weekly rhythm table from the calendar`.

### Task 8: doctor, docs and the opt-in connector round

**Files:**
- Modify: `src/doctor/checks.mjs`, `test/doctor.test.mjs`, both `messages.json`, `docs/security.md`, `docs/scheduling.md`, `docs/incidents.md`, `README.md`, `README.pt-BR.md`, `CHANGELOG.md`
- Create: `docs/connectors.md`, `test/e2e-connectors.test.mjs`

**Doctor:** a `connectors` check that reports, for each configured connector source: the last state from `last-run.json` and the round's date (DD/MM/YYYY), the observed tool prefix against the configured one (a mismatch names both and the setting), other calendars listed without recorded consent, and any user allow rule that blocks connector mode (naming the rule and its file). `doctor --probe` launches the connector mode with a trivial prompt, kills it at the `init` event (Part A3 measured the cost) and reports each configured connector's state from that `init`, without a round. A state other than `connected` is a warning, never a failure (the sources are best effort), unless the source is in `curate.sources.required`.

**Docs:** `docs/connectors.md`: what the two connector sources read and how to turn each on (`sources.calendar.calendars`, the literal meeting-notes title copied from one of the person's own documents with its accents); why connector mode loads the user settings and what it switches off (hooks, skills, built-in tools beyond the pinned set, every user allow rule mirrored as a deny) and what it cannot (the person's MCP server processes start, and a user rule allowing reads widens what the model can read); the seven states and what to do for each, including that a connector disabled for Claude Code shows as `absent`; the tool names in the CLI (`mcp__claude_ai_<Server>__<tool>`) against the desktop application's; the privacy policy and the recorded consent for other people's calendars; best-effort semantics, the state-change notification and `doctor --probe`. `docs/security.md`: the connector mode section with the measurements of this plan's Spec. `docs/scheduling.md`: one window per source, the sources line with three sources. `docs/incidents.md`: every "Where it lives" of the Connectors and Privacy sections points at the files this phase built. README (both) and CHANGELOG: a phase 3 section; the status table says "in review" (the controller sets "done" after the end-to-end run).

**End-to-end test** (`BRAIN_KIT_E2E_CONNECTORS=1` only, skipped otherwise, never in CI): in scratch, `init --yes` a vault with a bare remote and a fake `gh`; `sources.calendar.calendars` set to `BRAIN_KIT_E2E_CALENDAR` (default `primary`) and meeting notes on (`enabled: true`) with the pack's literal; the transcripts tree empty but configured; the real `claude` and the person's real connectors (HOME stays the person's, because the login and the connectors live there; `CLAUDE_CONFIG_DIR` untouched); `--max-budget-usd 1.5`, model sonnet. Asserts: exit 0; the mode was `connectors` (or the states say why not); for each connector source, either its evidence was read and its mark advanced, or its state is recorded and its mark did not move; no write tool of either connector was called (the record's tool names); a pull request was opened against the default branch, or `last-run.json` says nothing was proposed. It prints the cost, the states and the log path.

- [ ] **Step 1:** doctor tests with fixtures for each report and the probe (a fake `claude` that emits an `init` and waits to be killed); implement; whole suite.
- [ ] **Step 2:** write the docs; README and CHANGELOG.
- [ ] **Step 3:** write the end-to-end test (skipped by default); commit `feat: doctor reports connector states; connectors guide; opt-in connector round`.

## After the last task (controller)

- Final whole-phase review on the most capable model; one fix dispatch; adjudicate residuals.
- With the maintainer's yes in chat: run `BRAIN_KIT_E2E_CONNECTORS=1 node --test test/e2e-connectors.test.mjs` once (cost recorded, result in the ledger), and run the seed-rituals skill once in a throwaway vault in the maintainer's own session to check it fills the table (the phase 3 criterion); both outputs stay in scratch.
- README status to "done", push, report phase 3 complete with what the runs showed.
