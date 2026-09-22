import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import {
  loadPatterns,
  scanText,
  GENERIC_PATTERNS,
  OVERALL_SCAN_TIMEOUT_MS,
  ACCRUAL_PER_LINE_MS,
  ACCRUAL_PER_LINE_PER_PATTERN_MS,
  ACCRUAL_PER_CHAR_PER_PATTERN_MS,
  MAX_SCAN_BYTES,
  PREFILTER_MAX_LINES,
  PREFILTER_MAX_CHARS,
  SCAN_TIMEOUT,
  SCAN_FAILED,
} from '../src/leak.mjs';
import { decodeBytes } from '../src/io.mjs';

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
  return makeTempDir('brain-kit-leak-');
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

// Fix round 2 (CRITICAL): a configPatterns entry whose raw text is
// IDENTICAL to one GENERIC_PATTERNS already ships used to compile
// twice, as two independent pattern entries scanText treats as
// unrelated, so one real match was found and counted twice. This
// project's own shipped example configuration
// (test/fixtures/config/valid.json) names this exact shape: it lists
// `AKIA[0-9A-Z]{16}` in `privacy.secret_patterns`, and GENERIC_PATTERNS
// already carries the identical string. Reproduced here directly
// against GENERIC_PATTERNS itself (not a fixture copy of it, so this
// test cannot silently drift from whichever shape actually overlaps):
// three real secrets on three lines must report as three matches, never
// six.
test('a configPatterns entry identical to a generic pattern is folded into that one generic entry, never compiled and scanned a second time', () => {
  const overlapping = GENERIC_PATTERNS[0];
  const patterns = loadPatterns({ configPatterns: [overlapping] });
  assert.equal(patterns.length, GENERIC_PATTERNS.length, 'the duplicate must not add a second compiled entry');
  assert.equal(patterns.filter((p) => p.raw === overlapping).length, 1);
  assert.equal(patterns.find((p) => p.raw === overlapping).origin, 'generic', 'the surviving entry keeps the generic origin, safe to display verbatim');
});

test('three real secrets on three lines report as three matches, not six, when the shipped configuration duplicates a generic pattern shape', () => {
  const awsKey = 'AKIA' + 'DUPE1111DUPE2222';
  const text = [`one ${awsKey} here`, `two ${awsKey} here`, `three ${awsKey} here`].join('\n');
  const patterns = loadPatterns({ configPatterns: ['AKIA[0-9A-Z]{16}'] }); // the shipped example config's own overlap with GENERIC_PATTERNS
  const result = scanText(text, patterns);
  assert.equal(result.total, 3, `expected exactly one match per real secret, got total=${result.total}`);
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, false);
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
  // A timeout carries the timeout code, which is what lets the lint
  // report say "timed out" rather than "crashed" (final fix round 2).
  assert.match(result.stdout, new RegExp(`code=${SCAN_TIMEOUT}`));
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
      // And its code says the same, so a caller can tell the two apart
      // without reading prose (final fix round 2).
      assert.equal(err.code, SCAN_FAILED);
      return true;
    },
  );
});

