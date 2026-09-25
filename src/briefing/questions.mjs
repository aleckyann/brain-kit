// The briefing's question queue: the questions the briefing (or the
// curator) wants the person to answer, kept across sessions in one file of
// the vault's state directory, so a question asked today and not answered
// is asked again tomorrow instead of being lost with the session.
//
// THE FILE. machine.json's `paths.questions_log` when the state directory
// holds a machine.json that names one (a relative path belongs to the state
// directory, as every machine.paths entry does), else
// `<state dir>/questions.log` (STATE_FILES.QUESTIONS_LOG). One JSON object
// per line:
//
//   { id, text, normalized, createdOn, askedOn: ['YYYY-MM-DD', ...],
//     status: 'open'|'answered'|'archived', answeredOn, archivedOn,
//     archivedReason }
//
// Days are YYYY-MM-DD in the vault's time zone; the caller computes "today"
// (src/guards/watermark.mjs, localDay), nothing here reads a clock.
//
// NORMALISED TEXT AND THE ID. `normalized` is the text in Unicode NFC,
// lower-cased with String.prototype.toLowerCase (locale independent, so
// the same text has the same id on every machine), every Unicode
// punctuation mark and symbol (\p{P}, \p{S}) replaced by a space, runs of
// white space collapsed to one space, trimmed. Accents are kept: "e" and
// "e with an acute" are different letters, so two questions differing only
// there are two questions. NFC is not accent folding: it only makes the
// same accented letter typed as one code point or as a letter plus a
// combining mark the same text, which it is. `id` is `q-` plus the first 8
// hex characters of the SHA-256 of `normalized`, so a question asked again
// in other casing, spacing or punctuation has the id it had.
//
// NEVER LOSE A LINE. A line that is not UTF-8, not JSON, or not a question
// of the shape above is kept exactly as it is (its bytes, in its place)
// every time the file is rewritten, and every reader reports it with its
// line number. A line that is only white space is kept too and reported by
// no one: it holds nothing. A valid line that no write changes is also
// written back byte for byte, so a field this version does not know
// survives. Entries are never removed and never reordered; a new question
// is appended.
//
// WRITES. Every write reads the whole file, changes it in memory and
// replaces it atomically: a private temporary file in the same directory,
// mode 0600 set on the descriptor before any byte is written (the umask
// cannot widen it), flushed, then renamed over the queue. A reader sees the
// old queue or the new one, never half of one. Two writers doing this at
// once would each rename its own version and one would lose the other's
// question, so every write holds the QUEUE LOCK (see "the queue lock"
// below) from before its read to after its rename. The vault lock the
// command also takes is not enough: every process a scheduled round starts
// joins the round's vault lock, and parallel `questions add` calls inside
// one round then ran the cycle at once and lost questions while each said
// it had added its own (task 2 review, 25/09/2026). A temporary file a
// killed write left is removed by the next write, under the queue lock.
import {
  closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { loadMachine, MACHINE_FILENAME } from '../config.mjs';
import { isValidIsoDate } from '../dates.mjs';
import { expandHome } from '../doctor/checks.mjs';
import { KIT_ROOT } from '../version.mjs';
import { EXIT } from '../exit-codes.mjs';
import { acquireFileLock, LockHeld } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { daysBetween } from '../guards/watermark.mjs';
import { ensureStateDir, STATE_FILES } from '../state.mjs';

export const QUESTION_STATUS = Object.freeze({ OPEN: 'open', ANSWERED: 'answered', ARCHIVED: 'archived' });
const STATUSES = new Set(Object.values(QUESTION_STATUS));
export const QUESTION_ID = /^q-[0-9a-f]{8}$/;
const FILE_MODE = 0o600;
const NEWLINE = 0x0a;

// ------------------------------------------------------------ text and id

export function normalizeQuestion(text) {
  if (typeof text !== 'string') throw new TypeError('a question is a string');
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function questionId(normalized) {
  return `q-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8)}`;
}

// ------------------------------------------------------------ the file

// The queue's path for the state directory `stateDir`: see the header.
export function queueFile(stateDir, { env = process.env } = {}) {
  if (existsSync(join(stateDir, MACHINE_FILENAME))) {
    const configured = loadMachine(stateDir).paths?.questions_log;
    if (typeof configured === 'string' && configured !== '') return resolve(stateDir, expandHome(configured, env));
  }
  return join(stateDir, STATE_FILES.QUESTIONS_LOG);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function isDay(value) {
  return typeof value === 'string' && isValidIsoDate(value);
}

function optionalDay(value) {
  return value === undefined || value === null || isDay(value);
}

// The first field of `value` that is not what a question holds, or null
// when it is a question.
function badField(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '(line)';
  // `corrupt` is how readQueue marks a line it could not read; a record
  // carrying it would be mistaken for one.
  if (Object.hasOwn(value, 'corrupt')) return 'corrupt';
  if (typeof value.id !== 'string' || !QUESTION_ID.test(value.id)) return 'id';
  if (typeof value.text !== 'string' || value.text.trim() === '') return 'text';
  if (typeof value.normalized !== 'string' || value.normalized === '') return 'normalized';
  if (!isDay(value.createdOn)) return 'createdOn';
  if (!Array.isArray(value.askedOn) || !value.askedOn.every(isDay)) return 'askedOn';
  if (!STATUSES.has(value.status)) return 'status';
  if (!optionalDay(value.answeredOn) || (value.status === QUESTION_STATUS.ANSWERED && !isDay(value.answeredOn))) return 'answeredOn';
  if (!optionalDay(value.archivedOn) || (value.status === QUESTION_STATUS.ARCHIVED && !isDay(value.archivedOn))) return 'archivedOn';
  if (value.archivedReason !== undefined && value.archivedReason !== null && typeof value.archivedReason !== 'string') return 'archivedReason';
  return null;
}

// One line of the file, 1-based `line`, `raw` its bytes without the
// newline: { kind: 'question', question } | { kind: 'corrupt', reason,
// field } | { kind: 'blank' }.
function parseLine(raw, line) {
  let text;
  try {
    text = decoder.decode(raw);
  } catch {
    return { kind: 'corrupt', line, raw, reason: 'encoding', field: null, text: raw.toString('latin1') };
  }
  if (text.trim() === '') return { kind: 'blank', line, raw };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'corrupt', line, raw, reason: 'json', field: null, text };
  }
  const field = badField(value);
  if (field !== null) return { kind: 'corrupt', line, raw, reason: 'shape', field, text };
  return { kind: 'question', line, raw, question: value, changed: false };
}

function loadEntries(file) {
  if (!existsSync(file)) return [];
  const bytes = readFileSync(file);
  const entries = [];
  let start = 0;
  let line = 1;
  while (start < bytes.length) {
    let end = bytes.indexOf(NEWLINE, start);
    if (end === -1) end = bytes.length;
    entries.push(parseLine(bytes.subarray(start, end), line));
    start = end + 1;
    line += 1;
  }
  return entries;
}

function entryBytes(entry) {
  if (entry.kind === 'question' && entry.changed) return Buffer.from(JSON.stringify(entry.question), 'utf8');
  return entry.raw;
}

// The queue's own temporary files: `.<queue name>.<pid>.<12 hex>.tmp`.
function tempPattern(file) {
  const name = basename(file).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  return new RegExp(`^\\.${name}\\.\\d+\\.[0-9a-f]{12}\\.tmp$`);
}

// Only ever called holding the queue lock (withQueueLock).
function writeEntries(file, entries) {
  const dir = dirname(file);
  const parts = [];
  for (const entry of entries) parts.push(entryBytes(entry), Buffer.from([NEWLINE]));
  const buffer = Buffer.concat(parts);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    try {
      fchmodSync(fd, FILE_MODE);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed or already gone.
    }
    throw error;
  }
}

