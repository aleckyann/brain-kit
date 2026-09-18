# brain-kit Phase 1A: vault core and the validator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the engine to find a vault, walk it safely, read its frontmatter, and judge it against two separate rulers, so that `brain-kit validate` gives the same verdict the original vault's validator gives, with the known defects of that validator fixed.

**Architecture:** Four foundation modules (`exec`, `state`, `vault`, `frontmatter`) plus one command (`validate`). The spec ruler is fixed in code and follows the Open Knowledge Format; the house ruler is read from the vault's own config, so an adopter can be as strict as they like without editing the engine. Everything the validator learns here is reused by lint, propose, init and doctor in the later slices of Phase 1.

**Tech Stack:** Node.js >= 24, ESM, zero runtime dependencies, `node:test`.

**Spec:** the approved design at `/home/aleck/.claude/plans/ultracode-ao-mostrar-o-hazy-rain.md` (private to the maintainer), sections "Arquitetura do brain-kit" and "Fases de implementação", phase 1. Phase 1 is split into slices because one plan cannot carry it at usable quality; this is slice A. The phase's done-criteria are met only when all slices land.

**Phase 1 slices, for orientation (only A is planned here):**
- **1A (this plan):** vault core and `validate`.
- **1B:** `lint` (columns, orphans, index, tables, style, secrets, privacy, attribution) and the leak scanner moved from bash to Node, per the ruling carried out of Phase 0.
- **1C:** the git loop: `snapshot`, `sync`, `propose`, `hook stop`, `hook session-start`, the pre-push template.
- **1D:** the generator and the doctor: `init` (with `--adopt`), `update`, `machine`, `verify`, `doctor`, the vault skeleton in both languages.
- **1E:** the plugin surface: the seven skills, the `vault-reader` agent, `evals/`.

## Global Constraints

- Node `>=24`, ESM only, `"type": "module"`, `dependencies` and `devDependencies` stay empty. A test already enforces this; do not weaken it.
- Never build shell command strings. Every external command goes through `execFileSync`/`spawnSync` with an argument array.
- Code, identifiers, comments and docs in English. User-facing strings come from `lang/<code>/messages.json`, pt-BR being the reference pack and `en` mirroring it key for key; a test enforces parity, and pt-BR carries no em dash (U+2014) and no emoji.
- Exit codes are fixed and already defined in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not inside a vault, `3` degraded, `4` required source unread, `69` unavailable, `75` postponed.
- No household data: no company, colleague or client names, no real e-mail addresses, no real personal handles. Fixtures use the fictional owner "Ana" and `example.com` / `example.invalid`, the placeholder actors `human:ana` and `brain-kit-curator/claude-opus-5`.
- Fixture TAXONOMY is English too, and this is not cosmetic. A fixture vault uses `people/`, `projects/`, `decisions/`, `pending/`, `core/`, `memory/`, `attachments/`, never the reference vault's own Portuguese folder names. The kit's claim is that the taxonomy is configuration, so a test suite written in one adopter's taxonomy quietly asserts the opposite, and every later fixture copies whatever the first one did. Exactly ONE fixture in the suite may use a non-English taxonomy, and it must carry a comment saying it exists to prove the walk and the rulers are taxonomy-agnostic, so the intent is legible rather than accidental.
- The maintainer's pre-push gate is active (`core.hooksPath=.githooks`) and scans every commit of a push. Never bypass it with `--no-verify`; if it refuses, report the refusal.
- Commits use a conventional prefix and end with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Do not push. The controller pushes and watches CI.
- Work in `/home/aleck/Área de trabalho/brain-kit`, branch `main`. Tasks 1 and 2 have landed; the suite is at 109 tests and must stay green.

## Facts established by the Phase 1 opening experiment (18/09/2026)

A throwaway plugin was loaded with `claude --plugin-dir` in a live session. These are measurements, not assumptions, and they bind the design:

- A hook command may invoke `node` directly; the polyglot wrapper is not required on Unix. It stays for Windows.
- `${CLAUDE_PLUGIN_ROOT}` is substituted both in hook commands and inside `SKILL.md` content.
- `${user_config.*}` is **not** substituted in a `SKILL.md` command line: it reaches the shell literally and the command fails. Skills must therefore never read plugin user config through a shell line.
- A plugin hook's environment carries `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` and the session id, but **no `CLAUDE_PLUGIN_OPTION_*`** when the value was never configured; a manifest `default` alone does not materialize one.
- Consequence for this slice: nothing the engine needs may come from plugin user config. The vault is resolved from the working directory and its own files, and machine facts come from `machine.json` in the state directory.

## Source being ported

The original vault's validator lives at `/home/aleck/Área de trabalho/brain/scripts/validate-okf.mjs`, 215 lines, and is the behavioural reference: read it before writing code. It is a single file that walks the tree, extracts frontmatter with a regular expression, and accumulates problems into named buckets, printing `[spec]` and `[casa]` separately. Port its behaviour, not its shape, and fix these four defects, each of which was found by review and is not to be reproduced:

1. `stale_after` is required to be a plain `YYYY-MM-DD` date under a `[spec]` label, while the canonical OKF specification asks for a datetime with an offset. A vault that follows the specification is failed by a ruler that claims to be the specification. Here, the format is a house rule with three settings and the spec ruler accepts both forms.
2. The placeholder exemption (a value containing `<`) is applied inside spec checks everywhere in the tree, so any note with an angle bracket in a dated field escapes validation. Here it applies only under the configured templates directory.
3. The ignored path `Claude outputs` is hard-coded. Here the always-ignored set is dot-entries and `node_modules`, and everything else comes from `validate.ignore_paths`.
4. The walk is shared with no other tool, so the graph visualiser and the migrations disagree with it about what belongs to the vault. Here the walk is one exported function and every later tool uses it.

## File Structure

| File | Responsibility |
|---|---|
| `src/exec.mjs` | Run an external command with an argument array; never a shell string. Returns `{ status, stdout, stderr }`, never throws on a non-zero status. |
| `src/state.mjs` | Resolve and create the per-vault state directory with restrictive permissions; know the names of the files that live there. |
| `src/vault.mjs` | Find the vault root from a directory (the sentinel), and walk it, applying the always-ignored set and the configured one. |
| `src/frontmatter.mjs` | Split a markdown file into frontmatter and body, and read the scalar and mapping shapes the format uses, declaring its own limits. |
| `src/rules/spec.mjs` | The Open Knowledge Format ruler. Fixed in code, not configurable. |
| `src/rules/house.mjs` | The house ruler, driven entirely by the `validate` and `frontmatter` sections of the vault config. |
| `src/commands/validate.mjs` | Orchestrate: load config, walk, run both rulers, report, choose the exit code. |
| `test/fixtures/vaults/*` | Small vaults on disk: one conforming, and one carrying a single violation per rule. |

Each task below produces a self-contained deliverable with its own tests.

---

### Task 1: Command runner and state directory

