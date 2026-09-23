import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeSnapshot, readSnapshot, splitDirty } from '../src/guards/snapshot.mjs';
import { GUARD_FILES, GuardError } from '../src/guards/location.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { git, makeRepo, write } from './helpers/git-repo.mjs';

const NOW = new Date('2026-09-16T09:30:00.000Z');
const FILES = { 'index.md': '# Index\n', 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'notes/c.md': 'c\n' };
const TRANSLATORS = { en: createTranslator('en'), 'pt-BR': createTranslator('pt-BR') };

// Characters built at run time: no escape is typed into a file here.
const A_TILDE = String.fromCodePoint(0xe3);

// A name of raw bytes: text around one byte that is not valid UTF-8.
function bytesName(before, byte, after) {
  return Buffer.concat([Buffer.from(before), Buffer.from([byte]), Buffer.from(after)]);
}

const key = (path) => (typeof path === 'string' ? Buffer.from(path) : path).toString('hex');
const keys = (paths) => paths.map(key);

function snapshotFile(root) {
  return join(root, '.git', GUARD_FILES.SNAPSHOT);
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
}

function codeOf(fn) {
  return thrownBy(fn).code;
}

function rendersIn(error, needle) {
  for (const [lang, t] of Object.entries(TRANSLATORS)) {
    const text = t(error.messageKey, error.params);
    assert.ok(text.includes(needle), `${lang}: ${JSON.stringify(text)} does not name ${needle}`);
  }
}

// Asserts a split, with every path compared as bytes.
function assertSplit(split, { before, since }) {
  assert.deepEqual(keys(split.before), keys(before).sort(), 'before');
  assert.deepEqual(keys(split.since), keys(since).sort(), 'since');
}

// --- the brief's cases ----------------------------------------------------------

test('a snapshot of a tree with two dirty files, followed by a third change, splits into two before and one since', () => {
  const root = makeRepo(FILES);
  write(root, 'notes/a.md', 'a, edited by someone else\n');
  write(root, 'scratch.md', 'untracked\n');
  const snapshot = takeSnapshot(root, { now: NOW });
  assert.deepEqual(snapshot.paths.map(String), ['notes/a.md', 'scratch.md']);
  write(root, 'notes/b.md', 'b, edited by this session\n');
  assertSplit(splitDirty(root, snapshot), { before: ['notes/a.md', 'scratch.md'], since: ['notes/b.md'] });
});

test('outside a repository there is nothing to snapshot and nowhere to keep one: refused with exit 2, in both languages, writing nothing', () => {
  const plain = realpathSync(makeTempDir('brain-kit-snap-plain-'));
  write(plain, 'index.md', '# Index\n');
  for (const fn of [() => takeSnapshot(plain), () => readSnapshot(plain),
    () => splitDirty(plain, { at: NOW.toISOString(), root: plain, paths: [] })]) {
    const error = thrownBy(fn);
    assert.ok(error instanceof GuardError);
    assert.equal(error.code, 'GUARD_NOT_A_REPOSITORY');
    assert.equal(error.exitCode, EXIT.USAGE);
    rendersIn(error, plain);
  }
  assert.deepEqual(readdirSync(plain), ['index.md']);
});

// --- where it is kept, and how -----------------------------------------------------

test('the snapshot is kept in the git common directory, 0600, paths in hex, with nothing else left there, and read back identical', () => {
  const root = makeRepo(FILES);
  write(root, 'notes/a.md', 'edited\n');
  const snapshot = takeSnapshot(root, { now: NOW });
  assert.deepEqual(snapshot, { at: NOW.toISOString(), root, paths: [Buffer.from('notes/a.md')] });
  const stored = JSON.parse(readFileSync(snapshotFile(root), 'utf8'));
  assert.deepEqual(stored, { format: 1, at: NOW.toISOString(), root, paths: [Buffer.from('notes/a.md').toString('hex')] });
  assert.equal(statSync(snapshotFile(root)).mode & 0o777, 0o600);
  assert.deepEqual(readSnapshot(root), snapshot);
  assert.deepEqual(readdirSync(join(root, '.git')).filter((name) => name.startsWith('brain-kit')), [GUARD_FILES.SNAPSHOT]);

  // A second snapshot replaces the first.
  write(root, 'notes/b.md', 'edited\n');
  takeSnapshot(root);
  assert.deepEqual(readSnapshot(root).paths.map(String), ['notes/a.md', 'notes/b.md']);
  assert.deepEqual(readdirSync(join(root, '.git')).filter((name) => name.startsWith('brain-kit')), [GUARD_FILES.SNAPSHOT]);
});

