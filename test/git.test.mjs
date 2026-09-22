import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isGitRepo,
  resolveBase,
  changedPaths,
  addedLines,
  untrackedPaths,
  publishablePaths,
} from '../src/git.mjs';

// Every case here builds a REAL temporary git repository via spawnSync with
// an argument array, never a mock. A local commit identity is set on every
// call, so these tests never depend on the machine's global git config, and
// no remote is ever touched over the network: an "origin" used below is
// always another temporary directory on this same machine.
function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
}

function ok(result, label) {
  assert.equal(result.status, 0, `${label ?? 'git command'} failed: ${result.stderr}`);
  return result;
}

function initRepo(branch = 'main') {
  const root = makeTempDir('brain-kit-git-');
  ok(spawnSync('git', ['init', '-q', '-b', branch, root]), 'git init');
  return root;
}

function writeAndCommit(root, relPath, content, message) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  ok(git(root, ['add', '--', relPath]), `add ${relPath}`);
  ok(git(root, ['commit', '-q', '-m', message]), `commit "${message}"`);
}

test('isGitRepo is true inside a repository, false in a plain directory, and false in a bare repository', () => {
  const root = initRepo();
  assert.equal(isGitRepo(root), true);

  const plain = makeTempDir('brain-kit-plain-');
  assert.equal(isGitRepo(plain), false);

  // A bare repository answers "is this inside a work tree" with status 0
  // and stdout "false", not a failure: it is a real repository, but there
  // is no worktree to diff, so it must read as false here too.
  const bare = join(makeTempDir('brain-kit-bare-'), 'repo.git');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]), 'git init --bare');
  assert.equal(isGitRepo(bare), false);
});

test('resolveBase rejects a base id it does not know, carrying a machine-readable code rather than only prose', () => {
  const root = initRepo();
  assert.throws(
    () => resolveBase(root, 'nonsense'),
    (error) => /unknown base/.test(error.message) && error.code === 'unknown-base',
  );
});

test('a repository with no commit at all degrades every base but the explicit "all" one', () => {
  const root = initRepo();
  for (const requested of ['worktree', 'merge-base', 'auto']) {
    const base = resolveBase(root, requested);
    assert.equal(base.kind, 'all', `requested "${requested}" should degrade with no commits yet`);
    assert.equal(base.reason, 'no-commits');
  }
  const explicitAll = resolveBase(root, 'all');
  assert.equal(explicitAll.kind, 'all');
  assert.equal(explicitAll.reason, 'all-explicit');
});

test('outside a git repository every base degrades to all, and every file returns null lines', () => {
  const root = makeTempDir('brain-kit-not-git-');
  writeFileSync(join(root, 'a.md'), 'hello\n');
  assert.equal(isGitRepo(root), false);

  for (const requested of ['all', 'worktree', 'merge-base', 'auto']) {
    const base = resolveBase(root, requested);
    assert.equal(base.kind, 'all');
    assert.equal(base.reason, 'outside-repo');
    assert.equal(changedPaths(root, base), null);
    assert.equal(addedLines(root, base, 'a.md'), null);
  }
  assert.deepEqual(untrackedPaths(root), []);
});

test('an explicit "all" request stays "all" inside a real repository, whatever the branch or dirty state', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeFileSync(join(root, 'index.md'), 'root\nmore\n'); // dirty, and off the default branch

  const base = resolveBase(root, 'all');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'all-explicit');
  assert.equal(changedPaths(root, base), null);
  assert.equal(addedLines(root, base, 'index.md'), null);
});

// --- explicit worktree / merge-base: unchanged commit-to-commit and
// HEAD-to-worktree semantics ---------------------------------------------

test('a file added and committed on a feature branch appears under merge-base against main, but not under worktree', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes/new.md', 'hello\n', 'add note');

  const mergeBase = resolveBase(root, 'merge-base');
  assert.equal(mergeBase.kind, 'merge-base');
  assert.equal(mergeBase.defaultBranch, 'main');
  assert.ok(changedPaths(root, mergeBase).includes('notes/new.md'));

  const worktree = resolveBase(root, 'worktree');
  assert.equal(worktree.kind, 'worktree');
  assert.ok(!changedPaths(root, worktree).includes('notes/new.md'));
});

test('an uncommitted edit to a tracked file appears under worktree with only its added line numbers', () => {
  const root = initRepo();
  writeAndCommit(root, 'notes.md', 'one\ntwo\nthree\n', 'init');
  writeFileSync(join(root, 'notes.md'), 'one\ntwo changed\nthree\nfour\n');

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'notes.md');
  assert.deepEqual(lines.map((l) => l.line), [2, 4]);
  assert.equal(lines[0].text, 'two changed');
  assert.equal(lines[1].text, 'four');
});

