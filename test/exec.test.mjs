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

// --- a command killed by a timeout, split in two on purpose --------------
//
// This was ONE test, and it asserted both halves against a real 200ms
// timer: that a killed child reports failure, and that whatever it managed
// to write survives. The first half is deterministic under any load (a
// child blocked for five seconds is always killed at 200ms). The second is
// a race between the child starting up and the parent's timer, and on a
// busy machine the child loses it and the suite goes red on a pristine
// tree, which teaches whoever reads it that red means noise. Widening the
// timeout would only raise the load at which it happens.
//
// So the clock is injected for the half that needs one, rather than the
// tolerance widened. The two together assert strictly more than the
// original did: the integration half no longer depends on timing, and the
// unit half pins the exact shape spawnSync reports for a killed child,
// which the original could only reach by luck.

test('a command killed by a timeout reports failure, never success', () => {
  // Atomics.wait blocks the child's own thread (not its event loop) well
  // past the timeout, so spawnSync's parent-side timer always has to kill
  // it, whatever the machine is doing.
  const script = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);';
  const result = run(process.execPath, ['-e', script], { timeout: 200 });
  assert.notEqual(result.status, 0);
});

test('output written before a timeout killed the child survives, and is not replaced by an empty string', () => {
  // Exactly what spawnSync reports for a child it killed on a timeout:
  // captured output, a null status, and an ETIMEDOUT error beside it. The
  // clause under test is this module's, not the operating system's: real
  // output must survive the error branch rather than being thrown away.
  const killed = {
    status: null,
    stdout: 'line-before-timeout\n',
    stderr: '',
    error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  };
  const result = run(process.execPath, ['-e', '1'], { timeout: 200 }, { spawn: () => killed });
  assert.equal(result.stdout, 'line-before-timeout\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ETIMEDOUT/);
});

test('the injected spawn is a seam and nothing more: it receives the same arguments the real one would, with shell forced off', () => {
  let seen = null;
  run('some-program', ['a', 'b'], { timeout: 50 }, {
    spawn: (command, args, options) => {
      seen = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(seen.command, 'some-program');
  assert.deepEqual(seen.args, ['a', 'b']);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.timeout, 50);
  assert.equal(seen.options.encoding, 'utf8');
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
