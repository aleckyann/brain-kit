// The Open Knowledge Format ruler: the rules the specification itself
// requires, fixed in code and never configurable. The house ruler
// (src/rules/house.mjs, a later task) is where a vault's own config gets
// a say; this module has no config section of its own at all, and never
// reads context.config for that reason. It also never reads context.all:
// none of these eight rules resolves a link against the vault's full
// file list (link-target-exists, the one rule that does, is a house
// rule), so the walk asking for every file, attachments included, is not
// something this module needed.
//
// Consumes: splitFrontmatter and the readers from src/frontmatter.mjs,
// plus the two arguments of the ruler contract that src/commands/validate.mjs
// (a later task) builds from a single walkVault call: `files` (the sorted,
// root-relative, forward-slash markdown subset) and `context` (`{ root,
// config, all, readFile }`, where readFile already strips a leading
// byte-order mark and normalises line endings, once, for every rule and
// every reader alike). This module never calls walkVault itself: a second
// walk would let this ruler and the house ruler disagree about what the
// vault even contains, which is exactly the defect the single-walk
// contract exists to remove.
//
// The reader's two absences, load-bearing here: null means a key is
// ABSENT, undefined means it is PRESENT but written in a shape the
// regular-expression readers cannot see. Every rule below that reads a
// named field distinguishes them: an absent field is either skipped (the
// six "when present" rules: generated-actor, verified-events, status-enum,
// stale-after-format, sources-resource, and index-no-frontmatter's root
// exception) or, for type, reported as missing (type-required, the one
// unconditional field); an unreadable shape is always its own finding,
// naming PARSER_LIMITS, never folded into "missing". Collapsing the two
// would tell an adopter a field is absent when it is plainly on their
// screen, just written in a shape this project's zero-dependency reader
// declined to parse rather than guess at.
//
// Reserved filenames: index.md and log.md, matched by basename at any
// depth (a folder index two levels deep is exactly as reserved as the
// root one), are the 14 files the original vault's own comments called
// "reserved" out of 234 (13 index files plus the one log, ported here as
// a literal list rather than re-derived, since there is nothing to derive
// it FROM other than this pair of names). type-required and the five
// "when present" trust-signal rules all skip a reserved file outright:
// the original validator does the same (its per-file loop `continue`s
// right after handling index.md or log.md, before any of those checks
// run), and porting that control flow, not just its two dedicated rules,
// keeps a malformed reserved file from being double-reported by a check
// that was never about it in the first place.
//
// No placeholder exemption anywhere in this file, on purpose. The
// original validator's placeholder exemption (a value containing "<" was
// exempt from every dated-field check) applied inside its [spec] checks
// across the whole tree, which is a documented defect this port does not
// reproduce: here, a placeholder-shaped value is only ever excused by the
// house ruler, and only for files under the configured templates
// directory. The spec ruler has no notion of a template at all.
//
// Conformance levels (fix round 2, reading section 11 of the format
// itself rather than the plan's earlier guess at it): the specification
// defines exactly two tiers, not one. Section 11 makes only three things
// conformance: every non-reserved markdown file carries a parseable
// frontmatter block; every frontmatter block carries a non-empty type;
// and the reserved filenames follow their own sections. Everything in
// sections 5 to 10, the trust and lifecycle fields this file otherwise
// checks, is what a producer SHOULD do, not what makes a bundle
// conformant. Flattening the two into one severity would tell a person
// whose vault reports fifteen findings that they have a broken bundle
// when they may only have an opinionated one, which is the wrong
// direction to be wrong in: it is the answer that gets the tool switched
// off.
//
// Fix round 3: the level belongs to the CHECK, not to the rule. Two
// rules (index-no-frontmatter, log-format) bundle checks the format
// grades differently, so a single level per rule made the ruler
// over-claim on precisely this point. Every finding carries its own
// `level`, set either by the rule object (when every check it emits
// agrees: type-required is always 'must'; the five section 5 to 10
// rules are always 'should') or by the individual finding, for the two
// rules whose checks do not agree. `runSpecRules` prefers a finding's
// own level over its rule's, so a rule with no single level simply
// never sets one and every one of its findings must. When a reading of
// the format is arguable rather than plain, the level claimed is
// 'should', never 'must': telling a person their bundle is NOT
// CONFORMANT on a reading the text does not plainly support is the
// failure that gets a validator switched off.
//
// Section 11 also settles two questions this file no longer has to guess
// at. First, quoted here rather than left as an inference: consumers
// "MUST treat a bare `verified` mapping as a one-element list", which is
// exactly what readVerifiedEvents below already did on this project's
// own judgment before the citation existed. Second, and corrected in fix
// round 3 (the sentence quoted here in an earlier round did not exist;
// it spliced two real ones into a third): section 11 separately lists
// what consumers "MUST NOT reject a bundle because of", one item being
// "Unknown `type` values". That is why type-required below checks only
// that `type` is non-empty and never enumerates what it may be; a closed
// list of allowed types is a house rule (frontmatter.type_enum, task 5),
// and never belongs here.
//
// Section 5, quoted rather than inferred: "Every timestamp-valued key in
// OKF is an ISO 8601 datetime with an explicit UTC offset." This binds
// generated.at and stale_after alike (fix round 2): a house rule cannot
// widen a form the specification itself fixes to one, so stale_after no
// longer accepts a plain date here at all, and a vault mid-migration off
// plain dates declares that deviation to the house ruler instead
// (validate.timestamp_deviation, task 5), which can downgrade a `should`
// finding to a warning and can never touch a `must`.
//
// Line numbers: a rule that is fundamentally about a whole FIELD (every
// rule here except log-format, which is about heading LINES) reports the
// line of that field's own top-level "key:" line when the key exists, and
// null when it does not (there is no line to point at for a field that
// was never written). frontmatterKeyLine below derives that line directly
// from the frontmatter text every rule already has in hand; it does not
// re-derive WHICH shape the value is (that judgment stays exactly once,
// in src/frontmatter.mjs's own readers), only WHERE the key's line sits,
// which is unambiguous for a column-0 key regardless of how its value
// reads. A specific bad entry inside a list (one bad source, one bad
// verified event) is named by its index in the message instead of by its
// own line, rather than re-deriving readEntries' block-scanning here a
// second time for one extra digit of precision.
//
// Fix round 1 (review of commit 5486479/11356f8), five corrections that
// matter beyond their own diff: log-format now reads headings from the
// text with every fenced code block blanked out first (withoutFencedBlocks),
// since a "## " or a quoted date inside a fence is documentation, not a
// real heading or a real entry, and scanning raw text without that
// exclusion is exactly the hazard src/frontmatter.mjs's own delimiter
// design removes for "---"; index-no-frontmatter now exempts a YAML
// comment in the root index from being read as an extra declaration, and
// no longer exempts an indented line just for being indented (both
// checked against the trimmed line, matching the original validator's
// own filter); every date and datetime check (log-format, generated-actor,
// stale-after-format) validates the calendar, not only the shape, so a
// 29th of February in a non-leap year or a 13th month is a finding, not
// eight digits that merely look right; type-required no longer reports
// "missing" for a file whose frontmatter opens with "---" but never
// closes, since a type line can be sitting in that unterminated block in
// plain sight, which readScalar cannot see either way once
// splitFrontmatter itself lost track of where the block ends; and
// verified-events again reports a `verified` key present with no events
// under it at all, restoring a finding the original validator also made
// ("verified vazio") that this port had silently dropped.
//
// Fix round 3, six corrections: the level moved from the rule to the
// check (see above); withoutFencedBlocks now matches CommonMark's own
// fence rule (up to three leading spaces, three-or-more backticks OR
// tildes, tracking the opening marker's character and length and
// closing only on a marker at least as long of the SAME character)
// instead of a bare "```" prefix, which missed tilde fences, mishandled
// a shorter fence nested in a longer one, and, worst, treated a fenced
// three-backtick line found inside a four-space-indented code block as
// a real fence toggle, silently swallowing every real heading after it;
// type-required no longer says a file "has no frontmatter at all" when
// its frontmatter parses fine and simply has no type key, which is the
// commonest way this rule fires and had been miscast as the unterminated
// case's message since fix round 1 narrowed that one branch without
// revisiting the other; the offset ceiling on a datetime's UTC offset is
// 14 hours, not 23 (the real range of UTC offsets in use, checked
// against the offset's digits regardless of sign, so +14:00 and -12:00
// both pass and +15:00 does not); frontmatterKeyLine now recognises a
// quoted key the same way findKeyLine in src/frontmatter.mjs already
// does, since fix round 1 widened the shared lookup but left this
// module's own line-number helper matching only the bare form, which
// made a quoted key read correctly but report a null line; and
// stripTrailingComment now finds the real closing quote of a quoted
// value before looking for a comment after it, rather than assuming a
// value that opens with a quote never has anything real following it on
// the same line, which is what let a quoted, then commented, scalar
// still misread.
import { posix } from 'node:path';
import { readEntries, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);
const STATUS_ENUM = new Set(['draft', 'stable', 'deprecated']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

// --- calendar-valid dates and datetimes ---------------------------------------
//
// A date or datetime is checked against the calendar, not just against its
// own shape: fix round 1 found the original two regexes accepted a 29th of
// February in a year that is not a leap year, a 31st of April, a 13th
// month, hours or minutes of 99, and an offset of 99 hours, all of which
// match "\d\d" perfectly well while describing a moment that cannot exist.
// A format rule that accepts a date that never happened is not checking
// the date; it is checking that someone typed eight digits. Two-digit
// years and a datetime with no offset were already rejected by the shape
// alone (the pattern below still requires exactly four digits and an
// explicit "Z" or "+HH:MM"/"-HH:MM"), and stay rejected here.

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

function isValidTimeOfDay(hour, minute, second) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A plain date: right shape AND a day that exists in that month and year.
function isValidIsoDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

const DATETIME_WITH_OFFSET_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// A datetime with an explicit offset (a bare "Z" counts as one): right
// shape, a calendar-valid date, a clock-valid time, and, when the offset
// is not "Z", an offset hour of 0-14 and an offset minute of 0-59.
// Fourteen, not twenty-four: a clock's own hour runs to 23, but a UTC
// offset's real range in current use is -12:00 to +14:00, checked here
// against the digits alone regardless of sign, so +14:00 and -12:00
// both pass and +15:00 does not. Nothing asymmetric is coded for the
// negative side on purpose: the format gives no distinct bound for it,
// and a single ceiling checked against the unsigned digits already
// accepts every real offset in use and rejects anything wider.
function isValidIsoDatetimeWithOffset(value) {
  const match = DATETIME_WITH_OFFSET_PATTERN.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, zone] = match;
  if (!isValidCalendarDate(Number(yearStr), Number(monthStr), Number(dayStr))) return false;
  if (!isValidTimeOfDay(Number(hourStr), Number(minuteStr), Number(secondStr))) return false;
  if (zone === 'Z') return true;
  return Number(zone.slice(1, 3)) <= 14 && Number(zone.slice(4, 6)) <= 59;
}

