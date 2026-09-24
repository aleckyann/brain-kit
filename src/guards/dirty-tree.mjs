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
// (src/git.mjs, dirtyPathBytes: modified, staged, deleted, untracked). Each
// path is stat'ed by the bytes git printed, so a name that is not valid
// UTF-8 still finds its file, and shown decoded. `snapshot` is an optional
// list of paths the caller already read from `git status`, reported as they
// are instead of asking git again; without it git is asked. `mtime` is an
// ISO instant, or null for a path that is not on disk (a deletion).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyPathBytes } from '../git.mjs';
import { decodeBytes } from '../io.mjs';

function mtimeOf(fullPath) {
  try {
    return lstatSync(fullPath).mtime.toISOString();
  } catch {
    return null;
  }
}

export function checkDirtyTree(root, snapshot = null, { env = process.env } = {}) {
  if (Array.isArray(snapshot)) {
    const files = [...new Set(snapshot)].sort().map((path) => ({ path, mtime: mtimeOf(join(root, path)) }));
    return { ok: files.length === 0, files };
  }
  const prefix = Buffer.from(root.endsWith('/') ? root : `${root}/`);
  const files = dirtyPathBytes(root, { env }).map((bytes) => ({
    path: decodeBytes(bytes),
    mtime: mtimeOf(Buffer.concat([prefix, bytes])),
  }));
  return { ok: files.length === 0, files };
}
