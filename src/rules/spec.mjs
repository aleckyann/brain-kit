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
// off. Every rule object below carries a `level` of 'must' (type-required
// directly from section 11; index-no-frontmatter and log-format through
// it, since section 11 defers to their own sections for the reserved
// filenames) or 'should' (the five trust and lifecycle rules), and every
// finding carries the same level its rule does.
//
// Section 11 also settles two questions this file no longer has to guess
// at. First, quoted here rather than left as an inference: consumers
// "MUST treat a bare `verified` mapping as a one-element list", which is
// exactly what readVerifiedEvents below already did on this project's
// own judgment before the citation existed. Second: consumers "MUST NOT
// reject a concept for an unknown `type` value", which is why
// type-required below checks only that `type` is non-empty and never
// enumerates what it may be; a closed list of allowed types is a house
// rule (frontmatter.type_enum, task 5), and never belongs here.
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
// is not "Z", an offset hour of 0-23 and an offset minute of 0-59 (the
// same bounds a clock's own hour and minute use, since an offset is a
// difference of clock time from UTC, not a separate kind of number).
function isValidIsoDatetimeWithOffset(value) {
  const match = DATETIME_WITH_OFFSET_PATTERN.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, zone] = match;
  if (!isValidCalendarDate(Number(yearStr), Number(monthStr), Number(dayStr))) return false;
  if (!isValidTimeOfDay(Number(hourStr), Number(minuteStr), Number(secondStr))) return false;
  if (zone === 'Z') return true;
  return Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59;
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
function withoutFencedBlocks(text) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
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
function frontmatterKeyLine(frontmatter, key) {
  if (!frontmatter) return null;
  const pattern = new RegExp(`^${key}[ \t]*:`);
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
// Non-empty, never enumerated: section 11 says consumers "MUST NOT reject
// a concept for an unknown type value", so this check stops at "is type
// here and is it non-empty" on purpose. A closed list of allowed types
// belongs to the house ruler's frontmatter.type_enum (task 5), never here.

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
        // frontmatter is null here either because the file never opened
        // one at all, or because it opened one that never closed: those
        // are different claims. Reporting "missing" for the second case
        // would be the exact confident-wrong-finding this whole module
        // exists to avoid, since a type line can be sitting in plain
        // sight inside the unterminated block; readScalar cannot see it
        // either way, once splitFrontmatter itself could not find where
        // the block ends, so this is a shape problem, not an absence.
        if (frontmatter === null && looksLikeUnterminatedFrontmatter(rawText)) {
          findings.push({
            file,
            line: null,
            message: 'frontmatter opens with "---" but is never closed with a second one, so type cannot be confirmed; close the block',
          });
        } else {
          findings.push({ file, line: null, message: 'type is required but missing (the file has no frontmatter at all)' });
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

const indexNoFrontmatter = {
  id: 'index-no-frontmatter',
  section: '8, 12',
  level: 'must',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (posix.basename(file) !== 'index.md') continue;
      const { frontmatter, hasFrontmatter } = splitFrontmatter(context.readFile(file));
      if (!hasFrontmatter) continue; // no frontmatter at all is fine everywhere, root included

      if (file !== 'index.md') {
        findings.push({ file, line: 1, message: 'index.md is reserved and must carry no frontmatter (only the root index may declare okf_version)' });
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
          message: `the root index may declare only okf_version and nothing else; found "${lines[extraIndex].trim()}"`,
        });
      }
    }
    return findings;
  },
};

// --- log-format (9) -------------------------------------------------------------

const logFormat = {
  id: 'log-format',
  section: '9',
  level: 'must',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (posix.basename(file) !== 'log.md') continue;
      const text = context.readFile(file);
      const { hasFrontmatter } = splitFrontmatter(text);
      if (hasFrontmatter) {
        findings.push({ file, line: 1, message: 'log.md is reserved and must carry no frontmatter' });
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
        } else {
          findings.push({ file, line: heading.line, message: `log heading "## ${heading.text}" is not an ISO date (YYYY-MM-DD)` });
        }
      }
      for (let i = 1; i < dated.length; i++) {
        if (dated[i].text > dated[i - 1].text) {
          findings.push({
            file,
            line: dated[i].line,
            message: `log dates must run from most recent to oldest; "${dated[i].text}" comes after "${dated[i - 1].text}"`,
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
// flattened into one array, each stamped with `ruler: 'spec'` plus the
// id, section and level carried by the rule that produced it. A finding
// is identified by the PAIR of ruler and id, never by id alone: this
// project's own plan briefly had the house ruler redefine stale_after
// under its own id, before section 5 turned out to fix the timestamp
// form outright and that idea was dropped, so no id currently collides
// across the two rulers, but a rule filtering on id alone would still be
// one rename away from silencing the wrong ruler's finding, which is
// exactly the fragility stamping `ruler` on every finding removes.
// `level` ('must' or `should`, never computed here, always the rule's
// own) lets a consumer group or filter by conformance tier without
// re-deriving it, so a report can put every must-level finding ahead of
// every should-level one instead of treating fifteen departures from
// guidance as fifteen broken bundles. Rules are data (SPEC_RULES is a
// plain array of { id, section, level, check }), and this loop is the
// entire runner: no rule is special-cased, so a future suppression list
// can name one rule by id without this function ever having to change.
export function runSpecRules(files, context) {
  const findings = [];
  for (const rule of SPEC_RULES) {
    for (const partial of rule.check(files, context)) {
      findings.push({
        ruler: 'spec',
        id: rule.id,
        section: rule.section,
        level: rule.level,
        file: partial.file,
        line: partial.line,
        message: partial.message,
      });
    }
  }
  return findings;
}
