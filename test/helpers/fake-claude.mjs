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
//       "toolUses": [{ "name", "input", "isError", "content", "emulate" }],
//                                           added before the result; `content` is
//                                           the tool result's text (a connector
//                                           answers JSON text), "ok" or "error" by
//                                           default; a Read with "emulate": true is
//                                           answered as Claude Code's Read answers
//                                           it: denied when no Read rule of the
//                                           --allowedTools allows its path, and
//                                           otherwise ./read-tool.mjs (missing,
//                                           over 256 KB whole, 25 000 tokens a slice)
//       "readGranted": true | ["text", ...], a Read, emulated, of every exact
//                                           file a `Read(//<path>)` rule of the
//                                           --allowedTools grants (or of those
//                                           whose path holds one of the texts),
//                                           added before `toolUses`: what a model
//                                           that reads what it is handed does
//       "finalText": "...",                 an assistant text and result.result
//       "dropResult": true,
//       "appendLines": ["raw line", ...]
//     },
//     "stderr": "...",
//     "exitCode": 0,
//     "delayMs": 0,                         after the stream, before exiting
//     "killSelf": "SIGKILL",                after the stream is written, die by this signal
//     "launches": [{ ... }, { ... }],       per model launch (every run but
//                                           --version), fields laid over the
//                                           scenario's own, the last entry
//                                           repeating for later launches
//     "readLog": "<path>",                  one JSON line per emulated Read:
//                                           { path, isError, content, text, mode,
//                                           dirMode }, `text` the file's own text
//     "launchCountFile": "<path>",          how many model launches ran so far
//     "launchLog": "<path>"                 one JSON line per model launch:
//                                           { launch, argv, stdin }
//   }
//
// It validates its argument vector the way Claude Code 2.1.281 did when
// measured on 24/09/2026: `-p --output-format stream-json` without
// `--verbose` exits 1 with the real error text. Anything after `--` is
// refused, because the kit sends the prompt on standard input and never as
// an argument. The actions run with this process's own environment, so a
// variable the caller set for `claude` reaches them, as it does for the
// commands a real model runs through Bash.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { emulateRead } from './read-tool.mjs';

const argv = process.argv.slice(2);
const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
// `node --test` runs every file under test/, this one included, with no
// argument and no scenario: then there is nothing to do.
if (!scenarioPath && argv.length === 0) process.exit(0);
if (!scenarioPath) {
  process.stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO is not set\n');
  process.exit(70);
}
const base = JSON.parse(readFileSync(scenarioPath, 'utf8'));

if (base.argvFile) writeFileSync(base.argvFile, JSON.stringify(argv));

if (argv.includes('--version')) {
  process.stdout.write(`${base.version ?? '2.1.281 (Claude Code)'}\n`);
  process.exit(base.versionExit ?? 0);
}

// Which model launch this is (a round that relaunches runs the CLI twice),
// and the scenario for it.
let launch = 1;
if (base.launchCountFile) {
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(base.launchCountFile, 'utf8'), 10) || 0;
  } catch {
    count = 0;
  }
  launch = count + 1;
  writeFileSync(base.launchCountFile, String(launch));
}
const launches = Array.isArray(base.launches) ? base.launches : [];
const scenario = launches.length > 0 ? { ...base, ...launches[Math.min(launch, launches.length) - 1] } : base;

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
if (scenario.launchLog) appendFileSync(scenario.launchLog, `${JSON.stringify({ launch, argv, stdin })}\n`);

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

// The exact files the --allowedTools grant with a `Read(//<path>)` rule (a
// rule with a wildcard, such as a folder's `/**`, is not one), as Read uses
// of each, emulated: all of them for `true`, those whose path holds one of
// the texts for a list.
function grantedReads(which) {
  if (which !== true && !Array.isArray(which)) return [];
  return allowedRules()
    .map((rule) => /^Read\(\/\/(.+)\)$/.exec(rule)?.[1])
    .filter((path) => path !== undefined && !path.includes('*'))
    .map((path) => `/${path}`)
    .filter((path) => which === true || which.some((text) => path.includes(text)))
    .map((path) => ({ name: 'Read', input: { file_path: path }, emulate: true }));
}

// The rules after --allowedTools, up to the next option.
function allowedRules() {
  const at = argv.indexOf('--allowedTools');
  if (at === -1) return [];
  const rules = [];
  for (const arg of argv.slice(at + 1)) {
    if (arg.startsWith('--')) break;
    rules.push(arg);
  }
  return rules;
}

// Whether an emulated Read of `path` is allowed, the way `dontAsk` decides
// it for the rules a round passes: inside the working directory
// (`Read(./**)`), an exact file (`Read(//<path>)`), or under a folder
// (`Read(//<folder>/**)`). Anything else is denied, as the real CLI denies it.
function readAllowed(path) {
  if (typeof path !== 'string') return false;
  return allowedRules().some((rule) => {
    if (rule === 'Read(./**)') return path.startsWith(`${process.cwd()}/`);
    const scope = /^Read\(\/\/(.+)\)$/.exec(rule)?.[1];
    if (scope === undefined) return false;
    if (scope.endsWith('/**')) return path.startsWith(`/${scope.slice(0, -2)}`);
    return !scope.includes('*') && path === `/${scope}`;
  });
}

// A file's mode and its folder's, as octal permission bits, or null.
function modes(path) {
  const of = (p) => {
    try {
      return (statSync(p).mode & 0o777).toString(8);
    } catch {
      return null;
    }
  };
  return { mode: of(path), dirMode: of(dirname(path)) };
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
  [...grantedReads(rw.readGranted), ...(rw.toolUses ?? [])].forEach((use, i) => {
    const id = `toolu_fake_added_${i + 1}`;
    const assistant = { type: 'assistant', message: { id: `msg_fake_added_${i + 1}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: use.name, input: use.input }] }, parent_tool_use_id: null, session_id: session };
    let isError = use.isError === true;
    let content = typeof use.content === 'string' ? use.content : (isError ? 'error' : 'ok');
    if (use.emulate === true && use.name === 'Read') {
      const answer = readAllowed(use.input?.file_path) ? emulateRead(use.input) : { isError: true, content: 'Permission to use Read has been denied.', text: null };
      isError = answer.isError;
      content = answer.content;
      if (scenario.readLog) appendFileSync(scenario.readLog, `${JSON.stringify({ path: use.input.file_path, isError, content: isError ? content : null, text: answer.text, ...modes(use.input.file_path) })}\n`);
    }
    const user = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: null, session_id: session };
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
