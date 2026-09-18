// The Open Knowledge Format ruler: the rules fixed by the specification
// itself, as opposed to any single vault's house style (that ruler is
// src/rules/house.mjs, a later task). Every rule here is data, not a
// branch of a big if/else chain: an object with a stable id, the section
// of the format it comes from, and a check function, so the runner can
// iterate the array and a future suppression list can name one rule
// without touching the others.
//
// This module never calls walkVault: the validate command walks the
// vault exactly once and hands both rulers the same `files` and
// `context`, so the two rulers can never disagree about what the vault
// contains (see src/vault.mjs's own header for the defect this removes).
// These tests build that same shape by hand, from an in-memory map of
// path to content, so a test never depends on walkVault's own behaviour
// either: only makeVault (for the malformed-file tests, where real bytes
// on disk matter) reaches the filesystem at all.
//
// The reader contract this ruler leans on throughout: null means a key is
// ABSENT (most rules here simply skip, since the trust-signal fields are
// only checked "when present"; type-required is the one exception, since
// type is unconditionally required); undefined means the key is PRESENT
// but written in a shape src/frontmatter.mjs's regular-expression readers
// cannot see, and must never be reported as missing, since the field is
// plainly on a human's screen. Every rule below that reads a mapping,
// entries or a scalar (all but index-no-frontmatter and log-format, which
// work from raw text and headings instead) is tested for both.
//
// A finding is identified by the PAIR of ruler and id, never by id alone,
// so every filter below matches on `f.ruler === 'spec' && f.id === '...'`
// rather than id alone, and a dedicated test pins down that every finding
// this module produces carries `ruler: 'spec'` explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { walkVault } from '../src/vault.mjs';
import { SPEC_RULES, runSpecRules } from '../src/rules/spec.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

// --- test scaffolding --------------------------------------------------------

// Builds the exact { files, context } pair the real validate command (a
// later task) will hand to a ruler, from an in-memory map of vault-relative
// path to file content: `files` is the sorted markdown subset, and
// `context.readFile` mimics the ruler contract's own normalisation
// (stripping a leading byte-order mark and any carriage return) so a rule
// never has to special-case Windows line endings itself. Nothing here
// calls walkVault; the walk is exactly what this helper stands in for.
function rulerArgsFor(fileContents) {
  const paths = Object.keys(fileContents).sort();
  const files = paths.filter((p) => p.endsWith('.md'));
  const cache = new Map();
  const context = {
    root: '/fake-vault',
    config: {},
    all: new Set(paths),
    readFile(relPath) {
      if (!cache.has(relPath)) {
        if (!(relPath in fileContents)) throw new Error(`test double: no fixture content for ${relPath}`);
        let text = fileContents[relPath];
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.replace(/\r\n?/g, '\n');
        cache.set(relPath, text);
      }
      return cache.get(relPath);
    },
  };
  return { files, context };
}

function findingsFor(fileContents) {
  const { files, context } = rulerArgsFor(fileContents);
  return runSpecRules(files, context);
}

// A second scaffold, used only by the malformed-input tests below: it
// writes real files to a real temporary directory through makeVault and
// walks them for real through walkVault, so "a rule must never throw" is
// proven against actual bytes on disk read through the actual walk, not
// only against a hand-built in-memory map.
function findingsForRealVault(fileContents) {
  const root = makeVault({ files: fileContents });
  const config = loadConfig(root);
  const all = walkVault(root, config, { all: true });
  const files = all.filter((p) => p.endsWith('.md'));
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
  return runSpecRules(files, context);
}

// One clean note that satisfies all eight rules at once, including the
// case that matters most: stale_after as a datetime WITH AN OFFSET, which
// is exactly the shape the original validator failed under a [spec]
// label even though the canonical format accepts it. Every per-rule
// violation test below takes this exact text and changes only the one
// field its rule cares about, so the "almost identical shape that must
// not produce a finding" is never far from the shape that must.
const CLEAN_NOTE = [
  '---',
  'type: person',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  'verified: { by: human:ana, at: 2026-09-18T10:00:00Z }',
  'status: stable # confirmed after the latest review',
  'stale_after: 2026-12-18T00:00:00-03:00',
  'sources:',
  '  - resource: https://example.com/ana',
  '---',
  '# Ana',
  '',
  'An example person.',
  '',
].join('\n');

// Broadened in fix round 1: this is the only test certifying the absence
// of a false positive across all eight rules AT ONCE, and a narrower one
// (a single field-free log) would not have caught any of the three
// review findings that live in this exact area (a fenced heading/date
// pair read as real, a comment in the root index read as a declaration,
// a trailing comment on a scalar read as an unreadable fold). The fence
// below sandwiches its decoy heading and its decoy, out-of-order date
// between two real, correctly ordered ones on purpose, so a regression
// back to reading it would surface as a finding right here, not only in
// the dedicated fence test.
const CLEAN_LOG = [
  '## 2026-09-18',
  '',
  'Second entry, most recent.',
  '',
  'Example of what a log entry looks like, shown for documentation,',
  'never read as a real heading or a real date:',
  '',
  '```',
  '## not a real heading, just an example',
  '## 2099-01-01',
  '```',
  '',
  '## 2026-09-17',
  '',
  'First entry.',
  '',
].join('\n');

function cleanVaultFiles() {
  return {
    // A comment annotating okf_version, not a declaration: index-no-frontmatter
    // must not confuse the two (fix round 1).
    'index.md': '---\n# a note for humans about this key, not a declaration\nokf_version: "0.2"\n---\n# Welcome\n',
    'memory/log.md': CLEAN_LOG,
    'people/ana.md': CLEAN_NOTE,
  };
}

function isSpec(id) {
  return (f) => f.ruler === 'spec' && f.id === id;
}

// --- the clean baseline -------------------------------------------------------

test('a vault where every note satisfies every rule, the root index carries no frontmatter, and the log is well formed produces no findings at all', () => {
  assert.deepEqual(findingsFor(cleanVaultFiles()), []);
});

// --- SPEC_RULES and runSpecRules: shape and the ruler+id identity -------------

