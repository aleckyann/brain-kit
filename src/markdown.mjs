// The one place fenced, indented and inline code are recognised and
// blanked out of a body of markdown text, before any rule reads a
// heading or a link out of it.
//
// This module exists because of a mistake, not as a precaution against
// one. The house ruler (src/rules/house.mjs) once carried its own copy
// of this logic, built independently of the specification ruler's
// (src/rules/spec.mjs) on the stated reasoning that keeping the two
// rulers independent was itself a virtue. It was not: the house copy
// trimmed each line before testing it for a fence marker, so a
// fence-shaped line at ANY indentation opened a fence, including one
// sitting inside a four-space indented code block that was only ever
// being used to document how to write a fence. That phantom fence never
// closed, and blanked every remaining line of the file, silencing the
// house ruler's link checks for the rest of the note. The specification
// ruler had already been fixed twice for exactly this shape of bug
// (a bare "```" prefix test, then a version that still missed a tilde
// fence and a shorter fence nested inside a longer one), and neither
// fix ever reached the house ruler, because there was no shared code for
// a fix to reach. Two independent implementations of one rule are not
// independence: they are two chances to disagree about what a fence is,
// and disagreeing about that is the same class of defect as two walks
// disagreeing about what a vault contains (src/vault.mjs's own header).
//
// This project already paid for the general shape of this mistake once:
// the phase 0 push gate needed five rounds of fixes because its logic
// lived in many places that each had to remember the same rule.
// Duplicated-for-independence is worth nothing when the copies must
// agree in order to be correct, and code-stripping is exactly that kind
// of rule. So it lives here, once, and both rulers import it. A future
// third rule that needs to read a heading or a link past code gets this
// for free, correct, instead of a third chance to get it wrong.
//
// Fix round 2: blockquote support was added on top of the fence rule as
// a fourth case (marker character, marker length, the four-space
// indented block, and then "read a blockquote's content after its own
// prefix"), and a fourth case is exactly what it was: patched onto what
// closes a fence rather than derived from one model, so it got the
// model wrong in both directions. A fence opened inside a blockquote
// could be closed by an unquoted marker outside it, and vice versa, and
// an unclosed quoted fence ran all the way to the end of the FILE
// instead of stopping at the end of its own blockquote. The model,
// stated once rather than patched a fourth time: A FENCE BELONGS TO THE
// CONTAINER THAT OPENED IT. Every line has a blockquote DEPTH (how many
// levels of ">" it is nested under, 0 at the top level). A fence
// remembers the depth it opened at:
// - a later line at a SHALLOWER depth means that container has ended
//   (the blockquote the fence was inside has closed, or, for a
//   top-level fence, there is no shallower depth to fall to and this
//   case never fires), so the fence closes HERE, at its container's own
//   boundary, and that line is read fresh, exactly as if no fence had
//   been open, rather than being consumed as the fence's own content or
//   left to run to the end of the file;
// - a later line at the SAME depth is read in the ordinary way (does
//   its marker close this fence, or is it content);
// - a later line at a DEEPER depth (a blockquote marker appearing while
//   a shallower fence is open) can neither close the fence nor be
//   reinterpreted as a new container: a fence's content is never
//   reinterpreted in real markdown either, so it is simply more content
//   of the still-open fence, blanked the same as any other line inside
//   it, with no marker check at all (its depth cannot match the
//   fence's own, so it structurally cannot be the closing line).
// This one rule is what stops a marker's depth from ever crossing a
// container boundary in either direction, and is why an unclosed fence
// now stops at its own container's edge: the file simply runs out of
// lines at that depth before it runs out of lines at all.
//
// The contract, in full:
//
// - A FENCE opens on a line with at most three leading spaces carrying
//   at least three backticks or at least three tildes (never a mix),
//   with nothing else on the line but an optional info string; it
//   closes only on a later line, in the SAME container (see the model
//   above), whose marker is the SAME character and AT LEAST as long as
//   the one that opened it, with nothing else on that line. An unclosed
//   fence runs to the end of ITS CONTAINER: guessing where it might
//   have ended would be worse than declining to look inside it, the
//   same caution src/frontmatter.mjs takes for an unterminated
//   frontmatter block.
// - A line inside a BLOCKQUOTE (prefixed with up to three spaces, a
//   ">", and one optional following space, any number of times for a
//   nested quote) is read for fence and indentation purposes as its
//   content AFTER that prefix, exactly as a real markdown renderer
//   parses a blockquote's content independently of the quote marker.
//   A fenced code block quoted this way ("> ```", "> a line inside",
//   "> ```") is therefore still code, not prose: a vault entry that
//   quotes an example is an ordinary thing to write, and the same
//   hazard applies as an unquoted one.
// - A block of lines each indented four spaces or more (or starting
//   with a tab) beyond its own container's content column, immediately
//   following a blank line or the start of the text (an indented block
//   cannot interrupt a paragraph, so it needs a blank line before it,
//   exactly as it needs one in real markdown), is itself code, blanked
//   the same as a fenced block. This is also the reason a fence-shaped
//   line at that indentation never opens a fence: it is already inside
//   a code region, and a marker character inside code is content, not
//   structure. "Its own container's content column" matters for a list
//   item specifically (fix round 2): a loose list item's continuation
//   paragraph, indented to the ITEM's own content column rather than to
//   column 0, is not four spaces past THAT column and is therefore
//   ordinary text, never code, however many spaces past column 0 it
//   happens to sit at.
// - An INLINE code span is delimited by a run of one or more backticks,
//   closed by the NEXT run of the exact same length on the same line;
//   a run of a different length is content, not a delimiter. The whole
//   span, delimiters and contents alike, is blanked: a double-backtick
//   span hides what is inside it rather than unwrapping it, which is
//   what lets `` ``[text](url)`` `` document a link's own syntax
//   without that example being read as a real one.
//
// Blanking a line (replacing its content with an empty string) rather
// than removing it keeps every later line NUMBER exactly where it was:
// a finding reported after a multi-line fence must still point at its
// own real line in the original file, not at a line shifted up by
// however long the fence or the code block was.
//
// Declined on purpose, and not a fact this module hides: a fence or an
// inline span that starts mid-line after other content on an OPENING
// fence marker's own line is read by its info string rule correctly,
// but an inline code span is only ever recognised within a single
// line - a span that opens on one line and closes on a later one is
// not joined back together, the same trade-off src/frontmatter.mjs
// makes for a folded scalar. A nested list item's own, deeper content
// column is not separately tracked: this module remembers only the most
// recently seen list marker's column, which is the shape the reported
// defect actually took and the shape most real vaults write, not a full
// per-level list stack.

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;

