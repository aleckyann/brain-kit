import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPatterns, scanText, GENERIC_PATTERNS, OVERALL_SCAN_TIMEOUT_MS } from '../src/leak.mjs';

const CATASTROPHIC_SCAN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'leak', 'catastrophic-scan.mjs');

// Every secret-shaped fixture in this file is built by runtime string
// concatenation, never as one literal token, and every made-up pattern
// name is a fictional shape (never this or any real organisation's name).
// Writing a real secret literally, or naming a real household, is exactly
// what this repository's own push gate exists to catch, and it has
// already refused a commit for each once.
const PRIVATE_KEY_HEADER = ['-----BEGIN ', 'RSA PRIVATE KEY', '-----'].join('');
const GHP_TOKEN = 'ghp_' + 'A'.repeat(36);
const GITHUB_PAT_TOKEN = 'github_pat_' + 'B'.repeat(30);
const ANTHROPIC_KEY = 'sk-ant-' + 'C'.repeat(20);
const AWS_KEY_ID = 'AKIA' + '1'.repeat(16);
const SECOND_AWS_KEY_ID = 'AKIA' + '2'.repeat(16);
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
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].line, 2);
});

test('scanText finds both GitHub token shapes', () => {
  const patterns = loadPatterns();
  const text = `${GHP_TOKEN}\n${GITHUB_PAT_TOKEN}\n`;
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map((m) => m.line).sort(), [1, 2]);
});

test('scanText finds the Anthropic key shape', () => {
  const result = scanText(`token=${ANTHROPIC_KEY}\n`, loadPatterns());
  assert.equal(result.matches.length, 1);
});

test('scanText finds the AWS access key id shape', () => {
  const result = scanText(`id=${AWS_KEY_ID}\n`, loadPatterns());
  assert.equal(result.matches.length, 1);
});

test('scanText finds the Slack token shape', () => {
  const result = scanText(`slack=${SLACK_TOKEN}\n`, loadPatterns());
  assert.equal(result.matches.length, 1);
});

// --- configPatterns: public, may be requested alone ---------------------

test('configPatterns are applied alongside the generic patterns', () => {
  const patterns = loadPatterns({ configPatterns: ['fixture-internal-[0-9]{4}'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1);
  const result = scanText('code fixture-internal-9911 here\n', patterns);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].pattern, 'fixture-internal-[0-9]{4}');
});

test('a caller may ask for configPatterns alone: no env means no personal file is ever consulted, even if it would be broken', () => {
  // Deliberately no `env` key at all. If loadPatterns tried to read a
  // personal file in this mode it would throw (there is no such file at
  // this made-up path), so a clean return here proves personal loading was
  // skipped entirely, not merely tolerant of absence.
  const patterns = loadPatterns({ configPatterns: ['only-public-[0-9]+'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1);
});

test('loadPatterns treats env: null as "yes, include personal patterns" (presence, not truthiness), so it attempts the real default path rather than silently skipping', () => {
  // If loadPatterns tested truthiness instead of presence, `env: null`
  // would read as "no env given" and quietly fall back to generic and
  // config patterns only: failing OPEN exactly like the shell version's
  // signature failure. Pointing HOME at a directory with no personal file
  // proves the opposite: it still tries, and still fails closed.
  const fakeHome = tempDir();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.throws(() => loadPatterns({ env: null }), /leak-patterns\.txt/);
  } finally {
    process.env.HOME = realHome;
  }
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

test('an empty string in configPatterns is rejected at compile time, naming why, rather than compiled into a pattern that matches everywhere', () => {
  assert.throws(() => loadPatterns({ configPatterns: [''] }), /cannot be empty/);
});

// --- personal patterns: fail closed, never printed -----------------------

test('loadPatterns throws when the personal patterns file does not exist', () => {
  const dir = tempDir();
  const missing = join(dir, 'does-not-exist.txt');
  assert.throws(
    () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: missing } }),
    (err) => {
      assert.match(err.message, /not found/);
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
  writeFileSync(file, 'fixture-personal-pattern\n');
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
    writeFileSync(join(fakeHome, '.config', 'brain-kit', 'leak-patterns.txt'), 'fixture-personal-pattern\n');
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
    'fixture-personal-[0-9]+',
    '   ',
    '# a trailing comment',
    'fixture-secret-project',
  ].join('\n'));
  const patterns = loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file }, configPatterns: ['pub-[0-9]+'] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length + 1 + 2);
  const result = scanText('see fixture-personal-4471 and fixture-secret-project today\n', patterns);
  assert.equal(result.matches.length, 2);
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

