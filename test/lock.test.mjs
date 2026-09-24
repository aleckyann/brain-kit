import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, currentIdentity, describeLock, joinOrAcquire, LockHeld } from '../src/guards/lock.mjs';
import { GUARD_FILES, GuardError } from '../src/guards/location.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { git, makeRepo } from './helpers/git-repo.mjs';
import { makeHookVault, runHookProcess } from './helpers/hook-world.mjs';

const CHILD = fileURLToPath(new URL('./helpers/lock-child.mjs', import.meta.url));
const WATCHER = fileURLToPath(new URL('./helpers/lock-watcher.mjs', import.meta.url));
const NOW = new Date('2026-07-29T09:30:00.000Z');
const ME = currentIdentity();
const HAS_IDENTITY = ME.machineId !== null && ME.bootId !== null && ME.pidNamespace !== null;
const OTHER_BOOT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_MACHINE = '0123456789abcdef0123456789abcdef';
const TRANSLATORS = { en: createTranslator('en'), 'pt-BR': createTranslator('pt-BR') };

function commonDir(root) {
  return join(root, '.git');
}

function lockPath(root) {
  return join(commonDir(root), GUARD_FILES.LOCK);
}

function markerPath(root) {
  return join(commonDir(root), GUARD_FILES.LOCK_RECLAIM);
}

// A pid that was really used by a process on this machine and is now dead.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  return child.pid;
}

function writeLock(root, holder) {
  writeFileSync(lockPath(root), `${JSON.stringify(holder)}\n`);
}

// A holder from this machine, this boot and this pid namespace.
function holderLikeMe(overrides = {}) {
  return {
    pid: deadPid(), host: ME.host, command: 'curate', startedAt: '2026-07-29T03:00:00.000Z',
    machineId: ME.machineId, bootId: ME.bootId, pidNamespace: ME.pidNamespace, ...overrides,
  };
}

// Whatever `fn` throws, asserted to be an instance of `kind`, and returned.
function thrown(fn, kind = LockHeld) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof kind, `expected ${kind.name}, got ${caught && caught.stack}`);
  return caught;
}

// Every brain-kit file in the git common directory but the lock itself.
function leftovers(root) {
  return readdirSync(commonDir(root)).filter((name) => name.startsWith('brain-kit') && name !== GUARD_FILES.LOCK);
}

function rendersIn(error, needle) {
  for (const [lang, t] of Object.entries(TRANSLATORS)) {
    const text = t(error.messageKey, error.params);
    assert.ok(text.includes(String(needle)), `${lang}: ${JSON.stringify(text)} does not name ${needle}`);
  }
}

