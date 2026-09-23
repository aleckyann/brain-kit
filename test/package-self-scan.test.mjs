// The files the package ships must not match the credential shapes the
// package itself ships. A vault that ran `npm install` without ignoring
// node_modules/ had every file brain-kit ships read by its own `secrets`
// rule, and was told to rotate five credentials that did not exist
// (measured in slice B, 22/09/2026). The vault carries no package any more
// (templates/githooks/pre-push finds brain-kit on PATH), but a person can
// still commit a copy of it, and a false refusal over the engine's own
// files is the kind a person learns to bypass. So every file `npm pack`
// would ship is scanned here with the generic shapes, loadPatterns({}),
// exactly as a vault's gate reads them, and the answer must be none.
//
// A match found here is fixed in the shipped file (build the literal at
// runtime, or write the shape as the pattern that recognises it), never by
// leaving the file out of this scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { decodeBytes } from '../src/io.mjs';
import { loadPatterns, scanText } from '../src/leak.mjs';

function shippedFiles() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  // Either shape npm has shipped `pack --json` in (see test/zero-deps.test.mjs).
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return report.files.map((file) => file.path);
}

test('no file the package ships matches the credential shapes the package ships', () => {
  const paths = shippedFiles();
  // The precondition: the scan covers the engine, not an empty list.
  assert.ok(paths.includes('src/leak.mjs'), `npm pack did not list src/leak.mjs: ${paths.slice(0, 5).join(', ')}`);
  assert.ok(paths.includes('templates/githooks/pre-push'), 'npm pack did not list the template hook');
  const shapes = loadPatterns({});
  assert.ok(shapes.length > 0, 'no generic shapes were loaded');
  const found = [];
  for (const path of paths) {
    const text = decodeBytes(readFileSync(join(KIT_ROOT, path)));
    const result = scanText(text, shapes, { accrue: true, deadlineAt: Date.now() + 60000 });
    for (const match of result.matches) found.push(`${path}:${match.line} (${match.pattern})`);
  }
  assert.deepEqual(found, [], `shipped files match a shipped credential shape:\n  ${found.join('\n  ')}`);
});
