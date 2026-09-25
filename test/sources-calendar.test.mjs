// The calendar source (src/sources/calendar-google.mjs): when it counts as
// configured, the plan and prompt block it hands a round, the tool rules it
// asks the round for, and whether a round record read every calendar it
// planned (decision D7 of the phase 3 plan: the exact calls the model made,
// their inputs, their errors and their pages, never the model's word). The
// two incidents it carries have their own files under test/incidents/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig } from '../src/config.mjs';
import { completeDefaults } from '../src/init/config.mjs';
import { parseStream } from '../src/harness/stream.mjs';
import { connectorStates } from '../src/guards/connectors.mjs';
import { validateSource } from '../src/sources/index.mjs';
import { transcriptsSource } from '../src/sources/transcripts-claude-code.mjs';
import { calendarSource } from '../src/sources/calendar-google.mjs';

const FROM = new Date('2026-05-12T03:00:00.000Z');
const TO = new Date('2026-05-13T03:00:00.000Z');
const NOW = new Date('2026-05-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const PREFIX = 'mcp__claude_ai_Google_Calendar__';
const LIST = `${PREFIX}list_events`;
const OWNER = 'ana@example.com';
const TEAM = Object.freeze(['bruno@example.com', 'carla@example.com']);
const FIXTURE = fileURLToPath(new URL('./fixtures/stream/connectors-connected.jsonl', import.meta.url));

function defaults(lang = 'en') {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

// A vault configuration from a pack's defaults, with the owner's calendar
// configured unless `calendar` says otherwise.
function config({ lang = 'en', calendar = {} } = {}) {
  const c = defaults(lang);
  c.vault.timezone = TIMEZONE;
  c.sources.calendar = { ...c.sources.calendar, calendars: [OWNER], ...calendar };
  return c;
}

function collect(options = {}) {
  return calendarSource.collect({
    window: { from: FROM, to: TO, days: ['2026-05-12'], timezone: TIMEZONE },
    config: config(options),
    now: NOW,
  });
}

// The inputs the prompt block tells the model to pass for one calendar,
// with `overrides` applied; a key given as undefined is removed.
function listing(overrides = {}) {
  const input = { calendarId: OWNER, startTime: FROM.toISOString(), endTime: TO.toISOString(), eventType: ['DEFAULT'], pageSize: 250, timeZone: TIMEZONE, ...overrides };
  for (const [key, value] of Object.entries(input)) if (value === undefined) delete input[key];
  return input;
}

// A round record in the shape src/harness/stream.mjs builds, one tool use
// per call, in order: `error` makes its result an error, `more` gives its
// result a next page, `complete` is copied onto the result when given (a
// record from before the parser said has none), `unanswered` leaves it
// without any result, `name` replaces the list_events tool name.
function record(calls) {
  const toolUses = [];
  const toolResults = [];
  calls.forEach((call, index) => {
    const id = `toolu_cal_${index + 1}`;
    toolUses.push({ id, name: call.name ?? LIST, input: call.input });
    if (call.unanswered) return;
    const result = { toolUseId: id, isError: call.error === true, hasNextPage: call.more === true };
    if (call.complete !== undefined) result.complete = call.complete;
    toolResults.push(result);
  });
  return { toolUses, toolResults };
}

function evidence(calls, options) {
  return calendarSource.readEvidence(record(calls), collect(options));
}

const READ = Object.freeze({ read: 1, expected: 1, ok: true });
const UNREAD = Object.freeze({ read: 0, expected: 1, ok: false });

// ---------------------------------------------------------------- the interface

test('the calendar source implements the source interface as a best-effort connector source', () => {
  assert.deepEqual(validateSource(calendarSource), []);
  assert.equal(calendarSource.id, 'calendar');
  assert.equal(calendarSource.kind, 'connector');
  assert.equal(calendarSource.required, false);
  assert.equal(calendarSource.emptyMeansNothingListed, false);
  for (const member of ['isConfigured', 'serverSpec', 'toolRules', 'collect', 'readEvidence']) {
    assert.equal(typeof calendarSource[member], 'function', member);
  }
  assert.ok(Object.isFrozen(calendarSource));
});

test('validateSource checks the optional members when present, and a connector source must name its server and its tool rules', () => {
  const local = { id: 'notes', kind: 'local', required: true, collect() {}, readEvidence() {} };
  assert.deepEqual(validateSource(local), []);
  assert.deepEqual(validateSource(transcriptsSource), []);
  const wrong = validateSource({ ...local, emptyMeansNothingListed: 'no', isConfigured: true, serverSpec: {}, toolRules: [] });
  assert.equal(wrong.length, 4, wrong.join('\n'));
  for (const member of ['emptyMeansNothingListed', 'isConfigured', 'serverSpec', 'toolRules']) {
    assert.ok(wrong.some((e) => e.startsWith(`source.${member}`)), member);
  }
  const connector = validateSource({ ...local, id: 'agenda', kind: 'connector' });
  assert.equal(connector.length, 2, connector.join('\n'));
  assert.ok(connector.some((e) => e.startsWith('source.serverSpec')));
  assert.ok(connector.some((e) => e.startsWith('source.toolRules')));
});

// ---------------------------------------------------------------- isConfigured

test('isConfigured: a non-empty list of calendar ids, none blank and none a placeholder', () => {
  const is = (calendars) => calendarSource.isConfigured(config({ calendar: { calendars } }));
  assert.equal(is([]), false, 'the empty list of the defaults');
  assert.equal(is(['<owner-email>']), false, 'a placeholder');
  assert.equal(is([OWNER, '<teammate>']), false, 'a placeholder beside a real id');
  assert.equal(is(['']), false, 'an empty id');
  assert.equal(is(['  ']), false, 'a blank id');
  assert.equal(is([OWNER, '']), false, 'an empty id beside a real one');
  assert.equal(is([42]), false, 'not a string');
  assert.equal(is('ana@example.com'), false, 'not a list');
  assert.equal(is([OWNER]), true, 'a real id');
  assert.equal(is(['primary']), true, "the owner's main calendar");
  assert.equal(is([OWNER, 'team-calendar@example.com']), true);
  assert.equal(calendarSource.isConfigured({}), false, 'no sources section');
  assert.equal(calendarSource.isConfigured(undefined), false);
  const noCalendar = defaults();
  delete noCalendar.sources.calendar;
  assert.equal(calendarSource.isConfigured(noCalendar), false, 'no calendar section');
});

test('isConfigured looks at the owner calendars only: other people calendars never turn the source on', () => {
  assert.equal(calendarSource.isConfigured(config({ calendar: { calendars: [], team_calendars: [...TEAM], team_calendars_consent_noted: true } })), false);
});

// ---------------------------------------------------------------- collect

test('collect plans the configured calendars over the window, in the vault time zone', () => {
  const plan = collect({ calendar: { calendars: [OWNER, 'primary'] } });
  assert.equal(plan.configured, true);
  assert.deepEqual(plan.calendars, [OWNER, 'primary']);
  assert.deepEqual(plan.otherCalendars, []);
  assert.deepEqual(plan.window, { from: FROM.toISOString(), to: TO.toISOString(), timezone: TIMEZONE });
  assert.equal(plan.toolPrefix, PREFIX);
  assert.deepEqual(plan.problems, []);
  assert.equal(typeof plan.promptBlock, 'string');
});

test('collect lists a calendar named twice once', () => {
  const plan = collect({ calendar: { calendars: [OWNER, OWNER], team_calendars: [TEAM[0], TEAM[0], OWNER], team_calendars_consent_noted: true } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, [TEAM[0]]);
});

test('collect without recorded consent ignores other people calendars and says how many', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: false } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, []);
  assert.deepEqual(plan.problems, [{ code: 'other_calendars_without_consent', detail: '2' }]);
  assert.match(plan.promptBlock, /Calendars ignored in sources\.calendar\.team_calendars: 2\./);
  assert.match(plan.promptBlock, /team_calendars_consent_noted/);
  for (const id of TEAM) assert.ok(!plan.promptBlock.includes(id), `${id} must not reach the prompt`);
});

