// The exclusive lock every writing command takes before it touches a vault.
//
// It exists because of docs/incidents.md, 29/07/2026: on the first
// production run there was no lock, and two curation rounds ran over the
// same working tree at once. The output happened to come out coherent;
// nothing guaranteed it would.
//
// THE FILE. The lock is a file in the vault's state directory holding the
// holder's pid, host name, command and start time, as one JSON line. It is
// written in full to a private temporary file first (created exclusively,
// `wx`), and only then linked into place under the lock's name. `link`
// fails with EEXIST when the name exists, exactly as an exclusive open
// would, so creation is still exclusive; the difference is that nobody can
// ever read the lock while it is half written. An exclusive open followed
// by a write leaves a window where the lock exists and is empty, and a
// process that dies inside that window leaves a lock no one can prove is
// dead, forever.
//
// A SECOND ACQUIRE FAILS IMMEDIATELY. It never waits: it throws LockHeld,
// carrying the holder it found, and the command turns that into exit 75
// (postponed) naming the holder.
//
// STALE MEANS PROVABLY DEAD, ON THIS MACHINE. A lock is stale only when its
// host is this machine's host name AND signalling its pid with signal 0
// raises ESRCH (no such process). Anything else is a live holder: EPERM
// means the process exists under another user; a pid that is not a
// positive integer cannot be signalled safely at all (0 and negative
// numbers address process GROUPS); a lock written on another host names a
// pid that means nothing here, so it is never reclaimed automatically; and
// a lock that cannot be read or parsed names no one whose death could be
// proved. Every doubt resolves to "held": a lock that is wrongly kept costs
// a postponed run, a lock that is wrongly reclaimed puts two writers in one
// tree, which is the incident itself.
//
// A STALE LOCK IS REPLACED BY RENAME, NEVER BY DELETE-THEN-CREATE. Deleting
// the dead lock and creating a new one opens a gap in which a second
// reclaimer, which judged the same lock stale a moment earlier, deletes the
// NEW, live lock and creates its own: two winners. Renaming a prepared file
// over the lock keeps the lock's name occupied at every instant, so no
// plain acquirer can slip in; but rename alone is not a decision either,
// because two reclaimers can both rename, and the second then overwrites
// the first one's live lock. So a reclaim is decided by one more exclusive
// step: the reclaim marker (STATE_FILES.LOCK_RECLAIM), created the same way
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
// later reclaim of that lock then refuses, naming the marker (LockHeld's
// `blockedBy`), until a person removes it. Reclaiming the marker itself
// automatically would need the same guarantee one level down; the window is
// a handful of system calls long, and a refusal is the safe direction.
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { ensureStateDir, STATE_FILES } from '../state.mjs';

// How many times one acquire goes round when the lock changes under it
// (released between our failed link and our read of it, or replaced by
// another reclaimer while we were judging it). Each lap is a fresh look at
// the lock; a lock that keeps changing for this long is reported as held.
const MAX_ATTEMPTS = 8;

export class LockHeld extends Error {
  constructor(holder, lockPath, { blockedBy = null } = {}) {
    const who = holder.pid === null
      ? 'an unreadable lock'
      : `pid ${holder.pid} on ${holder.host} (${holder.command}, since ${holder.startedAt})`;
    super(`the vault lock ${lockPath} is held by ${who}`);
    this.name = 'LockHeld';
    this.code = 'LOCK_HELD';
    this.exitCode = EXIT.TEMPFAIL;
    this.holder = holder;
    this.lockPath = lockPath;
    this.blockedBy = blockedBy;
  }
}

function lockPathOf(stateDir) {
  return join(stateDir, STATE_FILES.LOCK);
}

function markerPathOf(stateDir) {
  return join(stateDir, STATE_FILES.LOCK_RECLAIM);
}

const UNREADABLE = Object.freeze({ pid: null, host: null, command: null, startedAt: null, unreadable: true });

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
  return { pid, host, command, startedAt };
}

