// The claude.ai connectors a round reads in connector mode (phase 3): the
// state of each one, read from the round's own init event (decision D2),
// the next-page flag the stream reader puts on every tool result (ruling
// R-B3), and the two connector fixtures, derived from the controller's
// capture of 24/09/2026 (Claude Code 2.1.281) and anonymized. Nothing here
// runs a claude of any kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTOR_STATES, connectorStateMessage, connectorStates } from '../src/guards/connectors.mjs';
import { parseStream } from '../src/harness/stream.mjs';
import { createTranslator, REFERENCE_LANG } from '../src/lang.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/stream/', import.meta.url));
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8');
const events = (name) => fixture(name).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const initOf = (list) => list.find((e) => e.type === 'system' && e.subtype === 'init');

// The two connector sources' specs, as tasks 3 and 4 will declare them.
const CALENDAR = Object.freeze({
  id: 'calendar', serverDisplayName: 'claude.ai Google Calendar', toolPrefix: 'mcp__claude_ai_Google_Calendar__', toolSuffixes: ['list_events', 'get_event'],
});
const MEETING_NOTES = Object.freeze({
  id: 'meeting_notes', serverDisplayName: 'claude.ai Google Drive', toolPrefix: 'mcp__claude_ai_Google_Drive__', toolSuffixes: ['search_files', 'read_file_content'],
});
const SPECS = [CALENDAR, MEETING_NOTES];

const connected = (spec) => ({ state: 'connected', rawStatus: 'connected', observedPrefix: spec.toolPrefix });

// The init event of the connector-mode run in connectors-states.jsonl,
// edited.
function statesInit(edit = () => {}) {
  const init = initOf(events('connectors-states'));
  edit(init);
  return init;
}
const serverOf = (init, spec) => init.mcp_servers.find((s) => s.name === spec.serverDisplayName);

// --- connectorStates ---------------------------------------------------------

test('CONNECTOR_STATES are the seven states of decision D2, frozen, in order', () => {
  assert.deepEqual([...CONNECTOR_STATES], ['connected', 'needs_auth', 'failed', 'pending', 'absent', 'tools_missing', 'unknown']);
  assert.ok(Object.isFrozen(CONNECTOR_STATES));
});

test('connectorStates reads both Google connectors as connected, with their tools and prefix, from each connector run', () => {
  for (const name of ['connectors-connected', 'connectors-states']) {
    assert.deepEqual(connectorStates(initOf(events(name)), SPECS), { calendar: connected(CALENDAR), meeting_notes: connected(MEETING_NOTES) }, name);
  }
  assert.deepEqual(connectorStates(statesInit(), []), {});
});

test('connectorStates gives each of the seven states from a rewritten init event, and leaves the other connector alone', () => {
  const cases = [
    ['connected', () => {}, connected(CALENDAR)],
    ['needs_auth', (init) => { serverOf(init, CALENDAR).status = 'needs-auth'; }, { state: 'needs_auth', rawStatus: 'needs-auth', observedPrefix: null }],
    ['failed', (init) => { serverOf(init, CALENDAR).status = 'failed'; }, { state: 'failed', rawStatus: 'failed', observedPrefix: null }],
    ['pending', (init) => { serverOf(init, CALENDAR).status = 'pending'; }, { state: 'pending', rawStatus: 'pending', observedPrefix: null }],
    ['absent', (init) => { init.mcp_servers = init.mcp_servers.filter((s) => s.name !== CALENDAR.serverDisplayName); }, { state: 'absent', rawStatus: null, observedPrefix: null }],
    ['tools_missing', (init) => { init.tools = init.tools.filter((n) => !n.startsWith(CALENDAR.toolPrefix)); }, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null }],
    ['unknown', (init) => { serverOf(init, CALENDAR).status = 'disabled'; }, { state: 'unknown', rawStatus: 'disabled', observedPrefix: null }],
  ];
  assert.deepEqual(cases.map(([state]) => state), [...CONNECTOR_STATES]);
  for (const [state, edit, expected] of cases) {
    assert.deepEqual(connectorStates(statesInit(edit), SPECS), { calendar: expected, meeting_notes: connected(MEETING_NOTES) }, state);
  }
});

