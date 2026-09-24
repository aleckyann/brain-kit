// Found while planning phase 2, 24/09/2026 (not yet an incident in
// production, and this file exists so it never becomes one). A scheduled
// round holds the vault's lock for its whole run, and the one writing
// command it lets the model run, `propose`, takes that same lock: without a
// way in, the round's own proposal is refused with 75 every time. And a
// proposal that succeeds leaves the proposed files in the working tree by
// design, so the next round would stop on its dirty tree guard with 75, day
// after day: the shape of the four silent days of 13/09/2026.
//
// Phase 2, task 5 (this file): the round's `propose` joins the lock the
// round holds, never releases it, and records what it pushed, so the round
// can clean up after it (task 6 adds the cleanup to this file's story).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, describeLock } from '../../src/guards/lock.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { GUARD_FILES } from '../../src/guards/location.mjs';
import { KIT_ROOT } from '../../src/version.mjs';
import { makeProposeWorld, note } from '../helpers/propose-world.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

function proposeProcess(world, env) {
  return spawnSync(process.execPath, [BIN, 'propose', 'Round notes', '--only', 'notes/meeting.md', 'notes/follow-up.md'], {
    cwd: world.vault, env, encoding: 'utf8',
  });
}

test('the round\'s own propose, run as a separate process with the round\'s token, opens the pull request under the round\'s lock and records what it pushed', () => {
  const world = makeProposeWorld();
  const patterns = join(world.base, 'leak-patterns.txt');
  writeFileSync(patterns, 'zz-no-such-leak-zz\n');
  world.write('notes/meeting.md', note('Meeting'));
  world.write('notes/follow-up.md', note('Follow-up'));
  world.write('notes/unfinished.md', note('Unfinished'));

  // The round, as `curate` will: the lock, held by a live process (this one).
  const round = acquireLock(world.vault, { command: 'curate', env: world.env });
  const lockFile = join(world.vault, '.git', GUARD_FILES.LOCK);
  const lockBytes = readFileSync(lockFile);
  const env = { ...world.env, BRAIN_KIT_LEAK_PATTERNS: patterns, BRAIN_KIT_LANG: 'en' };
  try {
    // Without the token, the round's propose is refused by the round's lock.
    const refused = proposeProcess(world, env);
    assert.equal(refused.status, EXIT.TEMPFAIL, refused.stderr);
    assert.deepEqual(world.ghCalls(), []);

    // With it, the model's propose joins.
    const run = proposeProcess(world, { ...env, BRAIN_KIT_ROUND_TOKEN: round.token });
    assert.equal(run.status, EXIT.OK, run.stderr);
    const creates = world.ghCalls().filter((call) => call.args[1] === 'create');
    assert.equal(creates.length, 1, 'the pull request is opened');
    assert.equal(creates[0].args[creates[0].args.indexOf('--base') + 1], 'main');
    assert.equal(`${run.stdout}${run.stderr}${refused.stdout}${refused.stderr}`.includes(round.token), false, 'the token is never printed');

    const recordFile = join(world.vault, '.git', `brain-kit-round-${round.token}.json`);
    const record = JSON.parse(readFileSync(recordFile, 'utf8'));
    const branch = creates[0].args[creates[0].args.indexOf('--head') + 1];
    assert.match(branch, /^bot\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    const commit = world.remoteSha(`refs/heads/${branch}`);
    assert.ok(commit, 'the branch is on the remote');
    assert.deepEqual(record, {
      format: 1, opened: true, remote: 'origin', branch, commit, paths: ['notes/follow-up.md', 'notes/meeting.md'],
    });
    assert.deepEqual(world.changedIn(commit).map((entry) => entry.split('\t')[1]), record.paths, 'the record names exactly what the commit changed');
    assert.equal(statSync(recordFile).mode & 0o777, 0o600);

    // The lock is still the round's, byte for byte.
    assert.deepEqual(readFileSync(lockFile), lockBytes);
    assert.equal(describeLock(world.vault, { env: world.env }).pid, process.pid);
    assert.equal(describeLock(world.vault, { env: world.env }).command, 'curate');
    assert.deepEqual(readdirSync(join(world.vault, '.git')).filter((name) => name.startsWith('brain-kit-round-')), [`brain-kit-round-${round.token}.json`]);
  } finally {
    assert.equal(round.release(), true, 'the round releases its own lock');
  }
});