// Starts the lock child; resolves with its one JSON line and a way to wait
// for it to exit. `prefix` runs it under another program (unshare).
function startChild(options, { env = process.env, prefix = [] } = {}) {
  const [command, ...args] = [...prefix, process.execPath, CHILD, JSON.stringify(options)];
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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

// --- the file and its place ---------------------------------------------------

test('acquire records who holds the lock in a 0600 file in the git common directory, and describeLock reads it back', () => {
  const root = makeRepo();
  const lock = acquireLock(root, { command: 'propose', now: NOW });
  assert.deepEqual(lock.holder, {
    pid: process.pid, host: hostname(), command: 'propose', startedAt: NOW.toISOString(),
    machineId: ME.machineId, bootId: ME.bootId, pidNamespace: ME.pidNamespace,
  });
  assert.equal(lock.lockPath, lockPath(root));
  assert.deepEqual(describeLock(root), lock.holder);
  assert.deepEqual(JSON.parse(readFileSync(lockPath(root), 'utf8')), { ...lock.holder, token: lock.token });
  assert.equal(statSync(lockPath(root)).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(root), [], 'no temporary file or marker is left beside the lock');
  lock.release();
});

test('the holder carries this machine\'s identity where the platform has it', { skip: !existsSync('/proc/self/ns/pid') && 'no /proc here' }, () => {
  assert.equal(ME.pidNamespace, readlinkSync('/proc/self/ns/pid'));
  assert.equal(ME.bootId, readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  if (existsSync('/etc/machine-id')) assert.equal(ME.machineId, readFileSync('/etc/machine-id', 'utf8').trim());
  assert.equal(ME.host, hostname());
});

test('acquire refuses to run without a command name', () => {
  const root = makeRepo();
  assert.throws(() => acquireLock(root, {}), TypeError);
  assert.throws(() => acquireLock(root, { command: '' }), TypeError);
});

test('one lock per repository: a subdirectory, a symlink, a linked worktree and a GIT_DIR elsewhere all find the same one', () => {
  const root = makeRepo({ 'notes/a.md': 'a\n' });
  const lock = acquireLock(root, { command: 'propose' });
  const link = join(root, '..', 'link to vault');
  symlinkSync(root, link);
  const worktree = join(root, '..', 'worktree');
  git(root, ['worktree', 'add', '-q', '-b', 'other', worktree]);
  const elsewhere = makeRepo();
  const env = { ...process.env, GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere };
  for (const [label, where, options] of [['subdirectory', join(root, 'notes'), {}], ['symlink', link, {}], ['linked worktree', worktree, {}],
    ['GIT_DIR naming another repository', root, { env }]]) {
    const error = thrown(() => acquireLock(where, { command: 'sync', ...options }));
    assert.equal(error.holder.pid, process.pid, label);
    assert.equal(error.lockPath, lockPath(root), label);
  }
  assert.equal(existsSync(join(elsewhere, '.git', GUARD_FILES.LOCK)), false);
  lock.release();
});

test('a vault whose path ends in a space is found as itself: only git\'s newline is taken off a path it prints', () => {
  const parent = realpathSync(makeTempDir('brain-kit-lock-space-'));
  const root = join(parent, 'vault ');
  mkdirSync(root);
  mkdirSync(join(parent, 'vault'));
  git(root, ['init', '-q', '-b', 'main']);
  const lock = acquireLock(root, { command: 'propose' });
  assert.equal(lock.lockPath, join(root, '.git', GUARD_FILES.LOCK));
  assert.equal(existsSync(lock.lockPath), true);
  lock.release();
});

test('four processes reaching one vault through four environments: exactly one holds the lock', async () => {
  const root = makeRepo();
  const base = join(root, '..');
  const link = join(base, 'link to vault');
  symlinkSync(root, link);
  const doneFile = join(base, 'done');
  const plain = { ...process.env };
  delete plain.BRAIN_KIT_STATE_DIR;
  const runs = [
    { label: 'pinned state directory', where: root, env: { ...plain, BRAIN_KIT_STATE_DIR: join(base, 'pinned') } },
    { label: 'XDG_STATE_HOME A', where: root, env: { ...plain, XDG_STATE_HOME: join(base, 'xdg-a') } },
    { label: 'XDG_STATE_HOME B', where: root, env: { ...plain, XDG_STATE_HOME: join(base, 'xdg-b') } },
    { label: 'symlink', where: link, env: { ...plain, XDG_STATE_HOME: join(base, 'xdg-a') } },
  ];
  const first = startChild({ root: runs[0].where, command: 'curate', id: 0, doneFile }, { env: runs[0].env });
  try {
    const held = await first.line;
    assert.equal(held.won, true, JSON.stringify(held));
    for (const [i, run] of runs.entries()) {
      if (i === 0) continue;
      const other = startChild({ root: run.where, command: 'propose', id: i }, { env: run.env });
      const result = await other.line;
      await other.exited;
      assert.equal(result.won, false, `${run.label}: ${JSON.stringify(result)}`);
      assert.equal(result.holder.pid, first.child.pid, run.label);
    }
  } finally {
    writeFileSync(doneFile, '');
    await first.exited;
  }
});

test('outside a working tree the lock refuses with exit 2, names the directory in both languages, and writes nothing', () => {
  const plain = realpathSync(makeTempDir('brain-kit-lock-plain-'));
  const bare = join(realpathSync(makeTempDir('brain-kit-lock-bare-')), 'repo.git');
  git(join(bare, '..'), ['init', '-q', '--bare', bare]);
  const root = makeRepo();
  for (const where of [plain, bare, join(root, '.git')]) {
    const before = readdirSync(where).sort();
    const error = thrown(() => acquireLock(where, { command: 'propose' }), GuardError);
    assert.equal(error.code, 'GUARD_NOT_A_REPOSITORY', where);
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.exitCode, 2);
    assert.equal(error.params.dir, where);
    rendersIn(error, where);
    assert.deepEqual(readdirSync(where).sort(), before, `nothing was written in ${where}`);
    assert.equal(thrown(() => describeLock(where), GuardError).code, 'GUARD_NOT_A_REPOSITORY');
  }
});

test('git missing is a failure, never read as "not a repository"', () => {
  const root = makeRepo();
  const empty = makeTempDir('brain-kit-lock-nogit-');
  const error = thrown(() => acquireLock(root, { command: 'propose', env: { ...process.env, PATH: empty } }), GuardError);
  assert.equal(error.code, 'GUARD_GIT_FAILED');
  assert.equal(error.exitCode, EXIT.FAILURE);
  rendersIn(error, root);
});

// --- a second writer ----------------------------------------------------------

test('a second acquire in the same process fails at once with LockHeld naming the first holder, exit code 75', () => {
  const root = makeRepo();
  const first = acquireLock(root, { command: 'propose', now: NOW });
  const before = readFileSync(lockPath(root), 'utf8');
  const error = thrown(() => acquireLock(root, { command: 'sync' }));
  assert.deepEqual(error.holder, first.holder);
  assert.equal(error.code, 'LOCK_HELD');
  assert.equal(error.exitCode, EXIT.TEMPFAIL);
  assert.equal(error.exitCode, 75);
  assert.equal(error.lockPath, lockPath(root));
  assert.equal(error.blockedBy, null);
  assert.equal(error.messageKey, 'lock.held');
  rendersIn(error, process.pid);
  rendersIn(error, 'propose');
  assert.equal(readFileSync(lockPath(root), 'utf8'), before, 'the refused acquire did not touch the lock');
  first.release();
});

test('a second acquire in a child process fails with the holder named', async () => {
  const root = makeRepo();
  const first = acquireLock(root, { command: 'propose', now: NOW });
  const { line, exited } = startChild({ root, command: 'sync', id: 'second' });
  const result = await line;
  await exited;
  assert.equal(result.won, false, JSON.stringify(result));
  assert.deepEqual(result.holder, first.holder);
  first.release();
});

// --- release ------------------------------------------------------------------

test('release lets the next acquire succeed, a second release is harmless, and nothing is left behind', () => {
  const root = makeRepo();
  const first = acquireLock(root, { command: 'propose' });
  assert.equal(first.release(), true);
  assert.equal(existsSync(lockPath(root)), false);
  assert.equal(describeLock(root), null);
  assert.equal(first.release(), false);
  const second = acquireLock(root, { command: 'sync' });
  assert.equal(second.holder.command, 'sync');
  assert.equal(second.release(), true);
  assert.deepEqual(leftovers(root), []);
  assert.equal(existsSync(lockPath(root)), false);
});

test('release never deletes a lock that is no longer the one it placed, even one with the same bytes', () => {
  const root = makeRepo();
  const lock = acquireLock(root, { command: 'propose' });
  const foreign = holderLikeMe({ pid: 1 });
  writeLock(root, foreign);
  assert.equal(lock.release(), false);
  assert.deepEqual(describeLock(root), foreign);
  unlinkSync(lockPath(root));

  // Same bytes, another file: a lock that was replaced by one that happens
  // to read the same is still not ours to delete.
  const again = acquireLock(root, { command: 'propose', now: NOW });
  const text = readFileSync(lockPath(root), 'utf8');
  const copy = join(commonDir(root), 'copy');
  writeFileSync(copy, text);
  renameSync(copy, lockPath(root));
  assert.equal(again.release(), false);
  assert.equal(readFileSync(lockPath(root), 'utf8'), text);
});

test('a stale handle released again never removes a later lock, even one with the same bytes on a reused inode', () => {
  const root = makeRepo();
  const first = acquireLock(root, { command: 'propose', now: NOW });
  assert.equal(first.release(), true);
  const second = acquireLock(root, { command: 'propose', now: NOW });
  assert.equal(first.release(), false);
  assert.deepEqual(describeLock(root), second.holder);
  second.release();
});

test('release of a lock a person already removed by hand is a quiet no-op', () => {
  const root = makeRepo();
  const lock = acquireLock(root, { command: 'propose' });
  unlinkSync(lockPath(root));
  assert.equal(lock.release(), false);
  assert.equal(describeLock(root), null);
});

// --- a lock that cannot be read -------------------------------------------------

const UNREADABLE = { pid: null, host: null, command: null, startedAt: null, machineId: null, bootId: null, pidNamespace: null, unreadable: true };

test('describeLock is null with no lock, and a lock that cannot be read is reported, never read as no lock', () => {
  const root = makeRepo();
  assert.equal(describeLock(root), null);
  const good = '"host":"h","command":"c","startedAt":"s"';
  for (const text of ['', 'not json', `{"pid":"12",${good}}`, `{"pid":0,${good}}`, `{"pid":-1,${good}}`, `{"pid":1.5,${good}}`,
    '{"pid":12,"host":"","command":"c","startedAt":"s"}', '{"pid":12,"host":5,"command":"c","startedAt":"s"}', '[12]', '"text"',
    '{"pid":12,"host":"h","startedAt":"s"}', '{"pid":12,"host":"h","command":"c"}', 'null', '12',
    `{"pid":12,${good},"machineId":5}`, `{"pid":12,${good},"bootId":""}`, `{"pid":12,${good},"pidNamespace":["x"]}`]) {
    writeFileSync(lockPath(root), text);
    assert.deepEqual(describeLock(root), UNREADABLE, `lock text ${JSON.stringify(text)}`);
  }
  unlinkSync(lockPath(root));
  mkdirSync(lockPath(root));
  assert.deepEqual(describeLock(root), UNREADABLE, 'a directory under the lock name');
});

test('identity fields that are absent or null read as null: a lock written where the platform has none', () => {
  const root = makeRepo();
  writeFileSync(lockPath(root), '{"pid":12,"host":"h","command":"c","startedAt":"s","machineId":null}');
  assert.deepEqual(describeLock(root), { pid: 12, host: 'h', command: 'c', startedAt: 's', machineId: null, bootId: null, pidNamespace: null });
});

test('a symlink or a FIFO under the lock name is an unreadable lock: never followed, never waited on, never reclaimed', { timeout: 20000 }, () => {
  const root = makeRepo();
  // A symlink to a perfectly good stale lock elsewhere is still not a lock.
  const elsewhere = join(root, '..', 'elsewhere');
  writeFileSync(elsewhere, `${JSON.stringify(holderLikeMe())}\n`);
  symlinkSync(elsewhere, lockPath(root));
  assert.deepEqual(describeLock(root), UNREADABLE, 'a symlink under the lock name');
  assert.equal(thrown(() => acquireLock(root, { command: 'propose' })).holder.unreadable, true);
  unlinkSync(lockPath(root));
  symlinkSync(join(root, 'nowhere'), lockPath(root));
  assert.deepEqual(describeLock(root), UNREADABLE, 'a dangling symlink under the lock name');
  unlinkSync(lockPath(root));
  assert.equal(spawnSync('mkfifo', [lockPath(root)]).status, 0);
  assert.deepEqual(describeLock(root), UNREADABLE, 'a FIFO under the lock name');
  assert.equal(thrown(() => acquireLock(root, { command: 'propose' })).holder.unreadable, true);
});

test('an unreadable lock is held: no one whose death could be proved, so it is never reclaimed, and the message names the file', () => {
  const root = makeRepo();
  for (const text of ['', `{"pid":${deadPid()},"host":"${hostname()}","command":"curate"}`]) {
    writeFileSync(lockPath(root), text);
    const error = thrown(() => acquireLock(root, { command: 'propose' }));
    assert.equal(error.holder.pid, null);
    assert.equal(error.holder.unreadable, true);
    assert.equal(error.messageKey, 'lock.held_unreadable');
    rendersIn(error, lockPath(root));
    assert.equal(readFileSync(lockPath(root), 'utf8'), text);
  }
});

// --- staleness: provably dead ----------------------------------------------------

test('a lock from this machine, boot and pid namespace whose pid is dead is reclaimed, by replacement, with nothing left behind', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  const inoBefore = lstatSync(lockPath(root)).ino;
  const lock = acquireLock(root, { command: 'propose', now: NOW });
  assert.equal(lock.holder.pid, process.pid);
  assert.deepEqual(describeLock(root), lock.holder);
  assert.notEqual(lstatSync(lockPath(root)).ino, inoBefore);
  assert.deepEqual(leftovers(root), []);
  assert.equal(lock.release(), true, 'a reclaimed lock is released like any other');
});

