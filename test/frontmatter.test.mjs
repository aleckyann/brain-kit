// Frontmatter reader: the split of a note into frontmatter and body, and
// the handful of shapes (scalar, inline/block mapping, inline/block list,
// block list of mappings) the format actually uses, read from the
// frontmatter string alone. See src/frontmatter.mjs for why this is a
// regular-expression reader and not a YAML parser, and what that means for
// the three-way null/undefined/value contract every reader below shares.
//
// Fix round 1: every refusal assertion (an expected `undefined`) is paired
// in the same test with its nearest positive, the almost-identical shape
// that must still be read. A test that only checks for `undefined` is
// satisfied by a reader that never reads anything at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARSER_LIMITS, danglingItems, frontmatterKeyLine, readEntries, readList, readMapping, readScalar, splitFrontmatter } from '../src/frontmatter.mjs';

// --- splitFrontmatter --------------------------------------------------------

test('a file opening with --- on its first line has its frontmatter split off, and the body excludes the closing delimiter', () => {
  const text = '---\ntype: note\ndescription: an example note\n---\n# Title\n\nBody text.\n';
  const result = splitFrontmatter(text);
  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.frontmatter, 'type: note\ndescription: an example note');
  assert.equal(result.body, '# Title\n\nBody text.\n');
  assert.ok(!result.body.includes('---'), 'the body must not carry the closing delimiter');
});

test('a file with no frontmatter reports hasFrontmatter false and a body equal to the whole text', () => {
  const text = '# Just a title\n\nNo frontmatter here at all.\n';
  const result = splitFrontmatter(text);
  assert.equal(result.hasFrontmatter, false);
  assert.equal(result.body, text);
});

test('an empty frontmatter block (--- directly followed by ---) still splits, with an empty frontmatter string', () => {
  const text = '---\n---\nBody right after.\n';
  const result = splitFrontmatter(text);
  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.frontmatter, '');
  assert.equal(result.body, 'Body right after.\n');
});

test('a --- that appears later in the body, inside a fenced code block, is not treated as a frontmatter delimiter', () => {
  const text = [
    '---',
    'type: note',
    '---',
    '',
    'Example of the delimiter, shown for documentation:',
    '',
    '```',
    '---',
    'type: nested-example',
    '---',
    '```',
    '',
  ].join('\n');
  const result = splitFrontmatter(text);
  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.frontmatter, 'type: note');
  assert.ok(result.body.includes('type: nested-example'), 'the later --- pair must stay in the body untouched');
});

// --- line ending and byte-order mark normalization --------------------------

// Reads every field a real note would carry, through every one of this
// module's readers, so a single deep comparison shows whether a line
// ending or byte-order-mark difference changed any answer at all.
function readAllFields(text) {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(text);
  return {
    hasFrontmatter,
    body,
    type: readScalar(frontmatter, 'type'),
    title: readScalar(frontmatter, 'title'),
    generated: readMapping(frontmatter, 'generated'),
    tags: readList(frontmatter, 'tags'),
    sources: readEntries(frontmatter, 'sources'),
  };
}

const SAMPLE_NOTE_LF = [
  '---',
  'type: note',
  'title: Example',
  'generated: { by: brain-kit-curator/claude-opus-5, at: 2026-09-18T09:30:00Z }',
  'tags: [okf, spec]',
  'sources:',
  '  - resource: /docs/a.md',
  '    title: A',
  '---',
  '# Body',
  '',
  'More text.',
  '',
].join('\n');

test('a file with Windows line endings (CRLF) reads type and title correctly, not just generated, the last key', () => {
  // This is the exact defect found in review: with CRLF, every internal
  // line kept a trailing \r once split on "\n" alone, and only the LAST
  // key (with no trailing \r, since the outer strip removes exactly one
  // trailing line break) still read back correctly.
  const crlf = SAMPLE_NOTE_LF.replace(/\n/g, '\r\n');
  const lfResult = readAllFields(SAMPLE_NOTE_LF);
  const crlfResult = readAllFields(crlf);

  assert.equal(lfResult.type, 'note');
  assert.equal(crlfResult.type, 'note');
  assert.equal(lfResult.title, 'Example');
  assert.equal(crlfResult.title, 'Example');
  assert.deepEqual(crlfResult, lfResult);
});

test('a leading byte-order mark does not make a note read as having no frontmatter, and every field still matches the same file without one', () => {
  const bom = String.fromCharCode(0xfeff) + SAMPLE_NOTE_LF;
  const lfResult = readAllFields(SAMPLE_NOTE_LF);
  const bomResult = readAllFields(bom);

  assert.equal(lfResult.hasFrontmatter, true);
  assert.equal(bomResult.hasFrontmatter, true); // this is exactly what a leading BOM used to flip to false
  assert.deepEqual(bomResult, lfResult);
});

test('a byte-order mark combined with Windows line endings still reads identically to plain LF', () => {
  const bomCrlf = String.fromCharCode(0xfeff) + SAMPLE_NOTE_LF.replace(/\n/g, '\r\n');
  assert.deepEqual(readAllFields(bomCrlf), readAllFields(SAMPLE_NOTE_LF));
});

// --- readScalar ---------------------------------------------------------------

test('readScalar reads a plain value', () => {
  assert.equal(readScalar('type: note', 'type'), 'note');
});

test('readScalar reads a quoted value', () => {
  assert.equal(readScalar('title: "Example, with a comma"', 'title'), 'Example, with a comma');
});

test('readScalar reads a value containing a colon', () => {
  assert.equal(readScalar('resource: https://example.com/path', 'resource'), 'https://example.com/path');
});

test('readScalar returns null for an absent key', () => {
  assert.equal(readScalar('type: note', 'title'), null);
});

test('readScalar does not match a key that merely appears inside another line', () => {
  const frontmatter = 'description: see the type: field below for the real value\ntype: note';
  assert.equal(readScalar(frontmatter, 'type'), 'note');
});

test('a key with a space before its colon still reads, the same as one with no space', () => {
  assert.equal(readScalar('type : note', 'type'), 'note');
  assert.equal(readScalar('type: note', 'type'), 'note');
});

