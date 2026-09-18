import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runOrThrow } from '../src/exec.mjs';

// A tiny node -e script that prints its own argv (everything after the
// script text) as JSON, so tests can inspect exactly what a program
// received, with no shell in between to reinterpret it.
const PRINT_ARGV = "console.log(JSON.stringify(process.argv.slice(1)))";

test('a successful command returns status 0 with stdout untouched, byte for byte', () => {
  const result = run(process.execPath, ['-e', "process.stdout.write('hello, no trailing newline')"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'hello, no trailing newline');
  assert.equal(result.stderr, '');
});

test('a failing command returns its real status with stderr captured, and does not throw', () => {
  const result = run(process.execPath, ['-e', "process.stderr.write('boom'); process.exitCode = 7;"]);
  assert.equal(result.status, 7);
  assert.equal(result.stderr, 'boom');
});

test('an argument with a space, a quote, a dollar sign and a semicolon reaches the program as one argument, unchanged', () => {
  const weird = 'has space "quote" $DOLLAR ; semicolon';
  const result = run(process.execPath, ['-e', PRINT_ARGV, weird]);
  assert.equal(result.status, 0);
  const received = JSON.parse(result.stdout);
  assert.deepEqual(received, [weird]);
});

test('a command that does not exist returns a non-zero status with a readable message, and does not throw', () => {
  const result = run('this-command-does-not-exist-in-any-path', []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /this-command-does-not-exist-in-any-path/);
});

test('run never shells out: passing options.shell is refused rather than silently honoured', () => {
  assert.throws(() => run(process.execPath, ['-e', '1'], { shell: true }), /shell/);
});

test('a command killed by a timeout still returns the output it wrote before dying', () => {
  // fs.writeSync performs a real, blocking write() to the fd, so the line is
  // guaranteed to have reached the pipe before the child blocks; a plain
  // console.log/process.stdout.write to a piped stdout is asynchronous on
  // POSIX and could still be queued, unflushed, when the timeout fires.
  // Atomics.wait then blocks the child's own thread (not the event loop)
  // well past the timeout, so spawnSync's parent-side timer has to kill it.
  const script = "require('fs').writeSync(1, 'line-before-timeout\\n'); "
    + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);';
  const result = run(process.execPath, ['-e', script], { timeout: 200 });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /line-before-timeout/);
});

test('runOrThrow throws on a non-zero status, and the error carries status, stdout and stderr', () => {
  assert.throws(
    () => runOrThrow(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;"]),
    (error) => error.status === 3 && error.stdout === 'out' && error.stderr === 'err',
  );
});

test('runOrThrow returns the result on success', () => {
  const result = runOrThrow(process.execPath, ['-e', "process.stdout.write('ok')"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
});
