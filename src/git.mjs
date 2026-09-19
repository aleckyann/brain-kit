// The git reader: what a change actually touched.
//
// Two later lint rules (style, secrets) judge only lines a change ADDED,
// never a line the vault already carried before this kit's rules existed.
// A vault that adopts this kit arrives with years of prose written under no
// such rule, and a linter that reports every old line on its first run is a
// linter someone switches off in its first minute. So those two rules read
// only what a diff says is new, and this module is what decides which lines
// that is.
//
// This module produces raw material, not the scope contract itself. The
// shape `runLintRules` actually consumes, `{ files, addedLines(relPath) ->
// Set<number> | null }`, is built by the command (src/commands/lint.mjs, a
// later task), because that is where the vault's markdown file list already
// lives from the one `walkVault` call. This module has no notion of a
// vault, a rule, or a config; it only knows how to ask git questions.
//
// A deliberate limitation: `root` is assumed to be the top level of the git
// working tree, exactly like every fixture in this codebase's own tests
// builds it. A vault nested inside a larger repository is out of scope for
// this task; slice C, which extends this reader for the propose loop, is
// where that would need to be handled if it ever comes up.
//
// The convention "null means no restriction, everything is in scope" is
// used at both levels this module can express it. `changedPaths` returns
// `null` for the `all` base: there is no git-computed file list, because
// the caller's own vault walk already IS the file list. `addedLines`
// returns `null` for the `all` base and for any untracked path, because a
// file git has never seen is entirely new, so every one of its lines is
// new.
//
// Every external command's status is checked. A probe whose non-zero status
// is itself the answer (is this a repository, does this branch exist, is
// the tree dirty, is this path tracked) uses the non-throwing `run`. A
// command that must succeed once its preconditions are known to hold (the
// diff itself, once a base has resolved to concrete refs) uses
// `runOrThrow`, which raises naming the command and the captured error
// rather than returning empty. That rule is the whole reason this reader is
// Node and not another round of shell: in shell, a failed pipeline stage
// can look exactly like "nothing to report" (see .githooks/pre-push's own
// lessons on this), and here it cannot.
import { run, runOrThrow } from './exec.mjs';

const KNOWN_BASES = Object.freeze(['all', 'worktree', 'merge-base', 'auto']);

// Line numbers come from the hunk header ("@@ -a,b +c,d @@", with either
// count omitted when it is 1), never from counting lines in the body: a
// file whose hunks touch is exactly where counting drifts, and git has
// already done the arithmetic correctly.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function isGitRepo(root) {
  const result = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
  return result.status === 0 && result.stdout.trim() === 'true';
}

// The branch HEAD points at, even before the first commit exists: an
// "unborn" branch still has a symbolic HEAD, and `git symbolic-ref` reads
// that name without needing a commit to resolve it to. `null` on a
// detached HEAD, where there is no branch name to give.
function currentBranchName(root) {
  const result = run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root });
  return result.status === 0 ? result.stdout.trim() : null;
}

// `git status --porcelain` never fails inside a repository, empty or not,
// so its status is checked but a non-zero result here would be a genuine
// surprise worth raising rather than a known probe outcome.
function isWorkingTreeDirty(root) {
  const result = runOrThrow('git', ['status', '--porcelain'], { cwd: root });
  return result.stdout.trim().length > 0;
}

// The branch a merge-base or an auto choice compares against. Tried in
// order: the remote's own notion of its default branch (what a real clone
// carries, via the refs/remotes/origin/HEAD symref), then the two
// conventional local names. `null` when none of these resolve, which
// happens on a repository this reader cannot identify a default branch
// for at all (no origin configured, and neither "main" nor "master"
// exists as a local branch). A repository is not required to have a
// remote for its tests to exercise merge-base, only a second branch.
function findDefaultBranch(root) {
  const symref = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (symref.status === 0) {
    const name = symref.stdout.trim();
    return name.startsWith('origin/') ? name.slice('origin/'.length) : name;
  }
  for (const candidate of ['main', 'master']) {
    const showRef = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd: root });
    if (showRef.status === 0) return candidate;
  }
  return null;
}

// Resolves a merge-base target and its sha, or degrades to `all` when no
// default branch can be identified at all. That degradation mirrors the
// outside-a-repository case: a base this reader cannot make sense of never
// raises, it falls back to the widest, safest scope instead.
function resolveMergeBase(root, requested, reason) {
  const defaultBranch = findDefaultBranch(root);
  if (defaultBranch === null) {
    return { kind: 'all', requested, reason: 'merge-base-unavailable' };
  }
  const mergeBaseSha = runOrThrow('git', ['merge-base', 'HEAD', defaultBranch], { cwd: root }).stdout.trim();
  return { kind: 'merge-base', requested, reason, defaultBranch, mergeBaseSha };
}