// Every entry of the queue, in file order: each question as its record,
// and each line that could not be read as { corrupt: true, line, reason:
// 'encoding'|'json'|'shape', field, text } (field names the first bad
// field of a 'shape' line). Blank lines are left out.
export function readQueue(stateDir, { env = process.env } = {}) {
  return loadEntries(queueFile(stateDir, { env })).flatMap((entry) => {
    if (entry.kind === 'question') return [entry.question];
    if (entry.kind === 'corrupt') return [{ corrupt: true, line: entry.line, reason: entry.reason, field: entry.field, text: entry.text }];
    return [];
  });
}

// ------------------------------------------------------------ the limits

const LIMIT_KEYS = Object.freeze({
  dedupDays: 'questions_dedup_days',
  escalateAfter: 'question_escalate_after',
  maxAgeDays: 'question_max_age_days',
});

// The queue's three limits for a loaded configuration, the one reading of
// them (the command and the briefing's facts both call it). loadConfig
// does not merge the pack's defaults, and a command reads a key the
// configuration leaves out as the kit's default, so a key absent from
// `briefing` takes lang/<config.lang>/config.defaults.json's value (15, 3
// and 45 in both packs); a key present is taken as it is, and `null` there
// means never. A default the pack does not carry is null.
export function questionLimits(config) {
  const briefing = config?.briefing !== null && typeof config?.briefing === 'object' ? config.briefing : {};
  let defaults = null;
  const limits = {};
  for (const [name, key] of Object.entries(LIMIT_KEYS)) {
    if (Object.hasOwn(briefing, key)) {
      limits[name] = briefing[key];
      continue;
    }
    if (defaults === null) {
      const lang = typeof config?.lang === 'string' && /^[A-Za-z-]+$/.test(config.lang) ? config.lang : 'en';
      defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8')).briefing ?? {};
    }
    limits[name] = Object.hasOwn(defaults, key) ? defaults[key] : null;
  }
  return limits;
}