test('SPEC_RULES is a plain array of eight rule objects, each with a stable id and a section string, and a check function', () => {
  assert.ok(Array.isArray(SPEC_RULES));
  assert.deepEqual(
    SPEC_RULES.map((rule) => rule.id),
    [
      'type-required',
      'index-no-frontmatter',
      'log-format',
      'generated-actor',
      'verified-events',
      'status-enum',
      'stale-after-format',
      'sources-resource',
    ],
  );
  for (const rule of SPEC_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.equal(typeof rule.section, 'string');
    assert.ok(rule.section.length > 0);
    assert.equal(typeof rule.check, 'function');
  }
});

// The level belongs to the CHECK, not to the rule (fix round 3):
// index-no-frontmatter and log-format each emit both a 'must' and a
// 'should' finding from different checks, so neither carries one
// uniform level of its own; every finding either of them produces must
// set its own `level`, with nothing to silently fall back to. The other
// six rules agree with themselves (type-required always 'must'; the
// five section 5 to 10 rules always 'should'), so their rule object
// carries that one level as every one of their findings' default.
test('type-required is must-level and the five section 5 to 10 rules are should-level; index-no-frontmatter and log-format carry no single level of their own', () => {
  const levelById = Object.fromEntries(SPEC_RULES.map((rule) => [rule.id, rule.level]));
  assert.deepEqual(levelById, {
    'type-required': 'must',
    'index-no-frontmatter': undefined,
    'log-format': undefined,
    'generated-actor': 'should',
    'verified-events': 'should',
    'status-enum': 'should',
    'stale-after-format': 'should',
    'sources-resource': 'should',
  });
});

test('every finding carries the same level its rule does', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/must-violation.md': 'no frontmatter at all, a must-level problem\n',
    'people/should-violation.md': CLEAN_NOTE.replace('status: stable # confirmed after the latest review', 'status: pending'),
  };
  const findings = findingsFor(files);
  const must = findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/must-violation.md');
  const should = findings.filter((f) => isSpec('status-enum')(f) && f.file === 'people/should-violation.md');
  assert.equal(must.length, 1);
  assert.equal(must[0].level, 'must');
  assert.equal(should.length, 1);
  assert.equal(should[0].level, 'should');
});

test('every finding carries ruler "spec" explicitly, a check naming its own assertion, and the full Finding shape, since a finding is identified by the (ruler, id, check) triple and never by id alone', () => {
  const files = { ...cleanVaultFiles(), 'people/bad.md': 'no frontmatter at all here\n' };
  const findings = findingsFor(files);
  assert.ok(findings.length > 0, 'the fixture must produce at least one real finding for this assertion to mean anything');
  for (const finding of findings) {
    assert.equal(finding.ruler, 'spec');
    assert.deepEqual(Object.keys(finding).sort(), ['check', 'file', 'id', 'level', 'line', 'message', 'ruler', 'section']);
    assert.equal(typeof finding.check, 'string');
    assert.ok(finding.check.length > 0);
  }
});

// One rule id carries several checks with different meanings
// (generated-actor's actor-present and timestamp-form), so `check` must
// distinguish them even though both share the same id: a filter that
// only matches `id === 'generated-actor'` would reach a missing-actor
// finding while meaning to touch only a timestamp-shaped one, which is
// the exact defect the house ruler's timestamp deviation step had before
// this field existed.
test('check is unique within a rule that emits more than one, so a downstream step can select one specific assertion without reaching the others', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-generated.md': CLEAN_NOTE.replace('generated: { by: human:ana, at: 2026-09-18T09:30:00Z }', 'generated: { by: , at: not-a-datetime }'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/bad-generated.md');
  assert.deepEqual(findings.map((f) => f.check).sort(), ['actor-present', 'timestamp-form']);
});

test('a single note can collect findings from more than one rule at once, each correctly identified by its own id', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/many-problems.md': CLEAN_NOTE.replace('type: person', 'type:').replace('status: stable', 'status: pending'),
  };
  const findings = findingsFor(files).filter((f) => f.file === 'people/many-problems.md');
  assert.deepEqual(findings.map((f) => f.id).sort(), ['status-enum', 'type-required']);
  for (const finding of findings) assert.equal(finding.ruler, 'spec');
});

// --- type-required ------------------------------------------------------------

// Fix round 3: a well-formed frontmatter block that simply has no type
// key is the commonest way this rule fires, and it used to say the file
// "has no frontmatter at all", which is false when the block parses
// fine and just lacks the one key. Both messages checked against each
// other here, not just each against a shared /required/ regex, since
// that regex is exactly loose enough to have hidden this bug for two
// fix rounds.
test('type-required flags a note with no frontmatter at all and, separately, one whose frontmatter has no type key, with two different messages, but allows one with a non-empty type', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-frontmatter.md': 'Just prose, no frontmatter.\n',
    'people/no-type-key.md': '---\ndescription: has frontmatter but no type\n---\nBody.\n',
  };
  const findings = findingsFor(files);

  const noFrontmatter = findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/no-frontmatter.md');
  assert.equal(noFrontmatter.length, 1);
  assert.equal(noFrontmatter[0].line, null);
  assert.match(noFrontmatter[0].message, /no frontmatter at all/);

  const noTypeKey = findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/no-type-key.md');
  assert.equal(noTypeKey.length, 1);
  assert.equal(noTypeKey[0].line, null);
  assert.match(noTypeKey[0].message, /required/);
  assert.ok(!/no frontmatter at all/.test(noTypeKey[0].message), 'a well-formed block with no type key must not be told it has no frontmatter at all');

  assert.deepEqual(findings.filter((f) => f.file === 'people/ana.md'), []);
});

// Fix round 1: an unterminated frontmatter block used to report "type is
// required but missing" even though a type line sits in plain sight
// inside the never-closed block, which is the precise confident-wrong
// finding this whole module exists to avoid. Paired against a file whose
// frontmatter DOES close and genuinely has no type key, which must still
// say "missing", not the new unterminated-block message.
test('type-required never says a type is missing when its frontmatter is merely unterminated, but still says missing for a properly closed block with no type key', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/unterminated.md': '---\ntype: note\ndescription: this block never closes\n',
    'people/closed-no-type.md': '---\ndescription: this block closes but has no type\n---\nBody.\n',
  };
  const findings = findingsFor(files);

  const unterminated = findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/unterminated.md');
  assert.equal(unterminated.length, 1);
  assert.ok(!/missing/.test(unterminated[0].message), 'must not claim the type is missing when it is plainly on screen');
  assert.match(unterminated[0].message, /never closed|not closed/);

  const closed = findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/closed-no-type.md');
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /missing/);
});