test('a pattern that matches very often on one line is bounded by the same collection cap rather than allocating without limit', () => {
  // The literal "a" matches at EVERY position of a long run of "a": twenty
  // thousand adjacent, zero-gap matches on one line, not catastrophic
  // backtracking, but exactly the "allocates its way to an outage" shape a
  // naive cap-after-scanning would not catch, because collecting every
  // match before slicing to max would already have paid the cost by the
  // time the cap is applied. The true total is still reported exactly.
  //
  // WHAT THIS ASSERTS ON, AND WHY NOT THE CLOCK. This test used to time
  // itself (half a million matches, "must finish within five seconds").
  // Two things were wrong with that, both measured rather than reasoned:
  //
  //   - It did not discriminate the clause it is named after. The cap
  //     bounds how many spans are COLLECTED; the time is spent in the
  //     regex loop, which runs to the end of the line either way. Measured
  //     at half a million matches: 3642ms with the cap, 4177ms without it.
  //     A thirteen percent difference, nowhere near a five-second
  //     threshold, so lifting the cap would not have moved the assertion.
  //   - At that size the SANDBOX's own timeout (2000ms per line) fires on
  //     a busy machine, on the CAPPED path, so the test went red on a
  //     pristine tree with nothing wrong. That is how a suite teaches
  //     whoever reads it that red means noise.
  //
  // So the size comes down to where the sandbox call has better than an
  // order of magnitude of headroom on a loaded machine (measured at 131ms
  // under a load average near 50), and the assertion moves to the cap's
  // own OBSERVABLE consequence, which is exact rather than approximate:
  // once more matches of one pattern exist on a line than the module is
  // willing to enumerate, it knows it cannot vouch for every neighbour of
  // a finding, so it masks the whole excerpt window instead of redacting
  // precisely. Lift the cap and every span IS enumerated, the line stops
  // counting as too dense, and the excerpt comes back with context in it.
  const patterns = loadPatterns({ configPatterns: ['a'] });
  const longLine = 'a'.repeat(20000);
  const result = scanText(longLine, patterns, { max: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 20000);
  assert.equal(
    result.matches[0].excerpt,
    '[REDACTED]',
    'the collection cap was not applied: every span was enumerated, so the line no longer counted as too dense to redact precisely',
  );
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
  //
  // THE CLOCK IS INJECTED, and this test used to race a real one: it took
  // a five millisecond real deadline and hoped the first call would finish
  // inside it. On a loaded machine the FIRST call blew the budget and
  // threw, and the test went red on a pristine tree with nothing wrong.
  // Widening the five milliseconds would only have moved that threshold to
  // a busier machine; what the test actually needs is to decide when time
  // passes, so it does.
  //
  // The clock advances one millisecond per reading, which is exactly how
  // this module spends time: one reading before every sandbox call. Twenty
  // lines that all match cost twenty-one: one for the pre-filter over the
  // whole run of twenty, then one before each line it found a match on.
  // That makes the budget a COUNT OF CALLS, and both halves of the claim
  // exact. Twenty-one readings against a twenty-one millisecond budget
  // consume all of it and finish on the boundary (the comparison is
  // strict, so the last reading is the last one that fits); the second
  // call then reads a clock that has already moved past the shared
  // deadline and must refuse. Were the deadline re-read as a duration from
  // each call's own start, the second call would get a fresh budget and
  // this would pass.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  let tick = 0;
  const clock = () => { tick += 1; return tick; };
  const deadlineAt = 21;
  const lines = Array.from({ length: 20 }, () => 'a hit here').join('\n');
  const first = scanText(lines, patterns, { deadlineAt, now: clock }); // spends the whole shared budget
  assert.equal(first.total, 20, 'the first call must finish, spending the budget rather than failing inside it');
  assert.equal(tick, 21, 'the first call must have read the clock once for the pre-filter and once per matching line');
  assert.throws(() => scanText('a hit here\n', patterns, { deadlineAt, now: clock }), /exceeded its deadline/);
});

test('an injected clock that is not a function falls back to the real one rather than leaving the scan unbounded', () => {
  // The clock is a test seam on the one code path that decides when a scan
  // gives up, so the seam itself must not be a way to switch that decision
  // off. Anything that is not callable falls back to Date.now, the same
  // shape as the deadlineAt fallback: an already-past absolute deadline
  // still aborts immediately, which it could not do if a broken clock had
  // silently disabled the check.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  for (const bad of [null, undefined, 0, 'later', {}, 12345]) {
    assert.throws(
      () => scanText('a hit here\n', patterns, { deadlineAt: 1, now: bad }),
      /exceeded its deadline/,
      `now=${JSON.stringify(bad)} must fall back to the real clock, not disable the deadline`,
    );
  }
});

test('an injected clock is used for the DEFAULT deadline too, not only for the per-line check', () => {
  // The default deadline is computed from the clock as well
  // (`clock() + OVERALL_SCAN_TIMEOUT_MS`). If that one call still read
  // Date.now directly while the per-line check read the injected clock,
  // the two would be on different time bases and the default deadline
  // would be meaningless to any caller driving the clock. A clock parked
  // at zero puts the default deadline at OVERALL_SCAN_TIMEOUT_MS; reading
  // one tick past it on the first line must abort.
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  let reading = 0;
  const clock = () => reading;
  const text = Array.from({ length: 3 }, () => 'a hit here').join('\n');
  reading = 0;
  assert.equal(scanText(text, patterns, { now: clock }).total, 3, 'a clock that never advances must never reach the default deadline');
  let call = 0;
  const advancingClock = () => {
    call += 1;
    return call === 1 ? 0 : OVERALL_SCAN_TIMEOUT_MS + 1;
  };
  assert.throws(
    () => scanText(text, patterns, { now: advancingClock }),
    /exceeded its deadline/,
    'the default deadline must be computed from the injected clock, so advancing past it aborts',
  );
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

// --- final fix round 2: one decoding, one ceiling, a budget that grows ----

test('a personal pattern holding an accented letter, written the ordinary way, matches that word in UTF-8 content', () => {
  // The patterns file and the content are decoded the same way now
  // (src/io.mjs). It used to be read as UTF-8 while the content was
  // decoded one byte per character, so this matched nothing.
  const dir = tempDir();
  const file = join(dir, 'patterns.txt');
  writeFileSync(file, 'caf\u00e9 da manh\u00e3\n', 'utf8');
  const patterns = loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } });
  const content = decodeBytes(Buffer.from('um caf\u00e9 da manh\u00e3 aqui\n', 'utf8'));
  const result = scanText(content, patterns);
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].pattern, 'a personal pattern');
});

