// The SessionStart hook: record which paths were already there when this
// session began, so the Stop hook can ask the session to propose only what
// it changed itself.
//
// KEEP OR RETAKE. Claude Code fires SessionStart on startup, resume, clear
// and compact. A snapshot retaken on compaction would file the session's
// own work so far as "already there", and the Stop hook would then release
// a session with its work unproposed: the command that succeeds while
// saying nothing. So the existing snapshot is KEPT when it is of this very
// working tree, was taken for this very session, and the event is that
// session continuing (`compact` or `resume`). Every other case retakes:
// a new session, a `clear`, a snapshot of another tree or of no session.
//
// A hook always exits 0. What it has to say travels on stdout as the
// `additionalContext` line Claude Code hands the model, and a warning for
// the person goes to stderr.
import { describeLock } from '../guards/lock.mjs';
import { locateRepository } from '../guards/location.mjs';
import { readSnapshot, takeSnapshot } from '../guards/snapshot.mjs';
import { createTranslator, resolveLang } from '../lang.mjs';
import { parseHookPayload, resolveHookVault, vaultTitle } from './payload.mjs';

const CONTINUING = new Set(['compact', 'resume']);

function output(line) {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } })}\n`;
}

function sessionIdOf(payload) {
  return typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null;
}

// Whether the recorded snapshot still describes the start of this session.
export function keepsSnapshot(existing, topLevel, payload) {
  const session = sessionIdOf(payload);
  return existing !== null
    && existing.root === topLevel
    && session !== null && existing.session === session
    && CONTINUING.has(payload.source);
}

function lockSentence(root, env, t) {
  const holder = describeLock(root, { env });
  if (holder === null) return '';
  if (holder.pid === null) return ` ${t('hook.session_start.lock_unreadable')}`;
  return ` ${t('hook.session_start.lock_held', { command: String(holder.command), pid: holder.pid })}`;
}

export function runSessionStart(stdinText, env = process.env, now = new Date()) {
  const parsed = parseHookPayload(stdinText);
  if (!parsed.ok) {
    const t = createTranslator(resolveLang(env));
    return { stdout: '', stderr: `${t('hook.payload_unreadable', { detail: parsed.reason })}\n` };
  }
  const { payload } = parsed;
  const vault = resolveHookVault(payload, env);
  if (vault.root === null) return { stdout: '', stderr: '' };
  const { root, config } = vault;
  const t = createTranslator(vault.lang);
  const title = vaultTitle(root, config);
  try {
    let topLevel;
    try {
      topLevel = locateRepository(root, env).topLevel;
    } catch (error) {
      if (error.messageKey === undefined) throw error;
      return noSnapshot(t, title, t(error.messageKey, error.params));
    }
    if (topLevel !== root) {
      return noSnapshot(t, title, t('snapshot.not_toplevel', { dir: root, top: topLevel }));
    }
    let existing = null;
    let replaced = false;
    try {
      existing = readSnapshot(root, { env });
    } catch {
      replaced = true;
    }
    let status;
    if (keepsSnapshot(existing, topLevel, payload)) {
      status = t('hook.session_start.kept', { title, count: existing.paths.length });
    } else {
      const session = sessionIdOf(payload);
      const count = takeSnapshot(root, { env, now, ...(session === null ? {} : { session }) }).paths.length;
      status = replaced ? t('hook.session_start.replaced', { title, count }) : t('hook.session_start.taken', { title, count });
    }
    const line = `${status}${lockSentence(root, env, t)}`;
    return { stdout: output(line), stderr: '' };
  } catch (error) {
    const detail = error.messageKey === undefined ? String(error.message) : t(error.messageKey, error.params);
    return { stdout: '', stderr: `${t('hook.session_start.failed', { detail })}\n` };
  }
}

function noSnapshot(t, title, why) {
  return {
    stdout: output(t('hook.session_start.no_snapshot', { title })),
    stderr: `${t('hook.session_start.no_repository', { why })}\n`,
  };
}
