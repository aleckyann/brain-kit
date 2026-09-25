import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import {
  validateConfig, validateMachine, findMachineOnlyKeys, loadConfig, loadMachine, ConfigError, CONFIG_FILENAME, RETIRED_MACHINE_PATHS, withoutRetiredPaths,
} from '../src/config.mjs';

const fixture = (name) => JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', name), 'utf8'));
const rawFixture = (name) => readFileSync(join(KIT_ROOT, 'test', 'fixtures', name), 'utf8');

test('the example config is valid', () => {
  assert.deepEqual(validateConfig(fixture('config/valid.json')), []);
});

// Fix round 1 (review): `validateConfig(...) === []` proves the shape
// is legal, never that the CONTENT is English. Renaming the owner,
// title, timezone or curator signature to anything else legal (even to
// Portuguese) leaves that one assertion just as green, since the
// schema has no notion of language for a free-form string. This is the
// fixture every later fixture copies (test/helpers/vault-fixture.mjs's
// own `baseConfig()` reads exactly this file), so it is the one most
// worth pinning, and until this test it was pinned at zero paths while
// its pt-BR sibling below was pinned at several.
test('the English fixture is pinned as English, not merely schema-valid', () => {
  const config = fixture('config/valid.json');
  assert.equal(config.lang, 'en');
  assert.equal(config.owner.name, 'Ana');
  assert.equal(config.vault.title, "Ana's Second Brain");
  // A generic, universal zone, never a real person's own timezone: the
  // ORIGINAL shared fixture this one was split from used
  // "America/Sao_Paulo" for every vault regardless of declared
  // language, which is exactly the one real household's shape this
  // split exists to stop leaking through a "generic adopter" example.
  assert.equal(config.vault.timezone, 'UTC');
  assert.equal(config.curate.signature, 'Second brain curator (example)');
  assert.equal(config.briefing.signature, 'Second brain morning briefing (example)');
  // The forbidden-characters example is the em dash ITSELF (U+2014),
  // parsed back from its JSON escape (the \\u2014 sequence in the
  // file, ASCII on
  // disk): a literal em dash byte sitting in this file would parse to
  // the exact same character and pass unnoticed by anything checking
  // only the parsed VALUE, so the byte-level shape is guarded
  // separately by test/no-portuguese.test.mjs's own non-ASCII scan of
  // src/, bin/ and the language pack (this fixture is deliberately
  // outside that guard's scope, since a config example is data, not
  // shipped source) - this assertion instead pins the one property
  // that actually matters for a config VALUE: it still parses to the
  // real character, whichever way it was spelled on disk.
  assert.equal(config.lint.style.forbidden_chars[0], String.fromCharCode(0x2014));
  // Fix round 1 (review): the assertion above proves the PARSED value
  // is the real character; it says nothing about how the FILE spelled
  // it, and a literal em dash byte parses to that exact same character,
  // so putting the raw byte back into the file passed that assertion
  // just the same. This one reads the raw bytes and pins the OTHER
  // half of the claim: the file itself stays ASCII, via the JSON
  // escape, not the literal character.
  assert.ok(!rawFixture('config/valid.json').includes(String.fromCharCode(0x2014)), 'the fixture file itself must not contain a literal em dash byte');
});