// The content of `line` after every leading blockquote marker (up to
// three spaces, then ">", then one optional space, repeated for a
// quote nested inside a quote) has been stripped, plus how many levels
// were stripped: the DEPTH a fence or a list item's own container
// tracking needs to tell one container from another.
function splitBlockquotePrefix(line) {
  let depth = 0;
  let rest = line;
  while (BLOCKQUOTE_PREFIX.test(rest)) {
    rest = rest.replace(BLOCKQUOTE_PREFIX, '');
    depth++;
  }
  return { content: rest, depth };
}

function leadingSpaceCount(logical) {
  return /^ */.exec(logical)[0].length;
}

// True when `logical` is indented at least four columns past
// `baseColumn` (the content column of whatever container it is read
// inside, 0 outside of a list item), or opens with a literal tab,
// matching this module's own, deliberately simple tab handling
// throughout.
function isIndentedEnough(logical, baseColumn) {
  if (/^\t/.test(logical)) return true;
  return leadingSpaceCount(logical) >= baseColumn + 4;
}

// The column a list item's own content begins at ("- ", "12. ", each
// with up to three leading spaces of their own), or null when `logical`
// does not open with a list marker at all.
function listMarkerColumn(logical) {
  const match = LIST_MARKER.exec(logical);
  return match ? match[0].length : null;
}