test('type-required treats a present but unreadable type (a block scalar header) as a distinct finding from an absent one, naming PARSER_LIMITS rather than calling the field missing', () => {
  const files = { ...cleanVaultFiles(), 'people/unreadable-type.md': CLEAN_NOTE.replace('type: person', 'type: |') };
  const findings = findingsFor(files).filter((f) => isSpec('type-required')(f) && f.file === 'people/unreadable-type.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /PARSER_LIMITS/);
  assert.ok(!/required but missing/.test(findings[0].message), 'an unreadable shape must not be reported as missing');
  assert.equal(findings[0].line, 2); // line 1 is "---", line 2 is "type: |"
});

test('type-required flags a type key present but left empty, distinct from both the absent and the unreadable case', () => {
  const files = { ...cleanVaultFiles(), 'people/empty-type.md': CLEAN_NOTE.replace('type: person', 'type:') };
  const findings = findingsFor(files).filter((f) => isSpec('type-required')(f) && f.file === 'people/empty-type.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /empty/);
});

test('type-required exempts index.md and log.md at any depth, even though neither carries a type, but still flags an ordinary file beside them with the same problem', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/index.md': 'a folder index, no frontmatter, no type\n',
    'archive/log.md': '## 2026-01-01\n\nAn older, secondary log file.\n',
    'people/plain.md': 'an ordinary note, no frontmatter, no type, and not a reserved name\n',
  };
  const findings = findingsFor(files);
  assert.deepEqual(
    findings.filter((f) => isSpec('type-required')(f) && (f.file === 'people/index.md' || f.file === 'archive/log.md')),
    [],
  );
  assert.equal(
    findings.filter((f) => isSpec('type-required')(f) && f.file === 'people/plain.md').length,
    1,
    'an ordinary file with the exact same missing-type problem must still be flagged, or this exemption test would pass against a stub that flags nothing at all',
  );
});

// --- index-no-frontmatter -------------------------------------------------------

test('index-no-frontmatter allows the root index to have no frontmatter at all, or only okf_version, but flags any other key alongside it, at that key\x27s own line', () => {
  const withOkfVersionOnly = { ...cleanVaultFiles(), 'index.md': '---\nokf_version: "0.2"\n---\n# Welcome\n' };
  const withNoFrontmatterAtAll = { ...cleanVaultFiles(), 'index.md': '# Welcome, no frontmatter at all\n' };
  const withExtraKey = { ...cleanVaultFiles(), 'index.md': '---\nokf_version: "0.2"\ntitle: My Vault\n---\n# Welcome\n' };

  assert.deepEqual(findingsFor(withOkfVersionOnly).filter(isSpec('index-no-frontmatter')), []);
  assert.deepEqual(findingsFor(withNoFrontmatterAtAll).filter(isSpec('index-no-frontmatter')), []);

  const bad = findingsFor(withExtraKey).filter(isSpec('index-no-frontmatter'));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].file, 'index.md');
  assert.equal(bad[0].line, 3); // line 1 "---", line 2 okf_version, line 3 the extra key
  assert.match(bad[0].message, /okf_version/);
  // Section 8's exception names only okf_version; whether another key
  // breaks the structure is arguable, and the rule for an arguable
  // reading is to claim the lower level.
  assert.equal(bad[0].level, 'should');
});

// Fix round 1, two defects in the same check: a YAML comment annotating
// okf_version was read as a forbidden declaration (a person's own note
// should never be told it is a declaration), and the mirror defect this
// port had introduced, an indented line was silently allowed no matter
// what it said, where the original validator caught it. Both pinned
// down together, against the same almost-clean root index.
test('index-no-frontmatter exempts a YAML comment annotating okf_version, but still flags an indented extra line, not only a column-0 one', () => {
  const withComment = {
    ...cleanVaultFiles(),
    'index.md': '---\n# a note for humans about this key, not a declaration\nokf_version: "0.2"\n---\n# Welcome\n',
  };
  assert.deepEqual(findingsFor(withComment).filter(isSpec('index-no-frontmatter')), []);

  const withIndentedExtra = {
    ...cleanVaultFiles(),
    'index.md': '---\nokf_version: "0.2"\n  title: My Vault\n---\n# Welcome\n',
  };
  const bad = findingsFor(withIndentedExtra).filter(isSpec('index-no-frontmatter'));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 3);
  assert.match(bad[0].message, /title/);
});

test('index-no-frontmatter flags any non-root index.md that carries frontmatter at all, at line 1, but allows one with none', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/index.md': '---\ntype: index\n---\n# People\n',
    'projects/index.md': '# Projects, no frontmatter here\n',
  };
  const findings = findingsFor(files);
  const bad = findings.filter((f) => isSpec('index-no-frontmatter')(f) && f.file === 'people/index.md');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 1);
  // Section 8 states this plainly, with no exception for a non-root index.
  assert.equal(bad[0].level, 'must');
  assert.deepEqual(findings.filter((f) => f.file === 'projects/index.md'), []);
});

// --- log-format ------------------------------------------------------------------

test('log-format flags a log.md that carries frontmatter, at line 1, but allows one with none', () => {
  const files = { ...cleanVaultFiles(), 'memory/log.md': '---\ntype: log\n---\n## 2026-09-18\n\nEntry.\n' };
  const bad = findingsFor(files).filter(isSpec('log-format'));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].file, 'memory/log.md');
  assert.equal(bad[0].line, 1);
  assert.match(bad[0].message, /frontmatter/);
  // Section 9 is silent on frontmatter in the log; the structure it shows has none.
  assert.equal(bad[0].level, 'should');
});

