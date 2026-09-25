// docs/incidents.md, 14/09/2026: for three days the step that updates the
// vault died with "Could not resolve hostname", because the round fired at
// resume, before the network was up; curation then ran from a stale base
// and nobody noticed. The rule: the network wait comes before the base
// update, the base update before the configuration and the prompt are
// read, and a test asserts the order by what each step leaves behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCurate } from '../../src/commands/curate.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { git } from '../helpers/git-repo.mjs';
import { FAKE, makeCurateWorld } from '../helpers/curate-world.mjs';

// A configuration change published on the remote by another clone.
function publishConfig(w, edit) {
  git(w.elsewhere, ['pull', '-q', 'origin', 'main']);
  const file = join(w.elsewhere, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  edit(config);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  git(w.elsewhere, ['commit', '-q', '-am', 'config from elsewhere']);
  git(w.elsewhere, ['push', '-q', 'origin', 'main']);
}

test('the configuration the round runs with is the one sync brought in, not the stale one on disk', () => {
  const w = makeCurateWorld();
  publishConfig(w, (c) => { c.curate.max_turns = 7; });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '7');
});

test('no network: nothing is fetched and the base is not touched, exit 69, loudly', async () => {
  const w = makeCurateWorld();
  publishConfig(w, (c) => { c.curate.max_turns = 7; });
  const before = w.sha('main');
  w.setMachine({ network_check: [process.execPath, '-e', 'process.exit(1)'] });
  assert.equal(w.machine.claude_bin, FAKE);
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  // The check runs for real, on a test clock (re-review N6): one attempt
  // spends the whole wait, and no wall-clock limit decides the outcome.
  const clock = { at: 0 };
  const networkDeps = {
    now: () => clock.at,
    sleep: async () => { throw new Error('a second attempt was never meant to run'); },
    runArgv: (argv) => { const done = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' }); clock.at += 1000; return done.status === 0; },
  };
  const status = await runCurate([], io, createTranslator('en'), { env: w.env, cwd: w.vault, networkTimeoutMs: 1000, networkDeps });
  assert.equal(status, EXIT.UNAVAILABLE);
  assert.equal(existsSync(join(w.vault, '.git', 'FETCH_HEAD')), false);
  assert.equal(w.sha('main'), before);
  assert.equal(existsSync(w.files.stdinFile), false);
  assert.match(out.join(''), /no network after waiting/);
  assert.equal(w.lastRun().exit, EXIT.UNAVAILABLE);
  assert.equal(w.notifications().length, 1);
});
