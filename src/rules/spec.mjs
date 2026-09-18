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
import { posix } from 'node:path';
import { readEntries, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const STATUS_ENUM = new Set(['draft', 'stable', 'deprecated']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
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
// know which spelling a given note chose.
function readVerifiedEvents(frontmatter) {
  const asEntries = readEntries(frontmatter, 'verified');
  if (asEntries === null) return null;
  if (Array.isArray(asEntries)) return asEntries;
  const asMapping = readMapping(frontmatter, 'verified');
  if (asMapping === null || asMapping === undefined) return asMapping;
  return [asMapping];
}

// --- type-required (4.1) -------------------------------------------------------

const typeRequired = {
  id: 'type-required',
  section: '4.1',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const value = readScalar(frontmatter, 'type');
      const line = frontmatterKeyLine(frontmatter, 'type');
      if (value === null) {
        findings.push({ file, line: null, message: 'type is required but missing (the file has no frontmatter, or none carries this key)' });
      } else if (value === undefined) {
        findings.push({ file, line, message: 'type is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
      } else if (isBlank(value)) {
        findings.push({ file, line, message: 'type is present but empty; it must be a non-empty string' });
      }
    }
    return findings;
  },
};

// --- index-no-frontmatter (8/12) -----------------------------------------------

const indexNoFrontmatter = {
  id: 'index-no-frontmatter',
  section: '8/12',
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

      const lines = frontmatter.split('\n');
      const extraIndex = lines.findIndex((line) => line.trim() !== '' && !/^[ \t]/.test(line) && !/^okf_version[ \t]*:/.test(line));
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
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^## (.+)$/.exec(lines[i]);
        if (match) headings.push({ text: match[1].trim(), line: i + 1 });
      }

      const dated = [];
      for (const heading of headings) {
        if (ISO_DATE.test(heading.text)) {
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

const generatedActor = {
  id: 'generated-actor',
  section: '5.2',
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
      if (!isBlank(generated.at) && !ISO_DATETIME_WITH_OFFSET.test(generated.at)) {
        findings.push({ file, line, message: `generated.at "${generated.at}" is not an ISO 8601 datetime with an offset` });
      }
    }
    return findings;
  },
};

// --- verified-events (5.2) -------------------------------------------------------

const verifiedEvents = {
  id: 'verified-events',
  section: '5.2',
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

const staleAfterFormat = {
  id: 'stale-after-format',
  section: '5.5',
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
      } else if (!ISO_DATE.test(staleAfter) && !ISO_DATETIME_WITH_OFFSET.test(staleAfter)) {
        findings.push({
          file,
          line,
          message: `stale_after "${staleAfter}" must be either a date (YYYY-MM-DD) or a datetime with an offset; both are accepted here, and narrowing to one is a house rule, not a spec rule`,
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
// id and section carried by the rule that produced it. A finding is
// identified by the PAIR of ruler and id, never by id alone: the house
// ruler defines its own stale-after-format, on purpose, for the same
// field under a stricter, vault-chosen setting, and a consumer that
// filtered on id alone would silence both rulers' versions of that rule
// at once. Rules are data (SPEC_RULES is a plain array of { id, section,
// check }), and this loop is the entire runner: no rule is special-cased,
// so a future suppression list can name one rule by id without this
// function ever having to change.
export function runSpecRules(files, context) {
  const findings = [];
  for (const rule of SPEC_RULES) {
    for (const partial of rule.check(files, context)) {
      findings.push({ ruler: 'spec', id: rule.id, section: rule.section, file: partial.file, line: partial.line, message: partial.message });
    }
  }
  return findings;
}
