// The briefing's question queue (src/briefing/questions.mjs) and its
// command (src/commands/questions.mjs). Review focus 3: a question asked
// again in other words is the same question; one answered in the session
// is closed only by the command; one never answered for weeks is escalated
// and later archived, out loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { runQuestions } from '../src/commands/questions.mjs';
import {
  addQuestion, answer, archive, isDueForArchive, isEscalated, markAsked, normalizeQuestion, questionId, queueFile, queueSummary, readQueue,
  sweepQueue,
} from '../src/briefing/questions.mjs';
import { CLEAN_ENV, makeRepo } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const TODAY = '2026-09-25';
const NOW = new Date('2026-09-25T12:00:00Z');
const LANGS = ['en', 'pt-BR'];

function stateDir() {
  return makeTempDir('brain-kit-questions-state-');
}

function logOf(state) {
  return join(state, 'questions.log');
}

function linesOf(state) {
  return readFileSync(logOf(state), 'utf8').split('\n').slice(0, -1);
}

function record(text, fields = {}) {
  const normalized = normalizeQuestion(text);
  return {
    id: questionId(normalized),
    text,
    normalized,
    createdOn: TODAY,
    askedOn: [],
    status: 'open',
    answeredOn: null,
    archivedOn: null,
    archivedReason: null,
    ...fields,
  };
}

// Writes the queue as given: records become JSON lines, strings and
// Buffers are written as they are.
function seed(state, lines) {
  mkdirSync(state, { recursive: true });
  const parts = lines.map((line) => (Buffer.isBuffer(line) ? line : Buffer.from(typeof line === 'string' ? line : JSON.stringify(line))));
  writeFileSync(logOf(state), Buffer.concat(parts.flatMap((part) => [part, Buffer.from('\n')])), { mode: 0o600 });
}

function questionsOnly(state) {
  return readQueue(state, { env: CLEAN_ENV }).filter((item) => item.corrupt !== true);
}

// ------------------------------------------------------------ normalisation

test('normalisation: case, punctuation, symbols and spacing fold; accents do not', () => {
  const base = normalizeQuestion('Did Ana send the report?');
  assert.equal(base, 'did ana send the report');
  for (const variant of ['did ana send the report', '  DID Ana   send\tthe report ?!', 'Did Ana send the report...', '"Did Ana" send the report??', 'Did-Ana send the report']) {
    assert.equal(normalizeQuestion(variant), base, variant);
  }
  assert.equal(normalizeQuestion('Price: $10 + tax = ok?'), 'price 10 tax ok');
  assert.notEqual(normalizeQuestion('A Ana enviou o relatório?'), normalizeQuestion('A Ana enviou o relatorio?'), 'accents are significant');
  assert.equal(normalizeQuestion('A Ana enviou o relatório?'), 'a ana enviou o relatório');
  // The same accented letter as one code point or as a letter plus a
  // combining mark is the same text.
  assert.equal(normalizeQuestion('relatório'.normalize('NFD')), normalizeQuestion('relatório'));
  assert.equal(normalizeQuestion('ÉPOCA'), 'época', 'lower-casing keeps the accent');
  assert.equal(normalizeQuestion('?!... ---'), '');
});

test('the id is q- and the first 8 hex characters of the SHA-256 of the normalised text', () => {
  // printf 'did ana send the report' | sha256sum
  assert.equal(questionId('did ana send the report'), 'q-021dd0f5');
  assert.match(questionId(normalizeQuestion('Anything at all?')), /^q-[0-9a-f]{8}$/);
});

// ------------------------------------------------------------ deduplication

test('add: the same question in other casing, punctuation or spacing is a duplicate of the open one', () => {
  const state = stateDir();
  const first = addQuestion(state, 'Did Ana send the report?', { today: TODAY, dedupDays: 15, env: CLEAN_ENV });
  assert.equal(first.added, true);
  for (const variant of ['did ana send the report', '  DID ana, send   the REPORT?!  ']) {
    const again = addQuestion(state, variant, { today: '2026-09-26', dedupDays: 15, env: CLEAN_ENV });
    assert.deepEqual([again.added, again.reason, again.duplicateOf, again.id], [false, 'open', first.id, first.id], variant);
  }
  assert.equal(linesOf(state).length, 1, 'nothing was appended');
  const accented = addQuestion(state, 'Did Ána send the report?', { today: TODAY, dedupDays: 15, env: CLEAN_ENV });
  assert.equal(accented.added, true, 'an accent makes another question');
  assert.notEqual(accented.id, first.id);
  assert.equal(linesOf(state).length, 2);
});

