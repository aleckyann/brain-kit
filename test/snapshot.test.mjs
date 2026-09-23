import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { takeSnapshot, readSnapshot, splitDirty } from '../src/guards/snapshot.mjs';
import { STATE_FILES } from '../src/state.mjs';
import { withoutLocalGitVars } from '../src/git-env.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const NOW = new Date('2026-09-16T09:30:00.000Z');
const CLEAN_ENV = withoutLocalGitVars(process.env);

// Real repositories, built with a local identity on every call and the
// caller's git environment removed, so nothing here depends on the
// machine's git configuration or on a GIT_DIR the runner happens to carry.
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', ...args], { cwd, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result;
}

function write(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function repo(files = { 'index.md': '# Index\n', 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'notes/c.md': 'c\n' }) {
  const root = join(makeTempDir('brain-kit-snap-'), 'vault');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  for (const [relPath, content] of Object.entries(files)) write(root, relPath, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function stateDir() {
  return join(makeTempDir('brain-kit-snap-state-'), 'state');
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return 'no error';
}

test('a snapshot of a tree with two dirty files, followed by a third change, splits into two before and one since', () => {
  const root = repo();
  const dir = stateDir();
  write(root, 'notes/a.md', 'a, edited by someone else\n');
  write(root, 'scratch.md', 'untracked\n');
  const snapshot = takeSnapshot(root, dir, { now: NOW });
  assert.deepEqual(snapshot.dirty, ['notes/a.md', 'scratch.md']);
  write(root, 'notes/b.md', 'b, edited by this session\n');
  assert.deepEqual(splitDirty(root, snapshot), { before: ['notes/a.md', 'scratch.md'], since: ['notes/b.md'] });
});

test('the snapshot is written to the state directory, 0600, with nothing else left there, and read back identical', () => {
  const root = repo();
  const dir = stateDir();
  write(root, 'notes/a.md', 'edited\n');
  const snapshot = takeSnapshot(root, dir, { now: NOW });
  assert.deepEqual(snapshot, { at: NOW.toISOString(), root, repository: true, dirty: ['notes/a.md'] });
  assert.deepEqual(readSnapshot(dir), snapshot);
  assert.deepEqual(readdirSync(dir), [STATE_FILES.SNAPSHOT]);
  assert.equal(statSync(join(dir, STATE_FILES.SNAPSHOT)).mode & 0o777, 0o600);
  assert.deepEqual(splitDirty(root, readSnapshot(dir)), { before: ['notes/a.md'], since: [] });

  // A second snapshot replaces the first.
  write(root, 'notes/b.md', 'edited\n');
  takeSnapshot(root, dir, { now: NOW });
  assert.deepEqual(readSnapshot(dir).dirty, ['notes/a.md', 'notes/b.md']);
  assert.deepEqual(readdirSync(dir), [STATE_FILES.SNAPSHOT]);
});

test('a snapshot of a non-repository is empty and says so, and splits into nothing', () => {
  const root = makeTempDir('brain-kit-snap-plain-');
  write(root, 'index.md', '# Index\n');
  const dir = stateDir();
  const snapshot = takeSnapshot(root, dir, { now: NOW });
  assert.equal(snapshot.repository, false);
  assert.deepEqual(snapshot.dirty, []);
  assert.equal(readSnapshot(dir).repository, false);
  write(root, 'other.md', 'x\n');
  assert.deepEqual(splitDirty(root, snapshot), { before: [], since: [] });
});

test('readSnapshot is null when none was taken, and refuses a file that is not a snapshot', () => {
  const dir = stateDir();
  assert.equal(readSnapshot(dir), null);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, STATE_FILES.SNAPSHOT);
  const valid = { at: NOW.toISOString(), root: '/v', repository: true, dirty: ['a.md'] };
  for (const bad of ['', 'not json', 'null', '[]', { ...valid, at: 1 }, { ...valid, root: null }, { ...valid, repository: 'yes' },
    { ...valid, dirty: 'a.md' }, { ...valid, dirty: [1] }, { ...valid, dirty: [''] }]) {
    writeFileSync(target, typeof bad === 'string' ? bad : JSON.stringify(bad));
    assert.equal(codeOf(() => readSnapshot(dir)), 'SNAPSHOT_UNREADABLE', `snapshot ${JSON.stringify(bad)}`);
  }
  writeFileSync(target, JSON.stringify(valid));
  assert.deepEqual(readSnapshot(dir), valid);
});

test('every kind of dirty path is recorded: staged, unstaged, deleted, renamed (both sides), untracked files one by one', () => {
  const root = repo();
  const dir = stateDir();
  write(root, 'notes/a.md', 'unstaged edit\n');
  write(root, 'notes/b.md', 'staged edit\n');
  git(root, ['add', 'notes/b.md']);
  unlinkSync(join(root, 'index.md'));
  git(root, ['mv', 'notes/c.md', 'notes/moved.md']);
  write(root, 'new/deep/one.md', '1\n');
  write(root, 'new/deep/two.md', '2\n');
  write(root, 'staged-new.md', 'n\n');
  git(root, ['add', 'staged-new.md']);
  // An accented letter, built at run time.
  const name = `odd "name" with sp${String.fromCodePoint(0xe1)}ce.md`;
  write(root, name, 'x\n');
  const snapshot = takeSnapshot(root, dir);
  assert.deepEqual(snapshot.dirty, [
    'index.md', 'new/deep/one.md', 'new/deep/two.md', 'notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/moved.md', name, 'staged-new.md',
  ].sort());
});

test('ignored files are not dirty', () => {
  const root = repo({ '.gitignore': '*.log\n', 'index.md': '# Index\n' });
  write(root, 'debug.log', 'noise\n');
  assert.deepEqual(takeSnapshot(root, stateDir()).dirty, []);
});

test('a file added to a directory that was already untracked is filed as since, even with untracked files hidden by configuration', () => {
  const root = repo();
  git(root, ['config', 'status.showUntrackedFiles', 'no']);
  const dir = stateDir();
  write(root, 'foreign/one.md', 'someone else\n');
  const snapshot = takeSnapshot(root, dir);
  assert.deepEqual(snapshot.dirty, ['foreign/one.md']);
  write(root, 'foreign/two.md', 'this session\n');
  assert.deepEqual(splitDirty(root, snapshot), { before: ['foreign/one.md'], since: ['foreign/two.md'] });
});

test('a path dirty before and touched again stays before; a path cleaned since is in neither list', () => {
  const root = repo();
  const dir = stateDir();
  write(root, 'notes/a.md', 'foreign edit\n');
  write(root, 'notes/b.md', 'foreign edit\n');
  const snapshot = takeSnapshot(root, dir);
  write(root, 'notes/a.md', 'foreign edit, then this session too\n');
  git(root, ['checkout', '--', 'notes/b.md']);
  assert.deepEqual(splitDirty(root, snapshot), { before: ['notes/a.md'], since: [] });
});

test('a GIT_DIR in the environment naming another repository changes nothing: the answer is about the vault', () => {
  const root = repo();
  const other = repo({ 'elsewhere.md': 'x\n' });
  write(other, 'elsewhere.md', 'dirty in the other repository\n');
  write(root, 'notes/a.md', 'dirty in the vault\n');
  const env = { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') };
  const dir = stateDir();
  const snapshot = takeSnapshot(root, dir, { env });
  assert.deepEqual(snapshot.dirty, ['notes/a.md']);
  write(root, 'notes/b.md', 'this session\n');
  assert.deepEqual(splitDirty(root, snapshot, { env }), { before: ['notes/a.md'], since: ['notes/b.md'] });

  // And a plain directory stays a plain directory under that environment.
  const plain = makeTempDir('brain-kit-snap-plain-');
  assert.equal(takeSnapshot(plain, stateDir(), { env }).repository, false);

  // The same, through the default: the environment of the process itself.
  const saved = {};
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    saved[name] = process.env[name];
    process.env[name] = env[name];
  }
  try {
    const viaProcess = takeSnapshot(root, stateDir());
    assert.deepEqual(viaProcess.dirty, ['notes/a.md', 'notes/b.md']);
    write(root, 'notes/c.md', 'this session again\n');
    assert.deepEqual(splitDirty(root, viaProcess), { before: ['notes/a.md', 'notes/b.md'], since: ['notes/c.md'] });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a snapshot of another directory is refused; the same directory through a symlink is not', () => {
  const root = repo();
  const other = repo();
  const snapshot = takeSnapshot(root, stateDir());
  assert.equal(codeOf(() => splitDirty(other, snapshot)), 'SNAPSHOT_OTHER_ROOT');
  const link = join(makeTempDir('brain-kit-snap-link-'), 'vault-link');
  symlinkSync(root, link);
  assert.deepEqual(splitDirty(link, snapshot), { before: [], since: [] });
  assert.equal(takeSnapshot(link, stateDir()).root, root);
});

test('a directory inside a repository but not its top level is refused, and so is the git directory itself', () => {
  const root = repo();
  assert.equal(codeOf(() => takeSnapshot(join(root, 'notes'), stateDir())), 'SNAPSHOT_NOT_TOPLEVEL');
  assert.equal(codeOf(() => takeSnapshot(join(root, '.git'), stateDir())), 'SNAPSHOT_NOT_TOPLEVEL');
});

test('a snapshot taken when the vault was not a repository cannot answer once it is one, nor the other way round', () => {
  const root = makeTempDir('brain-kit-snap-became-');
  write(root, 'index.md', '# Index\n');
  const before = takeSnapshot(root, stateDir());
  git(root, ['init', '-q', '-b', 'main']);
  assert.equal(codeOf(() => splitDirty(root, before)), 'SNAPSHOT_REPOSITORY_CHANGED');
  const asRepo = takeSnapshot(root, stateDir());
  rmSync(join(root, '.git'), { recursive: true, force: true });
  assert.equal(codeOf(() => splitDirty(root, asRepo)), 'SNAPSHOT_REPOSITORY_CHANGED');
});

test('splitDirty refuses anything that is not a snapshot', () => {
  const root = repo();
  for (const bad of [null, undefined, {}, { at: NOW.toISOString(), root, repository: true }, { at: NOW.toISOString(), root, repository: true, dirty: [3] }]) {
    assert.equal(codeOf(() => splitDirty(root, bad)), 'SNAPSHOT_UNREADABLE', JSON.stringify(bad));
  }
});

test('git missing, or failing, is an error, never read as "not a repository, nothing dirty"', () => {
  const root = repo();
  const empty = makeTempDir('brain-kit-snap-nogit-');
  assert.equal(codeOf(() => takeSnapshot(root, stateDir(), { env: { ...process.env, PATH: empty } })), 'SNAPSHOT_GIT_FAILED');
  const plain = makeTempDir('brain-kit-snap-plain-');
  assert.equal(codeOf(() => takeSnapshot(plain, stateDir(), { env: { ...process.env, PATH: empty } })), 'SNAPSHOT_GIT_FAILED');
  const snapshot = takeSnapshot(root, stateDir());
  assert.equal(codeOf(() => splitDirty(root, snapshot, { env: { ...process.env, PATH: empty } })), 'SNAPSHOT_GIT_FAILED');
});

// A git that answers everything truthfully except `status`, which prints
// what the test hands it.
function fakeStatusGit(output, status = 0, trigger = 'status') {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = makeTempDir('brain-kit-snap-fakegit-');
  const script = join(bin, 'git');
  writeFileSync(join(bin, 'status-output'), output);
  writeFileSync(script, [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = ${trigger} ]; then cat '${join(bin, 'status-output')}'; exit ${status}; fi`,
    'done',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

// A git that answers in Portuguese unless the locale is C, as a git with
// its translations installed does.
function translatedGit() {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = makeTempDir('brain-kit-snap-ptgit-');
  const script = join(bin, 'git');
  writeFileSync(script, [
    '#!/bin/sh',
    'if [ "$LC_ALL" != C ]; then',
    `  if ! '${real}' rev-parse --git-dir >/dev/null 2>&1; then echo 'fatal: nao e um repositorio git' >&2; exit 128; fi`,
    'fi',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return { ...process.env, LC_ALL: 'pt_BR.UTF-8', PATH: `${bin}:${process.env.PATH}` };
}

test('a git that speaks another language is still understood when it says the directory is not a repository', () => {
  const plain = makeTempDir('brain-kit-snap-plain-');
  const snapshot = takeSnapshot(plain, stateDir(), { env: translatedGit() });
  assert.equal(snapshot.repository, false);
});

test('a git status record this reader does not understand is refused, never skipped', () => {
  const root = repo();
  for (const output of ['MMnotes/a.md\0', '?? \0', 'M\0']) {
    assert.equal(codeOf(() => takeSnapshot(root, stateDir(), { env: fakeStatusGit(output) })), 'SNAPSHOT_GIT_FAILED', JSON.stringify(output));
  }
  assert.deepEqual(takeSnapshot(root, stateDir(), { env: fakeStatusGit(' M notes/a.md\0?? x y.md\0') }).dirty, ['notes/a.md', 'x y.md']);
});

test('a git status, or a top-level query, that fails is an error, whatever it printed before failing', () => {
  const root = repo();
  assert.equal(codeOf(() => takeSnapshot(root, stateDir(), { env: fakeStatusGit(' M notes/a.md\0', 128) })), 'SNAPSHOT_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, stateDir(), { env: fakeStatusGit('', 1) })), 'SNAPSHOT_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, stateDir(), { env: fakeStatusGit('', 128, '--show-toplevel') })), 'SNAPSHOT_GIT_FAILED');
});

test('taking a snapshot writes nothing into the vault, not even the index refresh a plain git status makes', () => {
  const root = repo();
  write(root, 'notes/a.md', 'edited\n');
  // Same bytes, newer time: a plain `git status` refreshes this entry and
  // rewrites the index, the file another live session may be using.
  const later = new Date(Date.now() + 5000);
  write(root, 'notes/b.md', 'b\n');
  utimesSync(join(root, 'notes/b.md'), later, later);
  const indexBefore = readFileSync(join(root, '.git', 'index'));
  takeSnapshot(root, stateDir());
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), indexBefore);
  assert.equal(git(root, ['stash', 'list']).stdout, '');
  assert.equal(readFileSync(join(root, 'notes/a.md'), 'utf8'), 'edited\n');
});
