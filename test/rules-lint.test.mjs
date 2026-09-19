// The lint ruler: whether a vault's content is HEALTHY, as against
// conformant (src/rules/spec.mjs) or in-house-style (src/rules/house.mjs).
// This file mirrors test/rules-house.test.mjs's own scaffolding: a real,
// on-disk vault per test (via makeVault), a real loadConfig + walkVault
// pass, and runLintRules called exactly the way src/commands/lint.mjs
// (a later task) will call it.
//
// Task 3 owns exactly three rules, all three judging the VAULT AS A
// WHOLE (see src/rules/lint.mjs's own header): index-completeness, the
// orphan rule and the column check. Every test below passes a real,
// correctly-shaped scope object rather than null or {}, specifically so
// a rule that started reading it by mistake would be caught reading a
// shape that answers a different question than "is this the whole
// vault", not merely fail to crash on an absent one.
//
// Fix round 1 (review of commit ce13e38). The review's single most
// important finding was that this file's own fixtures for the columns
// rule PASSED only because they were written to match the
// implementation rather than the format: a section heading spelled as a
// seventh table column, because the code expected one there. Every
// fixture below that stands in for "a correct file of this kind" is
// therefore built from what the vault's own configuration says that
// file actually contains (`taxonomy.columns.<name>.labels`, e.g.
// "open_heading": "## Open" means the follow-ups file has a real
// markdown heading spelled that way, with a real table under it, not a
// seventh column), and each such fixture says so in its own comment. A
// fixture standing in for a VIOLATION is not held to that standard: a
// mismatch test needs a defect, and a human typo or an ad hoc extra
// column is exactly the kind of defect this rule exists to catch.
//
// Example data throughout: the fictional owner Ana, example.com, and
// plain English taxonomy (people/, projects/, decisions/, pending/,
// core/, memory/), per this project's own standing rule; "Bruno" is an
// established second persona across this suite's own fixtures
// (test/rules-house.test.mjs uses it throughout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { walkVault } from '../src/vault.mjs';
import { LINT_RULES, runLintRules, displaySecretPattern } from '../src/rules/lint.mjs';
import { createTranslator } from '../src/lang.mjs';
import { OVERALL_SCAN_TIMEOUT_MS, PERSONAL_PATTERN_LABEL } from '../src/leak.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

const englishFor = createTranslator('en');
function renderedMessage(finding) {
  return englishFor(finding.messageKey, finding.params ?? {});
}

// Shaped exactly per src/git.mjs's own scope contract (task 1). The
// three task-3 rules ignore it outright; passing a real, correctly-shaped
// value, rather than null or {}, is what actually proves that: a rule
// that started reading `scope.files` by mistake would see an
// always-empty array here and silently misbehave on every fixture
// below, rather than throwing on a missing method the way a lazier
// stand-in (null, undefined) would. For the two task-4 rules (tables,
// style), which DO read `addedLines`, this same object doubles as "every
// line of every file is in scope" (a `null` return, per the scope
// contract, means exactly that), which is the correct default for every
// test in this file that is not itself testing scoping: a test that
// wants a NARROWER scope builds one with scopeFor, below, instead.
const IGNORED_SCOPE = { files: [], addedLines: () => null };

// Builds a scope whose `addedLines` answers per file from a plain map,
// for tests that need to prove tables/style actually consult the scope
// rather than always seeing "everything is in scope" (IGNORED_SCOPE,
// above). `linesByFile` maps a relative path to either an array of
// 1-based line numbers (turned into the Set the contract requires) or
// `null` (the untracked-file reading: every line of that file counts).
// A file named in neither `linesByFile` NOR requested here at all gets
// an EMPTY set, not `null`: a file the scope never mentions has nothing
// of its own added, exactly like a tracked file a diff left untouched.
function scopeFor(linesByFile) {
  return {
    files: Object.keys(linesByFile),
    addedLines(relPath) {
      const value = linesByFile[relPath];
      if (value === undefined) return new Set();
      return value === null ? null : new Set(value);
    },
  };
}

// Builds the { files, context } pair src/commands/lint.mjs (a later
// task) will hand this ruler, from a real, on-disk vault, exactly as
// test/rules-house.test.mjs's own rulerArgsFor does for the other two
// rulers.
function rulerArgsFor(root, config) {
  const all = walkVault(root, config, { all: true });
  const files = all.filter((path) => path.endsWith('.md'));
  const cache = new Map();
  const context = {
    root,
    config,
    all: new Set(all),
    readFile(relPath) {
      if (!cache.has(relPath)) {
        let text = readFileSync(join(root, relPath), 'utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.replace(/\r\n?/g, '\n');
        cache.set(relPath, text);
      }
      return cache.get(relPath);
    },
  };
  return { files, context };
}

function findingsFor({ files = {}, config = {}, scope = IGNORED_SCOPE } = {}) {
  const root = makeVault({ files, config });
  const loaded = loadConfig(root);
  const { files: mdFiles, context } = rulerArgsFor(root, loaded);
  return runLintRules(mdFiles, context, scope);
}

function isLint(id) {
  return (f) => f.ruler === 'lint' && f.id === id;
}
function isLintCheck(id, check) {
  return (f) => f.ruler === 'lint' && f.id === id && f.check === check;
}

// --- shape of the ruler itself -----------------------------------------------------

test('LINT_RULES is the eight rules this ruler owns, each with a stable id and its own lint.<key> setting name', () => {
  assert.deepEqual(
    LINT_RULES.map((r) => ({ id: r.id, settingKey: r.settingKey })),
    [
      { id: 'index-completeness', settingKey: 'index_completeness' },
      { id: 'orphans', settingKey: 'orphans' },
      { id: 'columns', settingKey: 'columns' },
      { id: 'tables', settingKey: 'tables' },
      { id: 'style', settingKey: 'style' },
      { id: 'secrets', settingKey: 'secrets' },
      { id: 'privacy', settingKey: 'privacy' },
      { id: 'attribution', settingKey: 'attribution' },
    ],
  );
});

test('every finding carries ruler "lint" and a severity, never a conformance level', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ghost.md': '# Ghost\n' };
  const findings = findingsFor({ files });
  assert.ok(findings.length > 0, 'expected at least one finding to inspect');
  for (const finding of findings) {
    assert.equal(finding.ruler, 'lint');
    assert.equal('level' in finding, false, 'a lint finding must never carry a conformance level');
    assert.ok(['error', 'warn', 'off'].includes(finding.severity), `unexpected severity "${finding.severity}"`);
  }
});

// --- index-completeness: "every directory holding a markdown file has an index.md" -

test('index-completeness reports a directory holding a markdown file with no index.md, beside a sibling directory that has one and is not reported', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n[Projects](projects/)\n',
    'people/ana.md': '# Ana\n',
    'projects/index.md': '# Projects\n',
    'projects/proj.md': '# Proj\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('index-completeness', 'directory-has-index'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'people/index.md');
  assert.equal(findings[0].line, null);
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].params.dir, 'people'); // fix round 1: the directory a finding is about should not have to be inferred from a path that, by definition, does not exist
  assert.equal(findings[0].severity, 'warn'); // this task's own example config's own default for this setting
  assert.match(renderedMessage(findings[0]), /index\.md/);
  assert.match(renderedMessage(findings[0]), /people/);
});

test('with no root index.md at all, index-completeness reports the root itself missing rather than every directory unlinked', () => {
  const files = { 'notes.md': '# Stray\n' };
  const findings = findingsFor({ files }).filter(isLint('index-completeness'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'directory-has-index');
  assert.equal(findings[0].file, 'index.md');
  assert.equal(findings[0].params.dir, '.');
});

// Fix round 1 (review finding 5 and finding 7): the previous version of
// this guard was tested only with a vault whose sole markdown file sat
// at the root ("notes.md" above), so the loop body the early return
// protects (reading index.md's own links, once per first-level
// directory) never ran, and the guard was never actually exercised.
// With a subdirectory in play, dropping the guard makes this rule call
// context.readFile('index.md') on a file that does not exist, an ENOENT
// crash rather than a report, which is exactly what the brief forbids.
test('with no root index.md at all, a vault whose markdown lives only in a subdirectory still reports every missing index without crashing, and reports nothing about links it cannot read', () => {
  const files = { 'people/a.md': '# A\n' };
  const findings = findingsFor({ files }).filter(isLint('index-completeness'));
  const byCheck = (check) => findings.filter((f) => f.check === check);
  // "." is an ancestor of every file, so the root's own absence is
  // reported here too, not only "people/index.md" (fix round 1 item 2:
  // the ancestor-chain reading of clause 1 catches this at every depth).
  assert.deepEqual(byCheck('directory-has-index').map((f) => f.file).sort(), ['index.md', 'people/index.md']);
  assert.equal(byCheck('root-links-directory').length, 0, 'with no index.md to read, this clause must say nothing rather than crash trying');
});

// --- index-completeness: "the root index links every first-level directory" --------

test('index-completeness reports a first-level directory the root index never links, beside one it links as a bare directory and one it links straight to its own index.md', () => {
  const files = {
    'index.md': '# Welcome\n\n[Projects](projects/)\n\n[Decisions](decisions/index.md)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
    'projects/index.md': '# Projects\n',
    'projects/proj.md': '# Proj\n',
    'decisions/index.md': '# Decisions\n',
    'decisions/d1.md': '# D1\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('index-completeness', 'root-links-directory'));
  assert.equal(findings.length, 1, 'only the unlinked directory should be reported');
  assert.equal(findings[0].file, 'index.md');
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].params.dir, 'people');
  assert.match(renderedMessage(findings[0]), /people/);
});

// Fix round 1: a root link to a directory's index.md that does NOT
// exist must not count as linking that directory (review finding, the
// clause list's #1: rootLinksDirectory's 'in-walk' guard). Paired with
// the accepted, existing "decisions/index.md" link in the same fixture
// so the distinction is visible in one test: a link to a real index.md
// clears the clause; a link to a non-existent one does not.
test('a root link straight to a directory own index.md that does not exist does not count as linking that directory', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/index.md)\n\n[Decisions](decisions/index.md)\n',
    'people/ana.md': '# Ana\n', // no people/index.md: the link above is broken
    'decisions/index.md': '# Decisions\n',
    'decisions/d1.md': '# D1\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('index-completeness', 'root-links-directory'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].params.dir, 'people');
});

