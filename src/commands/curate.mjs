// The `curate` command: one scheduled curator round.
//
//   brain-kit curate [dir] [--dry] [--check] [--keep-stream]
//
// It ties phase 2 together in a FIXED order, each step's side effect being
// what test/curate.test.mjs observes (docs/superpowers/plans/
// 2026-09-24-phase-2-scheduled-curator.md, task 6):
//
//    1. find the vault and load machine.json; missing or invalid: exit 2
//    2. --dry: print what the round would do and exit 0, taking no lock and
//       writing no state; the configuration is read from the working tree
//       as it is, unsynced, and the output says so (ruling R4). When the
//       round would refuse over a source it cannot do without (a required
//       source unknown, off, or with nothing to read: exit 1), --dry says
//       so in words, with the round's own sentence, and exits 1 too
//    3. take the vault lock; held: exit 75 naming the holder
//    4. wait for the network; none: exit 69 (did_not_wait is a note, R14)
//   4b. an index.lock that cannot belong to a live git command (empty, over
//       10 minutes old, no operation half done, a clean tree) is moved aside,
//       never deleted, and the move is recorded in the round's `repairs`;
//       any other lock stays, and this step never ends the round
//       (incident 06/10/2026)
//    5. sync in process, under the round's lock; diverged: 75; failed: 1
//    6. only now load the configuration and check the prompt it names and
//       the allow rules it adds (one that grants a path or command tool
//       with no scope: exit 2), so a synced configuration is what runs
//       (incident 14/09/2026)
//    7. the window from the watermark; a mark in the future: exit 1 naming
//       `brain-kit watermark reopen`; nothing open: exit 0
//    8. a dirty tree: exit 75 naming every file
//    9. the round's own snapshot
//   10. the CLI is a real program; not: exit 1, after reinstalling a launcher
//       stub an npm install left behind when it is safe to (src/guards/
//       cli-repair.mjs, incident 14/09/2026), the repair recorded in `repairs`
//   11. collect the sources, each over its own days (its open days after
//       its own mark, its own oldest seven, phase 3 decision D5 and ruling
//       C1 of task 5's review; the round's window is their union); a
//       listed source that is off is
//       recorded (said when it is half configured, ruling R-E1; exit 1 when
//       it is required); a required source misconfigured: exit 1 and no
//       mark moves; a required source listing a file it cannot read, or a
//       first open day with more transcripts than the cap: exit 4 before
//       the model, no mark moves; days past the cap are deferred and the
//       window ends at the last covered day; nothing in the window:
//       advance vacuously and exit 0 (never a source whose plan found
//       nothing to read because nothing is there: it failed, and keeps
//       its day open even as a best-effort source, ruling R-A9); the
//       transcripts plan carries a digest of each kept transcript, built in
//       memory, and the model is granted those digests, never the
//       transcripts (01/10/2026); the days the digests cannot hold whole
//       are deferred like the cap's, and said, and so, in the round's
//       reason, is a digest cut (fix round 1); a digest folder whose path
//       no read rule can name: exit 1 before the model
//   12. the launch mode (decisions D1 and D3): with a connector source to
//       read, the person's user settings are read and mirrored; connector
//       mode unless a rule refuses it (every connector source is then
//       blocked_by_user_rules, and the round runs isolated); --check: print
//       the plan, the mode, the round's limits, the privacy policy in effect
//       (one line, as --dry and the round print it) and the prompt's size,
//       exit 0
//   13. write the digests (mode 0600, in a folder of mode 0700 under the
//       state directory, src/state.mjs DIGEST_DIR; beside the stream in the
//       log folder with --keep-stream), saying each one cut short; then
//       run the model, with no --max-budget-usd when curate.budget_usd is
//       null (roundBudget), no --max-turns when curate.max_turns is null
//       (roundTurns), and killed after curate.timeout_minutes when that is
//       a number, never otherwise (roundTimeoutMinutes: exit 1, timed_out);
//       an init event that fails the isolation check
//       of its mode kills it at once: exit 1; in connector mode, an init
//       event where a connector source is not there (decision D4, ruling
//       R-B1) kills it before its first turn, and the round launches once
//       more without those sources, never twice
//   14. read evidence, the sources line and the round record
//   15. bring what the round proposed back to HEAD's content, byte-proved
//   16. the exit code, first match wins: isolation 1; an expired login 69
//       (auth_expired, the reason saying to log in again with /login); a
//       spent usage limit 75 (usage_limited, the reason saying when it
//       resets); another model failure 69 or 1; a required source unread
//       4; a round record that cannot be read 1; anything still dirty 1; a
//       proposal not opened 3; otherwise 0. A best-effort source never changes it.
//   17. advance each source's watermark through its own last day, only on
//       0 or 3
//   18. always: remove the round record and the round's digests (unless
//       the stream is kept), write last-run.json, append the log, release
//       the lock (the model's process group already dead) and run
//       machine.notify_command on any non-zero exit, and once when a
//       best-effort connector source's state changed since the last round.
//       Digests a round killed outright left behind are removed by the next
//       round, as soon as it holds the lock
//
// The log (logs/curate-<date>.log in the state directory) holds one line
// per event, never a tool result, the model's final text or anything read
// from a transcript (a digest's text included: only how many digests were
// written and each cut's counts), and never the round's token. What the CLI itself said
// on a failed run goes in the reason (step 16): the last line of its
// standard error, and the start of an error result's text, its own word on
// why the run ended. --check and --dry write no last-run.json: a round that
// did not run the model is not a round a reader of last-run should take for
// one.
//
// `deps` carries the environment, the working directory, the clock, the
// network wait's timing, a step observer, the round's kill timer
// (`roundTimeoutMs`, which overrides curate.timeout_minutes) and a wrapper
// for the model's launcher (`runModel`, handed the very options the real
// one gets, so a test can see that no kill timer is armed), for the tests.
// Production passes nothing.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, constants as osConstants } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isWindows, withPathPrefix } from '../platform.mjs';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, ConfigError, MACHINE_FILENAME, loadConfig, loadMachine } from '../config.mjs';
import { createTranslator, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { ensureStateDir, stateDirFor, STATE_FILES } from '../state.mjs';
import { dirtyPaths } from '../git.mjs';
import { expandHome } from '../doctor/checks.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { waitForNetwork } from '../guards/network.mjs';
import { moveOrphanIndexLock } from '../guards/index-lock.mjs';
import { checkDirtyTree } from '../guards/dirty-tree.mjs';
import { takeSnapshot } from '../guards/snapshot.mjs';
import { checkCli } from '../guards/cli.mjs';
import { repairStub } from '../guards/cli-repair.mjs';
import { checkIsolation } from '../guards/isolation.mjs';
import { connectorStateMessage, connectorStates } from '../guards/connectors.mjs';
import { evidenceFor, unreadRequired } from '../guards/read-evidence.mjs';
import { emptyWindow } from '../guards/empty-window.mjs';
import {
  addDays, advanceWatermark, DEFAULT_MAX_DAYS, localDay, parseSourcesLine, readWatermark, SOURCES_LINE_PREFIX, startOfDay, windowFor, WatermarkError,
} from '../guards/watermark.mjs';
import { buildArgv, runModel, unscopedRules } from '../harness/claude-code.mjs';
import { errorText, isLoginFailure } from '../harness/stream.mjs';
import { allowedTools, disallowedTools, KIT_SUBCOMMANDS, kitCommand } from '../curate/tools.mjs';
import { unsafeRuleCharacters } from '../curate/rule-path.mjs';
import { blockingMessage, mirrorUserRules, userSettingsFiles } from '../curate/user-rules.mjs';
import { SOURCES } from '../sources/index.mjs';
import { VAULT_PROJECT, waitingProjectName, writeDigests } from '../sources/transcripts-claude-code.mjs';
import { syncUnderLock } from './sync.mjs';
import { parseRoundRecord, roundRecordPath } from './propose.mjs';
import { proposedMatch, restoreMatching } from '../guards/proposed.mjs';
import { promptOutsideVault, renderCuratePrompt } from './prompt.mjs';
import { privacyLine } from '../privacy-policy.mjs';

const ROOT_INDEX = 'index.md';

// Used only when the configuration leaves the key out (ruling R10: a round
// the owner said nothing about runs bounded). A key set to null is not
// leaving it out: it is the owner asking for no cap at all (phase 5a,
// rulings R-A1 and R-A3), and the round then passes no --max-budget-usd
// (roundBudget) or no --max-turns (roundTurns).
const FALLBACK_MAX_TURNS = 100;
const FALLBACK_BUDGET_USD = 5;
// The settings of the round's limits, as a person finds them.
const BUDGET_SETTING = `${CONFIG_FILENAME} curate.budget_usd`;
const TURNS_SETTING = `${CONFIG_FILENAME} curate.max_turns`;
const TIMEOUT_SETTING = `${CONFIG_FILENAME} curate.timeout_minutes`;
const NOTIFY_TIMEOUT_MS = 30000;
// The setting a vault adds allow rules with, as a person finds it.
const ALLOWED_EXTRA_SETTING = `${CONFIG_FILENAME} curate.allowed_tools_extra`;
// What the CLI says when the model's usage limit is spent (30/09/2026: "You've
// hit your weekly limit", then the hour it resets). ASCII only: the measured
// text, with its middle dot, lives in test/fixtures/stream/usage-limit.jsonl.
export const USAGE_LIMIT_PATTERNS = Object.freeze([/hit your [a-z ]*limit/i, /usage limit/i]);
const API_ERROR = /API Error|\b401\b|authentication/i;
const API_MARKERS = Object.freeze([/API Error/i, /\b401\b/, /authentication/i]);

// Every signal that would end curate is caught and handled the same way:
// the model's process group is killed, last-run names the signal, the lock
// is released, notify runs, exit 1. The model runs detached (its own
// session), so a terminal's hangup no longer reaches it: without this, a
// SIGHUP or SIGQUIT left the model running with the round's token after
// the round and its lock were gone (review findings I2, I3). A SIGKILL of
// curate cannot be handled: the model then keeps running, and the lock is
// reclaimed as stale only once the model has exited. The rarer signals
// whose default action ends a Node process are handled the same way
// (SIGPWR exists on Linux, not on macOS, so it is listed only where the
// platform has it); SIGUSR1 is left alone, Node reserves it for its
// inspector.
const FORWARDED_SIGNALS = Object.freeze([
  'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR2', 'SIGALRM', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGPWR',
].filter((signal) => Object.hasOwn(osConstants.signals, signal)));

// The sources this version can read (src/sources/index.mjs), by the id the
// configuration names them with. A configured id missing here is refused
// when required and skipped, loudly, when best effort.
export { SOURCES };

// The connector states that stop a source for the round (decision D4): on
// the init event of the first launch, any of them kills the model before
// its first turn, and the round launches once more without that source.
// `pending` is not one (ruling R-B1): a connector still connecting when the
// session started stays in the round, and its evidence decides.
export const RELAUNCH_STATES = Object.freeze(['needs_auth', 'failed', 'absent', 'tools_missing', 'unknown']);

// The state of a connector source whose tools a user rule of the person's
// would widen or deny (decision D3).
export const BLOCKED_BY_USER_RULES = 'blocked_by_user_rules';

// Why the meeting notes are not offered in a round whose calendar, though
// configured, is not read (ruling I2 of the final review): their day could
// not close without the calendar's listing over it (SECOND_DOOR), so the
// model is given no work on them at all, and no round distils the same
// notes again and again while the calendar stays away.
export const WAITING_FOR_CALENDAR = 'waiting_for_calendar';

// The guide a changed connector state points the person to.
const CONNECTORS_DOC = 'docs/connectors.md';

// The limits a source may reach inside one round, by the source they bound
// (ruling R-D1): the model distils up to them, lists the rest by literal
// title in the log as not distilled this round, and reports the source
// `partial`, which never moves a mark, so the day stays open and the next
// round goes on. Each names the keys under curate.caps and the line the
// parameters give the model about them.
const SOURCE_CAPS = Object.freeze({
  meeting_notes: Object.freeze({ keys: Object.freeze(['search_docs_opened', 'attached_notes_opened']), message: 'curate.params.meeting_notes_caps' }),
});

// The states the model may write for a source in its last line: what every
// source can be, `partial` for a source with a limit of its own, and
// `unavailable` for a source reached through a connector, which may be
// missing from the session.
export function lineStates(source) {
  return [
    'ok', 'empty',
    ...(Object.hasOwn(SOURCE_CAPS, source.id) ? ['partial'] : []),
    'failed',
    ...(source.kind === 'connector' ? ['unavailable'] : []),
  ];
}

// Every state a last line may hold. Anything else the model writes after
// `<id>=` is recorded as `invalid`, never as written: the round's log and
// last-run hold no text of the model's (ruling I1 of task 5's review).
export const LINE_STATES = Object.freeze(['ok', 'empty', 'failed', 'unavailable', 'partial']);

function reportedOf(sourcesLine, id) {
  if (sourcesLine === null || !Object.hasOwn(sourcesLine, id)) return null;
  return LINE_STATES.includes(sourcesLine[id]) ? sourcesLine[id] : 'invalid';
}

// The last line for a round that offers `sources`, in their order.
export function sourcesLineFor(sources) {
  return `${SOURCES_LINE_PREFIX} ${sources.map((source) => `${source.id}=<${lineStates(source).join('|')}>`).join(' ')}`;
}

function parseArgs(argv) {
  const result = { dir: undefined, dry: false, check: false, keepStream: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--dry') result.dry = true;
    else if (arg === '--check') result.check = true;
    else if (arg === '--keep-stream') result.keepStream = true;
    else if (arg.startsWith('-') || result.dir !== undefined) return { error: 'argument', arg };
    else result.dir = arg;
  }
  if (result.dry && result.check) return { error: 'argument', arg: '--check' };
  return result;
}

// DD/MM/YYYY, for a person.
function shown(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// The command that reopens a source's mark from `day` on.
function reopenCommand(source, day) {
  return `brain-kit watermark reopen ${source} ${day}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// A file written in full to a private sibling and renamed into place.
function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// The sources this round runs, the listed ones that are off, and the
// configured ids it cannot read. A listed source runs only when it is
// configured (a source with no isConfigured always is): a connector source
// is off until the person names what it reads (decision D6). `active` is
// also what `watermark import` calls the enabled sources.
export function sourcesOf(config) {
  const required = [...new Set(config.curate?.sources?.required ?? [])];
  const bestEffort = [...new Set(config.curate?.sources?.best_effort ?? [])].filter((id) => !required.includes(id));
  const known = [...required, ...bestEffort].filter((id) => Object.hasOwn(SOURCES, id)).map((id) => SOURCES[id]);
  const configured = (source) => {
    if (typeof source.isConfigured !== 'function') return true;
    try {
      return source.isConfigured(config) === true;
    } catch {
      return false;
    }
  };
  return {
    required,
    active: known.filter(configured),
    off: known.filter((source) => !configured(source)),
    unknownRequired: required.filter((id) => !Object.hasOwn(SOURCES, id)),
    unknownBestEffort: bestEffort.filter((id) => !Object.hasOwn(SOURCES, id)),
  };
}

// Why a listed source is off: the problems its own plan names, from a plan
// collected over an empty window (a connector source's collect reads
// nothing, it only says what stands in the way). This and offOnPurpose are
// also what doctor's `connectors` check says about a source that is off.
export function offProblems(source, config, now, tz) {
  try {
    const plan = source.collect({ window: { from: now, to: now, days: [], timezone: tz }, config, now });
    return Array.isArray(plan?.problems) ? plan.problems.filter((p) => p !== null && typeof p === 'object' && typeof p.code === 'string') : [];
  } catch (error) {
    return [{ code: 'collect_failed', detail: error instanceof Error ? error.message : String(error) }];
  }
}

// A listed source that is off on purpose (its settings say enabled: false,
// or its own problems say it is disabled) is only recorded in last-run;
// one that is off for any other reason is half configured, and the round
// says so (ruling R-E1): a best-effort source is never dropped in silence.
export function offOnPurpose(source, config, problems) {
  return config?.sources?.[source.id]?.enabled === false || problems.some((p) => p.code === 'disabled');
}

// The second door of the meeting notes (docs/incidents.md, 11/08/2026):
// the documents attached to the events of a day, reached only through a
// listing of the calendar over that day in the same round. While the
// calendar is configured, a meeting-notes day closes only when the calendar
// was read over it in that round (ruling I2 of task 5's review), so the
// calendar is offered every day the meeting notes still have open, those it
// already closed included ("relisted": listed again for their attachments
// only). That listing is one window, from the first day of either source to
// the last of either, and it keeps the seven-day cap of every source (final
// review M2): past it, the oldest seven are listed, and the meeting-notes
// days beyond them wait for a later round with the calendar's own. While
// the calendar is configured but not read in a round (unavailable,
// blocked, or not offered), the meeting notes are not offered at all
// (WAITING_FOR_CALENDAR).
export const SECOND_DOOR = Object.freeze({ source: 'meeting_notes', through: 'calendar' });

// The round's window: the union of the sources' own days, from the first
// instant of the first one to the end of the last one. `remaining` is the
// largest number of open days a source leaves for a later round.
function unionWindow(days, remaining, now, tz) {
  const all = [...new Set(Object.values(days).flat())].sort();
  if (all.length === 0) {
    const today = startOfDay(localDay(now, tz), tz);
    return { days: [], from: today, to: today, remaining: 0 };
  }
  return { days: all, from: startOfDay(all[0], tz), to: startOfDay(addDays(all.at(-1), 1), tz), remaining: Math.max(0, ...Object.values(remaining)) };
}

// Each source's own days (decision D5, ruling C1 of task 5's review): its
// open days after its own mark (an unset mark reads only yesterday),
// oldest first, at most DEFAULT_MAX_DAYS of them, each source clipped on
// its own; `remaining[id]` counts the newer open days it leaves for the
// next round. A source that cannot move its mark therefore never takes a
// day from another. The round's window is their union. A mark later than
// yesterday on any source is the error state windowFor reports as
// `future`.
function computeWindow(stateDir, sources, now, tz) {
  const mark = readWatermark(stateDir);
  const yesterday = addDays(localDay(now, tz), -1);
  // windowFor's own verdict on each source's mark, never a second
  // comparison here that could disagree with it (review finding I4).
  for (const source of sources) {
    const day = mark.sources[source.id];
    if (day !== undefined && windowFor(day, now, tz).future) return { future: { source: source.id, day, yesterday } };
  }
  const days = {};
  const remaining = {};
  for (const source of sources) {
    const own = windowFor(mark.sources[source.id] ?? addDays(yesterday, -1), now, tz);
    days[source.id] = own.days;
    remaining[source.id] = own.remaining;
  }
  // The calendar also covers every day the meeting notes have open, as one
  // listing: from the first of either to the last of either.
  let relisted = [];
  const notes = SECOND_DOOR.source;
  const cal = SECOND_DOOR.through;
  if (Object.hasOwn(days, notes) && Object.hasOwn(days, cal) && days[notes].length > 0) {
    const both = [...days[notes], ...days[cal]].sort();
    const range = [];
    for (let day = both[0]; day <= both.at(-1) && range.length < DEFAULT_MAX_DAYS; day = addDays(day, 1)) range.push(day);
    const last = range.at(-1);
    const later = days[notes].filter((day) => day > last);
    days[notes] = days[notes].filter((day) => day <= last);
    remaining[notes] += later.length;
    const calMark = mark.sources[cal];
    // The calendar's open days after the listing's last: its own after its
    // mark (only yesterday while unset), those the listing did not reach.
    let open = 0;
    const first = calMark === undefined ? yesterday : addDays(calMark, 1);
    for (let day = first > last ? first : addDays(last, 1); day <= yesterday; day = addDays(day, 1)) open += 1;
    remaining[cal] = open;
    relisted = range.filter((day) => calMark !== undefined && day <= calMark);
    days[cal] = range;
  }
  return { window: unionWindow(days, remaining, now, tz), days, remaining, relisted, marks: mark.sources };
}

// Each source collected over its own window: from the start of its first
// day to the end of its last, with its own days. A source with no day in
// the round is never collected. `digestDir` is where the transcripts
// source names its digests (built in memory; writeDigests writes them).
function collectPlans(sources, days, config, machine, env, now, tz, digestDir, root) {
  const plans = {};
  const home = env.HOME || undefined;
  // The listed project that may have no folder yet (the vault's own), the
  // same answer `doctor` reads: a project with no sessions, not a
  // misconfiguration. Only the transcripts source reads it. That source is
  // also handed the vault's folder, whose project the entry {vault} of
  // include_projects stands for.
  const waiting = waitingProjectName({ vaultRoot: root, machine, env });
  for (const source of sources) {
    const own = days[source.id];
    plans[source.id] = source.collect({ window: { from: startOfDay(own[0], tz), to: startOfDay(addDays(own.at(-1), 1), tz), days: own, timezone: tz }, config, machine, now, digestDir, waiting, vaultRoot: root, ...(home ? { home } : {}) });
  }
  return plans;
}

// The instant of a round as its kept files name it: the stream's
// `curate-<stamp>.stream.jsonl`, and its kept digests.
function roundStamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

// The folder one round's digests go in (src/state.mjs, DIGEST_DIR): one of
// its own under digests/, removed when the round ends; with the stream
// kept, beside it in logs/ (`curate-<stamp>-<hex>.digests`), where the
// logs' retention removes it with the stream. The random part keeps two
// rounds of the same instant apart.
function digestDirFor(stateDir, now, keep) {
  const id = `${roundStamp(now)}-${randomBytes(4).toString('hex')}`;
  return keep ? join(stateDir, STATE_FILES.LOG_DIR, `curate-${id}.digests`) : join(stateDir, STATE_FILES.DIGEST_DIR, id);
}

// What a round killed outright (SIGKILL, a power cut) left in DIGEST_DIR,
// removed by the next round as soon as it holds the vault lock: no round
// is running then, so no folder there is any round's own. Only what bears
// a round's own name (ROUND_DIGEST_DIR) is removed; anything else there is
// left as it is. A DIGEST_DIR that is a link or a file is removed itself,
// never followed: the round would otherwise write its digests through it.
const ROUND_DIGEST_DIR = /^[0-9TZ-]+-[0-9a-f]{8}$/;

function sweepDigests(stateDir) {
  const dir = join(stateDir, STATE_FILES.DIGEST_DIR);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) {
    rmSync(dir, { force: true });
    return 1;
  }
  const names = readdirSync(dir).filter((name) => ROUND_DIGEST_DIR.test(name));
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  return names.length;
}

// The days a source with a whole-day cap (plan.daysCovered, C1 of the
// phase 2 final review) leaves for the next round: its own days end at its
// last covered day, and no other source's days change (ruling C1 of task
// 5's review: that cap bounds only its own source). Returns one entry per
// capped source: { source, last, deferred, cap }.
function capDays(offered, plans, days) {
  const out = [];
  for (const source of offered) {
    const covered = plans[source.id]?.daysCovered;
    if (!Array.isArray(covered) || covered.length === 0 || covered.length >= days[source.id].length) continue;
    const deferred = days[source.id].filter((day) => !covered.includes(day));
    days[source.id] = days[source.id].filter((day) => covered.includes(day));
    // Which of them a digest could not hold whole (fix round 1, ruling
    // R-D2), and which the cap left: each is said in its own words.
    const byDigest = deferred.filter((day) => (plans[source.id].digestDeferred ?? []).includes(day));
    const byCap = deferred.filter((day) => !byDigest.includes(day));
    out.push({ source, last: days[source.id].at(-1), deferred, byCap, byDigest, sessions: plans[source.id].digestLimitedBy ?? [], cap: plans[source.id].cap });
  }
  return out;
}

// How many files a local source's plan offers, for the report; null for a
// plan that lists none (a connector source's).
function keptOf(plan) {
  return Array.isArray(plan?.files) ? plan.files.length : null;
}

// What the round records about a source before the model runs.
function sourceEntry(source, plan) {
  if (source.kind === 'local') return { kept: keptOf(plan) ?? 0, read: 0, advanced: false, noTimestamp: plan.dropped?.noTimestamp ?? 0 };
  return { state: null, observedPrefix: null, read: 0, expected: null, listed: null, advanced: false, reported: null, ...(source.id === 'meeting_notes' ? { documents: null } : {}) };
}

// What the plan log line says about a source.
function planLogOf(source, plan, days) {
  if (source.kind === 'local') return { kept: keptOf(plan), dropped: plan.dropped };
  return { days, problems: (plan.problems ?? []).map((p) => p.code) };
}

// curate.network_min_wait_ms, read before the round's lock and sync (the
// network wait comes first, step 4) from the configuration as it is in the
// working tree: only a threshold for a note, never a decision, so an
// unsynced or unreadable file just leaves the default.
function networkMinWait(root) {
  try {
    const value = loadConfig(root).curate?.network_min_wait_ms;
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// The setting a person fixes for each misconfiguration code. The vault's own
// project missing under the entry {vault} is the folder Claude Code keeps its
// projects in, never a name in the shared configuration: the entry is right on
// every machine, the folder it is looked for in is this machine's.
function settingFor(code) {
  if (code === 'root_missing' || code === 'root_unreadable' || code === 'own_project_missing') return 'machine.json transcripts_dir';
  return `${CONFIG_FILENAME} sources.transcripts.include_projects`;
}

export function problemText(problems) {
  return problems.map((p) => (p.detail ? `${p.code} (${p.detail})` : p.code)).join(', ');
}

// What a source's problems read as: the plan's own sentences in the vault's
// language when it has them (the transcripts source's), else the codes.
function problemWords(plan) {
  return Array.isArray(plan.problemLines) && plan.problemLines.length > 0 ? plan.problemLines.join(' ') : problemText(plan.problems);
}

// The three things a round refuses over, for a source it cannot do without,
// in one place: the round says them and exits with the code
// (REQUIRED_SOURCE_EXIT), and `--dry` says the same sentences and exits with
// the same code. `problems` is what names the problems: the round writes the
// codes (its log and last-run keep them), --dry writes them in words.
const REQUIRED_SOURCE_EXIT = EXIT.FAILURE;

function unknownRequiredText(t, ids) {
  return t('curate.source_unknown', { sources: ids.join(', '), setting: `${CONFIG_FILENAME} curate.sources.required` });
}

function offRequiredText(t, source, problems) {
  return t('curate.source_misconfigured', { source: source.id, setting: `${CONFIG_FILENAME} sources.${source.id}`, problems: problemText(problems) || '-' });
}

function misconfiguredText(t, source, plan, problems) {
  const codes = plan.problems.filter((p) => ['no_projects', 'root_missing', 'root_unreadable', 'project_missing', 'own_project_missing', 'vault_unnamed'].includes(p.code));
  const setting = settingFor(codes[0]?.code ?? 'no_projects');
  const text = t('curate.source_misconfigured', { source: source.id, setting, problems });
  // A name written out that is not there may be another machine's project: the
  // way out is the entry that is the vault's own on every machine.
  return plan.problems.some((p) => p.code === 'project_missing') ? `${text} ${t('sources.transcripts.use_vault_token', { token: VAULT_PROJECT })}` : text;
}

// What a round would refuse over, in its own order and with its own
// sentences: { text } or null. The round does not call this (it refuses
// where it stands, after the steps before it that log and write); --dry
// does, and so cannot say "ok" over a round that stops.
function requiredRefusal(t, { config, now, tz, required, unknownRequired, off, offered, plans }) {
  if (unknownRequired.length > 0) return { text: unknownRequiredText(t, unknownRequired) };
  for (const source of off) {
    if (required.includes(source.id)) return { text: offRequiredText(t, source, offProblems(source, config, now, tz)) };
  }
  for (const source of offered) {
    const plan = plans[source.id];
    if (plan.misconfigured && required.includes(source.id)) return { text: misconfiguredText(t, source, plan, problemWords(plan)) };
  }
  return null;
}

// The parameters block. Each source the round offers gets its own section:
// its days when they are not the round's, a line about the connector it is
// read through, its plan's prompt block, and the limits it may reach. A
// source unavailable this round (`unavailable`, id -> state) gets one line
// instead, saying so with its state and forbidding any other way to it; a
// source whose connector was still connecting at the round's first launch
// (`pending`, a set of ids) is told so on a relaunch (ruling R-B1).
function renderParameters(t, { window, tz, plans, sources, days, config, deferred, unavailable = new Map(), pending = new Set(), relisted = [] }) {
  const lines = [];
  lines.push(t('curate.params.days', { days: window.days.map(shown).join(', '), timezone: tz }));
  lines.push(t('curate.params.window', { from: window.from.toISOString(), to: window.to.toISOString() }));
  if (deferred.length > 0) lines.push(t('curate.params.deferred', { count: deferred.length, days: deferred.map(shown).join(', ') }));
  if (window.remaining > 0) lines.push(t('curate.params.remaining', { count: window.remaining }));
  for (const source of sources) {
    lines.push('');
    lines.push(t('curate.params.source', { source: source.id }));
    if (unavailable.has(source.id)) {
      lines.push(t('curate.params.unavailable', { source: source.id, state: unavailable.get(source.id) }));
      continue;
    }
    const own = days[source.id];
    if (own.length !== window.days.length) {
      lines.push(t('curate.params.source_days', { days: own.map(shown).join(', '), from: startOfDay(own[0], tz).toISOString(), to: startOfDay(addDays(own.at(-1), 1), tz).toISOString() }));
    }
    if (source.kind === 'connector') {
      lines.push(t('curate.params.connector', { source: source.id, connector: source.serverSpec(config).serverDisplayName }));
      if (pending.has(source.id)) lines.push(t('curate.params.pending', { source: source.id }));
    }
    const again = source.id === SECOND_DOOR.through ? own.filter((day) => relisted.includes(day)) : [];
    if (again.length > 0) lines.push(t('curate.params.relisted', { days: again.map(shown).join(', '), notes: SECOND_DOOR.source }));
    lines.push(plans[source.id].promptBlock);
    const caps = SOURCE_CAPS[source.id];
    if (caps !== undefined) {
      const values = caps.keys.map((key) => config.curate?.caps?.[key]);
      if (values.every((value) => Number.isInteger(value) && value >= 0)) lines.push(t(caps.message, { source: source.id, search: values[0], attached: values[1] }));
    }
  }
  lines.push('');
  // The privacy policy in effect, in one line (02/10/2026): what the rule
  // `third-party-privacy` spells out in full, said here too so the round's
  // own output and its prompt name the same setting.
  lines.push(privacyLine(config, t));
  const caps = Object.entries(config.curate?.caps ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
  lines.push(t('curate.params.caps', { caps: caps === '' ? '-' : caps }));
  lines.push(t('curate.params.kit', { kit: kitCommand() }));
  return lines.join('\n');
}

// The files outside the vault the model may read: the digest of every file
// a local source's plan lists, each one by its exact path (ruling R-A2 of
// 24/09/2026), never its folder, and never the transcript itself
// (01/10/2026: least privilege; the model is handed the digest), so a
// session the plan left out stays unreadable, and so does every one it
// kept.
function readFilesOf(sources, plans) {
  return sources.filter((source) => source.kind === 'local')
    .flatMap((source) => (plans[source.id]?.files ?? []).map((file) => file.digest?.path).filter((path) => typeof path === 'string'));
}

// What a round grants the model to read outside the vault: the digests
// one by one (readFilesOf), except on Windows when one rule per digest
// would not fit on a command line. Windows caps a process's whole command
// line at 32 767 characters, and a week of catching up can list a few
// hundred digests at some 120 characters each: past the bound, the round
// would not even start. There the round grants each plan's digest folder
// instead, which holds nothing but the digests of the files that plan
// lists (written by the round itself, in a folder named for the round), so
// the grant reaches the same files.
export const WINDOWS_READ_RULES_BUDGET = 16000;

export function readGrantsOf(sources, plans, platform = process.platform) {
  const readFiles = readFilesOf(sources, plans);
  const cost = readFiles.reduce((sum, path) => sum + path.length + 12, 0);
  if (!isWindows(platform) || cost <= WINDOWS_READ_RULES_BUDGET) return { readFiles, readDirs: [] };
  const readDirs = [...new Set(sources.filter((source) => source.kind === 'local').map((source) => plans[source.id]?.digestDir).filter((dir) => typeof dir === 'string'))];
  return { readFiles: [], readDirs };
}

// The digest folder of a round whose plans grant a digest whose path holds
// a character no read rule can carry (src/curate/rule-path.mjs), with
// those characters: { dir, characters }; null when every one can be
// named. A digest's own name is `<NN>-<session>.txt`, the session a prefix
// of a file name the plan already refuses such characters in, so it is
// the state directory's path that holds them (a vault folder named
// `Notes (old)`, say).
function unsafeDigestDir(sources, plans) {
  for (const path of readFilesOf(sources, plans)) {
    const characters = unsafeRuleCharacters(path);
    if (characters.length > 0) return { dir: path.slice(0, path.lastIndexOf(sep)), characters: characters.join(' ') };
  }
  return null;
}

// The round's allow and deny lists in isolated mode. The deny list also
// tells the isolation check which built-in tools the round removed by name
// (ruling R-B4).
function roundTools(config, readFiles, readDirs = []) {
  return {
    allowed: allowedTools(config.curate?.allowed_tools_extra ?? [], { readFiles, readDirs }),
    disallowed: disallowedTools(config.curate?.disallowed_tools_extra ?? []),
  };
}

// The tool name a permission rule names: the text before its scope.
function ruleTool(rule) {
  return /^[^(]*/.exec(rule)[0];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whether a deny rule would deny `tool`: the same name; a name the tool's
// own starts with at a server boundary (`mcp__<server>` stands for every
// tool of that server); or a name with a wildcard that matches it. How the
// CLI reads a wildcard in the middle of an MCP name is not measured; read
// as matching, it fails closed (the source is not read).
function deniesTool(rule, tool) {
  const name = ruleTool(rule);
  if (name === tool || tool.startsWith(`${name}__`)) return true;
  return name.includes('*') && new RegExp(`^${name.split('*').map(escapeRegExp).join('.*')}$`).test(tool);
}

// The launch mode and its tools for a round whose connector sources, in
// `candidates`, have a day to read (decisions D1 and D3). No candidate:
// isolated, and the person's settings are not read at all. Otherwise the
// user settings files the round would load are read and every allow rule
// in them mirrored (src/curate/user-rules.mjs): a rule that refuses
// connector mode (a `blocking` entry) blocks every candidate; a mirrored
// deny that would deny a candidate's own read tools (a rule for a whole
// server, say) blocks that candidate, naming the rule, since dropping the
// rule would leave its other tools to the person's allow and keeping it
// denies the source its reads. What the round's own allow list holds
// decides which user rules are mirrored, so the mirror is taken again
// without the tools of each candidate blocked, until none is. Connector
// mode allows the round's own rules (without the `node <kit>` forms when a
// mirrored rule covers them) plus each available source's read tools, and
// denies the round's own denies, every mirrored rule and every configured
// connector source's write tools; with no candidate left, the round runs
// isolated. `blocked` maps an id to what blocked it. `brain-kit doctor`
// (check `connectors`, and `--probe`) asks this same function, so doctor
// and the round cannot disagree on which rule refuses connector mode.
export function chooseMode({ config, root, env, readFiles, readDirs = [], candidates, connectorDenies }) {
  const base = roundTools(config, readFiles, readDirs);
  if (candidates.length === 0) return { mode: 'isolated', tools: base, available: [], blocked: new Map(), userRules: null };
  const files = userSettingsFiles(env);
  const home = env.HOME || homedir();
  const kit = kitCommand();
  const nodeForms = KIT_SUBCOMMANDS.map((sub) => `Bash(node ${kit} ${sub}:*)`);
  const blocked = new Map();
  let available = [...candidates];
  for (;;) {
    const allowed = [...base.allowed, ...available.flatMap((source) => source.toolRules(config).allow)];
    const mirror = mirrorUserRules({ files, ownAllowed: allowed, vaultRoot: root, home, kit });
    const userRules = { mirrored: mirror.deny, widenedReads: mirror.widenedReads, blocking: mirror.blocking };
    if (mirror.blocking.length > 0) {
      for (const source of available) blocked.set(source.id, { blocking: mirror.blocking });
      return { mode: 'isolated', tools: base, available: [], blocked, userRules };
    }
    const hit = available.map((source) => ({ source, rules: mirror.deny.filter((rule) => source.toolRules(config).allow.some((tool) => deniesTool(rule, tool))) })).filter((entry) => entry.rules.length > 0);
    if (hit.length === 0) {
      if (available.length === 0) return { mode: 'isolated', tools: base, available, blocked, userRules };
      return {
        mode: 'connectors',
        tools: {
          allowed: mirror.dropNodeForms ? allowed.filter((rule) => !nodeForms.includes(rule)) : allowed,
          disallowed: [...new Set([...base.disallowed, ...mirror.deny, ...connectorDenies])],
        },
        available,
        blocked,
        userRules,
      };
    }
    for (const { source, rules } of hit) blocked.set(source.id, { rules });
    available = available.filter((source) => !blocked.has(source.id));
  }
}

// What --check and --dry say about the launch mode: the mode, the mirror's
// counts, and every rule that refused connector mode.
function modeLines(t, choice) {
  const rules = choice.userRules;
  const counts = rules === null ? {} : { mirrored: rules.mirrored.length, widened: rules.widenedReads.length };
  const lines = [];
  if (choice.mode === 'connectors') lines.push(t('curate.check_mode_connectors', counts));
  else if (rules === null) lines.push(t('curate.check_mode_isolated', {}));
  else lines.push(t('curate.check_mode_refused', counts));
  for (const item of rules?.blocking ?? []) {
    const message = blockingMessage(item);
    lines.push(t(message.messageKey, message.params));
  }
  return lines;
}

// What --check (with each plan's prompt block) and --dry (with each plan's
// problems) say about each source the round runs.
function sourceLines(t, { active, plans, days, unavailable, config, blocks }) {
  const lines = [];
  for (const source of active) {
    const own = days[source.id];
    if (own.length === 0) {
      lines.push(t('curate.check_source_no_day', { source: source.id }));
      continue;
    }
    if (unavailable.has(source.id)) {
      lines.push(t('curate.check_source_unavailable', { source: source.id, state: unavailable.get(source.id) }));
      continue;
    }
    const plan = plans[source.id];
    if (source.kind === 'local') {
      lines.push(t('curate.check_source', { source: source.id, kept: keptOf(plan) ?? 0 }));
      if (!blocks) lines.push(...(plan.waitingLines ?? []));
    }
    else lines.push(t('curate.check_connector_source', { source: source.id, connector: source.serverSpec(config).serverDisplayName, days: own.map(shown).join(', ') }));
    if (blocks) lines.push(plan.promptBlock);
    else if ((plan.problems ?? []).length > 0) lines.push(t('curate.source_warning', { source: source.id, problems: problemWords(plan) }));
  }
  return lines;
}

// For the meeting notes while the calendar is configured (SECOND_DOOR,
// ruling I2 of task 5's review): the last of their days, in order, that
// the calendar was read over in this round (offered, available, its
// evidence ok), as { through }, `through` null when not even the first one
// was. For any other source, or with the calendar not configured, null:
// the source's own evidence alone decides.
function secondDoor(source, { active, offered, days, evidence, unavailable }) {
  if (source.id !== SECOND_DOOR.source || !active.some((s) => s.id === SECOND_DOOR.through)) return null;
  const cal = SECOND_DOOR.through;
  const read = offered.some((s) => s.id === cal) && !unavailable.has(cal) && evidence[cal]?.ok === true ? days[cal] : [];
  let through = null;
  for (const day of days[source.id]) {
    if (!read.includes(day)) break;
    through = day;
  }
  return { through };
}

// The message saying why a source is blocked by the person's rules.
function blockedMessage(t, source, config, entry) {
  if (entry.blocking) return entry.blocking.map((item) => { const m = blockingMessage(item); return t(m.messageKey, m.params); }).join(' ');
  return t('curate.user_rules.denies_source', { rules: entry.rules.join(', '), connector: source.serverSpec(config).serverDisplayName, tools: source.toolRules(config).allow.join(', ') });
}

// The round's cost cap in USD: the number curate.budget_usd sets; null when
// it is null, the owner asking for no cap, so the round passes no
// --max-budget-usd at all; the fallback only when the key is absent. The
// round, --check, --dry and doctor's cost-cap all read the cap here, so
// they cannot disagree about it.
export function roundBudget(config) {
  const configured = config?.curate?.budget_usd;
  return configured === undefined ? FALLBACK_BUDGET_USD : configured;
}

// What the round, --check and --dry say about the cost cap.
function budgetLine(t, config) {
  const usd = roundBudget(config);
  if (usd === null) return t('curate.cost_cap_none', { setting: BUDGET_SETTING });
  if (config.curate?.budget_usd === undefined) return t('curate.cost_cap_default', { usd, setting: BUDGET_SETTING });
  return t('curate.cost_cap', { usd, setting: BUDGET_SETTING });
}

// The round's turn limit: the integer curate.max_turns sets; null when it
// is null, the owner asking for no turn limit, so the round passes no
// --max-turns at all; the fallback (100) only when the key is absent.
// The round, --check, --dry and doctor's turn-cap all read it here.
export function roundTurns(config) {
  const configured = config?.curate?.max_turns;
  return configured === undefined ? FALLBACK_MAX_TURNS : configured;
}

// The largest curate.timeout_minutes a round can keep: its milliseconds must
// fit Node's timer (MAX_TIMER_MS, 2^31-1 ms, about 24.8 days), or the kill
// would fire at once. The schema's maximum is this number, and doctor's
// time-cap names it.
export const MAX_TIMEOUT_MINUTES = 35791;

// The round's time limit, in minutes: the number curate.timeout_minutes
// sets, after which the model's whole process group is killed and the round
// exits 1 as timed_out; null when it is null or left out (both packs'
// default), and the model then runs until it ends by itself. Until phase
// 5a every round was killed after a fixed hour, a limit its owner never
// asked for (ruling R-A3, 25/09/2026). With none, a model that hangs holds
// the vault lock until a person stops it: under systemd and launchd, which do
// not start a job that is still running, the later windows simply do not run
// and nothing notifies; under cron each later round postpones (exit 75,
// naming the round) and notifies (docs/scheduling.md, "A round that hangs").
// The round, --check, --dry and doctor's time-cap all read it here.
export function roundTimeoutMinutes(config) {
  const configured = config?.curate?.timeout_minutes;
  return configured === undefined ? null : configured;
}

function turnsLine(t, config) {
  const turns = roundTurns(config);
  if (turns === null) return t('curate.turn_cap_none', { setting: TURNS_SETTING });
  if (config.curate?.max_turns === undefined) return t('curate.turn_cap_default', { turns, setting: TURNS_SETTING });
  return t('curate.turn_cap', { turns, setting: TURNS_SETTING });
}

function timeLine(t, config) {
  const minutes = roundTimeoutMinutes(config);
  if (minutes === null) return t('curate.time_cap_none', { setting: TIMEOUT_SETTING });
  return t('curate.time_cap', { minutes, setting: TIMEOUT_SETTING });
}

// What the round, --check and --dry say about the round's three limits.
function limitLines(t, config) {
  return [budgetLine(t, config), turnsLine(t, config), timeLine(t, config)];
}

// What the round, --check and --dry say about what the model records:
// the three limits, then the privacy policy in effect, one line, every round
// (02/10/2026), so a person reading the round's output is never surprised by
// what it left out or kept.
function settingLines(t, config) {
  return [...limitLines(t, config), privacyLine(config, t)];
}

function modelArgv(config, machine, tools, mode = 'isolated') {
  return buildArgv({
    mode,
    model: machine.model ?? undefined,
    maxTurns: roundTurns(config),
    budgetUsd: roundBudget(config),
    allowed: tools.allowed,
    disallowed: tools.disallowed,
  });
}

// The previous round's last-run.json, or null: where a connector state
// change is measured from.
function readLastRun(stateDir) {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, STATE_FILES.LAST_RUN), 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The last known state of each connector source, carried from round to
// round: `{ [id]: { state, at } }`, `at` the time of the round that saw it.
// A round that does not see a source's connector (no day for it, a round
// that stopped before the model) keeps what the last one saw, so a state
// that stays the same is never announced twice (ruling of task 5).
// Exported for the briefing's preflight (src/briefing/facts.mjs), which
// states the carried states with this same reading of them.
export function knownStates(previous) {
  const out = {};
  const carried = previous?.connectorStates;
  if (carried === null || typeof carried !== 'object' || Array.isArray(carried)) return out;
  for (const [id, entry] of Object.entries(carried)) {
    if (entry !== null && typeof entry === 'object' && typeof entry.state === 'string' && typeof entry.at === 'string') out[id] = { state: entry.state, at: entry.at };
  }
  return out;
}

// The environment the model runs with: the caller's, the round's token
// (so the `propose` it runs joins the round's lock), and machine.path_extra
// in front of PATH.
function modelEnv(env, machine, token) {
  const extra = (machine.path_extra ?? []).map((dir) => expandHome(String(dir), env));
  const out = withPathPrefix(env, extra);
  if (token !== null) out.BRAIN_KIT_ROUND_TOKEN = token;
  return out;
}

// ---------------------------------------------------------------- cleanup

// Step 15. For each path a proposal named (the latest proposal naming it,
// when several did), compare the working tree's bytes with that
// proposal's commit: equal, or absent from both, means the tree holds
// exactly what was pushed, and the path is brought back to HEAD (restored
// from HEAD when HEAD has it, deleted when it does not). Anything else was
// changed after the push and is left alone. The comparison and the restore
// are src/guards/proposed.mjs's, the same ones the Stop hook, `propose` and
// `sync` use for a proposal made outside a round.
export function cleanupProposals(root, proposals, env) {
  const match = proposedMatch(root, proposals, env);
  const restored = restoreMatching(root, match, env);
  return { restored, changed: match.changed };
}

// ---------------------------------------------------------------- sync failures

// What git, ssh and curl say when the remote's host cannot be reached at all
// (a machine just back from sleep, name resolution not yet up): a failed
// sync whose last line matches one is a lost network, a known cause the next
// window retries, never a failure of the sync itself (07/10/2026).
export const OFFLINE_PATTERNS = Object.freeze([
  /Could not resolve hostname/,
  /Could not resolve host/,
  /Temporary failure in name resolution/,
  /Name or service not known/,
  /nodename nor servname provided/,
  /Network is unreachable/,
]);

// ---------------------------------------------------------------- the command

export async function runCurate(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const onStep = deps.onStep ?? (() => {});
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(`${t('curate.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.error) {
    io.stderr.write(`${t('curate.bad_argument', { arg: parsed.arg })}\n`);
    io.stderr.write(`${t('curate.usage')}\n`);
    return EXIT.USAGE;
  }

  // 1. The vault and the machine file.
  onStep('machine');
  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('curate.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('curate.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('curate.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const stateDir = stateDirFor(root, env);
  const started = Date.now();
  const logFile = join(stateDir, STATE_FILES.LOG_DIR, `curate-${localIsoDate(now)}.log`);
  const writesState = !parsed.dry;
  const log = (event, details) => {
    if (!writesState) return;
    try {
      ensureStateDir(stateDir);
      mkdirSync(join(stateDir, STATE_FILES.LOG_DIR), { recursive: true, mode: 0o700 });
      const extra = details === undefined ? '' : ` ${JSON.stringify(details)}`;
      appendFileSync(logFile, `${new Date().toISOString()} ${event}${extra}\n`, { mode: 0o600 });
    } catch {
      // A log that cannot be written must not hide the round's own exit.
    }
  };

  let machine;
  try {
    machine = loadMachine(stateDir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const reason = error.code === 'machine_missing'
      ? t('curate.machine_missing', { file: join(stateDir, MACHINE_FILENAME) })
      : t('curate.machine_invalid', { detail: error.message });
    io.stderr.write(`${reason}\n`);
    log('exit', { exit: EXIT.USAGE, reason: 'machine_invalid' });
    if (writesState) {
      try {
        ensureStateDir(stateDir);
        writePrivate(join(stateDir, STATE_FILES.LAST_RUN), `${JSON.stringify({ at: now.toISOString(), durationMs: Date.now() - started, exit: EXIT.USAGE, reasonCode: 'machine_invalid', reason, connectorStates: knownStates(readLastRun(stateDir)) }, null, 2)}\n`);
      } catch {
        // as above
      }
    }
    return EXIT.USAGE;
  }
  const claudeBin = expandHome(machine.claude_bin, env);

  // 2. --dry: a read-only preview, from the working tree as it is.
  if (parsed.dry) return dryRun({ root, stateDir, machine, claudeBin, io, env, now, keepStream: parsed.keepStream || machine.keep_stream === true });

  // The round's own state, filled as it goes and written at the end.
  // The last round's record, read before this one can write its own: the
  // connector states it knew are carried forward and compared with this
  // round's (step 18).
  const previousRun = readLastRun(stateDir);
  // `budgetUsd`, `maxTurns` and `timeoutMinutes` stay undefined, so out of
  // last-run.json, until the model is launched: then the limits it runs
  // under, each a number or null for none.
  const run = {
    at: now.toISOString(), durationMs: null, exit: null, reasonCode: null, reason: null, window: null, network: null,
    sources: {}, warnings: [], remainingDays: 0, deferredDays: [], costUsd: null, budgetUsd: undefined, maxTurns: undefined, timeoutMinutes: undefined, numTurns: null, denials: [], isolation: null, proposed: null, leftovers: [],
    mode: null, relaunched: false, notConfigured: [], userRules: null, connectorStates: knownStates(previousRun),
    unknownCause: undefined,
    repairs: [],
  };
  // The notifications this round owes besides the one for a non-zero exit:
  // one per best-effort connector source whose state changed.
  const notices = [];
  let lock = null;
  let recordFile = null;
  let keepRecord = false;
  let interrupted = null;
  // The model's raw output, and with it the round's digests, are kept
  // only on request (--keep-stream, or keep_stream in machine.json).
  const keepStream = parsed.keepStream || machine.keep_stream === true;
  // This round's digest folder (step 11), removed in the `finally` below
  // whatever the round's end, unless the stream is kept.
  const digestDir = digestDirFor(stateDir, now, keepStream);
  const controller = new AbortController();
  const onSignal = (signal) => {
    interrupted = signal;
    controller.abort(signal);
  };

  const fail = (exit, code, reason) => {
    run.exit = exit;
    run.reasonCode = code;
    run.reason = reason;
    return exit;
  };
  // A reason the kit cannot explain ends by saying so (R5): the cause is
  // not one it knows, and the text before is the program's own. The text
  // before may end on a bare detail, so the sentence boundary is kept. The
  // round's record says so too (`unknownCause`, absent otherwise), so no
  // reader needs a list of reason codes.
  const withUnknownCause = (reason) => {
    run.unknownCause = true;
    const said = reason.trimEnd();
    return `${/[.!?]$/.test(said) ? said : `${said}.`}${t('curate.unknown_cause', {})}`;
  };

  // 3. The lock.
  onStep('lock');
  try {
    lock = acquireLock(root, { command: 'curate', env });
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    const reason = t(error.messageKey, error.params);
    run.exit = error.exitCode;
    // Held (the vault lock, or the legacy lock, exit 75) is a round
    // postponed; every other refusal (a legacy lock bridge that cannot be
    // used, no hard links, not a repository, a reclaim that died) is one no
    // retry fixes, and is recorded as such, never as held.
    run.reasonCode = error.exitCode === EXIT.TEMPFAIL ? 'lock_held' : 'lock_unusable';
    run.reason = reason;
    return finishRound({ run, io, log, stateDir, machine, env, started, lock: null, writeLastRun: true, check: false, notices });
  }
  recordFile = roundRecordPath(root, lock.token, env);
  log('start', { root, check: parsed.check });
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);

  try {
    await roundUnderLock();
  } catch (error) {
    fail(EXIT.FAILURE, 'internal_error', withUnknownCause(t('curate.internal_error', { detail: error instanceof Error ? error.message : String(error) })));
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onSignal);
    // The digests hold what the person wrote: gone first, on every end this
    // process sees, a failure, an exit 4 and a signal included. Each step
    // here is its own: one that fails is logged and never skips the next,
    // nor keeps the lock.
    if (!keepStream) {
      try {
        rmSync(digestDir, { recursive: true, force: true });
      } catch (error) {
        log('digests_not_removed', { code: error.code ?? null });
      }
    }
    if (recordFile !== null) {
      for (const file of keepRecord ? [`${recordFile}.lock`] : [recordFile, `${recordFile}.lock`]) {
        try {
          rmSync(file, { force: true });
        } catch (error) {
          log('record_not_removed', { code: error.code ?? null });
        }
      }
    }
  }
  return finishRound({ run, io, log, stateDir, machine, env, started, lock, writeLastRun: !parsed.check, check: parsed.check, notices });

  async function roundUnderLock() {
    // Digests a round killed outright left behind (step 18). Never in a
    // --check, which writes none.
    if (!parsed.check) {
      try {
        const swept = sweepDigests(stateDir);
        if (swept > 0) log('digests_swept', { count: swept });
      } catch (error) {
        log('digests_not_swept', { code: error.code ?? null });
      }
    }

    // 4. The network.
    onStep('network');
    const minWaitMs = networkMinWait(root);
    const network = await waitForNetwork(machine.network_check ?? null, {
      ...(minWaitMs !== undefined ? { minWaitMs } : {}),
      ...(deps.networkTimeoutMs !== undefined ? { timeoutMs: deps.networkTimeoutMs } : {}),
      ...(deps.networkIntervalMs !== undefined ? { intervalMs: deps.networkIntervalMs } : {}),
    }, deps.networkDeps ?? {});
    run.network = { ok: network.ok, waitedMs: network.waitedMs, attempts: network.attempts, warning: network.warning };
    if (!network.ok) return fail(EXIT.UNAVAILABLE, 'no_network', t('curate.network_failed', { waited: Math.round(network.waitedMs / 1000), attempts: network.attempts }));
    if (network.warning === 'did_not_wait') {
      log('network_did_not_wait', { waitedMs: network.waitedMs });
      io.stdout.write(`${t('curate.network_did_not_wait', { ms: network.waitedMs })}\n`);
    }
    if (interrupted) return fail(EXIT.FAILURE, 'interrupted', t('curate.interrupted', { signal: interrupted }));

    // 4b. A lock git left behind, moved aside before sync meets it. A step
    // that cannot tell is not a reason to end the round: sync fails, or not,
    // with git's own words.
    onStep('index_lock');
    let lockMove;
    try {
      lockMove = moveOrphanIndexLock(root, { env, now });
    } catch (error) {
      lockMove = { moved: false, to: null, ageMinutes: null, skipped: 'git_failed', error: error instanceof Error ? error.message : String(error) };
    }
    if (lockMove.moved) {
      run.repairs.push({ kind: 'index_lock_moved', to: lockMove.to, ageMinutes: lockMove.ageMinutes });
      log('index_lock_moved', lockMove);
      io.stdout.write(`${t('curate.index_lock_moved', { to: lockMove.to, minutes: lockMove.ageMinutes })}\n`);
    } else if (lockMove.skipped !== 'absent') {
      log('index_lock_kept', lockMove);
    }

    // 5. Sync, under the lock this round holds.
    onStep('sync');
    const outcome = {};
    // Sync's last non-empty line on stderr already quotes git: it is what
    // every sync outcome that is not a success puts in the round's reason.
    let lastSyncLine = null;
    const syncIo = {
      ...io,
      stderr: { write: (chunk) => { lastSyncLine = lastNonEmptyLine(chunk) ?? lastSyncLine; return io.stderr.write(chunk); } },
    };
    let synced;
    try {
      synced = syncUnderLock(root, syncIo, t, env, outcome);
    } catch (error) {
      io.stderr.write(`${t('sync.git_failed', { detail: error.message })}\n`);
      lastSyncLine = lastNonEmptyLine(error.message) ?? lastSyncLine;
      outcome.gitFailed = true;
      synced = EXIT.FAILURE;
    }
    const detail = lastSyncLine ?? '-';
    // A diverged base is exit 1, not 75: retrying cannot fix it, a person
    // must reconcile the two histories (controller ruling, fix round 1).
    if (outcome.diverged) return fail(EXIT.FAILURE, 'sync_diverged', t('curate.sync_diverged', { detail }));
    if (synced === EXIT.TEMPFAIL) {
      // Sync postpones first on a dirty tree; the round's own reason names
      // the files, as step 8 would (review finding M6).
      const early = checkDirtyTree(root, null, { env });
      if (!early.ok) {
        const files = early.files.map((f) => `${f.path} (${f.mtime ?? '-'})`).join(', ');
        return fail(EXIT.TEMPFAIL, 'dirty_tree', t('curate.dirty', { files }));
      }
      return fail(EXIT.TEMPFAIL, 'sync_postponed', t('curate.sync_postponed', { detail }));
    }
    if (synced !== EXIT.OK) {
      // A lost network is a known cause the next window retries (R1).
      if (OFFLINE_PATTERNS.some((re) => re.test(detail))) return fail(EXIT.UNAVAILABLE, 'sync_offline', t('curate.sync_offline', { detail }));
      // The reason code is sync_failed whoever diagnosed it; only a failure
      // of git itself is a cause the kit does not know (R5). A refusal sync
      // diagnosed (no remote, no default branch...) already names its cause.
      const failed = t('curate.sync_failed', { detail });
      return fail(EXIT.FAILURE, 'sync_failed', outcome.gitFailed ? withUnknownCause(failed) : failed);
    }

    // 6. The configuration, as synced, and the prompt it names.
    onStep('config');
    let config;
    try {
      config = loadConfig(root);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return fail(EXIT.USAGE, 'config_invalid', t('curate.config_invalid', { detail: error.message }));
    }
    const vaultLang = SUPPORTED_LANGS.includes(config.lang) ? config.lang : 'en';
    const tv = createTranslator(vaultLang);
    // From here on the round speaks the vault's language, whatever the
    // scheduler's environment says (a unit runs with LC_ALL=C.UTF-8 and no
    // BRAIN_KIT_LANG): its output, last-run.json and the notification.
    t = tv;
    // Disabled in the configuration: a normal state, said, never a failure,
    // and nothing is read, run or advanced.
    if (config.curate?.enabled === false) {
      run.exit = EXIT.OK;
      run.reasonCode = 'disabled';
      run.reason = t('curate.disabled', { file: CONFIG_FILENAME });
      return EXIT.OK;
    }
    const outside = promptOutsideVault(root, config);
    const promptSetting = `${CONFIG_FILENAME} curate.prompt`;
    if (outside !== null) return fail(EXIT.USAGE, 'prompt_outside', t('curate.prompt_outside', { path: outside, setting: promptSetting }));
    // An allow rule that grants a scoped tool with no scope is a
    // configuration error, said before anything runs (review M1 and M2,
    // 25/09/2026); buildArgv would throw on it anyway.
    const unscoped = unscopedRules(config.curate?.allowed_tools_extra ?? []);
    if (unscoped.length > 0) return fail(EXIT.USAGE, 'config_invalid', t('curate.allowed_unscoped', { rules: unscoped.join(', '), setting: ALLOWED_EXTRA_SETTING }));
    const tz = config.vault?.timezone;
    const { active, off, required, unknownRequired, unknownBestEffort } = sourcesOf(config);

    // 7. The window, and each source's own days in it.
    onStep('window');
    let computed;
    try {
      computed = computeWindow(stateDir, active, now, tz);
    } catch (error) {
      if (error instanceof WatermarkError) return fail(EXIT.FAILURE, 'watermark_unreadable', t('curate.watermark_unreadable', { file: error.file, detail: error.detail }));
      if (error instanceof RangeError) return fail(EXIT.USAGE, 'bad_timezone', t('curate.bad_timezone', { timezone: String(tz), file: CONFIG_FILENAME }));
      throw error;
    }
    if (computed.future) {
      const { source, day, yesterday } = computed.future;
      const command = reopenCommand(source, yesterday);
      return fail(EXIT.FAILURE, 'watermark_future', t('curate.watermark_future', { source, day: shown(day), yesterday: shown(yesterday), command }));
    }
    let { window } = computed;
    const days = { ...computed.days };
    const recordWindow = () => {
      run.window = {
        days: window.days, from: window.from.toISOString(), to: window.to.toISOString(), remaining: window.remaining,
        sources: Object.fromEntries(active.map((source) => [source.id, days[source.id]])),
      };
    };
    recordWindow();
    if (window.days.length === 0) {
      run.exit = EXIT.OK;
      run.reasonCode = 'up_to_date';
      run.reason = t('curate.up_to_date', {});
      return EXIT.OK;
    }
    // Catching up oldest first, each source on its own: its mark moves
    // through the last day it reads here, and its newer days wait for its
    // next round (never closed).
    run.remainingDays = window.remaining;
    for (const source of active) {
      const count = computed.remaining[source.id];
      if (!(count > 0)) continue;
      const last = days[source.id].at(-1);
      // The meeting notes can have no day this round while the calendar's
      // listing catches up on its own older days (SECOND_DOOR).
      const text = last === undefined
        ? t('curate.days_remaining_none', { source: source.id, count, calendar: SECOND_DOOR.through })
        : t('curate.days_remaining', { source: source.id, count, last: shown(last) });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('days_remaining', { source: source.id, count, through: last ?? null });
    }

    // 8. A dirty tree postpones the round.
    onStep('dirty');
    const dirty = checkDirtyTree(root, null, { env });
    if (!dirty.ok) {
      const files = dirty.files.map((f) => `${f.path} (${f.mtime ?? '-'})`).join(', ');
      return fail(EXIT.TEMPFAIL, 'dirty_tree', t('curate.dirty', { files }));
    }

    // 9. The round's own snapshot.
    onStep('snapshot');
    takeSnapshot(root, { env, now, session: `curate-${now.toISOString()}` });

    // 10. The CLI.
    onStep('cli');
    const childEnv = modelEnv(env, machine, lock.token);
    let cli = checkCli(claudeBin, { env: childEnv });
    // A launcher stub an npm install left behind is reinstalled with the
    // person's environment, never childEnv (it carries the round token).
    const repair = repairStub(cli, { env, now });
    if (repair.tried || repair.skipped !== 'not_stub') log('cli_repair', repair);
    if (repair.tried) {
      cli = checkCli(claudeBin, { env: childEnv });
      if (cli.ok) run.repairs.push({ kind: 'cli_reinstalled', version: cli.version });
    }
    if (!cli.ok) {
      const tried = repair.tried ? t('curate.cli_repair_failed', { said: repair.said ?? 'exit 0' }) : '';
      return fail(EXIT.FAILURE, `cli_${cli.problem}`, `${t('curate.cli_unusable', { problem: t(cli.messageKey, cli.params) })}${tried}`);
    }

    // 11. The sources.
    onStep('sources');
    if (unknownRequired.length > 0) {
      return fail(REQUIRED_SOURCE_EXIT, 'source_unknown', unknownRequiredText(t, unknownRequired));
    }
    for (const id of unknownBestEffort) {
      const text = t('curate.source_skipped', { source: id });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('source_skipped', { source: id });
    }
    // A listed source that is off: recorded; said when it is half
    // configured (ruling R-E1); a required one stops the round, since no
    // round could ever read it.
    for (const source of off) {
      const problems = offProblems(source, config, now, tz);
      const setting = `${CONFIG_FILENAME} sources.${source.id}`;
      run.notConfigured.push({ source: source.id, problems: problems.map((p) => (p.detail ? `${p.code} (${p.detail})` : p.code)) });
      if (required.includes(source.id)) return fail(REQUIRED_SOURCE_EXIT, 'source_misconfigured', offRequiredText(t, source, problems));
      if (offOnPurpose(source, config, problems)) continue;
      const text = t('curate.source_off', { source: source.id, problems: problemText(problems) || '-', setting });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('source_off', { source: source.id, problems: problems.map((p) => p.code) });
    }
    // Only a source with a day of its own in the round is collected,
    // offered and advanced (decision D5).
    let offered = active.filter((source) => days[source.id].length > 0);
    for (const source of active) {
      if (days[source.id].length === 0) log('source_no_day', { source: source.id, mark: computed.marks[source.id] ?? null });
    }
    const plans = collectPlans(offered, days, config, machine, env, now, tz, digestDir, root);
    for (const source of offered) {
      const plan = plans[source.id];
      run.sources[source.id] = sourceEntry(source, plan);
      if (plan.misconfigured && required.includes(source.id)) {
        return fail(REQUIRED_SOURCE_EXIT, 'source_misconfigured', misconfiguredText(t, source, plan, problemText(plan.problems)));
      }
      if (plan.problems.length > 0) {
        const text = t('curate.source_warning', { source: source.id, problems: problemText(plan.problems) });
        run.warnings.push(text);
        io.stderr.write(`${text}\n`);
        log('source_warning', { source: source.id, problems: plan.problems.map((p) => p.code) });
      }
      // A listed project with no sessions yet (a new vault's own) is said once,
      // plainly; it is no warning, and nothing about it needs fixing.
      for (const line of plan.waitingLines ?? []) io.stderr.write(`${line}\n`);
      if ((plan.waiting ?? []).length > 0) log('source_waiting', { source: source.id, projects: plan.waiting });
    }
    // A file a required source cannot read keeps its day open whatever the
    // model does, so the model is not started at all: running it would
    // spend the round and open a pull request for a day that cannot close,
    // and every retry would open it again (final review I2).
    for (const id of required) {
      const unreadable = plans[id]?.unreadable ?? [];
      if (unreadable.length === 0) continue;
      const setting = `${CONFIG_FILENAME} sources.${id}.exclude_path_patterns`;
      log('plan', { [id]: { kept: keptOf(plans[id]), dropped: plans[id].dropped } });
      let reason = t('curate.source_unreadable', { source: id, files: unreadable.map((f) => f.path).join(', '), setting, command: `brain-kit watermark assume-covered ${id}` });
      // A file whose path no read permission can name exactly: renaming
      // it, not its permissions, is the fix, and the reason says so.
      const unsafe = unreadable.filter((f) => Array.isArray(f.unsafe));
      if (unsafe.length > 0) {
        const unsafeFiles = unsafe.map((f) => f.path).join(', ');
        const characters = [...new Set(unsafe.flatMap((f) => f.unsafe))].join(' ');
        reason = `${reason} ${t('curate.source_unsafe_paths', { files: unsafeFiles, characters })}`;
      }
      // A project directory that could not be listed (ruling R-A4): its
      // sessions could be on any day, so skipping days does not clear it;
      // listing it, or leaving it out of the configuration, does.
      const directories = unreadable.filter((f) => f.directory === true);
      if (directories.length > 0) {
        const dirs = directories.map((f) => f.path).join(', ');
        reason = `${reason} ${t('curate.source_unlistable_dirs', { dirs, projects: `${CONFIG_FILENAME} sources.${id}.include_projects`, patterns: setting })}`;
      }
      return fail(EXIT.SOURCE_UNREAD, 'source_unreadable', reason);
    }
    // The first open day alone over a source's cap: no whole day fits, and
    // a round never reads part of a day (final review C1).
    for (const source of offered) {
      const over = plans[source.id].overCap;
      if (!over) continue;
      const setting = `${CONFIG_FILENAME} curate.caps.${source.id}`;
      log('plan', { [source.id]: { kept: 0, dropped: plans[source.id].dropped, overCap: over } });
      return fail(EXIT.SOURCE_UNREAD, 'cap_exceeded', t('curate.cap_exceeded', { day: shown(over.day), count: over.files, cap: plans[source.id].cap, setting }));
    }
    // Days past a source's whole-day cap wait for its next round; it
    // curates, and advances through, only the whole days it could take. No
    // other source's days change.
    let deferred = [];
    // What the round tells the person at its end, in its reason, about the
    // days a digest left open and the digests cut (fix round 1).
    const digestNotes = [];
    for (const capped of capDays(offered, plans, days)) {
      deferred = capped.deferred;
      run.deferredDays = deferred;
      run.sources[capped.source.id].kept = keptOf(plans[capped.source.id]) ?? 0;
      if (capped.byCap.length > 0) {
        const setting = `${CONFIG_FILENAME} curate.caps.${capped.source.id}`;
        const text = t('curate.days_deferred', { last: shown(capped.last), count: capped.byCap.length, days: capped.byCap.map(shown).join(', '), setting, cap: capped.cap });
        run.warnings.push(text);
        io.stderr.write(`${text}\n`);
      }
      if (capped.byDigest.length > 0) {
        const open = capped.byDigest.map(shown).join(', ');
        const text = t('curate.days_deferred_digest', { source: capped.source.id, last: shown(capped.last), count: capped.byDigest.length, days: open, sessions: capped.sessions.join(', ') });
        run.warnings.push(text);
        io.stderr.write(`${text}\n`);
        digestNotes.push(t('curate.reason_digest_days', { source: capped.source.id, days: open }));
      }
      log('days_deferred', { through: capped.last, days: deferred, source: capped.source.id, byDigest: capped.byDigest });
    }
    window = unionWindow(Object.fromEntries(offered.map((s) => [s.id, days[s.id]])), computed.remaining, now, tz);
    run.remainingDays = window.remaining;
    recordWindow();
    log('plan', Object.fromEntries(offered.map((s) => [s.id, planLogOf(s, plans[s.id], days[s.id])])));
    // Nothing to curate: only a round whose offered sources all list files
    // and list none (a connector source's plan lists no file, so it is
    // never empty: its empty day is a listing to prove, and it never
    // advances vacuously).
    if (emptyWindow(Object.fromEntries(offered.map((s) => [s.id, plans[s.id]])))) {
      if (parsed.check) {
        run.exit = EXIT.OK;
        run.reasonCode = 'nothing_to_curate';
        run.reason = t('curate.nothing_to_curate', { days: window.days.map(shown).join(', ') });
        return EXIT.OK;
      }
      const evidence = evidenceFor(offered, plans, null);
      for (const source of offered) {
        const through = days[source.id].at(-1);
        const moved = advanceWatermark(stateDir, source.id, through, { vacuous: true, evidence: evidence[source.id], timezone: tz, now, emptyMeansNothingListed: source.emptyMeansNothingListed !== false });
        run.sources[source.id].advanced = moved.advanced;
        log('watermark', { source: source.id, day: through, vacuous: true, ...moved });
        // A best-effort source that read nothing (ruling R-A9) keeps its day
        // open, and the round says so.
        if (!moved.advanced) io.stderr.write(`${t('curate.not_advanced', { source: source.id, reason: moved.reason })}\n`);
      }
      run.exit = EXIT.OK;
      run.reasonCode = 'nothing_to_curate';
      run.reason = t('curate.nothing_to_curate', { days: window.days.map(shown).join(', ') });
      return EXIT.OK;
    }

    // 12. The launch mode: connector mode for the connector sources the
    // person's rules allow, isolated otherwise (decisions D1 and D3).
    const connectorDenies = [...new Set(active.filter((s) => s.kind === 'connector').flatMap((s) => s.toolRules(config).deny))];
    // The digests the model is granted, each by its exact path: a folder
    // whose path no rule can name exactly could not be granted without
    // granting more, so the model is not started on it.
    const unsafeDigests = unsafeDigestDir(offered, plans);
    if (unsafeDigests !== null) return fail(EXIT.FAILURE, 'digest_dir_unsafe', t('curate.digest_dir_unsafe', { dir: unsafeDigests.dir, characters: unsafeDigests.characters }));
    const { readFiles, readDirs } = readGrantsOf(offered, plans);
    // Sources the round offers but cannot read this time (id -> state), and
    // the connector state each launch saw (id -> { state, observedPrefix }).
    const unavailable = new Map();
    const pending = new Set();
    const states = {};
    const block = (entries) => {
      for (const [id, entry] of entries) {
        const source = SOURCES[id];
        const rules = entry.rules ?? entry.blocking.map((item) => item.rule ?? item.file);
        unavailable.set(id, BLOCKED_BY_USER_RULES);
        states[id] = { state: BLOCKED_BY_USER_RULES, observedPrefix: null, detail: blockedMessage(t, source, config, entry) };
        run.sources[id].rules = rules;
        const text = t('curate.source_blocked', { source: id, reason: states[id].detail });
        run.warnings.push(text);
        io.stderr.write(`${text}\n`);
        log('source_blocked', { source: id, rules });
      }
    };
    // The meeting notes leave the round, before any model work on them,
    // when the calendar they need is configured but will not be read
    // (WAITING_FOR_CALENDAR). True when they just left.
    const waitForCalendar = () => {
      const notes = SECOND_DOOR.source;
      const cal = SECOND_DOOR.through;
      if (!offered.some((s) => s.id === notes) || unavailable.has(notes) || !active.some((s) => s.id === cal)) return false;
      const calOffered = offered.some((s) => s.id === cal);
      if (calOffered && !unavailable.has(cal)) return false;
      const state = calOffered ? unavailable.get(cal) : 'not_offered';
      unavailable.set(notes, WAITING_FOR_CALENDAR);
      run.sources[notes].waitingFor = { source: cal, state };
      const text = t('curate.source_waiting', { source: notes, calendar: cal, state });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('source_waiting', { source: notes, through: cal, state });
      return true;
    };
    const connectorsLeft = () => offered.filter((s) => s.kind === 'connector' && !unavailable.has(s.id));
    let choice = chooseMode({ config, root, env, readFiles, readDirs, candidates: offered.filter((s) => s.kind === 'connector'), connectorDenies });
    run.mode = choice.mode;
    run.userRules = choice.userRules;
    block(choice.blocked);
    if (waitForCalendar()) {
      choice = chooseMode({ config, root, env, readFiles, readDirs, candidates: connectorsLeft(), connectorDenies });
      run.mode = choice.mode;
      run.userRules = choice.userRules ?? run.userRules;
      block(choice.blocked);
    }
    const offeredLine = sourcesLineFor(offered);
    const promptNow = () => renderCuratePrompt({
      vaultRoot: root, config, lang: vaultLang, now, sourcesLine: offeredLine,
      parameters: renderParameters(tv, { window, tz, plans, sources: offered, days, config, deferred, unavailable, pending, relisted: computed.relisted }),
    });
    let prompt = promptNow();
    let argvList = modelArgv(config, machine, choice.tools, choice.mode);
    let readable = offered.filter((source) => !unavailable.has(source.id));
    // Nothing left for a model: every source it could read is a local one
    // that lists nothing (the others unavailable), or there is none.
    const nothingLeft = () => readable.every((source) => source.kind === 'local')
      && emptyWindow(Object.fromEntries(readable.map((source) => [source.id, plans[source.id]])));

    // --check stops before the model.
    if (parsed.check) {
      io.stdout.write(`${t('curate.check_window', { days: window.days.map(shown).join(', '), from: run.window.from, to: run.window.to })}\n`);
      for (const line of modeLines(t, choice)) io.stdout.write(`${line}\n`);
      for (const line of sourceLines(t, { active, plans, days, unavailable, config, blocks: true })) io.stdout.write(`${line}\n`);
      io.stdout.write(`${t('curate.check_argv', { bin: claudeBin, argv: JSON.stringify(argvList) })}\n`);
      for (const line of settingLines(t, config)) io.stdout.write(`${line}\n`);
      io.stdout.write(`${t('curate.check_prompt', { chars: prompt.length, bytes: Buffer.byteLength(prompt) })}\n`);
      run.exit = EXIT.OK;
      run.reasonCode = 'check';
      run.reason = t('curate.check_done', {});
      return EXIT.OK;
    }
    if (interrupted) return fail(EXIT.FAILURE, 'interrupted', t('curate.interrupted', { signal: interrupted }));

    // 13. The model: one launch, and once more without what the first
    // one's init event showed unavailable (decision D4). Never a third.
    onStep('model');
    const streamFile = keepStream ? join(stateDir, STATE_FILES.LOG_DIR, `curate-${roundStamp(now)}.stream.jsonl`) : null;
    let out = null;
    let isolationAbort = null;
    let launchMode = choice.mode;
    let launchTools = choice.tools;
    // The kill timer: the owner's curate.timeout_minutes, or none; a test
    // hands in its own milliseconds.
    const minutes = roundTimeoutMinutes(config);
    const timeoutMs = deps.roundTimeoutMs ?? (minutes === null ? null : minutes * 60 * 1000);
    if (!nothingLeft()) {
      // The digests the prompt names, written only now that a model is
      // about to read them (never by --check or --dry), each cut said.
      for (const source of offered.filter((s) => s.kind === 'local')) {
        const plan = plans[source.id];
        const written = writeDigests(plan);
        if (written === 0) continue;
        const cut = plan.files.filter((file) => file.digest.cutMessages > 0);
        log('digests', { source: source.id, written, cut: cut.map((file) => ({ session: file.session, kept: file.digest.kept, held: file.digest.held, messages: file.digest.cutMessages, chars: file.digest.cutChars })) });
        for (const file of cut) {
          const what = t('sources.transcripts.digest_cut', { messages: file.digest.cutMessages, chars: file.digest.cutChars });
          const text = t('curate.digest_cut', { source: source.id, session: file.session, kept: file.digest.kept, held: file.digest.held, cut: what });
          run.warnings.push(text);
          io.stderr.write(`${text}\n`);
        }
        if (cut.length > 0) digestNotes.push(t('curate.reason_digest_cut', { source: source.id, sessions: cut.map((file) => file.session).join(', ') }));
      }
      io.stdout.write(`${t('curate.model_start', { days: window.days.map(shown).join(', ') })}\n`);
      for (const line of settingLines(t, config)) io.stdout.write(`${line}\n`);
      run.budgetUsd = roundBudget(config);
      run.maxTurns = roundTurns(config);
      run.timeoutMinutes = timeoutMs === null ? null : timeoutMs / 60000;
    }
    for (let launch = 1; !nothingLeft(); launch += 1) {
      const launchSources = choice.available;
      const specs = launchSources.map((source) => source.serverSpec(config));
      run.mode = launchMode;
      run.relaunched = launch > 1;
      log('model_start', { launch, mode: launchMode, argv: argvList });
      let init = null;
      let hooks = 0;
      let lateHooks = 0;
      let seen = null;
      let relaunch = false;
      const launchControl = new AbortController();
      const onLine = (line) => {
        if (streamFile !== null) appendFileSync(streamFile, `${line}\n`, { mode: 0o600 });
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event === null || typeof event !== 'object' || event.type !== 'system' || typeof event.subtype !== 'string') return;
        const isHook = event.subtype.startsWith('hook_');
        if (isHook) hooks += 1;
        // A hook after the init event arrives while the model may already be
        // working (a PreToolUse hook rewrote a command in the measurement of
        // 24/09/2026): it kills the model at once, like one before init.
        if (isHook && init !== null) lateHooks += 1;
        const first = event.subtype === 'init' && init === null;
        if (first) init = event;
        if (!isHook && event.subtype !== 'init') return;
        let checked = checkIsolation({ init, hookEvents: hooks, hookEventsAfterInit: lateHooks }, { mode: launchMode, disallowed: launchTools.disallowed });
        // A hook before the init event is a hook, not a missing init.
        if (isHook && init === null) {
          const details = checked.details.filter((d) => d.code !== 'no_init');
          checked = { ok: false, problems: details.map((d) => d.code), details };
        }
        if (!checked.ok) {
          isolationAbort = checked;
          launchControl.abort('isolation');
          return;
        }
        // Each connector source's state, from this very launch's init event
        // (decision D2). On the first launch, one that is not there stops
        // the model before its first turn: the round goes on without it.
        if (first && launchMode === 'connectors') {
          seen = connectorStates(init, specs);
          if (launch === 1 && launchSources.some((source) => RELAUNCH_STATES.includes(seen[source.id].state))) {
            relaunch = true;
            launchControl.abort('relaunch');
          }
        }
      };
      out = await (deps.runModel ?? runModel)({
        claudeBin, argv: argvList, prompt, cwd: root, env: childEnv, timeoutMs, onLine,
        abortSignal: AbortSignal.any([controller.signal, launchControl.signal]),
        ...(deps.killGraceMs !== undefined ? { killGraceMs: deps.killGraceMs } : {}),
      });
      if (seen !== null) {
        for (const source of launchSources) {
          const entry = seen[source.id];
          const spec = source.serverSpec(config);
          const message = connectorStateMessage(spec, entry);
          states[source.id] = { state: entry.state, observedPrefix: entry.observedPrefix, detail: t(message.messageKey, message.params) };
        }
        log('connectors', { launch, states: Object.fromEntries(launchSources.map((s) => [s.id, seen[s.id].state])) });
      }
      log('model_end', {
        launch, exitCode: out.exitCode, signal: out.signal, timedOut: out.timedOut, aborted: out.aborted === null ? null : String(out.aborted),
        subtype: out.record.result?.subtype ?? null, isError: out.record.result?.isError ?? null, costUsd: out.record.result?.costUsd ?? null,
        numTurns: out.record.result?.numTurns ?? null, durationMs: out.durationMs,
      });
      // The whole stream of a launch stopped for a relaunch is still read
      // for a hook the kill came too late to stop, before any relaunch.
      if (relaunch && isolationAbort === null) {
        const whole = checkIsolation(out.record, { mode: launchMode, disallowed: launchTools.disallowed });
        if (!whole.ok) isolationAbort = whole;
      }
      if (!relaunch || isolationAbort !== null || interrupted) {
        if (launch > 1 && seen !== null) {
          // No second relaunch: a source still missing stays in the round,
          // and its evidence leaves its day open.
          for (const source of launchSources) {
            const entry = seen[source.id];
            if (entry.state === 'connected' || entry.state === 'pending') continue;
            const text = t('curate.connector_not_relaunched', { source: source.id, state: entry.state, detail: states[source.id].detail });
            run.warnings.push(text);
            io.stderr.write(`${text}\n`);
          }
        }
        break;
      }
      // The relaunch: the sources the init event showed missing leave the
      // round, each named with its state; one still connecting stays, and
      // the next launch's parameters say so (ruling R-B1).
      const gone = [];
      for (const source of launchSources) {
        const { state } = seen[source.id];
        if (RELAUNCH_STATES.includes(state)) {
          unavailable.set(source.id, state);
          gone.push(source.id);
          const text = t('curate.connector_unavailable', { source: source.id, state, detail: states[source.id].detail });
          run.warnings.push(text);
          io.stderr.write(`${text}\n`);
        } else if (state === 'pending') {
          pending.add(source.id);
        }
      }
      if (waitForCalendar()) gone.push(SECOND_DOOR.source);
      log('relaunch', { without: gone, states: Object.fromEntries(gone.map((id) => [id, unavailable.get(id)])) });
      readable = offered.filter((source) => !unavailable.has(source.id));
      if (readable.length > 0) {
        choice = chooseMode({ config, root, env, readFiles, readDirs, candidates: connectorsLeft(), connectorDenies });
        run.userRules = choice.userRules ?? run.userRules;
        block(choice.blocked);
        readable = offered.filter((source) => !unavailable.has(source.id));
      }
      if (nothingLeft()) {
        out = null;
        break;
      }
      launchMode = choice.mode;
      launchTools = choice.tools;
      prompt = promptNow();
      argvList = modelArgv(config, machine, choice.tools, choice.mode);
      io.stdout.write(`${t('curate.relaunch', { sources: gone.join(', ') })}\n`);
    }

    // Each connector source's state goes in the report and in the states
    // carried to the next round; a best-effort one whose state changed is
    // announced once (step 18). `pending` says nothing yet about the
    // connector (ruling R-B1): it is reported, never carried.
    for (const source of offered.filter((s) => s.kind === 'connector')) {
      const entry = states[source.id];
      if (entry === undefined) continue;
      run.sources[source.id].state = entry.state;
      run.sources[source.id].observedPrefix = entry.observedPrefix;
      if (entry.state === 'pending') continue;
      // A source never seen before counts as connected for the notify-once
      // rule, and its first notice does not claim it was.
      const seenBefore = run.connectorStates[source.id] !== undefined;
      const before = run.connectorStates[source.id]?.state ?? 'connected';
      run.connectorStates[source.id] = { state: entry.state, at: run.at };
      if (entry.state === before || required.includes(source.id)) continue;
      log('connector_state_changed', { source: source.id, from: before, to: entry.state });
      if (entry.state === 'connected') notices.push(t('curate.connector_restored', { source: source.id, previous: before, doc: CONNECTORS_DOC }));
      else if (!seenBefore) notices.push(t('curate.connector_seen', { source: source.id, state: entry.state, detail: entry.detail, doc: CONNECTORS_DOC }));
      else notices.push(t('curate.connector_changed', { source: source.id, state: entry.state, previous: before, detail: entry.detail, doc: CONNECTORS_DOC }));
    }
    const offeredIds = offered.map((source) => source.id);

    // Nothing was left for a model to read: no model ran a turn. A required
    // source left unread makes that exit 4, and no mark moves; otherwise
    // each readable source (local, listing nothing) advances vacuously, as
    // an empty window does, and an unavailable one keeps its day open.
    if (out === null && isolationAbort === null) {
      onStep('evidence');
      const evidence = evidenceFor(offered, plans, null);
      for (const source of offered) {
        run.sources[source.id].read = evidence[source.id].read;
        if (source.kind === 'connector') run.sources[source.id].expected = evidence[source.id].expected;
      }
      const unread = unreadRequired(evidence, required.filter((id) => offeredIds.includes(id)));
      if (unread.length > 0) {
        const sources = unread.map((id) => `${id} (${evidence[id].read}/${evidence[id].expected ?? '-'})`).join(', ');
        return fail(EXIT.SOURCE_UNREAD, 'source_unread', t('curate.source_unread', { sources }));
      }
      onStep('watermark');
      for (const source of readable) {
        const through = days[source.id].at(-1);
        const moved = advanceWatermark(stateDir, source.id, through, { vacuous: true, evidence: evidence[source.id], timezone: tz, now, emptyMeansNothingListed: source.emptyMeansNothingListed !== false });
        run.sources[source.id].advanced = moved.advanced;
        log('watermark', { source: source.id, day: through, vacuous: true, ...moved });
        if (!moved.advanced) io.stderr.write(`${t('curate.not_advanced', { source: source.id, reason: moved.reason })}\n`);
      }
      for (const source of offered.filter((s) => unavailable.get(s.id) === WAITING_FOR_CALENDAR)) {
        log('watermark', { source: source.id, day: null, advanced: false, reason: WAITING_FOR_CALENDAR });
        io.stderr.write(`${t('curate.not_advanced', { source: source.id, reason: WAITING_FOR_CALENDAR })}\n`);
      }
      const listed = offered.filter((source) => unavailable.has(source.id)).map((source) => `${source.id} (${unavailable.get(source.id)})`).join(', ');
      run.exit = EXIT.OK;
      run.reasonCode = 'nothing_available';
      run.reason = t('curate.nothing_available', { sources: listed || '-' });
      return EXIT.OK;
    }

    const record = out.record;
    const result = record.result;
    run.costUsd = result?.costUsd ?? null;
    run.numTurns = result?.numTurns ?? null;
    run.denials = record.denials.map((d) => ({ toolName: d.toolName ?? null }));
    const isolation = isolationAbort ?? checkIsolation(record, { mode: launchMode, disallowed: launchTools.disallowed });
    // A CLI that printed nothing at all (it died before its first event,
    // as on an expired login) never started a model that could do work
    // unisolated: that is a model failure, mapped below (69 or 1), not an
    // isolation breach. Any event without an init is still a breach.
    const neverStarted = record.events.length === 0 && isolation.problems.length === 1 && isolation.problems[0] === 'no_init';
    const isolationFailed = !isolation.ok && !neverStarted;
    run.isolation = { ok: isolation.ok, problems: isolation.problems };
    log('model_result', { denials: run.denials.map((d) => d.toolName), isolation: run.isolation });

    // 14. Evidence, the sources line and the round record.
    onStep('evidence');
    const evidence = evidenceFor(offered, plans, record);
    const sourcesLine = parseSourcesLine(result?.text ?? null);
    for (const source of offered) {
      const entry = run.sources[source.id];
      entry.read = evidence[source.id].read;
      if (source.kind !== 'connector') continue;
      entry.expected = evidence[source.id].expected;
      entry.listed = Number.isInteger(evidence[source.id].listed) ? evidence[source.id].listed : null;
      entry.reported = reportedOf(sourcesLine, source.id);
      if (Object.hasOwn(entry, 'documents')) entry.documents = evidence[source.id].documents ?? null;
    }
    let proposals = [];
    let recordBroken = false;
    if (existsSync(recordFile) || isSymlink(recordFile)) {
      let parsedRecord = null;
      try {
        if (lstatSync(recordFile).isFile()) parsedRecord = parseRoundRecord(readFileSync(recordFile, 'utf8'));
      } catch {
        parsedRecord = null;
      }
      if (parsedRecord === null) {
        recordBroken = true;
        keepRecord = true;
      } else {
        proposals = parsedRecord.proposals;
      }
    }
    if (proposals.length > 0) {
      const paths = [...new Set(proposals.flatMap((p) => p.paths))].sort();
      const last = proposals.at(-1);
      run.proposed = {
        opened: proposals.every((p) => p.opened),
        branch: last.branch,
        paths,
        proposals: proposals.map((p) => ({ opened: p.opened, branch: p.branch, paths: p.paths })),
      };
    }

    // 15. Cleanup of what was proposed.
    onStep('cleanup');
    if (!recordBroken && proposals.length > 0) {
      const cleaned = cleanupProposals(root, proposals, env);
      log('cleanup', cleaned);
      if (cleaned.restored.length > 0) io.stdout.write(`${t('curate.cleanup_restored', { paths: cleaned.restored.join(', ') })}\n`);
      if (cleaned.changed.length > 0) io.stderr.write(`${t('curate.cleanup_changed', { paths: cleaned.changed.join(', ') })}\n`);
    }
    run.leftovers = dirtyPaths(root, { env });

    // 16. The exit, first match wins.
    // Success is the CLI's own exit 0 with no signal (review finding I5: a
    // CLI killed by a signal nobody in the round sent is never a success)
    // and a result that is a success, not an error in disguise.
    const modelOk = out.exitCode === 0 && out.signal === null && !out.timedOut && out.aborted === null && out.spawnError === null
      && result !== null && !result.isError && result.subtype === 'success';
    // Only a required source the round offered can leave it unread: one
    // with no day of its own had nothing to read.
    const unread = unreadRequired(evidence, required.filter((id) => offeredIds.includes(id)));
    let exit;
    if (isolationFailed) {
      exit = fail(EXIT.FAILURE, 'isolation', t('curate.isolation_failed', { problems: isolation.details.map((d) => t(d.messageKey, d.params)).join('; ') }));
    } else if (interrupted) {
      exit = fail(EXIT.FAILURE, 'interrupted', t('curate.interrupted', { signal: interrupted }));
    } else if (out.timedOut) {
      exit = fail(EXIT.FAILURE, 'timed_out', t('curate.model_timed_out', { minutes: Math.ceil(timeoutMs / 60000) }));
    } else if (!modelOk) {
      const subtype = result?.subtype ?? '-';
      // An error result's own text, on one line and cut at 300 characters,
      // goes in the reason (the round of 30/09/2026 reported only "-"), with
      // the round's token hidden. The CLI's standard error is reported only
      // by the markers found in it on an API error (review finding M5), and
      // by its last line otherwise.
      const said = errorText(result, [lock.token]);
      const limitText = [said, out.stderrTail].find((text) => USAGE_LIMIT_PATTERNS.some((re) => re.test(text)));
      if (isLoginFailure(result)) {
        // An expired login is not a model failure and no retry fixes it:
        // exit 69 with what the person must do, and no mark moves.
        exit = fail(EXIT.UNAVAILABLE, 'auth_expired', t('curate.auth_expired', { detail: said || '-' }));
      } else if (limitText !== undefined) {
        // A spent usage limit lifts on its own: postponed on purpose (75),
        // with the hour it resets, and no mark moves. A known cause.
        const resets = /resets[^\n]*/i.exec(limitText)?.[0].slice(0, 300).trim() || '-';
        exit = fail(EXIT.TEMPFAIL, 'usage_limited', t('curate.usage_limited', { resets }));
      } else if (API_ERROR.test(out.stderrTail) || (result?.isError === true && API_ERROR.test(result.text ?? ''))) {
        const markers = API_MARKERS.map((re) => re.exec(out.stderrTail)?.[0]).filter(Boolean).join(', ');
        const detail = [said, markers].filter(Boolean).join('; ') || '-';
        exit = fail(EXIT.UNAVAILABLE, 'model_unavailable', t('curate.model_unavailable', { subtype, detail }));
      } else {
        const detail = [said, lastLine(out.stderrTail)].filter(Boolean).join('; ') || (out.spawnError ?? '-');
        exit = fail(EXIT.FAILURE, 'model_failed', withUnknownCause(t('curate.model_failed', { subtype, code: String(out.exitCode ?? out.signal ?? '-'), detail })));
      }
    } else if (unread.length > 0) {
      const sources = unread.map((id) => `${id} (${evidence[id].read}/${evidence[id].expected ?? '-'})`).join(', ');
      let reason = t('curate.source_unread', { sources });
      // A curate overlay that kept the old sample-from-end wording sends the
      // model to the transcripts themselves, which the round no longer
      // grants (fix round 1): its denials say so, and so does the reason.
      const raw = new Set(offered.filter((s) => s.kind === 'local').flatMap((s) => (plans[s.id]?.files ?? []).map((file) => file.path)));
      const deniedRaw = record.denials.filter((d) => d.toolName === 'Read' && raw.has(d.input?.file_path)).length;
      if (deniedRaw > 0) reason = `${reason} ${t('curate.hint_old_overlay', { count: deniedRaw, command: 'brain-kit prompt --check' })}`;
      exit = fail(EXIT.SOURCE_UNREAD, 'source_unread', reason);
    } else if (recordBroken) {
      exit = fail(EXIT.FAILURE, 'record_invalid', t('curate.record_invalid', { file: 'brain-kit-round-<token>.json', dir: recordDirOf(recordFile) }));
    } else if (run.leftovers.length > 0) {
      exit = fail(EXIT.FAILURE, 'leftovers', t('curate.leftovers', { paths: run.leftovers.join(', ') }));
    } else if (proposals.some((p) => !p.opened)) {
      // What to run, in the reason itself: propose's own message went to
      // the model's tool result, which nobody reads (final review I1).
      const branches = [...new Set(proposals.filter((p) => !p.opened).map((p) => p.branch))];
      const commands = branches.map((branch) => `gh pr create --head ${branch} --fill`).join('; ');
      exit = fail(EXIT.DEGRADED, 'not_opened', t('curate.not_opened', { branches: branches.join(', '), commands }));
    } else {
      exit = EXIT.OK;
      run.exit = EXIT.OK;
      run.reasonCode = proposals.length > 0 ? 'proposed' : 'nothing_proposed';
      run.reason = proposals.length > 0
        ? t('curate.done_proposed', { branch: run.proposed.branch, count: run.proposed.paths.length })
        : t('curate.done_nothing', {});
    }

    // 17. The watermark, only on 0 or 3: each source through its own last
    // day, by its own advance rule (src/guards/watermark.mjs).
    onStep('watermark');
    const stuck = [];
    if (exit === EXIT.OK || exit === EXIT.DEGRADED) {
      for (const source of offered) {
        const waiting = unavailable.get(source.id) === WAITING_FOR_CALENDAR;
        // A source unavailable on its own account keeps its day open by its
        // own evidence, never reported as a second door left unread.
        const door = unavailable.has(source.id) ? null : secondDoor(source, { active, offered, days, evidence, unavailable });
        const through = waiting ? null : door === null ? days[source.id].at(-1) : door.through;
        const reported = reportedOf(sourcesLine, source.id);
        let moved;
        if (waiting) moved = { advanced: false, reason: WAITING_FOR_CALENDAR };
        else if (through === null) moved = { advanced: false, reason: 'second_door_unread' };
        else moved = advanceWatermark(stateDir, source.id, through, {
          modelExit: modelOk ? 0 : 1, evidence: evidence[source.id], sourcesLine, timezone: tz, now, emptyMeansNothingListed: source.emptyMeansNothingListed !== false,
        });
        run.sources[source.id].advanced = moved.advanced;
        log('watermark', { source: source.id, day: through, reported, ...moved });
        if (!moved.advanced) io.stderr.write(`${t('curate.not_advanced', { source: source.id, reason: moved.reason })}\n`);
        if (!moved.advanced && moved.reason !== 'not_later' && required.includes(source.id)) stuck.push(`${source.id} (${moved.reason})`);
      }
    }
    // A round that otherwise succeeded but left a required source's day
    // open (no BRAIN_KIT_SOURCES line, the source reported failed or
    // empty with files) is never exit 0 (review finding I1): 4, notified.
    if (exit === EXIT.OK && stuck.length > 0) {
      exit = fail(EXIT.SOURCE_UNREAD, 'source_not_advanced', t('curate.source_not_advanced', { sources: stuck.join(', ') }));
    }
    // The round's last word to the person says which days a digest left
    // open and which digests were cut, whatever the exit.
    if (digestNotes.length > 0) run.reason = [run.reason, ...digestNotes].filter(Boolean).join(' ');
    return exit;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function recordDirOf(file) {
  return file.slice(0, file.lastIndexOf(sep));
}

function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).at(-1)?.slice(0, 300) ?? '';
}

// The last line of a text that is not blank, whole (a cut could drop the
// words a pattern looks for), or null.
function lastNonEmptyLine(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '').at(-1) ?? null;
}

// Step 18: last-run.json, the log's last line, the lock, the notification.
// The model's process group is already dead: runModel kills it before it
// resolves, so no child of the round outlives the lock.
// The round's own files in logs/ (its dated log, a kept stream and the
// folder of digests kept with it), and nothing else, older than
// machine.log_retention_days (30 by default).
const OWN_LOG_FILE = /^curate-(?:\d{4}-\d{2}-\d{2}\.log|[0-9TZ-]+\.stream\.jsonl)$/;
const OWN_DIGEST_DIR = /^curate-[0-9TZ-]+-[0-9a-f]{8}\.digests$/;
const DEFAULT_LOG_RETENTION_DAYS = 30;

function pruneLogs(stateDir, machine, now = Date.now()) {
  const days = Number.isInteger(machine?.log_retention_days) && machine.log_retention_days > 0 ? machine.log_retention_days : DEFAULT_LOG_RETENTION_DAYS;
  const dir = join(stateDir, STATE_FILES.LOG_DIR);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const limit = now - days * 24 * 60 * 60 * 1000;
  for (const name of names) {
    const file = OWN_LOG_FILE.test(name);
    if (!file && !OWN_DIGEST_DIR.test(name)) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.mtimeMs >= limit) continue;
      if (file && st.isFile()) rmSync(join(dir, name), { force: true });
      else if (!file && st.isDirectory()) rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // A file that went away or cannot be read is left to the next round.
    }
  }
}

