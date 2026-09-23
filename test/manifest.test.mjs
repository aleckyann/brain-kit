// .brain-kit/manifest.json: the record `init` leaves of every file it
// wrote and whose it is ('managed' by the kit, or 'seeded' for the person
// to own), with the sha256 each managed file had when it was written (a
// seeded file carries none: see src/manifest.mjs). `update` reads
// it to tell an untouched file from an edited one, so a manifest that
// reads as "nothing here" when it is really missing or broken would let
// `update` decide every file is untouched, or that there is nothing to
// update, and say nothing. readManifest therefore THROWS on every way the
// file can fail to be a real manifest, and this file proves each one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_PATH, ManifestError, readManifest, writeManifest, sha256Of } from '../src/manifest.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = '0123456789abcdef'.repeat(4);

function sample() {
  return {
    files: [
      { path: '.githooks/pre-push', sha256: SHA_A, class: 'managed' },
      { path: 'people/index.md', class: 'seeded' },
    ],
  };
}

function rootWith(content) {
  const root = makeTempDir('brain-kit-manifest-');
  mkdirSync(join(root, '.brain-kit'));
  writeFileSync(join(root, MANIFEST_PATH), content);
  return root;
}

test('the manifest lives at .brain-kit/manifest.json', () => {
  assert.equal(MANIFEST_PATH, '.brain-kit/manifest.json');
});

test('writeManifest then readManifest returns exactly what was written, creating .brain-kit/', () => {
  const root = makeTempDir('brain-kit-manifest-');
  writeManifest(root, sample());
  assert.ok(existsSync(join(root, '.brain-kit', 'manifest.json')));
  assert.deepEqual(readManifest(root), sample());
  assert.match(readFileSync(join(root, MANIFEST_PATH), 'utf8'), /\n$/);
});

test('sha256Of hashes bytes, as lowercase hex', () => {
  assert.equal(sha256Of(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a missing manifest THROWS rather than reading as empty', () => {
  const root = makeTempDir('brain-kit-manifest-');
  assert.throws(() => readManifest(root), ManifestError);
});

test('a manifest path that is a directory THROWS', () => {
  const root = makeTempDir('brain-kit-manifest-');
  mkdirSync(join(root, MANIFEST_PATH), { recursive: true });
  assert.throws(() => readManifest(root), ManifestError);
});

test('an empty manifest file THROWS', () => {
  assert.throws(() => readManifest(rootWith('')), /is empty/);
  assert.throws(() => readManifest(rootWith('  \n')), /is empty/);
});

test('a manifest that is not JSON THROWS', () => {
  assert.throws(() => readManifest(rootWith('{ files: [')), ManifestError);
});

const INVALID = [
  ['a JSON array', []],
  ['null', null],
  ['an object with no files', {}],
  ['files that is not an array', { files: {} }],
  ['files with no entry at all', { files: [] }],
  ['an unknown top-level key', { ...sample(), extra: 1 }],
  ['an entry with an unknown key', { files: [{ ...sample().files[0], mode: 1 }] }],
  ['an entry with no path', { files: [{ sha256: SHA_A, class: 'managed' }] }],
  ['an entry with an empty path', { files: [{ path: '', sha256: SHA_A, class: 'managed' }] }],
  ['an absolute path', { files: [{ path: '/etc/passwd', sha256: SHA_A, class: 'managed' }] }],
  ['a path that climbs out', { files: [{ path: 'people/../../x.md', sha256: SHA_A, class: 'seeded' }] }],
  ['a Windows separator', { files: [{ path: 'people\\x.md', sha256: SHA_A, class: 'seeded' }] }],
  ['a sha256 that is too short', { files: [{ path: 'a.md', sha256: 'abc', class: 'managed' }] }],
  ['a sha256 in upper case', { files: [{ path: 'a.md', sha256: SHA_A.toUpperCase(), class: 'managed' }] }],
  ['a managed entry with no sha256', { files: [{ path: 'a.md', class: 'managed' }] }],
  ['a managed entry whose sha256 is not a string', { files: [{ path: 'a.md', sha256: 1, class: 'managed' }] }],
  ['an unknown class', { files: [{ path: 'a.md', sha256: SHA_A, class: 'owned' }] }],
  ['no class', { files: [{ path: 'a.md', sha256: SHA_A }] }],
  ['the same path twice', { files: [sample().files[1], { ...sample().files[1], class: 'managed' }] }],
];

for (const [name, value] of INVALID) {
  test(`a schema-invalid manifest THROWS on read: ${name}`, () => {
    assert.throws(() => readManifest(rootWith(`${JSON.stringify(value)}\n`)), ManifestError);
  });
  test(`writeManifest refuses to write a schema-invalid manifest: ${name}`, () => {
    const root = makeTempDir('brain-kit-manifest-');
    assert.throws(() => writeManifest(root, value), ManifestError);
    assert.equal(existsSync(join(root, MANIFEST_PATH)), false);
  });
}

// Slice D, task 5 fix round: the manifest may record the vault's language
// at its top level. Optional, so a manifest written before the field
// existed still reads; when present, only a shipped language is a value.
test('lang is optional at the top level, and must be a supported language when present', () => {
  for (const lang of ['en', 'pt-BR']) {
    const root = rootWith(JSON.stringify({ lang, ...sample() }));
    assert.equal(readManifest(root).lang, lang);
    // and writeManifest writes it, reading back exactly.
    const written = makeTempDir('brain-kit-manifest-');
    writeManifest(written, { lang, ...sample() });
    assert.deepEqual(readManifest(written), { lang, ...sample() });
  }
  assert.equal(readManifest(rootWith(JSON.stringify(sample()))).lang, undefined, 'a manifest without lang still reads');
  for (const bad of ['fr', '', null, 1, ['en']]) {
    assert.throws(() => readManifest(rootWith(JSON.stringify({ lang: bad, ...sample() }))), /\$\.lang: must be one of en, pt-BR|\$\.lang: must be one of pt-BR, en/, String(bad));
    assert.throws(() => writeManifest(makeTempDir('brain-kit-manifest-'), { lang: bad, ...sample() }), ManifestError, String(bad));
  }
});

// Ruled at the close of slice 1D: a seeded entry carries NO hash. The
// manifest is committed, and update never reads a seeded hash.
test('writeManifest refuses a seeded entry that carries a sha256, valid or not, and writes nothing', () => {
  for (const sha256 of [SHA_B, 'abc', null]) {
    const root = makeTempDir('brain-kit-manifest-');
    assert.throws(() => writeManifest(root, { files: [{ path: 'a.md', sha256, class: 'seeded' }] }), /a seeded file carries no hash/);
    assert.equal(existsSync(join(root, MANIFEST_PATH)), false);
  }
});

test('an older manifest whose seeded entries carry a sha256 still reads, and the field is dropped, never handed on', () => {
  for (const sha256 of [SHA_B, 'ABC', 7]) {
    const root = rootWith(JSON.stringify({ files: [{ path: '.githooks/pre-push', sha256: SHA_A, class: 'managed' }, { path: 'a.md', sha256, class: 'seeded' }] }));
    const read = readManifest(root);
    assert.deepEqual(read.files, [{ path: '.githooks/pre-push', sha256: SHA_A, class: 'managed' }, { path: 'a.md', class: 'seeded' }]);
    // and what reads writes back without it.
    const again = makeTempDir('brain-kit-manifest-');
    writeManifest(again, read);
    assert.doesNotMatch(readFileSync(join(again, MANIFEST_PATH), 'utf8'), new RegExp(`"sha256": ${JSON.stringify(sha256)}`));
  }
});