// ------------------------------------------------------------ arguments

function requireDay(value, name) {
  if (!isDay(value)) throw new TypeError(`${name} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
}

function requireLimit(value, name, minimum) {
  if (value === null) return;
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${name} must be null or an integer of at least ${minimum}, got ${JSON.stringify(value)}`);
}

// ------------------------------------------------------------ the rules

// Open and asked at least `escalateAfter` times; `null` never escalates.
export function isEscalated(question, { escalateAfter }) {
  return escalateAfter !== null && question.status === QUESTION_STATUS.OPEN && question.askedOn.length >= escalateAfter;
}

// Open and created more than `maxAgeDays` days before `today`; `null`
// never archives.
export function isDueForArchive(question, { today, maxAgeDays }) {
  return maxAgeDays !== null && question.status === QUESTION_STATUS.OPEN && daysBetween(question.createdOn, today) > maxAgeDays;
}

function view(question, today) {
  return {
    id: question.id,
    text: question.text,
    createdOn: question.createdOn,
    ageDays: daysBetween(question.createdOn, today),
    askedOn: [...question.askedOn],
    askedCount: question.askedOn.length,
    lastAskedOn: question.askedOn.reduce((last, day) => (last === null || day > last ? day : last), null),
  };
}

// What the briefing shows of the queue: every open question, those
// escalated and those due for archiving (see the two rules above), and
// every line that could not be read. `questions` is readQueue's result.
export function queueSummary(questions, { today, escalateAfter = null, maxAgeDays = null } = {}) {
  requireDay(today, 'today');
  requireLimit(escalateAfter, 'escalateAfter', 1);
  requireLimit(maxAgeDays, 'maxAgeDays', 0);
  const summary = { open: [], escalated: [], toArchive: [], corrupt: [] };
  for (const item of questions) {
    if (item.corrupt === true) {
      summary.corrupt.push({ line: item.line, reason: item.reason, field: item.field, text: item.text });
      continue;
    }
    if (item.status !== QUESTION_STATUS.OPEN) continue;
    summary.open.push(view(item, today));
    if (isEscalated(item, { escalateAfter })) summary.escalated.push(view(item, today));
    if (isDueForArchive(item, { today, maxAgeDays })) summary.toArchive.push(view(item, today));
  }
  return summary;
}

// ------------------------------------------------------------ the queue lock

// The queue lock is `<queue>.lock` beside the queue, taken with
// acquireFileLock (src/guards/lock.mjs): the vault lock's own mechanism,
// on a file of the queue's own. Every write holds it from before the read
// to after the rename, so two writers never interleave, whether or not
// they hold the vault lock (every process of a round joins the round's
// vault lock, so the vault lock alone keeps none of them apart). A live
// holder is waited for, a few milliseconds at a time, with no limit: it
// holds the lock only for one read, change and rename, and a dead one is
// replaced by acquireFileLock's own rule. A lock that cannot be read, a
// reclaim that died, or a file system without hard links is refused with
// a GuardError naming the file, never waited on.
const pauseCell = new Int32Array(new SharedArrayBuffer(4));
const QUEUE_LOCK_PAUSE_MS = 5;