test('add: an answered question is a duplicate within dedupDays of its answer, inclusive, and a new question after', () => {
  const state = stateDir();
  seed(state, [record('Is the lease renewed?', { createdOn: '2026-08-01', status: 'answered', answeredOn: '2026-09-10' })]);
  const within = addQuestion(state, 'is the lease renewed', { today: '2026-09-25', dedupDays: 15, env: CLEAN_ENV });
  assert.deepEqual([within.added, within.reason], [false, 'answered'], '15 days after the answer is within 15');
  assert.equal(linesOf(state).length, 1);
  const after = addQuestion(state, 'is the lease renewed', { today: '2026-09-26', dedupDays: 15, env: CLEAN_ENV });
  assert.equal(after.added, true, '16 days after is past the window');
  assert.equal(after.id, within.id, 'same text, same id');
  const queue = questionsOnly(state);
  assert.deepEqual(queue.map((q) => q.status), ['answered', 'open']);
  assert.equal(queue[1].createdOn, '2026-09-26');
});

test('add: dedupDays 0 deduplicates the day of the answer only; null never deduplicates against an answer', () => {
  const state = stateDir();
  seed(state, [record('Q one?', { status: 'answered', answeredOn: TODAY })]);
  assert.equal(addQuestion(state, 'Q one', { today: TODAY, dedupDays: 0, env: CLEAN_ENV }).added, false);
  assert.equal(addQuestion(state, 'Q one', { today: '2026-09-26', dedupDays: 0, env: CLEAN_ENV }).added, true);
  const other = stateDir();
  seed(other, [record('Q two?', { status: 'answered', answeredOn: TODAY })]);
  assert.equal(addQuestion(other, 'Q two', { today: TODAY, dedupDays: null, env: CLEAN_ENV }).added, true);
});

test('add: an archived question is not a duplicate; the text is stored trimmed with its created day', () => {
  const state = stateDir();
  seed(state, [record('Old one?', { createdOn: '2026-07-01', status: 'archived', archivedOn: '2026-08-20', archivedReason: 'aged' })]);
  const result = addQuestion(state, '  Old one?  ', { today: TODAY, dedupDays: 15, env: CLEAN_ENV });
  assert.equal(result.added, true);
  assert.deepEqual(result.question, record('Old one?'));
});

test('add: an open question with another text under the same id is refused, never merged', () => {
  const state = stateDir();
  const id = questionId(normalizeQuestion('The real question'));
  seed(state, [{ ...record('Some other text'), id }]);
  const result = addQuestion(state, 'The real question', { today: TODAY, dedupDays: 15, env: CLEAN_ENV });
  assert.deepEqual([result.added, result.reason, result.id], [false, 'collision', id]);
  assert.equal(linesOf(state).length, 1);
});

test('add refuses a text with no letter or digit', () => {
  assert.throws(() => addQuestion(stateDir(), '?!', { today: TODAY }), TypeError);
});

// ------------------------------------------------------------ asked, answered, archived

test('markAsked counts a day once, only for open questions, and says which ids it did not mark', () => {
  const state = stateDir();
  const open = record('Open?');
  const done = record('Done?', { status: 'answered', answeredOn: TODAY });
  seed(state, [open, done]);
  const first = markAsked(state, [open.id, done.id, 'q-00000000'], TODAY, { env: CLEAN_ENV });
  assert.deepEqual(first, { marked: [open.id], already: [], unknown: ['q-00000000'], notOpen: [done.id], ambiguous: [] });
  const again = markAsked(state, [open.id, open.id], TODAY, { env: CLEAN_ENV });
  assert.deepEqual(again.already, [open.id]);
  markAsked(state, [open.id], '2026-09-26', { env: CLEAN_ENV });
  assert.deepEqual(questionsOnly(state)[0].askedOn, [TODAY, '2026-09-26']);
});

