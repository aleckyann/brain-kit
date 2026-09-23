// The session snapshot: which paths were already dirty when a session
// began, so that what the session goes on to propose can be told apart from
// work that was there before it and may belong to someone else.
//
// It exists because of docs/incidents.md, 16/09/2026: a scheduled round ran
// while another session was live editing a script, its unit files and its
// test, and a blanket `git add -A` would have swept that unfinished work
// into the round's pull request. The fingerprint of that situation is a
// modified file you did not touch. The snapshot records the dirty set at
// the start; `splitDirty` later answers, for every path dirty NOW, whether
// it was already dirty then (`before`) or became dirty since (`since`).
//
// A path dirty at the start and touched again during the session stays in
// `before`: the snapshot cannot tell whose edit is whose inside one file,
// and a foreign file must never be reclassified as ours by being touched.
// What the snapshot cannot see at all is a foreign session that starts
// editing AFTER the snapshot was taken: its files land in `since`. That is
// why `propose --only`, naming paths, is the normal path, and `since` is a
// limit on what may be swept, never proof of ownership.
//
// "Dirty" is whatever `git status` reports, staged or not: modified,
// added, deleted, typechanged, unmerged and untracked paths, every
// untracked FILE listed on its own (`--untracked-files=all`, which also
// overrides a `status.showUntrackedFiles=no` in the vault's configuration:
// with untracked directories collapsed into "dir/", a file added to an
// already-foreign new directory would be filed with it), renames split
// into their two paths (`--no-renames`), ignored files excluded. Read with
// `-z`, so no path is ever quoted or escaped, and with the caller's git
// environment removed (src/git-env.mjs), so the answer is about the vault
// and not whatever repository a GIT_DIR in the environment names.
// `GIT_OPTIONAL_LOCKS=0` keeps `git status` from writing the index while
// another session may be using it.
//
// Every answer is about one vault. The snapshot records the vault's real
// path, and `splitDirty` refuses a snapshot taken of another directory
// (a state directory pinned with BRAIN_KIT_STATE_DIR is shared by every
// vault run under it) or taken when the vault was not yet, or no longer
// is, a repository. A snapshot that answers about something other than
// what is about to be acted on is worse than none.
//
// Like src/git.mjs, `root` must be the top level of its working tree; a
// vault nested inside a larger repository is refused, not guessed at.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../exec.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';
import { ensureStateDir, STATE_FILES } from '../state.mjs';

const GIT_OPTS = { maxBuffer: 64 * 1024 * 1024 };

function snapshotError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gitEnvFor(env) {
  return { ...withoutLocalGitVars(env, localGitVarNames(env)), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

// No call here passes a path to git, so no pathspec needs escaping.
function git(root, args, env) {
  return run('git', args, { cwd: root, env, ...GIT_OPTS });
}

function gitOrThrow(root, args, env) {
  const result = git(root, args, env);
  if (result.status !== 0) {
    throw snapshotError('SNAPSHOT_GIT_FAILED', `git ${args.join(' ')} exited with status ${result.status} in ${root}: ${result.stderr.trim()}`);
  }
  return result;
}

// `git status --porcelain=v1 -z` prints one "XY PATH" record per path,
// each ended by a NUL. A record of any other shape is refused rather than
// skipped: a path the parser drops is a dirty path that silently becomes
// neither `before` nor `since`.
function parsePorcelain(stdout) {
  const paths = new Set();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw snapshotError('SNAPSHOT_GIT_FAILED', `git status printed a record this reader does not understand: ${JSON.stringify(record)}`);
    }
    paths.add(record.slice(3));
  }
  return [...paths].sort();
}

// What is dirty in `root` now. "Not a repository" is an answer only when
// git says exactly that; git missing, a repository git refuses to read
// (safe.directory), or any other failure raises, because read as "not a
// repository" it would become "nothing is dirty".
function readDirty(root, env) {
  const gitEnv = gitEnvFor(env);
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], gitEnv);
  if (inside.status !== 0) {
    if (/not a git repository/i.test(inside.stderr)) return { repository: false, dirty: [] };
    throw snapshotError('SNAPSHOT_GIT_FAILED', `git could not tell whether ${root} is a repository: ${inside.stderr.trim()}`);
  }
  if (inside.stdout.trim() !== 'true') {
    throw snapshotError('SNAPSHOT_NOT_TOPLEVEL', `${root} is inside a git directory, not a working tree`);
  }
  const top = gitOrThrow(root, ['rev-parse', '--show-toplevel'], gitEnv).stdout.trim();
  if (realpathSync(top) !== realpathSync(root)) {
    throw snapshotError('SNAPSHOT_NOT_TOPLEVEL', `${root} is inside the repository at ${top}, not the top level of its own`);
  }
  const status = gitOrThrow(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], gitEnv);
  return { repository: true, dirty: parsePorcelain(status.stdout) };
}

function isSnapshot(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.at === 'string'
    && typeof value.root === 'string'
    && typeof value.repository === 'boolean'
    && Array.isArray(value.dirty)
    && value.dirty.every((path) => typeof path === 'string' && path !== '');
}

// Record what is dirty in `root` now, in the state directory, and return
// it. `repository: false` says, in the record itself, that the empty list
// is empty because there is no repository, not because the tree is clean.
export function takeSnapshot(root, stateDir, { env = process.env, now = new Date() } = {}) {
  const { repository, dirty } = readDirty(root, env);
  const snapshot = { at: now.toISOString(), root: realpathSync(root), repository, dirty };
  ensureStateDir(stateDir);
  const target = join(stateDir, STATE_FILES.SNAPSHOT);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, target);
  return snapshot;
}

// The recorded snapshot, or `null` when none was ever taken. A file that is
// there but is not a snapshot raises: returned as `null`, it would read as
// "no snapshot" and a caller would take a fresh one, filing every foreign
// path as already there.
export function readSnapshot(stateDir) {
  let text;
  try {
    text = readFileSync(join(stateDir, STATE_FILES.SNAPSHOT), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (!isSnapshot(value)) {
    throw snapshotError('SNAPSHOT_UNREADABLE', `the snapshot in ${stateDir} is not a snapshot this version can read`);
  }
  return value;
}

// Every path dirty in `root` now, split by whether `snapshot` already
// recorded it as dirty (`before`) or not (`since`). Both lists sorted.
export function splitDirty(root, snapshot, { env = process.env } = {}) {
  if (!isSnapshot(snapshot)) {
    throw snapshotError('SNAPSHOT_UNREADABLE', 'splitDirty needs a snapshot taken by takeSnapshot');
  }
  if (snapshot.root !== realpathSync(root)) {
    throw snapshotError('SNAPSHOT_OTHER_ROOT', `the snapshot was taken of ${snapshot.root}, not of ${root}`);
  }
  const current = readDirty(root, env);
  if (current.repository !== snapshot.repository) {
    throw snapshotError('SNAPSHOT_REPOSITORY_CHANGED', `${root} ${current.repository ? 'is' : 'is not'} a repository now, and ${snapshot.repository ? 'was' : 'was not'} one when the snapshot was taken`);
  }
  const known = new Set(snapshot.dirty);
  return {
    before: current.dirty.filter((path) => known.has(path)),
    since: current.dirty.filter((path) => !known.has(path)),
  };
}
