// The `preflight` command: every fact the morning briefing states,
// computed by the kit (src/briefing/facts.mjs), printed for a person or as
// JSON for the briefing's prompt.
//
//   brain-kit preflight [dir] [--json]
//
// Only reads: no lock, no fetch, no write. The text is in the vault's own
// language (config.lang), like `validate`'s report; the usage errors before
// a vault is found are in the caller's. Exit 0, or 2 outside a vault (or
// with a configuration that cannot be used, such as a time zone this system
// does not know).
//
// The JSON carries `version` and then exactly the keys briefingFacts
// returns, in its order: consumers parse it, so adding a key is not a
// version bump and removing or renaming one is.
//
// `deps` hands in the environment, the working directory, the clock and
// briefingFacts' own deps, for the tests. Production passes nothing.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, ConfigError, loadConfig, loadMachine, MACHINE_FILENAME } from '../config.mjs';
import { createTranslator, REFERENCE_LANG, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { stateDirFor } from '../state.mjs';
import { localDay } from '../guards/watermark.mjs';
import { briefingFacts, humanDay } from '../briefing/facts.mjs';

const ROOT_INDEX = 'index.md';
export const PREFLIGHT_JSON_VERSION = 'brain-kit.preflight/1';

function parseArgs(argv) {
  const result = { dir: undefined, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) return { error: arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: arg };
  }
  return result;
}

function weekdayName(t, weekday) {
  switch (weekday) {
    case 'monday': return t('preflight.weekday_monday');
    case 'tuesday': return t('preflight.weekday_tuesday');
    case 'wednesday': return t('preflight.weekday_wednesday');
    case 'thursday': return t('preflight.weekday_thursday');
    case 'friday': return t('preflight.weekday_friday');
    case 'saturday': return t('preflight.weekday_saturday');
    default: return t('preflight.weekday_sunday');
  }
}

// What an exit code of a round means, as cli.usage lists them.
function exitMeaning(t, exit) {
  switch (exit) {
    case null: return t('preflight.exit_none');
    case EXIT.OK: return t('preflight.exit_ok');
    case EXIT.FAILURE: return t('preflight.exit_failure');
    case EXIT.USAGE: return t('preflight.exit_usage');
    case EXIT.DEGRADED: return t('preflight.exit_degraded');
    case EXIT.SOURCE_UNREAD: return t('preflight.exit_source_unread');
    case EXIT.UNAVAILABLE: return t('preflight.exit_unavailable');
    case EXIT.TEMPFAIL: return t('preflight.exit_tempfail');
    default: return t('preflight.exit_other');
  }
}

function yesNo(t, value) {
  if (value === true) return t('preflight.yes');
  if (value === false) return t('preflight.no');
  return t('preflight.unknown');
}

export function renderLastRun(facts, t) {
  const lines = [];
  const run = facts.lastRun;
  if (run === null) lines.push(t('preflight.last_run_none'));
  else if (run.problem !== null) lines.push(t('preflight.last_run_unreadable', { detail: run.problem }));
  else {
    lines.push(t('preflight.last_run', { at: run.atHuman ?? '-', exit: run.exit ?? '-', meaning: exitMeaning(t, run.exit), reason: run.reasonCode ?? '-' }));
    for (const [source, entry] of Object.entries(run.sources)) {
      lines.push(t('preflight.last_run_source', { source, state: entry.state ?? '-', advanced: yesNo(t, entry.advanced) }));
    }
  }
  const carried = Object.entries(facts.connectorStates);
  if (carried.length === 0) lines.push(t('preflight.connectors_none'));
  else {
    lines.push(t('preflight.connectors_header'));
    for (const [source, entry] of carried) lines.push(t('preflight.connector', { source, state: entry.state, at: entry.atHuman ?? '-' }));
  }
  return lines;
}

