import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, describeLock, LockHeld } from '../src/guards/lock.mjs';
import { STATE_FILES } from '../src/state.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const CHILD = fileURLToPath(new URL('./helpers/lock-child.mjs', import.meta.url));
const WATCHER = fileURLToPath(new URL('./helpers/lock-watcher.mjs', import.meta.url));
const NOW = new Date('2026-07-29T09:30:00.000Z');

function stateDir() {
  return join(makeTempDir('brain-kit-lock-'), 'state');
}

function lockPath(dir) {
  return join(dir, STATE_FILES.LOCK);
}

function markerPath(dir) {
  return join(dir, STATE_FILES.LOCK_RECLAIM);
}

// A pid that was really used by a process on this machine and is now dead.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  return child.pid;
}

function writeLock(dir, holder) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir), `${JSON.stringify(holder)}\n`);
}

function staleHolder(overrides = {}) {
  return { pid: deadPid(), host: hostname(), command: 'curate', startedAt: '2026-07-29T03:00:00.000Z', ...overrides };
}

// Whatever acquireLock throws, asserted to be LockHeld, and returned.
function heldError(fn) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LockHeld, `expected LockHeld, got ${caught && caught.stack}`);
  return caught;
}

function leftovers(dir) {
  return readdirSync(dir).filter((name) => name !== STATE_FILES.LOCK);
}

// Starts the lock child; resolves with its one JSON line and a way to wait
// for it to exit.
function startChild(options) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const line = new Promise((resolve, reject) => {
    const check = () => {
      const newline = out.indexOf('\n');
      if (newline !== -1) resolve(JSON.parse(out.slice(0, newline)));
    };
    child.stdout.on('data', check);
    child.on('exit', () => {
      check();
      reject(new Error(`lock child exited without a result: ${err}`));
    });
  });
  return { child, line, exited };
}

test('acquire records pid, host, command and start time in a 0600 lock file that describeLock reads back', () => {
  const dir = stateDir();
  const lock = acquireLock(dir, { command: 'propose', now: NOW });
  assert.deepEqual(lock.holder, { pid: process.pid, host: hostname(), command: 'propose', startedAt: NOW.toISOString() });
  assert.deepEqual(describeLock(dir), lock.holder);
  assert.deepEqual(JSON.parse(readFileSync(lockPath(dir), 'utf8')), lock.holder);
  assert.equal(statSync(lockPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(dir), [], 'no temporary file or marker is left beside the lock');
  lock.release();
});

test('acquire refuses to run without a command name', () => {
  assert.throws(() => acquireLock(stateDir(), {}), TypeError);
  assert.throws(() => acquireLock(stateDir(), { command: '' }), TypeError);
});

test('a second acquire in the same process fails at once with LockHeld naming the first holder, exit code 75', () => {
  const dir = stateDir();
  const first = acquireLock(dir, { command: 'propose', now: NOW });
  const before = readFileSync(lockPath(dir), 'utf8');
  const error = heldError(() => acquireLock(dir, { command: 'sync' }));
  assert.deepEqual(error.holder, first.holder);
  assert.equal(error.code, 'LOCK_HELD');
  assert.equal(error.exitCode, EXIT.TEMPFAIL);
  assert.equal(error.exitCode, 75);
  assert.equal(error.lockPath, lockPath(dir));
  assert.equal(error.blockedBy, null);
  assert.match(error.message, new RegExp(`pid ${process.pid}`));
  assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'the refused acquire did not touch the lock');
  first.release();
});

test('a second acquire in a child process fails with the holder named', async () => {
  const dir = stateDir();
  const first = acquireLock(dir, { command: 'propose', now: NOW });
  const { line, exited } = startChild({ stateDir: dir, command: 'sync', id: 'second' });
  const result = await line;
  await exited;
  assert.equal(result.won, false, JSON.stringify(result));
  assert.deepEqual(result.holder, first.holder);
  first.release();
});

