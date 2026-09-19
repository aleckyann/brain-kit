// The lint ruler: whether a vault's content is HEALTHY, as against
// conformant (src/rules/spec.mjs) or in-house-style (src/rules/house.mjs),
// this module's two siblings and the shape it mirrors: rules as DATA
// objects an array holds and one runner iterates, never a chain of
// conditionals, so a future rule is one array entry, not one more branch.
//
// Why a lint finding carries no `level`. `must` and `should` are the
// Open Knowledge Format's own two conformance tiers (spec.mjs's own
// header, reading section 11 of the format). A health question -
// "does every note have a way in from the root", "is this table the
// shape the vault's own taxonomy declares" - belongs to neither tier: a
// vault can be perfectly conformant and still have an orphaned note
// nobody can find. So a lint finding carries `severity` instead, read
// from `lint.<rule>` in the vault's own configuration (`error`, `warn`
// or `off`), defaulting to `warn` for a rule the configuration never
// names. `off` means the rule does not run at all: runLintRules below
// never calls a rule's `check` once its severity resolves to `off`, so
// an adopter who turns a rule off pays nothing for it, not even the
// walk.
//
// The three rules in this task judge the VAULT AS A WHOLE, not a
// change: every one of them reads the full `files` argument and ignores
// the `scope` argument entirely (task 4's two rules, tables and style,
// are the ones that read it). This is not an optimisation this module
// declines to make; narrowing any of these three questions to a
// change's own files would make the answer WRONG, in the confident
// direction. Reachability (the orphan rule) cannot be computed from a
// subset of the graph: a note is an orphan only with respect to the
// WHOLE graph, and restricting the walk to a change's files would
// report as orphaned a note that is actually reachable through a file
// the change never touched. The same is true of index-completeness ("is
// every directory covered", a question about every directory there is,
// not the ones a diff happened to touch) and of columns (a file named
// under `taxonomy.files` either has the right header row or it does
// not; nothing about a change's own line numbers bears on that). So
// every `check` function below is written `check(files, context)`, with
// no `scope` parameter at all: runLintRules still calls every rule the
// same way, `rule.check(files, context, scope)`, so a future scope-aware
// rule is one array entry away, exactly like HOUSE_RULES and SPEC_RULES;
// these three simply never look at the third argument JavaScript hands
// them for free.
//
// This module never calls walkVault, exactly like its two siblings
// (spec.mjs's and house.mjs's own headers make the identical claim):
// src/commands/lint.mjs (a later task) walks the vault ONCE and hands
// every ruler the same `files` and `context`, so this ruler and the
// other two can never disagree about what the vault even contains.
//
// What this module reuses rather than reinvents, and why: it imports
// `forEachInternalLink`, `resolveLinkPath` and `bodyPrefixLineCount`
// from src/rules/house.mjs (exported there for exactly this reuse; see
// that file's own comments at each export) instead of writing a second
// link scanner, a second link-path normaliser or a second body-relative
// line counter. This codebase has already paid, more than once, for the
// alternative: house.mjs's own header describes a code stripper
// duplicated for "independence" that silently disagreed with the
// original, and this file's orphan rule and index-completeness rule
// both need to ask the exact question link-target-exists already
// answers correctly ("what vault path does this link resolve to, and
// does it exist"). Two implementations of that question are two chances
// to disagree about what a link is, which is worse than one shared
// answer, however that answer is spelled. `stripCode` (src/markdown.mjs)
// and `splitFrontmatter` (src/frontmatter.mjs) are imported directly,
// exactly as house.mjs and spec.mjs already do, for the same reason.
//
// `RESERVED_FILENAMES`/`isReserved` below IS a second copy of the pair
// already private to both house.mjs and spec.mjs, not exported from
// either. That duplication is deliberate, not an oversight: unlike a
// link scanner or a fence model, "index.md and log.md are structure,
// not content" is a two-line, two-name fact with no room to silently
// drift, and this project's own two existing rulers already carry this
// exact duplicate between each other without either ever having caused
// a defect, which is the standing precedent this module follows rather
// than widening house.mjs's export surface for a fact this trivial to
// restate.
//
// Judgment calls this module makes, each recorded here because neither
// the format nor the plan settles it:
//
// 1. "Every directory that holds a markdown file has an index.md"
//    (index-completeness's first check) is read as DIRECT containment:
//    a directory needs its own index.md only when a markdown file sits
//    in it directly, not merely somewhere in its subtree. "The root
//    index links every first-level directory" (its second check) is
//    read more broadly, as TRANSITIVE containment: a first-level
//    directory whose markdown lives entirely in a nested subdirectory
//    still needs a root-level link, because that link is a reader's
//    only way in. The two checks answer two different questions (can
//    THIS directory's own listing be found; can a reader reach this
//    branch of the tree AT ALL), and a purely first-level containment
//    dropped the second question the moment a vault nested one level
//    deeper than the fixtures this task started from.
// 2. A first-level directory counts as "linked" by the root index when
//    a link resolves to the directory itself (the format's own worked
//    example, "[Subdirectory](subdir/)", section 8) OR to that
//    directory's own index.md. Both are how a person actually writes
//    this link by hand; accepting only one would make the other, an
//    equally sound choice, into a false positive of this rule's own.
// 3. The column check treats EVERY value in `taxonomy.columns.<name>`,
//    in declared order, as one literal expected heading, with no
//    attempt to guess which entries "really" name a column and which
//    are some other label a vault owner folded into the same object
//    (the shipped example config does exactly this: `open_heading` and
//    `resolved_heading` sit beside real column names, for a file with
//    two labelled sections). The schema draws no line between the two
//    kinds of entry, and guessing one from a key's spelling would be
//    exactly the kind of confident, unstated inference this project's
//    own rules elsewhere refuse to make. The cost, if this is the wrong
//    call: a vault whose columns object mixes section labels in with
//    real headings gets a literal, none-too-useful mismatch against a
//    header row that was never meant to contain a heading like
//    "## Open"; the fix available today is `lint.columns: "off"` or
//    "warn", and the more precise fix, a schema that separates the two
//    kinds of entry, is outside this task's remit.
// 4. A file named in `taxonomy.files` that does not exist in this walk
//    is skipped by the column check, in silence: reporting a missing
//    configured file is a different claim ("this file should exist at
//    all") from the one this rule makes ("this file's table has the
//    right headers"), and this task does not add a fourth rule to make
//    the first claim.
// 5. The orphan rule reports nothing at all when the root index itself
//    is missing from `files`: with no root to start a walk from, every
//    file would be "unreachable" for the same one reason, and reporting
//    that once, under index-completeness's own missing-index finding
//    for the root, says it once instead of drowning it under every
//    other file in the vault restating it.
import { posix } from 'node:path';
import { bodyPrefixLineCount, forEachInternalLink, resolveLinkPath } from './house.mjs';
import { splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';
import { classifyTargetPath } from '../vault.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

// The vault path a directory's own index page must sit at: "index.md"
// for the vault root (posix.dirname's own spelling of it), "<dir>/index.md"
// for anything else.
function indexPathFor(dir) {
  return dir === '.' ? 'index.md' : `${dir}/index.md`;
}

// --- index-completeness (lint.index_completeness) --------------------------------

// True when some link in the root index resolves to `dir` itself (the
// format's own directory-link convention) or to `dir`'s own index.md
// (judgment call 2 above). Reads every link in index.md rather than
// stopping at the first match, because forEachInternalLink's own
// contract (house.mjs) has no early-exit signal; the directory sets
// this task deals with are small enough that scanning the rest of one
// file's links costs nothing worth guarding against.
function rootLinksDirectory(dir, context) {
  let linked = false;
  forEachInternalLink('index.md', context, (target, pathPart) => {
    const resolved = resolveLinkPath('index.md', pathPart);
    const state = classifyTargetPath(context.root, resolved, context.all);
    if (state === 'directory' && resolved === dir) linked = true;
    else if (state === 'in-walk' && resolved === indexPathFor(dir)) linked = true;
  });
  return linked;
}

const indexCompleteness = {
  id: 'index-completeness',
  settingKey: 'index_completeness',
  check(files, context) {
    const findings = [];

    // Clause 1: every directory that DIRECTLY holds a markdown file
    // (judgment call 1 above) has its own index.md.
    const directDirs = new Set(files.map((file) => posix.dirname(file)));
    for (const dir of [...directDirs].sort()) {
      const indexPath = indexPathFor(dir);
      if (!files.includes(indexPath)) {
        findings.push({
          file: indexPath,
          line: null,
          check: 'directory-has-index',
          absence: true,
          messageKey: 'lint.index_completeness.missing_index',
          params: {},
        });
      }
    }

    // Clause 2: the root index links every first-level directory whose
    // subtree holds any markdown note at all (judgment call 1 above).
    // With no root index to read at all, there is nothing left to check
    // here; its own absence was already reported by clause 1, for dir
    // ".", the moment any markdown file exists in this vault at all.
    if (!files.includes('index.md')) return findings;
    const firstLevelDirs = new Set();
    for (const file of files) {
      const dir = posix.dirname(file);
      if (dir === '.') continue;
      firstLevelDirs.add(dir.split('/')[0]);
    }
    for (const dir of [...firstLevelDirs].sort()) {
      if (!rootLinksDirectory(dir, context)) {
        findings.push({
          file: 'index.md',
          line: null,
          check: 'root-links-directory',
          absence: true,
          messageKey: 'lint.index_completeness.dir_not_linked',
          params: { dir },
        });
      }
    }
    return findings;
  },
};

// --- orphans (lint.orphans) --------------------------------------------------------
//
// "Every note is reachable by following links from the root index."
// Reachability is computed ONCE here, breadth first from index.md, over
// forEachInternalLink/resolveLinkPath (house.mjs, see this file's own
// header): a note reachable only from a note that is itself unreachable
// is unreachable, which a plain forward walk from one root already
// guarantees without any special case, since a node this walk never
// visits never gets the chance to hand reachability on to whatever it
// links to.
//
// A link that resolves to a DIRECTORY (classifyTargetPath's own
// 'directory' state) is followed into that directory's own index.md,
// when one exists in this walk: the format's own directory-link
// convention (section 8) is exactly how a root index is meant to point
// a reader at an entire subtree, and refusing to follow it would call
// every note under a directory-linked subtree an orphan regardless of
// how well the vault actually links deeper down.

const orphans = {
  id: 'orphans',
  settingKey: 'orphans',
  check(files, context) {
    if (!files.includes('index.md')) return []; // see judgment call 5 above
    const markdownFiles = new Set(files);
    const visited = new Set(['index.md']);
    const queue = ['index.md'];

    while (queue.length > 0) {
      const current = queue.shift();
      forEachInternalLink(current, context, (target, pathPart) => {
        const resolved = resolveLinkPath(current, pathPart);
        const state = classifyTargetPath(context.root, resolved, context.all);
        let next = null;
        if (state === 'in-walk' && markdownFiles.has(resolved)) {
          next = resolved;
        } else if (state === 'directory') {
          const dirIndex = indexPathFor(resolved);
          if (markdownFiles.has(dirIndex)) next = dirIndex;
        }
        if (next !== null && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      });
    }

    const findings = [];
    for (const file of files) {
      if (visited.has(file) || isReserved(file)) continue; // a reserved filename is never an orphan
      findings.push({ file, line: null, check: 'reachable-from-root', messageKey: 'lint.orphans.unreachable', params: {} });
    }
    return findings;
  },
};

// --- columns (lint.columns) ---------------------------------------------------------
//
// "A file named under taxonomy.files carries the exact column headings
// its configuration declares, in order." Comparison is by TRIMMED,
// CASE-SENSITIVE equality (the brief's own words), and this rule reports
// only the FIRST divergence, with both what was expected and what was
// actually found, because a message that says only "the columns differ"
// makes a person diff two tables by eye, the same failure this project's
// own link-target-exists rule was built to avoid by naming what a link
// actually resolved to.
//
// No table parser exists anywhere else in this codebase (grep confirms
// it): this is new work, not a second copy of something that must
// agree with a first, so it lives here rather than being exported from
// a sibling.

// Splits one table ROW ("| a | b |" or "a | b", either style is legal
// markdown) into its cell texts, on every unescaped pipe. A pipe
// character INSIDE a heading's own text (a literal "|" a vault owner
// actually wants as part of a column name) is a declined edge case, not
// a guessed one: splitting it into two cells produces an honest column
// COUNT mismatch this rule already reports (too many headings found),
// rather than a silent, unproven guess at which pipe was "real" table
// syntax and which was content. house.mjs's own link scanner makes the
// opposite call for markdown brackets, where escaping is common,
// well-understood syntax; a pipe inside a table heading is neither.
function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|');
}

const DELIMITER_CELL = /^:?-+:?$/;
// A table's delimiter row: every cell (split the same way a real header
// row is split), once trimmed, is a run of only dashes with an optional
// leading and/or trailing colon ("-", "---", ":--", "--:" or ":-:"), and
// there is at least one such cell. An empty cell (two adjacent pipes
// with nothing between) or the empty string overall is declined, not
// guessed at: neither is a delimiter, so a row of only pipes is not one
// either. This alone is also what tells a genuine delimiter row apart
// from a Setext heading underline or a thematic break ("---" on its own
// line): either of those, split as if it were a header row, still fails
// this per-cell check the moment its single "cell" carries anything
// this pattern does not allow, which for ordinary prose is always.
function isDelimiterRow(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  const cells = splitTableRow(trimmed).map((cell) => cell.trim());
  if (cells.length === 0 || cells.some((cell) => cell === '')) return false;
  return cells.every((cell) => DELIMITER_CELL.test(cell));
}

// The FIRST markdown table's header row in `strippedBody` (fenced,
// indented and inline code already blanked by the caller, exactly as
// house.mjs's link scanner requires of its own input): a line carrying
// a pipe, immediately followed by a real delimiter row. Requiring a
// pipe on the header line itself declines a headerless single-column
// table on purpose, the same declared trade-off house.mjs's own link
// scanner makes for shapes this format does not commit to one reading
// of: a bare "---" is far more likely to be a thematic break or a
// heading underline than the world's only pipe-free table, and this
// rule producing no finding for one is safer than guessing which it is.
// Returns null, never throws, when no table is found at all: an empty
// file, a file with prose only, and a file whose only table sits inside
// a fenced code example (already blanked before this function ever
// sees it) all take this path alike.
function findFirstTableHeader(strippedBody) {
  const lines = strippedBody.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|')) continue;
    if (!isDelimiterRow(lines[i + 1])) continue;
    return { headers: splitTableRow(lines[i]).map((cell) => cell.trim()), lineIndex: i };
  }
  return null;
}

