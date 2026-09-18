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
// module exists to prevent. `ruler: 'house'` plus a rule's `id` is
// therefore the whole identity of a finding here: no level to sort by,
// no section to cite. A consumer combining both rulers' output sees
// three groups in order: specification `must`, specification `should`,
// and house, never four, and never a house finding mistaken for either
// specification tier.
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
//    module reads a single link or wikilink out of it. spec.mjs's own
//    header names the sibling defect this generalises: a heading inside
//    a fence, read as if it were real. The same hazard applies to a
//    link or a wikilink shown as a documentation example. stripCodeForLinks
//    below handles a backtick fence, a tilde fence, a fence longer than
//    three characters, and a fence that never closes (blanking to the
//    end of the file, never guessing where it might have ended, the same
//    caution splitFrontmatter itself uses for an unterminated block).
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
import { posix } from 'node:path';
import { readEntries, readList, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Finds the 1-based line, in the whole file, of the top-level frontmatter
// line "key:" (column 0, inside the frontmatter block only). Returns null
// when the key's own line cannot be found. Mirrors spec.mjs's own
// frontmatterKeyLine, which is not exported: duplicated here rather than
// imported, since the two rulers are deliberately independent modules
// that happen to share a small amount of line-finding arithmetic, not one
// sharing a private helper across a module boundary that was never meant
// to be public.
function frontmatterKeyLine(frontmatter, key) {
  if (!frontmatter) return null;
  const pattern = new RegExp(`^${key}[ \t]*:`);
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 2;
  }
  return null;
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
// key that is there in ANY shape, scalar or not. Once presence is
// established, readMapping / readList / readEntries are tried in turn to
// answer "is it empty", for whichever one of them recognises the shape;
// none of them can return null here (the key is already known to exist),
// so a null is treated the same as undefined, defensively, rather than
// trusted never to happen.
function classifyField(frontmatter, key) {
  const scalar = readScalar(frontmatter, key);
  if (scalar === null) return { state: 'absent' };
  if (typeof scalar === 'string') return { state: scalar.trim() === '' ? 'blank' : 'present' };

  const mapping = readMapping(frontmatter, key);
  if (mapping !== null && mapping !== undefined) return { state: Object.keys(mapping).length === 0 ? 'blank' : 'present' };

  const list = readList(frontmatter, key);
  if (list !== null && list !== undefined) return { state: list.length === 0 ? 'blank' : 'present' };

  const entries = readEntries(frontmatter, key);
  if (entries !== null && entries !== undefined) return { state: entries.length === 0 ? 'blank' : 'present' };

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
          findings.push({ file, line: null, message: `${key} is required by this vault's own configuration but is missing` });
        } else if (state === 'blank') {
          findings.push({ file, line: frontmatterKeyLine(frontmatter, key), message: `${key} is required by this vault's own configuration but is empty` });
        } else if (state === 'unreadable') {
          findings.push({
            file,
            line: frontmatterKeyLine(frontmatter, key),
            message: `${key} is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)`,
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
        findings.push({
          file,
          line: frontmatterKeyLine(frontmatter, key),
          message: `${key} is forbidden by this vault's own configuration but is present`,
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
        findings.push({ file, line, message: 'type is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' });
        continue;
      }
      if (isBlank(value)) continue; // an empty type is type-required's finding, not this one's
      if (!allowed.includes(value)) {
        findings.push({ file, line, message: `type "${value}" is not one of this vault's allowed types: ${allowed.join(', ')}` });
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
// is the one place in this module that can throw on ordinary config
// content rather than on file content, so it is the one place wrapped in
// its own try/catch. Returning null (no exemption ever matches) is the
// same answer as "no pattern configured at all".
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
          findings.push({ file, line, message: `${fieldName} is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)` });
          continue;
        }

        // The placeholder exemption: only under templates_dir, and only
        // once the value is confirmed present and readable, since an
        // unreadable shape is reported above regardless of where the
        // file lives.
        if (placeholder && isUnderDir(file, templatesDir) && placeholder.test(value)) continue;

        if (spec.type === 'boolean' && !isValidBooleanValue(value)) {
          findings.push({ file, line, message: `${fieldName} "${value}" must be a boolean (true or false)` });
        } else if (spec.type === 'number' && !isValidNumberValue(value)) {
          findings.push({ file, line, message: `${fieldName} "${value}" must be a number` });
        } else if (spec.type === 'date' && !isValidCalendarDateValue(value)) {
          findings.push({ file, line, message: `${fieldName} "${value}" must be an ISO calendar date (YYYY-MM-DD)` });
        } else if (spec.type === 'enum') {
          const noteType = readScalar(frontmatter, 'type');
          const allowed = allowedEnumValues(spec, typeof noteType === 'string' ? noteType : null);
          if (allowed !== null && !allowed.includes(value)) {
            findings.push({ file, line, message: `${fieldName} "${value}" is not one of this vault's allowed values: ${allowed.join(', ')}` });
          }
        }
        // spec.type === 'string' has no further shape to check: any
        // readable scalar already satisfies it.
      }
    }
    return findings;
  },
};

// --- fenced and inline code, blanked before either link rule reads a line ----------
//
// A fence opens with three or more backticks or three or more tildes,
// and closes only on a later line carrying at least as many of the SAME
// character and nothing else (CommonMark's own closing rule, not this
// project's invention). Blanking each line inside a fence, rather than
// removing it, keeps every later line number exactly where it was,
// which every finding below depends on. An opened fence with no closing
// line at all blanks every line to the end of the file, the same
// caution splitFrontmatter itself takes for an unterminated frontmatter
// block: guessing where it might have ended would be worse than
// declining to look inside it at all.
const FENCE_MARKER = /^(`{3,}|~{3,})/;

function withoutFencedCodeBlocks(text) {
  let fence = null; // { char, len } while a fence is open, else null
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const marker = FENCE_MARKER.exec(trimmed);
      if (fence === null) {
        if (marker) {
          fence = { char: marker[1][0], len: marker[1].length };
          return '';
        }
        return line;
      }
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len && trimmed === marker[1]) {
        fence = null;
      }
      return '';
    })
    .join('\n');
}

// A single-backtick inline code span, blanked per line so a link-shaped
// example written inline ("write it like `[text](url)`") is never read
// either. A double-backtick span containing a literal backtick is not
// recognised: this reader declines rather than guesses, the same trade
// every reader in src/frontmatter.mjs already makes for its own harder
// shapes.
function withoutInlineCode(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/`[^`\n]*`/g, ''))
    .join('\n');
}