**Files:**
- Create: `src/exec.mjs`
- Create: `src/state.mjs`
- Test: `test/exec.test.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier slices.
- Produces: `run(command, args, options) -> { status, stdout, stderr }` and `runOrThrow(command, args, options)` from `src/exec.mjs`; `stateDirFor(vaultRoot, env)`, `ensureStateDir(dir)`, `STATE_FILES` from `src/state.mjs`.

- [ ] **Step 1: Write the failing tests**

`test/exec.test.mjs` must assert: a successful command returns status 0 with its stdout trimmed of nothing (byte for byte); a failing command returns its real status with stderr captured and does not throw; an argument containing a space, a quote, a dollar sign and a semicolon reaches the program as one single argument unchanged (run `node -e` with a script that prints `process.argv` as JSON, and compare); a command that does not exist returns a non-zero status with a readable message rather than throwing; `runOrThrow` throws on a non-zero status and the thrown error carries `status`, `stdout` and `stderr`.

`test/state.test.mjs` must assert: `stateDirFor` honours `BRAIN_KIT_STATE_DIR` when set; otherwise it derives a stable directory under the user's state home from the vault's absolute path, and two different vault paths never collide; the same vault path always yields the same directory; `ensureStateDir` creates it with mode `0700` and creates parents; calling it twice is harmless; `STATE_FILES` names every file the later slices will write (lock, watermark, last run, snapshot, log directory, questions log) so no other module invents a name.

- [ ] **Step 2: Run the tests and watch them fail** (`node --test test/exec.test.mjs test/state.test.mjs`), then write the two modules and make them pass.

Notes for the implementation: `run` wraps `spawnSync` with `encoding: 'utf8'` and merges nothing into the shell. The derived state directory should be readable by a human looking at it, so build it from the vault's directory name plus a short hash of its absolute path rather than the hash alone. Respect `XDG_STATE_HOME`, falling back to `~/.local/state`.

- [ ] **Step 3: Commit** with prefix `feat:` and the required trailer.

---

### Task 2: Vault sentinel and walk

**Files:**
- Create: `src/vault.mjs`
- Test: `test/vault.test.mjs`
- Create: `test/helpers/vault-fixture.mjs`

**Interfaces:**
- Consumes: `CONFIG_FILENAME`, `loadConfig`, `ConfigError` from `src/config.mjs` (already written in Phase 0).
- Produces: `findVaultRoot(startDir)`, `isVaultRoot(dir)`, `ALWAYS_IGNORED`, `walkVault(root, config)`, `relativePosix(root, file)` from `src/vault.mjs`; and a test helper `makeVault(spec)` that writes a temporary vault from a plain object and returns its path.

- [ ] **Step 1: Write the failing test and the helper**

The helper `makeVault({ files, config })` creates a temporary directory, writes `brain-kit.config.json` (starting from the valid fixture and applying an override object), writes each entry of `files` as a path relative to the root, creating parent directories, and returns the root. Tests use it so no test hand-rolls a vault.

`test/vault.test.mjs` must assert:
- `isVaultRoot` is true only when both the config file and a root `index.md` are present, and false when either is missing. The sentinel deliberately does not require `okf_version` in the index, because that is a house rule and not a precondition for the directory being a vault.
- `findVaultRoot` walks upward from a subdirectory and returns the root; from an unrelated directory it returns `null` rather than throwing.
- `findVaultRoot` stops at a filesystem boundary and never returns a directory above the user's home.
- `walkVault` returns every markdown file, as paths relative to the root using forward slashes, sorted, and never returns a directory.
- `walkVault` always skips entries whose name begins with a dot, and always skips `node_modules`, at any depth, whatever the configuration says. Prove it with a `.brain-kit/prompts/curate.md` inside the fixture: it must not appear.
- `walkVault` additionally skips every prefix listed in `validate.ignore_paths`, matching on the path relative to the root, and a configured prefix that does not exist is not an error.
- `walkVault` returns non-markdown files too when asked (`{ all: true }`), because the link checker must know that an attachment exists; by default it returns only `.md`.
- A symbolic link inside the vault is not followed out of the vault, and a link that points outside is skipped rather than read.

- [ ] **Step 2: Watch it fail, write the module, watch it pass.**

- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 3: Frontmatter reader

**Files:**
- Create: `src/frontmatter.mjs`
- Test: `test/frontmatter.test.mjs`

**Interfaces:**
- Produces: `splitFrontmatter(text) -> { frontmatter, body, hasFrontmatter }`, `readScalar(frontmatter, key)`, `readMapping(frontmatter, key)`, `readList(frontmatter, key)`, `readEntries(frontmatter, key)`, `PARSER_LIMITS` from `src/frontmatter.mjs`.

Every reader after `splitFrontmatter` takes the `frontmatter` STRING, never the whole file, so a key inside a fenced code block in the body is structurally invisible to them rather than filtered out.

Shapes measured in the reference vault on 18/09/2026, which the readers must handle because they are what real notes contain:
- `generated` and `verified` are inline mappings, `{ by: x, at: y }`, in 222 of 222 notes that carry them. Not one uses the indented block form.
- A mapping value is routinely unquoted AND contains a colon, because the format's actor syntax is `human:ana` and `brain-kit-curator/claude-opus-5`. Split each pair on its FIRST colon only.
- `sources` is a block list of mappings whose entries carry `resource` and optionally `id`, `title`, `author` and a quoted `description` containing commas, colons and accented text.

`readMapping` reads BOTH the inline brace form and the indented block form, and is named for the value it reads rather than for one of the two spellings. The reference vault never writes the block form, but an adopter writing a note by hand will, and a reader that silently returned nothing there would make Task 4's `generated-actor` rule report a missing `by` that is plainly present, which is worse than not checking at all.

This module is deliberately a regular-expression reader and not a YAML parser, because the engine ships with no dependencies. That choice has consequences, and the module must state them rather than hide them: `PARSER_LIMITS` is an exported array of one-line strings describing what it cannot see, and the validator prints it in its JSON output so a consumer is never misled about the depth of the check.

- [ ] **Step 1: Write the failing test.** It must assert:
- A file opening with `---` on its first line has its frontmatter split off, and the body excludes the closing delimiter.
- A file with no frontmatter reports `hasFrontmatter: false` and a body equal to the whole text.
- A `---` that appears later in the body, for example inside a fenced code block, is not treated as a frontmatter delimiter.
- `readScalar` reads a plain value, a quoted value, and a value containing a colon; it returns `null` for an absent key; it does not match a key that merely appears inside another line.
- `readMapping` reads `generated: { by: x, at: y }` into an object and tolerates extra spaces; reads the same key written as an indented block; reads an unquoted value containing a colon, with `verified: { by: human:ana, at: ... }` as the case that must pass; and keeps a quoted value containing a comma intact.
- `readList` reads both the bracketed inline form and the block form with hyphens.
- `readEntries` reads a block list of mappings, as `sources` uses, returning one object per entry.
- A key that appears inside a fenced code block in the body is never read as frontmatter.
- `PARSER_LIMITS` is non-empty, and every entry is a short sentence.

- [ ] **Step 2: Watch it fail, write the module, watch it pass.** When a shape is beyond the reader, it must return `undefined` and add nothing to `PARSER_LIMITS` at runtime; the limits are static and reviewed by a human.

- [ ] **Step 3: Commit** with prefix `feat:`.

---

### The ruler contract (binding on tasks 4, 5 and 6)

Both rulers share one signature, `run<X>Rules(files, context) -> Finding[]`, and both are handed the same two values by `validate`, which calls `walkVault` exactly once, with `{ all: true }`:

- `files` is the markdown subset of that single walk: sorted, relative to the root, forward slashes. It is what a rule iterates, and neither ruler filters or re-walks it.
- `context` is `{ root, config, all, readFile }`. `all` is the full walk including attachments, as a `Set`, so membership is a lookup and not a scan. `readFile(relPath)` returns the file's text and caches it, so a dozen rules reading one file cost one read.

**The reader's two absences, ratified in task 3 and binding here.** Every reader in `src/frontmatter.mjs` distinguishes them, and a rule that collapses them reports the wrong thing. `null` means the key is ABSENT, so a required-field rule reports a missing field. `undefined` means the key is PRESENT but written in a shape this deliberately-regular-expression reader cannot see, so a rule must NOT report it as missing: the field is on screen, and a human who sees the tool deny what they can read stops trusting the tool. Report that case against `PARSER_LIMITS`, naming the shape, so the message says it could not read this rather than that you did not write it.

`link-target-exists` resolves against `context.all`, never against `files`, which is the only reason the walk asks for everything. One walk, one truth: a second walk would let two halves of the same command disagree about what the vault contains, and that disagreement is defect 4, the one this slice exists to remove.

---

### Task 4: The specification ruler

**Files:**
- Create: `src/rules/spec.mjs`
- Test: `test/rules-spec.test.mjs`
- Create: `test/fixtures/vaults/` entries as needed by the tests

**Interfaces:**
- Consumes: `splitFrontmatter` and the readers from Task 3, plus the two arguments of the ruler contract below.

**The ruler contract (identical for tasks 4, 5 and 6, and binding on all three).** `validate` calls `walkVault(root, config, { all: true })` exactly ONCE and hands both rulers the same two arguments:
- `files`: the markdown subset of that single walk, sorted, relative to the root, forward slashes. A ruler iterates it and never filters or re-walks it.
- `context`: `{ root, config, all, readFile }`. `all` is the full walk including attachments, as a `Set`, so membership is a lookup and not a scan. `readFile(relPath)` returns a file's text and caches it, so a dozen rules reading one file cost one read.

**The reader's two absences, ratified in task 3 and binding here.** Every reader in `src/frontmatter.mjs` distinguishes them, and a rule that collapses them reports the wrong thing. `null` means the key is ABSENT, so a required-field rule reports a missing field. `undefined` means the key is PRESENT but written in a shape this deliberately-regular-expression reader cannot see, so a rule must NOT report it as missing: the field is on screen, and a human who sees the tool deny what they can read stops trusting the tool. Report that case against `PARSER_LIMITS`, naming the shape, so the message says it could not read this rather than that you did not write it.

`link-target-exists` resolves against `context.all`, never against `files`: that is the only reason the walk asks for everything. No rules module calls `walkVault` itself. One walk, one truth, because a second walk would let two halves of the same command disagree about what the vault contains, which is defect 4, the one this slice exists to remove.

- Produces: `SPEC_RULES` (an array of rule objects `{ id, section, check }`) and `runSpecRules(files, context) -> Finding[]`, where a `Finding` is `{ ruler: 'spec', id, section, file, line, message }`.

The rules, each with a stable English id, and each carrying the section of the format it comes from:

| id | What it requires |
|---|---|
| `type-required` | Every markdown file that is not a reserved filename has frontmatter with a non-empty `type`. |
| `index-no-frontmatter` | A file named `index.md` carries no frontmatter, except the root index, which may declare `okf_version` and nothing else. |
| `log-format` | The log file carries no frontmatter, its date headings are `## YYYY-MM-DD`, and those dates run from most recent to oldest. |
| `generated-actor` | When `generated` is present it has a non-empty `by`, and its `at`, when present, is an ISO 8601 datetime. |
| `verified-events` | When `verified` is present, every event carries both `by` and `at`. |
| `status-enum` | When `status` is present it is one of `draft`, `stable`, `deprecated`. |
| `stale-after-format` | When `stale_after` is present it is either a date or a datetime with an offset. Both are accepted here; narrowing to one is a house rule. |
| `sources-resource` | Every entry of `sources` carries a non-empty `resource`. |