test('a markdown file sitting directly at the vault root is never mistaken for a first-level directory the root index must link', () => {
  const files = {
    'index.md': '# Welcome\n', // links nothing, and "BOOTSTRAP.md" needs no link: it is not a directory
    'BOOTSTRAP.md': '# Bootstrap\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('index-completeness', 'root-links-directory'));
  assert.deepEqual(findings, [], 'a root-level file must never be treated as a first-level directory needing a root link');
});

// Fix round 1 (review finding 2, "the containment question"): this test
// used to assert the OPPOSITE of what it asserts now. The previous
// reading (direct containment only) let a directory holding markdown
// only through a nested subdirectory go without its own index.md, which
// combined with a bare directory link and with the orphan rule's own
// directory-follow-into-index behaviour to produce a storm of unrelated
// "unreachable note" findings with no single finding ever naming the
// real cause: the missing index.md at the directory the root actually
// linked. Requiring an index.md at every directory ON THE PATH to a
// note, not only its immediate parent, is what makes that one missing
// file the thing a person is told.
test('a directory holding markdown only through a nested subdirectory needs its own index.md too, at every level between it and the note', () => {
  const files = {
    'index.md': '# Welcome\n', // deliberately links nothing at all
    'people/team/index.md': '# Team\n',
    'people/team/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('index-completeness'));
  const byCheck = (check) => findings.filter((f) => f.check === check);

  // Both "people" (an ancestor, not a direct parent) and "people/team"
  // (the direct parent) now need their own index.md.
  assert.deepEqual(byCheck('directory-has-index').map((f) => f.file).sort(), ['people/index.md']);
  // clause 2: "people" is the first-level directory whose subtree holds
  // a real note, so the root never linking it at all is reported too.
  assert.equal(byCheck('root-links-directory').length, 1);
  assert.equal(byCheck('root-links-directory')[0].params.dir, 'people');
});

// The scenario the review built to show the containment question has
// teeth: a bare directory link into a directory with NOTHING pointing a
// reader any deeper, so BEFORE fix round 1 the vault produced an orphan
// storm (every note under "projects/" reported unreachable) with no
// finding ever naming the one file that would fix it. After the fix,
// index-completeness names it directly.
test('a directory link that reaches nothing at all is named by index-completeness, not left for the orphan count alone to imply', () => {
  const files = {
    'index.md': '# Welcome\n\n[Projects](projects/)\n',
    // No projects/index.md at all: the link above resolves (it is a real
    // directory) but has nothing to hand a reader once they arrive.
    'projects/2026/q1/plan.md': '# Q1 plan\n',
  };
  const completeness = findingsFor({ files }).filter(isLint('index-completeness'));
  const missing = completeness.filter((f) => f.check === 'directory-has-index').map((f) => f.file).sort();
  // Every directory on the path to the one real note needs its own
  // index.md now: the one closest to the root ("projects/index.md") is
  // the actual fix, and it is present in this list, not merely implied
  // by a pile of orphan findings elsewhere.
  assert.deepEqual(missing, ['projects/2026/index.md', 'projects/2026/q1/index.md', 'projects/index.md']);
  assert.equal(completeness.filter((f) => f.check === 'root-links-directory').length, 0, 'the bare directory link does satisfy clause 2 on its own');

  // The orphan rule still (correctly) reports the note unreachable, since
  // nothing in this vault actually links to it: the two findings
  // together now tell the whole story, cause and effect, instead of the
  // effect alone.
  const orphanFindings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(orphanFindings.map((f) => f.file), ['projects/2026/q1/plan.md']);
});

// --- orphans: "every note is reachable by following links from the root index" -----

test('a note reachable only through an unreachable note is itself unreachable, beside a note the root reaches directly', () => {
  const files = {
    'index.md': '# Welcome\n\n[A](people/a.md)\n',
    'people/a.md': '# A\n', // reachable directly from root; links nowhere further
    'people/b.md': '# B\n\n[C](c.md)\n', // never linked by anything reachable
    'people/c.md': '# C\n', // only reachable through b, which is itself unreachable
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file).sort(), ['people/b.md', 'people/c.md']);
  assert.ok(findings.every((f) => f.check === 'reachable-from-root'));
  assert.ok(findings.every((f) => f.severity === 'warn'));
  assert.ok(findings.every((f) => f.messageKey === 'lint.orphans.unreachable'));
  assert.ok(findings.every((f) => f.line === null));
});

test('a reserved filename is never reported as an orphan, beside an ordinary unreachable note that is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'memory/log.md': '# Log\n', // reserved: structure, not content, however unreachable
    'people/ghost.md': '# Ghost\n', // ordinary: unreachable and reported
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/ghost.md']);
});

test('an unreachable NESTED index.md is exempt the same way the root one trivially is, beside an ordinary unreachable note in the same directory', () => {
  const files = {
    'index.md': '# Welcome\n', // deliberately never links "people/" at all
    'people/index.md': '# People\n', // reserved, unreachable, never reported
    'people/ghost.md': '# Ghost\n', // ordinary, unreachable, reported
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/ghost.md']);
});

// Fix round 1 (review finding 4): a template is structure a vault ships
// with, not content a reader navigates to. taxonomy.templates_dir in
// this task's own example config is "templates".
test('a note under the configured templates directory is never reported as an orphan, beside an ordinary unreachable note that is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'templates/template-person.md': '---\ntype: person\n---\n# <name>\n',
    'people/ghost.md': '# Ghost\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/ghost.md']);
});

test('a link to a directory reaches every note inside it through that directory own index', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n',
    'people/index.md': '# People\n\n[Ana](ana.md)\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

test('a link to a directory that has no index.md of its own does not reach anything inside it', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n',
    'people/ana.md': '# Ana\n', // no people/index.md at all
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/ana.md']);
});

test('a link through a non-markdown attachment is never followed into that attachment own content, even when the attachment happens to contain markdown-shaped link text', () => {
  const files = {
    'index.md': '# Welcome\n\n[Details](attachments/notes.txt)\n',
    // A real, walked, non-markdown file: this rule must treat reaching
    // IT as reaching an attachment, never as a reason to go on reading
    // ITS content for more links the way it reads a real note's body.
    'attachments/notes.txt': 'See [Hidden](../people/hidden.md) for more.\n',
    'people/hidden.md': '# Hidden\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/hidden.md'], 'a link inside an attachment must not make a note reachable');
});