function stripCodeForLinks(body) {
  return withoutInlineCode(withoutFencedCodeBlocks(body));
}

// The line, in the WHOLE file, that body-relative line index `bodyLineIndex`
// (0-based) falls on. `body` is always an exact suffix of `fullText` (both
// come from the same splitFrontmatter call, and body is never rebuilt),
// so counting the newlines in the untouched prefix is enough to place any
// later line without re-deriving how long the frontmatter block was.
function bodyPrefixLineCount(fullText, body) {
  const prefixLength = fullText.length - body.length;
  return fullText.slice(0, prefixLength).split('\n').length;
}

// A standard markdown link or image: "[text](target)" or "![text](target)".
// Deliberately simple (no nested-parenthesis handling in the target, no
// multi-line link support): a regular-expression reader that declines the
// hard cases rather than guessing at them is this project's own house
// style (src/frontmatter.mjs's header says so of itself), and the two
// behaviours this module is required to prove (fenced/inline code
// excluded first, and the placeholder exemption) do not depend on either
// hard case.
const LINK_PATTERN = /\[[^\]]*\]\(([^)]*)\)/g;
const WIKILINK_PATTERN = /\[\[([^\]]*)\]\]/g;

function scanPattern(strippedBody, pattern) {
  const results = [];
  const lines = strippedBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(lines[i])) !== null) {
      results.push({ target: match[1], lineIndex: i });
    }
  }
  return results;
}

function scanLinks(strippedBody) {
  return scanPattern(strippedBody, LINK_PATTERN);
}

function scanWikilinks(strippedBody) {
  return scanPattern(strippedBody, WIKILINK_PATTERN);
}