- [ ] **Step 1: Write the failing test.** One fixture vault that passes every rule and reports nothing, and one focused fixture per rule that violates exactly that rule, asserting the finding's `id`, `file` and, where the rule is about a line, its `line`. Include the case that matters most: a note whose `stale_after` is a datetime with an offset must pass, because the original validator failed it.

- [ ] **Step 2: Watch it fail, write the module, watch it pass.** Rules are data, not a chain of conditionals: each is an object with an `id` and a `check`, and `runSpecRules` iterates. A rule must never throw on a malformed file; it reports a finding instead.

- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 5: The house ruler

**Files:**
- Create: `src/rules/house.mjs`
- Test: `test/rules-house.test.mjs`

**Interfaces:**
- Produces: `HOUSE_RULES` and `runHouseRules(files, context) -> Finding[]` with `ruler: 'house'`.

**The ruler contract (identical for tasks 4, 5 and 6, and binding on all three).** `validate` calls `walkVault(root, config, { all: true })` exactly ONCE and hands both rulers the same two arguments:
- `files`: the markdown subset of that single walk, sorted, relative to the root, forward slashes. A ruler iterates it and never filters or re-walks it.
- `context`: `{ root, config, all, readFile }`. `all` is the full walk including attachments, as a `Set`, so membership is a lookup and not a scan. `readFile(relPath)` returns a file's text and caches it, so a dozen rules reading one file cost one read.