test('consent counts only as the boolean true: any other value is no consent', () => {
  for (const noted of ['true', 1, 'yes', null, undefined]) {
    const plan = collect({ calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: noted } });
    assert.deepEqual(plan.otherCalendars, [], String(noted));
    assert.deepEqual(plan.problems.map((p) => p.code), ['other_calendars_without_consent'], String(noted));
  }
});

test('collect with recorded consent plans other people calendars beside the owner ones', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: true } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, [...TEAM]);
  assert.deepEqual(plan.problems, []);
  for (const id of TEAM) assert.ok(plan.promptBlock.includes(JSON.stringify(listing({ calendarId: id }))), id);
});

test('a blank or placeholder entry of team_calendars names no calendar: never planned, never counted', () => {
  const team = ['<teammate-email>', '', '  ', TEAM[0]];
  assert.deepEqual(collect({ calendar: { team_calendars: team, team_calendars_consent_noted: true } }).otherCalendars, [TEAM[0]]);
  assert.deepEqual(collect({ calendar: { team_calendars: team } }).problems, [{ code: 'other_calendars_without_consent', detail: '1' }]);
});

test('no team calendar at all is no problem, with or without consent', () => {
  assert.deepEqual(collect({ calendar: { team_calendars: [] } }).problems, []);
  assert.deepEqual(collect({ calendar: { team_calendars: [], team_calendars_consent_noted: true } }).problems, []);
});

