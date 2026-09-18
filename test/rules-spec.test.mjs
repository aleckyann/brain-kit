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
// A finding is identified by the PAIR of ruler and id, never by id alone:
// stale-after-format exists again, with a different meaning, in the house
// ruler (a vault may narrow the spec's "either form" down to one), so
// every filter below matches on `f.ruler === 'spec' && f.id === '...'`
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
  'status: stable',
  'stale_after: 2026-12-18T00:00:00-03:00',
  'sources:',
  '  - resource: https://example.com/ana',
  '---',
  '# Ana',
  '',
  'An example person.',
  '',
].join('\n');

const CLEAN_LOG = ['## 2026-09-18', '', 'Second entry, most recent.', '', '## 2026-09-17', '', 'First entry.', ''].join('\n');

function cleanVaultFiles() {
  return {
    'index.md': '',
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

test('SPEC_RULES is a plain array of eight rule objects, each with a stable id, a section string, and a check function', () => {
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

test('every finding carries ruler "spec" explicitly and the full Finding shape, since a finding is identified by the (ruler, id) pair and never by id alone', () => {
  const files = { ...cleanVaultFiles(), 'people/bad.md': 'no frontmatter at all here\n' };
  const findings = findingsFor(files);
  assert.ok(findings.length > 0, 'the fixture must produce at least one real finding for this assertion to mean anything');
  for (const finding of findings) {
    assert.equal(finding.ruler, 'spec');
    assert.deepEqual(Object.keys(finding).sort(), ['file', 'id', 'line', 'message', 'ruler', 'section']);
  }
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

test('type-required flags a note with no frontmatter at all and, separately, one whose frontmatter has no type key, but allows one with a non-empty type', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-frontmatter.md': 'Just prose, no frontmatter.\n',
    'people/no-type-key.md': '---\ndescription: has frontmatter but no type\n---\nBody.\n',
  };
  const findings = findingsFor(files);
  for (const file of ['people/no-frontmatter.md', 'people/no-type-key.md']) {
    const bad = findings.filter((f) => isSpec('type-required')(f) && f.file === file);
    assert.equal(bad.length, 1, `${file} should have exactly one type-required finding`);
    assert.equal(bad[0].line, null);
    assert.match(bad[0].message, /required/);
  }
  assert.deepEqual(findings.filter((f) => f.file === 'people/ana.md'), []);
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
});

test('log-format flags a heading that is not an ISO date, at the line of that heading, but allows a well-formed date heading', () => {
  const files = { ...cleanVaultFiles(), 'memory/log.md': ['## 2026-09-18', '', 'ok', '', '## not a date', '', 'bad', ''].join('\n') };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
  assert.match(findings[0].message, /is not an ISO date/);
});

test('log-format flags dates that run oldest-first instead of most-recent-first, at the line of the entry that breaks the order', () => {
  const files = {
    ...cleanVaultFiles(),
    'memory/log.md': ['## 2026-09-17', '', 'older, listed first', '', '## 2026-09-18', '', 'newer, listed second: wrong', ''].join('\n'),
  };
  const findings = findingsFor(files).filter((f) => isSpec('log-format')(f) && f.file === 'memory/log.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
  assert.match(findings[0].message, /most recent to oldest/);
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
  assert.match(messy[0].message, /is not an ISO date/);
  assert.match(messy[1].message, /most recent to oldest/);
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
    'people/no-status.md': CLEAN_NOTE.replace('status: stable\n', ''),
    'people/unreadable-status.md': CLEAN_NOTE.replace('status: stable', 'status:\n  folded on the next line'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('status-enum')(f) && f.file === 'people/no-status.md'), []);

  const unreadable = findings.filter((f) => isSpec('status-enum')(f) && f.file === 'people/unreadable-status.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

// --- stale-after-format ----------------------------------------------------------

test('stale-after-format accepts a plain date and a datetime with an offset equally, since narrowing to one is a house rule and not a spec rule', () => {
  // This is the case that matters most: the original validator required a
  // plain YYYY-MM-DD date under a [spec] label, while the canonical format
  // accepts a datetime with an offset too, so a vault that followed the
  // specification was failed by a ruler that claimed to speak for it.
  // people/ana.md, in cleanVaultFiles(), already carries the offset form
  // (2026-12-18T00:00:00-03:00) and is asserted clean by the baseline test;
  // this test additionally proves the plain-date form is accepted too.
  const files = {
    ...cleanVaultFiles(),
    'people/date-only.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: 2026-12-18'),
    // Paired right here, not only in the dedicated "flags a value that is
    // neither..." test below: a stub that never reports anything would
    // otherwise satisfy this whole test on the two accepted forms alone.
    'people/bad-format.md': CLEAN_NOTE.replace('stale_after: 2026-12-18T00:00:00-03:00', 'stale_after: not-a-date-at-all'),
  };
  const findings = findingsFor(files);
  assert.deepEqual(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/date-only.md'), []);
  assert.equal(findings.filter((f) => isSpec('stale-after-format')(f) && f.file === 'people/bad-format.md').length, 1);
});

test('stale-after-format flags a value that is neither a plain date nor a datetime with an offset, including a placeholder-looking value, since the spec ruler has no notion of templates', () => {
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
