// The house ruler: a single vault's OWN style, as opposed to the Open
// Knowledge Format itself (src/rules/spec.mjs, this module's sibling and
// the shape it mirrors: rules as data objects that one runner iterates,
// never a chain of conditionals). Every setting a rule below reads comes
// from context.config; none is hard-coded, and every default is the
// permissive one, so a vault that configures nothing gets the
// specification (spec.mjs) and very little else from this file.
//
// Why house findings carry no `level` and no `section`: `must` and
// `should` are the format's own two conformance tiers, read from its
// section 11 (see spec.mjs's own header). A vault's own preference
// belongs to neither tier, and stamping one on it would be a house rule
// wearing a specification badge, which is the exact confusion this
// module exists to prevent. `ruler`, `id` and `check` are the whole
// identity of a finding here: no level to sort by, no section to cite.
// A consumer combining both rulers' output sees three groups in order:
// specification `must`, specification `should`, and house, never four,
// and never a house finding mistaken for either specification tier.
//
// The ruler contract (identical for the spec ruler and the validate
// command that will call both): this module never calls walkVault.
// `check(files, context)` receives `files` (the sorted, root-relative,
// forward-slash markdown subset of one walk) and `context` (`{ root,
// config, all, readFile }`, where `all` is the full walk as a Set and
// `readFile` already stripped a leading byte-order mark and normalised
// line endings for every reader alike). `link-target-exists` below is
// the only rule that reads `context.all`, and resolving a link is the
// only reason this ruler needs the full, unfiltered walk at all.
//
// The reader's two absences, binding here exactly as they bind in
// spec.mjs: null means a key is ABSENT (a required-field rule reports a
// missing field); undefined means the key is PRESENT but written in a
// shape src/frontmatter.mjs's regular-expression readers cannot see, and
// must never be reported as missing, since the field is plainly on a
// human's screen. Every rule below that classifies a field's presence
// distinguishes the two explicitly, naming PARSER_LIMITS for the second
// case rather than folding it into "missing".
//
// Fix round 1 (review of commit d0bc6b4), the shape of every correction
// worth stating up front rather than only where its diff lands:
//
// 1. Fenced, indented and inline code are no longer stripped by a copy
//    of this rule kept in this file. That copy was reviewed and found
//    to disagree with the specification ruler's own fence handling in
//    exactly the way that matters most: it trimmed a line before
//    testing it for a fence marker, so a fence-shaped line at ANY
//    indentation opened a fence, including one sitting inside a
//    four-space indented block that was only there to document how to
//    write a fence. That phantom fence never closed and blanked every
//    remaining line of the file, including a genuinely broken link far
//    below it, which then went unreported. spec.mjs had already been
//    fixed for this exact shape of bug twice, and neither fix ever
//    reached this file, because there was no shared code for a fix to
//    reach: two independent implementations of one rule are two chances
//    to disagree about what a fence is, and disagreeing about that is
//    the same class of defect as two walks disagreeing about what a
//    vault contains (src/vault.mjs's own header). Both rulers now
//    import stripCode from src/markdown.mjs, once, including its new
//    handling of a fence quoted inside a blockquote: `> ` `` ``` ``
//    is still code, and a link that only exists as an example inside
//    one is no longer reported as broken.
// 2. `frontmatterKeyLine` is no longer a copy kept in this file either.
//    The copy here built a RegExp from a config-supplied field name
//    (frontmatter.required, .forbidden, or an extensions key) without
//    escaping it, which threw a SyntaxError for a forbidden field named
//    with a parenthesis and would have taken the whole ruler down; a
//    comment 190 lines below in this same file already named exactly
//    this hazard for `placeholderRegex` and called itself the one place
//    it could happen, which was not true while this second, unguarded
//    site existed. The copy here had also dropped the quoted-key
//    alternative the sibling's own copy recognised, so a quoted key
//    reported a real line there and null here, as if absent. Both bugs
//    are gone by construction now that src/frontmatter.mjs exports one
//    frontmatterKeyLine, built on the same escaped, quote-aware lookup
//    every reader in that file already shares.
// 3. `check`. A finding now carries a `check` field naming the specific
//    assertion inside its rule, stable and unique within that rule (see
//    the field's own explanation on runHouseRules below). `applyTimestampDeviation`
//    used to select by `id` alone, and generated-actor (the spec ruler's
//    rule this function reads) carries an actor-presence check and a
//    timestamp-form check under that one id, so declaring "we have not
//    migrated our timestamps" quietly also downgraded a missing-actor
//    finding that has nothing to do with a timestamp. It now selects by
//    the (id, check) pair.
// 4. `classifyField` answered "present and non-empty" wrong for an
//    explicitly empty INLINE collection: "tags: []" and "description: {}"
//    read back from readScalar as the literal strings "[]" and "{}",
//    both non-blank, so the collection-aware branches below (which read
//    the real, structured answer) were never reached for that shape. A
//    vault requiring a field was told nothing was wrong when a note
//    supplied it empty. Fixed by asking a collection reader whenever the
//    scalar looks like one, inline or block alike, rather than trusting
//    a non-blank string on sight.
// 5. The link scanner used to find a target's closing parenthesis at the
//    first ")" character, so a target containing one of its own
//    ("real(1).md") was reported under a truncated, garbled name rather
//    than either resolved or declined. It used to find a link's own
//    text at the first "]" character too, so bracketed link text
//    ("[text [br]](url)") was never recognised as a link at all. Both
//    are now found by BALANCED matching (the same technique
//    src/frontmatter.mjs's own findMatchingClose uses for an inline
//    mapping or list), which also changes what a link nested inside
//    another link's text resolves to: see scanLinksInLine's own comment
//    for the trade-off this makes on purpose, and the module's declared
//    trade-offs below for what is still declined rather than handled.
//
// Fix round 2 (review of commit fc951b4), five more corrections:
//
// 1. Fenced-code handling grew a real MODEL instead of a fourth patched
//    case: see src/markdown.mjs's own header for "a fence belongs to
//    the container that opened it", the sentence that replaces three
//    rounds of case-by-case fixes here and there.
// 2. `applyTimestampDeviation` selected by the (id, check) pair, and
//    one round later `verified-events` still drew a single check name,
//    `event-timestamp-form`, around both "at is missing" and "at is
//    malformed", which put the original id-only defect back one level
//    down under a declared deviation. Split into `event-timestamp-present`
//    (presence, never eligible) and `event-timestamp-form` (form,
//    eligible), and the underlying invariant, "a downgrade may never
//    reach a finding about something being ABSENT", is now also
//    asserted directly in the tests, end to end through the real
//    specification ruler, without ever reading a check's name, so a
//    future check name cannot reintroduce this by being drawn too
//    coarsely again.
// 3. `classifyField`'s round-1 fix guessed a value was an inline
//    collection from the SHAPE of readScalar's own, already-unquoted
//    answer, which could not tell a real "[a, b]" from a quoted string
//    that merely reads back looking like one once its quotes are gone.
//    It now asks readList/readMapping first, unconditionally, which
//    look at the value's own raw, still-quoted head and correctly
//    decline a quoted string instead of guessing it is unreadable.
// 4. `link-style` judged `isAbsolute` against the decoded, query-
//    stripped path but quoted only the raw target in its message, so a
//    percent-encoded leading slash could be reported as "starts with a
//    slash" while the quoted evidence did not show one. Both are named
//    now whenever they differ.
// 5. Two link shapes this module's own header once left in the
//    unresolved middle (neither handled nor declared) are resolved:
//    see the declared trade-offs below for a backslash-escaped bracket
//    in link text and a raw space in a bare destination, both handled
//    now, and for the reference-style-link test that used to argue a
//    declined feature has no contrasting positive, which was wrong: the
//    contrast is one ordinary link to the same nonexistent target in
//    the same fixture, exactly the pairing this file already applies
//    everywhere else.
//
// Two behaviours a naive port of the original validator got wrong, and
// this module is built to get right on purpose:
//
// 1. The placeholder exemption (validate.placeholder_pattern) applies
//    ONLY to files under taxonomy.templates_dir, and only inside
//    extension-fields' own kind check (the one place a "dated field"
//    lives in this table). The original validator excused any value
//    containing "<" everywhere in the tree; spec.mjs's own header
//    explains why that defect is not ported there. It is not ported
//    here either in its old shape: a note outside templates_dir with a
//    placeholder-looking value is a normal finding, full stop.
//
// 2. Code, fenced and inline, is blanked out of the body before this
//    module reads a single link or wikilink out of it (src/markdown.mjs,
//    see fix round 1 item 1 above).
//
// Declared trade-offs of the link scanner, honest rather than silent
// about what it does not do:
//
// - A query string ("real.md?v=1") is stripped, and a percent-escaped
//   path ("real%20file.md") is decoded, before a target is checked for
//   existence: both are HANDLED, since both used to produce a confident
//   WRONG finding on a link that was not actually broken. A malformed
//   percent-escape is declined gracefully (the raw text is kept) rather
//   than thrown.
// - A target containing balanced parentheses, and link text containing
//   balanced brackets, are HANDLED (fix round 1 item 5 above).
// - A backslash-escaped bracket inside link text ("[a \] b](url)") is
//   HANDLED (fix round 2): findBalancedClose skips the character right
//   after any backslash, so an escaped "]" or "(" is never mistaken for
//   real structure. Before this, an escaped bracket made the whole
//   link invisible rather than merely mis-read.
// - A bare (non-"<...>"-wrapped) destination containing a raw,
//   unescaped space ("[x](my file.md)") is HANDLED by recognising it is
//   not a valid link destination at all in this markup, and producing
//   no finding for it, right or wrong (fix round 2): CommonMark
//   requires such a destination to be angle-bracket-wrapped or to
//   escape the space, and this reader recognises neither convention as
//   ever legitimising a raw space in a bare destination.
// - A link nested inside another link's text (an image inside a link,
//   "[![alt](img.png)](outer.md)") is read as ONE link, the OUTER one,
//   once balanced matching is in place: the inner image's own brackets
//   nest correctly inside the outer pair, so the outer target is now
//   found, where it used to be invisible. The inner image's own target
//   is, in exchange, no longer independently checked: it is now part of
//   the outer link's TEXT, not a link of its own. This is a DECLINED
//   case, not a silent gap: only the outer target is ever checked for a
//   genuinely nested pair.
// - A reference-style link ("[text][ref]" plus a separate "[ref]: target"
//   definition elsewhere in the file) is DECLINED outright: resolving it
//   needs a second pass over the whole file to collect every definition
//   before a single usage can be read, which is a materially bigger
//   feature than balancing two kinds of bracket on one line, and this
//   ruler produces no finding, wrong or otherwise, for one.
//
// timestamp-deviation is the one entry in HOUSE_RULES that is not shaped
// like the other eight, and it is worth saying why up front rather than
// leaving it as a silent inconsistency: every other rule here scans
// `files` for something inside THIS ruler's own remit. Downgrading a
// specification `should`-level timestamp finding to a warning is, by
// definition, an operation on the SPEC ruler's own output, which this
// rule's `check(files, context)` never receives (only the caller that
// holds both rulers' results, src/commands/validate.mjs, is in a
// position to combine them). So this rule's check always returns no
// findings of its own; it exists in the catalog so the setting it names
// is listed with the other eight, not hidden as a special case validate.mjs
// reads on its own. The actual transformation is applyTimestampDeviation,
// exported below, next to the one place that already knows what
// "forbid" and "allow" mean for this setting.
//
// Task 8: same contract as spec.mjs's own header describes. No rule
// below builds user-facing text; every `findings.push` names a
// `messageKey` (present in both lang/en/messages.json and
// lang/pt-BR/messages.json) and `params`, and src/commands/validate.mjs
// is the only place that renders them, through the vault's own
// config.lang.
import { posix } from 'node:path';
import { frontmatterKeyLine, readEntries, readList, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Classifies a value already known to be a collection (an array from
// readList, or a plain object from readMapping/readEntries) as 'blank'
// when it has nothing in it, or 'present' otherwise. `undefined` means
// the shape-aware reader declined too (PARSER_LIMITS): this happens for
// an inline collection whose scalar text merely LOOKS like one
// ("tags: [a, b" with no closing bracket) but is not actually readable
// as one, and reporting that as blank would be exactly the confident
// wrong answer classifyField exists to avoid.
function classifyCollection(value) {
  if (value === undefined) return { state: 'unreadable' };
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  return { state: size === 0 ? 'blank' : 'present' };
}

// Classifies a named field's presence across every shape the format's
// frontmatter can take, not only a plain scalar: a required or forbidden
// field named by a vault's own config might be `description` (a scalar)
// or `generated` (a mapping) alike, and this rule table has no way to
// know in advance which shape a given field name will use.
//
// readScalar alone already answers "present or absent" correctly for
// every shape: findKeyLine (inside every reader in src/frontmatter.mjs)
// matches the same key text at the same column-0 anchor regardless of
// what follows it, so readScalar returns null only when the key never
// appears at all, and returns a string OR undefined (never null) for a
// key that is there in ANY shape, scalar or not.
//
// Fix round 1: an inline collection reads back from readScalar as a
// perfectly ordinary, non-blank STRING ("tags: []" reads as the string
// "[]"), so trusting readScalar's own non-blankness answered "present
// and non-empty" for a field a vault owner had actually left empty.
//
// Fix round 2: the first attempt at that fix guessed from the shape of
// readScalar's own, already-UNQUOTED answer ("does the string start
// with '['"), which cannot tell a real flow collection apart from an
// ordinary QUOTED string that merely looks like one once its quotes are
// gone: "tags: \"[a, b]\"" reads back from readScalar as the string
// "[a, b]" too, indistinguishable at that point from a real list, so it
// was reported against PARSER_LIMITS as unreadable even though
// readScalar had read it perfectly well. The fix is to ask the
// collection-aware readers FIRST, unconditionally, rather than guess
// from readScalar's text at all: readList and readMapping look at the
// value's own RAW head, quotes and all, and return a real array or
// object only for genuine "[...]"/"{...}" syntax, undefined for
// anything else, including a quoted string that starts with one of
// those characters only after its quotes are stripped. An ordinary
// scalar (quoted or not) therefore always leaves both of them
// undefined and falls through to the plain-string branch unchanged.
function classifyField(frontmatter, key) {
  const scalar = readScalar(frontmatter, key);
  if (scalar === null) return { state: 'absent' };

  const mapping = readMapping(frontmatter, key);
  if (mapping !== null && mapping !== undefined) return classifyCollection(mapping);
  const list = readList(frontmatter, key);
  if (list !== null && list !== undefined) return classifyCollection(list);

  if (typeof scalar === 'string') return { state: scalar.trim() === '' ? 'blank' : 'present' };

  // scalar === undefined and neither flow-collection reader recognised
  // the shape either: try readEntries for the one remaining collection
  // shape (a block list of mappings, "sources" being the real
  // example), then give up honestly. None of the three readers can
  // return null here (the key is already known to exist via readScalar
  // above), so a null is treated the same as undefined, defensively,
  // rather than trusted never to happen.
  const entries = readEntries(frontmatter, key);
  if (entries !== null && entries !== undefined) return classifyCollection(entries);
  return { state: 'unreadable' };
}

// True when `file` (root-relative, forward-slash) lies at or under `dir`
// (a taxonomy.* config path, also root-relative). A path boundary, not a
// raw string prefix, mirroring src/vault.mjs's own matchesIgnorePrefix
// (also not exported): "templates" matches "templates/x.md" but not
// "templates-2024/x.md".
function isUnderDir(file, dir) {
  if (!dir) return false;
  const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  if (normalized === '') return false;
  return file === normalized || file.startsWith(`${normalized}/`);
}

// --- required-fields (frontmatter.required) -------------------------------------

const requiredFields = {
  id: 'required-fields',
  check(files, context) {
    const required = context.config?.frontmatter?.required ?? [];
    if (required.length === 0) return [];
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      for (const key of required) {
        const { state } = classifyField(frontmatter, key);
        if (state === 'absent') {
          findings.push({ file, line: null, check: 'field-present', messageKey: 'house.required_fields.missing', params: { key } });
        } else if (state === 'blank') {
          findings.push({
            file,
            line: frontmatterKeyLine(frontmatter, key),
            check: 'field-non-empty',
            messageKey: 'house.required_fields.empty',
            params: { key },
          });
        } else if (state === 'unreadable') {
          findings.push({
            file,
            line: frontmatterKeyLine(frontmatter, key),
            check: 'shape-readable',
            messageKey: 'common.shape_unreadable',
            params: { field: key },
          });
        }
      }
    }
    return findings;
  },
};

// --- forbidden-fields (frontmatter.forbidden) ------------------------------------

const forbiddenFields = {
  id: 'forbidden-fields',
  check(files, context) {
    const forbidden = context.config?.frontmatter?.forbidden ?? [];
    if (forbidden.length === 0) return [];
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      for (const key of forbidden) {
        const { state } = classifyField(frontmatter, key);
        if (state === 'absent') continue;
        // Present is present, whatever shape it is in: an unreadable
        // shape still means the key is there (see classifyField above),
        // and this rule's whole question is presence, not readability,
        // so it is not reported against PARSER_LIMITS the way a rule
        // that needs the VALUE would.
        findings.push({
          file,
          line: frontmatterKeyLine(frontmatter, key),
          check: 'field-forbidden',
          messageKey: 'house.forbidden_fields.present',
          params: { key },
        });
      }
    }
    return findings;
  },
};

