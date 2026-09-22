import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { createTranslator, loadMessages, interpolate, REFERENCE_LANG, SUPPORTED_LANGS } from '../src/lang.mjs';

const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('kitVersion matches package.json', () => {
  assert.equal(kitVersion(), pkg.version);
});

test('every supported pack has the same keys as the reference pack', () => {
  const reference = loadMessages(REFERENCE_LANG);
  for (const lang of SUPPORTED_LANGS) {
    const pack = loadMessages(lang);
    assert.deepEqual(Object.keys(pack).sort(), Object.keys(reference).sort(), `key set differs in ${lang}`);
    for (const key of Object.keys(reference)) {
      assert.equal(typeof pack[key], 'string', `${lang}.${key} must be a string`);
      assert.ok(pack[key].length > 0, `${lang}.${key} must not be empty`);
      assert.deepEqual(placeholders(pack[key]), placeholders(reference[key]), `placeholders differ for ${lang}.${key}`);
    }
  }
});

test('pt-BR values contain no em dash and no emoji', () => {
  for (const [key, value] of Object.entries(loadMessages('pt-BR'))) {
    assert.doesNotMatch(value, /\u2014/, `${key} contains an em dash`);
    assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, `${key} contains an emoji`);
  }
});

test('interpolate replaces known placeholders and keeps unknown ones', () => {
  assert.equal(interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
});

// An array param joins with ", ": the one list-formatting decision this
// module owns so no rule module has to make it (src/rules/house.mjs's
// type-enum and extension-fields rules used to call `.join(', ')`
// themselves before passing an already-formed string; they now pass
// the array through and this is where it becomes text).
test('interpolate joins an array param with ", ", but stringifies a non-array value plainly', () => {
  assert.equal(interpolate('allowed: {list}', { list: ['a', 'b', 'c'] }), 'allowed: a, b, c');
  assert.equal(interpolate('allowed: {list}', { list: [] }), 'allowed: ');
  assert.equal(interpolate('count: {n}', { n: 3 }), 'count: 3');
});

test('translator returns the requested language', () => {
  const t = createTranslator('en');
  assert.match(t('cli.unknown_command', { command: 'zzz' }), /zzz/);
});

test('translator falls back to the reference pack and warns once', () => {
  const warnings = [];
  const packs = {
    'pt-BR': { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', 'only.here': 'so em pt-BR', 'shared': 'compartilhado' },
    en: { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', shared: 'shared' },
  };
  const t = createTranslator('en', { warn: (m) => warnings.push(m), packs });
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /only\.here/);
});

test('translator throws on an unknown key', () => {
  const t = createTranslator('pt-BR');
  assert.throws(() => t('does.not.exist'), /Unknown message key/);
});

test('unsupported language falls back to the reference pack with a warning', () => {
  const warnings = [];
  const t = createTranslator('xx', { warn: (m) => warnings.push(m) });
  assert.match(t('cli.unknown_command', { command: 'q' }), /q/);
  assert.equal(warnings.length, 1);
});
