import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { GENERIC_PATTERNS } from '../src/leak.mjs';

// Generic gate that can live in a public CI: it names no one. Personal patterns
// are enforced by .githooks/pre-push on the maintainer's machine.
//
// Compiled from `GENERIC_PATTERNS` in src/leak.mjs rather than carrying a
// second, hand-copied list of the same six shapes: three uncoordinated
// copies of the same patterns (this test, the push gate, and the scanner
// module itself) is exactly the duplication this codebase has already had
// to fix, in another module, four times over. There is one list; this test
// and the push gate both read it.
const SECRET_PATTERNS = GENERIC_PATTERNS.map((raw) => new RegExp(raw, 'i'));
// gmail.com is not a public-author domain by itself: only this exact address
// (the maintainer's public GitHub-linked address) is allowlisted, so a future
// personal gmail.com address does not slip through as "just another gmail".
const ALLOWED_ADDRESSES = new Set(['aleckyann@gmail.com']);
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net|invalid)|anthropic\.com|users\.noreply\.github\.com)$/;
// A domain has no case, so every address is judged in lower case: one
// written in capitals is the same address, allowed or refused exactly as
// its lower-case spelling is. (Fix round 1 of slice 1C, task 5: the domain
// test was case-sensitive, so an example domain in capitals failed, and a
// real domain was only refused because it failed to match, not because it
// was read.)
function emailAllowed(email) {
  const lower = email.toLowerCase();
  return ALLOWED_ADDRESSES.has(lower) || ALLOWED_EMAIL_DOMAINS.test(lower);
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TEXT_EXT = /\.(mjs|js|json|md|yml|yaml|sh|cmd|txt)$/;
const EXEMPT_FILES = new Set([
  'test/no-leak.test.mjs',
  '.githooks/pre-push',
  'test/pre-push-hook.test.mjs',
  'docs/superpowers/plans/2026-09-18-phase-0-foundation.md',
]);

function trackedTextFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ls-files failed');
  return r.stdout.split('\0').filter((f) => f && (TEXT_EXT.test(f) || f === 'LICENSE' || f.startsWith('.githooks/')));
}

test('no tracked text file contains a secret-looking token', () => {
  for (const file of trackedTextFiles()) {
    if (EXEMPT_FILES.has(file)) continue; // defines or exercises the patterns as fixtures/docs, not real leaks
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test('every e-mail address in tracked files uses an example domain, a public-author domain, or is explicitly allowlisted', () => {
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const email of text.match(EMAIL) ?? []) {
      assert.ok(emailAllowed(email), `${file}: unexpected e-mail domain in ${email}`);
    }
  }
});

test('the e-mail allowlist ignores case in both directions', () => {
  for (const email of ['ana@example.com', 'ANA@EXAMPLE.INVALID', 'Curator@Example.Org', 'AleckYann@Gmail.com']) assert.ok(emailAllowed(email), email);
  // Joined at run time, so this file's own scan never reads them as addresses.
  const refused = [['someone', 'gmail.com'], ['Someone', 'GMAIL.COM'], ['ana', 'example.co'], ['ANA', 'EXAMPLE.COM.EVIL.IO'], ['other', 'Gmail.com']].map((parts) => parts.join('@'));
  for (const email of refused) assert.ok(!emailAllowed(email), email);
});

test('bin/brain-kit.mjs is executable', () => {
  const mode = statSync(join(KIT_ROOT, 'bin', 'brain-kit.mjs')).mode;
  assert.ok(mode & 0o111, 'bin/brain-kit.mjs must have the executable bit set');
});
