// The SessionStart hook: record which paths were already there when this
// session began, so the Stop hook can ask the session to propose only what
// it changed itself.
//
// WRITE ONLY AT A START. Claude Code fires SessionStart on startup, resume,
// clear and compact. A snapshot retaken on compaction would file the
// session's own work so far as "already there", and the Stop hook would
// then release a session with its work unproposed: the command that
// succeeds while saying nothing. So a snapshot is written only when a
// session really starts (`startup`, `clear`, or any source other than
// `compact` and `resume`). On `compact` or `resume` nothing is ever
// written: the snapshot on disk is kept as it is. When that snapshot is
// this session's own (same working tree, same session id) the line says
// it was kept; when it is missing, unreadable, of another tree, of another
// session or of no session, the line says this session's work cannot be
// told apart from earlier work, and the Stop hook, which trusts only a
// snapshot taken for this very session, counts every dirty path as the
// session's. This also covers `claude --resume --fork-session`, which
// arrives as `resume` with a new session id: the fork inherits no
// snapshot of its own, so its Stop counts everything, earlier work
// included, rather than releasing work done before the fork.
//
// A hook always exits 0. What it has to say travels on stdout as the
// `additionalContext` line Claude Code hands the model, and a warning for
// the person goes to stderr.
import { describeLock, isLockHolderStale } from '../guards/lock.mjs';
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

// Whether the recorded snapshot is this session's own: of this working
// tree and taken for this very session id.
export function ownsSnapshot(existing, topLevel, payload) {
  const session = sessionIdOf(payload);
  return existing !== null
    && existing.root === topLevel
    && session !== null && existing.session === session;
}

function lockSentence(root, env, t) {
  const holder = describeLock(root, { env });
  if (holder === null) return '';
  if (holder.pid === null) return ` ${t('hook.session_start.lock_unreadable')}`;
  if (isLockHolderStale(holder)) {
    return ` ${t('hook.session_start.lock_stale', { command: String(holder.command), pid: holder.pid })}`;
  }
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
    if (CONTINUING.has(payload.source)) {
      status = ownsSnapshot(existing, topLevel, payload)
        ? t('hook.session_start.kept', { title, count: existing.paths.length })
        : t('hook.session_start.not_kept', { title });
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
