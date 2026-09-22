# Phase 1 slice D: init, adopt, update and doctor, opening with the gate that ships

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a person who is not the maintainer can run one command and get a vault that validates, lints clean with every rule at error, and carries a push gate that scans what a push actually sends; and a person with an existing vault can adopt the kit without a single content file being touched.

**Architecture:** the push enumeration that the maintainer's gate spent five review rounds hardening moves, unchanged, into one script the engine ships, behind one new command both gates call; the adopter's template becomes a thin caller of it. Then four commands on top of what slices A and B built: `init` writes a vault from a language pack, `init --adopt` writes only configuration and state for an existing one, `update` refreshes managed files by checksum without ever overwriting an edit, and `doctor` reports the machine's readiness by named check.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`, bash 3.2 for the shell halves.

**Spec:** the approved design, private to the maintainer: its command table (rows `init`, `update`, `doctor`), its section on the vault `init` generates, its configuration section, and its phase 1 row. Slices A and B are landed; the repository is at `2272c84` with 930 tests. The previous plan, `docs/superpowers/plans/2026-09-18-phase-1b-lint-and-leak-scanner.md`, ends with the precondition this slice opens with and the method rules it inherits.

## Global Constraints

Every task's requirements implicitly include this section. Each line was paid for.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync` with an argument array.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key; a test enforces parity. A finding carries a `messageKey` and `params`, never a formed sentence.
- Files under `src/` and `bin/` are pure ASCII. The em dash (U+2014) is banned everywhere in the repository, and a test walks the whole tree for it. Never type a unicode escape into file content; build the character at runtime. The Portuguese language pack is the one place accented text belongs, and its new vault skeleton joins the existing exclusions of the no-Portuguese test by name, with a comment saying why.
- No household data: no company, colleague or client name, no real e-mail, no real personal handle, no absolute path naming anyone's machine, in source, test, fixture, comment, language pack, or anything a command writes. Example data uses the fictional owner "Ana", `example.com` / `example.invalid`, and the actors `human:ana` and `brain-kit-curator/claude-opus-5-5`.
- Exit codes are fixed in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not inside a vault, `3` degraded, `4` required source unread, `69` unavailable, `75` postponed.
- The maintainer's pre-push gate is active and installed per clone. Never bypass it. If it refuses, report the refusal.
- **Never touch the private reference vault this kit is extracted from.** No task in this slice reads it, runs against it, or writes to it. The adopt parity test is written opt-in and is NOT run during this slice.
- Commit with the repository's configured identity. Never supply an identity on the command line or in the environment: a commit on the previous slice did, it carried an identity matching the maintainer's private pattern list, and the gate refused the real push on the author-identity channel.
- Commits use a conventional prefix and end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

Everything in the previous plan's section of the same name holds, with one ruling from its close that changes the cost: **clause-by-clause mutation is mandatory where a deleted clause could let something reach a remote, or let a run exit zero that should not**: the push gate, the scanner, the secrets rule, `init`'s refusal to overwrite, `update`'s refusal to overwrite an edit, and anything that decides an exit code. Everywhere else, message wording, output layout and report formatting, ordinary tests plus the two questions below are enough. The test for which side a clause is on: could this clause, deleted, let something reach a remote, destroy a person's file, or let a run exit zero that should not? If yes, mutate it. If no, test it and move on.

Establish a control at zero failures before any mutation, more than once. Verify each mutation changes behaviour before trusting a survivor. Derive the clause list from the code as it stands when the task ends, never from the brief.

**The two questions, asked of every task that touches a gate or a file a person owns:** what single edit makes this pass what it should refuse, or overwrite what it should keep, while the suite stays green? And what already gets through with no edit at all? Prove each answer with a real run.

**The recurring shape of this project**, found six times in slice B, twice inside code written by the round that found it: a command that succeeds while saying nothing, read as nothing to do; and its sharper form, a command that succeeds and answers about something other than what we are about to act on. Every task in this slice has a place where it can happen: an empty answer file, an empty directory listing, a manifest with no entries, a doctor check whose probe printed nothing.