test('a two-note cycle reachable from root terminates and both notes are reachable, not reported as orphans', () => {
  const files = {
    'index.md': '# Welcome\n\n[A](people/a.md)\n',
    'people/a.md': '# A\n\n[B](b.md)\n',
    'people/b.md': '# B\n\n[Back to A](a.md)\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

test('with no root index.md at all, the orphan rule reports nothing rather than flagging every file for the same one reason', () => {
  const files = { 'notes.md': '# Stray\n', 'more.md': '# More\n' };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

// --- orphans: wikilinks and reference-style links (fix round 1, item 3) -----------

test('a note reached only through a wikilink is reachable, not an orphan, and an alias after "|" is ignored when resolving the target', () => {
  const files = {
    'index.md': '# Welcome\n\nSee [[bruno]] and [[bruno|the other person]] for context.\n',
    'bruno.md': '# Bruno\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

test('a wikilink written as an explicit relative path with its own extension is resolved as written, not doubled with ".md"', () => {
  const files = {
    'index.md': '# Welcome\n\n[[people/bruno.md]]\n',
    'people/bruno.md': '# Bruno\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

test('a wikilink to a directory reaches that directory own index, exactly like an ordinary directory link', () => {
  const files = {
    'index.md': '# Welcome\n\n[[people]]\n',
    'people/index.md': '# People\n\n[Ana](ana.md)\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings, []);
});

// A declared trade-off (see src/rules/lint.mjs's own header, judgment
// call 4), pinned rather than left silent: resolving a reference-style
// link needs a second pass collecting every "[label]: target" definition
// in the file before a single usage can be read, which house.mjs's own
// header already calls "a materially bigger feature" than this rule's
// other link handling and declines project-wide. Building it only here
// would let this one rule disagree with link-target-exists and
// link-style about what a link even is. This test exists so that
// disagreement is a known, accepted limitation, not a silent gap: if
// this ever starts passing with an empty result, it is because someone
// built real reference-style resolution, and this test should be
// rewritten to expect that.
test('a note reached only through a reference-style link is still reported as an orphan: a declared, accepted limitation, not a silent gap', () => {
  const files = {
    'index.md': '# Welcome\n\nSee [Ana][ana-ref] for context.\n\n[ana-ref]: people/ana.md\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('orphans'));
  assert.deepEqual(findings.map((f) => f.file), ['people/ana.md']);
});

// --- columns: "a file named under taxonomy.files carries the exact column headings"-
//
// This task's own example config's rituals contract
// (taxonomy.columns.rituals.columns, taxonomy.files.rituals ==
// "core/weekly-rhythm.md") declares, in order: Calendar title, Cadence,
// Time, Owner, Fixed attendees, Feeds. Its "labels" ("feeds_none": "none
// yet") is the placeholder text a "Feeds" CELL shows when a ritual feeds
// nothing forward, per this task's own report and the review that
// followed it, never a column of its own; fixtures below use it exactly
// that way, as a cell value under the real "Feeds" column, sourced
// directly from the label's own name and meaning rather than invented.

test('a ritual file whose table matches the configured columns exactly is not reported, and "none yet" (the configured empty-feeds label) appears correctly as a cell value, not a column', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      '# Weekly rhythm',
      '',
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds |',
      '|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | Team | none yet |',
      '| 1:1 with Bruno | Weekly | 15:00 | Ana | Bruno | Sprint planning |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

test('columns reports the first heading that differs, case sensitively, tolerating only surrounding whitespace, and never a later difference in the same row', () => {
  const files = {
    'index.md': '# Welcome\n',
    // Frontmatter plus a leading line of prose and a blank line before
    // the table itself, so the finding's own line number has to add a
    // real frontmatter offset (bodyPrefixLineCount) to a real
    // body-relative position (the table's own lineIndex) rather than
    // happening to be right by only ever testing a header sitting on a
    // file's very first line.
    'core/weekly-rhythm.md': [
      '---',
      'type: note',
      '---',
      'Some intro line before the table.',
      '',
      // Two real divergences here on purpose ("cadence" and "OWNER"):
      // only the first may ever be reported.
      '| Calendar title  |cadence| Time | OWNER | Fixed attendees | Feeds |',
      '|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | Team | none yet |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1, 'only the first divergence should be reported, not the later OWNER/Owner one too');
  const finding = findings[0];
  assert.equal(finding.check, 'columns-match');
  assert.equal(finding.absence, false);
  assert.equal(finding.severity, 'error'); // this task's own example config's own default for this setting
  assert.equal(finding.file, 'core/weekly-rhythm.md');
  assert.equal(finding.line, 6); // 3 frontmatter lines, an intro line, a blank line, then the header row
  assert.equal(finding.params.index, 2);
  assert.equal(finding.params.expected, 'Cadence');
  assert.equal(finding.params.found, 'cadence');
  assert.match(renderedMessage(finding), /Cadence/);
  assert.match(renderedMessage(finding), /cadence/);
});

// Fix round 1: a heading containing the table's own separator character
// is written with it backslash-escaped, and matched in that same
// escaped form (docs/incidents.md, "the deduplication key had to be the
// escaped literal title": "the column names are an interface... keep it
// escaped to write and to match in a markdown table"). "Blocks |
// Blocked by" replaces "Fixed attendees" for this test alone (a
// dependency-tracking column combining two related ideas with the
// separator itself, plausible content for a ritual table, not merely a
// string chosen to satisfy the parser) so the declared heading and the
// table's own header cell can both carry a real escaped pipe.
test('a column heading containing the table separator character, written escaped in both the configuration and the file, matches and is not reported', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      '| Calendar title | Cadence | Time | Owner | Blocks \\| Blocked by |',
      '|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | none |',
    ].join('\n'),
  };
  const config = { taxonomy: { columns: { rituals: { columns: ['Calendar title', 'Cadence', 'Time', 'Owner', 'Blocks \\| Blocked by'] } } } };
  const findings = findingsFor({ files, config }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

// "Compares after trimming" (the brief's own words) applies to the
// CONFIGURED heading, not only to what the table itself contains: a
// vault owner's own config can carry incidental whitespace around a
// value just as easily as a table cell can.
test('a configured heading padded with its own whitespace still matches a table cell with none', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds |',
      '|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | Team | none yet |',
    ].join('\n'),
  };
  const config = { taxonomy: { columns: { rituals: { columns: ['Calendar title', '  Cadence  ', 'Time', 'Owner', 'Fixed attendees', 'Feeds'] } } } };
  const findings = findingsFor({ files, config }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

test('columns reports a file with no table at all, beside a sibling configured file whose two-section table matches exactly and is not reported', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': 'This file will list our weekly rituals once we schedule them.\n',
    // Sourced from taxonomy.columns.followups.labels ("open_heading":
    // "## Open", "resolved_heading": "## Resolved"): a real follow-ups
    // file this task's own configuration describes has two SECTIONS,
    // each with its own real markdown heading and its own table under
    // it, both tables sharing the same 5 declared columns. Only the
    // FIRST table (under "## Open") is what this rule reads.
    'pending/follow-ups.md': [
      '# Follow-ups',
      '',
      '## Open',
      '',
      '| Logged | What | With whom / where | Deadline | Next step |',
      '|---|---|---|---|---|',
      '| 01/01/2026 | Ping Bruno about the review | Bruno / Slack | 05/01/2026 | Wait for reply |',
      '',
      '## Resolved',
      '',
      '| Logged | What | With whom / where | Deadline | Next step |',
      '|---|---|---|---|---|',
      '| 20/12/2025 | Confirm the schema change | Ana / call | 22/12/2025 | none |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1, 'the matching, two-section follow-ups file must not be reported');
  assert.equal(findings[0].check, 'table-present');
  assert.equal(findings[0].file, 'core/weekly-rhythm.md');
  assert.equal(findings[0].line, null);
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].messageKey, 'lint.columns.missing_table');
});

test('a table shown only as a fenced code example does not satisfy the column check, and is reported the same as having no table at all', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      'Here is an example of the shape our ritual table should take:',
      '',
      '```',
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds |',
      '|---|---|---|---|---|---|',
      '```',
      '',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'table-present');
});

// Fix round 1 (review finding 6): the loop bound that stops this
// function from ever reading one line past the end of the file is its
// own crash guard, and needs a fixture where the table-shaped candidate
// line really is the LAST line, with nothing after it to check as a
// delimiter row.
test('a file whose very last line looks like a table header, with nothing after it, reports no table rather than crashing', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': 'Some notes about timing.\n\n| Calendar title | Cadence |',
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'table-present');
});

// Fix round 1 (review finding 6): a partially-dash delimiter candidate
// ("one real delimiter cell, one that is not") must not be accepted, and
// an alignment row (leading/trailing colons) must be, both of which the
// previous test suite left completely unexercised.
test('a delimiter row is rejected the moment ANY one of its cells is not delimiter-shaped, beside a real alignment row (leading and trailing colons) which is accepted', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': ['| Calendar title | Cadence |', '|---|not-a-dash|', '| Standup | Daily |'].join('\n'),
    'pending/promises.md': [
      '| Made on | To whom | What I promised | Condition / deadline | Status |',
      '|:---|---|---|---:|:-:|',
      '| 01/01/2026 | Bruno | Help him prep the review | none | Open |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  // The bogus delimiter row means weekly-rhythm.md has no table at all;
  // the real alignment row means promises.md's table is read and its
  // (correct) headers produce no mismatch finding.
  assert.deepEqual(findings.map((f) => f.check), ['table-present']);
  assert.equal(findings[0].file, 'core/weekly-rhythm.md');
});

// A table row indented with its own leading whitespace before the first
// pipe (pasted from an editor that auto-indents, or written under a list
// item) must still be read correctly: the leading spaces belong to the
// ROW, not to its first cell.
test('a table row indented with its own leading whitespace still matches the declared columns exactly', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      '  | Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds |',
      '  |---|---|---|---|---|---|',
      '  | Standup | Daily | 09:00 | Ana | Team | none yet |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

test('a table with fewer columns than declared (an older ritual entry, before "Feeds" was tracked) reports the first missing heading as absent, beside one with an extra ad hoc column reporting the extra heading as unexpected', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      '| Calendar title | Cadence | Time | Owner | Fixed attendees |',
      '|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | Team |',
    ].join('\n'),
    'pending/promises.md': [
      '| Made on | To whom | What I promised | Condition / deadline | Status | Notes |',
      '|---|---|---|---|---|---|',
      '| 01/01/2026 | Bruno | Help him prep the review | none | Open | ad hoc column |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 2);

  const short = findings.find((f) => f.file === 'core/weekly-rhythm.md');
  assert.equal(short.params.index, 6);
  assert.equal(short.params.expected, 'Feeds');
  assert.equal(short.params.found, '(none)');

  const long = findings.find((f) => f.file === 'pending/promises.md');
  assert.equal(long.params.index, 6);
  assert.equal(long.params.expected, '(none)');
  assert.equal(long.params.found, 'Notes');
});

test('columns silently skips a configured file that does not exist in this vault, beside one that does and whose table matches exactly', () => {
  const files = {
    'index.md': '# Welcome\n',
    // "pending/promises.md" is named under taxonomy.files.promises but is
    // never written into this vault at all.
    'core/weekly-rhythm.md': [
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds |',
      '|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | Team | none yet |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

test('columns makes no claim about a declared column set whose file is configured as null', () => {
  const files = { 'index.md': '# Welcome\n' };
  const config = { taxonomy: { files: { rituals: null } } };
  const findings = findingsFor({ files, config }).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

// Fix round 1 (review finding 7): loadConfig's schema rejects a null or
// malformed taxonomy.columns.<name> entry, but this module's own header
// claims it never trusts the shape of configuration, and the test suite
// itself (this test included) already builds contexts that bypass
// loadConfig entirely. This calls runLintRules directly with a
// hand-built, never-validated config, the only way to exercise the
// guard that keeps this from throwing on Object.values(null) et al.
test('a null or malformed taxonomy.columns.<name> entry, reached by bypassing loadConfig entirely, is skipped rather than thrown on', () => {
  // Both configured files are actually written into the vault, and
  // named under taxonomy.files here (this test bypasses loadConfig
  // entirely, so it declares its own, deliberately malformed
  // taxonomy.columns): without a real file at each configured path, the
  // "does this file exist in the walk" guard would `continue` before
  // ever reaching declaredHeadings, and the two malformed shapes below
  // would go completely unexercised despite the test's own name.
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': '| A | B |\n|---|---|\n| x | y |\n',
    'pending/promises.md': '| A | B |\n|---|---|\n| x | y |\n',
  };
  const root = makeVault({ files });
  const config = {
    taxonomy: {
      files: { rituals: 'core/weekly-rhythm.md', promises: 'pending/promises.md' },
      columns: { rituals: null, promises: { columns: 'not-an-array' } },
    },
  };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  assert.doesNotThrow(() => runLintRules(mdFiles, context, IGNORED_SCOPE));
  const findings = runLintRules(mdFiles, context, IGNORED_SCOPE).filter(isLint('columns'));
  assert.deepEqual(findings, []);
});

// --- tables: "a table is preceded by a blank line, carries no duplicated data row, -
//     and no cell exceeds max_cell_chars" -------------------------------------------
//
// Unlike the three rules above, tables (and style, further below) READ
// the scope: every fixture in this section builds one with scopeFor
// rather than reusing IGNORED_SCOPE, specifically to prove each check
// only fires for a table whose own lines this change actually added.

test('tables reports a table whose header has no blank line before it, when the header line is one this change added', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '| A | B |', '|---|---|', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'core/notes.md');
  assert.equal(findings[0].line, 2);
  assert.match(renderedMessage(findings[0]), /blank/);
});

// --- Fix round 1 (review of commit 0718c40) -----------------------------------------
//
// Finding 1, CRITICAL and half the plan's own doing: the plan settled
// that this rule judges a table as a WHOLE once the change touches any
// one of its lines (docs/superpowers/plans, "docs: settle what the
// scope means for a table"), which means a finding can legitimately
// name a line the change never added. What was actually wrong is that
// none of this rule's three messages said so; every one of them now
// does (lang/en/messages.json, lang/pt-BR/messages.json). The three
// tests below pin, in order: the message says why on the check that
// started this (blank-line), that a finding CAN legitimately name an
// untouched line (documenting the ratified design, not a defect), and
// that the other two checks carry the same explanation.

test('the blank-line-before-table message explains that the change touched the table, not only the line it names', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '| A | B |', '|---|---|', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2] });
  const [finding] = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.match(renderedMessage(finding), /touched the table/);
});

test('a finding can legitimately name a line this change never added, because the change touched some OTHER line of the same table: the ratified design, not a defect', () => {
  const files = {
    'index.md': '# Welcome\n',
    // Only the last row (line 6) is added; the header at line 2 and its
    // missing blank line were already there before this change.
    'core/notes.md': ['intro', '| A | B |', '|---|---|', '| x | 1 |', '| y | 2 |', '| z | 3 |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [6] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2, 'the finding correctly names the untouched header line, since the check is about the table as a whole');
  assert.match(renderedMessage(findings[0]), /touched the table/, 'and says out loud why an untouched line is being named');
});

test('the duplicate-row and cell-too-long messages explain the same table-wide scoping the blank-line message does', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3, 4] });
  const duplicateFindings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.equal(duplicateFindings.length, 1);
  assert.match(renderedMessage(duplicateFindings[0]), /touched the table/);

  const cellFiles = {
    'index.md': '# Welcome\n',
    'core/notes.md': [`| ${'x'.repeat(5)} | B |`, '|---|---|', '| a | y |'].join('\n'),
  };
  const cellScope = scopeFor({ 'core/notes.md': [1] });
  const config = { lint: { tables: { max_cell_chars: 4 } } };
  const cellFindings = findingsFor({ files: cellFiles, scope: cellScope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.equal(cellFindings.length, 1);
  assert.match(renderedMessage(cellFindings[0]), /touched the table/);
});

// Finding 2, CRITICAL: a prose line containing a separator, sitting
// above a bare run of dashes, used to be read as a table. The fix
// (findAllTables, above) requires the delimiter row to carry a pipe of
// its own; these two are the real-world shapes the review named, a
// setext heading and a link title, neither of which is a table under
// any markdown reading.

test('a setext heading whose text uses a separator as punctuation is never mistaken for a table, even though its text line contains a separator', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['intro', 'Cost is a | b dollars', '---', 'more'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2, 3] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('a link whose title contains a separator, sitting above a thematic break, is never mistaken for a table', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['intro', 'See [x](y.md "a | b") here', '---', 'more'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2, 3] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

// Finding 5, IMPORTANT: two tables with no blank line between them used
// to be read as one, swallowing the second table's own header and
// delimiter as data of the first, which hid its missing blank line.

test('two tables with no blank line between them are read as two tables, not one, and the second table missing blank line is still caught', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro.', '', '| A | B |', '|---|---|', '| x | 1 |', '| C | D |', '|---|---|', '| y | 2 |'].join('\n'),
  };
  // Only the second table's own header line is marked as added: if the
  // two tables were still read as one, none of the second table's own
  // lines (falsely absorbed as data of the first) would ever be
  // recognised as a header at all, and this finding would not exist.
  const scope = scopeFor({ 'core/notes.md': [6] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 6);
});

test('the first of two back-to-back tables keeps only its own real data row: the second table header and delimiter are never absorbed as data of the first', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro.', '', '| A | B |', '|---|---|', '| x | 1 |', '| C | D |', '|---|---|', '| y | 2 |'].join('\n'),
  };
  // The two "| A | B |" style rows are never actually written here, so a
  // duplicate-row finding can only appear if the second table header
  // ("| C | D |") were wrongly compared as a data row of the first
  // against something identical, which it is not; this test instead
  // pins the ABSENCE of any duplicate-row finding when nothing is
  // actually duplicated, as a control for the fixture above.
  const scope = scopeFor({ 'core/notes.md': [3, 4, 5, 6, 7, 8] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.deepEqual(findings, []);
});

// Finding 6, IMPORTANT: a prose line with a separator, immediately
// after a table with no blank line separating them, is a defensible
// parse as more data (GFM's own lazy continuation), but a cell-length
// finding against a sentence is not an actionable message. The
// cell-length check now skips a row whose cell count does not match
// the header's.

test('a prose line absorbed as a data row by lazy continuation does not trigger a cell-length finding when its cell count does not match the header', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', '| x | 1 |', `Rates: ${'z'.repeat(50)} | more | text here.`].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [4] });
  const config = { lint: { tables: { max_cell_chars: 8 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

// Finding 7, MINOR: cell-too-long used to measure the escaped source
// form of a cell, overcounting by one character per literal separator
// the cell renders, against this project's own established practice
// (docs/incidents.md) of writing and matching a separator escaped.

test('cell length is measured on the unescaped, rendered text, not the escaped source form: an established escaped separator does not inflate the count', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A |', '|---|', '| a\\|b\\|c\\|d |'].join('\n'),
  };
  // "a\|b\|c\|d" is 10 characters in the source, 7 once rendered
  // (each "\|" is one rendered pipe); 8 sits strictly between the two.
  const scope = scopeFor({ 'core/notes.md': [3] });
  const config = { lint: { tables: { max_cell_chars: 8 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

// Finding 9, MINOR: eight more clauses the review found no test defended.

test('a table whose delimiter row is the very last line of the file is still found', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro.', '| A | B |', '|---|---|'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1);
});

test('a pipe-less prose line immediately after a table, with no blank line separating them, is never absorbed as a data row', () => {
  const files = {
    'index.md': '# Welcome\n',
    // A single-column table on purpose: the absorbed prose line below
    // also splits into exactly one cell (it has no pipe to split on at
    // all), so its cell count would MATCH the header's and slip past
    // the cell-count filter (finding 6) even if it were wrongly
    // absorbed; only the pipe requirement on the data-row scan itself
    // stops it, which is the clause this test actually isolates.
    'core/notes.md': ['| A |', '|---|', '| 1 |', `${'z'.repeat(50)} no separator here at all.`].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1, 2, 3] });
  const config = { lint: { tables: { max_cell_chars: 8 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

test('touching only a table own delimiter row puts the whole table in scope, exactly like touching its header or a data row', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro.', '| A | B |', '|---|---|', '| x | 1 |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3] }); // only the delimiter row
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1, 'the delimiter row alone must be enough to bring the whole table into scope');
});

test('a non-integer max_cell_chars disables the cell-length check rather than enforcing a fractional limit', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A |', '|---|', '| 1234567 |'].join('\n'), // a 7-character cell
  };
  // Bypasses loadConfig on purpose: the schema itself requires an
  // integer, so this shape can only be reached by a hand-built config.
  const root = makeVault({ files });
  const config = { lint: { tables: { max_cell_chars: 6.5 } } };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const findings = runLintRules(mdFiles, context, scope).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

test('a max_cell_chars of zero disables the cell-length check rather than flagging every non-empty cell', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A |', '|---|', '| x |'].join('\n'),
  };
  // Bypasses loadConfig on purpose: the schema requires a minimum of 1.
  const root = makeVault({ files });
  const config = { lint: { tables: { max_cell_chars: 0 } } };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const findings = runLintRules(mdFiles, context, scope).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

test('a row with two cells over the limit names the FIRST one, not the last', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', `| ${'x'.repeat(5)} | ${'y'.repeat(9)} |`].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const config = { lint: { tables: { max_cell_chars: 4 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].params, { index: 1, length: 5, max: 4 });
});

test('a whitespace-only line before a table still counts as blank, exactly like a truly empty one', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro.', '   ', '| A | B |', '|---|---|', '| x | 1 |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.deepEqual(findings, []);
});

// Finding 10, assorted. tables now skips reading a file entirely when
// this change added nothing in it, exactly like style already did; the
// review measured one readFile call per file with an empty scope
// before this fix, zero after.

test('tables skips reading a file entirely when this change added nothing in it, exactly like style', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', '| x | y |'].join('\n'),
  };
  const root = makeVault({ files });
  const config = { lint: { tables: 'error' } };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  let readCount = 0;
  const context = {
    root,
    config,
    all: new Set(all),
    readFile(relPath) {
      readCount++;
      return readFileSync(join(root, relPath), 'utf8');
    },
  };
  const tablesRule = LINT_RULES.find((rule) => rule.id === 'tables');
  const scope = scopeFor({ 'index.md': [], 'core/notes.md': [] }); // nothing added anywhere in this change
  tablesRule.check(mdFiles, context, scope);
  assert.equal(readCount, 0, 'a file with nothing added must never be read at all, the same performance path style already takes');
});

// A table inside a blockquote is never detected: the ">" prefix makes
// isDelimiterRow's plain-dashes test fail. Safe direction (a missed
// table, never a false one), now documented in findAllTables's own
// header; pinned here so it stays a declared limitation, not a silent
// gap, matching every other declined shape in this module.
test('a table written inside a blockquote is never detected as a table: a missed table is safer than a false one', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['> | A | B |', '> |---|---|', '> | x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1, 2, 3] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('a table preceded by a real blank line, or sitting at the very start of the body with nothing before it, is not reported for a missing blank line', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '', '| A | B |', '|---|---|', '| x | y |'].join('\n'),
    'core/leading.md': ['| A | B |', '|---|---|', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3], 'core/leading.md': [1] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.deepEqual(findings, []);
});

test('a finding line number correctly adds a real frontmatter offset, not just a body starting at the top of the file', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['---', 'type: note', '---', 'Intro line.', '| A | B |', '|---|---|', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [5] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5); // 3 frontmatter lines, an intro line, then the header row
});

test('tables leaves an untouched table alone, however malformed: none of its own lines is one this change added', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  // This table has no blank line before its header AND a duplicated data
  // row, either of which would be reported if the table were in scope.
  const scope = scopeFor({ 'core/notes.md': [] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('a file the scope has never seen at all (addedLines returns null) has every line in scope, exactly like an untracked file', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/brand-new.md': ['| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/brand-new.md': null });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

test('a duplicated data row is reported at its own line naming the earlier row it duplicates, and a row differing only in trailing whitespace IS a duplicate', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', '| x | y |', '| x | y   |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3, 4] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'core/notes.md');
  assert.equal(findings[0].line, 4);
  assert.equal(findings[0].params.line, 3);
});

test('two data rows that are genuinely different, even by a single non-whitespace character, are never reported as duplicates', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', '| x | y |', '| x | z |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3, 4] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.deepEqual(findings, []);
});

test('a duplicate-row finding carries lint.tables.duplicate_rows as its own severity, independent of lint.tables itself', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '', '| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [5, 6] });
  const config = { lint: { tables: { severity: 'warn', duplicate_rows: 'error' } } };

  const duplicateFindings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.equal(duplicateFindings.length, 1);
  assert.equal(duplicateFindings[0].severity, 'error');

  // A real blank line precedes this header, so this is a control proving
  // the OTHER check made by the same rule call is unaffected, not the
  // thing under test.
  const blankLineFindings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.deepEqual(blankLineFindings, []);
});

test('lint.tables.duplicate_rows set to "off" suppresses only the duplicate-row check, leaving the rule severity blank-line check unaffected', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [2, 4, 5] });
  const config = { lint: { tables: { severity: 'error', duplicate_rows: 'off' } } };

  const duplicateFindings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.deepEqual(duplicateFindings, [], 'duplicate_rows: off must suppress this one check');

  const blankLineFindings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'blank-line-before-table'));
  assert.equal(blankLineFindings.length, 1);
  assert.equal(blankLineFindings[0].severity, 'error', 'the rule-level severity still applies to a check duplicate_rows never touches');
});

// Regression: `duplicate_rows` left unconfigured used to fall back to
// the module's own flat "warn" default no matter what `lint.tables`
// itself resolved to, so setting the WHOLE rule to "error" silently
// left every duplicate-row finding at "warn" unless an adopter also
// named `duplicate_rows` explicitly, a downgrade nobody asked for.
test('leaving lint.tables.duplicate_rows unconfigured inherits the rule own overall resolved severity, rather than silently downgrading it to "warn"', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['# Notes', '', '| A | B |', '|---|---|', '| x | y |', '| x | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [5, 6] });
  const config = { lint: { tables: 'error' } }; // duplicate_rows never named at all
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error', 'an unconfigured duplicate_rows must inherit lint.tables own resolved severity, not fall back to "warn"');
});

test('a cell longer than the configured max_cell_chars is reported once, naming the first offending cell, its length and the configured maximum', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', `| ${'x'.repeat(5)} | ${'y'.repeat(3)} |`].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const config = { lint: { tables: { max_cell_chars: 4 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.deepEqual(findings[0].params, { index: 1, length: 5, max: 4 });
});

test('a cell exactly at the configured maximum is not reported; only a cell strictly over it is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', `| ${'x'.repeat(4)} | y |`].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const config = { lint: { tables: { max_cell_chars: 4 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

test('a missing max_cell_chars disables the cell-length check rather than assuming a made-up default limit', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['| A | B |', '|---|---|', `| ${'x'.repeat(9000)} | y |`].join('\n'),
  };
  // Bypasses loadConfig on purpose (like the malformed-columns test
  // above): this hand-built config gives lint.tables a bare severity
  // string, so it never sets max_cell_chars at all, which the schema
  // itself allows since none of a rule's own settings are required.
  const root = makeVault({ files });
  const config = { lint: { tables: 'error' } };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const scope = scopeFor({ 'core/notes.md': [3] });
  const findings = runLintRules(mdFiles, context, scope).filter(isLintCheck('tables', 'cell-too-long'));
  assert.deepEqual(findings, []);
});

test('a table written entirely inside a fenced code block is not treated as a table at all, even though it would otherwise fail every check', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': [
      'Here is an example table:',
      '',
      '```',
      '| A | B |',
      '|---|---|',
      '| x | y |',
      '| x | y |',
      '```',
    ].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [4, 5, 6, 7] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('an ordinary prose line that happens to contain a pipe is not a table header unless a real delimiter row follows it', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': ['Intro text before it.', 'Not really a table: a | b here.', 'Just another line of prose.'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1, 2, 3] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('a setext heading (a line of text followed by a bare "---") is never mistaken for a headerless, one-column table', () => {
  const files = {
    'index.md': '# Welcome\n',
    // Sits right after non-blank text on purpose: a table scanner that
    // wrongly accepted a pipe-free header would report a missing blank
    // line here, which is exactly what proves this fixture is exercising
    // the pipe requirement and not merely producing a table with nothing
    // else left to report.
    'core/notes.md': ['Intro text right before it.', 'Some heading', '---', '', 'Some prose after it.'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1, 2, 3] });
  const findings = findingsFor({ files, scope }).filter(isLint('tables'));
  assert.deepEqual(findings, []);
});