// test/fixtures/config/valid-pt-BR.json exists to PROVE a claim this kit
// has always made and, until this test, never once checked: taxonomy is
// configuration, so its labels, file names and column headings are the
// vault owner's own language, not brain-kit's. Its EN sibling above is
// deliberately, wholly English; this one is deliberately, wholly pt-BR,
// down to the taxonomy the schema leaves free-form. Checking only
// `validateConfig(...) === []` would pass against a fixture that was
// quietly re-anglicised (the schema does not know or care what
// language a free-form string is in), so this test also pins down
// specific non-English values at the exact schema paths a previous
// pass renamed to English keys: a column heading, a file name, and an
// extension field name. Mutate any one of those three values back to
// English and this test, not just the schema check, must fail.
//
// Fix round 1 (review): the fixture claims three axes (labels, file
// names, column headings); this test used to pin only ONE file name
// (taxonomy.files.promises) while a sibling entry under the exact same
// key (taxonomy.files.followups) and all three collection template
// paths stayed byte-identical to the English fixture, unnoticed. Two
// more file-name paths pinned below, on the same principle: a claim
// this fixture makes about itself is worth checking at more than one
// example of it.
test('the pt-BR sibling fixture proves the configuration accepts non-English labels, file names and column headings', () => {
  const config = fixture('config/valid-pt-BR.json');
  assert.deepEqual(validateConfig(config), []);
  assert.equal(config.lang, 'pt-BR');
  // A non-English column heading, under a schema key (taxonomy.columns)
  // that only ever requires a string: index 1 of the ordered "columns"
  // array is "What" in the English fixture, so its pt-BR sibling's own
  // index 1 is checked here (fix round 1: the array replaced a flat
  // object that mixed real column names with section-heading labels).
  assert.equal(config.taxonomy.columns.followups.columns[1], 'O que');
  // Non-English file names, under taxonomy.files (also free-form): two
  // of them, not one, since a previous pass translated one sibling
  // entry and left another (this exact one) untouched.
  assert.equal(config.taxonomy.files.promises, 'pending/promessas.md');
  assert.equal(config.taxonomy.files.followups, 'pending/acompanhamentos.md');
  // A non-English collection template path: all three used to stay
  // English (a schema-free-form string, exactly like the two above).
  assert.equal(config.taxonomy.collections.people.template, 'templates/modelo-pessoa.md');
  // A non-English extension field name, under frontmatter.extensions
  // (the map's own keys are free-form, not drawn from any enum).
  assert.ok('situacao' in config.frontmatter.extensions, 'expected a non-English extension field name');
  // The same em-dash-parses-to-the-real-character property the English
  // fixture above pins, since this fixture declares the identical
  // example value, and the same raw-byte check: this fixture is
  // deliberately non-ASCII elsewhere (its whole reason to exist), so
  // this pins the ONE character it must still never spell literally,
  // not the whole file.
  assert.equal(config.lint.style.forbidden_chars[0], String.fromCharCode(0x2014));
  assert.ok(
    !rawFixture('config/valid-pt-BR.json').includes(String.fromCharCode(0x2014)),
    'the fixture file itself must not contain a literal em dash byte',
  );
});

test('a machine-only key anywhere in the versioned config is rejected', () => {
  const errors = validateConfig(fixture('config/with-machine-key.json'));
  assert.ok(errors.some((e) => e.startsWith('$.curate.claude_bin: machine-only key')), errors.join('\n'));
});

test('findMachineOnlyKeys reports nested paths', () => {
  assert.deepEqual(findMachineOnlyKeys({ a: { notify_command: ['x'] }, b: [{ model: 'm' }] }), ['$.a.notify_command', '$.b[0].model']);
});

test('unknown top-level keys and bad enums are reported', () => {
  const config = fixture('config/valid.json');
  config.lang = 'xx';
  config.surprise = true;
  const errors = validateConfig(config);
  assert.ok(errors.includes('$.lang: must be one of ["pt-BR","en"]'), errors.join('\n'));
  assert.ok(errors.includes('$.surprise: unknown key'), errors.join('\n'));
});

// Phase 5a: curate.budget_usd null is the owner asking for no cost cap, so
// the schema takes it beside a number; a negative number or a string is
// still refused, and a configuration that leaves the key out stays valid
// (a round then gets the default cap).
test('curate.budget_usd takes a non-negative number or null, refuses a negative number or a string, and may be left out', () => {
  for (const value of [5, 0.5, 0, null]) {
    const config = fixture('config/valid.json');
    config.curate.budget_usd = value;
    assert.deepEqual(validateConfig(config), [], JSON.stringify(value));
  }
  const absent = fixture('config/valid.json');
  delete absent.curate.budget_usd;
  assert.deepEqual(validateConfig(absent), []);
  for (const value of [-1, -0.01, '5', 'none', true, [], {}]) {
    const config = fixture('config/valid.json');
    config.curate.budget_usd = value;
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.startsWith('$.curate.budget_usd:')), `${JSON.stringify(value)}: ${errors.join('\n')}`);
  }
});

test('curate.schedule entries must be HH:MM', () => {
  const config = fixture('config/valid.json');
  config.curate.schedule = ['9h30'];
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.curate.schedule[0]')));
});

// Fix round 1 (IMPORTANT, brain-kit lint's own secrets rule): an empty
// string used to be schema-valid inside privacy.secret_patterns, and
// only failed once it reached src/leak.mjs's own compilePattern, which
// refuses an empty pattern outright ("an empty pattern matches
// everywhere") and, for the secrets rule specifically, that refusal
// crashes the whole lint run rather than reporting a controlled
// finding. Caught here now, at config-validation time, before it ever
// reaches a rule at all.
test('an empty string inside privacy.secret_patterns is rejected by the schema itself, before it can crash the secrets rule at scan time', () => {
  const config = fixture('config/valid.json');
  config.privacy.secret_patterns = ['ghp_[A-Za-z0-9]{20,}', ''];
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.startsWith('$.privacy.secret_patterns[1]')), errors.join('\n'));
});

