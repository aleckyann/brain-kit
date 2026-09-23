// The exclusive lock every writing command takes before it touches a vault.
//
// It exists because of docs/incidents.md, 29/07/2026: on the first
// production run there was no lock, and two curation rounds ran over the
// same working tree at once. The output happened to come out coherent;
// nothing guaranteed it would.
//
// WHERE. The lock is GUARD_FILES.LOCK in the vault's git common directory
// (src/guards/location.mjs says why not the state directory): one lock per
// repository, whatever environment, symbolic link or linked worktree a
// command reaches it by. Outside a repository, acquiring refuses (exit 2).
//
// THE FILE. It holds the holder's pid, host name, command and start time,
// and, where the platform has them, the machine id, the boot id and the
// pid namespace, as one JSON line. It is written in full to a private
// temporary file first (created exclusively, `wx`), and only then linked
// into place under the lock's name. `link` fails with EEXIST when the name
// exists, exactly as an exclusive open would, so creation is still
// exclusive; the difference is that nobody can ever read the lock while it
// is half written. An exclusive open followed by a write leaves a window
// where the lock exists and is empty, and a process that dies inside that
// window leaves a lock no one can prove is dead, forever. A file system
// without hard links (some network and removable-media file systems) is
// refused with a message naming the directory, never with a raw EPERM.
//
// A SECOND ACQUIRE FAILS IMMEDIATELY. It never waits: it throws LockHeld,
// carrying the holder it found, and the command turns that into exit 75
// (postponed) naming the holder.
//
// STALE MEANS PROVABLY DEAD. The host name must be exactly this machine's,
// always. Then, where the platform has a machine id (Linux: /etc/machine-id),
// a lock is stale only when the machine id is this machine's AND EITHER the
// boot id differs (the machine rebooted since, so every process from before
// is dead: this is what reclaims a lock left by a power loss) OR the boot id
// and the pid namespace are both this process's and signalling the pid with
// signal 0 raises ESRCH. The pid namespace is what the first version lacked:
// a process in a container, or any other pid namespace, on the same host,
// sees ESRCH for a live holder whose pid it simply cannot see, and took a
// live lock in a real run. Where the platform has no machine id on either
// side, the rule falls back to the exact host name plus the pid. Anything
// else is a live holder: EPERM means the process exists under another user;
// a lock from another machine id, or another boot id or namespace that
// cannot be compared, or one side knowing an identity the other does not,
// is never reclaimed automatically; a lock that cannot be read names no one
// whose death could be proved. Every doubt resolves to "held": a lock that
// is wrongly kept costs a postponed run, a lock that is wrongly reclaimed
// puts two writers in one tree, which is the incident itself.
//
// A STALE LOCK IS REPLACED BY RENAME, NEVER BY DELETE-THEN-CREATE. Deleting
// the dead lock and creating a new one opens a gap in which a second
// reclaimer, which judged the same lock stale a moment earlier, deletes the
// NEW, live lock and creates its own: two winners. Renaming a prepared file
// over the lock keeps the lock's name occupied at every instant, so no
// plain acquirer can slip in; but rename alone is not a decision either,
// because two reclaimers can both rename, and the second then overwrites
// the first one's live lock. So a reclaim is decided by one more exclusive
// step: the reclaim marker (GUARD_FILES.LOCK_RECLAIM), created the same way
// as the lock, holding the reclaimer's own identity. Only the process that
// created the marker may rename over the lock, and only after checking,
// while it holds the marker, that the lock is still the very file it judged
// stale (same bytes, same inode). A reclaimer that finds the marker taken
// has lost, and says who holds it; a reclaimer that takes the marker after
// another reclaim already finished finds a lock that is no longer the one
// it judged, and loses to the live holder. Exactly one winner.
//
// A known limit, stated rather than hidden: a reclaimer that dies between
// taking the marker and removing it leaves the marker behind, and every
// later reclaim of that lock then refuses, saying a reclaim died and naming
// the marker for a person to remove (LockHeld's `blockedBy`). Reclaiming the
// marker itself automatically would need the same guarantee one level
// down; the window is a handful of system calls long, and a refusal is the
// safe direction.
//
// LEFTOVERS. A process killed while holding a private temporary file leaves
// it behind. Each acquire removes the ones whose creator is provably dead
// (the holder written in them, judged by the same rule as a lock), and
// those that name no one (killed before their first byte) or belong to a
// snapshot, once they are an hour old: no live write takes that long.
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { GUARD_FILES, GuardError, locateRepository } from './location.mjs';