test('release lets the next acquire succeed, a second release is harmless, and nothing is left behind', () => {
  const dir = stateDir();
  const first = acquireLock(dir, { command: 'propose' });
  assert.equal(first.release(), true);
  assert.equal(existsSync(lockPath(dir)), false);
  assert.equal(describeLock(dir), null);
  assert.equal(first.release(), false);
  const second = acquireLock(dir, { command: 'sync' });
  assert.equal(second.holder.command, 'sync');
  assert.equal(second.release(), true);
  assert.deepEqual(readdirSync(dir), []);
});

test('release never deletes a lock that is no longer the one it placed, even one with the same bytes', () => {
  const dir = stateDir();
  const lock = acquireLock(dir, { command: 'propose' });
  const foreign = { pid: 1, host: hostname(), command: 'curate', startedAt: NOW.toISOString() };
  writeFileSync(lockPath(dir), `${JSON.stringify(foreign)}\n`);
  assert.equal(lock.release(), false);
  assert.deepEqual(describeLock(dir), foreign);
  unlinkSync(lockPath(dir));

  // Same bytes, another file: a lock that was replaced by one that happens
  // to read the same is still not ours to delete.
  const again = acquireLock(dir, { command: 'propose', now: NOW });
  const text = readFileSync(lockPath(dir), 'utf8');
  const copy = join(dir, 'copy');
  writeFileSync(copy, text);
  renameSync(copy, lockPath(dir));
  assert.equal(again.release(), false);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), text);
});

test('a stale handle released again never removes a later lock, even one with the same bytes on a reused inode', () => {
  const dir = stateDir();
  const first = acquireLock(dir, { command: 'propose', now: NOW });
  assert.equal(first.release(), true);
  const second = acquireLock(dir, { command: 'propose', now: NOW });
  assert.equal(first.release(), false);
  assert.deepEqual(describeLock(dir), second.holder);
  second.release();
});

test('release of a lock a person already removed by hand is a quiet no-op', () => {
  const dir = stateDir();
  const lock = acquireLock(dir, { command: 'propose' });
  unlinkSync(lockPath(dir));
  assert.equal(lock.release(), false);
  assert.equal(describeLock(dir), null);
});

test('describeLock is null with no lock, and a lock that cannot be read is reported, never read as no lock', () => {
  const dir = stateDir();
  assert.equal(describeLock(dir), null);
  mkdirSync(dir, { recursive: true });
  const unreadable = { pid: null, host: null, command: null, startedAt: null, unreadable: true };
  for (const text of ['', 'not json', '{"pid":"12","host":"h","command":"c","startedAt":"s"}', '{"pid":0,"host":"h","command":"c","startedAt":"s"}',
    '{"pid":-1,"host":"h","command":"c","startedAt":"s"}', '{"pid":1.5,"host":"h","command":"c","startedAt":"s"}',
    '{"pid":12,"host":"","command":"c","startedAt":"s"}', '{"pid":12,"host":5,"command":"c","startedAt":"s"}', '[12]', '"text"', '{"pid":12,"host":"h","startedAt":"s"}', '{"pid":12,"host":"h","command":"c"}', 'null', '12']) {
    writeFileSync(lockPath(dir), text);
    assert.deepEqual(describeLock(dir), unreadable, `lock text ${JSON.stringify(text)}`);
  }
  unlinkSync(lockPath(dir));
  mkdirSync(lockPath(dir));
  assert.deepEqual(describeLock(dir), unreadable, 'a directory under the lock name');
});

