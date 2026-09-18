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
// Two questions this file no longer has to guess at. First, from section
// 11, quoted rather than left as an inference: consumers "MUST treat a
// bare `verified` mapping as a one-element list", a bullet that then
// cross-references section 5.2, where the format says it a second time
// in its own words ("Consumers MUST treat a bare mapping as a
// one-element list"). That is exactly what readVerifiedEvents below
// already did on this project's own judgment before the citation
// existed. Second, on why type-required never enumerates what a `type`
// may be. Fix round 3 cited a section 11
// bullet, one item in the list of what a consumer "MUST NOT reject a
// bundle because of"; fix round 4 replaces it with section 4.1's own
// direct sentence, which is both stronger and about the thing being
// claimed rather than about rejection: "Producers SHOULD pick values
// that are descriptive and self-explanatory; consumers MUST tolerate
// unknown types gracefully, typically by treating them as generic
// concepts." A closed list of allowed types is therefore a house rule
// (frontmatter.type_enum, task 5), and never belongs here.
//
// Section 5, quoted rather than inferred, and from fix round 4 quoted
// WHOLE: earlier rounds cut this sentence short inside its own quotation
// marks, and an unmarked elision is an alteration, particularly in a
// module whose entire argument is that you consult the source before you
// assert. "Every timestamp-valued key in OKF is an ISO 8601 datetime
// with an explicit UTC offset, for example `2026-06-30T14:00:00Z`."
// This binds generated.at and stale_after alike (fix round 2): a house
// rule cannot widen a form the specification itself fixes to one, so
// stale_after no longer accepts a plain date here at all, and a vault
// mid-migration off plain dates declares that deviation to the house
// ruler instead (validate.timestamp_deviation, task 5), which can
// downgrade a `should` finding to a warning and can never touch a `must`.
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
// (reported by the original validator in Portuguese as "verified empty") that this port had silently dropped.
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
// revisiting the other; the offset ceiling on a datetime's UTC offset
// dropped from 23 hours to 14 (but only partly: round 3 wrote the real
// range into this comment and then checked a single unsigned ceiling,
// which fix round 4 had to finish, see below); frontmatterKeyLine now recognises a
// quoted key the same way findKeyLine in src/frontmatter.mjs already
// does, since fix round 1 widened the shared lookup but left this
// module's own line-number helper matching only the bare form, which
// made a quoted key read correctly but report a null line; and
// stripTrailingComment now finds the real closing quote of a quoted
// value before looking for a comment after it, rather than assuming a
// value that opens with a quote never has anything real following it on
// the same line, which is what let a quoted, then commented, scalar
// still misread.
//
// Fix round 4, five corrections, every one of them a correction to a
// claim this project made about the format rather than to code that
// misread a file:
//
// 1. Section 9 DOES state ordering, in the sentence "The format
//    is a flat list of date-grouped entries, newest first:", and section
//    11 clause 3 makes following section 9 a matter of conformance, so
//    the log ordering check is 'must', not 'should'. The claim that the
//    section said nothing about ordering came from reading a window of
//    lines that began one sentence too late; it is removed from this
//    module and from the test file, not softened. (Final review: that
//    sentence is the section's SECOND, not its opening one, which opens
//    "A `log.md` file MAY appear at any level of the hierarchy to record
//    the history of changes to that scope." The quotation was exact and
//    the conclusion right; only the locating claim was wrong, and it is
//    dropped here rather than replaced with another one, since the
//    sentence recording the lesson about reading a section from its own
//    heading should not itself misstate where a sentence sits.)
// 2. The heading levels were backwards. The 'must' branch fired only for
//    a well-formed date that failed the calendar, so "## 2026-5-22" and
//    "## 22/05/2026", the commonest violations of section 9's one real
//    MUST, were graded 'should' with a message that told a person their
//    heading "is not a date" when it plainly was an attempt at one. See
//    log-format below for the three-way split that replaces it.
// 3. Two quotations were truncated inside their own quotation marks
//    while being presented as whole sentences: section 5's closing "for
//    example `2026-06-30T14:00:00Z`" was cut, and so was the trailing
//    cross-reference to section 12 that ends section 8's sentence. An
//    unmarked elision is an alteration. Both are quoted whole now. One
//    substitution is made in every quotation in this file and is
//    declared here rather than made silently: the format writes its
//    cross-references with a section sign, which is not ASCII, and this
//    file is ASCII only, so the sign is spelled out as the word
//    "section" wherever a quotation contains it. Nothing else inside any
//    quotation mark in this module differs from the source text.
// 4. The no-type-enumeration decision now cites section 4.1's direct
//    sentence about tolerating unknown types, not a section 11 bullet
//    about what must not cause a bundle to be rejected.
// 5. The UTC offset range is implemented, not merely described. Round 3
//    wrote "so +14:00 and -12:00 both pass and +15:00 does not" in a
//    comment and then compared a single unsigned ceiling of 14 hours,
//    which accepted +14:59, -13:00 and -14:00. The real range is -12:00
//    to +14:00 and the check is now sign-aware.
//
// Fix round 5, three corrections, none of them a misread file this time
// either:
//
// 1. `check`. A finding now carries a `check` field naming the specific
//    assertion inside its rule, stable and unique within that rule. A
//    rule id was not fine enough: generated-actor emits an actor-presence
//    check and a timestamp-form check under one id, and the house
//    ruler's timestamp deviation step used to select by id alone, so
//    declaring "we have not migrated our timestamps" quietly also
//    downgraded a missing-actor finding that has nothing to do with a
//    timestamp. Every check below is named for what it asserts, not for
//    its rule, and `runSpecRules` stamps it on every finding alongside
//    `id`.
// 2. Fenced, indented and inline code are no longer stripped by a copy
//    of this rule kept independently in this file. They are stripped by
//    src/markdown.mjs, imported here and by the house ruler alike: see
//    that module's own header for why an independent copy is how this
//    exact rule came to be reimplemented, weaker, in src/rules/house.mjs,
//    and never fixed there across three rounds of fixing it here.
//    withoutFencedBlocks and FENCE_LINE are gone from this file; log-format
//    below calls stripCode instead.
// 3. This module quoted section 5 as binding "every timestamp-valued
//    key" and then checked the form of only two of them: generated.at
//    and stale_after. verified[].at was checked for presence and not
//    for form, and sources[].last_modified was not checked at all. A
//    citation that claims more than the code enforces is the same
//    defect as a `must` claimed on a `should`, pointed the other way,
//    so verified-events now validates verified[].at's form the same way
//    generated-actor validates generated.at's, and sources-resource
//    gains a check for sources[].last_modified, when present, on the
//    same terms. Neither field is required to be present (section 5.1
//    and 5.2 require only `resource` and `by`/`at` respectively where
//    this file already required them; `last_modified` is not named as
//    required anywhere), so both new checks, like generated.at's, apply
//    only when the field is present.
//
// Also shared, and no longer duplicated: frontmatterKeyLine now lives in
// src/frontmatter.mjs, exported once and imported here and by the house
// ruler, rather than kept as two copies that had already, separately,
// diverged from each other (see that export's own comment).
//
// Task 8: no rule below builds a finding's user-facing text. Every
// `findings.push` names a `messageKey` (a key into lang/en/messages.json
// and lang/pt-BR/messages.json, both required to carry it, a test in
// test/lang.test.mjs enforces this) and `params` (the values that key's
// placeholders need, always a plain object, `{}` when the key has none).
// src/commands/validate.mjs is the one place that turns a key and its
// params into a sentence, through the translator built from the VAULT's
// own config.lang. Before this task every rule here built an English
// string directly, so a report framed in the vault's chosen language
// printed English findings underneath its own headings; that split is
// also the only reason a stray Portuguese phrase could ever hide in this
// otherwise English-only file, since English prose is not usually where
// anyone looks for one.
import { posix } from 'node:path';
import { DATE_PATTERN, isValidCalendarDate, isValidIsoDate } from '../dates.mjs';
import { frontmatterKeyLine, readEntries, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';

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

// isLeapYear, DAYS_IN_MONTH, isValidCalendarDate and DATE_PATTERN used
// to live here, and a second, independently written copy of all four
// lived in src/rules/house.mjs. They now come from src/dates.mjs, once,
// for the reason that module's own header gives: two calendars that
// must agree in order to be correct are two chances to disagree, and
// only one of the two copies was under test.

function isValidTimeOfDay(hour, minute, second) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

const DATETIME_WITH_OFFSET_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// A datetime with an explicit offset (a bare "Z" counts as one): right
// shape, a calendar-valid date, a clock-valid time, and, when the offset
// is not "Z", an offset inside the range UTC offsets actually occupy.
//
// That range is -12:00 to +14:00, and it is ASYMMETRIC, which is the
// whole of fix round 4's correction here. Fix round 3 wrote the range
// into this comment, in these words, and then implemented a single
// unsigned ceiling of fourteen hours plus a minute bound of 59. Under
// that check -13:00 and -14:00 passed, because their digits are no
// larger than fourteen, and +14:59 passed too, because 14 and 59 are
// each inside their own bound while the offset they make is not inside
// anything. A comment describing the range is not the range being
// checked; this now compares total minutes against the ceiling for the
// offset's OWN sign, so +14:00 and -12:00 pass, and +14:59, +15:00,
// -13:00 and -14:00 all fail.
const MAX_OFFSET_MINUTES_EAST = 14 * 60; // +14:00, the eastern extreme in current use
const MAX_OFFSET_MINUTES_WEST = 12 * 60; // -12:00, the western extreme in current use

function isValidUtcOffset(zone) {
  if (zone === 'Z') return true;
  const sign = zone[0];
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (minutes > 59) return false;
  const total = hours * 60 + minutes;
  return total <= (sign === '-' ? MAX_OFFSET_MINUTES_WEST : MAX_OFFSET_MINUTES_EAST);
}

function isValidIsoDatetimeWithOffset(value) {
  const match = DATETIME_WITH_OFFSET_PATTERN.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, zone] = match;
  if (!isValidCalendarDate(Number(yearStr), Number(monthStr), Number(dayStr))) return false;
  if (!isValidTimeOfDay(Number(hourStr), Number(minuteStr), Number(secondStr))) return false;
  return isValidUtcOffset(zone);
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
// Non-empty, never enumerated. Section 4.1 is the direct authority, and
// fix round 4 moved the citation to it from the section 11 bullet an
// earlier round used: "Producers SHOULD pick values that are descriptive
// and self-explanatory; consumers MUST tolerate unknown types
// gracefully, typically by treating them as generic concepts." That is a
// requirement on a consumer about types themselves, where the section 11
// bullet ("Unknown `type` values", one item in the list of what a
// consumer "MUST NOT reject a bundle because of") only said that an
// unknown type cannot sink a whole bundle. Same conclusion, stronger and
// better-aimed authority: this check stops at "is type here and is it
// non-empty" on purpose, and a closed list of allowed types belongs to
// the house ruler's frontmatter.type_enum (task 5), never here.

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
              check: 'type-present',
              messageKey: 'spec.type_required.unterminated',
              params: {},
            });
          } else {
            findings.push({ file, line: null, check: 'type-present', absence: true, messageKey: 'spec.type_required.no_frontmatter', params: {} });
          }
        } else {
          findings.push({ file, line: null, check: 'type-present', absence: true, messageKey: 'spec.type_required.no_type_key', params: {} });
        }
      } else if (value === undefined) {
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'type' } });
      } else if (isBlank(value)) {
        findings.push({ file, line, check: 'type-non-empty', absence: true, messageKey: 'spec.type_required.empty', params: {} });
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
// Two checks, two levels, quoted rather than inferred (fix round 3),
// and from fix round 4 quoted to the end of the sentence rather than
// stopped one clause short inside the quotation marks. Section 8 states
// plainly: "Index files contain no frontmatter, with one exception: a
// bundle-root `index.md` MAY carry an `okf_version` key (section 12)."
// (The format writes that closing cross-reference with a section sign,
// spelled out here for ASCII, as this file's header declares.)
// A non-root index carrying any frontmatter is therefore 'must'
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
          check: 'no-frontmatter-outside-root',
          messageKey: 'spec.index_no_frontmatter.outside_root',
          params: {},
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
          check: 'root-okf-version-only',
          messageKey: 'spec.index_no_frontmatter.extra_key',
          params: { found: lines[extraIndex].trim() },
        });
      }
    }
    return findings;
  },
};

