import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPatterns, scanText, GENERIC_PATTERNS } from '../src/leak.mjs';

// Every secret-shaped fixture in this file is built by runtime string
// concatenation, never as one literal token. Writing one literally would
// give this repository's own push gate (.githooks/pre-push, which carries
// the exact same GENERIC_PATTERNS shapes) a real instance of a secret to
// find in this very commit, and it has already refused a commit for exactly
// this reason once before.
const PRIVATE_KEY_HEADER = ['-----BEGIN ', 'RSA PRIVATE KEY', '-----'].join('');
const GHP_TOKEN = 'ghp_' + 'A'.repeat(36);
const GITHUB_PAT_TOKEN = 'github_pat_' + 'B'.repeat(30);
const ANTHROPIC_KEY = 'sk-ant-' + 'C'.repeat(20);
const AWS_KEY_ID = 'AKIA' + '1'.repeat(16);
const SLACK_TOKEN = 'xoxb-' + 'D'.repeat(15);

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'brain-kit-leak-'));
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// --- GENERIC_PATTERNS: versioned, always applied -----------------------

test('GENERIC_PATTERNS enumerates the six shapes phase 0 protected', () => {
  assert.equal(GENERIC_PATTERNS.length, 6);
});

test('loadPatterns with no arguments returns exactly the generic patterns', () => {
  const patterns = loadPatterns();
  assert.equal(patterns.length, GENERIC_PATTERNS.length);
});

test('scanText finds a private key header built at runtime', () => {
  const patterns = loadPatterns();
  const text = `before\n${PRIVATE_KEY_HEADER}\nafter\n`;
  const result = scanText(text, patterns);
  assert.equal(result.length, 1);
  assert.equal(result[0].line, 2);
});

test('scanText finds both GitHub token shapes', () => {
  const patterns = loadPatterns();
  const text = `${GHP_TOKEN}\n${GITHUB_PAT_TOKEN}\n`;
  const result = scanText(text, patterns);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((m) => m.line).sort(), [1, 2]);
});

test('scanText finds the Anthropic key shape', () => {
  const result = scanText(`token=${ANTHROPIC_KEY}\n`, loadPatterns());
  assert.equal(result.length, 1);
});

test('scanText finds the AWS access key id shape', () => {
  const result = scanText(`id=${AWS_KEY_ID}\n`, loadPatterns());
  assert.equal(result.length, 1);
});

test('scanText finds the Slack token shape', () => {
  const result = scanText(`slack=${SLACK_TOKEN}\n`, loadPatterns());
  assert.equal(result.length, 1);
});

// --- configPatterns: public, may be requested alone ---------------------

test('configPatterns are applied alongside the generic patterns', () => {
  const patterns = loadPatterns({ configPatterns: ['acme-internal-[0-9]{4}'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1);
  const result = scanText('code acme-internal-9911 here\n', patterns);
  assert.equal(result.length, 1);
  assert.equal(result[0].pattern, 'acme-internal-[0-9]{4}');
});

test('a caller may ask for configPatterns alone: no env means no personal file is ever consulted, even if it would be broken', () => {
  // Deliberately no `env` key at all. If loadPatterns tried to read a
  // personal file in this mode it would throw (there is no such file at
  // this made-up path), so a clean return here proves personal loading was
  // skipped entirely, not merely tolerant of absence.
  const patterns = loadPatterns({ configPatterns: ['only-public-[0-9]+'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1);
});

test('a pattern that fails to compile raises naming the pattern and its source, for a public source', () => {
  assert.throws(
    () => loadPatterns({ configPatterns: ['[unterminated'] }),
    (err) => {
      assert.match(err.message, /config/);
      assert.match(err.message, /\[unterminated/);
      return true;
    },
  );
});

// --- personal patterns: fail closed, never printed -----------------------

test('loadPatterns throws when the personal patterns file does not exist', () => {
  const dir = tempDir();
  const missing = join(dir, 'does-not-exist.txt');
  assert.throws(
    () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: missing } }),
    (err) => {
      assert.match(err.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('loadPatterns throws when the personal patterns file has zero bytes', () => {
  const dir = tempDir();
  const file = join(dir, 'fixture-a.txt');
  writeFileSync(file, '');
  assert.throws(() => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }), /no usable pattern/);
});

test('loadPatterns throws when the personal patterns file is only comments and blank lines', () => {
  const dir = tempDir();
  const file = join(dir, 'fixture-b.txt');
  writeFileSync(file, '# nothing here\n\n   \n# still nothing\n');
  assert.throws(() => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }), /no usable pattern/);
});

test('loadPatterns throws when the personal patterns file is a directory rather than a file', () => {
  const dir = tempDir();
  const asDir = join(dir, 'fixture-c');
  mkdirSync(asDir);
  assert.throws(() => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: asDir } }), /not a regular file/);
});

test('loadPatterns throws when the personal patterns file is unreadable', { skip: isRoot() ? 'root bypasses file permissions' : false }, () => {
  const dir = tempDir();
  const file = join(dir, 'locked.txt');
  writeFileSync(file, 'ana-personal-pattern\n');
  chmodSync(file, 0o000);
  try {
    assert.throws(() => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }), /not readable/);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('loadPatterns falls back to a path under the home directory when BRAIN_KIT_LEAK_PATTERNS is unset', () => {
  const fakeHome = tempDir();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.throws(
      () => loadPatterns({ env: {} }),
      (err) => {
        assert.match(err.message, /\.config[/\\]brain-kit[/\\]leak-patterns\.txt/);
        return true;
      },
    );
    mkdirSync(join(fakeHome, '.config', 'brain-kit'), { recursive: true });
    writeFileSync(join(fakeHome, '.config', 'brain-kit', 'leak-patterns.txt'), 'ana-personal-pattern\n');
    const patterns = loadPatterns({ env: {} });
    assert.equal(patterns.length, GENERIC_PATTERNS.length + 1);
  } finally {
    process.env.HOME = realHome;
  }
});