// --- fenced code blocks, skipped before log-format reads headings -------------
//
// A "## " line inside a fenced code block is an example, not a heading,
// and a date quoted inside a fence is not a real log entry: this is the
// third defect carried over from the original validator (its own log
// check scanned the raw file text for headings with no fence awareness
// at all), and it lands specifically in the one rule that works from raw
// text instead of the frontmatter split, which is exactly the hazard
// src/frontmatter.mjs's own header names as something its design removes
// (a "---" inside a fenced block is never mistaken for a delimiter there,
// for the same reason). Blanking each fenced line, rather than deleting
// it, keeps every line NUMBER after the fence exactly where it was: a
// heading reported after a multi-line fence must still point at its own
// real line, not at a line shifted up by however long the fence was.
//
// Fix round 3: matches the fence rule the review handed down, not a bare
// "```" prefix. A fence marker is up to three leading spaces, then three
// or more backticks OR three or more tildes (never mixed), with nothing
// but the rest of the line after it (an info string on an OPENING fence
// is allowed and ignored; a CLOSING fence allows only trailing
// whitespace). The four leading spaces of a real indented code block
// never match "at most three", so a fence-shaped line inside one is
// plain text here, not a toggle: this is what fixed the false negative
// where such a line silently opened a fence that swallowed every real
// heading after it. Closing requires the SAME character and a marker at
// LEAST as long as the one that opened it, tracked in `fence`, so a
// shorter same-character fence nested inside a longer one (three
// backticks inside four) is content, not a close, and a tilde fence is
// recognised on the same terms as a backtick one instead of being
// missed entirely.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

