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
// `ruler: 'house'` plus its `id` and, since fix round 1, its `check`:
// the specific assertion inside the rule, since one id is not always
// fine enough (extension-fields' value-kind and enum-value checks, for
// instance, share an id but mean two different things).
//
// This module never calls walkVault: the validate command (a later
// task) walks the vault exactly once and hands both rulers the same
// `files` and `context`. These tests build that same shape through the
// real makeVault fixture and a real loadConfig + walkVault pass, since
// every rule here reads a different corner of the config, unlike the
// spec ruler, which never reads config at all.
//
// The reader contract this ruler leans on throughout: null means a key
// is ABSENT; undefined means the key is PRESENT but written in a shape
// src/frontmatter.mjs's regular-expression readers cannot see, and must
// never be reported as missing.
//
// Example data: the fictional owner Ana, example.com, and the actors
// human:ana and brain-kit-curator/claude-opus-5, per this project's own
// standing rule. Fix round 1 also corrected two of this file's OWN
// leaks: a Portuguese placeholder value and a Portuguese extension
// field name, both replaced with English ones that mean the same thing
// for these tests' purposes (they are just field names the tests
// declare and read back, not values with meaning drawn from any other
// fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { walkVault } from '../src/vault.mjs';
import { HOUSE_RULES, runHouseRules, applyTimestampDeviation } from '../src/rules/house.mjs';
import { runSpecRules } from '../src/rules/spec.mjs';
import { createTranslator } from '../src/lang.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

// A finding carries a message KEY and PARAMS, never a formed sentence
// (see src/rules/house.mjs's own header): the pack is rendered here,
// once, for every test below that used to read finding.message
// directly, so this file keeps asserting on rendered English text
// without the rule modules ever building that text themselves. `en` is
// this file's own fixed rendering language, independent of whatever
// language a given test's vault happens to declare.
const englishFor = createTranslator('en');
function renderedMessage(finding) {
  return englishFor(finding.messageKey, finding.params ?? {});
}

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

function isHouseCheck(id, check) {
  return (f) => f.ruler === 'house' && f.id === id && f.check === check;
}

// A clean note that satisfies every house rule at once, when the config
// below is in force: required fields present and non-empty, no forbidden
// field, an allowed type, an allowed extension field value, a
// file-relative link, an existing link target, no wikilink.
const CLEAN_NOTE = [
  '---',
  'type: person',
  'description: an example person',
  'confidential: false',
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
      confidential: { type: 'boolean' },
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

// Pinned literally, not only verified by hand (review finding 12 of the
// previous round): a vault that configures NOTHING at all still gets
// link-target-exists (the one rule that is on by DEFAULT rather than
// off) and nothing else,
// even from a note that would fail every other rule in this file if any
// of them were on.
// Pinned literally against context.config being {} OR undefined
// directly, not through makeVault's own base-fixture deep merge (which
// itself configures several of these settings, so passing an override
// object through it is never actually "nothing configured"). Bytes
// still come from a real vault on disk; only the config object handed
// to runHouseRules is replaced.
test('a vault whose config is {} or undefined reports only link-target-exists, whichever is passed', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: robot\n---\nSee [[Bruno]] and [ghost](/nowhere.md), <fill-in-not-used-here>.\n',
  };
  const root = makeVault({ files });
  for (const config of [{}, undefined]) {
    const { files: mdFiles, context } = rulerArgsFor(root, config);
    const findings = runHouseRules(mdFiles, context);
    assert.deepEqual(findings.map((f) => f.id), ['link-target-exists']);
  }
});

// --- HOUSE_RULES and runHouseRules: shape and the ruler+id+check identity ----

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

test('every finding carries ruler "house" explicitly, a non-empty check, and exactly the house Finding shape, with no level and no section', () => {
  const files = { ...cleanVaultFiles(), 'people/bad.md': '---\ntype: robot\ndescription: x\n---\nBody.\n' };
  const config = { ...STRICT_CONFIG, frontmatter: { ...STRICT_CONFIG.frontmatter, type_enum: ['person'] } };
  const findings = findingsFor({ files, config });
  assert.ok(findings.length > 0, 'the fixture must produce at least one real finding for this assertion to mean anything');
  for (const finding of findings) {
    assert.equal(finding.ruler, 'house');
    assert.deepEqual(Object.keys(finding).sort(), ['absence', 'check', 'file', 'id', 'line', 'messageKey', 'params', 'ruler', 'unreadable']);
    assert.equal(typeof finding.check, 'string');
    assert.ok(finding.check.length > 0);
    // Always present, never sometimes: a consumer must never have to
    // tell `false` apart from "this ruler forgot to set it".
    assert.equal(typeof finding.absence, 'boolean');
    assert.equal(typeof finding.unreadable, 'boolean');
  }
});

// extension-fields' value-kind and enum-value checks share the rule id,
// exactly the shape that made applyTimestampDeviation's old id-only
// selector unsafe on the spec side: `check` must tell them apart even
// though `id` does not.
test('check is unique within a rule that emits more than one, so a downstream consumer can select one specific assertion without reaching the others', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-kind-and-enum.md': '---\ntype: person\ndescription: x\nconfidential: maybe\naffinity: nobody\n---\nBody.\n',
  };
  const config = {
    frontmatter: {
      required: [],
      forbidden: [],
      extensions: {
        confidential: { type: 'boolean' },
        affinity: { type: 'enum', values: ['team', 'external'] },
      },
    },
  };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('extension-fields')(f) && f.file === 'people/bad-kind-and-enum.md');
  assert.deepEqual(findings.map((f) => f.check).sort(), ['enum-value', 'value-kind']);
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

  const missing = findings.filter((f) => isHouseCheck('required-fields', 'field-present')(f) && f.file === 'people/missing.md');
  assert.equal(missing.length, 1);
  assert.match(renderedMessage(missing[0]), /missing/);
  assert.equal(missing[0].line, null);

  const empty = findings.filter((f) => isHouseCheck('required-fields', 'field-non-empty')(f) && f.file === 'people/empty.md');
  assert.equal(empty.length, 1);
  assert.match(renderedMessage(empty[0]), /empty/);

  assert.deepEqual(findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/ana.md'), []);
});