// How many times one acquire goes round when the lock changes under it
// (released between our failed link and our read of it, or replaced by
// another reclaimer while we were judging it). Each lap is a fresh look at
// the lock; a lock that keeps changing for this long is reported as held.
const MAX_ATTEMPTS = 8;

const ORPHAN_AGE_MS = 60 * 60 * 1000;
const LOCK_PRIVATE = /^brain-kit\.lock(?:\.reclaim)?\.\d+\.[0-9a-f]{12}\.tmp$/;
const SNAPSHOT_PRIVATE = /^brain-kit-snapshot\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

// The errors `link` raises on a file system that has no hard links.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

function readIdentifier(path) {
  try {
    const value = readFileSync(path, 'utf8').trim().toLowerCase();
    return /^[0-9a-f][0-9a-f-]{7,}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readPidNamespace() {
  try {
    const value = readlinkSync('/proc/self/ns/pid');
    return /^pid:\[\d+\]$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

let cachedIdentity = null;

// Who this process is, as far as the platform can say: the host name, and
// the machine id, boot id and pid namespace where they exist (null where
// they do not). A process's pid namespace never changes, and neither does
// its boot, so it is read once.
export function currentIdentity() {
  if (cachedIdentity === null) {
    cachedIdentity = Object.freeze({
      host: hostname(),
      machineId: readIdentifier('/etc/machine-id') ?? readIdentifier('/var/lib/dbus/machine-id'),
      bootId: readIdentifier('/proc/sys/kernel/random/boot_id'),
      pidNamespace: readPidNamespace(),
    });
  }
  return cachedIdentity;
}

function describeHolder(holder, lockPath) {
  if (holder.pid === null) {
    return {
      messageKey: 'lock.held_unreadable', params: { lock: lockPath },
      message: `the vault lock ${lockPath} cannot be read, so its holder cannot be proved gone`,
    };
  }
  return {
    messageKey: 'lock.held', params: { pid: holder.pid, host: holder.host, command: holder.command, startedAt: holder.startedAt },
    message: `the vault lock ${lockPath} is held by pid ${holder.pid} on ${holder.host} (${holder.command}, since ${holder.startedAt})`,
  };
}

export class LockHeld extends GuardError {
  constructor(holder, lockPath) {
    super({ code: 'LOCK_HELD', exitCode: EXIT.TEMPFAIL, ...describeHolder(holder, lockPath) });
    this.name = 'LockHeld';
    this.holder = holder;
    this.lockPath = lockPath;
    this.blockedBy = null;
  }
}

// A reclaim died and left its marker: no one holds the lock, and no run
// can replace it until a person removes the marker.
function reclaimDied(lockPath, markerPath) {
  const error = new LockHeld({ ...UNREADABLE }, lockPath);
  Object.assign(error, {
    code: 'LOCK_RECLAIM_DIED',
    holder: null,
    blockedBy: markerPath,
    messageKey: 'lock.reclaim_died', params: { marker: markerPath },
    message: `a run replacing the dead lock ${lockPath} died midway and left ${markerPath}; remove that file`,
  });
  return error;
}

function noHardLinks(dir) {
  return new GuardError({
    code: 'LOCK_NO_HARD_LINKS',
    exitCode: EXIT.FAILURE,
    messageKey: 'lock.no_hard_links', params: { dir },
    message: `the file system holding ${dir} does not support hard links, which the vault lock needs`,
  });
}

const UNREADABLE = Object.freeze({
  pid: null, host: null, command: null, startedAt: null, machineId: null, bootId: null, pidNamespace: null, unreadable: true,
});

// An identity field is optional: absent means the writer's platform did
// not have it (null); present, it must be a string or null.
function optionalIdentity(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  return typeof value === 'string' && value !== '' ? { ok: true, value } : { ok: false };
}

function parseHolder(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  // Null is the one JSON value that cannot be destructured; any other
  // non-object (a number, a string, an array) destructures to undefined
  // fields and is refused by the pid check below.
  if (value === null) return UNREADABLE;
  const { pid, host, command, startedAt } = value;
  if (!Number.isInteger(pid) || pid <= 0) return UNREADABLE;
  if (typeof host !== 'string' || host === '') return UNREADABLE;
  if (typeof command !== 'string' || typeof startedAt !== 'string') return UNREADABLE;
  const machineId = optionalIdentity(value.machineId);
  const bootId = optionalIdentity(value.bootId);
  const pidNamespace = optionalIdentity(value.pidNamespace);
  if (!machineId.ok || !bootId.ok || !pidNamespace.ok) return UNREADABLE;
  return { pid, host, command, startedAt, machineId: machineId.value, bootId: bootId.value, pidNamespace: pidNamespace.value };
}

// What is at `path` right now: its raw text, its inode, its modification
// time and the holder it names; `null` when nothing is there. Read through
// one descriptor, so the inode and the bytes always belong to the same file
// even while another process renames a new lock into place. Anything that
// is there but is not a regular file is an unreadable lock, never "no
// lock": a directory, a symlink (never followed, O_NOFOLLOW) or a FIFO
// (opened without blocking, O_NONBLOCK, so a planted one cannot hang every
// run) still occupies it.
function readLockFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') return { raw: null, ino: null, mtimeMs: 0, holder: UNREADABLE };
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { raw: null, ino: info.ino, mtimeMs: info.mtimeMs, holder: UNREADABLE };
    const raw = readFileSync(fd, 'utf8');
    return { raw, ino: info.ino, mtimeMs: info.mtimeMs, holder: parseHolder(raw) };
  } finally {
    closeSync(fd);
  }
}

function pidIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// True only when the holder is provably dead; see the header for the rule
// and for why every other answer is "alive".
function isStale(holder, me) {
  if (holder.pid === null) return false;
  if (holder.host !== me.host) return false;
  if (holder.machineId === null || me.machineId === null) {
    return holder.machineId === me.machineId && pidIsGone(holder.pid);
  }
  if (holder.machineId !== me.machineId) return false;
  if (holder.bootId !== me.bootId) return holder.bootId !== null && me.bootId !== null;
  if (holder.pidNamespace !== me.pidNamespace) return false;
  return pidIsGone(holder.pid);
}

// A private file holding `text` in full, created exclusively under a name
// no other process uses, ready to be linked or renamed into place.
function writePrivateFile(dir, baseName, text) {
  const path = join(dir, `${baseName}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function sweepLeftovers(dir, me) {
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const isLock = LOCK_PRIVATE.test(name);
    if (!isLock && !SNAPSHOT_PRIVATE.test(name)) continue;
    const path = join(dir, name);
    const seen = readLockFile(path);
    if (seen === null) continue;
    const old = now - seen.mtimeMs > ORPHAN_AGE_MS;
    const orphan = isLock && seen.holder.pid !== null ? isStale(seen.holder, me) : old;
    if (orphan) removeQuietly(path);
  }
}

// Link `text` into place at `target` if and only if nothing is there. The
// inode of what was placed, or `null` when the name was already taken.
function createExclusively(dir, target, baseName, text, link) {
  const tmp = writePrivateFile(dir, baseName, text);
  try {
    link(tmp, target);
    return lstatSync(tmp).ino;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    if (NO_HARD_LINKS.has(error.code)) throw noHardLinks(dir);
    throw error;
  } finally {
    removeQuietly(tmp);
  }
}

const RETRY = Symbol('retry');

// True when `current` is still the very lock `seen` was: same bytes, same
// inode. Anything else (gone, rewritten, replaced) is a lock that changed.
function isUnchanged(current, seen) {
  return current !== null && current.raw === seen.raw && current.ino === seen.ino;
}

// Replace the stale lock `seen` with ours. Returns the new lock's inode on
// a win, RETRY when the lock changed under us, and throws LockHeld when
// another reclaimer holds the marker.
//
// A marker found taken names its holder only while the lock is still the
// stale file this process judged. Once the lock has changed, the marker's
// holder is a reclaimer that judged the same dead lock, arrived after the
// winner, and is itself about to find the lock changed and lose; naming it
// would name a process that never holds the lock. So a changed lock sends
// this process round again, to name whoever really holds it.
function reclaim(ctx, seen) {
  const { dir, lockPath, markerPath, text, onStage, me, link } = ctx;
  if (createExclusively(dir, markerPath, GUARD_FILES.LOCK_RECLAIM, text, link) === null) {
    onStage('contended');
    const marker = readLockFile(markerPath);
    if (marker === null) return RETRY;
    if (!isUnchanged(readLockFile(lockPath), seen)) return RETRY;
    if (isStale(marker.holder, me)) throw reclaimDied(lockPath, markerPath);
    throw new LockHeld(marker.holder, lockPath);
  }
  try {
    if (!isUnchanged(readLockFile(lockPath), seen)) return RETRY;
    onStage('claimed');
    const tmp = writePrivateFile(dir, GUARD_FILES.LOCK, text);
    const ino = lstatSync(tmp).ino;
    renameSync(tmp, lockPath);
    return ino;
  } finally {
    removeQuietly(markerPath);
  }
}

// `root` is any directory inside the vault's working tree. `deps` is a
// test seam and nothing else, after src/exec.mjs's precedent:
//   onStage(name)  called at the four points where another process can
//                  change the lock under this one: the lock's name was
//                  found taken ('occupied'), the lock was judged stale
//                  ('stale'), the reclaim marker was found taken
//                  ('contended'), and this process holds the marker and has
//                  confirmed the lock is unchanged ('claimed'). The race
//                  tests use it to force the interleavings a scheduler
//                  produces only sometimes; it can only delay this process,
//                  never change a decision.
//   identity       stands in for currentIdentity(), so a test can be another
//                  platform, another boot or another namespace.
//   link           stands in for fs.linkSync, so a test can be a file system
//                  without hard links.
// Production never passes any of them.
export function acquireLock(root, { command, now = new Date(), env = process.env } = {}, deps = {}) {
  const { onStage = () => {}, identity = currentIdentity(), link = linkSync } = deps;
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('acquireLock needs the name of the command taking the lock');
  }
  const { commonDir } = locateRepository(root, env);
  const lockPath = join(commonDir, GUARD_FILES.LOCK);
  const holder = {
    pid: process.pid,
    host: identity.host,
    command,
    startedAt: now.toISOString(),
    machineId: identity.machineId,
    bootId: identity.bootId,
    pidNamespace: identity.pidNamespace,
  };
  const text = `${JSON.stringify(holder)}\n`;
  const ctx = { dir: commonDir, lockPath, markerPath: join(commonDir, GUARD_FILES.LOCK_RECLAIM), text, onStage, me: identity, link };
  sweepLeftovers(commonDir, identity);
  let lastSeen = UNREADABLE;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let ino = createExclusively(commonDir, lockPath, GUARD_FILES.LOCK, text, link);
    if (ino === null) {
      onStage('occupied');
      const seen = readLockFile(lockPath);
      if (seen === null) continue;
      lastSeen = seen.holder;
      if (!isStale(seen.holder, identity)) throw new LockHeld(seen.holder, lockPath);
      onStage('stale');
      ino = reclaim(ctx, seen);
      if (ino === RETRY) continue;
    }
    return { holder, lockPath, release: releaser(lockPath, text, ino) };
  }
  throw new LockHeld(lastSeen, lockPath);
}

// Release removes the lock only while it is still the one this acquire
// placed (same bytes, same inode): a release must never delete a lock that
// has since become someone else's. Calling it twice is harmless. True when
// it removed the lock.
function releaser(lockPath, text, ino) {
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    if (!isUnchanged(readLockFile(lockPath), { raw: text, ino })) return false;
    unlinkSync(lockPath);
    return true;
  };
}

// The holder of the vault's lock, or `null` when there is no lock. A lock
// that exists but cannot be read is reported as a holder with every field
// null and `unreadable: true`, never as `null`: "no lock" is an answer a
// command acts on, and it must not be given about a file that is there.
export function describeLock(root, { env = process.env } = {}) {
  const { commonDir } = locateRepository(root, env);
  const seen = readLockFile(join(commonDir, GUARD_FILES.LOCK));
  return seen === null ? null : seen.holder;
}
