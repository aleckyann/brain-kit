// What a proposal left in the working tree, and the one comparison that
// tells it from unproposed work.
//
// `propose` builds its commit with git plumbing and never moves HEAD, the
// index or the working tree (src/commands/propose.mjs), so the files it
// proposed are still dirty after it. Inside a round the round brings them
// back to HEAD from its round record. Outside one (a person's session, the
// morning briefing) the Stop hook would ask the session to propose them
// again, a second `propose` would open a second pull request for the same
// captures, and every later `sync` (so every scheduled round) would
// postpone on them, and after the owner's merge `propose` and `sync` would
// refuse each other (final review of phase 4, finding C1).
//
// ONE RECORD SHAPE. A round record (`<git dir>/brain-kit-round-<token>.json`)
// and the proposed-paths ledger (`<git dir>/brain-kit-proposed.json`,
// LEDGER_NAME) are the same format: `{ "format": 1, "proposals": [ { opened,
// remote, branch, commit, paths }, ... ] }`, `paths` being exactly the
// vault-relative paths that commit changed. Both are appended to under a
// guard file created exclusively beside them, read and validated, and
// written whole to a private temporary file renamed into place
// (appendRecord). A non-joined `propose` appends to the ledger once a
// commit is proved on at least one push url.
//
// ONE COMPARISON. proposedMatch: for each path, the most recent entry naming
// it; the path "matches" when its working-tree bytes equal that entry's
// pushed blob (a symbolic link's target for a link), or it is absent from
// both. Everything else, a byte changed included, is `changed`. A commit
// that can no longer be read (garbage collected) proves nothing, so its
// paths are `changed`. The round's cleanup, the Stop hook, `propose`'s
// refusal to propose a path again and `sync`'s restore all use it, so one
// byte edited after the push makes the path unproposed work again for every
// one of them.
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { runGit } from '../git.mjs';
import { decodeBytes } from '../io.mjs';
import { locateRepository } from './location.mjs';

export const RECORD_FORMAT = 1;
export const LEDGER_NAME = 'brain-kit-proposed.json';
// How long an append waits for another one to finish its read and write of
// the same record (they hold its guard for a few system calls; a guard
// older than that was left by a run that died).
export const RECORD_GUARD_WAIT_MS = 5000;

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY_KEYS = ['branch', 'commit', 'opened', 'paths', 'remote'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, keys) {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}

export function isEntry(entry) {
  return isPlainObject(entry) && sameKeys(entry, ENTRY_KEYS)
    && typeof entry.opened === 'boolean'
    && typeof entry.remote === 'string' && entry.remote !== ''
    && typeof entry.branch === 'string' && entry.branch !== ''
    && typeof entry.commit === 'string' && COMMIT_ID.test(entry.commit)
    && Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((path) => typeof path === 'string' && path !== '');
}

// A record's text: `{ format: 1, proposals: [entry, ...] }` with every entry
// well formed and nothing else, or null.
export function parseRoundRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !sameKeys(value, ['format', 'proposals'])) return null;
  if (value.format !== RECORD_FORMAT || !Array.isArray(value.proposals)) return null;
  return value.proposals.every(isEntry) ? value : null;
}

// The record at `file` as it is now: undefined when there is none, null
// when what is there is not a record this version reads (not a regular
// file, a symbolic link, or text that does not validate), the record
// otherwise. Opened without following a link and without blocking on a
// FIFO. Any other error is thrown.
export function readRecordFile(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return parseRoundRecord(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

// The guard two writers of one record take around their read and write,
// so neither loses the other's entry: a file created exclusively, retried
// until `waitMs` has passed. True once taken.
function takeRecordGuard(path, waitMs) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(cell, 0, 0, 20);
  }
}

const codeOf = (error) => (typeof error.code === 'string' ? error.code : 'error');