test('an unconfigured calendar source plans nothing, reads nothing and says so', () => {
  for (const calendars of [[], ['<owner-email>']]) {
    const plan = collect({ calendar: { calendars, team_calendars: [...TEAM], team_calendars_consent_noted: true } });
    assert.equal(plan.configured, false);
    assert.deepEqual(plan.calendars, []);
    assert.deepEqual(plan.otherCalendars, []);
    assert.deepEqual(plan.problems, [{ code: 'not_configured', detail: '' }]);
    assert.match(plan.promptBlock, /sources\.calendar\.calendars/);
    assert.ok(!plan.promptBlock.includes(LIST), plan.promptBlock);
    assert.deepEqual(calendarSource.readEvidence(record([{ input: listing() }]), plan), { read: 0, expected: 0, ok: false });
  }
});

// ---------------------------------------------------------------- the prompt block

test('the prompt block gives every calendar the exact inputs: the window instants, the private-event filter, the page size and the vault time zone', () => {
  for (const lang of ['en', 'pt-BR']) {
    const plan = collect({ lang, calendar: { calendars: [OWNER, 'primary'], team_calendars: [TEAM[0]], team_calendars_consent_noted: true } });
    const block = plan.promptBlock;
    for (const id of [OWNER, 'primary', TEAM[0]]) {
      const input = `{"calendarId":"${id}","startTime":"2026-05-12T03:00:00.000Z","endTime":"2026-05-13T03:00:00.000Z","eventType":["DEFAULT"],"pageSize":250,"timeZone":"${TIMEZONE}"}`;
      assert.ok(block.includes(input), `${lang}: ${input} missing from:\n${block}`);
    }
    assert.ok(block.includes(LIST), `${lang}: the tool's full name`);
    for (const word of ['nextPageToken', 'pageToken', 'primary', 'eventType', 'fileUrl']) assert.ok(block.includes(word), `${lang}: ${word}`);
    assert.ok(!block.includes(String.fromCharCode(0x2014)), `${lang}: no em dash`);
  }
});