test('readScalar returns undefined for a block or folded scalar header, but still reads a plain one-line value for the same key', () => {
  assert.equal(readScalar('description: |\n  line one\n  line two', 'description'), undefined);
  assert.equal(readScalar('description: a plain one-line value', 'description'), 'a plain one-line value');
});

test('readScalar returns undefined for a plain value folded across indented continuation lines with an empty key line, but still reads a single-line value for the same key', () => {
  const folded = 'description:\n  first line\n  second line';
  const singleLine = 'description: first line only';
  assert.equal(readScalar(folded, 'description'), undefined);
  assert.equal(readScalar(singleLine, 'description'), 'first line only');
});

// Fix round 2: the same fold, but the key's own line already carries the
// first line of the value instead of being left empty. Before this round,
// only the empty-key-line spelling above was caught; this one silently
// dropped the continuation and returned just the first line, a confident
// value indistinguishable from a note whose description really is one
// line short.
test('readScalar returns undefined for a plain value folded across continuation lines even when the key line already carries the first line of the value, but still reads a single-line value with no continuation at all', () => {
  const folded = 'description: a long line\n  continued here';
  const singleLine = 'description: a long line';
  assert.equal(readScalar(folded, 'description'), undefined);
  assert.equal(readScalar(singleLine, 'description'), 'a long line');
});

test('readScalar reads an empty string for a key with truly nothing after it and nothing indented underneath, distinct from both folded cases above', () => {
  assert.equal(readScalar('description:', 'description'), '');
});

// Fix round 2's neighbour check: a key that is really a block mapping or a
// block list must decline through readScalar the same way a folded plain
// scalar does, never returning just the fragment on the key's own line.
test('readScalar returns undefined for a key that is really a block mapping or a block list, the same as a folded plain scalar, but still reads a simple scalar key normally', () => {
  const asMapping = 'generated:\n  by: human:ana\n  at: 2026-01-01T00:00:00Z';
  const asList = 'tags:\n  - okf\n  - spec';
  assert.equal(readScalar(asMapping, 'generated'), undefined);
  assert.equal(readScalar(asList, 'tags'), undefined);
  assert.equal(readScalar('type: note', 'type'), 'note');
});

test('readScalar returns the raw line text, marker included, for a value carrying a YAML anchor', () => {
  const frontmatter = 'generated: &g1 { by: human:ana, at: 2026-01-01T00:00:00Z }';
  assert.equal(readScalar(frontmatter, 'generated'), '&g1 { by: human:ana, at: 2026-01-01T00:00:00Z }');
});

// A quoted key ("type": note or 'type': note) is legal YAML. Fix round 1
// of task 4 found it read as absent, which is exactly the wrong outcome
// under the two-absences contract for a key that is plainly on screen.
test('readScalar finds a key written with double or single quotes around it, the same as the bare key', () => {
  assert.equal(readScalar('"type": note', 'type'), 'note');
  assert.equal(readScalar("'type': note", 'type'), 'note');
  assert.equal(readScalar('type: note', 'type'), 'note');
});

// A "#" preceded by a space starts a YAML comment in an unquoted value,
// and readScalar strips it (fix round 1 of task 4): a status or a date
// with a trailing comment used to read as an unreadable, folded value,
// when the value was plainly a single line with a note attached to it.
test('readScalar strips a trailing comment from an unquoted value, but leaves a quoted value untouched even when it contains a hash', () => {
  assert.equal(readScalar('status: stable # confirmed after the last review', 'status'), 'stable');
  assert.equal(readScalar('title: "issue #42"', 'title'), 'issue #42');
});

// Fix round 3: a quoted value followed by a REAL trailing comment (after
// the closing quote, not a "#" inside the quoted span) used to misread,
// since the earlier version of stripTrailingComment treated "opens with
// a quote" as "nothing else follows this line": the comment stayed
// glued to the value, unquote's first/last-character check then failed,
// and the whole thing came back with its quotes and its comment intact.
test('readScalar strips a trailing comment after a closing quote too, but still leaves a hash inside the quotes alone when nothing follows', () => {
  assert.equal(readScalar('status: "stable" # confirmed after the last review', 'status'), 'stable');
  assert.equal(readScalar('title: "issue #42" # and it is still open', 'title'), 'issue #42');
  assert.equal(readScalar('title: "issue #42"', 'title'), 'issue #42');
});

test('readScalar treats a "#" with no preceding space as part of the value, not as a comment marker', () => {
  assert.equal(readScalar('tag: item#5', 'tag'), 'item#5');
});

// --- readMapping ---------------------------------------------------------------

test('readMapping reads an inline mapping and tolerates extra spaces', () => {
  const frontmatter = 'generated:   {  by:   brain-kit-curator/claude-opus-5 ,  at:  2026-09-18T09:30:00Z  }';
  assert.deepEqual(readMapping(frontmatter, 'generated'), {
    by: 'brain-kit-curator/claude-opus-5',
    at: '2026-09-18T09:30:00Z',
  });
});

test('readMapping reads the same key written as an indented block', () => {
  const frontmatter = 'generated:\n  by: brain-kit-curator/claude-opus-5\n  at: 2026-09-18T09:30:00Z';
  assert.deepEqual(readMapping(frontmatter, 'generated'), {
    by: 'brain-kit-curator/claude-opus-5',
    at: '2026-09-18T09:30:00Z',
  });
});

// This is the exact shape the format's actor syntax produces (human:<handle>),
// and the case that forces a first-colon-only split: splitting on every colon
// would break "human:ana" into two pieces instead of leaving it as one value.
test('readMapping splits each pair on its first colon only, so an unquoted actor value survives whole', () => {
  const frontmatter = 'verified: { by: human:ana, at: 2026-07-22T11:59:16Z }';
  assert.deepEqual(readMapping(frontmatter, 'verified'), {
    by: 'human:ana',
    at: '2026-07-22T11:59:16Z',
  });
});

