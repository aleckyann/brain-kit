// The harness that runs Claude Code for a round: the argument vector, the
// stream reader, the child process, and the two guards that read what the
// CLI says about itself (isolation from the person's settings, and whether
// the CLI is a real program at all). Every run here uses
// test/helpers/fake-claude.mjs, never the real binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, CONNECTOR_ARGS, ISOLATION_ARGS, ROUND_TOOLS, runModel, unscopedRules } from '../src/harness/claude-code.mjs';
import { parseStream } from '../src/harness/stream.mjs';
import { checkIsolation } from '../src/guards/isolation.mjs';
import { checkCli } from '../src/guards/cli.mjs';
import { createTranslator, REFERENCE_LANG } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/stream/', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8');
const fixtureLines = (name) => fixture(name).split('\n').filter((l) => l !== '');

// A test that could reach the real `claude` checks first that the binary it
// is about to run is the fake (incident: a test suite that would have burned
// a real round).
function assertFake(bin) {
  assert.equal(bin, FAKE, 'this test must run the fake claude, never the real one');
}

function scenario(fields) {
  const dir = makeTempDir('brain-kit-harness-');
  const files = { argvFile: join(dir, 'argv.json'), stdinFile: join(dir, 'stdin.txt'), recordFile: join(dir, 'record.jsonl') };
  const path = join(dir, 'scenario.json');
  writeFileSync(path, JSON.stringify({ ...files, ...fields }));
  return { dir, path, ...files, env: { ...process.env, FAKE_CLAUDE_SCENARIO: path } };
}

// --- buildArgv -------------------------------------------------------------

test('buildArgv puts the isolation flags first, then model, limits, each rule as its own argument, then -- and nothing after it', () => {
  const allowed = ['Bash("/opt/brain-kit/bin/brain-kit.mjs" validate:*)', 'Bash("/opt/brain-kit/bin/brain-kit.mjs" propose:*)', 'Read(./**)'];
  const disallowed = ['Bash(curl:*)', 'WebFetch'];
  const argv = buildArgv({ model: 'claude-opus-5-5', maxTurns: 40, budgetUsd: 1.5, allowed, disallowed });
  assert.deepEqual(argv, [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch',
    '--no-session-persistence',
    '--model', 'claude-opus-5-5', '--max-turns', '40', '--max-budget-usd', '1.5',
    '--allowedTools', ...allowed,
    '--disallowedTools', ...disallowed,
    '--',
  ]);
});

test('buildArgv always carries every isolation flag, and --setting-sources is followed by the empty string as its own element', () => {
  for (const options of [{}, { allowed: ['Read(./**)'] }, { model: 'm', maxTurns: 1 }]) {
    const argv = buildArgv(options);
    assert.deepEqual(argv.slice(0, ISOLATION_ARGS.length), [...ISOLATION_ARGS]);
    for (const flag of ['-p', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch');
    assert.equal(argv.at(-1), '--');
    assert.equal(argv.indexOf('--'), argv.length - 1);
  }
});

test('ROUND_TOOLS is the pinned built-in set, frozen, and --tools carries it once, as one comma-joined element; skills are disabled once', () => {
  assert.deepEqual([...ROUND_TOOLS], ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'ToolSearch']);
  assert.ok(Object.isFrozen(ROUND_TOOLS));
  assert.ok(Object.isFrozen(ISOLATION_ARGS));
  const argv = buildArgv({ model: 'm', maxTurns: 1, budgetUsd: 1, allowed: ['Read(./**)'], disallowed: ['WebFetch'] });
  assert.equal(argv.filter((a) => a === '--tools').length, 1);
  assert.equal(argv.filter((a) => a === '--disable-slash-commands').length, 1);
  assert.equal(argv[argv.indexOf('--tools') + 1], ROUND_TOOLS.join(','));
  // The value is one element: a tool name never lands where an option is read.
  assert.ok(!argv.includes('ToolSearch'));
});

test('buildArgv in connector mode: the user setting source with every hook off, no --strict-mcp-config, skills off, the pinned tools, then the same tail', () => {
  const allowed = ['Read(./**)', 'mcp__claude_ai_Google_Calendar__list_events'];
  const disallowed = ['Bash(curl:*)', 'Bash(rtk curl *)', 'mcp__claude_ai_Google_Calendar__create_event'];
  const argv = buildArgv({ mode: 'connectors', model: 'claude-opus-5-5', maxTurns: 40, budgetUsd: 1.5, allowed, disallowed });
  assert.deepEqual(argv, [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--tools', 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch',
    '--no-session-persistence',
    '--model', 'claude-opus-5-5', '--max-turns', '40', '--max-budget-usd', '1.5',
    '--allowedTools', ...allowed,
    '--disallowedTools', ...disallowed,
    '--',
  ]);
  assert.deepEqual(buildArgv({ mode: 'connectors' }), [...CONNECTOR_ARGS, '--']);
});

test('CONNECTOR_ARGS is frozen and differs from ISOLATION_ARGS only where connectors need it: user settings, hooks off, no --strict-mcp-config', () => {
  assert.ok(Object.isFrozen(CONNECTOR_ARGS));
  assert.deepEqual([...CONNECTOR_ARGS], [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--tools', ROUND_TOOLS.join(','),
    '--no-session-persistence',
  ]);
  assert.equal(CONNECTOR_ARGS.includes('--strict-mcp-config'), false);
  assert.deepEqual(JSON.parse(CONNECTOR_ARGS[CONNECTOR_ARGS.indexOf('--settings') + 1]), { disableAllHooks: true });
  // Everything else is the isolated mode's, flag for flag and in order.
  const expected = [];
  for (let i = 0; i < ISOLATION_ARGS.length; i++) {
    if (ISOLATION_ARGS[i] === '--strict-mcp-config') continue;
    if (ISOLATION_ARGS[i] === '--setting-sources') {
      expected.push('--setting-sources', 'user', '--settings', '{"disableAllHooks":true}');
      i += 1;
      continue;
    }
    expected.push(ISOLATION_ARGS[i]);
  }
  assert.deepEqual([...CONNECTOR_ARGS], expected);
});

test('buildArgv runs isolated unless asked for connectors, and refuses any other mode', () => {
  assert.deepEqual(buildArgv({ allowed: ['Read(./**)'] }), buildArgv({ mode: 'isolated', allowed: ['Read(./**)'] }));
  assert.deepEqual(buildArgv({ mode: undefined }), [...ISOLATION_ARGS, '--']);
  for (const mode of ['connector', 'Connectors', 'user', '', null, 1, true, {}, 'constructor', '__proto__', 'toString']) {
    assert.throws(() => buildArgv({ mode }), (error) => error instanceof TypeError && error.message.startsWith('not a launch mode: '), String(mode));
  }
  // The scope guard holds in connector mode too.
  assert.throws(() => buildArgv({ mode: 'connectors', allowed: ['Bash'] }), TypeError);
});

test('buildArgv leaves out what was not set and refuses a rule that would read as an option', () => {
  assert.deepEqual(buildArgv({}), [...ISOLATION_ARGS, '--']);
  assert.throws(() => buildArgv({ allowed: ['--dangerously-skip-permissions'] }), TypeError);
  assert.throws(() => buildArgv({ disallowed: [''] }), TypeError);
  assert.throws(() => buildArgv({ maxTurns: 0 }), TypeError);
  assert.throws(() => buildArgv({ budgetUsd: -1 }), TypeError);
});

test('buildArgv refuses to allow a path or command tool with no scope, alone or inside a list the CLI splits, and accepts it scoped', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']) {
    assert.throws(() => buildArgv({ allowed: [tool] }), (error) => error instanceof TypeError && error.message.includes(tool), tool);
    assert.throws(() => buildArgv({ allowed: ['Edit(./**)', `Write(./**),${tool}`] }), TypeError, `${tool} after a comma`);
    assert.throws(() => buildArgv({ allowed: [`Read(./a b/**) ${tool}`] }), TypeError, `${tool} after a space`);
    assert.doesNotThrow(() => buildArgv({ allowed: [`${tool}(./**)`] }), tool);
  }
  // A space or a comma inside a rule's parentheses is part of its scope,
  // even when what follows it reads like a tool name.
  assert.doesNotThrow(() => buildArgv({ allowed: ['Read(//home/ana/notes Read,Bash/c.jsonl)', 'ToolSearch', 'mcp__x__y'] }));
  // Denying a tool everywhere is the round's own business.
  assert.doesNotThrow(() => buildArgv({ disallowed: ['Bash', 'Read'] }));
});