test('the prompt block speaks the vault language and carries the privacy policy, the deduplication and the second door to meeting notes', () => {
  const en = collect({ lang: 'en' }).promptBlock;
  assert.match(en, /nextPageToken, call mcp__claude_ai_Google_Calendar__list_events again with the same inputs plus pageToken/);
  assert.match(en, /count it once, by its id/);
  assert.match(en, /In someone else's calendar, skip every event that already includes the owner/);
  assert.match(en, /only events with at least two attendees count/);
  assert.match(en, /Nothing about anyone's private life \(health, absence, family, personal errands\) is ever written, not even as a mention/);
  assert.match(en, /second door to meeting notes/);
  const pt = collect({ lang: 'pt-BR' }).promptBlock;
  assert.match(pt, /chame mcp__claude_ai_Google_Calendar__list_events de novo com as mesmas entradas e mais pageToken/);
  assert.match(pt, /conte uma vez só, pelo id/);
  assert.match(pt, /Na agenda de outra pessoa, pule todo evento que já inclui o dono/);
  assert.match(pt, /só contam eventos com pelo menos dois participantes/);
  assert.match(pt, /Nada da vida privada de ninguém \(saúde, ausência, família, compromissos pessoais\) é escrito, nem como menção/);
  assert.match(pt, /segunda porta para as notas de reunião/);
});

// ---------------------------------------------------------------- readEvidence

test('readEvidence: one listing of the whole window with the private-event filter reads the calendar', () => {
  assert.deepEqual(evidence([{ input: listing() }]), READ);
});

test('readEvidence: a listing that starts an hour late does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing({ startTime: new Date(FROM.getTime() + HOUR).toISOString() }) }]), UNREAD);
});

test('readEvidence: a listing that ends an hour early does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing({ endTime: new Date(TO.getTime() - HOUR).toISOString() }) }]), UNREAD);
});

test('readEvidence: a listing wider than the window reads it, its instants compared whatever offset they are written in', () => {
  assert.deepEqual(evidence([{ input: listing({ startTime: new Date(FROM.getTime() - HOUR).toISOString(), endTime: new Date(TO.getTime() + HOUR).toISOString() }) }]), READ);
  assert.deepEqual(evidence([{ input: listing({ startTime: '2026-05-12T00:00:00-03:00', endTime: '2026-05-13T00:00:00-03:00' }) }]), READ);
});

test('readEvidence: an instant written with no offset is no instant, and does not cover the window', () => {
  assert.deepEqual(evidence([{ input: listing({ startTime: '2026-05-12T00:00:00' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ endTime: '2026-05-14T00:00:00' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ startTime: 'yesterday' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ endTime: 1778641200000 }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ startTime: [FROM.toISOString()] }) }]), UNREAD, 'a list whose text is an instant is not one');
});

test('readEvidence never takes an instant it could not read for the epoch', () => {
  // A null compares as 0: a bound that could not be read must never let a
  // listing that starts before 1970 cover it, nor an unreadable end cover a
  // window that ends at the epoch.
  const plan = collect();
  const early = listing({ startTime: '1969-12-31T00:00:00.000Z' });
  assert.deepEqual(calendarSource.readEvidence(record([{ input: early }]), { ...plan, window: { ...plan.window, from: 'today' } }), UNREAD);
  const epoch = { ...plan, window: { from: '1969-12-31T00:00:00.000Z', to: '1970-01-01T00:00:00.000Z', timezone: TIMEZONE } };
  assert.deepEqual(calendarSource.readEvidence(record([{ input: listing({ startTime: '1969-12-31T00:00:00.000Z', endTime: 'later' }) }]), epoch), UNREAD);
  assert.deepEqual(calendarSource.readEvidence(record([{ input: listing({ startTime: '1969-12-31T00:00:00.000Z', endTime: '1970-01-01T00:00:00Z' }) }]), epoch), READ);
});