// Blanks every line that is part of a fenced code block or an indented
// code block, tracking both kinds of block, and the list item a loose
// continuation might belong to, across the whole text in one forward
// pass.
//
// `fence` holds the open fence's marker character, length and the
// DEPTH it opened at, or null; see this module's own header for the
// container model that depth serves. `indentedBlock` holds the base
// column an open indented block was measured against, or null.
// `precededByBlank` and `list` (the most recent list marker's own
// content column and the depth it was seen at) together decide whether
// an indented, non-blank line starts a new code block, continues a
// loose list item instead, or is itself a fresh list marker.
function blankFencedAndIndentedCode(text) {
  const lines = text.split('\n');
  const output = [];
  let fence = null;
  let indentedBlock = null;
  let precededByBlank = true;
  let list = null;

  for (const line of lines) {
    const { content: logical, depth } = splitBlockquotePrefix(line);

    if (fence) {
      if (depth < fence.depth) {
        // Shallower depth: the container the fence opened in has
        // ended (a blockquote it was inside just closed). The fence
        // closes HERE, at its container's own boundary, not at the
        // end of the file, and this line is read fresh below, exactly
        // as if no fence had ever been open.
        fence = null;
      } else if (depth === fence.depth) {
        const marker = FENCE_MARKER.exec(logical);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') fence = null;
        precededByBlank = false;
        output.push('');
        continue;
      } else {
        // Deeper depth: a blockquote marker appearing while a
        // shallower fence is open cannot close it and is not a new
        // container either, the same way a fence's content is never
        // reinterpreted in real markdown; it is simply more content of
        // the still-open fence.
        precededByBlank = false;
        output.push('');
        continue;
      }
    }

    if (indentedBlock) {
      if (logical.trim() === '' || isIndentedEnough(logical, indentedBlock.baseColumn)) {
        const isBlank = logical.trim() === '';
        precededByBlank = isBlank;
        output.push(isBlank ? line : '');
        continue;
      }
      indentedBlock = null; // under-indented, non-blank: the block ends, and this line is read fresh below
    }

    if (list && depth !== list.depth) list = null; // the list item's own container changed; it is no longer in scope

    const opening = FENCE_MARKER.exec(logical);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length, depth };
      list = null;
      precededByBlank = false;
      output.push('');
      continue;
    }

    if (logical.trim() === '') {
      precededByBlank = true; // a code block (of either kind) continues across a blank line untouched; there is nothing on it to blank
      output.push(line);
      continue;
    }

    const markerColumn = listMarkerColumn(logical);
    if (markerColumn !== null) {
      list = { column: markerColumn, depth };
      precededByBlank = false;
      output.push(line);
      continue;
    }

    if (list && leadingSpaceCount(logical) < list.column) list = null; // de-indented below the item's own content: it ends here

    const baseColumn = list ? list.column : 0;
    if (precededByBlank && isIndentedEnough(logical, baseColumn)) {
      indentedBlock = { baseColumn };
      precededByBlank = false;
      output.push('');
      continue;
    }

    precededByBlank = false;
    output.push(line);
  }

  return output.join('\n');
}

// Blanks every inline code span in `line`: a run of backticks opens one,
// and it closes at the next run of the EXACT same length, wherever that
// falls on the same line; a run of a different length in between is
// content, not a delimiter, so `` ``a`b`` `` is one span covering
// "a`b" whole, not two. A backtick run with no matching close on the
// line is not a span at all and is left in the output untouched, rather
// than guessed at or silently dropped.
function stripInlineCode(line) {
  let result = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let j = i;
      while (line[j] === '`') j++;
      const runLength = j - i;
      const closeIndex = findClosingBacktickRun(line, j, runLength);
      if (closeIndex !== -1) {
        i = closeIndex; // the whole span, delimiters and contents, is blanked: nothing is appended for it
        continue;
      }
      result += line.slice(i, j); // no matching close: not a span, keep the backticks as plain text
      i = j;
      continue;
    }
    result += line[i];
    i++;
  }
  return result;
}

function findClosingBacktickRun(line, from, runLength) {
  let k = from;
  while (k < line.length) {
    if (line[k] === '`') {
      let m = k;
      while (line[m] === '`') m++;
      if (m - k === runLength) return m;
      k = m;
    } else {
      k++;
    }
  }
  return -1;
}

// Blanks fenced code, indented code and inline code out of `text`, in
// that order (block-level code first, since an inline backtick run
// inside an already-blanked line has nothing left to match), preserving
// every line's position so line numbers computed against the result
// still point at the right line in the original file.
export function stripCode(text) {
  return blankFencedAndIndentedCode(text)
    .split('\n')
    .map(stripInlineCode)
    .join('\n');
}