test('required-fields treats a present but unreadable field (a block scalar header) as a distinct finding from an absent one, naming PARSER_LIMITS', () => {
  const files = { ...cleanVaultFiles(), 'people/unreadable.md': '---\ntype: person\ndescription: |\n---\nBody.\n' };
  const config = { frontmatter: { required: ['description'], forbidden: [] } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('required-fields')(f) && f.file === 'people/unreadable.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'shape-readable');
  assert.match(renderedMessage(findings[0]), /PARSER_LIMITS/);
  assert.ok(!/missing/.test(renderedMessage(findings[0])), 'an unreadable shape must not be reported as missing');
});

// The two flags, at every house build site that sets one. They exist
// for the same reason the spec ruler's do: a finding's own claim about
// itself must be a FIELD set where the finding is built, never
// something a later step infers from the sentence it happens to render.
// No house finding can reach applyTimestampDeviation today, so nothing
// here is load-bearing for that invariant; the flags are still a claim
// this ruler makes in its output, and a claim no test reads is a claim
// that drifts. Verified by mutation: dropping the flag from any one of
// these three build sites used to fail nothing at all.
test('the absence and unreadable flags on a house finding say what that finding actually claims, at every site that sets one', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/missing.md': '---\ntype: person\n---\nNo description at all.\n',
    'people/empty.md': '---\ntype: person\ndescription:\n---\nDescription present but empty.\n',
    'people/unreadable.md': '---\ntype: person\ndescription: |\n---\nBody.\n',
    'people/forbidden.md': '---\ntype: person\ndescription: x\ntimestamp: 2026-09-18T09:30:00Z\n---\nBody.\n',
    'people/bad-type.md': '---\ntype: robot\ndescription: x\n---\nBody.\n',
  };
  const config = {
    okf_version: '0.2',
    frontmatter: { required: ['description'], forbidden: ['timestamp'], type_enum: ['person'] },
    validate: { require_root_okf_version: true },
  };
  const findings = findingsFor({ files, config });
  const one = (id, check, file) => {
    const matched = findings.filter((f) => isHouseCheck(id, check)(f) && (file === undefined || f.file === file));
    assert.equal(matched.length, 1, `expected exactly one ${id}/${check} finding${file ? ` on ${file}` : ''}`);
    return matched[0];
  };

  const absences = [
    one('required-fields', 'field-present', 'people/missing.md'),
    one('required-fields', 'field-non-empty', 'people/empty.md'),
    one('root-okf-version', 'declared'),
  ];
  for (const finding of absences) {
    assert.equal(finding.absence, true, `${finding.id}/${finding.check} reports something that is not there`);
    assert.equal(finding.unreadable, false);
  }

  const unreadable = one('required-fields', 'shape-readable', 'people/unreadable.md');
  assert.equal(unreadable.unreadable, true);
  assert.equal(unreadable.absence, false, 'a field whose shape could not be read is not a field that is missing: that is the whole two-absences contract');

  // The paired negatives, in the same run, so this cannot pass against a
  // stub that flags everything: a forbidden field that IS present, and a
  // type that is present and simply not allowed, claim neither.
  for (const finding of [one('forbidden-fields', 'field-forbidden', 'people/forbidden.md'), one('type-enum', 'type-allowed', 'people/bad-type.md')]) {
    assert.equal(finding.absence, false, `${finding.id}/${finding.check} is about something present`);
    assert.equal(finding.unreadable, false);
  }
});

// The other three sites in this ruler that raise a could-not-read
// finding. They need their own vault because the root index can carry
// an unreadable okf_version or none at all, never both at once.
test('the unreadable flag is set at every remaining house site that raises a could-not-read finding, and never claims an absence alongside it', () => {
  const files = {
    'index.md': '---\nokf_version: |\n---\n# Welcome\n',
    'people/unreadable.md': '---\ntype: >\ndescription: an example person\nconfidential: |\n---\nBody.\n',
  };
  const config = {
    okf_version: '0.2',
    frontmatter: { required: ['description'], forbidden: [], type_enum: ['person'], extensions: { confidential: { type: 'boolean' } } },
    validate: { require_root_okf_version: true },
  };
  const findings = findingsFor({ files, config });
  const pairs = [...new Set(findings.filter((f) => f.unreadable).map((f) => `${f.id}/${f.check}`))].sort();
  assert.deepEqual(pairs, ['extension-fields/shape-readable', 'root-okf-version/shape-readable', 'type-enum/shape-readable']);
  for (const finding of findings.filter((f) => f.unreadable)) {
    assert.equal(finding.absence, false, 'a shape this reader cannot see is not a field that is missing');
  }
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
  assert.match(renderedMessage(empty[0]), /empty/);
});

// Fix round 1, finding 6: an INLINE empty collection ("tags: []",
// "tags: {}") used to read back from readScalar as the non-blank string
// "[]" or "{}" and was never handed to the collection-aware readers that
// would have answered correctly, so a required field left empty this
// way was reported as fine. Paired against a non-empty inline list,
// which must still pass, and the already-correct block-empty case,
// which must not regress.
test('required-fields treats an explicitly empty inline list or mapping as empty, not as a non-empty value, but still allows a non-empty inline list', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/empty-inline-list.md': '---\ntype: person\ntags: []\n---\nBody.\n',
    'people/empty-inline-mapping.md': '---\ntype: person\ntags: {}\n---\nBody.\n',
    'people/nonempty-inline-list.md': '---\ntype: person\ntags: [a, b]\n---\nBody.\n',
  };
  const config = { frontmatter: { required: ['tags'], forbidden: [] } };
  const findings = findingsFor({ files, config });

  for (const file of ['people/empty-inline-list.md', 'people/empty-inline-mapping.md']) {
    const bad = findings.filter((f) => isHouseCheck('required-fields', 'field-non-empty')(f) && f.file === file);
    assert.equal(bad.length, 1, `${file} should be reported empty`);
  }
  assert.deepEqual(findings.filter((f) => isHouse('required-fields')(f) && f.file === 'people/nonempty-inline-list.md'), []);
});

// Fix round 2, a side effect of the round-1 fix above: a QUOTED string
// that merely looks like a collection once its quotes are gone (a tags
// value written as a quoted pair of brackets) used to be reported
// against PARSER_LIMITS as unreadable, even though readScalar reads it
// perfectly well as an ordinary string. Paired against the real,
// unquoted empty collection right beside it, which must still be
// reported empty.
test('required-fields reads a quoted string that merely looks like a collection as an ordinary, non-empty value, not as unreadable, but still reports a real empty collection as empty', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/quoted-brackets.md': '---\ntype: person\ntags: "[a, b]"\n---\nBody.\n',
    'people/quoted-braces.md': '---\ntype: person\ntags: "{a: 1}"\n---\nBody.\n',
    'people/real-empty-list.md': '---\ntype: person\ntags: []\n---\nBody.\n',
  };
  const config = { frontmatter: { required: ['tags'], forbidden: [] } };
  const findings = findingsFor({ files, config });

  for (const file of ['people/quoted-brackets.md', 'people/quoted-braces.md']) {
    assert.deepEqual(
      findings.filter((f) => isHouse('required-fields')(f) && f.file === file),
      [],
      `${file}: a quoted string that merely looks like a collection reads fine and must not be reported at all`,
    );
  }
  assert.equal(findings.filter((f) => isHouseCheck('required-fields', 'field-non-empty')(f) && f.file === 'people/real-empty-list.md').length, 1);
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

  const has = findings.filter((f) => isHouseCheck('forbidden-fields', 'field-forbidden')(f) && f.file === 'people/has-it.md');
  assert.equal(has.length, 1);
  assert.match(renderedMessage(has[0]), /forbidden/);
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

