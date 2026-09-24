// The SessionStart hook, run as Claude Code runs it: the real launcher with
// the event JSON on standard input, against a throwaway vault from
// `init --yes`. Review focus 1: a snapshot taken at startup is kept when the
// same session compacts or resumes, and retaken otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../src/guards/lock.mjs';
import { GUARD_FILES } from '../src/guards/location.mjs';
import { readSnapshot } from '../src/guards/snapshot.mjs';
import { git, makeRepo } from './helpers/git-repo.mjs';
import { makeHookVault, runHookProcess } from './helpers/hook-world.mjs';

function start(fx, payload, { root = fx.root } = {}) {
  const r = runHookProcess('session-start', { hook_event_name: 'SessionStart', cwd: root, ...payload }, { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function contextOf(r) {
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /\n/, 'one line');
  return out.hookSpecificOutput.additionalContext;
}

const recorded = (root, env) => readSnapshot(root, { env }).paths.map(String);

test('startup takes a snapshot for the session and prints one valid SessionStart line naming the vault and the paths already there', () => {
  const fx = makeHookVault();
  writeFileSync(join(fx.root, 'draft.md'), 'foreign draft\n');
  const r = start(fx, { session_id: 's1', source: 'startup' });
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('}\n'));
  const line = contextOf(r);
  assert.match(line, /"Second brain"/);
  assert.match(line, /1 path\(s\) were already there/);
  assert.doesNotMatch(line, /lock/i);
  const snapshot = readSnapshot(fx.root, { env: fx.env });
  assert.equal(snapshot.session, 's1');
  assert.equal(snapshot.root, fx.root);
  assert.deepEqual(snapshot.paths.map(String), ['draft.md']);
});

test('compact of the same session keeps the snapshot: a file written after startup is still not in it', () => {
  const fx = makeHookVault();
  start(fx, { session_id: 's1', source: 'startup' });
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const line = contextOf(start(fx, { session_id: 's1', source: 'compact' }));
  assert.match(line, /kept across the compaction or resume: 0 path/);
  assert.deepEqual(recorded(fx.root, fx.env), []);
  assert.equal(readSnapshot(fx.root, { env: fx.env }).session, 's1');
});

test('resume of the same session keeps the snapshot', () => {
  const fx = makeHookVault();
  start(fx, { session_id: 's1', source: 'startup' });
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  assert.match(contextOf(start(fx, { session_id: 's1', source: 'resume' })), /kept/);
  assert.deepEqual(recorded(fx.root, fx.env), []);
});

test('compact or resume of another session retakes the snapshot for that session', () => {
  for (const source of ['compact', 'resume']) {
    const fx = makeHookVault();
    start(fx, { session_id: 's1', source: 'startup' });
    writeFileSync(join(fx.root, 'earlier.md'), 'the first session\n');
    assert.match(contextOf(start(fx, { session_id: 's2', source })), /Session snapshot taken: 1 path/);
    assert.deepEqual(recorded(fx.root, fx.env), ['earlier.md']);
    assert.equal(readSnapshot(fx.root, { env: fx.env }).session, 's2');
  }
});

test('clear, and a second startup, retake the snapshot even for the same session id', () => {
  for (const source of ['clear', 'startup']) {
    const fx = makeHookVault();
    start(fx, { session_id: 's1', source: 'startup' });
    writeFileSync(join(fx.root, 'before-clear.md'), 'x\n');
    assert.match(contextOf(start(fx, { session_id: 's1', source })), /taken/);
    assert.deepEqual(recorded(fx.root, fx.env), ['before-clear.md'], source);
  }
});

test('a session with no id never keeps a snapshot, not even one taken for no session', () => {
  const fx = makeHookVault();
  start(fx, { source: 'startup' });
  assert.equal(readSnapshot(fx.root, { env: fx.env }).session, null);
  writeFileSync(join(fx.root, 'later.md'), 'x\n');
  assert.match(contextOf(start(fx, { source: 'compact' })), /taken/);
  assert.deepEqual(recorded(fx.root, fx.env), ['later.md']);
  start(fx, { session_id: '', source: 'startup' });
  writeFileSync(join(fx.root, 'later2.md'), 'x\n');
  start(fx, { session_id: '', source: 'compact' });
  assert.deepEqual(recorded(fx.root, fx.env), ['later.md', 'later2.md']);
});

test('a snapshot of another working tree is retaken even for the same session on compact: a vault copied elsewhere', () => {
  const fx = makeHookVault();
  start(fx, { session_id: 's1', source: 'startup' });
  const copy = join(fx.base, 'copy');
  cpSync(fx.root, copy, { recursive: true });
  writeFileSync(join(copy, 'in-copy.md'), 'x\n');
  assert.equal(readSnapshot(copy, { env: fx.env }).root, fx.root, 'the copy carries the original snapshot');
  assert.match(contextOf(start(fx, { session_id: 's1', source: 'compact' }, { root: copy })), /taken/);
  const snapshot = readSnapshot(copy, { env: fx.env });
  assert.equal(snapshot.root, copy);
  assert.deepEqual(snapshot.paths.map(String), ['in-copy.md']);
});

test('an unreadable snapshot is replaced and the line says so', () => {
  const fx = makeHookVault();
  writeFileSync(join(fx.root, '.git', GUARD_FILES.SNAPSHOT), 'not json');
  const line = contextOf(start(fx, { session_id: 's1', source: 'compact' }));
  assert.match(line, /could not be read, so it was replaced/);
  assert.equal(readSnapshot(fx.root, { env: fx.env }).session, 's1');
});

test('outside a vault the hook prints nothing at all, even in a dirty repository with an index.md', () => {
  const fx = makeHookVault();
  const other = makeRepo({ 'index.md': '# Someone else\n' });
  writeFileSync(join(other, 'wip.md'), 'x\n');
  // Their own brain-kit.config.json without a valid kit_version is not the sentinel.
  for (const config of [null, '{ not json', '{"kit_version": 1}', '{"kit_version": "1.2"}', '[]']) {
    if (config !== null) writeFileSync(join(other, 'brain-kit.config.json'), config);
    const r = start(fx, { session_id: 's1', source: 'startup' }, { root: other });
    assert.deepEqual([r.stdout, r.stderr], ['', ''], String(config));
    assert.equal(readFileSync(join(other, '.git', 'HEAD'), 'utf8').length > 0, true);
    assert.throws(() => readFileSync(join(other, '.git', GUARD_FILES.SNAPSHOT)), { code: 'ENOENT' });
  }
});

test('a payload that is not a JSON object prints nothing on stdout, one line on stderr, and exits 0', () => {
  const fx = makeHookVault();
  for (const input of ['{ nope', '[]', '"text"', 'null', '']) {
    const r = runHookProcess('session-start', input, { env: fx.env, cwd: fx.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', JSON.stringify(input));
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, r.stderr);
    assert.match(r.stderr, /not a JSON object/);
  }
});

test('a vault that is not a repository, or not the top level of one, takes no snapshot and says the Stop hook cannot tell', () => {
  const plain = makeHookVault({ commit: false });
  rmSync(join(plain.root, '.git'), { recursive: true, force: true });
  let r = start(plain, { session_id: 's1', source: 'startup' });
  assert.match(contextOf(r), /cannot tell this session's work from earlier work/);
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
  assert.match(r.stderr, /no session snapshot was taken\. .*is not inside a git working tree/);

  const nested = makeHookVault({ commit: false });
  rmSync(join(nested.root, '.git'), { recursive: true, force: true });
  git(nested.base, ['init', '-q', '-b', 'main']);
  r = start(nested, { session_id: 's1', source: 'startup' });
  assert.match(contextOf(r), /cannot tell/);
  assert.match(r.stderr, /not its top level/);
  assert.throws(() => readFileSync(join(nested.base, '.git', GUARD_FILES.SNAPSHOT)), { code: 'ENOENT' });
});

test('a held lock is named in the line with its command and pid', () => {
  const fx = makeHookVault();
  const lock = acquireLock(fx.root, { command: 'brain-kit sync', env: fx.env });
  try {
    const line = contextOf(start(fx, { session_id: 's1', source: 'startup' }));
    assert.match(line, new RegExp(`held by brain-kit sync \\(pid ${process.pid}\\)`));
  } finally {
    lock.release();
  }
  writeFileSync(join(fx.root, '.git', GUARD_FILES.LOCK), 'garbage');
  assert.match(contextOf(start(fx, { session_id: 's1', source: 'startup' })), /cannot be read, so its holder is unknown/);
});

test('a pt-BR vault gets its line in Portuguese whatever the environment says', () => {
  const fx = makeHookVault({ lang: 'pt-BR' });
  const line = contextOf(start(fx, { session_id: 's1', source: 'startup' }));
  assert.match(line, /Retrato da sessão tirado/);
});

test('the hook writes nothing into the working tree', () => {
  const fx = makeHookVault();
  mkdirSync(join(fx.root, 'notes'), { recursive: true });
  writeFileSync(join(fx.root, 'notes', 'x.md'), 'x\n');
  const before = git(fx.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
  start(fx, { session_id: 's1', source: 'startup' });
  start(fx, { session_id: 's1', source: 'compact' });
  assert.equal(git(fx.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']), before);
});
