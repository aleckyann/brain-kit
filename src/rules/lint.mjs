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
//
// --- Task 5: the safety rules (secrets, privacy, attribution), and one
// configuration-shape fix carried ahead of them ---------------------------
//
// The fix, first, because the three rules below need somewhere to put
// their own settings and would otherwise have invented a fourth shape
// for it. Before this task, seven rules read `lint.<rule>` as a bare
// severity string, `style` was an object with NO severity field at all
// (permanently 'warn', with no way to turn it to 'error' or 'off'), and
// `tables_limits` sat beside `lint.tables` as a sibling key that was not
// a rule's own setting at all. `lint.<rule>` now accepts EITHER a bare
// severity string OR an object carrying `severity` plus that rule's own
// settings (see severityFor's own comment, below every rule
// definition), `tables_limits` folded into `tables.max_cell_chars` and
// `tables.duplicate_rows`, and the schema and all three configuration
// fixtures follow. This is the same defect as the columns object one
// task earlier (this file's own fix round 1, item 1), in different
// clothes: a configuration shape that makes one kind of thing
// impossible to say.
//
// The three rules themselves, each documented at its own definition
// below (search "--- secrets", "--- privacy", "--- attribution"):
// `secrets` calls src/leak.mjs and never writes its own regular
// expression, is scoped to added lines like `style`, and defaults to
// 'error' where every other rule defaults to 'warn'. `privacy` reads
// `privacy.confidential_dirs` and judges the whole vault, like
// index-completeness, orphans and columns. `attribution` is the only
// rule in this file that cites the Open Knowledge Format directly
// (section 5.1), and also judges the whole vault.
import { posix } from 'node:path';
import { bodyPrefixLineCount, forEachInternalLink, forEachWikilink, resolveLinkPath } from './house.mjs';
import { frontmatterKeyLine, readEntries, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';
import { classifyTargetPath, isUnderPath } from '../vault.mjs';
import { loadPatterns, scanText } from '../leak.mjs';

const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

// A second copy of house.mjs's own private isBlank, not an export
// reused from there: the same trivial, two-line, no-drift-possible
// duplication this file's own header already accepts for
// RESERVED_FILENAMES/isReserved, for the identical reason.
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
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

// --- tables (lint.tables, lint.tables.max_cell_chars, lint.tables.duplicate_rows) ---
//
// "A table is preceded by a blank line, carries no duplicated data row,
// and no cell exceeds max_cell_chars." Ported from a real awk one-liner
// (this slice's own plan, "the awk check for a split table"), which read
// a whole tracked file every run with no notion of which line was old
// and which was new. This is one of only two rules in LINT_RULES that
// reads `scope` at all (style, below, is the other), for the identical
// reason style needs it: a vault that adopts this kit arrives with
// tables written under no such rule, and a table check that reports
// every old table on its first run is exactly the linter someone
// switches off in its first minute. A table is judged only when at
// least one of its OWN lines (its header, its delimiter, or any of its
// data rows) is a line the scope says this change added; a table none
// of whose lines were touched is left alone in silence, however
// malformed, the same silence the style rule below keeps for an
// untouched line.
//
// A table found entirely inside a fenced or indented code block is not
// found at all: the table scanner below reads `stripCode`
// (src/markdown.mjs, already imported above for the columns rule), the
// SAME call every other rule in this file already goes through, applied
// before it ever looks for a pipe. A blanked fence line has no pipe
// left in it to be mistaken for one; this is not a second
// code-detection implementation choosing to agree with the first, it is
// the one shared call.
//
// Three independent checks share one table scan:
// - blank-line-before-table: the line immediately before a table's own
//   header row must be blank, unless the header is the very first line
//   of the body, with nothing before it to require a blank line from.
// - duplicate-row: two data rows in the SAME table whose cells, once
//   each is trimmed, read identically are a duplicate, reported at the
//   LATER row's own line. Trimming is what makes a row differing only
//   in trailing whitespace a duplicate, a case this task's own brief
//   names explicitly. `splitTableRow` (above, already honouring an
//   escaped pipe as literal content) is reused rather than a second,
//   simpler row split that could disagree with it on that escape.
// - cell-too-long: any cell (header or data), once trimmed, longer than
//   `lint.tables.max_cell_chars` is reported at its own row's
//   line, naming the first offending cell only: the same "first
//   divergence" discipline the columns rule above already follows,
//   because a message naming every offense on a row at once is worse
//   than one a person can fix and re-run against. A missing or
//   non-positive `max_cell_chars` disables this one check rather than
//   assuming a made-up limit nothing in this project ever declared
//   (the same silent-skip posture columns' own judgment call 2 takes
//   for a configured file absent from the walk).
//
// `lint.tables.duplicate_rows` is a SEPARATE severity from
// `lint.tables` itself: the configuration's own schema
// (schema/config.schema.json) gives duplicate-row detection its own
// error/warn/off knob, distinct from the blank-line and cell-length
// checks this same rule also makes. A finding this check returns
// therefore carries its own `severity` field, which runLintRules
// (below) reads in PREFERENCE to the one rule-level severity it computes
// for everything else a rule returns. That preference is the one thing
// added to runLintRules for this; every other rule leaves `severity`
// off its own findings and is unaffected.
function normalizedRowCells(cells) {
  return cells.map((cell) => cell.trim());
}

function rowKey(cells) {
  return JSON.stringify(normalizedRowCells(cells));
}

// Every markdown table in `strippedBody` (fenced, indented and inline
// code already blanked by the caller): a header row, its delimiter, and
// every immediately following non-blank line that itself carries a
// pipe. Unlike findFirstTableHeader above (columns' own single-table,
// single-file need), this collects every table in the text, in order,
// because a lint pass has to judge every table a file carries, not only
// the vault's one configured one. Both share the same row-level reading
// of "is this a table" (a pipe on the header line, a real delimiter row
// right after it, via the same splitTableRow/isDelimiterRow above), so
// the two can never disagree about what a table IS, only about how many
// of them a given call is asked to enumerate.
function findAllTables(strippedBody) {
  const lines = strippedBody.split('\n');
  const found = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (!lines[i].includes('|') || !isDelimiterRow(lines[i + 1])) {
      i++;
      continue;
    }
    const headerLineIndex = i;
    const dataRows = [];
    let j = i + 2;
    // A data row must carry a pipe; a blank line never does (trimming a
    // line that contains a pipe can never produce the empty string), so
    // requiring a pipe here already stops the scan at a blank line too,
    // with no separate blank check needed beside it.
    while (j < lines.length && lines[j].includes('|')) {
      dataRows.push({ lineIndex: j, cells: splitTableRow(lines[j]) });
      j++;
    }
    found.push({
      headerLineIndex,
      delimiterLineIndex: i + 1,
      headerCells: splitTableRow(lines[headerLineIndex]),
      dataRows,
    });
    i = j;
  }
  return found;
}

