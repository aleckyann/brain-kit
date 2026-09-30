// A legacy lock held the way a legacy scheduled job holds it, for the tests
// of the bridge (src/guards/legacy-lock.mjs): a real second process, bash,
// running `exec 9>>file; flock -n 9` and then blocking on its standard
// input. It says "ready" only once flock has succeeded, so a test waits for
// that line, never for a length of time. It lets go when stop() ends its
// input and signals it, and on its own when the test process dies, because
// its input is a pipe from that process: no holder outlives the run.
//
// runWatched runs a program to its end while watching /proc/locks: a
// process blocked in flock(2) on the file is listed there as a waiter
// ("N: -> FLOCK ..."), for as long as it waits, and the program's own
// process group is the only one looked for. A writer that waited for a
// legacy lock instead of refusing at once would never end while the holder
// lives, and would hang the test; seen waiting, its whole process group is
// killed and runWatched throws, so the test fails instead. The watch polls
// with no deadline: waiting is recognised by what the kernel says, never by
// how long something took.
//
// runUnderHolder runs a program as the child of the holder itself, the
// shape of a legacy job that starts `claude -p` while it holds its lock
// (docs/incidents.md, 28/09/2026), watched the same way.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';

export const HOLDER_SCRIPT = 'exec 9>>"$1" || exit 3; flock -n 9 || exit 4; echo ready; read -r _';

// True where the bridge can run at all: Linux, with util-linux flock on PATH.
export function flockAvailable() {
  if (process.platform !== 'linux') return false;
  const r = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && /util-linux/.test(`${r.stdout}${r.stderr}`);
}

// `{ ready, stop }`: ready resolves once the holder holds `file`, and
// rejects if it exits before; stop() lets go and resolves once it exited.
export function startHolder(file) {
  const child = spawn('bash', ['-c', HOLDER_SCRIPT, 'bash', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('ready\n')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`the holder exited (${code}) before it held ${file}: ${err}`)));
  });
  // A rejection after "ready" can no longer settle it; before, the test
  // awaits it and fails with the holder's own words.
  ready.catch(() => {});
  return {
    child,
    ready,
    async stop() {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
}

// The process group of `pid`, or null once it is gone. /proc/<pid>/stat is
// "pid (comm) state ppid pgrp ...", and comm may hold spaces or brackets,
// so the fields are counted from the last ")".
function processGroupOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}

// Whether a process of the process group `pgid` waits in flock(2) on the
// inode `ino` right now. A waiter's line in /proc/locks is
// "N: -> FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> 0 EOF"; the group
// is checked too, so an unrelated process that happens to wait on an equal
// inode number of another file system is never taken for the writer.
export function waitsOn(ino, pgid) {
  return readFileSync('/proc/locks', 'utf8').split('\n').some((line) => {
    const m = /^\d+:\s+->\s+FLOCK\s+\S+\s+\S+\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line);
    return m !== null && Number(m[2]) === ino && processGroupOf(Number(m[1])) === pgid;
  });
}

function killGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Runs `program args` in a process group of its own, to its end, with
// `input` on its standard input; throws if any process of that group waits
// on `file` while it runs (see the header). `file` must exist. Should the
// watch itself fail (/proc/locks unreadable), the group is killed before
// the error goes up, so no process of it outlives the test.
export async function runWatched(program, args, { file, env, cwd, input = '' }) {
  const { ino } = statSync(file);
  const child = spawn(program, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  let done = false;
  const closed = new Promise((resolve) => child.on('close', (status, signal) => {
    done = true;
    resolve({ status, signal });
  }));
  let waited = false;
  try {
    while (!done) {
      if (waitsOn(ino, child.pid)) {
        waited = true;
        killGroup(child.pid);
        break;
      }
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
  } catch (error) {
    killGroup(child.pid);
    await closed;
    throw error;
  }
  const { status, signal } = await closed;
  if (waited) throw new Error(`${args.join(' ')} waited for the legacy lock ${file} instead of refusing at once`);
  return { status, signal, stdout, stderr };
}

// The shape of the incident of 28/09/2026 (docs/incidents.md): a legacy job
// that holds its lock (`exec 9>>file; flock -n 9`) and, while it holds it,
// starts a program as its own child, as it starts `claude -p`. Before the
// child starts, the script proves the lock is held (a second `flock -n` on
// the file must fail); it exits 3, 4 or 5 when it could not open the file,
// could not lock it, or found it free. The child's status is the script's.
export const PARENT_HOLDER_SCRIPT = 'exec 9>>"$1" || exit 3; flock -n 9 || exit 4; if flock -n "$1" true; then exit 5; fi; shift; "$@"';

// Runs `program args` as the child of a bash holding `file` as above,
// watched like runWatched (a waiter in the group fails the test). The file
// is created first when missing, as the job's `>>` would create it, so the
// watch has an inode to look for. The holder is the child's parent and
// exits with it; runWatched's own close and its kill on failure leave no
// process of the group running.
export function runUnderHolder(file, program, args, { env, cwd, input = '' }) {
  closeSync(openSync(file, 'a'));
  return runWatched('bash', ['-c', PARENT_HOLDER_SCRIPT, 'bash', file, program, ...args], { file, env, cwd, input });
}

// flock(1) itself asked whether `file` can be locked right now, without
// waiting: 0 free, 1 held.
export function flockProbe(file) {
  return spawnSync('flock', ['-n', file, 'true']).status;
}
