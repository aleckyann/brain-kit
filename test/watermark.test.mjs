// The high water mark (src/guards/watermark.mjs) and the owner's command
// (src/commands/watermark.mjs). docs/incidents.md, 17/09/2026 and
// 20/08/2026: the mark holds the last day swept per source, and it moves
// only on exit 0 plus read evidence plus the model's sources line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { withConnectors } from './helpers/curate-world.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const OK_LINE = { transcripts: 'ok' };
const READ = { read: 2, expected: 2, ok: true };
// The round's clock and zone: yesterday is 24/09/2026 in UTC.
const ROUND = { timezone: 'UTC', now: new Date('2026-09-25T12:00:00Z') };
const advance = (dir, id, day, options = {}) => advanceWatermark(dir, id, day, { ...ROUND, ...options });

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
  assert.equal(covered.future, false);
});

test('windowFor: a mark later than yesterday is flagged future, never read as covered', () => {
  for (const mark of ['2026-09-24', '2026-09-30', '2099-01-01']) {
    const w = windowFor(mark, '2026-09-24', 'UTC');
    assert.deepEqual([w.days, w.clipped, w.future], [[], false, true], mark);
    assert.equal(w.from.getTime(), w.to.getTime());
  }
  assert.equal(windowFor('2026-09-23', '2026-09-24', 'UTC').future, false, 'yesterday is covered, not future');
  assert.equal(windowFor(null, '2026-09-24', 'UTC').future, false);
  assert.equal(windowFor('2026-09-01', '2026-09-24', 'UTC').future, false);
  // In the vault's zone: at 22:00 of 23/09 at UTC-3 a mark of 23/09 is ahead.
  const now = new Date('2026-09-24T01:00:00Z');
  assert.equal(windowFor('2026-09-23', now, 'America/Sao_Paulo').future, true);
  assert.equal(windowFor('2026-09-23', now, 'UTC').future, false);
});

test('windowFor: from the day after the mark to yesterday, inclusive', () => {
  const w = windowFor('2026-09-20', '2026-09-24', 'UTC');
  assert.deepEqual(w.days, ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.equal(w.from.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(w.to.toISOString(), '2026-09-24T00:00:00.000Z');
});

test('windowFor: more than maxDays open keeps the OLDEST, ends the window after the last kept day, and counts the newer days left', () => {
  const w = windowFor('2026-09-10', '2026-09-24', 'UTC');
  assert.deepEqual(w.days, ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
  assert.equal(w.clipped, true);
  assert.equal(w.remaining, 6, '18/09 to 23/09 are left for the next round');
  assert.equal('skipped' in w, false, 'no day is ever closed unread');
  assert.equal(w.from.toISOString(), '2026-09-11T00:00:00.000Z');
  assert.equal(w.to.toISOString(), '2026-09-18T00:00:00.000Z');
  const exact = windowFor('2026-09-16', '2026-09-24', 'UTC');
  assert.deepEqual([exact.days.length, exact.clipped, exact.remaining], [7, false, 0]);
  assert.equal(exact.to.toISOString(), '2026-09-24T00:00:00.000Z');
  const three = windowFor('2026-09-10', '2026-09-24', 'UTC', { maxDays: 3 });
  assert.deepEqual([three.days, three.clipped, three.remaining], [['2026-09-11', '2026-09-12', '2026-09-13'], true, 10]);
  assert.equal(three.to.toISOString(), '2026-09-14T00:00:00.000Z');
  // The next round, from the mark this one leaves, continues where it stopped.
  const next = windowFor('2026-09-13', '2026-09-24', 'UTC', { maxDays: 3 });
  assert.deepEqual([next.days[0], next.remaining], ['2026-09-14', 7]);
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

test('startOfDay where the clock goes back from 01:00 to 00:00: the first midnight starts the day', () => {
  // Asia/Gaza, 21/09/2012: 00:00 +03 came, and at 01:00 the clock went back
  // to 00:00 +02. The day began at the first 00:00, 21:00Z of the 20th.
  assert.equal(startOfDay('2012-09-21', 'Asia/Gaza').toISOString(), '2012-09-20T21:00:00.000Z');
  assert.equal(startOfDay('2012-09-22', 'Asia/Gaza').toISOString(), '2012-09-21T22:00:00.000Z');
  assert.equal(startOfDay('2012-09-20', 'Asia/Gaza').toISOString(), '2012-09-19T21:00:00.000Z');
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
  const result = advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE });
  assert.deepEqual(result, { advanced: true, previous: null });
  assert.deepEqual(markOf(dir), { sources: { calendar: '2026-09-01', transcripts: '2026-09-23' } });
  assert.equal(statSync(join(dir, 'watermark.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['watermark.json'], 'no temporary file is left behind');
});

test('advance: a model exit other than 0 leaves the day open, even with evidence and the line', () => {
  for (const modelExit of [1, 69, null, undefined, '0']) {
    const dir = stateDir();
    const result = advance(dir, 'transcripts', '2026-09-23', { modelExit, evidence: READ, sourcesLine: OK_LINE });
    assert.deepEqual(result, { advanced: false, reason: 'model_exit' }, String(modelExit));
    assert.equal(existsSync(join(dir, 'watermark.json')), false);
  }
});

test('advance: evidence that is not ok, or missing, leaves the day open', () => {
  for (const evidence of [{ read: 0, expected: 2, ok: false }, null, undefined, { read: 2, expected: 2, ok: 'yes' }]) {
    const dir = stateDir();
    const result = advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence, sourcesLine: OK_LINE });
    assert.deepEqual(result, { advanced: false, reason: 'no_evidence' });
    assert.equal(existsSync(join(dir, 'watermark.json')), false);
  }
});

test('advance: no sources line leaves the day open', () => {
  const dir = stateDir();
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: null }), { advanced: false, reason: 'no_sources_line' });
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ }), { advanced: false, reason: 'no_sources_line' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance: a line that does not name the source, or names it failed, leaves the day open', () => {
  const dir = stateDir();
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: { calendar: 'ok' } }), { advanced: false, reason: 'not_reported' });
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: {} }), { advanced: false, reason: 'not_reported' });
  for (const state of ['failed', 'OK', 'partial', '']) {
    assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: { transcripts: state } }), { advanced: false, reason: 'reported_failed' }, state);
  }
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance: "empty" counts only when the plan offered nothing', () => {
  const dir = stateDir();
  const withFiles = advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { read: 1, expected: 3, ok: true }, sourcesLine: { transcripts: 'empty' } });
  assert.deepEqual(withFiles, { advanced: false, reason: 'empty_with_files' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  const nothing = advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { read: 0, expected: 0, ok: true }, sourcesLine: { transcripts: 'empty' } });
  assert.deepEqual(nothing, { advanced: true, previous: null });
});