// True when `bodyLineIndex` (0-based, relative to the same stripped body
// findAllTables read) is a line the scope says this change added, or
// when the scope carries no restriction for this file at all (`null`,
// the untracked-file and "all" reading; see src/git.mjs's own header).
function lineIsInScope(scope, file, prefixLineCount, bodyLineIndex) {
  const added = scope.addedLines(file);
  return added === null || added.has(prefixLineCount + bodyLineIndex);
}

const tables = {
  id: 'tables',
  settingKey: 'tables',
  check(files, context, scope) {
    const findings = [];
    const maxCellCharsRaw = context.config?.lint?.tables?.max_cell_chars;
    const maxCellChars = Number.isInteger(maxCellCharsRaw) && maxCellCharsRaw > 0 ? maxCellCharsRaw : null;
    // Fix (review of this task's own severity-shape change): an
    // unconfigured `duplicate_rows` used to fall back to the module's
    // flat DEFAULT_SEVERITY ('warn') no matter what `lint.tables` itself
    // resolved to, so setting the WHOLE rule to 'error' silently left
    // every duplicate-row finding at 'warn' unless an adopter ALSO named
    // `duplicate_rows` explicitly. `duplicate_rows` is a genuine
    // override, not an independent setting with its own default: when
    // absent, it inherits `tables`'s OWN resolved severity (via
    // severityFor, below, called with `tables` itself rather than a
    // second copy of that resolution), so "set the rule to error" reads
    // as "everything this rule reports is an error" unless something
    // more specific says otherwise, and "off" (the one case this must
    // still refuse to silently escalate) is guarded separately below by
    // the check `duplicateSeverity !== 'off'`, never by this fallback.
    const duplicateSeverityRaw = context.config?.lint?.tables?.duplicate_rows;
    const duplicateSeverity = VALID_SEVERITIES.has(duplicateSeverityRaw) ? duplicateSeverityRaw : severityFor(tables, context.config);

    for (const file of files) {
      const text = context.readFile(file);
      const { body } = splitFrontmatter(text);
      const stripped = stripCode(body);
      const bodyLines = stripped.split('\n');
      const prefixLineCount = bodyPrefixLineCount(text, body);

      for (const table of findAllTables(stripped)) {
        const ownLineIndices = [table.headerLineIndex, table.delimiterLineIndex, ...table.dataRows.map((row) => row.lineIndex)];
        const inScope = ownLineIndices.some((idx) => lineIsInScope(scope, file, prefixLineCount, idx));
        if (!inScope) continue; // every one of this table's own lines already existed before this change

        if (table.headerLineIndex > 0 && bodyLines[table.headerLineIndex - 1].trim() !== '') {
          findings.push({
            file,
            line: prefixLineCount + table.headerLineIndex,
            check: 'blank-line-before-table',
            messageKey: 'lint.tables.missing_blank_line',
            params: {},
          });
        }

        if (duplicateSeverity !== 'off') {
          const seenAt = new Map();
          for (const row of table.dataRows) {
            const key = rowKey(row.cells);
            const firstLineIndex = seenAt.get(key);
            if (firstLineIndex !== undefined) {
              findings.push({
                file,
                line: prefixLineCount + row.lineIndex,
                check: 'duplicate-row',
                severity: duplicateSeverity,
                messageKey: 'lint.tables.duplicate_row',
                params: { line: prefixLineCount + firstLineIndex },
              });
            } else {
              seenAt.set(key, row.lineIndex);
            }
          }
        }

        if (maxCellChars !== null) {
          const rowsToCheck = [{ lineIndex: table.headerLineIndex, cells: table.headerCells }, ...table.dataRows];
          for (const row of rowsToCheck) {
            const cells = normalizedRowCells(row.cells);
            const overIndex = cells.findIndex((cell) => cell.length > maxCellChars);
            if (overIndex !== -1) {
              findings.push({
                file,
                line: prefixLineCount + row.lineIndex,
                check: 'cell-too-long',
                messageKey: 'lint.tables.cell_too_long',
                params: { index: overIndex + 1, length: cells[overIndex].length, max: maxCellChars },
              });
            }
          }
        }
      }
    }
    return findings;
  },
};