test('buildArgv refuses an empty or all-matching scope too, Tool() and Tool(*), trimmed; an explicit scope, however wide, is a deliberate grant', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']) {
    for (const rule of [`${tool}()`, `${tool}(*)`, `${tool}( )`, `${tool}( * )`]) {
      assert.throws(() => buildArgv({ allowed: [rule] }), (error) => error instanceof TypeError && error.message.includes(JSON.stringify(rule)), rule);
    }
  }
  assert.throws(() => buildArgv({ allowed: ['Bash(*)'] }), /such as Bash\(<command>:\*\)/);
  assert.throws(() => buildArgv({ allowed: ['Grep()'] }), /such as Grep\(\.\/\*\*\)/);
  assert.doesNotThrow(() => buildArgv({ allowed: ['Read(//**)', 'Bash(git status:*)', 'Read(**)', 'ToolSearch()'] }));
});

test('unscopedRules returns every rule with no real scope, across elements and inside a list the CLI splits, in order', () => {
  assert.deepEqual(unscopedRules(['Read(./**)', 'Edit(),Grep', 'mcp__x__y', 'Write(./notes/**) Bash(*)', 'ToolSearch', 'Task']), ['Edit()', 'Grep', 'Bash(*)']);
  assert.deepEqual(unscopedRules(['Read(//**)', 'Glob(./**)', 'Bash(node x:*)']), []);
  assert.deepEqual(unscopedRules(null), []);
  assert.deepEqual(unscopedRules([7, null, 'Read']), ['Read']);
});

// --- parseStream -----------------------------------------------------------

test('parseStream reads the default run: permission mode auto, two hook events, four MCP servers, five tool uses, no denial', () => {
  const r = parseStream(fixtureLines('default-run'));
  assert.equal(r.init.permissionMode, 'auto');
  assert.equal(r.hookEvents, 2);
  assert.equal(r.init.mcp_servers.length, 4);
  assert.deepEqual(r.toolUses.map((u) => u.name), ['Read', 'Read', 'Bash', 'Bash', 'Bash']);
  assert.equal(r.toolUses[3].input.command, 'curl -s https://example.com');
  assert.equal(r.toolResults.length, 5);
  assert.ok(r.toolResults.every((t) => t.isError === false));
  assert.deepEqual(r.denials, []);
  assert.deepEqual(r.result, {
    subtype: 'success', isError: false, costUsd: 0.3138986, numTurns: 6, terminalReason: 'completed',
    text: r.result.text,
  });
  assert.match(r.result.text, /\nBRAIN_KIT_SOURCES: transcripts=ok$/);
  assert.deepEqual(r.unknownTypes, []);
  assert.equal(r.invalidLines, 0);
  assert.equal(r.events.length, 36);
});

