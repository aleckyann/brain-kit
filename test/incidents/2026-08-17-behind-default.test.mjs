// docs/incidents.md, 17/08/2026: the local default branch was four commits
// behind. A round started writing without fetching, and the merge collided
// in the log file, because every round touches its first line. The rule:
// fetch and fast-forward the default branch before writing anything.
//
// And 25/08/2026: two rounds of the same day curated the same meeting. The
// rule: the ahead and behind counts of the default branch against its
// remote are the first thing a round learns, before reading a transcript.
//
// Phase 1 (this file, today): `brain-kit sync`, which a round calls first.
// Four commits behind, it fast-forwards and says so with the count; behind
// and ahead at once, it refuses naming both counts and moves nothing,
// because choosing between two histories in silence is the second
// incident. Phase 2 (curate calling sync first) adds its own run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../../src/commands/sync.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { describeLock } from '../../src/guards/lock.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { git } from '../helpers/git-repo.mjs';
import { makeWorld } from '../helpers/sync-world.mjs';

const t = createTranslator('en');

async function sync(world) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runSync([], io, t, { env: world.env, cwd: world.vault });
  return { code, stdout, stderr };
}

test('four commits behind the remote: fast-forwarded before anything is written, with the count said', async () => {
  const world = makeWorld({ prefix: 'brain-kit-incident-0817-' });
  const from = world.sha('main');
  world.publish(4);
  const tip = world.sha('main', world.elsewhere);
  assert.equal(world.sha('main'), from, 'the vault has not fetched: it does not know it is behind');

  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, `${t('sync.fast_forwarded', { branch: 'main', upstream: 'origin/main', behind: 4, from: from.slice(0, 12), to: tip.slice(0, 12) })}\n`);
  assert.equal(world.sha('main'), tip);
  assert.equal(world.sha('HEAD'), tip);
  assert.equal(git(world.vault, ['status', '--porcelain']), '');
  assert.equal(describeLock(world.vault), null);
});

test('behind and ahead at once: refused with both counts, and the local history is left exactly as it was', async () => {
  const world = makeWorld({ prefix: 'brain-kit-incident-0825-' });
  world.commitLocal(1);
  const local = world.sha('main');
  world.publish(4);

  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, `${t('sync.diverged', { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 4 })}\n`);
  assert.equal(world.sha('main'), local);
  assert.equal(world.sha('HEAD'), local);
  assert.equal(describeLock(world.vault), null);
});