test('an untracked file returns null from addedLines: every line is in scope', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeFileSync(join(root, 'new.md'), 'a\nb\n');

  const base = resolveBase(root, 'worktree');
  assert.equal(addedLines(root, base, 'new.md'), null);
});

test('a path containing a space and a path containing an accented character are both handled', () => {
  // The accented filename is the thing under test here: whether this
  // reader still reports the right scope for a path git itself renders
  // octal-escaped in a human-readable diff header. Built with
  // String.fromCharCode, never typed as a literal byte or an escape in
  // this file's own content, per this project's rule against typing a
  // unicode escape into file content.
  const eAcute = String.fromCharCode(0xe9);
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'folder with space/a.md', 'one\n', 'space path');
  writeFileSync(join(root, 'folder with space', 'a.md'), 'one\ntwo\n');

  const accentedPath = `folder with space/caf${eAcute}.md`;
  writeAndCommit(root, accentedPath, 'x\n', 'accented path');
  writeFileSync(join(root, accentedPath), 'x\ny\n');

  const base = resolveBase(root, 'worktree');
  const changed = changedPaths(root, base);
  assert.ok(changed.includes('folder with space/a.md'));
  assert.ok(changed.includes(accentedPath));

  const lines = addedLines(root, base, accentedPath);
  assert.deepEqual(lines.map((l) => l.line), [2]);
  assert.equal(lines[0].text, 'y');
});

test('a deleted file never appears under worktree', () => {
  const root = initRepo();
  writeAndCommit(root, 'gone.md', 'bye\n', 'init');
  ok(git(root, ['rm', '-q', 'gone.md']));

  const base = resolveBase(root, 'worktree');
  assert.ok(!changedPaths(root, base).includes('gone.md'));
});

test('a file deleted on a feature branch relative to main never appears under merge-base', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'notes/gone.md', 'bye\n', 'add');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  ok(git(root, ['rm', '-q', 'notes/gone.md']));
  ok(git(root, ['commit', '-q', '-m', 'remove']));

  const base = resolveBase(root, 'merge-base');
  assert.ok(!changedPaths(root, base).includes('notes/gone.md'));
});

test('changedPaths and untrackedPaths return an empty array, not an array holding an empty string, when nothing changed', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  const base = resolveBase(root, 'worktree');
  assert.deepEqual(changedPaths(root, base), []);
  assert.deepEqual(untrackedPaths(root), []);
});

test('a filename that begins with a dash is still diffed correctly, not read as an option', () => {
  const root = initRepo();
  writeAndCommit(root, '-dash.md', 'one\n', 'init');
  writeFileSync(join(root, '-dash.md'), 'one\ntwo\n');

  const base = resolveBase(root, 'worktree');
  assert.ok(changedPaths(root, base).includes('-dash.md'));
  const lines = addedLines(root, base, '-dash.md');
  assert.deepEqual(lines.map((l) => l.line), [2]);
});

test('changedPaths raises, naming the command and the error, when the resolved ref does not exist', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  const bogusBase = {
    kind: 'merge-base',
    requested: 'merge-base',
    reason: 'merge-base-explicit',
    defaultBranch: 'main',
    mergeBaseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  };
  assert.throws(
    () => changedPaths(root, bogusBase),
    (error) => error.status !== 0 && /git .*diff/.test(error.message),
  );
});

test('addedLines raises, naming the command and the error, when the resolved ref does not exist', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  const bogusBase = {
    kind: 'merge-base',
    requested: 'merge-base',
    reason: 'merge-base-explicit',
    defaultBranch: 'main',
    mergeBaseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  };
  assert.throws(
    () => addedLines(root, bogusBase, 'index.md'),
    (error) => error.status !== 0 && /git .*diff/.test(error.message),
  );
});

// --- default branch resolution ------------------------------------------

test('resolveBase finds "master" as the default branch when "main" does not exist and there is no origin', () => {
  const root = initRepo('master');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'master');
});

test('resolveBase prefers "main" over "master" when a repository has both', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['branch', 'master']));
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'main');
});

test('an explicit merge-base request degrades to all when no default branch can be identified', () => {
  const root = initRepo('trunk');
  writeAndCommit(root, 'index.md', 'root\n', 'init');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'merge-base-unavailable');
});

test('an explicit merge-base request degrades to all, rather than throwing, on an orphan branch with no common ancestor', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '--orphan', 'orphan']));
  ok(git(root, ['rm', '-q', '-rf', '.']));
  writeAndCommit(root, 'other.md', 'bye\n', 'orphan-init');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'merge-base-unavailable');
  assert.equal(changedPaths(root, base), null);
});