// --- style (lint.style.forbidden_chars) ----------------------------------------------
//
// "No forbidden character appears, judged ONLY on lines the scope says
// were added." Ported from the reference vault's own morning-briefing
// style lock, whose own history already taught this lesson once: the
// lock counted only added lines, for the exact reason tables' own
// header above restates, years of prose written before the rule existed
// must not all light up red the day a vault adopts it. This rule is why
// the scope contract (src/git.mjs) exists at all.
//
// One finding per (file, line): a line is reported at most once here
// even when it carries more than one forbidden character, or the same
// one twice, naming whichever configured character occurs FIRST reading
// left to right. The same "first divergence" discipline columns and
// tables both already follow above, for the same reason: a message
// naming every occurrence on a line at once is worse than one a person
// can fix and re-run against.
//
// stripCode runs over the WHOLE file text here, frontmatter included,
// not merely the body findAllTables and the columns rule restrict
// themselves to: this rule's own line numbers must match, one for one,
// the full-file line numbers scope.addedLines already reports (a git
// diff always counts whole-file lines), so there is no body-prefix
// offset to add back on here, unlike every other rule in this module
// that reports a line inside a specific known section of the file.
//
// A forbidden character inside a fenced or indented code block, or an
// inline code span, is never a finding: stripCode blanks all three
// before this rule ever looks at a line, because an example that
// documents the very character this rule forbids must still be
// quotable (the same reasoning tables' own header states for a table
// inside a fenced block).
const style = {
  id: 'style',
  settingKey: 'style',
  check(files, context, scope) {
    const configuredChars = context.config?.lint?.style?.forbidden_chars;
    const forbiddenChars = Array.isArray(configuredChars) ? configuredChars.filter((c) => typeof c === 'string' && c.length > 0) : [];
    // Both early exits below are unfalsifiable by any OUTPUT this
    // function can produce: the per-line loop already reads `added.has`
    // and `forbiddenChars` the same way either exit shortcuts, so
    // removing either one changes no finding this rule ever returns, in
    // any fixture. They are kept anyway, deliberately, for what they are
    // not dead FOR: the first skips readFile+stripCode for every file in
    // the vault when style has nothing configured to look for at all,
    // and the second skips the same per file this change never touched.
    // Neither is defended by a test that could tell its removal apart
    // from keeping it; a mutation of either survives the whole suite.
    if (forbiddenChars.length === 0) return [];

    const findings = [];
    for (const file of files) {
      const added = scope.addedLines(file);
      if (added !== null && added.size === 0) continue; // this change added nothing at all in this file: skip the read
      const lines = stripCode(context.readFile(file)).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        if (added !== null && !added.has(lineNumber)) continue;
        let firstChar = null;
        let firstIndex = Infinity;
        for (const char of forbiddenChars) {
          const idx = lines[i].indexOf(char);
          if (idx !== -1 && idx < firstIndex) {
            firstIndex = idx;
            firstChar = char;
          }
        }
        if (firstChar !== null) {
          findings.push({
            file,
            line: lineNumber,
            check: 'forbidden-char',
            messageKey: 'lint.style.forbidden_char',
            params: { char: firstChar },
          });
        }
      }
    }
    return findings;
  },
};

