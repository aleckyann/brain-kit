// The one frontmatter WRITER: append a verification event to a note's
// `verified` key and change no other byte of the note.
//
//   stampVerified(text, { by, at }) -> text
//
// It exists for `brain-kit verify` (the owner's command, docs/incidents.md,
// 22/07/2026 "who is allowed to write to the default branch"): the merge
// is the approval, and the stamp records it where the format looks for it
// (Open Knowledge Format v0.2, section 5.2). The three shapes, as section
// 11 says a consumer must read them:
//
//   - no `verified` key: a one-element list is added as the frontmatter's
//     last key;
//   - a list (`verified:` then `  - by: ...` / `    at: ...` entries): one
//     entry is appended after the last one, at the same indentation;
//   - a bare mapping (`verified: { by, at }`, or `verified:` then indented
//     `by:` / `at:` lines): it becomes a one-element list, its own pairs
//     carried over as written, byte for byte, and the new entry appended.
//   - an empty value (`verified:` alone, `verified: []`) is an empty list,
//     and a null (`verified: ~`) is no key yet: either gains the entry in
//     place of the value.
//
// Everything outside the `verified` key is sliced out of the original
// text, never rebuilt: the frontmatter's other keys, the delimiters, a
// byte-order mark, every line ending (a new line takes the ending of the
// line it follows, so a CRLF note stays CRLF), and the whole body,
// including a `verified:` inside a fenced code block, which is not in the
// frontmatter and so is never looked at.
//
// It never guesses (src/frontmatter.mjs is a regular-expression reader, not
// a YAML parser, and says so in PARSER_LIMITS). A `verified` value in any
// shape that reader cannot see, or can see only partly, is a refusal
// (StampRefused, naming the reason), never a rewrite. First of all, a
// frontmatter that is not block style (fix round 1, I2): a flow mapping at
// the top, an explicit key ("? verified"), a merge key, a key spelt with
// an escape, anything at column 0 that is not a plain or quoted key; in
// each, where `verified` is, or whether it is there, cannot be located
// with certainty, and appending a key could duplicate one or break the
// YAML. Then, for the value itself: an inline list, a
// scalar, an anchor or alias, a comment after the value, a value that
// continues past a blank line or a comment where the reader stops, a
// compact list at the key's own indentation, a tab in the indentation, the
// key written twice, or an existing event without a readable `by` and
// `at`, or with any field the reader returns as undefined (present, with
// something nested or folded under it that it does not read). A block
// list of inline mappings (`- { by: ..., at: ... }`, the form section 5.2
// prints) is read by the reader since slice 1C task 6, and gains a block
// entry after its last one. And the result is read back with the same reader
// before it is returned: the events it reads must be exactly the events
// read before plus the new one, or it is a refusal.
//
// Pure text handling: no filesystem, no process.
import { readEntries, readMapping, splitFrontmatter } from './frontmatter.mjs';

