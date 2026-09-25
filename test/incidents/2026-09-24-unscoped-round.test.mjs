// Measured on 24/09/2026 with Claude Code 2.1.281, while writing the plan
// of phase 3 (docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md,
// measurements 3 and 4): phase 2's round allowed a bare `Read`, which reads
// any file on disk, and ran with the default built-in tools, which also
// expose Task, Workflow, CronCreate, RemoteTrigger, SendMessage, Artifact
// and more in both setting-source modes, plus a Skill tool that loads every
// skill the person installed. Nothing in the round's own checks looked at
// either. The rule: every round passes --disable-slash-commands and --tools
// with the pinned set; the init event's built-in tools must be exactly that
// set, or the model is stopped before it works; and no round allows a path
// or command tool without a scope, so it reads the vault and the files its
// plan lists, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, ROUND_TOOLS, runModel } from '../../src/harness/claude-code.mjs';
import { checkIsolation } from '../../src/guards/isolation.mjs';
import { allowedTools, kitCommand, KIT_SUBCOMMANDS } from '../../src/curate/tools.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/stream/', import.meta.url));
const FAKE = fileURLToPath(new URL('../helpers/fake-claude.mjs', import.meta.url));

// What phase 2's round passed, literally: its isolation flags and its
// allow list.
const PHASE_2_ISOLATION = [
  '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
];
const kit = kitCommand();
const PHASE_2_ALLOWED = [
  'Read', 'Glob', 'Grep', 'Edit(./**)', 'Write(./**)',
  ...KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kit} ${sub}:*)`, `Bash(node ${kit} ${sub}:*)`]),
];

// The built-in tools a run with no --tools listed in its init event, as
// measured (the isolated run has no MCP server, so no MCP tool either).
const DEFAULT_BUILTINS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch',
  'Workflow', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'Artifact',
];

test('the phase 2 allow list, with its bare Read, Glob and Grep, is refused before any round starts', () => {
  assert.throws(() => buildArgv({ allowed: PHASE_2_ALLOWED }), (error) => error instanceof TypeError && error.message.includes('"Read"'));
  for (const bare of ['Read', 'Glob', 'Grep']) assert.throws(() => buildArgv({ allowed: [bare] }), TypeError, bare);
  // What a round allows now reads the vault and the files it names.
  const file = '/home/ana/transcripts/-home-ana-vault/a.jsonl';
  const allowed = allowedTools([], { readFiles: [file] });
  assert.deepEqual(allowed.filter((rule) => /^(Read|Glob|Grep)\b/.test(rule)), [
    'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Read(//home/ana/transcripts/-home-ana-vault/a.jsonl)',
  ]);
  assert.doesNotThrow(() => buildArgv({ allowed }));
});

test('the phase 2 argument vector left the default tools and every skill in; a round now pins the tools and disables skills', () => {
  assert.equal(PHASE_2_ISOLATION.includes('--tools'), false);
  assert.equal(PHASE_2_ISOLATION.includes('--disable-slash-commands'), false);
  const argv = buildArgv({ allowed: allowedTools() });
  assert.deepEqual(argv.slice(0, 11), PHASE_2_ISOLATION.slice(0, 11));
  assert.ok(argv.includes('--disable-slash-commands'));
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch');
  assert.deepEqual([...ROUND_TOOLS], ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'ToolSearch']);
});

test('end to end through the child process: a run whose init reports the default tools is refused, naming each tool beyond the pinned set', async () => {
  const dir = makeTempDir('brain-kit-incident-0924-unscoped-');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ stream: join(FIXTURES, 'isolated-run.jsonl'), rewrite: { tools: DEFAULT_BUILTINS } }));
  const argv = [...PHASE_2_ISOLATION, '--allowedTools', ...PHASE_2_ALLOWED, '--'];
  const out = await runModel({ claudeBin: FAKE, argv, prompt: 'x', cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath }, timeoutMs: 20000 });
  assert.equal(out.exitCode, 0);
  const checked = checkIsolation(out.record);
  assert.deepEqual(checked.problems, ['builtin_tools']);
  assert.deepEqual(checked.details[0].params, {
    extra: 'Task, WebFetch, WebSearch, Skill, Workflow, CronCreate, RemoteTrigger, SendMessage, Artifact', missing: '-',
  });
  // The same stream with the pinned set passes: the check is about the set.
  writeFileSync(scenarioPath, JSON.stringify({ stream: join(FIXTURES, 'isolated-run.jsonl') }));
  const pinned = await runModel({ claudeBin: FAKE, argv: buildArgv({ allowed: allowedTools() }), prompt: 'x', cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath }, timeoutMs: 20000 });
  assert.deepEqual(checkIsolation(pinned.record).problems, []);
});
