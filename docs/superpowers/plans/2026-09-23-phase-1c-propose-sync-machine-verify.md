# Phase 1 slice C: the git loop, propose, sync, machine and verify

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the agent can propose its work to a vault only by pull request, against the right base, from a tree it has synchronised, without ever sweeping another session's files into it; and the owner can confirm merged work with one command that stamps `verified`.

**Architecture:** two guards (an exclusive lock and a session snapshot) that every writing command takes; a small set of git loop helpers on top of the existing git reader, all running without a caller's git environment; then four commands: `sync` brings the default branch up to date, `propose` turns listed paths into a pull request, `machine` reads and edits the machine-local file, and `verify` lets the owner stamp notes from a merged pull request.

**Tech Stack:** Node 24, ESM, zero dependencies, `node:test`; `gh` is the only forge supported, and every test uses a fake `gh` that records its arguments.

**Spec:** the approved design, private to the maintainer: its command table (rows `propose`, `sync`, `machine`, `verify`), its guard list (`lock`, `snapshot`), and its phase 1 row. The lessons each command exists for are written, dated, in `docs/incidents.md`, section "Git and pull requests"; that section is this plan's source. The design names a proposal script in the private reference vault as the thing being ported; **this slice does not read it**, and builds from the incidents and the design instead. Slice D is landed; see the ledger of that slice for the state `main` is in when this slice starts.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=24`, ESM only, `dependencies` and `devDependencies` stay EMPTY. A test enforces it.
- Never build a shell command string. Every external command goes through `spawnSync` with an argument array. A summary, a title or a path is an argument, never a fragment of a command.
- Every git call removes the caller's git environment through `src/git-env.mjs`, except inside a git hook, where git sets it on purpose.
- Code, identifiers, comments and test names in English. Every user-facing string comes from `lang/<code>/messages.json`, and BOTH packs carry every key.
- Files under `src/` and `bin/` are pure ASCII. The em dash is banned everywhere in the repository. Never type a unicode escape into file content; build the character at runtime.
- No household data anywhere, including in anything a command writes. Example data uses the fictional owner "Ana", `example.com` / `example.invalid`, `human:ana`, and the agent actor `brain-kit-curator/claude-opus-5-5`.
- Exit codes are fixed in `src/exit-codes.mjs`: `0` ok, `1` failure, `2` usage or not inside a vault, `3` degraded (commit made, pull request not opened), `75` postponed (lock held, tree not safe to touch).
- **Never read, run against or write to the private reference vault this kit is extracted from.**
- Point `BRAIN_KIT_STATE_DIR` or `XDG_STATE_HOME` at a scratch directory in every test and every manual run.
- The maintainer's pre-push gate is active; never bypass it. Commit with the repository's configured identity and never supply one; commits end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the controller pushes.
- Never use `git stash` in the real repository, and never leave a process running when a task ends.

## How work is proven here

As in slice D: clause-by-clause mutation is mandatory where a deleted clause could let something reach a remote, commit a file the command was not given, leave the repository on the wrong branch, destroy a person's file, or let a run exit zero that should not. Everywhere else, ordinary tests plus the two questions. Control at zero failures before any mutation, more than once; verify each mutation changes behaviour; derive the clause list from the code as it stands at the end.

**The two questions:** what single edit makes this commit what it was not given, target the wrong base, leave the wrong branch checked out, or exit 0 when it should not, while the suite stays green? And what already does so with no edit at all? Prove each with a real run against a throwaway repository and bare remote, with a fake `gh`.

**The recurring shape:** a command that succeeds while saying nothing, read as nothing to do, and a command that succeeds but answers about something other than what we are about to act on. In this slice it lives in `gh pr create` returning 0 with a pull request against the wrong base, in a fetch that reached nothing, in a lock file that exists but belongs to a dead process, and in a merged pull request whose file list is empty.

## Review Focus

1. **A summary carrying quotes, `$()`, backticks, a newline and accented letters.** It reaches the commit message and the pull request title intact and is never interpreted. Owner: Task 3.
2. **A second writer while one holds the lock, and a lock left by a process that died.** The second waits for nothing: it exits `75` and names the holder; a dead holder's lock is reclaimed only when it is provably dead on this machine. Owner: Task 1.
3. **`gh` absent, unauthenticated, or creating the pull request against the wrong base.** The command exits `3` when a commit exists without a correct pull request, says what to run, and is back on the branch it started from. Owner: Task 3.
4. **A local default branch that is behind, diverged, or has no `origin/HEAD`.** `sync` fast-forwards the first, refuses the second naming both counts, and resolves the third through the same ladder the push gate uses. Owner: Task 2.
5. **A note with no frontmatter, with `verified` as a bare mapping, as a list, with CRLF line endings; a pull request not merged, or merged into another base.** `verify` stamps the three note shapes without changing any other byte and refuses the two pull requests. Owner: Task 5.

