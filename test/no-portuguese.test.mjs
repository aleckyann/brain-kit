// Guards the one claim task 8 exists to keep: the shipped ENGINE
// (src/, bin/, and lang/en/messages.json - the code, comments and
// English-pack prose that end up in the published tarball, as opposed
// to test fixtures or the pt-BR language pack) carries no stray
// Portuguese and no non-ASCII byte at all. A previous round reported
// cleaning this up and had not: two "verified vazio" comments were
// still sitting in src/rules/spec.mjs, quoting the original validator's
// own Portuguese message rather than describing it in English.
// Reporting a sweep is not the same as one, so this test is the sweep,
// run on every future change instead of trusted once.
//
// Fix round 1 (review): the first version of this file used `git
// ls-files` to list what to scan. That has two failure modes that both
// let the guard pass while defending nothing: it only lists files the
// INDEX already knows, so a brand-new source file - exactly what the
// normal order of work produces, write the file, then run the suite -
// is invisible to it until staged; and nothing in the original file
// ever checked that the listing came back non-empty, so pointing
// SCANNED_DIRS at a typo'd or deleted path left the two `for` loops
// below iterating zero times, both tests reporting "no violation
// found", and the whole guard silently defending nothing. Both are
// fixed here: `collectFiles` walks the real filesystem with
// `readdirSync` (so a file the index has never heard of is scanned the
// moment it exists on disk), and every test below asserts it scanned a
// non-trivial, specific number of files before trusting an empty
// violation list. A guard that can pass while scanning nothing is
// worse than no guard, because it also stops anyone looking by hand.
//
// Scope, and why it stops at src/, bin/ and lang/en/messages.json: this
// project's own claim about itself is "code, comments, identifiers and
// test names in English; every user-facing string comes from a
// language pack", and the language pack is part of that claim too -
// src/rules/spec.mjs and src/rules/house.mjs's own headers describe
// this task moving every user-facing sentence OUT of the rule modules
// and INTO lang/en/messages.json and lang/pt-BR/messages.json, so a
// guard that stopped at src/ and bin/ (fix round 0's own scope) would
// now be watching the wrong door: the prose moved, and the guard's
// boundary did not move with it. lang/en/messages.json ships in the
// published tarball exactly like src/ and bin/ do, so it gets the same
// two checks. Three places are still deliberately EXCLUDED, not
// overlooked: lang/pt-BR/messages.json IS the Portuguese language pack
// (lang.test.mjs already guards its own two properties, no em dash and
// no emoji); test/fixtures/config/valid-pt-BR.json exists specifically
// to prove the configuration accepts non-English labels, file names
// and column headings (config.test.mjs's own test names several of
// them); and README.pt-BR.md is a deliberate translation of the
// top-level README. Scanning any of those three for "no Portuguese"
// would be scanning them for failing to do their one job.
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
//
// Fix round 1, second correction: the word-list regex used to wrap
// every word in `\b...\b`. A word boundary needs a transition between a
// word character and a non-word character, and BOTH an underscore and
// every letter are word characters to `\b`, so a Portuguese word
// spelled as part of an identifier ("is_vazio", "vazioFlag") sits with
// no boundary on one or both sides and slips through structurally, not
// by chance. Dropping the anchors trades that structural blind spot for
// a plain substring search, which is the right side to err on for this
// specific word list: every word was hand-picked (see above) to not
// also be an English word or a common English substring, so a
// substring match over English-only source is not expected to fire on
// anything these words do not actually spell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const SCANNED = ['src', 'bin', 'lang/en/messages.json'];

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

// Case-insensitive, deliberately with NO \b anchors (see this file's
// own header for why): a plain alternation, matched as a substring.
function wordPattern() {
  return new RegExp(PORTUGUESE_WORDS.join('|'), 'i');
}

// Walks the REAL filesystem from each of `roots` (absolute or relative
// to `base`), never the git index, so a file that exists on disk but is
// not yet tracked (or not yet staged) is scanned exactly the same as
// one that is. A path naming a single file is included directly,
// without a directory read at all.
function collectFiles(roots, base = KIT_ROOT) {
  const files = [];
  function walk(path) {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        walk(join(path, entry.name));
      }
    } else if (st.isFile()) {
      files.push(path);
    }
  }
  for (const root of roots) {
    walk(join(base, root));
  }
  return files;
}

function findNonAsciiViolations(files) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) >= 128) {
        violations.push({ file, index: i, char: text[i] });
        break; // one report per file is enough to fail the test and name it
      }
    }
  }
  return violations;
}

function findWordListViolations(files, pattern) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const match = pattern.exec(text);
    if (match) violations.push({ file, word: match[0] });
  }
  return violations;
}

// A floor, not the exact count: this only needs to be high enough that
// a typo'd path (which would collect 0 or a handful of files from
// whatever unrelated directory the typo happened to resolve to) cannot
// pass it by accident, while staying below the real count so an
// ordinary future file addition or removal never breaks this test.
const MINIMUM_EXPECTED_FILES = 15;