export function renderPullRequests(facts, t) {
  const prs = facts.openPullRequests;
  if (!prs.ok) {
    if (prs.reason === 'absent') return [t('preflight.prs_absent')];
    if (prs.reason === 'failed') return [t('preflight.prs_failed', { detail: prs.detail ?? '-' })];
    return [t('preflight.prs_unreadable', { detail: prs.detail ?? '-' })];
  }
  if (prs.items.length === 0) return [t('preflight.prs_none')];
  const lines = [t('preflight.prs_header', { count: prs.items.length })];
  for (const pr of prs.items) lines.push(t('preflight.pr', { number: pr.number, title: pr.title, created: pr.createdHuman ?? '-', url: pr.url }));
  return lines;
}

export function renderStale(facts, t) {
  const stale = facts.stale;
  if (!stale.ok) return [t('preflight.stale_unknown')];
  if (stale.count === 0) return [t('preflight.stale_none')];
  const lines = [t('preflight.stale_header', { count: stale.count })];
  for (const note of stale.notes) lines.push(t('preflight.stale_note', { path: note.path, date: note.staleAfterHuman ?? '-' }));
  return lines;
}

function problemLine(t, { code, detail }) {
  switch (code) {
    case 'not_configured': return t('preflight.problem_not_configured', { file: detail.file });
    case 'heading_not_configured': return t('preflight.problem_heading_not_configured', { file: detail.file, heading: detail.heading });
    case 'duplicate_entry': return t('preflight.problem_duplicate_entry', { path: detail.path, heading: detail.heading });
    case 'never_read': return t('preflight.problem_never_read', { path: detail.path });
    case 'file_missing': return t('preflight.problem_file_missing', { path: detail.path });
    case 'unreadable': return t('preflight.problem_unreadable', { path: detail.path, detail: detail.detail });
    case 'heading_missing': return t('preflight.problem_heading_missing', { path: detail.path, heading: detail.heading });
    case 'table_missing': return t('preflight.problem_table_missing', { path: detail.path, heading: detail.heading });
    case 'heading_repeated': return t('preflight.problem_heading_repeated', { path: detail.path, heading: detail.heading });
    case 'tables_ignored': return t('preflight.problem_tables_ignored', { path: detail.path, heading: detail.heading, count: detail.count });
    case 'column_missing': return t('preflight.problem_column_missing', { path: detail.path, line: detail.line, heading: detail.heading, column: detail.column });
    case 'invalid_date': return t('preflight.problem_invalid_date', { path: detail.path, line: detail.line, value: detail.value });
    case 'date_without_year': return t('preflight.problem_date_without_year', { path: detail.path, line: detail.line, value: detail.value });
    default: return t('preflight.problem_unknown', { code, detail: JSON.stringify(detail) });
  }
}

function itemLines(t, items) {
  if (items.length === 0) return [t('preflight.none')];
  return items.map((item) => (item.deadline === null
    ? t('preflight.pending_item_undated', { what: item.what === '' ? '-' : item.what, raw: item.raw, file: item.file, line: item.line })
    : t('preflight.pending_item', { what: item.what === '' ? '-' : item.what, deadline: humanDay(item.deadline), file: item.file, line: item.line })));
}

export function renderPending(facts, t) {
  const pending = facts.pending;
  const lines = [
    t('preflight.pending_overdue', { count: pending.overdue.length }), ...itemLines(t, pending.overdue),
    t('preflight.pending_today', { count: pending.today.length }), ...itemLines(t, pending.today),
    t('preflight.pending_upcoming', { days: pending.upcomingDays, count: pending.upcoming.length }), ...itemLines(t, pending.upcoming),
    t('preflight.pending_undated', { count: pending.undated.length }), ...itemLines(t, pending.undated),
    t('preflight.pending_later', { days: pending.upcomingDays, count: pending.later }),
  ];
  if (pending.problems.length > 0) {
    lines.push(t('preflight.pending_problems', { count: pending.problems.length }));
    for (const problem of pending.problems) lines.push(problemLine(t, problem));
  }
  return lines;
}