## What earlier slices established, which this slice reuses

- `src/git.mjs`: `isGitRepo`, `resolveBase`, `changedPaths`, `addedLines`, `publishablePaths`, `untrackedPaths`. `src/git-env.mjs`: the git environment stripping. `src/state.mjs`: `stateDirFor`, `ensureStateDir`, `STATE_FILES` (which already names `LOCK` and `SNAPSHOT`). `src/manifest.mjs`: the manifest reader and writer. `src/config.mjs`: `loadConfig`, `validateConfig`, `validateMachine`, `findMachineOnlyKeys`, `MACHINE_ONLY_KEYS`.
- The configuration's `git` section: `agent_identity { name, email }`, `branch_prefix`, `commit_prefix`, `pr_command` (`gh`), `pr_title` (with `{{commit_prefix}}` and `{{summary}}`), `pr_body` (a path, default `.brain-kit/pr-body.md`), `forbid_agent_push_to_default`.
- The default-branch ladder (`refs/remotes/<remote>/HEAD`, then `main`, then `master`) exists in more than one place after slice D; if slice D's close consolidated it into one function, use that function; if it did not, Task 2 consolidates it and every existing caller uses the result.
- `init` writes `.brain-kit/manifest.json` and the managed files; the pull request body template becomes one of them in Task 3.

## Out of scope

- The curate round and its snapshot at round start: phase 2. This slice builds the snapshot guard and takes it at the start of `propose`'s own run; the session-start snapshot is slice E's hook.
- Forges other than GitHub: the design keeps `pr_command` as a field, and only `gh` is implemented.
- Pushing the owner's `verify` commit: `verify` commits and prints the push command; the owner pushes.

## File Structure

| File | Responsibility |
|---|---|
| `src/guards/lock.mjs` | Exclusive lock on the state directory: acquire, release, holder description, provable staleness. |
| `src/guards/snapshot.mjs` | Record which paths are dirty at a moment; later, split a dirty tree into paths dirty before and after. |
| `src/git.mjs` | Gains: `defaultBranch(root)`, `currentBranch(root)`, `aheadBehind(root, a, b)`, `fetch(root, remote)`, `isClean(root)`, each through the stripped environment. |
| `src/commands/sync.mjs` | `brain-kit sync`. |
| `src/commands/propose.mjs` | `brain-kit propose`. |
| `lang/<code>/vault/.brain-kit/pr-body.md` | The pull request body template, managed by `init` and `update`. |
| `src/commands/machine.mjs` | `brain-kit machine show\|set\|register`. |
| `src/frontmatter-write.mjs` | The one frontmatter writer: set or append `verified` without touching any other byte. |
| `src/commands/verify.mjs` | `brain-kit verify`. |

---

### Task 1: The lock and the snapshot

**Files:** Create `src/guards/lock.mjs`, `src/guards/snapshot.mjs`, `test/lock.test.mjs`, `test/snapshot.test.mjs`, `test/incidents/2026-07-29-concurrent-rounds.test.mjs`, `test/incidents/2026-09-16-foreign-files.test.mjs`.

**Interfaces:**
- Produces: `acquireLock(stateDir, { command, now }) -> { release(), holder }` which THROWS a `LockHeld` error carrying `{ holder: { pid, host, command, startedAt } }` when held; `describeLock(stateDir) -> holder | null`. `takeSnapshot(root, stateDir) -> { at, dirty: [path...] }` written to `STATE_FILES.SNAPSHOT`; `readSnapshot(stateDir) -> snapshot | null`; `splitDirty(root, snapshot) -> { before: [path...], since: [path...] }`.

The lock is an exclusively created file (`wx`) in the state directory holding the holder's pid, host name, command and start time. A second acquire fails immediately. A lock is stale only when its host equals this machine's and its pid is not running (`process.kill(pid, 0)` raising `ESRCH`); a stale lock is replaced by rename, never by delete-then-create, so two reclaimers cannot both win. A lock from another host is never reclaimed automatically.

