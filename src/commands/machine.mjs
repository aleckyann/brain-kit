// The `machine` command: reads and edits this vault's machine.json, the
// machine-local file that lives in the state directory, outside the vault,
// and holds everything that executes or points at this machine.
//
//   brain-kit machine show [dir]
//   brain-kit machine set <key> <value> [dir]
//   brain-kit machine register [dir] [--from <previous vault path>]
//
// Exit 0 when the file was shown, written, or already right; 1 when the
// file is missing, unreadable, or would not pass validateMachine, and when
// register refuses to touch state it cannot prove is this vault's; 2 on a
// usage error, a key the schema does not declare or a value that does not
// parse as the key's type, a state directory inside the vault, and when no
// vault is found; 75 when another writer holds the vault lock.
//
// WHY THE FILE IS NEVER WRITTEN IN PLACE. machine.json names the binary the
// scheduled curator runs and the command it notifies through. A write cut
// short in place leaves a file no command can read, and a value that fails
// validation leaves one every command refuses: either way the next
// scheduled round dies. So every write goes to a temporary file in the same
// directory, created exclusively at mode 0600, flushed to disk, and renamed
// over the old one only after the complete new value has passed
// validateMachine (the schema plus the values the schema allows but a run
// cannot use, src/config.mjs, machineValueErrors). A refusal, at any point
// before that rename, leaves the old file byte for byte as it was.
//
// WHY `set` AND `register` TAKE THE VAULT LOCK AND `show` DOES NOT. Two
// writers of one machine.json each write atomically, but the second one's
// read-modify-write loses the first one's change, and a register that moves
// the state directory under a running set leaves that set writing into a
// directory that is no longer there. The lock is the one every writing
// command takes (src/guards/lock.mjs), in the repository, so a held lock is
// exit 75 naming its holder. `show` only reads.
//
// WHY `set` AND `register` LEAVE THE LEGACY LOCK OUT. Every other writer
// also holds the legacy lock machine.json `paths.legacy_lock` names
// (src/guards/legacy-lock.mjs). These two do not: `machine set
// paths.legacy_lock <path>` and `... null` are how that bridge is set,
// changed and turned off, and a bridge that cannot be used (its directory
// gone, no flock program) refuses every writer that takes it, so taking it
// here would lock out the one command that repairs it, leaving a 0600 JSON
// file to edit by hand. They write machine.json, in the state directory,
// and never the vault's tree, which is what the legacy lock keeps a second
// writer out of; the vault lock still keeps two kit writers of machine.json
// apart.
//
// WHY `set` PARSES BY THE SCHEMA'S TYPE. An array key (notify_command,
// network_check, path_extra) is an argument vector handed to spawnSync one
// element per argument, never a command line: it is taken only as a JSON
// array, never split on spaces, so `$(...)` or a quote inside an element is
// that element's text. The key must be one the schema declares, looked up
// as an OWN property, so `__proto__` or `constructor` are not keys.
// vault_id, canonical_path and state_dir are refused: init writes them and
// `register` is the one command that moves them, because a hand-set
// canonical_path is a file that says it belongs to a vault it does not.
//
// WHY `register` NEVER GUESSES, AND WHY A PATH IS NOT AN IDENTITY. A moved
// vault's state directory was derived from its old path, which nothing
// inside the vault records, so without --from register works only on the
// state directory the current path implies (the pinned one, or a register
// interrupted after the move) and otherwise lists the candidates and asks.
// With --from, the state found there and a record already at the target
// are compared by vault_id, never by the path they record: a vault deleted
// without its state cleaned up leaves a record naming the very path another
// vault may be moved to, and taking that record as this vault's would hand
// this vault the dead one's watermark and skip every day in between. Equal
// ids are this vault's own record; different ids are refused, exit 1. A
// DECLARED LIMIT: without --from, or when the state named by --from is
// gone, only one record is in sight and nothing on disk tells two vaults
// apart; a dead vault's record at this vault's path is then taken as this
// vault's (the same limit as a state directory pinned for two vaults).
//
// `deps` is the seam the tests use to hand in the environment, the working
// directory, a rename that fails, and a validator that rejects what the
// real one accepts. Production passes nothing.
import {
  closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeSync, chmodSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import {
  CONFIG_FILENAME, MACHINE_FILENAME, canonicalPathMatches, machineSchema, validateMachine, withoutRetiredPaths,
} from '../config.mjs';
import { findVaultRoot, isVaultRoot } from '../vault.mjs';
import { ensureStateDir, stateDirFor, stateDirForPath, stateRootFor } from '../state.mjs';
import { decodeBytes } from '../io.mjs';
import { isInside } from '../init/skeleton.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';

const ROOT_INDEX = 'index.md';
const MACHINE_FILE_MODE = 0o600;
const MANAGED_KEYS = Object.freeze(['vault_id', 'canonical_path', 'state_dir']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// --- arguments -------------------------------------------------------------------

// `set` takes its key and value positionally and verbatim, so a value that
// begins with a dash is a value; only `--help` in the subcommand's own
// place is help.
function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || sub === 'help') return { help: true };
  if (sub === 'show') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) return { help: true };
    const bad = rest.find((arg) => arg.startsWith('-'));
    if (bad !== undefined) return { error: bad };
    if (rest.length > 1) return { error: rest[1] };
    return { sub, dir: rest[0] };
  }
  if (sub === 'set') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) return { help: true };
    if (rest.length < 2) return { error: 'set', missing: true };
    if (rest.length > 3) return { error: rest[3] };
    return { sub, key: rest[0], value: rest[1], dir: rest[2] };
  }
  if (sub === 'register') {
    const result = { sub, dir: undefined, from: undefined };
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--help' || arg === '-h') return { help: true };
      if (arg === '--from') {
        if (i + 1 >= rest.length || rest[i + 1] === '') return { error: arg };
        result.from = rest[i + 1];
        i++;
      } else if (arg.startsWith('--from=')) {
        const value = arg.slice('--from='.length);
        if (value === '') return { error: arg };
        result.from = value;
      } else if (arg.startsWith('-')) return { error: arg };
      else if (result.dir === undefined) result.dir = arg;
      else return { error: arg };
    }
    return result;
  }
  return { error: sub ?? '', missing: sub === undefined };
}