test('a lock whose pid is alive is not reclaimed, including one owned by another user', () => {
  const root = makeRepo();
  for (const pid of [process.ppid, 1]) {
    const live = holderLikeMe({ pid });
    writeLock(root, live);
    const error = thrown(() => acquireLock(root, { command: 'propose' }));
    assert.deepEqual(error.holder, live, `pid ${pid}`);
    assert.deepEqual(describeLock(root), live);
  }
});

test('a lock from another host name is never reclaimed, even with this machine\'s identity and a dead pid', () => {
  const root = makeRepo();
  const remote = holderLikeMe({ host: 'other-host.example.invalid' });
  writeLock(root, remote);
  assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' })).holder, remote);
  assert.deepEqual(describeLock(root), remote);
  assert.deepEqual(leftovers(root), []);
});

test('a lock from a previous boot of this machine is reclaimed, even when its pid is alive now: the reboot proved it dead', { skip: !HAS_IDENTITY }, () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe({ pid: process.ppid, bootId: OTHER_BOOT, pidNamespace: 'pid:[1]' }));
  const lock = acquireLock(root, { command: 'propose' });
  assert.equal(describeLock(root).pid, process.pid);
  lock.release();
});

test('a lock from another machine id is never reclaimed, whatever its boot or pid', { skip: !HAS_IDENTITY }, () => {
  const root = makeRepo();
  for (const holder of [holderLikeMe({ machineId: OTHER_MACHINE }), holderLikeMe({ machineId: OTHER_MACHINE, bootId: OTHER_BOOT })]) {
    writeLock(root, holder);
    assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' })).holder, holder);
  }
});

