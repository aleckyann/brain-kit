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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const PREFIX = 'mcp__claude_ai_Google_Calendar__';
const LIST = `${PREFIX}list_events`;
const OWNER = 'ana@example.com';
const TEAM = Object.freeze(['bruno@example.com', 'carla@example.com']);
// Who authorised reading the team's calendars, and the day (phase 5a task
// 4): with it, the tests of consent below see consent as the only gate.
const AUTHORIZED = Object.freeze({ by: 'human:ana', at: '2026-05-04' });
const FIXTURE = fileURLToPath(new URL('./fixtures/stream/connectors-connected.jsonl', import.meta.url));

function defaults(lang = 'en') {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

// A vault configuration from a pack's defaults, with the calendar source
// turned on for the owner's calendar unless `calendar` says otherwise.
function config({ lang = 'en', calendar = {} } = {}) {
  const c = defaults(lang);
  c.vault.timezone = TIMEZONE;
  c.sources.calendar = { ...c.sources.calendar, enabled: true, calendars: [OWNER], ...calendar };
  return c;
}

// The same, completed the way init completes a pack, so the schema can
// judge it.
function validConfig(calendar = {}) {
  const c = completeDefaults(defaults('en'), { lang: 'en', name: 'Ana', handle: 'ana', title: 'Notes', timezone: TIMEZONE });
  c.sources.calendar = { ...c.sources.calendar, enabled: true, calendars: [OWNER], ...calendar };
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
    if (Object.hasOwn(call, 'items')) result.items = call.items;
    toolResults.push(result);
  });
  return { toolUses, toolResults };
}

// Every field of the evidence but `listed`, which the tests of ruling R-F1
// check on their own.
function readCore(round, plan) {
  const { listed, ...rest } = calendarSource.readEvidence(round, plan);
  return rest;
}