test('the scan itself covers a real, non-trivial set of files, not zero and not the wrong directory', () => {
  const files = collectFiles(SCANNED);
  assert.ok(
    files.length >= MINIMUM_EXPECTED_FILES,
    `expected at least ${MINIMUM_EXPECTED_FILES} files under ${SCANNED.join(', ')}, found ${files.length}`,
  );
  // Pinned examples from two different scanned roots, and the one
  // scanned single file, so a walk that silently stopped recursing
  // into a subdirectory (src/rules/, src/commands/) cannot pass this
  // by having found plenty of files elsewhere.
  const relFiles = files.map((f) => relative(KIT_ROOT, f));
  assert.ok(relFiles.includes(join('src', 'rules', 'spec.mjs')), 'expected the walk to reach src/rules/');
  assert.ok(relFiles.includes(join('src', 'commands', 'validate.mjs')), 'expected the walk to reach src/commands/');
  assert.ok(relFiles.includes(join('bin', 'brain-kit.mjs')), 'expected the walk to reach bin/');
  assert.ok(relFiles.includes(join('lang', 'en', 'messages.json')), 'expected the single scanned file itself');
});

test('no file under src/, bin/, or the English language pack contains a non-ASCII byte', () => {
  const files = collectFiles(SCANNED);
  assert.ok(files.length >= MINIMUM_EXPECTED_FILES, 'the scan must not be empty for this assertion to mean anything');
  const violations = findNonAsciiViolations(files);
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${relative(KIT_ROOT, v.file)}: non-ASCII character at index ${v.index} ("${v.char}")`).join('\n'),
  );
});

test('no file under src/, bin/, or the English language pack contains a word from the fixed Portuguese list', () => {
  const files = collectFiles(SCANNED);
  assert.ok(files.length >= MINIMUM_EXPECTED_FILES, 'the scan must not be empty for this assertion to mean anything');
  const violations = findWordListViolations(files, wordPattern());
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${relative(KIT_ROOT, v.file)}: found Portuguese word "${v.word}"`).join('\n'),
  );
});

// --- the guard's own self-check: it must actually reject a real plant ------
//
// Everything above proves the CURRENT tree is clean; none of it proves
// the checking functions are capable of failing at all. A checker that
// always returns an empty violation list, whatever it is pointed at,
// would pass every test above too, which is exactly the "tool does
// nothing and looks fine" shape this whole round is about. These four
// tests point `collectFiles` at a real temporary directory this test
// builds and destroys itself, never at src/ or bin/, and prove the two
// checking functions actually flag what they are supposed to.
function withTempDir(build, use) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-kit-guard-selfcheck-'));
  try {
    build(dir);
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('self-check: the non-ASCII checker flags a planted file with a real accented character', () => {
  withTempDir(
    (dir) => writeFileSync(join(dir, 'leak.mjs'), '// nao deveria estar aqui: café\n'),
    (dir) => {
      const files = collectFiles(['.'], dir);
      assert.equal(files.length, 1, 'the plant itself must be found');
      const violations = findNonAsciiViolations(files);
      assert.equal(violations.length, 1);
      assert.match(violations[0].file, /leak\.mjs$/);
    },
  );
});

test('self-check: the non-ASCII checker reports nothing for a planted file that is pure ASCII', () => {
  withTempDir(
    (dir) => writeFileSync(join(dir, 'clean.mjs'), '// nothing to see here\n'),
    (dir) => {
      const files = collectFiles(['.'], dir);
      assert.deepEqual(findNonAsciiViolations(files), []);
    },
  );
});

test('self-check: the word-list checker flags a planted Portuguese word even spelled inside an identifier, with no space around it', () => {
  withTempDir(
    (dir) => writeFileSync(join(dir, 'leak.mjs'), 'export const is_vazio = true; // an identifier, not a standalone word\n'),
    (dir) => {
      const files = collectFiles(['.'], dir);
      assert.equal(files.length, 1);
      const violations = findWordListViolations(files, wordPattern());
      assert.equal(violations.length, 1, 'a word-boundary-anchored pattern would miss this on purpose; this checker must not');
      assert.match(violations[0].file, /leak\.mjs$/);
    },
  );
});

test('self-check: the word-list checker reports nothing for a planted file using none of the listed words', () => {
  withTempDir(
    (dir) => writeFileSync(join(dir, 'clean.mjs'), 'export const isEmpty = true;\n'),
    (dir) => {
      const files = collectFiles(['.'], dir);
      assert.deepEqual(findWordListViolations(files, wordPattern()), []);
    },
  );
});

test('self-check: collectFiles walks a real, previously untracked file the moment it exists on disk, with no git index involved at all', () => {
  withTempDir(
    (dir) => {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'nested', 'brand-new.mjs'), '// this file was never git add-ed, staged, or committed\n');
    },
    (dir) => {
      const files = collectFiles(['.'], dir);
      assert.equal(files.length, 1);
      assert.match(files[0], /nested[/\\]brand-new\.mjs$/);
    },
  );
});