test('connectorStates reads the statuses the fixture\'s neutral servers carry as the CLI printed them, and a server needs its exact display name', () => {
  const neutral = (name, suffix) => ({ id: name, serverDisplayName: name, toolPrefix: `mcp__${name.replace(/[^A-Za-z0-9]+/g, '_')}__`, toolSuffixes: [suffix] });
  const specs = [
    { ...neutral('plugin:example:tasks', 'list_items'), toolPrefix: 'mcp__plugin_example_tasks__' },
    neutral('plugin:example:mail', 'send'),
    neutral('plugin:example:wiki', 'read_page'),
    neutral('claude.ai Example Tickets', 'list_tickets'),
    neutral('claude.ai google calendar', 'list_events'),
    neutral('claude.ai Google Calendar ', 'list_events'),
    neutral('Google Calendar', 'list_events'),
  ];
  assert.deepEqual(connectorStates(statesInit(), specs), {
    'plugin:example:tasks': { state: 'connected', rawStatus: 'connected', observedPrefix: 'mcp__plugin_example_tasks__' },
    'plugin:example:mail': { state: 'needs_auth', rawStatus: 'needs-auth', observedPrefix: null },
    'plugin:example:wiki': { state: 'failed', rawStatus: 'failed', observedPrefix: null },
    'claude.ai Example Tickets': { state: 'pending', rawStatus: 'pending', observedPrefix: null },
    'claude.ai google calendar': { state: 'absent', rawStatus: null, observedPrefix: null },
    'claude.ai Google Calendar ': { state: 'absent', rawStatus: null, observedPrefix: null },
    'Google Calendar': { state: 'absent', rawStatus: null, observedPrefix: null },
  });
});

test('connectorStates says tools_missing when only some of a source\'s tools are in the session, or it names none, and a prefix only when one carries every tool (review M5)', () => {
  // A deny rule removes a tool from the session (measured on 24/09/2026): no prefix carries both tools.
  const init = statesInit((i) => { i.tools = i.tools.filter((n) => n !== 'mcp__claude_ai_Google_Calendar__list_events'); });
  assert.deepEqual(connectorStates(init, SPECS).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null });
  // A tool of the same server under another suffix proves nothing.
  const other = statesInit((i) => { i.tools = i.tools.filter((n) => !CALENDAR.toolSuffixes.some((s) => n === CALENDAR.toolPrefix + s)); });
  assert.ok(other.tools.includes('mcp__claude_ai_Google_Calendar__list_calendars'));
  assert.deepEqual(connectorStates(other, SPECS).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null });
  // One tool of the same name on an unrelated server names no prefix; every tool under one other prefix names it.
  const unrelated = statesInit((i) => { i.tools = [...other.tools, 'mcp__plugin_example_tasks__get_event']; });
  assert.deepEqual(connectorStates(unrelated, SPECS).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null });
  const moved = statesInit((i) => { i.tools = [...other.tools, 'mcp__plugin_example_tasks__get_event', 'mcp__plugin_example_tasks__list_events']; });
  assert.deepEqual(connectorStates(moved, SPECS).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: 'mcp__plugin_example_tasks__' });
  // A source that names no tool proves nothing either: never connected.
  const none = { ...CALENDAR, toolSuffixes: [] };
  assert.deepEqual(connectorStates(statesInit(), [none]).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null });
});