test('readSnapshot is null only when no snapshot was taken: a file that cannot be read, or is not a snapshot, raises', () => {
  const root = makeRepo(FILES);
  assert.equal(readSnapshot(root), null);
  const valid = { format: 1, at: NOW.toISOString(), root: '/v', paths: ['612e6d64'] };
  for (const bad of ['', 'not json', 'null', '[]', { ...valid, format: 2 }, { ...valid, format: undefined }, { ...valid, at: 1 },
    { ...valid, root: null }, { ...valid, paths: '612e6d64' }, { ...valid, paths: [1] }, { ...valid, paths: [''] }, { ...valid, paths: ['abc'] },
    { ...valid, paths: ['zz'] }, { ...valid, paths: ['61 62'] }, { ...valid, paths: ['6162\n'] }, { ...valid, paths: ['AB'] }]) {
    writeFileSync(snapshotFile(root), typeof bad === 'string' ? bad : JSON.stringify(bad));
    const error = thrownBy(() => readSnapshot(root));
    assert.equal(error.code, 'SNAPSHOT_UNREADABLE', `snapshot ${JSON.stringify(bad)}`);
    rendersIn(error, snapshotFile(root));
  }
  writeFileSync(snapshotFile(root), JSON.stringify(valid));
  assert.deepEqual(readSnapshot(root), { at: valid.at, root: '/v', paths: [Buffer.from('a.md')] });
  // There, but not readable as a file: raised, never "no snapshot".
  unlinkSync(snapshotFile(root));
  mkdirSync(snapshotFile(root));
  assert.equal(codeOf(() => readSnapshot(root)), 'EISDIR');
});

// --- what counts ------------------------------------------------------------------

test('every path in any state is recorded: staged, unstaged, deleted, renamed (both sides), untracked one by one, ignored', () => {
  const root = makeRepo({ ...FILES, '.gitignore': 'drafts/\n*.log\n' });
  write(root, 'notes/a.md', 'unstaged edit\n');
  write(root, 'notes/b.md', 'staged edit\n');
  git(root, ['add', 'notes/b.md']);
  unlinkSync(join(root, 'index.md'));
  git(root, ['mv', 'notes/c.md', 'notes/moved.md']);
  write(root, 'new/deep/one.md', '1\n');
  write(root, 'new/deep/two.md', '2\n');
  write(root, 'staged-new.md', 'n\n');
  git(root, ['add', 'staged-new.md']);
  write(root, 'drafts/x/draft.md', 'ignored folder\n');
  write(root, 'debug.log', 'ignored file\n');
  const snapshot = takeSnapshot(root);
  assert.deepEqual(snapshot.paths.map(String), [
    'debug.log', 'drafts/x/draft.md', 'index.md', 'new/deep/one.md', 'new/deep/two.md', 'notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/moved.md',
    'staged-new.md',
  ]);
});

