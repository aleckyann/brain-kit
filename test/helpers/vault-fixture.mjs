// Test-only scaffolding: builds a throwaway vault on disk from a plain
// object, so no test in this suite hand-rolls directory creation. Lives
// under test/, not src/: it is never shipped and never imported by the
// engine itself.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_FILENAME } from '../../src/config.mjs';
import { KIT_ROOT } from '../../src/version.mjs';

function baseConfig() {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Merges `override` onto `base`. An array replaces the base array outright
// (there is no sane way to merge e.g. validate.ignore_paths element by
// element); a plain object merges key by key, recursively, so a test can
// override one nested setting without restating the whole valid.json
// fixture just to flip it.
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

// Writes `content` at `relPath` under `root`, creating any missing parent
// directories, and returns the full path written. Exported on its own
// because a spec object can describe file content but not a symlink: a test
// that needs one lays down the real file with this first, then calls
// fs.symlinkSync itself once makeVault has returned the root.
export function writeVaultFile(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

// Creates a temporary directory, writes brain-kit.config.json (the valid
// fixture with `config` deep-merged over it), writes every entry of `files`
// (a map of vault-relative path -> content), and returns the vault root.
export function makeVault({ files = {}, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-vault-'));
  writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(deepMerge(baseConfig(), config), null, 2));
  for (const [relPath, content] of Object.entries(files)) {
    writeVaultFile(root, relPath, content);
  }
  return root;
}