test('the personal compile-failure line number counts FILE lines, not the lines left after comments and blanks are filtered', () => {
  const dir = tempDir();
  const file = join(dir, 'broken-with-comments.txt');
  // File line 1: comment. Line 2: usable ("fine-one"). Line 3: blank.
  // Line 4: the broken pattern. Line 5: usable ("fine-two"). Counted over
  // USABLE lines alone, the broken one would be "line 2" (its position
  // among ["fine-one", "[unterminated...", "fine-two"]); counted over the
  // file, which is correct, it is "line 4".
  writeFileSync(file, [
    '# a comment',
    'fine-one',
    '',
    '[unterminated-personal-regex',
    'fine-two',
  ].join('\n'));
  assert.throws(
    () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }),
    (err) => {
      assert.match(err.message, /line 4/);
      assert.ok(!err.message.includes('line 2'), 'must not report the position in the filtered list');
      return true;
    },
  );
});

test('every pattern compiles case-insensitively', () => {
  const patterns = loadPatterns({ configPatterns: ['secret-shape-[0-9]{3}'] });
  const result = scanText('SECRET-SHAPE-123\n', patterns);
  assert.equal(result.matches.length, 1);
});

// --- CRITICAL: a personal pattern's own text is never in a finding -------

test('a finding for a personal-origin match never carries the personal pattern text: it carries a fixed neutral label instead', () => {
  const dir = tempDir();
  const file = join(dir, 'personal.txt');
  const householdShape = 'fixture-household-name-[0-9]+';
  writeFileSync(file, `${householdShape}\n`);
  const patterns = loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } });
  const result = scanText('the note mentions fixture-household-name-7 in passing\n', patterns);
  assert.equal(result.matches.length, 1);
  assert.notEqual(result.matches[0].pattern, householdShape);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(householdShape), 'the personal pattern text must never appear in the returned structure');
});

test('a finding for a generic or config match still names the actual pattern (public patterns are safe to show)', () => {
  const patterns = loadPatterns({ configPatterns: ['pub-shape-[0-9]+'] });
  const result = scanText('pub-shape-42\n', patterns);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].pattern, 'pub-shape-[0-9]+');
});

// --- scanText: shape, caps, excerpts --------------------------------------

test('scanText reports a 1-based column, matching the 1-based line convention', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('xxhit\n', patterns);
  assert.equal(result.matches.length, 1);
  // "hit" starts at zero-based index 2, so its 1-based column is 3.
  assert.equal(result.matches[0].column, 3);
});

test('scanText returns a plain record, not an array with hidden properties: truncated and total survive JSON.stringify and a spread', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 8 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns, { max: 3 });
  assert.equal(Array.isArray(result), false);
  assert.ok(Array.isArray(result.matches));
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.equal(roundTripped.truncated, true);
  assert.equal(roundTripped.total, 8);
  const spread = { ...result };
  assert.equal(spread.truncated, true);
  assert.equal(spread.total, 8);
});

test('scanText caps results at max and reports truncated with the total', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 8 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns, { max: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 8);
});

test('scanText does not report truncation when the total is within max', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('a hit here\n', patterns, { max: 5 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.total, 1);
});

test('scanText default max is 5', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 7 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns);
  assert.equal(result.matches.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 7);
});

test('a non-numeric max does not lie about truncation: it falls back to the default cap instead of silently returning nothing', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 7 }, () => 'a hit here').join('\n');
  for (const badMax of [NaN, 'five', undefined, -3, 2.5]) {
    const result = scanText(lines, patterns, { max: badMax });
    assert.equal(result.matches.length, 5, `max=${String(badMax)} should fall back to the default cap`);
    assert.equal(result.truncated, true);
    assert.equal(result.total, 7);
  }
});

test('max: 0 keeps nothing but still reports the true total and that something was cut', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('a hit here\n', patterns, { max: 0 });
  assert.equal(result.matches.length, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 1);
});

test('scanText finds a match on the first line and a match on the last line, with no trailing newline', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = 'hit at top\nnothing in the middle\nhit at the very end';
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.matches[1].line, 3);
});

test('scanText reports two matches on one line with distinct columns', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('first hit then another hit here\n', patterns);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.matches[1].line, 1);
  assert.ok(result.matches[0].column < result.matches[1].column);
});

test('two matches from different patterns on one line come back in column order, not in pattern list order', () => {
  // "later" is declared after "earlier" in configPatterns, but its match
  // sits before "earlier"'s match on the line, so a result that just
  // concatenated per-pattern matches in list order would report them
  // backwards. The result must read left to right regardless of which
  // pattern found which match.
  const patterns = loadPatterns({ configPatterns: ['later-shape', 'earlier-shape'] });
  const result = scanText('earlier-shape then later-shape\n', patterns);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].pattern, 'earlier-shape');
  assert.equal(result.matches[1].pattern, 'later-shape');
  assert.ok(result.matches[0].column < result.matches[1].column);
});

test('scanText scans a binary-ish input with null bytes as text, with the nulls stripped, rather than skipping it', () => {
  // Built with String.fromCharCode rather than a Unicode escape literal,
  // so the NUL character exists only at runtime and never as a raw byte
  // sitting in this source file.
  const NUL = String.fromCharCode(0);
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = `${NUL}${NUL}binary${NUL}prefix a hit here${NUL}trailer${NUL}`;
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 1);
  assert.ok(!result.matches[0].excerpt.includes(NUL));
});

