// Frontmatter reader: split a note into its frontmatter and body, and read
// the handful of shapes the format actually uses out of the frontmatter
// string alone.
//
// This is a regular-expression reader, not a YAML parser, because the
// engine ships with zero dependencies (docs/rationale.md, principle 1).
// The original vault's validator made the same choice and documented the
// same trade-off in its own code (docs/incidents.md, "the validator is a
// regex, and says so"): a tool that knows what it cannot see must say so,
// rather than let a missing field read as "not present" when it was
// really "not understood." PARSER_LIMITS, at the bottom of this file, is
// that declaration for this reader; the validator built on top of it
// prints the list in its JSON output, so a green check is never mistaken
// for a check that looked deeper than it did.
//
// Every exported reader below, other than splitFrontmatter itself, takes
// the frontmatter STRING that splitFrontmatter returns, never the whole
// file. That split is what makes a key inside a fenced code block in the
// BODY structurally invisible to these readers, rather than something
// each one has to remember to filter out: the body is simply never in
// scope.
//
// Three return values carry three different meanings, on every reader
// here: null means the key is absent; undefined means the key is present
// but its value is a shape this reader cannot see (and is named in
// PARSER_LIMITS); anything else is the value this reader is confident it
// read correctly. Collapsing "absent" and "beyond the reader" into one
// value would hide exactly the failure mode this module exists to avoid:
// a confident wrong finding (a rule reporting a field missing when it is
// plainly present, just in a shape nobody taught the reader) is worse
// than reporting nothing.
//
// Pure text handling: no filesystem, no other module of this engine, and
// (deliberately, since every shape here is a plain string or line array)
// no import at all.

// The two delimiter lines are matched separately, not as one pattern that
// requires a newline on each side of the gap between them: the opening
// line's own trailing newline and the newline right before the closing
// line are the SAME character when the frontmatter block is empty ("---"
// directly followed by "---"), and a pattern asking for that one newline
// twice could never match that case.
//
// Neither pattern carries an optional \r: normalize() below removes every
// carriage return before either pattern ever runs, so there is exactly one
// place in this file that knows Windows line endings exist. Fix round 1
// found the alternative (an optional \r sprinkled into each pattern that
// might see one) already causing a real defect: a file with CRLF line
// endings still opened its frontmatter correctly, but every INTERNAL line
// of it kept a trailing \r once split on "\n" alone, and `.` in a
// JavaScript regex never matches \r (it is a line terminator, excluded
// like \n), so `(.*)$` in findKeyLine's pattern had no way to reach the
// true end of such a line and every key but the last read back as
// absent. One normalisation point, tested once here, is what this project
// chose after its phase 0 push gate needed five rounds of fixes for
// exactly the opposite habit: the same rule, remembered separately in
// nine patterns, forgotten in one of them.
function normalize(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a leading byte-order mark, stripped before anything else looks at position 0
  return text.replace(/\r\n?/g, '\n'); // CRLF, and a lone CR on its own, both become LF
}

const OPEN_DELIMITER = /^---[ \t]*\n/;
const CLOSE_DELIMITER = /^---[ \t]*(?:\n|$)/m;

// Splits `text` into { frontmatter, body, hasFrontmatter }. `hasFrontmatter`
// is true only when the very first line is a bare "---": a "---" anywhere
// else (a markdown horizontal rule, a line inside a fenced code block) is
// never mistaken for an opening delimiter, because OPEN_DELIMITER has no
// multiline flag and so only ever matches at position 0. Once opened, the
// CLOSE_DELIMITER search finds the FIRST subsequent line that is a bare
// "---" and stops there: a later "---" anywhere in the body (the case this
// module is explicitly required to get right) is never reached, because
// nothing calls the search again. An opened block with no closing line at
// all (malformed) is reported as no frontmatter, with the whole text as
// the body, rather than guessing where it might have ended.
//
// `text` is normalized FIRST, before either delimiter pattern runs, so a
// byte-order mark never hides the opening "---" from OPEN_DELIMITER
// (which matches only at position 0), and `body` is exactly as line-ending
// free as `frontmatter`: both come from the same normalized string, so a
// reader downstream never has to ask which kind of file it came from.
export function splitFrontmatter(text) {
  text = normalize(text);

  const open = OPEN_DELIMITER.exec(text);
  if (!open) return { frontmatter: null, body: text, hasFrontmatter: false };

  const rest = text.slice(open[0].length);
  const close = CLOSE_DELIMITER.exec(rest);
  if (!close) return { frontmatter: null, body: text, hasFrontmatter: false };

  return {
    frontmatter: rest.slice(0, close.index).replace(/\n$/, ''),
    body: rest.slice(close.index + close[0].length),
    hasFrontmatter: true,
  };
}