// --- type-enum (frontmatter.type_enum) -------------------------------------------
//
// When the list is non-null, `type` must be one of its values. An absent
// or blank type is left alone here on purpose: those are type-required's
// own findings (spec.mjs), and reporting them a second time under a
// different ruler would make one real problem look like two.

const typeEnum = {
  id: 'type-enum',
  check(files, context) {
    const allowed = context.config?.frontmatter?.type_enum ?? null;
    if (allowed === null) return [];
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      const value = readScalar(frontmatter, 'type');
      if (value === null) continue; // absence is type-required's finding, not this one's
      const line = frontmatterKeyLine(frontmatter, 'type');
      if (value === undefined) {
        findings.push({ file, line, check: 'shape-readable', messageKey: 'common.shape_unreadable', params: { field: 'type' } });
        continue;
      }
      if (isBlank(value)) continue; // an empty type is type-required's finding, not this one's
      if (!allowed.includes(value)) {
        findings.push({ file, line, check: 'type-allowed', messageKey: 'house.type_enum.invalid', params: { value, allowed } });
      }
    }
    return findings;
  },
};

// --- extension-fields (frontmatter.extensions) -----------------------------------

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidCalendarDateValue(value) {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function isValidBooleanValue(value) {
  return value === 'true' || value === 'false';
}

function isValidNumberValue(value) {
  return /^-?\d+(\.\d+)?$/.test(value);
}

// The allowed values for an enum-typed extension field, given the note's
// own `type`. values_by_type takes priority (the per-type form the brief
// requires): a type with no entry there has no configured list at all,
// which is treated as "nothing to check against" rather than "reject
// everything", matching the permissive-default philosophy every other
// rule here follows. Falls back to the flat `values` list when
// values_by_type is not declared for this field at all.
function allowedEnumValues(spec, noteType) {
  if (spec.values_by_type) return spec.values_by_type[noteType] ?? null;
  return spec.values ?? null;
}

// A malformed validate.placeholder_pattern (a vault owner's own typo in
// a regular expression) must never crash this rule: RegExp construction
// from config text is guarded here. (Fix round 1: this used to be the
// only site in this file making that claim about itself; it was not,
// since frontmatterKeyLine also built a RegExp from config text,
// unguarded and unescaped. That copy is gone now, sharing the escaped,
// shared export from src/frontmatter.mjs instead, so this really is the
// only remaining site that can throw on config content rather than file
// content.) Returning null (no exemption ever matches) is the same
// answer as "no pattern configured at all".
function placeholderRegex(config) {
  const pattern = config?.validate?.placeholder_pattern;
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const extensionFields = {
  id: 'extension-fields',
  check(files, context) {
    const extensions = context.config?.frontmatter?.extensions ?? {};
    const fieldNames = Object.keys(extensions);
    if (fieldNames.length === 0) return [];
    const templatesDir = context.config?.taxonomy?.templates_dir;
    const placeholder = placeholderRegex(context.config);
    const findings = [];
    for (const file of files) {
      if (isReserved(file)) continue;
      const { frontmatter } = splitFrontmatter(context.readFile(file));
      for (const fieldName of fieldNames) {
        const spec = extensions[fieldName];
        const value = readScalar(frontmatter, fieldName);
        if (value === null) continue; // this rule only applies when the field is present
        const line = frontmatterKeyLine(frontmatter, fieldName);
        if (value === undefined) {
          findings.push({
            file,
            line,
            check: 'shape-readable',
            messageKey: 'common.shape_unreadable',
            params: { field: fieldName },
          });
          continue;
        }

        // The placeholder exemption: only under templates_dir, and only
        // once the value is confirmed present and readable, since an
        // unreadable shape is reported above regardless of where the
        // file lives.
        if (placeholder && isUnderDir(file, templatesDir) && placeholder.test(value)) continue;

        if (spec.type === 'boolean' && !isValidBooleanValue(value)) {
          findings.push({ file, line, check: 'value-kind', messageKey: 'house.extension_fields.boolean', params: { field: fieldName, value } });
        } else if (spec.type === 'number' && !isValidNumberValue(value)) {
          findings.push({ file, line, check: 'value-kind', messageKey: 'house.extension_fields.number', params: { field: fieldName, value } });
        } else if (spec.type === 'date' && !isValidCalendarDateValue(value)) {
          findings.push({ file, line, check: 'value-kind', messageKey: 'house.extension_fields.date', params: { field: fieldName, value } });
        } else if (spec.type === 'enum') {
          const noteType = readScalar(frontmatter, 'type');
          const allowed = allowedEnumValues(spec, typeof noteType === 'string' ? noteType : null);
          if (allowed !== null && !allowed.includes(value)) {
            findings.push({
              file,
              line,
              check: 'enum-value',
              messageKey: 'house.extension_fields.enum',
              params: { field: fieldName, value, allowed },
            });
          }
        }
        // spec.type === 'string' has no further shape to check: any
        // readable scalar already satisfies it.
      }
    }
    return findings;
  },
};

// The line, in the WHOLE file, that body-relative line index `bodyLineIndex`
// (0-based) falls on. `body` is always an exact suffix of `fullText` (both
// come from the same splitFrontmatter call, and body is never rebuilt),
// so counting the newlines in the untouched prefix is enough to place any
// later line without re-deriving how long the frontmatter block was.
function bodyPrefixLineCount(fullText, body) {
  const prefixLength = fullText.length - body.length;
  return fullText.slice(0, prefixLength).split('\n').length;
}

// --- link scanning: markdown links, balanced brackets and parentheses -------------
//
// Fix round 1: the previous version found a link's own text at the
// first "]" and its target at the first ")", both by regular expression
// character class, so bracketed link text and a target containing its
// own parenthesis were either invisible or reported under a garbled
// name. Both are now found by BALANCED matching, tracking nesting depth
// the same way src/frontmatter.mjs's own findMatchingClose does for an
// inline mapping or list value: an inner matched pair of the same
// character does not close the outer scan early.
//
// One consequence worth stating rather than leaving implicit: for a
// link nested inside another link's text, such as an image inside a
// link ("[![alt](img.png)](outer.md)"), balanced matching for the TEXT
// span walks straight past the inner image's own "[alt]" (it nests
// correctly inside the outer pair) and lands on the OUTER "]", so the
// outer target ("outer.md") is now found correctly, where the previous,
// unbalanced version found only the inner one ("img.png") and never saw
// the outer link at all. The inner image is, in exchange, never
// independently scanned: it is now simply part of the outer link's
// text. This module's own header names this as a declared trade-off,
// not a silent gap: only the outer link of a nested pair is ever
// checked.
//
// Declining, not guessing: a "[" with no balanced closing "]" on the
// same line, or one not immediately followed by "(...)" with a balanced
// close of its own, is not a link at all here, and the scan simply
// continues from the very next character, so one malformed bracket does
// not blind the rest of the line to a later, well-formed link.
// Fix round 2: a backslash-escaped bracket in link text ("[a \] b](url)")
// used to be read as a real closing bracket, since depth tracking alone
// does not know a "\]" is a literal character rather than structure.
// That made the whole link invisible: the scanner found a false close
// with no "(" right after it, judged the "[" not a link opener at all,
// and moved on one character at a time, never finding the real link
// this text describes. Skipping the character right after ANY
// backslash, of either open or close, is CommonMark's own general
// escaping rule for ASCII punctuation, not a bracket-specific patch, so
// it applies here to both the text span and the target span alike.
function findBalancedClose(line, openIndex, open, close) {
  let depth = 1;
  for (let i = openIndex + 1; i < line.length; i++) {
    if (line[i] === '\\') {
      i++; // the next character, open/close or not, is escaped: never structural
      continue;
    }
    if (line[i] === open) depth++;
    else if (line[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findLinkAt(line, openIndex) {
  const textEnd = findBalancedClose(line, openIndex, '[', ']');
  if (textEnd === -1) return null;
  if (line[textEnd + 1] !== '(') return null;
  const targetOpen = textEnd + 1;
  const targetEnd = findBalancedClose(line, targetOpen, '(', ')');
  if (targetEnd === -1) return null;
  return { target: line.slice(targetOpen + 1, targetEnd), nextIndex: targetEnd + 1 };
}

function scanLinksInLine(line) {
  const results = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '[') {
      const found = findLinkAt(line, i);
      if (found) {
        results.push({ target: found.target, index: i });
        i = found.nextIndex;
        continue;
      }
    }
    i++;
  }
  return results;
}

function scanLinks(strippedBody) {
  const results = [];
  const lines = strippedBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { target } of scanLinksInLine(lines[i])) {
      results.push({ target, lineIndex: i });
    }
  }
  return results;
}

const WIKILINK_PATTERN = /\[\[([^\]]*)\]\]/g;

function scanWikilinks(strippedBody) {
  const results = [];
  const lines = strippedBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    WIKILINK_PATTERN.lastIndex = 0;
    let match;
    while ((match = WIKILINK_PATTERN.exec(lines[i])) !== null) {
      results.push({ target: match[1], lineIndex: i });
    }
  }
  return results;
}

