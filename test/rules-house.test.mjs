// The house ruler: a single vault's own preferences, as opposed to the
// Open Knowledge Format itself (that ruler is src/rules/spec.mjs, the
// sibling this module is built to mirror). Every rule here is data, an
// object with a stable id and a check function, run by one uniform
// runner: never a chain of conditionals, so a future rule is one array
// entry, not one more branch.
//
// House findings carry no `level` and no `section`: those two belong to
// the format's own two conformance tiers (see spec.mjs), and a vault's
// own preference belongs to neither. A finding here is identified by
// `ruler: 'house'` plus its `id`, and nothing else about severity.
//
// This module never calls walkVault: the validate command (a later task)
// walks the vault exactly once and hands both rulers the same `files`
// and `context`, exactly as rules-spec.test.mjs's own header explains.
// These tests build that same shape through the real makeVault fixture
// and a real loadConfig + walkVault pass, since every rule here reads a
// different corner of the config, unlike the spec ruler, which never
// reads config at all.
//
// The reader contract this ruler leans on throughout: null means a key
// is ABSENT; undefined means the key is PRESENT but written in a shape
// src/frontmatter.mjs's regular-expression readers cannot see, and must
// never be reported as missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { walkVault } from '../src/vault.mjs';
import { HOUSE_RULES, runHouseRules, applyTimestampDeviation } from '../src/rules/house.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

// --- test scaffolding --------------------------------------------------------

// Builds the { files, context } pair the real validate command will hand
// to both rulers, from a real, on-disk vault (via makeVault), so config
// validation is exercised for real on every test, not only on the ones
// that need real bytes. `context.readFile` mirrors the ruler contract's
// own normalisation (byte-order mark stripped, carriage returns folded
// into a bare newline).
function rulerArgsFor(root, config) {
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
  return { files, context };
}

function findingsFor({ files = {}, config = {} } = {}) {
  const root = makeVault({ files, config });
  const loaded = loadConfig(root);
  const { files: mdFiles, context } = rulerArgsFor(root, loaded);
  return runHouseRules(mdFiles, context);
}

function isHouse(id) {
  return (f) => f.ruler === 'house' && f.id === id;
}

// A clean note that satisfies every house rule at once, when the config
// below is in force: required fields present and non-empty, no forbidden
// field, an allowed type, an allowed extension field value, a
// file-relative link, an existing link target, no wikilink.
const CLEAN_NOTE = [
  '---',
  'type: person',
  'description: an example person',
  'confidencial: false',
  '---',
  '# Ana',
  '',
  'See [Bruno](../people/bruno.md) for the other example person.',
  '',
].join('\n');

function cleanVaultFiles() {
  return {
    'index.md': '# Welcome\n',
    'people/ana.md': CLEAN_NOTE,
    'people/bruno.md': '---\ntype: person\ndescription: another example person\n---\n# Bruno\n',
  };
}

// A config that turns on every setting this ruler reads, so the clean
// vault above must report nothing from any of them at once.
const STRICT_CONFIG = {
  frontmatter: {
    required: ['description'],
    forbidden: ['timestamp'],
    type_enum: ['person', 'project'],
    extensions: {
      confidencial: { type: 'boolean' },
    },
  },
  validate: {
    link_style: 'file-relative',
    wikilinks: 'forbid',
    require_root_okf_version: false,
    timestamp_deviation: 'forbid',
  },
};

// --- the clean baseline -------------------------------------------------------

test('a vault whose notes satisfy every configured house setting at once produces no findings', () => {
  assert.deepEqual(findingsFor({ files: cleanVaultFiles(), config: STRICT_CONFIG }), []);
});

// The permissive end of the same claim: a vault that configures an empty
// frontmatter.required and link_style: "any" gets nothing at all from
// this ruler for those two settings, even from a note whose links and
// frontmatter would fail every OTHER configuration tried elsewhere in
// this file (a slash-leading link, no description field).
test('a vault with an empty frontmatter.required and link_style: any reports nothing from this ruler for either setting', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [Bruno](/people/bruno.md), no description field here.\n',
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [] }, validate: { link_style: 'any' } };
  const findings = findingsFor({ files, config });
  assert.deepEqual(findings.filter(isHouse('required-fields')), []);
  assert.deepEqual(findings.filter(isHouse('link-style')), []);
});

