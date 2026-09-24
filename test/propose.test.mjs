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
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { parseRoundRecord, runPropose } from '../src/commands/propose.mjs';
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

async function propose(world, argv, { env = world.env, cwd = world.vault, now = NOW, extra = {} } = {}) {
  const f = fakeIo();
  const code = await runPropose(argv, f.io, t, { env, cwd, now: () => now, walkVault, tmpdir: world.tmp, ...extra });
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
  assert.deepEqual(readdirSync(join(world.vault, '.git', 'brain-kit-proposals')), [], 'a confirmed proposal leaves no body or record');
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
  world.publishNotes(1);
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

test('--all without --yes refuses a file that was already dirty in the session snapshot, naming it, exit 2 (it lacks the confirmation), nothing pushed', async () => {
  const world = makeProposeWorld();
  world.write('drafts/theirs.md', note('Theirs'));
  const snapshot = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T09:00:00.000Z') });
  world.write('notes/mine.md', note('Mine'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.USAGE);
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

test('--all with no snapshot, or one older than a day, or one from the future, requires --yes (exit 2); --yes proposes every dirty file', async () => {
  const world = makeProposeWorld();
  world.write('drafts/theirs.md', note('Theirs'));
  world.write('notes/mine.md', note('Mine'));
  let run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.no_snapshot'));

  const old = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-22T11:59:59.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.stale_snapshot', { at: old.at }));

  const future = takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-23T12:00:01.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.USAGE);
  assert.equal(run.stderr, line('propose.stale_snapshot', { at: future.at }));

  // Exactly a day old is still recent.
  takeSnapshot(world.vault, { env: world.env, now: new Date('2026-09-22T12:00:00.000Z') });
  run = await propose(world, ['Sweep', '--all']);
  assert.equal(run.code, EXIT.USAGE, 'both files were there at the snapshot');
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
  assert.match(run.stderr, new RegExp(`^The push of ${BRANCH} failed, and every push url \\(${world.remote}\\) answered that it does not hold it`));
  assert.deepEqual(readdirSync(join(world.vault, '.git', 'brain-kit-proposals')), [], 'no body or record is left for a proposal nothing holds');
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), null);
  assert.deepEqual(world.ghCalls(), []);
  assert.deepEqual(fingerprint(world.vault), before);
});

test('a branch of the same name already on the remote (a rerun in the same second) is never replaced: the proposal takes the next suffix', async () => {
  const world = makeProposeWorld();
  git(world.elsewhere, ['push', '-q', 'origin', `main:refs/heads/${BRANCH}`]);
  git(world.elsewhere, ['push', '-q', 'origin', `main:refs/heads/${BRANCH}-2`]);
  const theirs = world.remoteSha(`refs/heads/${BRANCH}`);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), theirs, 'the existing branch is untouched');
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}-3`)), ['A\tnotes/a.md']);
  assert.deepEqual(createArgs(world).slice(4, 6), ['--head', `${BRANCH}-3`]);
});

test('every suffix taken: exit 1, nothing pushed', async () => {
  const world = makeProposeWorld();
  for (const suffix of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9']) git(world.elsewhere, ['push', '-q', 'origin', `main:refs/heads/${BRANCH}${suffix}`]);
  const refs = world.remoteRefs();
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.branch_exhausted', { branch: BRANCH }));
  assert.equal(world.remoteRefs(), refs);
});

test('a push that reports success but leaves nothing on the remote is exit 1, never a pull request', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const shim = join(world.base, 'fakebin', 'git');
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "push" ]; then exit 0; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.push_unproved', { branch: BRANCH, urls: [world.remote], commit: run.stderr.match(/holds ([0-9a-f]{12}) there/)[1] }));
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
      assert.equal(body[1], join(world.vault, '.git', 'brain-kit-proposals', `${BRANCH.replace('/', '-')}.md`), 'in the git directory');
      assert.deepEqual(readdirSync(world.tmp), [], 'the temporary index and tree are removed');
      assert.equal(readFileSync(body[1], 'utf8'), world.ghCalls()[0].body);
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
  world.publishNotes(1);
  world.write('notes/a.md', note('A'));
  const before = { ...fingerprint(world.vault), all: repoState(world.vault) };
  const refs = world.remoteRefs();
  const run = await propose(world, ['Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('propose.dry_run', { files: ['notes/a.md'], urls: [world.remote], base: 'main', branch: BRANCH, title: 'curate: Add A', origin: 'main' }));
  assert.deepEqual({ ...fingerprint(world.vault), all: repoState(world.vault) }, before);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('behind the remote, with the path untouched there: the commit sits on the fetched tip, never on the stale local HEAD', async () => {
  const world = makeProposeWorld();
  world.publishNotes(2);
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

// --- fix round 1 -------------------------------------------------------------

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const bodyFileOf = (stderr) => /--body-file (\S+)\n$/.exec(stderr)?.[1];

test('the gate judges the PROPOSED tree: a chosen note linking to a file left out is refused, exit 1, nothing pushed', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A').replace('# A\n', '# A\n\nSee [B](b.md).\n'));
  world.write('notes/b.md', note('B'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['A only', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /notes\/a\.md:\d+ {2}link-target-exists/);
  assert.ok(run.stderr.endsWith(line('propose.validate_failed', { code: EXIT.FAILURE })));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(readdirSync(world.tmp), [], 'the extracted tree is removed');
  // Both chosen: the link resolves in the proposed tree, and it passes.
  const both = await propose(world, ['A and B', '--only', 'notes/a.md', 'notes/b.md']);
  assert.equal(both.code, EXIT.OK, both.stderr);
});

test('another session\'s broken, unchosen file no longer blocks a sound proposal: it is not in the proposed tree', async () => {
  const world = makeProposeWorld();
  world.write('notes/mine.md', note('Mine'));
  world.write('drafts/theirs.md', '---\ntitle: unfinished\n---\n');
  const run = await propose(world, ['Mine', '--only', 'notes/mine.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tnotes/mine.md']);
});

test('a note the owner merged on the remote default is never overwritten by a session\'s new file of the same name', async () => {
  const world = makeProposeWorld();
  git(world.elsewhere, ['pull', '-q']);
  writeFileSync(join(world.elsewhere, 'notes.md'), note('Owner'));
  git(world.elsewhere, ['add', 'notes.md']);
  git(world.elsewhere, ['commit', '-q', '-m', 'owner merged']);
  git(world.elsewhere, ['push', '-q', 'origin', 'main']);
  world.write('notes.md', note('Session'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['Notes', '--only', 'notes.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.base_differs', { files: ['notes.md'], base: 'main', tip: tip(world).slice(0, 12) }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('an untracked nested repository and a submodule pointer are refused naming them, exit 2, nothing pushed', async () => {
  const world = makeProposeWorld();
  // A submodule, committed and published, then moved to a new commit.
  const sub = join(world.vault, 'sub');
  git(world.base, ['init', '-q', '-b', 'main', sub]);
  writeFileSync(join(sub, 'x.txt'), 'x\n');
  git(sub, ['add', 'x.txt']);
  git(sub, ['commit', '-q', '-m', 'x']);
  git(world.vault, ['add', 'sub']);
  git(world.vault, ['commit', '-q', '-m', 'sub']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  writeFileSync(join(sub, 'y.txt'), 'y\n');
  git(sub, ['add', 'y.txt']);
  git(sub, ['commit', '-q', '-m', 'y']);
  // An untracked nested repository.
  const nested = join(world.vault, 'nested');
  git(world.base, ['init', '-q', '-b', 'main', nested]);
  writeFileSync(join(nested, 'z.txt'), 'z\n');
  const refs = world.remoteRefs();
  for (const [argv, paths] of [
    [['S', '--only', 'sub'], ['sub']],
    [['S', '--only', 'nested'], ['nested/']],
    [['S', '--all', '--yes'], ['nested/', 'sub']],
  ]) {
    const run = await propose(world, argv);
    assert.equal(run.code, EXIT.USAGE, argv.join(' '));
    assert.equal(run.stderr, line('propose.nested_repository', { paths }), argv.join(' '));
  }
  // A submodule deleted from the working tree is still a pointer.
  rmSync(sub, { recursive: true });
  rmSync(nested, { recursive: true });
  const deleted = await propose(world, ['S', '--only', 'sub']);
  assert.equal(deleted.code, EXIT.USAGE);
  assert.equal(deleted.stderr, line('propose.nested_repository', { paths: ['sub'] }));
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('-- ends options: a path and a summary beginning with - can be given, and the help says so', async () => {
  const world = makeProposeWorld();
  world.write('-dash.md', note('Dash'));
  const run = await propose(world, ['--only', '--', '-leading dash summary', '-dash.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\t-dash.md']);
  assert.equal(createArgs(world)[7], 'curate: -leading dash summary');
  assert.match(t('propose.usage'), /The summary comes first, before --only/);
  assert.match(t('propose.usage'), /After --, nothing is read as an option/);
});

// The nine refusals of base resolution, fetch and the body: each its exit
// code, and nothing pushed or asked of gh.
async function refused(world, argv, code, expected) {
  const refs = world.remoteRefs();
  const run = await propose(world, argv);
  assert.equal(run.code, code, run.stderr);
  if (expected !== undefined) assert.equal(run.stderr, expected);
  assert.equal(run.stdout, '');
  assert.equal(world.remoteRefs(), refs, 'nothing pushed');
  assert.deepEqual(world.ghCalls(), [], 'nothing asked of gh');
  return run;
}

test('refusal: no default branch known: exit 1', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['branch', '-m', 'main', 'work']);
  for (const ref of git(world.vault, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).split('\n').filter(Boolean)) git(world.vault, ['update-ref', '-d', ref]);
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.no_default_branch', { remote: 'origin', file: 'brain-kit.config.json' }));
});

test('refusal: vault.default_branch that is no branch name: exit 1, and --dry exits 1 too', async () => {
  const world = makeProposeWorld({ defaultBranch: 'bad..name' });
  world.write('notes/a.md', note('A'));
  const expected = line('propose.default_branch_invalid', { name: 'bad..name', file: 'brain-kit.config.json' });
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, expected);
  await refused(world, ['A', '--only', 'notes/a.md', '--dry'], EXIT.FAILURE, expected);
});

test('refusal: the default branch tracks a branch of this repository: exit 1', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['config', 'branch.main.remote', '.']);
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.local_upstream', { branch: 'main', key: 'branch.main.remote' }));
});

test('refusal: the default branch tracks a remote that is not configured: exit 1', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['config', 'branch.main.remote', 'upstream']);
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.no_remote', { remote: 'upstream', branch: 'main' }));
});

test('refusal: the remote publishes nothing yet: exit 1', async () => {
  const world = makeProposeWorld({ publishFirst: false });
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.remote_has_no_branch', { remote: 'origin', branch: 'main' }));
});

test('refusal: the forge renamed the default branch: exit 1, naming what it publishes', async () => {
  const world = makeProposeWorld();
  git(world.remote, ['branch', '-m', 'main', 'trunk']);
  git(world.remote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.remote_lacks_branch', { remote: 'origin', branch: 'main', published: ['trunk'] }));
});

test('refusal: a fetch that reports success and reached nothing: exit 1', async () => {
  const world = makeProposeWorld();
  world.publishNotes(1);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  writeFileSync(join(world.base, 'fakebin', 'git'), `#!/bin/sh\nif [ "$1" = "fetch" ]; then exit 0; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.fetch_incomplete', { remote: 'origin', branch: 'main' }));
});