test('forbidden-fields flags a field named with a regular-expression metacharacter without throwing, and still reports the real line', () => {
  const files = { ...cleanVaultFiles(), 'people/has-paren-field.md': '---\ntype: person\n"a(b": v\n---\nBody.\n' };
  const config = { frontmatter: { required: [], forbidden: ['a(b'] } };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor({ files, config });
  });
  const bad = findings.filter((f) => isHouse('forbidden-fields')(f) && f.file === 'people/has-paren-field.md');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 3);
});

// --- type-enum -------------------------------------------------------------------

test('type-enum flags a type outside the configured list, but allows one inside it, and does nothing when the list is null', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/robot.md': '---\ntype: robot\ndescription: x\n---\nBody.\n',
  };
  const strict = { frontmatter: { required: [], forbidden: [], type_enum: ['person', 'project'] } };
  const findings = findingsFor({ files, config: strict });
  const bad = findings.filter((f) => isHouseCheck('type-enum', 'type-allowed')(f) && f.file === 'people/robot.md');
  assert.equal(bad.length, 1);
  assert.match(renderedMessage(bad[0]), /robot/);
  // The allowed list is passed through as the raw array it already
  // is: how a list reads on screen (the ", " separator) is
  // interpolate()'s own decision now (src/lang.mjs), not this rule's,
  // so the rule's own param is pinned as the array, and the rendered
  // separator is pinned separately rather than left to a substring
  // match that would pass just the same whether the list rendered as
  // "person, project" or some other separator entirely.
  assert.deepEqual(bad[0].params.allowed, ['person', 'project']);
  assert.match(renderedMessage(bad[0]), /person, project/);
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
  const unreadable = findings.filter((f) => isHouseCheck('type-enum', 'shape-readable')(f) && f.file === 'people/unreadable-type.md');
  assert.equal(unreadable.length, 1);
  assert.match(renderedMessage(unreadable[0]), /PARSER_LIMITS/);
});

// --- extension-fields --------------------------------------------------------------

test('extension-fields flags a boolean field with a non-boolean value, but allows a true or false one, and does nothing when the field is absent', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-bool.md': '---\ntype: person\nconfidential: yes\n---\nBody.\n',
    'people/good-bool.md': '---\ntype: person\nconfidential: true\n---\nBody.\n',
    'people/no-field.md': '---\ntype: person\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { confidential: { type: 'boolean' } } } };
  const findings = findingsFor({ files, config });
  const bad = findings.filter((f) => isHouseCheck('extension-fields', 'value-kind')(f) && f.file === 'people/bad-bool.md');
  assert.equal(bad.length, 1);
  assert.match(renderedMessage(bad[0]), /boolean/);
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
  assert.equal(findings.filter((f) => isHouseCheck('extension-fields', 'value-kind')(f) && f.file === 'people/bad-number.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-number.md'), []);
});

test('extension-fields flags a date field that is not a calendar-valid ISO date, checking the calendar and not only the shape', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-date.md': '---\ntype: person\nlast_read: 2026-02-30\n---\nBody.\n',
    'people/good-date.md': '---\ntype: person\nlast_read: 2026-09-18\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { last_read: { type: 'date' } } } };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouseCheck('extension-fields', 'value-kind')(f) && f.file === 'people/bad-date.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-date.md'), []);
});

// The century and four-century leap rule, on the HOUSE side. The
// specification ruler had this test and the house ruler did not, while
// both files carried their own complete, independently written
// calendar: breaking the spec ruler's leap rule failed a named test,
// breaking this one failed nothing at all and accepted a day that never
// existed. Both now come from src/dates.mjs, and this is the test that
// notices if the house side ever grows its own copy again.
test('extension-fields still gets the century and four-century leap-year cases right: 1900-02-29 never existed, 2000-02-29 did', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/century.md': '---\ntype: person\nlast_read: 1900-02-29\n---\nBody.\n',
    'people/four-century.md': '---\ntype: person\nlast_read: 2000-02-29\n---\nBody.\n',
    'people/ordinary-leap.md': '---\ntype: person\nlast_read: 2024-02-29\n---\nBody.\n',
    'people/ordinary-common.md': '---\ntype: person\nlast_read: 2023-02-29\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { last_read: { type: 'date' } } } };
  const findings = findingsFor({ files, config }).filter(isHouse('extension-fields'));
  assert.deepEqual(
    findings.map((f) => f.file).sort(),
    ['people/century.md', 'people/ordinary-common.md'],
    '1900 is not a leap year and 2023 is not; 2000 and 2024 are',
  );
});

test('extension-fields flags an enum field outside its declared values, but allows one inside them', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/bad-enum.md': '---\ntype: person\naffinity: unknown-value\n---\nBody.\n',
    'people/good-enum.md': '---\ntype: person\naffinity: team\n---\nBody.\n',
  };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { affinity: { type: 'enum', values: ['team', 'external'] } } } };
  const findings = findingsFor({ files, config });
  const bad = findings.filter((f) => isHouseCheck('extension-fields', 'enum-value')(f) && f.file === 'people/bad-enum.md');
  assert.equal(bad.length, 1);
  // Same array-typed param, same rule as type-enum's own
  // (frontmatter.type_enum), pinned down here too rather than left to
  // a substring match.
  assert.deepEqual(bad[0].params.allowed, ['team', 'external']);
  assert.match(renderedMessage(bad[0]), /team, external/);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/good-enum.md'), []);
});