test('readMapping keeps a quoted value containing a comma intact', () => {
  const frontmatter = 'note: { label: "hello, this has a comma", at: 2026-01-01T00:00:00Z }';
  assert.deepEqual(readMapping(frontmatter, 'note'), {
    label: 'hello, this has a comma',
    at: '2026-01-01T00:00:00Z',
  });
});

test('readMapping returns null for an absent key', () => {
  assert.equal(readMapping('type: note', 'generated'), null);
});

// findKeyLine is the one function every reader calls to find a key's
// line, so fixing quoted-key support there (see readScalar's own test)
// means readMapping finds the same key with no change of its own.
test('readMapping finds a key written with quotes around it too, since quoted-key support lives in the one shared line finder', () => {
  assert.deepEqual(readMapping('"generated": { by: human:ana, at: 2026-01-01T00:00:00Z }', 'generated'), {
    by: 'human:ana',
    at: '2026-01-01T00:00:00Z',
  });
});

test('readMapping reads an empty inline mapping as an empty object', () => {
  assert.deepEqual(readMapping('generated: {}', 'generated'), {});
});

test('readMapping reads an empty indented block (key present, nothing under it) as an empty object', () => {
  assert.deepEqual(readMapping('generated:', 'generated'), {});
});

test('readMapping returns undefined for a nested mapping value, but still reads the flat mapping when nothing is nested', () => {
  const flat = 'generated: { by: brain-kit-curator/claude-opus-5, at: 2026-01-01T00:00:00Z }';
  const nested = 'generated: { by: { kind: human, handle: ana }, at: 2026-01-01T00:00:00Z }';
  assert.deepEqual(readMapping(flat, 'generated'), { by: 'brain-kit-curator/claude-opus-5', at: '2026-01-01T00:00:00Z' });
  assert.equal(readMapping(nested, 'generated'), undefined);
});

test('readMapping returns undefined for a block form where one line nests a mapping on itself, but still reads the same block when that one line is flat', () => {
  const flat = 'generated:\n  by: brain-kit-curator/claude-opus-5\n  at: 2026-01-01T00:00:00Z';
  const nested = 'generated:\n  by: { nested: true }\n  at: 2026-01-01T00:00:00Z';
  assert.deepEqual(readMapping(flat, 'generated'), { by: 'brain-kit-curator/claude-opus-5', at: '2026-01-01T00:00:00Z' });
  assert.equal(readMapping(nested, 'generated'), undefined);
});

test('readMapping returns undefined for a block form with inconsistent indentation, but still reads it when every line shares one indentation', () => {
  const uniform = 'generated:\n  by: brain-kit-curator/claude-opus-5\n  at: 2026-01-01T00:00:00Z';
  const nested = 'generated:\n  by:\n    kind: human\n    handle: ana\n  at: 2026-01-01T00:00:00Z';
  assert.deepEqual(readMapping(uniform, 'generated'), { by: 'brain-kit-curator/claude-opus-5', at: '2026-01-01T00:00:00Z' });
  assert.equal(readMapping(nested, 'generated'), undefined);
});

test('readMapping returns undefined when the block under the key is a list, but still reads the same fields written as a mapping', () => {
  const asMapping = 'verified:\n  by: human:ana\n  at: 2026-01-01T00:00:00Z';
  const asList = 'verified:\n  - by: human:ana\n    at: 2026-01-01T00:00:00Z';
  assert.deepEqual(readMapping(asMapping, 'verified'), { by: 'human:ana', at: '2026-01-01T00:00:00Z' });
  assert.equal(readMapping(asList, 'verified'), undefined);
});

test('readMapping returns undefined for a single-level block whose one line is a list entry, but still reads it when that one line is a mapping pair', () => {
  // Unlike the case above, this block has only one line, so it cannot be
  // caught by the indentation-uniformity check: the entry-marker check
  // alone must reject it.
  const asMapping = 'verified:\n  by: human:ana';
  const asList = 'verified:\n  - by: human:ana';
  assert.deepEqual(readMapping(asMapping, 'verified'), { by: 'human:ana' });
  assert.equal(readMapping(asList, 'verified'), undefined);
});

test('readMapping returns undefined for a value carrying a YAML anchor, but still reads the identical value once the anchor is removed', () => {
  const withAnchor = 'generated: &g1 { by: human:ana, at: 2026-01-01T00:00:00Z }';
  const withoutAnchor = 'generated: { by: human:ana, at: 2026-01-01T00:00:00Z }';
  assert.equal(readMapping(withAnchor, 'generated'), undefined);
  assert.deepEqual(readMapping(withoutAnchor, 'generated'), { by: 'human:ana', at: '2026-01-01T00:00:00Z' });
});

test('readMapping returns undefined when the key holds a plain scalar instead of a mapping, but still reads a real mapping under a different key', () => {
  assert.equal(readMapping('type: note', 'type'), undefined);
  assert.deepEqual(readMapping('generated: { by: human:ana, at: 2026-01-01T00:00:00Z }', 'generated'), {
    by: 'human:ana',
    at: '2026-01-01T00:00:00Z',
  });
});

// --- readList --------------------------------------------------------------

test('readList reads the bracketed inline form', () => {
  assert.deepEqual(readList('tags: [okf, spec, example]', 'tags'), ['okf', 'spec', 'example']);
});

test('readList reads the block form with hyphens', () => {
  const frontmatter = 'tags:\n  - okf\n  - spec\n  - example';
  assert.deepEqual(readList(frontmatter, 'tags'), ['okf', 'spec', 'example']);
});

test('readList returns null for an absent key', () => {
  assert.equal(readList('type: note', 'tags'), null);
});

test('readList reads an empty inline list as an empty array, not a one-element array', () => {
  assert.deepEqual(readList('tags: []', 'tags'), []);
});

test('readList reads a key with nothing under it (no inline value, no block lines) as an empty array', () => {
  assert.deepEqual(readList('tags:', 'tags'), []);
});

test('readList returns undefined when the key holds a plain scalar instead of a list, but still reads a real list under a different key', () => {
  assert.equal(readList('type: note', 'type'), undefined);
  assert.deepEqual(readList('tags: [okf, spec]', 'tags'), ['okf', 'spec']);
});