export class StampRefused extends Error {
  constructor(reason, detail = '') {
    super(`cannot stamp verified: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'StampRefused';
    this.reason = reason;
  }
}

// The reasons a caller can map to a sentence.
export const REFUSAL = Object.freeze({
  NO_FRONTMATTER: 'no_frontmatter',
  UNREADABLE: 'unreadable',
  DUPLICATE: 'duplicate',
  INCOMPLETE: 'incomplete',
  BAD_VALUE: 'bad_value',
});

// An actor (section 7) as a plain YAML scalar that means the same thing to
// every YAML reader: a kind, a colon or a slash, a name, no space, no
// character YAML gives a meaning to.
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]*[:/][A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// An ISO 8601 datetime with an explicit offset (section 5), the shape the
// validator's verified-events rule accepts.
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const DELIMITER = /^---[ \t]*$/;
const KEY_LINE = /^(?:"verified"|'verified'|verified)[ \t]*:(.*)$/;
// A line at column 0 of a block-style frontmatter: a key of the top-level
// mapping, then a colon ending it. The key is plain (its first character
// none YAML gives a meaning to: no flow brace or bracket, no explicit-key
// "?", no ":" or "-", no anchor, alias, tag, block scalar, directive,
// reserved character, comment, quote, and no "<<" merge key; no "#" in it)
// or quoted with no escape inside (no backslash, no doubled quote), so the
// key it names is the key written, and "verified" can only be spelt one
// of the three ways KEY_LINE finds.
const TOP_KEY = /^(?:"[^"\\]*"|'[^']*'|[^\s{}[\]?:\-&*!|>%@`#'",<][^#]*?)[ \t]*:(?:[ \t]|$)/;
// The empty values section 11 reads as "no event yet": an empty flow list
// is an empty list, and a null is no key at all.
const EMPTY_VALUE = /^(?:\[[ \t]*\]|~|null|Null|NULL)$/;

// The lines of `text` from `start`, each with where it starts, where its
// content ends, where the next line starts and its own ending ("\r\n",
// "\n", a lone "\r", or "" for a last line with none). The three endings
// are the three src/frontmatter.mjs normalises, so both agree on where a
// line is.
function rawLines(text, start) {
  const lines = [];
  let i = start;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
    let eol = '';
    if (j < text.length) eol = text[j] === '\r' && text[j + 1] === '\n' ? '\r\n' : text[j];
    lines.push({ start: i, next: j + eol.length, eol, content: text.slice(i, j) });
    i = j + eol.length;
  }
  return lines;
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
const isIndented = (line) => /^[ \t]/.test(line.content);
const indentOf = (content) => /^[ \t]*/.exec(content)[0];
const isEntryMarker = (trimmed) => trimmed === '-' || /^-[ \t]/.test(trimmed);
// A `key: value` pair (or `key:` alone): the colon that ends the key is
// followed by a space or ends the text, the one form both YAML and the
// reader split in the same place.
const isPair = (text) => /:(?:[ \t]|$)/.test(text);

// The events `frontmatter` holds, as the validator's verified-events rule
// reads them: null when the key is absent, undefined when its shape is
// beyond the reader, else a list.
function readEvents(frontmatter) {
  const entries = readEntries(frontmatter, 'verified');
  if (entries === null) return null;
  if (Array.isArray(entries)) return entries;
  const mapping = readMapping(frontmatter, 'verified');
  if (mapping === null || mapping === undefined) return mapping;
  return [mapping];
}

// Splits an inline mapping's inner text on commas outside quotes, as the
// reader does.
function splitPairs(inner) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

// The index of the brace closing the one at text[0], skipping quoted
// spans, or -1.
function closingBrace(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function entryLines(indent, by, at, eol) {
  return `${indent}- by: ${by}${eol}${indent}  at: ${at}${eol}`;
}

export function stampVerified(text, { by, at } = {}) {
  if (typeof by !== 'string' || !ACTOR.test(by)) throw new StampRefused(REFUSAL.BAD_VALUE, `by ${JSON.stringify(by)}`);
  if (typeof at !== 'string' || !DATETIME.test(at)) throw new StampRefused(REFUSAL.BAD_VALUE, `at ${JSON.stringify(at)}`);
  if (typeof text !== 'string') throw new TypeError('stampVerified takes the note as a string');

  // The frontmatter block, located in the raw text: the first line (after
  // a byte-order mark) a bare "---" with an ending, and the next bare
  // "---" line closing it.
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = rawLines(text, bom);
  if (lines.length === 0 || !DELIMITER.test(lines[0].content)) throw new StampRefused(REFUSAL.NO_FRONTMATTER);
  let close = -1;
  for (let k = 1; k < lines.length; k += 1) {
    if (DELIMITER.test(lines[k].content)) {
      close = k;
      break;
    }
  }
  if (close === -1) throw new StampRefused(REFUSAL.NO_FRONTMATTER, 'no closing delimiter');
  const fm = lines.slice(1, close);
  const { frontmatter } = splitFrontmatter(text);
  // The reader and this writer must be looking at the same block.
  if (frontmatter !== fm.map((line) => line.content).join('\n')) throw new StampRefused(REFUSAL.UNREADABLE, 'frontmatter located differently');

  // Block style only: the first line with content is at column 0, and
  // every line at column 0 that is not blank or a comment is a plain or
  // quoted key. A flow mapping, an explicit key ("? verified"), a merge
  // key, a key spelt with an escape: in each, where "verified" is (or
  // whether it is there at all) is beyond this writer, so it writes
  // nothing.
  const significant = fm.filter((line) => line.content.trim() !== '' && !/^[ \t]*#/.test(line.content));
  if ((significant.length > 0 && isIndented(significant[0]))
    || significant.some((line) => !isIndented(line) && !TOP_KEY.test(line.content))) {
    throw new StampRefused(REFUSAL.UNREADABLE, 'frontmatter is not a block mapping at column 0');
  }

  const keyIndexes = fm.flatMap((line, index) => (KEY_LINE.test(line.content) ? [index] : []));
  if (keyIndexes.length > 1) throw new StampRefused(REFUSAL.DUPLICATE);
  const emptyValue = keyIndexes.length === 1 && EMPTY_VALUE.test(KEY_LINE.exec(fm[keyIndexes[0]].content)[1].trim());
  const before = emptyValue ? [] : readEvents(frontmatter);

  let result;
  if (keyIndexes.length === 0) {
    const after = fm.length > 0 ? fm[fm.length - 1] : lines[0];
    const insert = `verified:${after.eol}${entryLines('  ', by, at, after.eol)}`;
    result = `${text.slice(0, after.next)}${insert}${text.slice(after.next)}`;
  } else {
    if (before === undefined || before === null) throw new StampRefused(REFUSAL.UNREADABLE, 'value beyond the reader');
    // A field the reader sees as present but cannot read (something
    // nested or folded under it) is never taken for absent: the event is
    // not what the reader read, so nothing is written.
    if (before.some((event) => Object.values(event).some((value) => value === undefined))) throw new StampRefused(REFUSAL.UNREADABLE, 'a field of an event beyond the reader');
    if (before.some((event) => isBlank(event.by) || isBlank(event.at))) throw new StampRefused(REFUSAL.INCOMPLETE);
    result = rewriteKey(text, fm, keyIndexes[0], { by, at });
  }

  // Read back with the same reader: exactly the events before, plus one.
  const expected = [...(before ?? []), { by, at }];
  const readBack = readEvents(splitFrontmatter(result).frontmatter);
  if (JSON.stringify(readBack) !== JSON.stringify(expected)) throw new StampRefused(REFUSAL.UNREADABLE, 'result does not read back');
  return result;
}

// The key is present, and its events are readable and complete.
function rewriteKey(text, fm, keyIndex, { by, at }) {
  const keyLine = fm[keyIndex];
  const head = KEY_LINE.exec(keyLine.content)[1];
  // The block under the key, where the reader stops: indented lines up to
  // the first blank line or line at column 0.
  let end = keyIndex + 1;
  while (end < fm.length && fm[end].content.trim() !== '' && isIndented(fm[end])) end += 1;
  const block = fm.slice(keyIndex + 1, end);
  // YAML does not stop where the reader does: past blank lines and
  // comments at column 0, an indented line (or a list marker at column 0)
  // still belongs to this value. Such a value is beyond the reader.
  let next = end;
  while (next < fm.length && (fm[next].content.trim() === '' || fm[next].content.startsWith('#'))) next += 1;
  if (next < fm.length && (isIndented(fm[next]) || isEntryMarker(fm[next].content))) {
    throw new StampRefused(REFUSAL.UNREADABLE, 'value continues past where the reader stops');
  }
  if (block.some((line) => indentOf(line.content).includes('\t'))) throw new StampRefused(REFUSAL.UNREADABLE, 'tab in indentation');

  const trimmedHead = head.trim();
  if (EMPTY_VALUE.test(trimmedHead)) {
    // `verified: []` or `verified: ~`: the value becomes the first entry.
    if (block.length > 0) throw new StampRefused(REFUSAL.UNREADABLE, 'empty value with something under it');
    const keyPart = keyLine.content.slice(0, keyLine.content.length - head.length);
    return `${text.slice(0, keyLine.start)}${keyPart}${keyLine.eol}${entryLines('  ', by, at, keyLine.eol)}${text.slice(keyLine.next)}`;
  }
  if (trimmedHead.startsWith('{')) {
    // An inline bare mapping: nothing may follow its closing brace, and
    // nothing may be indented under it.
    const open = head.indexOf('{');
    const closeAt = closingBrace(head.slice(open));
    if (closeAt === -1 || head.slice(open + closeAt + 1).trim() !== '' || block.length > 0) {
      throw new StampRefused(REFUSAL.UNREADABLE, 'inline mapping with something after it');
    }
    const pairs = splitPairs(head.slice(open + 1, open + closeAt));
    if (pairs.some((pair) => !isPair(pair))) throw new StampRefused(REFUSAL.UNREADABLE, 'inline pair');
    const eol = keyLine.eol;
    const keyPart = keyLine.content.slice(0, keyLine.content.length - head.length);
    const carried = pairs.map((pair, i) => `${i === 0 ? '  - ' : '    '}${pair}${eol}`).join('');
    const replacement = `${keyPart}${eol}${carried}${entryLines('  ', by, at, eol)}`;
    return `${text.slice(0, keyLine.start)}${replacement}${text.slice(keyLine.next)}`;
  }
  // Any other value on the key line (a scalar, a list, an anchor) was
  // already refused: the reader returns undefined for it.
  if (block.length === 0) {
    // `verified:` with nothing under it: an empty list gains its first
    // entry.
    return `${text.slice(0, keyLine.next)}${entryLines('  ', by, at, keyLine.eol)}${text.slice(keyLine.next)}`;
  }
  const indent = indentOf(block[0].content);
  const last = block[block.length - 1];
  if (isEntryMarker(block[0].content.slice(indent.length))) {
    // A block list: every marker at the first one's indentation, every
    // other line deeper, or the entries are not what the reader read.
    for (const line of block) {
      const own = indentOf(line.content);
      const marker = isEntryMarker(line.content.slice(own.length));
      if (marker ? own !== indent : own.length <= indent.length) throw new StampRefused(REFUSAL.UNREADABLE, 'list indentation');
    }
    return `${text.slice(0, last.next)}${entryLines(indent, by, at, last.eol)}${text.slice(last.next)}`;
  }
  // A block bare mapping: each line (one pair, all at one indentation, as
  // the reader requires) moves under a list marker, as written.
  if (block.some((line) => !isPair(line.content.slice(indent.length)))) throw new StampRefused(REFUSAL.UNREADABLE, 'mapping pair');
  const carried = block.map((line, i) => `${indent}${i === 0 ? '- ' : '  '}${line.content.slice(indent.length)}${line.eol}`).join('');
  return `${text.slice(0, block[0].start)}${carried}${entryLines(indent, by, at, last.eol)}${text.slice(last.next)}`;
}