test('the excerpt never contains the matched secret text, only surrounding context and a fixed marker', () => {
  const patterns = loadPatterns();
  const text = `line one\nprefix ${AWS_KEY_ID} suffix\nline three\n`;
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 1);
  assert.ok(!result.matches[0].excerpt.includes(AWS_KEY_ID));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(AWS_KEY_ID), 'the secret must not survive anywhere in the returned structure');
});

test('a match strictly nested inside a wider match does not cause the wider match\'s own tail to be re-exposed as raw text', () => {
  // "bracket-inner-value-bracket" is matched WHOLE by the first pattern
  // and, separately, "inner" alone (strictly inside it, ending well
  // before the outer match's own end) is matched by the second. Without
  // merging overlapping spans before masking, processing the outer span
  // and then the inner span independently walks the redaction cursor
  // BACKWARDS (to the inner span's earlier end), which then re-includes
  // the outer match's own trailing text ("-value-bracket") as if it had
  // never been matched at all.
  const patterns = loadPatterns({ configPatterns: ['bracket-[a-z-]+-bracket', 'inner'] });
  const result = scanText('bracket-inner-value-bracket\n', patterns);
  assert.equal(result.matches.length, 2);
  for (const match of result.matches) {
    assert.ok(!match.excerpt.includes('value'), `the outer match's own tail leaked back out: ${JSON.stringify(match.excerpt)}`);
    assert.ok(!match.excerpt.includes('bracket'), `the outer match's own text leaked back out: ${JSON.stringify(match.excerpt)}`);
  }
});

test('a distant, unrelated match elsewhere on the same line does not corrupt an excerpt whose own window never reaches it', () => {
  const patterns = loadPatterns({ configPatterns: ['hit', 'faraway-[0-9]+'] });
  const gap = 'PADDING'.repeat(10); // 70 characters: well beyond either match's 20-character window
  const line = `hit${gap}faraway-42\n`;
  const result = scanText(line, patterns);
  assert.equal(result.matches.length, 2);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  const markerCount = (hitFinding.excerpt.match(/\[REDACTED\]/g) ?? []).length;
  assert.equal(markerCount, 1, `an excerpt untouched by any other match must carry exactly one marker, got: ${JSON.stringify(hitFinding.excerpt)}`);
});

test('a normal (not too dense) excerpt keeps its surrounding safe context, not only the redaction marker', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('safe-prefix-text hit safe-suffix-text\n', patterns);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].excerpt, /safe-prefix-text/);
  assert.match(result.matches[0].excerpt, /safe-suffix-text/);
});

test('the excerpt carries only a bounded amount of surrounding context, never the whole line', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const padding = 'x'.repeat(100);
  const result = scanText(`${padding} hit ${padding}\n`, patterns);
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].excerpt.length < padding.length * 2, 'excerpt must be much shorter than the full padded line');
  assert.ok(!result.matches[0].excerpt.includes(padding), 'excerpt must not include the full 100-character padding on either side');
});

// --- CRITICAL: the excerpt redacts EVERY match it touches, not only the
//     one the finding is about -------------------------------------------

test('the excerpt redacts a second, neighbouring secret in its context window, not only the one this finding is about', () => {
  const patterns = loadPatterns();
  // Two distinct AWS-shaped access key ids close enough together that each
  // one's twenty-character context window reaches the other.
  const text = `${AWS_KEY_ID} ${SECOND_AWS_KEY_ID}\n`;
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 2);
  for (const match of result.matches) {
    assert.ok(!match.excerpt.includes(AWS_KEY_ID), 'the first key must not survive in any excerpt');
    assert.ok(!match.excerpt.includes(SECOND_AWS_KEY_ID), 'the second key must not survive in any excerpt');
  }
});

test('the excerpt is EXACTLY the expected before-marker-after shape, with a REAL neighbouring match present: an off-by-one or off-by-two boundary shift in either direction would change this string', () => {
  // A fragment-search assertion (does substring X survive anywhere in the
  // output) is the wrong tool for a boundary-shift bug specifically: if
  // only the match's very first character leaks because the mask starts
  // one position too late, that single leaked character sits directly
  // against the marker on one side and safe padding on the other, so it
  // never forms a contiguous run long enough to match a fragment of any
  // useful length (a run of 1 cannot equal a probe of length 2 or 3, so a
  // fragment-based test can only catch a shift large enough to leak a run
  // AS LONG AS the probe, which is exactly the "half-length fragment"
  // mistake at a smaller scale). Exact string equality has no such blind
  // spot: ANY shift in either clip boundary, by any amount, changes this
  // exact string, because the surrounding padding lengths are fixed and
  // known.
  //
  // Critically, unlike an earlier version of this test, a NEIGHBOUR must
  // actually be present: a single, isolated match on an otherwise empty
  // line has nothing overlapping either side region, so BOTH regions clip
  // to nothing and `maskRegion` returns through its early exit
  // (`clipped.length === 0`), never reaching the masking loop this test
  // exists to pin at all. "NEIGHBOR" here is that overlapping match: it
  // sits inside "hit"'s own after-region, so building "hit"'s excerpt
  // genuinely walks the merge-and-mask loop, with fully known padding on
  // both sides of it to predict the exact output.
  const before = 'AAAA'; // 4 known characters between "hit" and "NEIGHBOR"
  const after = 'BBBBBBBB'; // 8 known characters after "NEIGHBOR", still inside the 20-character region
  const patterns = loadPatterns({ configPatterns: ['hit', 'NEIGHBOR'] });
  const result = scanText(`hit${before}NEIGHBOR${after}\n`, patterns);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  assert.equal(hitFinding.excerpt, `[REDACTED]${before}[REDACTED]${after}`);
});