test('findDefaultBranch keeps the remote-tracking name qualified: a real clone with only "origin/main", no local "main" branch, still resolves and diffs', () => {
  // Reproduces the shape a continuous-integration checkout commonly
  // produces: refs/remotes/origin/* is populated and origin/HEAD is set,
  // but no local branch named "main" was ever created, because nothing
  // did the equivalent of `git branch main origin/main`. Stripping the
  // "origin/" prefix (the bug) makes merge-base ask for a ref called
  // "main" that plain does not exist here, and THROWS on an otherwise
  // perfectly good repository.
  const origin = join(makeTempDir('brain-kit-origin-'), 'repo.git');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]));
  const seed = initRepo('main');
  writeAndCommit(seed, 'index.md', 'root\n', 'init');
  ok(git(seed, ['remote', 'add', 'origin', origin]));
  ok(git(seed, ['push', '-q', 'origin', 'main']));
  ok(git(seed, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(seed, 'notes.md', 'x\n', 'add');
  ok(git(seed, ['push', '-q', 'origin', 'feature']));

  const root = makeTempDir('brain-kit-ci-checkout-');
  ok(spawnSync('git', ['init', '-q', '-b', 'placeholder', root]));
  ok(git(root, ['remote', 'add', 'origin', origin]));
  ok(git(root, ['fetch', '-q', 'origin', 'main', 'feature']));
  ok(git(root, ['remote', 'set-head', 'origin', 'main']));
  const featureSha = git(root, ['rev-parse', 'refs/remotes/origin/feature']).stdout.trim();
  ok(git(root, ['checkout', '-q', '--detach', featureSha]));

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'merge-base');
  assert.equal(base.defaultBranch, 'origin/main');
  assert.ok(changedPaths(root, base).includes('notes.md'));
});

test('findDefaultBranch falls back to a remote-tracking branch name when neither a symref nor a local branch names one', () => {
  const root = initRepo('feature');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  // Simulate a remote-tracking ref that exists without origin/HEAD ever
  // having been set to it and without a local branch of the same name:
  // fetch into refs/remotes/origin/main directly.
  ok(git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']));
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'origin/main');
});

test('a default branch that turns out to be the branch already checked out degrades rather than silently diffing a branch against itself', () => {
  // Reproduces the shape a pull-request checkout can have: the checkout
  // tool points refs/remotes/origin/HEAD at the branch it just fetched,
  // not at the remote's true default. Locally this is indistinguishable
  // from genuinely standing on the default branch, so both explicit
  // merge-base and auto must refuse to trust it rather than report a
  // silently empty scope.
  const origin = join(makeTempDir('brain-kit-origin2-'), 'repo.git');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]));
  const seed = initRepo('main');
  writeAndCommit(seed, 'index.md', 'root\n', 'init');
  ok(git(seed, ['remote', 'add', 'origin', origin]));
  ok(git(seed, ['push', '-q', 'origin', 'main']));
  ok(git(seed, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(seed, 'notes.md', 'a real change\n', 'add');
  ok(git(seed, ['push', '-q', 'origin', 'feature']));

  const root = makeTempDir('brain-kit-pr-checkout-');
  ok(spawnSync('git', ['clone', '-q', '--single-branch', '--branch', 'feature', origin, root]));
  ok(git(root, ['remote', 'set-head', 'origin', 'feature'])); // the mis-set symref

  const explicit = resolveBase(root, 'merge-base');
  assert.equal(explicit.kind, 'all');
  assert.equal(explicit.reason, 'merge-base-same-as-current');

  // Fix round 2: a fresh single-branch clone is exactly a clean tree with
  // nothing untracked, so auto's own "nothing left to compare against"
  // rule (the fix for a person's first run on a genuine default branch)
  // applies here too, for the identical reason: this mis-set symref is
  // locally indistinguishable from genuinely standing on the default
  // branch, and the same "checked nothing" failure would result either
  // way. Falling back to "all" is a welcome side effect of that fix, not
  // a separate one: it means this exact shape no longer silently reports
  // an empty scope, it reports the whole vault instead.
  const auto = resolveBase(root, 'auto');
  assert.equal(auto.kind, 'all');
  assert.equal(auto.reason, 'auto-on-default-branch-clean');
  assert.equal(changedPaths(root, auto), null); // everything is in scope, not merely nothing
});

// --- auto: a union, never a choice ---------------------------------------

test('CRITICAL: one unrelated untracked file does not hide a committed change on a feature branch under auto', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'one\ntwo\nsecretlike-value\n', 'add a committed change');

  // The stray scratch file: unrelated, uncommitted, untracked.
  writeFileSync(join(root, 'scratch.md'), 'just a scratch file\n');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-since-merge-base', 'the committed branch work must still anchor the diff');

  const changed = changedPaths(root, base);
  assert.ok(changed.includes('notes.md'), 'the committed change must not be hidden by the scratch file');
  assert.ok(changed.includes('scratch.md'), 'the untracked file is also part of the union');

  const lines = addedLines(root, base, 'notes.md');
  assert.ok(lines.some((l) => l.text === 'secretlike-value'), 'the committed line must be visible, not scoped away');
});

