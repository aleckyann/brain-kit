// The `questions` command: the person's view of, and hand on, the
// briefing's question queue (src/briefing/questions.mjs).
//
//   brain-kit questions list [dir]
//   brain-kit questions add "<text>" [dir]
//   brain-kit questions answer <id> [dir]
//   brain-kit questions archive <id> [--reason "<text>"] [dir]
//   brain-kit questions sweep [dir]
//
// `list` prints every question with its state: open ones with how often
// they were asked, and whether they are escalated or due for archiving;
// answered and archived ones with their day. `add` queues a question unless
// it is a duplicate (same text once normalised, open, or answered within
// briefing.questions_dedup_days). `answer` and `archive` close one open
// question by id. `sweep` archives every open question older than
// briefing.question_max_age_days and prints each one it archived: nothing
// is archived in silence.
//
// The limits come from the vault's configuration: questions_dedup_days,
// question_escalate_after and question_max_age_days under `briefing`. A key
// the configuration does not set means no limit (null): nothing is
// deduplicated against an answered question, escalated or archived by a
// number the person never chose.
//
// "Today" is the calendar day in the vault's time zone (vault.timezone).
// Days a person reads are DD/MM/YYYY.
//
// A line of the queue that cannot be read is kept as it is by every write
// and reported by every subcommand, with its line number; `list` and
// `sweep` exit 1 when there is one, after doing their work.
//
// The writing subcommands take the vault lock (src/guards/lock.mjs), the
// same lock curate and propose take, joined as propose joins it when the
// command runs inside a scheduled round: the queue lives in the state
// directory the round writes too, and two writers of one queue would lose
// a question. `list` only reads, and every write is a rename, so it never
// sees half a file.
//
// `deps` hands in the environment, the working directory and the clock, for
// the tests. Production passes nothing.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { stateDirFor } from '../state.mjs';
import { joinOrAcquire } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { daysBetween, localDay } from '../guards/watermark.mjs';
import {
  addQuestion, answer, archive, isDueForArchive, isEscalated, normalizeQuestion, QUESTION_ID, QUESTION_STATUS, queueFile, queueSummary,
  readQueue, sweepQueue,
} from '../briefing/questions.mjs';

const ROOT_INDEX = 'index.md';
const SUBCOMMANDS = Object.freeze({ list: 0, add: 1, answer: 1, archive: 1, sweep: 0 });
const WRITING = new Set(['add', 'answer', 'archive', 'sweep']);

// A day as a person reads it (DD/MM/YYYY); YYYY-MM-DD stays for the file.
function shown(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

function parseArgs(argv) {
  const positional = [];
  let help = false;
  let reason;
  let options = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (options && arg === '--') options = false;
    else if (options && (arg === '--help' || arg === '-h')) help = true;
    else if (options && arg === '--reason') {
      if (i + 1 >= argv.length) return { error: 'missing_value', arg };
      i += 1;
      reason = argv[i];
    } else if (options && arg.startsWith('--reason=')) reason = arg.slice('--reason='.length);
    else if (options && arg.startsWith('-') && arg !== '-') return { error: 'argument', arg };
    else positional.push(arg);
  }
  if (help) return { help: true };
  const [sub, ...rest] = positional;
  if (sub === undefined) return { error: 'missing' };
  if (!Object.hasOwn(SUBCOMMANDS, sub)) return { error: 'subcommand', arg: sub };
  if (reason !== undefined && sub !== 'archive') return { error: 'reason_elsewhere' };
  if (reason !== undefined && reason.trim() === '') return { error: 'empty_reason' };
  const need = SUBCOMMANDS[sub];
  if (rest.length < need) return { error: 'missing' };
  if (rest.length > need + 1) return { error: 'argument', arg: rest[need + 1] };
  return { sub, operand: need === 1 ? rest[0] : undefined, dir: rest[need], reason: reason === undefined ? null : reason.trim() };
}

function usageError(io, t, parsed) {
  if (parsed.error === 'subcommand') io.stderr.write(`${t('questions.unknown_subcommand', { arg: parsed.arg })}\n`);
  else if (parsed.error === 'argument') io.stderr.write(`${t('questions.bad_argument', { arg: parsed.arg })}\n`);
  else if (parsed.error === 'missing_value') io.stderr.write(`${t('questions.missing_value', { option: parsed.arg })}\n`);
  else if (parsed.error === 'reason_elsewhere') io.stderr.write(`${t('questions.reason_only_archive')}\n`);
  else if (parsed.error === 'empty_reason') io.stderr.write(`${t('questions.empty_reason')}\n`);
  io.stderr.write(`${t('questions.usage')}\n`);
  return EXIT.USAGE;
}

