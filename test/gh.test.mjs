// How the kit reads the answer of `gh auth status` (src/gh.mjs), the one
// reading `propose --dry` and `doctor` share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/exec.mjs';
import { AUTH_STATUS_ARGS, authVerdict, loginCommand } from '../src/gh.mjs';

test('the question is gh auth status, and the command that fixes a no is gh auth login', () => {
  assert.deepEqual([...AUTH_STATUS_ARGS], ['auth', 'status']);
  assert.equal(loginCommand('gh'), 'gh auth login');
});

test('exit 0 is logged in, whatever gh printed', () => {
  assert.deepEqual(authVerdict({ status: 0, stdout: '', stderr: '' }), { state: 'logged_in' });
});

test('a program that is not there is absent, which is not the same as logged out', () => {
  const result = run('this-program-is-in-no-path-at-all', ['auth', 'status']);
  assert.equal(result.errorCode, 'ENOENT');
  assert.deepEqual(authVerdict(result), { state: 'absent' });
});

test('a program that ran and said no is logged out, with its own sentence as the detail', () => {
  const verdict = authVerdict({ status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' });
  assert.deepEqual(verdict, { state: 'logged_out', status: 1, detail: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' });
});

test('the detail skips the line that is only the host name, and falls back to the exit status when gh printed nothing', () => {
  const hostFirst = authVerdict({ status: 1, stdout: 'github.com\n  X Failed to log in to github.com account ana (keyring)\n', stderr: '' });
  assert.equal(hostFirst.detail, 'X Failed to log in to github.com account ana (keyring)');
  assert.equal(authVerdict({ status: 4, stdout: '', stderr: '' }).detail, 'exit status 4');
});

test('a long line is cut, so a message never carries a page of gh output', () => {
  const verdict = authVerdict({ status: 1, stdout: '', stderr: `${'word '.repeat(200)}\n` });
  assert.ok(verdict.detail.length <= 303, String(verdict.detail.length));
  assert.ok(verdict.detail.endsWith('...'));
});