test('a header cell over max_cell_chars is reported too, not only a data cell: the check reads every row of the table, not merely its data rows', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': [`| ${'x'.repeat(5)} | B |`, '|---|---|', '| a | y |'].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1] });
  const config = { lint: { tables: { max_cell_chars: 4 } } };
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('tables', 'cell-too-long'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.deepEqual(findings[0].params, { index: 1, length: 5, max: 4 });
});

test('two separate tables in the same file are judged independently: an identical row in each is not a cross-table duplicate, and a blank line between them is what tells the scanner they are two tables, not one', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/notes.md': [
      '| A | B |',
      '|---|---|',
      '| x | y |',
      '',
      '| A | B |',
      '|---|---|',
      '| x | y |',
    ].join('\n'),
  };
  const scope = scopeFor({ 'core/notes.md': [1, 3, 5, 7] });
  const findings = findingsFor({ files, scope }).filter(isLintCheck('tables', 'duplicate-row'));
  assert.deepEqual(findings, [], 'the two "| x | y |" rows sit in two different tables, so neither duplicates the other');
});

// --- style: "no forbidden character appears, judged ONLY on lines the scope says --
//     were added" ---------------------------------------------------------------------
//
// This task's own example config (test/fixtures/config/valid.json,
// lint.style.forbidden_chars) already forbids the em dash; every
// fixture below builds it at runtime via String.fromCharCode, never
// literally, per this project's own standing rule against typing a
// unicode escape or a banned character straight into file content.