test('extension-fields resolves an enum field\x27s per-type values by the note\x27s own type, and skips the check when that type has no declared list', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/wrong-for-type.md': '---\ntype: person\nstage: archived\n---\nBody.\n',
    'people/right-for-type.md': '---\ntype: person\nstage: active\n---\nBody.\n',
    'decisions/no-list-for-type.md': '---\ntype: decision\nstage: whatever-goes\n---\nBody.\n',
  };
  // The shared base fixture (test/fixtures/config/valid.json) happens to
  // declare its own "stage" extension field, with its own values_by_type
  // for "decision" and "project" (it needs one, for its own purpose: an
  // English-generic example of exactly this feature). makeVault's
  // deepMerge is per-key recursive, so this test's own values_by_type
  // would otherwise be merged ONTO the fixture's, not replace it, and
  // "decisions/no-list-for-type.md" would incidentally inherit a real
  // declared list for "decision" from the fixture rather than exercising
  // the "no declared list for this type" branch this test is named for.
  // Explicit `undefined` clears an inherited key (JSON.stringify drops
  // it), the same device several tests below use for
  // validate.placeholder_pattern and validate.wikilinks, so this test
  // states its own config completely rather than depending on whatever
  // the shared fixture happens to declare for "stage" today.
  const config = {
    frontmatter: {
      required: [],
      forbidden: [],
      extensions: { stage: { type: 'enum', values_by_type: { person: ['active', 'inactive'], decision: undefined, project: undefined } } },
    },
  };
  const findings = findingsFor({ files, config });
  assert.equal(findings.filter((f) => isHouseCheck('extension-fields', 'enum-value')(f) && f.file === 'people/wrong-for-type.md').length, 1);
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/right-for-type.md'), []);
  assert.deepEqual(
    findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'decisions/no-list-for-type.md'),
    [],
    'a type with no declared list for this field has nothing to check against, so nothing is flagged',
  );
});

test('extension-fields reports a present but unreadable field against PARSER_LIMITS rather than checking its kind', () => {
  const files = { ...cleanVaultFiles(), 'people/unreadable.md': '---\ntype: person\nconfidential: |\n---\nBody.\n' };
  const config = { frontmatter: { required: [], forbidden: [], extensions: { confidential: { type: 'boolean' } } } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('extension-fields')(f) && f.file === 'people/unreadable.md');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'shape-readable');
  assert.match(renderedMessage(findings[0]), /PARSER_LIMITS/);
});

// --- the placeholder exemption: templates_dir only, and only there ---------------

test('the placeholder exemption excuses an unparseable dated value under taxonomy.templates_dir, but the identical value elsewhere is a finding', () => {
  const files = {
    ...cleanVaultFiles(),
    'templates/template-person.md': '---\ntype: person\nlast_read: <fill-in>\n---\nPlaceholder template.\n',
    'people/leaked-placeholder.md': '---\ntype: person\nlast_read: <fill-in>\n---\nA real note that forgot to fill this in.\n',
  };
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { last_read: { type: 'date' } } },
    validate: { placeholder_pattern: '<[^>]+>' },
  };
  const findings = findingsFor({ files, config });
  assert.deepEqual(findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'templates/template-person.md'), []);
  const leaked = findings.filter((f) => isHouse('extension-fields')(f) && f.file === 'people/leaked-placeholder.md');
  assert.equal(leaked.length, 1, 'a note elsewhere with an angle bracket in a dated field is a finding');
});

// A path BOUNDARY, not a raw string prefix, and this side of it had no
// test. src/vault.mjs's own copy of this logic has one ("'logs' ignores
// logs/ but keeps logs-2024/"); the copy that used to live in
// src/rules/house.mjs did not, so degrading it to a raw startsWith
// failed nothing and handed the placeholder exemption to any directory
// merely NAMED like the templates directory. Both now call
// vault.isUnderPath.
test('the placeholder exemption matches a path boundary, not a string prefix: a directory merely named like templates_dir gets no exemption', () => {
  const files = {
    ...cleanVaultFiles(),
    'templates/template-person.md': '---\ntype: person\nlast_read: <fill-in>\n---\nPlaceholder template.\n',
    'templates-old/template-person.md': '---\ntype: person\nlast_read: <fill-in>\n---\nAn archived template, outside templates_dir.\n',
  };
  const config = {
    taxonomy: { templates_dir: 'templates' },
    frontmatter: { required: [], forbidden: [], extensions: { last_read: { type: 'date' } } },
    validate: { placeholder_pattern: '<[^>]+>' },
  };
  const findings = findingsFor({ files, config }).filter(isHouse('extension-fields'));
  assert.deepEqual(
    findings.map((f) => f.file),
    ['templates-old/template-person.md'],
    'templates/ is exempt and templates-old/ is not: one is under the configured directory, the other only starts with its name',
  );
});

test('the placeholder exemption never fires without validate.placeholder_pattern configured, even under templates_dir', () => {
  const files = { ...cleanVaultFiles(), 'templates/template-person.md': '---\ntype: person\nlast_read: <fill-in>\n---\nPlaceholder template.\n' };
  // The base config fixture sets its own placeholder_pattern; an explicit
  // `undefined` here overrides makeVault's deepMerge with a key that
  // JSON.stringify then drops entirely, which is the only way to test
  // this rule's own default (no pattern at all) against a fixture that
  // otherwise always configures one.
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { last_read: { type: 'date' } } },
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
  const findings = findingsFor({ files, config: strict }).filter((f) => isHouseCheck('link-style', 'file-relative')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(renderedMessage(findings[0]), /slash/);
  assert.match(renderedMessage(findings[0]), /host/);

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
  const findings = findingsFor({ files, config }).filter((f) => isHouseCheck('link-style', 'bundle-absolute')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(renderedMessage(findings[0]), /bundle-absolute/);
});

test('link-style ignores an external link and a same-page fragment link either way, but still flags a real slash-leading link right beside them', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [site](https://example.com/x), [section](#see-also), and [bad](/people/ghost.md).\n',
  };
  const config = { validate: { link_style: 'file-relative' } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('link-style')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the slash-leading link should be flagged, not the external or fragment one');
  assert.match(renderedMessage(findings[0]), /ghost\.md/);
});

// Fix round 2: this rule judges isAbsolute against the decoded path,
// not the raw target text, so a percent-encoded leading slash judged
// "starts with a slash" must show a slash SOMEWHERE in its own message,
// not just quote raw text that plainly does not.
test('link-style names the resolved path alongside a raw target that does not itself show the slash it was judged by', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [encoded](%2Fpeople%2Fghost.md).\n',
  };
  const config = { validate: { link_style: 'file-relative' } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('link-style')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(renderedMessage(findings[0]), /%2Fpeople%2Fghost\.md/, 'the raw target must still be named');
  assert.match(renderedMessage(findings[0]), /\/people\/ghost\.md/, 'the resolved path, which is what was actually judged, must also be named');
});

// --- link-target-exists (validate.link_targets, default "report") ----------------

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
  assert.match(renderedMessage(findings[0]), /nobody\.md/);
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
  assert.match(renderedMessage(findings[0]), /nobody\.md/);
});

test('link-target-exists is on even when the vault configures nothing at all', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[ghost](nowhere.md)\n' };
  const findings = findingsFor({ files }).filter(isHouse('link-target-exists'));
  assert.equal(findings.length, 1);
});

// --- the four shapes this rule used to report as broken while they existed -------
//
// Every one of these was reproduced against the real binary before it
// was fixed, and the first of them is the exact line section 8 of the
// Open Knowledge Format prints as its own worked example of an index
// entry: "* [Subdirectory](subdir/) - short description of the
// subdirectory". walkVault returns files, so no directory could ever be
// in the set this rule looked in, which made a link to a subdirectory
// unconditionally broken in a tool whose report then said the vault had
// departed from a rule it had declared.