// --- log-format (9) -------------------------------------------------------------
//
// Four checks, two levels, regraded in fix round 4 against section 9
// read from its own heading rather than from a window of lines.
//
// Section 9 carries two things this rule enforces. The sentence that
// states ordering: "The format is a flat list of date-grouped entries,
// newest first:".
// And its one sentence with a requirement keyword: "Date headings MUST
// use ISO 8601 `YYYY-MM-DD` form." Section 11 clause 3 makes following
// section 9 a matter of conformance ("Every reserved filename
// (`index.md`, `log.md`) follows the structure in section 8 and section
// 9 respectively when present"), so both of those are 'must'. ORDERING
// IN PARTICULAR IS STATED, not merely shown by the example: fix rounds 1
// to 3 graded it 'should' and said in this very comment that the section
// was silent on it, which was false, and the false claim is deleted here
// rather than softened. Section 9 IS silent on frontmatter in the log,
// so that check alone stays 'should'.
//
// The heading check is three-way, and fix round 4 reversed two thirds of
// it. What section 9's MUST is actually about is a DATE HEADING, so:
//
// - A heading that is an attempt at a date but is not in YYYY-MM-DD form
//   ("## 2026-5-22", "## 22/05/2026") is 'must'. These are the commonest
//   violations of the one MUST section 9 has, and earlier rounds graded
//   them 'should' and told the person their heading "is not a date",
//   which is both the wrong level and a message that teaches nothing.
// - A heading in YYYY-MM-DD form naming a day that cannot exist
//   ("## 2026-02-30") is also 'must': a date that cannot exist is not an
//   ISO 8601 date.
// - A heading that is plainly prose rather than any attempt at a date
//   ("## Notes") is 'should'. Reading section 9's MUST as a claim that
//   every level-two heading in a log must be a date is the wider reading
//   the text does not plainly support, and on an arguable reading a
//   validator takes the lower claim.
//
// The three messages say three different things on purpose: a person
// reading "section 9 requires the YYYY-MM-DD form" about a heading whose
// form is already fine learns nothing about what is wrong with it.