test('readEvidence: a listing with no eventType does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing({ eventType: undefined }) }]), UNREAD);
});

test('readEvidence: eventType must be exactly ["DEFAULT"]: another type added, or the filter as a bare string, does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing({ eventType: ['DEFAULT', 'OUT_OF_OFFICE'] }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ eventType: ['OUT_OF_OFFICE', 'DEFAULT'] }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ eventType: ['FOCUS_TIME'] }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ eventType: 'DEFAULT' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ eventType: [] }) }]), UNREAD);
});

test('readEvidence: a listing narrowed by a text search covers the window and still does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing({ fullText: 'stand-up' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2', fullText: 'stand-up' }) }]), UNREAD, 'a next page narrowed by one');
});

test('readEvidence: a listing of a different calendar does not read this one', () => {
  assert.deepEqual(evidence([{ input: listing({ calendarId: 'bruno@example.com' }) }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing({ calendarId: 'primary' }) }]), UNREAD, 'primary is not taken for the id as written');
  assert.deepEqual(evidence([{ input: listing({ calendarId: undefined }) }]), UNREAD, 'no calendarId is primary, not this id');
});

test('readEvidence: a listing whose result is an error, or that has no result at all, does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing(), error: true }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing(), unanswered: true }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing(), error: true }, { input: listing() }]), READ, 'a retry that succeeds reads it');
});

test('readEvidence: a result that came back incomplete is no read, like an errored one; one that does not say counts as complete', () => {
  // A truncated first page can look like a last page: its text did not
  // parse, so no next page token was seen in it.
  assert.deepEqual(evidence([{ input: listing(), complete: false }]), UNREAD);
  assert.deepEqual(evidence([{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2' }), complete: false }]), UNREAD, 'an incomplete next page');
  assert.deepEqual(evidence([{ input: listing(), complete: false }, { input: listing(), complete: true }]), READ, 'a retry that came back whole');
  assert.deepEqual(evidence([{ input: listing(), complete: true }]), READ);
  assert.deepEqual(evidence([{ input: listing() }]), READ, 'no complete field: a record from before the parser said');
});

test('readEvidence: only the calendar tool counts, by its exact name', () => {
  assert.deepEqual(evidence([{ name: 'mcp__claude_ai_Other_Calendar__list_events', input: listing() }]), UNREAD);
  assert.deepEqual(evidence([{ name: `${PREFIX}search_events`, input: listing() }]), UNREAD);
  assert.deepEqual(evidence([{ name: 'list_events', input: listing() }]), UNREAD);
});

test('readEvidence: the tool is named under the prefix the vault configured, and no other', () => {
  const options = { calendar: { tool_prefix: 'mcp__claude_ai_Work_Calendar__' } };
  assert.deepEqual(evidence([{ name: 'mcp__claude_ai_Work_Calendar__list_events', input: listing() }], options), READ);
  assert.deepEqual(evidence([{ input: listing() }], options), UNREAD);
});

test('readEvidence: the first page is asked for without a pageToken', () => {
  assert.deepEqual(evidence([{ input: listing({ pageToken: 'page-2' }) }]), UNREAD);
});

test('readEvidence: a next page left unread does not read the calendar', () => {
  assert.deepEqual(evidence([{ input: listing(), more: true }]), UNREAD);
});

test('readEvidence: a next page followed with the same inputs and its token reads the calendar', () => {
  assert.deepEqual(evidence([{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2' }) }]), READ);
});

test('readEvidence: every page is followed, not only the first', () => {
  const pages = [{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2' }), more: true }];
  assert.deepEqual(evidence(pages), UNREAD);
  assert.deepEqual(evidence([...pages, { input: listing({ pageToken: 'page-3' }) }]), READ);
});

test('readEvidence: a follow-up counts only with a token, the same calendar, the same instants and the private-event filter', () => {
  const first = { input: listing(), more: true };
  assert.deepEqual(evidence([first, { input: listing(), more: true }]), UNREAD, 'the first page asked again instead of the next one');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: '' }) }]), UNREAD, 'an empty pageToken');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 42 }) }]), UNREAD, 'a pageToken that is not a string');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', calendarId: 'bruno@example.com' }) }]), UNREAD, 'another calendar');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', startTime: new Date(FROM.getTime() + HOUR).toISOString() }) }]), UNREAD, 'another start');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', endTime: new Date(TO.getTime() + HOUR).toISOString() }) }]), UNREAD, 'another end');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', eventType: undefined }) }]), UNREAD, 'a page without the filter');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', eventType: ['DEFAULT', 'OUT_OF_OFFICE'] }) }]), UNREAD, 'a page with another type');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2' }), error: true }]), UNREAD, 'a page whose result is an error');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2' }), unanswered: true }]), UNREAD, 'a page with no result');
  assert.deepEqual(evidence([first, { input: listing({ pageToken: 'page-2', startTime: '2026-05-12T00:00:00-03:00' }) }]), READ, 'the same instant written another way');
});