test('the smallest possible leak, a single character, does not survive: the one digit that tells two neighbouring keys apart never appears', () => {
  // A generic one-character probe is usually too weak on its own (almost
  // any single letter appears somewhere innocuously, including inside the
  // word "REDACTED" itself: checking for a bare "A" surviving would be a
  // false positive against the marker text alone). But the digit that
  // distinguishes these two fixture keys from each other is not one of
  // those letters, and appears nowhere else at all in this fixture's
  // excerpts: not in the marker, not in the safe space between the two
  // keys, and not (since only `.excerpt` fields are checked, never
  // `.pattern`) in the generic pattern's own public name.
  //
  // This is the probe strength the previous round's fragment tests
  // needed and did not have: a two-character probe cannot see a
  // one-character leak, because a single leaked character sitting between
  // a marker and safe padding never forms a run as long as the probe.
  const patterns = loadPatterns();
  const text = `${AWS_KEY_ID} ${SECOND_AWS_KEY_ID}\n`;
  const result = scanText(text, patterns);
  const excerpts = result.matches.map((m) => m.excerpt).join('\n');
  assert.ok(!excerpts.includes('1'), `the digit identifying the first key survived: ${JSON.stringify(excerpts)}`);
  assert.ok(!excerpts.includes('2'), `the digit identifying the second key survived: ${JSON.stringify(excerpts)}`);
});

test('the excerpt does not even reveal the exact length of a redacted neighbouring match: two differently sized secrets mask to the same shape', () => {
  const patterns = loadPatterns({ configPatterns: ['short-a', 'much-longer-fixture-b'] });
  const shortLine = scanText('lead-in short-a and trailer text\n', patterns);
  const longLine = scanText('lead-in much-longer-fixture-b and trailer text\n', patterns);
  // Both excerpts mask their match with the same fixed marker, so the
  // marker itself never becomes a side channel for the matched length.
  const shortExcerpt = shortLine.matches[0].excerpt;
  const longExcerpt = longLine.matches[0].excerpt;
  const markerPattern = /\[REDACTED\]/;
  assert.match(shortExcerpt, markerPattern);
  assert.match(longExcerpt, markerPattern);
  assert.equal(shortExcerpt.match(markerPattern)[0], longExcerpt.match(markerPattern)[0]);
});

// --- catastrophic patterns are bounded, not left to hang ------------------

// Both catastrophic-pattern tests below carry an explicit node:test
// `timeout`. The runner itself has no default deadline, and neither of
// these tests otherwise passes it one, so a regression that turned the
// internal timeout into a real, uninterruptible hang would not FAIL this
// suite, it would HANG it: whoever is watching a CI run gets a stuck
// process with no readable result, which is strictly worse than a red
// test. A bounded test either passes, fails, or times out visibly.
test('a catastrophically backtracking PERSONAL pattern is aborted without ever naming it, run in a child process because a hung one cannot be recovered from in-process', () => {
  const dir = tempDir();
  const file = join(dir, 'personal-evil.txt');
  const catastrophicShape = ['(', 'a+', ')+$'].join('');
  writeFileSync(file, `${catastrophicShape}\n`);
  const result = spawnSync(process.execPath, [CATASTROPHIC_SCAN_SCRIPT, 'personal', file], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.signal, null, `the child was killed (${result.signal}); the internal timeout did not fire`);
  assert.equal(result.status, 0, `the child exited ${result.status}, stdout: ${result.stdout}, stderr: ${result.stderr}`);
  assert.match(result.stdout, /^THREW:/);
  assert.ok(!result.stdout.includes(catastrophicShape), 'a personal pattern must never be named, even in a timeout error');
});