// Strips a trailing quoted title ("target \"title\"") and a surrounding
// "<...>" wrapper, both legal markdown around a link target, so neither
// is mistaken for part of the path itself.
// A raw, unescaped space in a BARE (not "<...>"-wrapped) link
// destination is not legal markup at all in this format: CommonMark
// requires such a destination to be wrapped in angle brackets, or the
// space itself backslash-escaped, and this reader recognises neither
// convention beyond the one check below. Fix round 2: a target like
// "my file.md" used to be read as a literal, real destination and
// reported broken (or not), a confident claim either way about
// something this markup does not parse as a link in the first place.
// A space immediately preceded by a backslash is escaped, not raw.
function hasRawSpace(text) {
  return /(?<!\\) /.test(text);
}

// Returns the link's destination, or null when the raw text is not a
// valid link destination at all (see hasRawSpace above), in which case
// the caller must treat the whole thing as not being a link, producing
// no finding, right or wrong, rather than a confident claim about text
// this markup does not parse as a link.
function parseLinkTarget(raw) {
  let target = raw.trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(target);
  if (titled) target = titled[1];
  const angleWrapped = target.length >= 2 && target.startsWith('<') && target.endsWith('>');
  if (angleWrapped) target = target.slice(1, -1);
  if (!angleWrapped && hasRawSpace(target)) return null;
  return target;
}

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isExternalLink(target) {
  return SCHEME_PATTERN.test(target) || target.startsWith('//');
}