const MISSING_HEADING_PLACEHOLDER = '(none)';

const columns = {
  id: 'columns',
  settingKey: 'columns',
  check(files, context) {
    const declaredColumns = context.config?.taxonomy?.columns ?? {};
    const declaredFiles = context.config?.taxonomy?.files ?? {};
    const findings = [];

    for (const key of Object.keys(declaredColumns)) {
      const path = declaredFiles[key];
      // Covers both "no file configured for this column set at all"
      // (path is null, per the schema's own ["string", "null"] shape for
      // taxonomy.files.<name>) and "the configured file does not exist in
      // this vault": Array.prototype.includes(null) and .includes('') are
      // both false, so a single check already declines both, and a
      // separate `if (!path) continue` first would be a clause this one
      // already makes unreachable. See judgment call 4 above.
      if (!files.includes(path)) continue;

      const expected = Object.values(declaredColumns[key]).map((value) => String(value).trim());
      const text = context.readFile(path);
      const { body } = splitFrontmatter(text);
      const stripped = stripCode(body);
      const table = findFirstTableHeader(stripped);

      if (table === null) {
        findings.push({ file: path, line: null, check: 'table-present', absence: true, messageKey: 'lint.columns.missing_table', params: {} });
        continue;
      }

      const found = table.headers;
      const width = Math.max(expected.length, found.length);
      for (let i = 0; i < width; i++) {
        const expectedHeading = expected[i];
        const foundHeading = found[i];
        if (expectedHeading === foundHeading) continue;
        findings.push({
          file: path,
          line: bodyPrefixLineCount(text, body) + table.lineIndex,
          check: 'columns-match',
          messageKey: 'lint.columns.mismatch',
          params: {
            index: i + 1,
            expected: expectedHeading ?? MISSING_HEADING_PLACEHOLDER,
            found: foundHeading ?? MISSING_HEADING_PLACEHOLDER,
          },
        });
        break; // only the FIRST difference, per this rule's own contract
      }
    }
    return findings;
  },
};