// A heading is an ATTEMPT at a date when its whole text is digit groups
// joined by date separators: "2026-5-22", "22/05/2026", "2026.05.22",
// "2026-05-22-1". That is deliberately a narrow test. Anything looser
// (any heading containing a number, say) would promote ordinary prose
// headings to 'must', which is precisely the over-claim this rule's
// levels exist to avoid, and the cost of being narrow is only that a
// heading such as "## 22 May 2026" is reported at 'should' instead of
// 'must', which is the safe direction to be wrong in.
const DATE_ATTEMPT_PATTERN = /^[0-9]+(?:[-/.][0-9]+)+$/;

function looksLikeDateAttempt(text) {
  return DATE_ATTEMPT_PATTERN.test(text);
}

// The narrower question, asked only of a heading that is already an
// attempt: is it in YYYY-MM-DD form, so that any remaining problem is
// the calendar rather than the form?
function hasIsoDateForm(text) {
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
        findings.push({ file, line: 1, level: 'should', check: 'no-frontmatter', messageKey: 'spec.log_format.has_frontmatter', params: {} });
      }

      const headings = [];
      const lines = stripCode(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^## (.+)$/.exec(lines[i]);
        if (match) headings.push({ text: match[1].trim(), line: i + 1 });
      }

      const dated = [];
      for (const heading of headings) {
        if (isValidIsoDate(heading.text)) {
          dated.push(heading);
        } else if (hasIsoDateForm(heading.text)) {
          findings.push({
            file,
            line: heading.line,
            level: 'must',
            check: 'heading-calendar',
            messageKey: 'spec.log_format.heading_calendar',
            params: { heading: heading.text },
          });
        } else if (looksLikeDateAttempt(heading.text)) {
          findings.push({
            file,
            line: heading.line,
            level: 'must',
            check: 'heading-form',
            messageKey: 'spec.log_format.heading_form',
            params: { heading: heading.text },
          });
        } else {
          findings.push({
            file,
            line: heading.line,
            level: 'should',
            check: 'heading-not-a-date',
            messageKey: 'spec.log_format.heading_not_a_date',
            params: { heading: heading.text },
          });
        }
      }
      for (let i = 1; i < dated.length; i++) {
        if (dated[i].text > dated[i - 1].text) {
          findings.push({
            file,
            line: dated[i].line,
            level: 'must',
            check: 'ordering',
            messageKey: 'spec.log_format.ordering',
            params: { date: dated[i].text, previous: dated[i - 1].text },
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
// counts as one). Section 5 of the format states this outright, quoted
// whole: "Every timestamp-valued key in OKF is an ISO 8601 datetime with
// an explicit UTC offset, for example `2026-06-30T14:00:00Z`." That is a
// should-level trust-signal requirement, not a
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
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'generated' } });
        continue;
      }
      if (isBlank(generated.by)) {
        findings.push({ file, line, check: 'actor-present', absence: true, messageKey: 'spec.generated_actor.missing_actor', params: {} });
      }
      if (!isBlank(generated.at) && !isValidIsoDatetimeWithOffset(generated.at)) {
        findings.push({
          file,
          line,
          check: 'timestamp-form',
          deviationEligible: true,
          messageKey: 'common.timestamp_form',
          params: { field: 'generated.at', value: generated.at },
        });
      }
    }
    return findings;
  },
};