function isFragmentOnly(target) {
  return target.startsWith('#');
}

function splitFragment(target) {
  const index = target.indexOf('#');
  return index === -1 ? [target, ''] : [target.slice(0, index), target.slice(index + 1)];
}

// Strips a trailing query string ("?v=1"): a target this vault serves
// through something that reads one (a generated page, a cache-busting
// parameter) still names the same file, and the file existing is what
// this rule checks, not the query. Fix round 1: this used to be
// unhandled, so a link precisely this shape was reported broken though
// the file it named was fine.
function stripQueryString(pathPart) {
  const index = pathPart.indexOf('?');
  return index === -1 ? pathPart : pathPart.slice(0, index);
}

// Percent-decodes a path ("real%20file.md" -> "real file.md"), the
// correct way to link a file whose name contains a character the
// markdown link syntax cannot carry unescaped. Fix round 1: this used
// to be unhandled too, so a correctly percent-encoded link to a real
// file was reported broken. A malformed escape sequence is declined,
// not thrown: decodeURIComponent throws on one, and the raw, undecoded
// text is kept instead, which is never worse than the input already
// was.
function decodePathSafely(pathPart) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function resolveLinkPath(file, pathPart) {
  if (pathPart.startsWith('/')) return pathPart.slice(1);
  return posix.normalize(posix.join(posix.dirname(file), pathPart));
}

