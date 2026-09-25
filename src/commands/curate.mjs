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
//       as it is, unsynced, and the output says so (ruling R4)
//    3. take the vault lock; held: exit 75 naming the holder
//    4. wait for the network; none: exit 69 (did_not_wait is a note, R14)
//    5. sync in process, under the round's lock; diverged: 75; failed: 1
//    6. only now load the configuration and check the prompt it names and
//       the allow rules it adds (one that grants a path or command tool
//       with no scope: exit 2), so a synced configuration is what runs
//       (incident 14/09/2026)
//    7. the window from the watermark; a mark in the future: exit 1 naming
//       `brain-kit watermark reopen`; nothing open: exit 0
//    8. a dirty tree: exit 75 naming every file
//    9. the round's own snapshot
//   10. the CLI is a real program; not: exit 1
//   11. collect the sources; a required source misconfigured: exit 1 and no
//       mark moves; a required source listing a file it cannot read, or a
//       first open day with more transcripts than the cap: exit 4 before
//       the model, no mark moves; days past the cap are deferred and the
//       window ends at the last covered day; nothing in the window:
//       advance vacuously and exit 0
//   12. --check: print the plan and the prompt's size, exit 0
//   13. run the model, isolated; an init event that fails the isolation
//       check kills it at once: exit 1
//   14. read evidence, the sources line and the round record
//   15. bring what the round proposed back to HEAD's content, byte-proved
//   16. the exit code, first match wins: isolation 1; model failure 69 or
//       1; a required source unread 4; a round record that cannot be read
//       1; anything still dirty 1; a proposal not opened 3; otherwise 0
//   17. advance each source's watermark, only on 0 or 3
//   18. always: remove the round record, write last-run.json, append the
//       log, release the lock (the model's process group already dead) and
//       run machine.notify_command on any non-zero exit
//
// The log (logs/curate-<date>.log in the state directory) holds one line
// per event, never a tool result, the model's final text or anything read
// from a transcript, and never the round's token. --check and --dry write
// no last-run.json: a round that did not run the model is not a round a
// reader of last-run should take for one.
//
// `deps` carries the environment, the working directory, the clock, the
// network wait's timing and a step observer, for the tests. Production
// passes nothing.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, ConfigError, loadConfig, loadMachine } from '../config.mjs';
import { createTranslator, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { ensureStateDir, stateDirFor, STATE_FILES } from '../state.mjs';
import { decodeBytes } from '../io.mjs';
import { dirtyPaths, runGit } from '../git.mjs';
import { expandHome } from '../doctor/checks.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { waitForNetwork } from '../guards/network.mjs';
import { checkDirtyTree } from '../guards/dirty-tree.mjs';
import { takeSnapshot } from '../guards/snapshot.mjs';
import { checkCli } from '../guards/cli.mjs';
import { checkIsolation } from '../guards/isolation.mjs';
import { evidenceFor, unreadRequired } from '../guards/read-evidence.mjs';
import { emptyWindow } from '../guards/empty-window.mjs';
import {
  addDays, advanceWatermark, localDay, parseSourcesLine, readWatermark, startOfDay, windowFor, WatermarkError,
} from '../guards/watermark.mjs';
import { buildArgv, runModel, unscopedRules } from '../harness/claude-code.mjs';
import { allowedTools, disallowedTools, kitCommand } from '../curate/tools.mjs';
import { transcriptsSource } from '../sources/transcripts-claude-code.mjs';
import { syncUnderLock } from './sync.mjs';
import { parseRoundRecord, roundRecordPath } from './propose.mjs';
import { promptOutsideVault, renderCuratePrompt } from './prompt.mjs';

const ROOT_INDEX = 'index.md';

// The longest a round's model may run. An unattended round that hangs
// holds the vault's lock for as long as it runs, and the next scheduled
// window (hours later) would find it held; an hour is far beyond any round
// measured (minutes) and well inside the gap between two windows.
export const ROUND_TIMEOUT_MS = 60 * 60 * 1000;

// Used only when the configuration does not set them (ruling R10: a round
// always runs bounded).
const FALLBACK_MAX_TURNS = 100;
const FALLBACK_BUDGET_USD = 5;
const NOTIFY_TIMEOUT_MS = 30000;
// The setting a vault adds allow rules with, as a person finds it.
const ALLOWED_EXTRA_SETTING = `${CONFIG_FILENAME} curate.allowed_tools_extra`;
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

// The sources this version can read, by the id the configuration names
// them with. A configured id missing here is refused when required and
// skipped, loudly, when best effort.
export const SOURCES = Object.freeze({ transcripts: transcriptsSource });

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

// The sources this round runs, and the configured ids it cannot.
function sourcesOf(config) {
  const required = [...new Set(config.curate?.sources?.required ?? [])];
  const bestEffort = [...new Set(config.curate?.sources?.best_effort ?? [])].filter((id) => !required.includes(id));
  const active = [...required, ...bestEffort].filter((id) => Object.hasOwn(SOURCES, id)).map((id) => SOURCES[id]);
  return {
    required,
    active,
    unknownRequired: required.filter((id) => !Object.hasOwn(SOURCES, id)),
    unknownBestEffort: bestEffort.filter((id) => !Object.hasOwn(SOURCES, id)),
  };
}

// The window: from the earliest mark among the sources the round runs (an
// unset mark reads only yesterday), so no source loses a day; each source
// then advances on its own. A mark later than yesterday on any source is
// the error state windowFor reports as `future`.
function computeWindow(stateDir, sources, now, tz) {
  const mark = readWatermark(stateDir);
  const yesterday = addDays(localDay(now, tz), -1);
  // windowFor's own verdict on each source's mark, never a second
  // comparison here that could disagree with it (review finding I4).
  for (const source of sources) {
    const day = mark.sources[source.id];
    if (day !== undefined && windowFor(day, now, tz).future) return { future: { source: source.id, day, yesterday } };
  }
  let earliest = null;
  for (const source of sources) {
    const effective = mark.sources[source.id] ?? addDays(yesterday, -1);
    if (earliest === null || effective < earliest) earliest = effective;
  }
  return { window: windowFor(earliest ?? addDays(yesterday, -1), now, tz), marks: mark.sources };
}

function collectPlans(sources, window, config, machine, env, now, tz) {
  const plans = {};
  const home = env.HOME || undefined;
  for (const source of sources) {
    plans[source.id] = source.collect({ window: { from: window.from, to: window.to, days: window.days, timezone: tz }, config, machine, now, ...(home ? { home } : {}) });
  }
  return plans;
}

// The whole days every source could take within its cap (plan.daysCovered,
// C1 of the final review): the window a round curates, and advances
// through, ends at the earliest last covered day among them. Returns null
// when every day is covered, otherwise the narrowed window, the deferred
// days, and the source that set the bound. A source that does not report
// daysCovered takes every day; one whose plan was collected over the wider
// window is collected again over the narrowed one.
function narrowWindow(window, plans, sources, tz) {
  let bound = null;
  for (const source of sources) {
    const covered = plans[source.id]?.daysCovered;
    if (!Array.isArray(covered)) continue;
    const last = covered.at(-1);
    if (last === undefined || last >= window.days.at(-1)) continue;
    if (bound === null || last < bound.last) bound = { last, source };
  }
  if (bound === null) return null;
  const days = window.days.filter((day) => day <= bound.last);
  return {
    window: { ...window, days, to: startOfDay(addDays(bound.last, 1), tz) },
    deferred: window.days.filter((day) => day > bound.last),
    source: bound.source,
    cap: plans[bound.source.id].cap,
  };
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

// The setting a person fixes for each misconfiguration code.
function settingFor(code) {
  if (code === 'root_missing' || code === 'root_unreadable') return 'machine.json transcripts_dir';
  return `${CONFIG_FILENAME} sources.transcripts.include_projects`;
}

function problemText(problems) {
  return problems.map((p) => (p.detail ? `${p.code} (${p.detail})` : p.code)).join(', ');
}

function renderParameters(t, { window, tz, plans, sources, config, deferred }) {
  const lines = [];
  lines.push(t('curate.params.days', { days: window.days.map(shown).join(', '), timezone: tz }));
  lines.push(t('curate.params.window', { from: window.from.toISOString(), to: window.to.toISOString() }));
  if (deferred.length > 0) lines.push(t('curate.params.deferred', { count: deferred.length, days: deferred.map(shown).join(', ') }));
  if (window.remaining > 0) lines.push(t('curate.params.remaining', { count: window.remaining }));
  for (const source of sources) {
    lines.push('');
    lines.push(t('curate.params.source', { source: source.id }));
    lines.push(plans[source.id].promptBlock);
  }
  lines.push('');
  const caps = Object.entries(config.curate?.caps ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
  lines.push(t('curate.params.caps', { caps: caps === '' ? '-' : caps }));
  lines.push(t('curate.params.kit', { kit: kitCommand() }));
  return lines.join('\n');
}

// The files outside the vault the model may read: every file a local
// source's plan lists, each one by its exact path (ruling R-A2 of
// 24/09/2026), never its folder, so a session the plan left out stays
// unreadable.
function readFilesOf(sources, plans) {
  return sources.filter((source) => source.kind === 'local').flatMap((source) => (plans[source.id]?.files ?? []).map((file) => file.path));
}

// The round's allow and deny lists. The deny list also tells the isolation
// check which built-in tools the round removed by name (ruling R-B4).
function roundTools(config, readFiles) {
  return {
    allowed: allowedTools(config.curate?.allowed_tools_extra ?? [], { readFiles }),
    disallowed: disallowedTools(config.curate?.disallowed_tools_extra ?? []),
  };
}

function modelArgv(config, machine, tools) {
  return buildArgv({
    model: machine.model ?? undefined,
    maxTurns: config.curate?.max_turns ?? FALLBACK_MAX_TURNS,
    budgetUsd: config.curate?.budget_usd ?? FALLBACK_BUDGET_USD,
    allowed: tools.allowed,
    disallowed: tools.disallowed,
  });
}

// The environment the model runs with: the caller's, the round's token
// (so the `propose` it runs joins the round's lock), and machine.path_extra
// in front of PATH.
function modelEnv(env, machine, token) {
  const extra = (machine.path_extra ?? []).map((dir) => expandHome(String(dir), env));
  const path = [...extra, env.PATH ?? ''].filter((part) => part !== '').join(delimiter);
  const out = { ...env, PATH: path };
  if (token !== null) out.BRAIN_KIT_ROUND_TOKEN = token;
  return out;
}

// ---------------------------------------------------------------- cleanup

// Every blob of a commit's tree: decoded name -> { mode, sha, bytes }.
function treeOf(root, commit, env) {
  const listed = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { env, encoding: 'buffer' });
  if (listed.status !== 0) throw new Error(`git ls-tree ${commit} exited with status ${listed.status}`);
  const out = new Map();
  const buf = Buffer.from(listed.stdout);
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    const record = buf.subarray(start, end === -1 ? buf.length : end);
    start = end === -1 ? buf.length : end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    const [mode, type, sha] = record.subarray(0, tab).toString('latin1').split(' ');
    if (type !== 'blob') continue;
    const bytes = Buffer.from(record.subarray(tab + 1));
    out.set(decodeBytes(bytes), { mode, sha, bytes });
  }
  return out;
}

function blobBytes(root, sha, env) {
  const shown = runGit(root, ['cat-file', 'blob', sha], { env, encoding: 'buffer' });
  if (shown.status !== 0) throw new Error(`git cat-file blob ${sha} exited with status ${shown.status}`);
  return Buffer.from(shown.stdout);
}

// What is on disk at `pathBytes`: null (absent), { link: Buffer } or
// { file: Buffer }; a directory or anything else is { other: true }.
function onDisk(root, pathBytes) {
  const full = Buffer.concat([Buffer.from(root.endsWith('/') ? root : `${root}/`), pathBytes]);
  let st;
  try {
    st = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (st.isSymbolicLink()) return { full, link: readlinkSync(full, { encoding: 'buffer' }) };
  if (st.isFile()) return { full, file: readFileSync(full) };
  return { full, other: true };
}

// Step 15. For each path a proposal named (the latest proposal naming it,
// when several did), compare the working tree's bytes with that
// proposal's commit: equal, or absent from both, means the tree holds
// exactly what was pushed, and the path is brought back to HEAD (restored
// from HEAD when HEAD has it, deleted when it does not). Anything else was
// changed after the push and is left alone. Git runs without the caller's
// git environment (runGit), with literal pathspecs read NUL-separated from
// standard input, never from the argument vector.
export function cleanupProposals(root, proposals, env) {
  const latest = new Map();
  for (const proposal of proposals) for (const path of proposal.paths) latest.set(path, proposal);
  const head = treeOf(root, 'HEAD', env);
  const trees = new Map();
  const restored = [];
  const changed = [];
  const fromHead = [];
  for (const [path, proposal] of latest) {
    if (!trees.has(proposal.commit)) trees.set(proposal.commit, treeOf(root, proposal.commit, env));
    const pushed = trees.get(proposal.commit).get(path) ?? null;
    const atHead = head.get(path) ?? null;
    const pathBytes = pushed?.bytes ?? atHead?.bytes ?? Buffer.from(path, 'utf8');
    const disk = onDisk(root, pathBytes);
    let same;
    if (pushed === null) same = disk === null;
    else if (disk === null || disk.other) same = false;
    else if (pushed.mode === '120000') same = disk.link !== undefined && disk.link.equals(blobBytes(root, pushed.sha, env));
    else same = disk.file !== undefined && disk.file.equals(blobBytes(root, pushed.sha, env));
    if (!same) {
      changed.push(path);
      continue;
    }
    if (atHead !== null) fromHead.push(atHead.bytes);
    else if (disk !== null) rmSync(disk.full, { force: true });
    restored.push(path);
  }
  if (fromHead.length > 0) {
    const input = Buffer.concat(fromHead.flatMap((bytes) => [bytes, Buffer.from([0])]));
    const done = runGit(root, ['--literal-pathspecs', 'checkout', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input, encoding: 'buffer' });
    if (done.status !== 0) throw new Error(`git checkout HEAD exited with status ${done.status}: ${decodeBytes(Buffer.from(done.stderr)).trim()}`);
  }
  return { restored: restored.sort(), changed: changed.sort() };
}

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
    const reason = t('curate.machine_invalid', { detail: error.message });
    io.stderr.write(`${reason}\n`);
    log('exit', { exit: EXIT.USAGE, reason: 'machine_invalid' });
    if (writesState) {
      try {
        ensureStateDir(stateDir);
        writePrivate(join(stateDir, STATE_FILES.LAST_RUN), `${JSON.stringify({ at: now.toISOString(), durationMs: Date.now() - started, exit: EXIT.USAGE, reasonCode: 'machine_invalid', reason }, null, 2)}\n`);
      } catch {
        // as above
      }
    }
    return EXIT.USAGE;
  }
  const claudeBin = expandHome(machine.claude_bin, env);

  // 2. --dry: a read-only preview, from the working tree as it is.
  if (parsed.dry) return dryRun({ root, stateDir, machine, claudeBin, io, env, now });

  // The round's own state, filled as it goes and written at the end.
  const run = {
    at: now.toISOString(), durationMs: null, exit: null, reasonCode: null, reason: null, window: null, network: null,
    sources: {}, warnings: [], remainingDays: 0, deferredDays: [], costUsd: null, numTurns: null, denials: [], isolation: null, proposed: null, leftovers: [],
  };
  let lock = null;
  let recordFile = null;
  let keepRecord = false;
  let interrupted = null;
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

  // 3. The lock.
  onStep('lock');
  try {
    lock = acquireLock(root, { command: 'curate', env });
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    const reason = t(error.messageKey, error.params);
    run.exit = error.exitCode;
    run.reasonCode = 'lock_held';
    run.reason = reason;
    return finishRound({ run, io, log, stateDir, machine, env, started, lock: null, writeLastRun: true, check: false });
  }
  recordFile = roundRecordPath(root, lock.token, env);
  log('start', { root, check: parsed.check });
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);

  try {
    await roundUnderLock();
  } catch (error) {
    fail(EXIT.FAILURE, 'internal_error', t('curate.internal_error', { detail: error instanceof Error ? error.message : String(error) }));
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onSignal);
    if (recordFile !== null) {
      if (!keepRecord) rmSync(recordFile, { force: true });
      rmSync(`${recordFile}.lock`, { force: true });
    }
  }
  return finishRound({ run, io, log, stateDir, machine, env, started, lock, writeLastRun: !parsed.check, check: parsed.check });

  async function roundUnderLock() {
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

    // 5. Sync, under the lock this round holds.
    onStep('sync');
    const outcome = {};
    let synced;
    try {
      synced = syncUnderLock(root, io, t, env, outcome);
    } catch (error) {
      io.stderr.write(`${t('sync.git_failed', { detail: error.message })}\n`);
      synced = EXIT.FAILURE;
    }
    // A diverged base is exit 1, not 75: retrying cannot fix it, a person
    // must reconcile the two histories (controller ruling, fix round 1).
    if (outcome.diverged) return fail(EXIT.FAILURE, 'sync_diverged', t('curate.sync_diverged', {}));
    if (synced === EXIT.TEMPFAIL) {
      // Sync postpones first on a dirty tree; the round's own reason names
      // the files, as step 8 would (review finding M6).
      const early = checkDirtyTree(root, null, { env });
      if (!early.ok) {
        const files = early.files.map((f) => `${f.path} (${f.mtime ?? '-'})`).join(', ');
        return fail(EXIT.TEMPFAIL, 'dirty_tree', t('curate.dirty', { files }));
      }
      return fail(EXIT.TEMPFAIL, 'sync_postponed', t('curate.sync_postponed', {}));
    }
    if (synced !== EXIT.OK) return fail(EXIT.FAILURE, 'sync_failed', t('curate.sync_failed', {}));

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
    const { active, required, unknownRequired, unknownBestEffort } = sourcesOf(config);

    // 7. The window.
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
    run.window = { days: window.days, from: window.from.toISOString(), to: window.to.toISOString(), remaining: window.remaining };
    if (window.days.length === 0) {
      run.exit = EXIT.OK;
      run.reasonCode = 'up_to_date';
      run.reason = t('curate.up_to_date', {});
      return EXIT.OK;
    }
    let lastDay = window.days.at(-1);
    if (window.remaining > 0) {
      // Catching up oldest first: the mark moves through the last day read
      // here, and the newer days wait for the next round (never closed).
      run.remainingDays = window.remaining;
      const text = t('curate.days_remaining', { count: window.remaining, last: shown(lastDay) });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('days_remaining', { count: window.remaining, through: lastDay });
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
    const cli = checkCli(claudeBin, { env: childEnv });
    if (!cli.ok) return fail(EXIT.FAILURE, `cli_${cli.problem}`, t('curate.cli_unusable', { problem: t(cli.messageKey, cli.params) }));

    // 11. The sources.
    onStep('sources');
    if (unknownRequired.length > 0) {
      const setting = `${CONFIG_FILENAME} curate.sources.required`;
      return fail(EXIT.FAILURE, 'source_unknown', t('curate.source_unknown', { sources: unknownRequired.join(', '), setting }));
    }
    for (const id of unknownBestEffort) {
      const text = t('curate.source_skipped', { source: id });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('source_skipped', { source: id });
    }
    let plans = collectPlans(active, window, config, machine, env, now, tz);
    for (const source of active) {
      const plan = plans[source.id];
      run.sources[source.id] = { kept: plan.files.length, read: 0, advanced: false, noTimestamp: plan.dropped?.noTimestamp ?? 0 };
      if (plan.misconfigured && required.includes(source.id)) {
        const codes = plan.problems.filter((p) => ['no_projects', 'root_missing', 'root_unreadable', 'project_missing'].includes(p.code));
        const setting = settingFor(codes[0]?.code ?? 'no_projects');
        return fail(EXIT.FAILURE, 'source_misconfigured', t('curate.source_misconfigured', { source: source.id, setting, problems: problemText(plan.problems) }));
      }
      if (plan.problems.length > 0) {
        const text = t('curate.source_warning', { source: source.id, problems: problemText(plan.problems) });
        run.warnings.push(text);
        io.stderr.write(`${text}\n`);
        log('source_warning', { source: source.id, problems: plan.problems.map((p) => p.code) });
      }
    }
    // A file a required source cannot read keeps its day open whatever the
    // model does, so the model is not started at all: running it would
    // spend the round and open a pull request for a day that cannot close,
    // and every retry would open it again (final review I2).
    for (const id of required) {
      const unreadable = plans[id]?.unreadable ?? [];
      if (unreadable.length === 0) continue;
      const setting = `${CONFIG_FILENAME} sources.${id}.exclude_path_patterns`;
      log('plan', { [id]: { kept: plans[id].files.length, dropped: plans[id].dropped } });
      let reason = t('curate.source_unreadable', { source: id, files: unreadable.map((f) => f.path).join(', '), setting, command: `brain-kit watermark assume-covered ${id}` });
      // A file whose path no read permission can name exactly: renaming
      // it, not its permissions, is the fix, and the reason says so.
      const unsafe = unreadable.filter((f) => Array.isArray(f.unsafe));
      if (unsafe.length > 0) {
        const unsafeFiles = unsafe.map((f) => f.path).join(', ');
        const characters = [...new Set(unsafe.flatMap((f) => f.unsafe))].join(' ');
        reason = `${reason} ${t('curate.source_unsafe_paths', { files: unsafeFiles, characters })}`;
      }
      return fail(EXIT.SOURCE_UNREAD, 'source_unreadable', reason);
    }
    // The first open day alone over a source's cap: no whole day fits, and
    // a round never reads part of a day (final review C1).
    for (const source of active) {
      const over = plans[source.id].overCap;
      if (!over) continue;
      const setting = `${CONFIG_FILENAME} curate.caps.${source.id}`;
      log('plan', { [source.id]: { kept: 0, dropped: plans[source.id].dropped, overCap: over } });
      return fail(EXIT.SOURCE_UNREAD, 'cap_exceeded', t('curate.cap_exceeded', { day: shown(over.day), count: over.files, cap: plans[source.id].cap, setting }));
    }
    // Days past the cap wait for the next round; this one curates, and
    // advances through, only the whole days it could take.
    const narrowed = narrowWindow(window, plans, active, tz);
    let deferred = [];
    if (narrowed !== null) {
      ({ window, deferred } = narrowed);
      lastDay = window.days.at(-1);
      const again = active.filter((source) => !Array.isArray(plans[source.id].daysCovered));
      if (again.length > 0) plans = { ...plans, ...collectPlans(again, window, config, machine, env, now, tz) };
      for (const source of active) run.sources[source.id].kept = plans[source.id].files.length;
      run.window = { ...run.window, days: window.days, to: window.to.toISOString() };
      run.deferredDays = deferred;
      const setting = `${CONFIG_FILENAME} curate.caps.${narrowed.source.id}`;
      const text = t('curate.days_deferred', { last: shown(lastDay), count: deferred.length, days: deferred.map(shown).join(', '), setting, cap: narrowed.cap });
      run.warnings.push(text);
      io.stderr.write(`${text}\n`);
      log('days_deferred', { through: lastDay, days: deferred, source: narrowed.source.id });
    }
    log('plan', Object.fromEntries(active.map((s) => [s.id, { kept: plans[s.id].files.length, dropped: plans[s.id].dropped }])));
    if (emptyWindow(plans)) {
      if (parsed.check) {
        run.exit = EXIT.OK;
        run.reasonCode = 'nothing_to_curate';
        run.reason = t('curate.nothing_to_curate', { days: window.days.map(shown).join(', ') });
        return EXIT.OK;
      }
      const evidence = evidenceFor(active, plans, null);
      for (const source of active) {
        const moved = advanceWatermark(stateDir, source.id, lastDay, { vacuous: true, evidence: evidence[source.id], timezone: tz, now });
        run.sources[source.id].advanced = moved.advanced;
        log('watermark', { source: source.id, day: lastDay, vacuous: true, ...moved });
      }
      run.exit = EXIT.OK;
      run.reasonCode = 'nothing_to_curate';
      run.reason = t('curate.nothing_to_curate', { days: window.days.map(shown).join(', ') });
      return EXIT.OK;
    }

    const parameters = renderParameters(tv, { window, tz, plans, sources: active, config, deferred });
    const prompt = renderCuratePrompt({ vaultRoot: root, config, lang: vaultLang, parameters, now });
    const tools = roundTools(config, readFilesOf(active, plans));
    const argvList = modelArgv(config, machine, tools);

    // 12. --check stops before the model.
    if (parsed.check) {
      io.stdout.write(`${t('curate.check_window', { days: window.days.map(shown).join(', '), from: run.window.from, to: run.window.to })}\n`);
      for (const source of active) io.stdout.write(`${t('curate.check_source', { source: source.id, kept: plans[source.id].files.length })}\n${plans[source.id].promptBlock}\n`);
      io.stdout.write(`${t('curate.check_argv', { bin: claudeBin, argv: JSON.stringify(argvList) })}\n`);
      io.stdout.write(`${t('curate.check_prompt', { chars: prompt.length, bytes: Buffer.byteLength(prompt) })}\n`);
      run.exit = EXIT.OK;
      run.reasonCode = 'check';
      run.reason = t('curate.check_done', {});
      return EXIT.OK;
    }
    if (interrupted) return fail(EXIT.FAILURE, 'interrupted', t('curate.interrupted', { signal: interrupted }));

    // 13. The model, isolated.
    onStep('model');
    io.stdout.write(`${t('curate.model_start', { days: window.days.map(shown).join(', ') })}\n`);
    log('model_start', { argv: argvList });
    const keepStream = parsed.keepStream || machine.keep_stream === true;
    const streamFile = keepStream ? join(stateDir, STATE_FILES.LOG_DIR, `curate-${now.toISOString().replace(/[:.]/g, '-')}.stream.jsonl`) : null;
    let init = null;
    let hooks = 0;
    let lateHooks = 0;
    let isolationAbort = null;
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
      if (event.subtype === 'init' && init === null) init = event;
      if (!isHook && event.subtype !== 'init') return;
      let checked = checkIsolation({ init, hookEvents: hooks, hookEventsAfterInit: lateHooks }, { disallowed: tools.disallowed });
      // A hook before the init event is a hook, not a missing init.
      if (isHook && init === null) {
        const details = checked.details.filter((d) => d.code !== 'no_init');
        checked = { ok: false, problems: details.map((d) => d.code), details };
      }
      if (!checked.ok) {
        isolationAbort = checked;
        controller.abort('isolation');
      }
    };
    const out = await runModel({
      claudeBin, argv: argvList, prompt, cwd: root, env: childEnv, timeoutMs: deps.roundTimeoutMs ?? ROUND_TIMEOUT_MS, onLine, abortSignal: controller.signal,
      ...(deps.killGraceMs !== undefined ? { killGraceMs: deps.killGraceMs } : {}),
    });
    const record = out.record;
    const result = record.result;
    run.costUsd = result?.costUsd ?? null;
    run.numTurns = result?.numTurns ?? null;
    run.denials = record.denials.map((d) => ({ toolName: d.toolName ?? null }));
    const isolation = isolationAbort ?? checkIsolation(record, { disallowed: tools.disallowed });
    // A CLI that printed nothing at all (it died before its first event,
    // as on an expired login) never started a model that could do work
    // unisolated: that is a model failure, mapped below (69 or 1), not an
    // isolation breach. Any event without an init is still a breach.
    const neverStarted = record.events.length === 0 && isolation.problems.length === 1 && isolation.problems[0] === 'no_init';
    const isolationFailed = !isolation.ok && !neverStarted;
    run.isolation = { ok: isolation.ok, problems: isolation.problems };
    log('model_end', {
      exitCode: out.exitCode, signal: out.signal, timedOut: out.timedOut, aborted: out.aborted === null ? null : String(out.aborted),
      subtype: result?.subtype ?? null, isError: result?.isError ?? null, costUsd: run.costUsd, numTurns: run.numTurns,
      denials: run.denials.map((d) => d.toolName), isolation: run.isolation, durationMs: out.durationMs,
    });

    // 14. Evidence, the sources line and the round record.
    onStep('evidence');
    const evidence = evidenceFor(active, plans, record);
    for (const source of active) run.sources[source.id].read = evidence[source.id].read;
    const sourcesLine = parseSourcesLine(result?.text ?? null);
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
    const unread = unreadRequired(evidence, required.filter((id) => Object.hasOwn(SOURCES, id)));
    let exit;
    if (isolationFailed) {
      exit = fail(EXIT.FAILURE, 'isolation', t('curate.isolation_failed', { problems: isolation.details.map((d) => t(d.messageKey, d.params)).join('; ') }));
    } else if (interrupted) {
      exit = fail(EXIT.FAILURE, 'interrupted', t('curate.interrupted', { signal: interrupted }));
    } else if (out.timedOut) {
      exit = fail(EXIT.FAILURE, 'timed_out', t('curate.model_timed_out', { minutes: Math.ceil((deps.roundTimeoutMs ?? ROUND_TIMEOUT_MS) / 60000) }));
    } else if (!modelOk) {
      const subtype = result?.subtype ?? '-';
      const api = API_ERROR.test(out.stderrTail) || (result?.isError === true && API_ERROR.test(result.text ?? ''));
      // On an API or login error only the markers found are reported, never
      // the CLI's own text (review finding M5); otherwise its last stderr line.
      const apiText = `${out.stderrTail}\n${result?.isError === true ? result.text ?? '' : ''}`;
      const detail = api
        ? API_MARKERS.map((re) => re.exec(apiText)?.[0]).filter(Boolean).join(', ')
        : lastLine(out.stderrTail) || (out.spawnError ?? '-');
      if (api) exit = fail(EXIT.UNAVAILABLE, 'model_unavailable', t('curate.model_unavailable', { subtype, detail }));
      else exit = fail(EXIT.FAILURE, 'model_failed', t('curate.model_failed', { subtype, code: String(out.exitCode ?? out.signal ?? '-'), detail }));
    } else if (unread.length > 0) {
      const sources = unread.map((id) => `${id} (${evidence[id].read}/${evidence[id].expected ?? '-'})`).join(', ');
      exit = fail(EXIT.SOURCE_UNREAD, 'source_unread', t('curate.source_unread', { sources }));
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

    // 17. The watermark, only on 0 or 3.
    onStep('watermark');
    const stuck = [];
    if (exit === EXIT.OK || exit === EXIT.DEGRADED) {
      for (const source of active) {
        const moved = advanceWatermark(stateDir, source.id, lastDay, { modelExit: modelOk ? 0 : 1, evidence: evidence[source.id], sourcesLine, timezone: tz, now });
        run.sources[source.id].advanced = moved.advanced;
        log('watermark', { source: source.id, day: lastDay, ...moved });
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

// Step 18: last-run.json, the log's last line, the lock, the notification.
// The model's process group is already dead: runModel kills it before it
// resolves, so no child of the round outlives the lock.
// The round's own files in logs/ (its dated log and a kept stream), and
// nothing else, older than machine.log_retention_days (30 by default).
const OWN_LOG_FILE = /^curate-(?:\d{4}-\d{2}-\d{2}\.log|[0-9TZ-]+\.stream\.jsonl)$/;
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
    if (!OWN_LOG_FILE.test(name)) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile() && st.mtimeMs < limit) rmSync(join(dir, name), { force: true });
    } catch {
      // A file that went away or cannot be read is left to the next round.
    }
  }
}