// --- HOUSE_RULES and runHouseRules: shape and the ruler+id identity -----------

test('HOUSE_RULES is a plain array of nine rule objects, each with a stable id and a check function, and none carries a level or a section', () => {
  assert.ok(Array.isArray(HOUSE_RULES));
  assert.deepEqual(
    HOUSE_RULES.map((rule) => rule.id),
    [
      'required-fields',
      'forbidden-fields',
      'type-enum',
      'extension-fields',
      'link-style',
      'link-target-exists',
      'no-wikilinks',
      'root-okf-version',
      'timestamp-deviation',
    ],
  );
  for (const rule of HOUSE_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.equal(typeof rule.check, 'function');
    assert.equal(rule.level, undefined);
    assert.equal(rule.section, undefined);
  }
});

test('every finding carries ruler "house" explicitly and exactly the house Finding shape, with no level and no section', () => {
  const files = { ...cleanVaultFiles(), 'people/bad.md': '---\ntype: robot\ndescription: x\n---\nBody.\n' };
  const config = { ...STRICT_CONFIG, frontmatter: { ...STRICT_CONFIG.frontmatter, type_enum: ['person'] } };
  const findings = findingsFor({ files, config });
  assert.ok(findings.length > 0, 'the fixture must produce at least one real finding for this assertion to mean anything');
  for (const finding of findings) {
    assert.equal(finding.ruler, 'house');
    assert.deepEqual(Object.keys(finding).sort(), ['file', 'id', 'line', 'message', 'ruler']);
  }
});

// --- required-fields -----------------------------------------------------------

test('required-fields flags a missing field and, separately, one present but empty, but allows the same field non-empty', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/missing.md': '---\ntype: person\n---\nNo description at all.\n',
    'people/empty.md': '---\ntype: person\ndescription:\n---\nDescription present but empty.\n',
  };
  const config = { frontmatter: { required: ['description'], forbidden: [] } };
  const findings = findingsFor({ files, config });

  const missing = findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/missing.md');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /missing/);
  assert.equal(missing[0].line, null);

  const empty = findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/empty.md');
  assert.equal(empty.length, 1);
  assert.match(empty[0].message, /empty/);

  assert.deepEqual(findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/ana.md'), []);
});

test('required-fields treats a present but unreadable field (a block scalar header) as a distinct finding from an absent one, naming PARSER_LIMITS', () => {
  const files = { ...cleanVaultFiles(), 'people/unreadable.md': '---\ntype: person\ndescription: |\n---\nBody.\n' };
  const config = { frontmatter: { required: ['description'], forbidden: [] } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('required-fields')(f) && f.file === 'people/unreadable.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /PARSER_LIMITS/);
  assert.ok(!/missing/.test(findings[0].message), 'an unreadable shape must not be reported as missing');
});

// A required field need not be a plain scalar: `generated` is a mapping in
// the format's own vocabulary, and a house vault may require it too. This
// pins down that classifying presence works across shapes, not only for a
// one-line string field.
test('required-fields recognises a non-empty mapping field as present, and an empty one (present with nothing under it) as empty', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/with-generated.md': '---\ntype: person\ndescription: x\ngenerated: { by: human:ana, at: 2026-09-18T09:30:00Z }\n---\nBody.\n',
    'people/empty-generated.md': '---\ntype: person\ndescription: x\ngenerated:\n---\nBody.\n',
  };
  const config = { frontmatter: { required: ['generated'], forbidden: [] } };
  const findings = findingsFor({ files, config });
  assert.deepEqual(findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/with-generated.md'), []);
  const empty = findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/empty-generated.md');
  assert.equal(empty.length, 1);
  assert.match(empty[0].message, /empty/);
});

test('required-fields does nothing at all when frontmatter.required is empty, but the identical file under a non-empty list is a finding', () => {
  const files = { ...cleanVaultFiles(), 'people/anything.md': '---\ntype: person\n---\nNo description, no problem.\n' };
  const off = { frontmatter: { required: [], forbidden: [] } };
  assert.deepEqual(findingsFor({ files, config: off }).filter((f) => isHouse('required-fields')(f) && f.file === 'people/anything.md'), []);

  const on = { frontmatter: { required: ['description'], forbidden: [] } };
  assert.equal(findingsFor({ files, config: on }).filter((f) => isHouse('required-fields')(f) && f.file === 'people/anything.md').length, 1);
});

