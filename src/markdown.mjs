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
// The contract, in full:
//
// - A FENCE opens on a line with at most three leading spaces carrying
//   at least three backticks or at least three tildes (never a mix),
//   with nothing else on the line but an optional info string; it
//   closes only on a later line whose marker is the SAME character and
//   AT LEAST as long as the one that opened it, with nothing else on
//   that line. An unclosed fence runs to the end of the file: guessing
//   where it might have ended would be worse than declining to look
//   inside it, the same caution src/frontmatter.mjs takes for an
//   unterminated frontmatter block.
// - A line inside a BLOCKQUOTE (prefixed with up to three spaces, a
//   ">", and one optional following space, any number of times for a
//   nested quote) is read for fence and indentation purposes as its
//   content AFTER that prefix, exactly as a real markdown renderer
//   parses a blockquote's content independently of the quote marker.
//   A fenced code block quoted this way ("> ```", "> a line inside",
//   "> ```") is therefore still code, not prose: the original defect
//   above was never about quoting, but a vault entry that quotes an
//   example is an ordinary thing to write, and the same hazard applies.
// - A block of lines each indented four spaces or more (or starting
//   with a tab), immediately following a blank line or the start of the
//   text (an indented block cannot interrupt a paragraph, so it needs a
//   blank line before it, exactly as it needs one in real markdown), is
//   itself code, blanked the same as a fenced block. This is also the
//   reason a fence-shaped line at that indentation never opens a fence:
//   it is already inside a code region, and a marker character inside
//   code is content, not structure.
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
// makes for a folded scalar.

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const INDENTED_CODE_PREFIX = /^(?: {4,}|\t)/;

// The content of `line` after every leading blockquote marker (up to
// three spaces, then ">", then one optional space, repeated for a
// quote nested inside a quote) has been stripped, so a fence or an
// indentation test below sees what a real renderer would see: the
// quote's own content, not the marks that carry it.
function stripBlockquoteMarkers(line) {
  let rest = line;
  while (BLOCKQUOTE_PREFIX.test(rest)) {
    rest = rest.replace(BLOCKQUOTE_PREFIX, '');
  }
  return rest;
}

// Blanks every line that is part of a fenced code block or an indented
// code block, tracking both kinds of block across the whole text in one
// forward pass. `fence` holds the open fence's marker character and
// length while one is open, or null; `inIndentedBlock` and
// `precededByBlank` together decide whether an indented, non-blank line
// starts or continues an indented block rather than being an ordinary
// line that merely happens to be indented (a list item's continuation,
// for instance, which this module does not otherwise need to recognise,
// since it is never mistaken for code by this rule: it is never
// preceded by a blank line the way a real indented code block must be).
function blankFencedAndIndentedCode(text) {
  let fence = null;
  let precededByBlank = true;
  let inIndentedBlock = false;

  return text
    .split('\n')
    .map((line) => {
      const logical = stripBlockquoteMarkers(line);

      if (fence) {
        const marker = FENCE_MARKER.exec(logical);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') {
          fence = null;
        }
        precededByBlank = false;
        return ''; // every line while a fence is open is code, its own closing marker included
      }

      const opening = FENCE_MARKER.exec(logical);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
        inIndentedBlock = false; // a fence takes precedence over any indented run in progress
        precededByBlank = false;
        return '';
      }

      if (logical.trim() === '') {
        precededByBlank = true; // an indented block continues across a blank line untouched; there is nothing on it to blank
        return line;
      }

      const indented = INDENTED_CODE_PREFIX.test(logical);
      if (inIndentedBlock) {
        if (indented) {
          precededByBlank = false;
          return '';
        }
        inIndentedBlock = false; // under-indented, non-blank: the block ends, and this line is ordinary text
      } else if (precededByBlank && indented) {
        inIndentedBlock = true;
        precededByBlank = false;
        return '';
      }

      precededByBlank = false;
      return line;
    })
    .join('\n');
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