// --- secrets (lint.secrets, privacy.secret_patterns) --------------------------------
//
// "No secret pattern appears on an added line." The one rule in this
// module whose failure cannot be undone, so it is the one with the
// strictest contract, and its own defaultSeverity below (see
// severityFor) is 'error' where every other rule in this file defaults
// to 'warn': a warning about a leaked credential is a leaked
// credential, already out, whatever this tool goes on to say about it.
// An adopter who never touches lint.secrets still gets a failing run
// the day one appears, not one line among warnings a busy person skims
// past.
//
// This rule calls src/leak.mjs (loadPatterns, scanText) and writes NO
// regular expression of its own: that module took two review rounds and
// three fix rounds to earn its one hard guarantee (never print what it
// found), and a second, independent pattern-matching implementation
// here would be a second chance to disagree with it, exactly the hazard
// this file's own header already names for a link scanner and a code
// stripper. GENERIC_PATTERNS (a private key header, the two GitHub
// token shapes, the Anthropic key shape, the AWS access key id shape,
// the Slack token shapes) are always applied, on top of whatever the
// vault's own `privacy.secret_patterns` adds.
//
// Personal patterns (BRAIN_KIT_LEAK_PATTERNS, read by loadPatterns only
// when a caller passes an `env`) are deliberately NEVER loaded here:
// this rule runs as part of an ordinary `brain-kit lint` invocation, on
// whatever machine that happens to be, and a personal file missing,
// empty or unreadable makes loadPatterns THROW by design (leak.mjs's
// own fail-closed contract). Wiring that into every lint run would turn
// a file that exists on one maintainer's own machine, for that
// maintainer's own push gate, into a hard requirement for every
// adopter's `lint` command everywhere else it does not exist. The push
// gate (a later task) is the one caller with reason to ask for the
// personal list, because refusing a PUSH over a missing personal file
// is exactly what that gate exists to do; refusing an ordinary lint run
// over the same absent file would not be failing closed, it would be
// breaking lint on every machine that never had a reason to have one.
//
// Scoped to added lines, like style, and for the same reason (see that
// rule's own header above): a vault adopting this kit arrives with
// years of prose already committed, and a scanner that reports every
// pre-existing match on day one is exactly the linter someone switches
// off in its first minute. `blankLinesOutsideScope` below turns every
// line NOT in scope into an empty string while leaving the file's own
// line COUNT unchanged, so scanText's own line numbers still land on
// the correct whole-file line without this rule reimplementing
// scanText's own line-splitting or column arithmetic.
//
// Deliberately NOT run through stripCode first, unlike every other rule
// in this file that reads a note's own prose: a secret pasted inside a
// fenced code example ("here is my .env file") is still a leaked
// secret, and treating a fence as automatically safe here would open
// exactly the blind spot stripCode exists to create ON PURPOSE for
// style and for tables, where an example legitimately needs to stay
// quotable. A secret is never an example.
//
// A compile failure in the vault's OWN `privacy.secret_patterns` (an
// invalid regular expression) is allowed to escape this rule as an
// exception rather than being swallowed into a soft finding:
// leak.mjs's own contract for a pattern that fails to compile is to
// raise, naming the pattern, because "a skipped pattern is a hole
// nobody sees" (leak.mjs's own header), and silently continuing a scan
// with fewer patterns than the vault configured is exactly that hole.
// Every OTHER rule in this file declines a malformed setting in silence
// (see e.g. the columns rule's own comment on a malformed
// taxonomy.columns entry); this one does not, because the two silences
// cost differently: a malformed column contract produces a wrong
// report about formatting, a silently narrowed secrets scan produces a
// wrong report about whether a credential is safe to push.
//
// The finding's own message carries ONLY the pattern that matched
// (`match.pattern`, always the safe, public form here: this rule's own
// pattern list is generic-plus-config, never personal, so
// displayPattern in leak.mjs never has occasion to substitute the
// neutral personal label for anything this rule reports) and points at
// SECURITY.md, this project's own incident-response document. It NEVER
// carries `match.excerpt`: even a redacted excerpt is text derived from
// the file's own content, and the one thing this rule must never do is
// put content derived from a match into a log, a terminal or a CI
// record. "Only which rule matched and where" is the finding's whole
// message; there is no third field.
function blankLinesOutsideScope(text, addedLines) {
  return text
    .split('\n')
    .map((line, index) => (addedLines.has(index + 1) ? line : ''))
    .join('\n');
}