function lockQueue(file) {
  const dir = dirname(file);
  const name = `${basename(file)}.lock`;
  for (;;) {
    try {
      return acquireFileLock(dir, name, { command: 'questions' });
    } catch (error) {
      if (error instanceof LockHeld) {
        if (error.blockedBy !== null) {
          throw new GuardError({
            code: 'QUEUE_LOCK_RECLAIM_DIED', exitCode: EXIT.FAILURE,
            messageKey: 'questions.queue_lock_reclaim_died', params: { marker: error.blockedBy },
            message: `a run replacing the dead queue lock died midway and left ${error.blockedBy}`,
          });
        }
        if (error.holder === null || error.holder.pid === null) {
          throw new GuardError({
            code: 'QUEUE_LOCK_UNREADABLE', exitCode: EXIT.FAILURE,
            messageKey: 'questions.queue_lock_unreadable', params: { lock: error.lockPath },
            message: `the queue lock ${error.lockPath} cannot be read`,
          });
        }
        Atomics.wait(pauseCell, 0, 0, QUEUE_LOCK_PAUSE_MS);
        continue;
      }
      if (error instanceof GuardError && error.code === 'LOCK_NO_HARD_LINKS') {
        throw new GuardError({
          code: 'QUEUE_LOCK_NO_HARD_LINKS', exitCode: EXIT.FAILURE,
          messageKey: 'questions.queue_lock_no_hard_links', params: { dir },
          message: `the file system holding ${dir} does not support hard links`,
        });
      }
      throw error;
    }
  }
}

