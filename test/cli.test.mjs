import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function run(args, input = '') {
  return spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
}

test('--version prints the package.json version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
  assert.match(r.stdout, /hook/);
});

test('no arguments prints usage and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
});

test('unknown command exits 2 with the command named on stderr', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /definitely-not-a-command/);
  assert.equal(r.stdout, '');
});

test('BRAIN_KIT_LANG=en switches CLI messages', () => {
  const r = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.match(r.stderr, /unknown command/);
});

test('hook stop is a silent no-op in phase 0', () => {
  const r = run(['hook', 'stop'], JSON.stringify({ stop_hook_active: false, cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook session-start is a silent no-op in phase 0', () => {
  const r = run(['hook', 'session-start'], JSON.stringify({ cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook with an unknown event exits 2', () => {
  const r = run(['hook', 'nope'], '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});