// Fix round 3 removed `lint.style.base`, a knob nothing read, and a
// review then showed the removal was undefended: putting it back into the
// schema kept the whole suite green. A vault that sets it is told the key
// is unknown, so a knob that does nothing cannot quietly return.
test('lint.style.base, removed because nothing read it, is refused by the schema rather than silently accepted', () => {
  const config = fixture('config/valid.json');
  config.lint.style = { forbidden_chars: ['x'], base: 'auto' };
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.startsWith('$.lint.style.base') && /unknown key/.test(e)), errors.join('\n'));
});

// Slice D, task 3 review (I2): the privacy rule reads the field that marks
// a note confidential from privacy.confidential_field, so the schema holds
// it to the shape of a frontmatter key. An empty name or one with a space
// or a colon could never match a key, and would read as a rule configured
// to watch nothing.
test('privacy.confidential_field is accepted as a frontmatter key name and refused otherwise', () => {
  const config = fixture('config/valid.json');
  for (const good of ['confidential', 'confidencial', 'is_private', 'private-note']) {
    config.privacy.confidential_field = good;
    config.frontmatter.extensions[good] = { type: 'boolean' };
    assert.deepEqual(validateConfig(config), [], good);
  }
  for (const bad of ['', 'two words', 'field:', '1st', true]) {
    config.privacy.confidential_field = bad;
    assert.ok(validateConfig(config).some((e) => e.startsWith('$.privacy.confidential_field')), String(bad));
  }
});

// Slice D, task 5: a misspelt confidential_field passes the schema's key
// shape, and the privacy rule then watches a field no note carries, which
// is the rule silently switched off. validateConfig refuses a name the
// same configuration does not declare as a boolean extension.
test('privacy.confidential_field must name a boolean extension the configuration declares', () => {
  const misspelt = fixture('config/valid.json');
  misspelt.privacy.confidential_field = 'confidental';
  assert.deepEqual(validateConfig(misspelt), [
    '$.privacy.confidential_field: "confidental" must name a boolean extension declared in frontmatter.extensions',
  ]);

  const notBoolean = fixture('config/valid.json');
  notBoolean.privacy.confidential_field = 'relationship';
  assert.equal(notBoolean.frontmatter.extensions.relationship.type, 'enum');
  assert.equal(validateConfig(notBoolean).length, 1, 'an enum extension is declared, but not a boolean one');

  const inherited = fixture('config/valid.json');
  inherited.privacy.confidential_field = 'toString';
  assert.equal(validateConfig(inherited).length, 1, 'a name found only on Object.prototype is not declared');

  const noExtensions = fixture('config/valid.json');
  delete noExtensions.frontmatter.extensions;
  assert.equal(validateConfig(noExtensions).length, 1, 'with no extensions at all, nothing is declared');

  const absent = fixture('config/valid.json');
  delete absent.privacy.confidential_field;
  delete absent.frontmatter.extensions.confidential;
  assert.deepEqual(validateConfig(absent), [], 'no confidential_field is not a misspelt one: the rule reads its default');

  const declared = fixture('config/valid.json');
  declared.privacy.confidential_field = 'private_note';
  declared.frontmatter.extensions.private_note = { type: 'boolean' };
  assert.deepEqual(validateConfig(declared), []);
});

test('each example configuration names the confidential field of its own language', () => {
  assert.equal(fixture('config/valid.json').privacy.confidential_field, 'confidential');
  const pt = fixture('config/valid-pt-BR.json');
  assert.equal(pt.privacy.confidential_field, 'confidencial');
  assert.equal(pt.frontmatter.extensions.confidencial.type, 'boolean', 'the named field is the language\'s own boolean extension');
});

// Final fix round 2: the secrets rule's own escape, a list of vault paths
// its scan leaves out, is a real setting of that rule, and only a list of
// non-empty paths is one.
test('lint.secrets.exclude_paths is accepted as a list of paths and refuses an empty entry', () => {
  const config = fixture('config/valid.json');
  config.lint.secrets = { severity: 'error', exclude_paths: ['attachments/big-export.csv'] };
  assert.deepEqual(validateConfig(config), []);
  config.lint.secrets = { severity: 'error', exclude_paths: [''] };
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.lint.secrets.exclude_paths[0]')));
  config.lint.secrets = { exclude_paths: 'attachments/' };
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.lint.secrets.exclude_paths')));
});

