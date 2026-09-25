# Phase 4: the morning briefing, configurable by the person

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every working morning the person gets, in a session of their own, a briefing built from their vault in the blocks they chose, with the facts computed by the kit and the judgement left to the model, up to the questions they want asked; their answers, and what the briefing captures, become one pull request.

**Architecture:** three layers. (1) `brain-kit preflight` computes every fact deterministically (dates, the curator's last round and each source's state, pending items by deadline, stale notes, pull requests awaiting merge, git and lock state, the question queue), so the model never does arithmetic. (2) `brain-kit questions` keeps the queue of open questions in the state directory, with deduplication, escalation and ageing. (3) `brain-kit prompt briefing` renders a domain-neutral prompt from the vault's own `briefing.blocks`: fact blocks filled from the preflight, judgement blocks with their instructions, and blocks the person defines. The `briefing` skill prints that prompt through its `!` line; a desktop scheduled task, registered by the `setup` skill, runs the skill on the person's schedule. The briefing writes only by `propose --only`.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`. Claude Code 2.1.281 and the Claude desktop application's scheduled tasks (the `create_scheduled_task` tool: a task is `~/.claude/scheduled-tasks/<taskId>/SKILL.md`, a cron in the machine's local time, runs while the app is open and on the next launch when it was closed; every run starts a fresh session). One opt-in test (`BRAIN_KIT_E2E_BRIEFING=1`, never in CI) runs the real skill against a throwaway vault.

**Spec:** the approved design, private to the maintainer: its `preflight` command row, its `briefing` skill description, its phase 4 row and criterion ("briefing pelo plugin produz os blocos, grava perguntas, escala as antigas, abre um único PR com `--only`; assinatura do briefing filtrada pelo varredor (teste)"). Decisions taken with the maintainer on 25/09/2026 override the design where they differ:

1. **B1, configurable, not opinionated.** The briefing's content is the vault's `briefing.blocks`: an ordered list of blocks chosen from the kit's catalog, plus blocks the person defines (a title, the notes to read, an instruction in their own words). The kit ships a neutral default list. A prompt overlay (`briefing.prompt`, default `.brain-kit/prompts/briefing.md`) still replaces the whole prompt for whoever wants to.
2. **B2, what stays out of configuration** (the kit's guarantees, not taste): nothing in `briefing.never_read` is ever read; the vault changes only by pull request; the closed uncertainty vocabulary (not verified, not found, don't know); no attestation of a document not opened in this session.
3. **B3, written from scratch, domain neutral** (phase 2's decision 1 applies): nothing is read from the original vault's briefing; it becomes an overlay inside that vault in phase 5.
4. **B4, no limits the person did not set** (the maintainer's instruction of 25/09/2026): `briefing.max_words`, `briefing.max_questions` and `briefing.write_caps` default to `null`, meaning no limit; a number set by the person is honoured and announced in the briefing when it bites.
5. **B5, text always, a pull request only when there is something to record.** The briefing is a message in the session; the person's answers and the briefing's own captures become one pull request with `propose --only`; no answers and no captures, no pull request.
6. **B6, the briefing's own sessions never reach the curator.** The scheduled task's prompt starts with `briefing.signature`, and the transcripts source's self-trace filter always includes it (not only when the person lists it in `curate.extra_signatures`): what the briefing records it proposes itself.

Phase 3 is on `main` at `825350f`.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync`/`spawn` with an argument array.
- Every git call removes the caller's git environment through `src/git-env.mjs`.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key. Prompts and skill bodies live in the packs, same files and placeholders in both.
- Files under `src/`, `bin/`, `hooks/`, `skills/`, `agents/` and `templates/` are pure ASCII. The em dash is banned everywhere. Never type a unicode escape into file content.
- No household data anywhere. Example data uses "Ana", `example.com` / `example.invalid`, `human:ana`, `brain-kit-curator/claude-opus-5-5`. For a UTC-3 example use `America/Argentina/Buenos_Aires` or write "UTC-3"; never write the name of the Brazilian city whose zone is `America/Sao_Paulo` with a space (the maintainer's gate refuses it).
- Human-facing dates are DD/MM/YYYY; ISO only where no person reads it.
- Exit codes are fixed in `src/exit-codes.mjs`.
- **Never read, run against or write to the private reference vault this kit is extracted from, and never run a command from the session's default working directory: always `cd` into the kit repository or a scratch directory first.** Never read the maintainer's `~/.claude/projects`, `~/.claude/scheduled-tasks`, calendar or Drive in tests: tests point `HOME` at scratch. Never call the real scheduled-tasks tool or the real `claude` in tests.
- No budget, turn or time limit that the maintainer did not ask for, in tests, tools or manual runs.
- Point `BRAIN_KIT_STATE_DIR` or `XDG_STATE_HOME` at a scratch directory in every test and every manual run.
- The maintainer's pre-push gate is active; never bypass it. Commit with the configured identity and never supply one; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

Clause-by-clause mutation is mandatory where a deleted clause could: put in the briefing a fact the kit did not compute (a date, a count, a deadline bucket), read a path in `never_read`, lose or duplicate a question, escalate or archive one at the wrong time, let a block the configuration did not ask for appear or one it asked for vanish, let the curator read a briefing session, or change the vault other than by `propose --only`. Everywhere else, ordinary tests plus the two questions: what single edit makes the briefing state a fact that is false, or drop a question the person never answered, while the suite stays green? And what already does so with no edit at all? Prove each with real runs of `brain-kit preflight`, `brain-kit questions` and `brain-kit prompt briefing` against throwaway vaults.

## Review Focus

1. **A deadline cell in every shape a person writes:** DD/MM/YYYY, YYYY-MM-DD, a date inside text, two dates, no date, an invalid date (31/02). Each lands in exactly one bucket, and "no date" is a bucket, never silence. Owner: Task 1.
2. **Today at the edges:** the vault's time zone, a run just after midnight, a Monday (the weekend's items), a deadline equal to today. Owner: Task 1.
3. **A question asked again in other words, answered in the session, never answered for weeks.** Deduplicated when the text normalises to the same, marked answered only by the command, escalated and later archived with the briefing saying so. Owner: Task 2.
4. **A `briefing.blocks` list with an unknown block, a duplicate, an empty list, a custom block naming a note in `never_read` or a note that does not exist.** Refused or reported by name, never silently dropped. Owner: Task 3.
5. **The scheduled task's first line, and the curator's filter.** A briefing session in an included project is never offered to the curator; a human session that merely quotes the signature later still is. Owner: Task 3 and Task 4.

