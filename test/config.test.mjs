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