function notify(machine, env, log, text) {
  if (!Array.isArray(machine?.notify_command) || machine.notify_command.length === 0) return;
  const [program, ...args] = machine.notify_command;
  const notified = spawnSync(expandHome(program, env), [...args, text], { env, stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS });
  if (notified.error || notified.status !== 0) log('notify_failed', { status: notified.status, error: notified.error ? notified.error.code : null });
}

// `notices` are the round's other notifications (a best-effort connector
// source whose state changed), sent whatever the exit, one each.
function finishRound({ run, io, log, stateDir, machine, env, started, lock, writeLastRun, check, notices = [] }) {
  run.durationMs = Date.now() - started;
  pruneLogs(stateDir, machine);
  const exit = run.exit ?? EXIT.FAILURE;
  if (run.reason) (exit === EXIT.OK ? io.stdout : io.stderr).write(`${run.reason}\n`);
  if (writeLastRun) {
    try {
      ensureStateDir(stateDir);
      writePrivate(join(stateDir, STATE_FILES.LAST_RUN), `${JSON.stringify(run, null, 2)}\n`);
    } catch (error) {
      io.stderr.write(`brain-kit curate: ${STATE_FILES.LAST_RUN}: ${error.code ?? error.message}\n`);
    }
  }
  log('exit', { exit, reasonCode: run.reasonCode, reason: run.reason, check });
  if (lock !== null) lock.release();
  if (exit !== EXIT.OK) notify(machine, env, log, run.reason ?? String(exit));
  for (const text of notices) {
    log('notify_state', { text });
    notify(machine, env, log, text);
  }
  return exit;
}