test('a symlink or a FIFO under the lock name is an unreadable lock: never followed, never waited on, never reclaimed', { timeout: 20000 }, () => {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const unreadable = { pid: null, host: null, command: null, startedAt: null, unreadable: true };
  // A symlink to a perfectly good stale lock elsewhere is still not a lock.
  const elsewhere = join(dir, '..', 'elsewhere');
  writeFileSync(elsewhere, `${JSON.stringify(staleHolder())}\n`);
  symlinkSync(elsewhere, lockPath(dir));
  assert.deepEqual(describeLock(dir), unreadable, 'a symlink under the lock name');
  assert.equal(heldError(() => acquireLock(dir, { command: 'propose' })).holder.unreadable, true);
  unlinkSync(lockPath(dir));
  symlinkSync(join(dir, 'nowhere'), lockPath(dir));
  assert.deepEqual(describeLock(dir), unreadable, 'a dangling symlink under the lock name');
  unlinkSync(lockPath(dir));
  assert.equal(spawnSync('mkfifo', [lockPath(dir)]).status, 0);
  assert.deepEqual(describeLock(dir), unreadable, 'a FIFO under the lock name');
  assert.equal(heldError(() => acquireLock(dir, { command: 'propose' })).holder.unreadable, true);
});

test('an unreadable lock is held: no one whose death could be proved, so it is never reclaimed', () => {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  for (const text of ['', `{"pid":${deadPid()},"host":"${hostname()}","command":"curate"}`]) {
    writeFileSync(lockPath(dir), text);
    const error = heldError(() => acquireLock(dir, { command: 'propose' }));
    assert.equal(error.holder.pid, null);
    assert.equal(error.holder.unreadable, true);
    assert.match(error.message, /unreadable/);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), text);
  }
});

test('a lock whose pid is dead on this host is reclaimed, by replacement, with nothing left behind', () => {
  const dir = stateDir();
  const stale = staleHolder();
  writeLock(dir, stale);
  const inoBefore = lstatSync(lockPath(dir)).ino;
  const lock = acquireLock(dir, { command: 'propose', now: NOW });
  assert.equal(lock.holder.pid, process.pid);
  assert.deepEqual(describeLock(dir), lock.holder);
  assert.notEqual(lstatSync(lockPath(dir)).ino, inoBefore);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(lock.release(), true, 'a reclaimed lock is released like any other');
});

test('a lock whose pid is alive on this host is not reclaimed, including one owned by another user', () => {
  const dir = stateDir();
  // The test runner's own parent, alive for as long as this test runs.
  for (const pid of [process.ppid, 1]) {
    const live = { pid, host: hostname(), command: 'curate', startedAt: NOW.toISOString() };
    writeLock(dir, live);
    const error = heldError(() => acquireLock(dir, { command: 'propose' }));
    assert.deepEqual(error.holder, live, `pid ${pid}`);
    assert.deepEqual(describeLock(dir), live);
  }
});

test('a lock from another host is never reclaimed, even when its pid is dead here', () => {
  const dir = stateDir();
  const remote = staleHolder({ host: 'other-host.example.invalid' });
  writeLock(dir, remote);
  const error = heldError(() => acquireLock(dir, { command: 'propose' }));
  assert.deepEqual(error.holder, remote);
  assert.deepEqual(describeLock(dir), remote);
  assert.deepEqual(leftovers(dir), []);
});