test('a lock from another pid namespace on this boot is never reclaimed: its pid means nothing here', { skip: !HAS_IDENTITY }, () => {
  const root = makeRepo();
  const holder = holderLikeMe({ pidNamespace: 'pid:[1]' });
  writeLock(root, holder);
  assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' })).holder, holder);
});

test('a lock whose identity cannot be compared with this machine\'s is never reclaimed', { skip: !HAS_IDENTITY }, () => {
  const root = makeRepo();
  for (const holder of [
    holderLikeMe({ machineId: null, bootId: null, pidNamespace: null }),
    holderLikeMe({ bootId: null }),
    holderLikeMe({ bootId: null, pidNamespace: null }),
    holderLikeMe({ pidNamespace: null }),
  ]) {
    writeLock(root, holder);
    assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' })).holder, holder, JSON.stringify(holder));
  }
  // And from this side: a process that knows its machine but not its boot.
  const holder = holderLikeMe({ pid: process.ppid, bootId: OTHER_BOOT });
  writeLock(root, holder);
  assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' }, { identity: { ...ME, bootId: null } })).holder, holder);
});

test('a process knowing no identity never reclaims a lock written by one that knows it, and the reverse', () => {
  const root = makeRepo();
  const bare = { host: hostname(), machineId: null, bootId: null, pidNamespace: null };
  const knowing = { host: hostname(), machineId: OTHER_MACHINE, bootId: OTHER_BOOT, pidNamespace: 'pid:[1]' };
  const byKnowing = { pid: deadPid(), command: 'curate', startedAt: 's', ...knowing };
  writeLock(root, byKnowing);
  assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' }, { identity: bare })).holder, byKnowing);
  const byBare = { pid: deadPid(), command: 'curate', startedAt: 's', ...bare };
  writeLock(root, byBare);
  assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' }, { identity: knowing })).holder, byBare);
});

test('where the platform has no identity, a dead pid on exactly this host name is reclaimed, and nothing looser', () => {
  const root = makeRepo();
  const bare = { host: 'ana-laptop', machineId: null, bootId: null, pidNamespace: null };
  for (const host of ['ana-laptop.other-site.example.invalid', 'ana-laptop.', 'ANA-LAPTOP', 'ana-lapto']) {
    const holder = { pid: deadPid(), host, command: 'curate', startedAt: 's', machineId: null, bootId: null, pidNamespace: null };
    writeLock(root, holder);
    assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' }, { identity: bare })).holder, holder, host);
  }
  writeLock(root, { pid: process.ppid, host: 'ana-laptop', command: 'curate', startedAt: 's' });
  assert.equal(thrown(() => acquireLock(root, { command: 'propose' }, { identity: bare })).holder.pid, process.ppid, 'a live pid');
  writeLock(root, { pid: deadPid(), host: 'ana-laptop', command: 'curate', startedAt: 's' });
  const lock = acquireLock(root, { command: 'propose' }, { identity: bare });
  assert.deepEqual(describeLock(root), lock.holder);
  assert.equal(lock.holder.host, 'ana-laptop');
  lock.release();
});

test('this machine\'s short host name alone does not make a lock from a longer name this host\'s', () => {
  const root = makeRepo();
  const short = hostname().split('.')[0];
  for (const host of [`${short}.other-site.example.invalid`, `${hostname()}.other-site.example.invalid`]) {
    const holder = holderLikeMe({ host });
    writeLock(root, holder);
    assert.deepEqual(thrown(() => acquireLock(root, { command: 'propose' })).holder, holder, host);
  }
});

