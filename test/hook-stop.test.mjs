// The Stop hook, run as Claude Code runs it: the real launcher with the event
// JSON on standard input, against a throwaway vault from `init --yes` (which
// also writes machine.json in the pinned state directory), committed clean,
// with the session's snapshot taken by the real SessionStart hook.
//
// Review focus 2: each rung of the ladder decides alone. Every test of a
// releasing rung leaves session dirt in place, so any later rung would
// block; every test of a blocking rung leaves a clean tree, so the later
// rungs would release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../src/guards/lock.mjs';
import { GUARD_FILES } from '../src/guards/location.mjs';
import { git, makeRepo, pathUnder } from './helpers/git-repo.mjs';
import { makeHookVault, runHookProcess } from './helpers/hook-world.mjs';

// Characters built at run time: no escape is typed into a file here.
const A_ACUTE = String.fromCodePoint(0xe1);
const C_CEDILLA = String.fromCodePoint(0xe7);
const A_TILDE = String.fromCodePoint(0xe3);

function begin(fx, { session = 's1' } = {}) {
  const r = runHookProcess('session-start', { session_id: session, source: 'startup', cwd: fx.root }, { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout, '');
}

function stop(fx, payload = {}, { root = fx.root } = {}) {
  const r = runHookProcess('stop', { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: root, ...payload }, { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function reasonOf(r) {
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['decision', 'reason']);
  assert.equal(out.decision, 'block');
  return out.reason;
}

function assertReleased(r, stderrPattern) {
  assert.equal(r.stdout, '', `expected a release, got ${r.stdout}`);
  if (stderrPattern === null) assert.equal(r.stderr, '');
  else {
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, r.stderr);
    assert.match(r.stderr, stderrPattern);
  }
}

// A registered vault whose session has begun and has written one note of its own.
function sessionWithWork() {
  const fx = makeHookVault();
  begin(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  return fx;
}

const machineFile = (fx) => join(fx.stateDir, 'machine.json');

// --- the baseline -----------------------------------------------------------------

test('session dirt in a registered vault blocks, naming the path, the inherited count and the instruction', () => {
  const fx = makeHookVault();
  writeFileSync(join(fx.root, 'foreign.md'), 'there before the session\n');
  begin(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const reason = reasonOf(stop(fx));
  const lines = reason.split('\n');
  assert.equal(lines[0], 'This session changed 1 path(s) in the vault:');
  assert.equal(lines[1], '  mine.md');
  assert.doesNotMatch(reason, /foreign\.md/);
  assert.match(reason, /^1 path\(s\) that were already there before this session were left out: they are not this session's to propose\.$/m);
  assert.match(reason, /capture what is new in the log, compile it into notes, run brain-kit validate and brain-kit lint/);
  assert.match(reason, /brain-kit propose --only <paths> \(or the curate-session skill\)/);
  assert.match(reason, /If these changes must not be proposed, say so to the person and stop\./);
  assert.doesNotMatch(reason, /snapshot was missing/);
});

test('a pt-BR vault gets the block reason in Portuguese', () => {
  const fx = makeHookVault({ lang: 'pt-BR' });
  begin(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'x\n');
  assert.match(reasonOf(stop(fx)), /^Esta sessão mudou 1 caminho\(s\) no vault:/);
});

// --- each rung alone --------------------------------------------------------------

test('rung 1: a payload that is not a JSON object releases with one stderr line, even with session dirt', () => {
  const fx = sessionWithWork();
  for (const input of ['{ nope', '[]', 'null', '']) {
    // Run from inside the vault: without this rung the vault would be found from the process directory.
    const r = runHookProcess('stop', input, { env: fx.env, cwd: fx.root });
    assert.equal(r.status, 0);
    assertReleased(r, /not a JSON object/);
  }
});

test('rung 2: stop_hook_active releases silently even with session dirt; only a literal true counts', () => {
  const fx = sessionWithWork();
  assertReleased(stop(fx, { stop_hook_active: true }), null);
  for (const value of ['true', 1, null]) reasonOf(stop(fx, { stop_hook_active: value }));
});

test('rung 3: a dirty repository that is not a vault releases with empty stdout and empty stderr', () => {
  const fx = makeHookVault();
  const other = makeRepo({ 'index.md': '# Someone else\n', 'src/app.js': 'x\n' });
  writeFileSync(join(other, 'src/app.js'), 'edited\n');
  writeFileSync(join(other, 'wip.md'), 'x\n');
  const r = stop(fx, {}, { root: other });
  assert.deepEqual([r.stdout, r.stderr], ['', '']);
});

test('rung 3: a registered vault whose configuration lacks a valid kit_version is no vault by the sentinel, and releases silently', () => {
  for (const kitVersion of [undefined, 1, '1.2', 'v0.0.1', '']) {
    const fx = sessionWithWork();
    const file = join(fx.root, 'brain-kit.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (kitVersion === undefined) delete config.kit_version;
    else config.kit_version = kitVersion;
    writeFileSync(file, JSON.stringify(config));
    assert.deepEqual([stop(fx).stdout, stop(fx).stderr], ['', ''], String(kitVersion));
  }
  const fx = sessionWithWork();
  writeFileSync(join(fx.root, 'brain-kit.config.json'), '{ not json');
  assert.deepEqual([stop(fx).stdout, stop(fx).stderr], ['', '']);
});

test('rung 3: a vault with some other configuration error is still a vault and still blocks', () => {
  const fx = sessionWithWork();
  const file = join(fx.root, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.owner = 'not an object';
  writeFileSync(file, JSON.stringify(config));
  reasonOf(stop(fx));
});

test('rung 4: no machine.json releases, naming brain-kit machine register, even with session dirt', () => {
  const fx = sessionWithWork();
  unlinkSync(machineFile(fx));
  assertReleased(stop(fx), /not registered on this machine .*brain-kit machine register/);
});

test('rung 5: a machine.json that is unreadable or invalid blocks, naming the file and brain-kit doctor, even on a clean tree', () => {
  for (const text of ['{ not json', '[]', '{"vault_id": 7}']) {
    const fx = makeHookVault();
    begin(fx);
    writeFileSync(machineFile(fx), text);
    const reason = reasonOf(stop(fx));
    assert.ok(reason.includes(machineFile(fx)), reason);
    assert.match(reason, /brain-kit doctor/);
  }
  const fx = makeHookVault();
  begin(fx);
  rmSync(machineFile(fx));
  mkdirSync(machineFile(fx));
  assert.match(reasonOf(stop(fx)), /cannot be read or is not valid/);
});

test('rung 5: a state directory that cannot be searched is not "no machine.json": it blocks', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads through any mode');
  const fx = makeHookVault();
  begin(fx);
  chmodSync(fx.stateDir, 0o000);
  try {
    const reason = reasonOf(stop(fx));
    assert.ok(reason.includes(machineFile(fx)), reason);
  } finally {
    chmodSync(fx.stateDir, 0o700);
  }
});

test('rung 6: a copy away from the registered path releases even with session dirt: a worktree under .claude/worktrees, and an edited canonical_path', () => {
  const fx = makeHookVault();
  const worktree = join(fx.root, '.claude', 'worktrees', 'w');
  git(fx.root, ['worktree', 'add', '-q', worktree, '-b', 'w']);
  begin({ ...fx, root: worktree });
  writeFileSync(join(worktree, 'mine.md'), 'x\n');
  assertReleased(stop(fx, {}, { root: worktree }), /is not the path registered on this machine/);

  const moved = sessionWithWork();
  const machine = JSON.parse(readFileSync(machineFile(moved), 'utf8'));
  machine.canonical_path = join(moved.base, 'elsewhere');
  writeFileSync(machineFile(moved), JSON.stringify(machine));
  assertReleased(stop(moved), /is not the path registered/);
});

test('rung 7: a registered vault that is not a repository, or not its top level, blocks and names brain-kit doctor', () => {
  const plain = makeHookVault();
  rmSync(join(plain.root, '.git'), { recursive: true, force: true });
  let reason = reasonOf(stop(plain));
  assert.match(reason, /needs this vault to be the top level of a git repository.*not inside a git working tree.*brain-kit doctor/s);

  const nested = makeHookVault();
  rmSync(join(nested.root, '.git'), { recursive: true, force: true });
  git(nested.base, ['init', '-q', '-b', 'main']);
  git(nested.base, ['add', '-A']);
  git(nested.base, ['commit', '-q', '-m', 'everything']);
  reason = reasonOf(stop(nested));
  assert.match(reason, /needs this vault to be the top level.*not its top level/s);
});

test('rung 8: a held lock releases, naming its command and pid, even with session dirt; an unreadable lock too', () => {
  const fx = sessionWithWork();
  const lock = acquireLock(fx.root, { command: 'brain-kit sync', env: fx.env });
  try {
    assertReleased(stop(fx), new RegExp(`held by brain-kit sync \\(pid ${process.pid}\\)`));
  } finally {
    lock.release();
  }
  writeFileSync(join(fx.root, '.git', GUARD_FILES.LOCK), 'garbage');
  assertReleased(stop(fx), /lock is there but cannot be read/);
  unlinkSync(join(fx.root, '.git', GUARD_FILES.LOCK));
  reasonOf(stop(fx));
});

test('rung 9: with no snapshot, an unreadable one or one of another tree, every dirty path is the session\'s and the reason says so', () => {
  const setups = {
    none: () => {},
    unreadable: (fx) => writeFileSync(join(fx.root, '.git', GUARD_FILES.SNAPSHOT), 'not json'),
    otherRoot: (fx) => writeFileSync(join(fx.root, '.git', GUARD_FILES.SNAPSHOT), JSON.stringify({
      format: 1, at: '2026-09-24T00:00:00.000Z', root: join(fx.base, 'other'), session: 's1', paths: [Buffer.from('foreign.md').toString('hex')],
    })),
  };
  for (const [name, setup] of Object.entries(setups)) {
    const fx = makeHookVault();
    writeFileSync(join(fx.root, 'foreign.md'), 'there before\n');
    setup(fx);
    const reason = reasonOf(stop(fx));
    assert.match(reason, /^This session changed 1 path\(s\) in the vault:\n {2}foreign\.md\n/, name);
    assert.match(reason, /^0 path\(s\) that were already there/m, name);
    assert.match(reason, /session snapshot was missing or unreadable, so every change counts as this session's and earlier work may be included/, name);
  }
});

test('rung 9: two sessions in one tree: after B starts, A\'s Stop still blocks on A\'s own work and says the snapshot is another session\'s', () => {
  const fx = makeHookVault();
  begin(fx, { session: 'A' });
  writeFileSync(join(fx.root, 'a.md'), 'A wrote this\n');
  begin(fx, { session: 'B' });
  const reason = reasonOf(stop(fx, { session_id: 'A' }));
  assert.match(reason, /^This session changed 1 path\(s\) in the vault:\n {2}a\.md\n/);
  assert.match(reason, /snapshot belongs to another session, so every change counts as this session's and earlier or foreign work may be listed: propose only the files this session changed/);
  assert.doesNotMatch(reason, /snapshot was missing/);
  // B's own Stop trusts B's snapshot: a.md was there before B began.
  assertReleased(stop(fx, { session_id: 'B' }), /left nothing to propose \(1 path\(s\)/);
  writeFileSync(join(fx.root, 'b.md'), 'B wrote this\n');
  const forB = reasonOf(stop(fx, { session_id: 'B' }));
  assert.match(forB, /^This session changed 1 path\(s\) in the vault:\n {2}b\.md\n1 path\(s\) that were already there/);
  assert.doesNotMatch(forB, /another session/);
});

test('rung 9: a Stop with no session id, or a snapshot taken for no session, never trusts the snapshot', () => {
  const noId = makeHookVault();
  writeFileSync(join(noId.root, 'foreign.md'), 'x\n');
  begin(noId, { session: 's1' });
  for (const payload of [{ session_id: undefined }, { session_id: '' }, { session_id: 7 }]) {
    const reason = reasonOf(stop(noId, payload));
    assert.match(reason, /foreign\.md/);
    assert.match(reason, /belongs to another session/);
  }

  // An empty id never matches, not even a snapshot that recorded an empty one.
  writeFileSync(join(noId.root, '.git', GUARD_FILES.SNAPSHOT), JSON.stringify({
    format: 1, at: '2026-09-24T00:00:00.000Z', root: noId.root, session: '', paths: [Buffer.from('foreign.md').toString('hex')],
  }));
  assert.match(reasonOf(stop(noId, { session_id: '' })), /foreign\.md[\s\S]*belongs to another session/);

  const sliceC = makeHookVault();
  writeFileSync(join(sliceC.root, 'foreign.md'), 'x\n');
  writeFileSync(join(sliceC.root, '.git', GUARD_FILES.SNAPSHOT), JSON.stringify({
    format: 1, at: '2026-09-24T00:00:00.000Z', root: sliceC.root, paths: [Buffer.from('foreign.md').toString('hex')],
  }));
  const reason = reasonOf(stop(sliceC));
  assert.match(reason, /^This session changed 1 path\(s\) in the vault:\n {2}foreign\.md\n/);
  assert.match(reason, /snapshot was taken for no session/);
});

test('rung 10: a clean tree releases, and so does one with only dirt from before the session, naming the inherited count', () => {
  const clean = makeHookVault();
  begin(clean);
  assertReleased(stop(clean), /left nothing to propose \(0 path\(s\)/);

  const fx = makeHookVault();
  writeFileSync(join(fx.root, 'foreign.md'), 'x\n');
  writeFileSync(join(fx.root, 'index.md'), 'edited by someone else\n');
  begin(fx);
  // Touched again during the session, a foreign file stays foreign.
  writeFileSync(join(fx.root, 'foreign.md'), 'touched again\n');
  assertReleased(stop(fx), /left nothing to propose \(2 path\(s\)/);
  writeFileSync(join(fx.root, 'mine.md'), 'x\n');
  assert.match(reasonOf(stop(fx)), /^2 path\(s\) that were already there/m);
});

test('after the registered machine the ladder fails closed: git unable to read the index blocks, it never releases', () => {
  const fx = sessionWithWork();
  writeFileSync(join(fx.root, '.git', 'index'), 'garbage');
  assert.match(reasonOf(stop(fx)), /could not check this vault: .*index.*brain-kit doctor/s);
});

// --- the listing ----------------------------------------------------------------

test('a path with spaces and accents is listed readably, and one that is not valid UTF-8 is listed without throwing', () => {
  const fx = makeHookVault();
  begin(fx);
  const accented = `notes/reuni${A_TILDE}o de mar${C_CEDILLA}o com ${A_ACUTE}gua.md`;
  mkdirSync(join(fx.root, 'notes'), { recursive: true });
  writeFileSync(join(fx.root, accented), 'x\n');
  const bytes = Buffer.concat([Buffer.from('notes/caf'), Buffer.from([0xe9]), Buffer.from(' latin1.md')]);
  writeFileSync(pathUnder(fx.root, bytes), 'x\n');
  const reason = reasonOf(stop(fx));
  const lines = reason.split('\n');
  assert.equal(lines[0], 'This session changed 2 path(s) in the vault:');
  assert.deepEqual(lines.slice(1, 3), [`  notes/caf${String.fromCodePoint(0xe9)} latin1.md`, `  ${accented}`]);
  assert.doesNotMatch(reason, /�/u);
});

test('25 new files list the first 20 in byte order and say 5 more', () => {
  const fx = makeHookVault();
  begin(fx);
  const names = Array.from({ length: 25 }, (_, i) => `new/n${String(i + 1).padStart(2, '0')}.md`);
  mkdirSync(join(fx.root, 'new'));
  for (const name of [...names].reverse()) writeFileSync(join(fx.root, name), 'x\n');
  const lines = reasonOf(stop(fx)).split('\n');
  assert.equal(lines[0], 'This session changed 25 path(s) in the vault:');
  assert.deepEqual(lines.slice(1, 21), names.slice(0, 20).map((name) => `  ${name}`));
  assert.equal(lines[21], '  and 5 more');
  assert.doesNotMatch(lines.join('\n'), /n21\.md/);

  const exact = makeHookVault();
  begin(exact);
  mkdirSync(join(exact.root, 'new'));
  for (const name of names.slice(0, 20)) writeFileSync(join(exact.root, name), 'x\n');
  assert.doesNotMatch(reasonOf(stop(exact)), /more/);
});

test('the hook never changes git status of the vault, releasing or blocking', () => {
  const fx = makeHookVault();
  writeFileSync(join(fx.root, 'foreign.md'), 'x\n');
  begin(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'x\n');
  const status = () => git(fx.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
  const before = status();
  reasonOf(stop(fx));
  assertReleased(stop(fx, { stop_hook_active: true }), null);
  assert.equal(status(), before);
});
