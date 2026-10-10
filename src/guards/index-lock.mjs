// An orphaned `index.lock` is moved aside before sync. Incident
// 06/10/2026: a 0-byte lock, a day old, left by a git command that died,
// killed every round at sync until a person removed it by hand.
//
//   moveOrphanIndexLock(root, { env, now, rename, minAgeMs })
//     -> { moved, to, ageMinutes, skipped, error }
//
// The vault's lock does not protect against a person's own git command, so
// the lock is moved only when it cannot belong to a live one: it is empty (a
// commit waiting in an editor has already written the new index into it), it
// is older than `minAgeMs` (10 minutes), the tree has no operation half done
// and no change of its own. The first condition that fails is `skipped`
// ('absent', 'not_empty', 'young', 'operation', 'dirty'). The lock is the one
// in the git directory of THIS working tree, never the common directory's. It
// is renamed to `index.lock.stale-<YYYYMMDDTHHMMSS>` (UTC) beside itself,
// never deleted; a rename the file system refuses (EBUSY or EPERM on Windows)
// is `skipped: 'rename_failed'` with the error's code, and never thrown.
//
// shortcut: the checks and the rename are not one atomic step, so a lock
// replaced by a live command in between is moved too; the window is
// microseconds and a rename loses nothing, revisit if a round ever reports it.
import { lstatSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyPaths, operationInProgress } from '../git.mjs';
import { locateRepository } from './location.mjs';

export const INDEX_LOCK_MIN_AGE_MS = 10 * 60 * 1000;

export function moveOrphanIndexLock(root, { env = process.env, now = new Date(), rename = renameSync, minAgeMs = INDEX_LOCK_MIN_AGE_MS } = {}) {
  const kept = (skipped, error = null) => ({ moved: false, to: null, ageMinutes: null, skipped, error });
  const lock = join(locateRepository(root, env).gitDir, 'index.lock');
  let stat;
  try {
    stat = lstatSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return kept('absent');
    throw error;
  }
  const ageMs = now.getTime() - stat.mtimeMs;
  if (stat.size !== 0) return kept('not_empty');
  if (ageMs <= minAgeMs) return kept('young');
  if (operationInProgress(root, { env }) !== null) return kept('operation');
  if (dirtyPaths(root, { env }).length > 0) return kept('dirty');
  const to = `${lock}.stale-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
  try {
    rename(lock, to);
  } catch (error) {
    return kept('rename_failed', error.code ?? error.message);
  }
  return { moved: true, to, ageMinutes: Math.floor(ageMs / 60000), skipped: null, error: null };
}
