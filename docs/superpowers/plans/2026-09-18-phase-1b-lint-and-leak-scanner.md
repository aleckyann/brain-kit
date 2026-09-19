# Phase 1 slice B: the lint command and the leak scanner in Node

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task.

**Goal:** `brain-kit lint` checks the health and the safety of a vault's content, as against `validate`, which checks its conformance to a format. And the anti-leak scanner moves from shell to Node, which is the decision phase 0 paid five rounds of fixes to earn.

**Architecture:** one new rule engine beside the two that exist, sharing their finding shape and their renderer; a minimal git reader that slice C will extend; and a leak scanner that both the `secrets` rule and the maintainer's push gate call, so there is one implementation rather than two that must agree.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`.

**Spec:** the approved design, private to the maintainer, its command table (the `lint` row) and its section on security and privacy as a requirement. Slice A is landed at 4db6039 with 379 tests.

## Global Constraints

Every task's requirements implicitly include this section. Each one was paid for.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync` with an argument array.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key; a test enforces parity. A finding carries a `messageKey` and `params`, never a formed sentence, because a report that frames its sections in one language and writes its findings in another is broken.
- Files under `src/` and `bin/` are pure ASCII. The em dash (U+2014) is banned everywhere in the repository. A test file may carry deliberate non-ASCII ONLY where the non-ASCII is the thing under test, and says so; otherwise build it with `String.fromCharCode`. NEVER type a unicode escape into file CONTENT, in code or in a comment: three separate times in this repository an escape has materialised as a literal byte through the editing transport, twice as an accented letter and once as a null byte that turned two source files binary. Build the character at runtime instead, every time, and verify with a byte-level check rather than by reading the file back.
- No household data: no company, colleague or client name, no real e-mail, no real personal handle, and no absolute path naming anyone's machine. A FILE PATH is household data, because a folder name reveals a taxonomy and a filename reveals a person. Example data uses the fictional owner "Ana", `example.com` / `example.invalid`, and the actors `human:ana` and `brain-kit-curator/claude-opus-5`. This project leaked its own household six times in one day, every time through an artifact built to test or describe the public thing.
- Fixture taxonomy is English (`people/`, `projects/`, `decisions/`, `pending/`, `core/`, `memory/`, `attachments/`). A non-English taxonomy appears only where it is the thing under test and says so where its format allows; a JSON fixture cannot say it in itself, because the config validator rejects unknown top-level keys, so its label lives in the test that loads it.
- Exit codes are fixed in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not inside a vault, `3` degraded, `4` required source unread, `69` unavailable, `75` postponed.
- The maintainer's pre-push gate is active. Never bypass it with `--no-verify`; if it refuses, report the refusal.
- Commits use a conventional prefix and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Do not push; the controller pushes and watches CI.

## How work is PROVEN here

The stub audit, which guts a module and counts surviving tests, is a smoke check and never the evidence: it came back perfect on a task where four contract clauses had no test at all. For every clause a task owns, mutate that clause alone, VERIFY THE MUTATION ACTUALLY CHANGES BEHAVIOUR, and confirm a NAMED test fails. A mutation that changes nothing proves nothing, and a clause is DEAD only when no input can tell its presence from its absence. If an input exists that behaves differently, the clause is not dead and removing it is a BEHAVIOUR CHANGE, which needs a decision and a line in the report, not a deletion filed under housekeeping. One removal on this slice was filed as a dead clause and was really a change to how an escaped separator inside a heading is read, and an implementer here once deleted a guard that was already dead beside its neighbour and the clause looked defended. Derive the clause list from the code as it stands when the round ENDS, never from the clauses a review named, because a round's own new clauses are exactly the ones no earlier review could have named. Report any clause you leave undefended, with the reason; naming one is worth more than a clean report.

**The sharper form of the question, earned on this slice and better than the one it replaces.** For any contract, do not ask whether the code holds. Attack it and the code will very likely survive, because it was just written to survive exactly that. Ask instead: WHAT SINGLE EDIT MAKES THIS BREAK WITHOUT TURNING THE SUITE RED? On this slice the redaction of secrets survived eight adversarial geometries and twenty-four thousand randomised cases, and then one deleted line, a sort, made a neighbouring secret print in full with every test still green. The defect was never in the code; it was in the tests, and only mutating AFTER attacking revealed it.

