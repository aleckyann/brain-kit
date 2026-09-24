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
//    8. the lock is held (unreadable included)    release (another writer)
//    9. no usable session snapshot                every dirty path is the session's
//   10. nothing dirty since the snapshot          release
//   11. otherwise                                 BLOCK, naming the session's paths
//
// Each release after rung 3 writes one line on stderr saying which rung
// released: Claude Code keeps it in the transcript, the model does not act
// on it. The hook reads the vault and never writes to its working tree.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPathMatches, loadMachine, MACHINE_FILENAME } from '../config.mjs';
import { describeLock } from '../guards/lock.mjs';
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
    if (holder !== null) {
      if (holder.pid === null) return release(t('hook.stop.release_lock_unreadable'));
      return release(t('hook.stop.release_lock_held', { command: String(holder.command), pid: holder.pid }));
    }
    let snapshot = null;
    try {
      snapshot = readSnapshot(root, { env });
    } catch {
      snapshot = null;
    }
    const usable = snapshot !== null && snapshot.root === topLevel;
    const { before, since } = splitDirty(root, usable ? snapshot : { at: '', root: topLevel, paths: [] }, { env });
    if (since.length === 0) return release(t('hook.stop.release_clean', { count: before.length }));
    return block(blockReason(t, since, before.length, usable));
  } catch (error) {
    return block(t('hook.stop.block_failed', { detail: detailOf(error, t) }));
  }
}

function blockReason(t, since, inherited, usable) {
  const lines = [t('hook.stop.block_changed', { count: since.length })];
  for (const path of since.slice(0, LISTING_CEILING)) lines.push(`  ${decodeBytes(path)}`);
  if (since.length > LISTING_CEILING) lines.push(t('hook.stop.block_more', { count: since.length - LISTING_CEILING }));
  lines.push(t('hook.stop.block_inherited', { count: inherited }));
  if (!usable) lines.push(t('hook.stop.block_no_snapshot'));
  lines.push(t('hook.stop.block_instruction'));
  return lines.join('\n');
}