// Fix round 4: the heading check is three-way, and the two levels fix
// round 3 assigned were backwards. Section 9's one MUST is "Date
// headings MUST use ISO 8601 `YYYY-MM-DD` form", so a heading that is
// plainly an attempt at a date and is NOT in that form ("## 2026-5-22",
// "## 22/05/2026") is the most direct violation the section has, and was
// being reported at 'should' with a message saying it "is not a date".
// A well-formed date that fails the calendar ("## 2026-02-30") is 'must'
// too, since a day that cannot exist is not an ISO 8601 date. Only a
// heading that is not an attempt at a date at all ("## Notes") is
// 'should', because reading the MUST as a rule that every level-two
// heading in a log must be a date is the wider claim the text does not
// plainly support.
test('log-format grades a malformed date heading and an impossible date heading at must-level, and a prose heading at should-level, with three distinct messages', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': [
      '## 2026-09-18', // line 1: well formed and real, no finding
      '',
      'ok',
      '',
      '## Notes', // line 5: prose, not an attempt at a date
      '',
      '## 2026-02-30', // line 7: right form, impossible day
      '',
      '## 2026-5-22', // line 9: a date, wrong form
      '',
      '## 22/05/2026', // line 11: a date, wrong form again
      '',
    ].join('\n'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 4);

  const prose = findings.find((f) => f.line === 5);
  assert.equal(prose.level, 'should');
  assert.match(prose.message, /is not a date heading/);

  const impossible = findings.find((f) => f.line === 7);
  assert.equal(impossible.level, 'must');
  assert.match(impossible.message, /names a day that does not exist/);

  for (const line of [9, 11]) {
    const wrongForm = findings.find((f) => f.line === line);
    assert.equal(wrongForm.level, 'must', `the heading on line ${line} violates section 9's only MUST`);
    assert.match(wrongForm.message, /requires date headings in ISO 8601 YYYY-MM-DD form/);
  }

  // The three messages must not be interchangeable: telling someone
  // "section 9 requires the YYYY-MM-DD form" about "## 2026-02-30",
  // whose form is already fine, teaches them nothing about what is
  // wrong, which is the defect fix round 4 was called in to fix.
  assert.equal(new Set(findings.map((f) => f.message.replace(/"## [^"]*"/, ''))).size, 3);
});

test('log-format flags dates that run oldest-first instead of most-recent-first, at must-level, at the line of the entry that breaks the order', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': ['## 2026-09-17', '', 'older, listed first', '', '## 2026-09-18', '', 'newer, listed second: wrong', ''].join('\n'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
  assert.match(findings[0].message, /most recent to oldest/);
  // Section 9 opens "The format is a flat list of date-grouped entries,
  // newest first:", so ordering is STATED, not merely shown by the
  // example, and section 11 clause 3 makes following section 9 a matter
  // of conformance. Fix rounds 1 to 3 graded this 'should' on the false
  // claim that the section was silent about order.
  assert.equal(findings[0].level, 'must');
});

// Two consecutive headings dated the same day (more than one entry
// logged the same date) must NOT be flagged: the order check is "not
// more recent than the one before it" (a plain ">"), not "strictly
// older" (which an off-by-one mutant to ">=" would enforce instead).
// Pinned down directly, since the earlier order test alone cannot
// distinguish the two: neither an equal-dates run nor a genuinely
// descending one ever exercises the ">=" branch differently from ">".
test('log-format allows two consecutive headings dated the same day, not just strictly descending ones, but still flags a same-day run followed by a newer one', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': ['## 2026-09-18', '', 'second entry that day', '', '## 2026-09-18', '', 'first entry that day', ''].join('\n'),
    // Two entries share a day, correctly, and then a THIRD, newer date
    // follows them: the same-day pair must not by itself excuse what
    // comes after it from the ordering check.
    'archive/log.md': [
      '## 2026-09-17',
      '',
      'older, same day as the next one',
      '',
      '## 2026-09-17',
      '',
      'same day again',
      '',
      '## 2026-09-18',
      '',
      'newer, listed last: wrong',
      '',
    ].join('\n'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => f.file === 'memory/log.md'), []);
  const bad = findings.filter((f) => isSpec('log-format')(f) && f.file === 'archive/log.md');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /most recent to oldest/);
});

test('log-format survives malformed and binary-ish content without throwing, and still finds the bad-format and out-of-order defects mixed in with garbage', () => {
  const messyLog = [
    String.fromCharCode(0, 1, 2) + 'binary preamble' + String.fromCharCode(255),
    '## not-a-real-date',
    String.fromCharCode(254) + 'more garbage',
    '## 2026-09-17',
    '## 2026-09-18',
  ].join('\n');

  const files = {
    ...cleanVaultFiles(),
    'a/log.md': '', // empty: must not throw, must report nothing
    'b/log.md': '---\n', // only the opening delimiter: must not throw, must report nothing
    'c/log.md': '---\ntype: note\n', // opened but never closed: must not throw, must report nothing
    'd/log.md': messyLog, // binary-ish garbage plus two real defects
  };

  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor(files);
  });

  for (const clean of ['a/log.md', 'b/log.md', 'c/log.md']) {
    assert.deepEqual(findings.filter((f) => f.file === clean), [], `${clean} has no headings and no frontmatter, so it must report nothing`);
  }

  const messy = findings.filter((f) => isSpec('log-format')(f) && f.file === 'd/log.md');
  assert.equal(messy.length, 2);
  assert.equal(messy[0].level, 'should'); // "## not-a-real-date" is prose, not an attempt at a date
  assert.match(messy[0].message, /is not a date heading/);
  assert.equal(messy[1].level, 'must'); // ordering: section 9 states "newest first"
  assert.match(messy[1].message, /most recent to oldest/);
});

// Fix round 1, the critical finding: a "## " line or a quoted date inside
// a fenced code block was read as a real heading or a real entry. Both
// defects reproduced together here, inside a fence sandwiched between
// two real, correctly ordered headings, so a regression back to reading
// fences would reintroduce a "not a date heading" finding for the comment
// AND a bogus out-of-order finding for the quoted future date, pointing
// at lines that are only ever example text.
test('log-format never reads a heading or a date from inside a fenced code block, but still reads one right outside it', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': [
      '## 2026-09-18',
      '',
      'Example of what a log entry looks like, shown for documentation:',
      '',
      '```',
      '## not a real heading, just an example',
      '## 2099-01-01',
      '```',
      '',
      // Same shape as the two lines inside the fence, placed right after
      // it: if fence-skipping ever regressed to skipping too much (or
      // reading too little outside the fence), this line would either
      // disappear from the count below or be missed entirely.
      '## not a real heading either, but this one is OUTSIDE the fence',
      '',
      '## 2026-09-17',
      '',
      'A real, older entry.',
      '',
    ].join('\n'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1, 'only the heading outside the fence should be flagged, not the two decoys inside it');
  assert.equal(findings[0].level, 'should');
  assert.match(findings[0].message, /is not a date heading/);
  assert.match(findings[0].message, /OUTSIDE the fence/);
});

