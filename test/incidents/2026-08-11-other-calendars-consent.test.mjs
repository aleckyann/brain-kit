// docs/incidents.md, 11/08/2026, "a squad's daily stand-up was invisible to
// the vault": only the owner's own calendar was in scope, so a stand-up the
// owner does not attend never reached the vault. The rule: other people's
// calendars are in scope, and there the value is what the owner does not
// see; an event that already has the owner among its attendees is skipped,
// and deduplication is by event id. And the undated incident beside it, "a
// colleague's medical appointment was in the calendar window": reading
// someone else's calendar needs a privacy filter and recorded consent. So
// the calendar source reads `sources.calendar.team_calendars` only with
// `team_calendars_consent_noted: true`; without it they are ignored, and
// the round is told how many, never silently.
//
// Replayed through the real pieces: the calendar source's collect, a stream
// parsed by src/harness/stream.mjs, and the source's readEvidence through
// src/guards/read-evidence.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { evidenceFor } from '../../src/guards/read-evidence.mjs';
import { calendarSource } from '../../src/sources/calendar-google.mjs';

const FROM = new Date('2026-05-12T03:00:00.000Z');
const TO = new Date('2026-05-13T03:00:00.000Z');
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const LIST = 'mcp__claude_ai_Google_Calendar__list_events';
const OWNER = 'ana@example.com';
const SQUAD = 'squad-calendar@example.com';

function config(lang, calendar) {
  const c = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
  c.vault.timezone = TIMEZONE;
  c.sources.calendar = { ...c.sources.calendar, calendars: [OWNER], team_calendars: [SQUAD], ...calendar };
  return c;
}

function plan(calendar, lang = 'en') {
  return calendarSource.collect({ window: { from: FROM, to: TO, timezone: TIMEZONE }, config: config(lang, calendar) });
}

// A round that listed the given calendars over the whole window, one page
// each, with the private-event filter.
function streamListing(calendarIds) {
  const lines = [{ type: 'system', subtype: 'init', permissionMode: 'dontAsk', tools: [LIST], mcp_servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }] }];
  calendarIds.forEach((calendarId, index) => {
    const id = `toolu_squad_${index + 1}`;
    const input = { calendarId, startTime: FROM.toISOString(), endTime: TO.toISOString(), eventType: ['DEFAULT'], pageSize: 250, timeZone: TIMEZONE };
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: LIST, input }] } });
    const events = [{ id: 'evt-0001', summary: 'Daily stand-up', eventType: 'default', attendees: [{ email: 'bruno@example.com' }, { email: 'carla@example.com' }] }];
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ accessRole: 'reader', events, summary: calendarId }) }] } });
  });
  lines.push({ type: 'result', subtype: 'success', is_error: false, result: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=ok' });
  return parseStream(lines.map((line) => JSON.stringify(line)));
}

test('without recorded consent, the squad calendar is ignored and the round is told how many were', () => {
  for (const lang of ['en', 'pt-BR']) {
    const p = plan({ team_calendars_consent_noted: false }, lang);
    assert.deepEqual(p.otherCalendars, [], lang);
    assert.deepEqual(p.problems, [{ code: 'other_calendars_without_consent', detail: '1' }], lang);
    assert.ok(!p.promptBlock.includes(SQUAD), `${lang}: the ignored calendar never reaches the prompt`);
    assert.ok(p.promptBlock.includes('sources.calendar.team_calendars_consent_noted'), `${lang}: the block names the setting`);
  }
  assert.match(plan({ team_calendars_consent_noted: false }).promptBlock, /Calendars ignored in sources\.calendar\.team_calendars: 1\./);
  assert.match(plan({ team_calendars_consent_noted: false }, 'pt-BR').promptBlock, /Agendas ignoradas em sources\.calendar\.team_calendars: 1\./);
  // A model that lists it anyway gains nothing: the source expects the
  // owner's calendar only.
  const p = plan({ team_calendars_consent_noted: false });
  assert.deepEqual(evidenceFor([calendarSource], { calendar: p }, streamListing([SQUAD])).calendar, { read: 0, expected: 1, ok: false });
  assert.deepEqual(evidenceFor([calendarSource], { calendar: p }, streamListing([OWNER, SQUAD])).calendar, { read: 1, expected: 1, ok: true });
});

test('with recorded consent, the squad calendar is planned with the same exact inputs, and the day is read only with it', () => {
  const p = plan({ team_calendars_consent_noted: true });
  assert.deepEqual(p.otherCalendars, [SQUAD]);
  assert.deepEqual(p.problems, []);
  assert.ok(p.promptBlock.includes(`{"calendarId":"${SQUAD}","startTime":"${FROM.toISOString()}","endTime":"${TO.toISOString()}","eventType":["DEFAULT"],"pageSize":250,"timeZone":"${TIMEZONE}"}`), p.promptBlock);
  assert.deepEqual(evidenceFor([calendarSource], { calendar: p }, streamListing([OWNER])).calendar, { read: 1, expected: 2, ok: false });
  assert.deepEqual(evidenceFor([calendarSource], { calendar: p }, streamListing([OWNER, SQUAD])).calendar, { read: 2, expected: 2, ok: true });
});

test('the block that plans other people calendars skips the events the owner attends, deduplicates by id and carries the privacy policy', () => {
  const en = plan({ team_calendars_consent_noted: true }).promptBlock;
  assert.match(en, /skip every event that already includes the owner/);
  assert.match(en, /by its id/);
  assert.match(en, /only events with at least two attendees count/);
  assert.match(en, /Nothing about anyone's private life/);
  const pt = plan({ team_calendars_consent_noted: true }, 'pt-BR').promptBlock;
  assert.match(pt, /pule todo evento que já inclui o dono/);
  assert.match(pt, /pelo id/);
  assert.match(pt, /só contam eventos com pelo menos dois participantes/);
  assert.match(pt, /Nada da vida privada de ninguém/);
});
