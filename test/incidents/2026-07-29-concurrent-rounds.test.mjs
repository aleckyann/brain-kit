// docs/incidents.md, 29/07/2026: two curations ran on the same vault at
// once. On the first production run there was no lock; two curation rounds
// ran over the same working tree and collided. The output happened to come
// out coherent, and the agent itself reported the collision.
//
// Phase 1 (this file, today): the lock every writing command takes. A
// second round is refused at once, as a real second process, with the exit
// code for "postponed" and the first round named; a round that died is
// replaced only when it is provably dead on this machine; and two rounds
// that find the same dead lock at the same moment never both start. Phase
// 2 (the curate round itself) adds its own run to this file when it exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, describeLock, LockHeld } from '../../src/guards/lock.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { STATE_FILES } from '../../src/state.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const CHILD = fileURLToPath(new URL('../helpers/lock-child.mjs', import.meta.url));

function round(options) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const result = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (out.includes('\n')) resolve(JSON.parse(out.slice(0, out.indexOf('\n'))));
    });
    child.on('exit', () => (out.includes('\n') ? resolve(JSON.parse(out.slice(0, out.indexOf('\n')))) : reject(new Error('the round printed nothing'))));
  });
  return { child, result, exited };
}

test('a second round while the first holds the lock is postponed at once, exit 75, naming the first round', async () => {
  const base = makeTempDir('brain-kit-incident-0729-');
  const stateDir = join(base, 'state');
  const doneFile = join(base, 'first-round-done');
  const first = round({ stateDir, command: 'curate', id: 'first', doneFile });
  try {
    assert.equal((await first.result).won, true);
    const second = round({ stateDir, command: 'curate', id: 'second' });
    const refused = await second.result;
    await second.exited;
    assert.equal(refused.won, false);
    assert.equal(refused.holder.pid, first.child.pid);
    assert.equal(refused.holder.command, 'curate');

    // In this process too: the error a command turns into its exit status.
    let error = null;
    try {
      acquireLock(stateDir, { command: 'propose' });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof LockHeld);
    assert.equal(error.exitCode, EXIT.TEMPFAIL);
    assert.equal(error.holder.pid, first.child.pid);
  } finally {
    writeFileSync(doneFile, '');
    await first.exited;
  }
  assert.equal(describeLock(stateDir), null, 'the first round released on finishing');
  const third = acquireLock(stateDir, { command: 'curate' });
  third.release();
});

test('a round that died holding the lock is replaced, because it is provably dead on this machine', async () => {
  const base = makeTempDir('brain-kit-incident-0729-');
  const stateDir = join(base, 'state');
  const first = round({ stateDir, command: 'curate', id: 'first', doneFile: join(base, 'never') });
  assert.equal((await first.result).won, true);
  first.child.kill('SIGKILL');
  await first.exited;
  assert.equal(describeLock(stateDir).pid, first.child.pid);
  const next = acquireLock(stateDir, { command: 'curate' });
  assert.equal(describeLock(stateDir).pid, process.pid);
  next.release();
});

test('two rounds that find the same dead round\'s lock at the same moment never both start', async () => {
  const base = makeTempDir('brain-kit-incident-0729-');
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(stateDir, STATE_FILES.LOCK), JSON.stringify({ pid: dead, host: hostname(), command: 'curate', startedAt: '2026-07-29T03:00:00.000Z' }));
  const barrier = join(base, 'barrier');
  mkdirSync(barrier);
  const doneFile = join(base, 'done');
  const rounds = ['morning', 'retry'].map((id) => round({ stateDir, command: 'curate', id, barrier: { dir: barrier, n: 2 }, doneFile }));
  try {
    const results = await Promise.all(rounds.map((r) => r.result));
    assert.equal(results.filter((r) => r.won).length, 1, JSON.stringify(results));
  } finally {
    writeFileSync(doneFile, '');
    await Promise.all(rounds.map((r) => r.exited));
  }
});