test('auto unions a committed branch change with a further uncommitted edit to the SAME file, in worktree-relative line numbers', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'notes.md', 'one\ntwo\nthree\n', 'seed');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'one\ntwo\nthree\nfour\n', 'commit: add four');
  // Uncommitted: insert a new first line, shifting "four" from line 4 to
  // line 5 in the actual worktree. A naive union of two separately
  // numbered diffs (branch..HEAD, then HEAD..worktree) would still say
  // "four" is at line 4, which is now the wrong line to read back.
  writeFileSync(join(root, 'notes.md'), 'ZERO\none\ntwo\nthree\nfour\n');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  const lines = addedLines(root, base, 'notes.md');
  assert.deepEqual(
    lines.map((l) => [l.line, l.text]),
    [[1, 'ZERO'], [5, 'four']],
  );
});

test('auto anchors at the merge base when the tree is clean and the branch is not the default', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-since-merge-base');
  assert.ok(changedPaths(root, base).includes('notes.md'));
});

// Fix round 2, CRITICAL, corrects a mistake ratified in fix round 1's own
// report: a clean checkout of the default branch, with nothing untracked
// either, has nothing left for the union to be a union OF. Measured
// directly: a vault whose only note already carries a committed secret,
// checked from exactly this state (a person's first run), reported zero
// findings and said so with no more caveat than a run that genuinely
// checked everything. Falling back to "all" here is not a narrower
// answer than the union, it is the honest one: there is no change to
// scope to, so the scope the question actually means is everything.
test('auto resolves to "all", not an empty union, when the tree is clean on the default branch with nothing untracked', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'untouched.md', 'never touched again\n', 'seed');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'auto-on-default-branch-clean');
  assert.equal(changedPaths(root, base), null);
  assert.equal(addedLines(root, base, 'untouched.md'), null);
});

// The one-exception is exactly that narrow: a REAL uncommitted edit or a
// new untracked note on the default branch is still a genuine, narrower
// change, and must stay a real `auto` union exactly as fix round 1 built
// it, not widen to "all" just because the branch happens to be the
// default one.
test('auto stays a real union on the default branch when there IS an uncommitted change to scope to', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'untouched.md', 'never touched again\n', 'seed');
  writeFileSync(join(root, 'index.md'), 'root\nan uncommitted edit\n');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-on-default-branch');
  assert.equal(base.anchor, 'HEAD');
  const changed = changedPaths(root, base);
  assert.ok(changed.includes('index.md'));
  assert.ok(!changed.includes('untouched.md'), 'a file this edit never touched must stay out of scope');
});

test('auto stays a real union on the default branch when there is nothing uncommitted but a new file is untracked', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'untouched.md', 'never touched again\n', 'seed');
  writeFileSync(join(root, 'fresh.md'), 'a brand new untracked note\n');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-on-default-branch');
  const changed = changedPaths(root, base);
  assert.ok(changed.includes('fresh.md'));
  assert.ok(!changed.includes('untouched.md'));
});

test('auto falls back to a plain HEAD anchor, not "all", when the tree is clean but no default branch can be identified', () => {
  const root = initRepo('trunk');
  writeAndCommit(root, 'index.md', 'root\n', 'init');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-no-default-branch');
  assert.equal(base.anchor, 'HEAD');
});

test('auto falls back to a plain HEAD anchor, still unioned with untracked files, on an orphan branch with no common ancestor', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '--orphan', 'orphan']));
  ok(git(root, ['rm', '-q', '-rf', '.']));
  writeAndCommit(root, 'other.md', 'bye\n', 'orphan-init');
  writeFileSync(join(root, 'scratch.md'), 'x\n');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-merge-base-unavailable');
  assert.equal(base.anchor, 'HEAD');
  assert.ok(changedPaths(root, base).includes('scratch.md'));
});

// --- status-zero: a command that succeeds while telling us nothing -------

test('a null byte in a note (git calls it binary) does not hide its added line', () => {
  const root = initRepo();
  writeAndCommit(root, 'note.md', 'one\n', 'init');
  const nul = String.fromCharCode(0);
  writeFileSync(join(root, 'note.md'), `one${nul}\ntwo\n`);

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'note.md');
  assert.ok(lines.length > 0, 'a binary-detected file must still be scanned as text');
  assert.ok(lines.some((l) => l.text.includes('two')));
});

test('a .gitattributes entry turning diffs off for markdown does not disable added-line scanning', () => {
  const root = initRepo();
  writeAndCommit(root, '.gitattributes', '*.md -diff\n', 'init');
  writeAndCommit(root, 'note.md', 'one\ntwo\n', 'seed');
  writeFileSync(join(root, 'note.md'), 'one\ntwo\nthree\n');

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'note.md');
  assert.deepEqual(lines.map((l) => l.text), ['three']);
});