test('required-fields exempts index.md and log.md at any depth, even when they lack the required field, but still flags an ordinary file beside them with the same problem', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/index.md': 'a folder index, no frontmatter, no description\n',
    'memory/log.md': '## 2026-09-18\n\nAn entry.\n',
    'people/plain.md': '---\ntype: person\n---\nan ordinary note, no description, and not a reserved name\n',
  };
  const config = { frontmatter: { required: ['description'], forbidden: [] } };
  const findings = findingsFor({ files, config });
  assert.deepEqual(
    findings.filter((f) => isHouse('required-fields')(f) && (f.file === 'people/index.md' || f.file === 'memory/log.md')),
    [],
  );
  assert.equal(
    findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/plain.md').length,
    1,
    'an ordinary file with the exact same missing-field problem must still be flagged, or this exemption test would pass against a stub that flags nothing at all',
  );
});

// --- forbidden-fields -----------------------------------------------------------

test('forbidden-fields flags a present forbidden field, even when it is empty or unreadable, but allows its absence', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/has-it.md': '---\ntype: person\ntimestamp: 2026-09-18\n---\nBody.\n',
    'people/lacks-it.md': '---\ntype: person\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: ['timestamp'] } };
  const findings = findingsFor({ files, config });

  const has = findings.filter((f) => isHouse('forbidden-fields')(f) && f.file === 'people/has-it.md');
  assert.equal(has.length, 1);
  assert.match(has[0].message, /forbidden/);
  assert.equal(has[0].line, 3); // line 1 "---", line 2 "type: person", line 3 "timestamp: ..."

  assert.deepEqual(findings.filter((f) => isHouse('forbidden-fields')(f) && f.file === 'people/lacks-it.md'), []);
});

test('forbidden-fields does nothing at all when frontmatter.forbidden is empty, but the identical file under a non-empty list is a finding', () => {
  const files = { ...cleanVaultFiles(), 'people/has-it.md': '---\ntype: person\ntimestamp: 2026-09-18\n---\nBody.\n' };
  const off = { frontmatter: { required: [], forbidden: [] } };
  assert.deepEqual(findingsFor({ files, config: off }).filter((f) => isHouse('forbidden-fields')(f) && f.file === 'people/has-it.md'), []);

  const on = { frontmatter: { required: [], forbidden: ['timestamp'] } };
  assert.equal(findingsFor({ files, config: on }).filter((f) => isHouse('forbidden-fields')(f) && f.file === 'people/has-it.md').length, 1);
});

// --- type-enum -------------------------------------------------------------------

test('type-enum flags a type outside the configured list, but allows one inside it, and does nothing when the list is null', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/robot.md': '---\ntype: robot\ndescription: x\n---\nBody.\n',
  };
  const strict = { frontmatter: { required: [], forbidden: [], type_enum: ['person', 'project'] } };
  const findings = findingsFor({ files, config: strict });
  const bad = findings.filter((f) => isHouse('type-enum')(f) && f.file === 'people/robot.md');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /robot/);
  assert.deepEqual(findings.filter((f) => isHouse('type-enum')(f) && f.file === 'people/ana.md'), []);

  const permissive = { frontmatter: { required: [], forbidden: [], type_enum: null } };
  assert.deepEqual(findingsFor({ files, config: permissive }).filter(isHouse('type-enum')), []);
});

test('type-enum does not fire when type is absent or blank, since those are the specification ruler\x27s own findings, but does fire, against PARSER_LIMITS, when type is present in an unreadable shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/no-type.md': '---\ndescription: x\n---\nBody.\n',
    'people/blank-type.md': '---\ntype:\ndescription: x\n---\nBody.\n',
    'people/unreadable-type.md': '---\ntype: |\ndescription: x\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], type_enum: ['person'] } };
  const findings = findingsFor({ files, config });
  assert.deepEqual(findings.filter((f) => isHouse('type-enum')(f) && f.file === 'people/no-type.md'), []);
  assert.deepEqual(findings.filter((f) => isHouse('type-enum')(f) && f.file === 'people/blank-type.md'), []);
  const unreadable = findings.filter((f) => isHouse('type-enum')(f) && f.file === 'people/unreadable-type.md');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].message, /PARSER_LIMITS/);
});