export const LINT_RULES = Object.freeze([indexCompleteness, orphans, columns]);

const VALID_SEVERITIES = new Set(['error', 'warn', 'off']);
const DEFAULT_SEVERITY = 'warn';

// The finding's severity, read from `lint.<settingKey>`: 'error', 'warn'
// or 'off' when the configuration names one of those three values
// explicitly, 'warn' for anything else at all, including a value the
// schema would itself reject (a malformed hand-built config in a test,
// or a config this function is handed before validation) - this rule
// module never trusts config shape and always has a safe default, the
// same posture every rule in house.mjs already takes for a setting it
// reads.
function severityFor(rule, config) {
  const value = config?.lint?.[rule.settingKey];
  return VALID_SEVERITIES.has(value) ? value : DEFAULT_SEVERITY;
}

// Runs every rule over `files`, in order, and returns their findings
// flattened into one array, each stamped with `ruler: 'lint'`, the id
// that produced it, its `check` (a stable name for the specific
// assertion inside the rule, mirroring house.mjs and spec.mjs), and a
// `severity` rather than a `level`: see this file's own header for why
// a health question belongs to neither of the format's two conformance
// tiers. A rule whose severity resolves to 'off' is never even called:
// `check` is skipped entirely, not called and filtered afterwards, so
// turning a rule off costs an adopter nothing, not even the walk that
// rule would have made.
//
// `scope` is accepted and handed to every rule uniformly, exactly as
// HOUSE_RULES and SPEC_RULES hand every rule the same `context`: none of
// the three rules in this task reads it (see this file's own header),
// but the runner does not know that and must not need to, so a future
// rule that DOES read scope (task 4) is one array entry away, not a
// change to this loop.
export function runLintRules(files, context, scope) {
  const findings = [];
  for (const rule of LINT_RULES) {
    const severity = severityFor(rule, context.config);
    if (severity === 'off') continue;
    for (const partial of rule.check(files, context, scope)) {
      findings.push({
        ruler: 'lint',
        id: rule.id,
        check: partial.check,
        severity,
        file: partial.file,
        line: partial.line,
        absence: partial.absence === true,
        messageKey: partial.messageKey,
        params: partial.params,
      });
    }
  }
  return findings;
}
