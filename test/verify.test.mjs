// `brain-kit verify`: the owner stamps `verified` on what a merged pull
// request changed (docs/incidents.md, 22/07/2026 "who is allowed to write
// to the default branch").
//
// Every case is a real run against a throwaway vault cloned from a bare
// remote on this machine (./helpers/sync-world.mjs), with a fake `gh` first
// on PATH that prints the `gh pr view` payload the case chooses and records
// its arguments. "Merged" is simulated the way it looks from the owner's
// checkout: the other clone pushes the pull request's changes to the
// remote's default branch, and the vault pulls them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerify } from '../src/commands/verify.mjs';
import { main } from '../src/cli.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { acquireLock, describeLock } from '../src/guards/lock.mjs';
import { createTranslator } from '../src/lang.mjs';
import { stampVerified } from '../src/frontmatter-write.mjs';
import { git } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { configText, gitProbe, makeWorld, repoState } from './helpers/sync-world.mjs';

const BIN = fileURLToPath(new URL('../bin/brain-kit.mjs', import.meta.url));
const t = createTranslator('en');
const NOW = new Date('2026-09-23T12:00:00.000Z');
const AT = '2026-09-23T12:00:00+00:00';
const BY = 'human:ana';
const AGENT = { name: "Ana's Second Brain (curator)", email: 'curator@example.invalid' };

const line = (key, params) => `${t(key, params)}\n`;

function note(title, extra = '') {
  return `---\ntype: note\ntitle: ${title}\ndescription: A note about ${title}.\ngenerated:\n  by: brain-kit-curator/claude-opus-5-5\n  at: 2026-09-22T00:00:00+00:00\n${extra}---\n\n# ${title}\n\nSee [the index](../index.md).\n`;
}

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const FAKE_GH = (log) => `#!${process.execPath}
'use strict';
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), repo: process.env.GH_REPO ?? null, gitDir: process.env.GIT_DIR ?? null }) + '\\n');
if (process.env.FAKE_GH_STATUS && process.env.FAKE_GH_STATUS !== '0') {
  process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of 7.\\n');
  process.exit(Number(process.env.FAKE_GH_STATUS));
}
if (process.env.FAKE_GH_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_GH_SLEEP));
process.stdout.write((process.env.FAKE_GH_VIEW || '') + '\\n');
`;