## What earlier phases established, which this phase reuses

- `src/guards/watermark.mjs` (`localDay`, `startOfDay`, `addDays`), `src/dates.mjs`, the vault time zone `vault.timezone`; `src/commands/prompt.mjs` (`renderCuratePrompt`, placeholders, overlays, `--check`, the never-empty rule), `src/curate/tools.mjs` (`kitCommand()`); `src/sources/transcripts-claude-code.mjs` (the self-trace filter reading `curate.signature` and `curate.extra_signatures`).
- `src/guards/lock.mjs` (`describeLock`), `src/git.mjs` (`defaultBranch`, `aheadBehind`, `dirtyPaths`), `src/commands/validate.mjs` (stale notes are reported with `stale_after`), the curator's `last-run.json` (exit, reason, per-source `state`, `advanced`, carried `connectorStates`), `src/state.mjs` (`STATE_FILES.QUESTIONS_LOG` is `questions.log`; machine.json `paths.questions_log`).
- The configuration's `briefing` section: `enabled`, `schedule` (`0 9 * * 1-5`), `prompt`, `signature`, `max_words`, `max_questions`, `questions_dedup_days` (15), `question_escalate_after` (3), `question_max_age_days` (45), `write_caps`, `strategy_doc { index, title_contains }`, `calendar_id`, `read`, `never_read`; `taxonomy.files.followups` and `promises`, and `taxonomy.columns.followups` / `promises` with their column labels and headings.
- Skills with the `!` line and `allowed-tools`, `SKILL_NAMES`, evals; the `setup` skill; `brain-kit schedule` with `--job curate`; `doctor` checks.

## Out of scope

