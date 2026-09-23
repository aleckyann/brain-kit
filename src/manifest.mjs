import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SUPPORTED_LANGS } from './lang.mjs';

// .brain-kit/manifest.json: every file `init` (and later `adopt`) wrote
// into a vault, whose it is, and the sha256 of its bytes at the moment
// it was written.
//
//   managed  the kit owns it: `update` may replace it, but only when its
//            bytes still hash to what is recorded here, so a person's
//            edit is never overwritten.
//   seeded   the kit only started it: from the moment of init it is the
//            person's note, and `update` never touches it.
//
// Shape: { lang?, files: [{ path, sha256, class }] }, `path` vault-relative
// with forward slashes. Nothing else is allowed, at either level, so a
// field a later version adds has to be added here on purpose.
//
// `lang` is the language the vault was installed or adopted in: the
// skeleton init wrote from, or the language adopt inferred the
// configuration in. It is fixed from then on: `update` refuses to refresh
// managed files when the configuration's `lang` no longer matches it,
// since refreshing them from the other language's skeleton would rewrite
// every untouched contract file into text whose links point at folders
// the vault does not have. Optional, so a manifest written before it
// existed still reads.
//
// `sha256` is the hash of the file's bytes with every CRLF read as LF, so
// a checkout that converts line endings still reads as untouched. init
// writes LF, where the two are the same bytes. update compares managed
// files only; a seeded file's hash (every file adopt records) is never
// compared with anything.
//
// readManifest THROWS on every way the file can fail to be a real
// manifest: missing, unreadable, empty, not JSON, or not this shape,
// including a manifest with no entry at all. Each of those, read as "an
// empty manifest", would let `update` conclude there is nothing to update
// and exit zero saying nothing, which is the one outcome worse than an
// error here. writeManifest checks the same shape before it writes, so
// this module never produces a file it would itself refuse to read.

export const MANIFEST_PATH = '.brain-kit/manifest.json';
export const MANIFEST_CLASSES = Object.freeze(['managed', 'seeded']);

const TOP_KEYS = Object.freeze(['lang', 'files']);
const ENTRY_KEYS = Object.freeze(['path', 'sha256', 'class']);
const SHA256 = /^[0-9a-f]{64}$/;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A vault-relative path this module will accept: non-empty, forward
// slashes only, not absolute, and no segment that is empty, "." or "..",
// so no entry can name a file outside the vault it describes.
function isVaultRelative(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function manifestErrors(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['$: must be an object'];
  for (const key of Object.keys(manifest)) {
    if (!TOP_KEYS.includes(key)) errors.push(`$.${key}: unknown key`);
  }
  if (Object.hasOwn(manifest, 'lang') && !SUPPORTED_LANGS.includes(manifest.lang)) {
    errors.push(`$.lang: must be one of ${SUPPORTED_LANGS.join(', ')}`);
  }
  if (!Array.isArray(manifest.files)) {
    errors.push('$.files: must be an array');
    return errors;
  }
  if (manifest.files.length === 0) errors.push('$.files: must list at least one file');
  const seen = new Set();
  manifest.files.forEach((entry, index) => {
    const at = `$.files[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) errors.push(`${at}.${key}: unknown key`);
    }
    if (!isVaultRelative(entry.path)) errors.push(`${at}.path: must be a vault-relative path with forward slashes`);
    else if (seen.has(entry.path)) errors.push(`${at}.path: "${entry.path}" is listed twice`);
    else seen.add(entry.path);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) errors.push(`${at}.sha256: must be 64 lowercase hex characters`);
    if (!MANIFEST_CLASSES.includes(entry.class)) errors.push(`${at}.class: must be one of ${MANIFEST_CLASSES.join(', ')}`);
  });
  return errors;
}

export function readManifest(root) {
  const file = join(root, MANIFEST_PATH);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ManifestError(`Cannot read ${file}: ${error.message}`);
  }
  if (text.trim() === '') throw new ManifestError(`${file} is empty`);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${file} is not JSON: ${error.message}`);
  }
  const errors = manifestErrors(manifest);
  if (errors.length > 0) throw new ManifestError(`${file} is not a valid manifest:\n  ${errors.join('\n  ')}`);
  return manifest;
}

// The manifest's text, after the same check readManifest applies, so a
// caller that writes the file itself (init, creating every file
// exclusively) still never writes one this module would refuse to read.
export function serializeManifest(manifest) {
  const errors = manifestErrors(manifest);
  if (errors.length > 0) throw new ManifestError(`Refusing to write an invalid manifest:\n  ${errors.join('\n  ')}`);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeManifest(root, manifest) {
  const text = serializeManifest(manifest);
  const file = join(root, MANIFEST_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