test('readList returns undefined when the block under the key is not plain list entries, but still reads it once the entries are plain values', () => {
  const asMapping = 'tags:\n  color: blue';
  const asList = 'tags:\n  - blue';
  assert.equal(readList(asMapping, 'tags'), undefined);
  assert.deepEqual(readList(asList, 'tags'), ['blue']);
});

test('readList returns undefined for a block of single-field mapping entries, the exact shape sources takes in real notes, but still reads plain scalar entries the same way', () => {
  const asMappingEntries = 'sources:\n  - resource: /docs/a.md\n  - resource: /docs/b.md';
  const asPlainEntries = 'sources:\n  - /docs/a.md\n  - /docs/b.md';
  assert.equal(readList(asMappingEntries, 'sources'), undefined);
  assert.deepEqual(readList(asPlainEntries, 'sources'), ['/docs/a.md', '/docs/b.md']);
});

// --- readEntries -----------------------------------------------------------

test('readEntries reads a block list of mappings, returning one object per entry', () => {
  const accentedWord = `caf${String.fromCharCode(233)}`; // one non-ASCII codepoint (e-acute), built at runtime so this source file stays ASCII-only
  const frontmatter = [
    'sources:',
    '  - id: example-source',
    '    resource: /docs/example.md',
    '    title: Example Title',
    '    author: human:ana',
    `    description: "a summary, with a comma: and ${accentedWord} too"`,
    '  - resource: https://example.com/page',
  ].join('\n');

  const entries = readEntries(frontmatter, 'sources');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    id: 'example-source',
    resource: '/docs/example.md',
    title: 'Example Title',
    author: 'human:ana',
    description: `a summary, with a comma: and ${accentedWord} too`,
  });
  assert.deepEqual(entries[1], { resource: 'https://example.com/page' });
});

test('readEntries returns null for an absent key', () => {
  assert.equal(readEntries('type: note', 'sources'), null);
});

test('readEntries reads a key with nothing under it as an empty array', () => {
  assert.deepEqual(readEntries('sources:', 'sources'), []);
});

test('readEntries returns undefined when the key holds an inline value instead of a block, but still reads the block form under the same key name', () => {
  assert.equal(readEntries('sources: nothing-useful', 'sources'), undefined);
  assert.deepEqual(readEntries('sources:\n  - resource: /docs/a.md', 'sources'), [{ resource: '/docs/a.md' }]);
});

test('readEntries returns undefined when the block does not open with an entry marker, but still reads it once it does', () => {
  const noMarker = 'sources:\n  resource: /docs/example.md';
  const withMarker = 'sources:\n  - resource: /docs/example.md';
  assert.equal(readEntries(noMarker, 'sources'), undefined);
  assert.deepEqual(readEntries(withMarker, 'sources'), [{ resource: '/docs/example.md' }]);
});

// --- readEntries: a list of inline mappings, the format's own 5.2 shape ------
//
// The Open Knowledge Format's section 5.2 writes `verified` as a block list
// whose entries are inline mappings. The reader used to split each entry on
// its first colon like a block field, so the format's own example came back
// as one key named "{ by" per entry. The first test holds that example
// VERBATIM, copied from the canonical SPEC.md, beside the block form of the
// same two events.

const SPEC_5_2_VERIFIED = [
  'verified:',
  '  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }',
  '  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }',
].join('\n');

const SPEC_5_2_VERIFIED_BLOCK = [
  'verified:',
  '  - by: human:ahormati',
  '    at: 2026-06-25T09:00:00Z',
  '  - by: process:finance-nightly',
  '    at: 2026-06-26T02:00:00Z',
].join('\n');