test('answer and archive close only the open question the id names, and write nothing otherwise', () => {
  const state = stateDir();
  const q = record('Close me?');
  seed(state, [q]);
  assert.equal(answer(state, 'q-00000000', TODAY, { env: CLEAN_ENV }).reason, 'unknown');
  const done = answer(state, q.id, TODAY, { env: CLEAN_ENV });
  assert.equal(done.ok, true);
  assert.deepEqual([done.question.status, done.question.answeredOn], ['answered', TODAY]);
  const before = readFileSync(logOf(state));
  assert.equal(answer(state, q.id, TODAY, { env: CLEAN_ENV }).reason, 'not_open');
  assert.equal(archive(state, q.id, TODAY, 'x', { env: CLEAN_ENV }).reason, 'not_open');
  assert.deepEqual(readFileSync(logOf(state)), before);
  const other = stateDir();
  const r = record('Archive me?');
  seed(other, [r]);
  const archived = archive(other, r.id, TODAY, 'no longer relevant', { env: CLEAN_ENV });
  assert.deepEqual([archived.question.status, archived.question.archivedOn, archived.question.archivedReason], ['archived', TODAY, 'no longer relevant']);
});

test('two open questions under one id are ambiguous: neither is closed', () => {
  const state = stateDir();
  const q = record('Twice?');
  seed(state, [q, { ...q, createdOn: '2026-09-20' }]);
  const before = readFileSync(logOf(state));
  assert.equal(answer(state, q.id, TODAY, { env: CLEAN_ENV }).reason, 'ambiguous');
  assert.deepEqual(readFileSync(logOf(state)), before);
});

// ------------------------------------------------------------ escalation and archiving

