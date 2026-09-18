import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

// Generic gate that can live in a public CI: it names no one. Personal patterns
// are enforced by .githooks/pre-push on the maintainer's machine.
const SECRET_PATTERNS = [
  /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net|invalid)|anthropic\.com|users\.noreply\.github\.com|gmail\.com)$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TEXT_EXT = /\.(mjs|js|json|md|yml|yaml|sh|cmd|txt)$/;

function trackedTextFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ls-files failed');
  return r.stdout.split('\0').filter((f) => f && (TEXT_EXT.test(f) || f === 'LICENSE' || f.startsWith('.githooks/')));
}

test('no tracked text file contains a secret-looking token', () => {
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (file === 'test/no-leak.test.mjs' || file === '.githooks/pre-push' || file === 'test/pre-push-hook.test.mjs' || file === 'docs/superpowers/plans/2026-09-18-phase-0-foundation.md') continue; // they define or exercise the patterns as fixtures/docs, not real leaks
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test('every e-mail address in tracked files uses an example or public-author domain', () => {
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const email of text.match(EMAIL) ?? []) {
      assert.match(email, ALLOWED_EMAIL_DOMAINS, `${file}: unexpected e-mail domain in ${email}`);
    }
  }
});