// Under the record's guard: the record read and validated, `change` applied
// to its entries, and the whole written in full to a private file created
// exclusively beside it and renamed into place, so no reader ever sees half
// of one and no entry is ever lost. An empty result removes the file.
// Returns { ok: true }, { ok: false, invalid: true } (what is there does not
// validate and is left exactly as it is) or { ok: false, code } (an error
// code, never an error's own text, which names the file).
function rewriteRecord(file, change, waitMs) {
  const guard = `${file}.lock`;
  try {
    if (!takeRecordGuard(guard, waitMs)) return { ok: false, code: 'EBUSY' };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const existing = readRecordFile(file);
    if (existing === null) return { ok: false, invalid: true };
    const proposals = change(existing === undefined ? [] : existing.proposals);
    if (proposals.length === 0) {
      rmSync(file, { force: true });
      return { ok: true };
    }
    const text = `${JSON.stringify({ format: RECORD_FORMAT, proposals }, null, 2)}\n`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    rmSync(tmp, { force: true });
    return { ok: false, code: codeOf(error) };
  } finally {
    rmSync(guard, { force: true });
  }
}

// `entry` appended to the record at `file`, merged, never overwritten.
export function appendRecord(file, entry, waitMs = RECORD_GUARD_WAIT_MS) {
  return rewriteRecord(file, (proposals) => [...proposals, entry], waitMs);
}

// ------------------------------------------------------------ the ledger

export function ledgerPath(root, env = process.env) {
  return join(locateRepository(root, env).gitDir, LEDGER_NAME);
}

// The ledger of this working tree: { state: 'absent' | 'ok' | 'invalid' |
// 'unreadable', file, entries, detail? }. `entries` is empty unless 'ok'.
// A ledger that cannot be read or does not validate is never an exception:
// each consumer says so on stderr and goes on as if there were none.
export function readLedger(root, env = process.env) {
  let file;
  try {
    file = ledgerPath(root, env);
  } catch (error) {
    return { state: 'unreadable', file: null, entries: [], detail: codeOf(error) };
  }
  try {
    const record = readRecordFile(file);
    if (record === undefined) return { state: 'absent', file, entries: [] };
    if (record === null) return { state: 'invalid', file, entries: [] };
    return { state: 'ok', file, entries: record.proposals };
  } catch (error) {
    return { state: 'unreadable', file, entries: [], detail: codeOf(error) };
  }
}

const entryKey = (entry) => JSON.stringify([entry.branch, entry.commit, entry.paths]);

// The ledger without the entries in `drop` (compared by branch, commit and
// paths), under its guard; the file is removed when nothing is left.
export function pruneLedger(file, drop, waitMs = RECORD_GUARD_WAIT_MS) {
  const keys = new Set(drop.map(entryKey));
  return rewriteRecord(file, (proposals) => proposals.filter((entry) => !keys.has(entryKey(entry))), waitMs);
}

// ------------------------------------------------------------ the comparison

// Every blob of a commit's tree: decoded name -> { mode, sha, bytes }.
function treeOf(root, commit, env) {
  const listed = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { env, encoding: 'buffer' });
  if (listed.status !== 0) throw new Error(`git ls-tree ${commit} exited with status ${listed.status}`);
  const out = new Map();
  const buf = Buffer.from(listed.stdout);
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    const record = buf.subarray(start, end === -1 ? buf.length : end);
    start = end === -1 ? buf.length : end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    const [mode, type, sha] = record.subarray(0, tab).toString('latin1').split(' ');
    if (type !== 'blob') continue;
    const bytes = Buffer.from(record.subarray(tab + 1));
    out.set(decodeBytes(bytes), { mode, sha, bytes });
  }
  return out;
}

function blobBytes(root, sha, env) {
  const shown = runGit(root, ['cat-file', 'blob', sha], { env, encoding: 'buffer' });
  if (shown.status !== 0) throw new Error(`git cat-file blob ${sha} exited with status ${shown.status}`);
  return Buffer.from(shown.stdout);
}