// Runs `work(file)` holding the queue lock, after removing the temporary
// files a killed write of this queue left: under the lock no write of this
// queue is running, so every such file is a leftover.
function withQueueLock(stateDir, env, work) {
  const file = queueFile(stateDir, { env });
  const dir = dirname(file);
  if (resolve(dir) === resolve(stateDir)) ensureStateDir(stateDir);
  else mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = lockQueue(file);
  try {
    const leftover = tempPattern(file);
    for (const name of readdirSync(dir)) {
      if (!leftover.test(name)) continue;
      try {
        unlinkSync(join(dir, name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return work(file);
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------ writes

function questionsIn(entries) {
  return entries.filter((entry) => entry.kind === 'question');
}

function corruptIn(entries) {
  return entries.filter((entry) => entry.kind === 'corrupt').map((entry) => ({ line: entry.line, reason: entry.reason, field: entry.field, text: entry.text }));
}

// The one open question `id` names: { entry } or { reason: 'unknown' |
// 'not_open' | 'ambiguous', statuses }.
function openEntry(entries, id) {
  const named = questionsIn(entries).filter((entry) => entry.question.id === id);
  if (named.length === 0) return { reason: 'unknown', statuses: [] };
  const open = named.filter((entry) => entry.question.status === QUESTION_STATUS.OPEN);
  if (open.length === 1) return { entry: open[0] };
  if (open.length > 1) return { reason: 'ambiguous', statuses: open.map((entry) => entry.question.status), count: open.length };
  return { reason: 'not_open', statuses: named.map((entry) => entry.question.status), last: named.at(-1).question };
}

// Adds `text` as an open question created `today`, unless it is a
// duplicate: an open question with the same normalised text, or one
// answered within `dedupDays` days of today (`null`: an answered question
// is never a duplicate). Returns { added: true, id, question } or
// { added: false, id, duplicateOf, reason: 'open' | 'answered', question }
// (the question it duplicates), or { added: false, id, reason:
// 'collision', question } when an open question with another text has the
// same id, which no one could then answer by id. Also `corrupt`: the lines
// that could not be read, kept.
export function addQuestion(stateDir, text, { today, dedupDays = null, env = process.env } = {}) {
  requireDay(today, 'today');
  requireLimit(dedupDays, 'dedupDays', 0);
  const normalized = normalizeQuestion(text);
  if (normalized === '') throw new TypeError('a question needs at least one letter or digit');
  const id = questionId(normalized);
  return withQueueLock(stateDir, env, (file) => {
    const entries = loadEntries(file);
    const corrupt = corruptIn(entries);
    const questions = questionsIn(entries).map((entry) => entry.question);
    const open = questions.find((q) => q.status === QUESTION_STATUS.OPEN && q.normalized === normalized);
    if (open !== undefined) return { added: false, id, duplicateOf: open.id, reason: 'open', question: open, corrupt };
    if (dedupDays !== null) {
      const recent = questions
        .filter((q) => q.status === QUESTION_STATUS.ANSWERED && q.normalized === normalized && daysBetween(q.answeredOn, today) <= dedupDays)
        .sort((a, b) => (a.answeredOn < b.answeredOn ? 1 : -1))[0];
      if (recent !== undefined) return { added: false, id, duplicateOf: recent.id, reason: 'answered', question: recent, corrupt };
    }
    const clash = questions.find((q) => q.status === QUESTION_STATUS.OPEN && q.id === id);
    if (clash !== undefined) return { added: false, id, reason: 'collision', question: clash, corrupt };
    const question = {
      id,
      text: text.trim(),
      normalized,
      createdOn: today,
      askedOn: [],
      status: QUESTION_STATUS.OPEN,
      answeredOn: null,
      archivedOn: null,
      archivedReason: null,
    };
    entries.push({ kind: 'question', question, changed: true, raw: null });
    writeEntries(file, entries);
    return { added: true, id, question, corrupt };
  });
}

// Records that the open questions `ids` were asked `today`. A day is
// counted once per question: a briefing run twice in a morning asks once.
// Returns { marked, already, unknown, notOpen, ambiguous } (ids), and
// writes only when something was marked.
export function markAsked(stateDir, ids, today, { env = process.env } = {}) {
  requireDay(today, 'today');
  if (!Array.isArray(ids)) throw new TypeError('ids must be a list of question ids');
  return withQueueLock(stateDir, env, (file) => {
    const entries = loadEntries(file);
    const result = { marked: [], already: [], unknown: [], notOpen: [], ambiguous: [] };
    for (const id of new Set(ids)) {
      const found = openEntry(entries, id);
      if (found.entry === undefined) {
        result[found.reason === 'unknown' ? 'unknown' : found.reason === 'ambiguous' ? 'ambiguous' : 'notOpen'].push(id);
        continue;
      }
      const { question } = found.entry;
      if (question.askedOn.includes(today)) {
        result.already.push(id);
        continue;
      }
      question.askedOn = [...question.askedOn, today];
      found.entry.changed = true;
      result.marked.push(id);
    }
    if (result.marked.length > 0) writeEntries(file, entries);
    return result;
  });
}

function close(stateDir, id, apply, env) {
  return withQueueLock(stateDir, env, (file) => {
    const entries = loadEntries(file);
    const corrupt = corruptIn(entries);
    const found = openEntry(entries, id);
    if (found.entry === undefined) {
      return { ok: false, reason: found.reason, statuses: found.statuses, count: found.count ?? 0, question: found.last ?? null, corrupt };
    }
    apply(found.entry.question);
    found.entry.changed = true;
    writeEntries(file, entries);
    return { ok: true, question: found.entry.question, corrupt };
  });
}

// Marks the open question `id` answered `today`. Returns { ok: true,
// question } or { ok: false, reason: 'unknown' | 'not_open' | 'ambiguous',
// question } and writes nothing in the second case.
export function answer(stateDir, id, today, { env = process.env } = {}) {
  requireDay(today, 'today');
  return close(stateDir, id, (question) => {
    question.status = QUESTION_STATUS.ANSWERED;
    question.answeredOn = today;
  }, env);
}

// Archives the open question `id` on `today`, with `reason` (a string, or
// null for none). Same result as answer.
export function archive(stateDir, id, today, reason = null, { env = process.env } = {}) {
  requireDay(today, 'today');
  if (reason !== null && typeof reason !== 'string') throw new TypeError('reason must be a string or null');
  return close(stateDir, id, (question) => {
    question.status = QUESTION_STATUS.ARCHIVED;
    question.archivedOn = today;
    question.archivedReason = reason;
  }, env);
}

// Archives every question queueSummary lists as toArchive, in one write,
// each with the reason `reasonFor(view)` gives it (view as in
// queueSummary). Returns { archived: [view...], corrupt } and writes
// nothing when nothing is due.
export function sweepQueue(stateDir, { today, maxAgeDays = null, reasonFor = () => null, env = process.env } = {}) {
  requireDay(today, 'today');
  requireLimit(maxAgeDays, 'maxAgeDays', 0);
  return withQueueLock(stateDir, env, (file) => {
    const entries = loadEntries(file);
    const archived = [];
    for (const entry of questionsIn(entries)) {
      const { question } = entry;
      if (!isDueForArchive(question, { today, maxAgeDays })) continue;
      const shown = view(question, today);
      question.status = QUESTION_STATUS.ARCHIVED;
      question.archivedOn = today;
      question.archivedReason = reasonFor(shown);
      entry.changed = true;
      archived.push(shown);
    }
    if (archived.length > 0) writeEntries(file, entries);
    return { archived, corrupt: corruptIn(entries) };
  });
}