test('style reports the forbidden character only on the line this change added, not on an identical untouched line, and names the right line number', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [`Ana went to the market ${emDash} it was busy.`, `Bruno went too ${emDash} they met there.`].join('\n'),
  };
  const scope = scopeFor({ 'people/ana.md': [2] });
  const findings = findingsFor({ files, scope }).filter(isLint('style'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'people/ana.md');
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].params.char, emDash);
});

test('a file the scope has never seen at all (addedLines returns null) has every line in scope, exactly like an untracked file', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/new.md': [`Line one ${emDash} has it.`, 'Line two is fine.', `Line three ${emDash} too.`].join('\n'),
  };
  const scope = scopeFor({ 'people/new.md': null });
  const findings = findingsFor({ files, scope }).filter(isLint('style'));
  assert.deepEqual(findings.map((f) => f.line), [1, 3]);
});

test('a forbidden character inside a fenced code block is not a finding, even on a line this change added, because code must stay quotable', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['Some prose.', '', '```', `example ${emDash} text`, '```'].join('\n'),
  };
  const scope = scopeFor({ 'people/ana.md': [4] });
  const findings = findingsFor({ files, scope }).filter(isLint('style'));
  assert.deepEqual(findings, []);
});

test('an empty forbidden_chars list means nothing is ever reported, even on an added line that would otherwise match the example config own default', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': `Ana went to the market ${emDash} it was busy.`,
  };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const config = { lint: { style: { forbidden_chars: [] } } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('style'));
  assert.deepEqual(findings, []);
});

// A guard this rule's own filter (`c.length > 0`, in the check function
// below) exists specifically to defend: String.prototype.indexOf('')
// returns 0 for EVERY string, so an empty string surviving into
// forbiddenChars would make every added line in the whole vault report
// a "forbidden character" at column 0, with no character actually
// forbidden. Deleting that one guard turns this test red without
// touching anything else, which is the point of pinning it: nothing
// else in this file happens to construct a forbidden_chars list with
// an empty string in it.
test('an empty string inside forbidden_chars is never treated as a forbidden character: it must not match every added line at column 0', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': 'This is an ordinary added line with nothing special in it at all.',
  };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const config = { lint: { style: { forbidden_chars: [''] } } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('style'));
  assert.deepEqual(findings, [], 'an empty string must never count as a forbidden character');
});

test('style severity defaults to "warn" when lint.style is left as its object of settings (forbidden_chars, base) with no severity of its own', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': `Ana went to the market ${emDash} it was busy.`,
  };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const findings = findingsFor({ files, scope }).filter(isLint('style'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
});

// Fix carried by this task ahead of its own three new rules: `style`
// used to be the one rule permanently stuck at "warn" because its own
// setting was an object with no `severity` field anywhere in the
// schema. `lint.<rule>` now accepts EITHER a bare severity string OR an
// object carrying `severity` plus that rule's own settings, uniformly
// across every rule in this file; these two tests pin style specifically,
// since it is the rule this defect was found on.
test('lint.style.severity, set inside its own settings object, overrides the default and can turn the rule to "error" or "off"', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': `Ana went to the market ${emDash} it was busy.`,
  };
  const scope = scopeFor({ 'people/ana.md': [1] });

  const errorFindings = findingsFor({ files, scope, config: { lint: { style: { severity: 'error' } } } }).filter(isLint('style'));
  assert.equal(errorFindings.length, 1);
  assert.equal(errorFindings[0].severity, 'error');
  assert.match(renderedMessage(errorFindings[0]), /added/, 'the settings object own forbidden_chars must still be read from the example config even once severity is also set there');

  const offFindings = findingsFor({ files, scope, config: { lint: { style: { severity: 'off' } } } }).filter(isLint('style'));
  assert.deepEqual(offFindings, [], 'an "off" severity inside the settings object must suppress the rule entirely, exactly like a bare "off" string does for every other rule');
});

test('a rule with no settings of its own (orphans) accepts its severity EITHER as a bare string OR as an object carrying only "severity", with identical results', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ghost.md': '# Ghost\n' };

  const bareString = findingsFor({ files, config: { lint: { orphans: 'error' } } }).filter(isLint('orphans'));
  const objectForm = findingsFor({ files, config: { lint: { orphans: { severity: 'error' } } } }).filter(isLint('orphans'));
  assert.equal(bareString.length, 1);
  assert.deepEqual(bareString.map((f) => f.severity), objectForm.map((f) => f.severity));
  assert.equal(objectForm[0].severity, 'error');
});

test('the style message itself says it only judges lines this change added, not the vault own existing prose', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': `Ana went to the market ${emDash} it was busy.`,
  };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const [finding] = findingsFor({ files, scope }).filter(isLint('style'));
  assert.match(renderedMessage(finding), /added/);
});

test('when a line carries more than one forbidden character, only the one that occurs FIRST, reading left to right, is named, and only once', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': 'Bruno uses a tilde ~ and later a caret ^ in the same added line.',
  };
  const scope = scopeFor({ 'people/ana.md': [1] });
  // Fix round 1, finding 8: the previous fixture configured
  // forbidden_chars as ['^', '~'], with '~' both textually FIRST and
  // LAST in the array, so "leftmost in the text" and "last entry in the
  // array that matches" gave the same answer and the test passed under
  // both readings; a mutation dropping the `idx < firstIndex` compare
  // entirely (always overwrite) survived the whole suite because of it.
  // The array is now ['~', '^'], with '~' first in the array but STILL
  // first in the text, so only the correct algorithm can produce '~'
  // here: "last matching array entry" would produce '^' instead.
  const config = { lint: { style: { forbidden_chars: ['~', '^'] } } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('style'));
  assert.equal(findings.length, 1, 'one finding per line, never one per forbidden character it carries');
  assert.equal(findings[0].params.char, '~', 'the tilde comes first in the text, regardless of the order forbidden_chars lists it in');
});

// --- severity: "error", "warn" or "off", defaulting to "warn" ----------------------

test('a finding severity comes from lint.<rule>, and "off" suppresses the rule entirely rather than merely hiding its findings', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ghost.md': '# Ghost\n' };

  const errorFindings = findingsFor({ files, config: { lint: { orphans: 'error' } } }).filter(isLint('orphans'));
  assert.equal(errorFindings.length, 1);
  assert.equal(errorFindings[0].severity, 'error');

  const warnFindings = findingsFor({ files, config: { lint: { orphans: 'warn' } } }).filter(isLint('orphans'));
  assert.equal(warnFindings.length, 1);
  assert.equal(warnFindings[0].severity, 'warn');

  const offFindings = findingsFor({ files, config: { lint: { orphans: 'off' } } }).filter(isLint('orphans'));
  assert.deepEqual(offFindings, [], 'an "off" rule must produce no findings at all, not findings marked off');
});

// Fix round 1 (review, clause list #16): index-completeness is the only
// rule in LINT_RULES whose settingKey ("index_completeness") differs
// from its id ("index-completeness"). Setting only lint.index_completeness,
// while leaving lint.orphans and lint.columns at their own defaults,
// distinguishes reading the setting by settingKey (correct) from reading
// it by id (a config key that does not exist, so it would silently fall
// back to "warn", the same value the default already produces): if this
// rule ever keyed on `rule.id` instead, this assertion would still see
// "warn" and never notice the swap.
test('severity is read by the rule own setting key, not its id, which matters exactly once: index-completeness is the only rule where the two spellings differ', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ghost.md': '# Ghost\n' };
  const findings = findingsFor({ files, config: { lint: { index_completeness: 'error' } } }).filter(isLint('index-completeness'));
  assert.ok(findings.length > 0, 'expected at least one index-completeness finding to carry the overridden severity');
  assert.ok(findings.every((f) => f.severity === 'error'));
});

test('an unrecognized severity value in the configuration is treated the same as none at all: it defaults to "warn"', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ghost.md': '# Ghost\n' };
  const root = makeVault({ files }); // this test bypasses loadConfig entirely below, so the example config's own schema-valid lint.orphans value never comes into it
  const config = { lint: { orphans: 'not-a-real-severity' } };
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const findings = runLintRules(mdFiles, context, IGNORED_SCOPE).filter(isLint('orphans'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
});

// displaySecretPattern classifies by `match.origin` directly, never by
// re-inspecting `match.pattern` (leak.mjs's own already-rendered display
// text): a 'personal' origin must render PERSONAL_PATTERN_LABEL, never
// CONFIGURED_PATTERN_LABEL, even though this rule's own `check()` never
// actually produces a 'personal'-origin match today (loadPatterns is
// called here without `env`; see this rule's own header). Exercised
// directly, on a hand-built match object, because a test that could
// only ever drive it through the rule's own public surface would never
// see this branch execute at all.
test("displaySecretPattern labels a 'personal' origin match distinctly from a 'config' one, never claiming a personal pattern was configured in privacy.secret_patterns", () => {
  assert.equal(displaySecretPattern({ origin: 'personal', pattern: PERSONAL_PATTERN_LABEL }), PERSONAL_PATTERN_LABEL);
  assert.equal(displaySecretPattern({ origin: 'config', pattern: 'internal-[0-9]{4}' }), 'a pattern configured in privacy.secret_patterns');
  assert.equal(displaySecretPattern({ origin: 'generic', pattern: 'AKIA[0-9A-Z]{16}' }), 'AKIA[0-9A-Z]{16}');
});

// --- secrets: "no secret pattern appears on an added line" -------------------------
//
// Every secret-shaped fixture string below is built by runtime string
// concatenation, NEVER as one contiguous literal: this repository's own
// push gate scans every commit of a push for exactly these shapes
// (src/leak.mjs's own GENERIC_PATTERNS), and has already refused one
// commit here for spelling one out directly. Splitting the prefix and
// the body into two separately-quoted pieces joined by "+" means the
// committed SOURCE text never contains the contiguous match the gate
// (or this rule) looks for, only the built STRING does, at runtime,
// inside the test process.
function fakeAwsKey(suffix) {
  return 'AKIA' + suffix; // AKIA + 16 [0-9A-Z] chars, GENERIC_PATTERNS' own AWS access key id shape
}

test('secrets reports a secret-shaped pattern only on the line this change added, never on an identical untouched line, and its rendered message never contains the matched text itself', () => {
  const awsKey = fakeAwsKey('ABCD1234EFGH5678');
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [`old key ${awsKey} already committed before this change`, `new key ${awsKey} added by this change`].join('\n'),
  };
  const scope = scopeFor({ 'people/ana.md': [2] });
  // The example config's own privacy.secret_patterns (test/fixtures/config/valid.json)
  // already lists this exact AWS shape as a "config" pattern alongside
  // leak.mjs's own "generic" copy of it, so both would otherwise match
  // the same text and double every count below; cleared here so this
  // test counts one match per real occurrence, not two origins of the
  // same one.
  const config = { privacy: { secret_patterns: [] } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  assert.equal(findings.length, 1, 'only the added line should be reported, not the identical untouched one above it');
  assert.equal(findings[0].file, 'people/ana.md');
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].check, 'secret-pattern');
  assert.equal(findings[0].params.pattern, 'AKIA[0-9A-Z]{16}', 'the param is the PATTERN definition (public, safe), never the matched text');
  // Fix round 2: this file's scope IS a real added-lines Set (not the
  // whole file), so the message correctly claims the narrower thing:
  // an added line, specifically, matched.
  assert.equal(findings[0].messageKey, 'lint.secrets.pattern_matched');

  const rendered = renderedMessage(findings[0]);
  const secretPattern = new RegExp(awsKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  assert.doesNotMatch(rendered, secretPattern, 'the rendered message must never contain the matched secret text itself');
  assert.match(rendered, /added line/, 'this file was scoped to added lines, and the message must say so');
  assert.match(rendered, /SECURITY\.md/, 'the message must point at the incident-response document');
});

