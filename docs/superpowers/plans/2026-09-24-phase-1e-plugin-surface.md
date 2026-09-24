# Phase 1 slice E: the plugin surface

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a person with the plugin installed gets, inside a vault, a session that records what was already dirty when it began, a Stop hook that asks for curation only of what this session changed (and never outside a vault, never in a copy away from the registered path, never while another writer holds the lock), seven skills that drive the engine in the vault's language, a read-only subagent, and one eval case per skill and language.

**Architecture:** the two hooks become real engine code behind `brain-kit hook <event>`, built on the guards slice C landed (`takeSnapshot`, `readSnapshot`, `splitDirty`, `describeLock`) and on the sentinel and machine file slices A and D landed. Skill bodies live in the language packs and are printed by a new `brain-kit prompt skill <name>` command; each `skills/<name>/SKILL.md` is an English ASCII frontmatter plus one `!` line that runs that command through `${CLAUDE_PLUGIN_ROOT}`, so the body the model reads is always in the vault's language and always the kit's current text.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`. Claude Code 2.1.281 on the maintainer's machine: `claude plugin validate --strict`, `claude plugin eval` (case layout `evals/<case>/prompt.md` plus `evals/<case>/graders/*.md`, grader `type` one of `regex | tool_order | tool_used | file_exists | llm | baseline`, measured on 24/09/2026 with `claude plugin eval init --bare`).

**Spec:** the approved design, private to the maintainer: its "Plugin do Claude Code" section, its `hook` and `prompt` command rows, and its phase 1 row ("hook bloqueia vault sujo, ignora repo alheio e cópia fora do canônico"; "`claude plugin eval` aciona cada skill em pt-BR e en"). The facts measured in the phase 1 opening experiment are in `docs/superpowers/plans/2026-09-18-phase-1a-vault-core-and-validate.md`, section "Facts established by the Phase 1 opening experiment"; they bind this slice. The dated lessons are in `docs/incidents.md` (the Stop hook false positive of 14/09/2026, the foreign session of 16/09/2026). Slices A to D are on `main` at `f0212ff`.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync` with an argument array.
- Every git call removes the caller's git environment through `src/git-env.mjs` (the guards already do, through `gitEnvFor`).
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key. Skill bodies are user-facing: they live in `lang/<code>/skills/<name>.md`, one per language, with the same set of files in both packs.
- Files under `src/`, `bin/`, `hooks/`, `skills/` and `agents/` are pure ASCII. The em dash is banned everywhere in the repository. Never type a unicode escape into file content.
- SKILL.md and agent frontmatter `name` and `description` are English ASCII: the description decides when the model picks the skill.
- No household data anywhere. Example data uses the fictional owner "Ana", `example.com` / `example.invalid`, `human:ana`, and the agent actor `brain-kit-curator/claude-opus-5-5`.
- Exit codes are fixed in `src/exit-codes.mjs`. A hook ALWAYS exits `0`: its verdict travels in its JSON on stdout, never in its exit code (an exit 2 from a Stop hook is a block Claude Code shows as an error; this kit blocks only through `{"decision":"block"}`).
- A hook must finish well inside its 15 second timeout and must never write to the vault's working tree. The session snapshot lives in the git directory (slice C), which is not the working tree.
- Nothing the engine needs may come from plugin user config: the vault is found from the hook payload's `cwd` and its own files; machine facts come from `machine.json` in the state directory. `${user_config.*}` is never used in a SKILL.md line.
- **Never read, run against or write to the private reference vault this kit is extracted from, and never run a command from the session's default working directory: always `cd` into the kit repository or a scratch directory first.**
- Point `BRAIN_KIT_STATE_DIR` or `XDG_STATE_HOME` at a scratch directory in every test and every manual run.
- The maintainer's pre-push gate is active; never bypass it. Commit with the repository's configured identity and never supply one; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

Clause-by-clause mutation is mandatory in the Stop hook's decision ladder (Task 2) and in the snapshot keep-or-retake rule (Task 1): a deleted clause there either blocks a session that must end (outside a vault, another person's repository, a copy away from the registered path) or lets a session end with its own work unproposed. Everywhere else, ordinary tests plus the two questions. Control at zero failures before any mutation, more than once; verify each mutation changes behaviour; derive the clause list from the code as it stands at the end.

**The two questions:** what single edit makes the Stop hook block where it must release, or release where it must block, while the suite stays green? And what already does so with no edit at all? Prove each by running the real hook (`node bin/brain-kit.mjs hook stop` with JSON on stdin) against a throwaway vault in a scratch directory.

**The recurring shape:** a command that succeeds while saying nothing, read as nothing to do; and one that answers about something other than what we act on. Here it lives in a snapshot retaken on compaction (the session's own work then reads as "already there" and the hook releases), in a hook that exits 0 with no output because it never found the vault, and in a skill whose `!` line failed and left the model an empty body.

## Review Focus

1. **Compaction and resume.** A snapshot taken at startup is kept when the same session compacts or resumes, and retaken when a different session starts. Owner: Task 1.
2. **Each rung of the Stop ladder, alone.** Bad JSON, `stop_hook_active`, no vault, invalid sentinel, unregistered machine, copy away from the canonical path, lock held, clean tree, only inherited dirt: each releases, and only session dirt blocks. Owner: Task 2.
3. **A path that is not valid UTF-8, a path with spaces and accents, and more dirty paths than the listing ceiling.** The block reason names them readably and says how many it left out. Owner: Task 2.
4. **A skill rendered outside a vault, inside a pt-BR vault, inside an en vault, and with the `!` line's command failing.** The body is in the right language, every placeholder is resolved, and a failure prints a line the model can act on instead of nothing. Owner: Task 3.

## What earlier slices established, which this slice reuses

- `src/guards/snapshot.mjs`: `takeSnapshot(root, { env, now })` returns `{ at, root, paths }` and stores `{ format, at, root, paths }` (paths hex) in the working tree's git dir; `readSnapshot(root, { env })` returns the same shape or `null`, and throws `GuardError` on an unreadable file; `splitDirty(root, snapshot, { env })` returns `{ before, since }` as Buffers. Both throw `GuardError` (`SNAPSHOT_NOT_TOPLEVEL`, exit 2) when `root` is not the top level, and `locateRepository` throws outside a repository.
- `src/guards/lock.mjs`: `describeLock(root, { env })` returns the holder or `null`; an unreadable lock is a holder with `unreadable: true`.
- `src/vault.mjs`: `findVaultRoot(startDir, home)` walks up, stopping at home; `isVaultRoot(dir)` checks the two sentinel files exist.
- `src/config.mjs`: `loadConfig`, `loadMachine(stateDir)`, `canonicalPathMatches(recorded, realRoot)`, `CONFIG_FILENAME`, `MACHINE_FILENAME`. `src/state.mjs`: `stateDirFor(vaultRoot, env)`.
- `src/lang.mjs`: `createTranslator(lang)`, `SUPPORTED_LANGS`, `resolveLang(env)`. `src/io.mjs`: `readStdin`, `decodeBytes`.
- `src/commands/hook.mjs`: routes `stop` and `session-start`, today reads stdin and exits 0.
- `hooks/hooks.json` and `hooks/run-hook.cmd` exist and are tested by `test/plugin.test.mjs`.
- The configuration carries `kit_version`, `lang`, `owner`, `actors { human, agent_prefix }`, `taxonomy.log` and `taxonomy.log_markers`.

## Out of scope

- The briefing skill and `seed-rituals`: phases 4 and 3.
- A CI workflow template for a vault: it must check the kit out at a pinned revision, and the kit has no release tag to pin until phase 6. Ruled out of this slice; phase 6 adds it.
- Changing the reference vault's own Stop hook: phase 5 migrates it.
- Running `claude plugin eval` in CI: it needs a logged-in CLI. This slice authors the cases and the controller runs one case once, by hand, with `--runs 1`.

## File Structure

| File | Responsibility |
|---|---|
| `src/guards/snapshot.mjs` (modify) | optional `session` in the snapshot |
| `src/hooks/session-start.mjs` (create) | keep or retake the snapshot; one status line |
| `src/hooks/stop.mjs` (create) | the release-or-block ladder |
| `src/hooks/payload.mjs` (create) | parse the hook JSON; resolve the vault and its language |
| `src/commands/hook.mjs` (modify) | route to the two handlers |
| `src/commands/prompt.mjs` (create) | `brain-kit prompt skill <name>` and `--check` |
| `src/cli.mjs` (modify) | register `prompt` |
| `lang/<code>/skills/<name>.md` (create, 14) | skill bodies |
| `skills/<name>/SKILL.md` (create, 7) | frontmatter plus the `!` line |
| `agents/vault-reader.md` (create) | read-only subagent |
| `evals/<name>-<lang>/` (create, 14) | one case per skill and language |
| `lang/<code>/vault/.claude/settings.json` (create, 2) | documental settings seeded by `init` |
| `hooks/hooks.json` (modify) | SessionStart matcher gains `resume` |
| `test/hook-session-start.test.mjs`, `test/hook-stop.test.mjs`, `test/prompt.test.mjs` (create) | tests |
| `test/plugin.test.mjs`, `test/parity.test.mjs` (modify) | skills, agent, evals, pack parity |

---

### Task 1: session identity in the snapshot, and the SessionStart hook

**Files:**
- Modify: `src/guards/snapshot.mjs`, `src/commands/hook.mjs`, `hooks/hooks.json`, both `messages.json`
- Create: `src/hooks/payload.mjs`, `src/hooks/session-start.mjs`, `test/hook-session-start.test.mjs`
- Test: `test/snapshot.test.mjs` (extend)

**Interfaces:**
- Produces: `takeSnapshot(root, { env, now, session })` stores `session` (string or omitted); `readSnapshot` returns `session` (`null` when the file has none, so a snapshot written by slice C still reads). The on-disk `format` value does not change.
- Produces: `parseHookPayload(text) -> { ok: true, payload } | { ok: false, reason }` (payload must be a JSON object); `resolveHookVault(payload, env) -> { root, config, lang } | { root: null, why }` where the start directory is `payload.cwd`, else `env.CLAUDE_PROJECT_DIR`, else `process.cwd()`; `root` is `findVaultRoot(start)` made real with `realpathSync`; the vault counts only when `brain-kit.config.json` parses as JSON and its `kit_version` is a string matching `^\d+\.\d+\.\d+$` (the sentinel of the design: config with a valid `kit_version`, plus `index.md`, which `findVaultRoot` already requires). `lang` is the config's `lang` when supported, else `resolveLang(env)`. The config is NOT schema-validated here: a vault with some other config error is still a vault.
- Produces: `runSessionStart(stdinText, env, now) -> { stdout, stderr }`, always exit 0.

Behaviour of `session-start`:

1. Payload does not parse: no stdout, one stderr line, exit 0.
2. No vault (`root: null`): no stdout, no stderr, exit 0.
3. Vault that is not a git repository, or is not the top level of its repository: no snapshot, one stderr line naming why, and the status line saying the Stop hook cannot tell this session's work from earlier work.
4. Keep or retake: read the existing snapshot. KEEP it when it exists, its `root` equals the vault's real top level, its `session` equals `payload.session_id` (a non-empty string), and `payload.source` is `compact` or `resume`. Otherwise TAKE a new one with `session: payload.session_id`. An unreadable snapshot file is replaced (it cannot protect anything) and the status line says so.
5. stdout is `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<one line>"}}`. The line, in the vault's language, names: the vault title (`vault.title`, else the folder name), how many paths were already dirty when the snapshot was taken (or kept), and the lock holder's command and pid when the lock is held.

- [ ] **Step 1:** tests in `test/snapshot.test.mjs`: `session` round-trips; a slice C file without `session` reads with `session: null`; a non-string `session` in the file is unreadable.
- [ ] **Step 2:** tests in `test/hook-session-start.test.mjs`, each spawning `node bin/brain-kit.mjs hook session-start` with JSON on stdin in a throwaway vault made by `init --yes` in a scratch directory (state dir pinned): startup takes; compact with the same session keeps (prove it: dirty a file after startup, compact, then `readSnapshot` still lacks that path); compact with another session retakes; resume with the same session keeps; clear retakes; outside a vault prints nothing; bad JSON prints nothing to stdout; a vault that is not a repository prints the warning line; an unreadable snapshot is replaced and reported; the output is valid JSON with `hookEventName` `SessionStart`.
- [ ] **Step 3:** run, see them fail; implement; run the whole suite.
- [ ] **Step 4:** `hooks/hooks.json` SessionStart matcher becomes `startup|resume|clear|compact`.
- [ ] **Step 5:** mutation over the keep-or-retake clauses (each of the four KEEP conditions deleted alone must turn a test red).
- [ ] **Step 6:** commit `feat: SessionStart hook records the session snapshot, kept across compaction`.

### Task 2: the Stop hook

**Files:**
- Create: `src/hooks/stop.mjs`, `test/hook-stop.test.mjs`
- Modify: `src/commands/hook.mjs`, both `messages.json`

**Interfaces:**
- Consumes: Task 1's `parseHookPayload`, `resolveHookVault`, `readSnapshot`; `splitDirty`, `describeLock`, `stateDirFor`, `loadMachine`, `canonicalPathMatches`, `decodeBytes`.
- Produces: `runStop(stdinText, env) -> { stdout, stderr }`, always exit 0.

The ladder, in this order. "Release" means exit 0 with no stdout. Each release after rung 3 writes one stderr line saying which rung released (Claude Code keeps it in the transcript, the model does not act on it).

1. Payload does not parse: release (fail open before the sentinel, stderr line).
2. `payload.stop_hook_active === true`: release. This is what lets a session end after it has been asked once.
3. No vault by the sentinel: release, silently. This is the false positive of 14/09/2026: another person's repository, dirty, must never be blocked.
4. `machine.json` absent in `stateDirFor(root)`: release (this copy is not registered on this machine; the stderr line names `brain-kit machine register`).
5. `machine.json` present but unreadable or invalid: BLOCK, reason names the file and `brain-kit doctor`. From here on the ladder fails closed.
6. `canonical_path` does not match the vault's real path by `canonicalPathMatches`: release (a copy away from the registered path, such as a worktree under `.claude/worktrees`).
7. Not a git repository or not the top level: BLOCK, reason says the kit needs the vault to be a repository and names `brain-kit doctor`.
8. `describeLock` returns a holder (unreadable included): release, stderr names the holder's command and pid. Another writer is working; asking this session to propose now would collide with it.
9. Snapshot: `readSnapshot`. `null`, unreadable, or of another root: treat every dirty path as this session's, and the reason says the session snapshot was missing so earlier work may be included.
10. `splitDirty`: `since` empty: release (clean, or only dirt that was already there; the stderr line gives the inherited count).
11. BLOCK: stdout `{"decision":"block","reason":"<text>"}`. The text, in the vault's language: the count of paths this session changed; up to 20 of them, one per line, decoded with `decodeBytes`, in byte order; when there are more, "and N more"; the count of inherited paths left out and that they are not this session's to propose; then the instruction: capture what is new in the log, compile it into notes, run `brain-kit validate` and `brain-kit lint`, and open the pull request with `brain-kit propose --only <paths>` (or the `curate-session` skill); if these changes must not be proposed, say so to the person and stop.

- [ ] **Step 1:** tests, each spawning the real hook in a throwaway vault from `init --yes` plus `brain-kit machine register` (or writing `machine.json` the way the machine tests do), state dir pinned: one test per rung, each proving the rung alone decides (set up everything else so the next rung would block). Plus: a path with spaces and accents is listed readably; a path that is not valid UTF-8 is listed without throwing; 25 new files list 20 and say "5"; inherited dirt from before `session-start` does not block while a new file does; `stop_hook_active` releases even with session dirt; the hook never changes `git status` of the vault (compare before and after); a dirty repository that is not a vault releases with empty stdout AND empty stderr.
- [ ] **Step 2:** run, see them fail; implement; run the whole suite.
- [ ] **Step 3:** mutation, mandatory, clause by clause over the ladder as it stands.
- [ ] **Step 4:** the two questions, answered with real runs, written into the report.
- [ ] **Step 5:** commit `feat: Stop hook asks for curation only of this session's changes in a registered vault`.

### Task 3: `brain-kit prompt`

**Files:**
- Create: `src/commands/prompt.mjs`, `test/prompt.test.mjs`, one placeholder skill body pair `lang/pt-BR/skills/capture.md` and `lang/en/skills/capture.md` (Task 4 writes the real text; here a short body that uses every placeholder)
- Modify: `src/cli.mjs`, both `messages.json` (`cli.usage` lists `prompt`)

**Interfaces:**
- Produces: `brain-kit prompt skill <name> [--vault <dir>]` prints the rendered body of `lang/<lang>/skills/<name>.md` and exits 0; `brain-kit prompt --check` exits 0 when every skill has a body in every supported language, the two packs carry the same set of skill files, and every placeholder in every body is known; otherwise exits 1 listing each problem. `SKILL_NAMES` exported: `['setup', 'curate-session', 'capture', 'ask', 'lint', 'review-stale', 'approve']`.
- The vault is found from `--vault` or from the working directory with `findVaultRoot`; outside a vault the skill still renders (setup needs this), with the language from `resolveLang(env)`.
- Placeholders, written `{{name}}`: `today` (DD/MM/YYYY, local time), `today_iso` (YYYY-MM-DD, for headings the log uses), `vault` (the vault root, or the translated words for "no vault found"), `log` (`taxonomy.log`, else the pack default), `capture_marker` (`taxonomy.log_markers.capture`, else the pack default), `human` (`actors.human`), `agent` (`actors.agent_prefix` + `/<model>` literal text `<model>`), `kit` (the command that runs this kit: `node "<absolute path to bin/brain-kit.mjs>"`, quoted so a path with spaces works when the model pastes it). An unknown `{{x}}` in a body is a `--check` failure and is printed literally by `skill`.
- Unknown skill name: exit 2, message lists the known names. A failure reading the body: exit 1 with one line. The line the model sees in place of the body must never be empty: on any failure, stdout carries one translated line saying the skill body could not be loaded and to run `brain-kit doctor`.

- [ ] **Step 1:** tests: renders in pt-BR inside a pt-BR vault, in en inside an en vault, outside a vault by the locale; every placeholder resolved; `{{kit}}` points at an existing file and survives a path with a space; unknown skill exits 2 with stdout non-empty; `--check` passes on the real packs and fails on a scratch copy with a missing en body and with an unknown placeholder (point it at the copy through an injected packs directory, not by editing the real packs).
- [ ] **Step 2:** run, see them fail; implement; run the whole suite.
- [ ] **Step 3:** commit `feat: brain-kit prompt renders skill bodies in the vault's language`.

### Task 4: the seven skills and the read-only subagent

**Files:**
- Create: `lang/pt-BR/skills/<name>.md` and `lang/en/skills/<name>.md` for the seven names (replacing Task 3's placeholder capture body), `skills/<name>/SKILL.md` (7), `agents/vault-reader.md`
- Modify: `test/plugin.test.mjs`, `test/parity.test.mjs`, `.claude-plugin/plugin.json` (description no longer says "Phase 0")

**SKILL.md shape** (every one the same, only name and description differ):

```markdown
---
name: capture
description: <English ASCII, one or two sentences, starting with "Use when">
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill capture`
```

Descriptions (verbatim):

- `setup`: `Use when the person wants to start a second brain with brain-kit, adopt an existing markdown vault, or check that the kit, git, gh and the plugin are ready on this machine.`
- `curate-session`: `Use at the end of a working session in a brain-kit vault, or when asked to curate: sync, capture what was learned, compile it into notes, validate, lint and open a pull request with only this session's files.`
- `capture`: `Use when the person says something new, changes their mind, or a fact conflicts with the brain-kit vault, and it should be written down now as a dated entry in the vault log without compiling notes.`
- `ask`: `Use when the person asks a question the brain-kit vault may answer: read from the root index down, only the notes needed, and answer with the vault's closed uncertainty states.`
- `lint`: `Use when brain-kit validate or lint reported problems, or the person asks what a lint rule means and how to fix what it found.`
- `review-stale`: `Use when notes in the brain-kit vault are past their stale_after date, or the person asks to review what may be out of date.`
- `approve`: `Use after the owner merged a brain-kit pull request and wants the merged notes stamped verified.`

**Body requirements**, both languages, each body under 120 lines, second person, plain prose and short numbered steps, placeholders only from Task 3's list, `{{kit}}` for every engine call:

- `setup`: check `node --version` (24 or newer), `git`, `gh auth status`; `{{kit}} doctor`; ask one question at a time whether this is a new vault or an existing one; new: `{{kit}} init <dir>`; existing: `{{kit}} init --adopt <dir>`, and explain that it writes only the configuration and manifest; recommend a private repository with `gh repo create --private` and explain why (notes about people); `{{kit}} machine register`; finish with `{{kit}} doctor` and say which checks still fail. Never enter a credential for the person; never run `gh auth login` for them.
- `curate-session`: `{{kit}} sync`; list what this session learned; append entries under today's heading (`## {{today_iso}}`) in `{{log}}`, most recent first, each starting with `{{capture_marker}}`; compile into new or changed notes with `generated: { by: {{agent}}, at: <ISO datetime with offset> }`; never write `verified`; `{{kit}} validate` and `{{kit}} lint`, fix until both pass; `{{kit}} propose --only <paths> "<summary>"` naming only this session's files; confirm the pull request base is the default branch before giving the link; never merge.
- `capture`: only the log entry (same heading and marker rules), nothing else; say what was captured in one line.
- `ask`: start at the vault's `index.md`; follow links to the notes needed and only those; weigh `verified`, `stale_after`, `sources`; when more than three notes are needed, delegate the reading to the `vault-reader` subagent; answer with the three closed states when the answer is not in hand: not verified (a source it could not read), not found (looked and found nothing), don't know (not in the vault). Never invent.
- `lint`: run `{{kit}} lint --json` and `{{kit}} validate --json`; explain each finding by rule id; for `secrets`, stop and say to rotate the credential and remove it from history, pointing at the vault's `SECURITY.md`, and never print the matched value.
- `review-stale`: `{{kit}} validate --json`, take the notes past `stale_after`; for each, read it and its sources, update what changed, re-stamp `generated.at` and `stale_after` by the vault's `stale_policy`; propose with `--only`.
- `approve`: this is the owner's command, never the agent's on its own work: confirm the person is the owner and the pull request is merged, then `{{kit}} verify --pr <number>` and show the push command it prints; never push for them.

**Agent** `agents/vault-reader.md`:

```markdown
---
name: vault-reader
description: Read-only reader for a brain-kit vault. Use to read several notes from the vault index down and return a short answer with the paths it relied on, without loading the whole vault.
tools: Read, Grep, Glob
---
```

Body in English (agent bodies are not rendered by the engine): start at `index.md`; follow links; never load the whole vault; never read a path the vault's `AGENTS.md` or configuration marks as not to be read; answer in the language the question was asked in; return the answer, the paths read, and any note past `stale_after` or without `verified`; the three closed uncertainty states as in `ask`.

**Tests** (`test/plugin.test.mjs`): every directory under `skills/` has a SKILL.md whose frontmatter `name` equals the directory name, whose description is ASCII and starts with `Use when` or `Use at` or `Use after`, and whose only body line is the `!` line naming the same skill; the set of skill directories equals `SKILL_NAMES`; the agent file declares exactly `Read, Grep, Glob`; `prompt --check` exits 0. `test/parity.test.mjs`: the two packs carry the same `skills/*.md` set and the same placeholders per file. And, when `claude` is on PATH (skip otherwise, like the existing opt-in tests): `claude plugin validate --strict .` exits 0.

- [ ] **Step 1:** tests; run, see them fail.
- [ ] **Step 2:** write the 14 bodies, 7 SKILL.md, the agent; run the whole suite and `claude plugin validate --strict .`.
- [ ] **Step 3:** render every skill in both languages with `prompt skill` and read the output once end to end; fix any sentence that reads as translated rather than written.
- [ ] **Step 4:** commit `feat: seven skills and the read-only vault-reader subagent`.

### Task 5: eval cases

**Files:**
- Create: `evals/<skill>-<lang>/prompt.md` and `evals/<skill>-<lang>/graders/*.md` for the 7 skills and 2 languages (14 cases)
- Modify: `test/plugin.test.mjs`, `package.json` `files` (evals stay OUT of the npm package: do not add them)

Each case: `prompt.md` frontmatter `max_turns: 6`, `allowed_tools: [Read, Glob, Grep, Skill]`, `runs: 1`, `tags: [<skill>, <lang>]`; body is a realistic request written as a person would type it, in that language, that should make the model pick the skill without naming it (for example, pt-BR capture: "anota aí que a Ana decidiu adiar o projeto X para outubro"). Graders: `graders/skill.md` with frontmatter `type: tool_used`, `tool: Skill`, `weight: 1`; and `graders/criteria.md` with `type: llm`, `weight: 1`, whose body says what a right response does for that skill (for capture: it proposes or writes one dated log entry and does not edit notes).

Tests: 14 case directories, one per skill and language; each has `prompt.md` and both graders; no body contains the skill's own name as a word (the prompt must trigger the skill, not name it); no body contains the blank template marker `TODO:`.

- [ ] **Step 1:** tests; run, see them fail.
- [ ] **Step 2:** write the 14 cases; run the suite.
- [ ] **Step 3:** commit `test: one plugin eval case per skill and language`.

### Task 6: the vault's documental Claude Code settings

**Files:**
- Create: `lang/pt-BR/vault/.claude/settings.json`, `lang/en/vault/.claude/settings.json`
- Modify: whatever `init` and `update` need so the file is seeded by `init` and recorded in the manifest as managed (check how the skeleton walk treats dot-directories: `.claude` must be copied, and `validate` and `lint` must not read it, which they already do not since dot entries are out of every walk); tests in `test/init.test.mjs`, `test/update.test.mjs`, `test/skeleton.test.mjs`.

Content, identical in both packs:

```json
{
  "extraKnownMarketplaces": {
    "brain-kit": {
      "source": { "source": "github", "repo": "aleckyann/brain-kit" }
    }
  },
  "enabledPlugins": {
    "brain-kit@brain-kit": true
  }
}
```

It is documental: it holds no permission, no hook and no path, so a clone of the vault asks the person to install the plugin from the marketplace, and nothing executes because of this file alone. `update` treats it like the other managed root files (replaced when untouched, offered as `.brain-kit-new` when edited). `init --adopt` does NOT write it (adopt writes only configuration and manifest).

- [ ] **Step 1:** tests: `init` writes it in both languages, it parses, the manifest records it as managed with a hash; `update` replaces an untouched copy and offers a new one beside an edited copy; `adopt` does not write it; a new vault still passes `validate` and `lint`.
- [ ] **Step 2:** run, see them fail; implement; run the whole suite.
- [ ] **Step 3:** commit `feat: init seeds documental Claude Code settings that point at the plugin`.

## After the last task (controller)

- Final whole-slice review on the most capable model; one fix dispatch; adjudicate residuals.
- One manual eval run by the controller: `claude plugin eval . --case capture-pt-BR --runs 1 --no-publish --max-cost-usd 1`, result recorded in the ledger (pass or not, never assumed).
- A live check with `claude --plugin-dir .` in a scratch vault: SessionStart line appears; a new file then Stop asks for curation; a dirty non-vault repository ends without being asked.
- README (both) and CHANGELOG: slices 1C and 1E done, the plugin surface described; phase 1 complete.
