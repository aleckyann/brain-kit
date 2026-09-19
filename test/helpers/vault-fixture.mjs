// Test-only scaffolding: builds a throwaway vault on disk from a plain
// object, so no test in this suite hand-rolls directory creation. Lives
// under test/, not src/: it is never shipped and never imported by the
// engine itself.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Every vault this helper creates, so the process can remove them when it
// ends. Without this the suite left one directory per call behind: a machine
// running it through this slice accumulated more than twenty-four thousand of
// them and 2.7 GB in the system temporary directory, and two implementers
// independently reported test flakiness that traced back to it. A test helper
// that leaks is a test helper that eventually decides whether a run passes.
const createdVaults = [];
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // `exit` only admits synchronous work, which is why this is the removal
  // call that blocks. It is best effort by design: a run killed by a signal
  // this handler does not see still leaves directories, and that is a better
  // trade than a handler that can itself fail a passing run.
  process.on('exit', () => {
    for (const dir of createdVaults) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A vault a test deliberately made unreadable must not fail the run
        // on the way out.
      }
    }
  });
}

export function makeVault({ files = {}, config = {} } = {}) {
  registerCleanup();
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-vault-'));
  createdVaults.push(root);
  writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(deepMerge(baseConfig(), config), null, 2));
  for (const [relPath, content] of Object.entries(files)) {
    writeVaultFile(root, relPath, content);
  }
  return root;
}
