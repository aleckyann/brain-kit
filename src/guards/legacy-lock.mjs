// The bridge to a legacy lock: for a vault moving to the kit from scripts of
// its own, which for a while still run a scheduled job that holds an
// exclusive `flock` on one file for its whole run (the shape is
// `exec 9>>file; flock -n 9`) and a Stop hook that stands down while it
// does. During the switch the kit's writers and that job must never both be
// in the tree. machine.json `paths.legacy_lock` names the file; when it is
// set, every command that takes the vault lock (src/guards/lock.mjs,
// acquireLock) also holds an exclusive flock(2) on it, taken and released
// together with the vault lock, and the Stop hook stands down while anyone
// else holds it.
//
// HOW A NODE PROCESS HOLDS A FLOCK. Node has no flock(2). The lock is taken
// by util-linux flock(1) in its descriptor mode, on a descriptor this
// process opened and hands to it as its fd 3: `flock -n -x -E 75 3`. A
// flock(2) lock belongs to the open file description, not to the process
// that asked for it, so when flock(1) exits the lock stays with the
// description, which this process still holds open. That is the legacy
// job's own idiom (its `flock -n 9` is a child process too, and the lock
// outlives it). The kernel releases the lock when this process closes the
// descriptor (the release) or ends, however it ends: a crash or a SIGKILL
// releases it as surely as a normal exit. Node opens every descriptor
// close-on-exec, so the programs a command runs (git, gh, the round's
// model) never hold it: exactly like the vault lock, it is held by the
// command's own process, and a round holds it for the whole round.
//
// WHY NOT RE-RUN THE COMMAND UNDER `flock -n <file> -- node <kit> <args>`,
// the first direction for this bridge. Node cannot replace its own process,
// so that is a second node process living as long as the command: the pid a
// scheduler or a person signals would be the waiting parent, and a round's
// own signal handling (which ends its model's process group before it lets
// go of the vault lock) would never see the signal. The vault a command
// works on, and so the machine.json that says whether the bridge is on, is
// found inside each command from its own arguments; a re-run decided
// before that would need every command's vault finding and every
// subcommand's knowledge of whether it writes, a second copy of each. And
// the command's exit status and flock's own (held, and flock's failures)
// would share one number. Holding the descriptor in the command's own
// process, taken where the vault lock is taken, has none of these
// problems, needs no environment marker to stop a second re-run, and puts
// the bridge in one place.
//
// WITHOUT WAITING. `-n`, always: a lock someone else holds is refused at
// once, never waited for, as the vault lock is.
//
// HELD MEANS HELD. flock(1) exits with 75 (`-E 75`) exactly when someone
// else holds the lock; in descriptor mode it never exits 75 for any other
// reason (its own failures are 64, 65 and 71). Held throws LegacyLockHeld,
// exit 75, which every command turns into the same exit and the same kind
// of line it gives for the vault lock held, naming the legacy file.
//
// UNUSABLE IS A REFUSAL, NEVER A SKIP. The bridge exists because the owner
// asked for it, so a bridge that cannot be used stops the command, exit 1,
// with a message naming the file, the cause and the way out (restore what
// is missing, or `brain-kit machine set paths.legacy_lock null`); running
// without it would be the two writers it exists to prevent. Unusable is:
// not Linux; no `flock` program on PATH; the file's directory missing; the
// file not openable, or not a regular file; flock(1) failing for any reason
// but held. A machine.json that cannot be read or parsed says nothing about
// whether the bridge is on, and is refused the same way; a machine.json
// that is not there has no bridge. `machine set` and `machine register`
// take the vault lock without the bridge (src/commands/machine.mjs says
// why): they are how it is set and cleared, and they write no tree.
//
// THE FILE. Opened read-write, and created when missing, with mode 0666
// less the umask, as the legacy job's `>>` and flock(1) itself create it;
// read-only when it exists but this user may not write it; never written
// to, never deleted, never truncated. Opened without blocking, so a FIFO
// planted there cannot hang a writer; anything but a regular file (a
// directory, a FIFO, a device) is refused. A symbolic link is followed, as
// the legacy job follows it, so both lock the same file.
//
// THE PROBE, for the Stop hook and doctor: a shared lock on the file opened
// read-only, taken without waiting and released at once. It never creates
// the file: a file that is not there cannot be locked by anyone, so it is
// free. A declared side effect, the same as `flock -n -s <file> true`: a
// legacy job that starts in the very instant the probe holds its shared
// lock finds the file locked and skips that run.
//
// A DECLARED LIMIT: flock(2) locks an inode, not a name. A legacy job that
// holds its lock on a file somebody deleted, or replaced, while it ran is
// invisible to every later opener of the name, the kit included; that is
// the legacy job's own limit between two of its runs too.
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { run } from '../exec.mjs';
import { EXIT } from '../exit-codes.mjs';
import { MACHINE_FILENAME } from '../config.mjs';
import { decodeBytes } from '../io.mjs';
import { stateDirFor } from '../state.mjs';
import { resolveCliPath } from './cli.mjs';
import { GuardError } from './location.mjs';