**The reader's two absences, ratified in task 3 and binding here.** Every reader in `src/frontmatter.mjs` distinguishes them, and a rule that collapses them reports the wrong thing. `null` means the key is ABSENT, so a required-field rule reports a missing field. `undefined` means the key is PRESENT but written in a shape this deliberately-regular-expression reader cannot see, so a rule must NOT report it as missing: the field is on screen, and a human who sees the tool deny what they can read stops trusting the tool. Report that case against `PARSER_LIMITS`, naming the shape, so the message says it could not read this rather than that you did not write it.

`link-target-exists` resolves against `context.all`, never against `files`: that is the only reason the walk asks for everything. No rules module calls `walkVault` itself. One walk, one truth, because a second walk would let two halves of the same command disagree about what the vault contains, which is defect 4, the one this slice exists to remove.


Every rule reads its setting from the config; none is hard-coded. Defaults are the permissive ones, so a vault that configures nothing gets the specification and little else.

| id | Setting | What it requires |
|---|---|---|
| `required-fields` | `frontmatter.required` | Each named field is present and non-empty. |
| `forbidden-fields` | `frontmatter.forbidden` | None of the named fields is present. |
| `type-enum` | `frontmatter.type_enum` | When the list is non-null, `type` is one of its values. |
| `extension-fields` | `frontmatter.extensions` | A declared extension field holds a value of its declared kind, and an enum field holds one of its values, including the per-type form. |
| `link-style` | `validate.link_style` | Internal links in the body follow the configured form. Under `file-relative`, a link beginning with a slash is a finding, and the message says why: it is resolved against the host and not the repository, so it breaks where a human reviews the change. |
| `link-target-exists` | always on | Every internal link resolves to a file that exists, markdown or attachment. |
| `no-wikilinks` | `validate.wikilinks` | Double-bracket links are findings when set to forbid. |
| `root-okf-version` | `validate.require_root_okf_version` | The root index declares `okf_version`, and it equals the configured `okf_version`. |
| `stale-after-format` | `validate.stale_after_format` | Narrow the accepted form to `date`, to `datetime`, or accept both under `any`. |