**Mutation testing cannot find a clause nobody wrote.** It perturbs what exists, so it is blind to the guard that was never added and, above all, to a DEFAULT inherited from a module you call. On this slice a caller destructured one field out of a scanner's return and silently took that scanner's default ceiling of five, so a file with eight secrets reported five and said nothing, while the scanner it called had been built over three rounds specifically to announce every ceiling. The implementer's mutation table was honest and complete and could not have contained this, because the clause lives in the dependency's default and nowhere in the caller's source. So beside the mutation pass, read every call into another module and ask what its unnamed arguments are, and what its return carries that you did not take.

**Establish a control before trusting a mutation run.** A `git archive` copy has no version-control directory, so any test that asks version control a question fails in it before a single mutation is applied. A reviewer on this slice ran a full pass that way and reported every mutant killed; the run was false and it said so. Run the suite on the unmutated copy FIRST and require zero failures, or every survivor you count is noise.

**A number inside a guard is a claim about throughput, so measure it.** Two budgets on this slice went three rounds being called judgment calls. One was measurably wrong: the scanner refused two megabytes of ordinary secret-free prose, roughly twenty-two thousand lines, because ninety-nine point eight percent of its time on clean input went to sandbox setup rather than to matching, at five hundred times the cost of the same work in plain code. Nobody had measured it, including me, because a constant reads like taste. Ask what the number implies about the largest input the feature must accept, and check.

**And do not walk a fix round's own item list.** Verifying the items a round was told to close systematically misses the hole that round opened. Three of the most serious findings on this slice were on nobody's list, including the one above.

## What slice A established, which this slice reuses rather than reinvents

- `walkVault(root, config, { all: true })` is called ONCE per command, and both the markdown subset and the full path set come from that one result.
- `context` is `{ root, config, all, readFile }`. `readFile` strips carriage returns and a leading byte-order mark and caches, so no rule ever sees either.
- `stripCode` in `src/markdown.mjs` removes fenced and inline code before any rule reads a heading or a link. A fence belongs to the container that opened it, and a container has a content column; every measurement is relative to it.
- The readers in `src/frontmatter.mjs` have two absences: `null` means a key is ABSENT, `undefined` means it is PRESENT in a shape the reader cannot see. A rule must never report the second as missing.
- A finding is `{ ruler, id, check, file, line, messageKey, params }`, plus `level` for the specification ruler only, plus the booleans `absence` and `unreadable` where they apply.
- `src/dates.mjs` holds the one calendar validator. `vault.isUnderPath` holds the one path-boundary check. Do not write a second of either.

## Source being ported

The reference vault's own guards, which exist as shell and as habit rather than as code:
- the awk check for a split table (a data row with no blank line before its header, and a duplicated row),
- the briefing's style lock, which counts ONLY lines added by a diff,
- the column contract, which the configuration already declares under `taxonomy.files`,
- the orphan-note idea, open since 10/08/2026 and never built,
- and the pre-push leak scanner, whose five rounds of fixes in phase 0 produced the decision this slice executes.

The lesson those five rounds taught, and the reason the scanner moves: **every hole was a status nobody read or a set nobody enumerated**, which is what shell makes easy. In Node, reading a blob or walking a set raises instead of returning empty.

**The Node-shaped sequel to that lesson, written down the day this slice found it.** Moving to Node removes the unread status and nothing else. The holes that remain all have status ZERO: a command that succeeded while printing something the parser cannot read, or a reference that was valid and wrong. A diff of a file git decided is binary exits 0 with no hunk at all. A merge base against a branch that happens to be the current one exits 0 with an empty range. So the rule for this slice is stronger than checking a status: **when a command succeeds and returns nothing, prove that nothing is the right answer before believing it.**

**And the scope is a UNION, never a choice between bases.** The automatic mode adds together what the branch committed, what the working tree changed and what is untracked. An either/or lets one unrelated scratch file flip the scope and hide every committed line on a branch, which is how a secret added today leaves the scope in the DEFAULT setting. A union can only over-include, and over-including is this project's stated direction when in doubt.

## File Structure