test('advance: "empty" with nothing expected still needs exit 0 and ok evidence', () => {
  const dir = stateDir();
  const nothing = { read: 0, expected: 0, ok: true };
  assert.equal(advance(dir, 'transcripts', '2026-09-23', { modelExit: 1, evidence: nothing, sourcesLine: { transcripts: 'empty' } }).advanced, false);
  assert.equal(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { ...nothing, ok: false }, sourcesLine: { transcripts: 'empty' } }).advanced, false);
  assert.equal(advance(dir, 'transcripts', '2026-09-23', { modelExit: 1, evidence: nothing, sourcesLine: OK_LINE }).advanced, false);
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
});

test('advance, vacuous (no model ran): only when the evidence expected nothing', () => {
  const dir = stateDir();
  for (const evidence of [{ read: 0, expected: 1, ok: false }, { read: 0, expected: null, ok: false }, null, undefined]) {
    assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence }), { advanced: false, reason: 'not_vacuous' });
  }
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  const ok = advance(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence: { read: 0, expected: 0, ok: true } });
  assert.deepEqual(ok, { advanced: true, previous: null });
  assert.equal(markOf(dir).sources.transcripts, '2026-09-23');
});

// Phase 3, task 5: the advance rule per source. A source whose plan never
// offers nothing while it is on (emptyMeansNothingListed false: the
// connector sources) proves its empty day by its listing.
test('advance, a source that lists something whenever it is on: "empty" counts with its evidence ok and something expected, never with nothing expected', () => {
  const dir = stateDir();
  const connector = { emptyMeansNothingListed: false };
  const listed = { read: 1, expected: 1, ok: true, listed: 0 };
  assert.deepEqual(advance(dir, 'calendar', '2026-09-23', { modelExit: 0, evidence: { ...listed, ok: false }, sourcesLine: { calendar: 'empty' }, ...connector }), { advanced: false, reason: 'no_evidence' });
  assert.deepEqual(advance(dir, 'calendar', '2026-09-23', { modelExit: 0, evidence: { read: 0, expected: 0, ok: true }, sourcesLine: { calendar: 'empty' }, ...connector }), { advanced: false, reason: 'empty_nothing_listed' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  assert.deepEqual(advance(dir, 'calendar', '2026-09-23', { modelExit: 0, evidence: listed, sourcesLine: { calendar: 'empty' }, ...connector }), { advanced: true, previous: null });
  assert.deepEqual(advance(dir, 'meeting_notes', '2026-09-23', { modelExit: 0, evidence: listed, sourcesLine: { meeting_notes: 'ok' }, ...connector }), { advanced: true, previous: null });
  for (const state of ['partial', 'unavailable', 'failed']) {
    assert.deepEqual(advance(dir, 'meeting_notes', '2026-09-24', { modelExit: 0, evidence: listed, sourcesLine: { meeting_notes: state }, ...connector }), { advanced: false, reason: 'reported_failed' }, state);
  }
  // The default (the member absent, or true) is phase 2's rule, unchanged.
  for (const member of [{}, { emptyMeansNothingListed: true }]) {
    assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: listed, sourcesLine: { transcripts: 'empty' }, ...member }), { advanced: false, reason: 'empty_with_files' });
  }
  assert.deepEqual(markOf(dir).sources, { calendar: '2026-09-23', meeting_notes: '2026-09-23' });
});