**Build the adversarial shape of a category, which is usually its most common member.** The environment file is `.env`, not a file with "env" in its name; a vault path on a real machine has a space and an accented letter in it; a person's stdin is sometimes closed.

## Review Focus

The five inputs a person will meet that no single task's tests would exercise unless written down here. Each line names the owning task, which carries its test.

1. **A vault path with a space, an accented letter and a quote in it.** Real vaults live in folders like a localised desktop directory. `init`, the installed hook, `doctor` and the state directory must all work there, and nothing may split the path. Owner: Task 4, with a check in Task 7.
2. **A standard input that is closed, piped or not a terminal.** `init` asks questions one at a time; run from a script or CI it must never hang, and must name the first answer it still needs and exit `2`. Owner: Task 4.
3. **A directory that is not empty, is already a git repository, or is already a vault.** `init` without `--adopt` refuses all three and writes nothing; `init --adopt` refuses a directory that is not a vault shape it can read, and never writes into content. Owner: Tasks 4 and 5.
4. **A pushed branch whose own configuration removes a pattern.** The adopter's gate must still scan with the pattern, because the configuration is data a branch can change. Owner: Task 2.
5. **A managed file the person edited, and a manifest that is missing or unreadable.** `update` never overwrites an edit, and a manifest it cannot read is a refusal, never "nothing is managed". Owner: Task 6.

## What slices A and B established, which this slice reuses rather than reinvents

- `walkVault(root, config, { all: true })` is called ONCE per command and handed down. `findVaultRoot(startDir)` and `isVaultRoot` in `src/vault.mjs` decide what a vault is: a directory holding `brain-kit.config.json` and a root `index.md`.
- `loadConfig` and `validateConfig` in `src/config.mjs` read and check the configuration against `schema/config.schema.json`; `findMachineOnlyKeys` rejects a machine key in the versioned configuration; `validateMachine` checks `machine.json` against `schema/machine.schema.json`.
- `stateDirFor(vaultRoot, env)` and `ensureStateDir(dir)` in `src/state.mjs` place the per-vault state directory, mode 0700, honouring `BRAIN_KIT_STATE_DIR` and `XDG_STATE_HOME`.
- `run` and `runOrThrow` in `src/exec.mjs` are the only way to spawn a process.
- `loadPatterns({ env, configPatterns })` in `src/leak.mjs` already accepts configured patterns beside the generic shapes; `scanText` is the one matcher; `decodeBytes` in `src/io.mjs` is the one decoder.
- `runScanBlobs(argv, io)` in `src/commands/scan-blobs.mjs` consumes the versioned record stream (`RECORD_PROTOCOL`) that `.githooks/pre-push` builds, and scans seven channels.
- `createTranslator` in `src/lang.mjs` and the two message packs; `SUPPORTED_LANGS` is `en` and `pt-BR`.
- The fixture configurations `test/fixtures/config/valid.json` and `valid-pt-BR.json` are complete, schema-valid configurations for the two languages. They are TEST fixtures carrying the example owner; the defaults this slice ships are separate files and must not carry "Ana".

## Out of scope, and where each item goes

- `machine show|set|register` and `verify`: slice C, beside `propose`, because both belong to the git loop.
- `.claude/settings.json`, the plugin skills and hooks, the CI workflow template with a pinned engine reference: slice E. The CI template needs a published reference to pin, which does not exist yet.
- `.brain-kit/prompts/` and `.brain-kit/pr-body.md`: phase 2 and slice C, which own the prompts and the pull request body.
- `doctor` checks for the curator, the connectors, the CLI stub and the scheduler: phases 2 and 3, which own those subsystems.

## File Structure