| File | Responsibility |
|---|---|
| `src/git.mjs` | Resolve a base, list changed and untracked paths, and return the ADDED lines of a diff with their line numbers. Minimal on purpose; slice C extends it for the propose loop. |
| `src/leak.mjs` | Scan text for secret patterns. One implementation, used by the `secrets` rule and by the maintainer's push gate. Fails closed. |
| `src/rules/lint.mjs` | `LINT_RULES` and `runLintRules(files, context, scope)`, with `ruler: 'lint'`. |
| `src/commands/lint.mjs` | The command: resolve the vault, one walk, resolve the scope, run the rules, render, exit. |
| `.githooks/pre-push` | Becomes a thin bash entry that hands every candidate blob to the Node scanner. |
| `lang/*/messages.json` | Every new key, in both packs. |
| `test/git.test.mjs`, `test/leak.test.mjs`, `test/rules-lint.test.mjs`, `test/lint.test.mjs` | One suite per module, each driving real temporary git repositories rather than mocks. |

---

### Task 1: The git reader

**Files:**
- Create: `src/git.mjs`
- Test: `test/git.test.mjs`

**Interfaces:**
- Produces: `resolveBase(root, requested)`, `changedPaths(root, base)`, `addedLines(root, base, relPath) -> [{ line, text }]`, `untrackedPaths(root)`, and `isGitRepo(root)`.

**The scope contract, which task 3 and task 6 both depend on.** A lint rule asks the scope one question: is this line mine to judge? The answer differs by rule, so `runLintRules` takes a third argument, `scope`, shaped `{ files: string[], addedLines(relPath) -> Set<number> | null }`. A `null` from `addedLines` means EVERY line of that file is in scope, which is what an untracked file returns, because a file git has never seen is entirely new. A rule that judges the VAULT, such as the index, orphan or column rules, reads the full walk and IGNORES the scope entirely. That is a correction to an earlier version of this plan, which told those rules to read `scope.files`, and it was wrong for a reason worth stating: reachability cannot be computed from a subset, because a note is an orphan only with respect to the whole graph, and a directory is missing an index only with respect to every directory. Narrowing a whole-vault question to a change's files does not make it cheaper, it makes it WRONG, and wrong in the confident direction, since it would report an orphan that is reachable from a file the change did not touch. Only the two rules that judge prose line by line, style and secrets, read the scope. A rule that judges lines, such as style, reads `addedLines` and skips a line the set does not carry.

**Base resolution.** `all` means every markdown file and every line. `worktree` means what differs from `HEAD`, which is what a session about to propose cares about. `merge-base` means what differs from the merge base with the repository's default branch, which is what a pull request cares about. `auto` picks `worktree` when the working tree is dirty, `merge-base` when it is clean and the current branch is not the default, and `all` otherwise. Outside a git repository every base degrades to `all`, with a message saying so, and never an error: a vault is markdown first and a repository second.

- [ ] **Step 1: Write the failing test.** Build a real temporary repository per case with `spawnSync` and an argument array. Assert: a file added and committed appears under `merge-base` against the default branch but not under `worktree` once committed; an uncommitted edit appears under `worktree` with only its added line numbers; an untracked file appears with `addedLines` returning `null`; a file with a path containing a space and a path containing an accented character are both handled; a deleted file never appears; `auto` picks each of its three answers in the three states; and outside a repository every base returns every file with `null` lines.
- [ ] **Step 2: Watch it fail, write the module, watch it pass.** Parse the diff with `-U0` and `--no-color`, and read the hunk headers for line numbers rather than counting, because counting drifts on a file whose hunks touch. Every `spawnSync` result has its status checked; a non-zero status raises with the command and the captured error, never returns empty. That rule is the whole reason this is Node.
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 2: The leak scanner

**Files:**
- Create: `src/leak.mjs`
- Test: `test/leak.test.mjs`

**Interfaces:**
- Produces: `loadPatterns({ env, configPatterns })`, `scanText(text, patterns, { max })`, `GENERIC_PATTERNS`.

This is the module phase 0 paid for. The shell version needed five rounds because each hole was a status nobody read or a set nobody enumerated. Preserve its behaviour and its failure mode, in a language where both are hard to get wrong.

