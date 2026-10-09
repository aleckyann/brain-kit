// 07/10/2026 (twice) and 09/10/2026: the machine woke from sleep and the
// round fired before name resolution was back. The configured network check
// answered in a few milliseconds, `git fetch` could not resolve the remote's
// host, and the round ended exit 1 `sync_failed` with the reason "see the
// message above", a message no one reads in a scheduler. The rule: a sync
// failure keeps git's own words in its reason, and a lost network is a known
// cause (`sync_offline`, exit 69, the next window tries again); a cause the
// kit does not know says so.
//
// No network is touched: the remote is an ssh URL on a reserved host and
// GIT_SSH_COMMAND is a script that prints what ssh prints and exits 255.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { OFFLINE_PATTERNS } from '../../src/commands/curate.mjs';
import { git } from '../helpers/git-repo.mjs';
import { makeCurateWorld } from '../helpers/curate-world.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

// A world whose remote cannot be reached, and one round of it in `lang`
// with the ssh command printing `message`.
function failingRound(message, lang) {
  assert.ok(!message.includes("'"), 'the script quotes the message with single quotes');
  const w = makeCurateWorld();
  git(w.vault, ['remote', 'set-url', 'origin', 'ssh://example.invalid/vault.git']);
  const script = join(makeTempDir('brain-kit-ssh-'), 'ssh.sh');
  writeFileSync(script, `#!/bin/sh\necho '${message}' >&2\nexit 255\n`);
  chmodSync(script, 0o755);
  const r = w.curate([], { GIT_SSH_COMMAND: script, BRAIN_KIT_LANG: lang });
  return { w, r, last: w.lastRun() };
}

const RESOLVE = 'ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution';

for (const [lang, sentence] of [['en', /no network to the remote/], ['pt-BR', /sem rede para o remoto/]]) {
  test(`${lang}: a remote whose name cannot be resolved is sync_offline, exit 69, with ssh's words in the reason and no mark moved`, () => {
    const { w, r, last } = failingRound(RESOLVE, lang);
    assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
    assert.equal(last.exit, EXIT.UNAVAILABLE);
    assert.equal(last.reasonCode, 'sync_offline');
    assert.equal(last.unknownCause, undefined, 'a lost network is a known cause');
    assert.match(last.reason, /Could not resolve hostname example\.invalid/);
    assert.match(last.reason, sentence);
    assert.equal(w.watermark(), null);
    assert.equal(w.notifications().length, 1);
    assert.equal(w.notifications()[0].at(-1), last.reason);
    assert.equal(w.launches().length, 0);
  });

  test(`${lang}: the nearest positive case, a failure that is not a lost network, stays sync_failed with git's line and says the cause is unknown`, () => {
    const { w, r, last } = failingRound('fatal: protocol error: bad line length', lang);
    assert.equal(r.status, EXIT.FAILURE, r.stderr);
    assert.equal(last.reasonCode, 'sync_failed');
    assert.equal(last.unknownCause, true, 'git itself failed, and the record says the cause is unknown');
    assert.match(last.reason, /fatal: protocol error: bad line length/);
    assert.match(last.reason, lang === 'en' ? /\. The cause is not one brain-kit knows/ : /\. A causa não é uma que o brain-kit conhece/);
    assert.doesNotMatch(last.reason, /see the message above|veja a mensagem acima/);
    assert.doesNotMatch(last.reason, /\.\./, 'a reason that already ends in a full stop gets no second one');
    assert.equal(w.watermark(), null);
    assert.equal(w.launches().length, 0);
  });
}

for (const message of [
  'ssh: connect to host example.invalid port 22: Temporary failure in name resolution',
  'curl: (6) Could not resolve host: example.invalid',
  'ssh: connect to host example.invalid port 22: Name or service not known',
  'ssh: getaddrinfo: nodename nor servname provided, or not known',
  'ssh: connect to host example.invalid port 22: Network is unreachable',
]) {
  test(`"${message}" is a lost network: sync_offline, exit 69`, () => {
    const { r, last } = failingRound(message, 'en');
    assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
    assert.equal(last.reasonCode, 'sync_offline');
    assert.ok(last.reason.includes(message), last.reason);
  });
}

test('the nearest positive case of the unknown-cause sentence: a failure sync diagnosed itself is sync_failed WITHOUT it', () => {
  const w = makeCurateWorld();
  git(w.vault, ['remote', 'remove', 'origin']);
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'sync_failed');
  assert.match(last.reason, /this repository has no remote by that name/);
  assert.doesNotMatch(last.reason, /not one brain-kit knows/);
  assert.equal(last.unknownCause, undefined);
  assert.equal(w.watermark(), null);
});

test('a fast-forward that git itself refuses is a git failure: sync_failed with the unknown-cause sentence', () => {
  const w = makeCurateWorld();
  w.publishNotes(1);
  writeFileSync(join(w.vault, '.git', 'refs', 'heads', 'main.lock'), '');
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'sync_failed');
  assert.match(last.reason, /Could not fast-forward main/);
  assert.match(last.reason, /\. The cause is not one brain-kit knows/);
  assert.equal(last.unknownCause, true);
});

test('a postponed sync names what sync said, not "see the message above"', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.vault, '.git', 'BISECT_LOG'), '');
  const r = w.curate();
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'sync_postponed');
  assert.match(last.reason, /A bisect is in progress in this working tree/);
  assert.doesNotMatch(last.reason, /see the message above/);
});

test('every offline pattern is a RegExp, and the message that is not one of them matches none', () => {
  assert.equal(OFFLINE_PATTERNS.length, 6);
  for (const re of OFFLINE_PATTERNS) assert.ok(re instanceof RegExp);
  assert.ok(!OFFLINE_PATTERNS.some((re) => re.test('fatal: protocol error: bad line length')));
});
