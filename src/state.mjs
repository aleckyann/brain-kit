import { mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

// Names of every file (or, for LOG_DIR, directory) later slices write inside
// a vault's state directory. Declared here, in the one module that resolves
// that directory, so no other module invents or renames one of these paths.
//
//   LOCK          the exclusive lock the scheduled curator loop takes before
//                 a run, so two runs against the same vault never overlap
//                 (ports the original vault's flock-based lock, now scoped
//                 per vault instead of one lock shared by every vault).
//   LOCK_RECLAIM  the marker a process creates, exclusively, to earn the
//                 right to replace a stale LOCK (src/guards/lock.mjs says
//                 why a rename needs it). Present only for the few system
//                 calls a reclaim takes; one left behind means a reclaimer
//                 died mid reclaim. LOCK, LOCK_RECLAIM and SNAPSHOT are
//                 each written through a transient sibling named
//                 `<name>.<pid>.<random>.tmp`, never under their own name.
//   WATERMARK     the high-water mark of the last day (or ref) the scheduled
//                 curator has already read, carried over from the original
//                 vault's own watermark file. Kept as JSON, not a bare date
//                 string, so it can grow a second field later without a
//                 format migration.
//   LAST_RUN      a small record of the most recent run's outcome (status,
//                 timestamp), so a briefing or `doctor` can answer "did the
//                 last run succeed" without re-parsing the log directory.
//   SNAPSHOT      the session snapshot (src/guards/snapshot.mjs): which
//                 paths were already dirty when a session began, so a later
//                 `propose` can tell them from what the session changed.
//   LOG_DIR       directory holding one dated log file per run (the
//                 individual file names are dynamic, so only the directory
//                 itself is named here).
//   QUESTIONS_LOG open questions the curator raised but could not resolve on
//                 its own; kept apart from the run log because it is read on
//                 its own by the briefing, independent of any single run.
export const STATE_FILES = Object.freeze({
  LOCK: 'lock',
  LOCK_RECLAIM: 'lock.reclaim',
  WATERMARK: 'watermark.json',
  LAST_RUN: 'last-run.json',
  SNAPSHOT: 'snapshot.json',
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

// Resolve the per-vault state directory. BRAIN_KIT_STATE_DIR, when set, is a
// full override (used by tests and by anyone who wants to pin the exact
// path) and the vault path is not consulted at all. Otherwise the directory
// is derived from the vault's absolute path under the user's state home, so
// the same vault always resolves to the same directory and two different
// vaults never collide.
export function stateDirFor(vaultRoot, env = process.env) {
  if (env.BRAIN_KIT_STATE_DIR) return env.BRAIN_KIT_STATE_DIR;
  const absolute = resolve(vaultRoot);
  const name = basename(absolute) || 'vault';
  return join(stateHome(env), 'brain-kit', `${name}-${shortHash(absolute)}`);
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