function withoutFencedBlocks(text) {
  let fence = null; // { char, length } of the open fence, or null
  return text
    .split('\n')
    .map((line) => {
      const match = FENCE_LINE.exec(line);
      if (!match) return fence ? '' : line;

      const marker = match[1];
      const rest = match[2];
      if (!fence) {
        fence = { char: marker[0], length: marker.length };
        return '';
      }
      if (marker[0] === fence.char && marker.length >= fence.length && rest.trim() === '') {
        fence = null;
      }
      return ''; // a marker line while inside a fence is always blanked, whether it closes the fence or is merely content that happens to look like one
    })
    .join('\n');
}

// A value read back from a mapping or entries object counts as blank when
// the key was never there at all (undefined) or was there with nothing
// but whitespace: the format has no reason to tell those two apart, since
// either way there is nothing usable in the field. String() guards this
// against ever throwing even if a future reader returned something other
// than a string or undefined for a leaf value; today it never does.
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Finds the 1-based line, in the whole file, of the top-level frontmatter
// line "key:" (column 0, inside the frontmatter block only). Returns null
// when the key's own line cannot be found, which callers use for "the key
// is absent, so there is no line to point at". `frontmatter` is the exact
// string splitFrontmatter returns (never the whole file, never the body):
// its line 0 is always the file's line 2, since splitFrontmatter's own
// opening delimiter match consumes exactly one line ("---" plus its own
// newline) before frontmatter begins, whatever the block's content is.
//
// The key may be written bare or quoted ("key": value, 'key': value),
// matching findKeyLine in src/frontmatter.mjs on the same three
// alternatives: fix round 1 widened that shared lookup so every reader
// finds a quoted key, but left this helper matching only the bare form,
// so a quoted key was read correctly and then reported at a null line,
// as if it were absent. Fixed here rather than by exporting and reusing
// findKeyLine itself, which is private to that module on purpose (this
// helper only needs WHERE a key's line is, never how its value reads).
function frontmatterKeyLine(frontmatter, key) {
  if (!frontmatter) return null;
  const pattern = new RegExp(`^(?:"${key}"|'${key}'|${key})[ \t]*:`);
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 2;
  }
  return null;
}

