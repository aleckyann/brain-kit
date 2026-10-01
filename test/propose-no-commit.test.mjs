// `brain-kit propose` in a repository with no commit yet (the second
// stranger's F3, 01/10/2026).
//
// A vault made by `init` has no commit until its owner makes one, and a
// `propose` run before that said the default branch could not be found and
// that vault.default_branch should be set in the configuration. A person
// who did as told was sent on to "no remote called origin", then to a
// `gh repo create` that failed with "src refspec HEAD does not match any
// ref", then to "push the default branch first" with no command: ten
// minutes in a maze whose only cause was the commit that was missing. The
// check that names the cause comes first, before any default-branch or
// remote logic, in the dry run and the real run alike.
//
// Real runs of the real command line against a throwaway vault, its bare
// remote and a fake `gh` (./helpers/propose-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { describeLock } from '../src/guards/lock.mjs';
import { git } from './helpers/git-repo.mjs';
import { configText, gitProbe, repoState } from './helpers/sync-world.mjs';
import { makeProposeWorld, note } from './helpers/propose-world.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

function brainKit(world, argv, lang = 'en') {
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: world.vault, encoding: 'utf8', env: { ...world.env, BRAIN_KIT_LANG: lang },
  });
}

// A vault that has never had a commit: what `brain-kit init` leaves. With
// `remote`, the remote of the world (which publishes a main) is configured
// as origin and never fetched.
function unbornWorld({ defaultBranch = null, remote = false } = {}) {
  const world = makeProposeWorld();
  rmSync(world.vault, { recursive: true, force: true });
  mkdirSync(world.vault);
  git(world.vault, ['init', '-q', '-b', 'main']);
  writeFileSync(join(world.vault, 'brain-kit.config.json'), configText(defaultBranch));
  writeFileSync(join(world.vault, 'index.md'), '# Index\n');
  world.write('notes/a.md', note('A'));
  if (remote) git(world.vault, ['remote', 'add', 'origin', world.remote]);
  return world;
}

function files(dir, rel = '', out = {}) {
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) files(dir, path, out);
    else out[path] = readFileSync(join(dir, path), 'utf8');
  }
  return out;
}

// Everything a refused propose may not have moved.
function stateOf(world) {
  return { repo: repoState(world.vault), files: files(world.vault), remote: world.remoteRefs(), gh: world.ghCalls() };
}

function assertRefusedFirst(world, argv, lang = 'en') {
  const t = createTranslator(lang);
  const before = stateOf(world);
  const run = brainKit(world, argv, lang);
  assert.equal(run.status, EXIT.FAILURE, `${argv.join(' ')}: ${run.stdout}${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, `${t('propose.no_commit')}\n`);
  assert.deepEqual(stateOf(world), before, 'nothing moved, nothing pushed, gh never asked');
  assert.equal(describeLock(world.vault, { env: world.env }), null, 'the lock is released');
  return run;
}

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: a vault with no commit and no remote is told to make the first commit, in the dry run and the real run alike`, () => {
    const world = unbornWorld();
    const dry = assertRefusedFirst(world, ['propose', 'Add A', '--only', 'notes/a.md', '--dry'], lang);
    const real = assertRefusedFirst(world, ['propose', 'Add A', '--only', 'notes/a.md'], lang);
    assert.equal(dry.stderr, real.stderr, 'the dry run says what the real run says');
  });

  test(`${lang}: the sentence gives the fix (the two commands) and does not send the person to the configuration`, () => {
    const text = createTranslator(lang)('propose.no_commit');
    assert.match(text, /git add -A/);
    assert.match(text, /git commit -m "[^"]+"/);
    assert.doesNotMatch(text, /default_branch/);
    assert.doesNotMatch(text, /\{[a-z_]+\}/);
  });
}

