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
export function run(command, args = [], options = {}) {
  if (options.shell) {
    throw new Error('run() must never shell out: pass the program and its arguments as an array instead');
  }
  const result = spawnSync(command, args, { encoding: 'utf8', ...options, shell: false });
  if (result.error) {
    return { status: 1, stdout: '', stderr: result.error.message };
  }
  return {
    // spawnSync leaves status null when the process was killed by a signal;
    // that is still a failure, so it is reported as a non-zero status.
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// Same as run(), but throws on a non-zero status. The thrown Error carries
// status, stdout and stderr so a caller that wants the detail still has it.
export function runOrThrow(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} exited with status ${result.status}: ${result.stderr || result.stdout}`.trim());
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}