// --- extension-fields --------------------------------------------------------------

test('extension-fields flags a boolean field with a non-boolean value, but allows a true or false one, and does nothing when the field is absent', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-bool.md': '---\ntype: person\nconfidencial: yes\n---\nBody.\n',
    'people/good-bool.md': '---\ntype: person\nconfidencial: true\n---\nBody.\n',
    'people/no-field.md': '---\ntype: person\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { confidencial: { type: 'boolean' } } } };
  const findings = findingsFor({ files, config });
  const bad = findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/bad-bool.md');
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /boolean/);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-bool.md'), []);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/no-field.md'), []);
});

test('extension-fields flags a number field with a non-numeric value, but allows a numeric one', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-number.md': '---\ntype: person\nrating: high\n---\nBody.\n',
    'people/good-number.md': '---\ntype: person\nrating: 4.5\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { rating: { type: 'number' } } } };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/bad-number.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-number.md'), []);
});

test('extension-fields flags a date field that is not a calendar-valid ISO date, checking the calendar and not only the shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-date.md': '---\ntype: person\nlido: 2026-02-30\n---\nBody.\n',
    'people/good-date.md': '---\ntype: person\nlido: 2026-09-18\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { lido: { type: 'date' } } } };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/bad-date.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-date.md'), []);
});

test('extension-fields flags an enum field outside its declared values, but allows one inside them', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-enum.md': '---\ntype: person\nvinculo: desconhecido\n---\nBody.\n',
    'people/good-enum.md': '---\ntype: person\nvinculo: equipe\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { vinculo: { type: 'enum', values: ['equipe', 'externo'] } } } };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/bad-enum.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-enum.md'), []);
});

// "fase" is a field name the base config fixture (test/fixtures/config/valid.json)
// never declares, deliberately: that fixture already declares a real
// per-type enum field ("situacao") of its own, and makeVault's deepMerge
// merges an override's nested object onto it key by key rather than
// replacing it outright, so reusing "situacao" here would leave the
// fixture's own "decision" and "project" lists in the merged result and
// mask exactly the "no declared list for this type" case this test
// exists to prove.
test('extension-fields resolves an enum field\x27s per-type values by the note\x27s own type, and skips the check when that type has no declared list', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/wrong-for-type.md': '---\ntype: person\nfase: arquivado\n---\nBody.\n',
    'people/right-for-type.md': '---\ntype: person\nfase: ativo\n---\nBody.\n',
    'decisions/no-list-for-type.md': '---\ntype: decision\nfase: whatever-goes\n---\nBody.\n',
  };
  const config = {
    frontmatter: {
      required: [],
      forbidden: [],
      extensions: { fase: { type: 'enum', values_by_type: { person: ['ativo', 'inativo'] } } },
    },
  };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/wrong-for-type.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/right-for-type.md'), []);
  assert.deepEqual(
    findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'decisions/no-list-for-type.md'),
    [],
    'a type with no declared list for this field has nothing to check against, so nothing is flagged',
  );
});

test('extension-fields reports a present but unreadable field against PARSER_LIMITS rather than checking its kind', () => {
  const files = { ...cleanVaultFiles(), 'people/unreadable.md': '---\ntype: person\nconfidencial: |\n---\nBody.\n' };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { confidencial: { type: 'boolean' } } } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('extension-fields')(f) && f.file === 'people/unreadable.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /PARSER_LIMITS/);
});

// --- the placeholder exemption: templates_dir only, and only there ---------------