- An unattended briefing (a scheduler without the person): the briefing asks questions, so it runs in the person's session.
- Cloud routines: documented as an alternative that cannot read local transcripts.
- Migrating the original vault's briefing: phase 5.

## File Structure

| File | Responsibility |
|---|---|
| `src/briefing/facts.mjs` (create) | every deterministic fact the briefing states |
| `src/briefing/pending.mjs` (create) | pending tables parsed into deadline buckets |
| `src/commands/preflight.mjs` (create) | `brain-kit preflight [dir] [--json]` |
| `src/briefing/questions.mjs` (create), `src/commands/questions.mjs` (create) | the question queue and its command |
| `src/briefing/blocks.mjs` (create) | the block catalog, configuration validation, rendering |
| `src/commands/prompt.mjs` (modify) | `brain-kit prompt briefing` |
| `lang/<code>/prompts/briefing.md` (create) | the generic briefing prompt |
| `src/sources/transcripts-claude-code.mjs` (modify) | the briefing signature always filtered |
| `lang/<code>/skills/briefing.md`, `skills/briefing/SKILL.md`, `evals/briefing-<lang>/` (create) | the skill |
| `lang/<code>/skills/setup.md` (modify), `src/commands/schedule.mjs` (modify) | registering the desktop task |
| `src/doctor/checks.mjs` (modify) | the `briefing` check |
| `lang/<code>/config.defaults.json`, `schema/config.schema.json` (modify) | blocks, pending roles, no-limit defaults |
| `docs/briefing.md` (create), `README*.md`, `CHANGELOG.md` (modify) | documentation |
| `test/e2e-briefing.test.mjs` (create) | the opt-in real run |

**Order of execution.** Tasks 1 and 2 touch disjoint files and can run in parallel; Task 3 follows both; Task 4 follows Task 3; Task 5 comes last.

---

### Task 1: `brain-kit preflight`

**Files:**
- Create: `src/briefing/facts.mjs`, `src/briefing/pending.mjs`, `src/commands/preflight.mjs`, `test/preflight.test.mjs`, `test/briefing-pending.test.mjs`
- Modify: `src/cli.mjs`, both `messages.json` (and `cli.usage`), both `config.defaults.json`, `schema/config.schema.json`