test('a live process holding the lock blocks the next writer; once it dies without releasing, its lock is reclaimed', async () => {
  const dir = stateDir();
  const doneFile = join(dir, '..', 'never');
  const { child, line, exited } = startChild({ stateDir: dir, command: 'curate', id: 'holder', doneFile });
  try {
    const result = await line;
    assert.equal(result.won, true, JSON.stringify(result));
    const error = heldError(() => acquireLock(dir, { command: 'propose' }));
    assert.equal(error.holder.pid, child.pid);
    assert.equal(error.holder.command, 'curate');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  assert.equal(describeLock(dir).pid, child.pid, 'the killed holder never released');
  const lock = acquireLock(dir, { command: 'propose' });
  assert.equal(describeLock(dir).pid, process.pid);
  lock.release();
});

test('a reclaim marker held by a live reclaimer means the lock is being taken: LockHeld names that reclaimer', () => {
  const dir = stateDir();
  const stale = staleHolder();
  writeLock(dir, stale);
  const reclaimer = { pid: process.ppid, host: hostname(), command: 'curate', startedAt: NOW.toISOString() };
  writeFileSync(markerPath(dir), `${JSON.stringify(reclaimer)}\n`);
  const error = heldError(() => acquireLock(dir, { command: 'propose' }));
  assert.deepEqual(error.holder, reclaimer);
  assert.equal(error.blockedBy, null);
  assert.deepEqual(describeLock(dir), stale, 'the lock itself was not touched');
  assert.ok(existsSync(markerPath(dir)), 'another process\'s marker is never removed');
});

test('a marker left by a dead reclaimer blocks the reclaim and is named, for a person to remove', () => {
  const dir = stateDir();
  const stale = staleHolder();
  writeLock(dir, stale);
  const deadReclaimer = staleHolder({ command: 'sync' });
  writeFileSync(markerPath(dir), `${JSON.stringify(deadReclaimer)}\n`);
  const error = heldError(() => acquireLock(dir, { command: 'propose' }));
  assert.equal(error.blockedBy, markerPath(dir));
  assert.deepEqual(error.holder, deadReclaimer);
  assert.deepEqual(describeLock(dir), stale);
  unlinkSync(markerPath(dir));
  acquireLock(dir, { command: 'propose' }).release();
});

test('a reclaimer that judged the lock stale loses to one that finished replacing it first', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  let first = null;
  const error = heldError(() => acquireLock(dir, { command: 'slow' }, {
    onStage(stage) {
      if (stage === 'stale' && first === null) first = acquireLock(dir, { command: 'fast' });
    },
  }));
  assert.equal(error.holder.command, 'fast');
  assert.deepEqual(describeLock(dir), first.holder);
  assert.deepEqual(leftovers(dir), []);
  first.release();
});

test('a reclaimer that finds the marker taken loses to the reclaimer holding it', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  let loser = null;
  const winner = acquireLock(dir, { command: 'first' }, {
    onStage(stage) {
      if (stage === 'claimed') loser = heldError(() => acquireLock(dir, { command: 'second' }));
    },
  });
  assert.equal(loser.holder.command, 'first');
  assert.deepEqual(describeLock(dir), winner.holder);
  assert.deepEqual(leftovers(dir), []);
  winner.release();
});

test('a lock released between the failed create and the read is simply taken', () => {
  const dir = stateDir();
  const other = acquireLock(dir, { command: 'curate' });
  const lock = acquireLock(dir, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'occupied') other.release();
    },
  });
  assert.equal(describeLock(dir).command, 'propose');
  lock.release();
});

test('a stale lock removed while it was being judged is simply taken', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  const lock = acquireLock(dir, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'stale') unlinkSync(lockPath(dir));
    },
  });
  assert.equal(describeLock(dir).command, 'propose');
  assert.deepEqual(leftovers(dir), []);
  lock.release();
});

test('a marker that vanishes before it can be read, over an unchanged stale lock, means that reclaim gave up: go round and take it', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  writeFileSync(markerPath(dir), `${JSON.stringify({ pid: process.ppid, host: hostname(), command: 'curate', startedAt: NOW.toISOString() })}\n`);
  let contended = 0;
  const lock = acquireLock(dir, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'contended' && (contended += 1) === 1) unlinkSync(markerPath(dir));
    },
  });
  assert.equal(contended, 1);
  assert.deepEqual(describeLock(dir), lock.holder);
  assert.deepEqual(leftovers(dir), []);
  lock.release();
});

test('a marker taken by a late reclaimer after the lock was already replaced: the loser names the real holder, not the late one', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  const late = { pid: process.ppid, host: hostname(), command: 'late', startedAt: NOW.toISOString() };
  let winner = null;
  const error = heldError(() => acquireLock(dir, { command: 'slow' }, {
    onStage(stage) {
      if (stage !== 'stale' || winner !== null) return;
      winner = acquireLock(dir, { command: 'winner' });
      writeFileSync(markerPath(dir), `${JSON.stringify(late)}\n`);
    },
  }));
  assert.deepEqual(error.holder, winner.holder);
  assert.deepEqual(describeLock(dir), winner.holder);
  unlinkSync(markerPath(dir));
  winner.release();
});