test('link-target-exists resolves a link to a subdirectory, the shape the format prints as its own index-entry example, and still flags a link to a directory that does not exist', () => {
  const files = {
    'index.md': '# Welcome\n\n* [Subdirectory](people/) - the people in this vault\n* [Ghost](nowhere/) - nothing is here\n',
    'people/ana.md': '---\ntype: person\n---\nBody.\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'index.md');
  assert.equal(findings.length, 1, 'only the directory that does not exist should be flagged');
  assert.match(renderedMessage(findings[0]), /nowhere\//);
});

test('link-target-exists resolves a directory link written without its trailing slash too', () => {
  const files = {
    'index.md': '# Welcome\n\n* [Subdirectory](people) - the people in this vault\n',
    'people/ana.md': '---\ntype: person\n---\nBody.\n',
  };
  assert.deepEqual(findingsFor({ files }).filter(isHouse('link-target-exists')), []);
});

// The "../" case was worse than a false positive: the evidence the
// message printed, "resolved to \"./\"", was neither the link the author
// wrote nor anything on disk, so the one field added to make a broken
// link understandable was garbage for the shape a human is most likely
// to write by hand.
test('link-target-exists resolves "./" and "../" through normalisation, and the resolved evidence it prints is a real vault path rather than a normalisation artifact', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [here](./), [up](../), [root index](../index.md) and [ghost](../nowhere/deeper/).\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the directory that does not exist should be flagged');
  assert.equal(findings[0].params.resolved, 'nowhere/deeper', 'the resolved path is canonical: no trailing slash, no leading "./"');
  for (const finding of findings) {
    assert.ok(!/^\.\/?$/.test(finding.params.resolved), 'the resolved evidence must never be the normalisation artifact "./"');
  }
});

// The fifth shape, and the one that belonged to no task: the same single
// walk fed the ignore filter and the existence set, so
// validate.ignore_paths silently doubled as a break-every-link-into-here
// switch. The file is on disk and the owner is looking at it; saying it
// is not in the vault is the tool telling a person something false.
test('a link into a directory the configuration told the walk to skip is reported as present but unwalked, in those words, and never as absent', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [the draft](../drafts/idea.md) and [a ghost](../drafts/nothing.md).\n',
    'drafts/idea.md': '---\ntype: note\n---\nBody.\n',
  };
  const config = { validate: { ignore_paths: ['drafts'] } };
  const findings = findingsFor({ files, config }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 2);

  const unwalked = findings.filter((f) => f.check === 'target-walked');
  assert.equal(unwalked.length, 1, 'the file that is really there gets the unwalked finding');
  assert.equal(unwalked[0].params.resolved, 'drafts/idea.md');
  assert.equal(unwalked[0].absence, false, 'a file that exists is not an absence, whatever the walk skipped');
  assert.match(renderedMessage(unwalked[0]), /exists on disk/);
  assert.match(renderedMessage(unwalked[0]), /ignore_paths/);

  const broken = findings.filter((f) => f.check === 'target-exists');
  assert.equal(broken.length, 1, 'a file that is genuinely not there is still broken, ignored directory or not');
  assert.equal(broken[0].params.resolved, 'drafts/nothing.md');
  assert.equal(broken[0].absence, true);
});

// A link that climbs out of the vault is not a vault path at all, and is
// never stat'd: it is reported broken with the canonical path it names,
// which is an honest answer to "where does this point".
test('link-target-exists reports a link that climbs out of the vault as broken, naming the path it actually resolved to, and never stats anything above the root', () => {
  const files = {
    'index.md': '# Welcome\n\nSee [up](../), the directory this vault sits in.\n',
    'people/ana.md': '---\ntype: person\n---\n[outside](../../elsewhere.md)\n',
  };
  const findings = findingsFor({ files }).filter(isHouse('link-target-exists'));
  assert.equal(findings.length, 2);

  const fromNote = findings.filter((f) => f.file === 'people/ana.md');
  assert.equal(fromNote.length, 1);
  assert.equal(fromNote[0].params.resolved, '../elsewhere.md');

  // The vault's parent directory really does exist on disk, and a
  // resolver that stat'd it would call this link satisfied: a link
  // pointing OUT of the vault would then be silently accepted by the
  // one rule whose whole job is deciding what is in the vault.
  const fromIndex = findings.filter((f) => f.file === 'index.md');
  assert.equal(fromIndex.length, 1, 'a link to the vault\x27s own parent directory is outside the vault, not a satisfied directory link');
  assert.equal(fromIndex[0].params.resolved, '..');
});

// The policy half. Section 6.1 of the format says "Consumers MUST
// tolerate broken links: a link whose target does not exist in the
// bundle is not malformed; it may simply represent not-yet-written
// knowledge", and section 11 lists broken cross-links among the things a
// consumer must not reject a bundle over. This rule stays on by default
// because brain-kit validate is producer-side (see the rule's own
// comment), but an adopter who reads section 11 now has the setting the
// module header always claimed every rule had.
test('validate.link_targets: "off" silences the rule entirely, and the identical vault still reports the broken link under the default', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[ghost](nowhere.md)\n' };
  assert.deepEqual(findingsFor({ files, config: { validate: { link_targets: 'off' } } }).filter(isHouse('link-target-exists')), []);
  assert.equal(findingsFor({ files, config: { validate: { link_targets: 'report' } } }).filter(isHouse('link-target-exists')).length, 1);
  assert.equal(findingsFor({ files }).filter(isHouse('link-target-exists')).length, 1, 'the default is "report": an unconfigured vault still gets its links checked');
});

// --- link honesty: query strings, percent-encoding, parens, brackets, nesting -----

// Fix round 1, finding 8 of the previous review: a query string or a
// percent-escaped path used to be reported broken even though the file
// it named was real. Both are now HANDLED.
test('link-target-exists strips a query string and decodes a percent-escaped path before checking existence, but still flags the same shapes when the file genuinely does not exist', () => {
  const realFiles = {
    'index.md': '# Welcome\n',
    'people/ana.md': [
      '---',
      'type: person',
      '---',
      'See [with query](bruno.md?v=1) and [percent-escaped](my%20notes.md).',
    ].join('\n'),
    'people/bruno.md': '---\ntype: person\n---\nBody.\n',
    'people/my notes.md': '---\ntype: person\n---\nBody.\n',
  };
  assert.deepEqual(findingsFor({ files: realFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md'), []);

  const ghostFiles = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [ghost](nowhere.md?v=1) and [ghost too](no%20file.md).\n',
  };
  const findings = findingsFor({ files: ghostFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 2, 'the identical query-string and percent-escaped shapes must still be flagged when the target genuinely does not exist');
});

test('link-target-exists never throws on a malformed percent-escape, and declines to decode it rather than guessing', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[bad escape](nowhere%zz.md)\n' };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor({ files });
  });
  const bad = findings.filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(bad.length, 1);
  assert.match(renderedMessage(bad[0]), /nowhere%zz\.md/);
});

