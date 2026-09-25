// 05/09/2026 (docs/incidents.md, "connected, online, and the tools were not
// there"): for four nights, 05/09 to 08/09/2026, the CLI listed the
// calendar and document connectors as Connected while the tool search found
// none of their tools; on 09/09 the same script, run by hand, opened its
// pull request, which put the cause in the scheduled invocation, not in
// the connectors. A listing that says "connected" answered a question about
// something other than the session the round would use. The rule: a
// connector's state comes from the init event of the very invocation that
// uses it (decision D2), and connected counts only with the tools the
// source needs in that session; otherwise it is tools_missing, naming the
// prefix the tools were seen under when they exist under another one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, runModel } from '../../src/harness/claude-code.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { checkIsolation } from '../../src/guards/isolation.mjs';
import { connectorStates } from '../../src/guards/connectors.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/stream/', import.meta.url));
const FAKE = fileURLToPath(new URL('../helpers/fake-claude.mjs', import.meta.url));
const STREAM = join(FIXTURES, 'connectors-states.jsonl');

const CALENDAR = { id: 'calendar', serverDisplayName: 'claude.ai Google Calendar', toolPrefix: 'mcp__claude_ai_Google_Calendar__', toolSuffixes: ['list_events', 'get_event'] };
const MEETING_NOTES = { id: 'meeting_notes', serverDisplayName: 'claude.ai Google Drive', toolPrefix: 'mcp__claude_ai_Google_Drive__', toolSuffixes: ['search_files', 'read_file_content'] };
const SPECS = [CALENDAR, MEETING_NOTES];

function initWith(editTools) {
  const record = parseStream(readFileSync(STREAM, 'utf8'));
  return { ...record.init, tools: editTools(record.init.tools) };
}
const isGoogle = (name) => name.startsWith('mcp__claude_ai_Google_');

test('both connectors connected in the init event, none of their tools in the session: tools_missing, with no prefix seen', () => {
  const init = initWith((tools) => tools.filter((name) => !isGoogle(name)));
  assert.deepEqual(init.mcp_servers.filter((s) => s.name.startsWith('claude.ai Google ')).map((s) => s.status), ['connected', 'connected']);
  assert.deepEqual(connectorStates(init, SPECS), {
    calendar: { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null },
    meeting_notes: { state: 'tools_missing', rawStatus: 'connected', observedPrefix: null },
  });
});

test('connected, with its tools present under another prefix: tools_missing, naming the prefix they were seen under', () => {
  const init = initWith((tools) => tools.map((name) => name.replace('mcp__claude_ai_Google_Calendar__', 'mcp__Google_Calendar__')));
  assert.deepEqual(connectorStates(init, SPECS), {
    calendar: { state: 'tools_missing', rawStatus: 'connected', observedPrefix: 'mcp__Google_Calendar__' },
    meeting_notes: { state: 'connected', rawStatus: 'connected', observedPrefix: 'mcp__claude_ai_Google_Drive__' },
  });
});

test('end to end through the child process: the isolation guard sees nothing wrong, and the connector state is what catches it', async () => {
  const dir = makeTempDir('brain-kit-incident-0905-');
  const scenarioPath = join(dir, 'scenario.json');
  const record = parseStream(readFileSync(STREAM, 'utf8'));
  writeFileSync(scenarioPath, JSON.stringify({ stream: STREAM, rewrite: { tools: record.init.tools.filter((name) => !isGoogle(name)) } }));
  const out = await runModel({
    claudeBin: FAKE, argv: buildArgv({ mode: 'connectors' }), prompt: 'x', cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath }, timeoutMs: 20000,
  });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(checkIsolation(out.record, { mode: 'connectors' }).problems, []);
  assert.deepEqual(Object.values(connectorStates(out.record.init, SPECS)).map((s) => s.state), ['tools_missing', 'tools_missing']);
});