test('refusal: a body template that cannot be read: exit 1', async () => {
  const world = makeProposeWorld();
  mkdirSync(join(world.vault, 'body-dir'));
  withGitConfig(world, { pr_body: 'body-dir' });
  world.write('notes/a.md', note('A'));
  await refused(world, ['A', '--only', 'notes/a.md'], EXIT.FAILURE, line('propose.body_unreadable', { file: join(world.vault, 'body-dir'), detail: 'EISDIR' }));
});

// --- the push destination ---------------------------------------------------

function bareCloneOf(world, name) {
  const dir = join(world.base, name);
  git(world.base, ['clone', '-q', '--bare', world.remote, dir]);
  return dir;
}

test('a pushurl elsewhere: the branch lands there, is proved there, and no remote-tracking reference is left behind', async () => {
  const world = makeProposeWorld();
  const pushed = bareCloneOf(world, 'pushed.git');
  git(world.vault, ['config', 'remote.origin.pushurl', pushed]);
  world.write('notes/a.md', note('A'));
  const before = fingerprint(world.vault);
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), null, 'nothing published to the fetch url');
  assert.deepEqual(git(pushed, ['diff-tree', '-r', '--no-commit-id', '--name-status', `${BRANCH}^`, BRANCH]).trim().split('\n'), ['A\tnotes/a.md']);
  assert.deepEqual(fingerprint(world.vault), before, 'every reference, remote-tracking ones included, is as it was');
});

