// Every fact the morning briefing states, computed by the kit.
//
// Phase 4, layer 1: the briefing is a model writing to a person, and the
// one thing it must never do is state a date, a count or a deadline it
// worked out itself. So the kit computes them all here, deterministically,
// and the briefing's prompt hands them over as they are: today in the
// vault's time zone, the curator's last round and each source's state, the
// connector states carried from round to round, the pull requests waiting
// for a merge, the notes past their stale_after, the pending items by
// deadline, the working tree and the lock.
//
// Where a fact cannot be known, the answer says so and says why; it never
// stands in a guess. `gh` absent or failing gives `{ ok: false, reason }`
// and no list, never an empty one; a last-run record that cannot be read is
// reported as such, never as "no round yet"; git that cannot answer leaves
// its numbers null with the reason beside them. Dates a person reads are
// DD/MM/YYYY (with HH:MM for an instant) in the vault's time zone.
//
// The comparison with the remote is against the remote-tracking reference
// as the last fetch left it: the preflight reads, it never fetches (a
// fetch is the curator's `sync`, under the lock).
//
// `deps` hands in, for the tests: `run` (the exec helper), `walkVault`,
// `listPublishable` and `findExecutable`. Production passes nothing.
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run as runCommand } from '../exec.mjs';
import { STATE_FILES } from '../state.mjs';
import { walkVault as realWalkVault } from '../vault.mjs';
import { listPublishable as realListPublishable, noteFileSet } from '../file-set.mjs';
import { computeStale, isMarkdown, makeReadFile } from '../commands/validate.mjs';
import { aheadBehind, currentBranch, defaultBranch, defaultBranchUpstream, dirtyPaths, resolveCommit, runGit } from '../git.mjs';
import { describeLock } from '../guards/lock.mjs';
import { localDay } from '../guards/watermark.mjs';
import { findExecutable as realFindExecutable } from '../doctor/checks.mjs';
import { knownStates } from '../commands/curate.mjs';
import { ghEnvOf } from '../commands/propose.mjs';
import { vaultClock } from '../commands/prompt.mjs';
import { pendingBuckets } from './pending.mjs';

// `gh pr list` returns at most this many pull requests when it is not
// given --limit (gh's own default). A list that long may be cut: the
// facts say so instead of stating the count as the whole.
export const GH_LIST_DEFAULT_LIMIT = 30;
export const PR_LIST_ARGS = Object.freeze(['pr', 'list', '--state', 'open', '--json', 'number,title,url,createdAt']);

// ISO weekday names, Sunday first as Date#getUTCDay counts them: an
// identifier, translated only where a person reads it.
export const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0] ?? '';
}

// YYYY-MM-DD as a person reads it.
export function humanDay(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// An instant as a person reads it in `tz`, DD/MM/YYYY HH:MM, or null when
// the value is not an instant.
export function humanInstant(value, tz) {
  const at = typeof value === 'string' ? new Date(value) : null;
  if (at === null || Number.isNaN(at.getTime())) return null;
  const { iso } = vaultClock(at, tz);
  return `${humanDay(iso.slice(0, 10))} ${iso.slice(11, 16)}`;
}

// The calendar day of an instant in `tz`, as a person reads it, or null.
function humanDayOf(value, tz) {
  const at = typeof value === 'string' ? new Date(value) : null;
  if (at === null || Number.isNaN(at.getTime())) return null;
  return humanDay(localDay(at, tz));
}

// The curator's last round, as src/commands/curate.mjs writes it at the end
// of every round, and the connector states it carries.
function lastRunFacts(stateDir, tz) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(stateDir, STATE_FILES.LAST_RUN), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { lastRun: null, connectorStates: {} };
    return { lastRun: unreadableRun(error.code ?? error.message), connectorStates: {} };
  }
  if (!isPlainObject(value)) return { lastRun: unreadableRun(`not an object: ${JSON.stringify(value)}`), connectorStates: {} };
  const sources = {};
  if (isPlainObject(value.sources)) {
    for (const [id, entry] of Object.entries(value.sources)) {
      const own = isPlainObject(entry) ? entry : {};
      sources[id] = {
        state: typeof own.state === 'string' ? own.state : null,
        advanced: typeof own.advanced === 'boolean' ? own.advanced : null,
      };
    }
  }
  const at = typeof value.at === 'string' ? value.at : null;
  const lastRun = {
    at,
    atHuman: humanInstant(at, tz),
    exit: Number.isInteger(value.exit) ? value.exit : null,
    reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : null,
    sources,
    problem: null,
  };
  const connectorStates = {};
  for (const [id, entry] of Object.entries(knownStates(value))) {
    connectorStates[id] = { state: entry.state, at: entry.at, atHuman: humanInstant(entry.at, tz) };
  }
  return { lastRun, connectorStates };
}

function unreadableRun(detail) {
  return { at: null, atHuman: null, exit: null, reasonCode: null, sources: {}, problem: String(detail) };
}