- `GENERIC_PATTERNS` is versioned in this repository and always applied: a private key header, the two GitHub token shapes, the Anthropic key shape, the AWS access key id shape, and the Slack token shapes. Build the private key header in the test by concatenation at runtime; writing it literally makes this repository's own push gate refuse the commit, which has already happened once.
- Personal patterns come from a file named by `BRAIN_KIT_LEAK_PATTERNS`, defaulting to `~/.config/brain-kit/leak-patterns.txt`. The list of names worth protecting is itself the data worth protecting, so that file NEVER enters this repository and is never printed. When a caller asks for personal patterns and the file is missing, empty, unreadable or a directory, `loadPatterns` THROWS. Failing closed is the point: a gate that cannot read its list must stop a push, not wave it through.
- `configPatterns` are the vault's own `privacy.secret_patterns`, which are public by nature. A caller may ask for those alone, and then a missing personal file is not an error.
- Every pattern compiles case-insensitively. A pattern that fails to compile raises naming the pattern and its source, rather than being skipped, because a skipped pattern is a hole nobody sees.
- `scanText` returns `[{ line, column, pattern, excerpt }]`, capped by `max` (default 5), and the cap is REPORTED in the return as `truncated: true` with the total. Every ceiling in this project says how much it cut.
- The excerpt NEVER contains the matched text. It carries the line number and at most forty characters of surrounding context with the match replaced by a fixed marker. A tool that prints the secret it found has leaked it into a log, a terminal scrollback and a CI record.

- [ ] **Step 1: Write the failing test,** covering each of the above, plus: a file with no trailing newline; a match on the first and on the last line; two matches on one line; a pattern list whose lines carry comments and blanks; and a binary-ish input with null bytes, which must be scanned as text with the nulls stripped rather than skipped, because the shell version skipped binary blobs and that was one of the five holes.
- [ ] **Step 2: Watch it fail, write the module, watch it pass.**
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 3: The structural lint rules

**Files:**
- Create: `src/rules/lint.mjs`
- Test: `test/rules-lint.test.mjs`

**Interfaces:**
- Produces: `LINT_RULES` and `runLintRules(files, context, scope) -> Finding[]` with `ruler: 'lint'`.

A lint finding carries NO conformance level. `must` and `should` are the format's own two tiers and a health check belongs to neither; the finding's severity comes from `lint.<rule>` in the configuration, with values `error`, `warn` and `off`, defaulting to `warn` for anything the configuration does not name. Severity is a field on the finding, not a level.

The three rules in this task judge the vault as a whole, so each reads the full walk and ignores the scope. A person running this on a clean default branch still gets a real answer about their vault's structure, which is the behaviour they expect, while the two prose rules in task 4 correctly stay silent because nothing changed.

| id | Setting | What it requires |
|---|---|---|
| `index-completeness` | `lint.index_completeness` | Every directory that holds a markdown file has an `index.md`, and the root index links every first-level directory. |
| `orphans` | `lint.orphans` | Every note is reachable by following links from the root index. Open since 10/08/2026 and never built. |
| `columns` | `lint.columns` | A file named under `taxonomy.columns` carries the exact column headings its configuration declares, in order. |

**The configuration's shape for this is wrong and changes with this rule.** Today `taxonomy.columns.<file>` is one flat object mixing two different things: the ordered headings of a table, and labels that are not columns at all, such as the heading of a section or the text shown when a list is empty. A rule reading every value as a column therefore reports errors on a CORRECT file, which a review verified against the shape this project's own configuration describes. Split it: `taxonomy.columns.<file>` becomes `{ columns: [ordered headings], labels: { other strings } }`, the rule reads only the first, and the schema and all three fixtures follow. Note how this was found, because it is the more useful half: the rule's own fixtures PASSED, because they were written to match the implementation rather than the format. A fixture written from the code proves the code agrees with itself.

Three behaviours to pin, because each is where a rule of this kind goes wrong:
- Reachability is computed once, breadth first from the root index, over the SAME link extraction the house ruler uses, which reads links only after code is stripped. A note reachable only from a note that is itself unreachable is unreachable.
- A reserved filename is never an orphan: `index.md` and `log.md` are structure, not content.
- The column check compares headings after trimming, is case sensitive, and reports the first difference with both the expected and the found heading, because a message saying only that columns differ makes a person diff two tables by eye.

- [ ] **Step 1: Write the failing test,** one fixture per rule that violates exactly that rule, one clean fixture that reports nothing, and, for every refusal, the nearest positive asserted in the SAME test: the shape that must be reported beside the almost-identical shape that must not.
- [ ] **Step 2: Watch it fail, write the module, watch it pass.** Rules are data, not a chain of conditionals. A rule never throws on malformed, empty or unclosed input; it reports.
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 4: The line-scoped lint rules