test('connectorStates fails closed on what it cannot read: no init, no server list, no tool list, and a status that is not a string or names an object property', () => {
  const absent = { state: 'absent', rawStatus: null, observedPrefix: null };
  for (const init of [null, undefined, {}, { mcp_servers: 'claude.ai Google Calendar' }, { mcp_servers: [null, 7, 'x'] }]) {
    assert.deepEqual(connectorStates(init, [CALENDAR]), { calendar: absent }, JSON.stringify(init));
  }
  for (const status of [undefined, null, 42, ['connected'], { connected: true }]) {
    const init = statesInit((i) => { serverOf(i, CALENDAR).status = status; });
    assert.deepEqual(connectorStates(init, [CALENDAR]).calendar, { state: 'unknown', rawStatus: null, observedPrefix: null }, JSON.stringify(status));
  }
  for (const status of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Connected', 'needs_auth', 'connected ']) {
    const init = statesInit((i) => { serverOf(i, CALENDAR).status = status; });
    assert.deepEqual(connectorStates(init, [CALENDAR]).calendar, { state: 'unknown', rawStatus: status, observedPrefix: null }, status);
  }
  for (const tools of [undefined, null, 'mcp__claude_ai_Google_Calendar__list_events', {}]) {
    const init = statesInit((i) => { i.tools = tools; });
    assert.deepEqual(connectorStates(init, [CALENDAR]).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null }, JSON.stringify(tools));
  }
  // A tool name that is not a string is skipped, never a crash.
  const odd = statesInit((i) => { i.tools = [42, null, { name: 'x' }, ...i.tools]; });
  assert.deepEqual(connectorStates(odd, [CALENDAR]).calendar, connected(CALENDAR));
  const oddMoved = statesInit((i) => { i.tools = [42, null, 'mcp__Google_Calendar__list_events', 'mcp__Google_Calendar__get_event']; });
  assert.deepEqual(connectorStates(oddMoved, [CALENDAR]).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: 'mcp__Google_Calendar__' });
  // A name with no server before its `__` is no prefix at all.
  const oddMissing = statesInit((i) => { i.tools = [42, null, '__list_events', '__get_event', 'mcp__Google_Calendar__list_events']; });
  assert.deepEqual(connectorStates(oddMissing, [CALENDAR]).calendar, { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null });
});

// --- messages ------------------------------------------------------------------

test('every state renders in both packs with exactly the params its message takes, and a tool prefix seen elsewhere names both prefixes', () => {
  const entries = [
    connected(CALENDAR),
    { state: 'needs_auth', rawStatus: 'needs-auth', observedPrefix: null },
    { state: 'failed', rawStatus: 'failed', observedPrefix: null },
    { state: 'pending', rawStatus: 'pending', observedPrefix: null },
    { state: 'absent', rawStatus: null, observedPrefix: null },
    { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null },
    { state: 'tools_missing', rawStatus: 'connected', observedPrefix: CALENDAR.toolPrefix },
    { state: 'tools_missing', rawStatus: 'connected', observedPrefix: 'mcp__Google_Calendar__' },
    { state: 'unknown', rawStatus: 'disabled', observedPrefix: null },
    { state: 'unknown', rawStatus: null, observedPrefix: null },
  ];
  const messages = entries.map((entry) => connectorStateMessage(CALENDAR, entry));
  assert.deepEqual(messages, [
    { messageKey: 'harness.connectors.connected', params: { connector: 'claude.ai Google Calendar' } },
    { messageKey: 'harness.connectors.needs_auth', params: { connector: 'claude.ai Google Calendar' } },
    { messageKey: 'harness.connectors.failed', params: { connector: 'claude.ai Google Calendar' } },
    { messageKey: 'harness.connectors.pending', params: { connector: 'claude.ai Google Calendar' } },
    { messageKey: 'harness.connectors.absent', params: { connector: 'claude.ai Google Calendar' } },
    { messageKey: 'harness.connectors.tools_missing', params: { connector: 'claude.ai Google Calendar', prefix: 'mcp__claude_ai_Google_Calendar__' } },
    { messageKey: 'harness.connectors.tools_missing', params: { connector: 'claude.ai Google Calendar', prefix: 'mcp__claude_ai_Google_Calendar__' } },
    { messageKey: 'harness.connectors.tools_elsewhere', params: { connector: 'claude.ai Google Calendar', prefix: 'mcp__claude_ai_Google_Calendar__', observed: 'mcp__Google_Calendar__' } },
    { messageKey: 'harness.connectors.unknown', params: { connector: 'claude.ai Google Calendar', status: 'disabled' } },
    { messageKey: 'harness.connectors.unknown', params: { connector: 'claude.ai Google Calendar', status: '-' } },
  ]);
  for (const lang of ['en', REFERENCE_LANG]) {
    const t = createTranslator(lang);
    for (const { messageKey, params } of messages) {
      const text = t(messageKey, params);
      assert.doesNotMatch(text, /\{\w+\}/, `${lang} ${messageKey}: ${text}`);
      for (const value of Object.values(params)) assert.ok(text.includes(String(value)), `${lang} ${messageKey} drops ${value}`);
    }
  }
});

// --- complete and hasNextPage (rulings R-B3 and I2) --------------------------------

