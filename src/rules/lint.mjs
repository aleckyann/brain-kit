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
// `forEachInternalLink`, `forEachWikilink`, `resolveLinkPath` and
// `bodyPrefixLineCount` from src/rules/house.mjs (exported there for
// exactly this reuse; see that file's own comments at each export)
// instead of writing a second link scanner, a second wikilink scanner, a
// second link-path normaliser or a second body-relative line counter.
// This codebase has already paid, more than once, for the alternative:
// house.mjs's own header describes a code stripper duplicated for
// "independence" that silently disagreed with the original, and this
// file's orphan rule and index-completeness rule both need to ask the
// exact question link-target-exists already answers correctly ("what
// vault path does this link resolve to, and does it exist"). Two
// implementations of that question are two chances to disagree about
// what a link is, which is worse than one shared answer, however that
// answer is spelled. `stripCode` (src/markdown.mjs), `splitFrontmatter`
// (src/frontmatter.mjs) and `isUnderPath`/`classifyTargetPath`
// (src/vault.mjs) are imported directly, exactly as house.mjs and
// spec.mjs already do, for the same reason.
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
// Fix round 1 (review of commit ce13e38), the shape of every correction
// worth stating up front rather than only where its diff lands:
//
// 1. CRITICAL. `taxonomy.columns.<file>` used to be one flat object
//    mixing the ordered headings of a real table with labels that are
//    not columns at all (a section heading, the text shown when a list
//    is empty), and this rule read every value in it as a literal
//    expected column. A review built the two-section file shape this
//    project's own configuration and its own incident record
//    (docs/incidents.md, "the column names are an interface between the
//    prompt and the note") describe, and got three `error`-severity
//    findings on three CORRECT files. Worse, this module's own fixtures
//    had passed only because they were written to match the
//    implementation rather than the format: a section heading spelled
//    as a seventh table column, because the code expected one there.
//    The configuration's shape is now `{ columns: [...ordered headings],
//    labels: {...everything else} }` (schema/config.schema.json, all
//    three fixtures), and the column rule below reads only `.columns`.
//    The array is deliberate, not incidental: the old shape's order came
//    from the order of keys in a parsed JSON object, an implicit
//    dependency on a parser's own behaviour this project has paid for
//    more than once already.
// 2. IMPORTANT. A directory link that reaches nothing used to produce an
//    orphan storm with no cause named: the root links a directory
//    holding no markdown directly, so the old direct-containment reading
//    of "every directory holding a markdown file has an index.md" never
//    asked for that directory's own index.md; link-target-exists stays
//    quiet because a directory target always resolves; and every note
//    underneath is reported unreachable, with no single finding saying
//    why. The fix is the containment reading itself: `directory-has-index`
//    now requires an index.md at EVERY directory on the path from the
//    root down to a note, not only a note's own direct parent (see
//    `ancestorDirs` below), which is what "root-links-directory" already
//    read as. The two readings agreeing is what makes the missing
//    index.md the one thing a person is told, instead of a count of
//    downstream notes it caused to look unreachable. A useful side
//    effect: a vault whose markdown lives only in subdirectories, with
//    no root index.md at all, is now reported at the root, which fix 5
//    (Undated, this list) needed to be true anyway.
// 3. IMPORTANT. Wikilinks are now followed by the orphan rule.
//    `validate.wikilinks` defaults to "allow" ("this is not an edge
//    case, it is the default"), and a note reached only through one used
//    to be called unreachable. `forEachWikilink` (house.mjs, exported
//    for this reuse) supplies the raw bracket text; this module records
//    its own resolution rule for that text below, since neither of
//    house.mjs's own two callers ever resolves one. Reference-style
//    links ("[A][a]" plus "[a]: target") are NOT followed: see the
//    declared trade-off below for why this is a disclosed limitation
//    rather than a second link-extraction system.
// 4. IMPORTANT. A note under `taxonomy.templates_dir` is no longer
//    reported as an orphan. A template is structure a vault ships with,
//    not content a reader navigates to, exactly the reasoning
//    house.mjs's own placeholder exemption already applies to the same
//    directory for a different rule.
// 5. IMPORTANT (Undated in this list because two reviews, not one,
//    argued about its actual cause). A vault with no root index.md at
//    all used to report almost nothing, on the strength of a
//    justification that did not hold for a vault whose markdown lived
//    only in subdirectories: `directDirs` only ever contained "." when
//    a markdown file sat directly at the root. Fix 2's ancestor-chain
//    reading of `directory-has-index` closes this too, since ANY
//    markdown file anywhere in the vault has "." among its ancestors.
//    The orphan rule's own early return on a missing root index (see
//    its own comment below) is correct in behaviour and now correct in
//    justification as well.
// 6. The column rule's table parser gained the escape handling this
//    round found was never dead (see splitTableRow's own comment): a
//    heading containing a literal "|" is written with it backslash-
//    escaped, established practice this project's own incident record
//    names for exactly this table contract, and comparing the escaped
//    form to the escaped form is the fix, not stripping it.
// 7. Two guards whose only job was preventing a crash had no test: the
//    early return on a missing root index.md (the same guard fix 5
//    revisits above), and a null or malformed `taxonomy.columns.<file>`
//    entry, which used to throw calling an object method on a value this
//    module's own header claimed, incorrectly, that it never trusted the
//    shape of. Both are guarded and tested now (see the column rule and
//    its own comment).
// 8. `missing_index` now carries `{ dir }`, matching `dir_not_linked`:
//    the directory a finding is ABOUT should not have to be inferred
//    from the file path that, by definition, does not exist.
// 9. `rootLinksDirectory` (a per-directory function that re-read and
//    re-scanned the root index once per first-level directory, with an
//    apology in its own comment about having no early-exit signal) is
//    now `rootLinkedPaths`, one pass building a set of every path the
//    root index links to, read once regardless of how many directories
//    there are to check against it.
//
// Judgment calls this module makes, each recorded here because neither
// the format nor the plan settles it:
//
// 1. A first-level directory counts as "linked" by the root index when
//    a link resolves to the directory itself (the format's own worked
//    example, "[Subdirectory](subdir/)", section 8) OR to that
//    directory's own index.md. Both are how a person actually writes
//    this link by hand; accepting only one would make the other, an
//    equally sound choice, into a false positive of this rule's own.
// 2. A configured file absent from the walk is skipped by the column
//    check, in silence: reporting a missing configured file is a
//    different claim ("this file should exist at all") from the one
//    this rule makes ("this file's table has the right headers"), and
//    this task does not add a fourth rule to make the first claim.
// 3. A wikilink's raw bracket text has no established target-resolution
//    rule anywhere in this codebase to reuse (see forEachWikilink's own
//    comment in house.mjs: neither of its other two callers ever
//    resolves one). This rule's own reading, used ONLY for reachability:
//    an alias ("[[target|Display text]]") is split on the first "|",
//    keeping only the target half. When that bare target already names
//    an extension ("[[people/bruno.md]]"), it is resolved as written,
//    through resolveLinkPath, the same function every other link kind in
//    this file goes through. When it does not, BOTH readings are tried
//    ("[[people]]" as the directory "people" AND as the file
//    "people.md"), since a wikilink's own syntax gives no way to tell
//    "this names a directory" from "this names a file whose extension I
//    am allowed to omit" apart in advance, and only whichever reading
//    actually resolves to something in this walk ever has an effect
//    (followLink is a no-op on the one that does not exist).
// 4. Reference-style links ("[A][a]" defined elsewhere as "[a]: target")
//    are a DECLARED trade-off, not a silent gap: house.mjs's own header
//    calls resolving them "a materially bigger feature" than balancing
//    brackets on one line, needing a second pass over the whole file to
//    collect every definition before a single usage can be read, and
//    declines them project-wide for that reason. Building that
//    resolution only inside this rule, while house.mjs's own
//    link-target-exists and link-style keep declining it, would be
//    exactly the two-implementations-disagreeing hazard this module's
//    own header opens by naming: a note reached only this way would be
//    "reachable" to this rule and invisible to every other one that
//    reads a link. A note reached only through a reference-style link is
//    still reported as an orphan; test/rules-lint.test.mjs pins this
//    down as accepted, not silent.
//
// Two limitations this module inherits rather than introduces, recorded
// here because the orphan rule's own message is the one a person will
// disbelieve if left unstated:
//
// - `classifyTargetPath` (src/vault.mjs) checks the walk set by exact
//   string first, then falls back to a filesystem stat. On a
//   case-insensitive filesystem (macOS default, Windows), a link whose
//   case does not match the real file's (`[A](People/A.md)` for
//   `people/a.md`) resolves as `unwalked` rather than `in-walk`: the
//   note is reported unreachable on a machine where the link plainly
//   works, alongside a separate, accurate `link_target_exists.unwalked`
//   finding. This is not fixable inside this module.
// - A vault whose OWN link syntax only THIS rule ever needs to resolve
//   (wikilinks, judgment call 3 above) means this rule's own
//   reachability answer can, in principle, disagree with what a link
//   actually points at in a real markdown renderer's own resolution
//   rule for the same bracket syntax, since none is standardised. This
//   is the cost of judgment call 3, paid once, here.
import { posix } from 'node:path';
import { bodyPrefixLineCount, forEachInternalLink, forEachWikilink, resolveLinkPath } from './house.mjs';
import { splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';
import { classifyTargetPath, isUnderPath } from '../vault.mjs';

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

// Every directory ON THE PATH from the vault root down to `file`'s own
// parent, not merely that immediate parent alone: for "a/b/c.md" this is
// ["a/b", "a", "."]. Fix round 1 (see this file's own header, item 2):
// requiring an index.md only at a file's DIRECT parent left every
// ANCESTOR directory free to have none, which is exactly the gap a
// directory link with nothing linkable behind it fell through. Every
// walk here terminates at ".", posix.dirname's own fixed point for the
// root, so the loop always ends.
function ancestorDirs(file) {
  const dirs = [];
  let current = posix.dirname(file);
  for (;;) {
    dirs.push(current);
    if (current === '.') return dirs;
    current = posix.dirname(current);
  }
}

// --- index-completeness (lint.index_completeness) --------------------------------

// Every vault path the root index links to, directly: a directory's own
// canonical spelling (classifyTargetPath's 'directory' state) or an
// ordinary file (its 'in-walk' state), collected in ONE pass over
// index.md's own links (fix round 1, item 9: this used to be a
// per-directory rescan, in a function once named rootLinksDirectory).
// The two accepted forms of "linked" (judgment call 1 above) are both
// membership tests against this one set, made where this is called: a
// bare directory link adds the directory's own path; a link straight to
// that directory's index.md adds that path instead, and either
// satisfies either check.
function rootLinkedPaths(context) {
  const linked = new Set();
  forEachInternalLink('index.md', context, (target, pathPart) => {
    const resolved = resolveLinkPath('index.md', pathPart);
    const state = classifyTargetPath(context.root, resolved, context.all);
    if (state === 'directory' || state === 'in-walk') linked.add(resolved);
  });
  return linked;
}

const indexCompleteness = {
  id: 'index-completeness',
  settingKey: 'index_completeness',
  check(files, context) {
    const findings = [];

    // Clause 1: every directory ON THE PATH to any markdown file has its
    // own index.md (ancestorDirs, fix round 1 item 2). "." (the vault
    // root) is among these ancestors for every file in the vault, so a
    // vault with no root index.md at all is always caught here, however
    // deep its own markdown actually lives (fix round 1 item 5).
    const requiredDirs = new Set();
    for (const file of files) {
      for (const dir of ancestorDirs(file)) requiredDirs.add(dir);
    }
    for (const dir of [...requiredDirs].sort()) {
      const indexPath = indexPathFor(dir);
      if (!files.includes(indexPath)) {
        findings.push({
          file: indexPath,
          line: null,
          check: 'directory-has-index',
          absence: true,
          messageKey: 'lint.index_completeness.missing_index',
          params: { dir },
        });
      }
    }

    // Clause 2: the root index links every first-level directory whose
    // subtree holds any markdown note at all. With no root index to read
    // at all, there is nothing left to check here; its own absence was
    // already reported by clause 1 above, for every file in the vault.
    if (!files.includes('index.md')) return findings;
    const firstLevelDirs = new Set();
    for (const file of files) {
      const dir = posix.dirname(file);
      if (dir === '.') continue;
      firstLevelDirs.add(dir.split('/')[0]);
    }
    const rootLinks = rootLinkedPaths(context);
    for (const dir of [...firstLevelDirs].sort()) {
      if (!rootLinks.has(dir) && !rootLinks.has(indexPathFor(dir))) {
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
// forEachInternalLink/forEachWikilink/resolveLinkPath (house.mjs, see
// this file's own header): a note reachable only from a note that is
// itself unreachable is unreachable, which a plain forward walk from one
// root already guarantees without any special case, since a node this
// walk never visits never gets the chance to hand reachability on to
// whatever it links to.
//
// A link that resolves to a DIRECTORY (classifyTargetPath's own
// 'directory' state) is followed into that directory's own index.md,
// when one exists in this walk: the format's own directory-link
// convention (section 8) is exactly how a root index is meant to point
// a reader at an entire subtree, and refusing to follow it would call
// every note under a directory-linked subtree an orphan regardless of
// how well the vault actually links deeper down.

// Resolves one candidate path part (from either an ordinary link or a
// wikilink, see wikilinkPathParts below) against `current`, and hands the
// vault path it reaches, if any, to `onReach`: `resolved` itself when it
// names a real markdown file in this walk, or that directory's own
// index.md when `resolved` names a directory that has one. Shared by
// both link kinds so the two can never independently drift on what
// "reaches a note" means.
function followLink(current, pathPart, markdownFiles, context, onReach) {
  const resolved = resolveLinkPath(current, pathPart);
  const state = classifyTargetPath(context.root, resolved, context.all);
  if (state === 'in-walk' && markdownFiles.has(resolved)) {
    onReach(resolved);
  } else if (state === 'directory') {
    const dirIndex = indexPathFor(resolved);
    if (markdownFiles.has(dirIndex)) onReach(dirIndex);
  }
}

// A wikilink's target, turned into every path part worth trying against
// resolveLinkPath (see judgment call 3 above for the rule this applies):
// none at all for a bare "[[]]" or an alias with nothing before its own
// "|"; the target exactly as written when it already names an
// extension; both the bare target AND the target with ".md" appended
// otherwise, since "[[people]]" and "[[bruno]]" are both real, common
// shapes and nothing in wikilink syntax itself says which one a given
// target is.
function wikilinkPathParts(rawTarget) {
  const target = rawTarget.split('|')[0].trim();
  if (target === '') return [];
  if (posix.extname(target) !== '') return [target];
  return [target, `${target}.md`];
}

const orphans = {
  id: 'orphans',
  settingKey: 'orphans',
  check(files, context) {
    // With no root index to start a walk from, every file would be
    // "unreachable" for the same one reason; index-completeness now
    // reports that reason directly, for every file's own ancestor chain
    // (fix round 1 item 5), so this rule says nothing rather than
    // restating it once per file in the vault.
    if (!files.includes('index.md')) return [];
    const markdownFiles = new Set(files);
    const visited = new Set(['index.md']);
    const queue = ['index.md'];

    const visitNext = (next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    };

    while (queue.length > 0) {
      const current = queue.shift();
      forEachInternalLink(current, context, (target, pathPart) => {
        followLink(current, pathPart, markdownFiles, context, visitNext);
      });
      forEachWikilink(current, context, (rawTarget) => {
        for (const pathPart of wikilinkPathParts(rawTarget)) {
          followLink(current, pathPart, markdownFiles, context, visitNext);
        }
      });
    }

    const templatesDir = context.config?.taxonomy?.templates_dir;
    const findings = [];
    for (const file of files) {
      if (visited.has(file)) continue;
      if (isReserved(file)) continue; // structure, not content, however unreachable
      if (isUnderPath(file, templatesDir)) continue; // a template is not a note a reader navigates to
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
// markdown) into its cell texts, treating a backslash-escaped pipe as
// literal content rather than a cell boundary, and leaving the escape
// itself in place rather than stripping it. Fix round 1: an earlier
// version of this function split on every pipe unconditionally, on the
// argument that the escaping this restores was an untested, guessable
// feature rather than a real one. That argument was wrong: this
// project's own docs/incidents.md records, for the exact table contract
// this rule checks, that a heading containing the separator character is
// written with it backslash-escaped, and matched in that SAME escaped
// form, not unescaped first ("keep it escaped to write and to match in a
// markdown table"). Comparing an escaped heading to an unescaped read of
// the same text is a false mismatch on a file that is correct, which is
// a behaviour change, not dead code: mutating this clause away changes
// what a real, established heading shape reads as.
function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  const cells = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

const DELIMITER_CELL = /^:?-+:?$/;
// A table's delimiter row: every cell (split the same way a real header
// row is split), once trimmed, is a run of only dashes with an optional
// leading and/or trailing colon ("-", "---", ":--", "--:" or ":-:").
// Fix round 1: this used to also guard "at least one cell" and "no cell
// is the empty string" before this final check, on the theory that an
// empty split or an empty cell needed a separate refusal. Neither guard
// was reachable in effect: String.prototype.split never returns an empty
// array, so the first could never fire; and DELIMITER_CELL never matches
// the empty string either, so `every` below already returns false the
// moment a cell is blank, with or without a guard naming that case
// specially. Removed rather than left in place looking like two
// defences when the one check below already is the whole defence. A
// third, found by this same round's own mutation pass rather than
// carried over from the last one: this function used to trim `line`
// itself before handing it to splitTableRow, which trims its OWN
// argument as its very first step (needed there for a table row's
// leading indentation, a shape splitTableRow's own header row caller
// never pre-trims). Once that trim existed, trimming twice before it
// could tell the difference was never reachable either.
function isDelimiterRow(line) {
  const cells = splitTableRow(line).map((cell) => cell.trim());
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
// file, a file with prose only, a file whose only table sits inside a
// fenced code example (already blanked before this function ever sees
// it), and a file whose very LAST line contains a pipe with nothing
// after it (the `lines.length - 1` bound below stops the loop one line
// early for exactly this shape, so `lines[i + 1]` is never read past the
// end of the array) all take this path alike.
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

// The declared column set for one `taxonomy.columns.<key>` entry, or
// null when there is nothing usable to check against: the key is not
// configured at all, or (fix round 1, item 7) the entry is malformed in
// a way `loadConfig`'s schema would reject but this module's own header
// still promises never to crash on, since the test suite itself already
// builds contexts that bypass loadConfig entirely. `Object.values`,
// `Array.isArray` and every other object operation in the caller below
// only ever run once this has confirmed there is a real array to read.
function declaredHeadings(columnsConfig, key) {
  const spec = columnsConfig[key];
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.columns)) return null;
  return spec.columns.map((value) => String(value).trim());
}

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
      // already makes unreachable. See judgment call 2 above.
      if (!files.includes(path)) continue;

      const expected = declaredHeadings(declaredColumns, key);
      if (expected === null) continue; // malformed or absent column contract: nothing to check

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

// The finding's severity, read from `lint.<rule.settingKey>` (NOT
// `rule.id`: index-completeness is the one rule in this array whose
// setting name differs from its id, "index_completeness" against
// "index-completeness", and the two must never be conflated here even
// though every other rule's id and settingKey happen to read the same):
// 'error', 'warn' or 'off' when the configuration names one of those
// three values explicitly, 'warn' for anything else at all, including a
// value the schema would itself reject (a malformed hand-built config in
// a test, or a config this function is handed before validation) - this
// rule module never trusts config shape and always has a safe default,
// the same posture every rule in house.mjs already takes for a setting
// it reads.
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