// Reads `verified` in either shape the format allows: a single event
// (the same inline-or-block mapping shape `generated` always uses) or a
// block list of several events over time. readEntries recognises only
// the list shape and returns undefined for anything else that is still
// present (an inline value on the key's own line, or a block mapping);
// readMapping recognises only a single mapping and returns undefined for
// a list. Trying entries first and falling back to a single mapping,
// normalised into a one-element list, means the rule below never has to
// know which spelling a given note chose. Section 11 of the format
// ratifies this in its own words: consumers "MUST treat a bare `verified`
// mapping as a one-element list", which this function already did as an
// engineering judgment (reviewed and approved in fix round 1) before that
// citation was found; it is a quotation now, not an inference.
function readVerifiedEvents(frontmatter) {
  const asEntries = readEntries(frontmatter, 'verified');
  if (asEntries === null) return null;
  if (Array.isArray(asEntries)) return asEntries;
  const asMapping = readMapping(frontmatter, 'verified');
  if (asMapping === null || asMapping === undefined) return asMapping;
  return [asMapping];
}

// True when `text` opens with a bare "---" line (splitFrontmatter's own
// OPEN_DELIMITER shape) but splitFrontmatter still reported no
// frontmatter, which only happens when no closing "---" was ever found.
// This is a narrower question than "does this text have frontmatter": it
// is "was frontmatter plainly ATTEMPTED", asked without re-deciding
// anything splitFrontmatter already decided (it is not called again
// here; the caller already has its result). Used by type-required alone,
// to tell an unterminated block apart from a file that never had
// frontmatter in mind at all, since those two need different messages.
function looksLikeUnterminatedFrontmatter(text) {
  return /^---[ \t]*\n/.test(text);
}