// Fix round 3: the fence rule handed down by the review, not a bare
// "```" prefix. Three cases in one test, each a gap the earlier version
// had: a tilde fence (missed entirely, since only backticks were
// recognised); a three-backtick fence nested inside a four-backtick one
// (closed early on the shorter marker, since length was never tracked);
// and, the false negative, a line of three backticks inside a real
// four-space-indented code block, which must NOT open a fence at all,
// or everything after it silently disappears, including a violation
// that must still be caught.
test('withoutFencedBlocks recognises a tilde fence, does not close a longer fence on a shorter nested marker, and never treats an indented code block as a fence', () => {
  const files = {
    ...cleanVaultFiles(),
    'a/log.md': ['## 2026-09-18', '', '~~~', '## not a real heading, inside a tilde fence', '## 2099-01-01', '~~~', '', '## 2026-09-17', ''].join(
      '\n',
    ),
    'b/log.md': [
      '## 2026-09-18',
      '',
      '````',
      'an outer four-backtick fence',
      '```',
      '## not a real heading, a three-backtick fence nested inside it',
      '```',
      'still inside the outer fence, since three backticks is shorter than four',
      '````',
      '',
      '## 2026-09-17',
      '',
    ].join('\n'),
    // The deliberately bad heading after the indented block is the
    // detector: if the indented "```" line wrongly opened a fence, this
    // line, and the finding it must produce, would silently disappear.
    'c/log.md': [
      '## 2026-09-18',
      '',
      '    a four-space indented code block',
      '    ```',
      '    three backticks, indented the same way: still just code, not a fence',
      '',
      '## not a real date, deliberately bad, must still be caught',
      '',
    ].join('\n'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => f.file === 'a/log.md'), []);
  assert.deepEqual(findings.filter((f) => f.file === 'b/log.md'), []);
  const cFindings = findings.filter((f) => isSpec('log-format')(f) && f.file === 'c/log.md');
  assert.equal(cFindings.length, 1, 'the heading after the indented code block must still be read and flagged');
  assert.match(cFindings[0].message, /is not a date heading/);
});

// The review's addition to the fence contract: a fence quoted inside a
// blockquote ("> ```") is still a fence, not prose, so a decoy heading
// inside one must be exactly as invisible as an unquoted one, while a
// real heading right after the blockquote closes must still be read.
test('a fenced block inside a blockquote is skipped the same as an unquoted one, but a real heading right after the quote survives', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': [
      '## 2026-09-18',
      '',
      '> ```',
      '> ## not a real heading, quoted and fenced',
      '> ```',
      '',
      '## not a real date, right after the quote, must still be caught',
      '',
    ].join('\n'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1, 'only the heading after the blockquote should be flagged, not the one quoted and fenced inside it');
  assert.match(findings[0].message, /is not a date heading/);
});

// log-format's own heading check shares the same calendar-valid date
// function as stale-after-format (fix round 1): a heading with the right
// shape but an impossible date is still a must-level violation of
// section 9, since a day that never happened is not an ISO 8601 date.
// Its message says the form is fine and the day is not, which is a
// different message from the one a wrongly-formed date gets (fix round
// 4): the two were interchangeable before, and the interchangeable one
// told a person their form was wrong when it was not.
test('log-format checks the calendar on its headings too, not just their shape', () => {
  const files = { ...cleanVaultFiles(), 'memory/log.md': ['## 2026-02-29', '', 'a leap day that never happened in 2026', ''].join('\n') };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'must');
  assert.match(findings[0].message, /names a day that does not exist/);
});

// --- generated-actor ---------------------------------------------------------

test('generated-actor does not fire when generated is absent, but does fire, against PARSER_LIMITS and not as "missing", when generated is present in a shape the reader cannot see', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-generated.md': CLEAN_NOTE.replace('generated: { by: human:ana, at: 2026-09-18T09:30:00Z }\n', ''),
    'people/unreadable-generated.md': CLEAN_NOTE.replace(
      'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
      'generated: &g1 { by: human:ana, at: 2026-09-18T09:30:00Z }',
    ),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/no-generated.md'), []);

  const unreadable = findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/unreadable-generated.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
  assert.ok(!/missing/.test(unreadable[0].message));
});

test('generated-actor requires a non-empty by, but leaves at alone when at is simply absent', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-by.md': CLEAN_NOTE.replace('generated: { by: human:ana, at: 2026-09-18T09:30:00Z }', 'generated: { at: 2026-09-18T09:30:00Z }'),
    'people/no-at.md': CLEAN_NOTE.replace('generated: { by: human:ana, at: 2026-09-18T09:30:00Z }', 'generated: { by: human:ana }'),
  };
  const findings = findingsFor(files);
  const noBy = findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/no-by.md');
  assert.equal(noBy.length, 1);
  assert.match(noBy[0].message, /by/);
  assert.deepEqual(findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/no-at.md'), []);
});

// Fix round 3: fix round 1 widened findKeyLine in src/frontmatter.mjs to
// recognise a quoted key, so a quoted "generated" key now reads
// correctly, but this module's OWN frontmatterKeyLine still matched only
// the bare form, so the resulting finding reported line: null, as if
// the key were absent, for a key that is right there on screen.
test('a quoted generated key is read correctly and its finding reports a real line, not null', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/quoted-key.md': CLEAN_NOTE.replace('generated: { by: human:ana, at: 2026-09-18T09:30:00Z }', '"generated": { at: 2026-09-18T09:30:00Z }'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/quoted-key.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /by/);
  assert.equal(findings[0].line, 3); // line 1 "---", line 2 "type: person", line 3 "generated": {...}
});