// Iterates every internal (non-external, non-fragment-only) link target
// in `file`'s body, already stripped of fenced and inline code, handing
// each to `visit(target, pathPart, fileLine)`. `pathPart` has already
// had its query string stripped and its percent-escapes decoded, so
// neither link-style nor link-target-exists has to repeat that work or
// risk disagreeing about it. Shared by both rules so they can never
// disagree about what counts as an internal link in the first place.
function forEachInternalLink(file, context, visit) {
  const text = context.readFile(file);
  const { body } = splitFrontmatter(text);
  const stripped = stripCode(body);
  const prefixLineCount = bodyPrefixLineCount(text, body);
  for (const { target, lineIndex } of scanLinks(stripped)) {
    const parsed = parseLinkTarget(target);
    if (parsed === null) continue; // not a valid link destination in this markup at all: not a link
    if (isExternalLink(parsed) || isFragmentOnly(parsed)) continue;
    const [rawPathPart] = splitFragment(parsed);
    const pathPart = decodePathSafely(stripQueryString(rawPathPart));
    if (pathPart === '') continue;
    visit(target, pathPart, prefixLineCount + lineIndex);
  }
}

// --- link-style (validate.link_style) --------------------------------------------

const linkStyle = {
  id: 'link-style',
  check(files, context) {
    const style = context.config?.validate?.link_style ?? 'any';
    if (style === 'any') return [];
    const findings = [];
    for (const file of files) {
      // Fix round 2: this rule judges `isAbsolute` against `pathPart`
      // (already query-stripped and percent-decoded), but used to quote
      // only the raw `target` text in its own message, so a link like
      // "%2Fetc/passwd" could be reported as "starts with a slash"
      // while the quoted evidence in the message plainly does not show
      // one. Both are named now, whenever they differ, so the message
      // always shows the evidence for what was actually judged.
      forEachInternalLink(file, context, (target, pathPart, line) => {
        const isAbsolute = pathPart.startsWith('/');
        const seen = pathPart === target ? `"${target}"` : `"${target}" (resolved path "${pathPart}")`;
        if (style === 'file-relative' && isAbsolute) {
          findings.push({
            file,
            line,
            check: 'file-relative',
            messageKey: 'house.link_style.file_relative',
            params: { seen },
          });
        } else if (style === 'bundle-absolute' && !isAbsolute) {
          findings.push({ file, line, check: 'bundle-absolute', messageKey: 'house.link_style.bundle_absolute', params: { seen } });
        }
      });
    }
    return findings;
  },
};