Two behaviours the tests must pin down, because both were defects in the original:
- The placeholder exemption, configured as `validate.placeholder_pattern`, applies **only** to files under `taxonomy.templates_dir`. A note elsewhere with an angle bracket in a dated field is a finding.
- Code, fenced and inline, is excluded before links are read, so an example in documentation is never mistaken for an edge of the graph.

- [ ] **Step 1: Write the failing test,** one fixture per rule plus the two behaviours above, and one fixture proving that a vault with an empty `frontmatter.required` and `link_style: any` reports nothing from this ruler.

- [ ] **Step 2: Watch it fail, write the module, watch it pass.**

- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 6: Staleness report and the `validate` command

**Files:**
- Create: `src/commands/validate.mjs`
- Modify: `src/cli.mjs` (register the command)
- Modify: `lang/pt-BR/messages.json` and `lang/en/messages.json`
- Test: `test/validate.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: `brain-kit validate [dir] [--only-problems] [--json]`.

**The ruler contract (identical for tasks 4, 5 and 6, and binding on all three).** `validate` calls `walkVault(root, config, { all: true })` exactly ONCE and hands both rulers the same two arguments:
- `files`: the markdown subset of that single walk, sorted, relative to the root, forward slashes. A ruler iterates it and never filters or re-walks it.
- `context`: `{ root, config, all, readFile }`. `all` is the full walk including attachments, as a `Set`, so membership is a lookup and not a scan. `readFile(relPath)` returns a file's text and caches it, so a dozen rules reading one file cost one read.

**The reader's two absences, ratified in task 3 and binding here.** Every reader in `src/frontmatter.mjs` distinguishes them, and a rule that collapses them reports the wrong thing. `null` means the key is ABSENT, so a required-field rule reports a missing field. `undefined` means the key is PRESENT but written in a shape this deliberately-regular-expression reader cannot see, so a rule must NOT report it as missing: the field is on screen, and a human who sees the tool deny what they can read stops trusting the tool. Report that case against `PARSER_LIMITS`, naming the shape, so the message says it could not read this rather than that you did not write it.

`link-target-exists` resolves against `context.all`, never against `files`: that is the only reason the walk asks for everything. No rules module calls `walkVault` itself. One walk, one truth, because a second walk would let two halves of the same command disagree about what the vault contains, which is defect 4, the one this slice exists to remove.

This task is the side that BUILDS those two arguments, so it owns the single call.

Behaviour:
- Resolve the vault from the argument or the working directory. Outside a vault, exit `2` with a message naming what is missing, not a stack trace.
- Call `walkVault(root, config, { all: true })` exactly ONCE and build the two values of the ruler contract from it: the markdown subset as `files`, and the whole list as `context.all`. A test must assert the single call, by counting reads or by spying, because the rule it protects is invisible in the output when it is broken.
- Run both rulers. Print the spec findings and the house findings under separate headings, each finding as `path:line  id  message`, so the two rulers never blur into one verdict.
- Notes whose `stale_after` has passed are an informational report, printed after the findings and **never** affecting the exit code. A build that fails as time passes is a build people switch off.
- `--only-problems` prints only rules that have findings. `--json` prints one object with `findings`, `stale`, `counts`, `parserLimits` and the two ruler names, and prints nothing else on stdout.
- Exit `0` when there is no finding, `1` when there is at least one, `2` for usage or no vault.

- [ ] **Step 1: Write the failing test,** driving the real binary with `spawnSync`: a conforming vault exits 0 and says so; a vault with one spec and one house finding exits 1 and names both under their own headings; `--json` parses and carries the same counts; a vault with a note past its date exits 0 and lists it as informational; running outside a vault exits 2; `--only-problems` omits the clean rules.

- [ ] **Step 2: Watch it fail, write the command and the messages, watch it pass.** Message keys go in both packs; the parity test will fail if you forget one.

- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 7: Agreement with the original validator

**Files:**
- Create: `test/parity.test.mjs`
- Create: `docs/validator-parity.md`

This task answers the question the phase's done-criteria asks: does the new validator agree with the one that has been guarding the original vault for two months? The original vault is private and lives outside this repository, so the test is opt-in and never runs in continuous integration.

- [ ] **Step 1: Write the parity test.** It is skipped unless `BRAIN_KIT_PARITY_VAULT` names a directory. When set, it runs the original validator (`node scripts/validate-okf.mjs .` inside that directory) and the new one (`brain-kit validate` with a configuration file that reproduces the house rules of that vault), and compares the two verdicts file by file. A difference is a failure unless it appears in the accepted-divergence list that the test loads from `docs/validator-parity.md`.

- [ ] **Step 2: Run it against the original vault** and write `docs/validator-parity.md`: the date, the two verdicts, every divergence with its cause, and whether each is a deliberate improvement or a defect to fix. The four defects listed at the top of this plan are expected to appear as divergences, each one an improvement. Any other divergence is a defect in the new validator and must be fixed before this task closes, not explained away. Keep the document free of household data: describe the vault as "the reference vault", never by name, and quote no note content.

- [ ] **Step 3: Commit** with prefix `test:`.

## Verification

The slice is done when all of these hold, and each is a command whose output you paste into the final report:

- `npm test` passes, with the suite grown from 60 to roughly 110 tests.
- `brain-kit validate` on a freshly written conforming fixture exits 0; on each single-violation fixture it exits 1 and names exactly the expected rule.
- `BRAIN_KIT_PARITY_VAULT=<the reference vault> npm test` passes, and `docs/validator-parity.md` explains every divergence.
- `npm pack --dry-run` still lists only the public files, and the zero-dependency test still passes.
- Continuous integration is green on both operating systems.
- No household data anywhere: `git grep -n -i -E -f ~/.config/brain-kit/leak-patterns.txt -- . ` prints nothing.