// Fix round 1, finding 9: a target containing balanced parentheses used
// to be reported under a garbled, truncated name. HANDLED now, by
// balanced matching.
test('link-target-exists resolves a target containing balanced parentheses by its real, whole name, but still flags the identical shape when that file does not exist, naming it whole rather than mangled', () => {
  const realFiles = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [scan](real(1).md).\n',
    'people/real(1).md': '---\ntype: person\n---\nBody.\n',
  };
  assert.deepEqual(findingsFor({ files: realFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md'), []);

  const ghostFiles = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[ghost](real(1).md)\n' };
  const findings = findingsFor({ files: ghostFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(renderedMessage(findings[0]), /real\(1\)\.md/);
});

// Fix round 1, finding 10: bracketed link text used to make the whole
// link invisible to this scanner. HANDLED now, by balanced matching on
// the text span too.
test('link-target-exists recognises a link whose own text contains brackets', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [text [with brackets]](ghost.md).\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'the link must be recognised at all, or this would report nothing instead of a broken target');
  assert.match(renderedMessage(findings[0]), /ghost\.md/);
});

// Fix round 2, finding: a backslash-escaped bracket in link text used
// to make the whole link invisible (the escaped "]" was read as a real
// close, no "(" followed, and the scanner never found the real link).
// HANDLED now: the escaped bracket is skipped, not read as structure.
test('link-target-exists recognises a link whose text contains a backslash-escaped bracket', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nSee [a \\] b](ghost.md).\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'the link must be recognised at all, or this would report nothing instead of a broken target');
  assert.match(renderedMessage(findings[0]), /ghost\.md/);
});

// Fix round 2, the other resolved middle-state shape: a bare
// destination containing a raw, unescaped space is not a valid link at
// all in this markup (CommonMark requires angle brackets or an
// escaped space), so it must produce NO finding, right or wrong, not a
// wrong one. Paired with the almost-identical shape one word over,
// where the space IS escaped and the link is real and broken.
test('link-target-exists declines a bare target containing a raw space outright, but still flags the identical target once its space is escaped', () => {
  const rawSpaceFiles = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[x](my file.md)\n' };
  assert.deepEqual(findingsFor({ files: rawSpaceFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md'), []);

  const escapedSpaceFiles = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[x](my\\ file.md)\n' };
  const findings = findingsFor({ files: escapedSpaceFiles }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'an escaped space makes this a real, bare destination, which does not exist and must be flagged');
});

// A target wrapped in angle brackets is allowed to contain a raw
// space: that is exactly what the wrapping is for, so this shape must
// never be declined.
test('link-target-exists still checks an angle-bracket-wrapped target containing a raw space, since the wrapping legitimises it', () => {
  const files = { 'index.md': '# Welcome\n', 'people/ana.md': '---\ntype: person\n---\n[x](<my file.md>)\n' };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
  assert.match(renderedMessage(findings[0]), /my file\.md/);
});

// Fix round 1, declared trade-off: a link nested inside another link's
// text (an image inside a link) is read as ONE link, the outer one, and
// the inner image's own target is no longer independently checked.
test('link-target-exists checks the outer target of a nested link-in-a-link pair, and does not independently check the inner one', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\n[![alt](inner-ghost.png)](outer-ghost.md)\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the outer target is checked for a nested pair');
  assert.match(renderedMessage(findings[0]), /outer-ghost\.md/);
  assert.ok(!findings.some((f) => renderedMessage(f).includes('inner-ghost.png')), 'the inner image is declined, not independently reported');
});

// Fix round 1, declared trade-off: a reference-style link is declined
// outright, and produces no finding at all, right or wrong.
// Fix round 2: the previous round's justification for this being the
// one unpaired survivor did not hold. A declined feature is not
// contrast-free: the contrast is one ordinary inline link to the SAME
// nonexistent target, in the SAME fixture, which must still produce a
// finding, exactly the pairing this file already applies to five other
// tests in this same round.
test('link-target-exists declines a reference-style link outright, producing no finding, not a wrong one, but still flags an ordinary link to the identical nonexistent target right beside it', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [
      '---',
      'type: person',
      '---',
      'See [Bruno][ref] for more, and also [Bruno again](nowhere-real.md) written plainly.',
      '',
      '[ref]: nowhere-real.md',
      '',
    ].join('\n'),
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the ordinary inline link should be flagged; the reference-style one is declined, not silently correct');
  assert.match(renderedMessage(findings[0]), /nowhere-real\.md/);
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
  assert.match(renderedMessage(findings[0]), /nowhere-real\.md/);
});

test('a link-shaped example inside inline code is never read as a real link, but the same target outside a backtick span is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': '---\ntype: person\n---\nWrite it like `[ghost](nowhere.md)` in prose, or for real as [ghost](nowhere.md).\n',
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1);
});

// Fix round 1: the shared review's own addition to the fence contract.
// A fence quoted inside a blockquote is still code, and the review
// showed this ruler turning that into a wrong link finding, which is
// exactly the "confident wrong finding" the module's own header
// declares it will not produce.
test('a link inside a fenced block quoted with ">" is never read as a real link, but a real link right after the quote closes still is', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': ['---', 'type: person', '---', '> ```', '> [x](ghost.md)', '> ```', '[real](nowhere-real.md)', ''].join('\n'),
  };
  const findings = findingsFor({ files }).filter((f) => isHouse('link-target-exists')(f) && f.file === 'people/ana.md');
  assert.equal(findings.length, 1, 'only the real link after the blockquote should be flagged, not the quoted-and-fenced example');
  assert.match(renderedMessage(findings[0]), /nowhere-real\.md/);
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
  assert.match(renderedMessage(findings[0]), /Bruno/);

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
  assert.equal(missingFindings[0].check, 'declared');
  assert.match(renderedMessage(missingFindings[0]), /does not declare/);

  const wrongFindings = findingsFor({ files: wrong, config }).filter(isHouse('root-okf-version'));
  assert.equal(wrongFindings.length, 1);
  assert.equal(wrongFindings[0].check, 'matches-configured');
  assert.match(renderedMessage(wrongFindings[0]), /0\.1/);

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
  const shouldFinding = { ruler: 'spec', id: 'stale-after-format', check: 'timestamp-form', section: '5.5', level: 'should', deviationEligible: true, absence: false, file: 'people/ana.md', line: 6, messageKey: 'spec.stale_after_format.invalid', params: { value: '2026-12-18' } };

  const allowed = applyTimestampDeviation([shouldFinding], { validate: { timestamp_deviation: 'allow' } });
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].warning, true);
  assert.equal(allowed[0].level, 'should', 'the original tier is preserved; only a warning flag is added');

  const forbidden = applyTimestampDeviation([shouldFinding], { validate: { timestamp_deviation: 'forbid' } });
  assert.deepEqual(forbidden, [shouldFinding]);

  const defaulted = applyTimestampDeviation([shouldFinding], {});
  assert.deepEqual(defaulted, [shouldFinding], 'an unconfigured vault gets the format\x27s own answer: forbid');
});

