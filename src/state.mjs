import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

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

// The real path of a vault that exists, so a vault reached through a
// symbolic link resolves to the same state directory (and machine.json) as
// through its real path; a path that does not exist yet (init, before it
// creates the vault) is only made absolute. Any other failure to resolve
// is raised, never guessed around.
function realPathOf(absolute) {
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return absolute;
    throw error;
  }
}

// Resolve the per-vault state directory. BRAIN_KIT_STATE_DIR, when set, is a
// full override (used by tests and by anyone who wants to pin the exact
// path) and the vault path is not consulted at all. Otherwise the directory
// is derived from the vault's absolute path under the user's state home, so
// the same vault always resolves to the same directory and two different
// vaults never collide.
export function stateDirFor(vaultRoot, env = process.env) {
  return stateDirForPath(realPathOf(resolve(vaultRoot)), env);
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

// Create the state directory (and any missing parents) with mode 0700. The
// directory holds run logs that quote a private vault, so its permissions
// are part of the product, not housekeeping. mkdirSync's `mode` option only
// applies to the last directory it creates and is still subject to the
// process umask, so the mode is set again explicitly to make the result
// deterministic. Calling this twice on the same directory is harmless.
export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
