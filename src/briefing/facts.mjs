// Every fact the morning briefing states, computed by the kit.
//
// Phase 4, layer 1: the briefing is a model writing to a person, and the
// one thing it must never do is state a date, a count or a deadline it
// worked out itself. So the kit computes them all here, deterministically,
// and the briefing's prompt hands them over as they are: today in the
// vault's time zone, the curator's last round and each source's state, the
// connector states carried from round to round, the pull requests waiting
// for a merge, the notes past their stale_after, the pending items by
// deadline, the working tree, the vault lock (and the legacy lock, when
// machine.json sets one) and the question queue.
//
// Every open pull request is listed, never a first page (ruling R-T1).
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
import { isMarkdown, makeReadFile } from '../commands/validate.mjs';
import { readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { isValidIsoDate } from '../dates.mjs';
import { aheadBehind, currentBranch, defaultBranch, defaultBranchUpstream, dirtyPaths, resolveCommit, runGit } from '../git.mjs';
import { describeLock } from '../guards/lock.mjs';
import { legacyLockSetting, probeLegacyLock } from '../guards/legacy-lock.mjs';
import { localDay } from '../guards/watermark.mjs';
import { findExecutable as realFindExecutable } from '../doctor/checks.mjs';
import { knownStates } from '../commands/curate.mjs';
import { ghEnvOf } from '../commands/propose.mjs';
import { vaultClock } from '../commands/prompt.mjs';
import { pendingBuckets } from './pending.mjs';
import { queueFile, queueSummary, questionLimits, readQueue } from './questions.mjs';

// Every open pull request, with no cap (ruling R-T1): `gh pr list` stops at
// 30 unless given a --limit, and any number there is a cap nobody asked
// for. `gh api --paginate` follows the API's next-page links until there
// are none, and exits non-zero when any page fails, so exit 0 means every
// page was read. {owner}/{repo} is filled by gh from the vault's own
// remote (or GH_REPO). The filter prints each pull request as one line of
// JSON (`tojson` makes it a string, which gh prints raw), whatever the
// page it came from.
export const PR_API_FILTER = '.[] | {number, title, url: .html_url, createdAt: .created_at} | tojson';
export const PR_LIST_ARGS = Object.freeze(['api', '--paginate', '--method', 'GET', 'repos/{owner}/{repo}/pulls?state=open', '--jq', PR_API_FILTER]);

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

// The open pull requests, every page of them, from `gh api` run in the vault.
function pullRequestFacts(root, config, env, tz, { run, findExecutable }) {
  const unknown = (reason, detail = null) => ({ ok: false, reason, detail, items: null });
  const name = typeof config.git?.pr_command === 'string' && config.git.pr_command !== '' ? config.git.pr_command : 'gh';
  const program = findExecutable(name, String(env.PATH ?? '').split(delimiter));
  if (program === null) return unknown('absent');
  const result = run(program, [...PR_LIST_ARGS], { cwd: root, env: ghEnvOf(env) });
  if (result.status !== 0) return unknown('failed', firstLine(result.stderr || result.stdout) || `exit ${result.status}`);
  const list = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      list.push(JSON.parse(line));
    } catch (error) {
      return unknown('unreadable', `${error.message}: ${firstLine(line)}`);
    }
  }
  const valid = list.every((pr) => isPlainObject(pr) && Number.isInteger(pr.number)
    && typeof pr.title === 'string' && typeof pr.url === 'string' && typeof pr.createdAt === 'string');
  if (!valid) return unknown('unreadable', firstLine(result.stdout));
  const items = list
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, createdHuman: humanDayOf(pr.createdAt, tz) }))
    .sort((a, b) => a.number - b.number);
  return { ok: true, reason: null, detail: null, items };
}

// A datetime carrying its offset (Z or +hh:mm): one without it would be
// read in the machine's zone, which is no zone of the vault's.
const INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

// When a stale_after has come, in the vault's zone (ruling R-T3): a plain
// YYYY-MM-DD is a civil date, due on that day in the vault's zone, and is
// shown as written; a datetime with an offset is an instant, due at that
// instant, and is shown as the vault's day it falls on. `{ stale, human }`,
// or null for a value that is neither (validate's spec rules report it).
// validate's own computeStale reads a plain date as UTC midnight, a day
// early behind UTC; it is left as it is (parked for the backlog), and the
// briefing states only what this function decides.
export function staleVerdict(staleAfter, { today, now, tz }) {
  if (typeof staleAfter !== 'string') return null;
  if (isValidIsoDate(staleAfter)) return { stale: staleAfter <= today, human: humanDay(staleAfter) };
  if (!INSTANT_WITH_OFFSET.test(staleAfter)) return null;
  const at = new Date(staleAfter);
  if (Number.isNaN(at.getTime())) return null;
  return { stale: at.getTime() <= now.getTime(), human: humanDay(localDay(at, tz)) };
}

