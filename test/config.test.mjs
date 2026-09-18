import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig, validateMachine, findMachineOnlyKeys, loadConfig, ConfigError, CONFIG_FILENAME } from '../src/config.mjs';

const fixture = (name) => JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', name), 'utf8'));

test('the example config is valid', () => {
  assert.deepEqual(validateConfig(fixture('config/valid.json')), []);
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
test('the pt-BR sibling fixture proves the configuration accepts non-English labels, file names and column headings', () => {
  const config = fixture('config/valid-pt-BR.json');
  assert.deepEqual(validateConfig(config), []);
  assert.equal(config.lang, 'pt-BR');
  // A non-English column heading, under a schema key (taxonomy.columns)
  // that only ever requires a string.
  assert.equal(config.taxonomy.columns.followups.what, 'O que');
  // A non-English file name, under taxonomy.files (also free-form).
  assert.equal(config.taxonomy.files.promises, 'pending/promessas.md');
  // A non-English extension field name, under frontmatter.extensions
  // (the map's own keys are free-form, not drawn from any enum).
  assert.ok('situacao' in config.frontmatter.extensions, 'expected a non-English extension field name');
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