test('a typechange (a symlink replaced by a regular file) does not report a spurious added line at position zero', () => {
  const root = initRepo();
  writeAndCommit(root, 'real.md', 'target\n', 'seed real');
  symlinkSync('real.md', join(root, 'link.md'));
  ok(git(root, ['add', 'link.md']));
  ok(git(root, ['commit', '-q', '-m', 'add symlink']));

  unlinkSync(join(root, 'link.md'));
  writeFileSync(join(root, 'link.md'), 'a\nb\nc\n');

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'link.md');
  assert.ok(lines.every((l) => l.line > 0), `no added line should be numbered zero: ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.map((l) => l.text), ['a', 'b', 'c']);
});

test('a path with a glob metacharacter is diffed literally, never matched as a pattern against a different file', () => {
  const root = initRepo();
  writeAndCommit(root, 'note[1].md', 'a\n', 'init');
  writeAndCommit(root, 'note1.md', 'b\n', 'init2');
  writeFileSync(join(root, 'note[1].md'), 'a\nx\n');
  writeFileSync(join(root, 'note1.md'), 'b\ny\n');

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'note[1].md');
  assert.deepEqual(lines.map((l) => l.text), ['x'], 'must not also pick up note1.md\'s "y"');
});

test('an added line whose own text looks like a hunk header is captured as content, not mistaken for a new hunk', () => {
  const root = initRepo();
  writeAndCommit(root, 'note.md', 'one\ntwo\n', 'init');
  const lookalike = 'an example hunk header looks like @@ -1 +1 @@ in a diff';
  writeFileSync(join(root, 'note.md'), `one\ntwo\n${lookalike}\n`);

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'note.md');
  assert.deepEqual(lines.map((l) => [l.line, l.text]), [[3, lookalike]]);
});

test('a pure rename (no content change) reports no added lines, not every line of the file', () => {
  const root = initRepo();
  writeAndCommit(root, 'old.md', 'one\ntwo\nthree\n', 'init');
  ok(git(root, ['mv', 'old.md', 'new.md']));

  const base = resolveBase(root, 'worktree');
  assert.ok(changedPaths(root, base).includes('new.md'));
  const lines = addedLines(root, base, 'new.md');
  assert.deepEqual(lines, [], 'a vault reorganisation must not flag every line of a moved note');
});

test('a rename combined with a real content change reports only the genuinely new line', () => {
  const root = initRepo();
  writeAndCommit(root, 'old.md', 'one\ntwo\nthree\n', 'init');
  ok(git(root, ['mv', 'old.md', 'new.md']));
  writeFileSync(join(root, 'new.md'), 'one\ntwo\nthree\nfour\n');

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'new.md');
  assert.deepEqual(lines.map((l) => [l.line, l.text]), [[4, 'four']]);
});

test('a rename is still found when an unrelated ordinary change sorts before it and its own path starts with "R"', () => {
  // "Readme.md" sorts before "old-b.md" in git's own listing, and its
  // name happens to start with the same letter a rename record's status
  // starts with ("R100"). This is exactly the layout that desyncs a
  // token-by-token reader of `--name-status -z` output if it ever
  // advances by the wrong number of tokens for an ordinary (non-rename)
  // record: the next record's own PATH, not its status, is what would be
  // misread as a status.
  const root = initRepo();
  writeAndCommit(root, 'Readme.md', 'r1\n', 'init');
  writeAndCommit(root, 'old-b.md', 'one\ntwo\n', 'init2');
  writeFileSync(join(root, 'Readme.md'), 'r1\nr2\n');
  ok(git(root, ['mv', 'old-b.md', 'new-b.md']));

  const base = resolveBase(root, 'worktree');
  assert.ok(changedPaths(root, base).includes('new-b.md'));
  const lines = addedLines(root, base, 'new-b.md');
  assert.deepEqual(lines, [], 'the rename must still be found despite the preceding record');
});

test('a CRLF line ending does not survive into the captured added-line text', () => {
  const root = initRepo();
  writeAndCommit(root, 'note.md', 'one\n', 'init');
  const cr = String.fromCharCode(13);
  writeFileSync(join(root, 'note.md'), `one${cr}\ntwo${cr}\n`);

  const base = resolveBase(root, 'worktree');
  const lines = addedLines(root, base, 'note.md');
  assert.ok(lines.every((l) => !l.text.includes(cr)), `no captured text should carry a bare CR: ${JSON.stringify(lines)}`);
});

// --- status checks with no earlier test (a corrupted index, cheap and
// safe to build by writing garbage into .git/index) ----------------------

function corruptIndex(root) {
  writeFileSync(join(root, '.git', 'index'), 'not a real index file');
}

test('untrackedPaths raises rather than returning empty when the index is unreadable', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  corruptIndex(root);
  assert.throws(() => untrackedPaths(root), (error) => error.status !== 0);
});

test('changedPaths under auto raises rather than silently reporting half a union when the index is unreadable', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  ok(git(root, ['checkout', '-q', '-b', 'feature']));
  writeAndCommit(root, 'notes.md', 'x\n', 'add');
  const base = resolveBase(root, 'auto');
  corruptIndex(root);
  assert.throws(() => changedPaths(root, base), (error) => error.status !== 0);
});

// --- fix round 3, finding F: which remote decides the default branch ---------
//
// The same three-step ladder is written twice, here and in
// templates/githooks/pre-push, and the two had already drifted on this
// exact field: the template takes the remote from git itself (which
// hands a pre-push hook the remote being pushed to), this module
// hardcoded "origin". The template was right. This module has no push to
// read a remote from, so it reads the remote the current branch actually
// tracks, and falls back to "origin" only when there is none.
test('the default-branch ladder follows the remote the current branch tracks, not a hardcoded "origin"', () => {
  const upstream = makeTempDir('brain-kit-git-upstream-');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', upstream]), 'bare init');

  // No local branch called main or master anywhere, so the ladder's
  // second rung cannot answer and the remote-tracking rung has to. The
  // remote is called "upstream", and there is no "origin" at all: before
  // fix round 3 this repository had no identifiable default branch and
  // `merge-base` degraded to the whole vault, silently.
  const root = initRepo('work');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['remote', 'add', 'upstream', upstream]), 'remote add');
  ok(git(root, ['push', '-q', 'upstream', 'work:main']), 'push');
  ok(git(root, ['fetch', '-q', 'upstream']), 'fetch');
  ok(git(root, ['branch', '--set-upstream-to=upstream/main', 'work']), 'set upstream');
  writeAndCommit(root, 'notes/new.md', '# New\n', 'add a note after the shared point');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'merge-base', `expected a real merge base, got ${base.reason}`);
  assert.equal(base.defaultBranch, 'upstream/main');
  assert.deepEqual(changedPaths(root, base), ['notes/new.md']);
});

// The other direction: nothing tracked, so "origin" is still the answer,
// which is what every ordinary clone relies on.
test('with no upstream to read, the ladder still falls back to origin', () => {
  const origin = makeTempDir('brain-kit-git-origin-');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]), 'bare init');

  const root = initRepo('work');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['remote', 'add', 'origin', origin]), 'remote add');
  ok(git(root, ['push', '-q', 'origin', 'work:main']), 'push');
  ok(git(root, ['fetch', '-q', 'origin']), 'fetch');
  writeAndCommit(root, 'notes/new.md', '# New\n', 'add a note after the shared point');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'merge-base', `expected a real merge base, got ${base.reason}`);
  assert.equal(base.defaultBranch, 'origin/main');
});

// --- fix round 3, finding H: the scope contract speaks vault-relative paths ---
//
// `changedPaths` used to return REPOSITORY-relative paths while `files`,
// `context.all` and every path a rule ever sees are VAULT-relative. The
// two agreed for a vault that IS the repository root, which is every
// other fixture in this file, which is exactly how a mismatch like this
// survives until the first rule reads the field.
test('changedPaths returns paths relative to the vault, not to an enclosing repository', () => {
  const repo = initRepo('main');
  writeAndCommit(repo, 'README.md', '# Repo\n', 'init');
  const vault = join(repo, 'vault');
  mkdirSync(vault, { recursive: true });
  writeAndCommit(repo, 'vault/index.md', '# Index\n', 'add the vault');

  writeFileSync(join(vault, 'index.md'), '# Index\n\nOne more line.\n');
  writeFileSync(join(vault, 'scratch.md'), '# Scratch\n');

  const base = resolveBase(vault, 'auto');
  const changed = changedPaths(vault, base);
  assert.ok(changed.includes('index.md'), `expected a vault-relative "index.md", got ${JSON.stringify(changed)}`);
  assert.ok(changed.includes('scratch.md'), `expected a vault-relative "scratch.md", got ${JSON.stringify(changed)}`);
  assert.ok(!changed.some((path) => path.startsWith('vault/')), `no path may be repository-relative: ${JSON.stringify(changed)}`);
  // Both halves of the union agree with each other, which is the half of
  // this that was never true before: the diff was repository-relative and
  // `git ls-files` was already cwd-relative.
  assert.deepEqual(untrackedPaths(vault), ['scratch.md']);
});

// The companion to the ladder above, and the clause a hardcoded "origin"
// prefix hid: once the ladder can name a remote other than origin, the
// "is this qualified ref the branch I am already on" guard has to strip
// whatever remote name it is actually given. Stripping the literal
// "origin/" read "upstream/main" as a branch called "upstream/main",
// decided it was never the current branch, and diffed a branch against
// itself, which git reports as an EMPTY range with complete confidence:
// exactly the status-zero wrong answer this guard exists to catch.
test('merge-base degrades loudly when the default branch on a non-origin remote IS the branch already checked out', () => {
  const upstream = makeTempDir('brain-kit-git-same-');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', upstream]), 'bare init');

  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['remote', 'add', 'upstream', upstream]), 'remote add');
  ok(git(root, ['push', '-q', 'upstream', 'main']), 'push');
  ok(git(root, ['fetch', '-q', 'upstream']), 'fetch');
  ok(git(root, ['remote', 'set-head', 'upstream', '--auto']), 'set-head');
  ok(git(root, ['branch', '--set-upstream-to=upstream/main', 'main']), 'set upstream');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'merge-base-same-as-current');
});

// --- final fix round 2: the bare name comes from the remote actually read ---
//
// git accepts a remote whose own name holds a slash. The guard against
// diffing a branch against itself used to strip everything before the
// FIRST slash of the qualified default branch, so "team/up/main" read as a
// branch called "up/main", never the branch checked out, and an explicit
// merge-base on the default branch resolved to an empty range at status
// zero: the exact answer the guard exists to refuse.
function repoTrackingRemote(remote, { localBranchNamedLikeRemote = false } = {}) {
  const bare = makeTempDir('brain-kit-git-slash-');
  ok(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]), 'bare init');
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['remote', 'add', remote, bare]), 'remote add');
  ok(git(root, ['push', '-q', remote, 'main']), 'push');
  ok(git(root, ['fetch', '-q', remote]), 'fetch');
  ok(git(root, ['remote', 'set-head', remote, '--auto']), 'set-head');
  ok(git(root, ['branch', `--set-upstream-to=${remote}/main`, 'main']), 'set upstream');
  if (localBranchNamedLikeRemote) ok(git(root, ['branch', `${remote}/main`]), 'a local branch named like the remote-tracking one');
  return root;
}

test('a remote whose name holds a slash does not defeat the same-branch guard', () => {
  const root = repoTrackingRemote('team/up');
  const explicit = resolveBase(root, 'merge-base');
  assert.equal(explicit.kind, 'all');
  assert.equal(explicit.reason, 'merge-base-same-as-current');
  // auto on a clean default branch widens to the whole vault, as it does
  // for any remote, rather than anchoring at a merge base that is HEAD.
  assert.equal(resolveBase(root, 'auto').reason, 'auto-on-default-branch-clean');
  // And from a feature branch that tracks the same remote, the ladder
  // names the default branch in full and diffs against it.
  ok(git(root, ['checkout', '-q', '-b', 'feature']), 'feature');
  ok(git(root, ['branch', '--set-upstream-to=team/up/main', 'feature']), 'feature tracks the slash remote');
  writeAndCommit(root, 'notes.md', '# Notes\n', 'feature work');
  const feature = resolveBase(root, 'merge-base');
  assert.equal(feature.kind, 'merge-base');
  assert.equal(feature.defaultBranch, 'team/up/main');
  assert.deepEqual(changedPaths(root, feature), ['notes.md']);
});

test('a local branch named like the remote-tracking default does not make the ladder read a shortened, ambiguous name', () => {
  // --short prints "remotes/origin/main" once a local "origin/main"
  // exists; the ladder reads the symbolic reference in full instead.
  const root = repoTrackingRemote('origin', { localBranchNamedLikeRemote: true });
  assert.equal(git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim(), 'remotes/origin/main', 'the ambiguity this test exists for');
  assert.equal(resolveBase(root, 'merge-base').reason, 'merge-base-same-as-current');
});

test('a remote HEAD pointed by hand at a local branch still has a bare name to compare; pointed anywhere else, the ladder degrades rather than trust a range it cannot check', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main']), 'symref to a local branch');
  assert.equal(resolveBase(root, 'merge-base').reason, 'merge-base-same-as-current');

  ok(git(root, ['tag', 'anchor']), 'tag');
  ok(git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/tags/anchor']), 'symref to a tag');
  ok(git(root, ['checkout', '-q', '-b', 'feature']), 'feature');
  assert.equal(resolveBase(root, 'merge-base').reason, 'merge-base-unavailable');
  assert.equal(resolveBase(root, 'auto').reason, 'auto-no-default-branch');
});

// --- final fix round 2: what a push from this vault could publish ---------

test('publishablePaths is null outside a repository', () => {
  assert.equal(publishablePaths(makeTempDir('brain-kit-git-norepo-')), null);
});

test('publishablePaths lists what git tracks and what it would add, dot-paths included and ignored files not, relative to the vault', () => {
  const outer = initRepo('main');
  const vault = join(outer, 'vault');
  writeAndCommit(outer, 'vault/.env', 'KEY=1\n', 'env');
  writeAndCommit(outer, 'vault/notes/a.md', '# A\n', 'a');
  writeAndCommit(outer, 'vault/.gitignore', 'local/\n*.log\n', 'ignore');
  writeAndCommit(outer, 'elsewhere.md', '# outside the vault\n', 'outside');
  mkdirSync(join(vault, 'local'));
  writeFileSync(join(vault, 'local', 'secret'), 'never pushed\n');
  writeFileSync(join(vault, 'debug.log'), 'never pushed\n');
  writeFileSync(join(vault, '.env.local'), 'would be added\n');
  writeFileSync(join(vault, 'new.md'), 'would be added\n');
  const listed = publishablePaths(vault);
  assert.deepEqual(listed.files, ['.env', '.env.local', '.gitignore', 'new.md', 'notes/a.md']);
  assert.deepEqual(listed.gitlinks, []);
  assert.deepEqual(listed.embedded, []);
  assert.deepEqual(listed.undecodable, []);
});

test('publishablePaths sets apart a submodule, a repository of its own and a name that is not UTF-8, and lists each path once', { skip: process.platform !== 'linux' ? 'only Linux lets a file name hold arbitrary bytes' : false }, () => {
  const inner = initRepo('main');
  writeAndCommit(inner, 'inside.txt', 'inside\n', 'inner');
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  ok(git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']), 'submodule add');
  ok(git(root, ['commit', '-q', '-m', 'submodule']), 'commit submodule');
  ok(spawnSync('git', ['init', '-q', join(root, 'embedded')]), 'an untracked repository inside');
  writeFileSync(Buffer.concat([Buffer.from(join(root, 'bad'), 'utf8'), Buffer.from([0xff]), Buffer.from('.txt')]), 'x\n');
  const listed = publishablePaths(root);
  assert.deepEqual(listed.gitlinks, ['sub']);
  assert.deepEqual(listed.embedded, ['embedded']);
  assert.deepEqual(listed.undecodable, ['bad\u00ff.txt']);
  assert.deepEqual(listed.files, ['.gitmodules', 'index.md']);
});

test('publishablePaths raises, naming the command, when git cannot list the index', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  writeFileSync(join(root, '.git', 'index'), 'not an index');
  assert.throws(() => publishablePaths(root), /git .*ls-files/);
});

// git stood in for, for one listing, by a script first on PATH: when the
// listing's own flag is among the arguments it prints `output` (a printf
// format) and nothing else; every other call reaches the real git.
function withListingStandIn(flag, output, body) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shims = makeTempDir('brain-kit-git-shim-');
  writeFileSync(join(shims, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = "${flag}" ]; then printf '${output}'; exit 0; fi`,
    'done',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${shims}:${path}`;
  try {
    return body();
  } finally {
    process.env.PATH = path;
  }
}

// A record the parser cannot read is refused, never read as a path. Were
// it read as one, a change in what git prints would turn every tracked
// file into a path that does not exist, reported as absent, and the scan
// would read nothing while its own exit said the push was fine.
test('publishablePaths refuses a listing record with no path in it rather than reading the record as a path', { skip: process.platform === 'win32' ? 'the stand-in is a shell script' : false }, () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  withListingStandIn('--stage', '100644 0123456789abcdef0123456789abcdef01234567 0 index.md\\000', () => {
    assert.throws(() => publishablePaths(root), /no path in it/);
  });
});

// The last record of a listing that does not end in a NUL is still a
// record. Dropped, it would be the one file the scan never reads, with
// nothing said about it.
test('publishablePaths keeps the last record of a listing that does not end in a NUL', { skip: process.platform === 'win32' ? 'the stand-in is a shell script' : false }, () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', '# Index\n', 'init');
  withListingStandIn('--others', 'first.md\\000last.md', () => {
    assert.deepEqual(publishablePaths(root).files, ['first.md', 'index.md', 'last.md']);
  });
});

test('the merge base is computed against the remote-tracking reference itself, never a short name a local branch of the same name shadows', () => {
  const root = repoTrackingRemote('origin');
  const initial = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  writeAndCommit(root, 'published.md', '# Published\n', 'published on main');
  ok(git(root, ['push', '-q', 'origin', 'main']), 'push');
  ok(git(root, ['fetch', '-q', 'origin']), 'fetch');
  // A local branch called "origin/main", left at an OLDER commit: the
  // short name "origin/main" now means this branch to git, not the
  // remote-tracking one.
  ok(git(root, ['branch', 'origin/main', initial]), 'a stale local branch named like the remote-tracking one');
  ok(git(root, ['checkout', '-q', '-b', 'feature']), 'feature');
  ok(git(root, ['branch', '--set-upstream-to=refs/remotes/origin/main', 'feature']), 'feature tracks origin');
  writeAndCommit(root, 'notes.md', '# Notes\n', 'feature work');
  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'merge-base');
  assert.deepEqual(changedPaths(root, base), ['notes.md'], 'the file already on the remote-tracking default branch must not count as changed');
});