test('queueSummary escalates an open question at exactly escalateAfter asks, never an answered one, and never with null', () => {
  const two = record('Two asks?', { askedOn: ['2026-09-20', '2026-09-22'] });
  const three = record('Three asks?', { askedOn: ['2026-09-20', '2026-09-22', '2026-09-24'] });
  const answered = record('Answered?', { askedOn: ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'], status: 'answered', answeredOn: TODAY });
  const summary = queueSummary([two, three, answered], { today: TODAY, escalateAfter: 3, maxAgeDays: 45 });
  assert.deepEqual(summary.open.map((q) => q.id), [two.id, three.id]);
  assert.deepEqual(summary.escalated.map((q) => q.id), [three.id]);
  assert.deepEqual([summary.escalated[0].askedCount, summary.escalated[0].lastAskedOn], [3, '2026-09-24']);
  assert.deepEqual(queueSummary([two, three], { today: TODAY, escalateAfter: 2, maxAgeDays: 45 }).escalated.map((q) => q.id), [two.id, three.id]);
  assert.deepEqual(queueSummary([two, three], { today: TODAY, escalateAfter: null, maxAgeDays: 45 }).escalated, []);
});

test('queueSummary archives an open question created more than maxAgeDays ago: exactly maxAgeDays is kept', () => {
  const exact = record('Exactly 45?', { createdOn: '2026-08-11' });
  const older = record('46 days?', { createdOn: '2026-08-10' });
  const oldAnswered = record('Old answered?', { createdOn: '2026-01-01', status: 'answered', answeredOn: '2026-02-01' });
  const summary = queueSummary([exact, older, oldAnswered], { today: TODAY, escalateAfter: 3, maxAgeDays: 45 });
  assert.deepEqual(summary.toArchive.map((q) => [q.id, q.ageDays]), [[older.id, 46]]);
  assert.equal(summary.open.find((q) => q.id === exact.id).ageDays, 45);
  assert.deepEqual(queueSummary([exact, older], { today: TODAY, escalateAfter: 3, maxAgeDays: null }).toArchive, []);
  assert.deepEqual(queueSummary([exact, older], { today: TODAY }).toArchive, [], 'limits default to null');
  assert.deepEqual(queueSummary([exact, older], { today: TODAY }).escalated, []);
});

test('the two rules hold for an open question only, whoever calls them', () => {
  const asked = ['2026-08-02', '2026-08-03', '2026-08-04'];
  const limits = { today: TODAY, escalateAfter: 3, maxAgeDays: 45 };
  assert.equal(isEscalated(record('Open?', { askedOn: asked }), limits), true);
  assert.equal(isDueForArchive(record('Open?', { createdOn: '2026-08-01' }), limits), true);
  for (const closed of [{ status: 'answered', answeredOn: TODAY }, { status: 'archived', archivedOn: TODAY }]) {
    const q = record('Closed?', { createdOn: '2026-08-01', askedOn: asked, ...closed });
    assert.equal(isEscalated(q, limits), false, closed.status);
    assert.equal(isDueForArchive(q, limits), false, closed.status);
  }
});

test('queueSummary refuses a bad day or limit rather than guessing', () => {
  assert.throws(() => queueSummary([], { today: '25/09/2026' }), TypeError);
  assert.throws(() => queueSummary([], { today: TODAY, escalateAfter: 0 }), TypeError);
  assert.throws(() => queueSummary([], { today: TODAY, maxAgeDays: -1 }), TypeError);
  assert.throws(() => queueSummary([], { today: TODAY, maxAgeDays: '45' }), TypeError);
});

test('sweepQueue archives exactly what queueSummary lists as toArchive, with its reason', () => {
  const state = stateDir();
  const exact = record('Exactly 45?', { createdOn: '2026-08-11' });
  const older = record('46 days?', { createdOn: '2026-08-10', askedOn: ['2026-08-11'] });
  seed(state, [exact, older]);
  const due = queueSummary(readQueue(state, { env: CLEAN_ENV }), { today: TODAY, maxAgeDays: 45 }).toArchive;
  const result = sweepQueue(state, { today: TODAY, maxAgeDays: 45, env: CLEAN_ENV, reasonFor: (q) => `aged ${q.ageDays}` });
  assert.deepEqual(result.archived, due);
  const after = questionsOnly(state);
  assert.deepEqual(after.map((q) => [q.status, q.archivedOn, q.archivedReason]), [['open', null, null], ['archived', TODAY, 'aged 46']]);
  const before = readFileSync(logOf(state));
  assert.deepEqual(sweepQueue(state, { today: TODAY, maxAgeDays: 45, env: CLEAN_ENV }).archived, []);
  assert.deepEqual(readFileSync(logOf(state)), before, 'nothing due, nothing written');
  assert.deepEqual(sweepQueue(state, { today: '2027-01-01', maxAgeDays: null, env: CLEAN_ENV }).archived, []);
});

// ------------------------------------------------------------ the file

test('a line that cannot be read is kept byte for byte in its place by every write, and reported with its line number', () => {
  const state = stateDir();
  const kept = record('Kept?', { createdOn: '2026-08-01' });
  // Written as a person's editor might: spaced, with a field this version
  // does not know. Unchanged, it must come back exactly so.
  const unknownField = JSON.stringify({ ...record('With an extra field?'), note: 'kept too' }, null, 1).replace(/\n/g, '');
  const notJson = 'this is not json {';
  const badUtf8 = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
  const badShape = JSON.stringify({ ...record('Bad status?'), status: 'maybe' });
  seed(state, [kept, notJson, unknownField, badUtf8, '', badShape]);
  const corruptBytes = [Buffer.from(notJson), badUtf8, Buffer.from(badShape)];
  const report = queueSummary(readQueue(state, { env: CLEAN_ENV }), { today: TODAY }).corrupt;
  assert.deepEqual(report.map((c) => [c.line, c.reason, c.field]), [[2, 'json', null], [4, 'encoding', null], [6, 'shape', 'status']]);
  const check = () => {
    const bytes = readFileSync(logOf(state));
    const lines = [];
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(0x0a, start);
      lines.push(bytes.subarray(start, end));
      start = end + 1;
    }
    assert.deepEqual([lines[1], lines[3], lines[5]], corruptBytes, 'the three unreadable lines, in their places');
    assert.equal(lines[2].toString(), unknownField, 'an unchanged line is written back as it was');
    assert.equal(lines[4].length, 0, 'the blank line is kept');
    return lines;
  };
  const added = addQuestion(state, 'New one?', { today: TODAY, dedupDays: 15, env: CLEAN_ENV });
  assert.deepEqual(added.corrupt.map((c) => c.line), [2, 4, 6]);
  check();
  markAsked(state, [kept.id], TODAY, { env: CLEAN_ENV });
  check();
  answer(state, added.id, TODAY, { env: CLEAN_ENV });
  check();
  const swept = sweepQueue(state, { today: TODAY, maxAgeDays: 45, env: CLEAN_ENV });
  assert.deepEqual(swept.archived.map((q) => q.id), [kept.id]);
  assert.deepEqual(swept.corrupt.map((c) => c.line), [2, 4, 6]);
  const lines = check();
  assert.equal(lines.length, 7, 'nothing dropped, one appended');
  assert.equal(questionsOnly(state).length, 3, 'the two readable seeded questions and the new one');
});

test('the queue is written mode 0600 whatever the umask, by rename, leaving no temporary file', () => {
  const state = stateDir();
  const previous = process.umask(0);
  try {
    addQuestion(state, 'Mode?', { today: TODAY, env: CLEAN_ENV });
    assert.equal(statSync(logOf(state)).mode & 0o777, 0o600);
    chmodSync(logOf(state), 0o644);
    markAsked(state, [questionId('mode')], TODAY, { env: CLEAN_ENV });
    assert.equal(statSync(logOf(state)).mode & 0o777, 0o600, 'a rewrite brings a wider file back to 0600');
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(state).mode & 0o777, 0o700, 'the state directory is 0700');
  assert.deepEqual(readdirSync(state), ['questions.log']);
});

test('the queue is machine.json paths.questions_log when set, relative to the state directory; else <state>/questions.log', () => {
  const state = stateDir();
  assert.equal(queueFile(state, { env: CLEAN_ENV }), join(state, 'questions.log'));
  const machine = {
    vault_id: 'vault-12345678', canonical_path: '/nowhere/vault', claude_bin: 'claude',
    paths: { watermark: join(state, 'watermark.json'), last_run: join(state, 'last-run.json'), log_dir: join(state, 'logs') },
  };
  writeFileSync(join(state, 'machine.json'), JSON.stringify(machine), { mode: 0o600 });
  assert.equal(queueFile(state, { env: CLEAN_ENV }), join(state, 'questions.log'), 'machine.json without the key');
  writeFileSync(join(state, 'machine.json'), JSON.stringify({ ...machine, paths: { ...machine.paths, questions_log: 'queue/q.log' } }), { mode: 0o600 });
  assert.equal(queueFile(state, { env: CLEAN_ENV }), join(state, 'queue', 'q.log'));
  addQuestion(state, 'Where?', { today: TODAY, env: CLEAN_ENV });
  assert.equal(existsSync(join(state, 'queue', 'q.log')), true);
  assert.equal(existsSync(join(state, 'questions.log')), false);
  assert.equal(statSync(join(state, 'queue', 'q.log')).mode & 0o777, 0o600);
  assert.equal(readQueue(state, { env: CLEAN_ENV }).length, 1);
});

// ------------------------------------------------------------ the command

function vaultRepo({ timezone = 'UTC', briefing } = {}) {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.timezone = timezone;
  if (briefing !== undefined) config.briefing = briefing(config.briefing);
  return makeRepo({ 'brain-kit.config.json': `${JSON.stringify(config, null, 2)}\n`, 'index.md': '# Index\n' }, 'brain-kit-questions-');
}

async function run(root, argv, { state, now = NOW, lang = 'en' } = {}) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runQuestions(argv, io, createTranslator(lang), { env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: state }, cwd: root, now });
  return { code, stdout, stderr };
}