test('generated-actor requires at, when present, to be an ISO 8601 datetime, but accepts one with an explicit offset', () => {
  const files = { ...cleanVaultFiles(), 'people/bad-at.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', 'at: 18/09/2026 }') };
  const findings = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/bad-at.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /ISO 8601/);
  // people/ana.md, present in every fixture above via cleanVaultFiles(), keeps its
  // "at: 2026-09-18T09:30:00Z" (an offset of zero, spelled "Z") and reports nothing.
});

// --- verified-events ----------------------------------------------------------

test('verified-events does not fire when verified is absent, but does fire, against PARSER_LIMITS, when verified is present in an unreadable shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-verified.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }\n', ''),
    'people/unreadable-verified.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: |'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/no-verified.md'), []);

  const unreadable = findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/unreadable-verified.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

test('verified-events requires both by and at on a single inline event, but allows one that carries both', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/verified-missing-at.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: { by: human:ana }'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-missing-at.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /verified\[0\]/);
  // people/ana.md keeps its complete inline event and reports nothing (see the clean-baseline test).
});

// Fix round 5: this module quotes section 5 as binding "every
// timestamp-valued key", and verified[].at used to be checked only for
// presence, the same as by, even though it is exactly as timestamp-
// valued as generated.at. A non-blank but malformed at (no offset, or a
// plain date) must now be its own finding, distinct from a missing one,
// under the event-timestamp-form check.
test('verified-events requires at to be an ISO 8601 datetime with an explicit offset, not merely present, and reports it as event-timestamp-form', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/verified-bad-at-form.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: { by: human:ana, at: 2026-09-18 }'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-bad-at-form.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'event-timestamp-form');
  assert.match(findings[0].message, /UTC offset/);
});

// Fix round 2: a blank at and a malformed at used to share the same
// check name (event-timestamp-form), which is the exact defect the
// check field exists to prevent, one level down: a downgrade selecting
// by that name would reach a finding about at being ABSENT, not merely
// mis-shaped. Pinned directly, with both shapes in the same test, so a
// future rename of either check cannot silently reintroduce this: a
// blank at and a malformed at must never share a check name.
test('verified-events names a blank at and a malformed at with two different checks, never the same one', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/verified-blank-at.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: { by: human:ana, at: }'),
    'people/verified-malformed-at.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: { by: human:ana, at: 2026-09-18 }'),
  };
  const findings = findingsFor(files);
  const blank = findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-blank-at.md');
  const malformed = findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-malformed-at.md');
  assert.equal(blank.length, 1);
  assert.equal(malformed.length, 1);
  assert.notEqual(blank[0].check, malformed[0].check, 'a missing at and a malformed at must never be named by the same check');
});

test('verified-events reads a block list of multiple events and flags only the one missing a field, by index', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/verified-list.md': CLEAN_NOTE.replace(
      'verified: { by: human:ana, at: 2026-09-18T10:00:00Z }',
      ['verified:', '  - by: human:ana', '    at: 2026-09-18T10:00:00Z', '  - by: brain-kit-curator/claude-opus-5'].join('\n'),
    ),
  };
  const findings = findingsFor(files).filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-list.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /verified\[1\]/);
});

// Fix round 1: a `verified` key present with nothing under it at all
// (zero events) used to pass silently. Restored, matching the original
// validator's own "verified vazio" finding. Paired against an empty
// INLINE mapping ("verified: {}"), which is a different shape (one
// event with no fields) that already fails the by/at check on its own
// and must keep doing so, not be swept into this same "no events" path.
test('verified-events flags a key present with no events under it at all, but treats an empty inline mapping as one incomplete event instead', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/verified-empty-block.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified:'),
    'people/verified-empty-mapping.md': CLEAN_NOTE.replace('verified: { by: human:ana, at: 2026-09-18T10:00:00Z }', 'verified: {}'),
  };
  const findings = findingsFor(files);

  const emptyBlock = findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-empty-block.md');
  assert.equal(emptyBlock.length, 1);
  assert.match(emptyBlock[0].message, /no events/);

  // An empty inline mapping is one event with BOTH fields blank, and
  // fix round 5 split the by check and the at check apart (the same
  // split generated-actor already had), so this now produces two
  // findings, one per field, rather than the one combined message it
  // used to. Fix round 2 split the at check again, into presence and
  // form, so a blank at is event-timestamp-present here, not
  // event-timestamp-form (see the invariant test below for why).
  const emptyMapping = findings.filter((f) => isSpec('verified-events')(f) && f.file === 'people/verified-empty-mapping.md');
  assert.equal(emptyMapping.length, 2);
  assert.deepEqual(emptyMapping.map((f) => f.check).sort(), ['event-actor', 'event-timestamp-present']);
  for (const finding of emptyMapping) assert.match(finding.message, /verified\[0\]/);
});

// --- status-enum ---------------------------------------------------------------

test('status-enum accepts every value in the enum, but flags one outside it', () => {
  for (const value of ['draft', 'stable', 'deprecated']) {
    const files = { ...cleanVaultFiles(), 'people/status-ok.md': CLEAN_NOTE.replace('status: stable', `status: ${value}`) };
    assert.deepEqual(
      findingsFor(files).filter((f) => isSpec('status-enum')(f) && f.file === 'people/status-ok.md'),
      [],
      `status: ${value} must be accepted`,
    );
  }

  const files = { ...cleanVaultFiles(), 'people/status-bad.md': CLEAN_NOTE.replace('status: stable', 'status: pending') };
  const bad = findingsFor(files).filter((f) => isSpec('status-enum')(f) && f.file === 'people/status-bad.md');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /draft, stable, deprecated/);
});

