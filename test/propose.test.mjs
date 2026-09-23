// `brain-kit propose`: listed paths into a pull request against the default
// branch, built with git plumbing so HEAD, the index and the working tree
// never move (docs/incidents.md, "Git and pull requests").
//
// Every case is a real run against a throwaway vault, its bare remote and a
// fake `gh` that records its arguments (./helpers/propose-world.mjs). What
// was committed is read back from the REMOTE, where the pull request would
// read it, and every sentence is compared exactly with what the language
// pack renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runPropose } from '../src/commands/propose.mjs';
import { main } from '../src/cli.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { acquireLock, currentIdentity } from '../src/guards/lock.mjs';
import { GUARD_FILES } from '../src/guards/location.mjs';
import { takeSnapshot } from '../src/guards/snapshot.mjs';
import { createTranslator } from '../src/lang.mjs';
import { walkVault } from '../src/vault.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { git } from './helpers/git-repo.mjs';
import { configText, gitProbe, repoState } from './helpers/sync-world.mjs';
import { BRANCH, NOW, PR_URL, fingerprint, makeProposeWorld, note } from './helpers/propose-world.mjs';

const t = createTranslator('en');
const line = (key, params) => `${t(key, params)}\n`;
const IDENTITY = "Ana's Second Brain (curator) <curator@example.invalid>";

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function propose(world, argv, { env = world.env, cwd = world.vault, now = NOW } = {}) {
  const f = fakeIo();
  const code = await runPropose(argv, f.io, t, { env, cwd, now: () => now, walkVault, tmpdir: world.tmp });
  return { code, stdout: f.stdout(), stderr: f.stderr() };
}

function tip(world) {
  return world.remoteSha('refs/heads/main');
}

// The gh create call's arguments, with the body file's path replaced, since
// it is a fresh temporary path on every run.
function createArgs(world) {
  const create = world.ghCalls().find((call) => call.args[1] === 'create');
  if (!create) return null;
  const args = [...create.args];
  args[args.indexOf('--body-file') + 1] = '<body>';
  return args;
}

function commitMessage(world, commit) {
  const raw = git(world.remote, ['cat-file', 'commit', commit]);
  return raw.slice(raw.indexOf('\n\n') + 2);
}