// --- link-target-exists (always on) -----------------------------------------------
//
// The only rule in this ruler that reads context.all instead of files:
// a link may legitimately point at a non-markdown attachment, which is
// exactly why the single walk this ruler is handed asks for every file,
// not only the markdown subset.

const linkTargetExists = {
  id: 'link-target-exists',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      forEachInternalLink(file, context, (target, pathPart, line) => {
        const resolved = resolveLinkPath(file, pathPart);
        if (!context.all.has(resolved)) {
          findings.push({
            file,
            line,
            check: 'target-exists',
            messageKey: 'house.link_target_exists.broken',
            params: { target, resolved },
          });
        }
      });
    }
    return findings;
  },
};

// --- no-wikilinks (validate.wikilinks) --------------------------------------------

const noWikilinks = {
  id: 'no-wikilinks',
  check(files, context) {
    const setting = context.config?.validate?.wikilinks ?? 'allow';
    if (setting !== 'forbid') return [];
    const findings = [];
    for (const file of files) {
      const text = context.readFile(file);
      const { body } = splitFrontmatter(text);
      const stripped = stripCode(body);
      const prefixLineCount = bodyPrefixLineCount(text, body);
      for (const { target, lineIndex } of scanWikilinks(stripped)) {
        findings.push({
          file,
          line: prefixLineCount + lineIndex,
          check: 'wikilink-forbidden',
          messageKey: 'house.no_wikilinks.forbidden',
          params: { target },
        });
      }
    }
    return findings;
  },
};

