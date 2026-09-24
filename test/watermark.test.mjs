// The high water mark (src/guards/watermark.mjs) and the owner's command
// (src/commands/watermark.mjs). docs/incidents.md, 17/09/2026 and
// 20/08/2026: the mark holds the last day swept per source, and it moves
// only on exit 0 plus read evidence plus the model's sources line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { main } from '../src/cli.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { runWatermark } from '../src/commands/watermark.mjs';
import {
  addDays, advanceWatermark, parseSourcesLine, readWatermark, setWatermark, startOfDay, windowFor, WatermarkError,
} from '../src/guards/watermark.mjs';
import { CLEAN_ENV, makeRepo } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const OK_LINE = { transcripts: 'ok' };
const READ = { read: 2, expected: 2, ok: true };

function stateDir() {
  return makeTempDir('brain-kit-watermark-state-');
}

function markOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'watermark.json'), 'utf8'));
}

// ------------------------------------------------------------ windowFor

test('windowFor: an unset mark reads only yesterday; a mark at yesterday reads nothing', () => {
  const unset = windowFor(null, '2026-09-24', 'UTC');
  assert.deepEqual(unset.days, ['2026-09-23']);
  assert.equal(unset.clipped, false);
  assert.equal(unset.from.toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(unset.to.toISOString(), '2026-09-24T00:00:00.000Z');
  const covered = windowFor('2026-09-23', '2026-09-24', 'UTC');
  assert.deepEqual(covered.days, []);
  assert.equal(covered.from.getTime(), covered.to.getTime());
  assert.deepEqual(windowFor('2026-09-30', '2026-09-24', 'UTC').days, [], 'a mark past yesterday opens nothing');
});

test('windowFor: from the day after the mark to yesterday, inclusive', () => {
  const w = windowFor('2026-09-20', '2026-09-24', 'UTC');
  assert.deepEqual(w.days, ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.equal(w.from.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(w.to.toISOString(), '2026-09-24T00:00:00.000Z');
});

test('windowFor: more than maxDays open keeps the most recent and says it clipped', () => {
  const w = windowFor('2026-09-10', '2026-09-24', 'UTC');
  assert.equal(w.days.length, 7);
  assert.equal(w.days[0], '2026-09-17');
  assert.equal(w.days[6], '2026-09-23');
  assert.equal(w.clipped, true);
  assert.deepEqual(w.skipped, ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16']);
  assert.equal(w.from.toISOString(), '2026-09-17T00:00:00.000Z');
  const exact = windowFor('2026-09-16', '2026-09-24', 'UTC');
  assert.deepEqual([exact.days.length, exact.clipped], [7, false]);
  const three = windowFor('2026-09-10', '2026-09-24', 'UTC', { maxDays: 3 });
  assert.deepEqual([three.days, three.clipped], [['2026-09-21', '2026-09-22', '2026-09-23'], true]);
});

test('windowFor: "today" is the day in the vault time zone, not in UTC', () => {
  const now = new Date('2026-09-24T01:00:00Z');
  assert.deepEqual(windowFor(null, now, 'UTC').days, ['2026-09-23']);
  const saoPaulo = windowFor(null, now, 'America/Sao_Paulo');
  assert.deepEqual(saoPaulo.days, ['2026-09-22'], 'at 22:00 of 23/09 at UTC-3, yesterday is 22/09');
  assert.equal(saoPaulo.from.toISOString(), '2026-09-22T03:00:00.000Z');
  assert.equal(saoPaulo.to.toISOString(), '2026-09-23T03:00:00.000Z');
  const kolkata = windowFor(null, now, 'Asia/Kolkata');
  assert.deepEqual(kolkata.days, ['2026-09-23']);
  assert.equal(kolkata.to.toISOString(), '2026-09-23T18:30:00.000Z');
  assert.deepEqual(windowFor(null, now, 'Pacific/Kiritimati').days, ['2026-09-23']);
  assert.deepEqual(windowFor(null, new Date('2026-09-24T10:59:00Z'), 'Pacific/Pago_Pago').days, ['2026-09-22']);
  assert.deepEqual(windowFor(null, new Date('2026-09-24T11:00:00Z'), 'Pacific/Pago_Pago').days, ['2026-09-23']);
});

test('startOfDay across daylight saving changes: 23 and 25 hour days, and a day whose midnight never happened', () => {
  assert.equal(startOfDay('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(startOfDay('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(startOfDay('2026-11-01', 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(startOfDay('2026-11-02', 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
  const w = windowFor('2026-03-07', '2026-03-10', 'America/New_York');
  assert.deepEqual(w.days, ['2026-03-08', '2026-03-09']);
  assert.equal(w.to.getTime() - w.from.getTime(), 47 * 3600 * 1000, 'the spring forward day has 23 hours');
  // Brazil, 04/11/2018: at 00:00 the clock jumped to 01:00; the day began
  // at the jump. 17/02/2019: at 00:00 it went back to 23:00 of the 16th.
  assert.equal(startOfDay('2018-11-04', 'America/Sao_Paulo').toISOString(), '2018-11-04T03:00:00.000Z');
  assert.equal(startOfDay('2018-11-05', 'America/Sao_Paulo').toISOString(), '2018-11-05T02:00:00.000Z');
  assert.equal(startOfDay('2019-02-16', 'America/Sao_Paulo').toISOString(), '2019-02-16T02:00:00.000Z');
  assert.equal(startOfDay('2019-02-17', 'America/Sao_Paulo').toISOString(), '2019-02-17T03:00:00.000Z');
});

test('addDays crosses months, years and leap days', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('windowFor refuses a mark that is not a date and a time zone that does not exist', () => {
  assert.throws(() => windowFor('24/09/2026', '2026-09-24', 'UTC'), TypeError);
  assert.throws(() => windowFor(null, '2026-09-24', 'Mars/Olympus'), RangeError);
});

// ------------------------------------------------------------ the file

test('readWatermark: a missing file is every source unset', () => {
  assert.deepEqual(readWatermark(stateDir()), { sources: {} });
});

test('readWatermark: a damaged file is an error, never read as unset', () => {
  for (const content of ['{not json', '[]', '{"sources": []}', '{"sources": {"transcripts": "yesterday"}}', '{"sources": {"transcripts": "2026-02-30"}}', '{}']) {
    const dir = stateDir();
    writeFileSync(join(dir, 'watermark.json'), content);
    assert.throws(() => readWatermark(dir), WatermarkError, content);
  }
});

// ------------------------------------------------------------ advanceWatermark

test('advance: exit 0, read evidence and the source reported ok move the mark, atomically and 0600', () => {
  const dir = stateDir();
  setWatermark(dir, 'calendar', '2026-09-01');
  const result = advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE });
  assert.deepEqual(result, { advanced: true, previous: null });
  assert.deepEqual(markOf(dir), { sources: { calendar: '2026-09-01', transcripts: '2026-09-23' } });
  assert.equal(statSync(join(dir, 'watermark.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['watermark.json'], 'no temporary file is left behind');
});

test('advance: a model exit other than 0 leaves the day open, even with evidence and the line', () => {
  for (const modelExit of [1, 69, null, undefined, '0']) {
    const dir = stateDir();
    const result = advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit, evidence: READ, sourcesLine: OK_LINE });
    assert.deepEqual(result, { advanced: false, reason: 'model_exit' }, String(modelExit));
    assert.equal(existsSync(join(dir, 'watermark.json')), false);
  }
});

test('advance: evidence that is not ok, or missing, leaves the day open', () => {
  for (const evidence of [{ read: 0, expected: 2, ok: false }, null, undefined, { read: 2, expected: 2, ok: 'yes' }]) {
    const dir = stateDir();
    const result = advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence, sourcesLine: OK_LINE });
    assert.deepEqual(result, { advanced: false, reason: 'no_evidence' });
    assert.equal(existsSync(join(dir, 'watermark.json')), false);
  }
});

test('advance: no sources line leaves the day open', () => {
  const dir = stateDir();
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: null }), { advanced: false, reason: 'no_sources_line' });
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ }), { advanced: false, reason: 'no_sources_line' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance: a line that does not name the source, or names it failed, leaves the day open', () => {
  const dir = stateDir();
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: { calendar: 'ok' } }), { advanced: false, reason: 'not_reported' });
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: {} }), { advanced: false, reason: 'not_reported' });
  for (const state of ['failed', 'OK', 'partial', '']) {
    assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: { transcripts: state } }), { advanced: false, reason: 'reported_failed' }, state);
  }
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance: "empty" counts only when the plan offered nothing', () => {
  const dir = stateDir();
  const withFiles = advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { read: 1, expected: 3, ok: true }, sourcesLine: { transcripts: 'empty' } });
  assert.deepEqual(withFiles, { advanced: false, reason: 'empty_with_files' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  const nothing = advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { read: 0, expected: 0, ok: true }, sourcesLine: { transcripts: 'empty' } });
  assert.deepEqual(nothing, { advanced: true, previous: null });
});