function finishRound({ run, io, log, stateDir, machine, env, started, lock, writeLastRun, check }) {
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
  if (exit !== EXIT.OK && Array.isArray(machine?.notify_command) && machine.notify_command.length > 0) {
    const [program, ...args] = machine.notify_command;
    const notified = spawnSync(expandHome(program, env), [...args, run.reason ?? String(exit)], { env, stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS });
    if (notified.error || notified.status !== 0) log('notify_failed', { status: notified.status, error: notified.error ? notified.error.code : null });
  }
  return exit;
}

// Step 2.
function dryRun({ root, stateDir, machine, claudeBin, io, env, now }) {
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
  const { active, unknownRequired, unknownBestEffort } = sourcesOf(config);
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
  if (window.days.length === 0) {
    io.stdout.write(`${t('curate.up_to_date', {})}\n`);
    return EXIT.OK;
  }
  io.stdout.write(`${t('curate.check_window', { days: window.days.map(shown).join(', '), from: window.from.toISOString(), to: window.to.toISOString() })}\n`);
  for (const id of [...unknownRequired, ...unknownBestEffort]) io.stdout.write(`${t('curate.source_skipped', { source: id })}\n`);
  const plans = collectPlans(active, window, config, machine, env, now, tz);
  for (const source of active) {
    const over = plans[source.id].overCap;
    if (over) io.stdout.write(`${t('curate.dry_cap_exceeded', { day: shown(over.day), count: over.files, cap: plans[source.id].cap, setting: `${CONFIG_FILENAME} curate.caps.${source.id}` })}\n`);
  }
  const narrowed = narrowWindow(window, plans, active, tz);
  if (narrowed !== null) {
    const setting = `${CONFIG_FILENAME} curate.caps.${narrowed.source.id}`;
    io.stdout.write(`${t('curate.dry_days_deferred', { last: shown(narrowed.window.days.at(-1)), count: narrowed.deferred.length, days: narrowed.deferred.map(shown).join(', '), setting, cap: narrowed.cap })}\n`);
  }
  for (const source of active) {
    io.stdout.write(`${t('curate.check_source', { source: source.id, kept: plans[source.id].files.length })}\n`);
    if (plans[source.id].problems.length > 0) io.stdout.write(`${t('curate.source_warning', { source: source.id, problems: problemText(plans[source.id].problems) })}\n`);
  }
  const argv = modelArgv(config, machine, roundTools(config, readFilesOf(active, plans)));
  io.stdout.write(`${t('curate.check_argv', { bin: claudeBin, argv: JSON.stringify(argv) })}\n`);
  return EXIT.OK;
}