- [ ] **Step 1: Write the failing tests:** a second acquire in the same process and in a child process fails with the holder named; release lets the next acquire succeed; a lock whose pid is dead on this host is reclaimed; a lock whose pid is alive, or whose host differs, is not; two children racing to reclaim the same stale lock produce exactly one winner; a snapshot of a tree with two dirty files, followed by a third change, splits into two `before` and one `since`; a snapshot of a non-repository is empty and says so.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Watch them pass.**
- [ ] **Step 5: Mutation, mandatory** on every acquire, staleness and split clause.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 2: Git loop helpers and `sync`

**Files:** Modify `src/git.mjs`; create `src/commands/sync.mjs`, `test/sync.test.mjs`, `test/incidents/2026-08-17-behind-default.test.mjs`; modify `src/cli.mjs`, both packs.

**Interfaces:**
- Consumes: `acquireLock`, `cleanGitEnv` (or its equivalent) from `src/git-env.mjs`.
- Produces: the helpers in the File Structure table; `brain-kit sync [dir]`.

`sync` takes the lock; refuses with `75`, naming the files, when the tree is dirty; fetches the remote the default branch tracks; reports ahead and behind counts; when behind only, checks out the default branch and fast-forwards; when diverged, refuses with `1` naming both counts and changing nothing; returns to the branch it started from when that was not the default; releases the lock in every outcome.

- [ ] **Step 1: Write the failing tests,** each against a throwaway repository and bare remote: four commits behind is fast-forwarded (the 17/08/2026 incident); diverged is refused with both counts and no ref moved; a dirty tree exits `75` naming the file and moves nothing; the lock held exits `75` naming the holder; no `origin/HEAD` resolves through `main`; a fetch that fails (remote unreachable) exits `1` and says so, never reporting "up to date"; `GIT_DIR` pointing at another repository leaves that repository unchanged.
- [ ] **Step 2: Watch them fail. Step 3: Implement,** consolidating the default-branch ladder into `defaultBranch` if slice D did not, and making every existing caller use it. **Step 4: Watch them pass.**
- [ ] **Step 5: Mutation, mandatory** on every clause that moves a ref or decides the exit code.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 3: `propose`

**Files:** Create `src/commands/propose.mjs`, `lang/en/vault/.brain-kit/pr-body.md`, `lang/pt-BR/vault/.brain-kit/pr-body.md`, `test/propose.test.mjs`, `test/incidents/2026-08-10-base-ref.test.mjs`, `test/incidents/2026-09-08-return-to-origin.test.mjs`; modify `src/commands/init.mjs` (the body template is managed), `src/cli.mjs`, both packs.

**Interfaces:**
- Consumes: Tasks 1 and 2; `runValidate`, `runLint`.
- Produces: `brain-kit propose "<summary>" (--only <path>... | --all [--yes]) [--dry]`.

The order, every step's status read before the next: take the lock; take this run's snapshot; resolve the vault; with `--only`, the listed paths must each be dirty and inside the vault, or refuse naming them; with `--all`, list every dirty path, refuse any that was already dirty in the previous snapshot unless `--yes` (the 16/09/2026 incident), and require `--yes` when there is no previous snapshot; run `validate` and `lint --base worktree`, refusing on failure; resolve `origin` (the current branch) and `base` (the default branch) as two variables that never share a meaning (the 10/08/2026 incident); create `<branch_prefix><YYYY-MM-DD-HH-MM-SS>` from the current HEAD; stage exactly the chosen paths with `git add --`; commit with the configured agent identity passed as `-c user.name` and `-c user.email`, because this command is the agent's and that identity is its designed author; push the branch; open the pull request with `gh pr create --base <base> --head <branch> --title <rendered> --body-file <rendered body>`; confirm with `gh pr view <branch> --json baseRefName` that the base is `base`; return to `origin` in every outcome, success included (the 08/09/2026 incident); release the lock. `--dry` prints the plan and changes nothing. Exit `3` when a commit exists without a confirmed pull request, naming the exact command to finish by hand.

