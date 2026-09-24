// What every hook needs before it can decide anything: the event JSON Claude
// Code wrote on standard input, and the vault that event is about.
//
// THE SENTINEL. A vault is found from the payload's `cwd` (else
// CLAUDE_PROJECT_DIR, else the process's own directory) by findVaultRoot,
// which already requires brain-kit.config.json and index.md side by side.
// On top of that the configuration must parse as JSON and carry a
// `kit_version` of the form x.y.z. Nothing more: a vault whose
// configuration has some other error is still a vault, and the hooks must
// treat it as one (a hook that only recognised a perfect vault would fall
// silent exactly when the vault needs attention). What the sentinel keeps
// out is another person's repository that merely happens to hold an
// index.md: 14/09/2026, a dirty repository that was not a vault must never
// be told to curate.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONFIG_FILENAME } from '../config.mjs';
import { decodeBytes } from '../io.mjs';
import { resolveLang, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';

const KIT_VERSION = /^\d+\.\d+\.\d+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The event JSON, which must be an object.
export function parseHookPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: 'the event is not a JSON object' };
  return { ok: true, payload };
}

function startDirOf(payload, env) {
  if (typeof payload.cwd === 'string' && payload.cwd !== '') return payload.cwd;
  if (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== '') return env.CLAUDE_PROJECT_DIR;
  return process.cwd();
}

// `{ root, config, lang }` for the vault the event is about, `root` its real
// path; `{ root: null, why }` when there is none by the sentinel.
export function resolveHookVault(payload, env) {
  const found = findVaultRoot(startDirOf(payload, env));
  if (found === null) return { root: null, why: 'no-vault' };
  let root;
  let config;
  try {
    root = realpathSync(found);
    config = JSON.parse(decodeBytes(readFileSync(join(root, CONFIG_FILENAME))));
  } catch {
    return { root: null, why: 'invalid-sentinel' };
  }
  if (!isPlainObject(config) || typeof config.kit_version !== 'string' || !KIT_VERSION.test(config.kit_version)) {
    return { root: null, why: 'invalid-sentinel' };
  }
  const lang = SUPPORTED_LANGS.includes(config.lang) ? config.lang : resolveLang(env);
  return { root, config, lang };
}

// The name a person knows the vault by: its configured title, else its
// folder's name.
export function vaultTitle(root, config) {
  const title = isPlainObject(config.vault) ? config.vault.title : undefined;
  if (typeof title === 'string' && title.trim() !== '') return title;
  return basename(root) || root;
}
