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

  const auto = resolveBase(root, 'auto');
  assert.equal(auto.kind, 'auto');
  assert.equal(auto.anchor, 'HEAD');
  assert.notEqual(auto.reason, 'auto-since-merge-base');
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

test('auto anchors at HEAD, and stays a real (non-"all") union, when the tree is clean and the branch is the default', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'untouched.md', 'never touched again\n', 'seed');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'auto');
  assert.equal(base.reason, 'auto-on-default-branch');
  assert.equal(base.anchor, 'HEAD');
  // Nothing has changed, so the union is empty, not "everything": this is
  // the fix for the pre-review design, which used to fall back to
  // scanning the whole vault here and would have flagged "untouched.md".
  assert.deepEqual(changedPaths(root, base), []);
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