test('parseStream reads the isolated run: dontAsk, no hooks, no MCP server, the kit command ran', () => {
  const r = parseStream(fixture('isolated-run'));
  assert.equal(r.init.permissionMode, 'dontAsk');
  assert.deepEqual(r.init.mcp_servers, []);
  assert.equal(r.hookEvents, 0);
  assert.deepEqual(r.toolUses.map((u) => [u.name, u.input.command]), [['Bash', '/opt/brain-kit/bin/brain-kit.mjs propose example']]);
  assert.deepEqual(r.toolResults, [{ toolUseId: r.toolUses[0].id, isError: false, hasNextPage: false }]);
  assert.equal(r.result.costUsd, 0.041879);
  assert.equal(r.result.numTurns, 2);
  assert.deepEqual(r.denials, []);
});

test('parseStream reads the connector run: deferred tools loaded first, every call with its input, and which results advertise a next page', () => {
  const r = parseStream(fixture('connectors-connected'));
  assert.equal(r.init.permissionMode, 'dontAsk');
  assert.deepEqual(r.toolUses.map((u) => u.name), [
    'ToolSearch', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Calendar__list_events',
    'mcp__claude_ai_Google_Calendar__get_event', 'mcp__claude_ai_Google_Drive__search_files',
  ]);
  assert.equal(r.toolUses[0].input.query, 'select:mcp__claude_ai_Google_Calendar__list_events,mcp__claude_ai_Google_Calendar__get_event,mcp__claude_ai_Google_Drive__search_files');
  assert.deepEqual(r.toolUses[1].input, { calendarId: 'primary', startTime: '2026-05-12T03:00:00Z', endTime: '2026-05-13T03:00:00Z', eventType: ['DEFAULT'], pageSize: 2 });
  // The second call asks for the page the first result advertised; that result is a string of JSON.
  const answer = (use) => r.events.find((e) => e.type === 'user' && e.message.content[0].tool_use_id === use.id).message.content[0].content;
  assert.equal(typeof answer(r.toolUses[1]), 'string');
  assert.equal(r.toolUses[2].input.pageToken, JSON.parse(answer(r.toolUses[1])).nextPageToken);
  assert.deepEqual(r.toolResults, r.toolUses.map((u, i) => ({ toolUseId: u.id, isError: false, hasNextPage: i === 1 || i === 4 })));
  assert.deepEqual(r.unknownTypes, []);
  assert.equal(r.invalidLines, 0);
  assert.equal(r.result.subtype, 'success');
});

test('parseStream reads a denial: the tool result is an error and the denial names the command the model asked for', () => {
  const r = parseStream(fixtureLines('denied-run'));
  const curl = r.toolUses.find((u) => u.input.command === 'curl -s https://example.com');
  assert.deepEqual(r.denials, [{ toolName: 'Bash', toolUseId: curl.id, input: { command: 'curl -s https://example.com', description: 'Fetch example.com' } }]);
  assert.deepEqual(r.toolResults.filter((t) => t.isError), [{ toolUseId: curl.id, isError: true, hasNextPage: false }]);
  const denied = r.events.find((e) => e.type === 'user' && e.message.content[0].tool_use_id === curl.id);
  assert.equal(denied.message.content[0].content, 'Permission to use Bash with command curl -s https://example.com has been denied.');
  assert.equal(r.result.subtype, 'success');
  assert.equal(r.result.costUsd, 0.08813380000000001);
  assert.equal(r.result.numTurns, 6);
});

test('parseStream takes a denial from either place it is reported, once: the result list, or the system event of a run cut before its result', () => {
  const lines = fixtureLines('denied-run');
  const resultOnly = parseStream(lines.filter((l) => !l.includes('"subtype":"permission_denied"')));
  assert.deepEqual(resultOnly.denials.map((d) => [d.toolName, d.input.command]), [['Bash', 'curl -s https://example.com']]);
  const cutBeforeResult = parseStream(lines.filter((l) => !l.includes('"type":"result"')));
  assert.deepEqual(cutBeforeResult.denials.map((d) => [d.toolName, d.input.command]), [['Bash', 'curl -s https://example.com']]);
  assert.equal(parseStream(lines).denials.length, 1);
});

test('parseStream reads a run that hit its turn limit as an error result', () => {
  const r = parseStream(fixtureLines('max-turns'));
  assert.equal(r.result.subtype, 'error_max_turns');
  assert.equal(r.result.isError, true);
  assert.equal(r.result.terminalReason, 'max_turns');
  assert.equal(r.result.text, null);
  assert.deepEqual(r.denials.map((d) => d.toolName), ['Bash', 'WebFetch']);
  assert.deepEqual(r.unknownTypes, []);
});

test('parseStream counts unknown types and subtypes and lines that are not JSON objects, and keeps reading', () => {
  const lines = [
    '{"type":"telemetry_ping"}',
    '',
    'not json at all',
    ...fixtureLines('isolated-run').slice(0, 3),
    '{"type":"system","subtype":"brand_new_thing"}',
    '[1,2,3]',
    '42',
    '{"no_type":true}',
    '   ',
    ...fixtureLines('isolated-run').slice(3),
    '{"type":"result","subtype":"error_something_new","is_error":true}',
  ];
  const r = parseStream(lines);
  assert.deepEqual(r.unknownTypes, ['telemetry_ping', 'system/brand_new_thing', 'result/error_something_new']);
  assert.equal(r.invalidLines, 4);
  assert.equal(r.init.permissionMode, 'dontAsk');
  assert.equal(r.toolUses.length, 1);
  // The last result wins, and an unknown subtype still fills it.
  assert.equal(r.result.subtype, 'error_something_new');
  assert.equal(r.result.isError, true);
  assert.equal(r.result.costUsd, null);
});

