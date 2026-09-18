// Frontmatter reader: the split of a note into frontmatter and body, and
// the handful of shapes (scalar, inline/block mapping, inline/block list,
// block list of mappings) the format actually uses, read from the
// frontmatter string alone. See src/frontmatter.mjs for why this is a
// regular-expression reader and not a YAML parser, and what that means for
// the three-way null/undefined/value contract every reader below shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARSER_LIMITS, readEntries, readList, readMapping, readScalar, splitFrontmatter } from '../src/frontmatter.mjs';

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

test('readScalar returns undefined for a block or folded scalar header instead of the bare marker', () => {
  const frontmatter = 'description: |\n  line one\n  line two';
  assert.equal(readScalar(frontmatter, 'description'), undefined);
});

test('readScalar returns the raw line text, marker included, for a value carrying a YAML anchor', () => {
  const frontmatter = 'generated: &g1 { by: human:ana, at: 2026-01-01T00:00:00Z }';
  assert.equal(readScalar(frontmatter, 'generated'), '&g1 { by: human:ana, at: 2026-01-01T00:00:00Z }');
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

test('readMapping reads an empty inline mapping as an empty object', () => {
  assert.deepEqual(readMapping('generated: {}', 'generated'), {});
});

test('readMapping reads an empty indented block (key present, nothing under it) as an empty object', () => {
  assert.deepEqual(readMapping('generated:', 'generated'), {});
});

test('readMapping returns undefined for a nested mapping value rather than a flattened or partial result', () => {
  const frontmatter = 'generated: { by: { kind: human, handle: ana }, at: 2026-01-01T00:00:00Z }';
  assert.equal(readMapping(frontmatter, 'generated'), undefined);
});

test('readMapping returns undefined for a block form where one line nests a mapping on itself, even though every line shares one indentation', () => {
  const frontmatter = 'generated:\n  by: { nested: true }\n  at: 2026-01-01T00:00:00Z';
  assert.equal(readMapping(frontmatter, 'generated'), undefined);
});

test('readMapping returns undefined for a block form with inconsistent indentation (a nested value)', () => {
  const frontmatter = 'generated:\n  by:\n    kind: human\n    handle: ana\n  at: 2026-01-01T00:00:00Z';
  assert.equal(readMapping(frontmatter, 'generated'), undefined);
});

test('readMapping returns undefined when the block under the key is a list, not a mapping', () => {
  const frontmatter = 'verified:\n  - by: human:ana\n    at: 2026-01-01T00:00:00Z';
  assert.equal(readMapping(frontmatter, 'verified'), undefined);
});

test('readMapping returns undefined for a single-level block whose one line is a list entry, not a mapping pair', () => {
  // Unlike the case above, this block has only one line, so it cannot be
  // caught by the indentation-uniformity check: it is the entry-marker
  // check alone that must reject it.
  const frontmatter = 'verified:\n  - by: human:ana';
  assert.equal(readMapping(frontmatter, 'verified'), undefined);
});

test('readMapping returns undefined for a value carrying a YAML anchor', () => {
  const frontmatter = 'generated: &g1 { by: human:ana, at: 2026-01-01T00:00:00Z }';
  assert.equal(readMapping(frontmatter, 'generated'), undefined);
});

test('readMapping returns undefined when the key holds a plain scalar instead of a mapping', () => {
  assert.equal(readMapping('type: note', 'type'), undefined);
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

test('readList returns undefined when the key holds a plain scalar instead of a list', () => {
  assert.equal(readList('type: note', 'type'), undefined);
});

test('readList returns undefined when the block under the key is not plain list entries', () => {
  const frontmatter = 'tags:\n  color: blue';
  assert.equal(readList(frontmatter, 'tags'), undefined);
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

test('readEntries returns undefined when the key holds an inline value instead of a block', () => {
  assert.equal(readEntries('sources: nothing-useful', 'sources'), undefined);
});

test('readEntries returns undefined when the block does not open with an entry marker', () => {
  const frontmatter = 'sources:\n  resource: /docs/example.md';
  assert.equal(readEntries(frontmatter, 'sources'), undefined);
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
