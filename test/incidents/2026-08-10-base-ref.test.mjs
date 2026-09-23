// docs/incidents.md, 10/08/2026: the pull request was opened against
// yesterday's branch. One variable held both the branch to return to and
// the branch to target, so each round's pull request went to the previous
// round's curation branch ("No commits between curator/yesterday and
// curator/today", "Base ref must be a branch"). The rule: origin (the
// current branch) and base (the repository default, read from the remote)
// are two different things, and the pull request always targets the base.
//
// Phase 1 (this file): `brain-kit propose`, run while checked out on a
// previous round's branch that carries a commit never merged. The pull
// request targets main; the commit sits on the remote main's tip, never on
// HEAD, so yesterday's unmerged commit does not ride along; and HEAD is
// still on yesterday's branch afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPropose } from '../../src/commands/propose.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { walkVault } from '../../src/vault.mjs';
import { git } from '../helpers/git-repo.mjs';
import { gitProbe } from '../helpers/sync-world.mjs';
import { BRANCH, NOW, fingerprint, makeProposeWorld, note } from '../helpers/propose-world.mjs';

const t = createTranslator('en');
const YESTERDAY = 'bot/2026-09-22-12-00-00';

async function propose(world, argv) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runPropose(argv, io, t, { env: world.env, cwd: world.vault, now: () => NOW, walkVault, tmpdir: world.tmp });
  return { code, stdout, stderr };
}

function onYesterdaysBranch() {
  const world = makeProposeWorld();
  git(world.vault, ['checkout', '-q', '-b', YESTERDAY]);
  world.write('notes/yesterday.md', note('Yesterday'));
  git(world.vault, ['add', 'notes/yesterday.md']);
  git(world.vault, ['commit', '-q', '-m', 'curate: yesterday']);
  // Yesterday's round pushed its branch and opened its own pull request,
  // which is still open: the remote has the branch, main does not have it.
  git(world.vault, ['push', '-q', '-u', 'origin', YESTERDAY]);
  return world;
}

test('from a previous round\'s branch, the pull request targets main, never that branch', async () => {
  const world = onYesterdaysBranch();
  world.write('notes/today.md', note('Today'));
  const run = await propose(world, ['Today', '--only', 'notes/today.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const create = world.ghCalls().find((call) => call.args[1] === 'create').args;
  assert.equal(create[create.indexOf('--base') + 1], 'main');
  assert.equal(create[create.indexOf('--head') + 1], BRANCH);
  assert.notEqual(BRANCH, YESTERDAY);
  assert.equal(run.stdout, `${t('propose.opened', { url: 'https://example.invalid/ana/vault/pull/7', base: 'main', branch: BRANCH, count: 1, origin: YESTERDAY })}\n`);
});

test('yesterday\'s unmerged commit does not ride into today\'s pull request: the commit sits on the remote main\'s tip', async () => {
  const world = onYesterdaysBranch();
  const main = world.remoteSha('refs/heads/main');
  const yesterday = world.remoteSha(`refs/heads/${YESTERDAY}`);
  world.write('notes/today.md', note('Today'));
  const before = fingerprint(world.vault);
  const run = await propose(world, ['Today', '--only', 'notes/today.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const commit = world.remoteSha(`refs/heads/${BRANCH}`);
  assert.equal(git(world.remote, ['rev-parse', `${commit}^`]).trim(), main);
  assert.notEqual(main, yesterday);
  assert.equal(gitProbe(world.remote, ['merge-base', '--is-ancestor', yesterday, commit]).status, 1, 'yesterday\'s commit is not in the proposal\'s history');
  assert.deepEqual(world.changedIn(commit), ['A\tnotes/today.md']);
  assert.equal(git(world.remote, ['ls-tree', '--name-only', '-r', commit]).includes('notes/yesterday.md'), false);
  assert.deepEqual(fingerprint(world.vault), before, 'HEAD is still on yesterday\'s branch, and nothing local moved');
});