test('a catastrophically backtracking pattern is aborted rather than left to hang the scanner, run in a child process the parent can always recover from', () => {
  // A test runner's own `timeout` option cannot interrupt a synchronous,
  // never-yielding call: it relies on the event loop it shares with the
  // test itself to notice an overrun, and a truly stuck call never gives
  // that event loop a turn. Only something OUTSIDE the process that might
  // hang, like the operating system killing a child, can guarantee this
  // test itself never hangs regardless of what src/leak.mjs does.
  const start = Date.now();
  const result = spawnSync(process.execPath, [CATASTROPHIC_SCAN_SCRIPT, 'config'], { encoding: 'utf8', timeout: 8000 });
  const elapsed = Date.now() - start;
  assert.equal(result.signal, null, `the child was killed (${result.signal}) after ${elapsed}ms; the internal timeout did not fire and the pattern was left to hang`);
  assert.equal(result.status, 0, `the child exited ${result.status}, stdout: ${result.stdout}, stderr: ${result.stderr}`);
  assert.match(result.stdout, /^THREW:/);
  assert.match(result.stdout, /took longer than|aborted/);
  // Bounded on both sides: an immediate return would mean the pattern was
  // never actually evaluated (a false pass), and anything near the child's
  // own 8-second spawnSync timeout would mean the internal timeout
  // constant itself had drifted far from its intended, small value.
  assert.ok(elapsed > 1000, `the child finished suspiciously fast (${elapsed}ms); the pattern may not have been evaluated at all`);
  assert.ok(elapsed < 5000, `the child took ${elapsed}ms, far longer than the internal timeout should allow`);
});

test('a sandbox failure that is NOT a timeout is reported honestly, not relabelled as one', () => {
  // A caller passing something that is not a compiled pattern (bypassing
  // loadPatterns entirely) is the ORGANIC way to reach this branch: no
  // valid pattern loadPatterns can produce ever fails this way, so this is
  // not a manufactured fault injected into a real pattern, it is a
  // genuinely malformed entry reaching the sandbox on its own. A bare
  // catch that called every sandbox failure a timeout would send whoever
  // reads this message chasing a catastrophically slow pattern that was
  // never there.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  patterns.push({ raw: 'not-really-a-pattern', origin: 'config', regex: 'not-a-regex-object' });
  assert.throws(
    () => scanText('a hit here\n', patterns),
    (err) => {
      assert.match(err.message, /not from a timeout/);
      assert.ok(!err.message.includes('took longer than'), 'a non-timeout failure must not be described as a timeout');
      return true;
    },
  );
});

test('a pattern that matches very often on one line is bounded by the same collection cap rather than allocating without limit', () => {
  // The literal "a" matches at EVERY position of a long run of "a": half a
  // million non-overlapping matches on one line, not catastrophic
  // backtracking, but exactly the "allocates its way to an outage" shape a
  // naive cap-after-scanning would not catch, because collecting every
  // match before slicing to max would already have paid the cost by the
  // time the cap is applied. The true total is still reported exactly.
  const patterns = loadPatterns({ configPatterns: ['a'] });
  const longLine = 'a'.repeat(500000);
  const start = Date.now();
  const result = scanText(longLine, patterns, { max: 3 });
  assert.ok(Date.now() - start < 5000, 'scanning half a million cheap matches must not itself take anywhere near the reported ten-second hang');
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 500000);
});

test('a pattern that can match the empty string does not stall scanning: zero-length matches advance rather than repeat forever', () => {
  // Without a guard that advances past a zero-length match, "x?" would
  // match empty at the same position forever, and the module's own
  // internal timeout would be the only thing that eventually stops it
  // (converting an instant, benign scan into a multi-second failure). This
  // asserts the FAST, correct path: ordinary short content with a
  // zero-length-capable pattern resolves almost immediately.
  const patterns = loadPatterns({ configPatterns: ['x?'] });
  const start = Date.now();
  const result = scanText('a short line without much in it\n', patterns);
  assert.ok(Date.now() - start < 200, 'a zero-length-capable pattern on ordinary short content must resolve almost instantly, not stall toward the internal timeout');
  assert.ok(result.total > 0);
});

