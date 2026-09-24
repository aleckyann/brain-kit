// Spike of 24/09/2026 (Claude Code 2.1.281), plan decision 3: a default
// `claude -p` inherited the person's own settings. The init event reported
// permission mode `auto`, a user SessionStart hook ran inside the run, and
// every configured MCP server was attached; under that, a command in
// --disallowedTools and a command outside the allowlist both ran, exit 0,
// no denial reported. The fixture default-run.jsonl is that stream,
// anonymized. The rule: the argument vector always carries the isolation
// flags, and the round reads the init event and stops when it shows any of
// the three, before the model does any work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, runModel } from '../../src/harness/claude-code.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { checkIsolation } from '../../src/guards/isolation.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/stream/', import.meta.url));
const FAKE = fileURLToPath(new URL('../helpers/fake-claude.mjs', import.meta.url));
const read = (name) => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8');

test('the default run, with the person\'s settings inherited, fails isolation on all three counts', () => {
  const record = parseStream(read('default-run'));
  const out = checkIsolation(record);
  assert.equal(out.ok, false);
  assert.deepEqual([...out.problems].sort(), ['hooks', 'mcp', 'permission_mode']);
  // And it is the run where the disallowed command ran with no denial.
  assert.ok(record.toolUses.some((u) => u.input.command === 'curl -s https://example.com'));
  assert.deepEqual(record.denials, []);
});

test('the isolated run passes, and its stream is what the isolation flags produced', () => {
  assert.deepEqual(checkIsolation(parseStream(read('isolated-run'))).problems, []);
  const argv = buildArgv({ allowed: ['Read'] });
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('end to end through the child process: the inherited-settings stream is caught from the round record runModel returns', async () => {
  const dir = makeTempDir('brain-kit-incident-0924-');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ stream: join(FIXTURES, 'default-run.jsonl') }));
  const out = await runModel({ claudeBin: FAKE, argv: buildArgv({}), prompt: 'x', cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath }, timeoutMs: 20000 });
  assert.equal(out.exitCode, 0);
  assert.deepEqual([...checkIsolation(out.record).problems].sort(), ['hooks', 'mcp', 'permission_mode']);
});
