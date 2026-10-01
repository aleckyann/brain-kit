// How the kit asks `gh` whether it can open a pull request (src/gh.mjs), the
// one reading `propose --dry` and `doctor` share: the host the vault uses, the
// question asked of that host alone, and what its answer is taken to mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/exec.mjs';
import { DEFAULT_HOST, authArgs, authVerdict, hostOfRemote, hostOfUrl, loginCommand } from '../src/gh.mjs';

test('the question is gh auth status for one host, and the command that fixes a no names the same host', () => {
  assert.deepEqual(authArgs('github.com'), ['auth', 'status', '--hostname', 'github.com']);
  assert.deepEqual(authArgs('ghe.example.com'), ['auth', 'status', '--hostname', 'ghe.example.com']);
  assert.equal(loginCommand('gh'), 'gh auth login');
  assert.equal(loginCommand('gh', 'ghe.example.com'), 'gh auth login --hostname ghe.example.com');
  assert.equal(DEFAULT_HOST, 'github.com');
});

test('the host of a remote url, in every form a clone can have', () => {
  const cases = [
    ['https://github.com/ana/brain.git', 'github.com'],
    ['https://ana@github.com/ana/brain', 'github.com'],
    ['https://user:secret@ghe.example.com:8443/ana/brain.git', 'ghe.example.com'],
    ['HTTPS://GitHub.COM/ana/brain.git', 'github.com'],
    ['ssh://git@github.com/ana/brain.git', 'github.com'],
    ['ssh://git@ghe.example.com:2222/ana/brain.git', 'ghe.example.com'],
    ['git@github.com:ana/brain.git', 'github.com'],
    ['ghe.example.com:ana/brain.git', 'ghe.example.com'],
    ['git://example.com/ana/brain.git', 'example.com'],
  ];
  for (const [url, host] of cases) assert.equal(hostOfUrl(url), host, url);
});

test('a url that names no host (a local path, a file url, nothing) has none, and the default host is used in its place', () => {
  for (const url of ['/tmp/remote.git', '../remote.git', './remote.git', 'file:///tmp/remote.git', 'C:\\work\\remote.git', '', '   ', 'not a url', '-oProxyCommand=x:y']) {
    assert.equal(hostOfUrl(url), null, JSON.stringify(url));
  }
  assert.equal(hostOfRemote(() => ({ status: 0, stdout: '/tmp/remote.git\n', stderr: '' }), 'origin'), DEFAULT_HOST);
  assert.equal(hostOfRemote(() => ({ status: 2, stdout: '', stderr: 'error: No such remote' }), 'origin'), DEFAULT_HOST, 'no origin yet');
  const asked = [];
  assert.equal(hostOfRemote((args) => { asked.push(args); return { status: 0, stdout: 'git@ghe.example.com:ana/brain.git\n', stderr: '' }; }, 'origin'), 'ghe.example.com');
  assert.deepEqual(asked, [['remote', 'get-url', 'origin']]);
});

test('exit 0 is the host\'s login confirmed, whatever gh printed', () => {
  assert.deepEqual(authVerdict({ status: 0, stdout: '', stderr: '' }), { state: 'logged_in' });
});

test('a program that is not there is absent, which is not the same as a problem', () => {
  const result = run('this-program-is-in-no-path-at-all', ['auth', 'status']);
  assert.equal(result.errorCode, 'ENOENT');
  assert.deepEqual(authVerdict(result), { state: 'absent' });
});

test('a program that ran and exited non-zero reported a problem, with its own sentence as the detail', () => {
  const verdict = authVerdict({ status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' });
  assert.deepEqual(verdict, { state: 'problem', status: 1, detail: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' });
});

test('a run that did not finish (a timeout, a program that cannot be started) is unverified, never a problem with the login', () => {
  assert.deepEqual(authVerdict({ status: 1, stdout: '', stderr: 'spawnSync gh ETIMEDOUT', errorCode: 'ETIMEDOUT' }), { state: 'unverified', error: 'ETIMEDOUT' });
  assert.deepEqual(authVerdict({ status: 1, stdout: '', stderr: 'spawnSync gh EACCES', errorCode: 'EACCES' }), { state: 'unverified', error: 'EACCES' });
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