// The open pull requests, from `gh pr list` run in the vault.
function pullRequestFacts(root, config, env, tz, { run, findExecutable }) {
  const unknown = (reason, detail = null) => ({ ok: false, reason, detail, items: null, mayHaveMore: false });
  const name = typeof config.git?.pr_command === 'string' && config.git.pr_command !== '' ? config.git.pr_command : 'gh';
  const program = findExecutable(name, String(env.PATH ?? '').split(delimiter));
  if (program === null) return unknown('absent');
  const result = run(program, [...PR_LIST_ARGS], { cwd: root, env: ghEnvOf(env) });
  if (result.status !== 0) return unknown('failed', firstLine(result.stderr || result.stdout) || `exit ${result.status}`);
  let list;
  try {
    list = JSON.parse(result.stdout);
  } catch (error) {
    return unknown('unreadable', error.message);
  }
  const valid = Array.isArray(list) && list.every((pr) => isPlainObject(pr) && Number.isInteger(pr.number)
    && typeof pr.title === 'string' && typeof pr.url === 'string' && typeof pr.createdAt === 'string');
  if (!valid) return unknown('unreadable', firstLine(result.stdout));
  const items = list
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, createdHuman: humanDayOf(pr.createdAt, tz) }))
    .sort((a, b) => a.number - b.number);
  return { ok: true, reason: null, detail: null, items, mayHaveMore: items.length >= GH_LIST_DEFAULT_LIMIT };
}

// The notes past their stale_after, over the same set `validate` judges.
function staleFacts(root, config, now, tz, { walkVault, listPublishable }) {
  const walked = walkVault(root, config, { all: true });
  const fileSet = noteFileSet(walked, listPublishable(root));
  if (fileSet.failure) return { ok: false, reason: 'listing_failed', count: null, notes: null };
  const files = fileSet.files.filter(isMarkdown);
  const stale = computeStale(files, { root, config, readFile: makeReadFile(root) }, now);
  const notes = stale.map((entry) => ({ path: entry.file, staleAfter: entry.staleAfter, staleAfterHuman: humanDayOf(entry.staleAfter, tz) }));
  return { ok: true, reason: null, count: notes.length, notes };
}

// The branch, how the default branch stands against its remote-tracking
// reference, and how many paths the working tree changes.
function gitFacts(root, env) {
  const facts = { branch: null, defaultBranch: null, upstream: null, ahead: null, behind: null, dirty: null, reason: null };
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'], { env });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { ...facts, reason: 'not_a_repository' };
  try {
    facts.branch = currentBranch(root, { env });
    facts.dirty = dirtyPaths(root, { env }).length;
    const found = defaultBranch(root, { env });
    if (found === null || found.bare === null) return { ...facts, reason: 'no_default_branch' };
    facts.defaultBranch = found.bare;
    const upstream = defaultBranchUpstream(root, found, { env });
    if (upstream.local || upstream.remote === null || upstream.branch === null) return { ...facts, reason: 'no_upstream' };
    const remotes = runGit(root, ['remote'], { env });
    if (remotes.status !== 0) return { ...facts, reason: `git_failed: ${firstLine(remotes.stderr)}` };
    if (!remotes.stdout.split('\n').includes(upstream.remote)) return { ...facts, reason: 'no_remote' };
    facts.upstream = `${upstream.remote}/${upstream.branch}`;
    const remoteRef = `refs/remotes/${upstream.remote}/${upstream.branch}`;
    const localRef = `refs/heads/${found.bare}`;
    if (resolveCommit(root, remoteRef, { env }) === null) return { ...facts, reason: 'no_remote_ref' };
    if (resolveCommit(root, localRef, { env }) === null) return { ...facts, reason: 'no_local_branch' };
    const { ahead, behind } = aheadBehind(root, localRef, remoteRef, { env });
    return { ...facts, ahead, behind };
  } catch (error) {
    return { ...facts, reason: `git_failed: ${firstLine(error.message)}` };
  }
}

function lockFacts(root, env) {
  try {
    const holder = describeLock(root, { env });
    return { held: holder !== null, command: holder === null ? null : (holder.command ?? null), reason: null };
  } catch (error) {
    return { held: null, command: null, reason: firstLine(error.message) };
  }
}

// `machine` is the vault's machine.json on this machine, or null; nothing
// in this task reads it (the question queue, wired in later, lives at its
// paths.questions_log). The last round is read where the curator writes
// it, `<stateDir>/last-run.json`.
export function briefingFacts({ root, config, machine = null, stateDir, now = new Date(), env = process.env, deps = {} }) {
  const run = deps.run ?? runCommand;
  const walkVault = deps.walkVault ?? realWalkVault;
  const listPublishable = deps.listPublishable ?? realListPublishable;
  const findExecutable = deps.findExecutable ?? realFindExecutable;
  const tz = config.vault.timezone;
  const today = localDay(now, tz); // a RangeError for a zone that is not one: the caller reports it
  const { lastRun, connectorStates } = lastRunFacts(stateDir, tz);
  return {
    today,
    todayHuman: humanDay(today),
    weekday: WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()],
    tz,
    lastRun,
    connectorStates,
    openPullRequests: pullRequestFacts(root, config, env, tz, { run, findExecutable }),
    stale: staleFacts(root, config, now, tz, { walkVault, listPublishable }),
    pending: pendingBuckets({ root, config, today, tz }),
    git: gitFacts(root, env),
    lock: lockFacts(root, env),
    questions: null,
  };
}