// --- type-required (4.1) -------------------------------------------------------
//
// Non-empty, never enumerated: section 11 lists "Unknown `type` values"
// among what consumers "MUST NOT reject a bundle because of", so this
// check stops at "is type here and is it non-empty" on purpose. A closed
// list of allowed types belongs to the house ruler's frontmatter.type_enum
// (task 5), never here.

const typeRequired = {
  id: 'type-required',
  section: '4.1',
  level: 'must',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const rawText = context.readFile(file);
      const { frontmatter } = splitFrontmatter(rawText);
      const value = readScalar(frontmatter, 'type');
      const line = frontmatterKeyLine(frontmatter, 'type');
      if (value === null) {
        // Three different claims share `value === null`, and only one
        // of them is "there is no frontmatter at all": frontmatter may
        // also be null because it opened with "---" and never closed
        // (fix round 1: reporting "missing" there would deny a type
        // line sitting in plain sight inside the unterminated block),
        // or frontmatter may parse perfectly well and simply carry no
        // type key at all, the commonest way this rule fires and the
        // one fix round 1's narrower wording accidentally broke by
        // leaving it in the same branch as "no frontmatter at all".
        if (frontmatter === null) {
          if (looksLikeUnterminatedFrontmatter(rawText)) {
            findings.push({
              file,
              line: null,
              message: 'frontmatter opens with "---" but is never closed with a second one, so type cannot be confirmed; close the block',
            });
          } else {
            findings.push({ file, line: null, message: 'type is required but missing (the file has no frontmatter at all)' });
          }
        } else {
          findings.push({ file, line: null, message: 'type is required but missing (this file has frontmatter, but no type key in it)' });
        }
      } else if (value === undefined) {
        findings.push({ file, line, message: 'type is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
      } else if (isBlank(value)) {
        findings.push({ file, line, message: 'type is present but empty; it must be a non-empty string' });
      }
    }
    return findings;
  },
};

// True for a line that is a YAML comment, once trimmed: a "#" is only a
// comment marker when nothing but whitespace comes before it on the
// line, distinct from stripTrailingComment's job inside a VALUE (a "#"
// after other content there starts a trailing comment on that same
// line, which is a different question this rule does not need to ask,
// since it never reads okf_version's own value at all).
function isCommentLine(trimmedLine) {
  return trimmedLine.startsWith('#');
}

// --- index-no-frontmatter (8, 12) -----------------------------------------------
//
// Two checks, two levels, quoted rather than inferred (fix round 3).
// Section 8 states plainly: "Index files contain no frontmatter, with
// one exception: a bundle-root `index.md` MAY carry an `okf_version`
// key." A non-root index carrying any frontmatter is therefore 'must'
// (section 8 plus section 11 clause 3, which makes the reserved
// filenames conformance). What section 8's exception does NOT plainly
// say is whether a key beyond `okf_version` on the root index breaks
// anything: that reading is arguable, and the rule to apply to an
// arguable reading is to claim the lower level, so the root-index extra-
// key check is 'should'.