// --- root-okf-version (validate.require_root_okf_version) -------------------------

const rootOkfVersion = {
  id: 'root-okf-version',
  check(files, context) {
    if (!context.config?.validate?.require_root_okf_version) return [];
    if (!files.includes('index.md')) return []; // nothing to check without the root index itself
    const { frontmatter } = splitFrontmatter(context.readFile('index.md'));
    const value = readScalar(frontmatter, 'okf_version');
    const line = frontmatterKeyLine(frontmatter, 'okf_version');
    if (value === null) {
      return [{ file: 'index.md', line: null, check: 'declared', messageKey: 'house.root_okf_version.missing', params: {} }];
    }
    if (value === undefined) {
      return [
        {
          file: 'index.md',
          line,
          check: 'shape-readable',
          messageKey: 'common.shape_unreadable',
          params: { field: 'okf_version' },
        },
      ];
    }
    const expected = context.config.okf_version;
    if (value !== expected) {
      return [
        {
          file: 'index.md',
          line,
          check: 'matches-configured',
          messageKey: 'house.root_okf_version.mismatch',
          params: { value, expected },
        },
      ];
    }
    return [];
  },
};

// --- timestamp-deviation (validate.timestamp_deviation) ---------------------------
//
// See this file's own header for why this rule's check always returns no
// findings: downgrading a specification finding is not a thing this
// ruler's per-file loop can do on its own.