test('parseStream counts any hook_* system event, and a stream with no result has result null', () => {
  const r = parseStream([
    '{"type":"system","subtype":"hook_response","hook_event":"SessionStart"}',
    '{"type":"system","subtype":"hook_progress"}',
    ...fixtureLines('isolated-run').filter((l) => !l.includes('"type":"result"')),
  ]);
  assert.equal(r.hookEvents, 2);
  assert.equal(r.result, null);
});

test('a hook event after the init event is counted apart, and checkIsolation then never says the model did no work (final review I3)', () => {
  const lines = fixtureLines('isolated-run');
  const initAt = lines.findIndex((l) => l.includes('"subtype":"init"'));
  const late = '{"type":"system","subtype":"hook_started","hook_name":"PreToolUse:Bash","hook_event":"PreToolUse"}';
  const r = parseStream([...lines.slice(0, initAt + 1), late, ...lines.slice(initAt + 1)]);
  assert.equal(r.hookEvents, 1);
  assert.equal(r.hookEventsAfterInit, 1);
  const checked = checkIsolation(r);
  assert.deepEqual(checked.problems, ['hooks']);
  assert.equal(checked.details[0].messageKey, 'harness.isolation.hooks_late');
  const early = parseStream(['{"type":"system","subtype":"hook_started","hook_event":"SessionStart"}', ...lines]);
  assert.equal(early.hookEventsAfterInit, 0);
  assert.equal(checkIsolation(early).details.find((d) => d.code === 'hooks').messageKey, 'harness.isolation.hooks');
});

// --- runModel ---------------------------------------------------------------

test('runModel writes the prompt on stdin, passes the argument vector untouched, and returns the child\'s own exit code with the record', async () => {
  const s = scenario({ stream: join(FIXTURES, 'isolated-run.jsonl'), exitCode: 3, stderr: 'something on stderr\n' });
  const argv = buildArgv({ maxTurns: 5, allowed: ['Read(./**)'] });
  const lines = [];
  assertFake(FAKE);
  const out = await runModel({ claudeBin: FAKE, argv, prompt: 'Curate the vault.\nSecond line.', cwd: s.dir, env: s.env, timeoutMs: 20000, onLine: (l) => lines.push(l) });
  assert.equal(out.exitCode, 3);
  assert.equal(out.signal, null);
  assert.equal(out.timedOut, false);
  assert.equal(readFileSync(s.stdinFile, 'utf8'), 'Curate the vault.\nSecond line.');
  assert.deepEqual(JSON.parse(readFileSync(s.argvFile, 'utf8')), argv);
  assert.equal(out.record.init.permissionMode, 'dontAsk');
  assert.equal(out.record.result.costUsd, 0.041879);
  assert.equal(lines.length, fixtureLines('isolated-run').length);
  assert.equal(out.stderrTail, 'something on stderr\n');
  assert.ok(out.durationMs >= 0);
});

test('runModel kills a child that outlives its timeout and reports the signal, never an exit code', async () => {
  const s = scenario({ stream: join(FIXTURES, 'isolated-run.jsonl'), delayMs: 30000 });
  assertFake(FAKE);
  const out = await runModel({ claudeBin: FAKE, argv: buildArgv({}), prompt: 'x', cwd: s.dir, env: s.env, timeoutMs: 500 });
  assert.equal(out.timedOut, true);
  assert.equal(out.exitCode, null);
  assert.equal(out.signal, 'SIGTERM');
  assert.equal(out.record.init.permissionMode, 'dontAsk');
});

test('runModel reports a binary that cannot start as a spawn error with no exit code', async () => {
  const dir = makeTempDir('brain-kit-harness-');
  const out = await runModel({ claudeBin: join(dir, 'no-such-claude'), argv: buildArgv({}), prompt: 'x', cwd: dir, timeoutMs: 5000 });
  assert.equal(out.exitCode, null);
  assert.equal(out.spawnError, 'ENOENT');
  assert.equal(out.record.init, null);
});

test('the fake refuses stream-json without --verbose with the real error, and a prompt after --', async () => {
  const s = scenario({ stream: join(FIXTURES, 'isolated-run.jsonl') });
  assertFake(FAKE);
  const noVerbose = buildArgv({}).filter((a) => a !== '--verbose');
  const a = await runModel({ claudeBin: FAKE, argv: noVerbose, prompt: 'x', cwd: s.dir, env: s.env, timeoutMs: 20000 });
  assert.equal(a.exitCode, 1);
  assert.equal(a.stderrTail, 'Error: When using --print, --output-format=stream-json requires --verbose\n');
  assert.equal(a.record.init, null);
  const b = await runModel({ claudeBin: FAKE, argv: [...buildArgv({}), 'the prompt'], prompt: 'x', cwd: s.dir, env: s.env, timeoutMs: 20000 });
  assert.equal(b.exitCode, 64);
});