const indexNoFrontmatter = {
  id: 'index-no-frontmatter',
  section: '8, 12',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (posix.basename(file) !== 'index.md') continue;
      const { frontmatter, hasFrontmatter } = splitFrontmatter(context.readFile(file));
      if (!hasFrontmatter) continue; // no frontmatter at all is fine everywhere, root included

      if (file !== 'index.md') {
        findings.push({
          file,
          line: 1,
          level: 'must',
          message: 'index.md is reserved and must carry no frontmatter (only the root index may declare okf_version)',
        });
        continue;
      }

      // Every non-blank, non-comment line counts, indented or not: a
      // human annotating okf_version with a "#" comment is not declaring
      // anything, so a comment line is exempt (fix round 1), but nothing
      // else is exempt just for being indented (the mirror defect fix
      // round 1 also found: the original counted an indented line as an
      // extra declaration too, since okf_version is a plain scalar with
      // no legitimate continuation of its own, and an EARLIER version of
      // this rule wrongly let any indented line slide on the assumption
      // that it must be a harmless continuation).
      const lines = frontmatter.split('\n');
      const extraIndex = lines.findIndex((line) => {
        const trimmed = line.trim();
        if (trimmed === '') return false;
        if (isCommentLine(trimmed)) return false;
        return !/^okf_version[ \t]*:/.test(trimmed);
      });
      if (extraIndex !== -1) {
        findings.push({
          file,
          line: extraIndex + 2,
          level: 'should',
          message: `the root index may declare only okf_version and nothing else; found "${lines[extraIndex].trim()}"`,
        });
      }
    }
    return findings;
  },
};

// --- log-format (9) -------------------------------------------------------------
//
// Four checks, two levels (fix round 3). Section 9's text, quoted rather
// than inferred, states exactly one requirement: "Date headings MUST use
// ISO 8601 `YYYY-MM-DD` form." Section 9 says nothing about ordering and
// nothing about frontmatter in the log; those checks stay, since they
// are real and useful, but at 'should', the level for a reading the text
// does not plainly support. The date-form check itself splits in two: a
// heading whose text has the shape of an attempt at YYYY-MM-DD (four
// digits, dash, two digits, dash, two digits) but fails the calendar is
// squarely what section 9's MUST is about, since a calendar-impossible
// date is not a real ISO 8601 date under any form, so that is 'must'. A
// heading that does not even have that shape (an arbitrary prose
// heading, "## Notes") is a WIDER claim, that every level-two heading in
// the log ought to be a date at all, which section 9 never states, so
// that is 'should'.
function looksLikeDateAttempt(text) {
  return DATE_PATTERN.test(text);
}

const logFormat = {
  id: 'log-format',
  section: '9',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (posix.basename(file) !== 'log.md') continue;
      const text = context.readFile(file);
      const { hasFrontmatter } = splitFrontmatter(text);
      if (hasFrontmatter) {
        findings.push({ file, line: 1, level: 'should', message: 'log.md is reserved and should carry no frontmatter' });
      }

      const headings = [];
      const lines = withoutFencedBlocks(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^## (.+)$/.exec(lines[i]);
        if (match) headings.push({ text: match[1].trim(), line: i + 1 });
      }

      const dated = [];
      for (const heading of headings) {
        if (isValidIsoDate(heading.text)) {
          dated.push(heading);
        } else if (looksLikeDateAttempt(heading.text)) {
          findings.push({
            file,
            line: heading.line,
            level: 'must',
            message: `log heading "## ${heading.text}" is not a valid ISO 8601 date; section 9 requires the YYYY-MM-DD form`,
          });
        } else {
          findings.push({
            file,
            line: heading.line,
            level: 'should',
            message: `log heading "## ${heading.text}" is not a date`,
          });
        }
      }
      for (let i = 1; i < dated.length; i++) {
        if (dated[i].text > dated[i - 1].text) {
          findings.push({
            file,
            line: dated[i].line,
            level: 'should',
            message: `log dates should run from most recent to oldest; "${dated[i].text}" comes after "${dated[i - 1].text}"`,
          });
        }
      }
    }
    return findings;
  },
};