// flock(1)'s exit status when someone else holds the lock (`-E`). Any
// status but this and 0 is flock failing, never "held".
export const FLOCK_HELD_STATUS = 75;

// The descriptor flock(1) is told to lock: the fourth entry of the stdio
// list it is started with.
const CHILD_FD = '3';

const WRITABLE = constants.O_RDWR | constants.O_CREAT | constants.O_NOCTTY | constants.O_NONBLOCK;
const READABLE = constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK;
// Errors that mean "this user may not open it for writing", where opening
// it read-only can still lock it.
const NOT_WRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

const OFF = Object.freeze({ state: 'off' });

export class LegacyLockHeld extends GuardError {
  constructor(file) {
    super({
      code: 'LEGACY_LOCK_HELD',
      exitCode: EXIT.TEMPFAIL,
      messageKey: 'lock.legacy_held', params: { lock: file },
      message: `the legacy lock ${file} is held by another process`,
    });
    this.name = 'LegacyLockHeld';
    this.lockPath = file;
  }
}

// A problem ({ messageKey, params }) turned into the refusal a command
// prints: exit 1, never 75, because retrying cannot fix it.
function unusable(found) {
  return new GuardError({
    code: 'LEGACY_LOCK_UNUSABLE',
    exitCode: EXIT.FAILURE,
    messageKey: found.messageKey,
    params: found.params,
    message: `the legacy lock cannot be used (${found.messageKey})`,
  });
}

// The bridge's setting in the machine.json of the state directory
// `stateDir`, read on its own (not through loadMachine) so that a file the
// schema would refuse for some other key still says whether the bridge is on:
//   { state: 'off' }                          no machine.json, or no
//                                             paths.legacy_lock (absent or null)
//   { state: 'on', file }                     an absolute path
//   { state: 'invalid', messageKey, params }  machine.json unreadable, or a
//                                             value that is not an absolute path
export function legacyLockSetting(stateDir) {
  const file = join(stateDir, MACHINE_FILENAME);
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return OFF;
    return { state: 'invalid', messageKey: 'lock.legacy_machine_unreadable', params: { file, detail: error.code ?? error.message } };
  }
  let value;
  try {
    value = JSON.parse(decodeBytes(bytes));
  } catch (error) {
    return { state: 'invalid', messageKey: 'lock.legacy_machine_unreadable', params: { file, detail: error.message } };
  }
  const paths = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.paths : undefined;
  const configured = paths !== null && typeof paths === 'object' && !Array.isArray(paths) ? paths.legacy_lock : undefined;
  if (configured === undefined || configured === null) return OFF;
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    return { state: 'invalid', messageKey: 'lock.legacy_setting_invalid', params: { file, value: JSON.stringify(configured) } };
  }
  return { state: 'on', file: configured };
}