// A world whose vault holds notes committed and published, the owner's
// identity configured in the vault, and a fake gh on PATH.
function makeVerifyWorld({ files = {}, lang = null, prefix = 'brain-kit-verify-' } = {}) {
  const world = makeWorld({ prefix });
  if (lang !== null) {
    const config = JSON.parse(configText());
    config.lang = lang;
    writeFileSync(join(world.vault, 'brain-kit.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  }
  for (const [rel, content] of Object.entries({
    'notes/a.md': note('A'), 'notes/b.md': note('B'), 'notes/untouched.md': note('Untouched'), 'templates/note.md': note('<title>'), ...files,
  })) {
    mkdirSync(join(world.vault, rel, '..'), { recursive: true });
    writeFileSync(join(world.vault, rel), content);
  }
  git(world.vault, ['add', '-A']);
  git(world.vault, ['commit', '-q', '-m', 'notes']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  // The owner's own identity, distinct from the one the fixture's git
  // passes on every call, so a commit carrying it can only have taken it
  // from the vault's configuration.
  git(world.vault, ['config', 'user.name', 'Ana Owner']);
  git(world.vault, ['config', 'user.email', 'owner@example.com']);
  git(world.elsewhere, ['pull', '-q', '--ff-only', 'origin', 'main']);

  const bin = join(world.base, 'fakebin');
  mkdirSync(bin);
  const log = join(world.base, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), FAKE_GH(log));
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...world.env, PATH: `${bin}:${world.env.PATH}` };
  return {
    ...world,
    env,
    // The pull request, merged: `change` maps a path to its new content, or
    // null to delete it; committed and pushed from the other clone.
    merge(change) {
      for (const [rel, content] of Object.entries(change)) {
        const full = join(world.elsewhere, rel);
        if (content === null) rmSync(full);
        else {
          mkdirSync(join(full, '..'), { recursive: true });
          writeFileSync(full, content);
        }
      }
      git(world.elsewhere, ['add', '-A']);
      git(world.elsewhere, ['commit', '-q', '-m', 'Merge pull request #7']);
      git(world.elsewhere, ['push', '-q', 'origin', 'main']);
    },
    pull() {
      git(world.vault, ['pull', '-q', '--ff-only']);
    },
    ghCalls() {
      return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    read(rel) {
      return readFileSync(join(world.vault, rel), 'utf8');
    },
  };
}

function view(files, { state = 'MERGED', base = 'main' } = {}) {
  return JSON.stringify({ state, baseRefName: base, files: files.map((path) => ({ path, additions: 1, deletions: 0 })) });
}

async function verify(world, argv, { env = {}, cwd = world.vault, deps = {} } = {}) {
  const f = fakeIo();
  const code = await runVerify(argv, f.io, t, { env: { ...world.env, ...env }, cwd, now: NOW, ...deps });
  return { code, stdout: f.stdout(), stderr: f.stderr() };
}

// Everything a refused run may not move: references, HEAD, the working
// tree (ignored files included) and every note's bytes.
function snapshot(world) {
  const state = repoState(world.vault);
  const notes = {};
  const walk = (rel) => {
    for (const entry of readdirSync(join(world.vault, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (path === '.git') continue;
      if (entry.isDirectory()) walk(path);
      else notes[path] = readFileSync(join(world.vault, path), 'latin1');
    }
  };
  walk('');
  return { refs: state.refs.split('\n').filter((ref) => !ref.startsWith('refs/remotes/')).join('\n'), head: state.head, status: state.status, notes };
}

function assertUnlocked(world) {
  assert.equal(describeLock(world.vault, { env: world.env }), null, 'the lock is released in every outcome');
}

function lastCommit(world) {
  return {
    author: git(world.vault, ['log', '-1', '--format=%an <%ae>']).trim(),
    committer: git(world.vault, ['log', '-1', '--format=%cn <%ce>']).trim(),
    subject: git(world.vault, ['log', '-1', '--format=%s']).trim(),
    body: git(world.vault, ['log', '-1', '--format=%b']).trim(),
    files: git(world.vault, ['diff-tree', '-r', '--no-commit-id', '--name-only', 'HEAD^', 'HEAD']).trim().split('\n').filter(Boolean).sort(),
  };
}

function validateJson(world, files) {
  const result = spawnSync(process.execPath, [BIN, 'validate', world.vault, '--json'], { encoding: 'utf8', env: world.env });
  const report = JSON.parse(result.stdout);
  const findings = (report.findings ?? []).filter((finding) => files.includes(finding.file));
  return { status: result.status, findings, report };
}

test('a pull request merged into the default branch: every changed note still here is stamped, committed with the owner\'s identity, and the push command printed', async () => {
  const world = makeVerifyWorld({ files: { 'notes/gone.md': note('Gone'), 'notes/data.txt': 'x\n' } });
  const changed = {
    'notes/a.md': note('A', 'tags: [one]\n'),
    'notes/new.md': note('New'),
    'notes/gone.md': null,
    'notes/data.txt': 'y\n',
    'index.md': '# Index, changed\n',
    'templates/note.md': note('<title>', 'tags: []\n'),
  };
  world.merge(changed);
  world.pull();
  const before = { a: world.read('notes/a.md'), fresh: world.read('notes/new.md'), untouched: world.read('notes/untouched.md') };
  world.env.FAKE_GH_VIEW = view(Object.keys(changed));

  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.deepEqual(world.ghCalls().map((call) => call.args), [['pr', 'view', '7', '--json', 'state,baseRefName,files']]);

  // Exactly the stamp, nothing else, in the two notes; nothing anywhere else.
  assert.equal(world.read('notes/a.md'), stampVerified(before.a, { by: BY, at: AT }));
  assert.equal(world.read('notes/new.md'), stampVerified(before.fresh, { by: BY, at: AT }));
  assert.equal(world.read('notes/untouched.md'), before.untouched);
  assert.ok(!world.read('templates/note.md').includes('verified'), 'a template is not a note');
  assert.ok(!world.read('index.md').includes('verified'), 'index.md is reserved');

  const commit = lastCommit(world);
  assert.equal(commit.author, 'Ana Owner <owner@example.com>');
  assert.equal(commit.committer, 'Ana Owner <owner@example.com>');
  assert.equal(commit.subject, t('verify.commit_pr', { pr: '7', branch: 'main', count: 2, by: BY }));
  assert.deepEqual(commit.files, ['notes/a.md', 'notes/new.md']);
  assert.equal(commit.body, 'notes/a.md\nnotes/new.md');
  assert.equal(git(world.vault, ['rev-parse', 'HEAD^']).trim(), world.sha('origin/main'), 'one commit on top of the merge');
  assert.equal(git(world.vault, ['status', '--porcelain']), '', 'the tree is clean after it');
  assert.equal(git(world.vault, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main');

  assert.equal(result.stdout, [
    line('verify.skipped_gone', { path: 'notes/gone.md' }),
    line('verify.skipped_not_note', { path: 'notes/data.txt' }),
    line('verify.skipped_not_note', { path: 'index.md' }),
    line('verify.skipped_not_note', { path: 'templates/note.md' }),
    line('verify.stamped', { path: 'notes/a.md', by: BY, at: AT }),
    line('verify.stamped', { path: 'notes/new.md', by: BY, at: AT }),
    line('verify.committed', { count: 2, sha: world.sha('HEAD').slice(0, 12), branch: 'main' }),
    line('verify.push_hint', { command: 'git push origin main' }),
  ].join(''));
  assert.equal(result.stderr, '');
  assertUnlocked(world);

  const checked = validateJson(world, ['notes/a.md', 'notes/new.md']);
  assert.deepEqual(checked.findings, [], JSON.stringify(checked.findings));
});

test('validate passes on every stamped note, in each of the three shapes', async () => {
  const world = makeVerifyWorld({
    files: {
      'notes/list.md': note('List', 'verified:\n  - by: human:bo\n    at: 2026-06-25T09:00:00Z\n'),
      'notes/inline.md': note('Inline', 'verified: { by: human:bo, at: 2026-06-25T09:00:00Z }\n'),
      'notes/block.md': note('Block', 'verified:\n  by: human:bo\n  at: 2026-06-25T09:00:00Z\n'),
    },
  });
  const result = await verify(world, ['--files', 'notes/list.md', 'notes/inline.md', 'notes/block.md', 'notes/a.md']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  const stamped = ['notes/a.md', 'notes/block.md', 'notes/inline.md', 'notes/list.md'];
  assert.deepEqual(lastCommit(world).files, stamped);
  for (const rel of ['notes/list.md', 'notes/inline.md', 'notes/block.md']) {
    assert.match(world.read(rel), /verified:\n {2}- by: human:bo\n {4}at: 2026-06-25T09:00:00Z\n {2}- by: human:ana\n {4}at: 2026-09-23T12:00:00\+00:00\n/);
  }
  const checked = validateJson(world, stamped);
  assert.deepEqual(checked.findings, [], JSON.stringify(checked.findings));
  // The yardstick sees these files: one broken stamp is a finding on it.
  writeFileSync(join(world.vault, 'notes/a.md'), world.read('notes/a.md').replace('at: 2026-09-23T12:00:00+00:00', 'at: 2026-09-23T12:00:00'));
  assert.deepEqual(validateJson(world, stamped).findings.map((finding) => finding.file), ['notes/a.md']);
});

test('an open pull request, a closed one and one merged into another base are refused, and nothing moves', async () => {
  for (const [options, key, params] of [
    [{ state: 'OPEN' }, 'verify.pr_not_merged', { pr: '7', state: 'OPEN' }],
    [{ state: 'CLOSED' }, 'verify.pr_not_merged', { pr: '7', state: 'CLOSED' }],
    [{ state: 'merged' }, 'verify.pr_not_merged', { pr: '7', state: 'merged' }],
    [{ base: 'bot/2026-09-22-10-00-00' }, 'verify.pr_wrong_base', { pr: '7', base: 'bot/2026-09-22-10-00-00', branch: 'main' }],
    [{ base: 'origin/main' }, 'verify.pr_wrong_base', { pr: '7', base: 'origin/main', branch: 'main' }],
  ]) {
    const world = makeVerifyWorld();
    world.merge({ 'notes/a.md': note('A', 'tags: [one]\n') });
    world.pull();
    world.env.FAKE_GH_VIEW = view(['notes/a.md'], options);
    const before = snapshot(world);
    const result = await verify(world, ['--pr', '7']);
    assert.equal(result.code, EXIT.FAILURE, JSON.stringify(options));
    assert.equal(result.stderr, line(key, params));
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(world), before);
    assertUnlocked(world);
  }
});

test('the agent\'s identity is refused, by e-mail or by name, as author or as committer, before gh is asked', async () => {
  for (const [how, apply, shown] of [
    ['email', (w) => git(w.vault, ['config', 'user.email', 'Curator@Example.invalid']), ['Ana Owner', 'Curator@Example.invalid']],
    ['name', (w) => git(w.vault, ['config', 'user.name', AGENT.name]), [AGENT.name, 'owner@example.com']],
    ['committer', () => ({ GIT_COMMITTER_EMAIL: AGENT.email }), ['Ana Owner', AGENT.email]],
    ['author', () => ({ GIT_AUTHOR_NAME: AGENT.name }), [AGENT.name, 'owner@example.com']],
  ]) {
    const world = makeVerifyWorld();
    const applied = apply(world);
    const env = typeof applied === 'object' ? applied : {};
    world.env.FAKE_GH_VIEW = view(['notes/a.md']);
    const before = snapshot(world);
    const result = await verify(world, ['--pr', '7'], { env });
    assert.equal(result.code, EXIT.FAILURE, how);
    assert.equal(result.stderr, line('verify.agent_identity', { name: shown[0], email: shown[1], file: 'brain-kit.config.json' }), how);
    assert.deepEqual(world.ghCalls(), [], `${how}: gh is never asked`);
    assert.deepEqual(snapshot(world), before, how);
    assertUnlocked(world);
  }
  // --files is refused the same way.
  const world = makeVerifyWorld();
  git(world.vault, ['config', 'user.email', AGENT.email]);
  const before = snapshot(world);
  const result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.deepEqual(snapshot(world), before);
});

test('an identity git cannot resolve stops the run before anything is written', async () => {
  const world = makeVerifyWorld();
  git(world.vault, ['config', '--unset', 'user.email']);
  git(world.vault, ['config', 'user.useConfigOnly', 'true']);
  const before = snapshot(world);
  const result = await verify(world, ['--files', 'notes/a.md'], { env: { EMAIL: '' } });
  assert.equal(result.code, EXIT.FAILURE);
  assert.ok(result.stderr.startsWith(t('verify.identity_unknown', { detail: '' }).trimEnd()), result.stderr);
  assert.deepEqual(snapshot(world), before);
});

test('a dirty tree, an untracked file or an operation in progress postpones the run, exit 75, and nothing moves', async () => {
  for (const [label, dirty, expected] of [
    ['modified', (w) => writeFileSync(join(w.vault, 'notes/untouched.md'), 'changed\n'), line('verify.dirty', { files: ['notes/untouched.md'] })],
    ['untracked', (w) => writeFileSync(join(w.vault, 'draft.md'), 'draft\n'), line('verify.dirty', { files: ['draft.md'] })],
    ['staged', (w) => { writeFileSync(join(w.vault, 'notes/b.md'), 'x\n'); git(w.vault, ['add', 'notes/b.md']); }, line('verify.dirty', { files: ['notes/b.md'] })],
    ['merge', (w) => writeFileSync(join(w.vault, '.git', 'MERGE_HEAD'), `${w.sha('HEAD')}\n`), line('verify.operation_in_progress', { operation: 'merge' })],
  ]) {
    const world = makeVerifyWorld();
    dirty(world);
    world.env.FAKE_GH_VIEW = view(['notes/a.md']);
    const before = snapshot(world);
    const result = await verify(world, ['--pr', '7']);
    assert.equal(result.code, EXIT.TEMPFAIL, label);
    assert.equal(result.stderr, expected, label);
    assert.deepEqual(world.ghCalls(), [], label);
    assert.deepEqual(snapshot(world), before, label);
    assertUnlocked(world);
  }
});

test('a branch other than the default, or a detached HEAD, is refused and nothing moves', async () => {
  const world = makeVerifyWorld();
  git(world.vault, ['checkout', '-q', '-b', 'bot/2026-09-23-10-00-00']);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  let before = snapshot(world);
  let result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.not_on_default', { branch: 'main', current: 'bot/2026-09-23-10-00-00' }));
  assert.deepEqual(snapshot(world), before);

  git(world.vault, ['checkout', '-q', '--detach', 'main']);
  before = snapshot(world);
  result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.detached', { branch: 'main' }));
  assert.deepEqual(snapshot(world), before);
  assert.deepEqual(world.ghCalls(), []);
  assertUnlocked(world);
});

test('a merged pull request not yet pulled into this checkout is refused naming sync: its new note would be missed', async () => {
  const world = makeVerifyWorld();
  world.merge({ 'notes/a.md': note('A', 'tags: [one]\n'), 'notes/new.md': note('New') });
  world.env.FAKE_GH_VIEW = view(['notes/a.md', 'notes/new.md']);
  const before = snapshot(world);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.behind', { branch: 'main', upstream: 'origin/main', behind: 1 }));
  assert.deepEqual(snapshot(world), before);
  assertUnlocked(world);
});

test('a remote that cannot be fetched is refused: whether the merge is here is not known', async () => {
  const world = makeVerifyWorld();
  git(world.vault, ['remote', 'set-url', 'origin', join(world.base, 'nowhere.git')]);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const before = snapshot(world);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.ok(result.stderr.startsWith('Could not fetch main from remote origin'), result.stderr);
  assert.deepEqual(snapshot(world), before);
});

test('a default branch tracking a local branch is refused for --pr', async () => {
  const world = makeVerifyWorld();
  git(world.vault, ['config', 'branch.main.remote', '.']);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const before = snapshot(world);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.local_upstream', { branch: 'main' }));
  assert.deepEqual(snapshot(world), before);
});

test('gh failing, answering garbage, listing no file or 100 files is refused, and nothing moves', async () => {
  const cases = [
    [{ FAKE_GH_STATUS: '1' }, (r) => assert.equal(r.stderr, line('verify.gh_failed', { pr: '7', detail: 'GraphQL: Could not resolve to a PullRequest with the number of 7.' }))],
    [{ FAKE_GH_VIEW: 'not json' }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: '' }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: 'null' }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', baseRefName: 'main' }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', files: [{ path: 'notes/a.md' }] }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ baseRefName: 'main', files: [{ path: 'notes/a.md' }] }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', baseRefName: 'main', files: [{ path: 7 }] }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', baseRefName: 'main', files: [{ path: '' }] }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', baseRefName: 'main', files: [null] }) }, (r) => assert.ok(r.stderr.startsWith('gh answered about pull request #7 in a shape'), r.stderr)],
    [{ FAKE_GH_VIEW: view([]) }, (r) => assert.equal(r.stderr, line('verify.pr_no_files', { pr: '7' }))],
    [{ FAKE_GH_VIEW: view(Array.from({ length: 100 }, (_, i) => `notes/n${i}.md`)) }, (r) => assert.equal(r.stderr, line('verify.pr_too_many_files', { pr: '7', count: 100, limit: 100 }))],
  ];
  for (const [env, check] of cases) {
    const world = makeVerifyWorld();
    Object.assign(world.env, env);
    const before = snapshot(world);
    const result = await verify(world, ['--pr', '7']);
    assert.equal(result.code, EXIT.FAILURE, JSON.stringify(env));
    check(result);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(world), before, JSON.stringify(env));
    assertUnlocked(world);
  }
});

test('99 files is under gh\'s limit and is read', async () => {
  const world = makeVerifyWorld();
  world.env.FAKE_GH_VIEW = view(['notes/a.md', ...Array.from({ length: 98 }, (_, i) => `gone/n${i}.md`)]);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.deepEqual(lastCommit(world).files, ['notes/a.md']);
});

test('gh is asked without GH_REPO and without the caller\'s GIT_DIR', async () => {
  const world = makeVerifyWorld();
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const other = realpathSync(makeTempDir('brain-kit-verify-other-'));
  git(other, ['init', '-q']);
  const result = await verify(world, ['--pr', '7'], { env: { GH_REPO: 'someone/else', GIT_DIR: join(other, '.git') } });
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.deepEqual(world.ghCalls().map((call) => [call.repo, call.gitDir]), [[null, null]]);
  assert.equal(gitProbe(other, ['rev-parse', '-q', '--verify', 'HEAD']).status, 1, 'nothing was committed into the other repository');
});

test('a merged pull request whose files hold no note is said, exit 0, and nothing is committed', async () => {
  const world = makeVerifyWorld({ files: { 'notes/data.txt': 'x\n' } });
  world.merge({ 'notes/data.txt': 'y\n' });
  world.pull();
  world.env.FAKE_GH_VIEW = view(['notes/data.txt', 'elsewhere/outside.md']);
  const head = world.sha('HEAD');
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.equal(result.stdout, [
    line('verify.skipped_not_note', { path: 'notes/data.txt' }),
    line('verify.skipped_gone', { path: 'elsewhere/outside.md' }),
    line('verify.nothing_to_stamp', { pr: '7' }),
  ].join(''));
  assert.equal(world.sha('HEAD'), head);
});

test('one note the writer refuses stops the whole run: nothing is written in any note', async () => {
  const world = makeVerifyWorld({ files: { 'notes/plain.md': '# No frontmatter\n', 'notes/odd.md': note('Odd', 'verified: [human:bo]\n') } });
  world.env.FAKE_GH_VIEW = view(['notes/a.md', 'notes/plain.md', 'notes/odd.md', 'notes/b.md']);
  const before = snapshot(world);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, [
    line('verify.refused_no_frontmatter', { path: 'notes/plain.md' }),
    line('verify.refused_unreadable', { path: 'notes/odd.md' }),
    line('verify.nothing_written'),
  ].join(''));
  assert.deepEqual(snapshot(world), before);
  assertUnlocked(world);
});

test('a note that is not UTF-8 is refused, not rewritten with replacement characters', async () => {
  const world = makeVerifyWorld({ files: { 'notes/latin.md': Buffer.from('---\ntype: note\ntitle: Caf\xe9\n---\n', 'latin1') } });
  const before = snapshot(world);
  const result = await verify(world, ['--files', 'notes/latin.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.refused_encoding', { path: 'notes/latin.md' }) + line('verify.nothing_written'));
  assert.deepEqual(snapshot(world), before);
});

test('--files stamps exactly the listed notes, relative to where it runs, and names no pull request', async () => {
  const world = makeVerifyWorld();
  const before = world.read('notes/b.md');
  const result = await verify(world, ['--files', 'b.md', './b.md', join(world.vault, 'notes/a.md')], { cwd: join(world.vault, 'notes') });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const commit = lastCommit(world);
  assert.deepEqual(commit.files, ['notes/a.md', 'notes/b.md']);
  assert.equal(commit.subject, t('verify.commit_files', { count: 2, by: BY }));
  assert.equal(world.read('notes/b.md'), stampVerified(before, { by: BY, at: AT }));
  assert.deepEqual(world.ghCalls(), [], '--files never asks gh');
  assert.ok(result.stdout.endsWith(line('verify.push_hint', { command: 'git push origin main' })));
});

test('--files refuses, exit 2 and nothing written, a path outside the vault, one that does not exist, and one that is not a note', async () => {
  const outside = join(realpathSync(makeTempDir('brain-kit-verify-out-')), 'x.md');
  writeFileSync(outside, note('X'));
  for (const [path, key] of [
    [outside, 'verify.file_outside'],
    ['..', 'verify.file_outside'],
    ['.', 'verify.file_outside'],
    ['notes/missing.md', 'verify.file_gone'],
    ['index.md', 'verify.file_not_note'],
    ['templates/note.md', 'verify.file_not_note'],
    ['brain-kit.config.json', 'verify.file_not_note'],
    ['notes', 'verify.file_not_note'],
  ]) {
    const world = makeVerifyWorld();
    const before = snapshot(world);
    const result = await verify(world, ['--files', 'notes/a.md', path]);
    assert.equal(result.code, EXIT.USAGE, path);
    assert.equal(result.stderr, line(key, { path }), path);
    assert.deepEqual(snapshot(world), before, path);
  }
});

test('a note git ignores, or one under validate.ignore_paths, is not a note to stamp', async () => {
  const world = makeVerifyWorld({ files: { '.gitignore': 'private/\n' } });
  mkdirSync(join(world.vault, 'private'));
  writeFileSync(join(world.vault, 'private/p.md'), note('P'));
  let result = await verify(world, ['--files', 'private/p.md']);
  assert.equal(result.code, EXIT.USAGE);
  assert.equal(result.stderr, line('verify.file_not_note', { path: 'private/p.md' }));

  world.env.FAKE_GH_VIEW = view(['private/p.md', 'notes/a.md']);
  result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.ok(result.stdout.startsWith(line('verify.skipped_not_note', { path: 'private/p.md' })), result.stdout);
  assert.deepEqual(lastCommit(world).files, ['notes/a.md']);

  const ignored = makeVerifyWorld();
  const config = JSON.parse(ignored.read('brain-kit.config.json'));
  config.validate.ignore_paths = ['notes/b.md'];
  writeFileSync(join(ignored.vault, 'brain-kit.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  git(ignored.vault, ['commit', '-q', '-am', 'ignore b']);
  result = await verify(ignored, ['--files', 'notes/b.md']);
  assert.equal(result.code, EXIT.USAGE);
});

test('a symbolic link to a note is not stamped through', async () => {
  const world = makeVerifyWorld();
  spawnSync('ln', ['-s', 'a.md', join(world.vault, 'notes/link.md')]);
  git(world.vault, ['add', 'notes/link.md']);
  git(world.vault, ['commit', '-q', '-m', 'link']);
  const before = snapshot(world);
  const result = await verify(world, ['--files', 'notes/link.md']);
  assert.equal(result.code, EXIT.USAGE);
  assert.deepEqual(snapshot(world), before);
});

test('CRLF notes go through verify with no byte outside the key changed', async () => {
  const crlf = note('C').replace(/\n/g, '\r\n');
  const world = makeVerifyWorld({ files: { 'notes/c.md': crlf, '.gitattributes': '*.md -text\n' } });
  const result = await verify(world, ['--files', 'notes/c.md']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  const after = readFileSync(join(world.vault, 'notes/c.md'), 'utf8');
  assert.equal(after, crlf.replace('---\r\n\r\n# C', 'verified:\r\n  - by: human:ana\r\n    at: 2026-09-23T12:00:00+00:00\r\n---\r\n\r\n# C'));
});

test('a vault in a folder below the repository\'s top maps the pull request\'s paths into it', async () => {
  const base = realpathSync(makeTempDir('brain-kit-verify-nested-'));
  const remote = join(base, 'remote.git');
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'brain', 'notes'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'brain', 'brain-kit.config.json'), configText());
  writeFileSync(join(repo, 'brain', 'index.md'), '# Index\n');
  writeFileSync(join(repo, 'brain', 'notes', 'a.md'), note('A'));
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes', 'a.md'), note('Top level, not the vault'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['config', 'user.name', 'Ana']);
  git(repo, ['config', 'user.email', 'ana@example.com']);
  const bin = join(base, 'fakebin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH(join(base, 'gh.jsonl')));
  chmodSync(join(bin, 'gh'), 0o755);
  mkdirSync(join(base, 'home'));
  writeFileSync(join(base, 'gitconfig'), '');
  const env = {
    ...process.env, HOME: join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    XDG_STATE_HOME: join(base, 'state'), BRAIN_KIT_STATE_DIR: join(base, 'state', 'brain-kit'), PATH: `${bin}:${process.env.PATH}`,
    FAKE_GH_VIEW: view(['brain/notes/a.md', 'notes/a.md']),
  };
  const f = fakeIo();
  const code = await runVerify(['--pr', '7'], f.io, t, { env, cwd: join(repo, 'brain'), now: NOW });
  assert.equal(code, EXIT.OK, f.stderr());
  assert.equal(f.stdout().split('\n')[0], t('verify.skipped_outside', { path: 'notes/a.md' }));
  assert.deepEqual(git(repo, ['diff-tree', '-r', '--no-commit-id', '--name-only', 'HEAD^', 'HEAD']).trim().split('\n'), ['brain/notes/a.md']);
  assert.ok(!readFileSync(join(repo, 'notes', 'a.md'), 'utf8').includes('verified'));
});

test('a commit git refuses puts every note back as it was, exit 1', async () => {
  const world = makeVerifyWorld();
  const hooks = join(world.base, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "pre-commit says no" >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(world.vault, ['config', 'core.hooksPath', hooks]);
  const before = snapshot(world);
  const result = await verify(world, ['--files', 'notes/a.md', 'notes/b.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.commit_failed', { detail: 'pre-commit says no' }));
  assert.deepEqual(snapshot(world), before);
  assertUnlocked(world);
});

test('a commit hook that changes the tree leaves a commit verify cannot prove, and says so', async () => {
  const world = makeVerifyWorld();
  const hooks = join(world.base, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\necho extra >> notes/untouched.md\n');
  chmodSync(join(hooks, 'post-commit'), 0o755);
  git(world.vault, ['config', 'core.hooksPath', hooks]);
  const result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.commit_unproven', { branch: 'main' }));
});

test('the lock held by another run postpones verify, exit 75, and nothing moves', async () => {
  const world = makeVerifyWorld();
  const lock = acquireLock(world.vault, { command: 'sync', env: world.env });
  try {
    const before = snapshot(world);
    const result = await verify(world, ['--files', 'notes/a.md']);
    assert.equal(result.code, EXIT.TEMPFAIL);
    assert.deepEqual(snapshot(world), before);
  } finally {
    lock.release();
  }
});

test('the commit message is in the vault\'s own language', async () => {
  const world = makeVerifyWorld({ lang: 'pt-BR' });
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const result = await verify(world, ['--pr', '12']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.equal(lastCommit(world).subject, createTranslator('pt-BR')('verify.commit_pr', { pr: '12', branch: 'main', count: 1, by: BY }));
  assert.equal(result.stdout.split('\n')[0], t('verify.stamped', { path: 'notes/a.md', by: BY, at: AT }), 'the person still reads their own language');
});

test('usage: no mode, both modes, a bad number, --files with nothing, an unknown argument, all exit 2 before anything runs', async () => {
  const world = makeVerifyWorld();
  for (const [argv, key, params] of [
    [[], 'verify.no_mode', {}],
    [['--pr', '7', '--files', 'notes/a.md'], 'verify.both_modes', {}],
    [['--files', 'notes/a.md', '--pr', '7'], 'verify.both_modes', {}],
    [['--pr'], 'verify.bad_pr', { value: '' }],
    [['--pr', '0'], 'verify.bad_pr', { value: '0' }],
    [['--pr', '7a'], 'verify.bad_pr', { value: '7a' }],
    [['--pr', '#7'], 'verify.bad_pr', { value: '#7' }],
    [['--pr', '-7'], 'verify.bad_pr', { value: '-7' }],
    [['--files'], 'verify.no_files', {}],
    [['--pr', '7', '--yes'], 'verify.bad_argument', { arg: '--yes' }],
    [['--pr', '7', world.vault, 'extra'], 'verify.bad_argument', { arg: 'extra' }],
  ]) {
    const result = await verify(world, argv);
    assert.equal(result.code, EXIT.USAGE, argv.join(' '));
    assert.equal(result.stderr, line(key, params) + line('verify.usage'), argv.join(' '));
  }
  const help = await verify(world, ['--help']);
  assert.equal(help.code, EXIT.OK);
  assert.equal(help.stdout, line('verify.usage'));
  const notDir = await verify(world, ['--pr', '7', join(world.vault, 'index.md')]);
  assert.equal(notDir.code, EXIT.USAGE);
  const noVault = await verify(world, ['--pr', '7', world.base]);
  assert.equal(noVault.code, EXIT.USAGE);
  assert.equal(noVault.stderr, line('verify.no_vault', { dir: world.base, config: 'brain-kit.config.json', index: 'index.md' }));
  assert.deepEqual(world.ghCalls(), []);
});

test('a [dir] argument finds the vault from elsewhere', async () => {
  const world = makeVerifyWorld();
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const result = await verify(world, ['--pr', '7', world.vault], { cwd: world.base });
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.deepEqual(lastCommit(world).files, ['notes/a.md']);
});

test('the CLI dispatches verify, and a real process exits with its code', async () => {
  const f = fakeIo();
  assert.equal(await main(['verify', '--help'], f.io), EXIT.OK);
  assert.ok(f.stdout().startsWith('Usage: brain-kit verify') || f.stdout().startsWith('Uso: brain-kit verify'));
  const world = makeVerifyWorld();
  world.env.FAKE_GH_VIEW = view(['notes/a.md'], { state: 'OPEN' });
  const open = spawnSync(process.execPath, [BIN, 'verify', '--pr', '7'], { cwd: world.vault, encoding: 'utf8', env: { ...world.env, BRAIN_KIT_LANG: 'en' } });
  assert.equal(open.status, EXIT.FAILURE, open.stderr);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const merged = spawnSync(process.execPath, [BIN, 'verify', '--pr', '7'], { cwd: world.vault, encoding: 'utf8', env: { ...world.env, BRAIN_KIT_LANG: 'en' } });
  assert.equal(merged.status, EXIT.OK, merged.stderr);
  assert.match(merged.stdout, /Push it with: git push origin main\n$/);
});

function hook(world, name, body) {
  const hooks = join(world.base, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(hooks, name), 0o755);
  git(world.vault, ['config', 'core.hooksPath', hooks]);
}

test('a remote that no longer publishes the default branch is refused, naming what the fetch found', async () => {
  const world = makeVerifyWorld();
  git(world.elsewhere, ['push', '-q', 'origin', 'main:trunk']);
  git(world.remote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  git(world.remote, ['update-ref', '-d', 'refs/heads/main']);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const before = snapshot(world);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.remote_unproven', { remote: 'origin', branch: 'main', detail: 'missing' }));
  assert.deepEqual(snapshot(world), before);
});

test('a pull request path that climbs out of the repository is outside the vault, never looked up', async () => {
  const world = makeVerifyWorld();
  writeFileSync(join(world.base, 'x.md'), note('X'));
  world.env.FAKE_GH_VIEW = view(['../x.md', 'notes//a.md', 'notes/a.md']);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.ok(result.stdout.startsWith(line('verify.skipped_outside', { path: '../x.md' }) + line('verify.skipped_outside', { path: 'notes//a.md' })), result.stdout);
  assert.ok(!readFileSync(join(world.base, 'x.md'), 'utf8').includes('verified'));
  assert.deepEqual(lastCommit(world).files, ['notes/a.md']);
});

test('a byte-order mark and a file mode survive the stamp', async () => {
  const bom = `${String.fromCharCode(0xfeff)}${note('Bom')}`;
  const world = makeVerifyWorld({ files: { 'notes/bom.md': bom, 'notes/run.md': note('Run') } });
  chmodSync(join(world.vault, 'notes/run.md'), 0o755);
  git(world.vault, ['commit', '-q', '-am', 'mode']);
  const result = await verify(world, ['--files', 'notes/bom.md', 'notes/run.md']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.equal(world.read('notes/bom.md'), stampVerified(bom, { by: BY, at: AT }));
  assert.ok(readFileSync(join(world.vault, 'notes/bom.md')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.equal(statSync(join(world.vault, 'notes/run.md')).mode & 0o777, 0o755);
  assert.equal(git(world.vault, ['ls-tree', 'HEAD', 'notes/run.md']).split(' ')[0], '100755');
});

test('a note changed by someone else between reading and writing puts every note back and commits nothing', async () => {
  const world = makeVerifyWorld();
  const head = world.sha('HEAD');
  const a = world.read('notes/a.md');
  const result = await verify(world, ['--files', 'notes/a.md', 'notes/b.md'], {
    deps: { beforeWrite: (rel) => { if (rel === 'notes/b.md') writeFileSync(join(world.vault, 'notes/b.md'), 'someone else\n'); } },
  });
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.changed_underneath', { path: 'notes/b.md' }));
  assert.equal(world.read('notes/a.md'), a, 'the note already written is put back');
  assert.equal(world.read('notes/b.md'), 'someone else\n', 'the other writer\'s bytes are not overwritten');
  assert.equal(world.sha('HEAD'), head);
  assert.deepEqual(readdirSync(join(world.vault, 'notes')).filter((name) => name.includes('brain-kit-tmp')), []);
});

test('a hook that adds a commit of its own leaves a commit verify cannot prove', async () => {
  const world = makeVerifyWorld();
  hook(world, 'post-commit', '[ -f .second ] && exit 0; : > .second; echo more >> notes/a.md; git commit -q -m second -- notes/a.md; rm .second');
  const result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.commit_unproven', { branch: 'main' }));
});

test('a hook that slips another file into the commit leaves a commit verify cannot prove', async () => {
  const world = makeVerifyWorld();
  hook(world, 'post-commit', '[ -f .amending ] && exit 0; : > .amending; echo x > extra.txt; git add extra.txt; git commit -q --amend --no-edit; rm .amending');
  const result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.commit_unproven', { branch: 'main' }));
  assert.deepEqual(lastCommit(world).files, ['extra.txt', 'notes/a.md']);
  assert.equal(git(world.vault, ['status', '--porcelain']), '', 'the tree is clean, so only the path check saw it');
});

test('the push command names the remote the default branch tracks', async () => {
  const world = makeVerifyWorld();
  git(world.vault, ['remote', 'rename', 'origin', 'upstream']);
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  const result = await verify(world, ['--pr', '7']);
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.ok(result.stdout.endsWith(line('verify.push_hint', { command: 'git push upstream main' })), result.stdout);
});

test('a configured default branch that is no branch name, or none known at all, is refused', async () => {
  const world = makeVerifyWorld();
  const config = JSON.parse(world.read('brain-kit.config.json'));
  config.vault.default_branch = 'bad..name';
  writeFileSync(join(world.vault, 'brain-kit.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  git(world.vault, ['commit', '-q', '-am', 'bad default']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  let result = await verify(world, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.default_branch_invalid', { name: 'bad..name', file: 'brain-kit.config.json' }));

  const lone = makeVerifyWorld();
  git(lone.vault, ['branch', '-m', 'main', 'trunk']);
  git(lone.vault, ['remote', 'remove', 'origin']);
  result = await verify(lone, ['--files', 'notes/a.md']);
  assert.equal(result.code, EXIT.FAILURE);
  assert.equal(result.stderr, line('verify.no_default_branch', { file: 'brain-kit.config.json' }));
});

test('a gh that hangs is given up on, exit 1, and nothing moves', async () => {
  const world = makeVerifyWorld();
  world.env.FAKE_GH_VIEW = view(['notes/a.md']);
  world.env.FAKE_GH_SLEEP = '5000';
  const before = snapshot(world);
  const started = Date.now();
  const result = await verify(world, ['--pr', '7'], { deps: { ghTimeout: 300 } });
  assert.equal(result.code, EXIT.FAILURE);
  assert.ok(result.stderr.startsWith('gh could not read pull request #7'), result.stderr);
  assert.ok(Date.now() - started < 4500, 'it did not wait for gh');
  assert.deepEqual(snapshot(world), before);
});