- [ ] **Step 1: Write the failing tests,** with a fake `gh` on PATH that records its arguments and can be told to fail, to be unauthenticated, or to report another base:
  - the base is the default branch even when the current branch is a previous round's branch;
  - HEAD is back on the origin branch after success, after a validate failure, after a push failure, and after a `gh` failure;
  - `--only` commits exactly the listed paths and leaves every other dirty file dirty and uncommitted;
  - `--all` without `--yes` refuses when a file was dirty in the previous snapshot, naming it;
  - a summary with quotes, `$()`, backticks, a newline and accented letters arrives intact in the commit message and in the title the fake `gh` recorded;
  - `gh` absent, `gh` failing, and `gh` reporting another base each exit `3` with the finishing command printed;
  - a clean tree exits `0` with nothing to propose, said in one line;
  - the lock held exits `75`;
  - `--dry` changes no ref, no file and no branch;
  - `init` writes `.brain-kit/pr-body.md` as managed in both languages.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Watch them pass.**
- [ ] **Step 5: Mutation, mandatory** on every clause that decides what is staged, which base is used, which branch is checked out at the end, and the exit code.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 4: `machine`

**Files:** Create `src/commands/machine.mjs`, `test/machine.test.mjs`; modify `src/cli.mjs`, both packs.

**Interfaces:**
- Produces: `brain-kit machine show [dir]`, `brain-kit machine set <key> <value> [dir]`, `brain-kit machine register [dir]`.

`show` prints `machine.json` for this vault, or says where it looked. `set` accepts only the keys `schema/machine.schema.json` declares, parses the value by the key's type (an argv array for executable keys, given as a JSON array), validates the result with `validateMachine` before writing, and writes atomically with mode 0600. `register` rewrites `canonical_path` to the vault's current real path and moves the state to the directory that path implies, for a vault that was moved; it refuses when the target state directory already holds a `machine.json` for another vault.

- [ ] **Step 1: Write the failing tests:** show in a vault and outside one; set of a valid string key, of an array key, of an unknown key (refused), of a value that fails the schema (refused, file unchanged byte for byte); register after moving a vault directory; register refusing to overwrite another vault's state; every write keeps mode 0600.
- [ ] **Step 2 to 4.** Watch them fail, implement, watch them pass.
- [ ] **Step 5: Mutation, mandatory** on every clause that decides whether the file is written.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

### Task 5: `verify`

**Files:** Create `src/frontmatter-write.mjs`, `src/commands/verify.mjs`, `test/frontmatter-write.test.mjs`, `test/verify.test.mjs`; modify `src/cli.mjs`, both packs.

**Interfaces:**
- Consumes: the frontmatter readers in `src/frontmatter.mjs`, `defaultBranch`, `currentBranch`.
- Produces: `stampVerified(text, { by, at }) -> text` in `src/frontmatter-write.mjs`, which changes nothing but the `verified` key; `brain-kit verify --pr <n> | --files <path>...`.

The owner's command. It refuses when the configured git identity equals the agent identity from the configuration, because the agent never verifies its own work. With `--pr`, it reads `gh pr view <n> --json state,baseRefName,files`, refuses unless the state is `MERGED` and the base is the default branch, and stamps every markdown note among the files that still exists; with `--files`, it stamps the listed notes. `by` is the configuration's `actors.human`, `at` the current time with an explicit offset. A bare `verified` mapping becomes a one-element list with the new entry appended, as the format's section 11 says a consumer must read it; a list gains one entry; an absent key gains a one-element list. It must be on the default branch with a clean tree, commits the stamps with the person's own configured identity and a message naming the pull request, and prints the push command.

- [ ] **Step 1: Write the failing tests:** `stampVerified` on a note with no frontmatter (refused, the note is not a note), with a bare mapping, with a list, with CRLF endings, and with `verified` inside a fenced code block in the body (untouched), each asserting that every byte outside the `verified` key is unchanged; `verify --pr` on a merged pull request against the default base (the fake `gh` returns the file list), on an open one, and on one merged into another base; the agent identity refused; a dirty tree or a non-default branch refused; `validate` passes on every stamped note.
- [ ] **Step 2 to 4.** Watch them fail, implement, watch them pass.
- [ ] **Step 5: Mutation, mandatory** on every clause that decides what is written, and the refusals.
- [ ] **Step 6: Commit** with prefix `feat:`.

---

## After the last task

The final whole-slice review runs over the whole range, with the design's phase 1 criterion for this slice in front of it: `propose` inside a round opens a pull request without `--only` only where a snapshot proves the files are the round's own, and an interactive `propose` requires `--only`; every run ends on the branch it started from; and `verify` stamps only what a merged pull request into the default branch changed.
