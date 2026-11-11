// docs/incidents.md, 11/11/2026: a key written eighteen times, read as once.
// Five notes of the original vault reached up to eighteen `generated` lines
// in their frontmatter: merge conflicts resolved by keeping both sides, then
// curator rounds that added a line above the others instead of replacing
// it. YAML allows a key once per mapping, the kit's readers stop at the
// first line, and `validate` passed every day it ran. The rule: a top-level
// key written twice is a finding, and under the default validate.fail_on it
// fails the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { makeVault } from '../helpers/vault-fixture.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

// Newest first, the order the curator rounds wrote them in.
const STAMPS = Array.from({ length: 18 }, (_, i) => `generated: { by: brain-kit-curator/model, at: 2026-11-${String(28 - i).padStart(2, '0')}T09:30:00-03:00 }`);

function vaultWith(stamps) {
  const person = ['---', 'type: person', 'description: an example person', ...stamps, '---', '# Ana', ''].join('\n');
  return makeVault({ files: { 'index.md': '# Welcome\n', 'memory/log.md': '## 2026-11-11\n\nOne entry.\n', 'people/ana.md': person }, config: { lang: 'en' } });
}

function validate(root) {
  return spawnSync(process.execPath, [BIN, 'validate', root, '--json'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
}

test('eighteen generated lines fail validate under the default fail_on, and keeping the newest one passes', () => {
  const broken = validate(vaultWith(STAMPS));
  assert.equal(broken.status, EXIT.FAILURE);
  const { findings } = JSON.parse(broken.stdout);
  assert.deepEqual(findings.map((f) => [f.id, f.file, f.params.key, f.params.count]), [['unique-keys', 'people/ana.md', 'generated', 18]]);

  assert.equal(validate(vaultWith(STAMPS.slice(0, 1))).status, EXIT.OK);
});