test('the fake performs its actions in its working directory with the environment the caller gave claude', async () => {
  const s = scenario({
    stream: join(FIXTURES, 'isolated-run.jsonl'),
    actions: [
      { write: { path: 'memory/log.md', content: '## 2026-09-24\n' } },
      { run: [process.execPath, '-e', 'process.stdout.write(process.env.BRAIN_KIT_ROUND_TOKEN)'] },
    ],
    rewrite: { finalText: 'BRAIN_KIT_SOURCES: transcripts=ok' },
  });
  assertFake(FAKE);
  const out = await runModel({ claudeBin: FAKE, argv: buildArgv({}), prompt: 'x', cwd: s.dir, env: { ...s.env, BRAIN_KIT_ROUND_TOKEN: 'feedface' }, timeoutMs: 20000 });
  assert.equal(out.exitCode, 0);
  assert.equal(readFileSync(join(s.dir, 'memory/log.md'), 'utf8'), '## 2026-09-24\n');
  const [run] = readFileSync(s.recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'feedface');
  assert.equal(out.record.result.text, 'BRAIN_KIT_SOURCES: transcripts=ok');
});

// --- checkIsolation ----------------------------------------------------------

function isolatedWith(edit) {
  const events = fixtureLines('isolated-run').map((l) => JSON.parse(l));
  return parseStream(edit(events).map((e) => JSON.stringify(e)));
}
const initOf = (events) => events.find((e) => e.subtype === 'init');

test('checkIsolation passes the isolated run', () => {
  assert.deepEqual(checkIsolation(parseStream(fixture('isolated-run'))), { ok: true, problems: [], details: [] });
});