| File | Responsibility |
|---|---|
| `src/push/records.sh` | The push enumeration, moved unchanged from `.githooks/pre-push`: reads the pre-push reference lines, asks git what the push carries, writes the record stream. Shipped with the engine. |
| `src/commands/push-gate.mjs` | `brain-kit push-gate <remote-name> <remote-url> --patterns personal\|config`: runs `records.sh`, feeds its stream to the scanner in-process, one verdict. |
| `.githooks/pre-push` | Keeps its install, snapshot and staleness checks; its enumeration and scan become one `push-gate --patterns personal` call. |
| `templates/githooks/pre-push` | Validate, lint, then `push-gate --patterns config`; resolves `brain-kit` from `PATH` only. |
| `lang/<code>/vault/` | The skeleton of a new vault in that language: root files, collection and domain directories with their indexes, the log, note templates. |
| `lang/<code>/config.defaults.json` | The default configuration for that language, schema-valid once the answers are merged in, carrying no example owner. |
| `src/init/answers.mjs` | The questions, their defaults, and reading answers one at a time from a terminal, from `--from-answers <file>`, or from `--yes`. |
| `src/init/skeleton.mjs` | Copy a language skeleton into a directory, write the configuration, `.gitignore`, the hook and the manifest, never overwriting. |
| `src/init/adopt.mjs` | Infer a configuration from an existing vault's folders, frontmatter and tables, without writing into content. |
| `src/manifest.mjs` | Read and write `.brain-kit/manifest.json`: each managed or seeded file with its sha256 and its class. |
| `src/commands/init.mjs`, `src/commands/update.mjs`, `src/commands/doctor.mjs` | The three commands. |
| `src/doctor/checks.mjs` | One function per named check, each returning `{ id, status: ok\|warn\|fail, messageKey, params }`. |

---

### Task 1: One push enumeration, behind one command

**Files:**
- Create: `src/push/records.sh`, `src/commands/push-gate.mjs`, `test/push-gate.test.mjs`
- Modify: `.githooks/pre-push`, `src/cli.mjs`, `.githooks/install-gate` (the snapshot must include `src/push/`), `package.json` `files` if needed so the script ships
- Test: `test/pre-push-hook.test.mjs` must pass UNCHANGED

**Interfaces:**
- Consumes: `runScanBlobs`'s parsing and scanning, factored so it can take a stream and a pattern set rather than reading `process.stdin` and the personal file itself.
- Produces: `runPushGate(argv, io, t)`, routed as `brain-kit push-gate`. Arguments: `<remote-name> <remote-url> --patterns personal|config`. Reads the pre-push reference lines on stdin. With `personal`, patterns come from `loadPatterns({ env })` exactly as today. With `config`, see Task 2. Exit `0` when nothing matched, `1` otherwise, and every refusal says why.

The shell enumeration in `.githooks/pre-push` is the most-reviewed code in this repository: five rounds, each closing a hole the previous one opened. This task moves it and changes NOTHING about what it does. The adopter's gate needs the same knowledge, and a second copy is the defect slice B's final review named: "the same knowledge lives twice, and one copy is the one someone forgets".

- [ ] **Step 1: Write the failing test.** `test/push-gate.test.mjs` drives `brain-kit push-gate` directly with a throwaway repository and bare remote, stdin fed the same reference lines git would feed a hook. It must assert: a clean push exits 0 and prints the "ran" line; a push carrying a matching blob exits 1 naming the CONTENT channel; the two argument errors (missing remote, unknown `--patterns` value) exit 2; and the command, run from a directory that is not a repository, exits 2 and says so.
- [ ] **Step 2: Watch it fail** with `node --test test/push-gate.test.mjs`: the command does not exist.
- [ ] **Step 3: Move the enumeration.** Cut the enumeration section of `.githooks/pre-push`, from where it reads the reference lines to where it hands the stream to the scanner, into `src/push/records.sh`, byte for byte except for how it receives its two arguments and where it writes. Keep every comment that explains a guard; they carry the incidents. `push-gate.mjs` runs it with `spawnSync('bash', [recordsPath, remoteName, remoteUrl], { input: stdinBytes })`, reads its status FIRST, refuses on any non-zero status, and only then parses the stream.
- [ ] **Step 4: Make the maintainer hook a caller.** `.githooks/pre-push` keeps its install-location check, its snapshot and staleness lines and its EXIT trap, and replaces its enumeration and scan with one `node "$ENGINE_DIR/bin/brain-kit.mjs" push-gate "$1" "$2" --patterns personal`, its status read and propagated. `install-gate` copies `src/push/` into the snapshot; the install refuses if the script is missing.
- [ ] **Step 5: Prove it is the same gate.** Run `test/pre-push-hook.test.mjs` with no edit to it: every test passes. A test that has to change is a behaviour change and needs a line in the report saying which and why.
- [ ] **Step 6: Trust boundary, in the report, in words.** Who can author `records.sh` as the maintainer's gate runs it: whoever can write the installed snapshot, who already has the bypass flag. Say it, and confirm by pushing a branch that rewrites `src/push/records.sh` to exit 0 with no records: the push must still be refused for a matching blob, because the hook runs the snapshot's copy.
- [ ] **Step 7: Mutation, mandatory here.** Every branch of `push-gate.mjs` and every status read added in the hook.
- [ ] **Step 8: Commit** with prefix `refactor:`.