test('a personal patterns file saved in another encoding still reads its accented letters as those letters, never as a replacement character', () => {
  // "caf" and 0xE9 is the word in latin1, which is not UTF-8. Read as
  // UTF-8 it would become a replacement character no content can match.
  const dir = tempDir();
  const file = join(dir, 'patterns.txt');
  writeFileSync(file, Buffer.concat([Buffer.from('caf', 'latin1'), Buffer.from([0xe9, 0x0a])]));
  const patterns = loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } });
  const result = scanText(decodeBytes(Buffer.from('um caf\u00e9 aqui\n', 'utf8')), patterns);
  assert.equal(result.total, 1);
});

// A list written the only way an accented name used to match, as its
// mojibake, would now match nothing at all about the name it was written
// for and go on saying "nothing matched". It is refused, naming the line
// and never the text, the way every other useless list is. A natural
// spelling, a name with a letter beyond latin1, a latin1 file and a plain
// ASCII list are not.
test('a personal pattern spelled as the mojibake of a name is refused by line number, never by its text', () => {
  const dir = tempDir();
  const file = join(dir, 'patterns.txt');
  const name = 'caf\u00e9 da manh\u00e3';
  const mojibake = Buffer.from(name, 'utf8').toString('latin1');
  writeFileSync(file, `# a comment\nplain-pattern\n${mojibake}\n`, 'utf8');
  assert.throws(
    () => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }),
    (err) => /line 3 of /.test(err.message) && /mojibake/.test(err.message) && !err.message.includes(mojibake) && !err.message.includes('caf'),
  );
  for (const fine of [Buffer.from(`${name}\n`, 'utf8'), Buffer.from('\u0141\u00f3d\u017a\n', 'utf8'), Buffer.from(`${name}\n`, 'latin1'), Buffer.from('plain-pattern\n', 'utf8')]) {
    writeFileSync(file, fine);
    assert.doesNotThrow(() => loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: file } }));
  }
});

test('the scan ceiling both gates share is 100 MiB', () => {
  assert.equal(MAX_SCAN_BYTES, 100 * 1024 * 1024);
});

test('the accrual rates are the measured ones with their margin, not zero and not unbounded', () => {
  assert.equal(ACCRUAL_PER_LINE_MS, 1);
  assert.equal(ACCRUAL_PER_LINE_PER_PATTERN_MS, 0.04);
  assert.equal(ACCRUAL_PER_CHAR_PER_PATTERN_MS, 0.000001);
});

// A clock that answers from a list, one reading at a time, and says how
// many readings were taken: the budget here is exact arithmetic over
// readings, never a race against a real clock.
function scriptedClock(readings) {
  let at = 0;
  const clock = () => {
    const value = readings[Math.min(at, readings.length - 1)];
    at += 1;
    return value;
  };
  clock.count = () => at;
  return clock;
}

test('with accrue, the budget grows by the per-line rate for every line scanned, per pattern, and without it the deadline stays absolute', () => {
  // 1025 short lines are two pre-filter runs, 1024 and 1, so the clock
  // is read twice: once before each run. The floor is zero. After the
  // first run the six generic patterns have earned 1024 * (1 + 0.04 * 6)
  // milliseconds plus a sliver per character, about 1269.8, so a second
  // reading of 1269 is inside the budget and 1270 is past it.
  const text = Array.from({ length: 1025 }, () => 'x').join('\n');
  const six = loadPatterns({});
  assert.equal(scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 1269]), accrue: true }).total, 0);
  assert.throws(() => scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 1270]), accrue: true }), /exceeded its deadline/);
  // The per-pattern part: seven patterns earn 1024 * 1.28, about 1310.7.
  const seven = loadPatterns({ configPatterns: ['zzz-never-present'] });
  assert.equal(scanText(text, seven, { deadlineAt: 0, now: scriptedClock([0, 1300]), accrue: true }).total, 0);
  assert.throws(() => scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 1300]), accrue: true }), /exceeded its deadline/);
  // No accrual at all unless it is asked for, and asked for exactly.
  assert.throws(() => scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 1]) }), /exceeded its deadline/);
  assert.throws(() => scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 1]), accrue: 'yes' }), /exceeded its deadline/);
});