test('readEvidence: a follow-up counts only after the page it follows', () => {
  assert.deepEqual(evidence([{ input: listing({ pageToken: 'page-2' }) }, { input: listing(), more: true }]), UNREAD);
});

test('readEvidence: a broken listing does not spoil a later complete one', () => {
  const calls = [
    { input: listing({ endTime: new Date(TO.getTime() - HOUR).toISOString() }) },
    { input: listing(), more: true },
    { input: listing() },
    { input: listing({ pageToken: 'page-2' }) },
  ];
  assert.deepEqual(evidence(calls), READ);
});

test('readEvidence: primary also matches a listing with no calendarId, first page and next pages alike', () => {
  const primary = { calendar: { calendars: ['primary'] } };
  assert.deepEqual(evidence([{ input: listing({ calendarId: undefined }) }], primary), READ);
  assert.deepEqual(evidence([{ input: listing({ calendarId: 'primary' }) }], primary), READ);
  assert.deepEqual(evidence([{ input: listing({ calendarId: undefined }), more: true }, { input: listing({ calendarId: 'primary', pageToken: 'page-2' }) }], primary), READ);
  assert.deepEqual(evidence([{ input: listing({ calendarId: OWNER }) }], primary), UNREAD, 'the id is not known to be primary');
  assert.deepEqual(evidence([{ input: listing({ calendarId: null }) }], primary), UNREAD, 'null is not an absent calendarId');
});

test('readEvidence: two calendars with one read is read 1 of 2, not ok', () => {
  const options = { calendar: { calendars: [OWNER, 'primary'] } };
  assert.deepEqual(evidence([{ input: listing() }], options), { read: 1, expected: 2, ok: false });
  assert.deepEqual(evidence([{ input: listing() }, { input: listing({ calendarId: 'primary' }) }], options), { read: 2, expected: 2, ok: true });
});

test('readEvidence: other people calendars planned with consent are expected too', () => {
  const options = { calendar: { team_calendars: [TEAM[0]], team_calendars_consent_noted: true } };
  assert.deepEqual(evidence([{ input: listing() }], options), { read: 1, expected: 2, ok: false });
  assert.deepEqual(evidence([{ input: listing() }, { input: listing({ calendarId: TEAM[0] }) }], options), { read: 2, expected: 2, ok: true });
  assert.deepEqual(evidence([{ input: listing({ calendarId: TEAM[0] }) }], { calendar: { team_calendars: [TEAM[0]] } }), UNREAD, 'without consent it is never planned');
});

test('readEvidence reads a record with no tool use as nothing read', () => {
  assert.deepEqual(calendarSource.readEvidence({ toolUses: [], toolResults: [] }, collect()), UNREAD);
  assert.deepEqual(calendarSource.readEvidence({}, collect()), UNREAD);
});