const SPEC_5_2_EVENTS = [
  { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
  { by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' },
];

test('readEntries reads the format\x27s own section 5.2 example, a list of inline mappings, exactly as it reads the block form of the same events', () => {
  assert.deepEqual(readEntries(SPEC_5_2_VERIFIED, 'verified'), SPEC_5_2_EVENTS);
  assert.deepEqual(readEntries(SPEC_5_2_VERIFIED_BLOCK, 'verified'), SPEC_5_2_EVENTS);
});

test('readEntries reads an inline entry with quoted values, a comma inside a quote, a trailing comment, and an empty mapping, and mixes inline and block entries in one list', () => {
  const frontmatter = [
    'verified:',
    '  - { by: "human:ana", at: \x272026-06-25T09:00:00Z\x27, note: "checked, twice" } # the owner',
    '  - {}',
    '  - by: process:nightly',
    '    at: 2026-06-26T02:00:00Z',
  ].join('\n');
  assert.deepEqual(readEntries(frontmatter, 'verified'), [
    { by: 'human:ana', at: '2026-06-25T09:00:00Z', note: 'checked, twice' },
    {},
    { by: 'process:nightly', at: '2026-06-26T02:00:00Z' },
  ]);
});

test('readEntries declines, for the whole field, every inline entry it cannot read whole, rather than returning a key nobody wrote', () => {
  const shapes = {
    'a brace that never closes on its line': '  - { by: human:ana,\n      at: 2026-06-25T09:00:00Z }',
    'a nested mapping as a value': '  - { by: { name: ana }, at: 2026-06-25T09:00:00Z }',
    'a nested list as a value': '  - { by: [human:ana], at: 2026-06-25T09:00:00Z }',
    'text after the closing brace': '  - { by: human:ana } at: 2026-06-25T09:00:00Z',
    'a comment with no space before it': '  - { by: human:ana }# note',
    'field lines under an inline entry': '  - { by: human:ana }\n    at: 2026-06-25T09:00:00Z',
    'a pair with no colon': '  - { human-ana }',
  };
  for (const [name, entry] of Object.entries(shapes)) {
    const frontmatter = `verified:\n  - { by: human:ok, at: 2026-06-24T09:00:00Z }\n${entry}`;
    assert.equal(readEntries(frontmatter, 'verified'), undefined, name);
  }
  // Control: the first entry alone, which every shape above extends, reads.
  assert.deepEqual(readEntries('verified:\n  - { by: human:ok, at: 2026-06-24T09:00:00Z }', 'verified'), [{ by: 'human:ok', at: '2026-06-24T09:00:00Z' }]);
});

test('readEntries declines a block entry line that is not a field, instead of splitting it on its first colon', () => {
  // A brace opening a continuation line used to come back as a key "{a";
  // a colon not followed by whitespace is not a YAML key separator, and
  // "- https://example.com" used to come back as a key "https".
  assert.equal(readEntries('sources:\n  - resource: /a.md\n    { a: 1 }', 'sources'), undefined);
  assert.equal(readEntries('sources:\n  - resource: /a.md\n    [a: 1]', 'sources'), undefined);
  assert.equal(readEntries('sources:\n  - https://example.com/page', 'sources'), undefined);
  // Controls: a field whose VALUE holds colons, a field with an empty
  // value, and a field whose value is an inline mapping are read as before.
  assert.deepEqual(readEntries('sources:\n  - resource: https://example.com/page\n    author: human:ana', 'sources'), [{ resource: 'https://example.com/page', author: 'human:ana' }]);
  assert.deepEqual(readEntries('sources:\n  - resource: /a.md\n    title:', 'sources'), [{ resource: '/a.md', title: '' }]);
  assert.deepEqual(readEntries('sources:\n  - resource: /a.md\n    usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }', 'sources'), [{ resource: '/a.md', usage_window: '{ from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }' }]);
});

test('readEntries reads a field with nested lines under it as undefined, never folding them into the entry, and keeps reading the entry\x27s other fields', () => {
  // A nested "by:" under an event's own "note:" used to replace the event's
  // "by", and a nested list's items used to become entries of their own.
  const nestedMapping = 'verified:\n  - by: human:ana\n    note:\n      by: process:other\n    at: 2026-06-25T09:00:00Z';
  const events = readEntries(nestedMapping, 'verified');
  assert.equal(events.length, 1);
  assert.equal(events[0].by, 'human:ana');
  assert.equal(events[0].at, '2026-06-25T09:00:00Z');
  assert.ok(Object.hasOwn(events[0], 'note') && events[0].note === undefined, 'the nested field is present and unreadable');

  const nestedList = 'sources:\n  - resource: /a.md\n    tags:\n      - x\n      - y\n  - resource: /b.md';
  const sources = readEntries(nestedList, 'sources');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].resource, '/a.md');
  assert.ok(Object.hasOwn(sources[0], 'tags') && sources[0].tags === undefined);
  assert.deepEqual(sources[1], { resource: '/b.md' });

  const folded = readEntries('sources:\n  - resource: /a.md\n    title: a long title\n      folded onto a second line', 'sources');
  assert.equal(folded[0].resource, '/a.md');
  assert.ok(Object.hasOwn(folded[0], 'title') && folded[0].title === undefined);
});

test('readEntries reads fields that start on the line after a bare marker, and declines a field indented less than the first one or a line back at the markers', () => {
  assert.deepEqual(readEntries('sources:\n  -\n    resource: /a.md\n    id: a', 'sources'), [{ resource: '/a.md', id: 'a' }]);
  assert.deepEqual(readEntries('sources:\n  - resource: /a.md\n    id: a', 'sources'), [{ resource: '/a.md', id: 'a' }]);
  assert.equal(readEntries('sources:\n  - resource: /a.md\n   id: a', 'sources'), undefined);
  assert.equal(readEntries('sources:\n  - resource: /a.md\n  id: a', 'sources'), undefined);
  assert.equal(readEntries('sources:\n    - resource: /a.md\n  - resource: /b.md', 'sources'), undefined);
  // A bare marker whose next line is back at the markers is not an entry
  // with that line as its field.
  assert.equal(readEntries('sources:\n  -\n  resource: /a.md', 'sources'), undefined);
});

test('readEntries reads a bare marker with nothing under it as an empty entry, beside the entries around it', () => {
  assert.deepEqual(readEntries('sources:\n  -\n  - resource: /a.md', 'sources'), [{}, { resource: '/a.md' }]);
  assert.deepEqual(readEntries('sources:\n  - resource: /a.md\n  -', 'sources'), [{ resource: '/a.md' }, {}]);
});

// --- escaped quotes inside an inline mapping or list value -------------------

// A backslash before a quote is not treated as an escape (PARSER_LIMITS).
// These pin down the actual, verified consequence, reproduced directly
// against the implementation before being written here: no value is ever
// silently truncated. An EVEN number of quote characters in the value
// still finds the real closing brace or bracket (the toggling in and out
// of "inside a quote" cancels out), and the value comes back whole, with
// the backslash preserved literally rather than interpreted. An ODD
// number leaves the scanner "inside a quote" when it reaches the real
// closing brace or bracket, which is therefore never found, and the whole
// field is undefined rather than a partial or corrupted value.

test('an even number of quote characters in an inline mapping value still finds the closing brace and reads the value back whole, backslash included, but an odd number never finds it and the whole field is undefined instead of a truncated value', () => {
  const even = 'note: { label: "she said \\"hi\\" to me", at: 2026-01-01T00:00:00Z }';
  const odd = 'note: { label: "she said \\"hi to me", at: 2026-01-01T00:00:00Z }';
  assert.deepEqual(readMapping(even, 'note'), {
    label: 'she said \\"hi\\" to me',
    at: '2026-01-01T00:00:00Z',
  });
  assert.equal(readMapping(odd, 'note'), undefined);
});

test('the same even/odd rule applies to an inline list: an even count reads the value back whole, an odd count returns undefined for the whole list', () => {
  const even = 'tags: ["a \\"b\\" c", d]';
  const odd = 'tags: ["a \\"b c", d]';
  assert.deepEqual(readList(even, 'tags'), ['a \\"b\\" c', 'd']);
  assert.equal(readList(odd, 'tags'), undefined);
});

// --- PARSER_LIMITS -----------------------------------------------------------

