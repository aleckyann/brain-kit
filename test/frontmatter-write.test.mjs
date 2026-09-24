// stampVerified: the one frontmatter writer (src/frontmatter-write.mjs).
//
// Every case that writes asserts two things: the exact text that comes
// out, and, independently, that removing the `verified` key's own lines
// from the frontmatter of the input and of the output leaves the SAME
// bytes, so no byte outside the key moved (the frontmatter's other keys,
// the delimiters, a byte-order mark, the line endings and the whole body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFUSAL, StampRefused, stampVerified } from '../src/frontmatter-write.mjs';
import { readEntries } from '../src/frontmatter.mjs';
import { splitFrontmatter } from '../src/frontmatter.mjs';

const EVENT = Object.freeze({ by: 'human:ana', at: '2026-09-23T12:00:00+00:00' });
const NEW = 'verified:\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n';
const BOM = String.fromCharCode(0xfeff);

// The text with the `verified` key's lines (its column-0 key line and the
// indented lines under it) removed from the frontmatter, every other byte
// kept, line endings included. Written separately from the writer, on
// purpose: it is the yardstick, not a copy of the thing measured.
function withoutVerified(text) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const lines = text.slice(bom.length).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter((line, i, all) => line !== '' || i < all.length - 1);
  const out = [];
  let inFrontmatter = false;
  let seenOpen = false;
  let inKey = false;
  for (const line of lines) {
    const content = line.replace(/(?:\r\n|\n|\r)$/, '');
    if (!seenOpen) {
      seenOpen = true;
      inFrontmatter = /^---[ \t]*$/.test(content);
      out.push(line);
      continue;
    }
    if (inFrontmatter && /^---[ \t]*$/.test(content)) {
      inFrontmatter = false;
      inKey = false;
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      if (/^(?:"verified"|'verified'|verified)[ \t]*:/.test(content)) {
        inKey = true;
        continue;
      }
      if (inKey && /^[ \t]/.test(content) && content.trim() !== '') continue;
      inKey = false;
    }
    out.push(line);
  }
  return bom + out.join('');
}

function assertOnlyKeyChanged(before, after) {
  assert.equal(withoutVerified(after), withoutVerified(before), 'every byte outside the verified key is unchanged');
}

function stampOk(text, expected) {
  const out = stampVerified(text, EVENT);
  assert.equal(out, expected);
  assertOnlyKeyChanged(text, out);
  return out;
}

