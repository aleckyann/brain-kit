// Guards the one claim task 8 exists to keep: the shipped ENGINE
// (src/ and bin/, the code and comments that end up in the published
// tarball, as opposed to test fixtures or the pt-BR language pack)
// carries no stray Portuguese and no non-ASCII byte at all. A previous
// round reported cleaning this up and had not: two "verified vazio"
// comments were still sitting in src/rules/spec.mjs, quoting the
// original validator's own Portuguese message rather than describing
// it in English. Reporting a sweep is not the same as one, so this
// test is the sweep, run on every future change instead of trusted
// once.
//
// Scope, and why it stops at src/ and bin/: those two directories are
// this project's own claim about itself ("code, comments, identifiers
// and test names in English; every user-facing string comes from a
// language pack"), and they are also the one place a Portuguese phrase
// could hide silently, since nobody reads English-only source expecting
// to find one. Three places are deliberately EXCLUDED, not overlooked:
// lang/pt-BR/messages.json IS the Portuguese language pack (lang.test.mjs
// already guards its own two properties, no em dash and no emoji);
// test/fixtures/config/valid-pt-BR.json exists specifically to prove the
// configuration accepts non-English labels, file names and column
// headings (config.test.mjs's own test names three of them); and
// README.pt-BR.md is a deliberate translation of the top-level README.
// Scanning any of those three for "no Portuguese" would be scanning
// them for failing to do their one job.
//
// Two independent checks, since either alone misses a real leak: a
// non-ASCII byte catches every accented word ("não", "situação",
// "vazio" has none but "criação" does) and the em dash itself; the
// fixed word list below catches the UNACCENTED spelling of exactly the
// words this project has already leaked once, which a byte-code check
// cannot see at all ("vazio", "nao" with the tilde dropped, "vinculo"
// with no cedilla to trip on). Each word was chosen because it already
// leaked into this repository's OWN source or tests at least once
// (see git history: "verified vazio" in src/rules/spec.mjs and
// test/rules-spec.test.mjs; "vinculo" as a test's own extension field
// name in test/rules-house.test.mjs; "situacao", "confidencial",
// "autor", "idioma", "curadoria", "curador" as taxonomy or extension
// values in the shared config fixture before it was split) or is a
// common Portuguese function word ("nao", "sao", "voce", "entao") that
// would only ever appear in stray prose, never in this project's own
// English vocabulary. None of them is also an English word, so the
// list cannot flag itself by matching ordinary source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const SCANNED_DIRS = ['src/', 'bin/'];

const PORTUGUESE_WORDS = [
  'vazio',
  'nao',
  'sao',
  'voce',
  'entao',
  'situacao',
  'vinculo',
  'confidencial',
  'autor',
  'idioma',
  'curadoria',
  'curador',
  'codigo',
  'configuracao',
  'verificacao',
  'criacao',
  'correcao',
  'aviso',
];

function wordPattern() {
  return new RegExp(`\\b(?:${PORTUGUESE_WORDS.join('|')})\\b`, 'i');
}

function scannedSourceFiles() {
  const r = spawnSync('git', ['ls-files', '-z', ...SCANNED_DIRS], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ls-files failed');
  return r.stdout.split('\0').filter(Boolean);
}

test('no file under src/ or bin/ contains a non-ASCII byte', () => {
  for (const file of scannedSourceFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (let i = 0; i < text.length; i++) {
      assert.ok(text.charCodeAt(i) < 128, `${file}: non-ASCII character at index ${i} ("${text[i]}")`);
    }
  }
});

test('no file under src/ or bin/ contains a word from the fixed Portuguese list', () => {
  const pattern = wordPattern();
  for (const file of scannedSourceFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    const match = pattern.exec(text);
    assert.equal(match, null, `${file}: found Portuguese word "${match?.[0]}" (see this file's own word list)`);
  }
});