test('PARSER_LIMITS is non-empty and every entry is a short, concrete, ASCII sentence with no em dash', () => {
  assert.ok(Array.isArray(PARSER_LIMITS));
  assert.ok(PARSER_LIMITS.length > 0);
  for (const entry of PARSER_LIMITS) {
    assert.equal(typeof entry, 'string');
    assert.ok(entry.length > 0 && entry.length < 320, `entry should be a short sentence: ${entry}`);
    assert.ok(/^[\x00-\x7F]*$/.test(entry), `entry must be ASCII only: ${entry}`);
    assert.ok(!entry.includes(String.fromCharCode(0x2014)), `entry must not contain an em dash: ${entry}`);
  }
});

const READER_FUNCTION_NAMES = ['readScalar', 'readMapping', 'readList', 'readEntries'];

test('PARSER_LIMITS entries are concrete, not vague: each names a reader function and the return value it produces for the shape it describes', () => {
  // A vague entry like "some values may not be read correctly" would pass
  // every check above (it is short, ASCII, no em dash) and still tell a
  // reader of the validator's output nothing about what actually happens.
  // This is what let the two wrong entries in fix round 1 ship in the
  // first place: nothing checked that PARSER_LIMITS said anything
  // specific enough to be wrong.
  for (const entry of PARSER_LIMITS) {
    assert.ok(
      READER_FUNCTION_NAMES.some((name) => entry.includes(name)),
      `entry does not name a reader function, so a vague sentence would pass this check: ${entry}`,
    );
    // Almost every entry here describes a decline, and says so with the
    // word "undefined". Fix round 1 of task 4 added one entry of a
    // different kind: a correct, non-declining behaviour (readScalar
    // stripping a trailing comment) that is still worth naming because it
    // can surprise. That entry says "returns" instead, so this check
    // accepts either word rather than only the one every entry happened
    // to use before this kind of entry existed.
    assert.ok(
      entry.includes('undefined') || entry.includes('returns'),
      `entry does not say what it returns: ${entry}`,
    );
  }
});

// --- cross-cutting: the fenced-code-block guarantee, and defensive inputs ----

test('a key inside a fenced code block in the body is never read as frontmatter', () => {
  const text = [
    '---',
    'type: note',
    '---',
    '',
    'Example of the shape, for documentation only:',
    '',
    '```',
    'generated: { by: human:ana, at: 2026-01-01T00:00:00Z }',
    '```',
    '',
  ].join('\n');
  const { frontmatter } = splitFrontmatter(text);
  assert.equal(readMapping(frontmatter, 'generated'), null);
});

test('every reader is safe to call on an empty or missing frontmatter, and reports every key absent', () => {
  for (const frontmatter of ['', null, undefined]) {
    assert.doesNotThrow(() => {
      readScalar(frontmatter, 'type');
      readMapping(frontmatter, 'generated');
      readList(frontmatter, 'tags');
      readEntries(frontmatter, 'sources');
    });
    assert.equal(readScalar(frontmatter, 'type'), null);
    assert.equal(readMapping(frontmatter, 'generated'), null);
    assert.equal(readList(frontmatter, 'tags'), null);
    assert.equal(readEntries(frontmatter, 'sources'), null);
  }
});

// --- frontmatterKeyLine ------------------------------------------------------
//
// Shared by both rules modules, which used to each carry their own copy:
// one dropped the quoted-key alternative findKeyLine already recognises,
// the other built a RegExp from the key text without escaping it, which
// throws for a config-supplied field name containing a metacharacter.
// Sharing this one implementation is what makes both bugs impossible by
// construction rather than fixed twice.

test('frontmatterKeyLine finds a bare key\x27s line, and null for an absent one', () => {
  const frontmatter = 'type: note\ndescription: an example';
  assert.equal(frontmatterKeyLine(frontmatter, 'description'), 3); // line 1 is "---", line 2 is "type", line 3 is "description"
  assert.equal(frontmatterKeyLine(frontmatter, 'missing'), null);
});

test('frontmatterKeyLine finds a double- or single-quoted key at its own line, not null as if it were absent', () => {
  const doubleQuoted = 'type: note\n"description": an example';
  const singleQuoted = "type: note\n'description': an example";
  assert.equal(frontmatterKeyLine(doubleQuoted, 'description'), 3);
  assert.equal(frontmatterKeyLine(singleQuoted, 'description'), 3);
});

test('frontmatterKeyLine never throws for a key containing a regular-expression metacharacter, and still finds its real line', () => {
  const frontmatter = 'type: note\n"a(b": v';
  let line;
  assert.doesNotThrow(() => {
    line = frontmatterKeyLine(frontmatter, 'a(b');
  });
  assert.equal(line, 3);
});

test('frontmatterKeyLine does not match a key that merely appears as a word inside another line\x27s value', () => {
  const frontmatter = 'description: see also description-of-thing\ndescription: real one';
  assert.equal(frontmatterKeyLine(frontmatter, 'description'), 2); // the first, top-level "description:" line, not the mention inside the value
});

test('frontmatterKeyLine returns null for null or empty frontmatter, never throwing', () => {
  for (const frontmatter of [null, '']) {
    let line;
    assert.doesNotThrow(() => {
      line = frontmatterKeyLine(frontmatter, 'type');
    });
    assert.equal(line, null);
  }
});

// --- danglingItems -------------------------------------------------------------
//
// The diagnosis behind extension-fields' frontmatter-dangling-items finding
// (incidents of 26/09 and 30/09/2026: a new `sources` entry written after a
// boolean's line, at the end of the frontmatter). Every positive below is
// paired with the nearest shape YAML really allows, which must come back
// null so the caller keeps its generic finding. `line` counts in the whole
// file: frontmatter line 0 is the file's line 2.

const SOURCES_ABOVE = ['sources:', '  - resource: /memory/log.md'];
const TAGS_ABOVE = ['tags:', '  - person'];
const BOTH_ABOVE = [...SOURCES_ABOVE, ...TAGS_ABOVE];

function fm(...lines) {
  return lines.join('\n');
}

