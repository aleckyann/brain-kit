# Phase 5a: what a vault migrating from a legacy setup needs

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a vault that already runs its own scripts (a date file as its watermark, a `flock` lock shared by a scheduled job and a Stop hook, no cost cap) can move to brain-kit without losing a day, without two writers in one tree during the switch, and without the kit imposing a limit its owner never set.

**Architecture:** three small, independent additions. (1) `brain-kit watermark import` reads a legacy watermark file and writes its day as the last day swept for the chosen sources. (2) A bridge to a legacy lock: `machine.json` `paths.legacy_lock` makes every kit writer also hold a kernel `flock(2)` on that file, and makes the Stop hook release while either lock is held. (3) `curate.budget_usd: null` means no cap.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`; util-linux `flock(1)` for the bridge (Linux; elsewhere the bridge reports itself unavailable).

**Spec:** the maintainer's private migration runbook for phase 5 (decisions R5-2, R5-6, R5-7) and the approved design's `watermark import` (planned since phase 2). Phase 4 is on `main` at `306c0eb`.

## Global Constraints

The phase 4 plan's Global Constraints apply verbatim (docs/superpowers/plans/2026-09-25-phase-4-morning-briefing.md, section "Global Constraints"), including: zero dependencies; argv arrays, never a shell string; git environment stripped; every user-facing string in both language packs; ASCII in src/bin/hooks/skills/agents/templates; no em dash; no household data, example names only Ana and example.com; human dates DD/MM/YYYY; no limit the maintainer did not ask for; tests never call the real claude or gh; BRAIN_KIT_STATE_DIR in scratch in every test and run; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push.

## How work is proven here

Clause-by-clause mutation is mandatory where a deleted clause could advance a watermark past a day nobody read, let two writers into one tree, or run a round with a cap the owner did not set. Everywhere else, ordinary tests plus the two questions (what single edit breaks the guarantee with the suite green; what already breaks it with no edit).

---

### Task 1: `brain-kit watermark import`

**Files:** Modify `src/commands/watermark.mjs`, both `lang/*/messages.json` (and `cli.usage`), tests in `test/watermark.test.mjs` (or the file that tests the watermark command today).

**Interface:** `brain-kit watermark import --from <file> [--sources <id,id,...>] [dir]`.
- The file must hold exactly one line `YYYY-MM-DD`, with or without a final newline (LF or CRLF); anything else (empty, two lines, other text, an unreal date, a day after yesterday in the vault's time zone) is refused with exit 2, quoting what was read (first 80 characters) and changing nothing.
- `--sources` defaults to every enabled source; a named source that is not enabled is refused (exit 2) before anything is written.
- It writes through exactly the same path as `watermark set` (the vault lock, the same validation, the same file), one source after another, and prints one line per source with the day written (DD/MM/YYYY) and the previous value (or "none").
- It never modifies, moves or deletes the file it reads (test: same bytes and mtime after the import).
- Importing the same file twice is idempotent (second run prints "unchanged" per source).

- [ ] Tests for every case above in both languages; implement; mutation over the refusal clauses and the no-write-before-validation order; commit `feat: watermark import reads a legacy watermark file into the chosen sources`.

### Task 2: the bridge to a legacy lock

**Files:** Modify `schema/machine.schema.json`, `src/commands/machine.mjs` (set/show), the vault-lock acquisition path (`src/guards/lock.mjs` and whatever entry point every writing command goes through), the Stop hook (`src/hooks/*`), `src/doctor/checks.mjs`, both `messages.json`, `docs/scheduling.md` (a short section "Moving from a legacy lock"), tests.

**Behaviour:**
- `machine.json` gains optional `paths.legacy_lock`, an absolute path; `brain-kit machine set paths.legacy_lock <abs path>` and `... null` set and clear it; a relative path is refused.
- When it is set, every command that takes the vault lock also holds an exclusive kernel `flock(2)` on that file for its whole lifetime, taken WITHOUT waiting, and compatible with `flock -n` from bash on the same file (the legacy scheduled job holds it that way). Direction for the implementation: re-exec the command under util-linux `flock -n -E <code> <file> -- <node> <kit> <args>` with an environment marker that prevents a second re-exec, so the kernel releases the lock exactly when the command exits, crash included. A legacy lock that is held is treated exactly like the vault lock being held: the same exit code and message shape the command uses today for a held lock, naming the legacy file.
- The kit never creates the legacy file beyond what opening it for `flock` requires and never deletes it.
- The Stop hook, before deciding to block, probes the legacy lock without waiting (e.g. `flock -n -s <file> true`); held means release, as it already does for the vault lock.
- doctor: a check that says the bridge is off, on and working, or on but unusable (no `flock` binary, the file's directory missing, not Linux), never failing a vault that has no bridge.
- A curate round (the process that joins the round lock) holds the legacy lock for the round; a `propose` joined to the round does not try to take it a second time.

- [ ] Tests with a real second process (`bash -c 'exec 9>>file; flock -n 9; sleep ...'`, killed at the end of each test, never left running) holding the file: a writer refuses with the held-lock outcome; the hook releases; with the holder gone the writer proceeds and the file stays; the bridge off changes nothing; re-exec happens once. Mutation over the held-means-held clause, the no-wait clause and the hook release. Commit `feat: a bridge to a legacy flock lock for vaults moving to the kit`.

### Task 3: `curate.budget_usd: null` means no cap

**Files:** Modify `schema/config.schema.json`, `src/commands/curate.mjs` and the harness that builds the argv, `src/doctor/checks.mjs` if it reports the cap, both `messages.json`, `docs/config.md` (or wherever the key is documented), tests.

**Behaviour:** the schema accepts a non-negative number or `null`; a number passes `--max-budget-usd <n>` as today; `null` passes no budget flag at all; an absent key keeps today's default (the pack default, 5, from the approved plan); the round report and doctor say "no cap" for `null`.

- [ ] Tests: argv with a number, with `null`, with the key absent; schema accepts null and refuses a negative or a string; doctor and the report wording in both languages. Commit `feat: curate.budget_usd null runs a round with no cost cap`.

## After the last task (controller)

Final review of the three tasks together, one fix dispatch, then the tag `v0.1.0-rc.1` (annotated) on the reviewed commit, pushed, for the reference vault to install from.