test('readEvidence passes over a call whose input is not an object', () => {
  assert.deepEqual(evidence([{ input: null }, { input: 'list everything' }, { input: listing() }]), READ);
});

test('readEvidence reads nothing against a plan whose window is not two instants', () => {
  const plan = collect();
  for (const window of [{ ...plan.window, to: 'tomorrow' }, { ...plan.window, from: 'today' }, {}]) {
    assert.deepEqual(calendarSource.readEvidence(record([{ input: listing() }]), { ...plan, window }), UNREAD, JSON.stringify(window));
  }
});

test('the anonymized capture of 24/09/2026 reads its calendar: two pages over the whole day with the private-event filter', () => {
  const lines = readFileSync(FIXTURE, 'utf8').split('\n');
  const plan = collect({ calendar: { calendars: ['primary'] } });
  assert.deepEqual(calendarSource.readEvidence(parseStream(lines), plan), READ);
  // Without the second page's call and result, the first page was not every page.
  const cut = lines.filter((line) => !line.includes('toolu_fake_connectors_3'));
  assert.equal(cut.length, lines.length - 2);
  assert.deepEqual(calendarSource.readEvidence(parseStream(cut), plan), UNREAD);
});

// ---------------------------------------------------------------- serverSpec and toolRules

test('serverSpec names the connector and the tools the source needs, from the configuration', () => {
  assert.deepEqual(calendarSource.serverSpec(config()), {
    id: 'calendar',
    serverDisplayName: 'claude.ai Google Calendar',
    toolPrefix: PREFIX,
    toolSuffixes: ['list_events', 'get_event', 'list_calendars'],
  });
  const custom = config({ calendar: { server_display_name: 'claude.ai Work Calendar', tool_prefix: 'mcp__claude_ai_Work_Calendar__', tool_suffixes: ['list_events'] } });
  assert.deepEqual(calendarSource.serverSpec(custom), {
    id: 'calendar', serverDisplayName: 'claude.ai Work Calendar', toolPrefix: 'mcp__claude_ai_Work_Calendar__', toolSuffixes: ['list_events'],
  });
});

test('serverSpec with no calendar section falls back to the packs defaults', () => {
  const spec = calendarSource.serverSpec({});
  const pack = defaults().sources.calendar;
  assert.deepEqual(spec, { id: 'calendar', serverDisplayName: pack.server_display_name, toolPrefix: pack.tool_prefix, toolSuffixes: pack.tool_suffixes });
});

test('with the default tools, the capture of 24/09/2026 finds the calendar connected', () => {
  const { init } = parseStream(readFileSync(FIXTURE, 'utf8'));
  assert.equal(connectorStates(init, [calendarSource.serverSpec(config())]).calendar.state, 'connected');
});

test('toolRules allows the configured read tools and denies every calendar write tool', () => {
  assert.deepEqual(calendarSource.toolRules(config()), {
    allow: [`${PREFIX}list_events`, `${PREFIX}get_event`, `${PREFIX}list_calendars`],
    deny: [`${PREFIX}create_event`, `${PREFIX}update_event`, `${PREFIX}delete_event`, `${PREFIX}respond_to_event`],
  });
  const custom = calendarSource.toolRules(config({ calendar: { tool_prefix: 'mcp__claude_ai_Work_Calendar__', tool_suffixes: ['list_events'] } }));
  assert.deepEqual(custom, {
    allow: ['mcp__claude_ai_Work_Calendar__list_events'],
    deny: ['mcp__claude_ai_Work_Calendar__create_event', 'mcp__claude_ai_Work_Calendar__update_event', 'mcp__claude_ai_Work_Calendar__delete_event', 'mcp__claude_ai_Work_Calendar__respond_to_event'],
  });
});

