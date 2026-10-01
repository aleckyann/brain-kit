// hasNoCommit (src/git.mjs), the question `propose` and `sync` ask first: has
// this repository ever had a commit? It is true when HEAD names nothing AND no
// reference of any kind reaches a commit. Each kind of reference that can hold
// the only history is pinned here, because a narrower `rev-list` (`--branches`,
// `--branches --remotes`, `--branches --remotes --tags`) would call such a
// repository empty and refuse it (N3 of the review of G2b: a mutant that swapped
// `--all` for `--branches` survived every test of the command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasNoCommit } from '../src/git.mjs';
import { git, makeRepo } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

// A repository whose one commit is reachable from nothing but `kind`: HEAD is
// an unborn orphan branch and the branch that held the commit is deleted.
function historyOnlyIn(kind) {
  const origin = makeRepo({ 'a.md': 'a\n' });
  const root = origin;
  if (kind === 'a remote-tracking branch') {
    const clone = join(makeTempDir('brain-kit-nocommit-'), 'clone');
    git(origin, ['clone', '-q', origin, clone]);
    git(clone, ['checkout', '-q', '--orphan', 'fresh']);
    git(clone, ['branch', '-D', 'main']);
    return clone;
  }
  if (kind === 'a tag') git(root, ['tag', 'v1']);
  if (kind === "a proposal's local ref") git(root, ['update-ref', 'refs/brain-kit/proposed/bot-x', 'HEAD']);
  if (kind === 'a stash-like ref outside heads, tags and remotes') git(root, ['update-ref', 'refs/notes/kept', 'HEAD']);
  git(root, ['checkout', '-q', '--orphan', 'fresh']);
  git(root, ['branch', '-D', 'main']);
  return root;
}

test('a repository that has never had a commit has none', () => {
  assert.equal(hasNoCommit(makeRepo()), true);
});

test('a repository with a commit on its checked-out branch has one', () => {
  assert.equal(hasNoCommit(makeRepo({ 'a.md': 'a\n' })), false);
});

test('a detached HEAD has a commit', () => {
  const root = makeRepo({ 'a.md': 'a\n' });
  git(root, ['checkout', '-q', '--detach']);
  assert.equal(hasNoCommit(root), false);
});

test('an orphan branch checked out in a repository with history is not "no commit": another branch holds one', () => {
  const root = makeRepo({ 'a.md': 'a\n' });
  git(root, ['checkout', '-q', '--orphan', 'fresh']);
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root }).status, 1, 'HEAD names nothing');
  assert.equal(hasNoCommit(root), false);
});

for (const kind of ['a remote-tracking branch', 'a tag', "a proposal's local ref", 'a stash-like ref outside heads, tags and remotes']) {
  test(`a repository whose only history is behind ${kind} is not "no commit"`, () => {
    const root = historyOnlyIn(kind);
    assert.equal(git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim(), '', 'no local branch holds a commit');
    assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root }).status, 1, 'HEAD names nothing');
    assert.equal(hasNoCommit(root), false);
  });
}

test('a reference that reaches no commit (a tag on a file) does not count, and neither does a commit nothing refers to', () => {
  const blob = makeRepo();
  writeFileSync(join(blob, 'a.md'), 'a\n');
  const sha = git(blob, ['hash-object', '-w', 'a.md']).trim();
  git(blob, ['tag', 'on-a-file', sha]);
  assert.equal(hasNoCommit(blob), true, 'a tag on a blob');

  const loose = makeRepo({ 'a.md': 'a\n' });
  git(loose, ['checkout', '-q', '--orphan', 'fresh']);
  git(loose, ['branch', '-D', 'main']);
  assert.equal(hasNoCommit(loose), true, 'the commit is still in the object store, and no reference reaches it');
});

test('a git that cannot answer is never read as "no commit"', () => {
  const root = makeRepo({ 'a.md': 'a\n' });
  git(root, ['checkout', '-q', '--orphan', 'fresh']);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shims = join(makeTempDir('brain-kit-nocommit-shim-'), 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nif [ "$1" = "rev-list" ]; then echo 'fatal: bad object' >&2; exit 128; fi\nexec '${real}' "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}` };
  assert.equal(hasNoCommit(root, { env }), false);
});
