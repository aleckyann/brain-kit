// The SessionStart hook, run as Claude Code runs it: the real launcher with
// the event JSON on standard input, against a throwaway vault from
// `init --yes`. Review focus 1: a snapshot is written only when a session
// starts; a compaction or resume never writes one, and says so when the
// snapshot on disk is not this session's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, currentIdentity } from '../src/guards/lock.mjs';
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

test('compact or resume of another session writes nothing: the first session\'s snapshot stays, and the line says the work cannot be told apart', () => {
  for (const source of ['compact', 'resume']) {
    const fx = makeHookVault();
    start(fx, { session_id: 's1', source: 'startup' });
    writeFileSync(join(fx.root, 'earlier.md'), 'the first session\n');
    const line = contextOf(start(fx, { session_id: 's2', source }));
    assert.match(line, /cannot tell this session's work from earlier work and will count every changed path/, source);
    assert.doesNotMatch(line, /Session snapshot taken|was kept/, source);
    assert.deepEqual(recorded(fx.root, fx.env), [], source);
    assert.equal(readSnapshot(fx.root, { env: fx.env }).session, 's1', source);
  }
});

test('compact or resume with no snapshot on disk writes none', () => {
  for (const source of ['compact', 'resume']) {
    const fx = makeHookVault();
    writeFileSync(join(fx.root, 'mid.md'), 'written before the plugin was on\n');
    assert.match(contextOf(start(fx, { session_id: 's1', source })), /cannot tell this session's work/, source);
    assert.equal(readSnapshot(fx.root, { env: fx.env }), null, source);
  }
});

test('A writes a.md, B starts, A compacts: A\'s Stop still blocks listing a.md', () => {
  const fx = makeHookVault();
  start(fx, { session_id: 'A', source: 'startup' });
  writeFileSync(join(fx.root, 'a.md'), 'A wrote this\n');
  start(fx, { session_id: 'B', source: 'startup' });
  assert.match(contextOf(start(fx, { session_id: 'A', source: 'compact' })), /cannot tell/);
  assert.equal(readSnapshot(fx.root, { env: fx.env }).session, 'B');
  const r = runHookProcess('stop', { session_id: 'A', stop_hook_active: false, cwd: fx.root }, { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^This session changed 1 path\(s\) in the vault:\n {2}a\.md\n/);
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

test('a session with no id never keeps a snapshot, and its compaction writes none', () => {
  const fx = makeHookVault();
  start(fx, { source: 'startup' });
  assert.equal(readSnapshot(fx.root, { env: fx.env }).session, null);
  writeFileSync(join(fx.root, 'later.md'), 'x\n');
  assert.match(contextOf(start(fx, { source: 'compact' })), /cannot tell/);
  assert.deepEqual(recorded(fx.root, fx.env), []);
  start(fx, { session_id: '', source: 'startup' });
  assert.deepEqual(recorded(fx.root, fx.env), ['later.md']);
  writeFileSync(join(fx.root, 'later2.md'), 'x\n');
  assert.match(contextOf(start(fx, { session_id: '', source: 'compact' })), /cannot tell/);
  assert.deepEqual(recorded(fx.root, fx.env), ['later.md']);
});

test('a snapshot of another working tree is never retaken on compact, even for the same session: a vault copied elsewhere', () => {
  const fx = makeHookVault();
  start(fx, { session_id: 's1', source: 'startup' });
  const copy = join(fx.base, 'copy');
  cpSync(fx.root, copy, { recursive: true });
  writeFileSync(join(copy, 'in-copy.md'), 'x\n');
  assert.equal(readSnapshot(copy, { env: fx.env }).root, fx.root, 'the copy carries the original snapshot');
  assert.match(contextOf(start(fx, { session_id: 's1', source: 'compact' }, { root: copy })), /cannot tell/);
  assert.equal(readSnapshot(copy, { env: fx.env }).root, fx.root);
  assert.match(contextOf(start(fx, { session_id: 's1', source: 'startup' }, { root: copy })), /taken/);
  const snapshot = readSnapshot(copy, { env: fx.env });
  assert.equal(snapshot.root, copy);
  assert.deepEqual(snapshot.paths.map(String), ['in-copy.md']);
});

test('an unreadable snapshot is replaced at a start and the line says so; on compact or resume it is left as it is', () => {
  for (const source of ['compact', 'resume']) {
    const fx = makeHookVault();
    const file = join(fx.root, '.git', GUARD_FILES.SNAPSHOT);
    writeFileSync(file, 'not json');
    assert.match(contextOf(start(fx, { session_id: 's1', source })), /cannot tell/, source);
    assert.equal(readFileSync(file, 'utf8'), 'not json', source);
  }
  const fx = makeHookVault();
  writeFileSync(join(fx.root, '.git', GUARD_FILES.SNAPSHOT), 'not json');
  const line = contextOf(start(fx, { session_id: 's1', source: 'startup' }));
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

test('a lock whose holder is provably dead is named as stale with brain-kit doctor, never as another writer, and is left in place', () => {
  const fx = makeHookVault();
  const me = currentIdentity();
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  const text = `${JSON.stringify({ pid, host: me.host, command: 'brain-kit propose', startedAt: '2026-09-24T00:00:00.000Z', machineId: me.machineId, bootId: me.bootId, pidNamespace: me.pidNamespace })}\n`;
  const lockFile = join(fx.root, '.git', GUARD_FILES.LOCK);
  writeFileSync(lockFile, text);
  const line = contextOf(start(fx, { session_id: 's1', source: 'startup' }));
  assert.match(line, new RegExp(`left by brain-kit propose \\(pid ${pid}\\), which is no longer running`));
  assert.match(line, /brain-kit doctor/);
  assert.doesNotMatch(line, /another writer is working/);
  assert.equal(readFileSync(lockFile, 'utf8'), text);
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

// Phase 3, task 5: the last round's connectors on the status line.

function turnOnCalendar(fx, extra = () => {}) {
  const file = join(fx.root, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.sources.calendar.enabled = true;
  config.sources.calendar.calendars = ['primary'];
  config.vault.timezone = 'America/Argentina/Buenos_Aires';
  extra(config);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function lastRun(fx, connectorStates) {
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(join(fx.stateDir, 'last-run.json'), `${JSON.stringify({ at: '2026-09-25T01:00:00.000Z', exit: 0, connectorStates })}\n`);
}

test('the status line names each configured connector source whose state in the last round was not connected, with that state and the round\'s date in the vault\'s zone', () => {
  const fx = makeHookVault();
  turnOnCalendar(fx);
  // 01:00 UTC on 25/09 is still 24/09 in UTC-3; meeting notes are listed but off.
  lastRun(fx, { calendar: { state: 'needs_auth', at: '2026-09-25T01:00:00.000Z' }, meeting_notes: { state: 'absent', at: '2026-09-25T01:00:00.000Z' } });
  const line = contextOf(start(fx, { session_id: 's1', source: 'startup' }));
  assert.match(line, /Connector sources not connected in the last round: calendar needs_auth \(24\/09\/2026\); see brain-kit doctor\./);
  assert.doesNotMatch(line, /meeting_notes/, 'a source that is not configured is not named');
});

test('nothing about connectors when the last state is connected, when the source is off, or when last-run cannot be read; the line is in the vault\'s language', () => {
  const fx = makeHookVault();
  turnOnCalendar(fx);
  lastRun(fx, { calendar: { state: 'connected', at: '2026-09-25T01:00:00.000Z' } });
  assert.doesNotMatch(contextOf(start(fx, { session_id: 's1', source: 'startup' })), /Connector sources/);
  writeFileSync(join(fx.stateDir, 'last-run.json'), '{ not json');
  assert.doesNotMatch(contextOf(start(fx, { session_id: 's2', source: 'startup' })), /Connector sources/);
  turnOnCalendar(fx, (config) => { config.sources.calendar.enabled = false; });
  lastRun(fx, { calendar: { state: 'needs_auth', at: '2026-09-25T01:00:00.000Z' } });
  assert.doesNotMatch(contextOf(start(fx, { session_id: 's3', source: 'startup' })), /Connector sources/);

  const pt = makeHookVault({ lang: 'pt-BR' });
  turnOnCalendar(pt);
  lastRun(pt, { calendar: { state: 'blocked_by_user_rules', at: '2026-09-24T12:00:00.000Z' } });
  assert.match(contextOf(start(pt, { session_id: 's1', source: 'startup' })), /Fontes por conector não conectadas na última rodada: calendar blocked_by_user_rules \(24\/09\/2026\)/);
});