function evidence(calls, options) {
  return readCore(record(calls), collect(options));
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

test('isConfigured needs sources.calendar.enabled to be exactly true, besides the calendars', () => {
  for (const enabled of [false, undefined, 'true', 1, null]) {
    assert.equal(calendarSource.isConfigured(config({ calendar: { enabled } })), false, String(enabled));
  }
  assert.equal(calendarSource.isConfigured(config({ calendar: { enabled: true } })), true);
});

// ---------------------------------------------------------------- the source turns itself off (ruling R-E1)

test('a vault made before the calendar source asked for enabled stays off after the upgrade, and says why', () => {
  // test/fixtures/config/valid.json is shaped like a configuration the old
  // init wrote: the owner's e-mail in calendars, and no enabled key.
  const old = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  assert.equal(Object.hasOwn(old.sources.calendar, 'enabled'), false);
  assert.deepEqual(old.sources.calendar.calendars, [OWNER]);
  assert.deepEqual(validateConfig(old), [], 'the old configuration still validates');
  assert.equal(calendarSource.isConfigured(old), false);
  const plan = calendarSource.collect({ window: { from: FROM, to: TO, timezone: TIMEZONE }, config: old });
  assert.equal(plan.configured, false);
  assert.deepEqual(plan.calendars, []);
  assert.deepEqual(plan.problems, [{ code: 'not_enabled', detail: '1' }]);
  assert.match(plan.promptBlock, /sources\.calendar\.calendars lists 1 calendar\(s\), but the calendar source is off because sources\.calendar\.enabled is not true/);
  assert.deepEqual(readCore(record([{ input: listing() }]), plan), { read: 0, expected: 0, ok: false });
  assert.deepEqual(calendarSource.toolRules(old).allow, [], 'an off source asks for no tool');
  const same = config({ calendar: { enabled: undefined } });
  delete same.sources.calendar.enabled;
  assert.deepEqual(collect({ calendar: { enabled: undefined } }).problems, [{ code: 'not_enabled', detail: '1' }]);
  assert.equal(calendarSource.isConfigured(same), false);
});

test('a source left off with no calendar says only that it is off', () => {
  for (const lang of ['en', 'pt-BR']) {
    const plan = calendarSource.collect({ window: { from: FROM, to: TO, timezone: TIMEZONE }, config: defaults(lang) });
    assert.equal(plan.configured, false, lang);
    assert.deepEqual(plan.problems, [{ code: 'disabled', detail: '' }], lang);
  }
  assert.match(collect({ calendar: { enabled: false, calendars: [] } }).promptBlock, /^The calendar source is off \(sources\.calendar\.enabled is not true\)/);
  assert.match(collect({ lang: 'pt-BR', calendar: { enabled: false, calendars: [] } }).promptBlock, /^A fonte de agenda está desligada \(sources\.calendar\.enabled não é true\)/);
  assert.deepEqual(collect({ calendar: { enabled: false, calendars: [OWNER, 'primary', '<teammate>'] } }).problems, [{ code: 'not_enabled', detail: '2' }], 'only real ids are counted');
});

test('a tool prefix that is not one MCP server prefix turns only this source off, with a named problem', () => {
  for (const prefix of ['Bash(*) mcp__x__', 'mcp__a__,Bash', 'mcp__a b__', 'mcp__x__(', 'mcp__claude_ai_Google_Calendar_', '']) {
    const c = validConfig({ tool_prefix: prefix });
    assert.deepEqual(validateConfig(c), [], `the schema leaves ${JSON.stringify(prefix)} to the source`);
    assert.equal(calendarSource.isConfigured(c), false, prefix);
    const plan = collect({ calendar: { tool_prefix: prefix } });
    assert.equal(plan.configured, false, prefix);
    assert.deepEqual(plan.problems, [{ code: 'bad_tool_prefix', detail: prefix }], prefix);
    assert.ok(plan.promptBlock.includes(`sources.calendar.tool_prefix is ${JSON.stringify(prefix)}, which is not one MCP server's tool prefix`), plan.promptBlock);
    assert.deepEqual(calendarSource.toolRules(c), { allow: [], deny: [] }, `no rule ever carries ${JSON.stringify(prefix)}`);
  }
});

test('a tool outside the calendar read tools, or a list without list_events, turns only this source off, with a named problem', () => {
  const writes = validConfig({ tool_suffixes: ['list_events', 'create_event', 'list_events Bash'] });
  assert.deepEqual(validateConfig(writes), []);
  assert.equal(calendarSource.isConfigured(writes), false);
  const plan = collect({ calendar: { tool_suffixes: ['list_events', 'create_event', 'list_events Bash'] } });
  assert.deepEqual(plan.problems, [{ code: 'bad_tool_suffixes', detail: '"create_event", "list_events Bash"' }]);
  assert.match(plan.promptBlock, /sources\.calendar\.tool_suffixes names "create_event", "list_events Bash", outside the calendar's read tools/);
  assert.deepEqual(calendarSource.toolRules(writes), {
    allow: [],
    deny: [`${PREFIX}create_event`, `${PREFIX}update_event`, `${PREFIX}delete_event`, `${PREFIX}respond_to_event`],
  });
  const noList = collect({ calendar: { tool_suffixes: ['get_event', 'list_calendars'] } });
  assert.equal(noList.configured, false);
  assert.deepEqual(noList.problems, [{ code: 'missing_tools', detail: 'list_events' }]);
  assert.match(noList.promptBlock, /sources\.calendar\.tool_suffixes leaves out list_events/);
  assert.equal(calendarSource.isConfigured(config({ calendar: { tool_suffixes: ['list_events'] } })), true, 'list_events alone is enough');
});

test('every configuration problem is named at once, in the order a person fixes them, in both languages', () => {
  const calendar = { calendars: [], tool_prefix: 'mcp__a b__', tool_suffixes: ['get_event', 'delete_event'] };
  const plan = collect({ calendar });
  assert.deepEqual(plan.problems.map((p) => p.code), ['not_configured', 'bad_tool_prefix', 'bad_tool_suffixes', 'missing_tools']);
  assert.equal(plan.promptBlock.split('\n').length, 4);
  const pt = collect({ lang: 'pt-BR', calendar }).promptBlock;
  assert.match(pt, /sources\.calendar\.enabled é true, mas sources\.calendar\.calendars não nomeia agenda nenhuma/);
  assert.match(pt, /sources\.calendar\.tool_prefix é "mcp__a b__", que não é o prefixo de ferramentas de um servidor MCP/);
  assert.match(pt, /sources\.calendar\.tool_suffixes nomeia "delete_event", fora das ferramentas de leitura da agenda/);
  assert.match(pt, /sources\.calendar\.tool_suffixes deixa de fora list_events/);
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
  const plan = collect({ calendar: { calendars: [OWNER, OWNER], team_calendars: [TEAM[0], TEAM[0], OWNER], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, [TEAM[0]]);
});

test('collect without recorded consent ignores other people calendars and says how many', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: false } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, []);
  assert.deepEqual(plan.problems, [{ code: 'other_calendars_without_consent', detail: '2' }]);
  assert.match(plan.promptBlock, /Calendars ignored in sources\.calendar\.team_calendars: 2\./);
  assert.match(plan.promptBlock, /team_calendars_consent_noted/);
  for (const id of TEAM) assert.ok(!plan.promptBlock.includes(id), `${id} must not reach the prompt`);
});

test('consent counts only as the boolean true: any other value is no consent', () => {
  for (const noted of ['true', 1, 'yes', null, undefined]) {
    const plan = collect({ calendar: { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: noted } });
    assert.deepEqual(plan.otherCalendars, [], String(noted));
    assert.deepEqual(plan.problems.map((p) => p.code), ['other_calendars_without_consent'], String(noted));
  }
});

test('collect with recorded consent plans other people calendars beside the owner ones', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, [...TEAM]);
  assert.deepEqual(plan.problems, []);
  for (const id of TEAM) assert.ok(plan.promptBlock.includes(JSON.stringify(listing({ calendarId: id }))), id);
});