const CAN_UNSHARE = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', 'true']).status === 0;

test('a process in its own pid namespace on this host never takes a live holder\'s lock', { skip: !CAN_UNSHARE && 'unprivileged pid namespaces are not available here' }, async () => {
  const root = makeRepo();
  const lock = acquireLock(root, { command: 'curate' });
  try {
    const inside = startChild({ root, command: 'propose', id: 'namespaced' }, { prefix: ['unshare', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc'] });
    const result = await inside.line;
    await inside.exited;
    assert.equal(result.won, false, JSON.stringify(result));
    assert.equal(result.holder.pid, process.pid);
    assert.deepEqual(describeLock(root), lock.holder);
  } finally {
    lock.release();
  }
});

test('a live process holding the lock blocks the next writer; once it dies without releasing, its lock is reclaimed', async () => {
  const root = makeRepo();
  const doneFile = join(root, '..', 'never');
  const { child, line, exited } = startChild({ root, command: 'curate', id: 'holder', doneFile });
  try {
    const result = await line;
    assert.equal(result.won, true, JSON.stringify(result));
    const error = thrown(() => acquireLock(root, { command: 'propose' }));
    assert.equal(error.holder.pid, child.pid);
    assert.equal(error.holder.command, 'curate');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  assert.equal(describeLock(root).pid, child.pid, 'the killed holder never released');
  const lock = acquireLock(root, { command: 'propose' });
  assert.equal(describeLock(root).pid, process.pid);
  lock.release();
});

// --- the reclaim marker -------------------------------------------------------

test('a reclaim marker held by a live reclaimer means the lock is being taken: LockHeld names that reclaimer', () => {
  const root = makeRepo();
  const stale = holderLikeMe();
  writeLock(root, stale);
  const reclaimer = holderLikeMe({ pid: process.ppid, command: 'sync' });
  writeFileSync(markerPath(root), `${JSON.stringify(reclaimer)}\n`);
  const error = thrown(() => acquireLock(root, { command: 'propose' }));
  assert.deepEqual(error.holder, reclaimer);
  assert.equal(error.blockedBy, null);
  assert.equal(error.code, 'LOCK_HELD');
  assert.deepEqual(describeLock(root), stale, 'the lock itself was not touched');
  assert.ok(existsSync(markerPath(root)), 'another process\'s marker is never removed');
});

test('a marker left by a reclaim that died blocks the reclaim: the message says a reclaim died and names the file, not a holder', () => {
  const root = makeRepo();
  const stale = holderLikeMe();
  writeLock(root, stale);
  const deadReclaimer = holderLikeMe({ command: 'sync' });
  writeFileSync(markerPath(root), `${JSON.stringify(deadReclaimer)}\n`);
  const error = thrown(() => acquireLock(root, { command: 'propose' }));
  assert.equal(error.code, 'LOCK_RECLAIM_DIED');
  assert.equal(error.exitCode, EXIT.FAILURE, 'it needs a person: a scheduler reads 75 as "try later"');
  assert.equal(error.exitCode, 1);
  assert.equal(error.blockedBy, markerPath(root));
  assert.equal(error.holder, null);
  assert.equal(error.messageKey, 'lock.reclaim_died');
  assert.deepEqual(error.params, { marker: markerPath(root) });
  rendersIn(error, markerPath(root));
  assert.match(error.message, /died/);
  assert.doesNotMatch(error.message, new RegExp(`pid ${deadReclaimer.pid}`));
  assert.deepEqual(describeLock(root), stale);
  unlinkSync(markerPath(root));
  acquireLock(root, { command: 'propose' }).release();
});

test('a reclaimer that judged the lock stale loses to one that finished replacing it first', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  let first = null;
  const error = thrown(() => acquireLock(root, { command: 'slow' }, {
    onStage(stage) {
      if (stage === 'stale' && first === null) first = acquireLock(root, { command: 'fast' });
    },
  }));
  assert.equal(error.holder.command, 'fast');
  assert.deepEqual(describeLock(root), first.holder);
  assert.deepEqual(leftovers(root), []);
  first.release();
});

test('a reclaimer that finds the marker taken loses to the reclaimer holding it', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  let loser = null;
  const winner = acquireLock(root, { command: 'first' }, {
    onStage(stage) {
      if (stage === 'claimed') loser = thrown(() => acquireLock(root, { command: 'second' }));
    },
  });
  assert.equal(loser.holder.command, 'first');
  assert.deepEqual(describeLock(root), winner.holder);
  assert.deepEqual(leftovers(root), []);
  winner.release();
});

test('a lock released between the failed create and the read is simply taken', () => {
  const root = makeRepo();
  const other = acquireLock(root, { command: 'curate' });
  const lock = acquireLock(root, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'occupied') other.release();
    },
  });
  assert.equal(describeLock(root).command, 'propose');
  lock.release();
});

test('a stale lock removed while it was being judged is simply taken', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  const lock = acquireLock(root, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'stale') unlinkSync(lockPath(root));
    },
  });
  assert.equal(describeLock(root).command, 'propose');
  assert.deepEqual(leftovers(root), []);
  lock.release();
});

test('a marker that vanishes before it can be read, over an unchanged stale lock, means that reclaim gave up: go round and take it', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  writeFileSync(markerPath(root), `${JSON.stringify(holderLikeMe({ pid: process.ppid }))}\n`);
  let contended = 0;
  const lock = acquireLock(root, { command: 'propose' }, {
    onStage(stage) {
      if (stage === 'contended' && (contended += 1) === 1) unlinkSync(markerPath(root));
    },
  });
  assert.equal(contended, 1);
  assert.deepEqual(describeLock(root), lock.holder);
  assert.deepEqual(leftovers(root), []);
  lock.release();
});