// --- verified-events (5.2) -------------------------------------------------------
//
// Fix round 5: verified[].at used to be checked only for presence, the
// same way verified[].by is, even though it is exactly as timestamp-
// valued as generated.at, which this file already validates for FORM
// and not merely presence. This module quotes section 5 as binding
// "every timestamp-valued key"; checking one of them for presence alone
// while quoting a sentence that promises form for all of them is the
// same defect as a `must` claimed on a `should`, pointed the other way.
// event-actor (by) and event-timestamp-form (at) are now two separate
// checks, not one combined message, for the same reason generated-actor
// already keeps actor-present and timestamp-form apart: a downstream
// step that selects by check (the house ruler's timestamp deviation,
// task 5) must be able to touch the timestamp-shaped failure without
// also touching the actor-shaped one.
//
// Fix round 2: that split was not fine enough either, and put the same
// defect back one level down. event-timestamp-form used to name BOTH
// "at is missing" (a presence assertion, exactly like event-actor) and
// "at is malformed" (the actual form assertion), so a vault declaring
// validate.timestamp_deviation still had a required-but-missing at
// downgraded to a mere warning, which is precisely the "a downgrade may
// never reach a finding about something being ABSENT" invariant this
// field exists to protect. event-timestamp-present (below) is the
// presence half; event-timestamp-form is now the form half alone, and
// only the form half is eligible for the house ruler's downgrade.

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
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'verified' } });
        continue;
      }
      if (events.length === 0) {
        // Present but carrying no events at all (the key is there with
        // nothing indented underneath it): fix round 1 restored this
        // finding, which the original validator also reported as
        // its own Portuguese "verified empty" message. An empty inline mapping ("verified: {}") is
        // NOT this case: readVerifiedEvents normalises it into a single
        // one-element list instead, which already fails the by/at check
        // below on its own, the same way it did before this round.
        findings.push({ file, line, check: 'has-events', absence: true, messageKey: 'spec.verified_events.empty', params: {} });
        continue;
      }
      events.forEach((event, index) => {
        if (isBlank(event.by)) {
          findings.push({ file, line, check: 'event-actor', absence: true, messageKey: 'spec.verified_events.missing_actor', params: { index } });
        }
        if (isBlank(event.at)) {
          findings.push({ file, line, check: 'event-timestamp-present', absence: true, messageKey: 'spec.verified_events.missing_timestamp', params: { index } });
        } else if (!isValidIsoDatetimeWithOffset(event.at)) {
          findings.push({
            file,
            line,
            check: 'event-timestamp-form',
            deviationEligible: true,
            messageKey: 'common.timestamp_form',
            params: { field: `verified[${index}].at`, value: event.at },
          });
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
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'status' } });
      } else if (!STATUS_ENUM.has(status)) {
        findings.push({ file, line, check: 'status-enum', messageKey: 'spec.status_enum.invalid', params: { value: status } });
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
// datetime with an explicit UTC offset, for example
// `2026-06-30T14:00:00Z`." is the format's own text, quoted whole since
// fix round 4, with no alternative on offer, so a plain date was
// leniency wearing a specification badge, the precise confusion this
// module exists to prevent. stale_after is a timestamp-valued key like
// any other; a plain date is now a finding here, full stop. A vault
// mid-migration off plain dates declares that deviation to the house
// ruler instead (validate.timestamp_deviation, task 5), which downgrades
// this should-level finding to a warning for that vault and can never
// touch a must-level one.

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
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'stale_after' } });
      } else if (!isValidIsoDatetimeWithOffset(staleAfter)) {
        findings.push({
          file,
          line,
          check: 'timestamp-form',
          deviationEligible: true,
          messageKey: 'spec.stale_after_format.invalid',
          params: { value: staleAfter },
        });
      }
    }
    return findings;
  },
};

