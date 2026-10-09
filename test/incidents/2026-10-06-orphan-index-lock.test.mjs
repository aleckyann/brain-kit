// 06/10/2026: a 0-byte `.git/index.lock`, a day old, left by a git command
// that died, killed every round at sync (exit 1) until a person removed it by
// hand. The rule: before sync, an index lock that cannot belong to a live git
// command is moved aside (renamed, never deleted), and only then. A commit
// waiting in an editor has already written the new index into its lock, so a
// lock that is empty, old, in a tree with no operation half done and no
// change of its own is an orphan; any other lock is left alone, and sync fails
// with git's words as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { moveOrphanIndexLock } from '../../src/guards/index-lock.mjs';
import { CLEAN_ENV, makeRepo, write } from '../helpers/git-repo.mjs';
import { makeCurateWorld } from '../helpers/curate-world.mjs';

const MINUTE = 60 * 1000;
const STALE = /index\.lock\.stale-\d{8}T\d{6}$/;

// A clean repository with one commit, and a lock in its git directory with
// `content` in it, `minutes` old.
function repoWithLock({ content = '', minutes = 20 } = {}) {
  const root = makeRepo({ 'index.md': '# Index\n' });
  const lock = join(root, '.git', 'index.lock');
  writeFileSync(lock, content);
  const then = new Date(Date.now() - minutes * MINUTE);
  utimesSync(lock, then, then);
  return { root, lock };
}

const move = (root, options = {}) => moveOrphanIndexLock(root, { env: CLEAN_ENV, ...options });

test('06/10/2026 replayed: a 0-byte lock, 20 minutes old, in a clean tree is moved aside, not deleted', () => {
  const { root, lock } = repoWithLock();
  const r = move(root);
  assert.equal(r.moved, true);
  assert.equal(r.skipped, null);
  assert.equal(r.error, null);
  assert.match(r.to, STALE);
  assert.ok(r.ageMinutes >= 19 && r.ageMinutes <= 21, String(r.ageMinutes));
  assert.equal(existsSync(lock), false, 'git can take its lock again');
  assert.equal(existsSync(r.to), true, 'the old lock is kept for a person to look at');
  assert.deepEqual(readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.lock')), [r.to.split('/').at(-1)]);
});

test('no lock: nothing to do', () => {
  const root = makeRepo({ 'index.md': '# Index\n' });
  assert.deepEqual(move(root), { moved: false, to: null, ageMinutes: null, skipped: 'absent', error: null });
});

// Each refusal leaves the lock where it is; the first case is its nearest
// positive (the test above): the same lock with one condition broken.
const REFUSALS = [
  ['a lock with a byte in it (a commit waiting in an editor has written its index there)', { content: 'x' }, {}, 'not_empty'],
  ['a lock 5 minutes old (a command that is running now)', { minutes: 5 }, {}, 'young'],
  ['a merge waiting for its commit', {}, { operation: (root) => write(root, '.git/MERGE_HEAD', '0'.repeat(40) + '\n') }, 'operation'],
  ['an untracked file in the tree', {}, { operation: (root) => write(root, 'draft.md', 'draft\n') }, 'dirty'],
];
for (const [name, lockOptions, { operation } = {}, skipped] of REFUSALS) {
  test(`${name}: kept, ${skipped}`, () => {
    const { root, lock } = repoWithLock(lockOptions);
    operation?.(root);
    const r = move(root);
    assert.deepEqual(r, { moved: false, to: null, ageMinutes: null, skipped, error: null });
    assert.equal(existsSync(lock), true);
    assert.deepEqual(readdirSync(join(root, '.git')).filter((n) => n.startsWith('index.lock')), ['index.lock']);
  });
}

test('a rename the file system refuses (EPERM on Windows) is reported, never thrown, and leaves the lock', () => {
  const { root, lock } = repoWithLock();
  const r = move(root, { rename: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); } });
  assert.deepEqual(r, { moved: false, to: null, ageMinutes: null, skipped: 'rename_failed', error: 'EPERM' });
  assert.equal(existsSync(lock), true);
});

test('the age bound is the one given: a 5 minute lock is moved when the bound is 1 minute', () => {
  const { root } = repoWithLock({ minutes: 5 });
  assert.equal(move(root, { minAgeMs: MINUTE }).moved, true);
});

test('the stale name carries the instant of the move, in UTC, and the age is read against that instant', () => {
  const { root, lock } = repoWithLock();
  const then = new Date('2026-10-06T10:00:00Z');
  utimesSync(lock, then, then);
  const r = move(root, { now: new Date('2026-10-06T10:20:30Z') });
  assert.equal(r.moved, true);
  assert.ok(r.to.endsWith('index.lock.stale-20261006T102030'), r.to);
  assert.equal(r.ageMinutes, 20);
});

// The round: the same lock in a vault that is level with its remote.
function lockedWorld(options) {
  const w = makeCurateWorld();
  const lock = join(w.vault, '.git', 'index.lock');
  writeFileSync(lock, options.content ?? '');
  const then = new Date(Date.now() - options.minutes * MINUTE);
  utimesSync(lock, then, then);
  return { w, lock };
}

test('a round with the 06/10/2026 lock goes on to sync, records the repair and logs it', () => {
  const { w, lock } = lockedWorld({ minutes: 20 });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.ok(['proposed', 'nothing_proposed'].includes(last.reasonCode), last.reasonCode);
  assert.equal(last.repairs.length, 1);
  assert.equal(last.repairs[0].kind, 'index_lock_moved');
  assert.match(last.repairs[0].to, STALE);
  assert.ok(last.repairs[0].ageMinutes >= 19, String(last.repairs[0].ageMinutes));
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(last.repairs[0].to), true);
  assert.match(w.logText(), /index_lock_moved/);
});

test('the nearest positive case of the round: a young lock stays, is logged as kept, and no repair is recorded', () => {
  const { w, lock } = lockedWorld({ minutes: 5 });
  w.curate();
  const last = w.lastRun();
  assert.deepEqual(last.repairs, []);
  assert.equal(existsSync(lock), true);
  assert.match(w.logText(), /index_lock_kept .*"skipped":"young"/);
  assert.doesNotMatch(w.logText(), /index_lock_moved/);
});

test('a round with no lock logs nothing about one and records no repair', () => {
  const w = makeCurateWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().repairs, []);
  assert.doesNotMatch(w.logText(), /index_lock/);
});