**Files:**
- Modify: `src/rules/lint.mjs`
- Modify: `test/rules-lint.test.mjs`

**Interfaces:**
- Consumes: `scope.addedLines` from task 1.

| id | Setting | What it requires |
|---|---|---|
| `tables` | `lint.tables` | A table is preceded by a blank line, carries no duplicated data row, and no cell exceeds the configured maximum. |

**What the scope means for a TABLE, settled here because this plan left it ambiguous and an implementer had to guess.** The plan said only the style rule judges added lines and said nothing about this one, so the scoping below is a decision rather than a restatement. A table is judged when the change touched ANY of its lines, and then the WHOLE table is judged, because the questions this rule asks are properties of a table and not of a line: whether a blank line precedes it is not a fact about any row. That keeps the adoption property, since a table nobody touched stays silent, while making a touched table answerable as the unit it is. The cost, and it must be paid in the message: a finding can name a line the change never touched. So each of this rule's messages SAYS that the table was judged because the change touched it, in those words. A finding on an untouched line with no explanation is how a person concludes the tool is wrong about their file.
| `style` | `lint.style.forbidden_chars` | No forbidden character appears, judged ONLY on lines the scope says were added. |

The style rule is the reason the scope exists. A vault that adopts this kit inherits years of prose it did not write under this rule, and a linter that reports every old line on the first run is a linter someone switches off in its first minute. So style judges only what this change added, and its message says so.

Two behaviours to pin: a forbidden character inside a fenced code block is not a finding, because code is stripped first and an example must be quotable; and a table inside a fenced code block is not a table, for the same reason. The fence handling is `stripCode` and is not to be reimplemented; this codebase fixed a second copy of it four times before the two were merged.

- [ ] **Step 1: Write the failing test,** including a file where the same forbidden character appears on an added line and on an untouched line, asserting exactly one finding and asserting its line number; an untracked file where every line counts; and a duplicated row that differs only in trailing whitespace, which IS a duplicate.
- [ ] **Step 2: Watch it fail, extend the module, watch it pass.**
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 5: The safety lint rules

**First, uniform severity, because this task adds three rules and would otherwise inherit an inconsistency and triple it.** Today seven rules are configured with a severity string, `style` is an object carrying its settings and NO severity, so it can never be set to error or off and is permanently a warning, and `tables_limits` is a sibling object that is not a rule at all. A task 4 implementer found this and disclosed it rather than papering over it.

Make `lint.<rule>` accept EITHER a severity string OR an object carrying `severity` plus that rule's own settings, fold `tables_limits` into `lint.tables`, and update the schema, all three fixtures and the rules. One shape, every rule configurable, and no rule silently unconfigurable because its settings needed somewhere to live. This is the same defect as the columns object one task earlier, in a different costume: a configuration shape that makes one kind of thing impossible to say.


**Files:**
- Modify: `src/rules/lint.mjs`
- Modify: `test/rules-lint.test.mjs`

| id | Setting | What it requires |
|---|---|---|
| `secrets` | `lint.secrets`, `privacy.secret_patterns` | No secret pattern appears on an added line. Calls `src/leak.mjs`; never its own regular expressions. |
| `privacy` | `lint.privacy`, `privacy.confidential_dirs` | A note under a confidential directory is not linked from a file outside one, and a note outside one does not carry a field the configuration marks confidential. |
| `attribution` | `lint.attribution` | A note whose `sources` carries more than one entry anchors each claim that crosses sources with a footnote whose key matches a source id. |

The secrets rule is the one whose failure is unrecoverable, so it is the one with the strictest contract. It is scoped to added lines, like style, and for the same reason. Its message NEVER contains the matched text, only the rule that matched and the line, and it points at the incident-response document. Its severity default is `error` even though every other rule defaults to `warn`, and the code says why: a warning about a leaked credential is a leaked credential.

The attribution rule is the only one here that reads the format, section 5.1, so it cites it. It does not run when `sources` has one entry or none, because a single source needs no disambiguation.

- [ ] **Step 1: Write the failing test.** Build every secret fixture by runtime concatenation, never literally, or this repository's own push gate refuses the commit. Assert the message carries no matched text by asserting the fixture's own secret string is absent from the rendered output.
- [ ] **Step 2: Watch it fail, extend the module, watch it pass.**
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 6: The `lint` command