test('a blank or placeholder entry of team_calendars names no calendar: never planned, never counted', () => {
  const team = ['<teammate-email>', '', '  ', TEAM[0]];
  assert.deepEqual(collect({ calendar: { team_calendars: team, team_authorization: AUTHORIZED, team_calendars_consent_noted: true } }).otherCalendars, [TEAM[0]]);
  assert.deepEqual(collect({ calendar: { team_calendars: team, team_authorization: AUTHORIZED } }).problems, [{ code: 'other_calendars_without_consent', detail: '1' }]);
});

test('without consent the count is of distinct calendars that are not already the owner ones', () => {
  const plan = collect({ calendar: { team_calendars: [TEAM[0], TEAM[0], OWNER, TEAM[1], ` ${TEAM[1]} `], team_authorization: AUTHORIZED } });
  assert.deepEqual(plan.problems, [{ code: 'other_calendars_without_consent', detail: '2' }]);
});

test('calendar ids are planned trimmed, so the ids the model is given are the ids it is checked against', () => {
  const plan = collect({ calendar: { calendars: [` ${OWNER} `, OWNER], team_calendars: [` ${TEAM[0]}`], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
  assert.deepEqual(plan.calendars, [OWNER]);
  assert.deepEqual(plan.otherCalendars, [TEAM[0]]);
  assert.ok(plan.promptBlock.includes(JSON.stringify(listing())), plan.promptBlock);
  assert.deepEqual(readCore(record([{ input: listing() }, { input: listing({ calendarId: TEAM[0] }) }]), plan), { read: 2, expected: 2, ok: true });
});

// Phase 5a, task 4: who authorised reading the team's calendars, and the day.
test('without the recorded authorization the team calendars are left out and the block says so; the owner calendar is still planned and its listing alone reads the source', () => {
  for (const lang of ['en', 'pt-BR']) {
    const plan = collect({ lang, calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: true } });
    assert.equal(plan.configured, true, lang);
    assert.deepEqual(plan.calendars, [OWNER], lang);
    assert.deepEqual(plan.otherCalendars, [], lang);
    assert.equal(plan.teamAuthorization, null, lang);
    assert.deepEqual(plan.problems, [{ code: 'team_calendars_without_authorization', detail: '2' }], lang);
    assert.ok(plan.promptBlock.includes('sources.calendar.team_authorization'), `${lang}: the block names the key`);
    assert.ok(plan.promptBlock.includes(JSON.stringify(listing())), `${lang}: the owner's calendar is still listed`);
    for (const id of TEAM) assert.ok(!plan.promptBlock.includes(id), `${lang}: ${id} must not reach the prompt`);
    assert.doesNotMatch(plan.promptBlock, /authorised by|autorizadas por/, lang);
    // A team calendar left out is never one the round must read.
    assert.deepEqual(readCore(record([{ input: listing() }]), plan), READ, lang);
  }
  assert.match(collect({ calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: true } }).promptBlock, /^Calendars ignored in sources\.calendar\.team_calendars: 2\. Someone else's calendar is read only when sources\.calendar\.team_authorization records who authorised reading the team's calendars and on which day/);
  assert.match(collect({ lang: 'pt-BR', calendar: { team_calendars: [...TEAM], team_calendars_consent_noted: true } }).promptBlock, /^Agendas ignoradas em sources\.calendar\.team_calendars: 2\. A agenda de outra pessoa só é lida quando sources\.calendar\.team_authorization registra quem autorizou/);
});

test('an authorization that is not a person and a day that exists records nothing', () => {
  const odd = [
    null, true, 'human:ana', [AUTHORIZED], {},
    { by: 'human:ana' }, { at: '2026-05-04' },
    { by: 'ana', at: '2026-05-04' }, { by: 'human:Ana', at: '2026-05-04' }, { by: 'process:ana', at: '2026-05-04' }, { by: 'human:', at: '2026-05-04' }, { by: 42, at: '2026-05-04' },
    { by: 'human:ana', at: '04/05/2026' }, { by: 'human:ana', at: '2026-5-4' }, { by: 'human:ana', at: '2026-02-31' }, { by: 'human:ana', at: '2026-13-01' }, { by: 'human:ana', at: '2026-05-04T10:00:00Z' }, { by: 'human:ana', at: 20260504 },
  ];
  for (const team_authorization of odd) {
    const plan = collect({ calendar: { team_calendars: [TEAM[0]], team_calendars_consent_noted: true, team_authorization } });
    assert.deepEqual(plan.otherCalendars, [], JSON.stringify(team_authorization));
    assert.deepEqual(plan.problems, [{ code: 'team_calendars_without_authorization', detail: '1' }], JSON.stringify(team_authorization));
  }
  assert.deepEqual(collect({ calendar: { team_calendars: [TEAM[0]], team_calendars_consent_noted: true, team_authorization: { by: 'human:ana-2', at: '2024-02-29' } } }).otherCalendars, [TEAM[0]], 'a leap day exists');
});

test('with the authorization and the consent recorded, the team calendars are planned and the block prints who authorised them and the day, DD/MM/YYYY', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
  assert.deepEqual(plan.otherCalendars, [...TEAM]);
  assert.deepEqual(plan.teamAuthorization, { by: 'human:ana', at: '2026-05-04' });
  assert.deepEqual(plan.problems, []);
  const lines = plan.promptBlock.split('\n');
  assert.deepEqual(lines.filter((line) => line.includes('authorised')), ['Team calendars authorised by human:ana on 04/05/2026.']);
  assert.ok(lines.indexOf('Team calendars authorised by human:ana on 04/05/2026.') > lines.findIndex((line) => line.includes(TEAM[1])), 'after the calendars it covers');
  const pt = collect({ lang: 'pt-BR', calendar: { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } }).promptBlock;
  assert.ok(pt.split('\n').includes('Agendas da equipe autorizadas por human:ana em 04/05/2026.'), pt);
  assert.deepEqual(readCore(record([{ input: listing() }]), plan), { read: 1, expected: 3, ok: false }, 'planned, they must be read');
});

