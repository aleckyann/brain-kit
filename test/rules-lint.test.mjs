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
import { LINT_RULES, runLintRules } from '../src/rules/lint.mjs';
import { createTranslator } from '../src/lang.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

const englishFor = createTranslator('en');
function renderedMessage(finding) {
  return englishFor(finding.messageKey, finding.params ?? {});
}

// Shaped exactly per src/git.mjs's own scope contract (task 1), even
// though every rule in this task ignores it outright. Passing a real,
// correctly-shaped value, rather than null or {}, is what actually
// proves these three rules never read it: a rule that started reading
// `scope.files` by mistake would see an always-empty array here and
// silently misbehave on every fixture below, rather than throwing on a
// missing method the way a lazier stand-in (null, undefined) would.
const IGNORED_SCOPE = { files: [], addedLines: () => null };

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

function findingsFor({ files = {}, config = {} } = {}) {
  const root = makeVault({ files, config });
  const loaded = loadConfig(root);
  const { files: mdFiles, context } = rulerArgsFor(root, loaded);
  return runLintRules(mdFiles, context, IGNORED_SCOPE);
}

function isLint(id) {
  return (f) => f.ruler === 'lint' && f.id === id;
}
function isLintCheck(id, check) {
  return (f) => f.ruler === 'lint' && f.id === id && f.check === check;
}

// --- shape of the ruler itself -----------------------------------------------------

test('LINT_RULES is the three structural rules this task owns, each with a stable id and its own lint.<key> setting name', () => {
  assert.deepEqual(
    LINT_RULES.map((r) => ({ id: r.id, settingKey: r.settingKey })),
    [
      { id: 'index-completeness', settingKey: 'index_completeness' },
      { id: 'orphans', settingKey: 'orphans' },
      { id: 'columns', settingKey: 'columns' },
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