// --- sources-resource (5.1) --------------------------------------------------------
//
// Fix round 5: sources[].last_modified is exactly as timestamp-valued as
// generated.at or stale_after, and this rule never checked it at all,
// against the same section 5 sentence the whole file quotes as binding
// "every" such key. Checked now, on the same "when present" terms as
// generated.at (section 5.1 requires only a non-empty `resource`;
// `last_modified` is not named as required anywhere, so its absence is
// not itself a finding, only its form when it is there).

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
        findings.push({ file, line, check: 'shape-readable', unreadable: true, messageKey: 'common.shape_unreadable', params: { field: 'sources' } });
        continue;
      }
      sources.forEach((entry, index) => {
        if (isBlank(entry.resource)) {
          findings.push({ file, line, check: 'entry-resource', absence: true, messageKey: 'spec.sources_resource.missing_resource', params: { index } });
        }
        if (!isBlank(entry.last_modified) && !isValidIsoDatetimeWithOffset(entry.last_modified)) {
          findings.push({
            file,
            line,
            check: 'entry-timestamp-form',
            deviationEligible: true,
            messageKey: 'common.timestamp_form',
            params: { field: `sources[${index}].last_modified`, value: entry.last_modified },
          });
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
// and section carried by the rule that produced it, a `level`, and,
// since fix round 5, a `check`. A finding is identified by the TRIPLE of
// ruler, id and check, never by id alone: this project's own plan
// briefly had the house ruler redefine stale_after under its own id,
// before section 5 turned out to fix the timestamp form outright and
// that idea was dropped, so no id currently collides across the two
// rulers, but a rule filtering on id alone would still be one rename
// away from silencing the wrong ruler's finding, AND one rule id alone
// is not fine enough even within this ruler: generated-actor's
// actor-present and timestamp-form checks share an id but mean two
// different things, which is exactly why a downstream step (the house
// ruler's timestamp deviation, task 5) must select by `check`, not `id`.
//
// `check` is a stable English name for the specific assertion inside a
// rule, always set by the rule itself (every `findings.push` above names
// one), never defaulted or derived here: unlike `level`, which a rule
// may leave to its own single value when every check it emits agrees,
// `check` always differs from one assertion to the next within a rule
// that has more than one, so there is no single default worth falling
// back to.
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
      const unreadable = partial.unreadable === true;
      findings.push({
        ruler: 'spec',
        id: rule.id,
        check: partial.check,
        section: rule.section,
        // A finding that says only "this value's shape could not be read"
        // is NEVER a conformance claim, whatever tier the rule that
        // raised it carries. type-required is a `must` rule, and a legal
        // YAML folded scalar ("type: >" with the value indented beneath)
        // is a shape src/frontmatter.mjs's regular-expression readers
        // cannot see, so the honest finding "type is present but its
        // shape could not be read" used to inherit `must` and print the
        // report's harshest line: the bundle is not conformant to the
        // Open Knowledge Format. The tool contradicted itself on one
        // screen, saying in the verdict that the bundle fails the format
        // and in the finding underneath it that it had not managed to
        // look.
        //
        // The two-absences contract every rule above honours is exactly
        // this distinction, and it died in the last inch, between the
        // ruler and the reader. 'should' is the floor the plan already
        // set for a reading the format's text does not plainly support:
        // "we could not read it" is not an arguable reading, it is no
        // reading at all, and it must not be claimed at the higher tier.
        // The `unreadable` flag travels with the finding so a consumer
        // (and --json) can tell this apart from a real guidance
        // departure.
        level: unreadable ? 'should' : (partial.level ?? rule.level),
        unreadable,
        absence: partial.absence === true,
        deviationEligible: partial.deviationEligible === true,
        file: partial.file,
        line: partial.line,
        messageKey: partial.messageKey,
        params: partial.params,
      });
    }
  }
  return findings;
}