const secrets = {
  id: 'secrets',
  settingKey: 'secrets',
  defaultSeverity: 'error',
  check(files, context, scope) {
    const configuredPatterns = context.config?.privacy?.secret_patterns;
    const configPatterns = Array.isArray(configuredPatterns) ? configuredPatterns.filter((p) => typeof p === 'string') : [];
    const patterns = loadPatterns({ configPatterns });

    const findings = [];
    for (const file of files) {
      const addedLines = scope.addedLines(file);
      if (addedLines !== null && addedLines.size === 0) continue; // this change added nothing at all in this file: skip the read, like style above
      const text = context.readFile(file);
      const scanned = addedLines === null ? text : blankLinesOutsideScope(text, addedLines);
      const { matches } = scanText(scanned, patterns);
      for (const match of matches) {
        findings.push({
          file,
          line: match.line,
          check: 'secret-pattern',
          messageKey: 'lint.secrets.pattern_matched',
          params: { pattern: match.pattern },
        });
      }
    }
    return findings;
  },
};

// --- privacy (lint.privacy, privacy.confidential_dirs) -------------------------------
//
// Two symmetric leaks, both about the one boundary the vault's own
// configuration draws with `privacy.confidential_dirs`: a set of
// directories the vault owner has already decided hold something that
// must not travel further than that directory's own edge.
//
// Clause 1: a note under a confidential directory must never be linked
// TO from a file that itself sits OUTSIDE every confidential directory.
// A file outside the boundary is, by construction, a file the vault
// owner treats as safe to read, quote or share more broadly than
// whatever lives inside the boundary; a link from it into a
// confidential path leaks the confidential note's own PATH (and,
// depending on how the link renders, its title or a preview) to
// exactly the audience the boundary exists to keep it from. Judgment
// call: the target's path text is checked with the same isUnderPath
// prefix test the vault's own configuration already uses to declare the
// boundary, whether or not the target actually resolves to a real file
// in this walk (classifyTargetPath is not consulted here at all): a
// link into a confidential-shaped path that happens to be broken still
// leaks a name and an intent, so this rule does not first ask whether
// the target is real before judging where it points.
//
// Clause 2: a note OUTSIDE every confidential directory must not carry
// `confidential: true` in its own frontmatter (frontmatter.extensions'
// own "confidential" field, declared boolean in this project's example
// configuration). A note that marks itself confidential but lives
// outside the one boundary the vault's tooling and its owner both
// already treat as confidential is exactly the shape of file a
// directory-level access control, a sync rule or a sharing habit built
// around `privacy.confidential_dirs` will never actually protect: the
// field says "handle me carefully" in a place nothing else agrees is
// careful.
//
// Both clauses read the FULL vault, like index-completeness, orphans
// and columns (this file's own header): "is this note's own directory,
// or the directory of whatever it links to, inside the boundary" is a
// question about the vault's whole shape, not about what one change
// happened to touch, and scoping either clause to added lines would let
// an old, already-committed leak go unreported forever the moment its
// own line stopped being "added".
//
// Link scanning reuses forEachInternalLink, forEachWikilink,
// resolveLinkPath and wikilinkPathParts exactly as the orphan rule does
// above, for the identical reason: two independent readings of "what
// does this link resolve to" are two chances to disagree about it.
//
// Judgment call, found while writing this rule's own fixtures against
// index-completeness's own contract rather than against this rule in
// isolation: the format's OWN required way to point a reader at an
// entire confidential subtree is a bare directory link or a link
// straight to that directory's own index.md ("[People](people/)",
// exactly the shape index-completeness's own judgment call 1, above,
// already accepts as "linking the directory"). If clause 1 flagged
// that link as a leak, this rule would contradict index-completeness's
// own requirement that the root link every first-level directory,
// confidential ones included: a vault could never simultaneously
// satisfy both rules. `isConfidentialContent` below is therefore
// STRICTER than `isUnderAnyConfidentialDir`: a link into the boundary's
// own front door (the bare directory, or a reserved filename anywhere
// under it, `index.md`/`log.md` per this file's own RESERVED_FILENAMES,
// "structure, not content" exactly as the orphan rule already treats
// them) is not itself a leak of any one note's identity; a link PAST
// that front door, into a specific note, is.
function isUnderAnyConfidentialDir(file, confidentialDirs) {
  return confidentialDirs.some((dir) => isUnderPath(file, dir));
}