// --- generated-actor (5.2) -------------------------------------------------------
//
// generated.at, when present, must carry an explicit offset (a bare "Z"
// counts as one). Section 5 of the format states this outright: "Every
// timestamp-valued key in OKF is an ISO 8601 datetime with an explicit
// UTC offset." That is a should-level trust-signal requirement, not a
// house preference quietly promoted to a specification badge, so this
// rule declares it in its own finding message and cites the section,
// rather than leaving it implicit in which regex happened to be reused
// from the original validator's port.

const generatedActor = {
  id: 'generated-actor',
  section: '5.2',
  level: 'should',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const generated = readMapping(frontmatter, 'generated');
      if (generated === null) continue; // absent: this rule only applies when generated is present
      const line = frontmatterKeyLine(frontmatter, 'generated');
      if (generated === undefined) {
        findings.push({ file, line, message: 'generated is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
        continue;
      }
      if (isBlank(generated.by)) {
        findings.push({ file, line, message: 'generated.by is required but missing or empty' });
      }
      if (!isBlank(generated.at) && !isValidIsoDatetimeWithOffset(generated.at)) {
        findings.push({
          file,
          line,
          message: `generated.at "${generated.at}" is not an ISO 8601 datetime with an explicit UTC offset, which section 5 requires for every timestamp-valued key`,
        });
      }
    }
    return findings;
  },
};

// --- verified-events (5.2) -------------------------------------------------------

const verifiedEvents = {
  id: 'verified-events',
  section: '5.2',
  level: 'should',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const events = readVerifiedEvents(frontmatter);
      if (events === null) continue; // absent: this rule only applies when verified is present
      const line = frontmatterKeyLine(frontmatter, 'verified');
      if (events === undefined) {
        findings.push({ file, line, message: 'verified is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
        continue;
      }
      if (events.length === 0) {
        // Present but carrying no events at all (the key is there with
        // nothing indented underneath it): fix round 1 restored this
        // finding, which the original validator also reported as
        // "verified vazio". An empty inline mapping ("verified: {}") is
        // NOT this case: readVerifiedEvents normalises it into a single
        // one-element list instead, which already fails the by/at check
        // below on its own, the same way it did before this round.
        findings.push({ file, line, message: 'verified is present but carries no events; remove the key or add at least one with by and at' });
        continue;
      }
      events.forEach((event, index) => {
        if (isBlank(event.by) || isBlank(event.at)) {
          findings.push({ file, line, message: `verified[${index}] must carry both a non-empty by and a non-empty at` });
        }
      });
    }
    return findings;
  },
};

// --- status-enum (5.4) ------------------------------------------------------------

const statusEnum = {
  id: 'status-enum',
  section: '5.4',
  level: 'should',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const status = readScalar(frontmatter, 'status');
      if (status === null) continue; // absent: this rule only applies when status is present
      const line = frontmatterKeyLine(frontmatter, 'status');
      if (status === undefined) {
        findings.push({ file, line, message: 'status is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
      } else if (!STATUS_ENUM.has(status)) {
        findings.push({ file, line, message: `status "${status}" is not one of draft, stable, deprecated` });
      }
    }
    return findings;
  },
};