function usageError(io, t, parsed) {
  if (!parsed.missing) io.stderr.write(`${t('machine.bad_argument', { arg: parsed.error })}\n`);
  io.stderr.write(`${t('machine.usage')}\n`);
  return EXIT.USAGE;
}

// The same refusal to climb from a path that is not real as doctor's.
function locateVault(io, t, dirArg, cwd) {
  let startDir = cwd;
  if (dirArg !== undefined) {
    startDir = resolve(cwd, dirArg);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('machine.path_not_found', { dir: startDir })}\n`);
      return null;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('machine.path_not_a_directory', { dir: startDir })}\n`);
      return null;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) io.stderr.write(`${t('machine.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
  return root;
}

// --- reading and writing the file ----------------------------------------------

// { missing } | { error } | { text, value }. Any failure to read other than
// absence is raised, never read as "no file".
function readMachineFile(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw error;
  }
  const text = decodeBytes(bytes);
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    return { text, error: error.message };
  }
}

// Flushes a directory's entries, so a rename in it survives a power cut.
// Best effort: some platforms and file systems refuse to open or fsync a
// directory, and by then the rename, which is the decision, has happened.
function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Not supported here; the rename itself stands.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The one way this command writes machine.json: complete, validated by the
// caller, to an exclusive temporary sibling at 0600, flushed, renamed over
// the file, and the directory flushed after the rename, so a power cut
// leaves either the old file or the new one, never a zero-length one.
// The mode given to open is filtered by the process umask, so it is set
// again on the descriptor, before a single byte of the file is written: the
// file is 0600 by the time it holds anything, whatever the umask.
export function writeMachineAtomic(file, value, { rename = renameSync } = {}) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', MACHINE_FILE_MODE);
  try {
    try {
      fchmodSync(fd, MACHINE_FILE_MODE);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rename(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed or already gone.
    }
    throw error;
  }
  fsyncDir(dirname(file));
}

// --- shared checks ---------------------------------------------------------------

// A state directory inside the vault would be committed with it: refused
// by every subcommand, the same way init refuses it, whether the vault was
// reached by its real path or through a link.
function refuseStateInsideVault(io, t, stateDir, root, realRoot) {
  if (!isInside(stateDir, realRoot) && !isInside(stateDir, root)) return null;
  io.stderr.write(`${t('machine.state_inside_vault', { state: stateDir, dir: realRoot })}\n`);
  return EXIT.USAGE;
}

// Runs `work` holding the vault lock, and releases it however `work` ends.
// A lock that cannot be taken is the guard's own exit code (75 when held,
// naming the holder; 2 outside a repository) and its own message. The
// legacy lock is left out (see the header).
function withVaultLock(io, t, root, env, command, work) {
  let lock;
  try {
    lock = acquireLock(root, { command, env, legacyLock: false });
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    io.stderr.write(`${t(error.messageKey, error.params)}\n`);
    return error.exitCode;
  }
  try {
    return work();
  } finally {
    lock.release();
  }
}

function realOrNull(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// A vault still in place at the path a machine.json records.
function liveVaultAt(recorded) {
  const real = realOrNull(recorded);
  return real !== null && isVaultRoot(real) ? real : null;
}

// The vault still in place that a machine.json records, when that is not
// this one: a state directory pinned by BRAIN_KIT_STATE_DIR is chosen by the
// environment, not by the vault, and can hold another vault's file. Reading
// it as this vault's, or editing it, is answering about something other than
// what was asked. null when the file records this vault, or a path that no
// longer holds one (a move that `register` has yet to record).
function otherVault(value, realRoot) {
  const recorded = isPlainObject(value) ? value.canonical_path : undefined;
  const live = liveVaultAt(recorded);
  return live !== null && live !== realRoot ? live : null;
}

// --- show ------------------------------------------------------------------------

function runShow(io, t, root, env) {
  const realRoot = realpathSync(root);
  const stateDir = stateDirFor(root, env);
  const inside = refuseStateInsideVault(io, t, stateDir, root, realRoot);
  if (inside !== null) return inside;
  const file = join(stateDir, MACHINE_FILENAME);
  const read = readMachineFile(file);
  if (read.missing) {
    io.stderr.write(`${t('machine.missing', { file })}\n`);
    return EXIT.FAILURE;
  }
  const owner = read.error === undefined ? otherVault(read.value, realRoot) : null;
  if (owner !== null) {
    io.stderr.write(`${t('machine.other_vault', { file, vault: owner })}\n`);
    return EXIT.FAILURE;
  }
  io.stdout.write(read.text.endsWith('\n') ? read.text : `${read.text}\n`);
  if (read.error !== undefined) {
    io.stderr.write(`${t('machine.unreadable', { file, error: read.error })}\n`);
    return EXIT.FAILURE;
  }
  const errors = validateMachine(read.value);
  if (errors.length > 0) {
    io.stderr.write(`${t('machine.invalid', { file, errors })}\n`);
    return EXIT.FAILURE;
  }
  // Valid, and nobody else's: a record of a path that is not this vault's
  // any more is a move register has yet to record. Said, not failed:
  // doctor warns about the same thing.
  if (!canonicalPathMatches(read.value.canonical_path, realRoot)) {
    io.stderr.write(`${t('machine.show_path_differs', { recorded: read.value.canonical_path, dir: realRoot })}\n`);
  }
  return EXIT.OK;
}

// --- set -------------------------------------------------------------------------

// The schema entry for `key`, a top-level key or `parent.child` one level
// into an object key, or null when the schema does not declare it.
function declaredKey(key) {
  const schema = machineSchema();
  const parts = key.split('.');
  if (parts.length > 2) return null;
  const [top, sub] = parts;
  if (!Object.hasOwn(schema.properties, top)) return null;
  const entry = schema.properties[top];
  if (sub === undefined) return { top, sub: null, entry };
  if (!isPlainObject(entry.properties) || !Object.hasOwn(entry.properties, sub)) return null;
  return { top, sub, entry: entry.properties[sub] };
}

// { value } or { messageKey } naming what the key takes.
function parseValue(raw, entry) {
  const types = Array.isArray(entry.type) ? entry.type : [entry.type];
  if (types.includes('null') && raw === 'null') return { value: null };
  if (types.includes('array') || types.includes('object')) {
    const wantArray = types.includes('array');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (wantArray && Array.isArray(parsed)) return { value: parsed };
    if (!wantArray && isPlainObject(parsed)) return { value: parsed };
    return { messageKey: wantArray ? 'machine.set_needs_array' : 'machine.set_needs_object' };
  }
  if (types.includes('integer')) {
    if (/^-?[0-9]+$/.test(raw) && Number.isSafeInteger(Number(raw))) return { value: Number(raw) };
    return { messageKey: 'machine.set_needs_integer' };
  }
  if (types.includes('boolean')) {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { messageKey: 'machine.set_needs_boolean' };
  }
  return { value: raw };
}

function runSet(io, t, root, env, parsed, deps) {
  const { key, value: raw } = parsed;
  const declared = declaredKey(key);
  if (declared === null) {
    io.stderr.write(`${t('machine.set_unknown_key', { key, keys: Object.keys(machineSchema().properties) })}\n`);
    return EXIT.USAGE;
  }
  if (MANAGED_KEYS.includes(declared.top)) {
    io.stderr.write(`${t('machine.set_managed_key', { key })}\n`);
    return EXIT.USAGE;
  }
  const parsedValue = parseValue(raw, declared.entry);
  if (parsedValue.messageKey !== undefined) {
    io.stderr.write(`${t(parsedValue.messageKey, { key, value: raw })}\n`);
    return EXIT.USAGE;
  }
  const realRoot = realpathSync(root);
  const stateDir = stateDirFor(root, env);
  const inside = refuseStateInsideVault(io, t, stateDir, root, realRoot);
  if (inside !== null) return inside;
  const file = join(stateDir, MACHINE_FILENAME);
  return withVaultLock(io, t, root, env, 'machine set', () => {
    const read = readMachineFile(file);
    if (read.missing) {
      io.stderr.write(`${t('machine.missing', { file })}\n`);
      return EXIT.FAILURE;
    }
    if (read.error !== undefined) {
      io.stderr.write(`${t('machine.unreadable', { file, error: read.error })}\n`);
      return EXIT.FAILURE;
    }
    if (!isPlainObject(read.value)) {
      io.stderr.write(`${t('machine.invalid', { file, errors: ['$: must be an object'] })}\n`);
      return EXIT.FAILURE;
    }
    const owner = otherVault(read.value, realRoot);
    if (owner !== null) {
      io.stderr.write(`${t('machine.other_vault', { file, vault: owner })}\n`);
      return EXIT.FAILURE;
    }
    // The retired paths keys are dropped from the value AFTER the new one is
    // in it, so what is validated is exactly what is written: validateMachine
    // ignores them, and a whole `paths` object carrying `lock` would
    // otherwise pass and be written back.
    const edited = structuredClone(read.value);
    if (declared.sub === null) edited[declared.top] = parsedValue.value;
    else edited[declared.top] = { ...(isPlainObject(edited[declared.top]) ? edited[declared.top] : {}), [declared.sub]: parsedValue.value };
    const next = withoutRetiredPaths(edited);
    const errors = validateMachine(next);
    if (errors.length > 0) {
      io.stderr.write(`${t('machine.set_rejected', { key, file, errors })}\n`);
      return EXIT.FAILURE;
    }
    writeMachineAtomic(file, next, { rename: deps.rename });
    io.stdout.write(`${t('machine.set_done', { key, file })}\n`);
    return EXIT.OK;
  });
}

// --- register --------------------------------------------------------------------

// `value` moved from inside `from` to the same place inside `to`; anything
// else (a path a person pointed elsewhere, a relative name) is left alone.
function rebase(value, from, to) {
  if (typeof value !== 'string' || !isAbsolute(value) || !isInside(value, from)) return value;
  return join(to, relative(from, value));
}

// State directories under the state root whose machine.json names a vault
// that is no longer there, or names a path that now leads to this vault (a
// move that left a symbolic link behind). Only listed for a person to
// choose from, never chosen.
function orphanedStates(env, except, realRoot) {
  const rootDir = stateRootFor(env);
  let names;
  try {
    names = readdirSync(rootDir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    const dir = join(rootDir, name);
    if (dir === except) continue;
    let read;
    try {
      read = readMachineFile(join(dir, MACHINE_FILENAME));
    } catch {
      continue;
    }
    const recorded = isPlainObject(read.value) ? read.value.canonical_path : undefined;
    if (typeof recorded !== 'string') continue;
    const live = liveVaultAt(recorded);
    if (live === null || live === realRoot) found.push(`  ${recorded}  (${dir})`);
  }
  return found;
}

// The state directory --from names: the old path's derivation through its
// real path, then as it is spelt (a link left at the old path resolves to
// the new one, and its old state is under the old name). The first that
// holds a machine.json and is not the target wins; the target itself only
// when nothing else holds one. null when none does.
function sourceFor(from, env, target) {
  const candidates = [...new Set([stateDirFor(from, env), stateDirForPath(from, env)])];
  const holding = candidates.filter((dir) => existsSync(join(dir, MACHINE_FILENAME)));
  return holding.find((dir) => dir !== target) ?? (holding.includes(target) ? target : null);
}

// "Already registered" is an exit 0, so it must mean what a register that
// did the work would leave: a record doctor calls valid, in a directory at
// 0700 holding it at 0600. An invalid record is refused, and the two modes
// are set, never the content.
function alreadyRegistered(io, t, dir, file, value, realRoot, validate) {
  const errors = validate(value);
  if (errors.length > 0) {
    io.stderr.write(`${t('machine.invalid', { file, errors })}\n`);
    return EXIT.FAILURE;
  }
  ensureStateDir(dir);
  chmodSync(file, MACHINE_FILE_MODE);
  io.stdout.write(`${t('machine.register_already', { dir: realRoot, file })}\n`);
  return EXIT.OK;
}

function runRegister(io, t, root, env, cwd, parsed, deps) {
  const realRoot = realpathSync(root);
  const target = stateDirFor(root, env);
  const inside = refuseStateInsideVault(io, t, target, root, realRoot);
  if (inside !== null) return inside;
  return withVaultLock(io, t, root, env, 'machine register', () => registerLocked(io, t, {
    realRoot, target, env, from: parsed.from === undefined ? undefined : resolve(cwd, parsed.from), deps,
  }));
}

function registerLocked(io, t, { realRoot, target, env, from, deps }) {
  const validate = deps.validate ?? validateMachine;
  const targetFile = join(target, MACHINE_FILENAME);
  let source = from === undefined ? target : sourceFor(from, env, target);

  if (source === null) {
    // Nothing where --from points. A register that already ran leaves
    // exactly this, so a record of this vault at the target is "nothing to
    // do", exit 0, and a retry of a success is not reported as a failure.
    const there = readMachineFile(targetFile);
    if (there.value !== undefined && canonicalPathMatches(isPlainObject(there.value) ? there.value.canonical_path : undefined, realRoot)) {
      return alreadyRegistered(io, t, target, targetFile, there.value, realRoot, validate);
    }
    io.stderr.write(`${t('machine.register_from_missing', { file: join(stateDirFor(from, env), MACHINE_FILENAME), from })}\n`);
    return EXIT.FAILURE;
  }
  let sourceFile = join(source, MACHINE_FILENAME);
  let read = readMachineFile(sourceFile);
  if (read.missing) {
    io.stderr.write(`${t('machine.register_nothing', { file: targetFile })}\n`);
    const candidates = env.BRAIN_KIT_STATE_DIR ? [] : orphanedStates(env, target, realRoot);
    if (candidates.length > 0) io.stderr.write(`${t('machine.register_candidates', { list: candidates.join('\n') })}\n`);
    return EXIT.USAGE;
  }
  if (read.error !== undefined) {
    io.stderr.write(`${t('machine.unreadable', { file: sourceFile, error: read.error })}\n`);
    return EXIT.FAILURE;
  }
  const sourceErrors = validate(read.value);
  if (sourceErrors.length > 0) {
    io.stderr.write(`${t('machine.invalid', { file: sourceFile, errors: sourceErrors })}\n`);
    return EXIT.FAILURE;
  }

  if (source !== target) {
    const there = readMachineFile(targetFile);
    if (!there.missing) {
      if (there.error !== undefined) {
        io.stderr.write(`${t('machine.register_target_unreadable', { file: targetFile, error: there.error })}\n`);
        return EXIT.FAILURE;
      }
      const targetErrors = validate(there.value);
      if (targetErrors.length > 0) {
        io.stderr.write(`${t('machine.register_target_invalid', { file: targetFile, errors: targetErrors })}\n`);
        return EXIT.FAILURE;
      }
      // Two valid records: the same vault only when the ids are equal. A
      // path recorded in either says nothing about which vault it is.
      if (there.value.vault_id !== read.value.vault_id) {
        io.stderr.write(`${t('machine.register_target_taken', {
          file: targetFile, theirs: there.value.vault_id, source: sourceFile, ours: read.value.vault_id,
        })}\n`);
        return EXIT.FAILURE;
      }
      // This vault's own record is already at the target: that is the one to
      // register, in place; the other is left where it is.
      source = target;
      sourceFile = targetFile;
      read = there;
    } else if (existsSync(target) && readdirSync(target).length > 0) {
      io.stderr.write(`${t('machine.register_target_not_empty', { dir: target })}\n`);
      return EXIT.FAILURE;
    }
  }

  const recorded = read.value.canonical_path;
  if (source === target && canonicalPathMatches(recorded, realRoot)) {
    return alreadyRegistered(io, t, target, targetFile, read.value, realRoot, validate);
  }
  const live = liveVaultAt(recorded);
  if (live !== null && live !== realRoot) {
    io.stderr.write(`${t('machine.register_source_live', { file: sourceFile, vault: live })}\n`);
    return EXIT.FAILURE;
  }

  const next = structuredClone(withoutRetiredPaths(read.value));
  next.canonical_path = realRoot;
  if (next.state_dir !== undefined) next.state_dir = rebase(next.state_dir, source, target);
  for (const [name, path] of Object.entries(next.paths)) next.paths[name] = rebase(path, source, target);
  const errors = validate(next);
  if (errors.length > 0) {
    io.stderr.write(`${t('machine.invalid', { file: sourceFile, errors })}\n`);
    return EXIT.FAILURE;
  }

  const rename = deps.rename ?? renameSync;
  if (source !== target) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) rmdirSync(target);
    rename(source, target);
    fsyncDir(dirname(target));
    fsyncDir(dirname(source));
  }
  try {
    ensureStateDir(target);
    writeMachineAtomic(targetFile, next, { rename });
  } catch (error) {
    // Put the state back where the old path's commands will find it, so a
    // failed register is no register at all.
    if (source !== target) {
      try {
        rename(target, source);
      } catch {
        io.stderr.write(`${t('machine.register_stranded', { from: source, to: target })}\n`);
      }
    }
    throw error;
  }
  if (source === target) io.stdout.write(`${t('machine.register_updated', { dir: realRoot, file: targetFile })}\n`);
  else io.stdout.write(`${t('machine.register_done', { dir: realRoot, from: source, to: target })}\n`);
  return EXIT.OK;
}

// --- entry -----------------------------------------------------------------------

export async function runMachine(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(`${t('machine.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.error !== undefined) return usageError(io, t, parsed);
  const root = locateVault(io, t, parsed.dir, cwd);
  if (!root) return EXIT.USAGE;
  if (parsed.sub === 'show') return runShow(io, t, root, env);
  if (parsed.sub === 'set') return runSet(io, t, root, env, parsed, deps);
  return runRegister(io, t, root, env, cwd, parsed, deps);
}