test('a lock that keeps changing under the acquire is reported as held after a bounded number of looks', () => {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  let looks = 0;
  const error = heldError(() => acquireLock(dir, { command: 'propose' }, {
    onStage(stage) {
      if (stage !== 'stale') return;
      looks += 1;
      if (looks > 50) throw new Error('the acquire did not stop looking');
      writeLock(dir, staleHolder({ command: `round-${looks}` }));
    },
  }));
  assert.ok(looks > 1 && looks <= 50, `looked ${looks} times`);
  assert.equal(error.holder.pid === null, false);
  assert.match(error.holder.command, /^round-/);
});

test('while a stale lock is replaced, again and again, a second process watching never once finds the lock\'s name empty', async () => {
  const dir = stateDir();
  const root = join(dir, '..');
  const staleText = `${JSON.stringify(staleHolder())}\n`;
  const putStaleBack = () => {
    const tmp = join(root, 'stale.tmp');
    writeFileSync(tmp, staleText);
    renameSync(tmp, lockPath(dir));
  };
  mkdirSync(dir, { recursive: true });
  putStaleBack();
  const readyFile = join(root, 'watching');
  const stopFile = join(root, 'stop');
  const watcher = spawn(process.execPath, [WATCHER, JSON.stringify({ lockPath: lockPath(dir), readyFile, stopFile })], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  watcher.stdout.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => watcher.on('exit', resolve));
  let laps = 0;
  try {
    while (!existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 5));
    for (; laps < 1500; laps += 1) {
      const lock = acquireLock(dir, { command: 'propose' });
      assert.equal(lock.holder.pid, process.pid);
      putStaleBack();
    }
  } finally {
    writeFileSync(stopFile, '');
    await exited;
  }
  const { looks, gaps } = JSON.parse(out);
  assert.equal(laps, 1500);
  assert.ok(looks > laps, `the watcher looked only ${looks} times`);
  assert.equal(gaps, 0, `the lock's name was empty ${gaps} times in ${looks} looks`);
});

async function race({ n, barrier, startAt }) {
  const dir = stateDir();
  writeLock(dir, staleHolder());
  const root = join(dir, '..');
  const doneFile = join(root, 'done');
  let barrierOption;
  if (barrier) {
    barrierOption = { dir: join(root, 'barrier'), n };
    mkdirSync(barrierOption.dir);
  }
  const children = Array.from({ length: n }, (_, i) => startChild({ stateDir: dir, command: `racer-${i}`, id: i, barrier: barrierOption, startAt, doneFile }));
  try {
    const results = await Promise.all(children.map((c) => c.line));
    for (const result of results) assert.equal(result.error, undefined, result.error);
    const winners = results.filter((result) => result.won);
    assert.equal(winners.length, 1, `exactly one winner, got ${JSON.stringify(results)}`);
    const winner = winners[0];
    assert.equal(describeLock(dir).pid, winner.pid);
    for (const loser of results.filter((result) => !result.won)) {
      assert.equal(loser.holder.pid, winner.pid, `every loser names the winner: ${JSON.stringify(loser)}`);
    }
  } finally {
    writeFileSync(doneFile, '');
    await Promise.all(children.map((c) => c.exited));
  }
  assert.equal(describeLock(dir), null, 'the winner released');
  assert.deepEqual(readdirSync(dir), []);
}

test('two child processes that both judged the same lock stale race to reclaim it: exactly one wins', async () => {
  await race({ n: 2, barrier: true });
});

test('four child processes that all judged the same lock stale race to reclaim it: exactly one wins', async () => {
  await race({ n: 4, barrier: true });
});

test('unforced races between child processes on one stale lock always produce exactly one winner', async () => {
  for (let round = 0; round < 6; round += 1) {
    await race({ n: 4, startAt: Date.now() + 400 });
  }
});