test('an ignored draft of another session that becomes visible when an ignore rule changes stays before', () => {
  const root = makeRepo({ ...FILES, '.gitignore': 'scratch/\n' });
  write(root, 'scratch/other-session-draft.md', 'someone else, unfinished\n');
  const snapshot = takeSnapshot(root);
  assert.deepEqual(splitDirty(root, snapshot), { before: [], since: [] });
  write(root, '.gitignore', '');
  write(root, 'index.md', '# Index\n\nThis session.\n');
  assertSplit(splitDirty(root, snapshot), { before: ['scratch/other-session-draft.md'], since: ['.gitignore', 'index.md'] });
  // The same through .git/info/exclude, a rule no commit ever shows.
  const other = makeRepo(FILES);
  write(other, '.git/info/exclude', 'private/\n');
  write(other, 'private/draft.md', 'someone else\n');
  const snap = takeSnapshot(other);
  write(other, '.git/info/exclude', '');
  assertSplit(splitDirty(other, snap), { before: ['private/draft.md'], since: [] });
});

test('an ignored file the session creates is neither before nor since: nothing can propose it', () => {
  const root = makeRepo({ ...FILES, '.gitignore': '*.log\n' });
  const snapshot = takeSnapshot(root);
  write(root, 'build.log', 'noise\n');
  write(root, 'notes/a.md', 'session\n');
  assertSplit(splitDirty(root, snapshot), { before: [], since: ['notes/a.md'] });
});

// Every awkward name, on both sides of the split: the other session's
// version is dirty before the snapshot, the session's own after it.
const AWKWARD = [
  ['a newline', 'fore\nign.md', 'ses\nsion.md'],
  ['an accented letter', `reuni${A_TILDE}o-a.md`, `reuni${A_TILDE}o-b.md`],
  ['a byte that is not UTF-8', bytesName('caf', 0xe9, '.md'), bytesName('caf', 0xe8, '.md')],
  ['a leading dot', '.env.local', '.env.session'],
  ['a leading space', ' lead-a.md', ' lead-b.md'],
  ['a trailing space', 'trail-a.md ', 'trail-b.md '],
  ['only an edge space apart', 'edge.md ', 'edge.md'],
  ['only a non-UTF-8 byte apart, twice', bytesName('x', 0xff, '.md'), bytesName('x', 0xfe, '.md')],
];

test('awkward names land on the right side of the split, as untracked files, byte for byte', () => {
  const root = makeRepo(FILES);
  for (const [, foreign] of AWKWARD) write(root, foreign, 'the other session\n');
  const snapshot = takeSnapshot(root);
  for (const [, , own] of AWKWARD) write(root, own, 'this session\n');
  assertSplit(splitDirty(root, snapshot), { before: AWKWARD.map(([, foreign]) => foreign), since: AWKWARD.map(([, , own]) => own) });
  // And after a round trip through the stored file.
  assertSplit(splitDirty(root, readSnapshot(root)), { before: AWKWARD.map(([, foreign]) => foreign), since: AWKWARD.map(([, , own]) => own) });
});

test('awkward names land on the right side of the split as tracked, modified files too', () => {
  const root = makeRepo(FILES);
  for (const [, foreign, own] of AWKWARD) {
    write(root, foreign, 'committed\n');
    write(root, own, 'committed\n');
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'awkward names']);
  for (const [, foreign] of AWKWARD) write(root, foreign, 'the other session\n');
  const snapshot = takeSnapshot(root);
  for (const [, , own] of AWKWARD) write(root, own, 'this session\n');
  assertSplit(splitDirty(root, snapshot), { before: AWKWARD.map(([, foreign]) => foreign), since: AWKWARD.map(([, , own]) => own) });
});

test('a name that is not UTF-8 is stored as its bytes, and never collapses with its neighbour', () => {
  const root = makeRepo(FILES);
  const e9 = bytesName('caf', 0xe9, '.md');
  const e8 = bytesName('caf', 0xe8, '.md');
  write(root, e9, 'x\n');
  write(root, e8, 'y\n');
  const snapshot = takeSnapshot(root);
  assert.deepEqual(keys(snapshot.paths), keys([e8, e9]));
  assert.deepEqual(JSON.parse(readFileSync(snapshotFile(root), 'utf8')).paths, [e8.toString('hex'), e9.toString('hex')]);
  assert.deepEqual(keys(readSnapshot(root).paths), keys([e8, e9]));
});

