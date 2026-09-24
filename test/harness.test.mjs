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
import { buildArgv, ISOLATION_ARGS, runModel } from '../src/harness/claude-code.mjs';
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
  const allowed = ['Bash("/opt/brain-kit/bin/brain-kit.mjs" validate:*)', 'Bash("/opt/brain-kit/bin/brain-kit.mjs" propose:*)', 'Read'];
  const disallowed = ['Bash(curl:*)', 'WebFetch'];
  const argv = buildArgv({ model: 'claude-opus-5-5', maxTurns: 40, budgetUsd: 1.5, allowed, disallowed });
  assert.deepEqual(argv, [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    '--model', 'claude-opus-5-5', '--max-turns', '40', '--max-budget-usd', '1.5',
    '--allowedTools', ...allowed,
    '--disallowedTools', ...disallowed,
    '--',
  ]);
});

test('buildArgv always carries every isolation flag, and --setting-sources is followed by the empty string as its own element', () => {
  for (const options of [{}, { allowed: ['Read'] }, { model: 'm', maxTurns: 1 }]) {
    const argv = buildArgv(options);
    assert.deepEqual(argv.slice(0, ISOLATION_ARGS.length), [...ISOLATION_ARGS]);
    for (const flag of ['-p', '--verbose', '--strict-mcp-config', '--no-session-persistence']) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
    assert.equal(argv.at(-1), '--');
    assert.equal(argv.indexOf('--'), argv.length - 1);
  }
});

test('buildArgv leaves out what was not set and refuses a rule that would read as an option', () => {
  assert.deepEqual(buildArgv({}), [...ISOLATION_ARGS, '--']);
  assert.throws(() => buildArgv({ allowed: ['--dangerously-skip-permissions'] }), TypeError);
  assert.throws(() => buildArgv({ disallowed: [''] }), TypeError);
  assert.throws(() => buildArgv({ maxTurns: 0 }), TypeError);
  assert.throws(() => buildArgv({ budgetUsd: -1 }), TypeError);
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
  assert.deepEqual(r.toolResults, [{ toolUseId: r.toolUses[0].id, isError: false }]);
  assert.equal(r.result.costUsd, 0.041879);
  assert.equal(r.result.numTurns, 2);
  assert.deepEqual(r.denials, []);
});

test('parseStream reads a denial: the tool result is an error and the denial names the command the model asked for', () => {
  const r = parseStream(fixtureLines('denied-run'));
  const curl = r.toolUses.find((u) => u.input.command === 'curl -s https://example.com');
  assert.deepEqual(r.denials, [{ toolName: 'Bash', toolUseId: curl.id, input: { command: 'curl -s https://example.com', description: 'Fetch example.com' } }]);
  assert.deepEqual(r.toolResults.filter((t) => t.isError), [{ toolUseId: curl.id, isError: true }]);
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

// --- runModel ---------------------------------------------------------------

test('runModel writes the prompt on stdin, passes the argument vector untouched, and returns the child\'s own exit code with the record', async () => {
  const s = scenario({ stream: join(FIXTURES, 'isolated-run.jsonl'), exitCode: 3, stderr: 'something on stderr\n' });
  const argv = buildArgv({ maxTurns: 5, allowed: ['Read'] });
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
    'harness.isolation.permission_mode', 'harness.isolation.mcp', 'harness.isolation.hooks', 'harness.isolation.no_init',
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

test('the stream fixtures carry no path of a real machine: no /home/ but /home/ana/, no /tmp/claude-, no -home-', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), ['default-run.jsonl', 'denied-run.jsonl', 'isolated-run.jsonl', 'max-turns.jsonl']);
  for (const file of files) {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    assert.doesNotMatch(text.replaceAll('/home/ana/', ''), /\/home\//, file);
    assert.ok(!text.includes('/tmp/claude-'), file);
    assert.ok(!text.includes('-home-'), file);
    for (const line of text.split('\n').filter((l) => l !== '')) {
      const event = JSON.parse(line);
      if (event.session_id !== undefined) assert.match(event.session_id, /^00000000-0000-4000-8000-00000000000\d$/, file);
      if (event.subtype === 'init') {
        assert.deepEqual(event.tools, ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'], file);
        assert.equal(event.cwd, '/home/ana/vault', file);
      }
    }
  }
});