// --- stale-after-format (5.5) ------------------------------------------------------
//
// Fix round 2: a plain date used to be accepted here as an alternative to
// a datetime with an offset, on the assumption that narrowing to one
// form was a house-level choice. Reading section 5 directly settled this
// the other way: "Every timestamp-valued key in OKF is an ISO 8601
// datetime with an explicit UTC offset" is the format's own text, with
// no alternative on offer, so a plain date was leniency wearing a
// specification badge, the precise confusion this module exists to
// prevent. stale_after is a timestamp-valued key like any other; a plain
// date is now a finding here, full stop. A vault mid-migration off plain
// dates declares that deviation to the house ruler instead
// (validate.timestamp_deviation, task 5), which downgrades this
// should-level finding to a warning for that vault and can never touch a
// must-level one.

const staleAfterFormat = {
  id: 'stale-after-format',
  section: '5.5',
  level: 'should',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const staleAfter = readScalar(frontmatter, 'stale_after');
      if (staleAfter === null) continue; // absent: this rule only applies when stale_after is present
      const line = frontmatterKeyLine(frontmatter, 'stale_after');
      if (staleAfter === undefined) {
        findings.push({ file, line, message: 'stale_after is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
      } else if (!isValidIsoDatetimeWithOffset(staleAfter)) {
        findings.push({
          file,
          line,
          message: `stale_after "${staleAfter}" must be an ISO 8601 datetime with an explicit UTC offset; section 5 requires this for every timestamp-valued key, so a plain date is no longer accepted here`,
        });
      }
    }
    return findings;
  },
};

// --- sources-resource (5.1) --------------------------------------------------------

const sourcesResource = {
  id: 'sources-resource',
  section: '5.1',
  level: 'should',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const sources = readEntries(frontmatter, 'sources');
      if (sources === null) continue; // absent: this rule only applies when sources is present
      const line = frontmatterKeyLine(frontmatter, 'sources');
      if (sources === undefined) {
        findings.push({ file, line, message: 'sources is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
        continue;
      }
      sources.forEach((entry, index) => {
        if (isBlank(entry.resource)) {
          findings.push({ file, line, message: `sources[${index}] is missing a non-empty resource` });
        }
      });
    }
    return findings;
  },
};

export const SPEC_RULES = Object.freeze([
  typeRequired,
  indexNoFrontmatter,
  logFormat,
  generatedActor,
  verifiedEvents,
  statusEnum,
  staleAfterFormat,
  sourcesResource,
]);

// Runs every rule over `files`, in order, and returns their findings
// flattened into one array, each stamped with `ruler: 'spec'`, the id
// and section carried by the rule that produced it, and a `level`. A
// finding is identified by the PAIR of ruler and id, never by id alone:
// this project's own plan briefly had the house ruler redefine
// stale_after under its own id, before section 5 turned out to fix the
// timestamp form outright and that idea was dropped, so no id currently
// collides across the two rulers, but a rule filtering on id alone
// would still be one rename away from silencing the wrong ruler's
// finding, which is exactly the fragility stamping `ruler` on every
// finding removes.
//
// `level` ('must' or 'should') is a FINDING property, not only a rule
// one (fix round 3): a rule's own `level`, when it has one, is the
// default every one of its findings takes; a finding that sets its own
// `level` (index-no-frontmatter and log-format each emit both must and
// should findings from different checks) overrides that default. A rule
// whose checks disagree simply carries no `level` of its own, so every
// one of its findings is required to set one, with nothing to silently
// fall back to. This lets a consumer group or filter by conformance
// tier without re-deriving it, so a report can put every must-level
// finding ahead of every should-level one instead of treating fifteen
// departures from guidance as fifteen broken bundles. Rules are data
// (SPEC_RULES is a plain array of { id, section, level?, check }), and
// this loop is the entire runner: no rule is special-cased, so a future
// suppression list can name one rule by id without this function ever
// having to change.
export function runSpecRules(files, context) {
  const findings = [];
  for (const rule of SPEC_RULES) {
    for (const partial of rule.check(files, context)) {
      findings.push({
        ruler: 'spec',
        id: rule.id,
        section: rule.section,
        level: partial.level ?? rule.level,
        file: partial.file,
        line: partial.line,
        message: partial.message,
      });
    }
  }
  return findings;
}