// Phase 3, task 6: the privacy rule's keywords and the paths exempt from
// them. A blank keyword would match almost every line once bounded on both
// sides, and a keyword with a space at either end would silently miss a
// word at the start or the end of a line, so the schema refuses both.
test('privacy.third_party_keywords and privacy.keyword_exempt_paths are accepted as lists; a blank or space-padded keyword and an empty path are refused', () => {
  const config = fixture('config/valid.json');
  config.privacy.third_party_keywords = ['sick leave', 'x', 'consulta médica'];
  config.privacy.keyword_exempt_paths = ['journal/', 'notes/health.md'];
  assert.deepEqual(validateConfig(config), []);
  for (const bad of ['', '   ', ' sick leave', 'sick leave ', 'sick\nleave']) {
    config.privacy.third_party_keywords = ['pregnancy', bad];
    assert.ok(validateConfig(config).some((e) => e.startsWith('$.privacy.third_party_keywords[1]')), JSON.stringify(bad));
  }
  config.privacy.third_party_keywords = 'sick leave';
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.privacy.third_party_keywords')));
  config.privacy.third_party_keywords = [];
  config.privacy.keyword_exempt_paths = [''];
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.privacy.keyword_exempt_paths[0]')));
});

test('machine.json names no lock and no snapshot: a new file without them is valid, and paths still requires the state files', () => {
  const machine = fixture('machine/valid.json');
  assert.equal('lock' in machine.paths, false);
  assert.equal('snapshot' in machine.paths, false);
  assert.deepEqual(validateMachine(machine), []);
  for (const key of ['watermark', 'last_run', 'log_dir']) {
    const without = fixture('machine/valid.json');
    delete without.paths[key];
    assert.deepEqual(validateMachine(without), [`$.paths.${key}: required`], key);
  }
  const unknown = fixture('machine/valid.json');
  unknown.paths.other = 'x';
  assert.notDeepEqual(validateMachine(unknown), [], 'any other unknown key under paths is still refused');
});

test('an older machine.json carrying paths.lock and paths.snapshot still reads: the keys are ignored and never handed on', () => {
  const older = fixture('machine/valid.json');
  older.paths.lock = '/home/ana/.local/state/brain-kit/brain-1a2b3c4d/lock';
  older.paths.snapshot = '/home/ana/.local/state/brain-kit/brain-1a2b3c4d/snapshot.json';
  assert.deepEqual(validateMachine(older), []);
  assert.deepEqual(validateMachine({ ...older, paths: { ...older.paths, lock: 5 } }), [], 'ignored whatever they hold');
  assert.equal(older.paths.lock.endsWith('/lock'), true, 'validating never changes what it was given');
  const dir = makeTempDir('brain-kit-machine-older-');
  writeFileSync(join(dir, 'machine.json'), JSON.stringify(older));
  const loaded = loadMachine(dir);
  assert.equal('lock' in loaded.paths, false);
  assert.equal('snapshot' in loaded.paths, false);
  assert.equal(loaded.paths.watermark, older.paths.watermark);
  assert.deepEqual(RETIRED_MACHINE_PATHS, ['lock', 'snapshot']);
  // Nothing but paths is touched, and a paths that is not an object is left for the schema.
  assert.deepEqual(withoutRetiredPaths({ vault_id: 'x' }), { vault_id: 'x' });
  assert.deepEqual(validateMachine({ ...older, paths: ['lock'] }), ['$.paths: expected object, got array']);
  assert.deepEqual(validateMachine({ ...older, paths: null }), ['$.paths: expected object, got null']);
});

test('the example machine.json is valid and canonical_path is required', () => {
  const machine = fixture('machine/valid.json');
  assert.deepEqual(validateMachine(machine), []);
  delete machine.canonical_path;
  assert.deepEqual(validateMachine(machine), ['$.canonical_path: required']);
});

test('loadConfig fails clearly outside a vault', () => {
  const dir = makeTempDir('brain-kit-');
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && /Not a brain-kit vault/.test(e.message));
});

test('loadConfig exposes schema errors on the thrown ConfigError', () => {
  const dir = makeTempDir('brain-kit-');
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ kit_version: '0.0.1' }));
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && e.errors.includes('$.lang: required'));
});
