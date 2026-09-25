// Found by the final review of phase 4, 25/09/2026 (named finding 1,
// Critical C1), before it became an incident in production; this file
// exists so it never does. `propose` builds its commit with git plumbing
// and never moves the working tree, so after a successful `propose --only
// memory/log.md` the log was still dirty. The Stop hook then blocked the
// session on that same path and told it to propose it; a second `propose`
// opened a second pull request for the same capture; `sync`, and so every
// scheduled round at its step 5, postponed with 75 on the dirty file, day
// after day (the shape of 13/09/2026); and once the owner merged the first
// pull request, the next day's `propose` refused with "not the same at
// HEAD and at main, run brain-kit sync" while `sync` refused with "commit,
// move or remove them": a deadlock only a person discarding by hand broke.
//
// The fix: a non-joined `propose` records what it pushed in the
// proposed-paths ledger (<git dir>/brain-kit-proposed.json), and the Stop
// hook, `propose` and `sync` share one comparison (src/guards/proposed.mjs):
// a path whose bytes are exactly what was pushed is proposed already, and
// one byte changed makes it unproposed work again.
//
// Every step is the real binary, as a process, against a vault made by
// `brain-kit init --yes`, registered on this (scratch) machine, with a bare
// remote on this machine and a fake `gh` that records its calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { git } from '../helpers/git-repo.mjs';
import { BIN, makeHookVault, runHookProcess } from '../helpers/hook-world.mjs';

const t = createTranslator('en');
const LOG = 'memory/log.md';
const SESSION = 's1';

function fakeGh(log) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://example.invalid/ana/vault/pull/' + (before.length + 1) + '\\n'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') {
  const created = before.filter((e) => e.args[1] === 'create' && e.args[e.args.indexOf('--head') + 1] === args[2]).at(-1);
  if (!created) { process.stderr.write('no pull requests found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ baseRefName: created.args[created.args.indexOf('--base') + 1], headRefName: args[2], url: 'https://example.invalid/ana/vault/pull/1' }) + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call\\n');
process.exit(2);
`;
}

function makeWorld() {
  const fx = makeHookVault();
  const remote = join(fx.base, 'remote.git');
  git(fx.base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(fx.root, ['branch', '-M', 'main']);
  git(fx.root, ['remote', 'add', 'origin', remote]);
  git(fx.root, ['push', '-q', '--no-verify', '-u', 'origin', 'main']);
  git(fx.root, ['remote', 'set-head', 'origin', '--auto']);
  const bin = join(fx.base, 'fakebin');
  mkdirSync(bin);
  const ghLog = join(fx.base, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), fakeGh(ghLog));
  chmodSync(join(bin, 'gh'), 0o755);
  // The vault's push gate runs `brain-kit` from PATH: this checkout's own.
  symlinkSync(BIN, join(bin, 'brain-kit'));
  const gitconfig = join(fx.base, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Ana\n\temail = ana@example.invalid\n[protocol "file"]\n\tallow = always\n');
  const env = { ...fx.env, PATH: `${bin}:${fx.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig };
  const elsewhere = join(fx.base, 'owner');
  git(fx.base, ['clone', '-q', remote, elsewhere]);
  return {
    ...fx,
    env,
    remote,
    elsewhere,
    kit: (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: fx.root, env, encoding: 'utf8' }),
    hook: (event, payload) => runHookProcess(event, payload, { env, cwd: join(fx.base, 'elsewhere') }),
    creates: () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((call) => call.args[0] === 'pr' && call.args[1] === 'create'),
    status: () => git(fx.root, ['status', '--porcelain=v1', '--untracked-files=all']),
    ledger: join(fx.root, '.git', 'brain-kit-proposed.json'),
    capture: (text) => {
      const file = join(fx.root, LOG);
      writeFileSync(file, `${readFileSync(file, 'utf8').replace(/\n*$/, '\n')}\n## 2026-09-25\n\n**Capture** ${text}\n`);
    },
  };
}

const stopPayload = { session_id: SESSION, hook_event_name: 'Stop', stop_hook_active: false };

