import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { validateSchema } from './schema.mjs';
import { KIT_ROOT } from './version.mjs';
import { decodeBytes } from './io.mjs';
import { unsafeRuleCharacters } from './curate/rule-path.mjs';

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

// The machine file's schema, for a caller that needs to know which keys it
// declares and their types (`machine set`), not only whether a value passes.
export function machineSchema() {
  return loadSchema('machine.schema.json');
}

// Values the schema accepts but the next run cannot use. THE ONE CHECK, read
// by every reader of machine.json through validateMachine (`machine set`
// before it writes, `machine register`, `doctor`'s machine-valid, init,
// loadMachine), so the command that writes a value and the check that
// judges it never disagree. The schema says "a string" or "a list of
// strings"; what breaks a scheduled round is narrower:
//   - an empty or blank string where a path or a program is expected
//     (claude_bin, canonical_path, state_dir, transcripts_dir, every paths
//     entry): the watermark written nowhere, a binary with no name;
//   - an empty `model`: null is how the default model is asked for;
//   - an argument vector with no element, or whose first element is empty
//     (network_check, notify_command): a check that runs nothing and so
//     passes, which is the "no network on resume" failure again, or a
//     program with no name;
//   - a path_extra entry that is neither absolute nor under `~/`: resolved
//     against whatever directory a run starts in, it names a different
//     directory every time;
//   - a transcripts_dir that is neither absolute nor under `~/`, for the
//     same reason, and because the round's read evidence compares the
//     absolute path the model reads with the path the plan listed: a
//     relative root makes every transcript unreadable as evidence;
//   - a transcripts_dir holding a character no read permission can name
//     exactly (src/curate/rule-path.mjs): every transcript under it would
//     be listed unreadable and stop every round, so it is said once here.
//     Spaces and accents are fine (measured);
//   - a paths.legacy_lock that is not an absolute path (null turns the
//     bridge off): the legacy job locks one file, and a relative name, or
//     one under `~/`, is a different file for every directory a writer
//     starts in, or none at all (src/guards/legacy-lock.mjs).
const MACHINE_PATH_KEYS = Object.freeze(['canonical_path', 'claude_bin', 'state_dir', 'transcripts_dir']);
const MACHINE_ARGV_KEYS = Object.freeze(['network_check', 'notify_command']);

function isBlank(value) {
  return typeof value === 'string' && value.trim() === '';
}

export function machineValueErrors(machine) {
  if (machine === null || typeof machine !== 'object' || Array.isArray(machine)) return [];
  const errors = [];
  for (const key of MACHINE_PATH_KEYS) {
    if (isBlank(machine[key])) errors.push(`$.${key}: must not be empty`);
  }
  const transcripts = machine.transcripts_dir;
  if (typeof transcripts === 'string' && !isBlank(transcripts) && !isAbsolute(transcripts) && transcripts !== '~' && !transcripts.startsWith('~/')) {
    errors.push('$.transcripts_dir: must be an absolute directory or start with ~/');
  }
  const unsafe = typeof transcripts === 'string' ? unsafeRuleCharacters(transcripts) : [];
  if (unsafe.length > 0) {
    errors.push(`$.transcripts_dir: must not hold ${unsafe.join(' ')}: a read permission cannot name such a path exactly (spaces and accents are fine)`);
  }
  if (isBlank(machine.model)) errors.push('$.model: must not be empty (null asks for the default model)');
  const paths = machine.paths;
  if (paths !== null && typeof paths === 'object' && !Array.isArray(paths)) {
    for (const [key, value] of Object.entries(paths)) {
      if (isBlank(value)) errors.push(`$.paths.${key}: must not be empty`);
    }
    const legacy = paths.legacy_lock;
    if (typeof legacy === 'string' && !isBlank(legacy) && !isAbsolute(legacy)) {
      errors.push('$.paths.legacy_lock: must be an absolute path (null turns the legacy lock bridge off)');
    }
  }
  for (const key of MACHINE_ARGV_KEYS) {
    const argv = machine[key];
    if (!Array.isArray(argv)) continue;
    if (argv.length === 0) errors.push(`$.${key}: must name a program to run (an empty list runs nothing)`);
    else if (isBlank(argv[0])) errors.push(`$.${key}[0]: must name a program to run`);
  }
  if (Array.isArray(machine.path_extra)) {
    machine.path_extra.forEach((entry, index) => {
      if (typeof entry !== 'string') return;
      if (!isAbsolute(entry) && entry !== '~' && !entry.startsWith('~/')) {
        errors.push(`$.path_extra[${index}]: must be an absolute directory or start with ~/`);
      }
    });
  }
  return errors;
}

export function validateMachine(machine) {
  const current = withoutRetiredPaths(machine);
  return [...validateSchema(current, loadSchema('machine.schema.json')), ...machineValueErrors(current)];
}

// Whether a machine.json's canonical_path records the vault whose real path
// is `realRoot`, in THE form doctor's machine-valid compares and `machine
// register` writes: an absolute path that, made absolute and normalised but
// with no symbolic link resolved, is the real path itself. A path that only
// leads there through a link is not it: doctor warns about it, so register
// must rewrite it, never answer "already registered".
export function canonicalPathMatches(recorded, realRoot) {
  return typeof recorded === 'string' && isAbsolute(recorded) && resolve(recorded) === realRoot;
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