function refused(text, reason, event = EVENT) {
  assert.throws(() => stampVerified(text, event), (error) => {
    assert.ok(error instanceof StampRefused, `a StampRefused, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

const BODY = '\n# Title\n\nSome text.\n';

test('the yardstick itself sees a changed byte outside the key', () => {
  const before = `---\ntype: note\nverified: { by: human:bo, at: 2026-01-01T00:00:00Z }\n---\n${BODY}`;
  assert.notEqual(withoutVerified(before.replace('type: note', 'type: notes')), withoutVerified(before));
  assert.notEqual(withoutVerified(before.replace('Some text.\n', 'Some text.\r\n')), withoutVerified(before));
  assert.equal(withoutVerified(before), `---\ntype: note\n---\n${BODY}`);
});

test('a note with no frontmatter is refused: it is not a note', () => {
  refused(`# Title\n\nverified: { by: human:bo, at: 2026-01-01T00:00:00Z }\n`, REFUSAL.NO_FRONTMATTER);
  refused('', REFUSAL.NO_FRONTMATTER);
  refused('---', REFUSAL.NO_FRONTMATTER);
  refused(`---\ntype: note\n${BODY}`, REFUSAL.NO_FRONTMATTER); // opened, never closed
  refused(`\n---\ntype: note\n---\n${BODY}`, REFUSAL.NO_FRONTMATTER); // "---" not on the first line
});

test('an absent key gains a one-element list as the last key of the frontmatter', () => {
  const text = `---\ntype: note\ntitle: A\n---\n${BODY}`;
  stampOk(text, `---\ntype: note\ntitle: A\n${NEW}---\n${BODY}`);
});

test('an empty frontmatter gains the key', () => {
  stampOk(`---\n---\n${BODY}`, `---\n${NEW}---\n${BODY}`);
});

test('an absent key after a block list and a block scalar is still added at column 0, after them', () => {
  const text = `---\ntype: note\ntags:\n  - a\n  - b\ndescription: |\n  two\n  lines\n---\n${BODY}`;
  stampOk(text, `---\ntype: note\ntags:\n  - a\n  - b\ndescription: |\n  two\n  lines\n${NEW}---\n${BODY}`);
});

test('a bare inline mapping becomes a one-element list, its pairs carried as written, and the new entry appended', () => {
  const text = `---\ntype: note\nverified: { by: "human:bo", at: 2026-06-25T09:00:00Z }\ntitle: A\n---\n${BODY}`;
  const out = stampOk(text, `---\ntype: note\nverified:\n  - by: "human:bo"\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\ntitle: A\n---\n${BODY}`);
  assert.deepEqual(readEntries(splitFrontmatter(out).frontmatter, 'verified'), [{ by: 'human:bo', at: '2026-06-25T09:00:00Z' }, EVENT]);
});

test('a bare block mapping becomes a one-element list at its own indentation', () => {
  const text = `---\ntype: note\nverified:\n    by: human:bo\n    at: 2026-06-25T09:00:00Z\n---\n${BODY}`;
  stampOk(text, `---\ntype: note\nverified:\n    - by: human:bo\n      at: 2026-06-25T09:00:00Z\n    - by: human:ana\n      at: 2026-09-23T12:00:00+00:00\n---\n${BODY}`);
});

test('a list gains one entry after its last, at the same indentation, and the keys after it stay where they were', () => {
  const text = `---\ntype: note\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: process:nightly\n    at: 2026-06-26T02:00:00Z\ntitle: A\n---\n${BODY}`;
  stampOk(text, `---\ntype: note\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: process:nightly\n    at: 2026-06-26T02:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\ntitle: A\n---\n${BODY}`);
  const deeper = `---\nverified:\n    - by: human:bo\n      at: 2026-06-25T09:00:00Z\n---\n`;
  stampOk(deeper, `---\nverified:\n    - by: human:bo\n      at: 2026-06-25T09:00:00Z\n    - by: human:ana\n      at: 2026-09-23T12:00:00+00:00\n---\n`);
});

test('a quoted key is found and kept as written', () => {
  const text = `---\n"verified":\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n---\n`;
  stampOk(text, `---\n"verified":\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n`);
});

test('an empty verified key (nothing under it) gains its first entry', () => {
  stampOk(`---\ntype: note\nverified:\ntitle: A\n---\n`, `---\ntype: note\n${NEW}title: A\n---\n`);
});

test('CRLF endings: every shape stays CRLF, with no bare LF added, and no byte outside the key changes', () => {
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const cases = [
    [`---\ntype: note\n---\n${BODY}`, `---\ntype: note\n${NEW}---\n${BODY}`],
    [`---\nverified: { by: human:bo, at: 2026-06-25T09:00:00Z }\n---\n${BODY}`, `---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n${BODY}`],
    [`---\nverified:\n  by: human:bo\n  at: 2026-06-25T09:00:00Z\n---\n${BODY}`, `---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n${BODY}`],
    [`---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n---\n${BODY}`, `---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n${BODY}`],
  ];
  for (const [input, expected] of cases) {
    const out = stampOk(crlf(input), crlf(expected));
    assert.equal(/(?<!\r)\n/.test(out), false, 'no bare LF');
  }
});

test('a verified inside a fenced code block in the body is untouched, and so is a "---" in the body', () => {
  const body = '\n# Example\n\n```yaml\n---\nverified:\n  - by: human:someone\n    at: 2026-01-01T00:00:00Z\n---\n```\n\nverified: { by: human:x, at: 2026-01-01T00:00:00Z }\n';
  const text = `---\ntype: note\n---\n${body}`;
  const out = stampOk(text, `---\ntype: note\n${NEW}---\n${body}`);
  assert.ok(out.endsWith(body));
  const withKey = `---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n---\n${body}`;
  stampOk(withKey, `---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n${body}`);
});

test('a byte-order mark and trailing spaces on the delimiters are kept', () => {
  const text = `${BOM}---  \ntype: note\n---\t\n${BODY}`;
  stampOk(text, `${BOM}---  \ntype: note\n${NEW}---\t\n${BODY}`);
});

test('a note whose closing delimiter is its last line, with no ending, is stamped', () => {
  stampOk('---\ntype: note\n---', `---\ntype: note\n${NEW}---`);
});

test('a lone CR ending is kept as the ending of the lines added after it', () => {
  stampOk('---\rtype: note\r---\r', '---\rtype: note\rverified:\r  - by: human:ana\r    at: 2026-09-23T12:00:00+00:00\r---\r');
});

test('a value in a shape the reader cannot see is refused, never rewritten', () => {
  const shapes = [
    'verified: [human:bo]',
    'verified: human:bo',
    'verified: &v { by: human:bo, at: 2026-06-25T09:00:00Z }',
    'verified: *v',
    'verified: |\n  by: human:bo',
    'verified: # later\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z',
    'verified: { by: human:bo, at: 2026-06-25T09:00:00Z } # checked',
    'verified: { by: human:bo, at: 2026-06-25T09:00:00Z } junk',
    'verified: { by: human:bo, at: 2026-06-25T09:00:00Z',
    'verified: { by: { name: bo }, at: 2026-06-25T09:00:00Z }',
    'verified: { by:human:bo, at: 2026-06-25T09:00:00Z }',
    // the value continues past where the reader stops
    'verified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n\n  - by: human:cy\n    at: 2026-06-26T00:00:00Z',
    'verified:\n  - by: human:bo\n# note\n    at: 2026-06-25T09:00:00Z',
    'verified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n# note\n    extra: 1',
    'verified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n\n    extra: 1',
    // a compact list at the key's own indentation, read as empty
    'verified:\n- by: human:bo\n  at: 2026-06-25T09:00:00Z',
    // a tab in the indentation
    'verified:\n\t- by: human:bo\n\t  at: 2026-06-25T09:00:00Z',
    // a list whose markers are not at one indentation
    'verified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n    - by: human:cy\n      at: 2026-06-26T00:00:00Z',
    // a list entry that is only a marker, its continuation at the marker's own column
    'verified:\n  - by: human:bo\n  at: 2026-06-25T09:00:00Z',
    // a block mapping whose pair has no space after its colon
    'verified:\n  by:human:bo\n  at: 2026-06-25T09:00:00Z',
    // a nested block mapping
    'verified:\n  by: human:bo\n  at: 2026-06-25T09:00:00Z\n  extra:\n    deep: 1',
  ];
  for (const shape of shapes) {
    const text = `---\ntype: note\n${shape}\ntitle: A\n---\n${BODY}`;
    assert.throws(() => stampVerified(text, EVENT), StampRefused, shape);
  }
});

test('an existing event without a readable by and at is refused, including the inline entries section 5.2 prints', () => {
  refused('---\nverified:\n  - by: human:bo\n---\n', REFUSAL.INCOMPLETE);
  refused('---\nverified:\n  - at: 2026-06-25T09:00:00Z\n---\n', REFUSAL.INCOMPLETE);
  refused('---\nverified: {}\n---\n', REFUSAL.INCOMPLETE);
  refused('---\nverified: { by: human:bo, at: "" }\n---\n', REFUSAL.INCOMPLETE);
  refused('---\nverified:\n  by: human:bo\n---\n', REFUSAL.INCOMPLETE);
  refused('---\nverified:\n  - { by: human:bo }\n---\n', REFUSAL.INCOMPLETE);
});

test('the list section 5.2 prints, inline mappings under markers, gains a block entry after its last', () => {
  const text = '---\ntype: note\nverified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }\ntitle: A\n---\n';
  const out = stampOk(text, '---\ntype: note\nverified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\ntitle: A\n---\n');
  assert.deepEqual(readEntries(splitFrontmatter(out).frontmatter, 'verified').map((event) => event.by), ['human:ahormati', 'process:finance-nightly', 'human:ana']);
  stampOk(text.replace(/\n/g, '\r\n'), out.replace(/\n/g, '\r\n'));
});

test('an event with a field the reader sees but cannot read is refused, never read as absent', () => {
  for (const nested of [
    '  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n    note:\n      deep: 1',
    '  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n    tags:\n      - a',
    '  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n      continued',
    '  - by:\n      name: bo\n    at: 2026-06-25T09:00:00Z',
  ]) {
    refused(`---\nverified:\n${nested}\n---\n`, REFUSAL.UNREADABLE);
  }
});

test('the key written twice is refused', () => {
  refused('---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\nverified: { by: human:cy, at: 2026-06-26T00:00:00Z }\n---\n', REFUSAL.DUPLICATE);
});

test('a frontmatter that is not a mapping at column 0 is refused when the key would be added', () => {
  refused('---\n  type: note\n---\n', REFUSAL.UNREADABLE);
  refused('---\n- a\n- b\n---\n', REFUSAL.UNREADABLE);
  refused('---\njust a scalar\n---\n', REFUSAL.UNREADABLE);
  // comments and blank lines before the first key are fine
  stampOk('---\n# a comment\n\ntype: note\n---\n', `---\n# a comment\n\ntype: note\n${NEW}---\n`);
});

test('an actor or a time that is not a plain, well-formed value is refused', () => {
  const text = '---\ntype: note\n---\n';
  for (const by of ['', 'ana', 'human:', 'human: ana', 'human:ana # x', 'human:ana, x', '{human:ana}', undefined]) {
    refused(text, REFUSAL.BAD_VALUE, { ...EVENT, by });
  }
  for (const at of ['', '2026-09-23', '2026-09-23T12:00:00', '2026-09-23 12:00:00Z', '2026-09-23T12:00:00+0000', undefined]) {
    refused(text, REFUSAL.BAD_VALUE, { ...EVENT, at });
  }
  assert.equal(stampVerified(text, { by: 'reference_agent/gemini-2.5-pro', at: '2026-09-23T12:00:00.5Z' }), '---\ntype: note\nverified:\n  - by: reference_agent/gemini-2.5-pro\n    at: 2026-09-23T12:00:00.5Z\n---\n');
});

test('an inline mapping whose quoted values hold a brace or a comma is split where the reader splits it', () => {
  const brace = '---\nverified: { by: "human:b}o", at: 2026-06-25T09:00:00Z }\n---\n';
  stampOk(brace, '---\nverified:\n  - by: "human:b}o"\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n');
  const comma = '---\nverified: { by: "human:b,o", at: 2026-06-25T09:00:00Z }\n---\n';
  stampOk(comma, '---\nverified:\n  - by: "human:b,o"\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n');
});

test('a quoted key written as an inline mapping keeps its quotes', () => {
  stampOk("---\n'verified': { by: human:bo, at: 2026-06-25T09:00:00Z }\n---\n", "---\n'verified':\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n---\n");
});

test('an empty verified key in a CRLF note stays CRLF', () => {
  stampOk('---\r\nverified:\r\ntitle: A\r\n---\r\n', '---\r\nverified:\r\n  - by: human:ana\r\n    at: 2026-09-23T12:00:00+00:00\r\ntitle: A\r\n---\r\n');
});

test('a whitespace-only line after the list ends it, and the entry goes before that line', () => {
  const text = '---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  \ntitle: A\n---\n';
  stampOk(text, '---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n  - by: human:ana\n    at: 2026-09-23T12:00:00+00:00\n  \ntitle: A\n---\n');
});

test('a tab counts as indentation where the reader stops, and in the frontmatter\'s first line', () => {
  refused('---\nverified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n\n\textra: 1\n---\n', REFUSAL.UNREADABLE);
  refused('---\n\ttype: note\n---\n', REFUSAL.UNREADABLE);
  refused('---\n- a: 1\n---\n', REFUSAL.UNREADABLE);
});

test('a frontmatter that is not block style is refused, written into nowhere (fix round 1, I2)', () => {
  const shapes = [
    '{type: note, title: F}', // a flow mapping at the top: valid YAML, where would a key go
    'type: note\n? verified\n: { by: human:bo, at: 2026-06-25T09:00:00Z }', // an explicit key
    '? verified\n: [x]', // an explicit key first
    'type: note\n? verified: x', // an explicit key whose content reads like a pair
    'type: note\n: orphan value',
    'type: note\n<<: *base', // a merge key can bring a verified with it
    'type: note\n"verif\\x69ed": x', // a key spelt with an escape
    "type: note\n'it''s': x", // a doubled quote inside a quoted key
    'type: note\n&a title: A',
    'type: note\n*a : x',
    'type: note\n!!str title: A',
    '%YAML 1.2\ntype: note',
    'type: note\n...',
    'type: note\n[a, b]: x',
    'type: note\n|: x',
    'type: note\n@x: y',
    'type: note\n`x`: y',
    'type: note\ntitle#x: A',
    'type: note\nplain text line',
    'type: note\nverified:x',
  ];
  for (const shape of shapes) {
    const text = `---\n${shape}\n---\n${BODY}`;
    assert.throws(() => stampVerified(text, EVENT), (error) => error instanceof StampRefused && error.reason === REFUSAL.UNREADABLE, shape);
  }
});

test('the block-style guard still admits every plain and quoted key a note uses', () => {
  const text = '---\ntype: note\n"title": A\n\'description\': B\nsources:\n  - resource: https://example.com/x\nstale_after: 2026-12-01\nkey with spaces: v\nurl-ish:thing: v\n# a comment\n\n---\n';
  const out = stampVerified(text, EVENT);
  assert.equal(out, text.replace('\n\n---\n', `\n\n${NEW}---\n`));
});

test('an empty flow list is an empty list and a null is no key: both gain the first entry in place of the value (fix round 1, M3)', () => {
  for (const value of ['[]', '[ ]', '~', 'null', 'Null', 'NULL']) {
    stampOk(`---\ntype: note\nverified: ${value}\ntitle: A\n---\n${BODY}`, `---\ntype: note\n${NEW}title: A\n---\n${BODY}`);
  }
  stampOk('---\n"verified": []\r\n---\r\n'.replace('---\n', '---\r\n'), '---\r\n"verified":\r\n  - by: human:ana\r\n    at: 2026-09-23T12:00:00+00:00\r\n---\r\n');
  for (const value of ['[] # none yet', '~ # none', '[ ]x', 'nULL', '""', "''", '[~]']) {
    refused(`---\ntype: note\nverified: ${value}\n---\n`, REFUSAL.UNREADABLE);
  }
  refused('---\ntype: note\nverified: ~\n  - by: human:bo\n---\n', REFUSAL.UNREADABLE);
});

test('an event whose by is only quoted spaces is incomplete', () => {
  refused('---\nverified:\n  - by: " "\n    at: 2026-06-25T09:00:00Z\n---\n', REFUSAL.INCOMPLETE);
});