test('the redaction span floor, not the requested max, decides when a line is too dense: fewer matches than the floor still get precise redaction even with a small max', () => {
  // 50 matches of one pattern on one line is well under the redaction
  // span floor (200), so this module can fully account for every one of
  // them even though `max` itself is only 1: the single finding it
  // returns must keep its real surrounding context, not fall back to a
  // bare marker as if the line had been too dense to enumerate.
  const patterns = loadPatterns({ configPatterns: ['x'] });
  const parts = [];
  for (let i = 0; i < 50; i += 1) parts.push('x');
  const line = parts.join('----PADDING----');
  const result = scanText(line, patterns, { max: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.total, 50);
  assert.notEqual(result.matches[0].excerpt, '[REDACTED]');
  assert.match(result.matches[0].excerpt, /PADDING/);
});

test('more than the redaction span floor of one pattern matching on one line falls back to masking the whole excerpt window, rather than risk an unenumerated neighbour surviving', () => {
  // 250 occurrences of "x", each separated by plenty of ordinary text, is
  // more than this module is willing to enumerate individually per
  // pattern per line (the floor is 200). If the collection cap that
  // enforces that floor were silently lifted, this scenario would instead
  // enumerate all 250 spans and redact precisely, showing the ordinary
  // "padding" text around the reported match; the module's actual
  // contract is to recognise it cannot vouch for every neighbour once the
  // floor is exceeded, and mask the whole window instead.
  const patterns = loadPatterns({ configPatterns: ['x'] });
  const parts = [];
  for (let i = 0; i < 250; i += 1) parts.push('x');
  const line = parts.join('----PADDING----');
  const result = scanText(line, patterns, { max: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.total, 250);
  assert.equal(result.matches[0].excerpt, '[REDACTED]');
});

// --- the lastIndex reset defends against an externally reused regex ------

test('maskRegion merges a span nested inside a wider one within the SAME side region, so the wider span\'s own tail is not re-exposed', () => {
  // "ABCDEFGHIJKLMNO" (the wide match, declared first) and "DEFG" (the
  // narrow match nested inside it, declared second) both fall inside
  // hit's own AFTER region. Without merging, processing them as two
  // separate clipped entries walks the masking cursor backwards (from the
  // wide span's own end down to the narrow span's smaller end),
  // re-exposing the part of the wide span that sits after the narrow one
  // as raw, unmasked text.
  const outer = 'ABCDEFGHIJKLMNO'; // 15 chars
  const inner = 'DEFG'; // nested inside `outer` at its own offset 3, length 4
  const patterns = loadPatterns({ configPatterns: ['hit', outer, inner] });
  const text = `hit AA${outer}PQ\n`;
  const result = scanText(text, patterns);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  assert.ok(!hitFinding.excerpt.includes(outer), `the wide match's own text was re-exposed whole: ${JSON.stringify(hitFinding.excerpt)}`);
  assert.ok(!hitFinding.excerpt.includes(inner), `the nested match's own text was re-exposed: ${JSON.stringify(hitFinding.excerpt)}`);
  // Specifically the TAIL of the wide match, past where the nested one
  // ends, is the part a missing merge would re-expose.
  const wideTail = outer.slice(3 + inner.length); // "HIJKLMNO"
  assert.ok(!hitFinding.excerpt.includes(wideTail), `the wide match's own tail leaked: ${JSON.stringify(hitFinding.excerpt)}`);
});

test('touching (adjacent, not overlapping) spans merge into one marker, not two: observable, but nothing is leaked either way', () => {
  // "LEFT" spans [3,7) and "RIGHT" spans [7,12): they touch exactly at
  // position 7 with no gap and no overlap. The merge condition
  // (`span[0] <= last[1]`, not `<`) treats touching spans as one
  // continuous range to mask; using a strict `<` would leave them as two
  // separate clipped entries instead, and the masking loop inserts one
  // marker per entry it processes, so two separate entries print two
  // markers back to back where one merged entry prints only one. Nothing
  // is leaked by either choice (no raw text sits in that zero-width gap
  // either way), which is why this needs its own test: mutating the
  // comparison would not fail any leak-detecting assertion at all.
  const patterns = loadPatterns({ configPatterns: ['hit', 'LEFT', 'RIGHT'] });
  const result = scanText('hitLEFTRIGHTTAIL\n', patterns);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  assert.equal(hitFinding.excerpt, '[REDACTED][REDACTED]TAIL');
});

test('maskRegion appends its trailing safe text after the last masked span, not only up to it', () => {
  const patterns = loadPatterns({ configPatterns: ['hit', 'nbr'] });
  const trailingSafe = 'Y'.repeat(14);
  const text = `hitXXXnbr${trailingSafe}\n`;
  const result = scanText(text, patterns);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  assert.ok(hitFinding.excerpt.includes(trailingSafe), `trailing safe context after the last masked span was dropped: ${JSON.stringify(hitFinding.excerpt)}`);
});

test('scanText is not thrown off by a pattern object whose lastIndex was left non-zero by unrelated prior use', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  // Advance the compiled regex's lastIndex on unrelated text before ever
  // calling scanText, simulating a caller who reused the same compiled
  // `patterns` array across an earlier scan or a hand-rolled probe.
  const hitEntry = patterns.find((p) => p.raw === 'hit');
  hitEntry.regex.lastIndex = 9999;
  const result = scanText('a hit right at the start\n', patterns);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].line, 1);
});

// --- the context length is exactly twenty characters each side -----------

test('the excerpt keeps exactly twenty characters of context on each side, not nineteen, not twenty-one, when more is available', () => {
  const before = 'B'.repeat(25); // more than twenty, so this pins the cutoff precisely
  const after = 'C'.repeat(25);
  const patterns = loadPatterns({ configPatterns: ['secrettoken'] });
  const result = scanText(`${before}secrettoken${after}\n`, patterns);
  assert.equal(result.matches.length, 1);
  const expectedBefore = 'B'.repeat(20);
  const expectedAfter = 'C'.repeat(20);
  assert.equal(result.matches[0].excerpt, `${expectedBefore}[REDACTED]${expectedAfter}`);
});

// --- the excerpt's total size does not scale with the match's own length -