test('advance: "empty" with nothing expected still needs exit 0 and ok evidence', () => {
  const dir = stateDir();
  const nothing = { read: 0, expected: 0, ok: true };
  assert.equal(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 1, evidence: nothing, sourcesLine: { transcripts: 'empty' } }).advanced, false);
  assert.equal(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { ...nothing, ok: false }, sourcesLine: { transcripts: 'empty' } }).advanced, false);
  assert.equal(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 1, evidence: nothing, sourcesLine: OK_LINE }).advanced, false);
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance, vacuous (no model ran): only when the evidence expected nothing', () => {
  const dir = stateDir();
  for (const evidence of [{ read: 0, expected: 1, ok: false }, { read: 0, expected: null, ok: false }, null, undefined]) {
    assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence }), { advanced: false, reason: 'not_vacuous' });
  }
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  const ok = advanceWatermark(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence: { read: 0, expected: 0, ok: true } });
  assert.deepEqual(ok, { advanced: true, previous: null });
  assert.equal(markOf(dir).sources.transcripts, '2026-09-23');
});

test('advance: vacuous must be exactly true; anything else takes the model path', () => {
  const dir = stateDir();
  const result = advanceWatermark(dir, 'transcripts', '2026-09-23', { vacuous: 'yes', evidence: { read: 0, expected: 0, ok: true } });
  assert.deepEqual(result, { advanced: false, reason: 'model_exit' });
});

