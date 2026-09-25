#!/usr/bin/env node
// A stand-in for the `claude` CLI, for tests. It never calls a model.
//
// It reads a scenario from the JSON file named in FAKE_CLAUDE_SCENARIO:
//
//   {
//     "version": "2.1.281 (Claude Code)",   printed for --version
//     "versionExit": 0,
//     "argvFile": "<path>",                 the argument vector, as JSON
//     "stdinFile": "<path>",                standard input, verbatim
//     "recordFile": "<path>",               one JSON line per `run` action
//     "actions": [                          performed in the working directory, in order
//       { "write": { "path": "<relative>", "content": "..." } },
//       { "run": ["<argv0>", "<arg>", ...] }
//     ],
//     "stream": "<path to a .jsonl fixture>",
//     "rewrite": {                          optional edits to the stream
//       "replace": [["from", "to"], ...],   plain text, over the whole stream
//       "permissionMode": "auto",           on the init event
//       "mcpServers": [{ "name", "status" }],
//       "tools": ["Read", ...],             the init event's tool list, replaced
//       "hookEvent": true,                  a hook_started event before init
//       "hookAfterInit": true,              a PreToolUse hook_started event right after init
//       "dropInit": true,
//       "toolUses": [{ "name", "input", "isError" }],  added before the result
//       "finalText": "...",                 an assistant text and result.result
//       "dropResult": true,
//       "appendLines": ["raw line", ...]
//     },
//     "stderr": "...",
//     "exitCode": 0,
//     "delayMs": 0,                         after the stream, before exiting
//     "killSelf": "SIGKILL"                 after the stream is written, die by this signal
//   }
//
// It validates its argument vector the way Claude Code 2.1.281 did when
// measured on 24/09/2026: `-p --output-format stream-json` without
// `--verbose` exits 1 with the real error text. Anything after `--` is
// refused, because the kit sends the prompt on standard input and never as
// an argument. The actions run with this process's own environment, so a
// variable the caller set for `claude` reaches them, as it does for the
// commands a real model runs through Bash.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
// `node --test` runs every file under test/, this one included, with no
// argument and no scenario: then there is nothing to do.
if (!scenarioPath && argv.length === 0) process.exit(0);
if (!scenarioPath) {
  process.stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO is not set\n');
  process.exit(70);
}
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

if (scenario.argvFile) writeFileSync(scenario.argvFile, JSON.stringify(argv));

if (argv.includes('--version')) {
  process.stdout.write(`${scenario.version ?? '2.1.281 (Claude Code)'}\n`);
  process.exit(scenario.versionExit ?? 0);
}

const formatAt = argv.indexOf('--output-format');
const streamJson = formatAt !== -1 && argv[formatAt + 1] === 'stream-json';
if (argv.includes('-p') && streamJson && !argv.includes('--verbose')) {
  process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
  process.exit(1);
}
const dashes = argv.indexOf('--');
if (dashes !== -1 && dashes !== argv.length - 1) {
  process.stderr.write('fake-claude: arguments after --; the prompt must come on standard input\n');
  process.exit(64);
}

const stdin = readFileSync(0, 'utf8');
if (scenario.stdinFile) writeFileSync(scenario.stdinFile, stdin);

for (const action of scenario.actions ?? []) {
  if (action.write) {
    const rel = normalize(action.write.path);
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`fake-claude: write outside the working directory: ${action.write.path}`);
    const target = join(process.cwd(), rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, action.write.content);
  } else if (action.run) {
    const [cmd, ...args] = action.run;
    const r = spawnSync(cmd, args, { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
    if (scenario.recordFile) {
      appendFileSync(scenario.recordFile, `${JSON.stringify({ argv: action.run, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error ? r.error.code : null })}\n`);
    }
  }
}

function buildStream() {
  if (!scenario.stream) return [];
  let text = readFileSync(scenario.stream, 'utf8');
  const rw = scenario.rewrite ?? {};
  for (const [from, to] of rw.replace ?? []) text = text.split(from).join(to);
  let events = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  const initAt = events.findIndex((e) => e.type === 'system' && e.subtype === 'init');
  const init = events[initAt];
  const session = init ? init.session_id : '00000000-0000-4000-8000-000000000000';
  if (init && rw.permissionMode !== undefined) init.permissionMode = rw.permissionMode;
  if (init && rw.mcpServers !== undefined) init.mcp_servers = rw.mcpServers;
  if (init && rw.tools !== undefined) init.tools = rw.tools;
  if (rw.dropInit) events = events.filter((e) => e !== init);
  if (rw.hookEvent) {
    const hook = { type: 'system', subtype: 'hook_started', hook_id: '00000000-0000-4000-a000-00000000000f', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', uuid: '00000000-0000-4000-9000-0000000000ff', session_id: session };
    const at = events.indexOf(init);
    events.splice(at === -1 ? 0 : at, 0, hook);
  }
  if (rw.hookAfterInit) {
    const hook = { type: 'system', subtype: 'hook_started', hook_id: '00000000-0000-4000-a000-00000000001f', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', uuid: '00000000-0000-4000-9000-0000000001ff', session_id: session };
    const at = events.indexOf(init);
    events.splice(at === -1 ? 0 : at + 1, 0, hook);
  }
  const resultAt = () => {
    const at = events.findIndex((e) => e.type === 'result');
    return at === -1 ? events.length : at;
  };
  (rw.toolUses ?? []).forEach((use, i) => {
    const id = `toolu_fake_added_${i + 1}`;
    const assistant = { type: 'assistant', message: { id: `msg_fake_added_${i + 1}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: use.name, input: use.input }] }, parent_tool_use_id: null, session_id: session };
    const user = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: use.isError === true, content: use.isError ? 'error' : 'ok' }] }, parent_tool_use_id: null, session_id: session };
    events.splice(resultAt(), 0, assistant, user);
  });
  if (rw.finalText !== undefined) {
    events.splice(resultAt(), 0, { type: 'assistant', message: { id: 'msg_fake_final', type: 'message', role: 'assistant', content: [{ type: 'text', text: rw.finalText }] }, parent_tool_use_id: null, session_id: session });
    const result = events.find((e) => e.type === 'result');
    if (result) result.result = rw.finalText;
  }
  if (rw.dropResult) events = events.filter((e) => e.type !== 'result');
  return [...events.map((e) => JSON.stringify(e)), ...(rw.appendLines ?? [])];
}

const lines = buildStream();
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.killSelf) {
  process.stdout.write(lines.length > 0 ? `${lines.join('\n')}\n` : '', () => process.kill(process.pid, scenario.killSelf));
  setTimeout(() => {}, 60000);
} else if (lines.length > 0) {
  process.stdout.write(`${lines.join('\n')}\n`);
}

// exitCode, not exit(): exit() can cut a pipe write short on some systems.
process.exitCode = scenario.exitCode ?? 0;
if (scenario.delayMs) setTimeout(() => {}, scenario.delayMs);
