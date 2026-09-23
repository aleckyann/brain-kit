// docs/incidents.md, 08/09/2026: success left the repository on the wrong
// branch. On failure the proposal command returned to the original branch;
// on success it did not, and the next session started on a stale branch,
// which is where the 10/08/2026 base-ref bug came from. The rule: back on
// the origin branch in every outcome, success included, and the pull
// request's base confirmed before the link is handed over.
//
// Phase 1 (this file): `brain-kit propose` builds its commit with git
// plumbing, so HEAD never leaves the origin branch at all. For success, a
// validate failure, a push failure, a gh failure and a gh reporting the
// wrong base, HEAD, the local branches, the index's bytes and every
// working-tree file (bytes, mode, modification time) are identical before
// and after, from a branch and from a detached HEAD alike. The confirmation
// is `gh pr view <branch> --json baseRefName,...`, and a pull request on
// another base is exit 3, never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPropose } from '../../src/commands/propose.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { walkVault } from '../../src/vault.mjs';
import { git } from '../helpers/git-repo.mjs';
import { BRANCH, NOW, fingerprint, makeProposeWorld, note } from '../helpers/propose-world.mjs';

const t = createTranslator('en');

async function propose(world, argv, env = world.env) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runPropose(argv, io, t, { env, cwd: world.vault, now: () => NOW, walkVault, tmpdir: world.tmp });
  return { code, stdout, stderr };
}

const OUTCOMES = [
  ['success', EXIT.OK, () => {}],
  ['a validate failure', EXIT.FAILURE, (world) => world.write('notes/a.md', '---\ntitle: No type\n---\n\n# A\n')],
  ['a push failure', EXIT.FAILURE, (world) => writeFileSync(join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })],
  ['a gh failure', EXIT.DEGRADED, (world) => { world.env.FAKE_GH_MODE = 'fail'; }],
  ['gh reporting another base', EXIT.DEGRADED, (world) => { world.env.FAKE_GH_MODE = 'otherbase'; }],
];

for (const start of ['a branch', 'a detached HEAD']) {
  for (const [label, expected, arrange] of OUTCOMES) {
    test(`from ${start}, after ${label}: HEAD, the branches, the index and the working tree are exactly as they were`, async () => {
      const world = makeProposeWorld();
      git(world.vault, ['checkout', '-q', '-b', 'bot/2026-09-22-12-00-00']);
      if (start === 'a detached HEAD') git(world.vault, ['checkout', '-q', '--detach']);
      world.write('notes/a.md', note('A'));
      world.write('drafts/other-session.md', note('Other'));
      world.write('staged-by-someone.md', note('Staged'));
      git(world.vault, ['add', 'staged-by-someone.md']);
      arrange(world);
      const before = fingerprint(world.vault);
      const run = await propose(world, ['A', '--only', 'notes/a.md']);
      assert.equal(run.code, expected, run.stderr);
      assert.deepEqual(fingerprint(world.vault), before);
      if (expected === EXIT.OK) assert.ok(world.remoteSha(`refs/heads/${BRANCH}`));
    });
  }
}

test('success is exit 0 only once gh confirms the base; a pull request on another base is exit 3 naming the fix', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md'], { ...world.env, FAKE_GH_MODE: 'otherbase' });
  assert.equal(run.code, EXIT.DEGRADED);
  const view = world.ghCalls().find((call) => call.args[1] === 'view');
  assert.deepEqual(view.args, ['pr', 'view', BRANCH, '--json', 'baseRefName,headRefName,url']);
  assert.equal(run.stderr, `${t('propose.degraded_base', { branch: BRANCH, found: `${BRANCH} -> bot/2026-09-22-10-00-00`, base: 'main', command: `gh pr edit ${BRANCH} --base main` })}\n`);
});