// What is at `path` right now: its raw text, its inode, and the holder it
// names; `null` when nothing is there. Read through one descriptor, so the
// inode and the bytes always belong to the same file even while another
// process renames a new lock into place. Anything that is there but is not
// a regular file is an unreadable lock, never "no lock": a directory, a
// symlink (never followed, O_NOFOLLOW) or a FIFO (opened without blocking,
// O_NONBLOCK, so a planted one cannot hang every run) still occupies it.
function readLockFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') return { raw: null, ino: null, holder: UNREADABLE };
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { raw: null, ino: info.ino, holder: UNREADABLE };
    const raw = readFileSync(fd, 'utf8');
    return { raw, ino: info.ino, holder: parseHolder(raw) };
  } finally {
    closeSync(fd);
  }
}

// True only when the holder is provably dead on this machine; see the
// header for why every other answer is "alive".
function isStale(holder) {
  if (holder.pid === null) return false;
  if (holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// A private file holding `text` in full, created exclusively under a name
// no other process uses, ready to be linked or renamed into place.
function writePrivateFile(stateDir, baseName, text) {
  const path = join(stateDir, `${baseName}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
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

// Link `text` into place at `target` if and only if nothing is there. The
// inode of what was placed, or `null` when the name was already taken.
function createExclusively(stateDir, target, baseName, text) {
  const tmp = writePrivateFile(stateDir, baseName, text);
  try {
    linkSync(tmp, target);
    return lstatSync(tmp).ino;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
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
function reclaim(stateDir, seen, text, onStage) {
  const lockPath = lockPathOf(stateDir);
  const markerPath = markerPathOf(stateDir);
  if (createExclusively(stateDir, markerPath, STATE_FILES.LOCK_RECLAIM, text) === null) {
    onStage('contended');
    const marker = readLockFile(markerPath);
    if (marker === null) return RETRY;
    if (!isUnchanged(readLockFile(lockPath), seen)) return RETRY;
    throw new LockHeld(marker.holder, lockPath, { blockedBy: isStale(marker.holder) ? markerPath : null });
  }
  try {
    if (!isUnchanged(readLockFile(lockPath), seen)) return RETRY;
    onStage('claimed');
    const tmp = writePrivateFile(stateDir, STATE_FILES.LOCK, text);
    const ino = lstatSync(tmp).ino;
    renameSync(tmp, lockPath);
    return ino;
  } finally {
    removeQuietly(markerPath);
  }
}

// `deps.onStage(name)` is a test seam and nothing else. It is called at the
// four points where another process can change the lock under this one:
// the lock's name was found taken ('occupied'), the lock was judged stale
// ('stale'), the reclaim marker was found taken ('contended'), and this
// process holds the marker and has confirmed the lock is unchanged
// ('claimed'). The race tests use it to force the interleavings a scheduler
// produces only sometimes, so a deleted clause fails every run instead of
// one run in a hundred. Production never passes it, and it can only delay
// this process, never change a decision.
export function acquireLock(stateDir, { command, now = new Date() } = {}, { onStage = () => {} } = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('acquireLock needs the name of the command taking the lock');
  }
  ensureStateDir(stateDir);
  const lockPath = lockPathOf(stateDir);
  const holder = { pid: process.pid, host: hostname(), command, startedAt: now.toISOString() };
  const text = `${JSON.stringify(holder)}\n`;
  let lastSeen = UNREADABLE;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let ino = createExclusively(stateDir, lockPath, STATE_FILES.LOCK, text);
    if (ino === null) {
      onStage('occupied');
      const seen = readLockFile(lockPath);
      if (seen === null) continue;
      lastSeen = seen.holder;
      if (!isStale(seen.holder)) throw new LockHeld(seen.holder, lockPath);
      onStage('stale');
      ino = reclaim(stateDir, seen, text, onStage);
      if (ino === RETRY) continue;
    }
    return { holder, release: releaser(lockPath, text, ino) };
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
export function describeLock(stateDir) {
  const seen = readLockFile(lockPathOf(stateDir));
  return seen === null ? null : seen.holder;
}
