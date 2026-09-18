import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.equal(pkg.bin['brain-kit'], 'bin/brain-kit.mjs');
  // the npm name differs from the command name because the registry refused
  // brain-kit as too similar to an existing package
  assert.equal(pkg.name, 'second-brain-kit');
  assert.deepEqual(Object.keys(pkg.bin), ['brain-kit']);
});

test('the published tarball does not ship the internal superpowers docs', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  // npm has shipped `pack --json` as a top-level array, and (this host's npm)
  // as an object keyed by package name; accept either shape.
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const paths = report.files.map((f) => f.path);
  assert.ok(paths.length > 0, 'npm pack reported no files');
  assert.ok(
    paths.every((p) => !p.startsWith('docs/superpowers/')),
    `tarball contains internal docs: ${paths.filter((p) => p.startsWith('docs/superpowers/')).join(', ')}`,
  );
});
