// `brain-kit sync`: the default branch brought up to date before anything
// is written (docs/incidents.md, 17/08/2026 and 25/08/2026).
//
// Every case is a real run against a throwaway vault and a bare remote on
// this machine (./helpers/sync-world.mjs), and every assertion about what
// was said is an exact comparison with the sentence the language pack
// renders, so a run that says "up to date" about the wrong thing, or with
// the wrong counts, fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../src/commands/sync.mjs';
import { main } from '../src/cli.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { describeLock } from '../src/guards/lock.mjs';
import { createTranslator } from '../src/lang.mjs';
import { CONFIG_FILENAME } from '../src/config.mjs';
import { CLEAN_ENV, git, makeRepo } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { assertOk, configText, gitProbe, makeWorld, repoState } from './helpers/sync-world.mjs';

const CHILD = fileURLToPath(new URL('./helpers/lock-child.mjs', import.meta.url));
const t = createTranslator('en');
const short = (sha) => sha.slice(0, 12);

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function sync(world, argv = [], { env = world.env, cwd = world.vault } = {}) {
  const f = fakeIo();
  const code = await runSync(argv, f.io, t, { env, cwd });
  return { code, stdout: f.stdout(), stderr: f.stderr() };
}

const line = (key, params) => `${t(key, params)}\n`;

// What a run may never move: the vault's own branches, where HEAD is and
// the working tree. The remote-tracking references are left out, since a
// fetch moving them is the point of fetching.
function localState(dir) {
  const state = repoState(dir);
  return { ...state, refs: state.refs.split('\n').filter((ref) => !ref.startsWith('refs/remotes/')).join('\n') };
}