test('status-enum does not fire when status is absent, but does fire, against PARSER_LIMITS, when it is present in an unreadable shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-status.md': CLEAN_NOTE.replace('status: stable # confirmed after the latest review\n', ''),
    'people/unreadable-status.md': CLEAN_NOTE.replace('status: stable', 'status:\n  folded on the next line'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('status-enum')(f) && f.file === 'people/no-status.md'), []);

  const unreadable = findings.filter((f) => isSpec('status-enum')(f) && f.file === 'people/unreadable-status.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

// --- stale-after-format ----------------------------------------------------------

// Fix round 2: section 5 of the format states, quoted whole since fix
// round 4 (earlier rounds stopped this sentence short inside its own
// quotation marks, which is an alteration, not a shortening), "Every
// timestamp-valued key in OKF is an ISO 8601 datetime with an explicit
// UTC offset, for example `2026-06-30T14:00:00Z`.", with
// no alternative on offer, so the plan's earlier "a plain date is
// accepted too" was leniency wearing a specification badge. This is
// still the case that matters most, in the opposite direction from
// round 1: a datetime with an offset must pass (the original validator
// failed exactly this under a [spec] label), and a plain date, once
// accepted here, must now be a finding that says the format requires
// the offset, not merely that the shape is unrecognised.
test('stale-after-format requires an explicit UTC offset per section 5: a datetime with an offset passes, a plain date no longer does', () => {
  // people/ana.md, in cleanVaultFiles(), already carries the offset form
  // (2026-12-18T00:00:00-03:00) and is asserted clean by the baseline test.
  const files = {
    ...cleanVaultFiles(),
    'people/date-only.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/date-only.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /explicit UTC offset/);
  assert.match(findings[0].message, /section 5/);
});

test('stale-after-format flags any value that is not a datetime with an explicit UTC offset, including a placeholder-looking value, since the spec ruler has no notion of templates', () => {
  // Placeholder exemption is a house-only concept (a documented defect of
  // the original validator this port deliberately does not reproduce): it
  // applies only under the configured templates directory, in the house
  // ruler. The spec ruler here has no such exemption at all, anywhere.
  const cases = {
    'bad format': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 18/12/2026'),
    'datetime with no offset': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18T00:00:00'),
    'placeholder-looking value': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: <fill-in>'),
  };
  for (const [label, content] of Object.entries(cases)) {
    const files = { ...cleanVaultFiles(), 'people/bad.md': content };
    const bad = findingsFor(files).filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/bad.md');
    assert.equal(bad.length, 1, `${label} should be flagged`);
  }
});

// Fix round 1: the date and datetime patterns accepted a calendar-
// impossible value as long as it had the right count of digits in the
// right places. Every one of these has the correct SHAPE and an
// impossible MEANING; each must still be flagged. Paired against the
// calendar-valid neighbour that differs by the smallest possible margin
// (a leap year for the 29th of February, a 30-day month for the 30th),
// so this is checking the calendar, not merely rejecting big numbers.
// Fix round 2 changed the accepted SHAPE (a datetime with an offset
// only, no more plain date), but the calendar check underneath it is
// the same one fix round 1 added, so every case here now carries the
// offset that stale_after requires, isolating "is the calendar right"
// from "is the offset there" instead of conflating the two.
test('stale-after-format checks the calendar, not just the shape: a real datetime with impossible components is flagged, and its calendar-valid neighbour is not', () => {
  const impossible = {
    '29 February in a non-leap year': 'stale_after: 2026-02-29T00:00:00Z',
    '31st of April': 'stale_after: 2026-04-31T00:00:00Z',
    '13th month': 'stale_after: 2026-13-01T00:00:00Z',
    '99th day': 'stale_after: 2026-01-99T00:00:00Z',
  };
  for (const [label, replacement] of Object.entries(impossible)) {
    const files = { ...cleanVaultFiles(), 'people/bad.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', replacement) };
    const bad = findingsFor(files).filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/bad.md');
    assert.equal(bad.length, 1, `${label} should be flagged`);
  }

  // 2028 is a leap year: the 29th of February is a real, calendar-valid date.
  const leapYear = { ...cleanVaultFiles(), 'people/leap.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2028-02-29T00:00:00Z') };
  assert.deepEqual(findingsFor(leapYear).filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/leap.md'), []);

  // April has 30 days: the 30th is real, only the 31st is impossible.
  const thirtyApril = { ...cleanVaultFiles(), 'people/april30.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-04-30T00:00:00Z') };
  assert.deepEqual(findingsFor(thirtyApril).filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/april30.md'), []);
});

// Fix round 1, the time-of-day and offset side of the same defect:
// generated.at accepted an hour or minute of 99 and an offset of 99
// hours, both matching "\d\d" perfectly while describing a time that
// cannot exist.
test('generated-actor checks the calendar and the clock on at, not just the shape', () => {
  const impossible = {
    'hour of 99': 'at: 2026-09-18T99:30:00Z }',
    'minute of 99': 'at: 2026-09-18T09:99:00Z }',
    'offset of 99 hours': 'at: 2026-09-18T09:30:00+99:00 }',
  };
  for (const [label, replacement] of Object.entries(impossible)) {
    const files = { ...cleanVaultFiles(), 'people/bad.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', replacement) };
    const bad = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/bad.md');
    assert.equal(bad.length, 1, `${label} should be flagged`);
  }
});

// The UTC offset range, fix round 4. Fix round 3 wrote the real range
// (-12:00 to +14:00) into the module's comment and then implemented a
// single unsigned ceiling of fourteen hours with a separate minute bound
// of 59, which is not that range: it accepted +14:59, because 14 and 59
// each sit inside their own bound while the offset they compose does
// not, and it accepted -13:00 and -14:00, because their digits are no
// larger than fourteen. The range is ASYMMETRIC, and the four cases the
// old check let through are pinned down here beside the two that must
// pass, since a test that only tried +15:00 was satisfied by the
// unsigned ceiling and could never have caught any of them.
test('generated-actor accepts the real UTC offset range, plus fourteen hours to minus twelve, rejecting plus fourteen fifty-nine, plus fifteen, minus thirteen and minus fourteen', () => {
  const accepted = { 'plus 14:00, the eastern extreme': '+14:00', 'minus 12:00, the western extreme': '-12:00' };
  const rejected = {
    'plus 15:00, beyond the eastern extreme': '+15:00',
    'plus 14:59, inside the hour ceiling but beyond the offset it composes': '+14:59',
    'minus 13:00, beyond the western extreme though inside an unsigned ceiling of 14': '-13:00',
    'minus 14:00, the mirror of the eastern extreme, which the west does not reach': '-14:00',
  };

  for (const [label, offset] of Object.entries(accepted)) {
    const files = { ...cleanVaultFiles(), 'people/offset.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', `at: 2026-09-18T09:30:00${offset} }`) };
    const findings = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/offset.md');
    assert.deepEqual(findings, [], `${label} is a real offset and must pass`);
  }

  for (const [label, offset] of Object.entries(rejected)) {
    const files = { ...cleanVaultFiles(), 'people/offset.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', `at: 2026-09-18T09:30:00${offset} }`) };
    const findings = findingsFor(files).filter((f) => isSpec('generated-actor')(f) && f.file === 'people/offset.md');
    assert.equal(findings.length, 1, `${label} is not a real offset and must be flagged`);
  }
});

