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
// Example data throughout: the fictional owner Ana, example.com, and
// plain English taxonomy (people/, projects/, decisions/, pending/,
// core/, memory/), per this project's own standing rule.
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
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].severity, 'warn'); // this task's own example config's own default for this setting
  assert.match(renderedMessage(findings[0]), /index\.md/);
});

test('with no root index.md at all, index-completeness reports the root itself missing rather than every directory unlinked', () => {
  const files = { 'notes.md': '# Stray\n' };
  const findings = findingsFor({ files }).filter(isLint('index-completeness'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'directory-has-index');
  assert.equal(findings[0].file, 'index.md');
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
  assert.equal(findings[0].params.dir, 'people');
  assert.match(renderedMessage(findings[0]), /people/);
});

test('a markdown file sitting directly at the vault root is never mistaken for a first-level directory the root index must link', () => {
  const files = {
    'index.md': '# Welcome\n', // links nothing, and "BOOTSTRAP.md" needs no link: it is not a directory
    'BOOTSTRAP.md': '# Bootstrap\n',
  };
  const findings = findingsFor({ files }).filter(isLintCheck('index-completeness', 'root-links-directory'));
  assert.deepEqual(findings, [], 'a root-level file must never be treated as a first-level directory needing a root link');
});

test('a directory holding markdown only through a nested subdirectory needs no index.md of its own, but the root index must still link it as a first-level directory', () => {
  const files = {
    'index.md': '# Welcome\n', // deliberately links nothing at all
    'people/team/index.md': '# Team\n',
    'people/team/ana.md': '# Ana\n',
  };
  const findings = findingsFor({ files }).filter(isLint('index-completeness'));
  const byCheck = (check) => findings.filter((f) => f.check === check);

  // Clause 1: "people" itself holds no markdown file directly (only its
  // nested "people/team/" does), so "people/index.md" is never required.
  assert.ok(
    !byCheck('directory-has-index').some((f) => f.file === 'people/index.md'),
    '"people" has no direct markdown file, so it must not need its own index.md',
  );
  // "people/team/" DOES hold a markdown file directly and has its own
  // index.md, so it is not reported either.
  assert.ok(!byCheck('directory-has-index').some((f) => f.file === 'people/team/index.md'));

  // Clause 2: "people" is still the first-level directory whose subtree
  // holds a real note, so the root never linking it at all is reported.
  assert.equal(byCheck('root-links-directory').length, 1);
  assert.equal(byCheck('root-links-directory')[0].params.dir, 'people');
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

// --- columns: "a file named under taxonomy.files carries the exact column headings"-
//
// Every fixture below reuses this task's own example config's rituals
// declaration (taxonomy.columns.rituals, taxonomy.files.rituals ==
// "core/weekly-rhythm.md"), in the exact order it declares: Calendar
// title, Cadence, Time, Owner, Fixed attendees, Feeds, none yet.

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
      '| Calendar title  |cadence| Time | OWNER | Fixed attendees | Feeds | none yet |',
      '|---|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | none | none | none |',
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

test('columns reports a file with no table at all, beside a sibling configured file whose table matches exactly and is not reported', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': 'Just some prose, no table here at all.\n',
    'pending/follow-ups.md': [
      '| Logged | What | With whom / where | Deadline | Next step | ## Open | ## Resolved |',
      '|---|---|---|---|---|---|---|',
      '| 01/01 | Ping Bruno | Bruno / call | 02/01 | Wait | data | data |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1, 'the matching follow-ups table must not be reported');
  assert.equal(findings[0].check, 'table-present');
  assert.equal(findings[0].file, 'core/weekly-rhythm.md');
  assert.equal(findings[0].absence, true);
  assert.equal(findings[0].messageKey, 'lint.columns.missing_table');
});

test('a table shown only as a fenced code example does not satisfy the column check, and is reported the same as having no table at all', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': [
      'Here is an example of the shape:',
      '',
      '```',
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds | none yet |',
      '|---|---|---|---|---|---|---|',
      '```',
      '',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'table-present');
});

test('a table with fewer columns than declared reports the first missing heading as absent, beside one with an extra column reporting the extra heading as unexpected', () => {
  const files = {
    'index.md': '# Welcome\n',
    'core/weekly-rhythm.md': ['| Calendar title | Cadence | Time |', '|---|---|---|', '| Standup | Daily | 09:00 |'].join('\n'),
    'pending/promises.md': [
      '| Made on | To whom | What I promised | Condition / deadline | Status | ## Active | ## Done / renegotiated | Extra |',
      '|---|---|---|---|---|---|---|---|',
      '| 01/01 | Bruno | Help | none | open | data | data | data |',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter(isLint('columns'));
  assert.equal(findings.length, 2);

  const short = findings.find((f) => f.file === 'core/weekly-rhythm.md');
  assert.equal(short.params.index, 4);
  assert.equal(short.params.expected, 'Owner');
  assert.equal(short.params.found, '(none)');

  const long = findings.find((f) => f.file === 'pending/promises.md');
  assert.equal(long.params.index, 8);
  assert.equal(long.params.expected, '(none)');
  assert.equal(long.params.found, 'Extra');
});

test('columns silently skips a configured file that does not exist in this vault, beside one that does and whose table matches exactly', () => {
  const files = {
    'index.md': '# Welcome\n',
    // "pending/promises.md" is named under taxonomy.files.promises but is
    // never written into this vault at all.
    'core/weekly-rhythm.md': [
      '| Calendar title | Cadence | Time | Owner | Fixed attendees | Feeds | none yet |',
      '|---|---|---|---|---|---|---|',
      '| Standup | Daily | 09:00 | Ana | none | none | none |',
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