// The flock(1) program for `file`: { program } or { problem }.
function flockProgram(file, env, platform) {
  if (platform !== 'linux') return { problem: { messageKey: 'lock.legacy_not_linux', params: { lock: file, platform } } };
  const program = resolveCliPath('flock', env);
  if (program === null) return { problem: { messageKey: 'lock.legacy_no_flock', params: { lock: file } } };
  return { program };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The file opened for flock: { fd }, { absent } (only when not creating: no
// file there, its directory there) or { problem }.
function openLockFile(file, { create }) {
  let fd;
  try {
    try {
      fd = openSync(file, create ? WRITABLE : READABLE, 0o666);
    } catch (error) {
      if (!create || !NOT_WRITABLE.has(error.code)) throw error;
      fd = openSync(file, READABLE);
    }
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    if (missing && !isDirectory(dirname(file))) {
      return { problem: { messageKey: 'lock.legacy_dir_missing', params: { lock: file, dir: dirname(file) } } };
    }
    if (error.code === 'ENOENT' && !create) return { absent: true };
    if (error.code === 'EISDIR') return { problem: { messageKey: 'lock.legacy_not_a_file', params: { lock: file } } };
    return { problem: { messageKey: 'lock.legacy_open_failed', params: { lock: file, code: error.code ?? error.message } } };
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    return { problem: { messageKey: 'lock.legacy_not_a_file', params: { lock: file } } };
  }
  return { fd };
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

// flock(1) on the descriptor `fd`, never waiting: 'taken', 'held', or
// { problem }. The lock taken stays with the descriptor after flock(1)
// exits (see the header).
function flockOn(program, fd, file, { shared, env }) {
  const result = run(program, ['-n', shared ? '-s' : '-x', '-E', String(FLOCK_HELD_STATUS), CHILD_FD], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    env: { ...env, LC_ALL: 'C' },
  });
  if (result.status === 0) return 'taken';
  if (result.status === FLOCK_HELD_STATUS) return 'held';
  return { problem: { messageKey: 'lock.legacy_flock_failed', params: { lock: file, status: result.status, detail: firstLine(result.stderr) || '-' } } };
}

// Takes the exclusive lock on `file` for this process, without waiting:
// `{ file, release }`, release closing the descriptor (and so the lock) at
// most once. Throws LegacyLockHeld (exit 75) when another process holds it,
// and a GuardError LEGACY_LOCK_UNUSABLE (exit 1) when it cannot be taken at
// all. `platform` is a test seam for "not Linux"; production passes nothing.
export function takeLegacyLock(file, { env = process.env, platform = process.platform } = {}) {
  const found = flockProgram(file, env, platform);
  if (found.problem) throw unusable(found.problem);
  const opened = openLockFile(file, { create: true });
  if (opened.problem) throw unusable(opened.problem);
  const outcome = flockOn(found.program, opened.fd, file, { shared: false, env });
  if (outcome !== 'taken') {
    closeSync(opened.fd);
    if (outcome === 'held') throw new LegacyLockHeld(file);
    throw unusable(outcome.problem);
  }
  let released = false;
  return {
    file,
    release: () => {
      if (released) return;
      released = true;
      closeSync(opened.fd);
    },
  };
}

// Whether another process holds `file` exclusively right now, asked
// without waiting and without creating the file:
//   { state: 'free' } | { state: 'held' } | { state: 'unusable', messageKey, params }
export function probeLegacyLock(file, { env = process.env, platform = process.platform } = {}) {
  const found = flockProgram(file, env, platform);
  if (found.problem) return { state: 'unusable', ...found.problem };
  const opened = openLockFile(file, { create: false });
  if (opened.absent) return { state: 'free' };
  if (opened.problem) return { state: 'unusable', ...opened.problem };
  try {
    const outcome = flockOn(found.program, opened.fd, file, { shared: true, env });
    if (outcome === 'taken') return { state: 'free' };
    if (outcome === 'held') return { state: 'held' };
    return { state: 'unusable', ...outcome.problem };
  } finally {
    // Closing the descriptor drops the shared lock the probe took.
    closeSync(opened.fd);
  }
}

// The bridge as acquireLock takes it, for the vault at `root` whose state
// directory `env` implies: null when it is off, the taken lock otherwise.
// Throws what takeLegacyLock throws, and a refusal (exit 1) when
// machine.json cannot say whether the bridge is on.
export function takeBridge(root, { env = process.env, platform = process.platform } = {}) {
  const setting = legacyLockSetting(stateDirFor(root, env));
  if (setting.state === 'off') return null;
  if (setting.state === 'invalid') throw unusable(setting);
  return takeLegacyLock(setting.file, { env, platform });
}