test('the placeholder exemption excuses an unparseable dated value under taxonomy.templates_dir, but the identical value elsewhere is a finding', () => {
  const files = {
    ...cleanVaultFiles(),
    'templates/template-person.md': '---\ntype: person\nlido: <preencher>\n---\nPlaceholder template.\n',
    'people/leaked-placeholder.md': '---\ntype: person\nlido: <preencher>\n---\nA real note that forgot to fill this in.\n',
  };
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { lido: { type: 'date' } } },
    validate: { placeholder_pattern: '<[^>]+>' },
  };
  const findings = findingsFor({ files, config });
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'templates/template-person.md'), []);
  const leaked = findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/leaked-placeholder.md');
  assert.equal(leaked.length, 1, 'a note elsewhere with an angle bracket in a dated field is a finding');
});

test('the placeholder exemption never fires without validate.placeholder_pattern configured, even under templates_dir', () => {
  const files = { ...cleanVaultFiles(), 'templates/template-person.md': '---\ntype: person\nlido: <preencher>\n---\nPlaceholder template.\n' };
  // The base config fixture sets its own placeholder_pattern; an explicit
  // `undefined` here overrides makeVault's deepMerge with a key that
  // JSON.stringify then drops entirely, which is the only way to test
  // this rule's own default (no pattern at all) against a fixture that
  // otherwise always configures one.
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { lido: { type: 'date' } } },
    validate: { placeholder_pattern: undefined },
  };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('extension-fields')(f) && f.file === 'templates/template-person.md');
  assert.equal(findings.length, 1);
});

// --- link-style ---------------------------------------------------------------------

test('link-style flags a slash-leading link under file-relative, but allows a relative one, and does nothing under "any"', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [Bruno](/people/bruno.md) and also [normal link](bruno.md).\n',
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
  };
  const strict = { validate: { link_style: 'file-relative' } };
  const findings = findingsFor({ files, config: strict }).filter((f) => isHouse('link-style')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /slash/);
  assert.match(findings[0].message, /host/);

  const permissive = { validate: { link_style: 'any' } };
  assert.deepEqual(findingsFor({ files, config: permissive }).filter(isHouse('link-style')), []);
});

test('link-style flags a relative link under bundle-absolute, but allows a slash-leading one', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [Bruno](bruno.md) and also [absolute](/people/bruno.md).\n',
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
  };
  const config = { validate: { link_style: 'bundle-absolute' } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('link-style')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /bundle-absolute/);
});

test('link-style ignores an external link and a same-page fragment link either way, but still flags a real slash-leading link right beside them', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [site](https://example.com/x), [section](#see-also), and [bad](/people/ghost.md).\n',
  };
  const config = { validate: { link_style: 'file-relative' } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('link-style')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the slash-leading link should be flagged, not the external or fragment one');
  assert.match(findings[0].message, /ghost\.md/);
});

// --- link-target-exists (always on) ----------------------------------------------

test('link-target-exists flags a link to a file that does not exist, but allows one to a real markdown file or a real attachment, resolved relative to the linking file', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [
      '---',
      'type: person',
      '---',
      'See [Bruno](bruno.md), a [scan](../attachments/scan.png), and a [ghost](nobody.md).',
    ].join('\n'),
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
    'attachments/scan.png': 'not really a png, just fixture bytes',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /nobody\.md/);
});

test('link-target-exists resolves a slash-leading link against the vault root, never flags an external or fragment-only link, but still flags a slash-leading ghost right beside them', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [
      '---',
      'type: person',
      '---',
      'See [Bruno](/people/bruno.md), [site](https://example.com), [section](#top), and [ghost](/people/nobody.md).',
    ].join('\n'),
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the slash-leading ghost should be flagged');
  assert.match(findings[0].message, /nobody\.md/);
});

test('link-target-exists is on even when the vault configures nothing at all', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[ghost](nowhere.md)\n' };
  const findings = findingsFor({ files }).filter(isHouse('link-target-exists'));
  assert.equal(findings.length, 1);
});

// --- code exclusion: fenced (backtick and tilde, including malformed) and inline ---