test('a secret on an untracked file is reported: an untracked file has every line in scope, exactly like style and tables', () => {
  const awsKey = fakeAwsKey('ZZZZ0000YYYY1111');
  const files = { 'index.md': '# Welcome\n', 'people/new.md': `a fresh note with ${awsKey} inside it` };
  const scope = scopeFor({ 'people/new.md': null });
  const config = { privacy: { secret_patterns: [] } }; // avoid double-counting against the example config's own overlapping AKIA pattern
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  assert.equal(findings.length, 1);
  // Fix round 2: this file's scope is the WHOLE file (an untracked note,
  // addedLines null), so the message must not claim the match sits on a
  // line this change "added" - it says merely that a line matches,
  // because that is all this run actually knows.
  assert.equal(findings[0].messageKey, 'lint.secrets.pattern_matched_full');
  assert.doesNotMatch(renderedMessage(findings[0]), /added line/);
});

test('a file with nothing added at all in this change is skipped entirely, even when it carries a secret-shaped pattern elsewhere', () => {
  const awsKey = fakeAwsKey('MMMM8888NNNN9999');
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': `an old key ${awsKey} nobody touched` };
  const scope = scopeFor({ 'people/ana.md': [] });
  const findings = findingsFor({ files, scope }).filter(isLint('secrets'));
  assert.deepEqual(findings, []);
});

test('a pattern configured in privacy.secret_patterns is applied too, not only the built-in generic patterns, but is named by a NEUTRAL label, never its own text', () => {
  const customToken = 'internal-token-' + '778899';
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': `see ${customToken} for details` };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const config = { privacy: { secret_patterns: ['internal-token-[0-9]{6}'] } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].params.pattern, 'a pattern configured in privacy.secret_patterns');
});

// Fix round 1, CRITICAL: a vault owner can paste a REAL, literal
// credential into privacy.secret_patterns by mistake (a denylist entry
// rather than a detection pattern). Before this fix, that pattern's own
// text (a "config"-origin match, per leak.mjs) was treated as safe to
// print, since leak.mjs calls a config pattern "public by nature" -- a
// claim about whether the LIST exists is safe to log, not about whether
// every STRING inside it is safe to print. Built by runtime
// concatenation, never as one literal, per this repository's own rule
// against writing a secret-shaped literal into a committed file.
test('a vault owner literal credential, pasted into privacy.secret_patterns by mistake, is never rendered verbatim: the message names it only as "a pattern configured in privacy.secret_patterns"', () => {
  // Deliberately NOT shaped like any of leak.mjs's own GENERIC_PATTERNS
  // (a private key header, ghp_, github_pat_, sk-ant-, AKIA, xox[baprs]-):
  // this fixture is testing the CONFIG-origin path alone, and a value
  // that also happened to match a generic pattern would produce a second,
  // legitimately-unmasked finding (the generic shape's own safe regex
  // text) that would make this assertion's own intent ambiguous.
  const pastedCredential = 'CorrectHorse' + 'BatteryStaple2026';
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': `the real token is ${pastedCredential} for now` };
  const scope = scopeFor({ 'people/ana.md': [1] });
  // Escaped so it is matched as a literal substring, exactly the mistake
  // a vault owner who thinks privacy.secret_patterns is a denylist would
  // make: pasting the credential itself rather than a detection pattern.
  const config = { privacy: { secret_patterns: [pastedCredential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  assert.ok(findings.length > 0, 'the pasted credential must still be detected');
  for (const finding of findings) {
    assert.equal(finding.params.pattern, 'a pattern configured in privacy.secret_patterns');
    const rendered = renderedMessage(finding);
    assert.doesNotMatch(rendered, new RegExp(pastedCredential), 'the vault owner own pasted credential must never appear in the rendered message');
  }
});

test('unlike style and tables, secrets is NOT exempt inside a fenced code block: an example pasted with a real key in it is still a leaked secret', () => {
  const awsKey = fakeAwsKey('TTTT6666UUUU7777');
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['Here is my env file:', '', '```', `AWS_KEY=${awsKey}`, '```'].join('\n'),
  };
  const scope = scopeFor({ 'people/ana.md': [4] });
  const config = { privacy: { secret_patterns: [] } }; // avoid double-counting against the example config's own overlapping AKIA pattern
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  assert.equal(findings.length, 1, 'a fence must never exempt a real secret, unlike style and tables, where an example must stay quotable');
  assert.equal(findings[0].line, 4);
});

test('lint.secrets set to "off" suppresses the rule entirely, even though a matching pattern is present on an added line', () => {
  const awsKey = fakeAwsKey('RRRR4444SSSS5555');
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': `token ${awsKey} here` };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const findings = findingsFor({ files, scope, config: { lint: { secrets: 'off' } } }).filter(isLint('secrets'));
  assert.deepEqual(findings, []);
});

// This task's own brief, verbatim: "its severity default is 'error'
// even though every other rule defaults to 'warn', and the code says
// why: a warning about a leaked credential is a leaked credential."
// Bypasses loadConfig, like the other default-severity tests in this
// file, so the example config's own explicit lint.secrets: "error"
// never comes into it: this pins the RULE's OWN defaultSeverity
// fallback, not a value the example configuration happens to set.
test('secrets defaults to severity "error" when the configuration never names it at all, unlike every other rule in this file, which defaults to "warn"', () => {
  const awsKey = fakeAwsKey('QQQQ2222WWWW3333');
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': `token ${awsKey} here` };
  const root = makeVault({ files });
  const config = {};
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const scope = scopeFor({ 'people/ana.md': [1] });
  const findings = runLintRules(mdFiles, context, scope).filter(isLint('secrets'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
});

// --- fix round 2: a fresh scan deadline per file, and a per-file degrade ------------
//
// The old shared deadline (one `Date.now() + OVERALL_SCAN_TIMEOUT_MS`,
// computed once before the per-file loop and threaded through every
// file's own scanText call) meant a slow-to-scan file left every file
// AFTER it with less of the shared budget than leak.mjs's own
// measurement assumed, and if it ran the budget out entirely, scanText's
// own "refusing to report a partial result as if it were complete"
// exception escaped this rule uncaught, aborting every rule still to
// run. Reproduced here without a real wait: a mocked clock reports the
// REAL time on its very first call (the rule's own deadline computation
// for file 1), then a FAR-FUTURE time on every call after that. File 1's
// own scanText call reads that far-future time on its first per-line
// check and finds itself already past its own (real-time-based)
// deadline; the fix's whole point is that file 2's deadline is computed
// AFTER that, from the SAME far-future "now", so file 2's own budget
// runs from far-future to far-future-plus-twenty-seconds and is not, in
// fact, already expired: it completes normally. A shared, once-computed
// deadline would have file 2 inherit file 1's own already-expired
// budget and fail identically; this fresh-per-file design does not.
test('a file whose own secrets scan cannot finish in time is reported as a degraded result for THAT FILE alone, and a later file still gets its own full, fresh budget', () => {
  // walkVault returns files SORTED (its own contract): "index.md" always
  // sorts before anything under "people/", so it is always the FIRST
  // file this rule's own per-file loop scans, whatever its content. The
  // mock clock below reports the REAL time on its very first call (that
  // first file's own deadline computation) and a FAR-FUTURE time on
  // every call after that, so "index.md" is the one file whose own
  // first per-line check reads a time already past ITS deadline; every
  // file scanned after it computes its OWN deadline from that same
  // far-future "now" and is never seen as expired against itself, which
  // is the whole point: a fresh, per-file deadline does not inherit an
  // earlier file's own overrun.
  const freshKey = fakeAwsKey('FRESH111FRESH222');
  const files = {
    'index.md': '# Welcome\n',
    'people/fresh.md': `token ${freshKey} here`,
  };
  const root = makeVault({ files, config: { privacy: { secret_patterns: [] } } });
  const config = loadConfig(root);
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  assert.deepEqual(mdFiles, ['index.md', 'people/fresh.md'], 'this test depends on this exact processing order');
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };

  const realDateNow = Date.now;
  const realNow = realDateNow();
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return calls === 1 ? realNow : realNow + OVERALL_SCAN_TIMEOUT_MS + 1000;
  };
  let findings;
  try {
    findings = runLintRules(mdFiles, context, IGNORED_SCOPE).filter(isLint('secrets'));
  } finally {
    Date.now = realDateNow;
  }

  const degraded = findings.filter((f) => f.defect === true);
  assert.equal(degraded.length, 1, 'exactly one file should have failed to finish its own scan');
  assert.equal(degraded[0].file, 'index.md');
  assert.equal(degraded[0].check, 'file-scan-failed');
  assert.match(degraded[0].params.message, /exceeded its deadline/);

  const realFinding = findings.find((f) => f.defect !== true);
  assert.ok(realFinding, 'the SECOND file must still be scanned, with its own fresh budget, not skipped because an earlier file ran out');
  assert.equal(realFinding.file, 'people/fresh.md');
  assert.equal(realFinding.check, 'secret-pattern');
});

// Fix round 2: a rule that throws for a DIFFERENT reason (loadPatterns'
// own refusal of a malformed `privacy.secret_patterns` entry, which
// this rule's own header says must never be swallowed into a soft
// finding) is NOT caught by the per-file guard above, since it happens
// before the per-file loop ever starts: it must still escape this
// rule's own check() function, to be caught by runLintRules' own
// generic per-rule guard instead, one level up. Proven here by checking
// that a DIFFERENT rule (orphans) still reports its own real finding in
// the SAME combined run, which only happens if runLintRules keeps going
// after catching secrets' own crash rather than letting it escape and
// abort every rule that has not run yet.
test('a malformed privacy.secret_patterns entry still crashes the secrets rule as a whole, caught by runLintRules rather than aborting rules that have not run yet', () => {
  // `privacy` runs AFTER `secrets` in LINT_RULES; a public link straight
  // into a confidential note gives it a REAL, positive finding to
  // report, so this test proves privacy actually EXECUTED after
  // secrets crashed, rather than merely proving it did not ALSO crash
  // (which would be equally true, and equally uninformative, if the old
  // uncaught exception had aborted the loop before privacy ever ran:
  // an aborted rule reports neither a crash nor a real finding).
  const files = { 'index.md': '# Welcome\n\n[Ghost](people/ghost.md)\n', 'people/ghost.md': '# Ghost\n' };
  const config = { privacy: { secret_patterns: ['[unterminated'], confidential_dirs: ['people/'] } };
  const root = makeVault({ files }); // bypasses loadConfig; this hand-built config is deliberately invalid
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const findings = runLintRules(mdFiles, context, IGNORED_SCOPE);

  const crashed = findings.filter((f) => f.id === 'secrets' && f.defect === true);
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0].check, 'rule-crashed');
  assert.equal(crashed[0].file, null);
  assert.match(crashed[0].params.message, /could not compile/);

  const privacyFindings = findings.filter((f) => f.id === 'privacy');
  assert.equal(privacyFindings.length, 1, 'privacy runs after secrets and must still report its own real finding');
  assert.equal(privacyFindings[0].check, 'link-into-confidential');
  assert.equal(privacyFindings[0].defect, false);
});