// Strips a trailing quoted title ("target \"title\"") and a surrounding
// "<...>" wrapper, both legal markdown around a link target, so neither
// is mistaken for part of the path itself.
function parseLinkTarget(raw) {
  let target = raw.trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(target);
  if (titled) target = titled[1];
  if (target.length >= 2 && target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
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

function resolveLinkPath(file, pathPart) {
  if (pathPart.startsWith('/')) return pathPart.slice(1);
  return posix.normalize(posix.join(posix.dirname(file), pathPart));
}

// Iterates every internal (non-external, non-fragment-only) link target
// in `file`'s body, already stripped of fenced and inline code, handing
// each to `visit(target, pathPart, fileLine)`. Shared by link-style and
// link-target-exists so the two rules can never disagree about what
// counts as an internal link in the first place.
function forEachInternalLink(file, context, visit) {
  const text = context.readFile(file);
  const { body } = splitFrontmatter(text);
  const stripped = stripCodeForLinks(body);
  const prefixLineCount = bodyPrefixLineCount(text, body);
  for (const { target, lineIndex } of scanLinks(stripped)) {
    const parsed = parseLinkTarget(target);
    if (isExternalLink(parsed) || isFragmentOnly(parsed)) continue;
    const [pathPart] = splitFragment(parsed);
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
      forEachInternalLink(file, context, (target, pathPart, line) => {
        const isAbsolute = pathPart.startsWith('/');
        if (style === 'file-relative' && isAbsolute) {
          findings.push({
            file,
            line,
            message: `link "${target}" starts with a slash, which resolves against the host, not the repository, and breaks where a human reviews the change; this vault requires file-relative links`,
          });
        } else if (style === 'bundle-absolute' && !isAbsolute) {
          findings.push({ file, line, message: `link "${target}" does not start with a slash; this vault requires bundle-absolute links` });
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
          findings.push({ file, line, message: `link target "${target}" does not resolve to a file in this vault (resolved to "${resolved}")` });
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
      const stripped = stripCodeForLinks(body);
      const prefixLineCount = bodyPrefixLineCount(text, body);
      for (const { target, lineIndex } of scanWikilinks(stripped)) {
        findings.push({
          file,
          line: prefixLineCount + lineIndex,
          message: `[[${target}]] is a wikilink, which this vault forbids; use a standard markdown link instead`,
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
      return [{ file: 'index.md', line: null, message: 'the root index does not declare okf_version, which this vault requires' }];
    }
    if (value === undefined) {
      return [{ file: 'index.md', line, message: 'okf_version is present but its shape could not be read (see PARSER_LIMITS in src/frontmatter.mjs)' }];
    }
    const expected = context.config.okf_version;
    if (value !== expected) {
      return [{ file: 'index.md', line, message: `the root index declares okf_version "${value}" but this vault is configured for "${expected}"` }];
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

// The specification `should`-level rules whose finding a vault may
// downgrade: the two timestamp-shaped ids from spec.mjs, generated-actor
// and stale-after-format. Nothing else is ever eligible, whatever the
// setting says.
const TIMESTAMP_FINDING_IDS = Object.freeze(['generated-actor', 'stale-after-format']);

// Downgrades a specification `should`-level timestamp finding to a
// warning (a `warning: true` field added alongside its own, unchanged
// `level`, never a rewrite of `level` itself: the original tier is a
// fact about the format, not something a house declaration gets to
// erase) when this vault has declared validate.timestamp_deviation as
// "allow". Defaults to "forbid", so an unconfigured vault gets the
// format's own answer, with every finding passed through untouched.
//
// Matches on the PAIR of `ruler === 'spec'` and one of the two timestamp
// ids, exactly the caution spec.mjs's own header names: an id is not
// unique across rulers on its own. A `must`-level finding is never
// touched, whatever the setting says: a house declaration can widen
// leniency for a `should`, never silence a conformance failure.
export function applyTimestampDeviation(findings, config) {
  const setting = config?.validate?.timestamp_deviation ?? 'forbid';
  if (setting !== 'allow') return findings;
  return findings.map((finding) => {
    if (finding.ruler === 'spec' && finding.level === 'should' && TIMESTAMP_FINDING_IDS.includes(finding.id)) {
      return { ...finding, warning: true };
    }
    return finding;
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
// flattened into one array, each stamped with `ruler: 'house'` plus the
// id that produced it. No `level`, no `section`: see this file's own
// header for why their absence is the point. Rules are data (HOUSE_RULES
// is a plain array of { id, check }), and this loop is the entire
// runner, mirroring runSpecRules in every way that matters: no rule is
// special-cased, so a future house rule is one array entry away.
export function runHouseRules(files, context) {
  const findings = [];
  for (const rule of HOUSE_RULES) {
    for (const partial of rule.check(files, context)) {
      findings.push({
        ruler: 'house',
        id: rule.id,
        file: partial.file,
        line: partial.line,
        message: partial.message,
      });
    }
  }
  return findings;
}