test('a link-shaped example inside a fenced code block is never read as a real link, whether the fence is backtick or tilde, longer than three characters, or never closed', () => {
  const bodies = {
    'a three-backtick fence': ['```', '[ghost](nowhere.md)', '```', ''].join('\n'),
    'a four-backtick fence': ['````', '[ghost](nowhere.md)', '````', ''].join('\n'),
    'a tilde fence': ['~~~', '[ghost](nowhere.md)', '~~~', ''].join('\n'),
    'a fence that is never closed': ['```', '[ghost](nowhere.md)', 'still fenced, no closing line'].join('\n'),
  };
  for (const [label, fenced] of Object.entries(bodies)) {
    const files = { 'index.md': '# Welcome\n', 'people/ana.md': `---\ntype: person\n---\n${fenced}` };
    const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
    assert.deepEqual(findings, [], `${label} must not be read as a real link`);
  }
  // the almost-identical shape that IS a real, broken link, right after the
  // fence closes, must still be caught: proof the exclusion is not simply
  // silencing this rule for the whole file.
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['---', 'type: person', '---', '```', '[ghost](nowhere.md)', '```', '[real-ghost](nowhere-real.md)', ''].join('\n'),
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /nowhere-real\.md/);
});

test('a link-shaped example inside inline code is never read as a real link, but the same target outside a backtick span is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nWrite it like `[ghost](nowhere.md)` in prose, or for real as [ghost](nowhere.md).\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
});

// --- no-wikilinks ------------------------------------------------------------------

test('no-wikilinks flags a double-bracket link when forbidden, but allows it when allowed, and a wikilink inside a fence is never flagged either way', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['---', 'type: person', '---', 'See [[Bruno]] for more.', '', '```', '[[example]]', '```', ''].join('\n'),
  };
  const forbid = { validate: { wikilinks: 'forbid' } };
  const findings = findingsFor({ files, config: forbid }).filter((f) => isHouse('no-wikilinks')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Bruno/);

  const allow = { validate: { wikilinks: 'allow' } };
  assert.deepEqual(findingsFor({ files, config: allow }).filter(isHouse('no-wikilinks')), []);
});

test('no-wikilinks does nothing when validate.wikilinks is not configured at all, but the identical file under "forbid" is a finding', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[[Bruno]]\n' };
  // The base config fixture sets its own wikilinks: "forbid"; an explicit
  // `undefined` here clears it through makeVault's deepMerge (dropped by
  // JSON.stringify), which is the only way to test this rule's own
  // default against a fixture that otherwise always configures a value.
  const unconfigured = { validate: { wikilinks: undefined } };
  assert.deepEqual(findingsFor({ files, config: unconfigured }).filter(isHouse('no-wikilinks')), []);

  const forbidden = { validate: { wikilinks: 'forbid' } };
  assert.equal(findingsFor({ files, config: forbidden }).filter(isHouse('no-wikilinks')).length, 1);
});

// --- root-okf-version ---------------------------------------------------------------

test('root-okf-version flags a root index with no okf_version, and one with the wrong okf_version, but allows the matching one, only when required', () => {
  const missing = { 'index.md': '# Welcome, no okf_version at all\n' };
  const wrong = { 'index.md': '---\nokf_version: "0.1"\n---\n# Welcome\n' };
  const right = { 'index.md': '---\nokf_version: "0.2"\n---\n# Welcome\n' };
  const config = { okf_version: '0.2', validate: { require_root_okf_version: true } };

  const missingFindings = findingsFor({ files: missing, config }).filter(isHouse('root-okf-version'));
  assert.equal(missingFindings.length, 1);
  assert.match(missingFindings[0].message, /does not declare/);

  const wrongFindings = findingsFor({ files: wrong, config }).filter(isHouse('root-okf-version'));
  assert.equal(wrongFindings.length, 1);
  assert.match(wrongFindings[0].message, /0\.1/);

  assert.deepEqual(findingsFor({ files: right, config }).filter(isHouse('root-okf-version')), []);
});

test('root-okf-version does nothing at all when not required, even for a root index with no okf_version, but the identical index is a finding once required', () => {
  const files = { 'index.md': '# Welcome, no okf_version at all\n' };
  const off = { validate: { require_root_okf_version: false } };
  assert.deepEqual(findingsFor({ files, config: off }).filter(isHouse('root-okf-version')), []);

  const on = { validate: { require_root_okf_version: true } };
  assert.equal(findingsFor({ files, config: on }).filter(isHouse('root-okf-version')).length, 1);
});

// --- timestamp-deviation: the rule itself is inert; applyTimestampDeviation is not ---

