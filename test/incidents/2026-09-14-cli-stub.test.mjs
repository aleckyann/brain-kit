// docs/incidents.md, 14/09/2026: a reinstall skipped its post install step
// and left a launcher of about 500 bytes where the native binary should be.
// For two days every round died on it; PATH found the file, and `--version`
// printed error text instead of a number. The rule: before a round, the CLI
// must be a real file of real size whose `--version` starts with a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCli, STUB_MAX_BYTES } from '../../src/guards/cli.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

test('a 500 byte launcher is a stub, not a CLI, whether named by path or found on PATH', () => {
  const dir = makeTempDir('brain-kit-incident-0914-');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/bin/sh\n# launcher\n${'#'.repeat(500 - 22)}\n`, { mode: 0o755 });
  const byPath = checkCli(stub);
  assert.deepEqual([byPath.ok, byPath.problem, byPath.version], [false, 'stub', null]);
  assert.equal(byPath.params.bytes, 500);
  assert.equal(checkCli('claude', { env: { PATH: dir } }).problem, 'stub');
});

test('the line is 2 KB: one byte under is a stub, at 2 KB the version decides', () => {
  const dir = makeTempDir('brain-kit-incident-0914-');
  const under = join(dir, 'under');
  writeFileSync(under, `#!/bin/sh\necho 2.1.281\n${'#'.repeat(STUB_MAX_BYTES - 1 - 24)}\n`, { mode: 0o755 });
  assert.equal(checkCli(under).problem, 'stub');
  const at = join(dir, 'at');
  writeFileSync(at, `#!/bin/sh\necho 2.1.281\n${'#'.repeat(STUB_MAX_BYTES - 24)}\n`, { mode: 0o755 });
  assert.deepEqual([checkCli(at).ok, checkCli(at).version], [true, '2.1.281']);
});