test('a marker taken by a late reclaimer after the lock was already replaced: the loser names the real holder, not the late one', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  const late = holderLikeMe({ pid: process.ppid, command: 'late' });
  let winner = null;
  const error = thrown(() => acquireLock(root, { command: 'slow' }, {
    onStage(stage) {
      if (stage !== 'stale' || winner !== null) return;
      winner = acquireLock(root, { command: 'winner' });
      writeFileSync(markerPath(root), `${JSON.stringify(late)}\n`);
    },
  }));
  assert.deepEqual(error.holder, winner.holder);
  assert.deepEqual(describeLock(root), winner.holder);
  unlinkSync(markerPath(root));
  winner.release();
});

test('a lock that keeps changing under the acquire is reported as held after a bounded number of looks', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  let looks = 0;
  const error = thrown(() => acquireLock(root, { command: 'propose' }, {
    onStage(stage) {
      if (stage !== 'stale') return;
      looks += 1;
      if (looks > 50) throw new Error('the acquire did not stop looking');
      writeLock(root, holderLikeMe({ command: `round-${looks}` }));
    },
  }));
  assert.ok(looks > 1 && looks <= 50, `looked ${looks} times`);
  assert.equal(error.holder.pid === null, false);
  assert.match(error.holder.command, /^round-/);
});

// --- leftovers and file systems ---------------------------------------------------

test('leftover private files are removed on the next acquire when their writer is provably dead or they are an hour old, and only then', () => {
  const root = makeRepo();
  const dir = commonDir(root);
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const put = (name, content, old = false) => {
    writeFileSync(join(dir, name), content);
    if (old) utimesSync(join(dir, name), hourAgo, hourAgo);
    return name;
  };
  const gone = [
    put(`brain-kit.lock.${deadPid()}.aaaaaaaaaaaa.tmp`, JSON.stringify(holderLikeMe())),
    put(`brain-kit.lock.reclaim.${deadPid()}.bbbbbbbbbbbb.tmp`, JSON.stringify(holderLikeMe())),
    put('brain-kit.lock.4242.dddddddddddd.tmp', '', true),
    put('brain-kit-snapshot.json.4242.eeeeeeeeeeee.tmp', '{"format":1', true),
  ];
  const kept = [
    put(`brain-kit.lock.${process.ppid}.cccccccccccc.tmp`, JSON.stringify(holderLikeMe({ pid: process.ppid })), true),
    put('brain-kit.lock.4243.ffffffffffff.tmp', ''),
    put('brain-kit-snapshot.json.4243.abcdefabcdef.tmp', '{"format":1'),
    put(`brain-kit.lock.${deadPid()}.123456123456.tmp`, JSON.stringify(holderLikeMe({ host: 'other-host.example.invalid' })), true),
    put('brain-kit.lock.4244.xyz.tmp', '', true),
    put('unrelated.tmp', '', true),
    put(GUARD_FILES.SNAPSHOT, '{"format":1}', true),
  ];
  const lock = acquireLock(root, { command: 'propose' });
  const names = readdirSync(dir);
  for (const name of gone) assert.equal(names.includes(name), false, `${name} should have been removed`);
  for (const name of kept) assert.equal(names.includes(name), true, `${name} should have been kept`);
  lock.release();
});

test('acquiring from a linked worktree sweeps its own git directory and the common one', () => {
  const root = makeRepo({ 'index.md': '# Ana\n' });
  const worktree = join(root, '..', 'worktree');
  git(root, ['worktree', 'add', '-q', '-b', 'other', worktree]);
  const linkedGitDir = realpathSync(git(worktree, ['rev-parse', '--git-dir']).replace(/\n$/, ''));
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const old = join(linkedGitDir, 'brain-kit-snapshot.json.4242.aaaaaaaaaaaa.tmp');
  const recent = join(linkedGitDir, 'brain-kit-snapshot.json.4243.bbbbbbbbbbbb.tmp');
  writeFileSync(old, '{"format":1');
  utimesSync(old, hourAgo, hourAgo);
  writeFileSync(recent, '{"format":1');
  // And the common directory is swept too, from whichever worktree acquires.
  const deadLockTmp = join(commonDir(root), `brain-kit.lock.${deadPid()}.cccccccccccc.tmp`);
  writeFileSync(deadLockTmp, JSON.stringify(holderLikeMe()));
  const lock = acquireLock(worktree, { command: 'propose' });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(deadLockTmp), false);
  assert.equal(lock.lockPath, lockPath(root), 'the lock itself stays in the common directory');
  lock.release();
});

test('a file system without hard links is refused with a translated message naming the directory, and leaves nothing', () => {
  const root = makeRepo();
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    const link = () => {
      const error = new Error(`${code}: operation not permitted, link`);
      error.code = code;
      throw error;
    };
    const error = thrown(() => acquireLock(root, { command: 'propose' }, { link }), GuardError);
    assert.equal(error.code, 'LOCK_NO_HARD_LINKS', code);
    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.deepEqual(error.params, { dir: commonDir(root) });
    rendersIn(error, commonDir(root));
    assert.deepEqual(readdirSync(commonDir(root)).filter((name) => name.startsWith('brain-kit')), []);
  }
  const other = () => {
    const error = new Error('EIO: i/o error, link');
    error.code = 'EIO';
    throw error;
  };
  assert.throws(() => acquireLock(root, { command: 'propose' }, { link: other }), (error) => error.code === 'EIO' && !(error instanceof GuardError));
});

