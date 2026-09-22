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
// the `scope` argument entirely. TWO rules read it instead: tables and
// style. That count has been wrong twice in this file's own life. It
// said two when three rules read the scope, was corrected to three, and
// is now two again because fix round 3 took the scope away from
// `secrets` on purpose (that rule's own header says why). Both times
// the count was wrong it was wrong in the direction that matters: a
// reader who believes secrets sweeps the whole vault does not expect a
// committed secret to print as no findings under a narrowed scope. It
// now does sweep the whole vault, so the belief and the code finally
// agree. This is
// not an optimisation this module
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
// expression, reads every file a push could publish rather than the
// notes (see its own header for how that set is drawn), and defaults to
// 'error' where every other rule defaults to 'warn'. `privacy` reads
// `privacy.confidential_dirs` and judges the whole vault, like
// index-completeness, orphans and columns. `attribution` is the only
// rule in this file that cites the Open Knowledge Format directly
// (section 5.1), and also judges the whole vault.
import { posix } from 'node:path';
import { bodyPrefixLineCount, forEachInternalLink, forEachWikilink, resolveLinkPath } from './house.mjs';
import { frontmatterKeyLine, readEntries, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { classifyTargetPath, isUnderPath } from '../vault.mjs';
import { OVERALL_SCAN_TIMEOUT_MS, PERSONAL_PATTERN_LABEL, SCAN_TIMEOUT, loadPatterns, scanText } from '../leak.mjs';

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
// and which was new. This is one of three rules in LINT_RULES that
// reads `scope` at all (style and secrets, below, are the other two),
// for the identical reason style needs it: a vault that adopts this kit
// arrives with
// tables written under no such rule, and a table check that reports
// every old table on its first run is exactly the linter someone
// switches off in its first minute. A table is judged only when at
// least one of its OWN lines (its header, its delimiter, or any of its
// data rows) is a line the scope says this change added; a table none
// of whose lines were touched is left alone in silence, however
// malformed, the same silence the style rule below keeps for an
// untouched line.
//
// Fix round 1 (review of commit 0718c40). The plan never said how THIS
// rule should read the scope: it named style's line-by-line reading
// explicitly and said nothing about tables at all, so table-level
// scoping (judge the whole table once ANY of its lines is touched) was
// a judgment call, later RATIFIED by the plan itself (see
// docs/superpowers/plans, "docs: settle what the scope means for a
// table"): what this rule asks (is there a blank line before this
// table, does it hold a duplicate row) are properties of the table, not
// of any one row, so the table is the right unit to judge. The defect
// the review actually found was not the scoping, it was the SILENCE:
// this rule is the one that CAN name a line the change never touched,
// and its three messages said nothing about why. Every message below
// now says so explicitly (see lang/en/messages.json's own three
// lint.tables.* entries).
//
// Two false positives fixed in the same round, both in table
// DETECTION rather than in scoping:
// - A delimiter row with no pipe of its own ("---", a bare run of
//   dashes) used to be accepted as a valid single-column delimiter,
//   which reads a setext heading ("Some text\n---") or a thematic break
//   sitting under a line that happens to use a pipe as punctuation (a
//   range, a link title) as a table. The fix requires the delimiter row
//   to carry a pipe of its own before it is trusted as one: a genuine
//   single-column table written as `| A |` over `|---|` still has one
//   (the framing pipes survive splitTableRow's own outer-pipe strip,
//   see that function's own header), so this declines nothing the
//   format actually offers, only the shape indistinguishable from a
//   setext underline. The same declared trade-off findFirstTableHeader
//   above already makes for a headerless table; this is its mirror for
//   a "delimiter-less" one.
// - Two real tables with no blank line between them used to be read as
//   ONE table, because the data-row scan absorbed the second table's
//   own header and delimiter as more data of the first, so its missing
//   blank line (this rule's own headline check) went unreported. The
//   data-row scan now stops, without consuming the line, the moment the
//   line it is about to absorb is itself followed by a real delimiter
//   row: that line is a new table's header, not more data of the
//   current one, and the outer scan picks it up fresh from there.
//
// A table found entirely inside a fenced or indented code block is not
// found at all: the table scanner below reads `stripCode`
// (src/markdown.mjs, already imported above for the columns rule), the
// SAME call every other rule in this file already goes through, applied
// before it ever looks for a pipe. A blanked fence line has no pipe
// left in it to be mistaken for one; this is not a second
// code-detection implementation choosing to agree with the first, it is
// the one shared call. A table inside a BLOCKQUOTE is a declared,
// accepted limitation of the same kind: the ">" prefix a blockquote
// puts in front of its own content makes isDelimiterRow's plain-dashes
// test fail, so a quoted table is never found. This is the safe
// direction (a missed table, never a false one), matching every other
// declined shape in this module, but unlike them it costs a vault
// nothing to work around: writing the table unquoted still gets it
// checked.
//
// Three independent checks share one table scan:
// - blank-line-before-table: the line immediately before a table's own
//   header row must be blank (a whitespace-only line counts, trimmed
//   the same way splitTableRow already trims a row), unless the header
//   is the very first line of the body, with nothing before it to
//   require a blank line from.
// - duplicate-row: two data rows in the SAME table whose cells, once
//   each is trimmed, read identically are a duplicate, reported at the
//   LATER row's own line. Trimming is what makes a row differing only
//   in trailing whitespace a duplicate, a case this task's own brief
//   names explicitly. `splitTableRow` (above, already honouring an
//   escaped pipe as literal content) is reused rather than a second,
//   simpler row split that could disagree with it on that escape.
// - cell-too-long: any cell (header or data), once trimmed AND
//   unescaped, longer than `lint.tables.max_cell_chars` is reported at
//   its own row's line, naming the first offending cell only: the same
//   "first divergence" discipline the columns rule above already
//   follows, because a message naming every offense on a row at once is
//   worse than one a person can fix and re-run against. Unescaping
//   (`a\|b` measures as 3 characters, not 4) is deliberate, not shared
//   with duplicate-row's own comparison: docs/incidents.md establishes
//   that a heading carrying the separator is written and MATCHED in its
//   escaped form, which duplicate detection still honours, but a length
//   measured on the escaped source form overcounts the one character
//   the escape adds for every literal pipe a cell actually renders, so
//   length is the one place that source form is the wrong unit. A row
//   whose own cell count does not match the header's is skipped by this
//   check alone (not by duplicate-row, which never sees it misparsed
//   this way in practice): GFM's lazy continuation makes a pipe-bearing
//   prose line right after a table, with no blank line separating them,
//   a defensible parse as more data, but a message naming a cell of a
//   sentence unactionable, and a mismatched cell count is the cheap
//   signal that the row is prose rather than data. A missing or
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

// A cell's length as it RENDERS, not as it is written: the one escape
// this project's own table contract establishes (docs/incidents.md, "a
// heading containing the separator is written with it backslash-escaped
// ... keep it escaped to write and to match in a markdown table") turns
// one rendered pipe into two source characters, so measuring the source
// form overcounts by one character per literal pipe a cell actually
// holds. Used ONLY for the cell-length check, never for rowKey's own
// duplicate comparison above, which is right to keep comparing the
// escaped source form: `a\|b` and `a|b` are a one-cell row and a
// two-cell row, not the same row written two ways.
function unescapeSeparator(text) {
  return text.replace(/\\\|/g, '|');
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
//
// The delimiter row must carry a pipe of ITS OWN (fix round 1, finding
// 2): a bare run of dashes with no pipe at all is far more likely to be
// a setext heading's underline or a thematic break than the world's
// only table whose delimiter omits its framing pipes, and accepting it
// read ordinary prose ("Cost is a | b dollars" over "---") as a table.
// A real single-column table keeps its own framing pipes (`| A |` over
// `|---|`, splitTableRow's outer-pipe strip leaves the delimiter's pipes
// in place before its own dash test ever runs), so nothing this format
// actually offers is declined by requiring one here too.
function findAllTables(strippedBody) {
  const lines = strippedBody.split('\n');
  const found = [];
  let i = 0;
  while (i < lines.length - 1) {
    if (!lines[i].includes('|') || !lines[i + 1].includes('|') || !isDelimiterRow(lines[i + 1])) {
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
    //
    // Fix round 1, finding 5: before absorbing `lines[j]` as one more
    // data row of THIS table, check whether IT is itself the header of
    // a second table (a pipe of its own, and a real delimiter row right
    // after it). Two real tables sitting back to back with no blank
    // line between them otherwise had the second one's header and
    // delimiter swallowed as data of the first, which hid the second
    // table's own missing-blank-line finding entirely and subjected its
    // header/delimiter rows to the cell-length check as if they held
    // data. Stopping here, without consuming the line, is what lets the
    // outer scan below pick it up fresh as a table of its own.
    while (j < lines.length && lines[j].includes('|')) {
      if (j + 1 < lines.length && isDelimiterRow(lines[j + 1])) break;
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
// when `added` is `null`, meaning the scope carries no restriction for
// this file at all (the untracked-file and "all" reading; see
// src/git.mjs's own header). Takes the already-resolved `added` set
// rather than `scope` and `file`, so a caller that reads it once per
// file (below) never asks the scope the same question twice per table.
function lineIsInScope(added, prefixLineCount, bodyLineIndex) {
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
      // Fix round 1, finding 10: style (below) already skipped
      // readFile+stripCode for a file with nothing added at all; this
      // rule ran both, plus a full table scan, on every file in the
      // vault regardless of scope, which is the more expensive miss of
      // the two. Unfalsifiable by any FINDING this function returns
      // (the per-table `inScope` check below already excludes every
      // such file's tables), so it changes no test's expected output,
      // only how much work a file the change never touched costs.
      const added = scope.addedLines(file);
      if (added !== null && added.size === 0) continue;

      const text = context.readFile(file);
      const { body } = splitFrontmatter(text);
      const stripped = stripCode(body);
      const bodyLines = stripped.split('\n');
      const prefixLineCount = bodyPrefixLineCount(text, body);

      for (const table of findAllTables(stripped)) {
        const ownLineIndices = [table.headerLineIndex, table.delimiterLineIndex, ...table.dataRows.map((row) => row.lineIndex)];
        const inScope = ownLineIndices.some((idx) => lineIsInScope(added, prefixLineCount, idx));
        if (!inScope) continue; // every one of this table's own lines already existed before this change

        if (table.headerLineIndex > 0 && bodyLines[table.headerLineIndex - 1].trim() !== '') {
          // Fix round 3 (finding C). Two literal key sites, exactly as
          // `secrets` was given in fix round 2 and for the identical
          // reason: `added === null` means this run carries no line
          // restriction for this file at all (`--base all`, or an
          // untracked file), and the old single message asserted "this
          // change touched the table" about a run where there is no
          // change. The keys are spelled out at each site rather than
          // computed, because test/message-keys.test.mjs can only
          // defend a key it can see statically in this source.
          if (added === null) {
            findings.push({
              file,
              line: prefixLineCount + table.headerLineIndex,
              check: 'blank-line-before-table',
              messageKey: 'lint.tables.missing_blank_line_full',
              params: {},
            });
          } else {
            findings.push({
              file,
              line: prefixLineCount + table.headerLineIndex,
              check: 'blank-line-before-table',
              messageKey: 'lint.tables.missing_blank_line',
              params: {},
            });
          }
        }

        if (duplicateSeverity !== 'off') {
          const seenAt = new Map();
          for (const row of table.dataRows) {
            const key = rowKey(row.cells);
            const firstLineIndex = seenAt.get(key);
            if (firstLineIndex !== undefined) {
              if (added === null) {
                findings.push({
                  file,
                  line: prefixLineCount + row.lineIndex,
                  check: 'duplicate-row',
                  severity: duplicateSeverity,
                  messageKey: 'lint.tables.duplicate_row_full',
                  params: { line: prefixLineCount + firstLineIndex },
                });
              } else {
                findings.push({
                  file,
                  line: prefixLineCount + row.lineIndex,
                  check: 'duplicate-row',
                  severity: duplicateSeverity,
                  messageKey: 'lint.tables.duplicate_row',
                  params: { line: prefixLineCount + firstLineIndex },
                });
              }
            } else {
              seenAt.set(key, row.lineIndex);
            }
          }
        }

        if (maxCellChars !== null) {
          const headerCellCount = table.headerCells.length;
          const rowsToCheck = [
            { lineIndex: table.headerLineIndex, cells: table.headerCells },
            ...table.dataRows.filter((row) => row.cells.length === headerCellCount),
          ];
          for (const row of rowsToCheck) {
            const measured = normalizedRowCells(row.cells).map(unescapeSeparator);
            const overIndex = measured.findIndex((cell) => cell.length > maxCellChars);
            if (overIndex !== -1) {
              if (added === null) {
                findings.push({
                  file,
                  line: prefixLineCount + row.lineIndex,
                  check: 'cell-too-long',
                  messageKey: 'lint.tables.cell_too_long_full',
                  params: { index: overIndex + 1, length: measured[overIndex].length, max: maxCellChars },
                });
              } else {
                findings.push({
                  file,
                  line: prefixLineCount + row.lineIndex,
                  check: 'cell-too-long',
                  messageKey: 'lint.tables.cell_too_long',
                  params: { index: overIndex + 1, length: measured[overIndex].length, max: maxCellChars },
                });
              }
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
// that reports a line inside a specific known section of the file. A
// consequence worth stating plainly (fix round 1, finding 10): a
// forbidden character sitting inside the frontmatter block itself,
// including inside an indented YAML block scalar, is judged exactly
// like ordinary prose, since nothing about YAML looks like a fence to
// stripCode. Correct for the line-number alignment this rule depends
// on, but a character common in YAML syntax (a colon, a dash) could in
// principle fire on structure rather than on prose if ever configured.
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
    // Fix round 3 (finding H): this early exit used to return an empty
    // array in SILENCE, so a vault owner who wrote `"style": {"severity":
    // "error"}` and forgot `forbidden_chars` got a green run and no word
    // that the rule they had just escalated had nothing to look for. A
    // configuration mistake that produces silence is the exact failure
    // this slice is about. It now says so, ONCE for the whole run
    // (`file: null`, rendered by src/commands/lint.mjs as its "(no file)"
    // marker), at this rule's own configured severity, so escalating the
    // rule to `error` and then giving it nothing to do fails the run
    // rather than passing it quietly.
    //
    // The finding is emitted ONLY when the vault's configuration NAMES
    // `lint.style` at all, in any shape. A vault that never mentions the
    // rule has not made a mistake: style is on by default at `warn`, and
    // telling every adopter who never asked for it that it has nothing
    // configured would be noise, not a warning. This is the difference
    // between an unset setting and a half-set one.
    if (forbiddenChars.length === 0) {
      if (context.config?.lint?.style === undefined) return [];
      return [{
        file: null,
        line: null,
        check: 'nothing-configured',
        absence: true,
        messageKey: 'lint.style.nothing_configured',
        params: {},
      }];
    }
    // The remaining early exit below is still unfalsifiable by any
    // OUTPUT this function can produce (the per-line loop reads
    // `added.has` the same way it shortcuts), and is still kept
    // deliberately, for what it is not dead FOR: it skips
    // readFile+stripCode for every file this change never touched. A
    // mutation removing it survives the whole suite, and this sentence
    // is the disclosure this project's own method asks for instead.

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
          // Fix round 3 (finding C), the same two-key treatment tables
          // above just received and secrets received in fix round 2.
          if (added === null) {
            findings.push({
              file,
              line: lineNumber,
              check: 'forbidden-char',
              messageKey: 'lint.style.forbidden_char_full',
              params: { char: firstChar },
            });
          } else {
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
// NOT scoped at all, unlike style: every line of every file, every run.
// Fix round 3 reversed the earlier reading here; the argument is in this
// rule's own fix-round-3 block below, immediately above the rule object.
// The history is worth keeping because it is the reason a whole scoping
// apparatus once existed in this rule: an early version scoped by
// BLANKING every out-of-scope line and scanning the whole text anyway,
// which bought nothing measurable (roughly 26 extra seconds over 200
// notes, for identical output); its replacement extracted only the added
// lines into a smaller blob and remapped each match back to its real
// line. Both are gone. A scanner with no scope has no line numbers to
// remap and nothing a caller can narrow.
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
// wrong report about whether a credential is safe to push. The schema
// (schema/config.schema.json) now also refuses an EMPTY string inside
// `privacy.secret_patterns` outright (`minLength: 1`), which used to be
// schema-valid and reach `compilePattern`'s own refusal only at scan
// time, crashing the whole run over a config a validator could have
// caught first.
//
// Fix round 1, CRITICAL. The message used to carry `match.pattern`
// (leak.mjs's own `displayPattern` output) verbatim for a "config"-origin
// match, on the reasoning that `privacy.secret_patterns` is public "by
// nature" (leak.mjs's own words, written about a DIFFERENT question: is
// this list safe to log the fact that it exists, not whether every
// string inside it is safe to print). A vault owner can paste a REAL,
// literal credential into `privacy.secret_patterns` by mistake (typing a
// denylist rather than a detection pattern), and this rule would then
// render that exact credential inside a message whose own text says
// never to paste, print or share it. Fixed by `displaySecretPattern`
// below: a matched pattern's text is only ever shown verbatim when it is
// one of the SIX versioned, reviewed `GENERIC_PATTERNS` this repository
// ships (which "name no one", per leak.mjs's own header); anything else
// -- every `privacy.secret_patterns` entry, without exception -- renders
// a fixed, neutral label instead. This is the "for configured patterns
// generally" choice the review offered, not "detect whether THIS
// pattern's own text looks like a secret shape": that second option
// would mean writing a second secret-shape classifier inside this rule
// to decide whether to trust the first one, doubling the very detection
// logic this rule exists to delegate to leak.mjs rather than duplicate,
// and it would still fail to protect a credential that happens not to
// match any known shape (a plain password, a company-specific token
// format). Rendering every configured pattern's text as neutral,
// unconditionally, protects the exact case that matters with no
// judgment call about what "looks like" a secret.
const CONFIGURED_PATTERN_LABEL = 'a pattern configured in privacy.secret_patterns';

// Fix round 2 (CRITICAL): this used to take `match.pattern` (leak.mjs's
// OWN already-rendered display text, `displayPattern`'s output) and
// re-classify it a SECOND time by checking `GENERIC_PATTERNS.includes`,
// on the reasoning that only a generic pattern's raw source ever shows
// up unchanged. That reasoning quietly assumed the only two origins
// this call site would ever see were 'generic' and 'config', which was
// true only because this rule's own `loadPatterns` call never passes
// `env` (see this rule's own header: personal patterns are deliberately
// never loaded here). It was never actually SAFE, only unreached: a
// 'personal'-origin match's own `pattern` field is already
// PERSONAL_PATTERN_LABEL (leak.mjs's neutral text for exactly that
// origin, never the pattern's real source), a string `GENERIC_PATTERNS`
// was never going to contain, so this function's old two-way test would
// have called it "a pattern configured in privacy.secret_patterns" --
// false, since it was never configured at all, it was personal -- the
// moment any future caller passed `env` through to `loadPatterns`, one
// argument away. Classifying by `match.origin` (the fact leak.mjs
// already knows for certain, exported on every match for exactly this)
// rather than by re-inspecting the rendered text removes the second,
// redundant and fragile classifier entirely; a 'personal' match, should
// one ever reach this rule, is labelled correctly on the day it does,
// not silently on the day someone happens to read this comment.
//
// Exported so this classification can be tested directly against a
// hand-built match object carrying `origin: 'personal'`: this rule's
// own `loadPatterns` call never passes `env` (see this rule's own
// header), so no match with that origin can reach this function through
// the rule's own public check() today, and a test that could only ever
// drive it through that path would leave this exact clause exactly as
// unverified as the bug it replaces was.
export function displaySecretPattern(match) {
  if (match.origin === 'personal') return PERSONAL_PATTERN_LABEL;
  return match.origin === 'generic' ? match.pattern : CONFIGURED_PATTERN_LABEL;
}

// Fix round 3 (CRITICAL, findings A and B of the whole-slice review).
// TWO clauses of this rule changed, and they are one decision: what
// "scan this vault for secrets" means.
//
// 1. WHICH FILES. This rule used to receive the same markdown subset
//    every other rule in this module gets, so an AWS access key
//    committed as `secrets.env`, `config.json` or a `.yml` was never
//    read by anything in `brain-kit lint`, while the report's own scope
//    line said "the whole vault was checked, every line". The
//    maintainer's own push gate (.githooks/pre-push, through
//    src/commands/scan-blobs.mjs) scans every BLOB and always did, so
//    the two halves of this slice disagreed about what a vault is, and
//    the half that disagreed was the one that ships to adopters: their
//    template gate (templates/githooks/pre-push) refuses only on a
//    non-zero `lint` exit. `scansEveryFile` below makes runLintRules
//    hand this rule a set of its own instead. Fix round 3 made that set
//    the whole walk, and the walk skips every dot-path, so a committed
//    `.env` still passed with exit 0 under a line claiming every file
//    had been scanned; final fix round 2 made it every file a push could
//    publish (see filesForRule, at the bottom of this file). No other
//    rule's reach changed: the other seven are about prose and markdown structure,
//    and a table check that started reading a PNG would report
//    nonsense.
//
// 2. WHICH LINES. This rule no longer reads `scope` at all. It used to
//    be scoped to added lines, like style, on the adoption-noise
//    argument that rule states. That argument does not transfer: years
//    of pre-existing PROSE really will light up a forbidden-character
//    rule on day one, which is why style is scoped, but a
//    pre-existing CREDENTIAL is not noise, it is the single finding an
//    adopter most needs on day one, and the six shipped GENERIC_PATTERNS
//    match shapes (an AWS key id, a GitHub token, a private key header)
//    that essentially never occur in prose by accident. The scoped
//    reading also carried a live defect nothing else could close: on
//    the default branch `auto` widens to the whole vault only when the
//    tree is clean AND nothing is untracked, so ONE unrelated scratch
//    file re-narrowed the scope and dropped a committed, already-found
//    secret to zero errors and exit 0 -- and an adopter's template gate
//    reads the exit code, not the prose caveat the report printed. A
//    rule that ignores the scope cannot be narrowed by a scratch file,
//    by a base, or by anything else. This also settles what a PARTIAL
//    run's exit code may mean: it may still be 0, because after this
//    change no rule that can find a secret is scoped at all.
//
// The `scope` parameter is therefore gone from the signature, exactly as
// it is absent from the three whole-vault rules above.
// THE CONFIGURATION FILE IS SCANNED FOR CREDENTIAL SHAPES ONLY (final fix
// round 2), and never for the privacy patterns it declares.
//
// `privacy.secret_patterns` lives in brain-kit.config.json, which is a file
// this rule reads. Scanning it with the patterns it declares makes every
// declaration match itself, which is why fix round 3 blanked each
// configured pattern's literal text out of the file first. That exemption
// was wrong in both directions, and both were proven:
//
//   - It hid real credentials. The blanking replaced every occurrence of a
//     configured pattern's text ANYWHERE in the file, and the shipped
//     example configuration declares the literal prefixes `sk-ant-` and
//     `github_pat_`, so an Anthropic key or a fine-grained GitHub token
//     pasted into any other field lost its prefix before the scan and
//     passed.
//   - It flagged the owner. Only a pattern whose text appears VERBATIM was
//     blanked, so a pattern written as a regular expression for the
//     owner's own domain or company matched the owner's own address and
//     name in the same file and told them to rotate a credential that was
//     their e-mail.
//
// So the file is read raw, every byte, against the generic credential
// shapes this repository ships (src/leak.mjs, GENERIC_PATTERNS), which
// never match a detection pattern's own text unless that text is itself
// credential-shaped (and that case is reported on purpose, see the
// credential-as-pattern check below). Nothing is blanked, so nothing can be
// blanked out of a real credential.
//
// THE TRADE-OFF, stated because it is real: a privacy pattern such as a
// client's name, appearing in the configuration, is not caught there. That
// is accepted because the configuration is the one file in the vault that
// is authored by its owner, reviewed in a pull request whenever it changes,
// and is where those very patterns are declared by design; every other
// file, a copy of the configuration at any other path included, is read
// against every pattern.
const secrets = {
  id: 'secrets',
  settingKey: 'secrets',
  defaultSeverity: 'error',
  scansEveryFile: true,
  check(files, context) {
    const configuredPatterns = context.config?.privacy?.secret_patterns;
    const configPatterns = Array.isArray(configuredPatterns) ? configuredPatterns.filter((p) => typeof p === 'string') : [];
    const patterns = loadPatterns({ configPatterns });
    // What the configuration file itself is read against: the generic
    // credential shapes and nothing the configuration declares (see the
    // comment above this rule).
    const shapesOnly = loadPatterns({});

    // Fix round 2 (CRITICAL): the ONE absolute deadline this check used
    // to compute ONCE, before this loop, and thread through every file's
    // own scanText call, was measured for a DIFFERENT unit of work than
    // it was given: OVERALL_SCAN_TIMEOUT_MS (leak.mjs's own export) is
    // roughly 13 seconds of real margin for ONE scanText call over
    // 100,000 lines, and sharing that single budget across an entire
    // vault's worth of files punishes exactly the adopter this rule
    // exists to help most, a vault's FIRST run: measured, 800 untracked
    // notes of about 300 lines each (nothing committed yet, so every
    // line of every file is in scope, per this rule's own header) under
    // the shipped configuration exceeded the shared budget partway
    // through, scanText raised ("refusing to report a partial result as
    // if it were complete"), the exception escaped this rule entirely,
    // and the two rules that run after secrets in LINT_RULES (privacy,
    // attribution) never executed AT ALL, for a vault that had done
    // nothing more unusual than existing.
    //
    // The fix mirrors the equivalent decision src/commands/scan-blobs.mjs
    // already made and wrote down for the push gate's own version of
    // this exact question (a fresh deadline per blob, not one shared
    // across a whole push): a FRESH deadline PER FILE, computed inside
    // this loop. Each file gets the full, generously-measured budget
    // leak.mjs's own header describes, which keeps the one guarantee
    // this rule actually needs (no single file's scan runs unbounded)
    // without inventing a new, unmeasured number for "a whole vault's
    // worth of scanning" -- exactly the mistake OVERALL_SCAN_TIMEOUT_MS's
    // own header warns a caller away from making up, which sharing one
    // deadline across every file in the vault already was. A lint run
    // over a vault is closer to scan-blobs' own "one blob to several
    // hundred" description than it first looks: a first adoption, an
    // import of an existing wiki, a vendored batch of notes, can all put
    // hundreds of ordinary files in scope in one run, and none of them
    // is the caller a single 20-second, whole-run budget was ever sized
    // for.
    //
    // Final fix round 2: each file's twenty seconds is a FLOOR, and the
    // budget grows with the file (`accrue: true`, src/leak.mjs's accrual
    // rates), because a flat per-file budget made an ordinary CSV of a
    // quarter of a million short lines time out, with no secret in it,
    // and the verdict called that a crash. A large file gets time in
    // proportion to the lines and characters it actually holds, and the
    // report says "timed out" for a file that still runs out of it.
    //
    // A per-file scan that STILL exceeds its own fresh budget (some
    // single file large enough that even the full measured margin is not
    // enough) is caught here, per file, rather than left to escape this
    // rule and abort every rule that has not run yet: that file's own
    // secrets check is reported as a DEGRADED result (`defect: true`,
    // caught by src/commands/lint.mjs's own tool-defect handling, exit
    // code DEGRADED rather than OK or FAILURE), and the loop continues
    // to the next file, so one pathological file costs this run exactly
    // one file's worth of missing coverage, named, rather than the whole
    // run's worth, unnamed. This is deliberately NARROWER than catching
    // every exception this whole `check` could ever throw (loadPatterns,
    // above, can also raise, for an unrelated reason: a malformed
    // `privacy.secret_patterns` entry, which this rule's own header
    // says must never be swallowed into a soft finding). Only the
    // per-file scanText call is guarded here; a compile failure still
    // escapes this function entirely, exactly as before, to be caught by
    // runLintRules' own generic per-rule guard instead.
    const findings = [];

    // A vault owner who pasted a REAL credential into
    // `privacy.secret_patterns` by mistake (typing a denylist rather than
    // a detection pattern, the exact mistake this rule's fix round 1
    // already went to some length over) is told so in those words. The
    // raw scan of the configuration below already reports a credential
    // shape anywhere in that file, this list included, at its line; this
    // check reads each pattern AFTER JSON has decoded it, so a credential
    // written with escapes that hide it from a raw read is still caught,
    // and it names the mistake rather than only the symptom. The finding
    // names no line and never echoes the text.
    for (const configured of configPatterns) {
      let looksLikeCredential;
      try {
        looksLikeCredential = scanText(configured, shapesOnly, { deadlineAt: Date.now() + OVERALL_SCAN_TIMEOUT_MS }).matches.length > 0;
      } catch {
        continue; // an unscannable pattern is loadPatterns' own problem, raised elsewhere; this check never invents one
      }
      if (looksLikeCredential) {
        findings.push({
          file: CONFIG_FILENAME,
          line: null,
          check: 'credential-as-pattern',
          messageKey: 'lint.secrets.pattern_is_a_credential',
          params: {},
        });
      }
    }

    // What the set this rule was handed could not include, and must not
    // pass in silence (src/commands/lint.mjs, buildSecretScan). A file
    // whose name is not valid UTF-8 exists and would be published, and
    // cannot be opened by name here, so it is a defect for that file, the
    // same answer the maintainer's gate gives a path it cannot hand to
    // git. A listing git itself could not produce is a defect for the
    // whole set.
    const scan = context.secretScan;
    for (const name of scan.undecodable ?? []) {
      findings.push({
        file: name,
        line: null,
        check: 'file-name-undecodable',
        defect: true,
        messageKey: 'lint.tool_defect.file_name_undecodable',
        params: {},
      });
    }
    if (scan.failure) {
      findings.push({
        file: null,
        line: null,
        check: 'publishable-list-failed',
        defect: true,
        messageKey: 'lint.tool_defect.publishable_list_failed',
        params: { status: scan.failure.status },
      });
    }

    for (const file of files) {
      // context.scanFile, not context.readFile: the bytes, unnormalised,
      // decoded the one way every scanner in this project decodes, with
      // the per-file size ceiling both gates share applied, and a
      // symbolic link read as the link. See makeScanFile in
      // src/commands/validate.mjs for the reasons.
      let read;
      try {
        read = context.scanFile(file);
      } catch (error) {
        // One unreadable file (a permission, a file deleted between the
        // listing and this read) costs this run that one file's coverage,
        // NAMED, rather than aborting the whole rule and taking every
        // file after it down unnamed, which is what letting this escape
        // to runLintRules' own per-rule guard would do.
        //
        // The operating system's error CODE, never its message (final fix
        // round 2): the message is "EACCES: permission denied, open" plus
        // the ABSOLUTE path, which names the machine and the person it
        // belongs to, and it reached both the text report and --json. The
        // finding already names the file, relative to the vault.
        findings.push({
          file,
          line: null,
          check: 'file-read-failed',
          defect: true,
          messageKey: 'lint.tool_defect.file_read_failed',
          params: { code: error.code ?? 'unknown' },
        });
        continue;
      }
      // The ceiling announces itself, per this project's standing rule.
      // A file too large to read is NOT a file that passed, and it FAILS
      // CLOSED: this finding carries the rule's own severity, which is
      // 'error' unless the vault lowered it for every secret finding at
      // once, so a run with a file this rule could not read exits 1,
      // exactly like a run with a credential in it, and the adopting
      // vault's gate refuses the push. Demoting it to a warning on its
      // own was proven to walk a key on the last line of a large log onto
      // a remote with the suite green; test/lint.test.mjs now pins both
      // the severity and the exit code. The remedy the message names is
      // lint.secrets.exclude_paths, a decision a pull request shows.
      if (read.tooLarge) {
        findings.push({
          file,
          line: null,
          check: 'file-too-large',
          messageKey: 'lint.secrets.file_too_large',
          params: { bytes: read.bytes, max: read.maxBytes },
        });
        continue;
      }
      // The vault's own configuration file, at the vault root and only
      // there, is read against the credential shapes alone (see this
      // rule's header). A copy of it anywhere else is an ordinary file.
      const applied = file === CONFIG_FILENAME ? shapesOnly : patterns;

      let scanResult;
      try {
        scanResult = scanText(read.text, applied, { deadlineAt: Date.now() + OVERALL_SCAN_TIMEOUT_MS, accrue: true });
      } catch (error) {
        // A scan that ran out of time is not a scan that crashed, and the
        // verdict must be able to say which (src/leak.mjs tags every
        // error it raises with a code for exactly this).
        if (error.code === SCAN_TIMEOUT) {
          findings.push({
            file,
            line: null,
            check: 'file-scan-timed-out',
            defect: true,
            messageKey: 'lint.tool_defect.file_scan_timed_out',
            params: { message: error.message },
          });
        } else {
          findings.push({
            file,
            line: null,
            check: 'file-scan-failed',
            defect: true,
            messageKey: 'lint.tool_defect.file_scan_failed',
            params: { message: error.message },
          });
        }
        continue;
      }

      // Fix round 1, CRITICAL. This used to destructure only `matches`
      // out of scanText's own return and silently accept its default
      // cap of five: a file with eight secrets on eight added lines
      // reported five and said nothing about the other three. leak.mjs's
      // own header calls out this EXACT caller by name for this EXACT
      // mistake ("Every ceiling in this project reports how much it
      // cut... a caller that only ever exercises an override never
      // notices"). The whole record is taken now, and `truncated` is
      // surfaced as its own finding, once per file, rather than dropped.
      const { matches, truncated, total } = scanResult;
      // ONE message key now, not two. Fix round 2 added a second key
      // here because this rule could run either scoped or unscoped and
      // said "an added line matches" for both; fix round 3 removed the
      // scoped reading entirely (see this rule's own header), so the
      // scoped key would be dead the day it was kept and
      // `lint.secrets.pattern_matched` is gone from both language packs
      // rather than left in them saying something no run can any longer
      // mean.
      for (const match of matches) {
        findings.push({
          file,
          line: match.line,
          check: 'secret-pattern',
          messageKey: 'lint.secrets.pattern_matched_full',
          params: { pattern: displaySecretPattern(match) },
        });
      }
      if (truncated) {
        findings.push({
          file,
          line: null,
          check: 'secret-pattern-truncated',
          messageKey: 'lint.secrets.truncated',
          params: { shown: matches.length, total },
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
// satisfy both rules.
//
// Fix round 1, CRITICAL. The exemption used to be `!isReserved(path)`:
// ANY file named `index.md` or `log.md`, AT ANY DEPTH under a
// confidential directory, was treated as the boundary's own front door.
// That is a materially bigger exemption than the one thing it exists to
// avoid contradicting: index-completeness's own `root-links-directory`
// clause (this file's own header, above) only ever requires the ROOT
// index to link a FIRST-LEVEL directory, or that directory's OWN
// index.md; it never mentions `log.md` at all, and it never requires
// linking a directory's own index.md from any depth deeper than one. The
// old exemption therefore let a PUBLIC note link `people/log.md` (a log
// of activity inside a confidential directory, not itself something
// index-completeness ever asks anyone to link) with zero findings from
// this rule, and let a public note link a NESTED `people/team/index.md`
// with zero findings too, while an otherwise-identical link to
// `people/team/` (the bare directory, with no index.md suffix) WAS
// reported: the same link, written two ways, disagreeing with itself.
// `isExemptFrontDoor` below is narrowed to exactly the two spellings
// index-completeness's own contract actually needs, one level deep: the
// confidential directory's own path, or that SAME directory's own
// `index.md`. Nothing about `log.md`, and nothing about a directory
// nested any deeper than the confidential boundary itself, is exempt.
// Fix round 2 (MINOR, cheap to fold in): a confidential directory
// configured as exactly "." is the natural way to spell "the whole
// vault is confidential", and this file's own header already disclosed,
// as an inherited and deliberately unfixed limitation, that isUnderPath
// does not read it that way: its own normalisation strips a trailing
// slash and then refuses an empty result, so "." matches NOTHING,
// silently. That silence has a real, visible cost this rule alone can
// pay for cheaply: with `confidential_dirs: ['.']`, every real file
// reads as OUTSIDE every confidential directory, which made clause 2
// (below) flag a note correctly marked `confidential: true` as sitting
// outside a boundary the vault owner had just declared to cover it
// entirely. Fixing isUnderPath itself remains out of this task's own
// scope, unchanged from that original disclosure: every other rule in
// this codebase depends on its current normalisation for an unrelated
// exemption (templates_dir), so changing it there is a bigger, riskier
// change than one MINOR fold-in owns. This reading is local to THIS
// rule's own two dir-matching call sites instead: a dot, once its own
// trailing slash (if any) is trimmed, matches every real vault-relative
// path, since no walked file is ever the vault root itself.
function isWholeVaultDir(dir) {
  return (dir.endsWith('/') ? dir.slice(0, -1) : dir) === '.';
}

function isUnderAnyConfidentialDir(file, confidentialDirs) {
  return confidentialDirs.some((dir) => isWholeVaultDir(dir) || isUnderPath(file, dir));
}

// Fix round 2 (CRITICAL): the exemption used to be computed over the
// WHOLE confidentialDirs list, separately from which dir a path was
// found strictly inside of: `isConfidentialContent` asked "is this path
// inside ANY confidential dir" and "is this path the front door of ANY
// confidential dir" as two independent questions, then combined them.
// That let a path exempt itself via a DIFFERENT, more deeply nested
// confidential directory than the one that made it confidential in the
// first place: with `confidentialDirs: ['people/', 'people/team/']` (a
// vault that names both an outer directory and one of its own
// subdirectories as separately confidential, which the schema permits
// and nothing here forbids), `people/team/index.md` sits strictly
// inside `people/` and is ALSO exactly `people/team/`'s own front door.
// The old code exempted it on the strength of the second fact without
// ever checking that the first fact came from a DIFFERENT directory:
// declaring the nested directory confidential MORE, not less, made this
// rule stop reporting a link into it from a public file, tightening a
// configuration into a looser rule. The fix asks both questions about
// the SAME `dir` on each pass: a path is confidential content the
// moment it is strictly inside SOME confidential directory whose OWN
// front door it is not, and it stays exempt only when every confidential
// directory it sits inside of is the one whose front door it actually
// is.
// Fix round 2 (CRITICAL), a second, independent asymmetry in the same
// function: the front-door comparison used to accept only the exact
// string `${normalized}/index.md`, WITH the extension. A wikilink is the
// one syntax this codebase resolves BOTH with and without an extension
// on purpose (`wikilinkPathParts`, above: "a wikilink's own syntax gives
// no way to tell 'this names a directory' from 'this names a file whose
// extension I am allowed to omit' apart in advance"), so `[[people]]`
// written for the directory's own index page can resolve to the bare
// `people/index`, never `people/index.md`, and that spelling missed the
// old exact-string check entirely. The result: `[[people/index]]` (no
// extension) from a public file was reported as leaking into
// `people/`, while the otherwise-identical `[[people/index.md]]` (same
// target, extension spelled out) and the ordinary link
// `[People](people/index.md)` were both correctly exempt, the exact
// "same link, written two ways, disagreeing with itself" shape Fix
// round 1's own front-door rewrite (above) already fixed once for a
// bare-directory link against its own `index.md` link, and this
// function re-created for a bare-directory link against its own bare
// `index`. Recognising `${normalized}/index` (no extension) as an
// equally valid front-door spelling closes it. The bare directory path
// itself (`path === normalized`) needs no clause of its own here: it
// can never simultaneously satisfy the `startsWith` guard just above
// (a string cannot both equal "people" and start with "people/"), so a
// vault link written as the bare directory front door, `[People](people/)`,
// already reads as "not even inside this dir" and exits before this
// exemption is ever consulted; test/rules-lint.test.mjs pins this down
// directly, by name, rather than leaving it a claim a mutation could
// quietly falsify.
function isConfidentialContent(path, confidentialDirs) {
  return confidentialDirs.some((dir) => {
    const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    if (normalized === '') return false;
    if (!path.startsWith(`${normalized}/`)) return false; // not inside THIS dir at all
    const indexPath = `${normalized}/index`;
    const isThisDirsOwnFrontDoor = path === `${indexPath}.md` || path === indexPath;
    return !isThisDirsOwnFrontDoor;
  });
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

// The literal string this rule accepts for `confidential`, compared
// CASE-INSENSITIVELY. Fix round 1 (MINOR, folded in cheap): the strict
// `=== 'true'` this rule started with matched house.mjs's own
// `isValidBooleanValue`, an established convention in this codebase, but
// a hand-written "confidential: TRUE" or "confidential: True" -- both
// valid YAML booleans, neither the lowercase spelling that convention
// assumes -- escaped the check entirely. Loosened here, specifically for
// this one security-relevant field, rather than in the shared
// convention every OTHER boolean-typed field in this codebase still
// reads strictly: missing a real confidential marking is the cost of
// being wrong in the direction this rule cannot afford.
function isConfidentialTrue(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

const privacy = {
  id: 'privacy',
  settingKey: 'privacy',
  check(files, context) {
    const findings = [];
    const configuredDirs = context.config?.privacy?.confidential_dirs;
    // Fix round 2 (CRITICAL, restoring a guard a previous round removed
    // as provably dead, and it was not dead). That round's argument was
    // real but incomplete: it checked only whether isUnderPath's OWN
    // comparison ever tells an empty string apart from absent (it does
    // not, `if (!dir) return false`), and concluded no input could tell
    // the two shapes apart anywhere in this function. It never checked
    // the OTHER place `confidentialDirs` is read two lines below this
    // one: `confidentialDirs.length === 0`, an early return that never
    // calls isUnderPath at all. `['']` (an empty string entry, schema-
    // valid: the schema has no `minLength` on this array's items) has
    // length ONE, not zero, so that early return does not fire, and
    // clause 2 below then runs against a boundary every real file reads
    // as OUTSIDE (isUnderPath('', anything) is always false), which
    // flags every note correctly marked `confidential: true` as if it
    // sat outside a boundary that, in every other respect, does not
    // exist. `[]` and `['']` must read as the SAME configuration (no
    // boundary declared at all), and only filtering the blank entry out
    // BEFORE this length check makes that true. `typeof d === 'string'`
    // stays load-bearing for the identical reason it always was: a
    // truthy non-string entry (a number, an object) would still reach
    // `dir.endsWith('/')` inside isUnderPath and throw.
    //
    // Inherited limitation, not introduced here (this file's own header
    // already names two such limitations for the orphan rule, in the
    // same spirit): isUnderPath's own normalisation means a confidential
    // directory configured as exactly "." or "/" matches NOTHING,
    // silently, rather than meaning "the whole vault". Fixing that would
    // mean changing isUnderPath itself, a function every other rule in
    // this codebase already depends on for an unrelated exemption
    // (templates_dir); that is a larger, riskier change than this task
    // owns, so it is disclosed here rather than attempted.
    const confidentialDirs = Array.isArray(configuredDirs) ? configuredDirs.filter((d) => typeof d === 'string' && d.length > 0) : [];
    if (confidentialDirs.length === 0) return findings; // nothing declared confidential: nothing for either clause to check against

    for (const file of files) {
      if (isUnderAnyConfidentialDir(file, confidentialDirs)) continue; // only a file OUTSIDE the boundary can leak across it

      forEachInternalLink(file, context, (target, pathPart, fileLine) => {
        const resolved = resolveLinkPath(file, pathPart);
        if (isConfidentialContent(resolved, confidentialDirs)) reportLinkIntoConfidential(findings, file, resolved, fileLine);
      });
      // Fix round 1 (IMPORTANT): `break` on the first match. A bare
      // wikilink target with no extension ("[[bruno]]") tries BOTH
      // readings through wikilinkPathParts ("bruno" and "bruno.md"), and
      // when the confidential boundary is a simple path prefix, BOTH
      // candidate strings can independently satisfy isConfidentialContent
      // ("people/bruno" and "people/bruno.md" both start with "people/"),
      // which used to report the SAME one wikilink twice. Reachability
      // (the orphan rule's own use of these two candidates) is a boolean
      // OR that a Set already dedupes for free; a REPORT is not, so this
      // loop stops at the first candidate that matches rather than
      // trying the second one uselessly.
      forEachWikilink(file, context, (rawTarget, fileLine) => {
        for (const pathPart of wikilinkPathParts(rawTarget)) {
          const resolved = resolveLinkPath(file, pathPart);
          if (isConfidentialContent(resolved, confidentialDirs)) {
            reportLinkIntoConfidential(findings, file, resolved, fileLine);
            break;
          }
        }
      });

      const { frontmatter } = splitFrontmatter(context.readFile(file));
      if (isConfidentialTrue(readScalar(frontmatter, 'confidential'))) {
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
// Fix round 1 (IMPORTANT): the rendered messages for `unknown_footnote`
// and `source_not_anchored` used to say "per section 5.1, X", citing the
// specification as the authority for a requirement it does not
// actually state: an identifier is optional and conditional there, and
// nothing in section 5.1 itself requires every declared identifier to
// be footnoted. That over-claim is exactly the gap between the
// paragraph above (which correctly calls this a shape-only PROXY, this
// rule's own judgment call, not literal enforcement of the
// specification's own wording) and what a person actually reads on
// screen: the disclosure lived in this comment and never reached the
// message. Both messages now describe what THIS CHECK expects, not what
// section 5.1 mandates; `lang/*/messages.json` no longer cites the
// section as the reason for either finding.
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
// `max_cell_chars`/`duplicate_rows`, style's `forbidden_chars`).
// Fix round 3 (finding D) removed a fourth, `lint.style.base`: it was
// declared in the schema, named here, and set in every shipped example
// configuration, and NOTHING read it. Removed rather than implemented,
// because a per-rule base is not a knob this report can honour: the
// report prints exactly ONE scope line for the whole run, so a rule
// quietly running against a different base than the line describes
// would make the report lie about itself, which is the defect this
// whole fix round is about. A person who wants a different base has
// `--base`, which the scope line always reflects.
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
//
// Fix round 1 (MINOR, disclosed rather than changed): a rule turned
// `off` while its OWN settings object still names a sub-setting
// (`{ severity: 'off', max_cell_chars: 40 }`) discards that sub-setting
// silently, because `runLintRules` (below) never calls `check` at all
// once severity resolves to `off`. This is not a bug to fix so much as
// the direct, correct consequence of this file's own established
// promise, stated for `off` since task 3: "an adopter who turns a rule
// off pays nothing for it, not even the walk." A sub-setting nobody's
// code ever reads because the rule itself never runs is exactly that
// promise kept, not a leftover value someone forgot to honour.
// Exported (task 6, src/commands/lint.mjs): the lint command's --rule
// filter needs to report which of the CONSIDERED rules resolve to 'off' in
// the vault's own configuration (its own "skipped" count and list), a
// question this exact function already answers correctly. Reimplementing
// severity resolution a second time in the command layer, rather than
// calling this one, is precisely the two-implementations-disagreeing
// hazard this file's own header opens by naming for a link scanner and a
// code stripper; nothing about this function's own behaviour changes.
export function severityFor(rule, config) {
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
//
// Fix round 2 (CRITICAL): `rule.check(...)` used to be called bare, with
// no catch around it at all. A rule that throws (loadPatterns, inside
// the secrets rule, raises on purpose for a malformed
// `privacy.secret_patterns` entry, per that rule's own header: "a
// skipped pattern is a hole nobody sees") had nothing to catch it here,
// so the exception escaped THIS function, then src/commands/lint.mjs,
// then all the way to src/cli.mjs's generic error boundary: no scope
// line, no rule name, no partial results from every rule that already
// ran, and exit code 1, the exact same code this ruler's own contract
// defines as "a finding of severity error" -- indistinguishable, to a
// machine reading `--json`, from a real finding, except this one comes
// with an EMPTY envelope, precisely when a caller trusting `--json` has
// the least information to tell the two apart. Caught here, per rule,
// pushing ONE synthetic finding (`defect: true`, never a `severity` of
// 'error' or 'warn': it is not a content finding, it is this tool
// failing to finish its own job) rather than a filled-in content
// finding, so a rule that dies on file 3 of 4,000 still lets the other
// 3,999 files' results, and every OTHER rule's results, reach the
// report. src/commands/lint.mjs is the one place that turns `defect:
// true` findings into their own section and the DEGRADED exit code
// (never OK, never the same FAILURE code an ordinary error finding
// uses): see that module's own header for why a degraded run is its
// own category, not a quieter version of either one.
// Fix round 3 (CRITICAL, finding A): the file list a rule receives is now
// a property OF THE RULE, one data field beside `id` and `settingKey`,
// exactly the shape this module is built on. `files` is the markdown
// subset for the seven rules that read prose and markdown structure; a
// rule declaring `scansEveryFile` gets every path the ONE walkVault call
// returned instead, `context.all`, sorted so the order is the walk's own
// and not a Set's insertion order. Only `secrets` declares it, for the
// reason that rule's own header gives.
//
// Final fix round 2: that set is no longer the walk. A rule declaring
// `scansEveryFile` gets `context.secretScan.files`, EVERY FILE A PUSH
// COULD PUBLISH, derived ONCE per run by src/commands/lint.mjs
// (buildSecretScan) and handed down in the context exactly the way the
// walk's own result is, never re-derived here: inside a git repository it
// is what git tracks plus what it would add, dot-paths included and
// ignored files excluded; outside one it is the walk plus dot-paths. The
// walk's dot-path exclusion is right for the seven rules that read notes
// and wrong for the one that reads credentials, where `.env` is the
// canonical place for one to be.
//
// A context that carries no such set is refused, loudly (runLintRules'
// own catch turns this into a rule-crashed defect), rather than quietly
// falling back to some other list: a fallback here is exactly how the
// secrets rule came to read a set nobody enumerated.
function filesForRule(rule, files, context) {
  if (rule.scansEveryFile !== true) return files;
  const handed = context.secretScan?.files;
  if (!Array.isArray(handed)) {
    throw new Error(`the ${rule.id} rule reads every file a push could publish, and this run handed it no such set`);
  }
  return handed;
}

// A vault's absolute path, removed from a message before it is shown
// (final fix round 2). An error raised while a rule ran can carry the
// path the operating system was given, and an absolute path names the
// machine and the person it belongs to; a report is read in pull requests
// and pasted into issues. Every occurrence of the vault root is replaced
// by the vault itself, ".", so what is left still says which file it was.
function withoutVaultRoot(message, root) {
  if (typeof message !== 'string' || typeof root !== 'string' || root === '') return message;
  return message.split(root).join('.');
}

export function runLintRules(files, context, scope) {
  const findings = [];
  for (const rule of LINT_RULES) {
    const severity = severityFor(rule, context.config);
    if (severity === 'off') continue;
    let partials;
    try {
      partials = rule.check(filesForRule(rule, files, context), context, scope);
    } catch (error) {
      findings.push({
        ruler: 'lint',
        id: rule.id,
        check: 'rule-crashed',
        severity: 'error',
        defect: true,
        file: null,
        line: null,
        absence: false,
        messageKey: 'lint.tool_defect.rule_crashed',
        params: { rule: rule.id, message: withoutVaultRoot(error.message, context.root) },
      });
      continue;
    }
    for (const partial of partials) {
      findings.push({
        ruler: 'lint',
        id: rule.id,
        check: partial.check,
        severity: VALID_SEVERITIES.has(partial.severity) ? partial.severity : severity,
        defect: partial.defect === true,
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