test('success: exactly the listed path, on the remote tip, by the agent, as a pull request against main, and nothing local moves', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const base = tip(world);
  const before = fingerprint(world.vault);
  const run = await propose(world, ['Add A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, line('propose.opened', { url: PR_URL, base: 'main', branch: BRANCH, count: 1, origin: 'main' }));

  const commit = world.remoteSha(`refs/heads/${BRANCH}`);
  assert.ok(commit, 'the branch is on the remote');
  assert.equal(git(world.remote, ['rev-parse', `${commit}^`]).trim(), base, 'the only parent is the remote tip');
  assert.equal(git(world.remote, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ').length, 2, 'one parent, no merge');
  assert.deepEqual(world.changedIn(commit), ['A\tnotes/a.md']);
  assert.equal(git(world.remote, ['show', `${commit}:notes/a.md`]), note('A'));
  assert.equal(git(world.remote, ['log', '-1', '--format=%an <%ae>', commit]).trim(), IDENTITY);
  assert.equal(git(world.remote, ['log', '-1', '--format=%cn <%ce>', commit]).trim(), IDENTITY);
  assert.equal(commitMessage(world, commit), 'curate: Add A\n');

  assert.deepEqual(createArgs(world), ['pr', 'create', '--base', 'main', '--head', BRANCH, '--title', 'curate: Add A', '--body-file', '<body>']);
  const calls = world.ghCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['pr', 'view', BRANCH, '--json', 'baseRefName,headRefName,url']);
  // The vault has no template of its own: the kit's, rendered.
  const template = readFileSync(join(KIT_ROOT, 'lang', 'en', 'vault', '.brain-kit', 'pr-body.md'), 'utf8');
  const expected = template.replace('{{summary}}', 'Add A').replace('{{files}}', '- `notes/a.md`').replace('{{branch}}', BRANCH).replace('{{base}}', 'main');
  assert.equal(calls[0].body, expected);

  assert.deepEqual(fingerprint(world.vault), before, 'HEAD, the branches, the index and the working tree are byte-identical');
  assert.equal(gitProbe(world.vault, ['status', '--porcelain']).stdout, '?? notes/\n', 'the proposed file is still uncommitted locally');
  assert.deepEqual(readdirSync(world.tmp), [], 'the temporary index and body are removed');
});

test('--only commits exactly the listed paths; another session\'s modified, staged and new files stay exactly as they were', async () => {
  const world = makeProposeWorld();
  world.write('notes/mine.md', note('Mine'));
  world.write('notes/also-mine.md', note('Also mine'));
  world.write('index.md', '# Index\n\nAnother session is editing this.\n');
  world.write('drafts/theirs.md', note('Theirs'));
  world.write('staged.md', note('Staged'));
  git(world.vault, ['add', 'staged.md']);
  const before = fingerprint(world.vault);
  const statusBefore = gitProbe(world.vault, ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
  const run = await propose(world, ['Two notes', '--only', 'notes/mine.md', 'notes/also-mine.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const commit = world.remoteSha(`refs/heads/${BRANCH}`);
  assert.deepEqual(world.changedIn(commit), ['A\tnotes/also-mine.md', 'A\tnotes/mine.md']);
  assert.deepEqual(fingerprint(world.vault), before);
  assert.equal(gitProbe(world.vault, ['status', '--porcelain=v1', '--untracked-files=all']).stdout, statusBefore);
  assert.equal(git(world.vault, ['diff', '--cached', '--name-only']), 'staged.md\n', 'the other session\'s staged file is still staged, and only it');
});

test('a path given relative to a subdirectory, and a deleted path, are proposed as what they are', async () => {
  const world = makeProposeWorld();
  world.publish(1);
  git(world.vault, ['pull', '-q']);
  const published = git(world.vault, ['ls-files', 'published-*.md']).trim();
  world.write('notes/b.md', note('B'));
  unlinkSync(join(world.vault, published));
  const run = await propose(world, ['Rework', '--only', 'b.md', `../${published}`], { cwd: join(world.vault, 'notes') });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tnotes/b.md', `D\t${published}`]);
  assert.equal(existsSync(join(world.vault, published)), false, 'the deletion is still only in the working tree');
  assert.equal(git(world.vault, ['ls-files', published]).trim(), published, 'and the index still tracks the file');
});

test('a file name that is not valid UTF-8 never reaches a pull request: lint cannot scan it, so --all stops at the gate', async () => {
  const world = makeProposeWorld();
  // "caf" + 0xe9 + ".txt": Latin-1, not UTF-8.
  const name = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('.txt')]);
  writeFileSync(Buffer.concat([Buffer.from(`${world.vault}/`), name]), 'plain bytes\n');
  const refs = world.remoteRefs();
  const run = await propose(world, ['Latin-1', '--all', '--yes']);
  assert.equal(run.code, EXIT.FAILURE);
  // lint's own exit for a file it could not scan is 3 (degraded); propose
  // refuses on anything but 0, and exits 1: nothing was committed.
  assert.ok(run.stderr.endsWith(line('propose.lint_failed', { code: EXIT.DEGRADED })), run.stderr);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('the summary is carried intact: quotes, $(), backticks, a newline and accented letters, in the commit message and the title', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const accented = `Reuni${String.fromCharCode(0xe3)}o com a ${String.fromCharCode(0xc1)}rea`;
  const summary = `"quoted" 'single' $(touch pwned) \`id\` {{commit_prefix}}\nsecond line ${accented}`;
  const run = await propose(world, [summary, '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const commit = world.remoteSha(`refs/heads/${BRANCH}`);
  assert.equal(commitMessage(world, commit), `curate: ${summary}\n`);
  assert.equal(createArgs(world)[7], `curate: ${summary}`);
  assert.ok(world.ghCalls()[0].body.includes(summary));
  assert.equal(existsSync(join(world.vault, 'pwned')), false);
  assert.equal(existsSync(join(world.vault, 'notes', 'pwned')), false);
});

test('a clean tree: exit 0, nothing to propose, in one line, and nothing is asked of the remote or of gh', async () => {
  const world = makeProposeWorld();
  const refs = world.remoteRefs();
  const run = await propose(world, ['Nothing', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK);
  assert.equal(run.stdout, line('propose.nothing_to_propose'));
  assert.equal(run.stdout.split('\n').length, 2);
  assert.equal(run.stderr, '');
  assert.deepEqual(world.ghCalls(), []);
  assert.equal(world.remoteRefs(), refs);
});

test('--only naming a path that is not dirty, or outside the vault: exit 2 naming each, and nothing is pushed', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const refs = world.remoteRefs();
  let run = await propose(world, ['S', '--only', 'notes/a.md', 'index.md', 'nowhere.md']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.not_dirty', { paths: ['index.md', 'nowhere.md'] }));
  run = await propose(world, ['S', '--only', 'notes/a.md', '../outside.md']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.outside_vault', { paths: ['../outside.md'], dir: world.vault }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('an ignored file cannot be proposed by --only, and --all never sweeps one in', async () => {
  const world = makeProposeWorld();
  world.write('.gitignore', 'secret.md\n');
  git(world.vault, ['add', '.gitignore']);
  git(world.vault, ['commit', '-q', '-m', 'ignore']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  world.write('secret.md', note('Secret'));
  world.write('notes/a.md', note('A'));
  let run = await propose(world, ['S', '--only', 'secret.md']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.not_dirty', { paths: ['secret.md'] }));
  run = await propose(world, ['S', '--all', '--yes']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tnotes/a.md']);
});

test('--all without --yes refuses a file that was already dirty in the session snapshot, naming it, exit 75, nothing pushed', async () => {
  const world = makeProposeWorld();
  world.write('drafts/theirs.md', note('Theirs'));
  const snapshot = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T09:00:00.000Z') });
  world.write('notes/mine.md', note('Mine'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('propose.dirty_before', { files: ['drafts/theirs.md'], at: snapshot.at }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('--all with a fresh snapshot and only the session\'s own files proposes them all', async () => {
  const world = makeProposeWorld();
  takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T09:00:00.000Z') });
  world.write('notes/one.md', note('One'));
  world.write('notes/two.md', note('Two'));
  const run = await propose(world, ['Both', '--all']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tnotes/one.md', 'A\tnotes/two.md']);
});

test('--all with no snapshot, or one older than a day, or one from the future, requires --yes (exit 75); --yes proposes every dirty file', async () => {
  const world = makeProposeWorld();
  world.write('drafts/theirs.md', note('Theirs'));
  world.write('notes/mine.md', note('Mine'));
  let run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('propose.no_snapshot'));

  const old = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-22T11:59:59.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('propose.stale_snapshot', { at: old.at }));

  const future = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T12:00:01.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('propose.stale_snapshot', { at: future.at }));

  // Exactly a day old is still recent.
  takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-22T12:00:00.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.TEMPFAIL, 'both files were there at the snapshot');
  assert.equal(run.stderr, line('propose.dirty_before', { files: ['drafts/theirs.md', 'notes/mine.md'], at: '2026-09-22T12:00:00.000Z' }));
  assert.deepEqual(world.ghCalls(), []);

  run = await propose(world, ['Sweep', '--all', '--yes']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tdrafts/theirs.md', 'A\tnotes/mine.md']);
});

test('--only is unaffected by the snapshot: a path already dirty in it can still be named', async () => {
  const world = makeProposeWorld();
  world.write('notes/mine.md', note('Mine'));
  takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T09:00:00.000Z') });
  const run = await propose(world, ['Mine', '--only', 'notes/mine.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
});

test('a validate failure: exit 1 with its report, nothing pushed, and nothing local moves', async () => {
  const world = makeProposeWorld();
  world.write('notes/bad.md', '---\ntitle: Bad\n---\n\n# Bad\n');
  const before = fingerprint(world.vault);
  const refs = world.remoteRefs();
  const run = await propose(world, ['Bad', '--only', 'notes/bad.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /type-required/);
  assert.ok(run.stderr.endsWith(line('propose.validate_failed', { code: EXIT.FAILURE })));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
  assert.deepEqual(fingerprint(world.vault), before);
});

test('a lint failure: exit 1 with its report, nothing pushed', async () => {
  const world = makeProposeWorld();
  world.write('notes/secret.md', note('Secret', 'confidential: true\n'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['Secret', '--only', 'notes/secret.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.ok(run.stderr.endsWith(line('propose.lint_failed', { code: EXIT.FAILURE })), run.stderr);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('a push the remote refuses: exit 1, nothing published, and nothing local moves', async () => {
  const world = makeProposeWorld();
  writeFileSync(join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho refused by the remote >&2\nexit 1\n', { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const before = fingerprint(world.vault);
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^The push of bot\/2026-09-23-12-00-00 to remote origin failed/);
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), null);
  assert.deepEqual(world.ghCalls(), []);
  assert.deepEqual(fingerprint(world.vault), before);
});

test('a branch of the same name already on the remote is never replaced: exit 1, and that branch is untouched', async () => {
  const world = makeProposeWorld();
  git(world.elsewhere, ['push', '-q', 'origin', `main:refs/heads/${BRANCH}`]);
  const theirs = world.remoteSha(`refs/heads/${BRANCH}`);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^The push of /);
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), theirs);
  assert.deepEqual(world.ghCalls(), []);
});

test('a push that reports success but leaves nothing on the remote is exit 1, never a pull request', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const shim = join(world.base, 'fakebin', 'git');
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "push" ]; then exit 0; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /reported success, but the remote does not show/);
  assert.deepEqual(world.ghCalls(), []);
});

for (const [label, mode, key] of [
  ['gh failing', 'fail', 'propose.degraded_create'],
  ['gh unauthenticated', 'unauth', 'propose.degraded_create'],
  ['gh unable to report the pull request', 'viewfail', 'propose.degraded_view'],
  ['gh reporting another base', 'otherbase', 'propose.degraded_base'],
  ['gh reporting another head branch', 'otherhead', 'propose.degraded_base'],
]) {
  test(`${label}: exit 3, the branch published, the finishing command printed, and nothing local moves`, async () => {
    const world = makeProposeWorld();
    world.write('notes/a.md', note('A'));
    const before = fingerprint(world.vault);
    const run = await propose(world, ['Add A', '--only', 'notes/a.md'], { env: { ...world.env, FAKE_GH_MODE: mode } });
    assert.equal(run.code, EXIT.DEGRADED, run.stderr);
    assert.equal(run.stdout, '');
    assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'the commit is published');
    if (mode === 'otherbase') {
      assert.equal(run.stderr, line(key, { branch: BRANCH, found: `${BRANCH} -> bot/2026-09-22-10-00-00`, base: 'main', command: `gh pr edit ${BRANCH} --base main` }));
    } else if (mode === 'otherhead') {
      assert.equal(run.stderr, line(key, { branch: BRANCH, found: 'someone-else/branch -> main', base: 'main', command: `gh pr edit ${BRANCH} --base main` }));
    } else if (mode === 'viewfail') {
      const detail = `no pull requests found for branch "${BRANCH}"`;
      assert.equal(run.stderr, line(key, { branch: BRANCH, detail, command: `gh pr view ${BRANCH} --json baseRefName,headRefName,url` }));
    } else {
      const body = /--body-file (\S+)\n$/.exec(run.stderr);
      assert.ok(body, run.stderr);
      const detail = mode === 'fail' ? 'HTTP 422: Validation Failed (createPullRequest)' : 'To get started with GitHub CLI, please run:  gh auth login';
      const command = `gh pr create --base main --head ${BRANCH} --title 'curate: Add A' --body-file ${body[1]}`;
      assert.equal(run.stderr, line(key, { branch: BRANCH, detail, command }));
      assert.ok(run.stderr.includes(`Open it by hand with: gh pr create --base main --head ${BRANCH} --title 'curate: Add A' --body-file ${body[1]}`), run.stderr);
      assert.ok(existsSync(body[1]), 'the rendered body is left for the finishing command');
      assert.deepEqual(readdirSync(world.tmp), [basename(join(body[1], '..'))], 'only the body is left, never the temporary index');
      assert.equal(readFileSync(body[1], 'utf8'), world.ghCalls()[0].body);
      rmSync(join(body[1], '..'), { recursive: true });
    }
    assert.deepEqual(fingerprint(world.vault), before);
  });
}

test('gh absent: exit 3, the branch published, the finishing command printed', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const before = fingerprint(world.vault);
  const run = await propose(world, ['Add A', '--only', 'notes/a.md'], { env: { ...world.env, PATH: world.absentPath() } });
  assert.equal(run.code, EXIT.DEGRADED, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`));
  assert.match(run.stderr, new RegExp(`^The commit is pushed as ${BRANCH}, but the pull request was not opened: .*Open it by hand with: gh pr create --base main --head ${BRANCH} --title 'curate: Add A' --body-file \\S+\\n$`));
  rmSync(join(/--body-file (\S+)\n$/.exec(run.stderr)[1], '..'), { recursive: true });
  assert.deepEqual(world.ghCalls(), []);
  assert.deepEqual(fingerprint(world.vault), before);
});

test('the lock held: exit 75 naming the holder, and nothing is read, pushed or asked', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const lock = acquireLock(world.vault, { command: 'curate', env: world.env, now: NOW });
  try {
    const refs = world.remoteRefs();
    const run = await propose(world, ['A', '--only', 'notes/a.md']);
    assert.equal(run.code, EXIT.TEMPFAIL);
    const me = currentIdentity();
    assert.equal(run.stderr, line('lock.held', { pid: process.pid, host: me.host, command: 'curate', startedAt: NOW.toISOString() }));
    assert.equal(world.remoteRefs(), refs);
    assert.deepEqual(world.ghCalls(), []);
  } finally {
    lock.release();
  }
});

test('a reclaim that died and left its marker: exit 1 naming the marker', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const me = currentIdentity();
  const holder = { pid: dead, host: me.host, command: 'curate', startedAt: '2026-09-23T03:00:00.000Z', machineId: me.machineId, bootId: me.bootId, pidNamespace: me.pidNamespace };
  writeFileSync(join(world.vault, '.git', GUARD_FILES.LOCK), `${JSON.stringify(holder)}\n`);
  const marker = join(world.vault, '.git', GUARD_FILES.LOCK_RECLAIM);
  writeFileSync(marker, `${JSON.stringify({ ...holder, command: 'propose' })}\n`);
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('lock.reclaim_died', { marker }));
  assert.deepEqual(world.ghCalls(), []);
});

test('--dry changes no reference (remote-tracking ones included), no file and no branch, asks gh nothing, and prints the plan', async () => {
  const world = makeProposeWorld();
  world.publish(1);
  world.write('notes/a.md', note('A'));
  const before = { ...fingerprint(world.vault), all: repoState(world.vault) };
  const refs = world.remoteRefs();
  const run = await propose(world, ['Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('propose.dry_run', { files: ['notes/a.md'], remote: 'origin', base: 'main', branch: BRANCH, title: 'curate: Add A', origin: 'main' }));
  assert.deepEqual({ ...fingerprint(world.vault), all: repoState(world.vault) }, before);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('behind the remote, with the path untouched there: the commit sits on the fetched tip, never on the stale local HEAD', async () => {
  const world = makeProposeWorld();
  world.publish(2);
  const fresh = tip(world);
  const stale = world.sha('HEAD');
  assert.notEqual(fresh, stale);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const commit = world.remoteSha(`refs/heads/${BRANCH}`);
  assert.equal(git(world.remote, ['rev-parse', `${commit}^`]).trim(), fresh);
  assert.deepEqual(world.changedIn(commit), ['A\tnotes/a.md']);
  assert.equal(world.sha('HEAD'), stale, 'HEAD did not move');
});

test('a path the remote changed since HEAD: exit 1 naming it, because proposing it would revert the remote\'s change', async () => {
  const world = makeProposeWorld();
  git(world.elsewhere, ['pull', '-q']);
  writeFileSync(join(world.elsewhere, 'index.md'), '# Index\n\nMerged elsewhere.\n');
  git(world.elsewhere, ['commit', '-q', '-am', 'merged elsewhere']);
  git(world.elsewhere, ['push', '-q', 'origin', 'main']);
  world.write('index.md', '# Index\n\nEdited on the old version.\n');
  const refs = world.remoteRefs();
  const run = await propose(world, ['Index', '--only', 'index.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.base_differs', { files: ['index.md'], base: 'main', tip: tip(world).slice(0, 12) }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('a remote that cannot be reached: exit 1, nothing proposed', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['remote', 'set-url', 'origin', join(world.base, 'gone.git')]);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^Could not fetch main from remote origin/);
  assert.deepEqual(world.ghCalls(), []);
});

test('the vault\'s own body template is rendered, placeholders in one pass', async () => {
  const world = makeProposeWorld();
  world.write('.brain-kit/pr-body.md', 'S={{summary}}\nF={{files}}\nB={{base}} H={{branch}} U={{unknown}}\n');
  git(world.vault, ['add', '.brain-kit/pr-body.md']);
  git(world.vault, ['commit', '-q', '-m', 'body']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['has {{base}} in it', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.ghCalls()[0].body, `S=has {{base}} in it\nF=- \`notes/a.md\`\nB=main H=${BRANCH} U={{unknown}}\n`);
});

test('usage: no summary, no mode or both, --only with no path, --yes without --all, an unknown option: exit 2', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const cases = [
    [['--only', 'notes/a.md'], 'propose.no_summary'],
    [['  ', '--only', 'notes/a.md'], 'propose.no_summary'],
    [['S'], 'propose.mode_required'],
    [['S', '--all', '--only', 'notes/a.md'], 'propose.mode_required'],
    [['S', '--only'], 'propose.only_empty'],
    [['S', '--only', 'notes/a.md', '--yes'], 'propose.yes_without_all'],
  ];
  for (const [argv, key] of cases) {
    const run = await propose(world, argv);
    assert.equal(run.code, EXIT.USAGE, argv.join(' '));
    assert.equal(run.stderr, `${line(key)}${line('propose.usage')}`, argv.join(' '));
  }
  const unknown = await propose(world, ['S', '--only', 'notes/a.md', '--force']);
  assert.equal(unknown.code, EXIT.USAGE);
  assert.equal(unknown.stderr, `${line('propose.bad_argument', { arg: '--force' })}${line('propose.usage')}`);
  assert.deepEqual(world.ghCalls(), []);
});

test('outside a vault: exit 2, and nothing is locked or asked', async () => {
  const world = makeProposeWorld();
  const run = await propose(world, ['S', '--all', '--yes'], { cwd: world.base });
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.no_vault', { dir: world.base, config: 'brain-kit.config.json', index: 'index.md' }));
});

test('the command is reachable through the CLI, and --help prints its usage', async () => {
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const code = await main(['propose', '--help'], io);
  assert.equal(code, EXIT.OK);
  assert.match(out, /brain-kit propose/);
});

test('an operation left half done (a merge waiting for its commit): exit 75, nothing read, pushed or asked', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  writeFileSync(join(world.vault, '.git', 'MERGE_HEAD'), `${world.sha('HEAD')}\n`);
  const refs = world.remoteRefs();
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('propose.operation_in_progress', { operation: 'merge' }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('a vault that is a subdirectory of a larger repository: exit 2, nothing proposed', async () => {
  const world = makeProposeWorld();
  const outer = join(world.base, 'outer');
  git(world.base, ['init', '-q', '-b', 'main', outer]);
  writeFileSync(join(outer, 'README.txt'), 'outer\n');
  git(outer, ['add', '-A']);
  git(outer, ['commit', '-q', '-m', 'outer']);
  const inner = join(outer, 'vault');
  mkdirSync(inner);
  writeFileSync(join(inner, 'brain-kit.config.json'), configText());
  writeFileSync(join(inner, 'index.md'), '# Index\n');
  const run = await propose(world, ['Vault', '--only', 'index.md'], { cwd: inner });
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.not_toplevel', { dir: inner, prefix: 'vault/' }));
  assert.deepEqual(world.ghCalls(), []);
});

test('a git plumbing step that fails: exit 1, nothing pushed, nothing local moves', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  writeFileSync(join(world.base, 'fakebin', 'git'), `#!/bin/sh\nif [ "$1" = "write-tree" ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const before = fingerprint(world.vault);
  const refs = world.remoteRefs();
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^brain-kit propose stopped, and nothing more was done: git write-tree exited with status 128: fatal: simulated\n$/);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
  assert.deepEqual(fingerprint(world.vault), before);
  assert.deepEqual(readdirSync(world.tmp), [], 'the temporary index and body are removed on failure too');
});

function withGitConfig(world, change) {
  const file = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(config.git, change);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

test('a branch prefix that makes no branch name: exit 1 naming the branch, nothing pushed', async () => {
  const world = makeProposeWorld();
  withGitConfig(world, { branch_prefix: 'bad..' });
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.branch_invalid', { branch: 'bad..2026-09-23-12-00-00' }));
  assert.deepEqual(world.ghCalls(), []);
});

test('a pull request body template outside the vault is refused before anything is pushed', async () => {
  const world = makeProposeWorld();
  writeFileSync(join(world.base, 'outside.md'), 'outside {{summary}}\n');
  withGitConfig(world, { pr_body: '../outside.md' });
  world.write('notes/a.md', note('A'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.body_outside', { file: '../outside.md' }));
  assert.equal(world.remoteRefs(), refs);
});

test('a path whose change is only staged, its working tree back to HEAD\'s version, changes nothing: exit 1 naming it, nothing pushed', async () => {
  const world = makeProposeWorld();
  world.write('index.md', '# Index\n\nStaged, then undone in the working tree.\n');
  git(world.vault, ['add', 'index.md']);
  world.write('index.md', '# Index\n');
  const refs = world.remoteRefs();
  const run = await propose(world, ['Index', '--only', 'index.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.tree_mismatch', { expected: ['index.md'], actual: [] }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});