// The `must` guard, and this test is the second attempt at it. The
// first built its `must` finding as
// { id: 'type-required', check: 'type-present' }, a pair that is not
// eligible for the deviation under any circumstances, so eligibility
// alone already refused it and the level guard never ran at all:
// deleting `if (finding.level !== 'should') return finding;` from
// applyTimestampDeviation failed nothing. The ledger recorded the
// clause as closed on the strength of that test for two rounds.
//
// The finding below is eligible in every other respect - the spec
// ruler, an eligible id and check, and the eligibility flag itself -
// so the ONLY thing between it and a `warning: true` is its level.
test('applyTimestampDeviation never touches a must-level finding, even one that is eligible in every other respect, and never touches a should-level finding that is not eligible, while still downgrading the eligible one in the same batch', () => {
  const mustFinding = { ruler: 'spec', id: 'generated-actor', check: 'timestamp-form', section: '5.2', level: 'must', deviationEligible: true, absence: false, file: 'people/ana.md', line: 4, messageKey: 'common.timestamp_form', params: { field: 'generated.at', value: 'not-a-datetime' } };
  const otherShould = { ruler: 'spec', id: 'sources-resource', check: 'entry-resource', section: '5.1', level: 'should', deviationEligible: false, absence: true, file: 'people/ana.md', line: 8, messageKey: 'spec.sources_resource.missing_resource', params: { index: 0 } };
  const eligible = { ruler: 'spec', id: 'generated-actor', check: 'timestamp-form', section: '5.2', level: 'should', deviationEligible: true, absence: false, file: 'people/ana.md', line: 4, messageKey: 'common.timestamp_form', params: { field: 'generated.at', value: 'not-a-datetime' } };

  const result = applyTimestampDeviation([mustFinding, otherShould, eligible], { validate: { timestamp_deviation: 'allow' } });
  assert.deepEqual(result[0], mustFinding, 'a must-level finding is never downgraded, whatever else about it is eligible');
  assert.deepEqual(result[1], otherShould);
  assert.equal(result[2].warning, true, 'the one eligible finding in the batch must still be downgraded, or this "leaves the others alone" test would pass against a stub that changes nothing at all');
});

// The absence guard, asserted the same way and for the same reason: no
// finding the real rulers produce today carries both the eligibility
// flag and `absence`, so only a hand-built one can reach this clause.
// It is defence in depth on purpose. The invariant it protects ("a
// downgrade may never reach a finding about something being ABSENT")
// is one check name away from being violated by a future round drawing
// a check too coarsely, which this repository has already done once.
test('applyTimestampDeviation never downgrades a finding that reports an ABSENCE, even one flagged eligible in every other respect', () => {
  const absentButEligible = { ruler: 'spec', id: 'verified-events', check: 'event-timestamp-form', section: '5.2', level: 'should', deviationEligible: true, absence: true, file: 'people/ana.md', line: 6, messageKey: 'spec.verified_events.missing_timestamp', params: { index: 0 } };
  const presentAndMalformed = { ...absentButEligible, absence: false, messageKey: 'common.timestamp_form', params: { field: 'verified[0].at', value: '2026-09-18' } };

  const result = applyTimestampDeviation([absentButEligible, presentAndMalformed], { validate: { timestamp_deviation: 'allow' } });
  assert.deepEqual(result[0], absentButEligible, 'an absence finding is never downgraded');
  assert.equal(result[1].warning, true, 'the same finding without the absence flag must still be downgraded, or this test would pass against a stub that downgrades nothing at all');
});

// Fix round 1, finding 5 of the previous review, the reason `check`
// exists at all: generated-actor and verified-events each carry an
// actor-shaped check under the SAME id as their timestamp-shaped check.
// Selecting by id alone would downgrade a missing-actor finding just
// because it shares an id with a real timestamp finding; selecting by
// the eligibility the spec ruler itself set must not.
test('applyTimestampDeviation never downgrades an actor-presence or shape-readable finding sharing an id with an eligible timestamp-form check, but still downgrades the real timestamp-form finding for that same id in the same batch', () => {
  const actorMissing = { ruler: 'spec', id: 'generated-actor', check: 'actor-present', section: '5.2', level: 'should', deviationEligible: false, absence: true, file: 'people/ana.md', line: 4, messageKey: 'spec.generated_actor.missing_actor', params: {} };
  const shapeUnreadable = { ruler: 'spec', id: 'generated-actor', check: 'shape-readable', section: '5.2', level: 'should', deviationEligible: false, unreadable: true, file: 'people/ana.md', line: 4, messageKey: 'common.shape_unreadable', params: { field: 'generated' } };
  const eventActor = { ruler: 'spec', id: 'verified-events', check: 'event-actor', section: '5.2', level: 'should', deviationEligible: false, absence: true, file: 'people/ana.md', line: 6, messageKey: 'spec.verified_events.missing_actor', params: { index: 0 } };
  const timestampForm = { ruler: 'spec', id: 'generated-actor', check: 'timestamp-form', section: '5.2', level: 'should', deviationEligible: true, absence: false, file: 'people/ana.md', line: 4, messageKey: 'common.timestamp_form', params: { field: 'generated.at', value: 'not-a-datetime' } };

  const result = applyTimestampDeviation([actorMissing, shapeUnreadable, eventActor, timestampForm], { validate: { timestamp_deviation: 'allow' } });
  assert.deepEqual(result[0], actorMissing);
  assert.deepEqual(result[1], shapeUnreadable);
  assert.deepEqual(result[2], eventActor);
  assert.equal(result[3].warning, true, 'the real timestamp-form finding sharing the same id must still be downgraded, or this test would pass against a stub that changes nothing at all');
});