// Three index stages for `path`, as a merge conflict leaves them.
function makeUnmerged(root, path) {
  const blob = (text) => git(root, ['hash-object', '-w', '--stdin'], { input: text }).trim();
  const [base, ours, theirs] = [blob('base\n'), blob('ours\n'), blob('theirs\n')];
  git(root, ['update-index', '--index-info'], { input: `100644 ${base} 1\t${path}\n100644 ${ours} 2\t${path}\n100644 ${theirs} 3\t${path}\n` });
  write(root, path, '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
}

test('unmerged paths land on the right side of the split', () => {
  const root = makeRepo(FILES);
  makeUnmerged(root, 'conflict-foreign.md');
  const snapshot = takeSnapshot(root);
  assert.ok(keys(snapshot.paths).includes(key('conflict-foreign.md')));
  makeUnmerged(root, 'conflict-own.md');
  assertSplit(splitDirty(root, snapshot), { before: ['conflict-foreign.md'], since: ['conflict-own.md'] });
});

test('changed submodules land on the right side of the split, even with submodules hidden by configuration', () => {
  const source = makeRepo({ 'readme.md': 'sub\n' }, 'brain-kit-snap-subsrc-');
  const root = makeRepo(FILES);
  git(root, ['submodule', 'add', '-q', source, 'sub-foreign']);
  git(root, ['submodule', 'add', '-q', source, 'sub-own']);
  git(root, ['commit', '-q', '-m', 'submodules']);
  git(root, ['config', 'diff.ignoreSubmodules', 'all']);
  git(root, ['config', 'submodule.sub-foreign.ignore', 'all']);
  git(root, ['config', 'submodule.sub-own.ignore', 'all']);
  write(root, 'sub-foreign/readme.md', 'the other session\n');
  const snapshot = takeSnapshot(root);
  assert.ok(keys(snapshot.paths).includes(key('sub-foreign')));
  write(root, 'sub-own/readme.md', 'this session\n');
  assertSplit(splitDirty(root, snapshot), { before: ['sub-foreign'], since: ['sub-own'] });
});

test('a file added to a directory that was already untracked is filed as since, even with untracked files hidden by configuration', () => {
  const root = makeRepo(FILES);
  git(root, ['config', 'status.showUntrackedFiles', 'no']);
  write(root, 'foreign/one.md', 'someone else\n');
  const snapshot = takeSnapshot(root);
  assert.deepEqual(snapshot.paths.map(String), ['foreign/one.md']);
  write(root, 'foreign/two.md', 'this session\n');
  assertSplit(splitDirty(root, snapshot), { before: ['foreign/one.md'], since: ['foreign/two.md'] });
});

test('a path dirty before and touched again stays before; a path cleaned since is in neither list', () => {
  const root = makeRepo(FILES);
  write(root, 'notes/a.md', 'foreign edit\n');
  write(root, 'notes/b.md', 'foreign edit\n');
  const snapshot = takeSnapshot(root);
  write(root, 'notes/a.md', 'foreign edit, then this session too\n');
  git(root, ['checkout', '--', 'notes/b.md']);
  assertSplit(splitDirty(root, snapshot), { before: ['notes/a.md'], since: [] });
});

// --- whose answer ------------------------------------------------------------------

test('a GIT_DIR in the environment naming another repository changes nothing: the answer is about the vault', () => {
  const root = makeRepo(FILES);
  const other = makeRepo({ 'elsewhere.md': 'x\n' });
  write(other, 'elsewhere.md', 'dirty in the other repository\n');
  write(root, 'notes/a.md', 'dirty in the vault\n');
  const env = { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') };
  const snapshot = takeSnapshot(root, { env });
  assert.deepEqual(snapshot.paths.map(String), ['notes/a.md']);
  write(root, 'notes/b.md', 'this session\n');
  assertSplit(splitDirty(root, snapshot, { env }), { before: ['notes/a.md'], since: ['notes/b.md'] });
  assert.deepEqual(readSnapshot(root, { env }), snapshot);
  assert.deepEqual(readdirSync(join(other, '.git')).filter((name) => name.startsWith('brain-kit')), []);

  // The same, through the default: the environment of the process itself.
  const saved = {};
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    saved[name] = process.env[name];
    process.env[name] = env[name];
  }
  try {
    const viaProcess = takeSnapshot(root);
    assert.deepEqual(viaProcess.paths.map(String), ['notes/a.md', 'notes/b.md']);
    write(root, 'notes/c.md', 'this session again\n');
    assertSplit(splitDirty(root, viaProcess), { before: ['notes/a.md', 'notes/b.md'], since: ['notes/c.md'] });
    assert.deepEqual(readSnapshot(root), viaProcess);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a snapshot of another working tree is refused, a linked worktree included; the same tree through a symlink is not', () => {
  const root = makeRepo(FILES);
  const other = makeRepo(FILES);
  const snapshot = takeSnapshot(root);
  const error = thrownBy(() => splitDirty(other, snapshot));
  assert.equal(error.code, 'SNAPSHOT_OTHER_ROOT');
  assert.equal(error.exitCode, EXIT.FAILURE);
  rendersIn(error, root);
  const worktree = join(root, '..', 'worktree');
  git(root, ['worktree', 'add', '-q', '-b', 'other', worktree]);
  assert.equal(codeOf(() => splitDirty(worktree, snapshot)), 'SNAPSHOT_OTHER_ROOT');
  const link = join(makeTempDir('brain-kit-snap-link-'), 'vault-link');
  symlinkSync(root, link);
  assertSplit(splitDirty(link, snapshot), { before: [], since: [] });
  assert.equal(takeSnapshot(link).root, root);
});

test('a directory inside a repository but not its top level is refused; so is the git directory itself', () => {
  const root = makeRepo(FILES);
  const error = thrownBy(() => takeSnapshot(join(root, 'notes')));
  assert.equal(error.code, 'SNAPSHOT_NOT_TOPLEVEL');
  assert.equal(error.exitCode, EXIT.USAGE);
  rendersIn(error, root);
  const snapshot = takeSnapshot(root);
  assert.equal(codeOf(() => splitDirty(join(root, 'notes'), snapshot)), 'SNAPSHOT_NOT_TOPLEVEL');
  assert.equal(codeOf(() => takeSnapshot(join(root, '.git'))), 'GUARD_NOT_A_REPOSITORY');
});

test('splitDirty refuses anything that is not a snapshot', () => {
  const root = makeRepo(FILES);
  for (const bad of [null, undefined, {}, { at: NOW.toISOString(), root }, { at: NOW.toISOString(), root, paths: ['notes/a.md'] },
    { at: NOW.toISOString(), root, paths: [Buffer.alloc(0)] }, { at: 1, root, paths: [] }, { at: NOW.toISOString(), root: 1, paths: [] }]) {
    assert.equal(codeOf(() => splitDirty(root, bad)), 'SNAPSHOT_INVALID', String(bad && JSON.stringify(bad)));
  }
});

// --- git failing ------------------------------------------------------------------

test('git missing, or failing, is an error, never read as "not a repository, nothing dirty"', () => {
  const root = makeRepo(FILES);
  const empty = makeTempDir('brain-kit-snap-nogit-');
  const noGit = { ...process.env, PATH: empty };
  assert.equal(codeOf(() => takeSnapshot(root, { env: noGit })), 'GUARD_GIT_FAILED');
  const plain = makeTempDir('brain-kit-snap-plain-');
  assert.equal(codeOf(() => takeSnapshot(plain, { env: noGit })), 'GUARD_GIT_FAILED');
  const snapshot = takeSnapshot(root);
  assert.equal(codeOf(() => splitDirty(root, snapshot, { env: noGit })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => readSnapshot(root, { env: noGit })), 'GUARD_GIT_FAILED');
});

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
  assert.equal(codeOf(() => takeSnapshot(plain, { env: translatedGit() })), 'GUARD_NOT_A_REPOSITORY');
});