---

### Task 2: The adopter's gate scans what the push carries

**Files:**
- Modify: `src/commands/push-gate.mjs`, `templates/githooks/pre-push`, `SECURITY.md` (only the lines about the template), `README.md` and `README.pt-BR.md` (only the Security section's sentence about the template)
- Test: `test/pre-push-template.test.mjs`, `test/push-gate.test.mjs`, `test/package-self-scan.test.mjs` (new)

**Interfaces:**
- Consumes: `runPushGate` from Task 1, `loadConfig`, `findVaultRoot`.
- Produces: `--patterns config`, whose pattern set is defined below; a template hook with three steps (validate, lint, push-gate) and the agent guard.

**Which configuration supplies the patterns, ruled here because a branch can change it.** The configuration is data, and a pushed branch can delete a pattern from it. So `--patterns config` uses the generic shapes plus the UNION of `privacy.secret_patterns` from the working tree's configuration and from the configuration at the default branch as this repository knows it (`refs/remotes/<remote>/HEAD`, resolved, read with `git show`). The default branch is what a human merged; the working tree is what is about to be committed. A union can only over-include, which is this project's stated direction. When the remote's default branch cannot be resolved, the gate says so on one line and scans with the working tree's patterns alone. A branch's own configuration is never the only source.

- [ ] **Step 1: Write the failing tests.** In `test/pre-push-template.test.mjs`, each a real push of a throwaway vault to its own bare remote, with `brain-kit` on `PATH` through a shim to this checkout:
  - a credential committed and then deleted: the push of both commits is refused, and the remote never receives them;
  - a credential in the tip commit hidden by an uncommitted edit that removes it from the working tree: refused;
  - pushing a branch other than the one checked out, carrying a credential: refused;
  - a note whose FILE NAME matches a configured pattern: refused on the PATH channel;
  - a commit message carrying a configured pattern: refused;
  - a branch whose own configuration deletes the pattern it then violates: refused;
  - a clean vault pushes, and the hook prints the gate's "ran" line;
  - `brain-kit` absent from `PATH`: refused with a message naming `PATH` and never mentioning installing into the vault.
- [ ] **Step 2: Watch them fail** with `node --test test/pre-push-template.test.mjs`.
- [ ] **Step 3: Implement.** `--patterns config` in `push-gate.mjs` per the ruling above. The template runs `brain-kit validate`, then `brain-kit lint --base all`, then `brain-kit push-gate "$1" "$2" --patterns config`, each status read, then the agent guard as it stands. `brain-kit` resolves from `PATH` only: the vault carries no package, by the design's own rule, so the `node_modules/.bin` lookup and its "install it as a dependency of this vault" message go.
- [ ] **Step 4: The shipped package must not match its own shapes.** `test/package-self-scan.test.mjs` lists the files `npm pack --dry-run --json` would ship and scans each with `loadPatterns({})` and `scanText`, asserting zero matches. Fix whatever it finds in the shipped files, never by exempting them. This is the false refusal slice B measured: a vault that ran `npm install` without ignoring `node_modules/` was told to rotate five credentials that do not exist.
- [ ] **Step 5: Rewrite the template header's limits paragraph.** It currently says the gate checks the working tree and never the pushed commits. After this task that is false; say what is now true, and keep what remains true: compressed content, a name split across lines, decomposed Unicode, and the bypass flag.
- [ ] **Step 6: Mutation, mandatory here.** Every clause of the pattern-set union, the `PATH` resolution and every status the template reads.
- [ ] **Step 7: The two questions, of this gate, proved by push.**
- [ ] **Step 8: Commit** with prefix `fix:`.

---

### Task 3: A vault skeleton and default configuration per language

**Files:**
- Create: `lang/en/vault/` and `lang/pt-BR/vault/`, `lang/en/config.defaults.json` and `lang/pt-BR/config.defaults.json`
- Modify: `test/no-portuguese.test.mjs` (exclude `lang/pt-BR/vault/` and `lang/pt-BR/config.defaults.json` by name, with the reason), `test/lang.test.mjs` (parity extends to the skeletons)
- Test: `test/skeleton.test.mjs` (new)

**Interfaces:**
- Produces: for each language, a directory tree and a defaults file that Task 4 copies and completes. The defaults file is a configuration with every key the schema requires, and the owner, vault and actor fields left as the placeholders Task 4 replaces.

The skeleton, following the design's section on the generated vault, with folder names from the language's own taxonomy:

| Role | `en` | `pt-BR` |
|---|---|---|
| core domain | `core/` | `nucleo/` |
| people collection | `people/` | `pessoas/` |
| organisations | `organizations/` | `organizacoes/` |
| projects | `projects/` | `projetos/` |
| decisions | `decisions/` | `decisoes/` |
| reflections | `reflections/` | `reflexoes/` |
| books | `references/books/` | `referencias/livros/` |
| follow-ups and promises | `pending/` | `pendencias/` |
| memory and log | `memory/log.md` | `memoria/log.md` |
| attachments | `attachments/` | `anexos/` |
| note templates | `templates/` | `templates/` |

Root files: `index.md` (linking every first-level directory, carrying `okf_version` as section 8 of the format allows), `AGENTS.md` (the agent's contract: read by index, capture in the log, propose by pull request, never write `verified`), `CLAUDE.md` (a short pointer to `AGENTS.md`), `CONVENTIONS.md`, `SECURITY.md` (third-party data, removal on request, what to do if a secret enters). Each directory holds an `index.md`; `core/` holds skeleton notes for identity, values, guidelines, decision frameworks and a weekly rhythm with an empty table whose headings match the configuration's `columns`; `pending/` holds the follow-ups and promises files with their configured headings; `templates/` holds one template per collection.

- [ ] **Step 1: Write the failing test.** `test/skeleton.test.mjs`, for each language: copy the skeleton into a temporary directory with its defaults file completed by a fixed set of example answers, `git init` it, and assert that `brain-kit validate` exits 0 with no finding of any tier, and that `brain-kit lint --base all` exits 0 with EVERY rule set to `error` in the configuration. Also assert the two skeletons have the same roles, the same number of files per role, and the same column count per table.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Write the skeletons and the defaults.** The defaults are derived from the two fixture configurations, with the example owner removed, `privacy.secret_patterns` carrying the generic credential shapes only as literal prefixes where a regular expression would match itself, and every lint rule present.
- [ ] **Step 4: Watch it pass**, in both languages.
- [ ] **Step 5: Commit** with prefix `feat:`.

---

### Task 4: `init`

**Files:**
- Create: `src/init/answers.mjs`, `src/init/skeleton.mjs`, `src/manifest.mjs`, `src/commands/init.mjs`
- Modify: `src/cli.mjs`, both message packs
- Test: `test/init.test.mjs` (new), `test/manifest.test.mjs` (new)

**Interfaces:**
- Consumes: the skeletons and defaults from Task 3, `stateDirFor`, `ensureStateDir`, `validateConfig`, `validateMachine`, `runValidate`, `runLint`, `run`.
- Produces: `runInit(argv, io, t)`, routed as `brain-kit init [dir] [--lang en|pt-BR] [--yes] [--from-answers <file>]`. `readManifest(root) -> { files: [{ path, sha256, class: 'managed'|'seeded' }] }`, which THROWS when the file is missing or unreadable, and `writeManifest(root, manifest)`.

The questions, one at a time, in this order, each with its default shown: language; first name and handle; vault title; GitHub repository or "not yet"; confirm the repository will be private, warning that the people and personal directories require it; time zone. The design's further questions (transcript projects, calendars, meeting notes, briefing, company domain, cost cap) belong to the phases that own those subsystems and are not asked here.

What it writes into `<dir>`: the language skeleton; `brain-kit.config.json` from the defaults and the answers, validated before it is written; `.gitignore` with `node_modules/` and the machine-local classes, commented by class; `.githooks/pre-push` from the template; `.brain-kit/manifest.json` marking the hook and the root contract files `managed` and every note file `seeded`. Then `git init`, `core.hooksPath .githooks`, and one initial commit ONLY IF the answers say so, never by default, because the first commit is the person's. What it writes into the state directory: `machine.json` with `vault_id`, `canonical_path`, `claude_bin` resolved from `PATH` or the literal `claude` when absent, and the state paths, mode 0600. Last, it runs `validate` and `lint --base all` and exits with the worse of the two.

- [ ] **Step 1: Write the failing tests.** `test/init.test.mjs` must assert, each on a temporary directory:
  - with `--from-answers`, both languages produce a vault on which `validate` and `lint` exit 0, and the command exits 0;
  - a directory that is not empty, one that is already a repository, and one that is already a vault are each refused with exit 2, and NOTHING is written in any of them, checked by listing the directory before and after;
  - with stdin closed and no `--yes` or `--from-answers`, the command does not wait: it exits 2 within a second naming the first missing answer;
  - `--yes` uses every default and says so;
  - a target path containing a space, an accented letter and a single quote works end to end, including the installed hook refusing a push of a committed credential;
  - `machine.json` lands in the state directory with mode 0600, the state directory with mode 0700, and neither inside the vault;
  - the versioned configuration contains no machine-only key.
  `test/manifest.test.mjs` asserts the round trip, and that a missing, empty, non-JSON or schema-invalid manifest THROWS.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.** Refuse before writing: every precondition is checked first, then the writes happen, so a refusal never leaves half a vault. Reading answers from a terminal uses `node:readline` over `io.stdin`; when `io.stdin` is not a TTY and no answers were supplied, refuse immediately.
- [ ] **Step 4: Watch them pass.**
- [ ] **Step 5: Mutation, mandatory** on every refusal clause and the exit code, because a deleted refusal overwrites a person's directory.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 5: `init --adopt`

**Files:**
- Create: `src/init/adopt.mjs`
- Modify: `src/commands/init.mjs`, both message packs
- Test: `test/adopt.test.mjs` (new), `test/fixtures/adopt/` (a small fictional vault in each language, written from what a real vault looks like: an index per folder, frontmatter with `generated`, a `situacao`-style enum under a different English name, a table with configured headings, a log)

**Interfaces:**
- Consumes: `walkVault`, the frontmatter readers, `validateConfig`, the manifest writer.
- Produces: `inferConfig(root, { lang }) -> { config, notes: [messageKey...] }`, where `notes` lists every inference the person should confirm; `init --adopt [dir]`.

What adopt infers: collections and domains from the first-level folders and their notes' `type`; each enum-looking extension from the distinct values it finds, per type; the column headings of every table in a file that has one; the stale policy from existing `stale_after` offsets when they are consistent, and the defaults otherwise; `validate.stale_after_format` as `date` when the vault writes plain dates. What it writes: the configuration, the manifest (every existing file `seeded`), the state directory and `machine.json`. What it never does: create, edit, rename or delete a content file, write the hook, or run `git` in a way that changes the repository.

- [ ] **Step 1: Write the failing tests.** For each fixture: adopt it in a copy; assert the only new paths are `brain-kit.config.json` and `.brain-kit/manifest.json` inside the vault, byte-comparing every pre-existing file before and after; assert the inferred configuration is schema-valid; assert `validate` on the adopted copy reports exactly the findings the fixture was built to contain; assert a directory with no `index.md`, and a directory that is already adopted, are refused with exit 2 and nothing written.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.** Print every entry of `notes`, because an inference a person never sees is a decision made for them.
- [ ] **Step 4: Write the opt-in parity test and do NOT run it.** Beside the existing opt-in parity test from slice A, gated by the same environment variable, a test that adopts a COPY of the vault the variable names and compares the adopted verdict with the recorded one. It never writes to the vault it names. It is skipped in every run of this slice.
- [ ] **Step 5: Commit** with prefix `feat:`.

---

### Task 6: `update`

**Files:**
- Create: `src/commands/update.mjs`
- Modify: `src/cli.mjs`, both message packs
- Test: `test/update.test.mjs` (new)

**Interfaces:**
- Consumes: `readManifest`, `writeManifest`, the language skeleton.
- Produces: `brain-kit update [--check]`.

The rule, from the design: a `managed` file whose current sha256 equals the manifest's is rewritten from the current kit and its checksum updated; a `managed` file the person edited is left alone and the new version is written beside it as `<name>.brain-kit-new`, named in the output; a `seeded` file is never touched; a file the manifest names that no longer exists is reported and not recreated. `--check` writes nothing and exits 1 when anything would change.

- [ ] **Step 1: Write the failing tests:** an untouched managed file is refreshed; an edited managed file keeps its bytes and gets a `.brain-kit-new` beside it; a seeded file is untouched even when the kit's version differs; a deleted managed file is reported, not recreated; `--check` writes nothing and exits 1 when a change is pending, 0 otherwise; a missing or unreadable manifest refuses with exit 1 and writes nothing, never treating it as "nothing is managed"; an existing `.brain-kit-new` is not silently overwritten.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Watch them pass.**
- [ ] **Step 5: Mutation, mandatory** on every clause deciding whether a file is written.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 7: `doctor`, the phase 1 checks

**Files:**
- Create: `src/doctor/checks.mjs`, `src/commands/doctor.mjs`
- Modify: `src/cli.mjs`, both message packs
- Test: `test/doctor.test.mjs` (new)

**Interfaces:**
- Produces: `brain-kit doctor [dir] [--json] [--only <id,...>]`. Each check returns `{ id, status, messageKey, params }`. Exit 0 when every check is `ok` or `warn`, 1 when any is `fail`.

The checks for this phase, each named by what it prevents:

| id | fail or warn when |
|---|---|
| `node-version` | fail below 24 |
| `git-present` | fail when `git` is absent |
| `default-branch-known` | warn when `origin/HEAD` is unset, naming `git remote set-head origin --auto` |
| `hooks-path` | fail when `core.hooksPath` does not point at the vault's hook, or the hook is absent: a clone with no gate |
| `config-valid` | fail when the configuration is invalid or carries a machine-only key |
| `machine-valid` | fail when `machine.json` is missing or invalid; warn when `canonical_path` differs from the vault's real path |
| `state-dir-mode` | fail when the state directory is not 0700 or `machine.json` not 0600 |
| `kit-version` | warn when the configuration's `kit_version` differs from the running engine's |
| `gh-present` | warn when `gh` is absent, because `propose` will need it |
| `claude-present` | warn when the configured `claude_bin` does not resolve |
| `gitignore-node-modules` | warn when `node_modules/` is not ignored, naming the false refusal it causes |

- [ ] **Step 1: Write the failing tests,** each check driven into each of its states with a controlled `PATH` and throwaway repositories; plus: a vault whose path has a space and an accented letter; `--json` output that is one parseable object; and a probe that exits 0 printing nothing is never reported `ok` without proof, which is the recurring shape.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Watch them pass.**
- [ ] **Step 5: Commit** with prefix `feat:`.

---

## After the last task

The final whole-slice review runs on the most capable model available, over the whole range from `2272c84`, with the two gates named as two, and with this slice's criterion from the design's phase 1 row in front of it: `init` produces a vault that passes `validate` and `lint` with every rule at error, in both languages; adopting an existing vault writes nothing into its content; and the gate that `init` installs refuses a credential that reaches a commit, whether or not the working tree still shows it.