// Every git command the run starts, one line each, from a `git` placed first on PATH
// that writes down its arguments and then runs the real one.
function recordGitCalls(world) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const log = join(world.base, 'git-calls.log');
  writeFileSync(join(world.base, 'fakebin', 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

// What a git command line is about: its first word that is not an option.
const subcommandOf = (line) => line.split(' ').find((word) => !word.startsWith('-'));

// What the default branch and the remote are asked with.
const ASKS_ABOUT_THE_BASE = ['config', 'remote', 'symbolic-ref', 'for-each-ref', 'ls-remote', 'fetch', 'push'];

test('a vault whose default branch is configured and whose remote publishes it is refused all the same, before git is asked anything about the base', () => {
  // Without the check the run goes on: the configured main resolves, the
  // remote publishes it, and a branch is pushed and a pull request opened
  // from a repository that has no commit. With it, the run asks git only
  // where it is (rev-parse) and whether any commit exists (rev-list): nothing
  // about the configuration, the branches, the remote or the network.
  for (const extra of [[], ['--dry']]) {
    const world = unbornWorld({ defaultBranch: 'main', remote: true });
    const calls = recordGitCalls(world);
    assertRefusedFirst(world, ['propose', 'Add A', '--only', 'notes/a.md', ...extra]);
    const asked = calls();
    assert.ok(asked.some((call) => subcommandOf(call) === 'rev-list'), `the recorder sees git: ${asked.join(' | ')}`);
    assert.deepEqual(asked.filter((call) => ASKS_ABOUT_THE_BASE.includes(subcommandOf(call))), [], `git was asked about the base: ${asked.join(' | ')}`);
  }
});

test('the check comes before the choice of paths: --all (with and without --yes) and a path that is not dirty meet the same sentence', () => {
  const world = unbornWorld();
  assertRefusedFirst(world, ['propose', 'Add A', '--all']);
  assertRefusedFirst(world, ['propose', 'Add A', '--all', '--yes']);
  assertRefusedFirst(world, ['propose', 'Add A', '--only', 'notes/not-there.md']);
});

test('a repository with commits is never refused for having none: a detached HEAD proposes as ever', () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  git(world.vault, ['checkout', '-q', '--detach']);
  const run = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(run.status, EXIT.OK, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /no commit/);
  assert.match(run.stdout, /^Dry run: /);
});

test('a repository with history is not refused because the branch checked out is an orphan with no commit of its own', () => {
  const world = makeProposeWorld();
  git(world.vault, ['checkout', '-q', '--orphan', 'fresh']);
  assert.equal(gitProbe(world.vault, ['rev-parse', '-q', '--verify', 'HEAD']).status, 1, 'HEAD names no commit');
  world.write('notes/a.md', note('A'));
  const dry = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.doesNotMatch(dry.stderr, /no commit/);
  assert.match(dry.stdout, /^Dry run: /);
  const real = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md']);
  assert.equal(real.status, EXIT.OK, real.stdout + real.stderr);
  assert.match(real.stdout, /^Pull request opened against main from /);
});

// The comment on hasNoCommit promises that a commit reachable from ANY reference
// counts. A checked-out orphan branch with the local branches gone leaves the
// history behind a remote-tracking branch only: `rev-list --branches` would miss
// it and refuse a repository whose proposal the base would open.
test('a repository whose only history is a remote-tracking branch is not refused for having no commit, dry run and real run', () => {
  const world = makeProposeWorld();
  git(world.vault, ['checkout', '-q', '--orphan', 'fresh']);
  git(world.vault, ['branch', '-D', 'main']);
  assert.equal(git(world.vault, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim(), '', 'no local branch holds a commit');
  assert.match(git(world.vault, ['for-each-ref', '--format=%(refname)', 'refs/remotes']), /refs\/remotes\/origin\/main/);
  world.write('notes/a.md', note('A'));
  const dry = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /^Dry run: /);
  const real = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md']);
  assert.equal(real.status, EXIT.OK, real.stdout + real.stderr);
  assert.match(real.stdout, /^Pull request opened against main from /);
});

test('a git that cannot answer whether any reference reaches a commit is not read as "no commit"', () => {
  const world = makeProposeWorld();
  git(world.vault, ['checkout', '-q', '--orphan', 'fresh']);
  world.write('notes/a.md', note('A'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  writeFileSync(join(world.base, 'fakebin', 'git'), `#!/bin/sh\nif [ "$1" = "rev-list" ]; then echo 'fatal: bad object' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const run = brainKit(world, ['propose', 'Add A', '--only', 'notes/a.md', '--dry']);
  assert.equal(run.status, EXIT.OK, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /no commit/);
});

test('once the first commit exists the same command goes through: the sentence is a stage, not a dead end', () => {
  const world = unbornWorld();
  git(world.vault, ['add', '-A']);
  git(world.vault, ['commit', '-q', '-m', 'first commit']);
  world.write('notes/b.md', note('B'));
  // The remote is still to be created, which is the next honest refusal.
  const run = brainKit(world, ['propose', 'Add B', '--only', 'notes/b.md', '--dry']);
  assert.notEqual(run.stderr, `${createTranslator('en')('propose.no_commit')}\n`);
  assert.match(run.stderr, /no remote called origin|No default branch is known/);
});