// One tool result, as a user event, read alone.
function resultWith(content) {
  const block = { type: 'tool_result', tool_use_id: 'toolu_fake_page', content };
  return parseStream([JSON.stringify({ type: 'user', message: { role: 'user', content: [block] } })]).toolResults[0];
}
const page = (content) => {
  const { complete, hasNextPage } = resultWith(content);
  return { complete, hasNextPage };
};
const WHOLE_NEXT = { complete: true, hasNextPage: true };
const WHOLE_LAST = { complete: true, hasNextPage: false };
const PART = { complete: false, hasNextPage: false };

// The text of the first list_events result in the connector run.
function firstPageText() {
  return JSON.parse(fixture('connectors-connected').split('\n')[24]).message.content[0].content;
}

test('every tool result says whether its text is one whole JSON document and whether that document advertises a next page; the record keeps no text', () => {
  const r = parseStream(fixture('connectors-connected'));
  // ToolSearch (tool references, no text), list_events page 1, page 2, get_event, search_files.
  assert.deepEqual(r.toolResults.map((t) => [t.complete, t.hasNextPage]), [[false, false], [true, true], [true, false], [true, false], [true, true]]);
  for (const t of r.toolResults) assert.deepEqual(Object.keys(t).sort(), ['complete', 'hasNextPage', 'isError', 'toolUseId']);
  assert.deepEqual(parseStream(fixture('connectors-states')).toolResults, []);
});

test('a list_events result cut before its token is incomplete and advertises no next page, with or without a notice after it (review I2)', () => {
  const text = firstPageText();
  assert.deepEqual(page(text), WHOLE_NEXT);
  const cut = text.slice(0, text.indexOf('"nextPageToken"'));
  for (const content of [cut, `${cut}\n[result truncated]`, `${cut.slice(0, 200)}...`, [{ type: 'text', text: cut }], `${text}\n[saved to a file]`]) {
    assert.deepEqual(page(content), PART, typeof content === 'string' ? content.slice(-40) : 'blocks');
  }
});

test('only a non-empty string at the top level is a next page: empty, null, a number, and a token nested in an event or quoted in a field are none', () => {
  const emptied = fixture('connectors-connected').replace(/\\"nextPageToken\\":\\"[^\\"]+\\"/, '\\"nextPageToken\\":\\"\\"');
  assert.notEqual(emptied, fixture('connectors-connected'));
  assert.deepEqual(parseStream(emptied).toolResults.map((t) => [t.complete, t.hasNextPage]), [[false, false], [true, false], [true, false], [true, false], [true, true]]);
  for (const content of ['{"events":[],"nextPageToken":""}', '{"events":[],"nextPageToken":null}', '{"events":[]}', '{"nextPageToken":42}', '{"nextPageToken":{"v":"abc"}}', '{"nextPageToken":["abc"]}']) {
    assert.deepEqual(page(content), WHOLE_LAST, content);
  }
  // A third party's event cannot hold the page open, and neither can a mention of a token.
  assert.deepEqual(page(JSON.stringify({ events: [{ id: 'evt-0001', conferenceData: { parameters: { nextPageToken: 'abc' } } }] })), WHOLE_LAST);
  assert.deepEqual(page(JSON.stringify({ description: 'copy "nextPageToken":"abc" here' })), WHOLE_LAST);
  // A document whose top level is not an object has no token.
  for (const content of ['null', '[{"nextPageToken":"abc"}]', '"nextPageToken"', '5']) assert.deepEqual(page(content), WHOLE_LAST, content);
  for (const content of ['{"events":[],"nextPageToken" : "abc="}', '{\n  "nextPageToken": "abc="\n}', '{"nextPageToken":" "}']) {
    assert.deepEqual(page(content), WHOLE_NEXT, content);
  }
});

test('a result that is not JSON, or is more than one document, is incomplete: a notice, a saved-file message, two documents, nothing', () => {
  for (const content of ['Error: the result is too large; it was saved to /home/ana/tmp/result.txt', '{"a":1}{"b":2}', '{"events":[]}\nmore', '', '   ']) {
    assert.deepEqual(page(content), PART, content);
  }
  for (const content of [undefined, null, 7, { nextPageToken: 'abc' }]) assert.deepEqual(page(content), PART, JSON.stringify(content));
});

