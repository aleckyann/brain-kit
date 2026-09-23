// A separate process that takes the vault lock, for the tests that need a
// second writer to really be a second process (a pid of its own, alive or
// dead), not a second call inside the test's own process.
//
// Configured through one JSON argument:
//   stateDir   the state directory whose lock to take
//   command    the command name to record in the lock
//   id         a label echoed back in the result
//   barrier    optional { dir, n }: on judging the lock stale, wait until n
//              children have judged it stale too, so every racer has read
//              the same stale lock before any of them tries to replace it
//   startAt    optional epoch milliseconds: spin until then before acquiring,
//              so unforced racers start as close together as possible
//   doneFile   optional: a winner holds the lock until this file exists, so
//              no loser can win merely by arriving after the winner let go
//
// Prints exactly one JSON line: { id, pid, won: true } or
// { id, pid, won: false, holder, blockedBy } or { id, pid, error }.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, LockHeld } from '../../src/guards/lock.mjs';

// `node --test` runs every file under test/, this one included, with no
// argument: then there is nothing to do.
if (process.argv[2] === undefined) process.exit(0);

const options = JSON.parse(process.argv[2]);
const cell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(cell, 0, 0, ms);
const LIMIT_MS = 20000;

function waitFor(condition, what) {
  const deadline = Date.now() + LIMIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`lock-child ${options.id}: gave up waiting for ${what}`);
    sleep(1);
  }
}

function onStage(stage) {
  if (stage !== 'stale' || !options.barrier) return;
  const { dir, n } = options.barrier;
  writeFileSync(join(dir, `${options.id}.reached`), '');
  waitFor(() => readdirSync(dir).filter((name) => name.endsWith('.reached')).length >= n, 'the other racers');
}

function print(result) {
  process.stdout.write(`${JSON.stringify({ id: options.id, pid: process.pid, ...result })}\n`);
}

try {
  if (options.startAt) waitFor(() => Date.now() >= options.startAt, 'the start time');
  const lock = acquireLock(options.stateDir, { command: options.command }, { onStage });
  print({ won: true });
  if (options.doneFile) waitFor(() => existsSync(options.doneFile), 'the done file');
  lock.release();
} catch (error) {
  if (error instanceof LockHeld) print({ won: false, holder: error.holder, blockedBy: error.blockedBy });
  else print({ error: String(error && error.stack) });
}