test('with accrue, the budget also grows with the characters scanned, per pattern', () => {
  // A line longer than one pre-filter run's character bound is a run of
  // its own, so this is two runs: the 300,000 character line, then "x".
  // The six patterns earn 1.24 for the line plus 300,000 * 0.000006 = 1.8
  // for its characters, 3.04 in all.
  const text = `${'x'.repeat(300000)}\nx`;
  const six = loadPatterns({});
  assert.equal(scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 3]), accrue: true }).total, 0);
  assert.throws(() => scanText(text, six, { deadlineAt: 0, now: scriptedClock([0, 3.1]), accrue: true }), /exceeded its deadline/);
});

test('a run earns its budget before the lines it matched on are scanned in full, so those scans are not judged against a budget that ignores them', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText('hit\nhit\nhit\n', patterns, { deadlineAt: 0, now: scriptedClock([0, 1, 1, 1]), accrue: true });
  assert.equal(result.total, 3);
});

test('a deadline that is exceeded raises with the timeout code, so a caller can call it a timeout and nothing else', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  assert.throws(() => scanText('a hit here\n', patterns, { deadlineAt: 0, now: () => 1 }), (err) => err.code === SCAN_TIMEOUT);
});

test('lines end at LF, at CRLF and at a lone CR, so a file with classic Mac line endings is numbered like every other reader numbers it', () => {
  const patterns = loadPatterns({});
  const crOnly = scanText(`first\rsecond\rkey ${AWS_KEY_ID}\rlast`, patterns);
  assert.equal(crOnly.matches.length, 1);
  assert.equal(crOnly.matches[0].line, 3);
  // CRLF is still ONE line break: a Windows file numbers as it always did.
  const crlf = scanText(`first\r\nsecond\r\nkey ${AWS_KEY_ID}\r\n`, patterns);
  assert.equal(crlf.matches[0].line, 3);
  const mixed = scanText(`one\ntwo\rthree\r\nfour ${AWS_KEY_ID}\n`, patterns);
  assert.equal(mixed.matches[0].line, 4);
  assert.equal(mixed.matches[0].column, 6);
});

// The pre-filter asks "does any pattern match this line at all" of a run
// of lines in one sandbox call, and only a line that answers yes is
// scanned in full. It must change NO result. The oracle here scans every
// line on its own and stitches the answers together, which cannot share a
// bug in how runs are cut, how lines are indexed inside one, or what a
// pattern's lastIndex carries from one line to the next.
function scanLineByLine(text, patterns, max) {
  const matches = [];
  let total = 0;
  text.split('\n').forEach((line, index) => {
    const one = scanText(line, patterns, { max: 1000 });
    total += one.total;
    for (const match of one.matches) matches.push({ ...match, line: index + 1 });
  });
  const kept = matches.slice(0, max);
  return { matches: kept, truncated: total > kept.length, total };
}

test('the pre-filter changes no result: every match on every line, across run boundaries, anchors and lookarounds included, exactly as a line-by-line scan finds it', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `an ordinary line number ${i} with nothing in it`);
  const key = (n) => `AKIA${String(n).padStart(16, '0')}`;
  // Matches at the edges of every run of 1024 lines, anchored at the
  // start and the end of a line, behind a lookbehind, and one line whose
  // match ends far to the right followed by a short line whose match is
  // at column one (what a pattern's leftover lastIndex would miss).
  const placed = {
    0: `${key(1)} at the very start`,
    699: `middle of a run ${key(2)}`,
    1022: `${'y'.repeat(80)} ${key(3)}`,
    1023: key(4),
    1024: `${key(5)} first line of the second run`,
    2047: `trailing KEY`,
    2048: `KEY`,
    // A line longer than one run's character bound, the shape of a
    // minified file, with its match at the very end.
    2500: `${'m'.repeat(PREFILTER_MAX_CHARS + 10)} ${key(7)}`,
    2999: `last line ${key(6)}`,
  };
  for (const [index, text] of Object.entries(placed)) lines[Number(index)] = text;
  const text = lines.join('\n');
  const patterns = loadPatterns({ configPatterns: ['^AKIA[0-9]{4}', 'KEY$', '(?<![a-z])AKIA0{15}6'] });
  for (const max of [5, 100]) {
    const expected = scanLineByLine(text, patterns, max);
    const actual = scanText(text, patterns, { max });
    assert.deepEqual(actual, expected, `max=${max}`);
  }
  // And the matches really are where they were put.
  const lineNumbers = [...new Set(scanText(text, patterns, { max: 100 }).matches.map((m) => m.line))];
  assert.deepEqual(lineNumbers, [1, 700, 1023, 1024, 1025, 2048, 2049, 2501, 3000]);
});

