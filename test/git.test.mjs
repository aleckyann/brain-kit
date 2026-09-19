import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isGitRepo, resolveBase, changedPaths, addedLines, untrackedPaths } from '../src/git.mjs';

// Every case here builds a REAL temporary git repository via spawnSync with
// an argument array, never a mock. A local commit identity is set on every
// call, so these tests never depend on the machine's global git config, and
// no remote is ever touched.
function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
}

function initRepo(branch = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-git-'));
  assert.equal(spawnSync('git', ['init', '-q', '-b', branch, root]).status, 0);
  return root;
}

function writeAndCommit(root, relPath, content, message) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  assert.equal(git(root, ['add', '--', relPath]).status, 0);
  assert.equal(git(root, ['commit', '-q', '-m', message]).status, 0, `commit "${message}" failed`);
}

test('isGitRepo is true inside a repository and false in a plain directory', () => {
  const root = initRepo();
  assert.equal(isGitRepo(root), true);
  const plain = mkdtempSync(join(tmpdir(), 'brain-kit-plain-'));
  assert.equal(isGitRepo(plain), false);
});

test('resolveBase rejects a base id it does not know, rather than silently degrading', () => {
  const root = initRepo();
  assert.throws(() => resolveBase(root, 'nonsense'), /unknown base/);
});

test('a file added and committed on a feature branch appears under merge-base against main, but not under worktree', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
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
  // octal-escaped in a human-readable diff header.
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'folder with space/a.md', 'one\n', 'space path');
  writeFileSync(join(root, 'folder with space', 'a.md'), 'one\ntwo\n');

  const accentedPath = 'folder with space/café.md';
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
  assert.equal(git(root, ['rm', '-q', 'gone.md']).status, 0);

  const base = resolveBase(root, 'worktree');
  assert.ok(!changedPaths(root, base).includes('gone.md'));
});

test('a file deleted on a feature branch relative to main never appears under merge-base', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  writeAndCommit(root, 'notes/gone.md', 'bye\n', 'add');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  assert.equal(git(root, ['rm', '-q', 'notes/gone.md']).status, 0);
  assert.equal(git(root, ['commit', '-q', '-m', 'remove']).status, 0);

  const base = resolveBase(root, 'merge-base');
  assert.ok(!changedPaths(root, base).includes('notes/gone.md'));
});

test('auto picks worktree when the working tree is dirty', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeFileSync(join(root, 'index.md'), 'root\nmore\n'); // uncommitted: dirty
  assert.equal(resolveBase(root, 'auto').kind, 'worktree');
});

test('auto picks merge-base when the tree is clean and the branch is not the default', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeAndCommit(root, 'notes.md', 'x\n', 'add');
  assert.equal(resolveBase(root, 'auto').kind, 'merge-base');
});

test('auto picks all when the tree is clean and the branch is the default', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(resolveBase(root, 'auto').kind, 'all');
});

test('an explicit "all" request stays "all" inside a real repository, whatever the branch or dirty state', () => {
  const root = initRepo();
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeFileSync(join(root, 'index.md'), 'root\nmore\n'); // dirty, and off the default branch

  const base = resolveBase(root, 'all');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'all-explicit');
  assert.equal(changedPaths(root, base), null);
  assert.equal(addedLines(root, base, 'index.md'), null);
});

test('findDefaultBranch prefers a configured origin/HEAD over the local branch names', () => {
  const bareOrigin = mkdtempSync(join(tmpdir(), 'brain-kit-origin-'));
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', bareOrigin]).status, 0);
  const root = initRepo('trunk');
  assert.equal(git(root, ['remote', 'add', 'origin', bareOrigin]).status, 0);
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['push', '-q', 'origin', 'trunk']).status, 0);
  // A real clone learns the remote's default branch through this symref;
  // a fresh `git init` + `remote add` never sets it on its own.
  assert.equal(git(root, ['remote', 'set-head', 'origin', 'trunk']).status, 0);
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'trunk');
});

test('resolveBase prefers "main" over "master" when a repository has both', () => {
  const root = initRepo('main');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['branch', 'master']).status, 0);
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'main');
});

test('auto falls back to all, not merge-base, when the tree is clean but no default branch can be identified', () => {
  const root = initRepo('trunk');
  writeAndCommit(root, 'index.md', 'root\n', 'init');

  const base = resolveBase(root, 'auto');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'auto-no-default-branch');
});

test('resolveBase finds "master" as the default branch when "main" does not exist and there is no origin', () => {
  const root = initRepo('master');
  writeAndCommit(root, 'index.md', 'root\n', 'init');
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  writeAndCommit(root, 'notes.md', 'x\n', 'add');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.defaultBranch, 'master');
});

test('an explicit merge-base request degrades to all when no default branch can be identified', () => {
  const root = initRepo('trunk');
  writeAndCommit(root, 'index.md', 'root\n', 'init');

  const base = resolveBase(root, 'merge-base');
  assert.equal(base.kind, 'all');
  assert.equal(base.reason, 'merge-base-unavailable');
});

test('outside a git repository every base degrades to all, and every file returns null lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-not-git-'));
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

test('untrackedPaths lists a new file and excludes one matched by .gitignore', () => {
  const root = initRepo();
  writeAndCommit(root, '.gitignore', 'ignored.md\n', 'init');
  writeFileSync(join(root, 'ignored.md'), 'x\n');
  writeFileSync(join(root, 'fresh.md'), 'y\n');

  const untracked = untrackedPaths(root);
  assert.ok(untracked.includes('fresh.md'));
  assert.ok(!untracked.includes('ignored.md'));
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
    (error) => error.status !== 0 && /git diff/.test(error.message),
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
    (error) => error.status !== 0 && /git diff/.test(error.message),
  );
});