// The eligibility table used to live here, in the house ruler: a frozen
// array of four (id, check) pairs, every one of them owned by
// src/rules/spec.mjs. Adding a timestamp-valued key to the spec ruler
// meant remembering to come and edit this file, with nothing to remind
// anyone. The fact now travels on the finding, set where the finding is
// built, and this test asserts the two ends agree END TO END through
// the real specification ruler: every finding the deviation downgrades
// carries the flag, and every timestamp-FORM finding the spec ruler can
// produce carries it.
test('eligibility for the timestamp deviation is a flag the specification ruler sets on its own finding, not a list the house ruler keeps: every downgraded finding carries it, and no other finding does', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/ana.md': [
      '---',
      'type: person',
      'generated: { by: human:ana, at: 2026-09-18 }',
      'stale_after: 2027-01-01',
      'verified: { by: human:ana, at: 2026-09-18 }',
      'sources:',
      '  - resource: https://example.com/a',
      '    last_modified: 2026-09-18',
      '---',
      'Body.',
      '',
    ].join('\n'),
  };
  const root = makeVault({ files });
  const config = loadConfig(root);
  const { files: mdFiles, context } = rulerArgsFor(root, config);
  const specFindings = runSpecRules(mdFiles, context);

  const flagged = specFindings.filter((f) => f.deviationEligible);
  assert.deepEqual(
    flagged.map((f) => `${f.id}/${f.check}`).sort(),
    ['generated-actor/timestamp-form', 'sources-resource/entry-timestamp-form', 'stale-after-format/timestamp-form', 'verified-events/event-timestamp-form'],
    'all four of section 5\x27s timestamp-valued keys, and nothing else',
  );

  const downgraded = applyTimestampDeviation(specFindings, { validate: { timestamp_deviation: 'allow' } });
  const warned = downgraded.filter((f) => f.warning === true);
  assert.equal(warned.length, flagged.length, 'the deviation downgrades exactly the findings the spec ruler flagged');
  for (const finding of warned) assert.equal(finding.deviationEligible, true);
  for (const finding of downgraded) {
    if (!finding.deviationEligible) assert.notEqual(finding.warning, true);
  }
});

// Fix round 2, the invariant itself, and this is the THIRD mechanism
// for it. The first read a check's name. The second read the finding's
// own rendered MESSAGE against the phrase "missing or empty", which was
// rejected when it was written down as a ruling - a tool must not infer
// its own semantics from its own prose - and kept anyway; a single
// differently-phrased absence (verified is present but carries no
// events; this file has frontmatter, but no type key in it) walked
// straight through it, and task 8 then moved every message into
// lang/*/messages.json, so the guard had come to depend on the wording
// of a translation file that a language pack can change without ever
// touching this repository's logic.
//
// It is a FIELD now, set at each findings.push that reports something
// absent, and this test reads that field and nothing else. No check
// name, no message text.
test('the invariant: a downgrade never reaches a finding that reports something ABSENT, asserted against the finding\x27s own absence field and never against its prose, end to end through the real specification ruler', () => {
  const files = {
    'index.md': '# Welcome\n',
    'people/blank-at.md': '---\ntype: person\nverified: { by: human:ana, at: }\n---\nBody.\n',
    'people/malformed-at.md': '---\ntype: person\nverified: { by: human:ana, at: 2026-09-18 }\n---\nBody.\n',
    'people/no-type.md': '---\nstatus: stable\n---\nBody.\n',
    'people/empty-verified.md': '---\ntype: person\nverified:\n---\nBody.\n',
  };
  const root = makeVault({ files });
  const config = loadConfig(root);
  const { files: mdFiles, context } = rulerArgsFor(root, config);
  const specFindings = runSpecRules(mdFiles, context);

  const downgraded = applyTimestampDeviation(specFindings, { validate: { timestamp_deviation: 'allow' } });

  const absent = downgraded.filter((f) => f.absence === true);
  const malformed = downgraded.filter((f) => f.id === 'verified-events' && f.check === 'event-timestamp-form');

  assert.ok(absent.length >= 3, 'the fixture must produce several differently-phrased absence findings for this assertion to mean anything');
  // Differently phrased on purpose: the previous guard matched one
  // phrase, and these three do not share one.
  const phrases = new Set(absent.map((f) => f.messageKey));
  assert.ok(phrases.size >= 3, `the absences must be phrased differently for this to be a real test of the field: ${[...phrases].join(', ')}`);
  for (const finding of absent) {
    assert.notEqual(finding.warning, true, `a finding that reports something absent must never be downgraded: ${finding.id}/${finding.check}`);
  }
  assert.ok(malformed.length > 0, 'the fixture must produce at least one malformed-but-present finding for this assertion to mean anything');
  for (const finding of malformed) {
    assert.equal(finding.warning, true, 'a finding about a malformed, present value must still be downgraded, or this test would pass against a stub that downgrades nothing at all');
  }
});

// --- a rule must never throw: malformed, truncated, empty and binary-ish files -----

test('a rule never throws on malformed input: empty, only the opening delimiter, or a frontmatter block that is never closed, and still reports each as a required-fields finding rather than as an exception or as silence', () => {
  const files = {
    ...cleanVaultFiles(),
    'people/empty.md': '',
    'people/only-open.md': '---\n',
    'people/unterminated.md': '---\ntype: note\ndescription: this frontmatter block is never closed\n',
  };
  const config = { frontmatter: { required: ['description'], forbidden: [], extensions: { confidential: { type: 'boolean' } } } };
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
  const files = { ...cleanVaultFiles(), 'people/binary.md': binaryish, 'people/has-bad-bool.md': '---\ntype: person\nconfidential: yes\n---\nBody.\n' };
  const config = {
    frontmatter: { required: [], forbidden: [], extensions: { confidential: { type: 'boolean' } } },
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

test('a rule never throws on adversarial link-shaped text: thousands of unmatched brackets, deeply nested links, or a very long single link, and still flags a real broken link placed right after each one', () => {
  const manyOpenBrackets = '['.repeat(5000);
  const deeplyNested = '['.repeat(200) + 'text' + ']('.repeat(0) + 'x.md)'.repeat(1); // 200 opens, one real close far short of matching them all
  const longLinkTarget = `[x](${'a'.repeat(40000)}.md)`;
  const files = {
    'index.md': '# Welcome\n',
    'people/brackets.md': `---\ntype: person\n---\n${manyOpenBrackets}\n[real-ghost](nowhere-real.md)\n`,
    'people/nested.md': `---\ntype: person\n---\n${deeplyNested}\n[real-ghost](nowhere-real.md)\n`,
    'people/long.md': `---\ntype: person\n---\n${longLinkTarget}\n[real-ghost](nowhere-real.md)\n`,
  };
  let findings;
  assert.doesNotThrow(() => {
    findings = findingsFor({ files });
  });
  for (const file of ['people/brackets.md', 'people/nested.md', 'people/long.md']) {
    assert.ok(
      findings.some((f) => isHouse('link-target-exists')(f) && f.file === file && renderedMessage(f).includes('nowhere-real.md')),
      `${file} should still report the real broken link placed after the adversarial text`,
    );
  }
});