test('a pattern that ends its match far to the right does not make the pre-filter miss the same pattern at the start of the next line', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  const result = scanText(`${'z'.repeat(60)} hit\nhit\n`, patterns);
  assert.deepEqual(result.matches.map((m) => [m.line, m.column]), [[1, 62], [2, 1]]);
});

test('a pre-filter run covers at most PREFILTER_MAX_LINES lines: the clock is read once per run of lines that match nothing', () => {
  assert.equal(PREFILTER_MAX_LINES, 1024);
  const patterns = loadPatterns({});
  const lines = (n) => Array.from({ length: n }, () => 'x').join('\n');
  for (const [count, runs] of [[1024, 1], [1025, 2], [2048, 2], [2049, 3]]) {
    const clock = scriptedClock([0]);
    scanText(lines(count), patterns, { deadlineAt: 1, now: clock });
    assert.equal(clock.count(), runs, `${count} lines`);
  }
});

test('a pre-filter run covers at most PREFILTER_MAX_CHARS characters, and a longer line is a run of its own', () => {
  assert.equal(PREFILTER_MAX_CHARS, 256 * 1024);
  const patterns = loadPatterns({});
  const lines = (n, width) => Array.from({ length: n }, () => 'x'.repeat(width)).join('\n');
  // 256 lines of 1024 characters are exactly the bound: one run. One more
  // line is a second run.
  for (const [text, runs] of [[lines(256, 1024), 1], [lines(257, 1024), 2], [`${'x'.repeat(PREFILTER_MAX_CHARS + 1)}\nx\nx`, 2]]) {
    const clock = scriptedClock([0]);
    scanText(text, patterns, { deadlineAt: 1, now: clock });
    assert.equal(clock.count(), runs);
  }
});