// Whether `commit` names a commit this repository still holds.
function hasCommit(root, commit, env) {
  return runGit(root, ['cat-file', '-e', `${commit}^{commit}`], { env }).status === 0;
}

// What is on disk at `pathBytes`: null (absent), { link: Buffer } or
// { file: Buffer }; a directory or anything else is { other: true }.
function onDisk(root, pathBytes) {
  const full = Buffer.concat([Buffer.from(root.endsWith('/') ? root : `${root}/`), pathBytes]);
  let st;
  try {
    st = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (st.isSymbolicLink()) return { full, link: readlinkSync(full, { encoding: 'buffer' }) };
  if (st.isFile()) return { full, file: readFileSync(full) };
  return { full, other: true };
}

// The comparison. For each path an entry names (the latest entry naming
// it, when several do), restricted to `paths` when given: `matching` (the
// working tree holds exactly what that entry's commit pushed, or the path
// is absent from both) and `changed` (anything else), each sorted, and
// `details`, path -> { entry, atHead, disk } for every matching path, which
// restoreMatching needs. Git runs without the caller's git environment
// (runGit).
export function proposedMatch(root, entries, env = process.env, { paths = null } = {}) {
  const wanted = paths === null ? null : new Set(paths);
  const latest = new Map();
  for (const entry of entries) {
    for (const path of entry.paths) if (wanted === null || wanted.has(path)) latest.set(path, entry);
  }
  const matching = [];
  const changed = [];
  const details = new Map();
  if (latest.size === 0) return { matching, changed, details };
  const head = treeOf(root, 'HEAD', env);
  const trees = new Map();
  for (const [path, entry] of latest) {
    if (!trees.has(entry.commit)) trees.set(entry.commit, hasCommit(root, entry.commit, env) ? treeOf(root, entry.commit, env) : null);
    const tree = trees.get(entry.commit);
    if (tree === null) {
      changed.push(path);
      continue;
    }
    const pushed = tree.get(path) ?? null;
    const atHead = head.get(path) ?? null;
    const pathBytes = pushed?.bytes ?? atHead?.bytes ?? Buffer.from(path, 'utf8');
    const disk = onDisk(root, pathBytes);
    let same;
    if (pushed === null) same = disk === null;
    else if (disk === null || disk.other) same = false;
    else if (pushed.mode === '120000') same = disk.link !== undefined && disk.link.equals(blobBytes(root, pushed.sha, env));
    else same = disk.file !== undefined && disk.file.equals(blobBytes(root, pushed.sha, env));
    if (!same) {
      changed.push(path);
      continue;
    }
    matching.push(path);
    details.set(path, { entry, atHead, disk });
  }
  return { matching: matching.sort(), changed: changed.sort(), details };
}

// The restore half: every matching path brought back to HEAD (restored from
// HEAD when HEAD has it, deleted when it does not), with literal pathspecs
// read NUL-separated from standard input, never from the argument vector.
// The content is on the pushed branch, so nothing is lost. Returns the
// restored paths, sorted.
export function restoreMatching(root, match, env = process.env) {
  const fromHead = [];
  for (const path of match.matching) {
    const { atHead, disk } = match.details.get(path);
    if (atHead !== null) fromHead.push(atHead.bytes);
    else if (disk !== null) rmSync(disk.full, { force: true });
  }
  if (fromHead.length > 0) {
    const input = Buffer.concat(fromHead.flatMap((bytes) => [bytes, Buffer.from([0])]));
    const done = runGit(root, ['--literal-pathspecs', 'checkout', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input, encoding: 'buffer' });
    if (done.status !== 0) throw new Error(`git checkout HEAD exited with status ${done.status}: ${decodeBytes(Buffer.from(done.stderr)).trim()}`);
  }
  return [...match.matching];
}

// The branches the matching paths' entries name, distinct, in entry order.
export function branchesOf(match) {
  return [...new Set(match.matching.map((path) => match.details.get(path).entry.branch))];
}