const said = (lang, key, params) => `${createTranslator(lang)(key, params)}\n`;

test('questions add, then again in other words, in both languages', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const text = 'Did Ana send the report?';
    const id = questionId(normalizeQuestion(text));
    let r = await run(root, ['add', text], { state, lang });
    assert.deepEqual([r.code, r.stdout, r.stderr], [EXIT.OK, said(lang, 'questions.added', { id, text }), ''], lang);
    r = await run(root, ['add', 'did ANA send, the report', root], { state, lang });
    assert.deepEqual([r.code, r.stdout], [EXIT.OK, said(lang, 'questions.duplicate_open', { id, text })], lang);
    answer(state, id, '2026-09-20', { env: CLEAN_ENV });
    r = await run(root, ['add', text], { state, lang });
    assert.equal(r.stdout, said(lang, 'questions.duplicate_answered', { id, day: '20/09/2026', days: 5, window: 15, text }), lang);
    assert.equal(linesOf(state).length, 1, lang);
  }
});

test('questions answer and archive, in both languages, and their refusals', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const a = record('First?');
    const b = record('Second?');
    const c = record('Third?');
    seed(state, [a, b, c]);
    let r = await run(root, ['answer', a.id], { state, lang });
    assert.deepEqual([r.code, r.stdout], [EXIT.OK, said(lang, 'questions.answered', { id: a.id, day: '25/09/2026', text: 'First?' })], lang);
    r = await run(root, ['archive', b.id, '--reason', 'moot now'], { state, lang });
    assert.deepEqual([r.code, r.stdout], [EXIT.OK, said(lang, 'questions.archived_reason', { id: b.id, day: '25/09/2026', reason: 'moot now', text: 'Second?' })], lang);
    r = await run(root, ['archive', c.id], { state, lang });
    assert.deepEqual([r.code, r.stdout], [EXIT.OK, said(lang, 'questions.archived', { id: c.id, day: '25/09/2026', text: 'Third?' })], lang);
    const before = readFileSync(logOf(state));
    r = await run(root, ['answer', a.id], { state, lang });
    assert.deepEqual([r.code, r.stderr], [EXIT.USAGE, said(lang, 'questions.not_open', { id: a.id, status: createTranslator(lang)('questions.status_answered') })], lang);
    r = await run(root, ['answer', b.id], { state, lang });
    assert.equal(r.stderr, said(lang, 'questions.not_open', { id: b.id, status: createTranslator(lang)('questions.status_archived') }), lang);
    r = await run(root, ['answer', 'q-00000000'], { state, lang });
    assert.deepEqual([r.code, r.stderr], [EXIT.USAGE, said(lang, 'questions.not_found', { id: 'q-00000000' })], lang);
    assert.deepEqual(readFileSync(logOf(state)), before, lang);
  }
});