test('danglingItems names the first dangling item\x27s line and the list above, after a boolean, and the readers still decline and read exactly what they did', () => {
  const frontmatter = fm('type: person', ...SOURCES_ABOVE, 'confidential: true', '  - resource: /people/ana.md', '    last_modified: 2026-09-30T10:00:00Z');
  assert.deepEqual(danglingItems(frontmatter, 'confidential'), { line: 6, list: 'sources' });
  // A diagnosis, not a reader: readScalar still declines the field, and
  // the list above still reads only its own item.
  assert.equal(readScalar(frontmatter, 'confidential'), undefined);
  assert.deepEqual(readEntries(frontmatter, 'sources'), [{ resource: '/memory/log.md' }]);
});

test('danglingItems finds the same shape after a quoted string, after a value with a trailing comment, and after a date', () => {
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'author: "Ana"', '  - resource: /a.md'), 'author'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, "author: 'Ana' # the owner", '  - resource: /a.md'), 'author'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'confidential: true # set by hand', '  - resource: /a.md'), 'confidential'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'review_date: 2026-09-30', '  - resource: /a.md'), 'review_date'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'confidential: true', '  -', '    resource: /a.md'), 'confidential'), { line: 5, list: 'sources' }, 'a bare marker with its fields under it is an item too');
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'confidential: true', '\t- resource: /a.md'), 'confidential'), { line: 5, list: 'sources' }, 'tab indentation, as collectBlock reads it');
});

test('danglingItems reads an escaped quote as data: a quoted value that really closes on its key line is a scalar, however it is escaped', () => {
  // Inside double quotes a backslash escapes the next character, so an
  // escaped backslash leaves the closing quote a real close; inside single
  // quotes a doubled quote is one literal quote and a backslash is only a
  // backslash. A " #" after an escaped quote is still inside the span.
  assert.deepEqual(danglingItems(fm(...TAGS_ABOVE, 'author: "Ana \\\\"', '  - and Bruno'), 'author'), { line: 5, list: 'tags' });
  assert.deepEqual(danglingItems(fm(...TAGS_ABOVE, "author: 'it''s'", '  - notes'), 'author'), { line: 5, list: 'tags' });
  assert.deepEqual(danglingItems(fm(...TAGS_ABOVE, "author: 'a\\'", '  - notes'), 'author'), { line: 5, list: 'tags' });
  assert.deepEqual(danglingItems(fm(...TAGS_ABOVE, 'author: "a \\" # b"', '  - notes'), 'author'), { line: 5, list: 'tags' });
});

test('danglingItems names the NEAREST list above, skipping keys that are not lists, and finds a list on the first frontmatter line', () => {
  const twoLists = fm('tags:', '  - example', 'sources:', '  - resource: /a.md', 'status: stable', 'confidential: true', '  - resource: /b.md');
  assert.deepEqual(danglingItems(twoLists, 'confidential'), { line: 8, list: 'sources' });
  const nearestIsFirst = fm('tags:', '  - example', 'aliases:', '  - Ana', 'confidential: true', '  - person');
  assert.deepEqual(danglingItems(nearestIsFirst, 'confidential'), { line: 7, list: 'aliases' });
  const onlyOnLineZero = fm('sources:', '  - resource: /a.md', 'type: person', 'confidential: true', '  - resource: /b.md');
  assert.deepEqual(danglingItems(onlyOnLineZero, 'confidential'), { line: 6, list: 'sources' });
  // A list key written quoted or with an anchor is still a list key, and
  // one held by a dangling key of its own is not a list at all.
  assert.deepEqual(danglingItems(fm('"sources":', '  - resource: /a.md', 'confidential: true', '  - resource: /b.md'), 'confidential'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(fm('sources: &s # the notes', '  - resource: /a.md', 'confidential: true', '  - resource: /b.md'), 'confidential'), { line: 5, list: 'sources' });
  const twoGroups = fm(...SOURCES_ABOVE, 'author: Ana', '  - resource: /b.md', 'confidential: true', '  - resource: /c.md');
  assert.deepEqual(danglingItems(twoGroups, 'author'), { line: 5, list: 'sources' });
  assert.deepEqual(danglingItems(twoGroups, 'confidential'), { line: 7, list: 'sources' });
});

test('danglingItems names the list whose entries look like the dangling item, not merely the nearest list: a source is never sent to the tags', () => {
  // The review's reproduction: `tags` written between `sources` and the
  // dangling key. Naming the nearest list sent the source to `tags`,
  // where it passed validate unread.
  const tagsBetween = fm(...SOURCES_ABOVE, 'tags:', '  - person', 'confidential: true', '  - resource: /memory/log.md', '    title: second');
  assert.deepEqual(danglingItems(tagsBetween, 'confidential'), { line: 7, list: 'sources' });
  const aliasesBetween = fm(...SOURCES_ABOVE, 'aliases:', '  - Ana', 'confidential: true', '  - resource: /memory/log.md');
  assert.deepEqual(danglingItems(aliasesBetween, 'confidential'), { line: 7, list: 'sources' });
  // Its pair: a scalar item in the same layout belongs to the scalar list.
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, 'tags:', '  - person', 'confidential: true', '  - example'), 'confidential'), { line: 7, list: 'tags' });
  assert.deepEqual(danglingItems(fm('tags:', '  - person', ...SOURCES_ABOVE, 'confidential: true', '  - example'), 'confidential'), { line: 7, list: 'tags' });

  // For a mapping item, the list whose first entry starts with the same
  // field wins over a nearer one that only shares a later field...
  const firstFieldWins = fm(...SOURCES_ABOVE, 'links:', '  - url: https://example.com', '    resource: /a.md', 'confidential: true', '  - resource: /b.md');
  assert.deepEqual(danglingItems(firstFieldWins, 'confidential'), { line: 8, list: 'sources' });
  // ...and a list sharing any field is named when none starts with it, in
  // either direction.
  const listStartsElsewhere = fm('sources:', '  - title: the log', '    resource: /a.md', ...TAGS_ABOVE, 'confidential: true', '  - resource: /b.md');
  assert.deepEqual(danglingItems(listStartsElsewhere, 'confidential'), { line: 8, list: 'sources' });
  const itemStartsElsewhere = fm(...SOURCES_ABOVE, ...TAGS_ABOVE, 'confidential: true', '  - title: second', '    resource: /b.md');
  assert.deepEqual(danglingItems(itemStartsElsewhere, 'confidential'), { line: 7, list: 'sources' });

  // An inline mapping entry is a mapping, above or dangling, and so is a
  // bare marker whose fields follow a comment; a quoted field name is the
  // same field.
  assert.deepEqual(danglingItems(fm('sources:', '  - { resource: /a.md }', ...TAGS_ABOVE, 'confidential: true', '  - resource: /b.md'), 'confidential'), { line: 7, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, ...TAGS_ABOVE, 'confidential: true', '  - { resource: /b.md }'), 'confidential'), { line: 7, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, ...TAGS_ABOVE, 'confidential: true', '  - # the log', '    resource: /b.md'), 'confidential'), { line: 7, list: 'sources' });
  assert.deepEqual(danglingItems(fm(...SOURCES_ABOVE, ...TAGS_ABOVE, 'confidential: true', '  - "resource": /b.md'), 'confidential'), { line: 7, list: 'sources' });
});

