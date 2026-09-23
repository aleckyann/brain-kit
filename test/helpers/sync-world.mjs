// A throwaway vault with a bare remote of its own, for the tests of
// `brain-kit sync`: a bare repository standing in for the remote, a vault
// cloned from it (so origin/HEAD, origin/main and the upstream of main are
// exactly what a real clone has), and a second clone, "elsewhere", that
// publishes commits the vault has not fetched yet. Nothing here touches a
// network: the remote is a directory on this machine.
//
// Every fixture command carries a local identity and runs with the
// caller's git environment removed (./git-repo.mjs); every run of the
// command under test gets an environment of its own, with an empty global
// git configuration and the state directory pinned inside the world.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { CLEAN_ENV, git } from './git-repo.mjs';
import { makeTempDir } from './tmp.mjs';

export function configText(defaultBranch = null) {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.default_branch = defaultBranch;
  return `${JSON.stringify(config, null, 2)}\n`;
}

// git as the fixture runs it, but returning the result instead of
// asserting success, for the questions whose answer is a failure.
export function gitProbe(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV });
}

export function makeWorld({ defaultBranch = null, publishFirst = true, prefix = 'brain-kit-sync-' } = {}) {
  const base = realpathSync(makeTempDir(prefix));
  const remote = join(base, 'remote.git');
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);

  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  git(elsewhere, ['init', '-q', '-b', 'main']);
  writeFileSync(join(elsewhere, 'brain-kit.config.json'), configText(defaultBranch));
  writeFileSync(join(elsewhere, 'index.md'), '# Index\n');
  git(elsewhere, ['add', '-A']);
  git(elsewhere, ['commit', '-q', '-m', 'initial']);
  git(elsewhere, ['remote', 'add', 'origin', remote]);
  if (publishFirst) git(elsewhere, ['push', '-q', '-u', 'origin', 'main']);

  const vault = join(base, 'vault');
  if (publishFirst) {
    git(base, ['clone', '-q', remote, vault]);
  } else {
    // Nothing published yet: the vault is its own first commit, with the
    // (empty) remote configured, as `git remote add` before a first push
    // leaves it.
    mkdirSync(vault);
    git(vault, ['init', '-q', '-b', 'main']);
    writeFileSync(join(vault, 'brain-kit.config.json'), configText(defaultBranch));
    writeFileSync(join(vault, 'index.md'), '# Index\n');
    git(vault, ['add', '-A']);
    git(vault, ['commit', '-q', '-m', 'initial']);
    git(vault, ['remote', 'add', 'origin', remote]);
  }

  const home = join(base, 'home');
  mkdirSync(home);
  writeFileSync(join(base, 'gitconfig'), '');
  const env = {
    ...CLEAN_ENV,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    XDG_STATE_HOME: join(base, 'state'),
    BRAIN_KIT_STATE_DIR: join(base, 'state', 'brain-kit'),
  };

  let counter = 0;
  const commitIn = (dir, n, label) => {
    for (let i = 0; i < n; i += 1) {
      counter += 1;
      writeFileSync(join(dir, `${label}-${counter}.md`), `# ${label} ${counter}\n`);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', `${label} ${counter}`]);
    }
  };

  return {
    base, remote, elsewhere, vault, env,
    // n commits published to the remote's `branch` from the other clone.
    publish(n, branch = 'main') {
      const current = git(elsewhere, ['symbolic-ref', '--short', 'HEAD']).trim();
      if (current !== branch) git(elsewhere, ['checkout', '-q', '-B', branch]);
      commitIn(elsewhere, n, 'published');
      git(elsewhere, ['push', '-q', 'origin', `${branch}:${branch}`]);
    },
    // n commits made in the vault on whatever it has checked out.
    commitLocal(n) {
      commitIn(vault, n, 'local');
    },
    sha(ref, dir = vault) {
      return git(dir, ['rev-parse', '--verify', ref]).trim();
    },
  };
}

// Everything a run could move in a repository, in one comparable value:
// every reference and what it points at, where HEAD is, and the status of
// the working tree, ignored files included.
export function repoState(dir) {
  const head = gitProbe(dir, ['symbolic-ref', '-q', 'HEAD']);
  return {
    refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']),
    head: head.status === 0 ? head.stdout.trim() : `detached ${git(dir, ['rev-parse', 'HEAD']).trim()}`,
    status: git(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']),
  };
}

export function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return result;
}