test('advance never moves the mark back or onto the day it already holds', () => {
  const dir = stateDir();
  setWatermark(dir, 'transcripts', '2026-09-23');
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: false, reason: 'not_later' });
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-20', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: false, reason: 'not_later' });
  assert.equal(markOf(dir).sources.transcripts, '2026-09-23');
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-24', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: true, previous: '2026-09-23' });
});

test('advance refuses a day that is not a date', () => {
  assert.throws(() => advanceWatermark(stateDir(), 'transcripts', '23/09/2026', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), TypeError);
});

// ------------------------------------------------------------ parseSourcesLine

test('parseSourcesLine reads the LAST BRAIN_KIT_SOURCES line as id=state pairs', () => {
  const text = 'Done.\nBRAIN_KIT_SOURCES: transcripts=failed\nMore text\n  BRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=failed junk =x y=\r\nbye';
  assert.deepEqual(parseSourcesLine(text), { transcripts: 'ok', calendar: 'empty', meeting_notes: 'failed' });
  assert.deepEqual(parseSourcesLine('BRAIN_KIT_SOURCES:'), {});
  assert.equal(parseSourcesLine('all good, nothing to report'), null);
  assert.equal(parseSourcesLine('I would print BRAIN_KIT_SOURCES: transcripts=ok here'), null, 'a line must start with it');
  assert.equal(parseSourcesLine(null), null);
  assert.equal(parseSourcesLine(undefined), null);
});

// ------------------------------------------------------------ the command

function vaultRepo(timezone = 'UTC') {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.timezone = timezone;
  return makeRepo({ 'brain-kit.config.json': `${JSON.stringify(config, null, 2)}\n`, 'index.md': '# Index\n' }, 'brain-kit-watermark-');
}

async function run(root, argv, { state, now = new Date('2026-09-24T12:00:00Z'), lang = 'en' } = {}) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runWatermark(argv, io, createTranslator(lang), { env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: state }, cwd: root, now });
  return { code, stdout, stderr };
}