**Files:**
- Create: `src/commands/lint.mjs`
- Modify: `src/cli.mjs`, both `lang/*/messages.json`
- Test: `test/lint.test.mjs`

**Interfaces:**
- Produces: `brain-kit lint [dir] [--rule <id>...] [--base auto|worktree|merge-base|all] [--json]`.

Behaviour:
- Resolve the vault, then call `walkVault` ONCE with everything included, exactly as `validate` does, and build the same `context`. The command module does not import the walk; the entry point owns the reference and hands it down, which is how `validate` keeps the same promise.
- Build the scope from `src/git.mjs` and the requested base. Print which base was chosen and why, in one line, because a person who does not know the scope cannot read the findings.
- `--rule` may repeat and restricts the run to the named rules. An unknown rule id is a usage error with exit `2` that lists the known ids, never a silent empty run.
- Group findings by SEVERITY, errors first, then warnings, each group saying in words what it means. Rules set to `off` do not run, and the summary says how many were skipped, because a count of zero findings means something different when half the rules were off.
- Exit `1` when any finding has severity `error`, `0` when there are only warnings, `2` for usage or no vault. A warning never fails a run: this command lands on a vault written before it existed.
- `--json` prints ONE object and nothing else, carrying `findings`, `counts`, `scope` (the base chosen, the number of files and whether lines were restricted), `skipped` and `version: "brain-kit.lint/1"`. The version goes in now, for the reason `validate` has one: adding it later is the breaking change a version exists to prevent.

- [ ] **Step 1: Write the failing test,** driving the real binary with `spawnSync`: a clean vault exits 0; a vault with one error and one warning exits 1 and groups them; a vault with only warnings exits 0 and says so; an unknown rule exits 2 and lists the ids; `--json` parses and carries the same counts; and a mutation test proving the walk happens exactly once.
- [ ] **Step 2: Watch it fail, write the command and the message keys in both packs, watch it pass.**
- [ ] **Step 3: Commit** with prefix `feat:`.

---

### Task 7: The push gate calls the Node scanner

**Files:**
- Modify: `.githooks/pre-push`
- Modify: `test/pre-push-hook.test.mjs`
- Create: `templates/githooks/pre-push`

**Interfaces:**
- Produces: `brain-kit scan-blobs`, an internal subcommand reading paths or blob contents on standard input and exiting non-zero on a match.

The hook keeps exactly what shell is good at, which is asking git what a push contains, and hands everything else to Node. Its five rounds of fixes in phase 0 stay as tests: the scan must cover every commit in the range and not only the tip; a new ref derives its exclusions from a live remote listing and falls back to a full scan when the remote is unreachable; merge commits are diffed; a typechange is included; every stage of a pipeline has its status read; and the patterns file being missing, empty or a directory fails the push.

Those behaviours move into Node, where an unread status raises. What stays in bash is the ref negotiation on standard input and the call. Bash 3.2 compatibility still applies, because a macOS runner proved it empirically.

`templates/githooks/pre-push` is the version an adopting vault installs, which runs `validate` and `lint` and refuses a push by the agent identity to the default branch. It is a template, so it names no path on anyone's machine.

- [ ] **Step 1: Write the failing test,** extending the existing hook suite: every phase 0 behaviour still holds, and the new subcommand refuses a blob carrying a pattern and accepts one that does not.
- [ ] **Step 2: Watch it fail, write it, watch it pass.** Never bypass the live gate to test it; build a temporary repository.
- [ ] **Step 3: Commit** with prefix `refactor:`.

---

## Verification

The slice is done when each of these has been RUN, with its output pasted into the final report:

- `npm test` passes, and the parity test still passes against the reference vault when its environment variable is set.
- `brain-kit lint` on a clean fixture exits 0; on a fixture with one error exits 1 and names the rule; with every rule off exits 0 and says how many were skipped.
- `brain-kit lint --base all` on the reference vault runs without crashing, and its findings are reported as COUNTS BY RULE only. No path, no note content, no folder name: a file path is household data.
- The push gate still refuses a commit carrying a personal pattern, proven in a temporary repository and never against the real remote.
- `npm pack --dry-run` still ships only public files, and dependencies are still empty.
- Continuous integration is green on both operating systems.