test('advance, ruling R-F1: a connector source\'s "empty" counts only when its reads listed nothing; a listing that found something, or no count, is inconsistent_empty, while "ok" does not look at the count', () => {
  const dir = stateDir();
  const connector = { emptyMeansNothingListed: false };
  const read = { read: 1, expected: 1, ok: true };
  for (const listed of [2, 1, null, undefined, -1, '0', 0.5]) {
    const evidence = listed === undefined ? read : { ...read, listed };
    assert.deepEqual(advance(dir, 'meeting_notes', '2026-09-23', { modelExit: 0, evidence, sourcesLine: { meeting_notes: 'empty' }, ...connector }), { advanced: false, reason: 'inconsistent_empty' }, String(listed));
  }
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  assert.deepEqual(advance(dir, 'calendar', '2026-09-23', { modelExit: 0, evidence: { ...read, listed: 3 }, sourcesLine: { calendar: 'ok' }, ...connector }), { advanced: true, previous: null });
  assert.deepEqual(advance(dir, 'meeting_notes', '2026-09-23', { modelExit: 0, evidence: { ...read, listed: 0 }, sourcesLine: { meeting_notes: 'empty' }, ...connector }), { advanced: true, previous: null });
  // A local source's empty is phase 2's rule: the count plays no part.
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: { read: 0, expected: 0, ok: true, listed: 4 }, sourcesLine: { transcripts: 'empty' } }), { advanced: true, previous: null });
});

test('advance, vacuous: never for a source that lists something whenever it is on, even with nothing expected', () => {
  const dir = stateDir();
  const nothing = { read: 0, expected: 0, ok: true };
  assert.deepEqual(advance(dir, 'calendar', '2026-09-23', { vacuous: true, evidence: nothing, emptyMeansNothingListed: false }), { advanced: false, reason: 'not_vacuous' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence: nothing, emptyMeansNothingListed: true }), { advanced: true, previous: null });
});

test('advance: vacuous must be exactly true; anything else takes the model path', () => {
  const dir = stateDir();
  const result = advance(dir, 'transcripts', '2026-09-23', { vacuous: 'yes', evidence: { read: 0, expected: 0, ok: true } });
  assert.deepEqual(result, { advanced: false, reason: 'model_exit' });
});

test('advance never moves the mark back or onto the day it already holds', () => {
  const dir = stateDir();
  setWatermark(dir, 'transcripts', '2026-09-23');
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-23', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: false, reason: 'not_later' });
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-20', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: false, reason: 'not_later' });
  assert.equal(markOf(dir).sources.transcripts, '2026-09-23');
  assert.deepEqual(advance(dir, 'transcripts', '2026-09-24', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), { advanced: true, previous: '2026-09-23' });
});

test('advance refuses a day later than yesterday in the vault zone, on every path', () => {
  const dir = stateDir();
  const now = new Date('2026-09-24T01:00:00Z');
  const nothing = { read: 0, expected: 0, ok: true };
  for (const day of ['2026-09-24', '2099-01-01']) {
    assert.deepEqual(advanceWatermark(dir, 'transcripts', day, { modelExit: 0, evidence: READ, sourcesLine: OK_LINE, timezone: 'UTC', now }), { advanced: false, reason: 'future_day' }, day);
    assert.deepEqual(advanceWatermark(dir, 'transcripts', day, { vacuous: true, evidence: nothing, timezone: 'UTC', now }), { advanced: false, reason: 'future_day' }, day);
  }
  // 23/09 has ended in UTC but not at UTC-3 (22:00 there).
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence: nothing, timezone: 'America/Sao_Paulo', now }), { advanced: false, reason: 'future_day' });
  assert.equal(existsSync(join(dir, 'watermark.json')), false);
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-22', { vacuous: true, evidence: nothing, timezone: 'America/Sao_Paulo', now }), { advanced: true, previous: null });
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2026-09-23', { vacuous: true, evidence: nothing, timezone: 'UTC', now }), { advanced: true, previous: '2026-09-22' });
});

test('advance needs the vault time zone; the default clock is now', () => {
  const dir = stateDir();
  assert.throws(() => advanceWatermark(dir, 'transcripts', '2026-09-01', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), TypeError);
  assert.deepEqual(advanceWatermark(dir, 'transcripts', '2099-01-01', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE, timezone: 'UTC' }), { advanced: false, reason: 'future_day' });
});