// A git that answers everything truthfully except the call carrying
// `trigger`, which prints `output` (bytes) and exits `status`.
function fakeGit(output, status = 0, trigger = 'status') {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = makeTempDir('brain-kit-snap-fakegit-');
  const script = join(bin, 'git');
  writeFileSync(join(bin, 'output'), output);
  writeFileSync(script, [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = ${trigger} ]; then cat '${join(bin, 'output')}'; exit ${status}; fi`,
    'done',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test('a git status record this reader does not understand is refused, never skipped', () => {
  const root = makeRepo(FILES);
  for (const output of ['MMnotes/a.md\0', '?? \0', 'M\0', '\0', ' M notes/a.md']) {
    assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit(output) })), 'GUARD_GIT_FAILED', JSON.stringify(output));
  }
  const raw = Buffer.concat([Buffer.from(' M notes/a.md\0?? x y.md\0!! '), bytesName('caf', 0xe9, '.md'), Buffer.from('\0')]);
  assert.deepEqual(keys(takeSnapshot(root, { env: fakeGit(raw) }).paths), keys(['notes/a.md', 'x y.md', bytesName('caf', 0xe9, '.md')]).sort());
});

test('a git status, or a top-level query, that fails is an error, whatever it printed before failing', () => {
  const root = makeRepo(FILES);
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit(' M notes/a.md\0', 128) })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit('', 1) })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit('', 128, '--show-toplevel') })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit('', 0, '--git-common-dir') })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit('.git\n', 128, '--git-common-dir') })), 'GUARD_GIT_FAILED');
  assert.equal(codeOf(() => takeSnapshot(root, { env: fakeGit('true\n', 1, '--is-inside-work-tree') })), 'GUARD_GIT_FAILED');
  const snapshot = takeSnapshot(root);
  assert.equal(codeOf(() => splitDirty(root, snapshot, { env: fakeGit('', 1) })), 'GUARD_GIT_FAILED');
});

test('a vault whose path ends in a space is its own top level: only git\'s newline is taken off a path it prints', () => {
  const parent = realpathSync(makeTempDir('brain-kit-snap-space-'));
  const root = join(parent, 'vault ');
  mkdirSync(root);
  mkdirSync(join(parent, 'vault'));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'a.md', 'a\n');
  const snapshot = takeSnapshot(root);
  assert.equal(snapshot.root, root);
  assertSplit(splitDirty(root, snapshot), { before: ['a.md'], since: [] });
});

// --- touching nothing -------------------------------------------------------------

test('taking a snapshot writes nothing into the vault, not even the index refresh a plain git status makes', () => {
  const root = makeRepo(FILES);
  write(root, 'notes/a.md', 'edited\n');
  // Same bytes, newer time: a plain `git status` refreshes this entry and
  // rewrites the index, the file another live session may be using.
  const later = new Date(Date.now() + 5000);
  write(root, 'notes/b.md', 'b\n');
  utimesSync(join(root, 'notes/b.md'), later, later);
  const indexBefore = readFileSync(join(root, '.git', 'index'));
  const snapshot = takeSnapshot(root);
  splitDirty(root, snapshot);
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), indexBefore);
  assert.equal(git(root, ['stash', 'list']), '');
  assert.equal(readFileSync(join(root, 'notes/a.md'), 'utf8'), 'edited\n');
});

test('two linked worktrees share one snapshot file: the second snapshot replaces the first, which then refuses to answer', () => {
  const root = makeRepo(FILES);
  const worktree = join(root, '..', 'worktree');
  git(root, ['worktree', 'add', '-q', '-b', 'other', worktree]);
  const first = takeSnapshot(root);
  takeSnapshot(worktree);
  assert.equal(readSnapshot(root).root, realpathSync(worktree));
  assert.equal(codeOf(() => splitDirty(root, readSnapshot(root))), 'SNAPSHOT_OTHER_ROOT');
  assertSplit(splitDirty(root, first), { before: [], since: [] });
  rmSync(worktree, { recursive: true, force: true });
});