test('toolRules refuses a prefix or a tool name that would carry more than one permission rule', () => {
  for (const tool_prefix of ['Bash(*) mcp__x__', 'mcp__a__,Bash', 'mcp__a b__', 'mcp__x__(', 'mcp__claude_ai_Google_Calendar_', '']) {
    assert.throws(() => calendarSource.toolRules(config({ calendar: { tool_prefix } })), TypeError, tool_prefix);
  }
  for (const suffix of ['list_events Bash', 'list_events,Bash', 'list_events(*)', '']) {
    assert.throws(() => calendarSource.toolRules(config({ calendar: { tool_suffixes: ['list_events', suffix] } })), TypeError, suffix);
  }
});

// ---------------------------------------------------------------- defaults and schema

const CALENDAR_DEFAULTS = Object.freeze({
  provider: 'claude-connector-google-calendar',
  server_display_name: 'claude.ai Google Calendar',
  tool_prefix: PREFIX,
  tool_suffixes: ['list_events', 'get_event', 'list_calendars'],
  calendars: [],
  team_calendars: [],
  team_calendars_consent_noted: false,
  skip_events_with_owner: true,
  dedup_by: 'eventId',
  privacy: { exclude_event_types: ['OUT_OF_OFFICE', 'FOCUS_TIME'], exclude_keywords: [], team_personal_events: 'drop' },
  focus_blocks_as_ruler: true,
});

test('both packs default to no calendar (the source is opt in) and to the three read tools, the rest unchanged', () => {
  for (const [lang, keyword] of [['en', 'personal'], ['pt-BR', 'pessoal']]) {
    const pack = defaults(lang);
    assert.deepEqual(pack.sources.calendar, { ...CALENDAR_DEFAULTS, privacy: { ...CALENDAR_DEFAULTS.privacy, exclude_keywords: [keyword] } }, lang);
    assert.equal(calendarSource.isConfigured(pack), false, lang);
  }
});

test('a vault made by init has no calendar configured, even when the owner gave an e-mail', () => {
  for (const lang of ['en', 'pt-BR']) {
    const made = completeDefaults(defaults(lang), { lang, name: 'Ana', handle: 'ana', email: OWNER, title: 'Notes', timezone: TIMEZONE });
    assert.deepEqual(made.sources.calendar.calendars, [], lang);
    assert.equal(calendarSource.isConfigured(made), false, lang);
    assert.deepEqual(validateConfig(made), [], lang);
  }
});

test('the schema refuses a calendar tool the source must never reach, and a prefix that is not one MCP server prefix', () => {
  const base = completeDefaults(defaults('en'), { lang: 'en', name: 'Ana', handle: 'ana', title: 'Notes', timezone: TIMEZONE });
  const withCalendars = structuredClone(base);
  withCalendars.sources.calendar.calendars = [OWNER, 'primary'];
  withCalendars.sources.calendar.team_calendars = [...TEAM];
  withCalendars.sources.calendar.team_calendars_consent_noted = true;
  assert.deepEqual(validateConfig(withCalendars), []);
  for (const tool of ['create_event', 'update_event', 'delete_event', 'respond_to_event', 'list_events Bash']) {
    const bad = structuredClone(base);
    bad.sources.calendar.tool_suffixes = ['list_events', tool];
    assert.match(validateConfig(bad).join('\n'), /\$\.sources\.calendar\.tool_suffixes\[1\]: must be one of/, tool);
  }
  for (const prefix of ['Bash(*) mcp__x__', 'mcp__a__,Bash', 'mcp__a b__', 'mcp__claude_ai_Google_Calendar_', 'Read(//**)']) {
    const bad = structuredClone(base);
    bad.sources.calendar.tool_prefix = prefix;
    assert.match(validateConfig(bad).join('\n'), /\$\.sources\.calendar\.tool_prefix: does not match/, prefix);
  }
  const renamed = structuredClone(base);
  renamed.sources.calendar.tool_prefix = 'mcp__claude_ai_Work-Calendar__';
  assert.deepEqual(validateConfig(renamed), []);
});