// git stood in for by a script first on PATH. `cases` maps a git
// subcommand to a shell body run in its place: `exit 0` does nothing and
// says it worked; `real; exit 1` runs the real git and then says it
// failed. `when` optionally narrows a case to calls carrying one more
// argument. Every other call reaches the real git.
function withShim(world, cases, { when = {} } = {}) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const shims = join(world.base, `shims-${Object.keys(cases).join('-')}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(shims);
  const lines = ['#!/bin/sh', `real() { '${realGit}' "$@"; }`, 'sub="$1"', 'all="$*"'];
  for (const [sub, body] of Object.entries(cases)) {
    const narrow = when[sub] ? ` && case " $all " in *" ${when[sub]} "*) true;; *) false;; esac` : '';
    lines.push(`if [ "$sub" = "${sub}" ]${narrow}; then ${body.replace('real;', 'real "$@";')}; fi`);
  }
  lines.push(`exec '${realGit}' "$@"`, '');
  writeFileSync(join(shims, 'git'), lines.join('\n'));
  chmodSync(join(shims, 'git'), 0o755);
  return { ...world.env, PATH: `${shims}:${world.env.PATH}` };
}

function assertUnlocked(world) {
  assert.equal(describeLock(world.vault, { env: world.env }), null, 'the lock is released in every outcome');
}

test('a vault already level with its remote says so with both counts and exits 0', async () => {
  const world = makeWorld();
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.up_to_date', { branch: 'main', upstream: 'origin/main' }));
  assert.equal(run.stderr, '');
  assert.deepEqual(repoState(world.vault), before);
  assertUnlocked(world);
});

test('behind only, on the default branch: fast-forwarded to the remote tip', async () => {
  const world = makeWorld();
  const from = world.sha('main');
  world.publish(2);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.fast_forwarded', { branch: 'main', upstream: 'origin/main', behind: 2, from: short(from), to: short(tip) }));
  assert.equal(world.sha('main'), tip);
  assert.equal(world.sha('HEAD'), tip);
  assert.equal(git(world.vault, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
  assert.equal(git(world.vault, ['status', '--porcelain']), '');
  assertUnlocked(world);
});

test('behind only, started on another branch: main is fast-forwarded and the run returns to that branch, untouched', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  world.commitLocal(1);
  const feature = world.sha('curator/today');
  const from = world.sha('main');
  world.publish(3);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.fast_forwarded', { branch: 'main', upstream: 'origin/main', behind: 3, from: short(from), to: short(tip) })
    + line('sync.back_on', { start: 'curator/today' }));
  assert.equal(world.sha('main'), tip);
  assert.equal(git(world.vault, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/curator/today');
  assert.equal(world.sha('curator/today'), feature, 'the branch the run started on did not move');
  assert.equal(git(world.vault, ['status', '--porcelain']), '');
  assertUnlocked(world);
});

test('behind only, started on a detached HEAD: the run returns to the same commit, still detached', async () => {
  const world = makeWorld();
  const detachedAt = world.sha('HEAD');
  git(world.vault, ['checkout', '-q', '--detach', 'HEAD']);
  world.publish(1);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), tip);
  assert.equal(gitProbe(world.vault, ['symbolic-ref', '-q', 'HEAD']).status, 1, 'still detached');
  assert.equal(world.sha('HEAD'), detachedAt);
  assert.ok(run.stdout.endsWith(line('sync.back_on', { start: short(detachedAt) })), run.stdout);
  assertUnlocked(world);
});

test('diverged: refused with exit 1 naming both counts, and no branch, HEAD or file moved', async () => {
  const world = makeWorld();
  world.commitLocal(1);
  world.publish(2);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.diverged', { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2 }));
  assert.equal(run.stdout, '');
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('diverged while on another branch: refused the same way, and the run never leaves that branch', async () => {
  const world = makeWorld();
  world.commitLocal(2);
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  world.publish(1);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.diverged', { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 }));
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('ahead only: nothing to bring in, said with the count, exit 0, nothing moved', async () => {
  const world = makeWorld();
  world.commitLocal(2);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.ahead', { branch: 'main', upstream: 'origin/main', ahead: 2 }));
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('a dirty tree is postponed with exit 75 naming every file, before any fetch, and nothing moves', async () => {
  const world = makeWorld();
  world.publish(2);
  writeFileSync(join(world.vault, 'index.md'), '# Index\n\nAn edit in progress.\n');
  writeFileSync(join(world.vault, 'draft.md'), '# Draft\n');
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('sync.dirty', { files: ['draft.md', 'index.md'] }));
  assert.equal(run.stdout, '');
  assert.deepEqual(repoState(world.vault), before, 'not even the remote-tracking reference moved: no fetch ran');
  assertUnlocked(world);
});

test('a staged change alone is a dirty tree too', async () => {
  const world = makeWorld();
  writeFileSync(join(world.vault, 'index.md'), '# Index\n\nStaged.\n');
  git(world.vault, ['add', 'index.md']);
  const run = await sync(world);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('sync.dirty', { files: ['index.md'] }));
  assertUnlocked(world);
});

test('an ignored file is not a dirty tree', async () => {
  const world = makeWorld();
  writeFileSync(join(world.vault, '.git', 'info', 'exclude'), 'scratch.tmp\n');
  writeFileSync(join(world.vault, 'scratch.tmp'), 'x\n');
  world.publish(1);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), world.sha('main', world.elsewhere));
});

test('a rebase stopped with a clean tree is postponed with exit 75, and nothing moves', async () => {
  const world = makeWorld();
  world.commitLocal(2);
  const stop = spawnSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', 'rebase', '-i', 'HEAD~1'], {
    cwd: world.vault, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_SEQUENCE_EDITOR: 'sed -i -e "1i break"' },
  });
  assertOk(stop, 'rebase stopping at break');
  assert.equal(git(world.vault, ['status', '--porcelain']), '', 'the tree is clean: only the rebase makes it unsafe');
  world.publish(1);
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('sync.operation_in_progress', { operation: 'rebase' }));
  assert.deepEqual(repoState(world.vault), before);
  assertUnlocked(world);
});

test('the lock held by another run: exit 75 naming the holder, and nothing moves', async () => {
  const world = makeWorld();
  world.publish(1);
  const doneFile = join(world.base, 'holder-done');
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ root: world.vault, command: 'curate', id: 'holder', doneFile })], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const holder = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve(JSON.parse(out.slice(0, out.indexOf('\n'))).holder);
      });
      child.on('exit', () => reject(new Error('the holder printed nothing')));
    });
    const before = repoState(world.vault);
    const run = await sync(world);
    assert.equal(run.code, EXIT.TEMPFAIL);
    assert.equal(run.stderr, line('lock.held', { pid: holder.pid, host: holder.host, command: 'curate', startedAt: holder.startedAt }));
    assert.equal(run.stdout, '');
    assert.deepEqual(repoState(world.vault), before);
    assert.equal(describeLock(world.vault).pid, child.pid, 'the holder\'s lock is still its own');
  } finally {
    writeFileSync(doneFile, '');
    await exited;
  }
});

test('no origin/HEAD: the default branch resolves through origin/main and is fast-forwarded', async () => {
  const world = makeWorld();
  git(world.vault, ['remote', 'set-head', 'origin', '-d']);
  assert.notEqual(gitProbe(world.vault, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).status, 0, 'the case this test exists for');
  world.publish(3);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), tip);
  assertUnlocked(world);
});

test('vault.default_branch decides over origin/HEAD, which names another branch', async () => {
  const world = makeWorld({ defaultBranch: 'trunk' });
  world.publish(1, 'trunk');
  git(world.vault, ['fetch', '-q', 'origin']);
  git(world.vault, ['branch', '-q', '--track', 'trunk', 'origin/trunk']);
  world.publish(2, 'trunk');
  const mainBefore = world.sha('main');
  const tip = world.sha('trunk', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('trunk'), tip);
  assert.equal(world.sha('main'), mainBefore, 'origin/HEAD\'s branch is not the one the configuration names');
  assert.equal(git(world.vault, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main', 'back where it started');
  assertUnlocked(world);
});

test('a vault.default_branch that is not a branch name is refused with exit 1 and never reaches git as an option', async () => {
  const world = makeWorld();
  writeFileSync(join(world.vault, CONFIG_FILENAME), configText('--upload-pack=touch pwned'));
  git(world.vault, ['commit', '-q', '-am', 'a hostile configuration']);
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.default_branch_invalid', { name: '--upload-pack=touch pwned', file: CONFIG_FILENAME }));
  assert.deepEqual(repoState(world.vault), before);
  assert.equal(existsSync(join(world.vault, 'pwned')), false);
  assertUnlocked(world);
});

test('a remote that cannot be reached: exit 1 saying so, never "up to date", and nothing moves', async () => {
  const world = makeWorld();
  git(world.vault, ['remote', 'set-url', 'origin', join(world.base, 'gone.git')]);
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stdout, '');
  const prefix = t('sync.fetch_failed', { remote: 'origin', branch: 'main', detail: '' });
  assert.ok(run.stderr.startsWith(prefix), run.stderr);
  assert.ok(run.stderr.length > prefix.length + 1, 'git\'s own reason is carried');
  assert.doesNotMatch(run.stderr + run.stdout, /up to date/);
  assert.deepEqual(repoState(world.vault), before);
  assertUnlocked(world);
});

test('a fetch that exits 0 having reached nothing is a failure, never "up to date"', async () => {
  const world = makeWorld();
  world.publish(2);
  const before = localState(world.vault);
  const run = await sync(world, [], { env: withShim(world, { fetch: 'exit 0' }) });
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, line('sync.fetch_incomplete', {
    remote: 'origin', branch: 'main', upstream: 'origin/main', sha: short(world.sha('main', world.elsewhere)),
  }));
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('a remote with no such branch yet (nothing published): said, exit 0, nothing moves', async () => {
  const world = makeWorld({ publishFirst: false });
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.remote_has_no_branch', { remote: 'origin', branch: 'main' }));
  assert.deepEqual(repoState(world.vault), before);
  assertUnlocked(world);
});

test('no remote by the name the ladder reads: exit 1 naming it', async () => {
  const world = makeWorld();
  git(world.vault, ['remote', 'rename', 'origin', 'upstream']);
  git(world.vault, ['branch', '--unset-upstream', 'main']);
  git(world.vault, ['update-ref', '-d', 'refs/remotes/upstream/HEAD']);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.no_remote', { remote: 'origin', branch: 'main' }));
  assertUnlocked(world);
});

test('the default branch has no local branch: exit 1 naming the command that creates it, nothing created', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'work']);
  git(world.vault, ['branch', '-q', '-D', 'main']);
  world.publish(1);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.no_local_branch', { branch: 'main', upstream: 'origin/main', command: 'git branch --track main origin/main' }));
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('a return to the starting branch that fails is exit 1 naming where the repository is left', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  // A post-checkout hook that, once main is checked out, deletes the branch
  // the run started from, so the way back no longer exists.
  const hooks = join(world.base, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nif [ "$(git symbolic-ref -q HEAD)" = refs/heads/main ]; then git branch -q -D curator/today; fi\nexit 0\n');
  chmodSync(join(hooks, 'post-checkout'), 0o755);
  git(world.vault, ['config', 'core.hooksPath', hooks]);
  world.publish(1);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(world.sha('main'), tip, 'the fast-forward itself happened');
  assert.ok(run.stderr.endsWith(line('sync.return_failed', { start: 'curator/today', current: 'main' })), run.stderr);
  assertUnlocked(world);
});

test('GIT_DIR and GIT_WORK_TREE naming another repository leave that repository unchanged, and the vault is the one synced', async () => {
  const world = makeWorld();
  world.publish(2);
  const other = makeRepo({ 'note.md': '# Other\n' }, 'brain-kit-sync-other-');
  git(other, ['checkout', '-q', '-b', 'main-other']);
  const otherBefore = repoState(other);
  const env = { ...world.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') };
  const run = await sync(world, [], { env });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), world.sha('main', world.elsewhere));
  assert.deepEqual(repoState(other), otherBefore);
  assert.equal(existsSync(join(other, '.git', 'FETCH_HEAD')), false);
  assert.equal(existsSync(join(other, '.git', 'brain-kit.lock')), false);
  assertUnlocked(world);
});

test('the directory argument names the vault; a path that does not exist is a usage error', async () => {
  const world = makeWorld();
  world.publish(1);
  const elsewhere = makeTempDir('brain-kit-sync-cwd-');
  const run = await sync(world, [world.vault], { cwd: elsewhere });
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), world.sha('main', world.elsewhere));

  const missing = join(world.base, 'missing');
  const bad = await sync(world, [missing], { cwd: elsewhere });
  assert.equal(bad.code, EXIT.USAGE);
  assert.equal(bad.stderr, line('sync.path_not_found', { dir: missing }));
});

test('outside a vault: exit 2, and no lock is taken anywhere', async () => {
  const repo = makeRepo({ 'a.md': 'x\n' }, 'brain-kit-sync-novault-');
  const f = fakeIo();
  const code = await runSync([], f.io, t, { cwd: repo, env: { ...process.env } });
  assert.equal(code, EXIT.USAGE);
  assert.equal(f.stderr(), line('sync.no_vault', { dir: repo, config: CONFIG_FILENAME, index: 'index.md' }));
  assert.equal(existsSync(join(repo, '.git', 'brain-kit.lock')), false);
});

test('an unknown option is a usage error, and --help prints the usage', async () => {
  const world = makeWorld();
  const bad = await sync(world, ['--force']);
  assert.equal(bad.code, EXIT.USAGE);
  assert.equal(bad.stderr, line('sync.bad_argument', { arg: '--force' }) + line('sync.usage'));
  const help = await sync(world, ['--help']);
  assert.equal(help.code, EXIT.OK);
  assert.equal(help.stdout, line('sync.usage'));
});

test('the command is reachable from the CLI and listed in its usage', async () => {
  const f = fakeIo();
  const code = await main(['sync', '--help'], f.io);
  assert.equal(code, EXIT.OK);
  assert.match(f.stdout(), /brain-kit sync/);
  const usage = fakeIo();
  await main(['--help'], usage.io);
  assert.match(usage.stdout(), /\n {2}sync \[dir\]/);
});

test('nothing names a default branch: exit 1, naming the remote and the configuration, nothing moved', async () => {
  const world = makeWorld();
  git(world.vault, ['remote', 'remove', 'origin']);
  git(world.vault, ['branch', '-m', 'main', 'trunk']);
  const before = repoState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.no_default_branch', { remote: 'origin', file: CONFIG_FILENAME }));
  assert.deepEqual(repoState(world.vault), before);
  assertUnlocked(world);
});

test('the default branch checked out in another worktree: the checkout is refused, exit 1, nothing moved, still on the starting branch', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  git(world.vault, ['worktree', 'add', '-q', join(world.base, 'second'), 'main']);
  world.publish(1);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.ok(run.stderr.startsWith(t('sync.checkout_failed', { branch: 'main', detail: '' })), run.stderr);
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('a checkout that exits non-zero is not trusted even though it switched: exit 1, main not moved, back on the starting branch', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  const hooks = join(world.base, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nif [ "$(git symbolic-ref -q HEAD)" = refs/heads/main ]; then echo refusing >&2; exit 1; fi\nexit 0\n');
  chmodSync(join(hooks, 'post-checkout'), 0o755);
  git(world.vault, ['config', 'core.hooksPath', hooks]);
  const from = world.sha('main');
  world.publish(1);
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.checkout_failed', { branch: 'main', detail: 'refusing' }));
  assert.equal(world.sha('main'), from);
  assert.equal(git(world.vault, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/curator/today');
  assertUnlocked(world);
});

test('a checkout that exits 0 without switching is caught before any merge: exit 1, neither branch moved', async () => {
  const world = makeWorld();
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  const feature = world.sha('curator/today');
  const from = world.sha('main');
  world.publish(1);
  const run = await sync(world, [], { env: withShim(world, { checkout: 'exit 0' }) });
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stderr, line('sync.checkout_failed', { branch: 'main', detail: 'exit status 0' }));
  assert.equal(world.sha('main'), from);
  assert.equal(world.sha('curator/today'), feature, 'the merge never ran on the branch left checked out');
  assertUnlocked(world);
});

test('a merge that exits 0 without moving the branch is a failure, never "fast-forwarded"', async () => {
  const world = makeWorld();
  const from = world.sha('main');
  world.publish(2);
  const run = await sync(world, [], { env: withShim(world, { merge: 'exit 0' }) });
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, line('sync.fast_forward_failed', { branch: 'main', upstream: 'origin/main', detail: 'exit status 0' }));
  assert.equal(world.sha('main'), from);
  assertUnlocked(world);
});

test('a merge that exits non-zero is a failure even when the branch moved', async () => {
  const world = makeWorld();
  world.publish(1);
  const run = await sync(world, [], { env: withShim(world, { merge: 'real; echo "said it failed" >&2; exit 1' }) });
  assert.equal(run.code, EXIT.FAILURE);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, line('sync.fast_forward_failed', { branch: 'main', upstream: 'origin/main', detail: 'said it failed' }));
  assertUnlocked(world);
});

test('a return to a detached commit that exits 0 without going there is exit 1 naming where the repository is left', async () => {
  const world = makeWorld();
  const detachedAt = world.sha('HEAD');
  git(world.vault, ['checkout', '-q', '--detach', 'HEAD']);
  world.publish(1);
  const run = await sync(world, [], { env: withShim(world, { checkout: 'exit 0' }, { when: { checkout: '--detach' } }) });
  assert.equal(run.code, EXIT.FAILURE);
  assert.ok(run.stderr.endsWith(line('sync.return_failed', { start: short(detachedAt), current: 'main' })), run.stderr);
  assertUnlocked(world);
});

test('the remote is the one the default branch tracks, not the one the branch checked out tracks', async () => {
  const world = makeWorld();
  const fork = join(world.base, 'fork.git');
  git(world.base, ['clone', '-q', '--bare', world.remote, fork]);
  git(world.vault, ['remote', 'add', 'fork', fork]);
  git(world.vault, ['fetch', '-q', 'fork']);
  git(world.vault, ['checkout', '-q', '-b', 'work', '--track', 'fork/main']);
  world.publish(2);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), tip, 'main was brought level with origin, the remote it tracks');
  assert.equal(git(world.vault, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/work');
  assertUnlocked(world);
});

test('counts that lie never produce a merge commit: the merge is fast-forward only, and main is not moved', async () => {
  const world = makeWorld();
  world.commitLocal(1);
  const local = world.sha('main');
  world.publish(2);
  const env = {
    ...withShim(world, { 'rev-list': "printf '0\\t2\\n'; exit 0" }),
    GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'ana@example.com', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'ana@example.com',
  };
  const run = await sync(world, [], { env });
  assert.equal(run.code, EXIT.FAILURE);
  assert.ok(run.stderr.startsWith(t('sync.fast_forward_failed', { branch: 'main', upstream: 'origin/main', detail: '' })), run.stderr);
  assert.equal(world.sha('main'), local);
  assertUnlocked(world);
});

test('git failing mid-run is exit 1 saying so, and the lock is still released', async () => {
  const world = makeWorld();
  writeFileSync(join(world.vault, '.git', 'index'), 'not an index');
  const run = await sync(world);
  assert.equal(run.code, EXIT.FAILURE);
  assert.ok(run.stderr.startsWith(t('sync.git_failed', { detail: '' })), run.stderr);
  assertUnlocked(world);
});

test('a remote with no fetch refspec configured is still fetched and fast-forwarded, never read as level', async () => {
  const world = makeWorld();
  git(world.vault, ['config', '--unset-all', 'remote.origin.fetch']);
  world.publish(2);
  const tip = world.sha('main', world.elsewhere);
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(world.sha('main'), tip);
  assertUnlocked(world);
});

test('a fast-forward that would overwrite a file git ignores here is postponed with exit 75 naming it, and nothing moves', async () => {
  const world = makeWorld();
  git(world.elsewhere, ['checkout', '-q', 'main']);
  writeFileSync(join(world.elsewhere, 'draft.md'), '# Published draft\n');
  git(world.elsewhere, ['add', 'draft.md']);
  git(world.elsewhere, ['commit', '-q', '-m', 'publish a draft']);
  git(world.elsewhere, ['push', '-q', 'origin', 'main']);
  writeFileSync(join(world.vault, '.git', 'info', 'exclude'), 'draft.md\n');
  writeFileSync(join(world.vault, 'draft.md'), 'another session\'s private draft\n');
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('sync.ignored_in_the_way', { branch: 'main', upstream: 'origin/main', files: ['draft.md'] }));
  assert.equal(readFileSync(join(world.vault, 'draft.md'), 'utf8'), 'another session\'s private draft\n');
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('checking out the default branch to fast-forward it would overwrite an ignored file: postponed, still on the starting branch, the file intact', async () => {
  const world = makeWorld();
  writeFileSync(join(world.vault, 'notes.md'), '# Tracked on main\n');
  git(world.vault, ['add', 'notes.md']);
  git(world.vault, ['commit', '-q', '-m', 'notes on main']);
  git(world.vault, ['push', '-q', 'origin', 'main']);
  git(world.elsewhere, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(world.vault, ['checkout', '-q', '-b', 'curator/today']);
  git(world.vault, ['rm', '-q', 'notes.md']);
  git(world.vault, ['commit', '-q', '-m', 'notes removed on the branch']);
  writeFileSync(join(world.vault, '.git', 'info', 'exclude'), 'notes.md\n');
  writeFileSync(join(world.vault, 'notes.md'), 'a draft kept where main tracks a file\n');
  // The remote removes notes.md again, so only the checkout of the local
  // main would write it: the fetched tip alone does not have it.
  git(world.elsewhere, ['rm', '-q', 'notes.md']);
  git(world.elsewhere, ['commit', '-q', '-m', 'notes removed on the remote']);
  git(world.elsewhere, ['push', '-q', 'origin', 'main']);
  const before = localState(world.vault);
  const run = await sync(world);
  assert.equal(run.code, EXIT.TEMPFAIL);
  assert.equal(run.stderr, line('sync.ignored_in_the_way', { branch: 'main', upstream: 'origin/main', files: ['notes.md'] }));
  assert.equal(readFileSync(join(world.vault, 'notes.md'), 'utf8'), 'a draft kept where main tracks a file\n');
  assert.deepEqual(localState(world.vault), before);
  assertUnlocked(world);
});

test('the default branch is compared against the branch it tracks, not a same-named one', async () => {
  const world = makeWorld();
  git(world.elsewhere, ['push', '-q', 'origin', 'main:trunk']);
  git(world.vault, ['fetch', '-q', 'origin']);
  git(world.vault, ['branch', '-q', '--set-upstream-to=origin/trunk', 'main']);
  world.publish(1, 'trunk');
  const tip = world.sha('trunk', world.elsewhere);
  const from = world.sha('main');
  const run = await sync(world);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.equal(run.stdout, line('sync.fast_forwarded', { branch: 'main', upstream: 'origin/trunk', behind: 1, from: short(from), to: short(tip) }));
  assert.equal(world.sha('main'), tip);
  assertUnlocked(world);
});

test('a tracked merge reference that is not a branch git can be handed falls back to the same-named branch', async () => {
  for (const merge of ['refs/heads/-x', 'refs/tags/v1']) {
    const world = makeWorld();
    world.publish(1);
    const tip = world.sha('main', world.elsewhere);
    git(world.vault, ['config', 'branch.main.merge', merge]);
    const run = await sync(world);
    assert.equal(run.code, EXIT.OK, `${merge}: ${run.stderr}`);
    assert.equal(world.sha('main'), tip, merge);
  }
});
