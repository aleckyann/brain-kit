// docs/incidents.md, 13/09/2026: from 13/09 to 16/09/2026 four rounds in a
// row died on the dirty working tree guard with exit code 0. The service
// manager recorded "Finished", each log was 95 bytes long, the high water
// mark stayed at 11/09, and nobody was told. The rule: a guard that only
// postpones names every offending file, with its modification time, and
// the caller exits 75 (TEMPFAIL), never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { checkDirtyTree } from '../../src/guards/dirty-tree.mjs';
import { CLEAN_ENV, makeRepo, write } from '../helpers/git-repo.mjs';

test('13/09/2026 replayed: a leftover from a round is not ok, and is named with its modification time', () => {
  const root = makeRepo({ 'index.md': '# Index\n', 'memory/log.md': '# Log\n' });
  write(root, 'memory/log.md', '# Log\n\n## 2026-09-12\n- **Capture** half written\n');
  write(root, 'people/ana.md', 'draft\n');
  const leftover = new Date('2026-09-12T23:58:00Z');
  utimesSync(join(root, 'memory/log.md'), leftover, leftover);
  const r = checkDirtyTree(root, null, { env: CLEAN_ENV });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files.map((f) => f.path), ['memory/log.md', 'people/ana.md']);
  assert.equal(r.files[0].mtime, '2026-09-12T23:58:00.000Z');
  assert.ok(r.files.every((f) => typeof f.mtime === 'string'));
});

test('the code a postponing guard maps to is 75, and 75 is not success', () => {
  assert.equal(EXIT.TEMPFAIL, 75);
  assert.notEqual(EXIT.TEMPFAIL, EXIT.OK);
});

test('one dirty file is enough: there is no threshold under which the guard stays quiet', () => {
  const root = makeRepo({ 'index.md': '# Index\n' });
  write(root, 'x.md', 'x\n');
  const r = checkDirtyTree(root, null, { env: CLEAN_ENV });
  assert.deepEqual([r.ok, r.files.length], [false, 1]);
});