// A briefing limit as the queue reads it: the configured integer, or null
// (no limit) when the configuration does not set one.
function limitOf(briefing, key) {
  const value = briefing?.[key];
  return Number.isInteger(value) ? value : null;
}

function corruptDetail(t, item) {
  if (item.reason === 'encoding') return t('questions.corrupt_encoding');
  if (item.reason === 'json') return t('questions.corrupt_json');
  return t('questions.corrupt_shape', { field: item.field });
}

// Every line that could not be read, one per line, on `stream`, then the
// count. True when there was one.
function reportCorrupt(stream, t, corrupt, file) {
  for (const item of corrupt) {
    stream.write(`${t('questions.corrupt_line', { line: item.line, detail: corruptDetail(t, item), raw: item.text })}\n`);
  }
  if (corrupt.length > 0) stream.write(`${t('questions.corrupt_summary', { count: corrupt.length, file })}\n`);
  return corrupt.length > 0;
}

function statusLabel(t, status) {
  return status === QUESTION_STATUS.ANSWERED ? t('questions.status_answered') : t('questions.status_archived');
}

function list(io, t, { file, today, tz, limits }) {
  const items = readQueue(limits.stateDir, { env: limits.env });
  const questions = items.filter((item) => item.corrupt !== true);
  const corrupt = items.filter((item) => item.corrupt === true);
  const count = (status) => questions.filter((q) => q.status === status).length;
  if (items.length === 0) {
    io.stdout.write(`${t('questions.list_empty', { file })}\n`);
    return EXIT.OK;
  }
  io.stdout.write(`${t('questions.list_header', {
    file, today: shown(today), timezone: tz, open: count(QUESTION_STATUS.OPEN), answered: count(QUESTION_STATUS.ANSWERED), archived: count(QUESTION_STATUS.ARCHIVED),
  })}\n`);
  for (const q of questions) {
    if (q.status === QUESTION_STATUS.OPEN) {
      const created = shown(q.createdOn);
      if (q.askedOn.length === 0) io.stdout.write(`${t('questions.list_open_never', { id: q.id, created, text: q.text })}\n`);
      else io.stdout.write(`${t('questions.list_open', { id: q.id, created, count: q.askedOn.length, text: q.text })}\n`);
      if (isEscalated(q, { escalateAfter: limits.escalateAfter })) {
        io.stdout.write(`${t('questions.list_escalated', { count: q.askedOn.length, limit: limits.escalateAfter })}\n`);
      }
      if (isDueForArchive(q, { today, maxAgeDays: limits.maxAgeDays })) {
        io.stdout.write(`${t('questions.list_due_archive', { days: daysBetween(q.createdOn, today), limit: limits.maxAgeDays })}\n`);
      }
    } else if (q.status === QUESTION_STATUS.ANSWERED) {
      io.stdout.write(`${t('questions.list_answered', { id: q.id, day: shown(q.answeredOn), text: q.text })}\n`);
    } else if (typeof q.archivedReason === 'string' && q.archivedReason !== '') {
      io.stdout.write(`${t('questions.list_archived_reason', { id: q.id, day: shown(q.archivedOn), reason: q.archivedReason, text: q.text })}\n`);
    } else {
      io.stdout.write(`${t('questions.list_archived', { id: q.id, day: shown(q.archivedOn), text: q.text })}\n`);
    }
  }
  return reportCorrupt(io.stdout, t, corrupt, file) ? EXIT.FAILURE : EXIT.OK;
}

function closeFailed(io, t, id, result) {
  if (result.reason === 'unknown') io.stderr.write(`${t('questions.not_found', { id })}\n`);
  else if (result.reason === 'ambiguous') io.stderr.write(`${t('questions.ambiguous', { id, count: result.count })}\n`);
  else io.stderr.write(`${t('questions.not_open', { id, status: statusLabel(t, result.question.status) })}\n`);
  return result.reason === 'ambiguous' ? EXIT.FAILURE : EXIT.USAGE;
}

