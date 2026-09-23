// docs/incidents.md, 16/09/2026: a scheduled round nearly swept another
// session's work into a pull request. The round ran while another session
// was live editing the scheduler script, its unit files and its test; a
// blanket `git add -A` would have swept that unfinished work in. The rule:
// never stash another session's files, commit explicit paths, and read
// modified files you did not touch as someone else's.
//
// Phase 1 (this file): the session snapshot. Taken at the start of the
// round, it files the other session's files as `before`, even while that
// session keeps editing them, and the round's own work as `since`; and it
// does so without touching, stashing or staging anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeSnapshot, readSnapshot, splitDirty } from '../../src/guards/snapshot.mjs';
import { git, makeRepo, write } from '../helpers/git-repo.mjs';

const text = (paths) => paths.map(String);

const FOREIGN = ['scripts/curate.sh', 'systemd/brain-kit-curate.service', 'systemd/brain-kit-curate.timer', 'tests/curate.test.sh'];

function vaultWithAnotherSessionLive() {
  const committed = { 'index.md': '# Ana\n', 'notes/meeting.md': '# Meeting\n' };
  for (const path of FOREIGN.slice(0, 3)) committed[path] = 'committed\n';
  const root = makeRepo(committed, 'brain-kit-incident-0916-');
  // The other session, mid task: three edits and one new test file.
  for (const path of FOREIGN.slice(0, 3)) write(root, path, 'half-finished edit\n');
  write(root, FOREIGN[3], 'new test, unfinished\n');
  return root;
}

test('the other session\'s files are before, the round\'s own work is since, even while the other session keeps editing', () => {
  const root = vaultWithAnotherSessionLive();
  takeSnapshot(root);

  // The round works.
  write(root, 'notes/meeting.md', '# Meeting\n\nDecided: Ana reviews on Friday.\n');
  write(root, 'notes/follow-up.md', '# Follow-up\n');
  // The other session is still live: it edits its script again, minutes
  // after the round began.
  write(root, 'scripts/curate.sh', 'second half-finished edit\n');

  const split = splitDirty(root, readSnapshot(root));
  assert.deepEqual(text(split.since), ['notes/follow-up.md', 'notes/meeting.md']);
  assert.deepEqual(text(split.before), [...FOREIGN].sort());
});

test('the snapshot and the split never stash, stage or rewrite the other session\'s files', () => {
  const root = vaultWithAnotherSessionLive();
  const contents = Object.fromEntries(FOREIGN.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const statusBefore = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const snapshot = takeSnapshot(root);
  splitDirty(root, snapshot);
  assert.equal(git(root, ['stash', 'list']), '');
  assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'nothing was staged');
  assert.equal(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), statusBefore);
  for (const path of FOREIGN) assert.equal(readFileSync(join(root, path), 'utf8'), contents[path]);
});

// The limit, pinned so no later task mistakes `since` for ownership: a file
// the other session creates AFTER the snapshot is indistinguishable, to a
// snapshot, from the round's own work. This is why `propose --only`, with
// explicit paths, is the normal path.
test('a file the other session creates after the snapshot is filed as since: the snapshot limits a sweep, it does not prove ownership', () => {
  const root = vaultWithAnotherSessionLive();
  takeSnapshot(root);
  write(root, 'notes/meeting.md', '# Meeting\n\nRound edit.\n');
  write(root, 'systemd/brain-kit-curate-retry.timer', 'created by the other session after the snapshot\n');
  assert.deepEqual(text(splitDirty(root, readSnapshot(root)).since), ['notes/meeting.md', 'systemd/brain-kit-curate-retry.timer']);
});