test('the authorization is printed only beside team calendars that are read: none listed, none left after the owner ones, or no consent', () => {
  for (const calendar of [
    { team_calendars: [], team_authorization: AUTHORIZED, team_calendars_consent_noted: true },
    { team_calendars: [OWNER, '<teammate>'], team_authorization: AUTHORIZED, team_calendars_consent_noted: true },
    { team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: false },
  ]) {
    const plan = collect({ calendar });
    assert.equal(plan.teamAuthorization, null, JSON.stringify(calendar));
    assert.doesNotMatch(plan.promptBlock, /authorised by/, JSON.stringify(calendar));
  }
  const off = collect({ calendar: { calendars: [], team_calendars: [...TEAM], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
  assert.equal(off.teamAuthorization, null, 'a source that is off prints nothing about the team');
  assert.deepEqual(off.problems, [{ code: 'not_configured', detail: '' }]);
});

test('with neither record, both are named, the authorization first, and nothing but the owner calendar is planned', () => {
  const plan = collect({ calendar: { team_calendars: [...TEAM] } });
  assert.deepEqual(plan.problems, [{ code: 'team_calendars_without_authorization', detail: '2' }, { code: 'other_calendars_without_consent', detail: '2' }]);
  assert.deepEqual(plan.otherCalendars, []);
  const lines = plan.promptBlock.split('\n');
  assert.match(lines[0], /sources\.calendar\.team_authorization/);
  assert.match(lines[1], /sources\.calendar\.team_calendars_consent_noted/);
});

test('no team calendar at all is no problem, with or without consent', () => {
  assert.deepEqual(collect({ calendar: { team_calendars: [] } }).problems, []);
  assert.deepEqual(collect({ calendar: { team_calendars: [], team_calendars_consent_noted: true } }).problems, []);
});

test('an unconfigured calendar source plans nothing, reads nothing and says so', () => {
  for (const calendars of [[], ['<owner-email>']]) {
    for (const consent of [true, false]) {
      const plan = collect({ calendar: { calendars, team_calendars: [...TEAM], team_calendars_consent_noted: consent } });
      assert.equal(plan.configured, false);
      assert.deepEqual(plan.calendars, []);
      assert.deepEqual(plan.otherCalendars, []);
      assert.deepEqual(plan.problems, [{ code: 'not_configured', detail: '' }], 'only why it is off, never the consent of a source that reads nothing');
      assert.match(plan.promptBlock, /sources\.calendar\.calendars/);
      assert.ok(!plan.promptBlock.includes(LIST), plan.promptBlock);
      assert.deepEqual(readCore(record([{ input: listing() }]), plan), { read: 0, expected: 0, ok: false });
    }
  }
});

// ---------------------------------------------------------------- the prompt block

test('the prompt block gives every calendar the exact inputs: the window instants, the private-event filter, the page size and the vault time zone', () => {
  for (const lang of ['en', 'pt-BR']) {
    const plan = collect({ lang, calendar: { calendars: [OWNER, 'primary'], team_calendars: [TEAM[0]], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } });
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
  assert.match(en, /passing exactly the inputs on its line and no other/);
  assert.match(en, /If a page fails or comes back cut, ask for it again with the same pageToken, lowering pageSize if that helps \(pageSize is the only input you may change\)/);
  const pt = collect({ lang: 'pt-BR' }).promptBlock;
  assert.match(pt, /passando exatamente as entradas da linha dela e nenhuma outra/);
  assert.match(pt, /Se uma página falhar ou vier cortada, peça-a de novo com o mesmo pageToken, baixando o pageSize se ajudar \(pageSize é a única entrada que você pode mudar\)/);
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

test('readEvidence: the first page covers the window with no slack at all', () => {
  for (const ms of [MINUTE, 1]) {
    assert.deepEqual(evidence([{ input: listing({ startTime: new Date(FROM.getTime() + ms).toISOString() }) }]), UNREAD, `starts ${ms} ms late`);
    assert.deepEqual(evidence([{ input: listing({ endTime: new Date(TO.getTime() - ms).toISOString() }) }]), UNREAD, `ends ${ms} ms early`);
  }
});

test('readEvidence: a next page carries exactly the first page instants, not a minute more or less on either bound', () => {
  const first = { input: listing(), more: true };
  const bounds = [
    ['startTime', FROM, -MINUTE, 'starts a minute earlier'],
    ['startTime', FROM, MINUTE, 'starts a minute later'],
    ['endTime', TO, -MINUTE, 'ends a minute earlier'],
    ['endTime', TO, MINUTE, 'ends a minute later'],
    ['startTime', FROM, -1, 'starts 1 ms earlier'],
    ['endTime', TO, -1, 'ends 1 ms earlier'],
  ];
  for (const [key, instant, shift, label] of bounds) {
    const next = listing({ pageToken: 'page-2', [key]: new Date(instant.getTime() + shift).toISOString() });
    assert.deepEqual(evidence([first, { input: next }]), UNREAD, label);
  }
  // The first page itself asked wider than the window: its next pages carry
  // its instants, not the window's.
  const wide = listing({ startTime: new Date(FROM.getTime() - HOUR).toISOString(), endTime: new Date(TO.getTime() + HOUR).toISOString() });
  assert.deepEqual(evidence([{ input: wide, more: true }, { input: { ...wide, pageToken: 'page-2' } }]), READ);
  assert.deepEqual(evidence([{ input: wide, more: true }, { input: listing({ pageToken: 'page-2' }) }]), UNREAD, 'the window instead of the first page instants');
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
  assert.deepEqual(readCore(record([{ input: early }]), { ...plan, window: { ...plan.window, from: 'today' } }), UNREAD);
  const epoch = { ...plan, window: { from: '1969-12-31T00:00:00.000Z', to: '1970-01-01T00:00:00.000Z', timezone: TIMEZONE } };
  assert.deepEqual(readCore(record([{ input: listing({ startTime: '1969-12-31T00:00:00.000Z', endTime: 'later' }) }]), epoch), UNREAD);
  assert.deepEqual(readCore(record([{ input: listing({ startTime: '1969-12-31T00:00:00.000Z', endTime: '1970-01-01T00:00:00Z' }) }]), epoch), READ);
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

test('readEvidence: only the inputs the prompt names count; any other input, on any page, makes the call not count', () => {
  // fullText narrows by text; eventTypeFilter (served beside eventType on
  // 25/09/2026) widens or narrows the event types; orderBy changes what a
  // page token means; an input nobody knows yet might filter too.
  const extras = [
    { fullText: 'stand-up' },
    { eventTypeFilter: ['OUT_OF_OFFICE', 'FOCUS_TIME'] },
    { eventTypeFilter: ['BIRTHDAY'] },
    { orderBy: 'startTime' },
    { q: 'review' },
    { showDeleted: true },
  ];
  for (const extra of extras) {
    const label = JSON.stringify(extra);
    assert.deepEqual(evidence([{ input: listing(extra) }]), UNREAD, `first page with ${label}`);
    assert.deepEqual(evidence([{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2', ...extra }) }]), UNREAD, `next page with ${label}`);
  }
  // Every input the prompt names, and nothing else, reads it; pageSize and
  // timeZone may be left out.
  assert.deepEqual(evidence([{ input: listing() }]), READ);
  assert.deepEqual(evidence([{ input: listing({ pageSize: undefined, timeZone: undefined }) }]), READ);
  assert.deepEqual(evidence([{ input: listing(), more: true }, { input: listing({ pageToken: 'page-2', pageSize: 50 }) }]), READ, 'a lower pageSize on a next page');
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

test('readEvidence: the next page is the first later call with a token; a page that failed, came back cut or was never answered is never stepped over', () => {
  // The review's sequence: page 2 comes back cut, and the model still asks
  // page 3 with the token it saw in what it got.
  const one = { input: listing(), more: true };
  const two = listing({ pageToken: 'token-1' });
  const three = { input: listing({ pageToken: 'token-2' }) };
  assert.deepEqual(evidence([one, { input: two, complete: false }, three]), UNREAD, 'page 2 cut');
  assert.deepEqual(evidence([one, { input: two, error: true }, three]), UNREAD, 'page 2 errored');
  assert.deepEqual(evidence([one, { input: two, unanswered: true }, three]), UNREAD, 'page 2 unanswered');
  // A wrong next page is not stepped over either, even when a right one follows.
  assert.deepEqual(evidence([one, { input: listing({ pageToken: 'token-1', endTime: new Date(TO.getTime() - HOUR).toISOString() }) }, { input: two }]), UNREAD, 'a narrower next page first');
  assert.deepEqual(evidence([one, { input: listing({ pageToken: 'token-1', orderBy: 'startTime' }) }, { input: two }]), UNREAD, 'a next page with another input first');
  // Calls without a token, and calls for other calendars, are not next pages.
  const late = listing({ startTime: new Date(FROM.getTime() + HOUR).toISOString() });
  assert.deepEqual(evidence([one, { input: listing({ calendarId: 'bruno@example.com', pageToken: 'other' }) }, { input: late }, { input: two }]), READ);
});

test('readEvidence: only a retry with the same pageToken takes the place of a page that failed, came back cut or was never answered', () => {
  const one = { input: listing(), more: true };
  const two = listing({ pageToken: 'token-1' });
  assert.deepEqual(evidence([one, { input: two, complete: false }, { input: two }]), READ, 'retried after a cut');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: two, unanswered: true }, { input: two, complete: false }, { input: two }]), READ, 'retried until whole');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: { ...two, pageSize: 50 } }]), READ, 'retried with a lower pageSize');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: two, more: true }, { input: listing({ pageToken: 'token-2' }) }]), READ, 'retried, then the listing goes on');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: listing({ pageToken: 'token-2' }) }]), UNREAD, 'another token instead of the retry');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: { ...two, endTime: new Date(TO.getTime() - HOUR).toISOString() } }]), UNREAD, 'a retry with other instants');
  assert.deepEqual(evidence([one, { input: two, error: true }]), UNREAD, 'never retried');
  assert.deepEqual(evidence([one, { input: two, error: true }, { input: two, complete: false }]), UNREAD, 'retried, and the retry came back cut too');
  assert.deepEqual(evidence([one, { input: two, complete: false }, { input: two, unanswered: true }]), UNREAD, 'retried, and the retry was never answered');
  // Starting the listing over from its first page is a new listing, and it
  // reads the calendar when it completes.
  assert.deepEqual(evidence([one, { input: two, complete: false }, { input: listing(), more: true }, { input: two }]), READ);
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
  const options = { calendar: { team_calendars: [TEAM[0]], team_authorization: AUTHORIZED, team_calendars_consent_noted: true } };
  assert.deepEqual(evidence([{ input: listing() }], options), { read: 1, expected: 2, ok: false });
  assert.deepEqual(evidence([{ input: listing() }, { input: listing({ calendarId: TEAM[0] }) }], options), { read: 2, expected: 2, ok: true });
  assert.deepEqual(evidence([{ input: listing({ calendarId: TEAM[0] }) }], { calendar: { team_calendars: [TEAM[0]] } }), UNREAD, 'without consent it is never planned');
});

