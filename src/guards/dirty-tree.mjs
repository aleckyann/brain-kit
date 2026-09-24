// A dirty working tree postpones the round, loudly. docs/incidents.md,
// 13/09/2026: four rounds in a row died on this guard with exit 0, each log
// 95 bytes long, and nobody was told. The rule: a guard that only postpones
// names every file (with its modification time, so a person can tell a
// draft from yesterday from a leftover of last week) and the caller exits
// 75, TEMPFAIL, never 0.
//
//   checkDirtyTree(root, snapshot?, { env }) -> { ok, files: [{ path, mtime }] }
//
// Dirty is anything `git status` reports that git does not ignore
// (src/git.mjs, dirtyPaths: modified, staged, deleted, untracked). `snapshot`
// is an optional list of paths the caller already read from `git status`,
// reported as they are instead of asking git again; without it git is asked.
// `mtime` is an ISO instant, or null for a path that is not on disk (a
// deletion).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyPaths } from '../git.mjs';

function mtimeOf(root, path) {
  try {
    return lstatSync(join(root, path)).mtime.toISOString();
  } catch {
    return null;
  }
}

export function checkDirtyTree(root, snapshot = null, { env = process.env } = {}) {
  const paths = Array.isArray(snapshot) ? [...new Set(snapshot)].sort() : dirtyPaths(root, { env });
  const files = paths.map((path) => ({ path, mtime: mtimeOf(root, path) }));
  return { ok: files.length === 0, files };
}
