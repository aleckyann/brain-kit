// The session snapshot: which paths were already there, in any state, when
// a session began, so that what the session goes on to propose can be told
// apart from work that was there before it and may belong to someone else.
//
// It exists because of docs/incidents.md, 16/09/2026: a scheduled round ran
// while another session was live editing a script, its unit files and its
// test, and a blanket `git add -A` would have swept that unfinished work
// into the round's pull request. The fingerprint of that situation is a
// modified file you did not touch. The snapshot records the paths at the
// start; `splitDirty` later answers, for every path dirty NOW, whether it
// was already there then (`before`) or appeared since (`since`).
//
// EVERY PATH IN ANY STATE. The snapshot records every path `git status`
// reports: modified, added, deleted, typechanged, unmerged, untracked, a
// submodule with changes, AND ignored. A path recorded in any state is
// `before`. Ignored paths are the reason: another session's draft in an
// ignored folder is invisible to a split until someone changes an ignore
// rule (.gitignore, .git/info/exclude, a global excludes file), and then it
// surfaced as `since`, the side a sweep takes, in a real run. Recorded at
// the start, it stays `before` whatever becomes of the rule. What a split
// reports as dirty NOW excludes ignored paths, since nothing can propose
// them.
//
// A path dirty at the start and touched again during the session stays in
// `before`: the snapshot cannot tell whose edit is whose inside one file,
// and a foreign file must never be reclassified as ours by being touched.
// What the snapshot cannot see at all is a foreign session that starts
// editing AFTER the snapshot was taken: its files land in `since`. That is
// why `propose --only`, naming paths, is the normal path, and `since` is a
// limit on what may be swept, never proof of ownership.
//
// PATHS ARE BYTES. A file name on Linux is a sequence of bytes, not text. A
// name that is not valid UTF-8, read as text, turns every bad byte into the
// same replacement character: two names differing only in that byte
// collapsed into one, the session's file landed in neither list, and the
// recorded string named no real file. So git's output is read as bytes,
// paths are Buffers in memory, hex in the stored JSON, and compared byte by
// byte. A caller hands them to git the same way (`--pathspec-from-file`
// with `--pathspec-file-nul` on standard input), since a process argument
// cannot carry every byte string.
//
// How git is asked: `--untracked-files=all` lists every untracked or
// ignored file on its own, also overriding a `status.showUntrackedFiles=no`
// in the vault's configuration (with directories collapsed into "dir/", a
// file added to an already-foreign directory would be filed with it);
// `--ignore-submodules=none` overrides any configuration hiding a changed
// submodule; `--no-renames` reports a rename as its two paths; `-z` means
// no path is ever quoted. Run with the caller's git environment removed and
// without taking the index's optional lock (src/guards/location.mjs).
//
// WHERE AND FOR WHOM. The snapshot is GUARD_FILES.SNAPSHOT in the git
// directory of the working tree it describes (`git rev-parse --git-dir`),
// not the common directory the lock uses: two linked worktrees, each with a
// session of its own, keep two snapshots. It also records the real path of
// that working tree, and `splitDirty` refuses a snapshot of another one. Outside a
// repository there is nothing to snapshot and nowhere to keep one: refused,
// exit 2. Like src/git.mjs, `root` must be the top level of its working
// tree; a vault nested inside a larger repository is refused, not guessed
// at.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { GUARD_FILES, GuardError, git, gitEnvFor, gitFailed, locateRepository } from './location.mjs';

const STATUS_ARGS = Object.freeze([
  'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none', '--no-renames',
]);
const IGNORED = '!!';
const FORMAT = 1;
const HEX_PATH = /^(?:[0-9a-f]{2})+$/;

function statusUnreadable(root, detail) {
  return new GuardError({
    code: 'GUARD_GIT_FAILED',
    exitCode: EXIT.FAILURE,
    messageKey: 'guard.git_failed', params: { dir: root, detail },
    message: `git status printed something this reader does not understand in ${root}: ${detail}`,
  });
}

// `git status --porcelain=v1 -z` prints one "XY PATH" record per path,
// each ended by a NUL. A record of any other shape is refused rather than
// skipped: a path the parser drops is a path that silently becomes neither
// `before` nor `since`.
function parsePorcelain(root, stdout) {
  const entries = [];
  let start = 0;
  while (start < stdout.length) {
    const end = stdout.indexOf(0, start);
    if (end === -1) throw statusUnreadable(root, 'a record with no terminating NUL');
    const record = stdout.subarray(start, end);
    start = end + 1;
    if (record.length < 4 || record[2] !== 0x20) {
      throw statusUnreadable(root, `a record of an unknown shape (hex ${record.toString('hex')})`);
    }
    entries.push({ state: record.subarray(0, 2).toString('latin1'), path: Buffer.from(record.subarray(3)) });
  }
  return entries;
}

