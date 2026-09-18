import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

test('package.json declares no runtime or dev dependencies', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});

test('package is ESM, targets Node 24 and exposes the brain-kit binary', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.bin['brain-kit'], './bin/brain-kit.mjs');
});
