// Measured on 24/09/2026 with Claude Code 2.1.281, while writing the plan
// of phase 3 (docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md,
// measurement 3): the claude.ai connectors appear only when the round loads
// the person's user settings, and those bring every allow rule of theirs.
// Phase 2's spike had seen a user hook rewrite `curl` into `rtk curl` and a
// user rule allowing `Bash(rtk curl *)` let the rewritten command run
// (docs/incidents.md, 24/09/2026). With the hooks switched off, the allow
// rule alone still let `rtk curl` run; the same rule mirrored into
// --disallowedTools denied it, because a deny wins over an allow. The
// rule: in connector mode every user allow rule the round would inherit is
// mirrored as a deny, except the ones the round already holds, read rules
// (recorded as widening reads) and rules inside the vault; a rule that
// cannot be mirrored without denying the round's own tools refuses
// connector mode (decision D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, runModel } from '../../src/harness/claude-code.mjs';
import { checkIsolation } from '../../src/guards/isolation.mjs';
import { allowedTools, disallowedTools } from '../../src/curate/tools.mjs';
import { mirrorUserRules, userSettingsFiles } from '../../src/curate/user-rules.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/stream/', import.meta.url));
const FAKE = fileURLToPath(new URL('../helpers/fake-claude.mjs', import.meta.url));

// The measured user settings, in a scratch CLAUDE_CONFIG_DIR: the hook that
// rewrote the command and the allow rule for the rewritten form.
function measuredSettings() {
  const dir = makeTempDir('brain-kit-incident-0924-rules-');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk rewrite-hook' }] }] },
    permissions: { allow: ['Bash(rtk curl *)'] },
  }));
  return dir;
}

test('the rewritten command\'s allow rule reaches neither of the round\'s own lists, and the mirror puts it in the deny list', () => {
  const configDir = measuredSettings();
  const files = userSettingsFiles({ CLAUDE_CONFIG_DIR: configDir });
  assert.deepEqual(files, [join(configDir, 'settings.json')]);
  assert.equal(allowedTools().includes('Bash(rtk curl *)'), false);
  assert.equal(disallowedTools().includes('Bash(rtk curl *)'), false);
  assert.ok(disallowedTools().includes('Bash(curl:*)'), 'the round denies curl, not the form the hook rewrote it into');
  const mirror = mirrorUserRules({ files, ownAllowed: allowedTools(), vaultRoot: '/home/ana/vault', home: '/home/ana' });
  assert.deepEqual(mirror, { deny: ['Bash(rtk curl *)'], widenedReads: [], blocking: [], dropNodeForms: false });
});

test('end to end through the child process: the connector-mode argument vector carries the mirrored deny and switches the hook off', async () => {
  const configDir = measuredSettings();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  const mirror = mirrorUserRules({ files: userSettingsFiles(env), ownAllowed: allowedTools(), vaultRoot: '/home/ana/vault', home: '/home/ana' });
  const disallowed = [...disallowedTools(), ...mirror.deny];
  const argv = buildArgv({ mode: 'connectors', allowed: allowedTools(), disallowed });
  const dir = makeTempDir('brain-kit-incident-0924-rules-run-');
  const argvFile = join(dir, 'argv.json');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ stream: join(FIXTURES, 'connectors-states.jsonl'), argvFile }));
  const out = await runModel({ claudeBin: FAKE, argv, prompt: 'x', cwd: dir, env: { ...env, FAKE_CLAUDE_SCENARIO: scenarioPath }, timeoutMs: 20000 });
  assert.equal(out.exitCode, 0);
  const seen = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.deepEqual(seen, argv);
  assert.equal(seen[seen.indexOf('--setting-sources') + 1], 'user');
  assert.equal(seen[seen.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.equal(seen.includes('--strict-mcp-config'), false);
  const rule = seen.indexOf('Bash(rtk curl *)');
  assert.ok(rule > seen.indexOf('--disallowedTools') && seen.indexOf('--disallowedTools') > seen.indexOf('--allowedTools'), 'the rule sits in the deny list');
  assert.equal(seen.lastIndexOf('Bash(rtk curl *)'), rule, 'and only there');
  // The run reports what the flags promise: dontAsk, no hook event, the pinned tools.
  assert.deepEqual(checkIsolation(out.record, { mode: 'connectors', disallowed }).problems, []);
});
