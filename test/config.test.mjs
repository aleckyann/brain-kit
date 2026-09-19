import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig, validateMachine, findMachineOnlyKeys, loadConfig, ConfigError, CONFIG_FILENAME } from '../src/config.mjs';

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
  // parsed back from its JSON escape (— in the file, ASCII on
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

test('curate.schedule entries must be HH:MM', () => {
  const config = fixture('config/valid.json');
  config.curate.schedule = ['9h30'];
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.curate.schedule[0]')));
});

test('the example machine.json is valid and canonical_path is required', () => {
  const machine = fixture('machine/valid.json');
  assert.deepEqual(validateMachine(machine), []);
  delete machine.canonical_path;
  assert.deepEqual(validateMachine(machine), ['$.canonical_path: required']);
});

test('loadConfig fails clearly outside a vault', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-kit-'));
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && /Not a brain-kit vault/.test(e.message));
});

test('loadConfig exposes schema errors on the thrown ConfigError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-kit-'));
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ kit_version: '0.0.1' }));
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && e.errors.includes('$.lang: required'));
});