// Fix round 1 (review's own gap list: "no test puts two secrets in one
// file"). Two DISTINCT secret shapes, on two different added lines of
// the SAME file, both reported, each with its own correct line number:
// this is the shape that would break first if the per-file loop
// accidentally kept only the first match, or mis-mapped a later line
// back to the wrong original number.
test('two distinct secrets on two different added lines of the same file are both reported, each at its own correct line', () => {
  const awsKey = fakeAwsKey('AAAA1111BBBB2222');
  const slackToken = 'xoxb-' + '1234567890';
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['untouched line, nothing here', `first secret: ${awsKey}`, 'an ordinary line in between', `second secret: ${slackToken}`].join('\n'),
  };
  const scope = scopeFor({ 'people/ana.md': [2, 4] });
  const config = { privacy: { secret_patterns: [] } }; // isolate GENERIC_PATTERNS only, avoiding the AKIA overlap noted elsewhere in this file
  const findings = findingsFor({ files, scope, config }).filter(isLintCheck('secrets', 'secret-pattern'));
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.line).sort(), [2, 4]);
});

// Fix round 1, CRITICAL: this rule used to destructure only `matches`
// out of scanText's own return, silently accepting the default cap of
// five and never surfacing `truncated`. Eight distinct secrets on eight
// added lines (one per line, all the same generic shape so each line
// contributes exactly one match) exceeds that cap; this pins that the
// whole record is now read, and that truncation is surfaced as its own
// finding rather than dropped.
test('a file with more secret-shaped matches on added lines than the cap allows surfaces its own truncation finding, naming how many were shown and how many exist', () => {
  const lines = [];
  const addedLineNumbers = [];
  for (let i = 0; i < 8; i++) {
    lines.push(`secret number ${i}: ${fakeAwsKey(`Z${i}Z${i}BBBB2222CCCC`.slice(0, 16).toUpperCase())}`);
    addedLineNumbers.push(i + 1);
  }
  const files = { 'index.md': '# Welcome\n', 'people/many.md': lines.join('\n') };
  const scope = scopeFor({ 'people/many.md': addedLineNumbers });
  const config = { privacy: { secret_patterns: [] } };
  const findings = findingsFor({ files, scope, config }).filter(isLint('secrets'));
  const matchFindings = findings.filter((f) => f.check === 'secret-pattern');
  const truncatedFindings = findings.filter((f) => f.check === 'secret-pattern-truncated');
  assert.equal(matchFindings.length, 5, 'the default cap still applies to how many individual matches are named');
  assert.equal(truncatedFindings.length, 1, 'exactly one truncation notice per file, not one per hidden match');
  assert.equal(truncatedFindings[0].params.shown, 5);
  assert.equal(truncatedFindings[0].params.total, 8);
  assert.match(renderedMessage(truncatedFindings[0]), /8/);
});

// --- privacy: "a note under a confidential directory is not linked from a file outside
//     one, and a note outside one does not carry a field the configuration marks
//     confidential" -----------------------------------------------------------------
//
// This task's own example config (test/fixtures/config/valid.json,
// privacy.confidential_dirs) already declares "people/" confidential;
// every fixture below reuses it rather than declaring a second boundary.

test('privacy reports a link from a file outside every confidential directory straight into a specific note inside it', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Ana directly](people/ana.md)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(findings.length, 1, 'only the direct link to the specific note should be reported');
  assert.equal(findings[0].file, 'index.md');
  assert.equal(findings[0].params.target, 'people/ana.md');
});

// Judgment call, found while writing this very fixture against
// index-completeness's own contract: linking the confidential directory
// itself, or straight to its own index.md, is the format's OWN required
// way to point a reader at an entire subtree (index-completeness's own
// judgment call 1), and reporting it here would make the two rules
// impossible to both satisfy at once.
test('linking the confidential directory itself, or straight to its own index.md, from outside is not reported: only a link past that front door, into a specific note, is', () => {
  const files = {
    'index.md': '# Welcome\n\n[People bare](people/)\n\n[People index](people/index.md)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('privacy'));
  assert.deepEqual(findings, []);
});

// Fix round 2, CRITICAL: a wikilink is the one syntax this codebase
// resolves both with and without an extension on purpose
// (wikilinkPathParts's own header). `[[people/index]]` (no extension)
// used to be reported as a leak into the confidential directory, while
// the otherwise-identical `[[people/index.md]]` (extension spelled out)
// and the ordinary link `[People index](people/index.md)` were both
// correctly exempt as the directory's own front door: the same target,
// spelled three ways, disagreeing about whether it leaks.
test('a bare wikilink to a confidential directory own index, with no extension, is exempt exactly like the spelling with the extension', () => {
  const files = {
    'index.md': '# Welcome\n\n[[people/index]]\n',
    'people/index.md': '# People\n',
  };
  const findings = findingsFor({ files, config: { privacy: { confidential_dirs: ['people/'] } } }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.deepEqual(findings, [], 'a bare-index wikilink into the directory own front door must not be reported as a leak');
});

// Fix round 2, CRITICAL: declaring a MORE specific, nested directory
// confidential used to REMOVE a finding rather than add one. With
// `confidential_dirs: ['people/', 'people/team/']`, a link straight to
// `people/team/index.md` sits strictly inside the outer `people/`
// directory (which does not exempt it: index-completeness's own
// front-door contract only covers a directory's OWN index, not an
// arbitrary path one level under it) but IS `people/team/`'s own front
// door. The old code exempted the path on the strength of the SECOND
// fact without checking the first fact came from a different directory,
// so tightening the configuration by naming the nested directory too
// made this rule stop reporting a link that a single, less specific
// `confidential_dirs: ['people/']` already correctly reported.
test('naming a nested directory as ALSO confidential never removes a finding a less specific configuration already reported', () => {
  const files = {
    'index.md': '# Welcome\n\n[Team](people/team/index.md)\n',
    'people/team/index.md': '# Team\n',
  };
  const singleDir = findingsFor({ files, config: { privacy: { confidential_dirs: ['people/'] } } }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(singleDir.length, 1, 'sanity: the single, outer directory alone already reports this link');

  const nestedAlsoNamed = findingsFor({ files, config: { privacy: { confidential_dirs: ['people/', 'people/team/'] } } }).filter(
    isLintCheck('privacy', 'link-into-confidential'),
  );
  assert.equal(nestedAlsoNamed.length, 1, 'naming the nested directory too must not make this rule go silent about the same link');
});

// Fix round 2 (CRITICAL, restoring a guard removed in fix round 1 as
// provably dead): the removal's own reasoning checked only isUnderPath's
// OWN comparison, never the "confidentialDirs.length === 0" early
// return two lines above it, which an empty-string entry (schema-valid:
// no minLength on this array's items) has length ONE, not zero, for.
// With `confidential_dirs: ['']`, every real file used to read as
// OUTSIDE every confidential directory, which flagged a note correctly
// marked `confidential: true` as leaking past a boundary that, in every
// other respect, does not exist at all.
test('an empty string in confidential_dirs is treated exactly like no confidential directory at all, never like a real, unmatchable boundary', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\nconfidential: true\n---\n# Ana\n' };
  const findings = findingsFor({ files, config: { privacy: { confidential_dirs: [''] } } }).filter(isLint('privacy'));
  assert.deepEqual(findings, [], 'a blank entry must behave exactly like an empty confidentialDirs array (no boundary declared)');
});

// Fix round 2 (MINOR, cheap to fold in): "." is the natural way to spell
// "the whole vault is confidential", and isUnderPath's own normalisation
// does not read it that way (a disclosed, inherited limitation this
// file's own header already named). The visible cost: a note correctly
// marked `confidential: true` under `confidential_dirs: ['.']` used to
// be reported as sitting OUTSIDE a boundary that was declared to cover
// the entire vault.
test('a confidential directory configured as exactly "." covers the whole vault: a correctly marked note is never reported as outside it', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\nconfidential: true\n---\n# Ana\n' };
  const findings = findingsFor({ files, config: { privacy: { confidential_dirs: ['.'] } } }).filter(isLint('privacy'));
  assert.deepEqual(findings, []);
});

// Fix round 1, CRITICAL: the exemption used to cover log.md too (any
// RESERVED filename, index-completeness's own pair), but
// index-completeness's own root-links-directory clause never mentions
// log.md at all; a public note linking straight to a confidential
// directory's log is exactly the leak clause 1 exists to catch, and
// used to produce zero findings.
test('linking a confidential directory own log.md from outside is reported: index-completeness never requires linking it, so it is not the front door', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[People activity log](people/log.md)\n',
    'people/index.md': '# People\n',
    'people/log.md': '# Log\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].params.target, 'people/log.md');
});

// Fix round 1, CRITICAL: the exemption used to cover a reserved
// filename at ANY DEPTH, so a link straight to a NESTED index.md
// ("people/team/index.md") went unreported while the equivalent bare
// directory link ("people/team/") WAS reported -- the same underlying
// target, reported one way and not the other. index-completeness's own
// contract only ever concerns the confidential directory's OWN,
// top-level index.md; a nested one is confidential content like any
// other note.
test('a nested index.md deeper inside a confidential directory is confidential content, not exempt like the top-level one, and reporting is consistent with the bare directory link', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Team page](people/team/index.md)\n\n[Team bare](people/team/)\n',
    'people/index.md': '# People\n',
    'people/team/index.md': '# Team\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.deepEqual(
    findings.map((f) => f.params.target).sort(),
    ['people/team', 'people/team/index.md'],
    'both spellings of the same nested target must be reported, consistently with each other',
  );
});

test('a link between two notes that are both under the confidential directory is not reported: only a link FROM outside the boundary counts', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n',
    'people/index.md': '# People\n\n[Ana](ana.md)\n',
    'people/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('privacy'));
  assert.deepEqual(findings, []);
});

