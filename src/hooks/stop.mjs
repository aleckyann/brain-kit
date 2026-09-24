// The Stop hook: before a session in a registered vault ends, ask it to
// propose what IT changed, and nothing else.
//
// THE LADDER, in this order. "Release" is exit 0 with nothing on stdout;
// "block" is exit 0 with `{"decision":"block","reason":...}` on stdout (a
// hook ALWAYS exits 0, its verdict travels in its JSON). Up to the
// registered machine the ladder fails OPEN: a hook that blocks a session it
// knows nothing about is the false positive of 14/09/2026, another person's
// dirty repository told to curate. From an invalid machine file on it fails
// CLOSED: this is a vault registered on this machine, and a session that
// ends with its own work unproposed is the failure the hook exists for.
//
//    1. the event is not a JSON object            release (stderr line)
//    2. stop_hook_active                          release (asked once already)
//    3. no vault by the sentinel                  release, silently
//    4. no machine.json in the state directory    release (not registered here)
//    5. machine.json unreadable or invalid        BLOCK
//    6. canonical_path is not this copy           release (a worktree, a copy)
//    7. not a repository, or not its top level    BLOCK
//    8. the lock is held (unreadable included)    release (another writer);
//       a holder provably dead by the lock's own staleness rule is no
//       writer: the ladder goes on, and a block names the stale lock
//       (the hook never reclaims or deletes it)
//    9. no snapshot of this tree for THIS session every dirty path is the session's
//   10. nothing dirty since the snapshot          release (paths under
//       .claude/worktrees/, Claude Code's agent worktrees, never count)
//   11. otherwise                                 BLOCK, naming the session's paths
//
// Each release after rung 3 writes one line on stderr saying which rung
// released: Claude Code keeps it in the transcript, the model does not act
// on it. The hook reads the vault and never writes to its working tree.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPathMatches, loadMachine, MACHINE_FILENAME } from '../config.mjs';
import { describeLock, isLockHolderStale } from '../guards/lock.mjs';
import { locateRepository } from '../guards/location.mjs';
import { readSnapshot, splitDirty } from '../guards/snapshot.mjs';
import { decodeBytes } from '../io.mjs';
import { createTranslator, resolveLang } from '../lang.mjs';
import { stateDirFor } from '../state.mjs';
import { parseHookPayload, resolveHookVault } from './payload.mjs';

export const LISTING_CEILING = 20;

const release = (stderr = '') => ({ stdout: '', stderr: stderr === '' ? '' : `${oneLine(stderr)}\n` });
const block = (reason) => ({ stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: '' });

function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ');
}

function detailOf(error, t) {
  return error.messageKey === undefined ? String(error.message) : t(error.messageKey, error.params);
}

function isPresent(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

// Claude Code puts agent worktrees under .claude/worktrees/ inside the
// project: an embedded checkout, never a change this session made to the
// vault. A vault seeded by init ignores the folder; an adopted one may not.
const WORKTREES_PREFIX = Buffer.from('.claude/worktrees/');

function isVaultPath(path) {
  return !(path.length >= WORKTREES_PREFIX.length && path.subarray(0, WORKTREES_PREFIX.length).equals(WORKTREES_PREFIX));
}

export function runStop(stdinText, env = process.env) {
  const parsed = parseHookPayload(stdinText);
  if (!parsed.ok) {
    const t = createTranslator(resolveLang(env));
    return release(t('hook.payload_unreadable', { detail: parsed.reason }));
  }
  const { payload } = parsed;
  if (payload.stop_hook_active === true) return release();
  const vault = resolveHookVault(payload, env);
  if (vault.root === null) return release();
  const { root } = vault;
  const t = createTranslator(vault.lang);

  let stateDir;
  try {
    stateDir = stateDirFor(root, env);
  } catch (error) {
    return block(t('hook.stop.block_failed', { detail: detailOf(error, t) }));
  }
  const machineFile = join(stateDir, MACHINE_FILENAME);
  if (!isPresent(machineFile)) return release(t('hook.stop.release_unregistered', { file: machineFile }));
  let machine;
  try {
    machine = loadMachine(stateDir);
  } catch (error) {
    return block(t('hook.stop.block_machine_invalid', { file: machineFile, detail: oneLine(error.message) }));
  }
  if (!canonicalPathMatches(machine.canonical_path, root)) {
    return release(t('hook.stop.release_other_path', { root, recorded: String(machine.canonical_path) }));
  }

  try {
    let topLevel;
    try {
      topLevel = locateRepository(root, env).topLevel;
    } catch (error) {
      if (error.messageKey === undefined) throw error;
      return block(t('hook.stop.block_not_repository', { why: detailOf(error, t) }));
    }
    if (topLevel !== root) {
      const why = t('snapshot.not_toplevel', { dir: root, top: topLevel });
      return block(t('hook.stop.block_not_repository', { why }));
    }
    const holder = describeLock(root, { env });
    const staleLock = holder !== null && isLockHolderStale(holder);
    if (holder !== null && !staleLock) {
      if (holder.pid === null) return release(t('hook.stop.release_lock_unreadable'));
      return release(t('hook.stop.release_lock_held', { command: String(holder.command), pid: holder.pid }));
    }
    let snapshot = null;
    try {
      snapshot = readSnapshot(root, { env });
    } catch {
      snapshot = null;
    }
    const trust = snapshotTrust(snapshot, topLevel, payload);
    const usable = trust === 'own';
    const split = splitDirty(root, usable ? snapshot : { at: '', root: topLevel, paths: [] }, { env });
    const before = split.before.filter(isVaultPath);
    const since = split.since.filter(isVaultPath);
    if (since.length === 0) return release(t('hook.stop.release_clean', { count: before.length }));
    const reason = blockReason(t, since, before.length, trust);
    return block(staleLock ? `${reason}\n${t('hook.stop.block_stale_lock', { command: String(holder.command), pid: holder.pid })}` : reason);
  } catch (error) {
    return block(t('hook.stop.block_failed', { detail: detailOf(error, t) }));
  }
}

// Whether the snapshot on disk may split this session's work from earlier
// work: only one of this working tree taken for this very session. One per
// working tree, a snapshot is retaken by any session that starts there; a
// second session's startup would otherwise file the first session's work as
// "already there", and the first would end with it unproposed. Anything but
// 'own' makes every dirty path count as this session's, which fails toward
// blocking, and the reason says why.
export function snapshotTrust(snapshot, topLevel, payload) {
  if (snapshot === null || snapshot.root !== topLevel) return 'missing';
  if (snapshot.session === null) return 'sessionless';
  // snapshot.session is a string here, so an absent or non-string id can
  // never equal it; an empty one could, and is refused by name.
  if (payload.session_id === '' || snapshot.session !== payload.session_id) return 'foreign';
  return 'own';
}

function blockReason(t, since, inherited, trust) {
  const lines = [t('hook.stop.block_changed', { count: since.length })];
  for (const path of since.slice(0, LISTING_CEILING)) lines.push(`  ${decodeBytes(path)}`);
  if (since.length > LISTING_CEILING) lines.push(t('hook.stop.block_more', { count: since.length - LISTING_CEILING }));
  lines.push(t('hook.stop.block_inherited', { count: inherited }));
  if (trust === 'missing') lines.push(t('hook.stop.block_no_snapshot'));
  if (trust === 'sessionless') lines.push(t('hook.stop.block_sessionless_snapshot'));
  if (trust === 'foreign') lines.push(t('hook.stop.block_foreign_snapshot'));
  lines.push(t('hook.stop.block_instruction'));
  return lines.join('\n');
}