function isConfidentialContent(path, confidentialDirs) {
  const strictlyInside = confidentialDirs.some((dir) => {
    const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    return normalized !== '' && path.startsWith(`${normalized}/`);
  });
  return strictlyInside && !isReserved(path);
}

function reportLinkIntoConfidential(findings, file, target, line) {
  findings.push({
    file,
    line,
    check: 'link-into-confidential',
    messageKey: 'lint.privacy.linked_into_confidential',
    params: { target },
  });
}

const privacy = {
  id: 'privacy',
  settingKey: 'privacy',
  check(files, context) {
    const findings = [];
    const configuredDirs = context.config?.privacy?.confidential_dirs;
    const confidentialDirs = Array.isArray(configuredDirs) ? configuredDirs.filter((d) => typeof d === 'string' && d.length > 0) : [];
    if (confidentialDirs.length === 0) return findings; // nothing declared confidential: nothing for either clause to check against

    for (const file of files) {
      if (isUnderAnyConfidentialDir(file, confidentialDirs)) continue; // only a file OUTSIDE the boundary can leak across it

      forEachInternalLink(file, context, (target, pathPart, fileLine) => {
        const resolved = resolveLinkPath(file, pathPart);
        if (isConfidentialContent(resolved, confidentialDirs)) reportLinkIntoConfidential(findings, file, resolved, fileLine);
      });
      forEachWikilink(file, context, (rawTarget, fileLine) => {
        for (const pathPart of wikilinkPathParts(rawTarget)) {
          const resolved = resolveLinkPath(file, pathPart);
          if (isConfidentialContent(resolved, confidentialDirs)) reportLinkIntoConfidential(findings, file, resolved, fileLine);
        }
      });

      const { frontmatter } = splitFrontmatter(context.readFile(file));
      if (readScalar(frontmatter, 'confidential') === 'true') {
        findings.push({
          file,
          line: frontmatterKeyLine(frontmatter, 'confidential'),
          check: 'confidential-field-outside',
          messageKey: 'lint.privacy.confidential_outside',
          params: {},
        });
      }
    }
    return findings;
  },
};