test('watermark show lists every configured source, unset or with its days behind', async () => {
  const root = vaultRepo();
  const state = stateDir();
  let r = await run(root, ['show'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  for (const source of ['transcripts', 'calendar', 'meeting_notes']) assert.match(r.stdout, new RegExp(`${source}: not set`));
  assert.match(r.stdout, /yesterday was 23\/09\/2026/);
  setWatermark(state, 'transcripts', '2026-09-20');
  r = await run(root, ['show', root], { state });
  assert.match(r.stdout, /transcripts: last day swept 20\/09\/2026, 3 day\(s\) behind yesterday/);
  assert.equal(existsSync(join(state, 'watermark.json')), true);
});

test('watermark set writes the day, and says what it closed unread', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-19');
  const r = await run(root, ['set', 'transcripts', '2026-09-21'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-21');
  assert.match(r.stdout, /moved from 19\/09\/2026 to 21\/09\/2026/);
  assert.match(r.stdout, /These 2 day\(s\) are now closed without having been read by a round: 20\/09\/2026, 21\/09\/2026/);
  const back = await run(root, ['set', 'transcripts', '2026-09-10'], { state });
  assert.equal(back.code, EXIT.OK);
  assert.doesNotMatch(back.stdout, /closed without/);
  assert.match(back.stdout, /13 days are open/);
});

test('watermark set refuses today, a later day, a bad date and an unknown source, writing nothing', async () => {
  const root = vaultRepo();
  const state = stateDir();
  for (const argv of [['set', 'transcripts', '2026-09-24'], ['set', 'transcripts', '2026-10-01'], ['set', 'transcripts', '23/09/2026'], ['set', 'nope', '2026-09-20'], ['set', 'transcripts'], ['bogus'], [], ['set', 'transcripts', '2026-09-20', root, 'extra'], ['show', '--force']]) {
    const r = await run(root, argv, { state });
    assert.equal(r.code, EXIT.USAGE, argv.join(' '));
  }
  assert.equal(existsSync(join(state, 'watermark.json')), false);
});

test('watermark days are the vault time zone\'s: at 22:00 of 23/09 at UTC-3, 23/09 has not ended', async () => {
  const root = vaultRepo('America/Sao_Paulo');
  const state = stateDir();
  const now = new Date('2026-09-24T01:00:00Z');
  const r = await run(root, ['set', 'transcripts', '2026-09-23'], { state, now });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /has not ended yet in America\/Sao_Paulo/);
  const assumed = await run(root, ['assume-covered', 'transcripts'], { state, now });
  assert.equal(assumed.code, EXIT.OK, assumed.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-22');
});

test('watermark reopen moves the mark to the day before, so that day is read again', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-22');
  const r = await run(root, ['reopen', 'transcripts', '2026-09-20'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-19');
  assert.deepEqual(windowFor('2026-09-19', '2026-09-24', 'UTC').days, ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']);
  const open = await run(root, ['reopen', 'transcripts', '2026-09-21'], { state });
  assert.equal(open.code, EXIT.USAGE);
  assert.match(open.stderr, /already open/);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-19');
});

test('watermark reopen of an unset source: yesterday is already open, an earlier day moves it back', async () => {
  const root = vaultRepo();
  const state = stateDir();
  assert.equal((await run(root, ['reopen', 'transcripts', '2026-09-23'], { state })).code, EXIT.USAGE);
  assert.equal(existsSync(join(state, 'watermark.json')), false);
  assert.equal((await run(root, ['reopen', 'transcripts', '2026-09-21'], { state })).code, EXIT.OK);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-20');
});

test('watermark assume-covered sets yesterday and prints every day it skips', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'calendar', '2026-09-20');
  const r = await run(root, ['assume-covered', 'calendar'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readWatermark(state).sources.calendar, '2026-09-23');
  assert.match(r.stdout, /These 3 day\(s\) are now closed without having been read by a round: 21\/09\/2026, 22\/09\/2026, 23\/09\/2026/);
  const again = await run(root, ['assume-covered', 'calendar'], { state });
  assert.equal(again.code, EXIT.OK);
  assert.match(again.stdout, /already 23\/09\/2026/);
  const unset = await run(root, ['assume-covered', 'transcripts'], { state });
  assert.match(unset.stdout, /These 1 day\(s\) are now closed without having been read by a round: 23\/09\/2026/);
});

test('watermark writes take the vault lock: a live holder postpones with 75 and nothing moves', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-20');
  const lock = acquireLock(root, { command: 'curate', env: CLEAN_ENV });
  try {
    for (const argv of [['set', 'transcripts', '2026-09-22'], ['reopen', 'transcripts', '2026-09-18'], ['assume-covered', 'transcripts']]) {
      const r = await run(root, argv, { state });
      assert.equal(r.code, EXIT.TEMPFAIL, argv.join(' '));
      assert.match(r.stderr, /curate/);
    }
    assert.equal((await run(root, ['show'], { state })).code, EXIT.OK, 'show only reads');
  } finally {
    lock.release();
  }
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-20');
});

test('watermark on a damaged file exits 1 and changes nothing', async () => {
  const root = vaultRepo();
  const state = stateDir();
  writeFileSync(join(state, 'watermark.json'), '{oops');
  for (const argv of [['show'], ['assume-covered', 'transcripts']]) {
    const r = await run(root, argv, { state });
    assert.equal(r.code, EXIT.FAILURE);
    assert.match(r.stderr, /cannot be read/);
  }
  assert.equal(readFileSync(join(state, 'watermark.json'), 'utf8'), '{oops');
});

test('watermark outside a vault is a usage error; pt-BR speaks Portuguese', async () => {
  const state = stateDir();
  const nowhere = makeTempDir('brain-kit-watermark-nowhere-');
  assert.equal((await run(nowhere, ['show'], { state })).code, EXIT.USAGE);
  const root = vaultRepo();
  const r = await run(root, ['show'], { state, lang: 'pt-BR' });
  assert.match(r.stdout, /sem marca/);
});

test('the CLI dispatches watermark, and the usage lists it', async () => {
  let stdout = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: () => {} } };
  assert.equal(await main(['watermark', '--help'], io), EXIT.OK);
  assert.match(stdout, /brain-kit watermark assume-covered </);
  stdout = '';
  assert.equal(await main(['--help'], io), EXIT.OK);
  assert.match(stdout, /watermark show\|set\|reopen\|assume-covered/);
});