test('the mirror idiom (insteadOf to a mirror, identity pushInsteadOf upstream): the push and its proof both go upstream', async () => {
  const world = makeProposeWorld();
  const mirror = bareCloneOf(world, 'mirror.git');
  git(world.vault, ['config', `url.${mirror}.insteadOf`, world.remote]);
  git(world.vault, ['config', `url.${world.remote}.pushInsteadOf`, world.remote]);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'published upstream');
  assert.equal(gitProbe(mirror, ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`]).status, 1, 'the mirror never received it');
});

test('two push urls: both must hold the commit; a partial publish is exit 3 naming which, with the commands that finish', async () => {
  const world = makeProposeWorld();
  const first = bareCloneOf(world, 'first.git');
  const second = bareCloneOf(world, 'second.git');
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', first]);
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', second]);
  writeFileSync(join(second, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.DEGRADED, run.stderr);
  const commit = git(first, ['rev-parse', BRANCH]).trim();
  const body = join(world.vault, '.git', 'brain-kit-proposals', `${BRANCH.replace('/', '-')}.md`);
  const command = `git push ${second} ${commit}:refs/heads/${BRANCH} && gh pr create --base main --head ${BRANCH} --title 'curate: A' --body-file ${body}`;
  assert.equal(run.stderr, line('propose.partial_publish', { branch: BRANCH, held: [first], missing: [second], command }));
  assert.deepEqual(world.ghCalls(), [], 'no pull request for a partial publish');
  // Finishing by hand, as printed, completes it.
  rmSync(join(second, 'hooks', 'pre-receive'));
  const done = spawnSync('sh', ['-c', command], { cwd: world.vault, env: world.env, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git(second, ['rev-parse', BRANCH]).trim(), commit);
});

test('two push urls that both accept: exit 0, both hold the commit', async () => {
  const world = makeProposeWorld();
  const first = bareCloneOf(world, 'first.git');
  const second = bareCloneOf(world, 'second.git');
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', first]);
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', second]);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(git(first, ['rev-parse', BRANCH]).trim(), git(second, ['rev-parse', BRANCH]).trim());
});

test('the push runs the vault\'s pre-push gate: a refusing hook refuses the proposal, exit 1, nothing published', async () => {
  const world = makeProposeWorld();
  writeFileSync(join(world.vault, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho gate refused >&2\nexit 1\n', { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^The push of .* failed, .*git said: .*/);
  assert.equal(world.remoteRefs(), refs);
  assert.deepEqual(world.ghCalls(), []);
});

test('a destination holding another commit under the branch is not proof: exit 1, never a pull request', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const marker = join(world.base, 'pushed-marker');
  writeFileSync(join(world.base, 'fakebin', 'git'), [
    '#!/bin/sh',
    `if [ "$1" = "push" ]; then '${realGit}' "$@"; s=$?; touch '${marker}'; exit $s; fi`,
    `if [ "$1" = "ls-remote" ] && [ -e '${marker}' ]; then printf '%s\\t%s\\n' 0123456789012345678901234567890123456789 "$3"; exit 0; fi`,
    `exec '${realGit}' "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.match(run.stderr, /^The push of .* reported success, but no push url/);
  assert.deepEqual(world.ghCalls(), []);
});

test('the printed finishing command runs as printed: a summary with a single quote, a newline and $()', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const summary = "Ana's notes $(touch pwned)\nsecond line";
  const run = await propose(world, [summary, '--only', 'notes/a.md'], { env: { ...world.env, FAKE_GH_MODE: 'fail' } });
  assert.equal(run.code, EXIT.DEGRADED, run.stderr);
  const marker = 'Open it by hand with: ';
  const command = run.stderr.slice(run.stderr.indexOf(marker) + marker.length, -1);
  const done = spawnSync('sh', ['-c', command], { cwd: world.vault, env: world.env, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  const created = world.ghCalls().filter((call) => call.args[1] === 'create');
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].args, created[0].args, 'the same arguments, byte for byte');
  assert.equal(created[1].args[7], `curate: ${summary}`);
  assert.equal(existsSync(join(world.vault, 'pwned')), false);
});