function write(io, t, parsed, { stateDir, env, file, today, limits }) {
  if (parsed.sub === 'add') {
    const result = addQuestion(stateDir, parsed.operand, { today, dedupDays: limits.dedupDays, env });
    reportCorrupt(io.stderr, t, result.corrupt, file);
    if (result.added) {
      io.stdout.write(`${t('questions.added', { id: result.id, text: result.question.text })}\n`);
      return EXIT.OK;
    }
    if (result.reason === 'open') {
      io.stdout.write(`${t('questions.duplicate_open', { id: result.duplicateOf, text: result.question.text })}\n`);
      return EXIT.OK;
    }
    if (result.reason === 'answered') {
      io.stdout.write(`${t('questions.duplicate_answered', {
        id: result.duplicateOf, day: shown(result.question.answeredOn), days: daysBetween(result.question.answeredOn, today), window: limits.dedupDays, text: result.question.text,
      })}\n`);
      return EXIT.OK;
    }
    io.stderr.write(`${t('questions.id_collision', { id: result.id, other: result.question.text })}\n`);
    return EXIT.FAILURE;
  }
  if (parsed.sub === 'answer') {
    const result = answer(stateDir, parsed.operand, today, { env });
    reportCorrupt(io.stderr, t, result.corrupt, file);
    if (!result.ok) return closeFailed(io, t, parsed.operand, result);
    io.stdout.write(`${t('questions.answered', { id: result.question.id, day: shown(today), text: result.question.text })}\n`);
    return EXIT.OK;
  }
  if (parsed.sub === 'archive') {
    const result = archive(stateDir, parsed.operand, today, parsed.reason, { env });
    reportCorrupt(io.stderr, t, result.corrupt, file);
    if (!result.ok) return closeFailed(io, t, parsed.operand, result);
    if (parsed.reason === null) io.stdout.write(`${t('questions.archived', { id: result.question.id, day: shown(today), text: result.question.text })}\n`);
    else io.stdout.write(`${t('questions.archived_reason', { id: result.question.id, day: shown(today), reason: parsed.reason, text: result.question.text })}\n`);
    return EXIT.OK;
  }
  // sweep
  if (limits.maxAgeDays === null) {
    io.stdout.write(`${t('questions.sweep_no_limit')}\n`);
    const corrupt = queueSummary(readQueue(stateDir, { env }), { today }).corrupt;
    return reportCorrupt(io.stdout, t, corrupt, file) ? EXIT.FAILURE : EXIT.OK;
  }
  const result = sweepQueue(stateDir, {
    today, maxAgeDays: limits.maxAgeDays, env, reasonFor: (q) => t('questions.sweep_reason', { days: q.ageDays, limit: limits.maxAgeDays }),
  });
  for (const q of result.archived) {
    io.stdout.write(`${t('questions.sweep_archived', { id: q.id, created: shown(q.createdOn), days: q.ageDays, count: q.askedCount, limit: limits.maxAgeDays, text: q.text })}\n`);
  }
  if (result.archived.length === 0) io.stdout.write(`${t('questions.sweep_none', { limit: limits.maxAgeDays })}\n`);
  else io.stdout.write(`${t('questions.sweep_done', { count: result.archived.length, day: shown(today) })}\n`);
  return reportCorrupt(io.stdout, t, result.corrupt, file) ? EXIT.FAILURE : EXIT.OK;
}

export async function runQuestions(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(`${t('questions.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.error) return usageError(io, t, parsed);
  if (parsed.sub === 'add' && normalizeQuestion(parsed.operand) === '') {
    io.stderr.write(`${t('questions.empty_text')}\n`);
    return EXIT.USAGE;
  }
  if ((parsed.sub === 'answer' || parsed.sub === 'archive') && !QUESTION_ID.test(parsed.operand)) {
    io.stderr.write(`${t('questions.bad_id', { id: parsed.operand })}\n`);
    return EXIT.USAGE;
  }

  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('questions.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('questions.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('questions.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root);
  const tz = config.vault.timezone;
  let today;
  try {
    today = localDay(now, tz);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    io.stderr.write(`${t('questions.bad_timezone', { timezone: tz, file: CONFIG_FILENAME })}\n`);
    return EXIT.USAGE;
  }
  const stateDir = stateDirFor(root, env);
  const file = queueFile(stateDir, { env });
  const limits = {
    stateDir,
    env,
    dedupDays: limitOf(config.briefing, 'questions_dedup_days'),
    escalateAfter: limitOf(config.briefing, 'question_escalate_after'),
    maxAgeDays: limitOf(config.briefing, 'question_max_age_days'),
  };

  if (!WRITING.has(parsed.sub)) return list(io, t, { file, today, tz, limits });

  let lock;
  try {
    lock = joinOrAcquire(root, { command: `questions ${parsed.sub}`, env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  try {
    return write(io, t, parsed, { stateDir, env, file, today, limits });
  } finally {
    lock.release();
  }
}