**Interfaces:**
- Config: `briefing.pending`, default in both packs: `[{ "file": "followups", "heading": "open_heading", "date_column": <the pack's "Deadline" label>, "what_column": <the pack's "What" label> }, { "file": "promises", "heading": "active_heading", "date_column": <the pack's "Condition / deadline" label>, "what_column": <the pack's "What I promised" label> }]` (`file` names a key of `taxonomy.files`, `heading` a key of that file's `taxonomy.columns.<file>.labels`); `briefing.upcoming_days`, default `7`.
- Produces: `pendingBuckets({ root, config, today, tz }) -> { overdue: Item[], today: Item[], upcoming: Item[], undated: Item[], later: number, problems: [{ code, detail }] }`, `Item = { file, line, what, deadline: 'YYYY-MM-DD' | null, raw }`. A cell's date is the first DD/MM/YYYY or YYYY-MM-DD in it that is a real calendar date; a cell with a date that is not real (31/02) is a problem naming the file and line, and the item goes to `undated`. A table missing, a heading missing, a column missing: a problem each, never an exception.
- Produces: `briefingFacts({ root, config, machine, stateDir, now, env, deps }) -> { today, todayHuman, weekday, tz, lastRun: { at, atHuman, exit, reasonCode, sources: { id: { state, advanced } } } | null, connectorStates, openPullRequests: { ok, items: [{ number, title, url, createdHuman }] } , stale: { count, notes: [{ path, staleAfterHuman }] }, pending, git: { branch, behind, ahead, dirty }, lock: { held, command } , questions (Task 2 fills it; here `null`) }`. Open pull requests come from `gh pr list --state open --json number,title,url,createdAt` run in the vault (argv, no shell); `gh` absent or failing gives `{ ok: false, reason }`, never a guess. Dates for people are DD/MM/YYYY in the vault's zone.
- `brain-kit preflight [dir] [--json]`: the facts as text in the vault's language, or as JSON; exit 0, or 2 outside a vault.

- [ ] **Step 1:** tests for every Review Focus 1 and 2 case, for each missing-structure problem, for `gh` present (a fake on PATH), absent and failing, for a vault with no last run, with a last run of each exit, with carried connector states; the text output in both languages; `--json` stable keys.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over the date parsing, the bucket boundaries (today, upcoming days) and the "no date" bucket.
- [ ] **Step 4:** commit `feat: brain-kit preflight computes every fact the briefing states`.

### Task 2: the question queue

**Files:**
- Create: `src/briefing/questions.mjs`, `src/commands/questions.mjs`, `test/questions.test.mjs`
- Modify: `src/cli.mjs`, both `messages.json`

**Interfaces:**
- The queue is `machine.paths.questions_log` (default `<state dir>/questions.log`), one JSON object per line, written atomically (temp file and rename), mode 0600: `{ id, text, normalized, createdOn, askedOn: ['YYYY-MM-DD'], status: 'open'|'answered'|'archived', answeredOn, archivedOn, archivedReason }`. `id` is `q-` plus the first 8 hex characters of the SHA-256 of `normalized`. `normalized` is the text lower-cased, with accents kept, punctuation and runs of whitespace collapsed to one space, trimmed.
- Produces: `readQueue(stateDir) -> Question[]` (a line that does not parse is kept as it is and reported, never dropped), `addQuestion(stateDir, text, { today, dedupDays }) -> { added, id, duplicateOf? }` (an open question with the same `normalized`, or one answered within `dedupDays`, is a duplicate), `markAsked(stateDir, ids, today)`, `answer(stateDir, id, today)`, `archive(stateDir, id, today, reason)`, `queueSummary(questions, { today, escalateAfter, maxAgeDays }) -> { open: [...], escalated: [...], toArchive: [...] }`: escalated when asked at least `escalateAfter` times and still open; to archive when open and created more than `maxAgeDays` ago. `escalateAfter` and `maxAgeDays` `null` mean never.
- `brain-kit questions list|add "<text>"|answer <id>|archive <id> [--reason "<text>"] [dir]`, and `brain-kit questions sweep [dir]` which archives what `queueSummary` says, printing each archived question: nothing is archived silently. Each writing subcommand takes the vault lock.
- `briefingFacts` (Task 1) gets `questions: queueSummary(...)` once both tasks land (Task 3 wires it).

- [ ] **Step 1:** tests: dedup by normalisation (case, punctuation, spacing; accents significant), dedup window after an answer, escalation at exactly `escalateAfter`, archiving at exactly `maxAgeDays`, `null` meaning never, a corrupt line kept and reported, concurrent writers serialised by the lock, the file mode, every subcommand's output in both languages.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over dedup, escalation, archiving and the corrupt-line rule.
- [ ] **Step 4:** commit `feat: brain-kit questions keeps the briefing's queue, deduplicated, escalated and archived out loud`.

### Task 3: the blocks and the briefing prompt

**Files:**
- Create: `src/briefing/blocks.mjs`, `lang/pt-BR/prompts/briefing.md`, `lang/en/prompts/briefing.md`, `test/briefing-blocks.test.mjs`, `test/prompt-briefing.test.mjs`, `test/incidents/2026-09-25-briefing-self-trace.test.mjs`
- Modify: `src/commands/prompt.mjs`, `src/sources/transcripts-claude-code.mjs`, `src/briefing/facts.mjs` (wire the queue summary), both `messages.json`, both `config.defaults.json`, `schema/config.schema.json`

**Interfaces:**
- The catalog, `BLOCKS`: fact blocks, filled by the kit from `briefingFacts`, the model only presents them: `sources` (the curator's last round and each source's state, with what to do for any that is not read), `due` (overdue and due today), `upcoming` (due within `briefing.upcoming_days`), `undated` (pending items without a readable deadline), `open_prs` (pull requests awaiting the owner's merge), `stale` (notes past `stale_after`), `questions` (the escalated, then the open questions, then room for new ones); judgement blocks, with an instruction the model follows: `blind_spots` (what the vault should know and does not, from the `read` list and the recent log headings), `strategy` (the vault's position against the strategy document named by `briefing.strategy_doc`; skipped, and said so, when none is configured or found), `today_calendar` (today's events from the calendar connector of the person's session, with the calendar source's privacy policy; when the connector is not in the session, say so and skip). Custom blocks: `{ "id": "<lower-case slug>", "title": "<text>", "read": ["<vault-relative path>", ...], "instruction": "<text>" }`.
- Config: `briefing.blocks`, default in both packs `["sources", "due", "upcoming", "undated", "open_prs", "stale", "blind_spots", "strategy", "questions"]`; `briefing.max_words`, `briefing.max_questions` and every `briefing.write_caps` value default to `null` (B4). Validation (`validateBriefingBlocks(config, root) -> problems`): an unknown id, a duplicate, an empty list, a custom block whose `read` names a path in `never_read`, outside the vault, or missing: each a named problem; `prompt briefing` and `doctor` report them; the blocks with problems are left out and the briefing says which and why.
- `brain-kit prompt briefing [--vault <dir>]`: the prompt overlay when present (with its signature line prepended if missing, as for curate), else the pack's prompt, with placeholders `{{signature}}` (first line), `{{today_human}}`, `{{kit}}`, `{{blocks}}` (each enabled block in order: fact blocks with their facts already rendered as text in the vault's language, judgement and custom blocks with their instruction and the paths to read), `{{read}}`, `{{never_read}}`, `{{limits}}` (only the limits the person set, one line each; nothing when all are `null`), `{{log}}`, `{{capture_marker}}`, `{{agent}}`, `{{now_iso}}`.
- The prompt, both languages, domain neutral, second person, with contract markers `<!-- rule:<id> -->`: `never-read` (never open a path in the never-read list, not even to check it exists), `facts-from-kit` (every date, count and deadline comes from the blocks as given; never compute or restate one differently), `closed-uncertainty`, `never-empty-unopened`, `questions-by-command` (a new question is added with `{{kit}} questions add`, an answer recorded with `{{kit}} questions answer <id>` only after the person answered it in this session), `propose-only` (captures go to the log under today's heading with the capture marker, pending changes to their tables, then `{{kit}} validate`, `{{kit}} lint --base worktree`, and one `{{kit}} propose "<summary>" --only <paths>`; nothing to record, no pull request), `honour-limits` (a limit given in `{{limits}}` is honoured and said when it bites).
- The self-trace filter reads `briefing.signature` in addition to `curate.signature` and `curate.extra_signatures`, always.

- [ ] **Step 1:** tests: every catalog block renders in both languages from fixture facts; custom blocks in order; each validation problem; the default list; `null` limits render nothing and a set limit renders its line; the overlay path; every placeholder resolved; the contract markers present in both languages; `prompt --check` covers the briefing prompt. Incident test `2026-09-25-briefing-self-trace`: a transcript whose first user line starts with the briefing signature is dropped by the transcripts source with an empty `extra_signatures`; one that quotes it later is kept.
- [ ] **Step 2:** run, see them fail; implement; whole suite.
- [ ] **Step 3:** mutation, mandatory, over block validation, the order, the never-read check on custom blocks, the limits rendering and the self-trace clause.
- [ ] **Step 4:** commit `feat: the briefing prompt is the vault's own blocks, facts from the kit and judgement from the model`.

### Task 4: the skill, the desktop task and doctor

**Files:**
- Create: `lang/pt-BR/skills/briefing.md`, `lang/en/skills/briefing.md`, `skills/briefing/SKILL.md`, `evals/briefing-pt-BR/`, `evals/briefing-en/`
- Modify: `src/commands/prompt.mjs` (`SKILL_NAMES`), `lang/*/skills/setup.md`, `src/commands/schedule.mjs`, `src/doctor/checks.mjs`, both `messages.json`, `test/plugin.test.mjs`, `test/prompt.test.mjs`, `test/schedule.test.mjs`, `test/doctor.test.mjs`

**Interfaces:**
- `skills/briefing/SKILL.md`: the same shape as the other skills, `allowed-tools` granting exactly its own `!` command, which is `node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt briefing`; description, verbatim: `Use when the person asks for their morning briefing from the brain-kit vault, or when the scheduled briefing task starts: facts from the kit, the vault's own blocks, open questions, and one pull request for what gets recorded.`
- The skill body (both packs, under 60 lines) says only: the briefing below is this session's instructions; if the `!` output is the "could not load" line, run `{{kit}} doctor` and stop.
- The desktop task: `brain-kit schedule install --job briefing [dir]` prints the task to register (its `taskId` `brain-kit-briefing-<vault_id>`, its title in the vault's language, its cron from `briefing.schedule`, and its prompt) and exits 3, because a scheduled task of the desktop application can be created only from inside the application. The prompt's first line is `briefing.signature` (B6), then one line asking to run the brain-kit briefing for the vault at its absolute path (`/brain-kit:briefing`, with `--vault` given to the prompt command through that line). `status --job briefing` reads `~/.claude/scheduled-tasks/brain-kit-briefing-<vault_id>/SKILL.md` and says whether the task exists and whether its prompt still starts with the signature.
- The `setup` skill gains a step: after `schedule install --job curate`, offer the briefing; on yes, run `{{kit}} schedule install --job briefing <dir>` and create the task it prints with the application's scheduled-task tool (taskId, title, cron, prompt exactly as printed), and say that it runs while the application is open and on the next launch when it was closed.
- doctor's `briefing` check: `briefing.enabled`; block validation problems (Task 3); the queue readable; the task present and signed (warning when absent, since registering is the person's step).
- Evals: one case per language, the same shape as the other cases, a request that does not name the skill (pt-BR: "me dá o resumo da manhã do meu cérebro").

- [ ] **Step 1:** tests: SKILL.md shape and description; `SKILL_NAMES` has nine names; the rendered skill body; `schedule install --job briefing` output and exit 3 in both languages, with a vault path holding a space and an accent; `status --job briefing` with the task present, absent and unsigned (HOME in scratch); the setup body's new step; doctor's `briefing` check for each state; evals' shape.
- [ ] **Step 2:** run, see them fail; implement; whole suite; `claude plugin validate --strict .`.
- [ ] **Step 3:** commit `feat: the briefing skill, its desktop task and doctor's briefing check`.

### Task 5: docs and the opt-in real run

**Files:**
- Create: `docs/briefing.md`, `test/e2e-briefing.test.mjs`
- Modify: `README.md`, `README.pt-BR.md`, `CHANGELOG.md`, `docs/incidents.md` (the self-trace entry names the briefing signature)

**Docs:** `docs/briefing.md`: what the briefing is and is not (not the curator), the blocks catalog with what each shows and where its facts come from, custom blocks with an example (Ana's reading group), the limits and their `null` default, the question queue and its commands, how to register the desktop task and what "runs while the app is open" means, the prompt overlay, what never changes (B2). README (both) and CHANGELOG: phase 4, status "in review" until the controller's run.

**End-to-end test** (`BRAIN_KIT_E2E_BRIEFING=1` only, skipped otherwise, never in CI, no budget or turn limit): in scratch, `init --yes` a vault in the language of `BRAIN_KIT_E2E_LANG` (default `en`), committed, with a bare remote and a fake `gh`; pending tables seeded with one overdue item, one due today, one undated; the queue seeded with one question asked three times; the real `claude -p --plugin-dir <kit>` in the vault with a request that runs the briefing and answers its questions in advance. Asserts: the model invoked the briefing skill; every default block's heading appears in the reply in order; the escalated question appears first among the questions; a new question was added through `questions add` or the answered one marked through `questions answer`; exactly one `pr create` against the default branch with `--only` paths, or none when nothing was recorded; `never_read` paths were never read (the stream's tool uses).

- [ ] **Step 1:** write the docs, README and CHANGELOG.
- [ ] **Step 2:** write the end-to-end test (skipped by default); commit `docs: the morning briefing; opt-in briefing run`.

## After the last task (controller)

- Final whole-phase review on the most capable model; one fix dispatch; adjudicate residuals.
- Run `BRAIN_KIT_E2E_BRIEFING=1 BRAIN_KIT_E2E_LANG=pt-BR node --test test/e2e-briefing.test.mjs` once, result in the ledger.
- README status to "done", push, report phase 4 complete.