// The notes past their stale_after, over the same set `validate` judges. A
// note that cannot be read is named in `unreadable` with its error code
// (fix round 1 of task 3, ruling R-T8): whether it is past its stale_after
// is not known, and one such note never stops the rest from being judged.
function staleFacts(root, config, now, today, tz, { walkVault, listPublishable }) {
  const walked = walkVault(root, config, { all: true });
  const fileSet = noteFileSet(walked, listPublishable(root));
  if (fileSet.failure) return { ok: false, reason: 'listing_failed', count: null, notes: null, unreadable: null };
  const readFile = makeReadFile(root);
  const notes = [];
  const unreadable = [];
  for (const path of fileSet.files.filter(isMarkdown).sort()) {
    let text;
    try {
      text = readFile(path);
    } catch (error) {
      unreadable.push({ path, detail: error.code ?? firstLine(error.message) });
      continue;
    }
    const staleAfter = readScalar(splitFrontmatter(text).frontmatter, 'stale_after');
    const verdict = staleVerdict(staleAfter, { today, now, tz });
    if (verdict !== null && verdict.stale) notes.push({ path, staleAfter, staleAfterHuman: verdict.human });
  }
  return { ok: true, reason: null, count: notes.length, notes, unreadable };
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

// The question queue as the briefing shows it (src/briefing/questions.mjs):
// every open question, those escalated and those due for archiving, by the
// vault's limits (questionLimits: a key left out is the pack's default, an
// explicit null is never), and every line of the file that could not be
// read, which is shown and never hidden. A queue that cannot be read at all
// is `ok: false` with the reason, never an empty queue.
function questionFacts(stateDir, config, today, env) {
  const { escalateAfter, maxAgeDays } = questionLimits(config);
  let file = null;
  try {
    file = queueFile(stateDir, { env });
    const summary = queueSummary(readQueue(stateDir, { env }), { today, escalateAfter, maxAgeDays });
    return { ok: true, reason: null, file, escalateAfter, maxAgeDays, ...summary };
  } catch (error) {
    return { ok: false, reason: firstLine(error.message), file, escalateAfter, maxAgeDays, open: null, escalated: null, toArchive: null, corrupt: null };
  }
}

// The vault lock, and the legacy lock when the vault's machine.json sets
// one (src/guards/legacy-lock.mjs). `held`, `command` and `reason` are the
// vault lock's alone. `legacy` is null with the bridge off; otherwise the
// file and its state right now, probed exactly as the Stop hook probes it
// (without waiting, never creating the file): 'held' when another process
// holds it, 'free' when none does, 'unusable' when no writer can take it,
// with the writers' own refusal as `reason` ({ messageKey, params }). A
// legacy lock another process holds is never reported free, whatever the
// vault lock says.
function lockFacts(root, env, stateDir) {
  let vault;
  try {
    const holder = describeLock(root, { env });
    vault = { held: holder !== null, command: holder === null ? null : (holder.command ?? null), reason: null };
  } catch (error) {
    vault = { held: null, command: null, reason: firstLine(error.message) };
  }
  return { ...vault, legacy: legacyFacts(stateDir, env) };
}

function legacyFacts(stateDir, env) {
  const setting = legacyLockSetting(stateDir);
  if (setting.state === 'off') return null;
  if (setting.state === 'invalid') return { file: null, state: 'unusable', reason: { messageKey: setting.messageKey, params: setting.params } };
  const probed = probeLegacyLock(setting.file, { env });
  if (probed.state === 'unusable') return { file: setting.file, state: 'unusable', reason: { messageKey: probed.messageKey, params: probed.params } };
  return { file: setting.file, state: probed.state, reason: null };
}

// `machine` is the vault's machine.json on this machine, or null; nothing
// here reads it directly (the question queue finds its own
// paths.questions_log through queueFile). The last round is read where the
// curator writes it, `<stateDir>/last-run.json`.
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
    stale: staleFacts(root, config, now, today, tz, { walkVault, listPublishable }),
    pending: pendingBuckets({ root, config, today, tz }),
    git: gitFacts(root, env),
    lock: lockFacts(root, env, stateDir),
    questions: questionFacts(stateDir, config, today, env),
  };
}