function readStatus(root, env) {
  const result = git(root, STATUS_ARGS, gitEnvFor(env), { encoding: 'buffer' });
  if (result.status !== 0) throw gitFailed(root, STATUS_ARGS, result);
  return parsePorcelain(root, result.stdout);
}

// Distinct paths, in byte order.
function distinct(paths) {
  const byKey = new Map();
  for (const path of paths) byKey.set(path.toString('hex'), path);
  return [...byKey.values()].sort(Buffer.compare);
}

// The working tree's top level, which `root` must be.
function topLevelOf(root, env) {
  const { gitDir, topLevel } = locateRepository(root, env);
  if (realpathSync(root) !== topLevel) {
    throw new GuardError({
      code: 'SNAPSHOT_NOT_TOPLEVEL',
      exitCode: EXIT.USAGE,
      messageKey: 'snapshot.not_toplevel', params: { dir: root, top: topLevel },
      message: `${root} is inside the repository at ${topLevel}, not the top level of its own`,
    });
  }
  return { gitDir, topLevel };
}

function snapshotFile(gitDir) {
  return join(gitDir, GUARD_FILES.SNAPSHOT);
}

// Record every path git reports in `root` now, in any state, and return
// the snapshot: `{ at, root, paths }`, `paths` being Buffers in byte order.
export function takeSnapshot(root, { env = process.env, now = new Date() } = {}) {
  const { gitDir, topLevel } = topLevelOf(root, env);
  const paths = distinct(readStatus(root, env).map((entry) => entry.path));
  const snapshot = { at: now.toISOString(), root: topLevel, paths };
  const target = snapshotFile(gitDir);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const stored = { format: FORMAT, at: snapshot.at, root: snapshot.root, paths: paths.map((path) => path.toString('hex')) };
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, target);
  return snapshot;
}

function unreadableSnapshot(file) {
  return new GuardError({
    code: 'SNAPSHOT_UNREADABLE',
    exitCode: EXIT.FAILURE,
    messageKey: 'snapshot.unreadable', params: { file },
    message: `${file} is not a snapshot this version can read`,
  });
}

// The recorded snapshot of the vault at `root`, or `null` when none was
// ever taken. Only a missing file is "none": a file that is there but
// cannot be read, or is not a snapshot, raises. Returned as `null`, it
// would read as "no snapshot", and a caller would take a fresh one, filing
// every foreign path as already there.
export function readSnapshot(root, { env = process.env } = {}) {
  const { gitDir } = locateRepository(root, env);
  const file = snapshotFile(gitDir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    throw unreadableSnapshot(file);
  }
  const valid = stored !== null
    && stored.format === FORMAT
    && typeof stored.at === 'string'
    && typeof stored.root === 'string'
    && Array.isArray(stored.paths)
    && stored.paths.every((hex) => typeof hex === 'string' && HEX_PATH.test(hex));
  if (!valid) throw unreadableSnapshot(file);
  return { at: stored.at, root: stored.root, paths: stored.paths.map((hex) => Buffer.from(hex, 'hex')) };
}

function isSnapshot(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.at === 'string'
    && typeof value.root === 'string'
    && Array.isArray(value.paths)
    && value.paths.every((path) => Buffer.isBuffer(path) && path.length > 0);
}

// Every path dirty in `root` now (any state but ignored), split by whether
// `snapshot` recorded it in any state (`before`) or not (`since`). Both
// lists are Buffers in byte order.
export function splitDirty(root, snapshot, { env = process.env } = {}) {
  if (!isSnapshot(snapshot)) {
    const error = new TypeError('splitDirty needs a snapshot from takeSnapshot or readSnapshot');
    error.code = 'SNAPSHOT_INVALID';
    throw error;
  }
  const { topLevel } = topLevelOf(root, env);
  if (snapshot.root !== topLevel) {
    throw new GuardError({
      code: 'SNAPSHOT_OTHER_ROOT',
      exitCode: EXIT.FAILURE,
      messageKey: 'snapshot.other_root', params: { dir: topLevel, snapshotRoot: snapshot.root },
      message: `the snapshot was taken of ${snapshot.root}, not of ${topLevel}`,
    });
  }
  const known = new Set(snapshot.paths.map((path) => path.toString('hex')));
  const dirty = distinct(readStatus(root, env).filter((entry) => entry.state !== IGNORED).map((entry) => entry.path));
  return {
    before: dirty.filter((path) => known.has(path.toString('hex'))),
    since: dirty.filter((path) => !known.has(path.toString('hex'))),
  };
}