// --- attribution (lint.attribution) ---------------------------------------------------
//
// "A note whose sources carries more than one entry anchors each claim
// that crosses sources with a footnote whose key matches a source id."
// Open Knowledge Format, section 5.1: the only rule in this file that
// reads the format directly rather than a house convention layered on
// top of it (every other rule here cites this file's own header, or a
// house record such as docs/incidents.md, instead). This rule never
// re-reports what src/rules/spec.mjs's own sourcesResource rule (5.1)
// already covers there: a non-blank `resource` and a well-formed
// `last_modified` per entry. This rule only ever reads `sources` for
// its own ids, never for those two fields.
//
// "Anchors each claim" cannot be verified by reading which SENTENCE a
// fact came from: that is a judgment about meaning, not a shape this
// rule can check. What IS a shape: every declared source has an id a
// footnote could name, and every id that is declared is actually named
// by at least one footnote somewhere in the body. A source nobody ever
// footnotes is, definitionally, a source no claim in the body is
// anchored to; a footnote key naming no declared source is a typo or a
// stale reference, exactly what "a footnote whose key matches a source
// id" rules out. Together these two checks are the closest a
// shape-only reader gets to "each claim crossing sources is anchored"
// without pretending to read the prose itself.
//
// Skips entirely when `sources` carries fewer than two entries (this
// task's own brief, verbatim: "a single source needs no
// disambiguation") or is absent, or is not the block-of-mappings shape
// readEntries expects at all: an unreadable `sources` is
// sourcesResource's own concern to report, not this rule's to report a
// second time under a different messageKey.
//
// A footnote REFERENCE ("...as Bruno mentioned[^bruno]...") anchors a
// claim; a footnote DEFINITION ("[^bruno]: said on the call") only
// gives that key its text and anchors nothing by itself. The two are
// told apart by position: a definition is the shape "[^key]:" starting
// the line, with nothing but whitespace before it, the one place this
// syntax is legal at the very start of a line; anywhere else, the exact
// same bracket text is a reference sitting next to whatever claim it
// anchors. `stripCode` runs first, exactly as every other rule in this
// file that reads a note's own prose: a footnote key mentioned inside a
// fenced example documenting this very syntax is not a real anchor.
const FOOTNOTE_PATTERN = /\[\^([^\]]+)\]/g;

function isFootnoteDefinition(line, matchIndex, matchLength) {
  return line.slice(0, matchIndex).trim() === '' && line[matchIndex + matchLength] === ':';
}

// Every footnote REFERENCE (never a definition, see isFootnoteDefinition
// above) in `strippedBody`, each tagged with its own 0-based body line
// index. The caller cross-checks `key` against the note's own declared
// source ids; this function knows nothing about sources at all, on
// purpose, so it can never drift from what "a footnote reference" means
// independently of what it is being checked against.
function scanFootnoteReferences(strippedBody) {
  const refs = [];
  const lines = strippedBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    FOOTNOTE_PATTERN.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_PATTERN.exec(line)) !== null) {
      if (isFootnoteDefinition(line, match.index, match[0].length)) continue;
      refs.push({ key: match[1], lineIndex: i });
    }
  }
  return refs;
}

const attribution = {
  id: 'attribution',
  settingKey: 'attribution',
  check(files, context) {
    const findings = [];
    for (const file of files) {
      const text = context.readFile(file);
      const { frontmatter, body } = splitFrontmatter(text);
      const sources = readEntries(frontmatter, 'sources');
      if (sources === null || sources === undefined) continue; // absent, or a shape sourcesResource (spec.mjs) already reports as unreadable
      if (sources.length < 2) continue; // a single source, or none, needs no disambiguation

      const sourcesLine = frontmatterKeyLine(frontmatter, 'sources');
      const ids = [];
      sources.forEach((entry, index) => {
        if (isBlank(entry.id)) {
          findings.push({
            file,
            line: sourcesLine,
            check: 'missing-source-id',
            absence: true,
            messageKey: 'lint.attribution.missing_source_id',
            params: { index },
          });
          return;
        }
        ids.push(String(entry.id).trim());
      });
      if (ids.length === 0) continue; // every entry lacked an id, already reported above; nothing left to cross-check footnotes against

      const idSet = new Set(ids);
      const stripped = stripCode(body);
      const prefixLineCount = bodyPrefixLineCount(text, body);
      const referencedIds = new Set();

      for (const { key, lineIndex } of scanFootnoteReferences(stripped)) {
        if (idSet.has(key)) {
          referencedIds.add(key);
        } else {
          findings.push({
            file,
            line: prefixLineCount + lineIndex,
            check: 'unknown-footnote',
            messageKey: 'lint.attribution.unknown_footnote',
            params: { key },
          });
        }
      }
      for (const id of ids) {
        if (!referencedIds.has(id)) {
          findings.push({
            file,
            line: sourcesLine,
            check: 'source-not-anchored',
            absence: true,
            messageKey: 'lint.attribution.source_not_anchored',
            params: { id },
          });
        }
      }
    }
    return findings;
  },
};