test('the excerpt does not grow with a very long match: a long token still yields a short, fixed-size excerpt', () => {
  // ghp_ and several other generic shapes have no upper bound on length
  // ({20,} or {10,}); a single window spanning [start - CTX, end + CTX)
  // would grow with a committed token's own length, unbounded by this
  // module. The two-sided design bounds the excerpt to roughly
  // `2 * EXCERPT_CONTEXT_CHARS` plus fixed markers, regardless of how long
  // the match itself is.
  const patterns = loadPatterns();
  const longToken = 'ghp_' + 'A'.repeat(2000);
  const result = scanText(`prefix text ${longToken} trailer text\n`, patterns);
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].excerpt.length < 100, `excerpt grew with the match's own length: ${result.matches[0].excerpt.length} characters`);
});

// --- HIGH: the sort inside maskRegion, whose sibling sort was tested but
//     this one was not -----------------------------------------------------

test('redaction spans are sorted before merging: two neighbours within the SAME side region, collected out of position order, both still get masked', () => {
  // The primary match is "hit"; two other patterns each match inside
  // hit's own AFTER region (within twenty characters of hit's end).
  // "zzzfar" is declared first in configPatterns and sits FURTHER RIGHT;
  // "zzznear" is declared second and sits FURTHER LEFT, closer to "hit".
  // Collection therefore contributes zzzfar's span to redactionSpans
  // BEFORE zzznear's, even though zzznear's span starts earlier in the
  // line: the two land in maskRegion's `clipped` array in that same
  // out-of-position order. Without the sort, the merge step (which only
  // ever widens the END of the most recently merged range, relying on
  // ascending order to guarantee it never also needs to move the START)
  // absorbs zzznear's span into zzzfar's without moving zzzfar's own
  // start down to meet it, and zzznear's own text is never masked at all.
  const patterns = loadPatterns({ configPatterns: ['hit', 'zzzfar', 'zzznear'] });
  const text = 'hit' + 'AAA' + 'zzznear' + 'BB' + 'zzzfar' + '\n';
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 3);
  const hitFinding = result.matches.find((m) => m.pattern === 'hit');
  assert.ok(hitFinding, 'the "hit" finding must be present');
  assert.ok(!hitFinding.excerpt.includes('zzznear'), `zzznear leaked verbatim in hit's own excerpt: ${JSON.stringify(hitFinding.excerpt)}`);
  assert.ok(!hitFinding.excerpt.includes('zzzfar'), `zzzfar leaked verbatim in hit's own excerpt: ${JSON.stringify(hitFinding.excerpt)}`);
});

// --- HIGH: an aggregate deadline for the whole scan, not only per unit ---
//
// `deadlineAt` is an ABSOLUTE point in time, not a duration, specifically
// so one budget can be threaded across many `scanText` calls (a whole run
// over a vault, not one file at a time). Every test below computes it as
// `Date.now() + N` at the call site, exactly as a real caller threading a
// budget across a run would compute it once and pass the same value to
// every file's call.

test('scanText enforces an aggregate deadline across the whole scan, not only a per-line, per-pattern one', () => {
  // Five thousand ordinary, fast lines each cost only a few microseconds
  // against "hit", nowhere near the per-evaluation SCAN_TIMEOUT_MS. An
  // aggregate deadline just past "now" proves the mechanism fires from
  // accumulation, not from any single slow evaluation: no per-unit call
  // here is remotely close to slow.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const manyFastLines = Array.from({ length: 5000 }, () => 'a hit here').join('\n');
  assert.throws(
    () => scanText(manyFastLines, patterns, { deadlineAt: Date.now() + 1 }),
    /exceeded its deadline/,
  );
});

test('scanText completes normally when the aggregate deadline is generous', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const lines = Array.from({ length: 20 }, () => 'a hit here').join('\n');
  const result = scanText(lines, patterns, { deadlineAt: Date.now() + 5000 });
  assert.equal(result.total, 20);
});

test('a non-finite deadlineAt falls back to this module\'s own default rather than disabling the deadline', () => {
  // Unlike the old relative-duration option this replaced, `0` and a
  // negative number are NOT invalid here: an absolute deadline of "the
  // epoch" or "five milliseconds before it" is a real, if extreme, point
  // in the past, and correctly aborts the scan immediately rather than
  // falling back to anything (see the next test). Only a value that is
  // not a finite number at all (NaN, a string, undefined) has no sensible
  // reading as a point in time, and those are what falls back.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  for (const bad of [NaN, 'never', undefined]) {
    const result = scanText('a hit here\n', patterns, { deadlineAt: bad });
    assert.equal(result.matches.length, 1, `deadlineAt=${String(bad)} must not break an ordinary scan`);
  }
});

test('an already-past deadlineAt (zero or negative) is honoured as a real, already-expired deadline, not treated as invalid', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  for (const past of [0, -5, Date.now() - 1000]) {
    assert.throws(() => scanText('a hit here\n', patterns, { deadlineAt: past }), /exceeded its deadline/, `deadlineAt=${past} should have aborted immediately`);
  }
});