test('advance refuses a day that is not a date', () => {
  assert.throws(() => advance(stateDir(), 'transcripts', '23/09/2026', { modelExit: 0, evidence: READ, sourcesLine: OK_LINE }), TypeError);
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

test('parseSourcesLine: an id named twice keeps the first state that is not ok', () => {
  assert.deepEqual(parseSourcesLine('BRAIN_KIT_SOURCES: transcripts=failed transcripts=ok'), { transcripts: 'failed' });
  assert.deepEqual(parseSourcesLine('BRAIN_KIT_SOURCES: transcripts=ok transcripts=failed'), { transcripts: 'failed' });
  assert.deepEqual(parseSourcesLine('BRAIN_KIT_SOURCES: transcripts=empty transcripts=ok calendar=ok calendar=ok'), { transcripts: 'empty', calendar: 'ok' });
});

test('parseSourcesLine: one layer of markdown around the line is removed', () => {
  const want = { transcripts: 'ok', calendar: 'empty' };
  assert.deepEqual(parseSourcesLine('`BRAIN_KIT_SOURCES: transcripts=ok calendar=empty`'), want);
  assert.deepEqual(parseSourcesLine('**BRAIN_KIT_SOURCES:** transcripts=ok calendar=empty'), want);
  assert.deepEqual(parseSourcesLine('> BRAIN_KIT_SOURCES: transcripts=ok calendar=empty'), want);
  assert.equal(parseSourcesLine('see `BRAIN_KIT_SOURCES: transcripts=ok`'), null, 'still only at the start of a line');
});

// ------------------------------------------------------------ the command

function vaultRepo(timezone = 'UTC', edit = () => {}) {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.timezone = timezone;
  edit(config);
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
  assert.match(r.stdout, /Days now closed without having been read by a round \(2\): 20\/09\/2026, 21\/09\/2026/);
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
  assert.match(r.stdout, /Days now closed without having been read by a round \(3\): 21\/09\/2026, 22\/09\/2026, 23\/09\/2026/);
  const again = await run(root, ['assume-covered', 'calendar'], { state });
  assert.equal(again.code, EXIT.OK);
  assert.match(again.stdout, /already 23\/09\/2026/);
  const unset = await run(root, ['assume-covered', 'transcripts'], { state });
  assert.match(unset.stdout, /Days now closed without having been read by a round \(1\): 23\/09\/2026/);
});

test('watermark writes take the vault lock: a live holder postpones with 75 and nothing moves', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-20');
  const lock = acquireLock(root, { command: 'curate', env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: state } });
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

test('watermark show flags a mark ahead of yesterday and names the reopen command', async () => {
  const root = vaultRepo();
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-26');
  setWatermark(state, 'calendar', '2026-09-23');
  const r = await run(root, ['show'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.match(r.stdout, /transcripts: last day swept 26\/09\/2026, 3 day\(s\) AHEAD of yesterday \(23\/09\/2026\)/);
  assert.match(r.stdout, /brain-kit watermark reopen transcripts 2026-09-23/);
  assert.match(r.stdout, /calendar: last day swept 23\/09\/2026, 0 day\(s\) behind yesterday/);
  assert.doesNotMatch(r.stdout, /transcripts: last day swept 26\/09\/2026, 0 day/);
  const pt = await run(root, ['show'], { state, lang: 'pt-BR' });
  assert.match(pt.stdout, /À FRENTE de ontem/);
  assert.match(pt.stdout, /brain-kit watermark reopen transcripts 2026-09-23/);
  // The command it names works, and brings the window back.
  const reopened = await run(root, ['reopen', 'transcripts', '2026-09-23'], { state });
  assert.equal(reopened.code, EXIT.OK, reopened.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-22');
  assert.deepEqual(windowFor('2026-09-22', '2026-09-24', 'UTC').days, ['2026-09-23']);
});

test('watermark with a vault.timezone the system does not know exits 2 naming it', async () => {
  const root = vaultRepo('Mars/Base');
  const state = stateDir();
  const r = await run(root, ['show'], { state });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /"Mars\/Base"/);
});

test('watermark on a damaged file exits 1 and changes nothing', async () => {
  const root = vaultRepo();
  const state = stateDir();
  writeFileSync(join(state, 'watermark.json'), '{oops');
  const legacy = join(makeTempDir('brain-kit-watermark-legacy-'), 'last-day-swept');
  writeFileSync(legacy, '2026-09-20\n');
  for (const argv of [['show'], ['assume-covered', 'transcripts'], ['import', '--from', legacy]]) {
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

// ------------------------------------------------------------ import
//
// Phase 5a, task 1: `watermark import --from <file> [--sources <id,...>]`
// carries a legacy setup's watermark (one line, YYYY-MM-DD) over into the
// marks of the enabled sources, through set's own path.

// What each language says, in the lines and refusals of an import.
const SAYS = Object.freeze({
  en: {
    set: 'last day swept set to', previous: 'previous', none: 'none', unchanged: 'unchanged, the last day swept is already',
    badLine: 'must hold exactly one line, a day written as YYYY-MM-DD', badDay: 'which is not a day of the calendar',
    future: 'has not ended yet in', notEnabled: 'not an enabled source of this vault:', noEnabled: 'no source of this vault is enabled',
    nothing: 'Nothing was changed.', cut: '(its first 80 characters)', notFound: 'does not exist', notFile: 'is not a regular file',
    needsValue: 'needs a value', needsFrom: '--from <file> is required', emptySource: 'has an empty one',
  },
  'pt-BR': {
    set: 'último dia varrido definido como', previous: 'anterior', none: 'nenhum', unchanged: 'inalterado, o último dia varrido já é',
    badLine: 'precisa guardar exatamente uma linha, um dia escrito como AAAA-MM-DD', badDay: 'que não é um dia do calendário',
    future: 'ainda não terminou no fuso', notEnabled: 'não é uma fonte ligada deste vault:', noEnabled: 'nenhuma fonte deste vault está ligada',
    nothing: 'Nada foi alterado.', cut: '(os primeiros 80 caracteres)', notFound: 'não existe', notFile: 'não é um arquivo comum',
    needsValue: 'precisa de um valor', needsFrom: '--from <arquivo> é obrigatório', emptySource: 'tem um vazio',
  },
});
const LANGS = Object.keys(SAYS);
const ALL_ON = ['transcripts', 'calendar', 'meeting_notes'];

// A legacy watermark file as a legacy setup's own script leaves it, with an
// mtime in the past, so that any write to it shows.
const LEGACY_MTIME = new Date('2026-01-02T03:04:05Z');
function legacyFile(content, name = 'last-day-swept') {
  const file = join(makeTempDir('brain-kit-watermark-legacy-'), name);
  writeFileSync(file, content);
  utimesSync(file, LEGACY_MTIME, LEGACY_MTIME);
  return file;
}

// What an import leaves exactly as it was: the bytes, the inode (a
// replacement by rename is a move) and the mtime.
function fingerprint(file) {
  const stat = statSync(file);
  return { bytes: readFileSync(file).toString('hex'), ino: stat.ino, mtime: stat.mtimeMs };
}

function lines(text) {
  return text.split('\n').filter((line) => line !== '');
}

function marksBytes(state) {
  const file = join(state, 'watermark.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function shownDay(day) {
  return day.split('-').reverse().join('/');
}

test('watermark import writes the legacy day into every enabled source, one line each with the day and the previous mark, in both languages', async () => {
  const root = vaultRepo('UTC', withConnectors());
  const file = legacyFile('2026-09-20\n');
  for (const lang of LANGS) {
    const say = SAYS[lang];
    const state = stateDir();
    setWatermark(state, 'calendar', '2026-09-10');
    const r = await run(root, ['import', '--from', file], { state, lang });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(readWatermark(state).sources, { transcripts: '2026-09-20', calendar: '2026-09-20', meeting_notes: '2026-09-20' });
    assert.deepEqual(lines(r.stdout), [
      `transcripts: ${say.set} 20/09/2026 (${say.previous}: ${say.none}).`,
      `calendar: ${say.set} 20/09/2026 (${say.previous}: 10/09/2026).`,
      `meeting_notes: ${say.set} 20/09/2026 (${say.previous}: ${say.none}).`,
    ], lang);
  }
});

test('watermark import defaults to the enabled sources alone: a listed source that is off, or a configured one no list names, keeps its mark', async () => {
  // The fixture lists calendar and meeting_notes and leaves both off.
  const off = vaultRepo();
  let state = stateDir();
  let r = await run(off, ['import', '--from', legacyFile('2026-09-20')], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readWatermark(state).sources, { transcripts: '2026-09-20' });
  assert.deepEqual(lines(r.stdout), ['transcripts: last day swept set to 20/09/2026 (previous: none).']);
  // The calendar configured and on, but in neither list: no round reads it.
  const unlisted = vaultRepo('UTC', (c) => {
    withConnectors()(c);
    c.curate.sources.best_effort = ['meeting_notes'];
  });
  state = stateDir();
  r = await run(unlisted, ['import', '--from', legacyFile('2026-09-20')], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readWatermark(state).sources, { transcripts: '2026-09-20', meeting_notes: '2026-09-20' });
});

test('watermark import --sources writes only the sources named, in the order named, a name given twice once', async () => {
  const root = vaultRepo('UTC', withConnectors());
  const file = legacyFile('2026-09-20\r\n');
  let state = stateDir();
  setWatermark(state, 'calendar', '2026-09-01');
  let r = await run(root, ['import', '--sources', 'meeting_notes,transcripts, meeting_notes', '--from', file], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readWatermark(state).sources, { calendar: '2026-09-01', meeting_notes: '2026-09-20', transcripts: '2026-09-20' });
  assert.deepEqual(lines(r.stdout).map((line) => line.split(':')[0]), ['meeting_notes', 'transcripts']);
  state = stateDir();
  r = await run(root, ['import', `--from=${file}`, '--sources=calendar'], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readWatermark(state).sources, { calendar: '2026-09-20' });
});

test('watermark import refuses with 2 a named source that is not enabled, before anything is written, listing the enabled ones, in both languages', async () => {
  // transcripts on; calendar and meeting_notes listed and off.
  const fixture = vaultRepo();
  // A listed id this version does not know.
  const unknown = vaultRepo('UTC', (c) => { c.curate.sources.best_effort = ['calendar', 'meeting_notes', 'slack']; });
  // The calendar configured and on, but in neither list.
  const unlisted = vaultRepo('UTC', (c) => {
    withConnectors()(c);
    c.curate.sources.best_effort = ['meeting_notes'];
  });
  const file = legacyFile('2026-09-20\n');
  const cases = [
    [fixture, 'calendar', 'calendar', 'transcripts'],
    [fixture, 'nope', 'nope', 'transcripts'],
    // One enabled and one not: the enabled one is not written either.
    [fixture, 'transcripts,calendar', 'calendar', 'transcripts'],
    [fixture, 'calendar,nope,transcripts', 'calendar, nope', 'transcripts'],
    // An id is its exact spelling: no round reads a mark kept under another.
    [fixture, 'Transcripts', 'Transcripts', 'transcripts'],
    [unknown, 'slack', 'slack', 'transcripts'],
    [unlisted, 'transcripts,calendar', 'calendar', 'transcripts, meeting_notes'],
  ];
  for (const lang of LANGS) {
    const say = SAYS[lang];
    for (const [vault, ids, named, enabled] of cases) {
      const state = stateDir();
      setWatermark(state, 'transcripts', '2026-09-10');
      const before = marksBytes(state);
      const r = await run(vault, ['import', '--from', file, '--sources', ids], { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${ids}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(`${say.notEnabled} ${named}.`), `${lang} ${ids}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`: ${enabled}. ${say.nothing}`), `${lang} ${ids}: ${r.stderr}`);
      assert.equal(marksBytes(state), before, `${lang} ${ids}: nothing was written`);
    }
  }
});

test('watermark import with no enabled source refuses with 2 rather than write nothing in silence, in both languages', async () => {
  const none = vaultRepo('UTC', (c) => {
    c.curate.sources.required = [];
    c.curate.sources.best_effort = ['calendar'];
  });
  const file = legacyFile('2026-09-20\n');
  for (const lang of LANGS) {
    for (const extra of [[], ['--sources', 'calendar']]) {
      const state = stateDir();
      const r = await run(none, ['import', '--from', file, ...extra], { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${extra}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(SAYS[lang].noEnabled), r.stderr);
      assert.ok(r.stderr.includes(SAYS[lang].nothing), r.stderr);
      assert.equal(existsSync(join(state, 'watermark.json')), false);
    }
  }
});

test('watermark import accepts exactly one line YYYY-MM-DD, with or without a final LF or CRLF', async () => {
  const root = vaultRepo();
  for (const content of ['2026-09-20', '2026-09-20\n', '2026-09-20\r\n']) {
    const state = stateDir();
    const r = await run(root, ['import', '--from', legacyFile(content)], { state });
    assert.equal(r.code, EXIT.OK, `${JSON.stringify(content)}: ${r.stderr}`);
    assert.equal(readWatermark(state).sources.transcripts, '2026-09-20');
  }
});

test('watermark import refuses with 2 every other shape of file, quoting what it read and changing nothing, in both languages', async () => {
  const root = vaultRepo();
  const shapes = [
    ['', '""'],
    ['\n', '"\\n"'],
    ['\r\n', '"\\r\\n"'],
    ['2026-09-20\n2026-09-21\n', '"2026-09-20\\n2026-09-21\\n"'],
    ['2026-09-20\n\n', '"2026-09-20\\n\\n"'],
    ['2026-09-20\n\r\n', '"2026-09-20\\n\\r\\n"'],
    ['\n2026-09-20\n', '"\\n2026-09-20\\n"'],
    ['2026-09-20\r', '"2026-09-20\\r"'],
    ['2026-09-20\n\r', '"2026-09-20\\n\\r"'],
    [' 2026-09-20\n', '" 2026-09-20\\n"'],
    ['2026-09-20 \n', '"2026-09-20 \\n"'],
    ['2026-09-20\t\n', '"2026-09-20\\t\\n"'],
    ['yesterday\n', '"yesterday\\n"'],
    ['20/09/2026\n', '"20/09/2026\\n"'],
    ['2026-9-20\n', '"2026-9-20\\n"'],
    ['2026-09-20T09:30:00Z\n', '"2026-09-20T09:30:00Z\\n"'],
    ['last="2026-09-20"\n', '"last=\\"2026-09-20\\"\\n"'],
    // Characters that print as nothing are named, so a file that looks
    // right shows why it is refused: a byte order mark, a no-break space.
    [`${String.fromCodePoint(0xfeff)}2026-09-20\n`, '"<U+FEFF>2026-09-20\\n"'],
    [`2026-09-20${String.fromCodePoint(0xa0)}\n`, '"2026-09-20<U+00A0>\\n"'],
  ];
  for (const lang of LANGS) {
    const say = SAYS[lang];
    for (const [content, quote] of shapes) {
      const state = stateDir();
      const file = legacyFile(content);
      const r = await run(root, ['import', '--from', file], { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${quote}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(say.badLine), `${lang} ${quote}: ${r.stderr}`);
      assert.ok(r.stderr.includes(file), `${lang} ${quote}: ${r.stderr}`);
      assert.ok(r.stderr.includes(` ${quote}. ${say.nothing}`), `${lang} ${quote}: ${r.stderr}`);
      assert.equal(existsSync(join(state, 'watermark.json')), false);
    }
  }
});

test('watermark import refuses with 2 a date the calendar does not have, quoting it; a real leap day is written', async () => {
  const root = vaultRepo();
  for (const lang of LANGS) {
    for (const day of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-09-00', '2025-02-29', '1900-02-29']) {
      const state = stateDir();
      const r = await run(root, ['import', '--from', legacyFile(`${day}\n`)], { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${day}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(`"${day}\\n", ${SAYS[lang].badDay}. ${SAYS[lang].nothing}`), `${lang} ${day}: ${r.stderr}`);
      assert.equal(existsSync(join(state, 'watermark.json')), false);
    }
  }
  const state = stateDir();
  const leap = await run(root, ['import', '--from', legacyFile('2024-02-29\n')], { state });
  assert.equal(leap.code, EXIT.OK, leap.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2024-02-29');
});

test('watermark import refuses with 2 a day after yesterday in the vault time zone, quoting it; yesterday itself is written', async () => {
  // run()'s clock: 24/09/2026 12:00 UTC, so yesterday was 23/09/2026.
  const utc = vaultRepo();
  for (const lang of LANGS) {
    const say = SAYS[lang];
    for (const day of ['2026-09-24', '2026-09-25', '2099-01-01']) {
      const state = stateDir();
      const r = await run(utc, ['import', '--from', legacyFile(`${day}\n`)], { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${day}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(`"${day}\\n"`), `${lang} ${day}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`${shownDay(day)} ${say.future} UTC;`), `${lang} ${day}: ${r.stderr}`);
      assert.ok(r.stderr.includes('23/09/2026'), `${lang} ${day}: ${r.stderr}`);
      assert.equal(existsSync(join(state, 'watermark.json')), false);
    }
  }
  let state = stateDir();
  assert.equal((await run(utc, ['import', '--from', legacyFile('2026-09-23\n')], { state })).code, EXIT.OK);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-23');
  // At 22:00 of 23/09 at UTC-3 that day has not ended there, though it has in UTC.
  const now = new Date('2026-09-24T01:00:00Z');
  const west = vaultRepo('America/Argentina/Buenos_Aires');
  for (const lang of LANGS) {
    state = stateDir();
    const r = await run(west, ['import', '--from', legacyFile('2026-09-23\n')], { state, now, lang });
    assert.equal(r.code, EXIT.USAGE, lang);
    assert.ok(r.stderr.includes(`23/09/2026 ${SAYS[lang].future} America/Argentina/Buenos_Aires;`), `${lang}: ${r.stderr}`);
    assert.ok(r.stderr.includes('22/09/2026'), `${lang}: ${r.stderr}`);
    assert.equal(existsSync(join(state, 'watermark.json')), false);
  }
  state = stateDir();
  assert.equal((await run(west, ['import', '--from', legacyFile('2026-09-22\n')], { state, now })).code, EXIT.OK);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-22');
  state = stateDir();
  assert.equal((await run(utc, ['import', '--from', legacyFile('2026-09-23\n')], { state, now })).code, EXIT.OK, 'in UTC, 23/09 has ended');
});

test('watermark import quotes a long file by its first 80 characters, counted as characters, in both languages', async () => {
  const root = vaultRepo();
  const clef = String.fromCodePoint(0x1d11e);
  for (const lang of LANGS) {
    const cut = SAYS[lang].cut;
    for (const [content, quote] of [
      ['x'.repeat(81), 'x'.repeat(80)],
      ['x'.repeat(10000), 'x'.repeat(80)],
      ['ã'.repeat(100), 'ã'.repeat(80)],
      [clef.repeat(100), clef.repeat(80)],
    ]) {
      const r = await run(root, ['import', '--from', legacyFile(content)], { state: stateDir(), lang });
      assert.equal(r.code, EXIT.USAGE);
      assert.ok(r.stderr.includes(`"${quote}" ${cut}. ${SAYS[lang].nothing}`), `${lang}: ${r.stderr.slice(0, 300)}`);
      assert.ok(!r.stderr.includes(quote + Array.from(quote)[0]), 'never more than 80 characters');
    }
    const whole = await run(root, ['import', '--from', legacyFile('y'.repeat(80))], { state: stateDir(), lang });
    assert.ok(whole.stderr.includes(`"${'y'.repeat(80)}". ${SAYS[lang].nothing}`), whole.stderr);
    assert.ok(!whole.stderr.includes(cut), 'exactly 80 characters are quoted whole');
  }
});

test('watermark import refuses with 2 a --from that is missing, not a file or not given, and a bad --sources, in both languages', async () => {
  const root = vaultRepo();
  const dir = makeTempDir('brain-kit-watermark-legacy-dir-');
  const file = legacyFile('2026-09-20');
  for (const lang of LANGS) {
    const say = SAYS[lang];
    const state = stateDir();
    const cases = [
      [['import', '--from', join(dir, 'absent')], say.notFound],
      [['import', '--from', join(file, 'below-a-file')], say.notFound],
      [['import', '--from', dir], say.notFile],
      [['import', '--from'], `--from ${say.needsValue}`],
      [['import', '--from='], `--from ${say.needsValue}`],
      [['import'], say.needsFrom],
      [['import', root], say.needsFrom],
      [['import', '--from', file, '--sources'], `--sources ${say.needsValue}`],
      [['import', '--from', file, '--sources', ''], `--sources ${say.needsValue}`],
      [['import', '--from', file, '--sources', 'transcripts,,calendar'], say.emptySource],
      [['import', '--from', file, '--sources=,'], say.emptySource],
    ];
    for (const [argv, expected] of cases) {
      const r = await run(root, argv, { state, lang });
      assert.equal(r.code, EXIT.USAGE, `${lang} ${argv.join(' ')}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(expected), `${lang} ${argv.join(' ')}: ${r.stderr}`);
    }
    assert.equal(existsSync(join(state, 'watermark.json')), false);
  }
});

test('watermark import refuses with 2 a file it cannot read, naming the error, in both languages', { skip: process.getuid?.() === 0 && 'root reads a file whatever its mode' }, async () => {
  const root = vaultRepo();
  const file = legacyFile('2026-09-20\n');
  chmodSync(file, 0o000);
  try {
    for (const [lang, says] of [['en', 'cannot be read (EACCES)'], ['pt-BR', 'não foi possível ler']]) {
      const state = stateDir();
      const r = await run(root, ['import', '--from', file], { state, lang });
      assert.equal(r.code, EXIT.USAGE, lang);
      assert.ok(r.stderr.includes(says), `${lang}: ${r.stderr}`);
      assert.ok(r.stderr.includes('EACCES'), `${lang}: ${r.stderr}`);
      assert.equal(existsSync(join(state, 'watermark.json')), false);
    }
  } finally {
    chmodSync(file, 0o600);
  }
});

test('watermark import never changes, moves or removes the file it reads: same bytes, inode and mtime after an import, a second import and a refusal', async () => {
  const root = vaultRepo('UTC', withConnectors());
  const state = stateDir();
  const file = legacyFile('2026-09-20\n');
  const before = fingerprint(file);
  assert.equal((await run(root, ['import', '--from', file], { state })).code, EXIT.OK);
  assert.deepEqual(fingerprint(file), before);
  assert.equal((await run(root, ['import', '--from', file], { state })).code, EXIT.OK);
  assert.deepEqual(fingerprint(file), before);
  assert.deepEqual(readdirSync(dirname(file)), ['last-day-swept'], 'nothing is written beside it');
  const future = legacyFile('2026-09-24\n');
  const futureBefore = fingerprint(future);
  assert.equal((await run(root, ['import', '--from', future], { state })).code, EXIT.USAGE);
  assert.deepEqual(fingerprint(future), futureBefore);
});

test('watermark import of the same file twice: the second run prints unchanged per source and writes nothing, in both languages', async () => {
  const root = vaultRepo('UTC', withConnectors());
  const file = legacyFile('2026-09-20\n');
  for (const lang of LANGS) {
    const state = stateDir();
    assert.equal((await run(root, ['import', '--from', file], { state, lang })).code, EXIT.OK);
    const marks = join(state, 'watermark.json');
    utimesSync(marks, LEGACY_MTIME, LEGACY_MTIME);
    const before = fingerprint(marks);
    const again = await run(root, ['import', '--from', file], { state, lang });
    assert.equal(again.code, EXIT.OK, again.stderr);
    assert.equal(again.stderr, '');
    assert.deepEqual(lines(again.stdout), ALL_ON.map((source) => `${source}: ${SAYS[lang].unchanged} 20/09/2026.`), lang);
    assert.deepEqual(fingerprint(marks), before, 'the marks file is not written again');
  }
});

test('watermark import writes through set\'s own path: a held vault lock postpones it with 75 and nothing moves; then set finds the same file', async () => {
  const root = vaultRepo('UTC', withConnectors());
  const state = stateDir();
  setWatermark(state, 'transcripts', '2026-09-10');
  const before = marksBytes(state);
  const file = legacyFile('2026-09-20\n');
  const lock = acquireLock(root, { command: 'curate', env: CLEAN_ENV });
  try {
    const r = await run(root, ['import', '--from', file], { state });
    assert.equal(r.code, EXIT.TEMPFAIL);
    assert.match(r.stderr, /curate/);
    assert.equal(r.stdout, '');
  } finally {
    lock.release();
  }
  assert.equal(marksBytes(state), before);
  assert.equal((await run(root, ['import', '--from', file], { state })).code, EXIT.OK);
  assert.equal(statSync(join(state, 'watermark.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(state), ['watermark.json'], 'no temporary file is left behind');
  for (const source of ALL_ON) {
    const set = await run(root, ['set', source, '2026-09-20'], { state });
    assert.equal(set.code, EXIT.OK, set.stderr);
    assert.match(set.stdout, /already 20\/09\/2026/, source);
  }
});

test('watermark import reads a relative --from from the working directory, and takes the vault as [dir]', async () => {
  const root = vaultRepo();
  const file = legacyFile('2026-09-20\n');
  const state = stateDir();
  const r = await run(dirname(file), ['import', '--from', 'last-day-swept', root], { state });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readWatermark(state).sources.transcripts, '2026-09-20');
});

test('watermark import is in the usage of both languages and in the CLI help; its options belong to it alone', async () => {
  const root = vaultRepo();
  const en = await run(root, ['--help'], { state: stateDir() });
  assert.match(en.stdout, /brain-kit watermark import --from <file> \[--sources <source,source,\.\.\.>\] \[dir\]/);
  const pt = await run(root, ['--help'], { state: stateDir(), lang: 'pt-BR' });
  assert.match(pt.stdout, /brain-kit watermark import --from <arquivo> \[--sources <fonte,fonte,\.\.\.>\] \[dir\]/);
  let stdout = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: () => {} } };
  assert.equal(await main(['--help'], io), EXIT.OK);
  assert.match(stdout, /\n {2}watermark import --from </);
  const state = stateDir();
  const file = legacyFile('2026-09-20');
  for (const argv of [
    ['set', 'transcripts', '2026-09-20', '--from', file],
    ['show', '--sources', 'transcripts'],
    ['assume-covered', 'transcripts', `--from=${file}`],
    ['import', '--from', file, '--from', file],
    ['import', '--from', file, '--sources', 'transcripts', '--sources=transcripts'],
    ['import', '--from', file, root, 'extra'],
    ['import', '--from', file, '--force'],
  ]) {
    const r = await run(root, argv, { state });
    assert.equal(r.code, EXIT.USAGE, argv.join(' '));
    assert.match(r.stderr, /unrecognized argument/, argv.join(' '));
  }
  assert.equal(existsSync(join(state, 'watermark.json')), false);
});