export const LINT_RULES = Object.freeze([indexCompleteness, orphans, columns, tables, style, secrets, privacy, attribution]);

const VALID_SEVERITIES = new Set(['error', 'warn', 'off']);
const DEFAULT_SEVERITY = 'warn';

// The finding's severity, read from `lint.<rule.settingKey>` (NOT
// `rule.id`: index-completeness is the one rule in this array whose
// setting name differs from its id, "index_completeness" against
// "index-completeness", and the two must never be conflated here even
// though every other rule's id and settingKey happen to read the same).
//
// This task's own first requirement, carried before its three new
// rules: `lint.<rule>` now accepts EITHER a bare severity string OR an
// object carrying `severity` plus that rule's own settings (tables'
// `max_cell_chars`/`duplicate_rows`, style's `forbidden_chars`/`base`).
// Before this, `style` was an object with no `severity` field AT ALL,
// so it was permanently 'warn' with no way to configure it to 'error'
// or 'off', and `tables_limits` sat beside `lint.tables` as a sibling
// key that was not a rule's own setting at all, a shape the schema
// validator (src/schema.mjs) cannot express as "one field, two shapes"
// (it has no `oneOf`), so the object branch below reads `.severity` off
// whatever the configuration gave it and lets `VALID_SEVERITIES` decide
// whether that was usable, exactly as the bare-string branch always
// did. A configured object with no `severity` key at all (every rule's
// settings-only shape, until an adopter adds one) reads as `undefined`
// here, which `VALID_SEVERITIES.has` correctly rejects, falling through
// to this rule's own default below.
//
// 'error', 'warn' or 'off' when the configuration names one of those
// three values explicitly (as a bare string, or as `.severity` inside
// an object), the rule's own `defaultSeverity` for anything else at
// all -- including a value the schema would itself reject (a malformed
// hand-built config in a test, or a config this function is handed
// before validation) -- falling back further to `DEFAULT_SEVERITY`
// ('warn') when a rule declares no `defaultSeverity` of its own. Only
// `secrets` (see its own header above) declares one: 'error', because a
// warning about a leaked credential is a leaked credential, and an
// adopter who never touches `lint.secrets` should still get a failing
// run the day one appears rather than a warning among warnings. This
// rule module never trusts config shape and always has a safe default,
// the same posture every rule in house.mjs already takes for a setting
// it reads.
function severityFor(rule, config) {
  const raw = config?.lint?.[rule.settingKey];
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw.severity : raw;
  return VALID_SEVERITIES.has(value) ? value : (rule.defaultSeverity ?? DEFAULT_SEVERITY);
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
// HOUSE_RULES and SPEC_RULES hand every rule the same `context`: the
// three rules from task 3 never read it (see this file's own header),
// while tables and style (above) do, and the runner does not need to
// know which is which for either to work.
//
// A finding may carry its OWN `severity`, read in preference to the one
// rule-level severity this function otherwise stamps on everything a
// rule returns: `lint.tables.duplicate_rows` is a real,
// separately configurable severity the schema already gives one single
// check inside the `tables` rule (see that rule's own header above), and
// a runner that only ever had one severity per rule could not honour it
// without this. `VALID_SEVERITIES.has(partial.severity)` guards against
// a rule that never sets the field at all (every rule but tables'
// duplicate-row check): `undefined` is not a member of that set, so
// those findings fall straight through to the ordinary rule-level
// severity exactly as before this existed.
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
        severity: VALID_SEVERITIES.has(partial.severity) ? partial.severity : severity,
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