test('questions list shows every state, escalation and due archiving, in both languages', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const never = record('Never asked?');
    const escalated = record('Asked thrice?', { createdOn: '2026-08-10', askedOn: ['2026-09-22', '2026-09-23', '2026-09-24'] });
    const answered = record('Answered?', { status: 'answered', answeredOn: '2026-09-21' });
    const archivedPlain = record('Archived?', { status: 'archived', archivedOn: '2026-09-22' });
    const archivedWhy = record('Archived why?', { status: 'archived', archivedOn: '2026-09-23', archivedReason: 'moot' });
    seed(state, [never, escalated, answered, archivedPlain, archivedWhy]);
    const r = await run(root, ['list'], { state, lang });
    assert.equal(r.code, EXIT.OK, r.stderr);
    const expected = [
      said(lang, 'questions.list_header', { file: logOf(state), today: '25/09/2026', timezone: 'UTC', open: 2, answered: 1, archived: 2 }),
      said(lang, 'questions.list_open_never', { id: never.id, created: '25/09/2026', text: 'Never asked?' }),
      said(lang, 'questions.list_open', { id: escalated.id, created: '10/08/2026', count: 3, text: 'Asked thrice?' }),
      said(lang, 'questions.list_escalated', { count: 3, limit: 3 }),
      said(lang, 'questions.list_due_archive', { days: 46, limit: 45 }),
      said(lang, 'questions.list_answered', { id: answered.id, day: '21/09/2026', text: 'Answered?' }),
      said(lang, 'questions.list_archived', { id: archivedPlain.id, day: '22/09/2026', text: 'Archived?' }),
      said(lang, 'questions.list_archived_reason', { id: archivedWhy.id, day: '23/09/2026', reason: 'moot', text: 'Archived why?' }),
    ].join('');
    assert.equal(r.stdout, expected, lang);
    const nothing = stateDir();
    const empty = await run(root, ['list'], { state: nothing, lang });
    assert.deepEqual([empty.code, empty.stdout], [EXIT.OK, said(lang, 'questions.list_empty', { file: logOf(nothing) })], lang);
  }
});