function gitReason(t, reason) {
  if (reason === 'not_a_repository') return t('preflight.git_reason_not_a_repository');
  if (reason === 'no_default_branch') return t('preflight.git_reason_no_default_branch');
  if (reason === 'no_upstream') return t('preflight.git_reason_no_upstream');
  if (reason === 'no_remote') return t('preflight.git_reason_no_remote');
  if (reason === 'no_remote_ref') return t('preflight.git_reason_no_remote_ref');
  if (reason === 'no_local_branch') return t('preflight.git_reason_no_local_branch');
  return t('preflight.git_reason_failed', { detail: String(reason).replace(/^git_failed: /, '') });
}

export function renderGit(facts, t) {
  const git = facts.git;
  if (git.reason === 'not_a_repository' || (git.dirty === null && git.reason !== null)) {
    return [t('preflight.git_unknown', { reason: gitReason(t, git.reason) })];
  }
  const branch = git.branch ?? t('preflight.detached');
  const lines = [t('preflight.git_tree', { branch, changed: git.dirty })];
  if (git.behind !== null && git.ahead !== null) {
    lines.push(t('preflight.git_upstream', { branch: git.defaultBranch, behind: git.behind, ahead: git.ahead, upstream: git.upstream }));
  } else {
    lines.push(t('preflight.git_upstream_unknown', { branch: git.defaultBranch ?? t('preflight.default_branch'), reason: gitReason(t, git.reason) }));
  }
  return lines;
}

export function renderLock(facts, t) {
  const lock = facts.lock;
  if (lock.held === null) return [t('preflight.lock_unknown', { reason: lock.reason ?? '-' })];
  if (lock.held) return [t('preflight.lock_held', { command: lock.command ?? '-' })];
  return [t('preflight.lock_free')];
}

export function renderPreflight(facts, t, { vault }) {
  return [
    t('preflight.header', { vault, timezone: facts.tz }),
    t('preflight.today', { weekday: weekdayName(t, facts.weekday), date: facts.todayHuman }),
    ...renderLastRun(facts, t),
    ...renderPullRequests(facts, t),
    ...renderStale(facts, t),
    ...renderPending(facts, t),
    ...renderGit(facts, t),
    ...renderLock(facts, t),
  ].join('\n');
}

export async function runPreflight(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('preflight.bad_argument', { arg: parsed.error })}\n`);
    io.stderr.write(`${t('preflight.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('preflight.usage')}\n`);
    return EXIT.OK;
  }

  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('preflight.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('preflight.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('preflight.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root); // a ConfigError: src/cli.mjs's boundary makes it exit 2
  const reportT = createTranslator(SUPPORTED_LANGS.includes(config.lang) ? config.lang : REFERENCE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  const stateDir = stateDirFor(root, env);
  // No machine.json is an answer (a vault not registered on this machine);
  // one that cannot be read is said, on stderr, and the facts go on without
  // it: nothing the preflight states comes from it.
  let machine = null;
  if (existsSync(join(stateDir, MACHINE_FILENAME))) {
    try {
      machine = loadMachine(stateDir);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      io.stderr.write(`${reportT('preflight.machine_unreadable', { detail: error.message })}\n`);
    }
  }

  try {
    localDay(now, config.vault.timezone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    io.stderr.write(`${reportT('preflight.bad_timezone', { timezone: config.vault.timezone, file: CONFIG_FILENAME })}\n`);
    return EXIT.USAGE;
  }
  const facts = briefingFacts({ root, config, machine, stateDir, now, env, deps: deps.facts ?? {} });
  if (parsed.json) {
    io.stdout.write(`${JSON.stringify({ version: PREFLIGHT_JSON_VERSION, ...facts }, null, 2)}\n`);
    return EXIT.OK;
  }
  io.stdout.write(`${renderPreflight(facts, reportT, { vault: root })}\n`);
  return EXIT.OK;
}
