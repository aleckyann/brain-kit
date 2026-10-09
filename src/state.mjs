import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isWindows, restrictToOwner } from './platform.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// Names of every file (or, for LOG_DIR, directory) later slices write inside
// a vault's state directory. Declared here, in the one module that resolves
// that directory, so no other module invents or renames one of these paths.
//
//   WATERMARK     the high-water mark of the last day (or ref) the scheduled
//                 curator has already read, carried over from the original
//                 vault's own watermark file. Kept as JSON, not a bare date
//                 string, so it can grow a second field later without a
//                 format migration.
//   LAST_RUN      a small record of the most recent run's outcome (status,
//                 timestamp), so a briefing or `doctor` can answer "did the
//                 last run succeed" without re-parsing the log directory.
//   LOG_DIR       directory holding one dated log file per run (the
//                 individual file names are dynamic, so only the directory
//                 itself is named here).
//   QUESTIONS_LOG open questions the curator raised but could not resolve on
//                 its own; kept apart from the run log because it is read on
//                 its own by the briefing, independent of any single run.
//   DIGEST_DIR    directory holding, while a round runs, one directory of
//                 that round's transcript digests (the text the model reads
//                 in place of each transcript, src/sources/
//                 transcripts-claude-code.mjs). The round deletes its own on
//                 every exit it can handle, and the next round deletes
//                 whatever a round killed outright left there. A round with
//                 --keep-stream writes its digests next to its stream in
//                 LOG_DIR instead, where they age out with the logs.
//   INCIDENTS     one JSON line per round that went wrong or repaired
//                 something, appended before the round releases its lock
//                 and pruned only by a round holding it (src/incidents.mjs).
//
// There is no lock and no snapshot here, on purpose. A state directory is
// chosen by the caller's environment (BRAIN_KIT_STATE_DIR, XDG_STATE_HOME),
// so one vault can have several, and a lock kept in one of them lets a
// second writer in through another. The vault lock every writing command
// takes, the scheduled curator's included, lives in the repository's git
// common directory, and the session snapshot in the working tree's git
// directory (src/guards/location.mjs). machine.json no longer names either.
export const STATE_FILES = Object.freeze({
  WATERMARK: 'watermark.json',
  LAST_RUN: 'last-run.json',
  LOG_DIR: 'logs',
  QUESTIONS_LOG: 'questions.log',
  DIGEST_DIR: 'digests',
  INCIDENTS: 'incidents.jsonl',
});

// A relative XDG_STATE_HOME is ignored, as the XDG Base Directory
// specification requires: resolved against whatever directory a command
// happens to run from, it would put one vault's state in a different
// place for every working directory.
function stateHome(env) {
  const configured = env.XDG_STATE_HOME;
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.local', 'state');
}

// Short, stable hash of the vault's absolute path. Used as a disambiguator
// alongside the vault's own directory name, not on its own: a hash alone
// would make the state directory unreadable to a human looking at it.
function shortHash(absoluteVaultPath) {
  return createHash('sha256').update(absoluteVaultPath).digest('hex').slice(0, 8);
}

// The physical path of an absolute path: its real path when it exists, and
// when it does not, the real path of the deepest part of it that does,
// followed by the rest as it is spelt. That is the path it has, or will
// have once it is created, with every symbolic link above it resolved.
// Only making a missing path absolute is not enough on a machine where a
// directory above it is a link, which on macOS includes every temporary
// directory (/var and /tmp lead to /private/var and /private/tmp): the
// same place would be spelt two ways, and a state directory derived from
// one spelling is not found from the other. Any failure other than a
// missing path is raised, never guessed around.
export function physicalPathOf(absolute) {
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(physicalPathOf(parent), basename(absolute));
}

// Resolve the per-vault state directory. BRAIN_KIT_STATE_DIR, when set, is a
// full override (used by tests and by anyone who wants to pin the exact
// path) and the vault path is not consulted at all. Otherwise the directory
// is derived from the vault's physical path under the user's state home, so
// a vault reached through a symbolic link resolves to the same state
// directory (and machine.json) as through its real path, the same vault
// always resolves to the same directory, and two different vaults never
// collide. A vault path that does not exist (init, before it creates the
// vault; the old path `machine register --from` names) derives from the
// physical path it would have.
export function stateDirFor(vaultRoot, env = process.env) {
  return stateDirForPath(physicalPathOf(resolve(vaultRoot)), env);
}

// The same derivation from a path taken as it is spelt, with no symbolic
// link resolved. `machine register --from` needs it: a vault moved with a
// link left at its old path has its old state under the old path's own
// name, and resolving the link would derive the new path's directory
// instead.
export function stateDirForPath(absolute, env = process.env) {
  if (env.BRAIN_KIT_STATE_DIR) return env.BRAIN_KIT_STATE_DIR;
  const name = basename(absolute) || 'vault';
  return join(stateRootFor(env), `${name}-${shortHash(absolute)}`);
}

// The directory every derived state directory sits in, one per vault. Read
// by `machine register` to list the state directories whose vault is no
// longer where their machine.json says; BRAIN_KIT_STATE_DIR does not move
// it, because that override names one vault's directory, not this one.
export function stateRootFor(env = process.env) {
  return join(stateHome(env), 'brain-kit');
}

// machine.json's vault_id: the vault directory's name, folded to the
// schema's lowercase-and-dashes alphabet (accents dropped, anything else
// a dash), followed by the same short path hash stateDirFor uses, so two
// vaults both called "vault" never share an id, and the id of a vault
// reads as that vault to a person looking at it.
export function vaultIdFor(vaultRoot) {
  const absolute = resolve(vaultRoot);
  const name = basename(absolute)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${name === '' ? 'vault' : name}-${shortHash(absolute)}`;
}

// A file written in full to a private sibling and renamed into place.
export function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// Create the state directory (and any missing parents) with mode 0700. The
// directory holds run logs that quote a private vault, so its permissions
// are part of the product, not housekeeping. mkdirSync's `mode` option only
// applies to the last directory it creates and is still subject to the
// process umask, so the mode is set again explicitly to make the result
// deterministic. Calling this twice on the same directory is harmless.
//
// On Windows a mode is not who may open a directory (src/platform.mjs): its
// ACL is. The directory is made open to the person, the system and the
// administrators only when this call creates it, and when `tighten` asks
// for it (init and `machine register`, which tighten an existing directory
// on POSIX too); everything created in it inherits that. A failure to set
// it is raised, as a failing chmod is.
export function ensureStateDir(dir, { tighten = false, platform = process.platform, restrict = restrictToOwner } = {}) {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (isWindows(platform) && (!existed || tighten)) {
    const result = restrict(dir, { directory: true });
    if (!result.ok) throw new Error(`could not make ${dir} private to its owner (icacls): ${result.error}`);
  }
  return dir;
}