// The same range, checked on stale_after rather than generated.at: both
// read the one isValidIsoDatetimeWithOffset, and nothing else pins that
// down, so a future rule reading timestamps through a second path would
// go unnoticed here.
test('stale-after-format applies the same UTC offset range as generated.at does', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/east-extreme.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18T00:00:00+14:00'),
    'people/west-extreme.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18T00:00:00-12:00'),
    'people/too-far-west.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18T00:00:00-13:00'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/east-extreme.md'), []);
  assert.deepEqual(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/west-extreme.md'), []);
  assert.equal(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/too-far-west.md').length, 1);
});

// Leap-day handling itself is untouched by this round; re-confirmed here
// across a century year (not divisible by 400, so NOT a leap year) and a
// four-century year (divisible by 400, so a leap year after all), since
// the review verified exactly these cases and asked that this logic not
// be disturbed while fixing the offset ceiling right beside it.
test('generated-actor still gets the century and four-century leap-year cases right, unchanged by this round', () => {
  const files = {
    ...cleanVaultFiles(),
    // 1900 is divisible by 100 but not by 400: not a leap year, so its 29th of February does not exist.
    'people/century.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', 'at: 1900-02-29T09:30:00Z }'),
    // 2000 is divisible by 400: a leap year, so its 29th of February is real.
    'people/four-century.md': CLEAN_NOTE.replace('at: 2026-09-18T09:30:00Z }', 'at: 2000-02-29T09:30:00Z }'),
  };
  const findings = findingsFor(files);
  assert.equal(findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/century.md').length, 1);
  assert.deepEqual(findings.filter((f) => isSpec('generated-actor')(f) && f.file === 'people/four-century.md'), []);
});

test('stale-after-format does not fire when stale_after is absent, but does fire, against PARSER_LIMITS, when present in an unreadable shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-stale-after.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00\n', ''),
    'people/unreadable-stale-after.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: |'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/no-stale-after.md'), []);

  const unreadable = findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/unreadable-stale-after.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

// --- sources-resource --------------------------------------------------------------

test('sources-resource requires every entry to carry a non-empty resource, flagging only the entries that do not, by index', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/sources-list.md': CLEAN_NOTE.replace(
      'sources:\n  - resource: https://example.com/ana',
      ['sources:', '  - resource: https://example.com/ana', '  - title: no resource here', '  - resource:'].join('\n'),
    ),
  };
  const findings = findingsFor(files).filter((f) => isSpec('sources-resource')(f) && f.file === 'people/sources-list.md');
  assert.deepEqual(
    findings.map((f) => f.message.match(/sources\[\d+\]/)[0]),
    ['sources[1]', 'sources[2]'],
  );
});

// Fix round 5: sources[].last_modified is exactly as timestamp-valued
// as generated.at, and this rule used to never check it at all, against
// the same section 5 sentence the whole file quotes as binding "every"
// such key. Absence is not itself a finding (last_modified is not named
// as required anywhere); a malformed one, when present, is, and it is
// the entry-timestamp-form check that reports it, distinct from
// entry-resource.
test('sources-resource checks last_modified\x27s form when present, but leaves it alone when absent, and names the check entry-timestamp-form', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/sources-good-last-modified.md': CLEAN_NOTE.replace(
      'sources:\n  - resource: https://example.com/ana',
      'sources:\n  - resource: https://example.com/ana\n    last_modified: 2026-09-01T00:00:00Z',
    ),
    'people/sources-bad-last-modified.md': CLEAN_NOTE.replace(
      'sources:\n  - resource: https://example.com/ana',
      'sources:\n  - resource: https://example.com/ana\n    last_modified: 2026-09-01',
    ),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('sources-resource')(f) && f.file === 'people/sources-good-last-modified.md'), []);

  const bad = findings.filter((f) => isSpec('sources-resource')(f) && f.file === 'people/sources-bad-last-modified.md');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].check, 'entry-timestamp-form');
  assert.match(bad[0].message, /last_modified/);
});

test('sources-resource does not fire when sources is absent, but does fire, against PARSER_LIMITS, when present in an unreadable shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-sources.md': CLEAN_NOTE.replace('sources:\n  - resource: https://example.com/ana\n', ''),
    'people/unreadable-sources.md': CLEAN_NOTE.replace('sources:\n  - resource: https://example.com/ana', 'sources: nothing-useful'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('sources-resource')(f) && f.file === 'people/no-sources.md'), []);

  const unreadable = findings.filter((f) => isSpec('sources-resource')(f) && f.file === 'people/unreadable-sources.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

// --- a rule must never throw: malformed, truncated, empty and binary-ish files ----

test('a rule never throws on malformed input, empty, only the opening delimiter, or a frontmatter block that is never closed, and reports each as a type-required finding rather than as an exception or as silence', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/empty.md': '',
    'people/only-open.md': '---\n',
    'people/unterminated.md': '---\ntype: note\ndescription: this frontmatter block is never closed\n',
  };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsForRealVault(files);
  });
  for (const file of ['people/empty.md', 'people/only-open.md', 'people/unterminated.md']) {
    const fileFindings = findings.filter((f) => f.file === file);
    assert.deepEqual(fileFindings.map((f) => f.id), ['type-required'], `${file} should produce exactly one type-required finding`);
    assert.equal(fileFindings[0].ruler, 'spec');
  }
});

test('a rule never throws on binary-ish content either, and still reports the missing type rather than silently passing', () => {
  const binaryish = String.fromCharCode(0, 1, 2, 255, 254) + 'not really frontmatter' + String.fromCharCode(7);
  const files = { ...cleanVaultFiles(), 'people/binary.md': binaryish };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsForRealVault(files);
  });
  const fileFindings = findings.filter((f) => f.file === 'people/binary.md');
  assert.deepEqual(fileFindings.map((f) => f.id), ['type-required']);
});