// Resolves a requested base ("all" | "worktree" | "merge-base" | "auto")
// into the concrete decision `changedPaths` and `addedLines` consume.
// `all` is every markdown file and every line. `worktree` is what differs
// from HEAD, which is what a session about to propose cares about.
// `merge-base` is what differs from the merge base with the repository's
// default branch, which is what a pull request cares about. `auto` picks
// `worktree` when the working tree is dirty, `merge-base` when it is clean
// and the current branch is not the default, and `all` otherwise.
//
// Outside a git repository every base degrades to `all`, never an error: a
// vault is markdown first and a repository second. `reason` is a short,
// machine-readable code, not a formed sentence: this module has no notion
// of the language packs, and the command that prints "which base was
// chosen and why" (a later task) is the one that owns turning `reason`
// into a message key.
export function resolveBase(root, requested) {
  if (!KNOWN_BASES.includes(requested)) {
    throw new Error(`unknown base: ${requested} (expected one of ${KNOWN_BASES.join(', ')})`);
  }
  if (!isGitRepo(root)) {
    return { kind: 'all', requested, reason: 'outside-repo' };
  }
  if (requested === 'all') {
    return { kind: 'all', requested, reason: 'all-explicit' };
  }
  if (requested === 'worktree') {
    return { kind: 'worktree', requested, reason: 'worktree-explicit' };
  }
  if (requested === 'merge-base') {
    return resolveMergeBase(root, requested, 'merge-base-explicit');
  }
  // auto
  if (isWorkingTreeDirty(root)) {
    return { kind: 'worktree', requested, reason: 'auto-dirty' };
  }
  const defaultBranch = findDefaultBranch(root);
  const current = currentBranchName(root);
  if (defaultBranch !== null && current !== defaultBranch) {
    return resolveMergeBase(root, requested, 'auto-not-default-branch');
  }
  return {
    kind: 'all',
    requested,
    reason: defaultBranch === null ? 'auto-no-default-branch' : 'auto-on-default-branch',
  };
}

// The repo-relative paths a resolved base considers changed, excluding
// deletions (there is nothing left to lint in a deleted file). `null` for
// the `all` base: the caller's own vault walk is the file list.
//
// `--diff-filter=d` (lower case) excludes only deletions and keeps every
// other kind of change, additions, modifications, typechanges, copies and
// renames included; an allow-list of change kinds is a blind spot by
// construction; see .githooks/pre-push's own fourth lesson.
export function changedPaths(root, base) {
  if (base.kind === 'all') return null;
  const args = ['diff', '--name-only', '-z', '--diff-filter=d'];
  args.push(...(base.kind === 'worktree' ? ['HEAD'] : [base.mergeBaseSha, 'HEAD']));
  const result = runOrThrow('git', args, { cwd: root });
  return result.stdout.split('\0').filter((path) => path.length > 0);
}

// True when git has never seen `relPath` at all (a brand new, unstaged
// file). Deliberately distinct from "changed": an untracked path has no
// diff to read, so `addedLines` short-circuits before ever calling git
// diff on it.
function isUntracked(root, relPath) {
  const result = run('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: root });
  return result.status !== 0;
}

// The lines a resolved base considers ADDED in `relPath`, with their text,
// in file order. `null` for the `all` base and for an untracked path: in
// both cases every line of the file is in scope, not merely the ones a
// diff would enumerate.
//
// Parsed from `-U0 --no-color` output. With zero context lines, every line
// inside a hunk body is either a removal (present only in the old file, so
// it never advances the new-file line counter) or an addition (present in
// the new file, at exactly the position the running counter says, since
// git already computed that position in the hunk header and this reader
// never recomputes it by counting).
export function addedLines(root, base, relPath) {
  if (base.kind === 'all') return null;
  if (isUntracked(root, relPath)) return null;
  const args = ['diff', '-U0', '--no-color'];
  args.push(...(base.kind === 'worktree' ? ['HEAD'] : [base.mergeBaseSha, 'HEAD']));
  args.push('--', relPath);
  const result = runOrThrow('git', args, { cwd: root });
  const added = [];
  let currentLine = null;
  for (const rawLine of result.stdout.split('\n')) {
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (currentLine === null) continue; // still in the file-level header, before the first hunk
    if (rawLine.startsWith('+')) {
      added.push({ line: currentLine, text: rawLine.slice(1) });
      currentLine += 1;
    }
    // A '-' line is consumed only from the old file; the new-file line
    // pointer does not move for it. Anything else inside a -U0 hunk body
    // does not occur.
  }
  return added;
}

// The repo-relative paths git has never seen at all: not in the index, not
// in any commit. `--exclude-standard` honours .gitignore, so an ignored
// file (a build artifact, an editor's scratch file) is never treated as
// vault content. `[]` outside a repository, without ever invoking git:
// there is no tracked/untracked distinction to make there.
export function untrackedPaths(root) {
  if (!isGitRepo(root)) return [];
  const result = runOrThrow('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root });
  return result.stdout.split('\0').filter((path) => path.length > 0);
}