test('a result given as blocks is read from its text blocks concatenated; other blocks, and a text that is not a string, are not text', () => {
  assert.deepEqual(page([{ type: 'text', text: '{"files":[],"nextPageToken":"abc"}' }]), WHOLE_NEXT);
  assert.deepEqual(page([{ type: 'image', source: {} }, { type: 'text', text: '{"nextPageToken":"abc"}' }]), WHOLE_NEXT);
  assert.deepEqual(page([{ type: 'text', text: '{"files":[],"nextPage' }, { type: 'text', text: 'Token":"abc"}' }]), WHOLE_NEXT);
  assert.deepEqual(page([{ type: 'text', text: '{"files":[]}' }, { type: 'text', text: '{"nextPageToken":"abc"}' }]), PART);
  assert.deepEqual(page([{ type: 'tool_reference', tool_name: 'mcp__claude_ai_Google_Drive__search_files' }]), PART);
  assert.deepEqual(page([{ type: 'thinking', text: '{"nextPageToken":"abc"}' }]), PART);
  assert.deepEqual(page([{ type: 'text', text: 7 }, null, 'x']), PART);
});

// --- the fixtures -------------------------------------------------------------------

test('the stream fixtures name no real person, place or machine: no /home/ but /home/ana/, no /tmp/claude-, no -home-, no @ but @example.com, no URL but https://example.com', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.includes('connectors-connected.jsonl') && files.includes('connectors-states.jsonl'));
  for (const file of files) {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    assert.doesNotMatch(text.replaceAll('/home/ana/', ''), /\/home\//, file);
    assert.ok(!text.includes('/tmp/claude-'), file);
    assert.ok(!text.includes('-home-'), file);
    for (const m of text.matchAll(/@/g)) assert.match(text.slice(m.index, m.index + 40), /^@example\.com(?![A-Za-z0-9.-])/, file);
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\//g)) assert.match(text.slice(m.index, m.index + 60), /^https:\/\/example\.com(?![A-Za-z0-9.-])/, file);
  }
});

test('the connector fixtures keep the shapes the capture showed: string results, structured copies, the token form, one neutral server per status', () => {
  const run = events('connectors-connected');
  const users = run.filter((e) => e.type === 'user');
  // ToolSearch answers with tool references; every connector answers with a string of JSON.
  assert.deepEqual(users[0].message.content[0].content.map((b) => b.type), ['tool_reference', 'tool_reference', 'tool_reference']);
  for (const e of users.slice(1)) {
    const [block] = e.message.content;
    assert.equal(typeof block.content, 'string');
    assert.equal(block.is_error, undefined);
    assert.deepEqual(Object.keys(e.tool_use_result), ['content', 'structuredContent']);
    assert.equal(e.tool_use_result.content, block.content);
    assert.deepEqual(JSON.parse(block.content), e.tool_use_result.structuredContent);
  }
  const tokens = users.slice(1).map((e) => /"nextPageToken":"[^"]+"/.test(e.message.content[0].content));
  assert.deepEqual(tokens, [true, false, false, true]);
  // The attachments carry a URL and a title, no file id of their own (ruling R-B2).
  const event = JSON.parse(users[3].message.content[0].content);
  assert.deepEqual(event.attachments.map((a) => Object.keys(a)), [['fileUrl', 'title'], ['fileUrl', 'title']]);
  for (const name of ['connectors-connected', 'connectors-states']) {
    const servers = initOf(events(name)).mcp_servers;
    const neutral = servers.filter((s) => !s.name.startsWith('claude.ai Google '));
    assert.deepEqual(neutral.map((s) => s.status).sort(), ['connected', 'failed', 'needs-auth', 'pending'], name);
    assert.deepEqual(servers.filter((s) => s.name.startsWith('claude.ai Google ')).map((s) => [s.name, s.status, s.source]).sort(), [
      ['claude.ai Google Calendar', 'connected', 'claudeai'], ['claude.ai Google Drive', 'connected', 'claudeai'],
    ], name);
  }
  // The capture's own write tools were denied, so its session lists none; the states run denied nothing.
  const writes = /__(create_event|update_event|delete_event|respond_to_event|create_file|update_file|copy_file|share_file|trash_file|download_file_content)$/;
  assert.equal(initOf(run).tools.some((n) => writes.test(n)), false);
  assert.equal(initOf(events('connectors-states')).tools.filter((n) => writes.test(n)).length, 10);
});