const timestampDeviation = {
  id: 'timestamp-deviation',
  check() {
    return [];
  },
};

// The specification `should`-level checks a vault may downgrade,
// identified by the (id, check) pair rather than by id alone (fix round
// 1: an id is not fine enough on its own, since generated-actor and
// verified-events each carry an actor-shaped check and a timestamp-
// shaped check under one id). Every one of these is section 5's own
// "every timestamp-valued key" claim, made good by spec.mjs's own fix
// round 5: generated.at, stale_after, verified[].at and
// sources[].last_modified.
//
// log-format is deliberately excluded, and this is a ratified choice,
// not an oversight left to be inferred from a frozen array: log-format's
// date headings are governed by section 9, not section 5, and they are
// plain ISO 8601 DATES ("## YYYY-MM-DD"), not datetimes with a UTC
// offset at all, so they are not "timestamp-valued keys" in the sense
// this deviation exists for, which is a vault mid-migration off a plain
// date onto the offset form section 5 requires. A log heading was never
// in that form to begin with. Separately, and sufficient on its own:
// every one of log-format's checks is 'must' or, where 'should'
// (frontmatter, non-date headings), about something with no timestamp
// shape either, and this function already refuses to touch a `must`
// finding no matter what the setting says.
const TIMESTAMP_ELIGIBLE = Object.freeze([
  { id: 'generated-actor', check: 'timestamp-form' },
  { id: 'stale-after-format', check: 'timestamp-form' },
  { id: 'verified-events', check: 'event-timestamp-form' },
  { id: 'sources-resource', check: 'entry-timestamp-form' },
]);

// Downgrades a specification `should`-level timestamp finding to a
// warning (a `warning: true` field added alongside its own, unchanged
// `level`, never a rewrite of `level` itself: the original tier is a
// fact about the format, not something a house declaration gets to
// erase) when this vault has declared validate.timestamp_deviation as
// "allow". Defaults to "forbid", so an unconfigured vault gets the
// format's own answer, with every finding passed through untouched.
//
// Matches on the TRIPLE of `ruler === 'spec'`, `level === 'should'` and
// the finding's own `check` being one of TIMESTAMP_ELIGIBLE's (id,
// check) pairs: `id` alone was tried first and found wanting (see fix
// round 1 above), and `check` alone would still risk a coincidental
// name collision across two different rules' own vocabularies, so both
// are matched together, the same caution spec.mjs's own header applies
// to `ruler` and `id`. A `must`-level finding is never touched,
// whatever the setting says: a house declaration can widen leniency for
// a `should`, never silence a conformance failure.
export function applyTimestampDeviation(findings, config) {
  const setting = config?.validate?.timestamp_deviation ?? 'forbid';
  if (setting !== 'allow') return findings;
  return findings.map((finding) => {
    if (finding.ruler !== 'spec' || finding.level !== 'should') return finding;
    const eligible = TIMESTAMP_ELIGIBLE.some((e) => e.id === finding.id && e.check === finding.check);
    return eligible ? { ...finding, warning: true } : finding;
  });
}

export const HOUSE_RULES = Object.freeze([
  requiredFields,
  forbiddenFields,
  typeEnum,
  extensionFields,
  linkStyle,
  linkTargetExists,
  noWikilinks,
  rootOkfVersion,
  timestampDeviation,
]);

// Runs every rule over `files`, in order, and returns their findings
// flattened into one array, each stamped with `ruler: 'house'`, the id
// that produced it, and, since fix round 1, a `check`: a stable English
// name for the specific assertion inside the rule, unique within it (a
// required-fields finding names 'field-present', 'field-non-empty' or
// 'shape-readable', for instance, not just "required-fields" three
// times over). No `level`, no `section`: see this file's own header for
// why their absence is the point. Rules are data (HOUSE_RULES is a
// plain array of { id, check }), and this loop is the entire runner,
// mirroring runSpecRules in every way that matters: no rule is
// special-cased, so a future house rule is one array entry away.
export function runHouseRules(files, context) {
  const findings = [];
  for (const rule of HOUSE_RULES) {
    for (const partial of rule.check(files, context)) {
      findings.push({
        ruler: 'house',
        id: rule.id,
        check: partial.check,
        file: partial.file,
        line: partial.line,
        messageKey: partial.messageKey,
        params: partial.params,
      });
    }
  }
  return findings;
}