test('loadPatterns reads personal patterns, skipping comments and blank lines, combined with generic and config patterns', () => {
  const dir = tempDir();
  const file = join(dir, 'personal.txt');
  writeFileSync(file, [
    '# household names worth protecting',
    '',
    'ana-personal-[0-9]+',
    '   ',
    '# a trailing comment',
    'ObiWan-secret-project',
  ].join('\n'));
  const patterns = loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file }, configPatterns: ['pub-[0-9]+'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1 + 2);
  const result = scanText('see ana-personal-4471 and ObiWan-secret-project today\n', patterns);
  assert.equal(result.length, 2);
});

test('a pattern that fails to compile from the personal file raises naming the source and line, but never the pattern text itself', () => {
  const dir = tempDir();
  const file = join(dir, 'broken.txt');
  writeFileSync(file, 'fine-one\n[unterminated-personal-regex\nfine-two\n');
  assert.throws(
    () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }),
    (err) => {
      assert.match(err.message, /personal/);
      assert.match(err.message, /line 2/);
      assert.ok(!err.message.includes('unterminated-personal-regex'), 'personal pattern text must never be printed');
      return true;
    },
  );
});

test('every pattern compiles case-insensitively', () => {
  const patterns = loadPatterns({ configPatterns: ['secret-shape-[0-9]{3}'] });
  const result = scanText('SECRET-SHAPE-123\n', patterns);
  assert.equal(result.length, 1);
});

// --- scanText: shape, caps, excerpts --------------------------------------

test('scanText reports a 1-based column, matching the 1-based line convention', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('xxhit\n', patterns);
  assert.equal(result.length, 1);
  // "hit" starts at zero-based index 2, so its 1-based column is 3.
  assert.equal(result[0].column, 3);
});

test('scanText caps results at max and reports truncated with the total', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 8 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns, { max: 3 });
  assert.equal(result.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 8);
});

test('scanText does not report truncation when the total is within max', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('a hit here\n', patterns, { max: 5 });
  assert.equal(result.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.total, 1);
});

test('scanText default max is 5', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 7 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns);
  assert.equal(result.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 7);
});

test('scanText finds a match on the first line and a match on the last line, with no trailing newline', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = 'hit at top\nnothing in the middle\nhit at the very end';
  const result = scanText(text, patterns);
  assert.equal(result.length, 2);
  assert.equal(result[0].line, 1);
  assert.equal(result[1].line, 3);
});

test('scanText reports two matches on one line with distinct columns', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('first hit then another hit here\n', patterns);
  assert.equal(result.length, 2);
  assert.equal(result[0].line, 1);
  assert.equal(result[1].line, 1);
  assert.ok(result[0].column < result[1].column);
});

test('two matches from different patterns on one line come back in column order, not in pattern list order', () => {
  // "later" is declared after "earlier" in configPatterns, but its match
  // sits before "earlier"'s match on the line, so a result that just
  // concatenated per-pattern matches in list order would report them
  // backwards. The result must read left to right regardless of which
  // pattern found which match.
  const patterns = loadPatterns({ configPatterns: ['later-shape', 'earlier-shape'] });
  const result = scanText('earlier-shape then later-shape\n', patterns);
  assert.equal(result.length, 2);
  assert.equal(result[0].pattern, 'earlier-shape');
  assert.equal(result[1].pattern, 'later-shape');
  assert.ok(result[0].column < result[1].column);
});

test('scanText scans a binary-ish input with null bytes as text, with the nulls stripped, rather than skipping it', () => {
  // Built with String.fromCharCode rather than a Unicode escape literal,
  // so the NUL character exists only at runtime and never as a raw byte
  // sitting in this source file.
  const NUL = String.fromCharCode(0);
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = `${NUL}${NUL}binary${NUL}prefix a hit here${NUL}trailer${NUL}`;
  const result = scanText(text, patterns);
  assert.equal(result.length, 1);
  assert.ok(!result[0].excerpt.includes(NUL));
});

test('the excerpt never contains the matched secret text, only surrounding context and a fixed marker', () => {
  const patterns = loadPatterns();
  const text = `line one\nprefix ${AWS_KEY_ID} suffix\nline three\n`;
  const result = scanText(text, patterns);
  assert.equal(result.length, 1);
  assert.ok(!result[0].excerpt.includes(AWS_KEY_ID));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(AWS_KEY_ID), 'the secret must not survive anywhere in the returned structure');
});

test('the excerpt carries only a bounded amount of surrounding context, never the whole line', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const padding = 'x'.repeat(100);
  const result = scanText(`${padding} hit ${padding}\n`, patterns);
  assert.equal(result.length, 1);
  assert.ok(result[0].excerpt.length < padding.length * 2, 'excerpt must be much shorter than the full padded line');
  assert.ok(!result[0].excerpt.includes(padding), 'excerpt must not include the full 100-character padding on either side');
});