test('questions sweep prints every question it archives, in both languages; with no limit set it archives nothing and says so', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const old = record('Old?', { createdOn: '2026-08-01', askedOn: ['2026-08-02', '2026-08-03'] });
    const exact = record('Exact?', { createdOn: '2026-08-11' });
    seed(state, [old, exact]);
    let r = await run(root, ['sweep'], { state, lang });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(r.stdout, [
      said(lang, 'questions.sweep_archived', { id: old.id, created: '01/08/2026', days: 55, count: 2, limit: 45, text: 'Old?' }),
      said(lang, 'questions.sweep_done', { count: 1, day: '25/09/2026' }),
    ].join(''), lang);
    const stored = questionsOnly(state);
    assert.deepEqual(stored.map((q) => q.status), ['archived', 'open']);
    assert.equal(stored[0].archivedReason, createTranslator(lang)('questions.sweep_reason', { days: 55, limit: 45 }));
    r = await run(root, ['sweep'], { state, lang });
    assert.equal(r.stdout, said(lang, 'questions.sweep_none', { limit: 45 }), lang);

    const unlimited = vaultRepo({ briefing: (b) => { const { question_max_age_days: _a, question_escalate_after: _e, questions_dedup_days: _d, ...rest } = b; return rest; } });
    const state2 = stateDir();
    seed(state2, [old]);
    const before = readFileSync(logOf(state2));
    r = await run(unlimited, ['sweep'], { state: state2, lang });
    assert.deepEqual([r.code, r.stdout], [EXIT.OK, said(lang, 'questions.sweep_no_limit')], lang);
    assert.deepEqual(readFileSync(logOf(state2)), before, lang);
    r = await run(unlimited, ['list'], { state: state2, lang });
    assert.doesNotMatch(r.stdout, /\n {6}\S/, 'no escalation or archiving line without a limit');
  }
});

test('questions list and sweep report an unreadable line with its number and exit 1; writes keep it and warn', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const q = record('Fine?', { createdOn: '2026-08-01' });
    seed(state, [q, 'garbage']);
    const t = createTranslator(lang);
    const lineReport = said(lang, 'questions.corrupt_line', { line: 2, detail: t('questions.corrupt_json'), raw: 'garbage' })
      + said(lang, 'questions.corrupt_summary', { count: 1, file: logOf(state) });
    let r = await run(root, ['list'], { state, lang });
    assert.equal(r.code, EXIT.FAILURE, lang);
    assert.ok(r.stdout.endsWith(lineReport), lang);
    r = await run(root, ['add', 'New?'], { state, lang });
    assert.deepEqual([r.code, r.stderr], [EXIT.OK, lineReport], lang);
    r = await run(root, ['sweep'], { state, lang });
    assert.equal(r.code, EXIT.FAILURE, lang);
    assert.ok(r.stdout.startsWith(said(lang, 'questions.sweep_archived', { id: q.id, created: '01/08/2026', days: 55, count: 0, limit: 45, text: 'Fine?' })), lang);
    assert.ok(r.stdout.endsWith(lineReport), lang);
    assert.equal(linesOf(state)[1], 'garbage', lang);
  }
});