test('the timestamp-deviation rule never produces a house finding of its own, whatever the setting says, since it has no file content to check', () => {
  const files = { 'index.md': '# Welcome\n' };
  const forbid = findingsFor({ files, config: { validate: { timestamp_deviation: 'forbid' } } });
  const allow = findingsFor({ files, config: { validate: { timestamp_deviation: 'allow' } } });
  assert.deepEqual(forbid.filter(isHouse('timestamp-deviation')), []);
  assert.deepEqual(allow.filter(isHouse('timestamp-deviation')), []);
});

test('applyTimestampDeviation downgrades a should-level timestamp finding to a warning when the vault declares "allow", but leaves it untouched by default ("forbid")', () => {
  const shouldFinding = { ruler: 'spec', id: 'stale-after-format', section: '5.5', level: 'should', file: 'people/ana.md', line: 6, message: 'stale_after is a plain date' };

  const allowed = applyTimestampDeviation([shouldFinding], { validate: { timestamp_deviation: 'allow' } });
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].warning, true);
  assert.equal(allowed[0].level, 'should', 'the original tier is preserved; only a warning flag is added');

  const forbidden = applyTimestampDeviation([shouldFinding], { validate: { timestamp_deviation: 'forbid' } });
  assert.deepEqual(forbidden, [shouldFinding]);

  const defaulted = applyTimestampDeviation([shouldFinding], {});
  assert.deepEqual(defaulted, [shouldFinding], 'an unconfigured vault gets the format\x27s own answer: forbid');
});

test('applyTimestampDeviation never touches a must-level finding or a should-level finding under a different id, even while it downgrades the one eligible finding in the same batch', () => {
  const mustFinding = { ruler: 'spec', id: 'type-required', section: '4.1', level: 'must', file: 'people/ana.md', line: null, message: 'type is required but missing' };
  const otherShould = { ruler: 'spec', id: 'sources-resource', section: '5.1', level: 'should', file: 'people/ana.md', line: 8, message: 'sources[0] is missing a resource' };
  const eligible = { ruler: 'spec', id: 'generated-actor', section: '5.2', level: 'should', file: 'people/ana.md', line: 4, message: 'generated.at is not an ISO 8601 datetime' };

  const result = applyTimestampDeviation([mustFinding, otherShould, eligible], { validate: { timestamp_deviation: 'allow' } });
  assert.deepEqual(result[0], mustFinding);
  assert.deepEqual(result[1], otherShould);
  assert.equal(result[2].warning, true, 'the one eligible finding in the batch must still be downgraded, or this "leaves the others alone" test would pass against a stub that changes nothing at all');
});

// --- a rule must never throw: malformed, truncated, empty and binary-ish files -----

test('a rule never throws on malformed input: empty, only the opening delimiter, or a frontmatter block that is never closed, and still reports each as a required-fields finding rather than as an exception or as silence', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/empty.md': '',
    'people/only-open.md': '---\n',
    'people/unterminated.md': '---\ntype: note\ndescription: this frontmatter block is never closed\n',
  };
  const config = { frontmatter: { required: ['description'], forbidden: [], extensions: { confidencial: { type: 'boolean' } } } };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor({ files, config });
  });
  for (const file of ['people/empty.md', 'people/only-open.md', 'people/unterminated.md']) {
    assert.equal(
      findings.filter((f) => isHouse('required-fields')(f) && f.file === file).length,
      1,
      `${file} should still produce exactly one required-fields finding`,
    );
  }
});

test('a rule never throws on binary-ish content, or on a malformed validate.placeholder_pattern that is not a valid regular expression, and still reports the missing extension field rather than silently passing', () => {
  const binaryish = String.fromCharCode(0, 1, 2, 255, 254) + 'not really frontmatter' + String.fromCharCode(7);
  const files = { ...cleanVaultFiles(), 'people/binary.md': binaryish, 'people/has-bad-bool.md': '---\ntype: person\nconfidencial: yes\n---\nBody.\n' };
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { confidencial: { type: 'boolean' } } },
    validate: { placeholder_pattern: '(unclosed' },
  };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor({ files, config });
  });
  assert.equal(
    findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/has-bad-bool.md').length,
    1,
    'a malformed placeholder pattern must not silently grant an exemption it cannot evaluate',
  );
});