test('25/09/2026 replayed: after propose, the Stop hook releases, a second propose opens no second pull request, sync restores the file and exits 0, and one byte edited blocks again', () => {
  const w = makeWorld();
  const begun = w.hook('session-start', { session_id: SESSION, source: 'startup', cwd: w.root });
  assert.equal(begun.status, 0, begun.stderr);
  const atHead = readFileSync(join(w.root, LOG), 'utf8');
  w.capture('(morning briefing) Ana moved the reading group to Thursdays.');
  const captured = readFileSync(join(w.root, LOG));

  const first = w.kit(['propose', 'Briefing captures', '--only', LOG]);
  assert.equal(first.status, EXIT.OK, first.stderr);
  assert.equal(w.creates().length, 1);
  const branch = w.creates()[0].args[w.creates()[0].args.indexOf('--head') + 1];
  assert.equal(w.status(), ` M ${LOG}\n`, 'propose never moves the working tree');
  const ledger = JSON.parse(readFileSync(w.ledger, 'utf8'));
  assert.equal(ledger.format, 1);
  assert.deepEqual(ledger.proposals.map((p) => [p.branch, p.paths, p.opened]), [[branch, [LOG], true]]);

  // The Stop hook releases: the log holds exactly what was pushed.
  const stopped = w.hook('stop', { ...stopPayload, cwd: w.root });
  assert.equal(stopped.status, 0);
  assert.equal(stopped.stdout, '', `the hook blocked: ${stopped.stdout}`);
  assert.equal(stopped.stderr, `${t('hook.stop.release_proposed', { count: 1, branches: [branch], inherited: 0 })}\n`);

  // A second propose opens no second pull request.
  const second = w.kit(['propose', 'Briefing captures', '--only', LOG]);
  assert.equal(second.status, EXIT.OK, second.stderr);
  assert.equal(second.stdout, `${t('propose.already_proposed_all', { count: 1, paths: [LOG], branches: [branch] })}\n`);
  assert.equal(w.creates().length, 1, 'exactly one pull request');

  // sync, what every round runs at its step 5, restores instead of postponing.
  const synced = w.kit(['sync']);
  assert.equal(synced.status, EXIT.OK, synced.stderr);
  assert.ok(synced.stdout.startsWith(t('sync.restored_proposed', { count: 1, paths: [LOG], branches: [branch] })), synced.stdout);
  assert.equal(w.status(), '');
  assert.equal(readFileSync(join(w.root, LOG), 'utf8'), atHead);
  assert.equal(existsSync(w.ledger), false, 'the ledger is pruned once nothing holds proposed bytes');
  assert.deepEqual(git(w.remote, ['show', `${branch}:${LOG}`]), captured.toString('utf8'), 'the capture lives on the pushed branch');

  // A new edit is this session's work again.
  w.capture('Ana asked for a shorter reading list.');
  const blocked = w.hook('stop', { ...stopPayload, cwd: w.root });
  assert.equal(blocked.status, 0);
  const verdict = JSON.parse(blocked.stdout);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, new RegExp(`^  ${LOG}$`, 'm'));
});

test('one byte changed after the push is unproposed work for all three: the hook blocks naming it, propose proposes it, sync postpones on it', () => {
  const w = makeWorld();
  w.hook('session-start', { session_id: SESSION, source: 'startup', cwd: w.root });
  w.capture('Ana finished the book on gardens.');
  assert.equal(w.kit(['propose', 'Captures', '--only', LOG]).status, EXIT.OK);
  writeFileSync(join(w.root, LOG), `${readFileSync(join(w.root, LOG), 'utf8')}x`);

  const stopped = w.hook('stop', { ...stopPayload, cwd: w.root });
  assert.equal(JSON.parse(stopped.stdout).decision, 'block');
  assert.match(JSON.parse(stopped.stdout).reason, new RegExp(`^  ${LOG}$`, 'm'));

  const synced = w.kit(['sync']);
  assert.equal(synced.status, EXIT.TEMPFAIL, synced.stdout + synced.stderr);
  assert.equal(synced.stderr, `${t('sync.dirty', { files: [LOG] })}\n`);

  const again = w.kit(['propose', 'Captures and one more', '--only', LOG]);
  assert.equal(again.status, EXIT.OK, again.stderr);
  assert.equal(w.creates().length, 2, 'the changed file is proposed');
});

test('the day after the owner merged: propose says it is proposed already and sync restores, fast-forwards and leaves the merged capture, instead of refusing each other', () => {
  const w = makeWorld();
  w.hook('session-start', { session_id: SESSION, source: 'startup', cwd: w.root });
  w.capture('(morning briefing) Ana moved the reading group to Thursdays.');
  const captured = readFileSync(join(w.root, LOG), 'utf8');
  assert.equal(w.kit(['propose', 'Briefing captures', '--only', LOG]).status, EXIT.OK);
  const branch = w.creates()[0].args[w.creates()[0].args.indexOf('--head') + 1];

  // The owner merges the pull request on the remote.
  git(w.elsewhere, ['fetch', '-q', 'origin', branch]);
  git(w.elsewhere, ['merge', '-q', '--no-ff', '-m', 'Merge the briefing', 'FETCH_HEAD']);
  git(w.elsewhere, ['push', '-q', 'origin', 'main']);

  const next = w.kit(['propose', 'Briefing captures', '--only', LOG]);
  assert.equal(next.status, EXIT.OK, `${next.stdout}${next.stderr}`);
  assert.equal(next.stdout, `${t('propose.already_proposed_all', { count: 1, paths: [LOG], branches: [branch] })}\n`);
  assert.equal(w.creates().length, 1);

  const synced = w.kit(['sync']);
  assert.equal(synced.status, EXIT.OK, synced.stderr);
  assert.match(synced.stdout, /fast-forwarded/);
  assert.equal(w.status(), '');
  assert.equal(readFileSync(join(w.root, LOG), 'utf8'), captured, 'the merged capture is on disk, from the default branch');
  assert.equal(existsSync(w.ledger), false);
});