test('checkIsolation reports each problem alone', () => {
  const cases = {
    permission_mode: (ev) => { initOf(ev).permissionMode = 'auto'; return ev; },
    hooks: (ev) => [{ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' }, ...ev],
    mcp: (ev) => { initOf(ev).mcp_servers = [{ name: 'example-server', status: 'connected' }]; return ev; },
    builtin_tools: (ev) => { initOf(ev).tools.push('Task'); return ev; },
    no_init: (ev) => ev.filter((e) => e.subtype !== 'init'),
  };
  for (const [code, edit] of Object.entries(cases)) {
    const out = checkIsolation(isolatedWith(edit));
    assert.equal(out.ok, false, code);
    assert.deepEqual(out.problems, [code], code);
  }
});

test('checkIsolation fails closed on a missing permission mode or an unreadable server list, and lets through the servers the round asked for', () => {
  assert.deepEqual(checkIsolation(isolatedWith((ev) => { delete initOf(ev).permissionMode; return ev; })).problems, ['permission_mode']);
  assert.deepEqual(checkIsolation(isolatedWith((ev) => { delete initOf(ev).mcp_servers; return ev; })).problems, ['mcp']);
  const withServer = isolatedWith((ev) => { initOf(ev).mcp_servers = [{ name: 'example-server', status: 'connected' }, { name: 'other', status: 'failed' }]; return ev; });
  assert.deepEqual(checkIsolation(withServer, { allowMcp: ['example-server', 'other'] }).problems, []);
  const out = checkIsolation(withServer, { allowMcp: ['example-server'] });
  assert.deepEqual(out.problems, ['mcp']);
  assert.deepEqual(out.details[0].params, { servers: 'other' });
  assert.deepEqual(checkIsolation(null).problems, ['no_init']);
});

test('checkIsolation flags builtin_tools for an init with Task added and for one with Read missing, naming the difference', () => {
  const added = checkIsolation(isolatedWith((ev) => { initOf(ev).tools.push('Task'); return ev; }));
  assert.deepEqual(added.problems, ['builtin_tools']);
  assert.deepEqual(added.details, [{ code: 'builtin_tools', messageKey: 'harness.isolation.builtin_tools', params: { extra: 'Task', missing: '-' } }]);
  const missing = checkIsolation(isolatedWith((ev) => { initOf(ev).tools = initOf(ev).tools.filter((n) => n !== 'Read'); return ev; }));
  assert.deepEqual(missing.problems, ['builtin_tools']);
  assert.deepEqual(missing.details[0].params, { extra: '-', missing: 'Read' });
  // Both at once, every default extra named in the order the init lists them.
  const both = checkIsolation(isolatedWith((ev) => { initOf(ev).tools = ['Task', 'Skill', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'ToolSearch', 'Workflow']; return ev; }));
  assert.deepEqual(both.details[0].params, { extra: 'Task, Skill, Workflow', missing: 'Read' });
});

test('checkIsolation passes the pinned set in any order, repeated, beside MCP tools, and fails closed on an init with no readable tool list', () => {
  const pinned = (tools) => checkIsolation(isolatedWith((ev) => { initOf(ev).tools = tools; return ev; }));
  assert.deepEqual(pinned([...ROUND_TOOLS]).problems, []);
  assert.deepEqual(pinned([...ROUND_TOOLS].reverse()).problems, []);
  assert.deepEqual(pinned([...ROUND_TOOLS, 'Read']).problems, []);
  assert.deepEqual(pinned([...ROUND_TOOLS, 'mcp__claude_ai_Example__list_items']).problems, []);
  // An MCP tool never stands in for a built-in one.
  assert.deepEqual(pinned([...ROUND_TOOLS.filter((n) => n !== 'Bash'), 'mcp__x__Bash']).details[0].params, { extra: '-', missing: 'Bash' });
  for (const tools of [undefined, null, 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch', {}]) {
    const out = pinned(tools);
    assert.deepEqual(out.problems, ['builtin_tools'], JSON.stringify(tools));
    assert.deepEqual(out.details[0].params, { extra: '(unreadable tools)', missing: ROUND_TOOLS.join(', ') }, JSON.stringify(tools));
  }
  // A name that is not a string is not one of the pinned tools.
  assert.deepEqual(pinned([...ROUND_TOOLS, 42]).details[0].params, { extra: '42', missing: '-' });
});

test('checkIsolation expects absent a built-in the round denies by bare name (ruling R-B4), and present one it denies only in part', () => {
  const withTools = (tools) => isolatedWith((ev) => { initOf(ev).tools = tools; return ev; });
  const noGlob = withTools(ROUND_TOOLS.filter((n) => n !== 'Glob'));
  assert.deepEqual(checkIsolation(noGlob, { disallowed: ['Bash(curl:*)', 'Glob', 'WebFetch'] }).problems, []);
  assert.deepEqual(checkIsolation(noGlob).details[0].params, { extra: '-', missing: 'Glob' });
  assert.deepEqual(checkIsolation(noGlob, { disallowed: ['Glob(./secret/**)'] }).details[0].params, { extra: '-', missing: 'Glob' });
  // Denied by bare name and still listed: the CLI did not do what was measured.
  assert.deepEqual(checkIsolation(withTools([...ROUND_TOOLS]), { disallowed: ['Glob'] }).details[0].params, { extra: 'Glob', missing: '-' });
  // The kit's own denylist names no pinned tool bare.
  assert.deepEqual(checkIsolation(withTools([...ROUND_TOOLS]), { disallowed: ['WebFetch', 'WebSearch'] }).problems, []);
});

test('checkIsolation splits each deny element where the CLI splits a tool list, so one element can deny several tools (review M3)', () => {
  const withTools = (tools) => isolatedWith((ev) => { initOf(ev).tools = tools; return ev; });
  const noGlobGrep = withTools(ROUND_TOOLS.filter((n) => n !== 'Glob' && n !== 'Grep'));
  for (const deny of [['Glob,Grep'], ['Glob Grep'], [' Glob', 'Grep '], ['Bash(curl:*),Glob Grep']]) {
    assert.deepEqual(checkIsolation(noGlobGrep, { disallowed: deny }).problems, [], JSON.stringify(deny));
  }
  // A comma inside a rule's scope splits nothing.
  assert.deepEqual(checkIsolation(noGlobGrep, { disallowed: ['Bash(x,Glob,Grep)'] }).details[0].params, { extra: '-', missing: 'Glob, Grep' });
});

function connectorsWith(edit) {
  const events = fixtureLines('connectors-states').map((l) => JSON.parse(l));
  return parseStream(edit(events).map((e) => JSON.stringify(e)));
}

test('checkIsolation in connector mode passes the connector runs, whose servers come from the person\'s settings; judged isolated, they fail on those servers alone', () => {
  for (const name of ['connectors-connected', 'connectors-states']) {
    const r = parseStream(fixture(name));
    assert.ok(r.init.mcp_servers.length > 0, name);
    assert.deepEqual(checkIsolation(r, { mode: 'connectors' }), { ok: true, problems: [], details: [] }, name);
    assert.deepEqual(checkIsolation(r).problems, ['mcp'], name);
    assert.deepEqual(checkIsolation(r, { mode: 'isolated' }).problems, ['mcp'], name);
    // allowMcp does not change connector mode, and still governs the isolated one.
    const names = r.init.mcp_servers.map((s) => s.name);
    assert.deepEqual(checkIsolation(r, { mode: 'isolated', allowMcp: names }).problems, [], name);
    assert.deepEqual(checkIsolation(r, { mode: 'connectors', allowMcp: [] }).problems, [], name);
  }
});

test('checkIsolation in connector mode still reports the permission mode, hooks, built-in tools and a missing init, each alone', () => {
  const cases = {
    permission_mode: (ev) => { initOf(ev).permissionMode = 'auto'; return ev; },
    hooks: (ev) => [{ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' }, ...ev],
    builtin_tools: (ev) => { initOf(ev).tools.push('Skill'); return ev; },
    no_init: (ev) => ev.filter((e) => e.subtype !== 'init'),
  };
  for (const [code, edit] of Object.entries(cases)) {
    assert.deepEqual(checkIsolation(connectorsWith(edit), { mode: 'connectors' }).problems, [code], code);
  }
  // A missing permission mode or tool list still fails closed; the server list is connectorStates' business.
  assert.deepEqual(checkIsolation(connectorsWith((ev) => { delete initOf(ev).permissionMode; return ev; }), { mode: 'connectors' }).problems, ['permission_mode']);
  assert.deepEqual(checkIsolation(connectorsWith((ev) => { delete initOf(ev).tools; return ev; }), { mode: 'connectors' }).problems, ['builtin_tools']);
  assert.deepEqual(checkIsolation(connectorsWith((ev) => { delete initOf(ev).mcp_servers; return ev; }), { mode: 'connectors' }).problems, []);
  // R-B4 holds in connector mode: a built-in the round denies by bare name is expected absent.
  const noGlob = connectorsWith((ev) => { initOf(ev).tools = initOf(ev).tools.filter((n) => n !== 'Glob'); return ev; });
  assert.deepEqual(checkIsolation(noGlob, { mode: 'connectors', disallowed: ['Glob'] }).problems, []);
  assert.deepEqual(checkIsolation(noGlob, { mode: 'connectors' }).details[0].params, { extra: '-', missing: 'Glob' });
});

// Some of the built-in tools a connector-mode run listed on 24/09/2026 when
// it loaded the user settings with no --tools and no --disable-slash-commands
// (it also ran a user hook before its init event): the MCP resource tools
// come with the connectors, and Skill with the person's skills.
const USER_SETTINGS_BUILTINS = [
  'Task', 'Bash', 'Edit', 'ListMcpResourcesTool', 'NotebookEdit', 'Read', 'ReadMcpResourceTool', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
];

test('checkIsolation in connector mode stops a run that loaded the user settings without neutralising them: the hook and every tool beyond the pinned set', () => {
  const r = connectorsWith((ev) => {
    const init = initOf(ev);
    init.tools = [...USER_SETTINGS_BUILTINS, ...init.tools.filter((n) => n.startsWith('mcp__'))];
    const hook = { type: 'system', subtype: 'hook_started', hook_id: '00000000-0000-4000-a000-000000000001', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: init.session_id };
    return [hook, { ...hook, subtype: 'hook_response', output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' }, ...ev];
  });
  const out = checkIsolation(r, { mode: 'connectors' });
  assert.deepEqual(out.problems, ['builtin_tools', 'hooks']);
  assert.deepEqual(out.details.map((d) => [d.code, d.params]), [
    ['builtin_tools', { extra: 'Task, ListMcpResourcesTool, NotebookEdit, ReadMcpResourceTool, Skill, WebFetch, WebSearch', missing: 'Glob, Grep' }],
    ['hooks', { count: 2 }],
  ]);
});

test('checkIsolation refuses a mode it does not know, rather than guessing which checks apply', () => {
  const record = parseStream(fixture('isolated-run'));
  assert.deepEqual(checkIsolation(record, { mode: 'isolated' }).problems, []);
  assert.deepEqual(checkIsolation(record, {}).problems, []);
  for (const mode of ['connector', 'Connectors', '', null, 0, 'constructor', '__proto__']) {
    assert.throws(() => checkIsolation(record, { mode }), (error) => error instanceof TypeError && error.message.startsWith('checkIsolation: not a launch mode: '), String(mode));
  }
});

// --- checkCli ------------------------------------------------------------------

test('checkCli: a missing file, a --version that prints error text or fails, and the good fake', () => {
  const dir = makeTempDir('brain-kit-harness-');
  assert.equal(checkCli(join(dir, 'claude')).problem, 'missing');
  assert.equal(checkCli('brain-kit-no-such-claude', { env: { PATH: dir } }).problem, 'missing');

  const broken = scenario({ version: 'Error: claude native binary not installed.' });
  const a = checkCli(FAKE, { env: broken.env });
  assert.deepEqual([a.ok, a.problem, a.version], [false, 'version', null]);
  assert.equal(a.params.output, 'Error: claude native binary not installed.');

  const failing = scenario({ version: '2.1.281 (Claude Code)', versionExit: 1 });
  assert.equal(checkCli(FAKE, { env: failing.env }).problem, 'version');

  const good = scenario({ version: '2.1.281 (Claude Code)' });
  assert.deepEqual(checkCli(FAKE, { env: good.env }), { ok: true, problem: null, version: '2.1.281', messageKey: null, params: null });
});

// --- messages ---------------------------------------------------------------------

test('every problem the two guards report renders in both packs with exactly the params it passes', () => {
  const dir = makeTempDir('brain-kit-harness-');
  const stub = join(dir, 'claude');
  writeFileSync(stub, 'x'.repeat(500), { mode: 0o755 });
  const broken = scenario({ version: 'Error' });
  const details = [
    ...checkIsolation(parseStream(fixture('default-run'))).details,
    ...checkIsolation(null).details,
    checkCli(join(dir, 'missing')),
    checkCli(stub),
    checkCli(FAKE, { env: broken.env }),
  ];
  assert.deepEqual(details.map((d) => d.messageKey), [
    'harness.isolation.permission_mode', 'harness.isolation.mcp', 'harness.isolation.builtin_tools', 'harness.isolation.hooks', 'harness.isolation.no_init',
    'harness.cli.missing', 'harness.cli.stub', 'harness.cli.version',
  ]);
  for (const lang of ['en', REFERENCE_LANG]) {
    const t = createTranslator(lang);
    for (const { messageKey, params } of details) {
      const text = t(messageKey, params);
      assert.doesNotMatch(text, /\{\w+\}/, `${lang} ${messageKey}: ${text}`);
      for (const value of Object.values(params)) assert.ok(text.includes(String(value)), `${lang} ${messageKey} drops ${value}`);
    }
  }
});

// --- fixtures ---------------------------------------------------------------------

// The built-in tools a run with no --tools exposes, as measured on
// 24/09/2026 with Claude Code 2.1.281, plus one tool of the fixture's
// connected MCP server.
const DEFAULT_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch',
  'Workflow', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'Artifact', 'mcp__example-server__lookup',
];

test('the pinned fixtures list exactly ROUND_TOOLS as a set, and the default run lists more than it with none missing', () => {
  assert.deepEqual(['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch'].sort(), [...ROUND_TOOLS].sort());
  const out = checkIsolation(parseStream(fixture('default-run')));
  assert.deepEqual(out.details.find((d) => d.code === 'builtin_tools').params, {
    extra: 'Task, WebFetch, WebSearch, Skill, Workflow, CronCreate, RemoteTrigger, SendMessage, Artifact', missing: '-',
  });
});

// The connector runs list the pinned built-ins in the order Claude Code
// listed them under --tools (measured on 24/09/2026), then MCP tools only:
// the two Google connectors' own names, and one neutral server's.
const CONNECTOR_BUILTINS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'ToolSearch', 'Write'];
const CONNECTOR_TOOL_PREFIXES = ['mcp__claude_ai_Google_Calendar__', 'mcp__claude_ai_Google_Drive__', 'mcp__plugin_example_', 'mcp__claude_ai_Example_'];

test('the stream fixtures carry no path of a real machine: no /home/ but /home/ana/, no /tmp/claude-, no -home-', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), [
    'connectors-connected.jsonl', 'connectors-states.jsonl', 'default-run.jsonl', 'denied-run.jsonl', 'isolated-run.jsonl', 'max-turns.jsonl',
  ]);
  for (const file of files) {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    assert.doesNotMatch(text.replaceAll('/home/ana/', ''), /\/home\//, file);
    assert.ok(!text.includes('/tmp/claude-'), file);
    assert.ok(!text.includes('-home-'), file);
    for (const line of text.split('\n').filter((l) => l !== '')) {
      const event = JSON.parse(line);
      if (event.session_id !== undefined) assert.match(event.session_id, /^00000000-0000-4000-8000-00000000000\d$/, file);
      if (event.subtype === 'init') {
        // The default run lists the default built-in set (measured on
        // 24/09/2026); the connector runs, the pinned set and MCP tools;
        // every other fixture, the pinned set.
        if (file.startsWith('connectors-')) {
          const firstMcp = event.tools.findIndex((name) => name.startsWith('mcp__'));
          assert.deepEqual(event.tools.slice(0, firstMcp), CONNECTOR_BUILTINS, file);
          for (const name of event.tools.slice(firstMcp)) assert.ok(CONNECTOR_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)), `${file}: ${name}`);
        } else {
          const expected = file === 'default-run.jsonl' ? DEFAULT_TOOLS : ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch'];
          assert.deepEqual(event.tools, expected, file);
        }
        assert.equal(event.cwd, '/home/ana/vault', file);
      }
    }
  }
});

// --- the process group (ruling R9) -------------------------------------------------
//
// These runs spawn plain node scripts, not a claude of any kind: `claudeBin`
// is this node binary and the script is on the argument vector.

// A parent that starts a grandchild holding the parent's standard output
// and standard error open (as a Bash command the model started would), and
// writes the grandchild's pid to `pidFile`. Then the parent exits at once,
// or sleeps.
function familyScript(pidFile, { parentSleeps, holdsOutput = true }) {
  const stdio = holdsOutput ? "['ignore', 'inherit', 'inherit']" : "'ignore'";
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ${stdio} });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    "process.stdout.write('{\"type\":\"system\",\"subtype\":\"init\",\"permissionMode\":\"dontAsk\",\"mcp_servers\":[]}\\n');",
    parentSleeps ? 'setTimeout(() => {}, 60000);' : 'process.exitCode = 0; g.unref();',
  ].join('\n');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function gone(pid, withinMs = 5000) {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

test('runModel ends a run whose CLI exited while a grandchild still holds its output, and kills that grandchild', { timeout: 60000 }, async () => {
  const dir = makeTempDir('brain-kit-harness-');
  const pidFile = join(dir, 'grandchild.pid');
  const started = Date.now();
  const out = await runModel({
    claudeBin: process.execPath, argv: ['-e', familyScript(pidFile, { parentSleeps: false })], prompt: '', cwd: dir, timeoutMs: 30000, drainGraceMs: 300,
  });
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(Date.now() - started < 10000, 'the run ended well before the grandchild would have');
    assert.equal(out.exitCode, 0);
    assert.equal(out.timedOut, false);
    assert.equal(out.record.init.permissionMode, 'dontAsk');
    assert.equal(await gone(grandchild), true, 'the grandchild is dead');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('runModel on timeout kills the whole process group, the grandchild holding stdout included, and says it timed out', { timeout: 60000 }, async () => {
  const dir = makeTempDir('brain-kit-harness-');
  const pidFile = join(dir, 'grandchild.pid');
  const out = await runModel({
    claudeBin: process.execPath, argv: ['-e', familyScript(pidFile, { parentSleeps: true })], prompt: '', cwd: dir, timeoutMs: 800, killGraceMs: 500,
  });
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, null);
    assert.equal(await gone(grandchild), true, 'the grandchild is dead');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('runModel aborted through its signal kills the group and reports the reason; an onLine that throws aborts the same way', { timeout: 60000 }, async () => {
  const dir = makeTempDir('brain-kit-harness-');
  const pidFile = join(dir, 'grandchild.pid');
  const controller = new AbortController();
  const pending = runModel({
    claudeBin: process.execPath, argv: ['-e', familyScript(pidFile, { parentSleeps: true })], prompt: '', cwd: dir, timeoutMs: 30000, killGraceMs: 500,
    abortSignal: controller.signal, onLine: () => controller.abort('isolation'),
  });
  const out = await pending;
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(out.aborted, 'isolation');
    assert.equal(out.timedOut, false);
    assert.equal(await gone(grandchild), true);
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
  }

  const pidFile2 = join(dir, 'grandchild2.pid');
  const boom = new Error('bad init');
  const started2 = Date.now();
  const out2 = await runModel({
    claudeBin: process.execPath, argv: ['-e', familyScript(pidFile2, { parentSleeps: true })], prompt: '', cwd: dir, timeoutMs: 30000, killGraceMs: 500,
    onLine: () => { throw boom; },
  });
  const grandchild2 = Number(readFileSync(pidFile2, 'utf8'));
  try {
    assert.equal(out2.aborted, boom);
    assert.ok(Date.now() - started2 < 10000, 'stopped at once, not at the timeout');
    assert.equal(await gone(grandchild2), true);
  } finally {
    try { process.kill(grandchild2, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('runModel kills a grandchild that holds nothing open once the CLI has closed', { timeout: 60000 }, async () => {
  const dir = makeTempDir('brain-kit-harness-');
  const pidFile = join(dir, 'grandchild.pid');
  const out = await runModel({
    claudeBin: process.execPath, argv: ['-e', familyScript(pidFile, { parentSleeps: false, holdsOutput: false })], prompt: '', cwd: dir, timeoutMs: 30000,
  });
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(out.exitCode, 0);
    assert.equal(await gone(grandchild, 3000), true, 'the grandchild is dead');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
  }
});