test('the same deadlineAt threaded across two separate scanText calls shares one budget: the second call inherits what the first already spent', () => {
  // This is the whole reason the deadline is absolute rather than a
  // duration: a duration measured from when EACH call starts would give
  // every file in a run its own fresh budget, so a run over many files
  // would have no aggregate budget at all. A single deadline computed once
  // and passed to both calls here proves the SECOND call is bound by what
  // the first one already consumed, not by a fresh clock of its own.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const deadlineAt = Date.now() + 5;
  const lines = Array.from({ length: 20 }, () => 'a hit here').join('\n');
  scanText(lines, patterns, { deadlineAt }); // spends part of the shared budget
  // Busy-wait CLEARLY past the shared deadline, not merely to it: a
  // strict `>` comparison at the exact millisecond boundary is a real
  // race against a timer-based wait, so this waits a few milliseconds
  // further to make the "past the deadline" state unambiguous.
  while (Date.now() < deadlineAt + 5) { /* busy-wait past the shared deadline */ }
  assert.throws(() => scanText('a hit here\n', patterns, { deadlineAt }), /exceeded its deadline/);
});

test('OVERALL_SCAN_TIMEOUT_MS, the default deadline, is exported and holds a specific, bounded value', () => {
  // Without this, a test that only ever exercises the deadlineAt OVERRIDE
  // (every test above) never notices this constant changing by any
  // factor at all, including a regression that multiplied it a
  // thousandfold and turned a bounded scan back into an effectively
  // unbounded one: the suite would stay green either way.
  assert.equal(typeof OVERALL_SCAN_TIMEOUT_MS, 'number');
  assert.ok(OVERALL_SCAN_TIMEOUT_MS >= 5000, `OVERALL_SCAN_TIMEOUT_MS (${OVERALL_SCAN_TIMEOUT_MS}) is too small to admit the large, ordinary input this module measured itself against`);
  assert.ok(OVERALL_SCAN_TIMEOUT_MS <= 60000, `OVERALL_SCAN_TIMEOUT_MS (${OVERALL_SCAN_TIMEOUT_MS}) is large enough that a scan bounded by it is no longer meaningfully bounded for an interactive caller`);
});

test('the default deadline (no override) is genuinely computed from OVERALL_SCAN_TIMEOUT_MS, not a hardcoded duplicate of it', () => {
  // A mock clock, not a real wait: the first Date.now() call inside
  // scanText (computing the default deadline, since no deadlineAt is
  // passed) reports the real "now"; every call after that (the per-line
  // checks) reports as if exactly OVERALL_SCAN_TIMEOUT_MS plus one second
  // had passed since then. If the default deadline is genuinely
  // `Date.now() + OVERALL_SCAN_TIMEOUT_MS`, that is now in the past and
  // the scan throws. If some OTHER, independently hardcoded number were
  // used for the default instead of this exported constant (drifting from
  // it silently in either direction), this specific mock would no longer
  // reliably straddle the real deadline, and this is exactly the
  // "constant used in two places that can drift apart" shape this
  // codebase has already had to fix elsewhere.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = 'a hit here\nb hit here\n';
  const realDateNow = Date.now;
  const realNow = realDateNow();
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return calls === 1 ? realNow : realNow + OVERALL_SCAN_TIMEOUT_MS + 1000;
  };
  try {
    assert.throws(() => scanText(text, patterns), /exceeded its deadline/);
  } finally {
    Date.now = realDateNow;
  }
});

// --- NUL bytes are removed, not replaced: column numbers reflect that ----

test('null bytes are stripped from the text entirely, not replaced by a placeholder character: a match after them reports the column it has once they are gone', () => {
  const NUL = String.fromCharCode(0);
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const text = `${NUL}${NUL}${NUL}hit\n`;
  const result = scanText(text, patterns);
  assert.equal(result.matches.length, 1);
  // If the three NUL bytes were replaced by a placeholder character
  // instead of removed, "hit" would sit at column 4; stripped outright, it
  // sits at column 1.
  assert.equal(result.matches[0].column, 1);
});

// --- the empty-string override for BRAIN_KIT_LEAK_PATTERNS falls back ----

test('an empty string for BRAIN_KIT_LEAK_PATTERNS falls back to the default path rather than being treated as a literal, useless path', () => {
  const fakeHome = tempDir();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.throws(
      () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: '' } }),
      (err) => {
        assert.match(err.message, /\.config[/\\]brain-kit[/\\]leak-patterns\.txt/);
        return true;
      },
    );
  } finally {
    process.env.HOME = realHome;
  }
});

// --- GENERIC_PATTERNS is actually frozen, not merely declared const ------

test('GENERIC_PATTERNS is frozen: attempting to mutate it has no effect', () => {
  assert.equal(Object.isFrozen(GENERIC_PATTERNS), true);
  const before = [...GENERIC_PATTERNS];
  assert.throws(() => { GENERIC_PATTERNS.push('should not be allowed'); }, TypeError);
  assert.deepEqual([...GENERIC_PATTERNS], before);
});