test('readEvidence reads a record with no tool use as nothing read', () => {
  assert.deepEqual(readCore({ toolUses: [], toolResults: [] }, collect()), UNREAD);
  assert.deepEqual(readCore({}, collect()), UNREAD);
});

test('readEvidence passes over a call whose input is not an object', () => {
  assert.deepEqual(evidence([{ input: null }, { input: 'list everything' }, { input: listing() }]), READ);
});

test('readEvidence reads nothing against a plan whose window is not two instants', () => {
  const plan = collect();
  for (const window of [{ ...plan.window, to: 'tomorrow' }, { ...plan.window, from: 'today' }, {}]) {
    assert.deepEqual(readCore(record([{ input: listing() }]), { ...plan, window }), UNREAD, JSON.stringify(window));
  }
});

test('the anonymized capture of 24/09/2026 reads its calendar: two pages over the whole day with the private-event filter', () => {
  const lines = readFileSync(FIXTURE, 'utf8').split('\n');
  const plan = collect({ calendar: { calendars: ['primary'] } });
  assert.deepEqual(readCore(parseStream(lines), plan), READ);
  // Without the second page's call and result, the first page was not every page.
  const cut = lines.filter((line) => !line.includes('toolu_fake_connectors_3'));
  assert.equal(cut.length, lines.length - 2);
  assert.deepEqual(readCore(parseStream(cut), plan), UNREAD);
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

test('toolRules never emits a rule that would carry a second one, and an off source asks for no tool', () => {
  for (const tool_prefix of ['Bash(*) mcp__x__', 'mcp__a__,Bash', 'mcp__a b__', 'mcp__x__(', 'mcp__claude_ai_Google_Calendar_', '']) {
    assert.deepEqual(calendarSource.toolRules(config({ calendar: { tool_prefix } })), { allow: [], deny: [] }, tool_prefix);
  }
  const deny = [`${PREFIX}create_event`, `${PREFIX}update_event`, `${PREFIX}delete_event`, `${PREFIX}respond_to_event`];
  for (const suffix of ['list_events Bash', 'list_events,Bash', 'list_events(*)', '', 'search_events', 'create_event']) {
    assert.deepEqual(calendarSource.toolRules(config({ calendar: { tool_suffixes: ['list_events', suffix] } })), { allow: [], deny }, suffix);
  }
  for (const calendar of [{ enabled: false }, { calendars: [] }, { tool_suffixes: ['get_event'] }]) {
    assert.deepEqual(calendarSource.toolRules(config({ calendar })), { allow: [], deny }, JSON.stringify(calendar));
  }
});

// ---------------------------------------------------------------- defaults and schema

const CALENDAR_DEFAULTS = Object.freeze({
  enabled: false,
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

test('both packs default to the source off, no calendar and the three read tools, the rest unchanged', () => {
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

test('the schema holds enabled to a boolean and leaves the tool prefix and tools to the source, so a best-effort source never stops the vault (ruling R-E1)', () => {
  const base = completeDefaults(defaults('en'), { lang: 'en', name: 'Ana', handle: 'ana', title: 'Notes', timezone: TIMEZONE });
  const on = structuredClone(base);
  on.sources.calendar.enabled = true;
  on.sources.calendar.calendars = [OWNER, 'primary'];
  on.sources.calendar.team_calendars = [...TEAM];
  on.sources.calendar.team_calendars_consent_noted = true;
  assert.deepEqual(validateConfig(on), []);
  assert.equal(calendarSource.isConfigured(on), true);
  for (const enabled of ['true', 1, null]) {
    const bad = structuredClone(on);
    bad.sources.calendar.enabled = enabled;
    assert.match(validateConfig(bad).join('\n'), /\$\.sources\.calendar\.enabled: expected boolean/, String(enabled));
  }
  const odd = structuredClone(on);
  odd.sources.calendar.tool_prefix = 'Bash(*) mcp__x__';
  odd.sources.calendar.tool_suffixes = ['list_events', 'create_event'];
  assert.deepEqual(validateConfig(odd), [], 'refused by the source, never by the schema');
  assert.equal(calendarSource.isConfigured(odd), false);
});

// ---------------------------------------------------------------- listed (ruling R-F1)

test('readEvidence: listed sums the events on the pages of the listing that read each calendar, and no other call', () => {
  const listed = (calls, options) => calendarSource.readEvidence(record(calls), collect(options)).listed;
  assert.equal(listed([{ input: listing(), items: 0 }]), 0);
  assert.equal(listed([{ input: listing(), items: 3 }]), 3);
  assert.equal(listed([{ input: listing(), more: true, items: 2 }, { input: listing({ pageToken: 'page-2' }), items: 1 }]), 3, 'every page of the listing');
  assert.equal(listed([{ input: listing(), more: true, items: 0 }, { input: listing({ pageToken: 'page-2' }), error: true, items: 5 }, { input: listing({ pageToken: 'page-2' }), items: 0 }]), 0, 'a failed page taken over by its retry');
  assert.equal(listed([{ input: listing({ startTime: undefined }), items: 4 }, { input: listing(), items: 0 }]), 0, 'a listing that did not read the calendar does not count');
  // Every listing of the window counts, not only the one that proves the read (scoped re-review).
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing(), items: 6 }]), 6, 'a later listing that found events');
  assert.equal(listed([{ input: listing(), items: 2 }, { input: listing(), more: true, items: 0 }, { input: listing({ pageToken: 'page-2' }), items: 0 }]), 2, 'an earlier one too');
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing(), more: true, items: 0 }, { input: listing({ pageToken: 'page-2' }), items: 3 }]), 3, 'the next page of a second listing');
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing({ calendarId: 'someone@example.com' }), items: 5 }]), 0, 'a calendar the plan does not list');
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing(), error: true, items: 4 }]), 0, 'a failed call listed nothing the model can count');
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing() }]), null, 'a second listing with no count');
  const wider = { startTime: new Date(FROM.getTime() - 3600000).toISOString() };
  assert.equal(listed([{ input: listing(), items: 0 }, { input: listing(wider), error: true, more: true }, { input: listing({ ...wider, pageToken: 'page-2' }), items: 2 }]), 2, 'the next page of a listing whose first page failed');
  assert.equal(listed([{ input: listing(), items: 1 }, { input: listing({ calendarId: 'primary' }), items: 2 }], { calendar: { calendars: [OWNER, 'primary'] } }), 3, 'every calendar');
  assert.equal(listed([{ input: listing() }]), null, 'a page with no count');
  assert.equal(listed([{ input: listing(), more: true, items: 0 }, { input: listing({ pageToken: 'page-2' }), items: null }]), null, 'one page with no count');
  assert.equal(listed([{ input: listing({ startTime: undefined }), items: 0 }]), null, 'nothing read');
  const twice = record([{ input: listing(), items: 0 }]);
  twice.toolResults.push({ ...twice.toolResults[0], items: 0 });
  assert.equal(calendarSource.readEvidence(twice, collect()).listed, null, 'two results for one call');
});
