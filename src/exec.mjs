import { spawnSync } from 'node:child_process';

// Run an external command with an argument array, never a shell string.
//
// This engine feeds an AI agent's output into a user's repository; a command
// built by concatenating strings is exactly how a note's content becomes a
// command. Accepting only (command, args[]) is the safeguard, not a style
// choice, so `options.shell` is refused rather than silently honoured: a
// caller that reaches for it has already stepped outside what this module
// promises to be safe.
//
// Never throws. A non-zero exit, a signal, or a command that could not even
// be spawned (e.g. ENOENT) all come back as a normal { status, stdout,
// stderr } result for the caller to inspect.
// `deps.spawn` is a seam, and it exists for one reason: the clause below
// (output captured before a child died must survive alongside the error)
// could only be tested by really starting a process, really letting a
// wall-clock timer kill it, and hoping the child got its write in first.
// On a loaded machine it did not, and the test went red for a reason that
// had nothing to do with this file. Widening the timeout only moves the
// load at which it happens. Injecting the thing that carries the clock
// removes it: the test hands over the exact result spawnSync produces for
// a killed child and asserts what this function does with it, which is
// the only part that is this module's to get right. The real timeout is
// still exercised, for the part that IS deterministic under load (a
// killed child never reports success).
//
// Production never passes it, and nothing in this module reads a clock,
// so the seam cannot change what a real run does.
export function run(command, args = [], options = {}, { spawn = spawnSync } = {}) {
  if (options.shell) {
    throw new Error('run() must never shell out: pass the program and its arguments as an array instead');
  }
  const result = spawn(command, args, { encoding: 'utf8', ...options, shell: false });
  // spawnSync still captures whatever the child wrote before dying (a few
  // lines before a timeout kills it, say) even when it also reports an
  // error. That real output must survive, not be replaced by empty strings;
  // only a genuine absence of captured output falls back to ''.
  const stdout = result.stdout ?? '';
  if (result.error) {
    const stderr = result.stderr ? `${result.stderr}\n${result.error.message}` : result.error.message;
    // Force non-zero explicitly rather than `?? 1`: spawnSync reports status
    // null in the cases seen so far (ENOENT, a killing timeout), but this is
    // the error branch, so a failure must never read back as status 0.
    return { status: result.status || 1, stdout, stderr };
  }
  return {
    // spawnSync leaves status null when the process was killed by a signal;
    // that is still a failure, so it is reported as a non-zero status.
    status: result.status ?? 1,
    stdout,
    stderr: result.stderr ?? '',
  };
}

// Same as run(), but throws on a non-zero status. The thrown Error carries
// status, stdout and stderr so a caller that wants the detail still has it.
export function runOrThrow(command, args = [], options = {}, deps = {}) {
  const result = run(command, args, options, deps);
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} exited with status ${result.status}: ${result.stderr || result.stdout}`.trim());
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}
