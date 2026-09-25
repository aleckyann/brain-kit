// docs/incidents.md, 20/08/2026, "the round closed a day it had never read":
// the round exited 0 and wrote the previous day into the high water mark
// without having read the calendar. That day's calendar never reopened. The
// rule: a round that did not read its sources may not close the day as
// swept. For the calendar source this is the recurring shape the phase 3
// plan names, a command that succeeds answering about something other than
// what we act on: a listing of one hour of the day read as the whole day, a
// first page read as every page. So a listing counts only when its
// startTime and endTime cover the source's whole window, and a partial
// listing leaves the calendar unread whatever the model reports, and its
// day open.
//
// Replayed through the real pieces: a stream parsed by
// src/harness/stream.mjs (tool results carry the connector's JSON text, a
// next page shown as "nextPageToken"), the calendar source's readEvidence
// through src/guards/read-evidence.mjs, the model's final line through
// parseSourcesLine, and advanceWatermark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { evidenceFor } from '../../src/guards/read-evidence.mjs';
import { advanceWatermark, parseSourcesLine, readWatermark } from '../../src/guards/watermark.mjs';
import { calendarSource } from '../../src/sources/calendar-google.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const FROM = new Date('2026-05-12T03:00:00.000Z');
const TO = new Date('2026-05-13T03:00:00.000Z');
const NOW = new Date('2026-05-13T12:30:00.000Z');
const DAY = '2026-05-12';
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const LIST = 'mcp__claude_ai_Google_Calendar__list_events';

function plan() {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8'));
  config.vault.timezone = TIMEZONE;
  config.sources.calendar.calendars = ['primary'];
  return calendarSource.collect({ window: { from: FROM, to: TO, days: [DAY], timezone: TIMEZONE }, config });
}

// A round whose model made these list_events calls, each answered with the
// connector's JSON text (with a next page token when `more`), and whose
// last line reports the calendar read.
function round(calls) {
  const lines = [{ type: 'system', subtype: 'init', permissionMode: 'dontAsk', tools: [LIST], mcp_servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }] }];
  calls.forEach(({ input, more }, index) => {
    const id = `toolu_partial_${index + 1}`;
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: LIST, input }] } });
    const answer = { accessRole: 'owner', events: [{ id: `evt-000${index + 1}`, summary: 'Reading group', eventType: 'default' }], summary: 'Ana' };
    if (more) answer.nextPageToken = `bmV1dHJhbCBwYWdlIHRva2Vu${index}`;
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(answer) }] } });
  });
  lines.push({ type: 'result', subtype: 'success', is_error: false, result: 'Nothing new on the calendar today.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=ok' });
  return parseStream(lines.map((line) => JSON.stringify(line)));
}

function input(overrides = {}) {
  return { calendarId: 'primary', startTime: FROM.toISOString(), endTime: TO.toISOString(), eventType: ['DEFAULT'], pageSize: 250, timeZone: TIMEZONE, ...overrides };
}

// What the round would do with the calendar's mark, given the record.
function closeDay(record) {
  const stateDir = makeTempDir('brain-kit-calendar-partial-');
  const evidence = evidenceFor([calendarSource], { calendar: plan() }, record).calendar;
  const outcome = advanceWatermark(stateDir, 'calendar', DAY, { modelExit: 0, evidence, sourcesLine: parseSourcesLine(record.result.text), timezone: TIMEZONE, now: NOW });
  return { evidence, outcome, mark: readWatermark(stateDir).sources.calendar ?? null };
}

test('a listing of one afternoon hour, read as the whole day, does not read the calendar and leaves its day open', () => {
  const hour = round([{ input: input({ startTime: '2026-05-12T14:00:00-03:00', endTime: '2026-05-12T15:00:00-03:00' }) }]);
  const { evidence, outcome, mark } = closeDay(hour);
  assert.deepEqual(evidence, { read: 0, expected: 1, ok: false });
  assert.deepEqual(outcome, { advanced: false, reason: 'no_evidence' });
  assert.equal(mark, null);
});

test('a listing that stops an hour before the window ends, or starts an hour after it opens, does not read the calendar', () => {
  for (const partial of [input({ endTime: '2026-05-13T02:00:00.000Z' }), input({ startTime: '2026-05-12T04:00:00.000Z' })]) {
    const { evidence, mark } = closeDay(round([{ input: partial }]));
    assert.deepEqual(evidence, { read: 0, expected: 1, ok: false }, JSON.stringify(partial));
    assert.equal(mark, null);
  }
});

test('a whole-day listing whose first page was read as every page does not read the calendar', () => {
  const { evidence, mark } = closeDay(round([{ input: input(), more: true }]));
  assert.deepEqual(evidence, { read: 0, expected: 1, ok: false });
  assert.equal(mark, null);
});

test('the whole window with every page read is what closes the day', () => {
  const { evidence, outcome, mark } = closeDay(round([{ input: input(), more: true }, { input: input({ pageToken: 'bmV1dHJhbCBwYWdlIHRva2Vu0' }) }]));
  assert.deepEqual(evidence, { read: 1, expected: 1, ok: true });
  assert.equal(outcome.advanced, true);
  assert.equal(mark, DAY);
});