// --- shared helpers -----------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strips one layer of matching quotes. Deliberately does not resolve a
// backslash-escaped quote inside the span (PARSER_LIMITS): the span is
// read as closing at the first quote character of the same kind, escaped
// or not.
function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  return value;
}

// A block or folded scalar header (YAML "|" or ">", with an optional
// chomping indicator and an optional explicit indentation digit, and
// nothing else on the line): the real content lives on the following
// indented lines, which this reader never joins back in (PARSER_LIMITS).
// Detecting the header itself is cheap and reliable, so a field written
// this way is reported as undefined rather than as the single character
// "|" or ">", which would be a confident wrong scalar value.
function isBlockScalarHeader(value) {
  return /^[|>][+-]?\d*$/.test(value);
}

// Splits `text` on its FIRST colon only, into [key, value], both trimmed.
// This is what lets an actor value like "human:ana" survive whole inside
// a mapping pair "by: human:ana": the pair itself is split here, once,
// and the value's own colon is never touched again.
function splitFirstColon(text) {
  const index = text.indexOf(':');
  if (index === -1) return null;
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

// Splits `text` on `separator`, except where the separator sits inside a
// single- or double-quoted span, so a quoted value that itself contains
// the separator (a description with a comma in it) stays in one piece.
// An escaped quote inside the span is not recognised (PARSER_LIMITS): the
// span still closes at the first quote character of the same kind.
function splitUnquoted(text, separator) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === separator) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// Finds the index, inside `text`, of the `closeChar` that matches the
// `openChar` assumed to sit at text[0]: nesting depth is tracked so a
// genuinely nested "{...}" does not close the scan early, and a quoted
// span is skipped whole so a brace or bracket character inside a quoted
// value is never mistaken for a structural one. Returns -1 when the span
// never closes inside `text` at all (an inline value folded across more
// than one line, which this reader does not join back together: see
// PARSER_LIMITS).
function findMatchingClose(text, openChar, closeChar) {
  let depth = 1;
  let quote = null;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

// A block list marker line ("- value", or a bare "-"), matched after the
// line's own leading indentation has already been stripped by the caller.
function isEntryMarker(trimmedLine) {
  return trimmedLine === '-' || /^-[ \t]/.test(trimmedLine);
}

function afterMarker(trimmedLine) {
  return trimmedLine.slice(1).replace(/^[ \t]+/, '');
}

// True when `text` (already stripped of its "- " marker) itself opens with
// a "field:" of its own: a bare token with no internal space or colon,
// then ":", then either a space or the end of the text. This is the same
// shape findKeyLine looks for, generalised to an unknown key, and it is
// also the real rule YAML itself uses to tell a mapping key from a plain
// scalar that merely contains a colon (a URL like "https://example.com"
// has no space after its colon, so it does not match). It is what lets
// readList refuse a block of single-field mapping entries ("- resource:
// /a.md") on purpose, instead of reading each one back as a plain string
// that happens to contain a colon.
function looksLikeMappingField(text) {
  return /^[^\s:]+:(\s|$)/.test(text);
}

// Finds the top-level line (no leading indentation, so a same-named key
// nested under a different field is never mistaken for this one) that
// opens with "key:", and returns its line index plus whatever follows the
// colon on that same line. Anchoring the match to the exact key text,
// followed by an optional run of spaces or tabs and then ":", is also what
// keeps a key that merely appears as a word inside another line's value
// from ever matching: that line does not start with "key" at column 0, so
// it is skipped, not matched. The optional whitespace before the colon
// (allowing "type : note" as well as "type: note") is a real fix, not
// leniency for its own sake: without it, a hand-written space before the
// colon made the key read as ABSENT, the one value guaranteed to produce a
// "missing field" finding, for a key that is plainly on screen.
//
// The key itself may also be quoted ("type": note or 'type': note), which
// is legal YAML: the three alternatives (bare, double-quoted, single-
// quoted) are tried in the same pattern, at the same anchor, so every
// caller of this function, not just one, stops mistaking a legally quoted
// key for an absent one. Fixed here rather than by teaching each reader
// to strip a pair of quotes off the front of a line before matching: this
// is the one function every reader already calls to find a key's line,
// so it is the one place that needs to know a key can be quoted at all.
function findKeyLine(lines, key) {
  const escaped = escapeRegExp(key);
  const pattern = new RegExp(`^(?:"${escaped}"|'${escaped}'|${escaped})[ \\t]*:(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (match) return { index: i, head: match[1] };
  }
  return null;
}

// Strips a trailing YAML comment from a scalar value: a "#" preceded by
// whitespace starts a comment that runs to the end of the line. This is
// the format's own rule (plain YAML), not something this reader adds on
// top of it, so `readScalar` applies it before anything else looks at
// the value. What is INSIDE a quoted span is always left untouched,
// comment-looking "#" and all, since that is data; `unquote` (called
// after this) is still the one place that decides where such a span
// ends. Fix round 3: an earlier version of this function treated
// "opens with a quote" as "nothing real follows on this line", which
// left a real trailing comment AFTER a properly closed quoted value
// (`status: "stable" # confirmed`) stuck to the value, so the whole
// thing failed `unquote`'s first/last-character match and came back
// unquoted and uncommented. This version finds the matching closing
// quote first (the next occurrence of the same quote character), and
// only then looks for a comment in whatever follows it, leaving the
// quoted span itself exactly as it was. PARSER_LIMITS below names the
// one surprising consequence that remains: an unquoted value meant to
// contain a literal "#" preceded by a space loses everything from that
// point on, silently and correctly, per the format.
function stripTrailingComment(rawHead) {
  const withoutLeadingSpace = rawHead.replace(/^[ \t]+/, '');
  const first = withoutLeadingSpace[0];
  if (first === '"' || first === "'") {
    const closeIndex = withoutLeadingSpace.indexOf(first, 1);
    if (closeIndex === -1) return rawHead.trim(); // no closing quote at all: leave it for unquote to judge, unchanged
    const afterQuote = withoutLeadingSpace.slice(closeIndex + 1);
    const commentInTail = /[ \t]#/.exec(afterQuote);
    if (!commentInTail) return withoutLeadingSpace.trim();
    return (withoutLeadingSpace.slice(0, closeIndex + 1) + afterQuote.slice(0, commentInTail.index)).trim();
  }
  const commentStart = /[ \t]#/.exec(withoutLeadingSpace);
  if (!commentStart) return rawHead.trim();
  return withoutLeadingSpace.slice(0, commentStart.index).trim();
}

// Collects the lines that belong to the indented block following the line
// at `keyLineIndex`: every subsequent line that carries leading
// indentation, stopping at the first blank line or the first line back at
// column 0 (a new top-level key), or at the end of the frontmatter.
// Ported from the original validator's own boundary check (any leading
// whitespace means "still part of the block"), extended to also stop on a
// blank line, which real frontmatter never has inside a block anyway.
function collectBlock(lines, keyLineIndex) {
  const block = [];
  for (let i = keyLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || !/^[ \t]/.test(line)) break;
    block.push(line);
  }
  return block;
}

// --- readScalar ----------------------------------------------------------

// Reads a single-line value for `key`: plain, quoted, or containing a
// colon of its own (the value is everything after the key's OWN first
// colon, taken as-is, so a further colon inside it is never re-split).
// null means the key is absent. undefined means the key is present but
// its value is one of two shapes this function does not join back
// together: a block or folded scalar header ("|" or ">", PARSER_LIMITS),
// or a PLAIN value folded across indented continuation lines with no
// marker at all - real YAML allows this, and it is exactly the shape a
// person writing a long description by hand produces without ever
// intending any special syntax, whether their editor wrapped the line for
// them or they indented a continuation on purpose.
//
// The following-block check does not care whether the key's own line was
// left empty or already carries the first line of the value: either way,
// something is indented underneath that this function cannot safely fold
// in, and refusing is the only answer that is never wrong. The two shapes
// look different but fail the same way if only the empty-head one is
// caught: fix round 2 found that a non-empty head with a continuation
// underneath ("description: a long line" then "  continued here") still
// returned just "a long line", silently dropping the continuation - a
// confident value indistinguishable from a note whose description really
// is one line, for the single field the whole vault's index is built
// from. Checked directly against the neighbouring shapes while fixing
// this: a key that is really a block mapping or a block list already
// takes this same path (its own line is empty, and something is
// indented underneath), so it was already declining before this fix and
// still does after it.
export function readScalar(frontmatter, key) {
  const lines = (frontmatter ?? '').split('\n');
  const found = findKeyLine(lines, key);
  if (!found) return null;

  const value = stripTrailingComment(found.head);
  if (isBlockScalarHeader(value)) return undefined;
  if (collectBlock(lines, found.index).length > 0) return undefined;
  return unquote(value);
}

// --- readMapping -----------------------------------------------------------

// Reads `key` as a mapping, in either spelling the format uses: the inline
// brace form ("key: { a: 1, b: 2 }") or the indented block form ("key:"
// followed by "  a: 1" / "  b: 2"). Named for the value it reads, not for
// either spelling, because a caller judging whether a field like
// `generated` or `verified` is present must get the same answer
// regardless of which spelling a note happens to use: a reader that only
// understood one spelling would make a rule report a field missing that
// is plainly there, just written by hand instead of by the tool that
// happens to always emit the other form.
//
// null means the key is absent. undefined means the key is present but
// its value is a shape this reader does not parse: a nested mapping or
// list as one of the pairs' values, a block whose lines are not all at
// the same indentation (which is how a nested block reads here, since a
// deeper-indented continuation line never matches the block's own base
// indentation), a block that is actually a list, a value carrying a YAML
// anchor or alias, or a bare scalar where a mapping was expected. Every
// one of those is a case where guessing would produce a plausible-looking
// but wrong object, so the reader declines instead (PARSER_LIMITS).
export function readMapping(frontmatter, key) {
  const lines = (frontmatter ?? '').split('\n');
  const found = findKeyLine(lines, key);
  if (!found) return null;

  const head = found.head.trim();
  if (head === '') return readBlockMapping(lines, found.index);
  if (head.startsWith('{')) return readInlineMapping(head);
  return undefined; // present, but neither "{...}" nor an empty block header
}

function readInlineMapping(head) {
  const close = findMatchingClose(head, '{', '}');
  if (close === -1) return undefined;
  const inner = head.slice(1, close).trim();
  if (inner === '') return {};

  const result = {};
  for (const rawPair of splitUnquoted(inner, ',')) {
    const pair = splitFirstColon(rawPair.trim());
    if (!pair) return undefined;
    const [pairKey, pairValue] = pair;
    if (pairValue.startsWith('{') || pairValue.startsWith('[')) return undefined; // nested value
    result[pairKey] = unquote(pairValue);
  }
  return result;
}

function readBlockMapping(lines, keyLineIndex) {
  const block = collectBlock(lines, keyLineIndex);
  if (block.length === 0) return {}; // key present, nothing under it: an empty mapping

  const base = indentOf(block[0]);
  if (block.some((line) => indentOf(line) !== base)) return undefined; // inconsistent indentation: a nested value

  const result = {};
  for (const line of block) {
    const trimmed = line.slice(base);
    if (isEntryMarker(trimmed)) return undefined; // a list, not a mapping
    const pair = splitFirstColon(trimmed);
    if (!pair) return undefined;
    const [pairKey, pairValue] = pair;
    if (pairValue.startsWith('{') || pairValue.startsWith('[')) return undefined; // nested value
    result[pairKey] = unquote(pairValue);
  }
  return result;
}

// --- readList --------------------------------------------------------------

// Reads `key` as a list of plain scalars, in either spelling: the inline
// bracket form ("key: [a, b]") or the indented block form ("key:"
// followed by "  - a" / "  - b"). null means the key is absent; undefined
// means it is present but is not one of those two shapes: a bare scalar,
// a block whose lines are not all plain "- value" entries at the same
// indentation, or a block whose entries each look like "- field: value"
// (a single-field mapping, checked on PURPOSE via looksLikeMappingField,
// not left to fall out of the indentation check by accident) - which is
// what a list of mappings looks like, `sources` being the real example:
// use readEntries for that shape instead.
export function readList(frontmatter, key) {
  const lines = (frontmatter ?? '').split('\n');
  const found = findKeyLine(lines, key);
  if (!found) return null;

  const head = found.head.trim();
  if (head === '') return readBlockList(lines, found.index);
  if (head.startsWith('[')) return readInlineList(head);
  return undefined;
}

function readInlineList(head) {
  const close = findMatchingClose(head, '[', ']');
  if (close === -1) return undefined;
  const inner = head.slice(1, close).trim();
  if (inner === '') return [];
  return splitUnquoted(inner, ',').map((part) => unquote(part.trim()));
}

function readBlockList(lines, keyLineIndex) {
  const block = collectBlock(lines, keyLineIndex);
  if (block.length === 0) return [];

  const base = indentOf(block[0]);
  if (block.some((line) => indentOf(line) !== base)) return undefined;

  const items = [];
  for (const line of block) {
    const trimmed = line.slice(base);
    if (!isEntryMarker(trimmed)) return undefined; // not a plain list entry
    const item = afterMarker(trimmed).trim();
    if (looksLikeMappingField(item)) return undefined; // "- field: value": a mapping entry, not a plain scalar
    items.push(unquote(item));
  }
  return items;
}

// --- readEntries -------------------------------------------------------------

// Reads `key` as a block list of mappings, the shape `sources` uses: each
// entry opens with "- field: value" and continues on however many further
// lines carry the SAME field-per-line shape, indented deeper than the
// entry's own marker. Unlike readBlockMapping/readBlockList, the lines
// inside this block are deliberately NOT required to share one
// indentation: a list of mappings always carries two levels by
// construction (the marker line, and its continuation fields), so
// requiring one level here would reject the only shape this function
// exists to read.
//
// An entry may also be ONE inline mapping on its marker's own line
// ("- { by: human:ana, at: 2026-06-25T09:00:00Z }"), which is how the
// format's own section 5.2 writes `verified`. It used to be split on its
// first colon like a block field, so the example came back as one key
// named "{ by" and every conformant note written that way was reported
// with its `by` and `at` missing. Such an entry is read by the same
// inline reader readMapping uses, and only when it is the whole entry:
// the brace closes on that line, nothing follows it but a comment, no
// field line continues it, and none of its values is itself a mapping or
// a list. Anything else is a shape this reader does not guess at, and the
// whole field is undefined (PARSER_LIMITS).
//
// Inside an entry, a line indented deeper than the entry's fields belongs
// to the field above it (see readBlockEntry): that one field reads as
// undefined, and the entry's other fields are still read.
//
// null means the key is absent. undefined means it is present but is not
// this shape at all: an inline value on the key's own line, a block
// whose first line is not an entry marker, a line that is not a field, or
// an inline entry outside the one form described above.
export function readEntries(frontmatter, key) {
  const lines = (frontmatter ?? '').split('\n');
  const found = findKeyLine(lines, key);
  if (!found) return null;
  if (found.head.trim() !== '') return undefined; // only the block form is recognised

  const block = collectBlock(lines, found.index);
  if (block.length === 0) return [];

  // Each line keeps its indentation, because indentation is what says
  // whether a line is a new entry, a field of the current entry, or
  // something nested under one of its fields. The entries' own markers sit
  // at the block's first indentation; a marker deeper than that is an item
  // of a list nested inside an entry, never an entry of this list.
  const markerIndent = indentOf(block[0]);
  const rawEntries = [];
  let current = null;
  for (const line of block) {
    const indent = indentOf(line);
    const trimmed = line.slice(indent);
    if (indent === markerIndent && isEntryMarker(trimmed)) {
      const afterDash = afterMarker(trimmed);
      current = [];
      rawEntries.push(current);
      if (afterDash.trim() !== '') current.push({ indent: indent + trimmed.length - afterDash.length, text: afterDash.trim() });
    } else if (current && indent > markerIndent) {
      current.push({ indent, text: trimmed });
    } else {
      return undefined; // a line before any entry marker, or back at (or left of) the markers without being one
    }
  }

  const entries = [];
  for (const rawLines of rawEntries) {
    if (rawLines.length > 0 && rawLines[0].text.startsWith('{')) {
      if (rawLines.length > 1) return undefined; // an inline entry continued by further lines: neither form
      const inline = readInlineEntry(rawLines[0].text);
      if (inline === undefined) return undefined;
      entries.push(inline);
      continue;
    }
    const entry = readBlockEntry(rawLines);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return entries;
}

// One entry written as fields, one per line, all at the indentation of
// its first field. A line indented deeper than that belongs to the field
// above it: a nested mapping or list, or a plain value folded onto a
// further line. This reader does not read either, so that one FIELD is
// undefined (present, in a shape this reader cannot see), and the entry's
// other fields are still read. It used to fold the nested lines into the
// entry as fields of its own, so a nested "by:" under an event's "note:"
// replaced the event's own "by". A line indented less than the first
// field, but still inside the entry, is no shape at all, and the whole
// list is undefined.
function readBlockEntry(rawLines) {
  const entry = {};
  if (rawLines.length === 0) return entry;
  const fieldIndent = rawLines[0].indent;
  let lastKey = null;
  for (const { indent, text } of rawLines) {
    // Never on the first line, which sets fieldIndent, so lastKey is
    // always the field just above.
    if (indent > fieldIndent) {
      entry[lastKey] = undefined;
      continue;
    }
    if (indent < fieldIndent) return undefined;
    const pair = entryFieldPair(text);
    if (!pair) return undefined;
    const [entryKey, entryValue] = pair;
    entry[entryKey] = unquote(entryValue);
    lastKey = entryKey;
  }
  return entry;
}

// One "field: value" line of a block entry, split on its first colon, or
// null when the line is not a field at all. Two shapes used to be split
// anyway and handed back as a key nobody wrote: a line opening with a
// brace or a bracket (an inline collection where a field was expected,
// read as a key named "{a"), and a line whose first colon is not followed
// by whitespace or the end of the line, which in YAML is not a key
// separator ("- https://example.com" read as a key "https"). Both now
// decline the whole field, the same answer every other shape this reader
// cannot see gets.
function entryFieldPair(line) {
  if (line.startsWith('{') || line.startsWith('[')) return null;
  const colon = line.indexOf(':');
  if (colon === -1 || !/^(?:[ \t]|$)/.test(line.slice(colon + 1))) return null;
  return splitFirstColon(line);
}

// One list entry written as an inline mapping, the text after its "- "
// marker. Read only when the mapping is the whole entry: what follows the
// closing brace may be a YAML comment (a "#" after whitespace) and nothing
// else, since text after it is not part of the mapping and reading past it
// would hand back a value the entry does not hold. readInlineMapping
// already declines a nested value, and reads only up to the closing
// brace. A brace that never closes (close is -1) leaves the whole text as
// the tail, which opens with the brace itself and so never passes.
function readInlineEntry(text) {
  const close = findMatchingClose(text, '{', '}');
  if (!/^(?:[ \t]+#.*)?$/.test(text.slice(close + 1))) return undefined;
  return readInlineMapping(text);
}

// --- frontmatterKeyLine -----------------------------------------------------

// Finds the 1-based line, in the WHOLE FILE, of the top-level frontmatter
// line "key:" (column 0, quoted or bare, inside the frontmatter block
// only), using the exact same lookup every reader above already shares.
// Returns null when the key's own line cannot be found, which callers
// use for "the key is absent, so there is no line to point at".
// `frontmatter` is the exact string splitFrontmatter returns (never the
// whole file, never the body): its line 0 is always the file's line 2,
// since splitFrontmatter's own opening delimiter match consumes exactly
// one line ("---" plus its own newline) before frontmatter begins,
// whatever the block's content is.
//
// Exported once, here, rather than duplicated in each rules module. Two
// independent copies of exactly this helper (src/rules/spec.mjs and
// src/rules/house.mjs) diverged from each other in two different ways at
// once: the house copy rebuilt its own RegExp from the key text without
// escaping it first, which throws outright for a config-supplied field
// name containing a regular-expression metacharacter such as "a(b", and
// separately dropped the quoted-key alternative findKeyLine already
// recognises, so a quoted key read correctly by every OTHER reader in
// this file still reported a null line from that copy, as if it were
// absent. Sharing findKeyLine directly, instead of re-deriving its
// pattern a third time, means a future fix to how a key is found (a new
// quoting form, a new escaping rule) reaches every caller by construction,
// which is the same lesson src/markdown.mjs's own header states of
// itself for fenced code.
export function frontmatterKeyLine(frontmatter, key) {
  if (!frontmatter) return null;
  const found = findKeyLine(frontmatter.split('\n'), key);
  return found ? found.index + 2 : null;
}

// --- PARSER_LIMITS -----------------------------------------------------------

// What this reader cannot see, or what it can see but might still
// surprise a reader of its output, stated plainly so a consumer of the
// validator's JSON output is never misled about the depth of a check that
// passed. Static and human-reviewed: nothing appends to this array at
// runtime, and nothing above ever tries to. Most entries here describe a
// decline (the call sites above return undefined for a shape this reader
// will not guess at); one, the last, describes behaviour that is correct
// per the format and still worth naming, because a rule built on top of
// a correct answer can still be surprised by it. A shape found to be
// beyond this reader either returns undefined at the call sites above,
// or, if it silently produced a wrong answer instead, is a bug in this
// file rather than a fact about the format.
export const PARSER_LIMITS = Object.freeze([
  'A mapping value that is itself a mapping or a list (a nested structure) is not parsed: readMapping returns undefined for the whole field rather than a flattened or partial result.',
  'A block or folded scalar (a value written as just "|" or ">", with the real content on the following indented lines) is not read: readScalar returns undefined for that field instead of the bare marker character.',
  'A YAML anchor (&name) or alias (*name) is not recognized: readMapping and readList return undefined for a field that carries one, and readScalar returns the raw line text, marker included, since it never tries to interpret the value at all.',
  'An inline mapping or list whose closing brace or bracket is not on the same line as the key is not read: readMapping and readList both return undefined for that field, the same as any other shape they cannot see.',
  'A backslash before a quote inside an inline mapping or list is not an escape: an even count of quote characters still finds the closing brace or bracket and reads the value whole, backslash included; an odd count never finds it, and readMapping or readList returns undefined instead of a truncated value.',
  'A plain value folded across indented continuation lines, with no "|" or ">" marker, is not joined back together, whether the key line is left empty or already carries the first line of the value: readScalar returns undefined either way instead of an empty string or a truncated first line.',
  'A hash preceded by a space inside an UNQUOTED scalar value starts a YAML comment: readScalar strips it and returns the shortened value, correct per the format, which can still surprise a value meant to hold a literal "#" unquoted.',
  'A field of a readEntries entry with lines indented deeper than the entry\'s fields under it (a nested mapping or list, or a folded value) is not read: that field is undefined in the entry, and the entry\'s other fields are still read.',
  'readEntries reads a list entry written as one inline mapping only when it closes on its own line with nothing after it but a comment, holds no nested value and has no field lines under it; any other inline entry, and an inline list of mappings on the key line, returns undefined for the whole field.',
]);