// --- races --------------------------------------------------------------------

test('while a stale lock is replaced, again and again, a second process watching never once finds the lock\'s name empty', async () => {
  const root = makeRepo();
  const base = join(root, '..');
  const staleText = `${JSON.stringify(holderLikeMe())}\n`;
  const putStaleBack = () => {
    const tmp = join(base, 'stale.tmp');
    writeFileSync(tmp, staleText);
    renameSync(tmp, lockPath(root));
  };
  putStaleBack();
  const readyFile = join(base, 'watching');
  const stopFile = join(base, 'stop');
  const watcher = spawn(process.execPath, [WATCHER, JSON.stringify({ lockPath: lockPath(root), readyFile, stopFile })], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  watcher.stdout.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => watcher.on('exit', resolve));
  let laps = 0;
  try {
    while (!existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 5));
    for (; laps < 400; laps += 1) {
      const lock = acquireLock(root, { command: 'propose' });
      assert.equal(lock.holder.pid, process.pid);
      putStaleBack();
    }
  } finally {
    writeFileSync(stopFile, '');
    await exited;
  }
  const { looks, gaps } = JSON.parse(out);
  assert.equal(laps, 400);
  assert.ok(looks > laps, `the watcher looked only ${looks} times`);
  assert.equal(gaps, 0, `the lock's name was empty ${gaps} times in ${looks} looks`);
});

async function race({ n, barrier, startAt }) {
  const root = makeRepo();
  writeLock(root, holderLikeMe());
  const base = join(root, '..');
  const doneFile = join(base, 'done');
  let barrierOption;
  if (barrier) {
    barrierOption = { dir: join(base, 'barrier'), n };
    mkdirSync(barrierOption.dir);
  }
  const children = Array.from({ length: n }, (_, i) => startChild({ root, command: `racer-${i}`, id: i, barrier: barrierOption, startAt, doneFile }));
  try {
    const results = await Promise.all(children.map((c) => c.line));
    for (const result of results) assert.equal(result.error, undefined, result.error);
    const winners = results.filter((result) => result.won);
    assert.equal(winners.length, 1, `exactly one winner, got ${JSON.stringify(results)}`);
    const winner = winners[0];
    assert.equal(describeLock(root).pid, winner.pid);
    for (const loser of results.filter((result) => !result.won)) {
      assert.equal(loser.holder.pid, winner.pid, `every loser names the winner: ${JSON.stringify(loser)}`);
    }
  } finally {
    writeFileSync(doneFile, '');
    await Promise.all(children.map((c) => c.exited));
  }
  assert.equal(describeLock(root), null, 'the winner released');
  assert.deepEqual(leftovers(root), []);
}

test('two child processes that both judged the same lock stale race to reclaim it: exactly one wins', async () => {
  await race({ n: 2, barrier: true });
});

test('four child processes that all judged the same lock stale race to reclaim it: exactly one wins', async () => {
  await race({ n: 4, barrier: true });
});

test('unforced races between child processes on one stale lock always produce exactly one winner', async () => {
  for (let round = 0; round < 6; round += 1) {
    await race({ n: 4, startAt: Date.now() + 500 });
  }
});


// --- the round's token (phase 2, task 5) ------------------------------------------

const TOKEN_RE = /^[0-9a-f]{32}$/;

function withToken(token) {
  return { ...process.env, BRAIN_KIT_ROUND_TOKEN: token };
}

// Every text a caller could print about a holder, in both languages.
function everythingSaid(error) {
  return [JSON.stringify(error.holder), error.message, ...Object.values(TRANSLATORS).map((t) => t(error.messageKey, error.params))].join('\n');
}

test('acquire records a fresh 32-hex token in the lock file and returns it, never in the holder callers see', () => {
  const root = makeRepo();
  const lock = acquireLock(root, { command: 'curate', now: NOW });
  try {
    assert.match(lock.token, TOKEN_RE);
    assert.equal(JSON.parse(readFileSync(lockPath(root), 'utf8')).token, lock.token);
    assert.equal('token' in lock.holder, false);
    assert.equal('token' in describeLock(root), false);
    assert.equal(JSON.stringify(describeLock(root)).includes(lock.token), false);
    const refused = thrown(() => acquireLock(root, { command: 'propose' }));
    assert.equal(refused.exitCode, EXIT.TEMPFAIL);
    assert.equal(everythingSaid(refused).includes(lock.token), false, 'LockHeld never carries the token');
    const joinedRefusal = thrown(() => joinOrAcquire(root, { command: 'propose', env: withToken('0'.repeat(32)) }));
    assert.equal(everythingSaid(joinedRefusal).includes(lock.token), false);
  } finally {
    lock.release();
  }
  const second = acquireLock(root, { command: 'curate' });
  assert.notEqual(second.token, lock.token, 'each acquire draws its own token');
  second.release();
});

test('a lock written before the token existed still reads and still refuses; a malformed token makes the lock unreadable', () => {
  const root = makeRepo();
  const old = holderLikeMe({ pid: process.pid });
  writeLock(root, old);
  assert.equal(describeLock(root).pid, process.pid);
  assert.equal(describeLock(root).command, 'curate');
  const refused = thrown(() => acquireLock(root, { command: 'propose' }));
  assert.equal(refused.holder.pid, process.pid);
  for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), ' '.repeat(32), 42, ['a'.repeat(32)]]) {
    writeLock(root, { ...old, token: bad });
    assert.equal(describeLock(root).unreadable, true, `token ${JSON.stringify(bad)}`);
  }
  writeLock(root, { ...old, token: 'a'.repeat(32) });
  assert.equal(describeLock(root).pid, process.pid);
  unlinkSync(lockPath(root));
});