// The pre-filter's own timeout cannot be reached with a real pattern
// without a test that takes seconds and depends on how fast the machine
// is, so the sandbox call is replaced for these two, and only these two:
// the pre-filter's call is answered with the engine's own timeout error,
// every other call runs for real.
function withPrefilterTimingOut(body) {
  const real = vm.runInContext;
  const calls = { prefilter: 0, full: 0 };
  vm.runInContext = function stub(source, context, options) {
    if (source.includes('hits.push')) {
      calls.prefilter += 1;
      throw Object.assign(new Error('Script execution timed out.'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
    }
    calls.full += 1;
    return real.call(this, source, context, options);
  };
  try {
    return body(calls);
  } finally {
    vm.runInContext = real;
  }
}

test('a pre-filter run of several lines that times out falls back to one call per line and still reads every line', () => {
  withPrefilterTimingOut((calls) => {
    const result = scanText('clean\nhit\nclean\nhit here\n', loadPatterns({ configPatterns: ['hit'] }));
    assert.equal(result.total, 2);
    assert.deepEqual(result.matches.map((m) => m.line), [2, 4]);
    assert.equal(calls.prefilter, 1, 'after one run timed out, the rest is scanned line by line, not retried');
    assert.equal(calls.full, 5, 'every line, the trailing empty one included, gets its own full scan');
  });
});

test('a pre-filter run of ONE line that times out is the answer: that line cannot be scanned either, and the scan refuses', () => {
  withPrefilterTimingOut((calls) => {
    assert.throws(() => scanText('hit', loadPatterns({ configPatterns: ['hit'] })), (err) => err.code === SCAN_TIMEOUT);
    assert.equal(calls.full, 0);
  });
});

test('after a pre-filter timeout, each line scanned one by one still earns its budget', () => {
  // In the one-line-per-call fallback the clock is read before every line
  // and each line adds its accrual after it is scanned. A floor of zero
  // with a clock that has moved by one millisecond only passes if the
  // lines already scanned paid for it.
  withPrefilterTimingOut(() => {
    const patterns = loadPatterns({ configPatterns: ['hit'] });
    const result = scanText('hit\nplain\nhit\n', patterns, { deadlineAt: 0, now: scriptedClock([0, 0, 1, 1, 1]), accrue: true });
    assert.equal(result.total, 2);
  });
});

// The pre-filter hands the sandbox the WHOLE text, split into lines, and
// the sandbox is one object reused for every scan of the process. The
// binding is cleared when the call returns, so a scan of a large file does
// not stay reachable, whole, until the next scan happens to overwrite it.
test('the sandbox does not keep the text of a scan alive once the scan has returned', () => {
  const real = vm.runInContext;
  let context = null;
  vm.runInContext = function stub(source, ctx, options) {
    if (source.includes('hits.push')) context = ctx;
    return real.call(this, source, ctx, options);
  };
  try {
    scanText('one line\nanother line\n', loadPatterns({ configPatterns: ['hit'] }));
  } finally {
    vm.runInContext = real;
  }
  assert.ok(context !== null, 'the pre-filter ran');
  assert.equal(context.lines, undefined);
});

// The full per-line scan's own two failures, reached the same way: its
// sandbox call answered with the engine's timeout, or with some other
// error, while the pre-filter runs for real and sends the line through.
function withFullScanFailing(error, body) {
  const real = vm.runInContext;
  vm.runInContext = function stub(source, context, options) {
    if (!source.includes('hits.push')) throw error;
    return real.call(this, source, context, options);
  };
  try {
    return body();
  } finally {
    vm.runInContext = real;
  }
}

test('the full per-line scan names a timeout as one and any other failure as something else, each with its code', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  withFullScanFailing(Object.assign(new Error('Script execution timed out.'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' }), () => {
    assert.throws(() => scanText('a hit here', patterns), (err) => err.code === SCAN_TIMEOUT && /took longer than/.test(err.message));
  });
  withFullScanFailing(new TypeError('something the engine said'), () => {
    assert.throws(() => scanText('a hit here', patterns), (err) => err.code === SCAN_FAILED && /not from a timeout/.test(err.message) && !/engine said/.test(err.message));
  });
});

// The pre-filter's own failure that is NOT a timeout. It refuses at once,
// as a failure: falling back to one call per line would treat a broken
// scanner as a slow one, and a fallback that then happened to succeed
// would hide the defect behind a clean result. The stub answers only the
// pre-filter's call with an engine error, so a fallback WOULD succeed here,
// which is what makes the difference visible on a text of several lines.
function withPrefilterFailing(error, body) {
  const real = vm.runInContext;
  const calls = { prefilter: 0, full: 0 };
  vm.runInContext = function stub(source, context, options) {
    if (source.includes('hits.push')) {
      calls.prefilter += 1;
      throw error;
    }
    calls.full += 1;
    return real.call(this, source, context, options);
  };
  try {
    return body(calls);
  } finally {
    vm.runInContext = real;
  }
}

test('a pre-filter failure that is not a timeout refuses at once, as a failure, never falling back, on one line or many', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  for (const text of ['plain', 'plain\nhit\nplain\n']) {
    withPrefilterFailing(new TypeError('something the engine said'), (calls) => {
      assert.throws(() => scanText(text, patterns), (err) => err.code === SCAN_FAILED && /not from a timeout/.test(err.message) && !/engine said/.test(err.message));
      assert.equal(calls.prefilter, 1);
      assert.equal(calls.full, 0, 'no line is scanned in full once the pre-filter itself has failed');
    });
  }
});

// The same failure reached for real, with no stub: a compiled list holding
// an entry that is not a regular expression. The line matches nothing
// before that entry, so it is the pre-filter, not the full scan, that meets
// it.
test('a real broken entry in the pattern list fails the pre-filter as a failure, not as a timeout', () => {
  const patterns = loadPatterns({ configPatterns: ['hit'] });
  patterns.push({ raw: 'not-really-a-pattern', origin: 'config', regex: 'not-a-regex-object' });
  assert.throws(() => scanText('plain words', patterns), (err) => err.code === SCAN_FAILED);
  assert.throws(() => scanText('plain\nwords\n', patterns), (err) => err.code === SCAN_FAILED);
});