test('gh gets no caller git environment, and GIT_TERMINAL_PROMPT=0 and GH_PROMPT_DISABLED=1', async () => {
  const world = makeProposeWorld();
  const other = join(world.base, 'other');
  git(world.base, ['init', '-q', other]);
  world.write('notes/a.md', note('A'));
  const env = { ...world.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') };
  const run = await propose(world, ['A', '--only', 'notes/a.md'], { env });
  assert.equal(run.code, EXIT.OK, run.stderr);
  for (const call of world.ghCalls()) {
    assert.deepEqual(call.env, { GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, call.args.join(' '));
    assert.equal(call.cwd, world.vault);
  }
  assert.equal(git(other, ['for-each-ref']), '', 'the other repository was not touched');
});

test('a pt-BR vault without its own template gets the pt-BR body', async () => {
  const world = makeProposeWorld();
  const file = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.lang = 'pt-BR';
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const template = readFileSync(join(KIT_ROOT, 'lang', 'pt-BR', 'vault', '.brain-kit', 'pr-body.md'), 'utf8');
  assert.equal(world.ghCalls()[0].body, template.replace('{{summary}}', 'A').replace('{{files}}', '- `notes/a.md`').replace('{{branch}}', BRANCH).replace('{{base}}', 'main'));
});

test('a run killed after the push is reported by the next run with the finishing command; once finished, the record goes', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const env = { ...world.env, FAKE_GH_MODE: 'killparent', TMPDIR: world.tmp, BRAIN_KIT_LANG: 'en' };
  const killed = spawnSync(process.execPath, [BIN, 'propose', 'Killed', '--only', 'notes/a.md'], { cwd: world.vault, env, encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL');
  const dir = join(world.vault, '.git', 'brain-kit-proposals');
  const records = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(records.length, 1, 'the published branch was recorded before gh was called');
  const record = JSON.parse(readFileSync(join(dir, records[0]), 'utf8'));
  assert.ok(world.remoteSha(`refs/heads/${record.branch}`), 'and it is published');

  world.write('notes/b.md', note('B'));
  const next = await propose(world, ['B', '--only', 'notes/b.md'], { now: new Date('2026-09-23T13:00:00.000Z') });
  assert.equal(next.code, EXIT.OK, next.stderr);
  assert.equal(next.stderr, line('propose.pending', { branch: record.branch, command: record.command }));

  const done = spawnSync('sh', ['-c', record.command], { cwd: world.vault, env: world.env, encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  world.write('notes/c.md', note('C'));
  const after = await propose(world, ['C', '--only', 'notes/c.md'], { now: new Date('2026-09-23T14:00:00.000Z') });
  assert.equal(after.code, EXIT.OK, after.stderr);
  assert.equal(after.stderr, '', 'the confirmed proposal is no longer reported');
  assert.deepEqual(readdirSync(dir), [], 'its record and body are removed');
});

test('the mirror idiom in the person\'s global configuration: the pin is read first, and the push and its proof still go upstream', async () => {
  const world = makeProposeWorld();
  const mirror = bareCloneOf(world, 'mirror.git');
  writeFileSync(world.env.GIT_CONFIG_GLOBAL, `[url "${mirror}"]\n\tinsteadOf = ${world.remote}\n[url "${world.remote}"]\n\tpushInsteadOf = ${world.remote}\n`);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'published upstream');
  assert.equal(gitProbe(mirror, ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`]).status, 1, 'the mirror never received it');
});

test('a push url that cannot be asked which branches it holds: exit 1 before anything is pushed, no record left', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['config', 'remote.origin.pushurl', join(world.base, 'gone.git')]);
  world.write('notes/a.md', note('A'));
  const refs = world.remoteRefs();
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.destination_unreadable', { url: join(world.base, 'gone.git') }));
  assert.equal(world.remoteRefs(), refs);
  assert.equal(existsSync(join(world.vault, '.git', 'brain-kit-proposals')), false);
});

test('a destination that stops answering after the push is exit 3, never "nothing was published"', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const marker = join(world.base, 'pushed-marker');
  writeFileSync(join(world.base, 'fakebin', 'git'), [
    '#!/bin/sh',
    `if [ "$1" = "push" ]; then '${realGit}' "$@"; s=$?; touch '${marker}'; exit $s; fi`,
    `if [ "$1" = "ls-remote" ] && [ -e '${marker}' ]; then echo "fatal: the remote hung up" >&2; exit 128; fi`,
    `exec '${realGit}' "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.DEGRADED, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'it is in fact published');
  assert.match(run.stderr, new RegExp(`^${BRANCH} is published to - but not to ${world.remote}`));
  assert.deepEqual(world.ghCalls(), []);
});

// --- fix round 1, additional survivors from the reviewer's mutation list ---

test('a race at the push: another writer creates the just-checked-free branch first; the lease refuses it, and the decoy is untouched', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const decoy = git(world.elsewhere, ['rev-parse', 'HEAD']).trim();
  const marker = join(world.base, 'race-marker');
  const ref = `refs/heads/${BRANCH}`;
  writeFileSync(join(world.base, 'fakebin', 'git'), [
    '#!/bin/sh',
    `if [ "$1" = "ls-remote" ] && [ "$3" = "${ref}" ] && [ ! -e '${marker}' ]; then`,
    `  touch '${marker}'`,
    `  '${realGit}' push --quiet "$2" ${decoy}:${ref}`,
    '  exit 0',
    'fi',
    `exec '${realGit}' "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE, run.stderr);
  assert.match(run.stderr, new RegExp(`^The push of ${BRANCH.replace(/\//g, '\\/')} failed`));
  assert.equal(world.remoteSha(ref), decoy, 'the decoy commit that won the race is untouched');
});

test('lint judges the PROPOSED tree, not the working tree: an unchosen dirty file that fails lint does not block a sound proposal', async () => {
  const world = makeProposeWorld();
  world.write('notes/mine.md', note('Mine'));
  world.write('drafts/leaked.md', note('Leaked').replace('# Leaked\n', `# Leaked\n\nghp_${'a'.repeat(24)}\n`));
  const run = await propose(world, ['Mine', '--only', 'notes/mine.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${BRANCH}`)), ['A\tnotes/mine.md']);
});

test('lint judging the working tree instead of the proposed tree would have refused the case above (control)', async () => {
  const world = makeProposeWorld();
  world.write('notes/mine.md', note('Mine'));
  world.write('drafts/leaked.md', note('Leaked').replace('# Leaked\n', `# Leaked\n\nghp_${'a'.repeat(24)}\n`));
  const linting = { stdout: '', stderr: '' };
  const io = { stdout: { write: (s) => { linting.stdout += s; } }, stderr: { write: (s) => { linting.stderr += s; } } };
  const { runLint } = await import('../src/commands/lint.mjs');
  const code = await runLint([world.vault, '--base', 'worktree'], io, t, walkVault);
  assert.equal(code, EXIT.FAILURE, 'confirms the working tree itself fails lint because of the foreign file, so propose succeeding proves it did not read the working tree');
  assert.match(linting.stdout, /leaked/);
});

test('an earlier proposal record whose pull request now exists but on the wrong base: the pending message prints the edit command, not the create command', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const killed = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'brain-kit.mjs'), 'propose', 'Killed', '--only', 'notes/a.md'], {
    cwd: world.vault, env: { ...world.env, FAKE_GH_MODE: 'killparent', TMPDIR: world.tmp, BRAIN_KIT_LANG: 'en' }, encoding: 'utf8',
  });
  assert.equal(killed.signal, 'SIGKILL');
  const dir = join(world.vault, '.git', 'brain-kit-proposals');
  const recordFile = join(dir, readdirSync(dir).find((name) => name.endsWith('.json')));
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  // A pull request now exists for that branch, opened by hand against the wrong base.
  spawnSync(join(world.base, 'fakebin', 'gh'), ['pr', 'create', '--base', 'trunk', '--head', record.branch, '--title', 'by hand', '--body-file', recordFile], {
    cwd: world.vault, env: world.env,
  });
  world.write('notes/b.md', note('B'));
  const run = await propose(world, ['B', '--only', 'notes/b.md'], { now: new Date('2026-09-23T13:00:00.000Z') });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stderr, line('propose.pending', { branch: record.branch, command: `gh pr edit ${record.branch} --base ${record.base}` }));
});

test('--dry never checks or reports an earlier unconfirmed proposal, and asks gh nothing', async () => {
  const world = makeProposeWorld();
  const dir = join(world.vault, '.git', 'brain-kit-proposals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stale.json'), JSON.stringify({ branch: 'bot/stale', base: 'main', command: 'gh pr create --base main --head bot/stale' }));
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md', '--dry']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('propose.dry_run', { files: ['notes/a.md'], urls: [world.remote], base: 'main', branch: BRANCH, title: 'curate: A', origin: 'main' }));
  assert.deepEqual(world.ghCalls(), []);
  assert.ok(existsSync(join(dir, 'stale.json')), 'the stale record is left exactly as it was');
});


// --- fix round 2: the person's own real global config leaked the push ------
//
// A `pushInsteadOf` rule in the OWNER's real global gitconfig, naming this
// vault's origin url for a reason that has nothing to do with brain-kit,
// silently retargeted the push while the run reported success. Reproduced
// exactly as found, against the unmutated code, in
// .superpowers/sdd/2026-09-23-phase-1c-propose-sync-machine-verify/repro-c3-pushinsteadof/probe.mjs.

test('a pushInsteadOf rule in the person\'s real global gitconfig, naming the origin url for an unrelated reason, cannot retarget the push', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const decoy = bareCloneOf(world, 'decoy.git');
  const originUrl = git(world.vault, ['remote', 'get-url', '--push', 'origin']).trim();
  writeFileSync(world.env.GIT_CONFIG_GLOBAL, `[url "${decoy}"]\n\tpushInsteadOf = "${originUrl}"\n`);
  const run = await propose(world, ['Add A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'the real remote has the branch');
  assert.equal(gitProbe(decoy, ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`]).status, 1, 'the decoy the global rule points at has nothing');
});

test('the same global pushInsteadOf rule, with an explicit remote.origin.pushurl set: the explicit pushurl is honoured, and the rule still cannot retarget it', async () => {
  const world = makeProposeWorld();
  const pushed = bareCloneOf(world, 'pushed.git');
  git(world.vault, ['config', 'remote.origin.pushurl', pushed]);
  world.write('notes/a.md', note('A'));
  const decoy = bareCloneOf(world, 'decoy.git');
  writeFileSync(world.env.GIT_CONFIG_GLOBAL, `[url "${decoy}"]\n\tpushInsteadOf = "${pushed}"\n`);
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(git(pushed, ['diff-tree', '-r', '--no-commit-id', '--name-status', `${BRANCH}^`, BRANCH]).trim().split('\n'), ['A\tnotes/a.md']);
  assert.equal(gitProbe(decoy, ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`]).status, 1);
});

test('a global insteadOf rule (not pushInsteadOf) naming the origin url cannot retarget the push either', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const decoy = bareCloneOf(world, 'decoy.git');
  const originUrl = git(world.vault, ['remote', 'get-url', 'origin']).trim();
  writeFileSync(world.env.GIT_CONFIG_GLOBAL, `[url "${decoy}"]\n\tinsteadOf = "${originUrl}"\n`);
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.ok(world.remoteSha(`refs/heads/${BRANCH}`));
  assert.equal(gitProbe(decoy, ['rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`]).status, 1);
});

test('remote get-url --push --all can no longer be the source of the push destination: without any rewrite, it still agrees with rawPushUrls', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`) !== null, true);
});

test('no remote.origin.url and no pushurl at all: exit 1 naming the remote, nothing asked of gh', async () => {
  const world = makeProposeWorld();
  git(world.vault, ['remote', 'remove', 'origin']);
  git(world.vault, ['remote', 'add', 'origin', world.remote]);
  git(world.vault, ['config', '--unset', 'remote.origin.url']);
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md']);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('propose.no_push_url', { remote: 'origin' }));
  assert.deepEqual(world.ghCalls(), []);
});

test('the pin-proof check itself: a git that answers ls-remote --get-url with a value other than what it will actually push to is refused before anything is pushed, naming the mismatch', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const originUrl = git(world.vault, ['remote', 'get-url', '--push', 'origin']).trim();
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const liarBin = join(world.base, 'liarbin');
  mkdirSync(liarBin);
  const liarPath = join(liarBin, 'git');
  writeFileSync(liarPath, `#!${process.execPath}
'use strict';
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'ls-remote' && args[1] === '--get-url') {
  process.stdout.write('${originUrl}-lying-about-the-destination\\n');
  process.exit(0);
}
const r = spawnSync('${realGit}', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  chmodSync(liarPath, 0o755);
  const env = { ...world.env, PATH: `${liarBin}:${world.env.PATH}` };
  const before = fingerprint(world.vault);
  const run = await propose(world, ['Add A', '--only', 'notes/a.md'], { env });
  assert.equal(run.code, EXIT.FAILURE, run.stderr);
  assert.equal(run.stderr, line('propose.url_rewritten', { url: originUrl, got: `${originUrl}-lying-about-the-destination` }));
  assert.equal(world.remoteSha(`refs/heads/${BRANCH}`), null, 'nothing was pushed: the check fired before any push attempt');
  assert.deepEqual(world.ghCalls(), [], 'gh was never asked either');
  assert.deepEqual(fingerprint(world.vault), before, 'HEAD, the index and the working tree are untouched');
});

// --- inside a round: joining its lock, and the round record (phase 2, task 5) -----

const roundRecord = (world, token) => join(world.vault, '.git', `brain-kit-round-${token}.json`);

// Every round record, and every temporary file of one, in the git directory.
function roundFiles(world) {
  return readdirSync(join(world.vault, '.git')).filter((name) => name.startsWith('brain-kit-round-'));
}

function holdAsRound(world) {
  return acquireLock(world.vault, { command: 'curate', env: world.env, now: NOW });
}

function readRecord(world, token) {
  return JSON.parse(readFileSync(roundRecord(world, token), 'utf8'));
}

test('inside a round: propose joins the round\'s lock, the lock is byte-identical afterwards, and the record names exactly the commit\'s paths', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  world.write('notes/b.md', note('B'));
  world.write('notes/c.md', note('C'));
  const round = holdAsRound(world);
  try {
    const lockFile = join(world.vault, '.git', GUARD_FILES.LOCK);
    const before = readFileSync(lockFile);
    const inode = statSync(lockFile).ino;
    const run = await propose(world, ['A and B', '--only', 'notes/b.md', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.OK, run.stderr);
    assert.equal(run.stdout, line('propose.opened', { url: PR_URL, base: 'main', branch: BRANCH, count: 2, origin: 'main' }));
    assert.equal(`${run.stdout}${run.stderr}`.includes(round.token), false, 'the token is never printed');
    assert.deepEqual(readFileSync(lockFile), before, 'the round\'s lock is untouched');
    assert.equal(statSync(lockFile).ino, inode);
    const commit = world.remoteSha(`refs/heads/${BRANCH}`);
    assert.deepEqual(readRecord(world, round.token), {
      format: 1, proposals: [{ opened: true, remote: 'origin', branch: BRANCH, commit, paths: ['notes/a.md', 'notes/b.md'] }],
    });
    assert.deepEqual(world.changedIn(commit).map((entry) => entry.split('\t')[1]), readRecord(world, round.token).proposals[0].paths);
    assert.equal(statSync(roundRecord(world, round.token)).mode & 0o777, 0o600);
    assert.deepEqual(roundFiles(world), [basename(roundRecord(world, round.token))], 'no temporary file is left beside the record');
  } finally {
    assert.equal(round.release(), true, 'the round still owns its lock');
  }
});

test('inside a round: a pull request that cannot be opened still records the pushed commit, with opened false', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const round = holdAsRound(world);
  try {
    const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, FAKE_GH_MODE: 'fail', BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.DEGRADED, run.stderr);
    assert.equal(`${run.stdout}${run.stderr}`.includes(round.token), false);
    assert.deepEqual(readRecord(world, round.token), {
      format: 1, proposals: [{ opened: false, remote: 'origin', branch: BRANCH, commit: world.remoteSha(`refs/heads/${BRANCH}`), paths: ['notes/a.md'] }],
    });
  } finally {
    round.release();
  }
});

test('inside a round: a partial publish records the commit one url holds, with opened false', async () => {
  const world = makeProposeWorld();
  const first = bareCloneOf(world, 'first.git');
  const second = bareCloneOf(world, 'second.git');
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', first]);
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', second]);
  writeFileSync(join(second, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const round = holdAsRound(world);
  try {
    const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.DEGRADED, run.stderr);
    assert.deepEqual(readRecord(world, round.token), {
      format: 1, proposals: [{ opened: false, remote: 'origin', branch: BRANCH, commit: git(first, ['rev-parse', BRANCH]).trim(), paths: ['notes/a.md'] }],
    });
  } finally {
    round.release();
  }
});

test('inside a round: nothing pushed, or a push no url can confirm, writes no record', async () => {
  // The vault's pre-push gate refuses: nothing published.
  const refusing = makeProposeWorld();
  writeFileSync(join(refusing.vault, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  refusing.write('notes/a.md', note('A'));
  let round = holdAsRound(refusing);
  try {
    const run = await propose(refusing, ['A', '--only', 'notes/a.md'], { env: { ...refusing.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.FAILURE);
    assert.deepEqual(roundFiles(refusing), []);
  } finally {
    round.release();
  }
  // The destination stops answering after the push: the commit may be
  // there, and nothing proves it, so the files must stay for a person.
  const silent = makeProposeWorld();
  silent.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: silent.env }).stdout.trim();
  const marker = join(silent.base, 'pushed-marker');
  writeFileSync(join(silent.base, 'fakebin', 'git'), [
    '#!/bin/sh',
    `if [ "$1" = "push" ]; then '${realGit}' "$@"; s=$?; touch '${marker}'; exit $s; fi`,
    `if [ "$1" = "ls-remote" ] && [ -e '${marker}' ]; then echo "fatal: the remote hung up" >&2; exit 128; fi`,
    `exec '${realGit}' "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  round = holdAsRound(silent);
  try {
    const run = await propose(silent, ['A', '--only', 'notes/a.md'], { env: { ...silent.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.DEGRADED, run.stderr);
    assert.deepEqual(roundFiles(silent), []);
  } finally {
    round.release();
  }
  // --dry pushes nothing.
  const dry = makeProposeWorld();
  dry.write('notes/a.md', note('A'));
  round = holdAsRound(dry);
  try {
    const run = await propose(dry, ['A', '--only', 'notes/a.md', '--dry'], { env: { ...dry.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.OK, run.stderr);
    assert.deepEqual(roundFiles(dry), []);
  } finally {
    round.release();
  }
});

test('not joined: a token that matches nothing is ignored, propose takes and releases its own lock, and no record is written', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const token = '0123456789abcdef0123456789abcdef';
  const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: token } });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(roundFiles(world), []);
  assert.equal(existsSync(join(world.vault, '.git', GUARD_FILES.LOCK)), false);
});

test('not joined: the right token on a round that died reclaims its lock as any propose would, and writes no record', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const token = 'abcdef0123456789abcdef0123456789';
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const me = currentIdentity();
  writeFileSync(join(world.vault, '.git', GUARD_FILES.LOCK), `${JSON.stringify({
    pid: dead, host: me.host, command: 'curate', startedAt: '2026-09-23T03:00:00.000Z', machineId: me.machineId, bootId: me.bootId, pidNamespace: me.pidNamespace, token,
  })}\n`);
  const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: token } });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.deepEqual(roundFiles(world), []);
  assert.equal(existsSync(join(world.vault, '.git', GUARD_FILES.LOCK)), false, 'reclaimed, then released');
});

test('refused while a round holds the lock: a wrong or malformed token is exit 75 naming the round, and the round\'s token is never printed', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const round = holdAsRound(world);
  try {
    const me = currentIdentity();
    for (const token of [undefined, 'f'.repeat(32), round.token.toUpperCase(), round.token.slice(0, 31)]) {
      const env = token === undefined ? world.env : { ...world.env, BRAIN_KIT_ROUND_TOKEN: token };
      const run = await propose(world, ['A', '--only', 'notes/a.md'], { env });
      assert.equal(run.code, EXIT.TEMPFAIL, `${token}: ${run.stderr}`);
      assert.equal(run.stderr, line('lock.held', { pid: process.pid, host: me.host, command: 'curate', startedAt: NOW.toISOString() }));
      assert.equal(`${run.stdout}${run.stderr}`.includes(round.token), false);
    }
    assert.deepEqual(world.ghCalls(), []);
    assert.deepEqual(roundFiles(world), []);
  } finally {
    round.release();
  }
});

test('not joined: a pushed commit writes no round record, whether the pull request opened, failed or the publish was partial', async () => {
  const token = '0123456789abcdef0123456789abcdef';
  for (const mode of ['ok', 'fail']) {
    const world = makeProposeWorld();
    world.write('notes/a.md', note('A'));
    const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, FAKE_GH_MODE: mode, BRAIN_KIT_ROUND_TOKEN: token } });
    assert.equal(run.code, mode === 'ok' ? EXIT.OK : EXIT.DEGRADED, run.stderr);
    assert.deepEqual(roundFiles(world), [], mode);
  }
  const world = makeProposeWorld();
  const first = bareCloneOf(world, 'first.git');
  const second = bareCloneOf(world, 'second.git');
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', first]);
  git(world.vault, ['config', '--add', 'remote.origin.pushurl', second]);
  writeFileSync(join(second, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: token } });
  assert.equal(run.code, EXIT.DEGRADED, run.stderr);
  assert.deepEqual(roundFiles(world), [], 'partial');
});

test('inside a round: a record whose guard another run holds is exit 3 naming the directory and EBUSY, never the file, so never the token', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const round = holdAsRound(world);
  try {
    const guard = `${roundRecord(world, round.token)}.lock`;
    writeFileSync(guard, '');
    const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token }, extra: { recordGuardWaitMs: 100 } });
    assert.equal(run.code, EXIT.DEGRADED, run.stderr);
    assert.equal(run.stderr, line('propose.round_record_failed', { branch: BRANCH, dir: join(world.vault, '.git'), code: 'EBUSY' }));
    assert.equal(`${run.stdout}${run.stderr}`.includes(round.token), false);
    assert.ok(world.remoteSha(`refs/heads/${BRANCH}`), 'the commit is pushed');
    assert.deepEqual(roundFiles(world), [basename(guard)], 'the other run\'s guard is left to it, and no record or temporary file appears');
  } finally {
    round.release();
  }
});

test('inside a round: two proposals in one round keep both entries, each with its own paths, and the guard is gone after each', async () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  world.write('notes/b.md', note('B'));
  world.write('notes/c.md', note('C'));
  const round = holdAsRound(world);
  try {
    const env = { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token };
    const first = await propose(world, ['A and B', '--only', 'notes/a.md', 'notes/b.md'], { env });
    assert.equal(first.code, EXIT.OK, first.stderr);
    assert.deepEqual(roundFiles(world), [basename(roundRecord(world, round.token))]);
    const second = await propose(world, ['C', '--only', 'notes/c.md'], { env });
    assert.equal(second.code, EXIT.OK, second.stderr);
    assert.equal(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`.includes(round.token), false);
    assert.deepEqual(readRecord(world, round.token), {
      format: 1,
      proposals: [
        { opened: true, remote: 'origin', branch: BRANCH, commit: world.remoteSha(`refs/heads/${BRANCH}`), paths: ['notes/a.md', 'notes/b.md'] },
        { opened: true, remote: 'origin', branch: `${BRANCH}-2`, commit: world.remoteSha(`refs/heads/${BRANCH}-2`), paths: ['notes/c.md'] },
      ],
    });
    assert.equal(statSync(roundRecord(world, round.token)).mode & 0o777, 0o600);
    assert.deepEqual(roundFiles(world), [basename(roundRecord(world, round.token))], 'no guard or temporary file left');
  } finally {
    round.release();
  }
});

test('inside a round: an existing record that does not validate is left exactly as it is, exit 3, and the token is never printed', async () => {
  const entry = { opened: true, remote: 'origin', branch: 'bot/x', commit: 'a'.repeat(40), paths: ['notes/x.md'] };
  const corrupt = [
    '{"format": 1, "proposals": [',
    'null\n',
    JSON.stringify({ format: 2, proposals: [entry] }),
    JSON.stringify({ format: 1, proposals: [entry], extra: true }),
    JSON.stringify({ format: 1, opened: true, remote: 'origin', branch: 'bot/x', commit: 'a'.repeat(40), paths: ['notes/x.md'] }),
    JSON.stringify({ format: 1, proposals: [{ ...entry, commit: 'nope' }] }),
  ];
  for (const text of corrupt) {
    const world = makeProposeWorld();
    world.write('notes/a.md', note('A'));
    const round = holdAsRound(world);
    try {
      writeFileSync(roundRecord(world, round.token), text);
      const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
      assert.equal(run.code, EXIT.DEGRADED, `${text}: ${run.stderr}`);
      assert.equal(run.stderr, line('propose.round_record_invalid', { branch: BRANCH, dir: join(world.vault, '.git') }));
      assert.equal(`${run.stdout}${run.stderr}`.includes(round.token), false);
      assert.equal(readFileSync(roundRecord(world, round.token), 'utf8'), text, 'left exactly as it is');
      assert.deepEqual(roundFiles(world), [basename(roundRecord(world, round.token))], 'no guard or temporary file left');
    } finally {
      round.release();
    }
  }
  // Not a regular file: a directory, and a symbolic link (never followed).
  for (const plant of ['directory', 'symlink']) {
    const world = makeProposeWorld();
    world.write('notes/a.md', note('A'));
    const round = holdAsRound(world);
    try {
      const file = roundRecord(world, round.token);
      if (plant === 'directory') mkdirSync(file);
      else symlinkSync(join(world.base, 'elsewhere-record.json'), file);
      const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
      assert.equal(run.code, EXIT.DEGRADED, run.stderr);
      assert.equal(run.stderr, line('propose.round_record_invalid', { branch: BRANCH, dir: join(world.vault, '.git') }));
      assert.equal(existsSync(join(world.base, 'elsewhere-record.json')), false, 'nothing written through the link');
      assert.equal(lstatSync(file).isDirectory() || lstatSync(file).isSymbolicLink(), true, plant);
    } finally {
      round.release();
    }
  }
});

test('parseRoundRecord accepts exactly the record format and refuses every malformed entry', () => {
  const entry = { opened: false, remote: 'origin', branch: 'bot/x', commit: 'b'.repeat(64), paths: ['a.md', 'b c.md'] };
  const ok = { format: 1, proposals: [entry, { ...entry, opened: true, commit: 'c'.repeat(40) }] };
  assert.deepEqual(parseRoundRecord(JSON.stringify(ok)), ok);
  assert.deepEqual(parseRoundRecord(JSON.stringify({ format: 1, proposals: [] })), { format: 1, proposals: [] });
  const bad = [
    { ...entry, opened: 'true' }, { ...entry, remote: '' }, { ...entry, remote: 1 }, { ...entry, branch: '' }, { ...entry, branch: null },
    { ...entry, commit: 'B'.repeat(40) }, { ...entry, commit: 'b'.repeat(39) }, { ...entry, paths: [] }, { ...entry, paths: [''] },
    { ...entry, paths: 'a.md' }, { ...entry, paths: [1] }, { ...entry, extra: 1 }, (({ opened, ...rest }) => rest)(entry), null, [entry],
  ];
  for (const item of bad) assert.equal(parseRoundRecord(JSON.stringify({ format: 1, proposals: [entry, item] })), null, JSON.stringify(item));
  for (const top of [[], 'x', { format: 1 }, { proposals: [] }, { format: '1', proposals: [] }, { format: 1, proposals: {} }]) {
    assert.equal(parseRoundRecord(JSON.stringify(top)), null, JSON.stringify(top));
  }
  assert.equal(parseRoundRecord('not json'), null);
});

test('inside a round: the token never reaches what propose runs (the push\'s hooks see no BRAIN_KIT_ROUND_TOKEN)', async () => {
  const world = makeProposeWorld();
  const seen = join(world.base, 'pre-push-saw');
  writeFileSync(join(world.vault, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho "\${BRAIN_KIT_ROUND_TOKEN-unset}" > '${seen}'\nexit 0\n`, { mode: 0o755 });
  world.write('notes/a.md', note('A'));
  const round = holdAsRound(world);
  try {
    const run = await propose(world, ['A', '--only', 'notes/a.md'], { env: { ...world.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(run.code, EXIT.OK, run.stderr);
    assert.equal(readFileSync(seen, 'utf8'), 'unset\n');
    assert.equal(readRecord(world, round.token).proposals.length, 1, 'joined, all the same');
  } finally {
    round.release();
  }
});