test('danglingItems returns null for every shape YAML allows under a key line, so the caller keeps its generic finding', () => {
  // Both kinds of list sit above every shape here, so each one is null
  // for its own reason and never because no list matched its items.
  const cases = {
    'a block list header': fm(...BOTH_ABOVE, 'author:', '  - Ana'),
    'a header holding only a comment': fm(...BOTH_ABOVE, 'author: # the owners', '  - Ana'),
    'a literal block scalar': fm(...BOTH_ABOVE, 'author: |', '  - Ana'),
    'a folded block scalar with a chomping indicator': fm(...BOTH_ABOVE, 'author: >-', '  - Ana'),
    'a block scalar with an indentation digit first': fm(...BOTH_ABOVE, 'author: |2-', '  - Ana'),
    'an anchor alone': fm(...BOTH_ABOVE, 'author: &owners', '  - Ana'),
    'an anchor then a block scalar header': fm(...BOTH_ABOVE, 'author: &owners |', '  - Ana'),
    'a tag alone': fm(...BOTH_ABOVE, 'author: !!seq', '  - Ana'),
    'a flow list continued below': fm(...BOTH_ABOVE, 'author: [Ana,', '  - Bruno]'),
    'a flow mapping continued below': fm(...BOTH_ABOVE, 'author: { name: Ana,', '  - x }'),
    'a double-quoted scalar continued below': fm(...BOTH_ABOVE, 'author: "Ana', '  - and Bruno"'),
    'a single-quoted scalar continued below': fm(...BOTH_ABOVE, "author: 'Ana", "  - and Bruno'"),
    'a double-quoted scalar with an escaped quote, continued below': fm(...BOTH_ABOVE, 'author: "Ana \\"', '  - and Bruno"'),
    'a single-quoted scalar with a doubled quote, continued below': fm(...BOTH_ABOVE, "author: 'it''s", "  - notes'"),
    'a mapping indented under a scalar': fm(...BOTH_ABOVE, 'confidential: true', '  reason: - not a list item'),
    'a mapping line under a scalar, then an item': fm(...BOTH_ABOVE, 'confidential: true', '  reason: x', '  - resource: /b.md'),
    'a plain value folded onto an indented line': fm(...BOTH_ABOVE, 'author: Ana', '  and Bruno'),
    'a plain value folded onto a line, then one starting with a dash': fm(...BOTH_ABOVE, 'author: Ana', '  and Bruno', '  - and Carla'),
    'a scalar with nothing under it': fm(...BOTH_ABOVE, 'confidential: true'),
    'a bare marker with nothing in it': fm(...BOTH_ABOVE, 'confidential: true', '  -'),
    'items after a blank line': fm(...BOTH_ABOVE, 'confidential: true', '', '  - resource: /b.md'),
    'no list above': fm('type: person', 'confidential: true', '  - resource: /b.md'),
    'only a flow list above': fm('sources: [a, b]', 'confidential: true', '  - resource: /b.md'),
    'only a mapping above': fm('generated:', '  by: human:ana', 'confidential: true', '  - resource: /b.md'),
    'a list below, never above': fm('confidential: true', '  - resource: /b.md', ...SOURCES_ABOVE),
    // A list above whose entries are of another kind is no place for the
    // items either.
    'a source under only a list of scalars': fm(...TAGS_ABOVE, 'confidential: true', '  - resource: /b.md'),
    'a scalar under only a list of mappings': fm(...SOURCES_ABOVE, 'confidential: true', '  - example'),
    'a source under only a list of mappings with none of its fields': fm('links:', '  - url: https://example.com', 'confidential: true', '  - resource: /b.md'),
    'a source under a list holding its field only nested deeper': fm('links:', '  - title: x', '    note:', '      resource: /a.md', 'confidential: true', '  - resource: /b.md'),
    'a list above whose first entry holds nothing': fm('sources:', '  -', 'confidential: true', '  - resource: /b.md'),
  };
  for (const [name, frontmatter] of Object.entries(cases)) {
    const key = frontmatter.includes('author:') ? 'author' : 'confidential';
    assert.equal(danglingItems(frontmatter, key), null, name);
  }
  // Each refusal beside its nearest positive: the same scalar with a list
  // item under it and a list of its kind above IS the shape.
  assert.deepEqual(danglingItems(fm(...BOTH_ABOVE, 'author: Ana', '  - and Bruno'), 'author'), { line: 7, list: 'tags' });
  assert.deepEqual(danglingItems(fm(...BOTH_ABOVE, 'author: "Ana"', '  - and Bruno'), 'author'), { line: 7, list: 'tags' });
  assert.deepEqual(danglingItems(fm(...BOTH_ABOVE, 'confidential: true', '  - resource: /b.md', '  reason: x'), 'confidential'), { line: 7, list: 'sources' });
});

test('danglingItems returns null for an absent key and for a missing or empty frontmatter, never throwing', () => {
  assert.equal(danglingItems(fm(...SOURCES_ABOVE, 'confidential: true', '  - resource: /b.md'), 'author'), null);
  assert.equal(danglingItems(null, 'confidential'), null);
  assert.equal(danglingItems('', 'confidential'), null);
});
