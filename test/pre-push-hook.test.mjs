import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK = join(KIT_ROOT, '.githooks', 'pre-push');

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-prepush-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  mkdirSync(join(work, '.githooks'));
  copyFileSync(HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  git(work, ['config', 'core.hooksPath', '.githooks']);
  git(work, ['remote', 'add', 'origin', bare]);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\nsecret[- ]partner\n');
  return { work, patterns };
}

function commit(work, file, content, message) {
  writeFileSync(join(work, file), content);
  git(work, ['add', file]);
  assert.equal(git(work, ['commit', '-q', '-m', message]).status, 0);
}

test('clean content pushes', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('a personal pattern blocks the push, case-insensitively, naming the file', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('a private key header blocks the push even without a personal pattern', () => {
  const { work, patterns } = setup();
  // Header assembled at runtime so the repository's own leak gate does not trip on this fixture.
  commit(work, 'key.pem', ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') + '\nabc\n', 'key');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in key\.pem/);
});

test('a missing patterns file refuses the push (fail closed)', () => {
  const { work } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leak patterns file not found/);
});

test('a leak buried in an intermediate commit still blocks the push, even after a later commit removes it', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const leakSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  commit(work, 'notes.md', 'Meeting with a partner tomorrow\n', 'scrub');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
  assert.match(r.stderr, new RegExp(leakSha.slice(0, 7)));
});
