import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from './schema.mjs';
import { KIT_ROOT } from './version.mjs';
import { decodeBytes } from './io.mjs';

export const CONFIG_FILENAME = 'brain-kit.config.json';
export const MACHINE_FILENAME = 'machine.json';

// Keys that execute something or point at this machine. They belong in
// machine.json (outside the vault, never in a pull request) and are rejected
// anywhere inside the versioned config, at any depth: the versioned config is
// writable by the agent and travels through PRs, so a key like notify_command
// there would be a way to run commands via a merged PR.
export const MACHINE_ONLY_KEYS = Object.freeze([
  'claude_bin', 'model', 'network_check', 'notify_command', 'transcripts_dir', 'path_extra',
  'canonical_path', 'state_dir', 'paths', 'log_retention_days', 'keep_stream', 'briefing_task_id',
]);

export class ConfigError extends Error {
  constructor(message, errors = []) {
    super(errors.length ? `${message}\n  ${errors.join('\n  ')}` : message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const schemaCache = new Map();
function loadSchema(name) {
  if (!schemaCache.has(name)) {
    schemaCache.set(name, JSON.parse(readFileSync(join(KIT_ROOT, 'schema', name), 'utf8')));
  }
  return schemaCache.get(name);
}

export function findMachineOnlyKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findMachineOnlyKeys(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, sub] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (MACHINE_ONLY_KEYS.includes(key)) found.push(here);
      findMachineOnlyKeys(sub, here, found);
    }
  }
  return found;
}

export function validateConfig(config) {
  const errors = validateSchema(config, loadSchema('config.schema.json'));
  for (const where of findMachineOnlyKeys(config)) {
    errors.push(`${where}: machine-only key is not allowed in the versioned config (it belongs in ${MACHINE_FILENAME})`);
  }
  errors.push(...confidentialFieldErrors(config));
  return errors;
}

// privacy.confidential_field names the frontmatter field the privacy rule
// reads to find a note marked confidential. The schema holds it to the
// shape of a key and no more, so a misspelt name ("confidental") passes
// it, the rule then watches a field no note carries, and a note marked
// confidential outside every confidential directory is never reported.
// That is the rule silently disabled by a typo, so the name must be one
// the same configuration declares, as a boolean, under
// frontmatter.extensions. (A name like "toString" or "constructor" finds
// something on Object.prototype, but never anything whose `type` is
// "boolean", so the type check refuses it too.)
function confidentialFieldErrors(config) {
  const field = config?.privacy?.confidential_field;
  if (typeof field !== 'string') return [];
  const extensions = config?.frontmatter?.extensions;
  const declared = extensions !== null && typeof extensions === 'object' ? extensions[field] : null;
  if (declared?.type === 'boolean') return [];
  return [`$.privacy.confidential_field: "${field}" must name a boolean extension declared in frontmatter.extensions`];
}

// Keys under `paths` that machine.json files written before slice 1C carry:
// the lock and the session snapshot, which used to live in the state
// directory and now live in the repository (src/guards/location.mjs).
// Nothing reads them any more and init no longer writes them, but an older
// file carrying them must still read: they are ignored, never an error, and
// never handed on, so no caller can take a lock at a path the guards do not
// use.
export const RETIRED_MACHINE_PATHS = Object.freeze(['lock', 'snapshot']);

// `machine` without the retired `paths` keys; every other value, and
// anything that is not the expected shape, is left for the schema to judge.
export function withoutRetiredPaths(machine) {
  const paths = machine?.paths;
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) return machine;
  const kept = { ...paths };
  for (const key of RETIRED_MACHINE_PATHS) delete kept[key];
  return { ...machine, paths: kept };
}

export function validateMachine(machine) {
  return validateSchema(withoutRetiredPaths(machine), loadSchema('machine.schema.json'));
}

// Decoded the one way every scanner in this project decodes bytes
// (src/io.mjs, decodeBytes), because this file is where
// `privacy.secret_patterns` comes from, and a pattern decoded differently
// from the content it is matched against matches nothing (final fix round
// 2). For a file that is valid UTF-8, which is every file an editor writes
// by default, this reads exactly what it always read; for one holding a
// byte from another encoding, that byte is itself rather than a
// replacement character no pattern can match.
function readJson(file) {
  try {
    return JSON.parse(decodeBytes(readFileSync(file)));
  } catch (error) {
    throw new ConfigError(`Cannot parse ${file}: ${error.message}`);
  }
}

export function loadConfig(vaultDir) {
  const file = join(vaultDir, CONFIG_FILENAME);
  if (!existsSync(file)) throw new ConfigError(`Not a brain-kit vault: ${CONFIG_FILENAME} not found in ${vaultDir}`);
  const config = readJson(file);
  const errors = validateConfig(config);
  if (errors.length) throw new ConfigError(`Invalid ${file}`, errors);
  return config;
}

export function loadMachine(stateDir) {
  const file = join(stateDir, MACHINE_FILENAME);
  if (!existsSync(file)) throw new ConfigError(`Machine file not found: ${file} (created by brain-kit init from phase 1 onward)`);
  const machine = withoutRetiredPaths(readJson(file));
  const errors = validateMachine(machine);
  if (errors.length) throw new ConfigError(`Invalid ${file}`, errors);
  return machine;
}