test('a wikilink from outside the boundary into a specific confidential note is reported exactly like an ordinary link', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Projects](projects/)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
    'projects/index.md': '# Projects\n\nSee [[../people/ana.md]] for background.\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'projects/index.md');
  assert.equal(findings[0].params.target, 'people/ana.md');
});

// Fix round 1, IMPORTANT: a BARE wikilink target (no extension) tries
// BOTH readings wikilinkPathParts offers ("people/ana" and
// "people/ana.md"), and when the boundary is a simple path prefix, both
// candidate strings independently satisfy isConfidentialContent. This
// used to report the SAME one wikilink twice; the fix stops at the
// first candidate that matches, exactly the way followLink (the orphan
// rule's own use of these two candidates) already only needs one to
// succeed.
test('a single bare wikilink (no extension) into a confidential note is reported exactly ONCE, not once per candidate reading', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Projects](projects/)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
    'projects/index.md': '# Projects\n\nSee [[../people/ana]] for background.\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(findings.length, 1, 'one wikilink must produce one finding, however many candidate readings its bare target has');
});

// Fix round 1 (MINOR, cheap): a hand-written "confidential: TRUE" or
// "confidential: True" is a valid YAML boolean, but this check started
// life comparing against the exact lowercase string only (matching
// house.mjs's own established, stricter convention for a boolean-typed
// field). Loosened for THIS one field, since missing a real
// confidential marking is the cost of being wrong in the direction this
// rule cannot afford.
test('a confidential field written in a different case ("TRUE") still counts: only the strict lowercase spelling used to be recognised', () => {
  const files = {
    'index.md': '# Welcome\n\n[Projects](projects/)\n',
    'projects/index.md': '# Projects\n',
    'projects/leaky.md': '---\nconfidential: TRUE\n---\n# Leaky\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'confidential-field-outside'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'projects/leaky.md');
});

test('a note outside every confidential directory carrying confidential: true is reported, beside one inside the boundary carrying the same field that is not', () => {
  const files = {
    'index.md': '# Welcome\n\n[Projects](projects/)\n\n[People](people/)\n',
    'projects/index.md': '# Projects\n',
    'projects/leaky.md': '---\nconfidential: true\n---\n# Leaky\n',
    'people/index.md': '# People\n',
    'people/ana.md': '---\nconfidential: true\n---\n# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'confidential-field-outside'));
  assert.equal(findings.length, 1, 'only the note outside the boundary should be reported');
  assert.equal(findings[0].file, 'projects/leaky.md');
});

test('a note outside every confidential directory carrying confidential: false is never reported: only the literal value "true" counts', () => {
  const files = {
    'index.md': '# Welcome\n\n[Projects](projects/)\n',
    'projects/index.md': '# Projects\n',
    'projects/not-leaky.md': '---\nconfidential: false\n---\n# Not leaky\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('privacy', 'confidential-field-outside'));
  assert.deepEqual(findings, []);
});

test('with no confidential directories declared at all, privacy reports nothing for either clause', () => {
  const files = {
    'index.md': '# Welcome\n\n[Secret](secret/)\n\n[Direct](secret/note.md)\n',
    'secret/index.md': '# Secret\n',
    'secret/note.md': '---\nconfidential: true\n---\n# Note\n',
  };
  const config = { privacy: { confidential_dirs: [] } };
  const findings = findingsFor({ files, config }).filter(isLint('privacy'));
  assert.deepEqual(findings, []);
});

// This task's own example config (test/fixtures/config/valid.json)
// happens to set lint.privacy to "error" itself, matching the parity
// vault's own strict policy for it, so findingsFor (which merges onto
// that example config) can never observe the RULE's own code-level
// default; this bypasses loadConfig, like the "unrecognized severity"
// and secrets' own default-severity tests above, to pin that default
// directly instead.
test('privacy defaults to severity "warn" like every rule except secrets, when the configuration never names it at all', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Ana](people/ana.md)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
  };
  const root = makeVault({ files });
  const config = { privacy: { confidential_dirs: ['people/'] } }; // no lint key at all
  const all = walkVault(root, config, { all: true });
  const mdFiles = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: (relPath) => readFileSync(join(root, relPath), 'utf8') };
  const findings = runLintRules(mdFiles, context, IGNORED_SCOPE).filter(isLintCheck('privacy', 'link-into-confidential'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
});

test('lint.privacy set to "off" suppresses the rule entirely, even though both clauses would otherwise report', () => {
  const files = {
    'index.md': '# Welcome\n\n[People](people/)\n\n[Ana](people/ana.md)\n',
    'people/index.md': '# People\n',
    'people/ana.md': '# Ana\n',
  };
  const offFindings = findingsFor({ files, config: { lint: { privacy: 'off' } } }).filter(isLint('privacy'));
  assert.deepEqual(offFindings, []);
});

// --- attribution: "a note whose sources carries more than one entry anchors each claim
//     that crosses sources with a footnote whose key matches a source id" (5.1) ------

test('a note with two sources, each claim anchored by a footnote whose key matches a source id, reports nothing', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/case-clean.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Ana said this in the call[^call1].',
      '',
      'Bruno confirmed it by email[^call2].',
      '',
      '[^call1]: transcript excerpt',
      '[^call2]: email excerpt',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.deepEqual(findings, []);
});

test('attribution does not run at all when sources carries one entry, or none: a single source needs no disambiguation', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/single-source.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '---',
      '# Case',
      '',
      'No footnote anywhere, and that is fine with a single source.',
    ].join('\n'),
    'people/no-sources.md': '# No Sources\n\nJust prose.\n',
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.deepEqual(findings, []);
});

test('a sources entry with no id is reported by its own index, so no footnote could ever anchor a claim to it', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/missing-id.md': [
      '---',
      'sources:',
      '  - resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Claim anchored[^call2].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLintCheck('attribution', 'missing-source-id'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].params.index, 0);
  assert.equal(findings[0].line, 2); // "sources:" own line, the same location every entry-level finding here points at
});

test('a footnote key naming no declared source id is reported, beside two real ids correctly anchored in the same file', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/unknown-footnote.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Claim one[^call1].',
      '',
      'Claim two[^call2].',
      '',
      'A stray, mistaken reference[^call9].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  const unknown = findings.filter((f) => f.check === 'unknown-footnote');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].params.key, 'call9');
  // Fix round 1 (review's own gap list: "none asserts an attribution
  // finding's line"): line 14 is where "[^call9]" actually sits in the
  // fixture above (a stray reference, whole-file line, frontmatter
  // included), not some other line the finding happened to be attached
  // to by an off-by-one in the body-prefix arithmetic.
  assert.equal(unknown[0].line, 14);
  assert.deepEqual(findings.filter((f) => f.check === 'source-not-anchored'), [], 'both real ids were anchored, so neither should be reported unanchored');
});

test('a declared source id that no footnote anywhere in the body ever references is reported, by its own id', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/unanchored.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Only the first claim is anchored[^call1].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLintCheck('attribution', 'source-not-anchored'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].params.id, 'call2');
  // A "not anchored" finding is about the DECLARATION, not any one line
  // in the body (there is no line in the body it could point at instead,
  // since the whole complaint is that no line ever cites it): it points
  // at "sources:" own line, 2 in this fixture.
  assert.equal(findings[0].line, 2);
});

test('a footnote DEFINITION alone, with no inline reference anywhere, does not anchor a claim: the id is still reported unanchored', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/definition-only.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Claim one[^call1].',
      '',
      '[^call1]: transcript',
      '[^call2]: never actually used inline anywhere in the body',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLintCheck('attribution', 'source-not-anchored'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].params.id, 'call2');
});

// Fix round 1 (review's own gap list: "none exercises a footnote beside
// a colon or at the start of a line"). Two edge cases the position rule
// (isFootnoteDefinition) has to tell apart correctly:
test('a footnote reference followed by an ordinary colon, with text before it on the line, still anchors a claim: only a colon at the START of the line makes it a definition', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/colon-after-reference.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Bruno put it this way[^call1]: he fully agreed with the plan.',
      '',
      'Ana confirmed separately[^call2].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.deepEqual(findings, [], 'a colon right after the reference, with real text before it on the line, must not be read as a definition');
});

test('a footnote reference sitting at the very start of a line, with NO colon right after it, still anchors a claim rather than being read as a definition', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/reference-at-line-start.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      '[^call1] confirmed this point on its own line, with no colon right after it.',
      '',
      'Ana confirmed the second point separately[^call2].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.deepEqual(findings, [], 'a reference at the start of a line, without an immediate colon, must not be read as a definition');
});

// Fix round 1: no existing fixture had EVERY sources entry lacking an
// id at once (ids.length reaching 0 after every entry is reported
// missing), which is the one input that tells the ids.length===0 early
// return apart from removing it: without the guard, every footnote
// reference in the body would be reported as "unknown" against an
// empty id set, rather than the body being left alone once every source
// has already been reported for lacking an id in the first place.
test('when every sources entry lacks an id, each is reported once by its own index, and no footnote in the body is also reported as unknown', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/all-missing-ids.md': [
      '---',
      'sources:',
      '  - resource: https://example.com/call1',
      '  - resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'A claim with a stray footnote[^call9].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  const missing = findings.filter((f) => f.check === 'missing-source-id');
  assert.deepEqual(missing.map((f) => f.params.index), [0, 1]);
  assert.deepEqual(findings.filter((f) => f.check === 'unknown-footnote'), [], 'with no id ever declared, the body is left alone rather than flooded with "unknown footnote" for every reference in it');
});

test('a footnote-shaped reference inside a fenced code block is neither an anchor nor an unknown footnote: code is stripped first, like every other rule in this file', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/fenced-footnote.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Claim one[^call1].',
      '',
      'Claim two[^call2].',
      '',
      'Example syntax, not a real anchor:',
      '',
      '```',
      'Something[^madeup]',
      '```',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.deepEqual(findings, [], 'both real ids are anchored outside the fence, and the fenced [^madeup] must never surface as an unknown footnote');
});

test('attribution defaults to severity "warn" like every rule except secrets, and "off" suppresses it entirely', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/unanchored.md': [
      '---',
      'sources:',
      '  - id: call1',
      '    resource: https://example.com/call1',
      '  - id: call2',
      '    resource: https://example.com/call2',
      '---',
      '# Case',
      '',
      'Only the first claim is anchored[^call1].',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('attribution'));
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.severity === 'warn'));

  const offFindings = findingsFor({ files, config: { lint: { attribution: 'off' } } }).filter(isLint('attribution'));
  assert.deepEqual(offFindings, []);
});

// --- rendering: every message key this ruler can emit renders cleanly --------------

test('every lint message key renders in English with its real parameters, leaving no key name or unfilled placeholder on screen', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ghost.md': '# Ghost\n',
    'core/weekly-rhythm.md': ['| Wrong |', '|---|', '| data |'].join('\n'),
  };
  const findings = findingsFor({ files });
  const seenChecks = new Set(findings.map((f) => `${f.id}:${f.check}`));
  assert.ok(seenChecks.size >= 3, `expected findings from more than one check, saw: ${[...seenChecks].join(', ')}`);
  for (const finding of findings) {
    const rendered = renderedMessage(finding);
    assert.doesNotMatch(rendered, /\{[A-Za-z_]+\}/, `"${finding.messageKey}" left an unfilled placeholder: ${rendered}`);
    assert.doesNotMatch(
      rendered,
      new RegExp(finding.messageKey.replace(/\./g, '\\.')),
      `"${finding.messageKey}" rendered the bare key name itself: ${rendered}`,
    );
  }
});