test('questions refuses bad arguments with 2 and writes nothing, in both languages', async () => {
  for (const lang of LANGS) {
    const root = vaultRepo();
    const state = stateDir();
    const cases = [
      [[], null],
      [['bogus'], ['questions.unknown_subcommand', { arg: 'bogus' }]],
      [['add'], null],
      [['add', '?!?'], ['questions.empty_text']],
      [['add', 'Q?', '--reason', 'x'], ['questions.reason_only_archive']],
      [['archive', 'q-12345678', '--reason'], ['questions.missing_value', { option: '--reason' }]],
      [['archive', 'q-12345678', '--reason', '  '], ['questions.empty_reason']],
      [['answer', 'Q-1234'], ['questions.bad_id', { id: 'Q-1234' }]],
      [['list', '--force'], ['questions.bad_argument', { arg: '--force' }]],
      [['list', root, 'extra'], ['questions.bad_argument', { arg: 'extra' }]],
      [['list', join(root, 'nope')], ['questions.path_not_found', { dir: join(root, 'nope') }]],
    ];
    for (const [argv, first] of cases) {
      const r = await run(root, argv, { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${argv.join(' ')}`);
      if (first !== null) assert.ok(r.stderr.startsWith(said(lang, ...first)), `${lang} ${argv.join(' ')}: ${r.stderr}`);
    }
    assert.equal(existsSync(logOf(state)), false, lang);
    const help = await run(root, ['--help'], { state, lang });
    assert.deepEqual([help.code, help.stdout], [EXIT.OK, said(lang, 'questions.usage')]);
    const dashed = await run(root, ['add', '--', '-- is this a question?'], { state, lang });
    assert.equal(dashed.code, EXIT.OK, 'after -- a text may start with a dash');
  }
});

test('questions: today is the vault time zone\'s day', async () => {
  const root = vaultRepo({ timezone: 'America/Argentina/Buenos_Aires' });
  const state = stateDir();
  const r = await run(root, ['add', 'Late night?'], { state, now: new Date('2026-09-25T01:30:00Z') });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(questionsOnly(state)[0].createdOn, '2026-09-24', 'at 22:30 of 24/09 at UTC-3 it is still 24/09');
  const list = await run(root, ['list'], { state, now: new Date('2026-09-25T01:30:00Z') });
  assert.match(list.stdout, /today is 24\/09\/2026 in America\/Argentina\/Buenos_Aires/);
});

test('questions writes take the vault lock: a live holder postpones every write with 75 and the queue does not move', async () => {
  const root = vaultRepo();
  const state = stateDir();
  const q = record('Locked?', { createdOn: '2026-08-01' });
  seed(state, [q]);
  const before = readFileSync(logOf(state));
  const lock = acquireLock(root, { command: 'curate', env: CLEAN_ENV });
  try {
    for (const argv of [['add', 'Another?'], ['answer', q.id], ['archive', q.id], ['sweep']]) {
      const r = await run(root, argv, { state });
      assert.equal(r.code, EXIT.TEMPFAIL, argv.join(' '));
      assert.match(r.stderr, /curate/);
    }
    assert.equal((await run(root, ['list'], { state })).code, EXIT.OK, 'list only reads');
  } finally {
    lock.release();
  }
  assert.deepEqual(readFileSync(logOf(state)), before);
  assert.equal((await run(root, ['add', 'Another?'], { state })).code, EXIT.OK);
});

function cli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('concurrent writers are serialised by the lock: every add that succeeded is in the queue, the others were postponed, none lost', async () => {
  const root = vaultRepo();
  const state = stateDir();
  const home = makeTempDir('brain-kit-questions-home-');
  const env = { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: state, HOME: home, BRAIN_KIT_LANG: 'en' };
  const texts = Array.from({ length: 8 }, (_, i) => `Concurrent question number ${i}?`);
  let pending = [...texts];
  let rounds = 0;
  let postponed = 0;
  while (pending.length > 0) {
    rounds += 1;
    const results = await Promise.all(pending.map((text) => cli(['questions', 'add', text], { cwd: root, env })));
    for (const r of results) assert.ok(r.code === EXIT.OK || r.code === EXIT.TEMPFAIL, `${r.code}: ${r.stderr}`);
    const stored = new Set(questionsOnly(state).map((q) => q.text));
    results.forEach((r, i) => {
      if (r.code === EXIT.OK) assert.ok(stored.has(pending[i]), `an add that said OK is in the queue: ${pending[i]}`);
    });
    postponed += results.filter((r) => r.code === EXIT.TEMPFAIL).length;
    pending = pending.filter((_, i) => results[i].code !== EXIT.OK);
  }
  const final = questionsOnly(state);
  assert.deepEqual(final.map((q) => q.text).sort(), [...texts].sort());
  assert.equal(new Set(final.map((q) => q.id)).size, texts.length);
  assert.deepEqual(readdirSync(state), ['questions.log'], 'no temporary file left behind');
  assert.ok(rounds >= 1 && postponed >= 0);
});

test('the command is routed by the CLI', async () => {
  const root = vaultRepo();
  const state = stateDir();
  const home = makeTempDir('brain-kit-questions-home-');
  const r = await cli(['questions', 'list', root], { cwd: home, env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: state, HOME: home, BRAIN_KIT_LANG: 'pt-BR' } });
  assert.deepEqual([r.code, r.stdout], [EXIT.OK, said('pt-BR', 'questions.list_empty', { file: logOf(state) })]);
});