// Step 2.
function dryRun({ root, stateDir, machine, claudeBin, io, env, now, keepStream }) {
  const config = loadConfig(root);
  // The preview speaks the vault's language, as the round it previews does.
  const t = createTranslator(SUPPORTED_LANGS.includes(config.lang) ? config.lang : 'en');
  io.stdout.write(`${t('curate.dry_header', {})}\n`);
  if (config.curate?.enabled === false) {
    io.stdout.write(`${t('curate.disabled', { file: CONFIG_FILENAME })}\n`);
    return EXIT.OK;
  }
  const unscoped = unscopedRules(config.curate?.allowed_tools_extra ?? []);
  if (unscoped.length > 0) {
    io.stderr.write(`${t('curate.allowed_unscoped', { rules: unscoped.join(', '), setting: ALLOWED_EXTRA_SETTING })}\n`);
    return EXIT.USAGE;
  }
  const tz = config.vault?.timezone;
  const { active, off, required, unknownRequired, unknownBestEffort } = sourcesOf(config);
  let computed;
  try {
    computed = computeWindow(stateDir, active, now, tz);
  } catch (error) {
    if (error instanceof WatermarkError) {
      io.stderr.write(`${t('curate.watermark_unreadable', { file: error.file, detail: error.detail })}\n`);
      return EXIT.FAILURE;
    }
    if (error instanceof RangeError) {
      io.stderr.write(`${t('curate.bad_timezone', { timezone: String(tz), file: CONFIG_FILENAME })}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }
  if (computed.future) {
    const { source, day, yesterday } = computed.future;
    const command = reopenCommand(source, yesterday);
    io.stderr.write(`${t('curate.watermark_future', { source, day: shown(day), yesterday: shown(yesterday), command })}\n`);
    return EXIT.FAILURE;
  }
  const { window } = computed;
  const days = { ...computed.days };
  if (window.days.length === 0) {
    io.stdout.write(`${t('curate.up_to_date', {})}\n`);
    return EXIT.OK;
  }
  io.stdout.write(`${t('curate.check_window', { days: window.days.map(shown).join(', '), from: window.from.toISOString(), to: window.to.toISOString() })}\n`);
  // An unknown required source is a refusal, said below; an unknown best-effort one is only skipped.
  for (const id of unknownBestEffort) io.stdout.write(`${t('curate.source_skipped', { source: id })}\n`);
  for (const source of off) io.stdout.write(`${t('curate.check_source_off', { source: source.id, problems: problemText(offProblems(source, config, now, tz)) || '-' })}\n`);
  const offered = active.filter((source) => days[source.id].length > 0);
  // The digests are built in memory to name them as the round would; a dry
  // run writes none.
  const plans = collectPlans(offered, days, config, machine, env, now, tz, digestDirFor(stateDir, now, keepStream), root);
  // A round that would refuse over a source it cannot do without says so
  // here, with its own sentence and exit code, instead of previewing a round
  // that will not happen.
  const refusal = requiredRefusal(t, { config, now, tz, required, unknownRequired, off, offered, plans });
  if (refusal !== null) {
    io.stderr.write(`${t('curate.dry_would_refuse', { code: REQUIRED_SOURCE_EXIT, reason: refusal.text })}\n`);
    return REQUIRED_SOURCE_EXIT;
  }
  for (const source of offered) {
    const over = plans[source.id].overCap;
    if (over) io.stdout.write(`${t('curate.dry_cap_exceeded', { day: shown(over.day), count: over.files, cap: plans[source.id].cap, setting: `${CONFIG_FILENAME} curate.caps.${source.id}` })}\n`);
  }
  for (const capped of capDays(offered, plans, days)) {
    const setting = `${CONFIG_FILENAME} curate.caps.${capped.source.id}`;
    if (capped.byCap.length > 0) io.stdout.write(`${t('curate.dry_days_deferred', { last: shown(capped.last), count: capped.byCap.length, days: capped.byCap.map(shown).join(', '), setting, cap: capped.cap })}\n`);
    if (capped.byDigest.length > 0) io.stdout.write(`${t('curate.dry_days_deferred_digest', { source: capped.source.id, last: shown(capped.last), count: capped.byDigest.length, days: capped.byDigest.map(shown).join(', '), sessions: capped.sessions.join(', ') })}\n`);
  }
  const connectorDenies = [...new Set(active.filter((s) => s.kind === 'connector').flatMap((s) => s.toolRules(config).deny))];
  const unsafeDigests = unsafeDigestDir(offered, plans);
  if (unsafeDigests !== null) {
    io.stderr.write(`${t('curate.digest_dir_unsafe', { dir: unsafeDigests.dir, characters: unsafeDigests.characters })}\n`);
    return EXIT.FAILURE;
  }
  const digests = readFilesOf(offered, plans).length;
  const { readFiles, readDirs } = readGrantsOf(offered, plans);
  let choice = chooseMode({ config, root, env, readFiles, readDirs, candidates: offered.filter((s) => s.kind === 'connector'), connectorDenies });
  const blocked = choice.blocked;
  const unavailable = new Map([...blocked.keys()].map((id) => [id, BLOCKED_BY_USER_RULES]));
  // The meeting notes wait for a calendar the round will not read, as the
  // round itself decides (WAITING_FOR_CALENDAR).
  const notes = SECOND_DOOR.source;
  const cal = SECOND_DOOR.through;
  let waiting = null;
  if (offered.some((s) => s.id === notes) && !unavailable.has(notes) && active.some((s) => s.id === cal) && (!offered.some((s) => s.id === cal) || unavailable.has(cal))) {
    waiting = unavailable.get(cal) ?? 'not_offered';
    unavailable.set(notes, WAITING_FOR_CALENDAR);
    choice = chooseMode({ config, root, env, readFiles, readDirs, candidates: offered.filter((s) => s.kind === 'connector' && !unavailable.has(s.id)), connectorDenies });
  }
  for (const line of modeLines(t, choice)) io.stdout.write(`${line}\n`);
  for (const [id, entry] of blocked) io.stdout.write(`${t('curate.source_blocked', { source: id, reason: blockedMessage(t, SOURCES[id], config, entry) })}\n`);
  if (waiting !== null) io.stdout.write(`${t('curate.source_waiting', { source: notes, calendar: cal, state: waiting })}\n`);
  for (const line of sourceLines(t, { active, plans, days, unavailable, config, blocks: false })) io.stdout.write(`${line}\n`);
  if (digests > 0) io.stdout.write(`${t('curate.dry_digests', { count: digests })}\n`);
  const argv = modelArgv(config, machine, choice.tools, choice.mode);
  io.stdout.write(`${t('curate.check_argv', { bin: claudeBin, argv: JSON.stringify(argv) })}\n`);
  for (const line of settingLines(t, config)) io.stdout.write(`${line}\n`);
  return EXIT.OK;
}