test('joinOrAcquire with the round\'s token joins its live lock: no second lock, the file untouched, and release never removes it', () => {
  const root = makeRepo();
  const round = acquireLock(root, { command: 'curate', now: NOW });
  try {
    const before = readFileSync(lockPath(root));
    const inode = statSync(lockPath(root)).ino;
    const joined = joinOrAcquire(root, { command: 'propose', env: withToken(round.token) });
    assert.equal(joined.joined, true);
    assert.equal(joined.token, round.token);
    assert.equal(joined.lockPath, lockPath(root));
    assert.equal(joined.holder.pid, process.pid);
    assert.equal(joined.holder.command, 'curate');
    assert.equal('token' in joined.holder, false);
    assert.equal(joined.release(), false);
    assert.deepEqual(readFileSync(lockPath(root)), before);
    assert.equal(statSync(lockPath(root)).ino, inode);
    assert.deepEqual(leftovers(root), []);
  } finally {
    assert.equal(round.release(), true, 'the round still owns and releases its lock');
  }
});

test('joinOrAcquire falls back to acquiring for a wrong, a malformed or an absent token: refused with 75 while the round holds the lock', () => {
  const root = makeRepo();
  const round = acquireLock(root, { command: 'curate', now: NOW });
  try {
    const wrong = round.token.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const cases = [wrong, round.token.toUpperCase(), round.token.slice(1), `${round.token}0`, ` ${round.token}`, `${round.token}\n`, ''];
    for (const token of cases) {
      const error = thrown(() => joinOrAcquire(root, { command: 'propose', env: withToken(token) }));
      assert.equal(error.exitCode, EXIT.TEMPFAIL, JSON.stringify(token));
      assert.equal(error.holder.command, 'curate');
    }
    const { BRAIN_KIT_ROUND_TOKEN, ...without } = withToken('');
    assert.equal(thrown(() => joinOrAcquire(root, { command: 'propose', env: without })).exitCode, EXIT.TEMPFAIL);
  } finally {
    round.release();
  }
});

test('joinOrAcquire never joins an old-format lock, whatever token it is given', () => {
  const root = makeRepo();
  writeLock(root, holderLikeMe({ pid: process.pid }));
  for (const token of ['0'.repeat(32), 'f'.repeat(32)]) {
    assert.equal(thrown(() => joinOrAcquire(root, { command: 'propose', env: withToken(token) })).exitCode, EXIT.TEMPFAIL);
  }
  unlinkSync(lockPath(root));
});

test('joinOrAcquire with the right token on a stale holder does not join: it reclaims, as any acquire does, and owns what it placed', () => {
  const root = makeRepo();
  const token = 'c'.repeat(32);
  writeLock(root, holderLikeMe({ token }));
  const got = joinOrAcquire(root, { command: 'propose', env: withToken(token) });
  assert.equal(got.joined, false);
  assert.notEqual(got.token, token);
  const onDisk = JSON.parse(readFileSync(lockPath(root), 'utf8'));
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.command, 'propose');
  assert.equal(onDisk.token, got.token);
  assert.equal(got.release(), true);
  assert.equal(describeLock(root), null);
});

test('joinOrAcquire with a token and no lock at all acquires, and releases what it placed', () => {
  const root = makeRepo();
  const got = joinOrAcquire(root, { command: 'propose', env: withToken('d'.repeat(32)) });
  assert.equal(got.joined, false);
  assert.match(got.token, TOKEN_RE);
  assert.notEqual(got.token, 'd'.repeat(32));
  assert.equal(describeLock(root).command, 'propose');
  assert.equal(got.release(), true);
  assert.equal(describeLock(root), null);
});

test('the hooks never print the token of a lock that carries one, live or stale', () => {
  const fx = makeHookVault();
  const outside = join(fx.base, 'elsewhere');
  // session-start, then a file of the session's own, then stop: so stop
  // blocks and names a stale lock, the one place it prints a holder while
  // blocking.
  let n = 0;
  const hooks = () => {
    const started = runHookProcess('session-start', { session_id: 's1', source: 'startup', cwd: fx.root }, { env: fx.env, cwd: outside });
    n += 1;
    writeFileSync(join(fx.root, `mine-${n}.md`), 'x\n');
    const stopped = runHookProcess('stop', { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: fx.root }, { env: fx.env, cwd: outside });
    return [started, stopped];
  };
  const lock = acquireLock(fx.root, { command: 'curate', env: fx.env });
  try {
    for (const r of hooks()) {
      assert.equal(r.status, 0, r.stderr);
      assert.match(`${r.stdout}${r.stderr}`, /curate/);
      assert.equal(`${r.stdout}${r.stderr}`.includes(lock.token), false);
    }
  } finally {
    lock.release();
  }
  const token = 'e'.repeat(32);
  writeFileSync(join(fx.root, '.git', GUARD_FILES.LOCK), `${JSON.stringify(holderLikeMe({ token }))}\n`);
  for (const r of hooks()) {
    assert.equal(r.status, 0, r.stderr);
    assert.match(`${r.stdout}${r.stderr}`, /no longer running/);
    assert.equal(`${r.stdout}${r.stderr}`.includes(token), false);
  }
});
